/**
 * 🛡️ CSRF 토큰 가드 (관리자 라우트 보호용)
 */
const csrf = require('../utils/csrf');

module.exports = {
  requireCsrf: csrf.requireCsrf,
  ensureToken: csrf.ensureToken,
  exposeTokenHeader: csrf.exposeTokenHeader,
  issueCsrfToken: csrf.issueCsrfToken,
  clearCsrfCookie: csrf.clearCsrfCookie,
  verifyToken: csrf.verifyToken
};
