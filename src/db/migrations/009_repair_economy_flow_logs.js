'use strict';

/**
 * Migration 009: 레거시 economy_flow_logs 스키마를 현재 통합 원장 형식으로 보정한다.
 *
 * 과거 테이블이 이미 존재하면 004의 CREATE TABLE IF NOT EXISTS가 성공 처리되면서
 * flow_type 등의 신규 컬럼이 생기지 않는 문제가 있었다. 기존 컬럼과 데이터는
 * 삭제하지 않고 호환 컬럼을 추가하고 값만 이관한다.
 */

async function getColumns(connection) {
  const [rows] = await connection.query('SHOW COLUMNS FROM economy_flow_logs');
  return new Set(rows.map((row) => String(row.Field)));
}

async function addColumn(connection, columns, name, definition) {
  if (columns.has(name)) return;
  await connection.query(`ALTER TABLE economy_flow_logs ADD COLUMN \`${name}\` ${definition}`);
  columns.add(name);
}

async function ensureIndex(connection, indexName, columnsSql) {
  const [rows] = await connection.query(
    `SELECT 1
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'economy_flow_logs'
        AND index_name = ?
      LIMIT 1`,
    [indexName]
  );
  if (rows.length) return;
  await connection.query(`ALTER TABLE economy_flow_logs ADD INDEX \`${indexName}\` (${columnsSql})`);
}

module.exports = {
  version: '009',
  name: '009_repair_economy_flow_logs',

  async up(connection) {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_flow_logs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        flow_type ENUM('INFLOW_MINT', 'OUTFLOW_SINK', 'TRANSFER') NOT NULL,
        category VARCHAR(64) NOT NULL,
        amount DECIMAL(65,0) NOT NULL DEFAULT 0,
        user_id VARCHAR(32) NULL,
        target_user_id VARCHAR(32) NULL,
        balance_after DECIMAL(65,0) NULL,
        reason VARCHAR(255) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const columns = await getColumns(connection);
    await addColumn(connection, columns, 'flow_type', "ENUM('INFLOW_MINT', 'OUTFLOW_SINK', 'TRANSFER') NULL");
    await addColumn(connection, columns, 'user_id', 'VARCHAR(32) NULL');
    await addColumn(connection, columns, 'target_user_id', 'VARCHAR(32) NULL');
    await addColumn(connection, columns, 'balance_after', 'DECIMAL(65,0) NULL');
    await addColumn(connection, columns, 'metadata', 'JSON NULL');
    await addColumn(connection, columns, 'created_at', 'DATETIME NULL');

    // 레거시 ENUM(MINT/SINK/TRANSFER/ASSET)은 SHOP_BUY, LOTTO_BUY 등을 담을 수 없다.
    await connection.query('ALTER TABLE economy_flow_logs MODIFY COLUMN category VARCHAR(64) NOT NULL');
    await connection.query('ALTER TABLE economy_flow_logs MODIFY COLUMN reason VARCHAR(255) NULL');

    const sourceExpr = columns.has('source_user_id') ? 'source_user_id' : 'NULL';
    const sinkExpr = columns.has('sink_user_id') ? 'sink_user_id' : 'NULL';
    const createdExpr = columns.has('ts') ? 'ts' : 'NOW()';

    await connection.query(`
      UPDATE economy_flow_logs
         SET flow_type = COALESCE(
               flow_type,
               CASE
                 WHEN category = 'MINT' THEN 'INFLOW_MINT'
                 WHEN category = 'SINK' THEN 'OUTFLOW_SINK'
                 WHEN category = 'TRANSFER' THEN 'TRANSFER'
                 WHEN ${sourceExpr} IS NULL AND ${sinkExpr} IS NOT NULL THEN 'INFLOW_MINT'
                 WHEN ${sourceExpr} IS NOT NULL AND ${sinkExpr} IS NULL THEN 'OUTFLOW_SINK'
                 ELSE 'TRANSFER'
               END
             ),
             user_id = COALESCE(user_id, ${sourceExpr}, ${sinkExpr}),
             target_user_id = COALESCE(target_user_id, ${sinkExpr}),
             created_at = COALESCE(created_at, ${createdExpr}, NOW())
    `);

    await connection.query(
      "ALTER TABLE economy_flow_logs MODIFY COLUMN flow_type ENUM('INFLOW_MINT', 'OUTFLOW_SINK', 'TRANSFER') NOT NULL"
    );
    await connection.query(
      'ALTER TABLE economy_flow_logs MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'
    );

    await ensureIndex(connection, 'idx_flow_type_date', 'flow_type, created_at');
    await ensureIndex(connection, 'idx_flow_cat_date', 'category, created_at');
    await ensureIndex(connection, 'idx_flow_user', 'user_id, created_at');

    console.log('✅ [Migration 009] 레거시 경제 흐름 원장을 현재 스키마로 보정 완료');
  },

  // 복구 마이그레이션은 기존 레거시 컬럼을 보존하므로 down에서 파괴적 롤백을 하지 않는다.
  async down() {}
};
