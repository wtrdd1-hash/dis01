'use strict';

// Run inside the deployed application container. Do not print credentials.
const { pool } = require('./src/config/database');

async function main() {
  const [identityRows] = await pool.query(
    'SELECT CURRENT_USER() AS current_identity, USER() AS connected_identity, @@version AS version'
  );
  const identity = identityRows[0] || {};
  const accountHost = String(identity.current_identity || '').split('@').pop();
  const connectedHost = String(identity.connected_identity || '').split('@').pop();

  let variables = [];
  try {
    const [rows] = await pool.query(
      "SHOW VARIABLES WHERE Variable_name IN ('bind_address', 'require_secure_transport', 'have_ssl', 'tls_version')"
    );
    variables = rows.map((row) => ({
      name: row.Variable_name,
      value: row.Value
    }));
  } catch (error) {
    variables = [{ name: 'query_error', value: error.code || error.message }];
  }

  let grants = [];
  try {
    const [rows] = await pool.query('SHOW GRANTS FOR CURRENT_USER()');
    grants = rows.flatMap((row) => Object.values(row)).map((grant) =>
      String(grant)
        .replace(/TO\s+('[^']+'|`[^`]+`)@('[^']+'|`[^`]+`)/i, 'TO <redacted-account>')
        .replace(/IDENTIFIED BY PASSWORD\s+'[^']+'/i, 'IDENTIFIED BY PASSWORD <redacted>')
    );
  } catch (error) {
    grants = [`query_error=${error.code || error.message}`];
  }

  console.log(JSON.stringify({
    accountHost,
    connectedHost,
    versionFamily: String(identity.version || '').split('-').slice(-1)[0],
    variables,
    grants
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
