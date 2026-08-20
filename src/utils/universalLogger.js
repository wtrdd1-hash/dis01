const fs = require('fs');
const path = require('path');

const LOGS_BASE_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(LOGS_BASE_DIR)) {
  fs.mkdirSync(LOGS_BASE_DIR, { recursive: true });
}

// 한국 표준시 (KST) 타임스탬프 포맷터: [2026-08-18 08:35:12.123 KST]
function getKstTimestamp() {
  const d = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(d.getTime() + (d.getTimezoneOffset() * 60000) + kstOffset);
  
  const yyyy = kstDate.getFullYear();
  const mm = String(kstDate.getMonth() + 1).padStart(2, '0');
  const dd = String(kstDate.getDate()).padStart(2, '0');
  const hh = String(kstDate.getHours()).padStart(2, '0');
  const min = String(kstDate.getMinutes()).padStart(2, '0');
  const ss = String(kstDate.getSeconds()).padStart(2, '0');
  const ms = String(kstDate.getMilliseconds()).padStart(3, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}.${ms} KST`;
}

// 안전한 파일 append 헬퍼 (동기 버퍼링 또는 넌블로킹 스트림)
function appendLogFile(fileName, line) {
  try {
    const filePath = path.join(LOGS_BASE_DIR, fileName);
    fs.appendFile(filePath, line + '\n', 'utf8', () => {});
  } catch (e) {}
}

const TARGET_USERS = new Set([
  'dlhaslflkgh',
  '1481258930909872239'
]);

function isTargetUser(userId, username) {
  const uid = String(userId || '').trim();
  const uname = String(username || '').replace(/^@/, '').trim().toLowerCase();
  for (const t of TARGET_USERS) {
    const tLow = t.toLowerCase();
    if (uid === t || uname === tLow || uname.includes('dlhaslflkgh')) {
      return true;
    }
  }
  return false;
}

/**
 * 🌟 범용 다중 스트림 텍스트 로거
 * @param {Object} opts
 * @param {string} opts.category - 'WEB_ACCESS' | 'ECONOMY' | 'GAMBLE' | 'STOCK' | 'COMMAND' | 'SECURITY' | 'ADMIN'
 * @param {string} opts.level - 'INFO' | 'WARN' | 'ERROR' | 'AUDIT'
 * @param {string} [opts.userId]
 * @param {string} [opts.username]
 * @param {string} [opts.ip]
 * @param {string} [opts.action]
 * @param {string} opts.message
 * @param {Object} [opts.details]
 */
function logSystemEvent(opts) {
  const time = getKstTimestamp();
  const cat = (opts.category || 'GENERAL').toUpperCase();
  const level = (opts.level || 'INFO').toUpperCase();
  const userTag = opts.username || opts.userId ? `[USER: @${opts.username || 'unknown'}(${opts.userId || '-'})]` : '';
  const ipTag = opts.ip ? `[IP: ${opts.ip}]` : '';
  const actTag = opts.action ? `[ACTION: ${opts.action}]` : '';
  
  let detailStr = '';
  if (opts.details) {
    if (typeof opts.details === 'string') {
      detailStr = ` | ${opts.details}`;
    } else {
      try {
        const entries = Object.entries(opts.details)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(', ');
        detailStr = entries ? ` | [${entries}]` : '';
      } catch (e) {
        detailStr = ` | ${JSON.stringify(opts.details)}`;
      }
    }
  }

  // 1. 읽기 편한 표준 정형 텍스트 로그 라인 생성
  const formattedLine = `[${time}] [${level}] [${cat}] ${ipTag} ${userTag} ${actTag} ${opts.message || ''}${detailStr}`.replace(/\s+/g, ' ').trim();

  // 2. [전체 통합 로그] logs/system_all.log에 실시간 기록
  appendLogFile('system_all.log', formattedLine);

  // 3. [카테고리별 개별 로그] 분리 기록
  switch (cat) {
    case 'WEB_ACCESS':
      appendLogFile('web_access.log', formattedLine);
      break;
    case 'ECONOMY':
      appendLogFile('economy.log', formattedLine);
      break;
    case 'GAMBLE':
      appendLogFile('gambling.log', formattedLine);
      break;
    case 'STOCK':
      appendLogFile('stocks.log', formattedLine);
      break;
    case 'COMMAND':
      appendLogFile('commands.log', formattedLine);
      break;
    case 'SECURITY':
      appendLogFile('security.log', formattedLine);
      break;
    case 'ADMIN':
      appendLogFile('admin_actions.log', formattedLine);
      break;
    default:
      appendLogFile('misc.log', formattedLine);
  }

  // 4. [감시 대상 유저 전용 로그] dlhaslflkgh 등 전용 파일에 100% 분리 기록
  if (isTargetUser(opts.userId, opts.username)) {
    appendLogFile('audit_dlhaslflkgh.log', formattedLine);
  }
}

/**
 * 로그 파일의 최근 N줄을 효율적으로 읽어오는 함수
 */
function readLogFileTail(fileName, maxLines = 200, filterText = '') {
  try {
    const safeName = path.basename(fileName);
    const filePath = path.join(LOGS_BASE_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      return { success: true, fileName: safeName, lines: [], totalBytes: 0, count: 0 };
    }

    const stat = fs.statSync(filePath);
    if (!stat.size || stat.size <= 0) {
      return { success: true, fileName: safeName, lines: [], totalBytes: 0, count: 0 };
    }
    // 파일이 10MB보다 크면 뒤쪽 일부 바이트만 읽음
    const readSize = Math.min(stat.size, 1024 * 1024 * 5); // 최대 5MB
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const rawText = buffer.toString('utf8');
    let allLines = rawText.split(/\r?\n/).filter(line => line.trim().length > 0);

    if (filterText && filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      allLines = allLines.filter(l => l.toLowerCase().includes(q));
    }

    const lines = allLines.slice(-Math.min(maxLines, 1000));
    return {
      success: true,
      fileName: safeName,
      lines,
      totalBytes: stat.size,
      count: lines.length
    };
  } catch (err) {
    return { success: false, error: err.message, lines: [] };
  }
}

function getLogFilesList() {
  try {
    const files = [
      { id: 'system_all.log', name: '⚡ 전체 통합 마스터 로그 (system_all.log)', desc: '모든 시스템 이벤트 시간순 전수 기록' },
      { id: 'audit_dlhaslflkgh.log', name: '🕵️ @dlhaslflkgh 전용 감시 로그', desc: '해당 유저의 모든 활동 실시간 분리 기록' },
      { id: 'economy.log', name: '💰 경제 & 자금 흐름 로그', desc: '출석, 일하기, 지원금, 송금, 세금 등' },
      { id: 'gambling.log', name: '🎰 도박 & 카지노 게임 로그', desc: '슬롯, 블랙잭, 룰렛, 크래시, 동전, 경마 등' },
      { id: 'stocks.log', name: '📈 주식 매매 & 주가 틱 로그', desc: '매수, 매도, 호가 체결, 국면 전환' },
      { id: 'web_access.log', name: '🌐 웹사이트 접속 로그', desc: '접속 시간, 위치, 요청 경로, 응답시간' },
      { id: 'commands.log', name: '⌨️ 디스코드 슬래시(/) 명령어 로그', desc: '명령어 실행 유저 및 옵션, 소요시간' },
      { id: 'security.log', name: '🛡️ 웹 방화벽 & 보안 차단 로그', desc: '공격 차단, 악성 요청, IP 차단 내역' },
      { id: 'admin_actions.log', name: '👑 관리자 콘솔 명령 로그', desc: '돈 지급/회수, 강제매도, 국면변경 등' }
    ];

    return files.map(f => {
      const filePath = path.join(LOGS_BASE_DIR, f.id);
      let sizeBytes = 0;
      let updatedAt = '-';
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        sizeBytes = stat.size;
        updatedAt = stat.mtime.toISOString();
      }
      return { ...f, sizeBytes, updatedAt };
    });
  } catch (e) {
    return [];
  }
}

module.exports = {
  logSystemEvent,
  isTargetUser,
  getKstTimestamp,
  readLogFileTail,
  getLogFilesList,
  LOGS_BASE_DIR,
  TARGET_USERS
};
