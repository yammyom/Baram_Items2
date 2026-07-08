require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const { createClient } = require('@supabase/supabase-js');
const { cleanupOldMonths } = require('./cleanup');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const NEXON_API_KEY = process.env.NEXON_API_KEY;

const NEXON_SERVERS = { '연': 131073, '무휼': 131074, '유리': 131086, '하자': 131087, '호동': 131088, '진': 131089 };
const DB_SERVER_IDS = { '연': 1, '무휼': 2, '유리': 3, '하자': 4, '호동': 5, '진': 6 };
const JOBS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const MIN_PROMOTION_LEVEL = 7;
const MAX_PROMOTION_LEVEL = 9;

const PART_MAP = {
  '무기': 1, '투구': 2, '갑옷': 3, '왼손': 4, '오른손': 4,
  '목장식': 5, '목/어깨장식': 5, '신발': 6, '망토': 7, '얼굴장식': 8,
  '보조1': 9, '보조2': 9, '보조': 9, '장신구': 10, '세트옷': 11, '방패/보조무기': 12,
  '캐시 무기': 13, '캐시무기': 13,
  '캐시 투구': 14, '캐시투구': 14,
  '캐시 겉옷': 15, '캐시겉옷': 15,
  '캐시 목/어깨장식': 16, '캐시목/어깨장식': 16,
  '캐시 신발': 17, '캐시신발': 17,
  '캐시 망토': 18, '캐시망토': 18,
  '캐시 얼굴장식': 19, '캐시얼굴장식': 19,
  '캐시 장신구': 20, '캐시장신구': 20,
  '캐시 세트옷': 21, '캐시세트옷': 21,
  '캐시 방패/보조무기': 22, '캐시방패/보조무기': 22
};

const limit = pLimit(30);
const webLimit = pLimit(10);

async function fetchWithRetry(url, params = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, { params, timeout: 8000 });
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function getOcid(characterName, serverName) {
  try {
    const resp = await axios.get('https://open.api.nexon.com/baram/v1/id', {
      params: { character_name: characterName, server_name: serverName },
      headers: { 'x-nxopen-api-key': NEXON_API_KEY }
    });
    return resp.data.ocid;
  } catch { return null; }
}

async function processCharacter(characterName, serverName, dbServerId, jobCode) {
  try {
    const ocid = await getOcid(characterName, serverName);
    if (!ocid) return null;

    const [basicResp, equipResp] = await Promise.all([
      axios.get('https://open.api.nexon.com/baram/v1/character/basic', { params: { ocid }, headers: { 'x-nxopen-api-key': NEXON_API_KEY } }),
      axios.get('https://open.api.nexon.com/baram/v1/character/item-equipment', { params: { ocid }, headers: { 'x-nxopen-api-key': NEXON_API_KEY } })
    ]);

    const rawCreatedAt = basicResp.data.character_date_create;
    const createdAt = rawCreatedAt ? rawCreatedAt.split('T')[0] : null;

    const PET_NAMES = ["주작", "현무", "백호", "청룡", "황룡", "혼돈", "도올", "궁기", "도철", "고대불의", "고대바람의", "고대땅의", "고대물의", "생명의목걸이"];
    
    const itemsToProcessRaw = (equipResp.data.item_equipment || [])
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
        const limit = (item.part_id === 4 || item.part_id === 9) ? 2 : 1;
        partCounts[item.part_id] = (partCounts[item.part_id] || 0) + 1;
        if (partCounts[item.part_id] > limit) continue;
      }
      itemsToProcess.push(item);
    }

    if (itemsToProcess.length > 0) {
      itemsToProcess.sort((a, b) => {
        if (a.part_id !== b.part_id) return a.part_id - b.part_id;
        return a.name.localeCompare(b.name, 'ko');
      });
    }

    const genderStr = basicResp.data.character_gender;
    const genderCode = genderStr === 'M' ? 1 : (genderStr === 'F' ? 2 : null);

    return {
      ocid: ocid,
      server_id: dbServerId,
      character_name: characterName,
      job_id: jobCode,
      gender: genderCode,
      level: basicResp.data.character_level,
      exp: basicResp.data.character_exp || 0,
      created_at: createdAt || '-',
      equipment_json: itemsToProcess
    };
  } catch {
    return null;
  }
}

async function findLastPage(serverCode, jobCode) {
  let low = 0, high = 4999, lastGoodPage = -1;
  while (low <= high) {
    let mid = Math.floor((low + high) / 2);
    const startRank = (mid * 20) + 1;
    const url = `https://baram.nexon.com/Rank/List?maskGameCode=${serverCode}&n4Rank_start=${startRank}&codeGameJob=${jobCode}`;
    try {
      const resp = await fetchWithRetry(url);
      const $ = cheerio.load(resp.data);
      const firstCharPromotion = parseInt($('tr:nth-child(2) td:nth-child(6)').text()) || 0;
      const hasCharacters = $('tr').length > 1;

      if (hasCharacters && firstCharPromotion >= MIN_PROMOTION_LEVEL) {
        lastGoodPage = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    } catch { high = mid - 1; }
  }
  return lastGoodPage;
}

async function fetchCharacterNamesFromWeb(serverCode, jobCode) {
  const names = [];
  try {
    const lastPage = await findLastPage(serverCode, jobCode);
    if (lastPage === -1) return [];

    console.log(`    [*] 0 ~ ${lastPage} 페이지 병렬 수집 중...`);
    const pages = Array.from({ length: lastPage + 1 }, (_, i) => i);

    await Promise.all(pages.map(page => webLimit(async () => {
      const startRank = (page * 20) + 1;
      const url = `https://baram.nexon.com/Rank/List?maskGameCode=${serverCode}&n4Rank_start=${startRank}&codeGameJob=${jobCode}`;
      const response = await fetchWithRetry(url);
      const $ = cheerio.load(response.data);

      $('tr').each((_, el) => {
        const name = $(el).find('td:nth-child(3)').text().trim();
        const promotion = parseInt($(el).find('td:nth-child(6)').text()) || 0;
        if (name && promotion >= MIN_PROMOTION_LEVEL && promotion <= MAX_PROMOTION_LEVEL) names.push(name);
      });
    })));
  } catch (err) {
    console.error(`\n❌ 웹 크롤링 최종 실패: ${err.message}`);
  }
  return [...new Set(names)];
}

async function cleanupOldData() {
  console.log('\n[*] 2일 이상 경과된 오래된 데이터 정리 중...');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase.from('users').delete({ count: 'exact' }).lt('updated_at', twoDaysAgo);
  if (error) console.error('❌ 데이터 정리 실패:', error.message);
  else console.log(`[*] 정리 완료: ${count || 0}명의 캐릭터 삭제됨`);
}

async function runPipeline() {
  const args = process.argv.slice(2);
  const targetJobArg = args.find(a => a.startsWith('--job='))?.split('=')[1];
  const targetServerArg = args.find(a => a.startsWith('--server='))?.split('=')[1];
  const targetJob = targetJobArg ? parseInt(targetJobArg) : null;
  const targetServer = targetServerArg || null;
  const start = new Date().getTime();
  console.log(`>>> 유저 경계탐색 파이프라인 가동: ${MIN_PROMOTION_LEVEL}차 ~ ${MAX_PROMOTION_LEVEL}차`, start);

  for (const [serverName, nexonServerCode] of Object.entries(NEXON_SERVERS)) {
    if (targetServer && serverName !== targetServer) continue;
    for (const jobCode of JOBS) {
      if (targetJob !== null && jobCode !== targetJob) continue;
      const dbServerId = DB_SERVER_IDS[serverName];
      console.log(`\n[*] 수집 중: ${serverName} (직업: ${jobCode})`);
      const characterNames = await fetchCharacterNamesFromWeb(nexonServerCode, jobCode);
      console.log(`    -> ${characterNames.length}명의 캐릭터명 수집됨`);

      const BATCH_SIZE = 100;
      for (let i = 0; i < characterNames.length; i += BATCH_SIZE) {
        const chunk = characterNames.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(chunk.map(name => limit(() => processCharacter(name, serverName, dbServerId, jobCode))));
        const validResults = results.filter(r => r !== null);
        
        if (validResults.length > 0) {
          // 1. 기존 users 및 items UPSERT
          await supabase.rpc('upsert_character_data_batch', { p_characters: validResults });
          
          // 2. In-Memory Delta Check (character_master, ocid 기준)
          const ocids = validResults.map(r => r.ocid);
          
          const { data: existingData, error: expErr } = await supabase
            .from('character_master')
            .select('ocid, exp')
            .in('ocid', ocids);

          if (expErr) {
            console.error('❌ 기존 exp 조회 실패:', expErr.message);
          }

          const expMap = new Map();
          if (existingData) {
            existingData.forEach(row => {
              expMap.set(row.ocid, BigInt(row.exp || 0));
            });
          }

          // 변동이 있거나(Delta), 신규 유저만 추출
          const deltaCharacters = validResults.filter(r => {
            const currentExp = BigInt(r.exp);
            const prevExp = expMap.get(r.ocid);
            return prevExp === undefined || prevExp !== currentExp;
          });

          // 3. 변동분(Delta)만 월별 상태 테이블 및 character_master에 갱신
          if (deltaCharacters.length > 0) {
            const date = new Date();
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const tableName = `character_state_${yyyy}_${mm}`;
            
            await supabase.rpc('upsert_character_state_batch', { 
              p_table_name: tableName,
              p_characters: deltaCharacters 
            });
          }
          process.stdout.write(`[수집:${validResults.length}/활성:${deltaCharacters.length}] `);
        } else {
          process.stdout.write(`[수집:0] `);
        }
      }

      console.log(`\n    -> ${characterNames.length}명의 캐릭터명 수집 및 저장 완료`);
    }
  }

  if (targetJob === null && targetServer === null) {
    await cleanupOldData();

    console.log('\n[*] 휴면 캐릭터 감지 중...');
    const { data: dormantCount, error: dormantErr } = await supabase.rpc('detect_dormant_users_dynamic', { 
      p_dormant_days: 7 
    });
    if (dormantErr) console.error('❌ 휴면 감지 실패:', dormantErr.message);
    else console.log(`[*] 신규 휴면 처리: ${dormantCount || 0}명`);

    console.log('\n[*] 3개월 전 백업 및 정리 시작...');
    await cleanupOldMonths();
  }
  console.log('\n>>> 파이프라인 완료', new Date().getTime() - start, 'ms');
}

runPipeline().catch(console.error);
