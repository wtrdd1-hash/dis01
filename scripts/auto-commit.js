const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEBOUNCE_MS = 5000; // 5초간 추가 변경이 없으면 커밋 & 푸시 진행

let timer = null;
const changedFiles = new Set();

// 감시에서 제외할 디렉터리 및 파일 목록
const IGNORED_PATTERNS = [
  'node_modules',
  '.git',
  'logs',
  'scratch',
  '.env'
];

function isIgnored(filePath) {
  if (!filePath) return true;
  const normalized = filePath.replace(/\\/g, '/');
  
  // .env 관련 파일 전체 차단
  if (normalized.includes('.env')) return true;

  // 기타 제외 패턴 검사
  return IGNORED_PATTERNS.some(pattern => {
    return normalized === pattern || 
           normalized.startsWith(`${pattern}/`) || 
           normalized.includes(`/${pattern}/`);
  });
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

    const fileArray = Array.from(changedFiles);
    const filesList = fileArray.slice(0, 3).join(', ');
    const moreCount = fileArray.length > 3 ? ` 외 ${fileArray.length - 3}개` : '';
    const fileSummary = filesList ? `${filesList}${moreCount}` : '파일 수정';

    const now = new Date();
    const timestamp = now.toLocaleDateString('ko-KR') + ' ' + now.toLocaleTimeString('ko-KR');
    const commitMsg = `auto: ${fileSummary} (${timestamp})`;

    console.log(`\n[Auto-Commit] 🔄 변경 사항 감지! 백업 진행 중... (${fileSummary})`);
    
    await runCommand('git add .');
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
  if (!filename || isIgnored(filename)) return;

  const baseName = path.basename(filename);
  changedFiles.add(baseName);
  console.log(`[Auto-Commit Watcher] 📝 파일 변경 감지: ${filename} (5초 후 자동 백업예정)`);

  if (timer) clearTimeout(timer);
  timer = setTimeout(doAutoCommit, DEBOUNCE_MS);
}

console.log(`=======================================================`);
console.log(`[Auto-Commit Watcher] Git 자동 백업 감시 시작됨 (디바운스: 5초)`);
console.log(`제외 대상: .env*, node_modules, .git, logs, scratch`);
console.log(`=======================================================\n`);

fs.watch(ROOT_DIR, { recursive: true }, (eventType, filename) => {
  scheduleCommit(filename);
});
