const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { lookupIp } = require('./geoIp');

const TARGET_USERS = new Set([
  'dlhaslflkgh',
  '1481258930909872239'
]);

const AUDIT_DIR = path.join(__dirname, '../../logs/audit_targets');
if (!fs.existsSync(AUDIT_DIR)) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

// 전용 감사 테이블 초기화
async function initDedicatedAuditTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_dedicated_audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        category VARCHAR(32) NOT NULL,
        action VARCHAR(64) NOT NULL,
        amount DECIMAL(65,0) NULL,
        balance_after DECIMAL(65,0) NULL,
        ip VARCHAR(64) NULL,
        country VARCHAR(100) NULL,
        details JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_user (user_id),
        INDEX idx_audit_cat (category),
        INDEX idx_audit_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (err) {
    console.error('user_dedicated_audit_logs 테이블 초기화 실패:', err);
  }
}
initDedicatedAuditTable();

function isTargetUser(userId, username) {
  if (!userId && !username) return false;
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

function addTargetUser(identifier) {
  if (identifier) TARGET_USERS.add(String(identifier).trim());
}

async function recordDedicatedAudit(entry) {
  const { userId, username, category, action, amount, balanceAfter, ip, country, details } = entry;
  if (!isTargetUser(userId, username)) return;

  const uid = String(userId || 'unknown');
  const uname = String(username || 'dlhaslflkgh');
  const cat = String(category || 'GENERAL').toUpperCase();
  const act = String(action || 'EVENT');
  const amtStr = amount !== undefined && amount !== null ? amount.toString() : null;
  const balStr = balanceAfter !== undefined && balanceAfter !== null ? balanceAfter.toString() : null;
  const clientIp = String(ip || '').trim() || null;

  let geoCountry = country;
  if (!geoCountry && clientIp && clientIp !== '127.0.0.1' && clientIp !== 'localhost') {
    const geo = lookupIp(clientIp);
    if (geo) geoCountry = `${geo.flag || ''} ${geo.countryName || geo.country || ''}`.trim();
  }

  // 1. DB 테이블 영구 저장
  try {
    await pool.query(`
      INSERT INTO user_dedicated_audit_logs (user_id, username, category, action, amount, balance_after, ip, country, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uid,
      uname,
      cat,
      act,
      amtStr,
      balStr,
      clientIp,
      geoCountry || null,
      details ? JSON.stringify(details) : null
    ]);
  } catch (err) {
    console.error('user_dedicated_audit_logs INSERT 실패:', err.message);
  }

  // 2. 표준 텍스트 .log 파일(system_all.log & audit_dlhaslflkgh.log & 카테고리별.log) 실시간 기록
  try {
    const { logSystemEvent } = require('./universalLogger');
    logSystemEvent({
      category: cat,
      level: 'AUDIT',
      userId: uid,
      username: uname,
      ip: clientIp,
      action: act,
      message: amtStr ? `금액: ${Number(amtStr).toLocaleString()}원 (잔여: ${balStr ? Number(balStr).toLocaleString() + '원' : '-'})` : `활동: ${act}`,
      details
    });
  } catch (e) {}
}

async function getDedicatedAuditLogs(userId, limit = 100) {
  const [rows] = await pool.query(`
    SELECT * FROM user_dedicated_audit_logs
    ORDER BY id DESC
    LIMIT ?
  `, [Number(limit) || 100]);
  return rows;
}

module.exports = {
  isTargetUser,
  addTargetUser,
  recordDedicatedAudit,
  getDedicatedAuditLogs,
  TARGET_USERS
};
