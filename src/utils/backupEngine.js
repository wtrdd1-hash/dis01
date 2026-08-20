const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pool } = require('../config/database');
const { logAdminAction } = require('./logger');

// 백업 저장 디렉터리 (프로젝트 내부 backups 폴더 - 도커 및 로컬 완전 호환)
const BACKUP_DIR = path.resolve(__dirname, '../../backups');

// 디렉터리 자동 생성
try {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
} catch (e) {}

/**
 * 포맷된 KST 타임스탬프 (YYYYMMDD_HHmmss)
 */
function getTimestampStr() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours());
  const min = pad(now.getUTCMinutes());
  const s = pad(now.getUTCSeconds());
  return `${y}${m}${d}_${h}${min}${s}`;
}

/**
 * SQL 값 이스케이프 헬퍼
 */
function escapeSqlValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (val instanceof Date) {
    const kst = new Date(val.getTime() + 9 * 60 * 60 * 1000);
    return `'${kst.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)}'`;
  }
  if (Buffer.isBuffer(val)) {
    return `X'${val.toString('hex')}'`;
  }
  if (typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  const str = String(val)
    .replace(/\\/g, '\\\\')
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
  return `'${str}'`;
}

/**
 * 💾 Node.js Native MySQL 데이터베이스 풀 백업 실행 (.sql.gz)
 * 외부 mysqldump 바이너리에 의존하지 않고 100% 독립적으로 작동
 */
async function createDatabaseBackup(options = {}) {
  const reason = options.reason || 'MANUAL';
  const triggeredBy = options.triggeredBy || 'SYSTEM';
  const timestamp = getTimestampStr();
  const filename = `accountax_db_${timestamp}.sql.gz`;
  const filePath = path.join(BACKUP_DIR, filename);

  return new Promise(async (resolve, reject) => {
    let conn;
    const writeStream = fs.createWriteStream(filePath);
    const gzip = zlib.createGzip({ level: 6 });
    gzip.pipe(writeStream);

    const writeChunk = (text) => {
      return new Promise((r) => {
        if (!gzip.write(text, 'utf8')) {
          gzip.once('drain', r);
        } else {
          r();
        }
      });
    };

    try {
      conn = await pool.getConnection();

      // 헤더 작성
      await writeChunk(`-- ========================================================\n`);
      await writeChunk(`-- WTRD Duck Economy Database Dump (Native Node.js Backup)\n`);
      await writeChunk(`-- Generated At: ${new Date().toISOString()} (KST)\n`);
      await writeChunk(`-- Backup Reason: ${reason} | Triggered By: ${triggeredBy}\n`);
      await writeChunk(`-- ========================================================\n\n`);
      await writeChunk(`SET FOREIGN_KEY_CHECKS = 0;\n`);
      await writeChunk(`SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";\n`);
      await writeChunk(`SET NAMES utf8mb4;\n\n`);

      // 1. 전체 테이블 목록 조회
      const [tablesResult] = await conn.query(`SHOW TABLES`);
      const tableNames = tablesResult.map(r => Object.values(r)[0]);

      for (const table of tableNames) {
        // 테이블 스키마 DDL 생성
        await writeChunk(`-- --------------------------------------------------------\n`);
        await writeChunk(`-- Table structure for table \`${table}\`\n`);
        await writeChunk(`-- --------------------------------------------------------\n\n`);
        await writeChunk(`DROP TABLE IF EXISTS \`${table}\`;\n`);

        const [createTableResult] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
        const createSql = createTableResult[0]['Create Table'] || createTableResult[0]['Create View'];
        if (createSql) {
          await writeChunk(`${createSql};\n\n`);
        }

        // 테이블 데이터 INSERT 생성
        await writeChunk(`-- Dumping data for table \`${table}\`\n`);
        
        const [countRes] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${table}\``);
        const totalRows = countRes[0]?.cnt || 0;

        if (totalRows > 0) {
          const batchSize = 500;
          let offset = 0;

          while (offset < totalRows) {
            const [rows] = await conn.query(`SELECT * FROM \`${table}\` LIMIT ? OFFSET ?`, [batchSize, offset]);
            if (!rows || rows.length === 0) break;

            const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
            await writeChunk(`INSERT INTO \`${table}\` (${cols}) VALUES\n`);

            const valueLines = rows.map(row => {
              const vals = Object.values(row).map(escapeSqlValue).join(', ');
              return `  (${vals})`;
            });

            await writeChunk(valueLines.join(',\n') + ';\n\n');
            offset += rows.length;
          }
        } else {
          await writeChunk(`-- (Table is empty)\n\n`);
        }
      }

      await writeChunk(`SET FOREIGN_KEY_CHECKS = 1;\n`);
      await writeChunk(`-- Dump completed on ${new Date().toISOString()}\n`);

      gzip.end();

      writeStream.on('finish', async () => {
        try {
          const stats = fs.statSync(filePath);
          const sizeBytes = stats.size;
          const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);

          console.log(`✅ [BackupEngine] DB 백업 성공: ${filename} (${sizeMb} MB) [${reason}]`);

          // 관리자 감사 로그 기록
          try {
            await logAdminAction(triggeredBy, triggeredBy, 'CREATE_DATABASE_BACKUP', 'SYSTEM', {
              filename,
              sizeBytes,
              sizeMb: `${sizeMb} MB`,
              reason
            });
          } catch (e) {}

          // 30일 초과 백업 자동 정리
          cleanupOldBackups(30).catch(() => {});

          resolve({
            success: true,
            filename,
            filePath,
            sizeBytes,
            sizeMb: `${sizeMb} MB`,
            createdAt: new Date().toISOString()
          });
        } catch (err) {
          reject(err);
        }
      });

      writeStream.on('error', (err) => reject(err));
      gzip.on('error', (err) => reject(err));

    } catch (err) {
      if (conn) conn.release();
      try { gzip.end(); } catch (e) {}
      console.error('❌ [BackupEngine] DB 백업 중 예외 발생:', err);
      reject(err);
    } finally {
      if (conn) conn.release();
    }
  });
}

/**
 * 📋 저장된 백업 파일 목록 조회
 */
async function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const files = fs.readdirSync(BACKUP_DIR);
    const backupList = [];

    for (const f of files) {
      if (!f.endsWith('.sql.gz') && !f.endsWith('.tar.gz') && !f.endsWith('.sql')) continue;
      try {
        const fullPath = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(fullPath);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
        backupList.push({
          filename: f,
          sizeBytes: stat.size,
          sizeFormatted: stat.size > 1024 * 1024 ? `${sizeMb} MB` : `${(stat.size / 1024).toFixed(1)} KB`,
          createdAt: stat.mtime,
          timestamp: stat.mtime.getTime()
        });
      } catch (e) {}
    }

    // 최신순 정렬
    backupList.sort((a, b) => b.timestamp - a.timestamp);
    return backupList;
  } catch (e) {
    console.error('❌ [BackupEngine] 백업 목록 조회 실패:', e);
    return [];
  }
}

/**
 * 🧹 오래된 백업 파일 자동 정리 (기본 30일)
 */
async function cleanupOldBackups(retentionDays = 30) {
  try {
    const list = await listBackups();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    if (list.length <= 5) return;

    for (let i = 5; i < list.length; i++) {
      const item = list[i];
      if (item.timestamp < cutoff) {
        const fullPath = path.join(BACKUP_DIR, item.filename);
        try {
          fs.unlinkSync(fullPath);
          console.log(`🧹 [BackupEngine] 만료된 백업 파일 자동 삭제: ${item.filename}`);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

/**
 * 🔒 다운로드용 백업 파일 경로 검증
 */
function getSafeBackupPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const safeName = path.basename(filename);
  if (safeName !== filename) return null;
  if (!safeName.endsWith('.sql.gz') && !safeName.endsWith('.tar.gz') && !safeName.endsWith('.sql')) return null;

  const fullPath = path.join(BACKUP_DIR, safeName);
  if (fs.existsSync(fullPath)) return fullPath;
  return null;
}

/**
 * ⏰ 자동 정기 백업 스케줄러 시작 (매 6시간마다 1회 자동 실행)
 */
let autoBackupInterval = null;

function startAutoBackupScheduler() {
  if (autoBackupInterval) return;

  const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6시간 주기
  console.log('⏰ [BackupEngine] Native DB 자동 정기 백업 스케줄러 가동 시작 (6시간 주기)');

  autoBackupInterval = setInterval(async () => {
    try {
      console.log('⏰ [BackupEngine] 정기 자동 DB 백업 시작...');
      await createDatabaseBackup({ reason: 'AUTO_SCHEDULED', triggeredBy: 'CRON_SCHEDULER' });
    } catch (e) {
      console.error('❌ [BackupEngine] 정기 자동 DB 백업 실패:', e.message);
    }
  }, INTERVAL_MS);
}

module.exports = {
  createDatabaseBackup,
  listBackups,
  cleanupOldBackups,
  getSafeBackupPath,
  startAutoBackupScheduler,
  BACKUP_DIR
};
