'use strict';

// Run inside the deployed application container. Creates one temporary notice
// through the Discord command handler and always removes it before exit.
const config = require('./src/config/config');
const command = require('./src/commands/admin/adminNotice');
const { pool } = require('./src/config/database');

const marker = `QA_DISCORD_${Date.now()}`;
let noticeId = null;

async function main() {
  let reply = '';
  const originalLog = console.log;
  const interaction = {
    user: { id: config.adminIds[0], username: 'qa-admin', globalName: 'QA Admin' },
    options: {
      getSubcommand: () => 'create',
      getString: (name) => name === 'title'
        ? marker
        : (name === 'content' ? 'Temporary Discord command QA' : 'GENERAL'),
      getBoolean: () => false,
      getInteger: () => null
    },
    deferReply: async () => {},
    editReply: async (value) => { reply = String(value); return value; }
  };

  try {
    // The command's audit logger writes administrator identifiers to stdout.
    // Keep the QA artifact free of those identifiers; the DB audit record still runs.
    console.log = () => {};
    await command.execute(interaction);
  } finally {
    console.log = originalLog;
  }
  if (!reply.startsWith('✅')) throw new Error(`command reply failed: ${reply}`);
  const [rows] = await pool.query(
    'SELECT id FROM site_announcements WHERE title = ? ORDER BY id DESC LIMIT 1',
    [marker]
  );
  if (!rows[0]) throw new Error('command did not create notice');
  noticeId = rows[0].id;
  console.log('DISCORD_NOTICE_CREATE=PASS');
}

main().catch((error) => {
  console.error(`DISCORD_NOTICE_CREATE=FAIL|${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (noticeId) await pool.query('DELETE FROM site_announcements WHERE id = ?', [noticeId]);
    console.log(`DISCORD_NOTICE_CLEANUP=${noticeId ? 'PASS' : 'SKIP'}`);
  } finally {
    await pool.end();
  }
});
