'use strict';
/**
 * 관리자 페이지 라우터 (HTML 렌더링 전용)
 *
 * server.js 안에 인라인으로 박혀 있던 9개 관리자 페이지 핸들러를 분리.
'use strict';
/**
 * 관리자 페이지 라우터 (HTML 렌더링 전용)
 *
 * server.js 안에 인라인으로 박혀 있던 9개 관리자 페이지 핸들러를 분리.
 * - /admin/users       : 유저 자산/차단 관리
 * - /admin/economy     : 실시간 자금 흐름
 * - /admin/audit       : 특정 유저 정밀 관제
 * - /admin/stocks      : 주주 명부 & 보유 주식
 * - /admin/tax         : 세금 국고 & 거래세 정책
 * - /admin/loans       : 대출 현황
 * - /admin/console     : 시스템 명령 조작
 * - /admin/security    : 보안 차단 관리
 * - /admin/inquiries   : 1:1 문의
 * - /admin/logs        : 종합 로그 뷰어
 *
 * 모든 핸들러는 `requireAdminWeb` 가드를 통과해야 호출된다.
 */

function createAdminPageRoutes(deps) {
  const {
    pool,
    config,
    requireAdminWeb,
    escapeHtml,
    escapeJsStr,
    formatMoney,
    formatMoneyCompact,
    formatKstDateTime,
    safeBigInt,
    amountToUnits,
    mulPriceAmount,
    NET_WORTH_SQL,
    getBannedIpsList,
    getWhitelistedIpsList,
    lookupIp,
    getFlagEmoji
  } = deps;

  return function adminPageRoutes(app) {
    // ───────────────────────────────────────────
    // 0. /admin 진입 시 /admin/users 로 리다이렉트
    // ───────────────────────────────────────────
    app.get('/admin', (req, res) => res.redirect('/admin/users'));
    // /admin/admins 진입 시 /admin/users 의 관리자 계정 섹션으로 안내
    app.get('/admin/admins', requireAdminWeb, (req, res) => res.redirect('/admin/users#admin-users'));
    // 공지 등록 화면을 관리자 메뉴에서 바로 열 수 있는 고정 진입점
    app.get('/admin/announcements', requireAdminWeb, (req, res) => res.redirect('/admin/console#announcement-manager'));

    // 🛍️ 가상경제 소비 및 외형/제작/덕하우스 관리자 대시보드
    app.get('/admin/spending', requireAdminWeb, (req, res) => {
      res.render('admin/spending', {
        adminUser: req.session?.user || req.session?.localUser || {},
        pageTitle: '가상경제 소비 & 외형 & 덕하우스 전권 관리',
        pageHeader: '가상경제 소비 & 외형 & 덕하우스 관리',
        activeMenu: 'spending'
      });
    });

    // ───────────────────────────────────────────
    // 1. 유저 자산 페이지 (/admin/users)
    // ───────────────────────────────────────────
    app.get('/admin/users', requireAdminWeb, async (req, res) => {
      try {
        const [allUsersWealth] = await pool.query(`
          SELECT
            u.discord_id, u.username, u.cash, u.bank, u.created_at,
            u.is_banned, u.banned_until, u.ban_reason,
            CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0)) AS stock_val,
            ${NET_WORTH_SQL} AS net_worth
          FROM users u
          LEFT JOIN user_stocks us ON u.discord_id = us.user_id
          LEFT JOIN stocks s ON us.stock_id = s.stock_id
          GROUP BY u.discord_id, u.username, u.cash, u.bank, u.created_at, u.is_banned, u.banned_until, u.ban_reason
          ORDER BY net_worth DESC
        `);

        const regularUsers = allUsersWealth.filter((u) => !config.isAdmin(u.discord_id));
        const adminUsers = allUsersWealth.filter((u) => config.isAdmin(u.discord_id));

        let totalCashSum = 0n, totalBankSum = 0n, totalStockSum = 0n, totalNetSum = 0n;
        for (const u of regularUsers) {
          totalCashSum += safeBigInt(u.cash);
          totalBankSum += safeBigInt(u.bank);
          totalStockSum += safeBigInt(u.stock_val);
          totalNetSum += safeBigInt(u.net_worth);
        }
        const summaryStats = {
          totalUsersCount: regularUsers.length,
          adminCount: adminUsers.length,
          totalCash: totalCashSum, totalBank: totalBankSum,
          totalStock: totalStockSum, totalNet: totalNetSum
        };

        const { getTaxKing } = require('../utils/taxEngine');
        const taxKing = await getTaxKing();
        const taxKingId = taxKing ? String(taxKing.userId) : null;

                const renderUserRows = (usersList) => {
          let html = '';
          const now = Date.now();
          for (const u of usersList) {
            const cash = safeBigInt(u.cash);
            const bank = safeBigInt(u.bank);
            const stockVal = safeBigInt(u.stock_val);
            const net = safeBigInt(u.net_worth);
            const isTaxKingUser = taxKingId && String(u.discord_id) === taxKingId;

            let banBadge = '';
            let isCurrentlyBanned = false;
            if (u.is_banned) {
              if (u.banned_until) {
                const untilTime = new Date(u.banned_until).getTime();
                if (untilTime > now) {
                  isCurrentlyBanned = true;
                  const remMins = Math.ceil((untilTime - now) / 60000);
                  const h = Math.floor(remMins / 60);
                  const m = remMins % 60;
                  const timeStr = h > 0 ? `${h}시간 ${m}분` : `${m}분`;
                  banBadge = `<span style="background:rgba(239,68,68,0.2); border:1px solid #ef4444; color:#f87171; font-size:0.7rem; font-weight:800; padding:2px 6px; border-radius:4px;" title="사유: ${escapeHtml(u.ban_reason || '')}">⏳ 정지 (${timeStr})</span>`;
                }
              } else {
                isCurrentlyBanned = true;
                banBadge = `<span style="background:rgba(239,68,68,0.2); border:1px solid #ef4444; color:#f87171; font-size:0.7rem; font-weight:800; padding:2px 6px; border-radius:4px;" title="사유: ${escapeHtml(u.ban_reason || '')}">🔒 영구 차단</span>`;
              }
            }

            html += `
              <tr style="${isCurrentlyBanned ? 'background: rgba(239, 68, 68, 0.08);' : (isTaxKingUser ? 'background: rgba(245, 158, 11, 0.05);' : '')}">
                <td>
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span style="font-weight:700; color:#f8fafc;">@${escapeHtml(u.username)}</span>
                    ${isTaxKingUser ? '<span style="background:linear-gradient(135deg, #d97706, #f59e0b); color:#1e1b4b; font-size:0.72rem; font-weight:900; padding:2px 7px; border-radius:4px; box-shadow:0 0 10px rgba(245,158,11,0.35);">👑 세금왕</span>' : ''}
                    ${banBadge}
                  </div>
                  <code style="font-size:0.72rem; color:#64748b;">${escapeHtml(u.discord_id)}</code>
                </td>
                <td style="text-align:right; color:#34d399; font-weight:800; font-size:0.92rem; white-space:nowrap;" title="${formatMoney(cash)}">${formatMoneyCompact(cash)}</td>
                <td style="text-align:right; color:#60a5fa; font-weight:700; white-space:nowrap;" title="${formatMoney(bank)}">${formatMoneyCompact(bank)}</td>
                <td style="text-align:right; color:#fbbf24; font-weight:700; white-space:nowrap;" title="${formatMoney(stockVal)}">${formatMoneyCompact(stockVal)}</td>
                <td style="text-align:right; font-weight:800; color:#f59e0b; font-size:0.95rem; white-space:nowrap;" title="${formatMoney(net)}">${formatMoneyCompact(net)}</td>
                <td style="text-align:center; white-space:nowrap;">
                  <button type="button" onclick="openQuickMoneyModal('${escapeJsStr(u.discord_id)}', '${escapeJsStr(u.username)}')" style="background:#059669; border:1px solid #10b981; color:#fff; padding:4px 8px; border-radius:6px; font-size:0.75rem; cursor:pointer; font-weight:700; margin-right:4px;">💵 자금</button>
                  <button type="button" onclick="openUserEditModal('${escapeJsStr(u.discord_id)}', '${escapeJsStr(u.username)}')" style="background:#4f46e5; border:1px solid #818cf8; color:#fff; padding:4px 8px; border-radius:6px; font-size:0.75rem; cursor:pointer; font-weight:700; margin-right:4px;">✏️ 수정</button>
                  <button type="button" onclick="showUserStocksModal('${escapeJsStr(u.discord_id)}', '${escapeJsStr(u.username)}')" style="background:#0284c7; border:1px solid #38bdf8; color:#fff; padding:4px 8px; border-radius:6px; font-size:0.75rem; cursor:pointer; font-weight:700; margin-right:4px;">📊 주식</button>
                  <button type="button" onclick="openUserBanModal('${escapeJsStr(u.discord_id)}', '${escapeJsStr(u.username)}', ${isCurrentlyBanned})" style="background:${isCurrentlyBanned ? '#10b981' : '#dc2626'}; border:1px solid ${isCurrentlyBanned ? '#34d399' : '#f87171'}; color:#fff; padding:4px 8px; border-radius:6px; font-size:0.75rem; cursor:pointer; font-weight:800; margin-right:4px;">${isCurrentlyBanned ? '🔓 해제' : '🚫 차단'}</button>
                  <button type="button" onclick="showUserIps('${escapeJsStr(u.discord_id)}')" style="background:#334155; border:1px solid rgba(255,255,255,0.15); color:#cbd5e1; padding:4px 8px; border-radius:6px; font-size:0.75rem; cursor:pointer;">🌐 IP</button>
                </td>
              </tr>`;
          }
          return html;
        };

        res.render('admin/users', {
          adminUser: req.adminUser,
          summaryStats,
          adminIds: (config.adminIds || []).map(String),
          userRowsHtml: renderUserRows(regularUsers) || '<tr><td colspan="6" style="text-align:center; color:#9ca3af; padding:30px;">일반 유저가 없습니다.</td></tr>',
          adminUserRowsHtml: renderUserRows(adminUsers) || '<tr><td colspan="6" style="text-align:center; color:#9ca3af; padding:30px;">관리자 계정이 없습니다.</td></tr>'
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('유저 자산 페이지 로드 실패');
      }
    });

       // ───────────────────────────────────────────
    // 1-2. 실시간 자금 흐름 페이지 (/admin/economy)
    // ───────────────────────────────────────────
    app.get('/admin/economy', requireAdminWeb, async (req, res) => {
      try {
        const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.lines || req.query.limit, 10) || 50, 10), 200);
        const typeFilter = String(req.query.type || '').trim();
        const search = String(req.query.search || '').trim();

        const whereClauses = [];
        const params = [];
        if (typeFilter) {
          whereClauses.push('type LIKE ?');
          params.push(`%${typeFilter}%`);
        }
        if (search) {
          whereClauses.push('(username LIKE ? OR user_id LIKE ? OR description LIKE ?)');
          params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

        const [[countRow]] = await pool.query('SELECT COUNT(*) as cnt FROM economy_logs');
        const totalLogCount = (countRow && countRow.cnt) ? countRow.cnt.toLocaleString() : '0';
        const [[filteredCountRow]] = await pool.query(`SELECT COUNT(*) as cnt FROM economy_logs ${whereSql}`, params);
        const totalFiltered = filteredCountRow ? filteredCountRow.cnt : 0;
        const totalPages = Math.max(Math.ceil(totalFiltered / limit), 1);
        const page = Math.min(requestedPage, totalPages);
        const offset = (page - 1) * limit;

        const queryParams = [...params, limit, offset];
        const [logs] = await pool.query(`SELECT * FROM economy_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, queryParams);

        const { wherePublicPlayer } = require('../utils/economyCohort');
        const playerFilter = wherePublicPlayer('user_id');

        const [[inflowRow]] = await pool.query(`
          SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) as inflow
          FROM economy_logs
          WHERE created_at >= NOW() - INTERVAL 24 HOUR
            AND CAST(balance_after AS DECIMAL(65,0)) >= CAST(balance_before AS DECIMAL(65,0))
            AND type NOT LIKE '%ADMIN%'
            AND user_id NOT IN ('SYSTEM', 'TREASURY')
            AND ${playerFilter.sql}
        `, playerFilter.params);

        const [[outflowRow]] = await pool.query(`
          SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) as outflow
          FROM economy_logs
          WHERE created_at >= NOW() - INTERVAL 24 HOUR
            AND CAST(balance_after AS DECIMAL(65,0)) < CAST(balance_before AS DECIMAL(65,0))
            AND type NOT LIKE '%ADMIN%'
            AND user_id NOT IN ('SYSTEM', 'TREASURY')
            AND ${playerFilter.sql}
        `, playerFilter.params);

        const flowStats = {
          inflow24h: inflowRow ? inflowRow.inflow : '0',
          outflow24h: outflowRow ? outflowRow.outflow : '0'
        };

        const getTypeBadge = (type) => {
          const t = String(type || '').toUpperCase();
          if (t.includes('ADMIN')) return '<span class="eco-badge eco-badge-admin">👑 ' + escapeHtml(type) + '</span>';
          if (t.includes('BUSINESS')) return '<span class="eco-badge eco-badge-biz">🏢 ' + escapeHtml(type) + '</span>';
          if (t.includes('INFLOW')) return '<span class="eco-badge eco-badge-in">📥 ' + escapeHtml(type) + '</span>';
          if (t.includes('OUTFLOW')) return '<span class="eco-badge eco-badge-out">📤 ' + escapeHtml(type) + '</span>';
          if (t.includes('GAMBLE') || t.includes('CASINO')) return '<span class="eco-badge eco-badge-gamble">🎰 ' + escapeHtml(type) + '</span>';
          if (t.includes('STOCK')) return '<span class="eco-badge eco-badge-stock">📈 ' + escapeHtml(type) + '</span>';
          if (t.includes('TAX')) return '<span class="eco-badge eco-badge-tax">🏛️ ' + escapeHtml(type) + '</span>';
          if (t.includes('LOAN')) return '<span class="eco-badge eco-badge-loan">💳 ' + escapeHtml(type) + '</span>';
          if (t.includes('TRANSFER')) return '<span class="eco-badge eco-badge-transfer">💸 ' + escapeHtml(type) + '</span>';
          if (t.includes('DAILY') || t.includes('WORK')) return '<span class="eco-badge eco-badge-daily">💼 ' + escapeHtml(type) + '</span>';
          return '<span class="eco-badge eco-badge-default">' + escapeHtml(type || '-') + '</span>';
        };

        let economyRowsHtml = '';
        if (!logs.length) {
          economyRowsHtml = '<tr><td colspan="8" style="text-align:center; color:#9ca3af; padding:30px;">조건에 일치하는 자금 이동 기록이 없습니다.</td></tr>';
        } else {
          for (const e of logs) {
            const isPlus = BigInt(e.balance_after || 0) >= BigInt(e.balance_before || 0);
            const amt = safeBigInt(e.amount);
            const before = safeBigInt(e.balance_before);
            const after = safeBigInt(e.balance_after);
            economyRowsHtml += `
              <tr data-type="${escapeHtml(e.type || '')}">
                <td style="color:#64748b; font-weight:700; font-size:0.8rem; white-space:nowrap;">#${e.id}</td>
                <td style="font-size:0.8rem; color:#94a3b8; white-space:nowrap;">${formatKstDateTime(e.created_at)}</td>
                <td style="white-space:nowrap;">
                  <div style="font-weight:700; color:#f1f5f9;">@${escapeHtml(e.username || '유저')}</div>
                  <code style="font-size:0.7rem; color:#64748b;">${escapeHtml(e.user_id)}</code>
                </td>
                <td style="white-space:nowrap;">${getTypeBadge(e.type)}</td>
                <td style="text-align:right; white-space:nowrap;">
                  <div style="font-weight:800; font-size:0.92rem; color:${isPlus ? '#34d399' : '#f87171'};" title="${formatMoney(amt)}">
                    ${isPlus ? '+' : '-'}${formatMoneyCompact(amt)}
                  </div>
                </td>
                <td style="text-align:right; white-space:nowrap;">
                  <div style="font-size:0.78rem; color:#94a3b8;" title="${formatMoney(before)}">${formatMoneyCompact(before)}</div>
                  <div style="font-size:0.72rem; color:#64748b;">↓</div>
                  <div style="font-weight:700; font-size:0.84rem; color:#e2e8f0;" title="${formatMoney(after)}">${formatMoneyCompact(after)}</div>
                </td>
                <td style="color:#cbd5e1; font-size:0.82rem; word-break:break-word; min-width:180px; max-width:380px; line-height:1.4;">${escapeHtml(e.description || '-')}</td>
                <td style="text-align:center; white-space:nowrap;">
                  <button type="button" onclick="openQuickMoneyModal('${escapeJsStr(e.user_id)}', '${escapeJsStr(e.username || '유저')}')" style="background:#059669; border:1px solid #10b981; color:#fff; padding:5px 10px; border-radius:6px; font-size:0.75rem; cursor:pointer; font-weight:700; transition:all 0.15s;">💵 자금</button>
                </td>
              </tr>`;
          }
        }

        res.render('admin/economy', {
          adminUser: req.adminUser,
          totalLogCount, totalFiltered, totalPages,
          currentPage: page, currentLimit: limit,
          currentType: typeFilter, currentSearch: search,
          flowStats, economyRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('자금 흐름 페이지 로드 실패');
      }
    });

 // ───────────────────────────────────────────
    // 2. dlhaslflkgh 정밀 관제 페이지 (/admin/audit)
    // ───────────────────────────────────────────
    app.get('/admin/audit', requireAdminWeb, async (req, res) => {
      try {
        let auditUserObj = { username: 'dlhaslflkgh', discordId: '1481258930909872239', cashText: '0원', bankText: '0원' };
        const [targetUserRows] = await pool.query('SELECT discord_id, username, cash, bank FROM users WHERE username = "dlhaslflkgh" OR discord_id = "1481258930909872239" LIMIT 1');
        if (targetUserRows.length) {
          const tu = targetUserRows[0];
          auditUserObj = {
            username: tu.username,
            discordId: tu.discord_id,
            cashText: formatMoney(safeBigInt(tu.cash)),
            bankText: formatMoney(safeBigInt(tu.bank))
          };
        }
        const targetUid = auditUserObj.discordId;

        const [tWeb] = await pool.query('SELECT * FROM web_access_logs WHERE user_id = ? OR username LIKE "%dlhaslflkgh%" ORDER BY id DESC LIMIT 50', [targetUid]);
        let auditWebRowsHtml = '';
        if (!tWeb.length) {
          auditWebRowsHtml = '<tr><td colspan="6" style="text-align:center; color:#6b7280; padding:15px;">접속 기록이 없습니다.</td></tr>';
        } else {
          for (const w of tWeb) {
            const statusClass = w.status_code < 400 ? 'status-ok' : 'status-err';
            const geoText = `${w.country || ''} ${w.country_name || w.city || '-'}`.trim();
            auditWebRowsHtml += `
              <tr>
                <td style="white-space:nowrap; font-size:0.8rem;">${formatKstDateTime(w.created_at)}</td>
                <td>${escapeHtml(geoText)}</td>
                <td class="cell-path"><span class="method-tag">${escapeHtml(w.method || 'GET')}</span> <code>${escapeHtml(w.url || '/')}</code></td>
                <td><span class="${statusClass}">${w.status_code || 200}</span></td>
                <td>${w.duration_ms || 0}ms</td>
                <td style="font-size:0.75rem; color:#9ca3af; max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(w.user_agent || '')}">${escapeHtml(w.user_agent || '-')}</td>
              </tr>`;
          }
        }

        const [tEco] = await pool.query('SELECT * FROM economy_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50', [targetUid]);
        let auditEcoRowsHtml = '';
        if (!tEco.length) {
          auditEcoRowsHtml = '<tr><td colspan="6" style="text-align:center; color:#6b7280; padding:15px;">자금 이동 기록이 없습니다.</td></tr>';
        } else {
          for (const e of tEco) {
            const isPlus = BigInt(e.balance_after || 0) >= BigInt(e.balance_before || 0);
            const color = isPlus ? '#34d399' : '#f87171';
            const sign = isPlus ? '+' : '-';
            auditEcoRowsHtml += `
              <tr>
                <td style="white-space:nowrap; font-size:0.8rem;">${formatKstDateTime(e.created_at)}</td>
                <td><span class="badge-admin">${escapeHtml(e.type || '-')}</span></td>
                <td style="text-align:right; font-weight:800; color:${color};">${sign}${formatMoneyCompact(safeBigInt(e.amount))}</td>
                <td style="text-align:right; color:#9ca3af;">${formatMoneyCompact(safeBigInt(e.balance_before))}</td>
                <td style="text-align:right; color:#cbd5e1; font-weight:700;">${formatMoneyCompact(safeBigInt(e.balance_after))}</td>
                <td style="color:#cbd5e1; font-size:0.8rem;">${escapeHtml(e.description || '-')}</td>
              </tr>`;
          }
        }

        const [tGamble] = await pool.query('SELECT * FROM gambling_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50', [targetUid]);
        let auditGambleRowsHtml = '';
        if (!tGamble.length) {
          auditGambleRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#6b7280; padding:15px;">도박 기록이 없습니다.</td></tr>';
        } else {
          for (const g of tGamble) {
            const prof = safeBigInt(g.profit);
            const isWin = prof >= 0n;
            const color = isWin ? '#34d399' : '#f87171';
            auditGambleRowsHtml += `
              <tr>
                <td style="white-space:nowrap; font-size:0.8rem;">${formatKstDateTime(g.created_at)}</td>
                <td><span class="cmd-tag">${escapeHtml(g.game || '-')}</span></td>
                <td style="text-align:right; color:#cbd5e1;">${formatMoneyCompact(safeBigInt(g.bet))}</td>
                <td style="text-align:right; color:#38bdf8;">${formatMoneyCompact(safeBigInt(g.payout))}</td>
                <td style="text-align:right; font-weight:800; color:${color};">${isWin ? '+' : ''}${formatMoneyCompact(prof)}</td>
                <td style="text-align:right; color:#fbbf24;">${formatMoneyCompact(safeBigInt(g.balance_after))}</td>
                <td>${g.is_rolled_back ? '<span style="color:#f87171;">롤백됨</span>' : '<span style="color:#34d399;">정상</span>'}</td>
              </tr>`;
          }
        }

        const [tStock] = await pool.query('SELECT st.*, s.name as stock_name FROM stock_transactions st JOIN stocks s ON st.stock_id = s.stock_id WHERE st.user_id = ? ORDER BY st.id DESC LIMIT 50', [targetUid]);
        let auditStockRowsHtml = '';
        if (!tStock.length) {
          auditStockRowsHtml = '<tr><td colspan="6" style="text-align:center; color:#6b7280; padding:15px;">주식 매매 체결 기록이 없습니다.</td></tr>';
        } else {
          for (const s of tStock) {
            const isBuy = s.action === 'BUY';
            const color = isBuy ? '#38bdf8' : '#fb923c';
            auditStockRowsHtml += `
              <tr>
                <td style="white-space:nowrap; font-size:0.8rem;">${formatKstDateTime(s.created_at)}</td>
                <td><b>${escapeHtml(s.stock_name || s.stock_id)}</b> (${escapeHtml(s.stock_id)})</td>
                <td><span style="color:${color}; font-weight:700;">${isBuy ? '🛒 매수' : '💰 매도'}</span></td>
                <td style="text-align:right; font-weight:700;">${Number(s.amount).toLocaleString()}주</td>
                <td style="text-align:right; color:#9ca3af;">${formatMoneyCompact(safeBigInt(s.price))}</td>
                <td style="text-align:right; font-weight:800; color:${color};">${formatMoneyCompact(safeBigInt(s.total_price))}</td>
              </tr>`;
          }
        }

        const [tDed] = await pool.query('SELECT * FROM user_dedicated_audit_logs WHERE user_id = ? OR username LIKE "%dlhaslflkgh%" ORDER BY id DESC LIMIT 50', [targetUid]);
        let auditDedicatedRowsHtml = '';
        if (!tDed.length) {
          auditDedicatedRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#6b7280; padding:15px;">블랙박스 감사 기록이 없습니다.</td></tr>';
        } else {
          for (const d of tDed) {
            let detStr = '-';
            if (d.details) {
              try { detStr = typeof d.details === 'string' ? d.details : JSON.stringify(d.details); } catch (e) {}
            }
            auditDedicatedRowsHtml += `
              <tr>
                <td style="white-space:nowrap; font-size:0.8rem;">${formatKstDateTime(d.created_at)}</td>
                <td><span class="badge-admin">${escapeHtml(d.category || 'EVENT')}</span></td>
                <td><b>${escapeHtml(d.action || '-')}</b></td>
                <td style="text-align:right; color:#38bdf8; font-weight:700;">${d.amount ? formatMoneyCompact(safeBigInt(d.amount)) : '-'}</td>
                <td style="text-align:right; color:#fbbf24;">${d.balance_after ? formatMoneyCompact(safeBigInt(d.balance_after)) : '-'}</td>
                <td>${escapeHtml(d.country || '🌐 접속')}</td>
                <td style="font-size:0.75rem; color:#cbd5e1; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(detStr)}">${escapeHtml(detStr)}</td>
              </tr>`;
          }
        }

        res.render('admin/audit', {
          adminUser: req.adminUser,
          auditUserObj,
          auditWebRowsHtml, auditEcoRowsHtml, auditGambleRowsHtml,
          auditStockRowsHtml, auditDedicatedRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('정밀 관제 페이지 로드 실패');
      }
    });

    // ───────────────────────────────────────────
    // 3. 주주 명부 페이지 (/admin/stocks)
    // ───────────────────────────────────────────
    app.get('/admin/stocks', requireAdminWeb, async (req, res) => {
      try {
        const [ssrHolders] = await pool.query(`
          SELECT
            us.user_id, u.username, us.stock_id, s.name AS stock_name,
            us.amount, us.total_spent, s.price AS current_price,
            CAST(ROUND(us.amount * s.price) AS DECIMAL(65,0)) AS eval_val
          FROM user_stocks us
          JOIN users u ON us.user_id = u.discord_id
          JOIN stocks s ON us.stock_id = s.stock_id
          WHERE us.amount > 0
          ORDER BY eval_val DESC
          LIMIT 100
        `);

        let stockHoldersRowsHtml = '';
        if (!ssrHolders.length) {
          stockHoldersRowsHtml = '<tr><td colspan="9" style="text-align:center; color:#6b7280; padding:15px;">주식을 보유한 유저가 없습니다.</td></tr>';
        } else {
          for (const h of ssrHolders) {
            const amt = Number(h.amount);
            const amountUnits = amountToUnits(h.amount);
            const curPrice = safeBigInt(h.current_price);
            const spent = safeBigInt(h.total_spent);
            const evalVal = safeBigInt(h.eval_val);
            const profit = evalVal - spent;
            const roi = spent > 0n ? ((Number(profit) / Number(spent)) * 100).toFixed(2) : '0.00';
            const avgPrice = amountUnits > 0n ? (spent * 10000n) / amountUnits : 0n;
            const isProfit = profit >= 0n;
            const profitColor = isProfit ? '#34d399' : '#f87171';

            stockHoldersRowsHtml += `
              <tr>
                <td><b>@${escapeHtml(h.username)}</b><br><code style="font-size:0.75rem; color:#9ca3af;">${escapeHtml(h.user_id)}</code></td>
                <td><b>${escapeHtml(h.stock_name)}</b> <span style="color:#818cf8; font-size:0.75rem;">(${escapeHtml(h.stock_id)})</span></td>
                <td style="text-align:right; font-weight:700; color:#fff;">${amt.toLocaleString()}주</td>
                <td style="text-align:right; color:#9ca3af;">${formatMoney(avgPrice)}</td>
                <td style="text-align:right; color:#cbd5e1;">${formatMoney(spent)}</td>
                <td style="text-align:right; font-weight:800; color:#fbbf24;">${formatMoney(evalVal)}</td>
                <td style="text-align:right; font-weight:800; color:${profitColor};">${(isProfit ? '+' : '')}${formatMoney(profit)}</td>
                <td style="text-align:right; font-weight:800; color:${profitColor};">${(isProfit ? '+' : '')}${roi}%</td>
                <td style="text-align:center; white-space:nowrap;">
                  <button type="button" onclick="showUserStocksModal('${escapeJsStr(h.user_id)}', '${escapeJsStr(h.username)}')" style="background:#0369a1; border:1px solid #38bdf8; color:#fff; padding:3px 7px; border-radius:4px; font-size:0.75rem; cursor:pointer; font-weight:700; margin-right:4px;">포트폴리오</button>
                  <button type="button" onclick="execForceSellStock('${escapeJsStr(h.user_id)}', '${escapeJsStr(h.stock_id)}', '${escapeJsStr(h.stock_name)}', ${amt})" style="background:#dc2626; border:1px solid #ef4444; color:#fff; padding:3px 7px; border-radius:4px; font-size:0.75rem; cursor:pointer; font-weight:700;">🚨 강제매도</button>
                </td>
              </tr>`;
          }
        }

        res.render('admin/stocks', {
          adminUser: req.adminUser,
          stockHoldersRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('주주 명부 페이지 로드 실패');
      }
    });

    // ───────────────────────────────────────────
    // 4. 세금 및 국고 페이지 (/admin/tax)
    // ───────────────────────────────────────────
    app.get('/admin/tax', requireAdminWeb, async (req, res) => {
      try {
        const { getTaxOverview, getTopTaxPayers, readTreasury } = require('../utils/taxEngine');
        const treasury = await readTreasury();
        const topPayers = await getTopTaxPayers(20);

        const [sumRows] = await pool.query(`
          SELECT
            COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) AS total_tax_all,
            COALESCE(SUM(CASE WHEN type = 'TAX_TRADE' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS total_trade_tax,
            COALESCE(SUM(CASE WHEN type = 'TAX_WEALTH' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS total_wealth_tax,
            COALESCE(SUM(CASE WHEN type = 'TAX_TRANSFER' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS total_transfer_tax,
            COALESCE(SUM(CASE WHEN type = 'TAX_ADMIN' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS total_admin_tax
          FROM economy_logs
          WHERE type IN ('TAX_TRADE', 'TAX_WEALTH', 'TAX_TRANSFER', 'TAX_ADMIN')
        `);

        const totalTaxAll = safeBigInt(sumRows[0]?.total_tax_all || 0);
        const totalTradeTax = safeBigInt(sumRows[0]?.total_trade_tax || 0);
        const totalWealthTax = safeBigInt(sumRows[0]?.total_wealth_tax || 0);
        const totalTransferTax = safeBigInt(sumRows[0]?.total_transfer_tax || 0);
        const totalAdminTax = safeBigInt(sumRows[0]?.total_admin_tax || 0);

        const calcPct = (part, total) => {
          if (total <= 0n || part <= 0n) return '0.0%';
          const pct = Number(part * 1000n / total) / 10;
          return pct.toFixed(1) + '%';
        };

        let taxPayersRowsHtml = '';
        if (!topPayers.length) {
          taxPayersRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#9ca3af; padding:25px;">아직 세금 납부 기록이 없습니다.</td></tr>';
        } else {
          for (const p of topPayers) {
            const isTop1 = p.rank === 1 && BigInt(p.totalTaxPaid || 0) > 0n;
            taxPayersRowsHtml += `
              <tr style="${isTop1 ? 'background: rgba(245, 158, 11, 0.08); border-left: 3px solid #fbbf24;' : ''}">
                <td style="font-weight:800; color:${p.rank === 1 ? '#fbbf24' : (p.rank === 2 ? '#94a3b8' : (p.rank === 3 ? '#cd7f32' : '#fff'))};">
                  ${p.rank === 1 ? '🥇 1' : (p.rank === 2 ? '🥈 2' : (p.rank === 3 ? '🥉 3' : p.rank + '위'))}
                </td>
                <td>
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <b>@${escapeHtml(p.username)}</b>
                    ${isTop1 ? '<span style="background: linear-gradient(135deg, #d97706, #f59e0b); color: #1e1b4b; font-size: 0.72rem; font-weight: 900; padding: 2px 7px; border-radius: 4px; box-shadow: 0 0 10px rgba(245, 158, 11, 0.4);">👑 세금왕</span>' : ''}
                  </div>
                  <code style="font-size:0.72rem; color:#64748b;">${escapeHtml(p.userId)}</code>
                </td>
                <td style="text-align:right; color:#38bdf8; font-weight:800;">${escapeHtml(p.totalTaxPaidText)}</td>
                <td style="text-align:right; color:#fbbf24; font-weight:600;">${escapeHtml(p.wealthTaxPaidText)}</td>
                <td style="text-align:right; color:#a78bfa;">${escapeHtml(p.tradeTaxPaidText)}</td>
                <td style="text-align:center; font-weight:700;">${p.taxCount}회</td>
                <td style="color:#94a3b8; font-size:0.78rem;">${escapeHtml(p.lastTaxAtText || '-')}</td>
              </tr>`;
          }
        }

        res.render('admin/tax', {
          adminUser: req.adminUser,
          treasuryBalance: treasury,
          totalTaxAll, totalTradeTax, totalWealthTax, totalTransferTax, totalAdminTax,
          tradePct: calcPct(totalTradeTax, totalTaxAll),
          wealthPct: calcPct(totalWealthTax, totalTaxAll),
          transferPct: calcPct(totalTransferTax, totalTaxAll),
          adminPct: calcPct(totalAdminTax, totalTaxAll),
          taxRates: {
            trade: '0.25%', transfer: '0.50%', gamble: '5.00%',
            wealthMin: '3.0%', wealthMax: '15.0%'
          },
          taxPayersRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('세금 국고 페이지 로드 실패');
      }
    });

    // ───────────────────────────────────────────
    // 5. 대출 페이지 (/admin/loans)
    // ───────────────────────────────────────────
    app.get('/admin/loans', requireAdminWeb, async (req, res) => {
      try {
        const { listLoansAdmin } = require('../utils/loanEngine');
        const loansData = await listLoansAdmin();
        const loanOverview = loansData.overview || {};

        let loanRowsHtml = '';
        if (!loansData.loans || !loansData.loans.length) {
          loanRowsHtml = '<tr><td colspan="9" style="text-align:center; color:#9ca3af;">대출 기록이 없습니다.</td></tr>';
        } else {
          for (const l of loansData.loans) {
            const statusBadge = l.status === 'OVERDUE'
              ? '<span style="color:#f87171; font-weight:700;">연체</span>'
              : '<span style="color:#34d399; font-weight:700;">진행중</span>';
            loanRowsHtml += `
              <tr>
                <td>#${l.id}</td>
                <td><b>@${escapeHtml(l.username)}</b><br><code style="font-size:0.7rem;">${escapeHtml(l.user_id)}</code></td>
                <td>${statusBadge}</td>
                <td style="text-align:right;">${formatMoney(safeBigInt(l.principal))}</td>
                <td style="text-align:right; color:#fbbf24; font-weight:700;">${formatMoney(safeBigInt(l.remaining_debt))}</td>
                <td style="text-align:right; color:#9ca3af;">${formatMoney(safeBigInt(l.collateral_locked))}</td>
                <td style="font-size:0.8rem;">${formatKstDateTime(l.created_at)}</td>
                <td style="font-size:0.8rem;">${formatKstDateTime(l.due_date)}</td>
                <td style="text-align:center;">
                  <button type="button" onclick="adminForceCollectLoan(${l.id})" style="background:#dc2626; border:none; color:#fff; padding:3px 8px; border-radius:4px; font-size:0.75rem; cursor:pointer;">강제회수</button>
                </td>
              </tr>`;
          }
        }

        res.render('admin/loans', {
          adminUser: req.adminUser,
          loanOverview,
          loanRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('대출 페이지 로드 실패');
      }
    });

    // ───────────────────────────────────────────
    // 6. 명령 콘솔 페이지 (/admin/console)
    // ───────────────────────────────────────────
    app.get('/admin/console', requireAdminWeb, async (req, res) => {
      res.render('admin/console', { adminUser: req.adminUser });
    });

    // ───────────────────────────────────────────
    // 7. 보안 페이지 (/admin/security)
    // ───────────────────────────────────────────
    app.get('/admin/security', requireAdminWeb, async (req, res) => {
      try {
        const bannedList = deps.getBannedIpsList ? deps.getBannedIpsList() : [];
        let bannedRowsHtml = '';
        if (!bannedList.length) {
          bannedRowsHtml = '<tr><td colspan="6" style="text-align:center; color:#9ca3af;">차단된 IP가 없습니다.</td></tr>';
        } else {
          for (const ban of bannedList) {
            const geo = ban.ip ? deps.lookupIp(ban.ip) : { flag: '🌐', countryName: '' };
            bannedRowsHtml += `
              <tr>
                <td class="cell-mono"><code>${escapeHtml(ban.ip)}</code></td>
                <td>${geo.flag} ${escapeHtml(geo.countryName || '-')}</td>
                <td>${escapeHtml(ban.reason || '-')}</td>
                <td>${escapeHtml(String(ban.remainingMinutes))}분</td>
                <td>${escapeHtml(ban.bannedAt || '-')}</td>
                <td><button type="button" onclick="unbanFromLog('${escapeJsStr(ban.ip)}')" class="btn-rollback">해제</button></td>
              </tr>`;
          }
        }

        const whitelist = deps.getWhitelistedIpsList ? await deps.getWhitelistedIpsList() : [];
        let whitelistRowsHtml = '';
        if (!whitelist.length) {
          whitelistRowsHtml = '<tr><td colspan="5" style="text-align:center; color:#9ca3af;">등록된 화이트리스트 IP가 없습니다.</td></tr>';
        } else {
          for (const item of whitelist) {
            const geo = item.ip ? deps.lookupIp(item.ip) : { flag: '🌐', countryName: '' };
            const isProtected = item.ip === '127.0.0.1' || item.ip === '::1' || item.ip === 'localhost';
            whitelistRowsHtml += `
              <tr>
                <td class="cell-mono"><code style="color:#34d399; font-weight:700;">${escapeHtml(item.ip)}</code></td>
                <td>${geo.flag} ${escapeHtml(geo.countryName || '-')}</td>
                <td>${escapeHtml(item.description || '-')}</td>
                <td style="font-size:0.78rem; color:#94a3b8;">${item.created_at ? formatKstDateTime(item.created_at) : '-'}</td>
                <td>${isProtected ? '<span style="color:#9ca3af; font-size:0.75rem;">보호됨</span>' : `<button type="button" onclick="removeWhitelist('${escapeJsStr(item.ip)}')" class="btn-rollback" style="background:#475569; color:#f1f5f9;">삭제</button>`}</td>
              </tr>`;
          }
        }

        const [secRows] = await pool.query('SELECT * FROM security_events ORDER BY id DESC LIMIT 50');
        let secEventRowsHtml = '';
        if (!secRows.length) {
          secEventRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#9ca3af;">보안 이벤트가 없습니다.</td></tr>';
        } else {
          for (const ev of secRows) {
            const flag = ev.country === 'LOCAL' ? '🏠' : deps.getFlagEmoji(ev.country);
            const canBan = ev.ip && ev.ip !== 'DELETED' && ev.ip !== '127.0.0.1';
            secEventRowsHtml += `
              <tr>
                <td>${formatKstDateTime(ev.created_at)}</td>
                <td>${escapeHtml(ev.event_type || '-')}</td>
                <td>${flag} ${escapeHtml(ev.country_name || ev.country || '-')}</td>
                <td class="cell-mono"><code>${escapeHtml(ev.ip || '-')}</code></td>
                <td><code>${escapeHtml(ev.path || '-')}</code></td>
                <td>${escapeHtml(ev.reason || '-')}</td>
                <td>${canBan ? `<button type="button" onclick="banFromLog('${escapeJsStr(ev.ip)}')" class="btn-rollback">차단</button>` : '-'}</td>
              </tr>`;
          }
        }

        res.render('admin/security', {
          adminUser: req.adminUser,
          bannedList,
          bannedRowsHtml,
          whitelistList: whitelist,
          whitelistRowsHtml,
          secEventRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('보안 페이지 로드 실패');
      }
    });

    // ───────────────────────────────────────────
    // 8. 1:1 문의 페이지 (/admin/inquiries)
    // ───────────────────────────────────────────
    app.get('/admin/inquiries', requireAdminWeb, async (req, res) => {
      try {
        const [inquiryLogs] = await pool.query('SELECT * FROM inquiries ORDER BY id DESC LIMIT 50');
        const pendingInquiryCount = inquiryLogs.filter((inq) => inq.status !== 'ANSWERED').length;

        let inquiryRowsHtml = '';
        if (!inquiryLogs.length) {
          inquiryRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#6b7280;">접수된 1:1 문의가 없습니다.</td></tr>';
        } else {
          for (const inq of inquiryLogs) {
            const isAnswered = inq.status === 'ANSWERED';
            const statusHtml = isAnswered
              ? `<span style="display:inline-block; background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3); padding:4px 10px; border-radius:8px; font-weight:800; font-size:0.75rem;">답변완료</span>`
              : `<span style="display:inline-block; background:rgba(239,68,68,0.15); color:#fca5a5; border:1px solid rgba(239,68,68,0.3); padding:4px 10px; border-radius:8px; font-weight:800; font-size:0.75rem;">답변대기</span>`;

            const replyFormOrAnswer = isAnswered
              ? `<div style="background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.25); border-left:4px solid #10b981; padding:10px 14px; border-radius:8px; font-size:0.84rem; color:#f1f5f9; line-height:1.6; white-space:pre-wrap; word-break:break-word;">${escapeHtml(inq.answer || '')}</div>
                 <div style="font-size:0.72rem; color:#64748b; margin-top:5px;">답변자: ${escapeHtml(inq.answered_by || '관리자')} · ${formatKstDateTime(inq.answered_at)}</div>`
              : `
                <div style="display:flex; flex-direction:column; gap:8px;">
                  <textarea id="inquiry-ans-${inq.id}" placeholder="답변을 입력하세요 (작성 완료 시 유저에게 Discord DM 자동 전송)" style="width:100%; min-height:75px; background:#030712; border:1px solid rgba(255,255,255,0.18); color:#f8fafc; padding:8px 12px; border-radius:8px; font-size:0.82rem; font-family:inherit; line-height:1.5; resize:vertical;"></textarea>
                  <button type="button" onclick="submitInquiryAnswer(${inq.id})" style="background:linear-gradient(135deg, #4f46e5, #7c3aed); border:none; color:#fff; font-weight:800; font-size:0.8rem; padding:8px 16px; border-radius:8px; cursor:pointer; align-self:flex-start; display:inline-flex; align-items:center; gap:6px; box-shadow:0 2px 8px rgba(79,70,229,0.3);">
                    <span>💬 답변 전송 & DM 발송</span>
                  </button>
                </div>`;

            inquiryRowsHtml += `
              <tr>
                <td style="font-weight:700; color:#818cf8; text-align:center;">#${inq.id}</td>
                <td style="font-size:0.78rem; color:#94a3b8; white-space:nowrap;">${formatKstDateTime(inq.created_at)}</td>
                <td>
                  <div style="font-weight:700; color:#f8fafc;">@${escapeHtml(inq.username)}</div>
                  <div style="font-size:0.7rem; color:#64748b; font-family:monospace; margin-top:2px;">${escapeHtml(inq.user_id)}</div>
                </td>
                <td>
                  <span style="display:inline-block; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); padding:3px 8px; border-radius:6px; font-size:0.76rem; color:#cbd5e1; white-space:nowrap;">
                    ${escapeHtml(inq.category || '일반문의')}
                  </span>
                </td>
                <td style="word-break:break-word; max-width:320px;">
                  <div style="font-weight:800; color:#e2e8f0; font-size:0.88rem; margin-bottom:4px;">${escapeHtml(inq.title)}</div>
                  <div style="font-size:0.8rem; color:#94a3b8; line-height:1.5; white-space:pre-wrap; background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.04);">${escapeHtml(inq.content)}</div>
                </td>
                <td style="text-align:center;">${statusHtml}</td>
                <td style="min-width:300px; max-width:380px;">${replyFormOrAnswer}</td>
              </tr>`;
          }
        }

        res.render('admin/inquiries', {
          adminUser: req.adminUser,
          pendingInquiryCount,
          inquiryRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('문의 페이지 로드 실패');
      }
    });

    // ───────────────────────────────────────────
    // 9. 실시간 종합 로그 뷰어 페이지 (/admin/logs)
    // ───────────────────────────────────────────
    app.get('/admin/logs', requireAdminWeb, async (req, res) => {
      try {
        const [economyLogs] = await pool.query('SELECT * FROM economy_logs ORDER BY id DESC LIMIT 50');
        const [gambleLogs] = await pool.query('SELECT g.*, u.username FROM gambling_logs g LEFT JOIN users u ON g.user_id = u.discord_id ORDER BY g.id DESC LIMIT 50');
        const [tradeLogs] = await pool.query('SELECT st.*, s.name as stock_name FROM stock_transactions st JOIN stocks s ON st.stock_id = s.stock_id ORDER BY st.id DESC LIMIT 50');
        const [priceLogs] = await pool.query('SELECT * FROM stock_price_logs ORDER BY id DESC LIMIT 50');
        const [webLogs] = await pool.query('SELECT * FROM web_access_logs ORDER BY id DESC LIMIT 50');
        const [cmdLogs] = await pool.query('SELECT * FROM command_logs ORDER BY id DESC LIMIT 50');

        let economyRowsHtml = '';
        for (const e of economyLogs) {
          const isPlus = BigInt(e.balance_after || 0) >= BigInt(e.balance_before || 0);
          const color = isPlus ? '#34d399' : '#f87171';
          economyRowsHtml += `
            <tr>
              <td>#${e.id}</td>
              <td style="font-size:0.8rem;">${formatKstDateTime(e.created_at)}</td>
              <td><b>@${escapeHtml(e.username || '유저')}</b><br><code style="font-size:0.7rem;">${escapeHtml(e.user_id)}</code></td>
              <td><span class="badge-admin">${escapeHtml(e.type || '-')}</span></td>
              <td style="text-align:right; font-weight:800; color:${color};">${isPlus ? '+' : '-'}${formatMoneyCompact(safeBigInt(e.amount))}</td>
              <td style="text-align:right; color:#9ca3af;">${formatMoneyCompact(safeBigInt(e.balance_before))}</td>
              <td style="text-align:right; color:#cbd5e1; font-weight:700;">${formatMoneyCompact(safeBigInt(e.balance_after))}</td>
              <td style="color:#cbd5e1; font-size:0.8rem;">${escapeHtml(e.description || '-')}</td>
            </tr>`;
        }

        let gambleRowsHtml = '';
        for (const g of gambleLogs) {
          const prof = safeBigInt(g.profit);
          const isWin = prof >= 0n;
          const color = isWin ? '#34d399' : '#f87171';
          gambleRowsHtml += `
            <tr>
              <td>#${g.id}</td>
              <td style="font-size:0.8rem;">${formatKstDateTime(g.created_at)}</td>
              <td><b>@${escapeHtml(g.username || '유저')}</b></td>
              <td><span class="cmd-tag">${escapeHtml(g.game || '-')}</span></td>
              <td style="text-align:right;">${formatMoneyCompact(safeBigInt(g.bet))}</td>
              <td style="text-align:right; font-weight:800; color:${color};">${isWin ? '+' : ''}${formatMoneyCompact(prof)}</td>
              <td style="text-align:right; color:#9ca3af;">${formatMoneyCompact(safeBigInt(g.balance_before))}</td>
              <td style="text-align:right; color:#fbbf24;">${formatMoneyCompact(safeBigInt(g.balance_after))}</td>
              <td>${g.is_rolled_back ? '<span style="color:#f87171;">롤백됨</span>' : `<button type="button" onclick="rollbackGamble(${g.id})" class="btn-rollback">롤백</button>`}</td>
            </tr>`;
        }

        let tradeLogsRowsHtml = '';
        for (const t of tradeLogs) {
          const isBuy = t.action === 'BUY';
          const color = isBuy ? '#38bdf8' : '#fb923c';
          tradeLogsRowsHtml += `
            <tr>
              <td>#${t.id}</td>
              <td style="font-size:0.8rem;">${formatKstDateTime(t.created_at)}</td>
              <td><b>@${escapeHtml(t.username)}</b></td>
              <td><b>${escapeHtml(t.stock_name)}</b> (${escapeHtml(t.stock_id)})</td>
              <td><span style="color:${color}; font-weight:700;">${isBuy ? '🛒 매수' : '💰 매도'}</span></td>
              <td style="text-align:right;">${Number(t.amount).toLocaleString()}주</td>
              <td style="text-align:right; color:#9ca3af;">${formatMoneyCompact(safeBigInt(t.price))}</td>
              <td style="text-align:right; font-weight:800; color:${color};">${formatMoneyCompact(safeBigInt(t.total_price))}</td>
            </tr>`;
        }

        let priceRowsHtml = '';
        for (const p of priceLogs) {
          const isUp = Number(p.diff) >= 0;
          priceRowsHtml += `
            <tr>
              <td>#${p.id}</td>
              <td style="font-size:0.8rem;">${formatKstDateTime(p.created_at)}</td>
              <td><b>${escapeHtml(p.name || p.stock_id)}</b></td>
              <td style="text-align:right;">${formatMoneyCompact(safeBigInt(p.prev_price))}</td>
              <td style="text-align:right; font-weight:700; color:${isUp ? '#34d399' : '#f87171'};">${formatMoneyCompact(safeBigInt(p.new_price))}</td>
              <td style="text-align:right; font-weight:800; color:${isUp ? '#34d399' : '#f87171'};">${isUp ? '+' : ''}${Number(p.diff_percent || 0).toFixed(2)}%</td>
              <td>${escapeHtml(p.regime_name || '-')}</td>
              <td style="font-size:0.8rem; color:#9ca3af;">${escapeHtml(p.reason || '-')}</td>
            </tr>`;
        }

        let webRowsHtml = '';
        for (const w of webLogs) {
          const flag = w.country === 'LOCAL' ? '🏠' : deps.getFlagEmoji(w.country);
          webRowsHtml += `
            <tr>
              <td style="font-size:0.8rem;">${formatKstDateTime(w.created_at)}</td>
              <td>${flag} ${escapeHtml(w.country_name || w.country || '-')}</td>
              <td><code>${escapeHtml(w.ip)}</code></td>
              <td><b>@${escapeHtml(w.username || '비회원')}</b></td>
              <td><span class="method-tag">${escapeHtml(w.method)}</span> <code>${escapeHtml(w.url)}</code></td>
              <td><span class="${w.status_code < 400 ? 'status-ok' : 'status-err'}">${w.status_code}</span></td>
              <td>${w.duration_ms}ms</td>
              <td>${w.ip && w.ip !== '127.0.0.1' ? `<button type="button" onclick="banFromLog('${escapeJsStr(w.ip)}')" class="btn-rollback">차단</button>` : '-'}</td>
            </tr>`;
        }

        let cmdRowsHtml = '';
        for (const c of cmdLogs) {
          cmdRowsHtml += `
            <tr>
              <td style="font-size:0.8rem;">${formatKstDateTime(c.created_at)}</td>
              <td><b>${escapeHtml(c.username)}</b></td>
              <td><span class="cmd-tag">/${escapeHtml(c.command_name)}</span></td>
              <td><code>${escapeHtml(c.options || '{}')}</code></td>
              <td><span class="${c.status === 'SUCCESS' ? 'status-ok' : 'status-err'}">${c.status}</span></td>
              <td>${c.execution_time_ms}ms</td>
            </tr>`;
        }

        res.render('admin/logs', {
          adminUser: req.adminUser,
          economyRowsHtml,
          gambleRowsHtml,
          tradeRowsHtml: tradeLogsRowsHtml,
          priceRowsHtml,
          webRowsHtml,
          cmdRowsHtml
        });
      } catch (e) {
        console.error(e);
        res.status(500).send('로그 뷰어 로드 실패');
      }
    });
  };
}

module.exports = { createAdminPageRoutes };
