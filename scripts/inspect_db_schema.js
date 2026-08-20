'use strict';
const { pool } = require('../src/config/database');

async function inspectSchema() {
  try {
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(t => Object.values(t)[0]);
    console.log('=== Database Tables ===');
    console.log(tableNames.join(', '));
    console.log('\n=== Table Schemas ===');

    for (const tableName of ['admin_roles', 'users', 'web_accounts', 'stocks', 'user_stocks', 'loans', 'inquiries']) {
      if (tableNames.includes(tableName)) {
        const [cols] = await pool.query(`DESCRIBE ${tableName}`);
        console.log(`\n[Table: ${tableName}]`);
        for (const c of cols) {
          console.log(`  ${c.Field} | ${c.Type} | ${c.Null} | ${c.Key} | ${c.Default}`);
        }
      } else {
        console.log(`\n[Table: ${tableName}] - NOT EXISTS`);
      }
    }
  } catch (err) {
    console.error('Error inspecting schema:', err);
  } finally {
    process.exit(0);
  }
}

inspectSchema();
