const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEBOUNCE_MS = 5000; // 5초간 추가 변경이 없으면 커밋 & 푸시 진행

let timer = null;
const changedFiles = new Set();

// 🚨 [SECURITY] 절대 차단 패턴 (디렉터리/파일 단위)
// - 이 목록에 들어간 항목은 fs.watch에서 변경이 감지돼도 커밋 대상에서 제외됩니다.
const IGNORED_PATTERNS = [
  'node_modules',
  '.git',
  'logs',
  'scratch',
  '.env',
  'wtrdd_vps_key',
  'backups',
  'uploads'
];

// 🚨 [SECURITY] 민감 확장자 차단
const IGNORED_EXTENSIONS = [
  '.sql', '.sql.gz', '.sql.bak', '.dump', '.mysqldump',
  '.sqlite3', '.db',
  '.tar.gz', '.tgz', '.zip', '.7z', '.rar',
  '.pem', '.key', '.p12', '.pfx',
  '.env', '.env.local', '.env.production'
];

// 🚨 [SECURITY] 차단 정규식 (파일명에 특정 키워드가 포함되면 차단)
const IGNORED_KEYWORDS = [
  'password', 'secret', 'credential', 'token',
  'backup', 'dump'
];

function isIgnored(filePath) {
  if (!filePath) return true;
  const normalized = filePath.replace(/\\/g, '/');
  const baseName = path.basename(normalized);

  // .env 관련 파일 전체 차단
  if (normalized.includes('.env') || baseName.startsWith('.env')) return true;

  // 디렉터리/파일 패턴 검사
  for (const pattern of IGNORED_PATTERNS) {
    if (
      normalized === pattern ||
      normalized.startsWith(`${pattern}/`) ||
      normalized.includes(`/${pattern}/`)
    ) {
      return true;
    }
  }

  // 확장자 검사
  const lower = baseName.toLowerCase();
  for (const ext of IGNORED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }

  // 키워드 검사
  for (const kw of IGNORED_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  return false;
}

// 🚨 [SECURITY] 백업 압축파일 단일 컷 (auto-commit이 절대 안 만지도록)
function isBlocklistedBackupArtifact(filePath) {
  if (!filePath) return false;
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith('bot.') && base.endsWith('.tar.gz')) return true;
  if (base === 'discord-bot.zip') return true;
  if (base.startsWith('project_backup_') && base.endsWith('.zip')) return true;
  if (base.startsWith('project_full_backup_') && base.endsWith('.tar.gz')) return true;
  if (base.startsWith('project_') && (base.endsWith('.zip') || base.endsWith('.tar.gz'))) return true;
  return false;
}

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: ROOT_DIR }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout ? stdout.trim() : '');
    });
  });
}

async function doAutoCommit() {
  try {
    const status = await runCommand('git status --porcelain');
    if (!status) {
      changedFiles.clear();
      return;
    }

    // 🚨 [SECURITY] porcelain 출력에서 위험 파일은 제외하고 stage
    const lines = status.split('\n').filter(Boolean);
    const staged = [];
    const skipped = [];
    for (const line of lines) {
      const pathStr = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
      const targetPath = pathStr.includes(' -> ') ? pathStr.split(' -> ').pop() : pathStr;
      if (isIgnored(targetPath) || isBlocklistedBackupArtifact(targetPath)) {
        skipped.push(targetPath);
        continue;
      }
      try {
        await runCommand(`git add -- "${targetPath}"`);
        staged.push(targetPath);
      } catch (e) {
        // 개별 파일 add 실패는 무시하고 계속 진행
      }
    }

    if (!staged.length) {
      console.log(`[Auto-Commit] ⏭ 모든 변경 사항이 제외되어 커밋 대상이 없습니다 (스킵 ${skipped.length}개)`);
      changedFiles.clear();
      return;
    }

    // 스테이지 후 실제로 커밋할 게 있는지 확인
    const diffCached = await runCommand('git diff --cached --name-only');
    if (!diffCached) {
      console.log('[Auto-Commit] ⏭ 스테이지된 변경이 없습니다.');
      changedFiles.clear();
      return;
    }

    const filesList = staged.slice(0, 3).join(', ');
    const moreCount = staged.length > 3 ? ` 외 ${staged.length - 3}개` : '';
    const fileSummary = `${filesList}${moreCount}`;

    const now = new Date();
    const timestamp = now.toLocaleDateString('ko-KR') + ' ' + now.toLocaleTimeString('ko-KR');
    const commitMsg = `auto: ${fileSummary} (${timestamp})`;

    console.log(`\n[Auto-Commit] 🔄 ${staged.length}개 파일 백업 진행 중... (${fileSummary})`);
    if (skipped.length) {
      console.log(`[Auto-Commit] 🛡️ 보안 제외: ${skipped.length}개 (백업/SQL/시크릿)`);
    }

    await runCommand(`git commit -m "${commitMsg}"`);
    console.log(`[Auto-Commit] ✅ 로컬 커밋 완료: "${commitMsg}"`);

    await runCommand('git push origin main');
    console.log(`[Auto-Commit] 🚀 GitHub 원격 저장소 푸시 완료!\n`);

    changedFiles.clear();
  } catch (err) {
    console.error(`[Auto-Commit Error] 백업 중 오류 발생:`, err.message);
  }
}

function scheduleCommit(filename) {
  if (!filename || isIgnored(filename) || isBlocklistedBackupArtifact(filename)) {
    return;
  }

  const baseName = path.basename(filename);
  changedFiles.add(baseName);
  console.log(`[Auto-Commit Watcher] 📝 파일 변경 감지: ${filename} (5초 후 자동 백업예정)`);

  if (timer) clearTimeout(timer);
  timer = setTimeout(doAutoCommit, DEBOUNCE_MS);
}

console.log(`=======================================================`);
console.log(`[Auto-Commit Watcher] Git 자동 백업 감시 시작됨 (디바운스: 5초)`);
console.log(`제외 대상: .env*, node_modules, .git, logs, scratch, backups/, *.sql, *.dump, *.tar.gz, *.zip, *.pem, *.key`);
console.log(`[SECURITY] git add . → 화이트리스트 add 방식으로 자동 커밋 안전화 적용`);
console.log(`=======================================================\n`);

fs.watch(ROOT_DIR, { recursive: true }, (eventType, filename) => {
  if (filename) scheduleCommit(filename);
});