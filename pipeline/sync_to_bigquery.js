const fs = require('fs');
const { BigQuery } = require('@google-cloud/bigquery');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Base64로 인코딩된 GCP 키를 디코딩하여 JSON 객체로 파싱
const GCP_CREDENTIALS = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString());

const bigquery = new BigQuery({ credentials: GCP_CREDENTIALS, projectId: GCP_CREDENTIALS.project_id });

async function main() {
  console.log('1. Supabase에서 버퍼 데이터 CSV 다운로드 시작...');
  
  const response = await fetch(`${SUPABASE_URL}/rest/v1/daily_growth_buffer`, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept': 'text/csv'
    }
  });

  if (!response.ok) throw new Error(`Supabase Fetch Error: ${response.statusText}`);
  
  const csvText = await response.text();
  if (!csvText || csvText.trim() === '') {
    console.log('이관할 데이터가 없습니다. 종료합니다.');
    return;
  }

  const filePath = '/tmp/buffer.csv';
  fs.writeFileSync(filePath, csvText);
  console.log('CSV 다운로드 완료. BigQuery Load 시작...');

  const datasetId = 'baram_dataset'; // 생성하신 데이터셋 이름

  // 2. 스테이징 테이블에 덮어쓰기 Load (비용 무료)
  await bigquery.dataset(datasetId).table('staging_buffer').load(filePath, {
    sourceFormat: 'CSV',
    skipLeadingRows: 1, // 헤더 제거
    autodetect: false,
    writeDisposition: 'WRITE_TRUNCATE' 
  });
  console.log('BigQuery Staging Load 완료.');

  // 3. 마스터/팩트 테이블 분배 쿼리 (닉네임/서버 변경 감지 로직 포함)
  console.log('3. BigQuery 내부 데이터 분배 쿼리 실행...');
  const mergeQuery = `
    -- 1) 마스터 테이블 병합
    MERGE \`${GCP_CREDENTIALS.project_id}.${datasetId}.dim_characters\` T
    USING \`${GCP_CREDENTIALS.project_id}.${datasetId}.staging_buffer\` S
    ON T.ocid = S.ocid
    WHEN MATCHED AND (T.character_name != S.character_name OR T.server_id != S.server_id) THEN
      UPDATE SET character_name = S.character_name, server_id = S.server_id, job_id = S.job_id
    WHEN NOT MATCHED THEN
      INSERT (ocid, server_id, character_name, job_id, created_at)
      VALUES (S.ocid, S.server_id, S.character_name, S.job_id, S.created_at);

    -- 2) 일일 성장 팩트 테이블 삽입
    INSERT INTO \`${GCP_CREDENTIALS.project_id}.${datasetId}.fact_daily_growth\` (record_date, ocid, level, exp)
    SELECT record_date, ocid, level, exp
    FROM \`${GCP_CREDENTIALS.project_id}.${datasetId}.staging_buffer\`;
  `;

  const [job] = await bigquery.createQueryJob({ query: mergeQuery });
  await job.getQueryResults();
  console.log('데이터 병합 완료. (닉네임 변경 감지 및 성장기록 적재)');

  // 4. Supabase 버퍼 비우기 (다음 날을 위해)
  console.log('4. Supabase 임시 버퍼 비우기...');
  const clearResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/truncate_growth_buffer`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });

  if (!clearResponse.ok) throw new Error('Supabase Buffer Truncate 실패');
  console.log('모든 이관 작업이 성공적으로 완료되었습니다!');
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
