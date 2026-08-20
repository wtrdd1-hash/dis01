const { execSync } = require('child_process');

try {
  console.log('=== 🏛️ 실서버 신규 컨테이너 가동 상태 검증 ===\n');
  const out = execSync('ssh -i E:\\dis_01\\wtrdd_vps_key\\id_ed25519 wtrdd@51.222.206.109 "sudo docker exec wtrdd-discord-app node -e \\"const { getTaxOverview } = require(\'./src/utils/taxEngine\'); getTaxOverview().then(console.log);\\""', { encoding: 'utf8' });
  console.log('1. 컨테이너 내부 taxEngine.getTaxOverview():');
  console.log(out);
} catch (e) {
  console.error('Error:', e.message);
}
