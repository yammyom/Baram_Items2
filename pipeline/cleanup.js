const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function cleanupOldMonths() {
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('[-] DISCORD_WEBHOOK_URL이 설정되지 않아 3개월 전 백업을 건너뜁니다.');
    return;
  }

  const date = new Date();
  date.setMonth(date.getMonth() - 3);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const targetTable = `character_state_${year}_${month}`;

  console.log(`[*] 정리 대상 테이블 확인 중: ${targetTable}`);

  const { error: checkErr } = await supabase
    .from(targetTable)
    .select('*')
    .limit(1);

  if (checkErr && (checkErr.code === '42P01' || checkErr.code === 'PGRST106' || checkErr.message.includes('schema cache'))) {
    console.log(`[*] ${targetTable} 테이블이 존재하지 않습니다. (정리 스킵)`);
    return;
  }

  console.log(`[*] ${targetTable} 테이블 백업 시작 (스트리밍 및 분할 압축)`);

  const PART_ROWS_LIMIT = 200000;
  const PAGE_SIZE = 1000;
  let from = 0;
  let partIndex = 1;
  let currentPartRowCount = 0;
  let csvStream = null;
  let currentGzipPath = null;
  const generatedFiles = [];

  function startNewPartFile() {
    if (csvStream) csvStream.end();
    currentGzipPath = path.join(__dirname, `${targetTable}_part${partIndex}.csv.gz`);
    const gzip = zlib.createGzip();
    const fileStream = fs.createWriteStream(currentGzipPath);
    gzip.pipe(fileStream);
    csvStream = gzip;
    generatedFiles.push(currentGzipPath);
    currentPartRowCount = 0;
    partIndex++;
  }

  try {
    startNewPartFile();
    let headerWritten = false;

    while (true) {
      const { data: rows, error: fetchErr } = await supabase
        .from(targetTable)
        .select('*')
        .range(from, from + PAGE_SIZE - 1);

      if (fetchErr) throw fetchErr;
      if (!rows || rows.length === 0) break;

      if (!headerWritten) {
        const headers = Object.keys(rows[0]).join(',') + '\n';
        csvStream.write(headers);
        headerWritten = true;
      }

      const csvChunk = rows.map(row =>
        Object.values(row).map(v => {
          if (v === null || v === undefined) return '';
          return `"${String(v).replace(/"/g, '""')}"`;
        }).join(',')
      ).join('\n') + '\n';

      csvStream.write(csvChunk);
      currentPartRowCount += rows.length;
      from += PAGE_SIZE;

      process.stdout.write(`\r[*] 데이터 추출 및 실시간 압축 중: ${from}행 진행됨`);

      if (currentPartRowCount >= PART_ROWS_LIMIT) {
        headerWritten = false;
        startNewPartFile();
      }

      await new Promise(r => setTimeout(r, 50));

      if (rows.length < PAGE_SIZE) break;
    }

    if (csvStream) {
      await new Promise(resolve => csvStream.end(resolve));
    }
    console.log(`\n[*] 추출 완료! 총 ${generatedFiles.length}개 압축 파일 생성됨.`);

    for (const filePath of generatedFiles) {
      if (!fs.existsSync(filePath)) continue;
      const fileStat = fs.statSync(filePath);
      if (fileStat.size <= 30) {
        fs.unlinkSync(filePath);
        continue;
      }

      const fileName = path.basename(filePath);
      console.log(`[*] Discord로 전송 중: ${fileName} (${(fileStat.size / 1024 / 1024).toFixed(2)} MB)...`);

      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath), { filename: fileName });

      await axios.post(DISCORD_WEBHOOK_URL, formData, {
        headers: formData.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      console.log(`[+] ${fileName} 전송 완료.`);

      fs.unlinkSync(filePath);
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`[*] 백업 성공 확인 완료. 테이블 삭제를 진행합니다: ${targetTable}`);
    const { error: dropErr } = await supabase.rpc('drop_old_table', { p_table_name: targetTable });
    if (dropErr) {
      console.error(`[-] 테이블 삭제 실패:`, dropErr.message);
    } else {
      console.log(`[+] ${targetTable} 테이블 삭제 완료.`);
    }

  } catch (err) {
    console.error(`[-] 백업 처리 중 오류 발생:`, err.message);
    generatedFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  }
}

module.exports = { cleanupOldMonths };
