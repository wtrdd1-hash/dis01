const { execSync } = require('child_process');

try {
  const out = execSync('ssh -i E:\\dis_01\\wtrdd_vps_key\\id_ed25519 wtrdd@51.222.206.109 "curl -s http://127.0.0.1:3000/"', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  console.log('HTML Length:', out.length);
  const idx = out.indexOf('btn-floating-chat-toggle');
  console.log('Index of btn-floating-chat-toggle:', idx);
  if (idx !== -1) {
    console.log('✅ Found btn-floating-chat-toggle in live VPS HTML:');
    console.log(out.slice(idx - 30, idx + 600));
  }
} catch (e) {
  console.error(e.message);
}
