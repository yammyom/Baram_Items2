const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/**
 * 3개월 전 테이블이 존재하면 CSV로 변환하여 Discord로 전송하고 테이블을 삭제합니다.
 */
async function cleanupOldMonths() {
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('[-] DISCORD_WEBHOOK_URL이 설정되지 않아 3개월 전 백업을 건너뜁니다.');
    return;
  }

  // 3개월 전 날짜 계산
  const date = new Date();
  date.setMonth(date.getMonth() - 3);
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const targetTable = `character_state_${year}_${month}`;

  console.log(`[*] 정리 대상 테이블 확인 중: ${targetTable}`);

  // 테이블 존재 여부 확인 (RPC 대신 REST API 활용)
  const { data: tableExists, error: checkErr } = await supabase
    .from(targetTable)
    .select('ocid')
    .limit(1);

  // 테이블이 존재하지 않으면 에러 반환 (보통 42P01 undefined_table)
  if (checkErr && checkErr.code === '42P01') {
    console.log(`[*] ${targetTable} 테이블이 존재하지 않습니다. (정리 스킵)`);
    return;
  }

  console.log(`[*] ${targetTable} 테이블이 존재합니다. 데이터 추출 및 전송을 시작합니다.`);

  try {
    // 1. 전체 데이터 조회 (용량이 매우 클 경우 페이징 처리가 필요할 수 있으나 우선 통째로 가져옴)
    const { data: rows, error: fetchErr } = await supabase
      .from(targetTable)
      .select('*')
      .order('recorded_date', { ascending: true });

    if (fetchErr) throw fetchErr;
    if (!rows || rows.length === 0) {
      console.log(`[*] ${targetTable} 테이블에 데이터가 없습니다. 테이블 삭제만 진행합니다.`);
    } else {
      // 2. CSV 변환
      const headers = Object.keys(rows[0]).join(',');
      const csvContent = rows.map(row => 
        Object.values(row).map(v => {
          if (v === null || v === undefined) return '';
          const str = String(v);
          // CSV 안전 처리를 위해 쌍따옴표 추가 및 내부 쌍따옴표 이스케이프
          return `"${str.replace(/"/g, '""')}"`;
        }).join(',')
      ).join('\n');

      const finalCsv = `${headers}\n${csvContent}`;
      const buffer = Buffer.from(finalCsv, 'utf-8');

      // 3. Discord 전송
      console.log(`[*] Discord로 CSV 전송 중... (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      const formData = new FormData();
      formData.append('file', buffer, { filename: `${targetTable}.csv` });
      
      await axios.post(DISCORD_WEBHOOK_URL, formData, {
        headers: formData.getHeaders()
      });
      console.log(`[+] Discord 전송 완료.`);
    }

    // 4. 테이블 삭제 (Supabase에서 DROP TABLE은 RPC를 통해 실행해야 함)
    // 보안을 위해 관리자용 drop_table_rpc가 필요하지만, 
    // 여기서는 파이프라인에서 직접 삭제 쿼리를 날릴 수 있는 RPC를 호출한다고 가정합니다.
    const { error: dropErr } = await supabase.rpc('drop_old_table', { p_table_name: targetTable });
    if (dropErr) {
      console.error(`[-] 테이블 삭제 실패:`, dropErr.message);
    } else {
      console.log(`[+] ${targetTable} 테이블 삭제 완료.`);
    }
  } catch (err) {
    console.error(`[-] 정리 작업 중 오류 발생:`, err.message);
  }
}

module.exports = { cleanupOldMonths };
