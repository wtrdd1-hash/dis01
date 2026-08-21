'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function ensureMigrationTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function runMigrations(customPool) {
  const dbPool = customPool || pool;
  const connection = await dbPool.getConnection();
  try {
    await ensureMigrationTable(connection);

    const [appliedRows] = await connection.query('SELECT version FROM _schema_migrations');
    const appliedSet = new Set(appliedRows.map(r => r.version));

    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      fs.mkdirSync(migrationsDir, { recursive: true });
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    console.log(`🔍 [DB Migration] 총 ${files.length}개의 마이그레이션 파일 발견 (기적용: ${appliedSet.size}개)`);

    for (const file of files) {
      const version = file.split('_')[0];
      if (appliedSet.has(version)) continue;

      const migrationPath = path.join(migrationsDir, file);
      const migration = require(migrationPath);

      console.log(`⏳ [DB Migration] 마이그레이션 적용 중: ${file} (v${version})...`);
      
      await connection.beginTransaction();
      try {
        if (typeof migration.up === 'function') {
          await migration.up(connection);
        }
        await connection.query(
          'INSERT INTO _schema_migrations (version, name) VALUES (?, ?)',
          [version, file]
        );
        await connection.commit();
        console.log(`✅ [DB Migration] 적용 성공: ${file}`);
      } catch (err) {
        await connection.rollback();
        console.error(`❌ [DB Migration] 실패 (${file}):`, err);
        throw err;
      }
    }
    console.log('✨ [DB Migration] 모든 데이터베이스 마이그레이션이 최신 상태입니다.');
    return true;
  } finally {
    connection.release();
  }
}

module.exports = {
  runMigrations,
  ensureMigrationTable
};
