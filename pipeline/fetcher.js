import pLimit from 'p-limit';
import { createClient } from '@supabase/supabase-js';

const limit = pLimit(300); // 넥슨 API 초당 300회 제한

const JOBS_MAP = {
  '전사': 1, '도적': 2, '주술사': 3, '도사': 4, '궁사': 5,
  '천인': 6, '마도사': 7, '영술사': 8, '차사': 9, '살수': 10, '흑화랑': 11
};

const PART_MAP = {
  '무기': 1, '투구': 2, '갑옷': 3, '왼손': 4, '오른손': 4,
  '목장식': 5, '목/어깨장식': 5, '신발': 6, '망토': 7, '얼굴장식': 8,
  '보조1': 9, '보조2': 9, '보조': 9, '장신구': 10, '세트옷': 11, '방패/보조무기': 12,
  '캐시 무기': 13, '캐시무기': 13,
  '캐시 투구': 14, '캐시투구': 14,
  '캐시 겉옷': 15, '캐시겉옷': 15,
  '캐시 목장식': 16, '캐시목장식': 16,
  '캐시 신발': 17, '캐시신발': 17,
  '캐시 망토': 18, '캐시망토': 18,
  '캐시 얼굴장식': 19, '캐시얼굴장식': 19,
  '캐시 장신구': 20, '캐시장신구': 20,
  '캐시 세트옷': 21, '캐시세트옷': 21,
  '캐시 방패/보조무기': 22, '캐시방패/보조무기': 22
};

export default {
  async queue(batch, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const NEXON_API_KEY = env.NEXON_API_KEY;

    const tasks = batch.messages.map(msg =>
      limit(async () => {
        const { serverName, characterName } = msg.body;

        try {
          // 1. Get OCID
          const idResponse = await fetch(`https://open.api.nexon.com/baram/v1/id?character_name=${encodeURIComponent(characterName)}&server_name=${encodeURIComponent(serverName)}`, {
            headers: { 'x-nxopen-api-key': NEXON_API_KEY }
          });
          if (!idResponse.ok) return null;
          const { ocid } = await idResponse.json();

          // 2. Get Basic Info (Level, Gender, Job, Exp, CreatedAt)
          const basicResponse = await fetch(`https://open.api.nexon.com/baram/v1/character/basic?ocid=${ocid}`, {
            headers: { 'x-nxopen-api-key': NEXON_API_KEY }
          });
          const basicData = await basicResponse.json();
          const level = basicData.character_level;
          const genderStr = basicData.character_gender;
          const genderCode = genderStr === 'M' ? 1 : (genderStr === 'F' ? 2 : null);
          const jobCode = JOBS_MAP[basicData.character_class_name] || 1;
          
          // [추가] 성장 데이터 파싱
          const exp = basicData.character_exp;
          const createdAt = basicData.character_date_create;

          // 3. Get Equipment Info
          const equipResponse = await fetch(`https://open.api.nexon.com/baram/v1/character/item-equipment?ocid=${ocid}`, {
            headers: { 'x-nxopen-api-key': NEXON_API_KEY }
          });
          const equipData = await equipResponse.json();

          // 장비 정규화 로직
          const PET_NAMES = ["주작", "현무", "백호", "청룡", "황룡", "혼돈", "도올", "궁기", "도철", "고대불의", "고대바람의", "고대땅의", "고대물의", "생명의목걸이"];
          const itemsToProcessRaw = (equipData.item_equipment || [])
            .filter(i => i.item_id)
            .map(i => {
              const slotName = (i.item_equipment_slot_name || '').trim();
              return {
                name: i.item_id.trim(),
                part_id: PART_MAP[slotName] || 23
              };
            })
            .filter(item => {
              const hasPrefix = PET_NAMES.some(prefix => item.name.startsWith(prefix));
              const hasSuffix = /\d+성$/.test(item.name);
              return !(hasPrefix && hasSuffix);
            });

          const partCounts = {};
          const itemsToProcess = [];

          for (const item of itemsToProcessRaw) {
            if (item.part_id !== 23) {
              const itemLimit = (item.part_id === 4 || item.part_id === 9) ? 2 : 1;
              partCounts[item.part_id] = (partCounts[item.part_id] || 0) + 1;
              if (partCounts[item.part_id] > itemLimit) continue;
            }
            itemsToProcess.push(item);
          }

          if (itemsToProcess.length === 0) {
            msg.ack();
            return null;
          }

          itemsToProcess.sort((a, b) => {
            if (a.part_id !== b.part_id) return a.part_id - b.part_id;
            return a.name.localeCompare(b.name, 'ko');
          });

          const serverId = getServerId(serverName);

          return {
            msg,
            data: {
              ocid: ocid, // PK 식별자 추가
              server_id: serverId,
              character_name: characterName,
              job_id: jobCode,
              gender: genderCode,
              level: level,
              exp: exp,
              created_at: createdAt,
              equipment_json: itemsToProcess
            }
          };
        } catch (err) {
          console.error(`Error fetching data for ${msg.body?.characterName}:`, err);
          return null;
        }
      })
    );

    const results = await Promise.all(tasks);
    const validResults = results.filter(Boolean);

    if (validResults.length > 0) {
      // ocid 기준의 완벽한 중복 제거
      const dedupMap = new Map();
      for (const r of validResults) {
        dedupMap.set(r.data.ocid, r);
      }
      const dedupedResults = [...dedupMap.values()];
      
      // 1. 기존 장비 DB용 Payload 조립
      const charactersData = dedupedResults.map(r => ({
        server_id: r.data.server_id,
        character_name: r.data.character_name,
        job_id: r.data.job_id,
        gender: r.data.gender,
        level: r.data.level,
        equipment_json: r.data.equipment_json
      }));

      // 2. 일일 성장 버퍼용 Payload 조립 (KST 기준 날짜)
      const now = new Date();
      const kstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000)).toISOString().split('T')[0];
      
      const growthData = dedupedResults.map(r => ({
        record_date: kstDate,
        ocid: r.data.ocid,
        server_id: r.data.server_id,
        character_name: r.data.character_name,
        job_id: r.data.job_id,
        level: r.data.level || 0,
        exp: r.data.exp ? r.data.exp.toString() : '0', // 값이 없으면 문자열 '0'
        created_at: r.data.created_at || '-' // 값이 없으면 '-'
      }));

      try {
        // 병렬로 2개의 RPC 호출
        const [equipResult, growthResult] = await Promise.all([
          supabase.rpc('upsert_character_data_batch', { p_characters: charactersData }),
          supabase.rpc('insert_growth_buffer_batch', { p_growth_data: growthData })
        ]);

        if (equipResult.error) throw equipResult.error;
        if (growthResult.error) throw growthResult.error;

        dedupedResults.forEach(r => r.msg.ack());
        console.log(`[+] 성공적으로 ${dedupedResults.length}명 배치 2종 저장 및 ACK 완료.`);
      } catch (dbErr) {
        console.error(`[-] Batch DB 처리 중 에러 발생, 재시도 예약:`, dbErr.message);
        dedupedResults.forEach(r => r.msg.retry({ delaySeconds: 5 }));
      }
    }
  }
};

function getServerId(name) {
  const mapping = { '연': 1, '무휼': 2, '유리': 3, '하자': 4, '호동': 5, '진': 6 };
  return mapping[name] || 0;
}
