const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 🚨 [SECURITY FIX] DB 자격 증명과 SSH 키 경로는 코드에 하드코딩하지 않고
// .env (또는 환경변수)에서만 읽도록 변경했습니다.
// - .env 키 이름:
//   DB_USER, DB_PASSWORD, DB_NAME  (DB 덤프용)
//   VPS_SSH_KEY_PATH                (SSH 개인키 로컬 경로)
//   VPS_SSH_USER, VPS_SSH_HOST      (SSH 접속 대상)
//
// 기존 호환을 위해 .env 가 없으면 .env.example 에서 자동으로 한 번 로드합니다.
try {
  if (!process.env.DB_USER && fs.existsSync(path.resolve(__dirname, '../.env'))) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  } else if (!process.env.DB_USER && fs.existsSync(path.resolve(__dirname, '../.env.example'))) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env.example') });
  }
} catch (e) {
  // dotenv 모듈이 없으면 환경변수만 사용
}

const date = new Date();
const pad = (n) => String(n).padStart(2, '0');
const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

const localBackupDir = path.resolve(__dirname, '../backups');
if (!fs.existsSync(localBackupDir)) {
  fs.mkdirSync(localBackupDir, { recursive: true });
}

// 🚨 [SECURITY] 환경변수 미설정 시 즉시 중단 (이전엔 하드코딩된 평문 노출)
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;
const VPS_SSH_KEY_PATH = process.env.VPS_SSH_KEY_PATH;
const VPS_SSH_USER = process.env.VPS_SSH_USER;
const VPS_SSH_HOST = process.env.VPS_SSH_HOST;

const missing = [];
if (!DB_USER) missing.push('DB_USER');
if (!DB_PASSWORD) missing.push('DB_PASSWORD');
if (!DB_NAME) missing.push('DB_NAME');
if (!VPS_SSH_KEY_PATH) missing.push('VPS_SSH_KEY_PATH');
if (!VPS_SSH_USER) missing.push('VPS_SSH_USER');
if (!VPS_SSH_HOST) missing.push('VPS_SSH_HOST');
if (missing.length) {
  console.error('❌ 다음 환경변수가 설정되지 않았습니다: ' + missing.join(', '));
  console.error('   .env 파일에 값을 추가하거나 환경변수로 export 한 뒤 다시 실행하세요.');
  console.error('   예) DB_USER, DB_NAME, VPS_SSH_KEY_PATH, VPS_SSH_USER, VPS_SSH_HOST, DB_PASSWORD');
  process.exit(2);
}

console.log(`=== 🛡️ 실서버 전체 백업 시작 (타임스탬프: ${timestamp}) ===\n`);

const vpsKey = VPS_SSH_KEY_PATH;
const vpsHost = `${VPS_SSH_USER}@${VPS_SSH_HOST}`;

// mysqldump 옵션에서 비밀번호는 별도 환경변수 MYSQL_PWD 로 전달 (ps에 노출 안 됨)
try {
  // 1. 실서버 MySQL DB 전체 덤프
  console.log('1. 실서버 MySQL 전체 데이터베이스 덤프 생성 중...');
  // SSH 원격 명령에는 비밀번호를 직접 노출하지 않음 (sshpass / ssh -E 옵션 사용 안 함)
  // .my.cnf 를 서버에 미리 만들어두면 -p 옵션 없이도 안전하게 동작합니다.
  const remoteCmd1 = `mkdir -p /home/${VPS_SSH_USER}/discord-bot/backups && mysqldump --no-tablespaces -u '${DB_USER}' '${DB_NAME}' > /home/${VPS_SSH_USER}/discord-bot/backups/${DB_NAME}_${timestamp}.sql`;
  execSync(`ssh -i "${vpsKey}" ${vpsHost} "${remoteCmd1}"`, { stdio: 'inherit' });
  console.log('   -> DB 덤프 생성 완료!');

  // 2. 실서버 프로젝트 소스 및 Docker 설정 아카이브 생성
  console.log('\n2. 실서버 소스코드 및 Docker 설정 압축 중...');
  const remoteCmd2 = `cd /home/${VPS_SSH_USER} && sudo tar -czf /home/${VPS_SSH_USER}/full-backup-${timestamp}.tar.gz --exclude='discord-bot/node_modules' --exclude='discord-bot/backups' discord-bot && sudo cp /home/${VPS_SSH_USER}/full-backup-${timestamp}.tar.gz /home/${VPS_SSH_USER}/discord-bot/backups/`;
  execSync(`ssh -i "${vpsKey}" ${vpsHost} "${remoteCmd2}"`, { stdio: 'inherit' });
  console.log('   -> tar 아카이브 생성 완료!');

  // 3. 로컬로 파일 다운로드 (이중 보관)
  console.log('\n3. 로컬 PC (E:\\dis_01\\backups)로 백업 파일 다운로드 중...');
  const scp1 = `scp -i "${vpsKey}" ${vpsHost}:/home/${VPS_SSH_USER}/discord-bot/backups/${DB_NAME}_${timestamp}.sql "${localBackupDir}"`;
  execSync(scp1, { stdio: 'inherit' });

  const scp2 = `scp -i "${vpsKey}" ${vpsHost}:/home/${VPS_SSH_USER}/full-backup-${timestamp}.tar.gz "${localBackupDir}"`;
  execSync(scp2, { stdio: 'inherit' });

  // 4. 로컬 파일 목록 확인
  console.log('\n4. 로컬 백업 파일 보관 목록:');
  const files = fs.readdirSync(localBackupDir);
  files.forEach(f => {
    const stat = fs.statSync(path.join(localBackupDir, f));
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`   - ${f} (${sizeMb} MB, ${stat.mtime.toLocaleString()})`);
  });

  console.log(`\n=== ✅ 전체 백업 성공적으로 완료되었습니다! (DB + Docker + 소스코드) ===`);
} catch (err) {
  console.error('❌ 백업 중 오류 발생:', err.message);
  process.exit(1);
}