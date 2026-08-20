/**
 * 경제 코호트 분리.
 * 관리자도 플레이는 할 수 있지만, 시세·조절·순위·통화량 집계는
 * 일반 유저 / 관리자 계정으로 나눈다.
 */
const config = require('../config/config');

function adminIdList() {
  return (config.adminIds || []).map((id) => String(id)).filter(Boolean);
}

function idsOrPlaceholder() {
  const ids = adminIdList();
  return ids.length ? ids : ['0'];
}

function sqlIn(column, ids) {
  const list = ids && ids.length ? ids : ['0'];
  return {
    sql: `${column} IN (${list.map(() => '?').join(',')})`,
    params: list
  };
}

function sqlNotIn(column, ids) {
  const list = ids && ids.length ? ids : ['0'];
  return {
    sql: `${column} NOT IN (${list.map(() => '?').join(',')})`,
    params: list
  };
}

function isEconomyPlayerId(userId) {
  const id = String(userId || '');
  if (!/^[0-9]{16,22}$/.test(id)) return false;
  if (id.length === 19 && id.startsWith('9')) return false;
  return true;
}

function sqlDiscordPlayer(column) {
  const col = column || 'u.discord_id';
  return {
    sql: `${col} REGEXP '^[0-9]{16,22}$' AND NOT (CHAR_LENGTH(${col}) = 19 AND ${col} LIKE '9%')`,
    params: []
  };
}

function whereNotAdmin(column) {
  return sqlNotIn(column || 'u.discord_id', idsOrPlaceholder());
}

function wherePublicPlayer(column) {
  const col = column || 'u.discord_id';
  const admin = whereNotAdmin(col);
  const player = sqlDiscordPlayer(col);
  return {
    sql: `${admin.sql} AND ${player.sql}`,
    params: admin.params
  };
}

function whereIsAdmin(column) {
  return sqlIn(column || 'u.discord_id', idsOrPlaceholder());
}

function cohortOf(userId) {
  return config.isAdmin(userId) ? 'admin' : 'user';
}

function whereCohort(column, cohort) {
  return cohort === 'admin' ? whereIsAdmin(column) : whereNotAdmin(column);
}

module.exports = {
  adminIdList,
  idsOrPlaceholder,
  isEconomyPlayerId,
  sqlDiscordPlayer,
  whereNotAdmin,
  wherePublicPlayer,
  whereIsAdmin,
  whereCohort,
  cohortOf
};
