const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, '../src/web/server.js');
let content = fs.readFileSync(serverFile, 'utf8');

// 1. audit 라우트의 render('admin/audit' 위치 찾기
const auditRenderKey = "res.render('admin/audit', {";
const auditRenderIdx = content.indexOf(auditRenderKey);
if (auditRenderIdx === -1) {
  console.error('auditRenderKey not found');
  process.exit(1);
}

// auditRenderIdx 이후의 세미콜론과 닫는 괄호
const auditCloseKey = "auditDedicatedRowsHtml\n      });";
const auditCloseIdx = content.indexOf(auditCloseKey, auditRenderIdx);

let auditPrefix = "";
if (auditCloseIdx !== -1) {
  auditPrefix = content.slice(0, auditCloseIdx + auditCloseKey.length) + `
    } catch (e) {
      console.error(e);
      res.status(500).send('정밀 관제 페이지 로드 실패');
    }
  });`;
} else {
  console.error('auditCloseKey not found');
  process.exit(1);
}

// 2. Discord OAuth2 시작 부분 찾기
const discordAuthKey = "  // Discord OAuth2 시작 (state CSRF 방지)";
const discordAuthIdx = content.indexOf(discordAuthKey);
if (discordAuthIdx === -1) {
  console.error('discordAuthKey not found');
  process.exit(1);
}

// 3. 대체할 EJS 라우트들 정의
const ejsRoutes = `

  // 3. 주주 명부 & 주식 관제 페이지 (/admin/stocks)
  app.get('/admin/stocks', requireAdminWeb, async (req, res) => {
    try {
      const [ssrHolders] = await pool.query(\`
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
      \`);

      let stockHoldersRowsHtml = '';
      if (!ssrHolders.length) {
        stockHoldersRowsHtml = '<tr><td colspan="9" style="text-align:center; color:#6b7280; padding:15px;">주식을 보유한 유저가 없습니다.</td></tr>';
      } else {
        for (const h of ssrHolders) {
          const amt = Number(h.amount);
          const curPrice = safeBigInt(h.current_price);
          const spent = safeBigInt(h.total_spent);
          const evalVal = safeBigInt(h.eval_val);
          const profit = evalVal - spent;
          const roi = spent > 0n ? ((Number(profit) / Number(spent)) * 100).toFixed(2) : '0.00';
          const avgPrice = amt > 0 ? safeBigInt(Math.floor(Number(spent) / amt)) : 0n;
          const isProfit = profit >= 0n;
          const profitColor = isProfit ? '#34d399' : '#f87171';

          stockHoldersRowsHtml += \`
            <tr>
              <td><b>@\${escapeHtml(h.username)}</b><br><code style="font-size:0.75rem; color:#9ca3af;">\${escapeHtml(h.user_id)}</code></td>
              <td><b>\${escapeHtml(h.stock_name)}</b> <span style="color:#818cf8; font-size:0.75rem;">(\${escapeHtml(h.stock_id)})</span></td>
              <td style="text-align:right; font-weight:700; color:#fff;">\${amt.toLocaleString()}주</td>
              <td style="text-align:right; color:#9ca3af;">\${formatMoney(avgPrice)}</td>
              <td style="text-align:right; color:#cbd5e1;">\${formatMoney(spent)}</td>
              <td style="text-align:right; font-weight:800; color:#fbbf24;">\${formatMoney(evalVal)}</td>
              <td style="text-align:right; font-weight:800; color:\${profitColor};">\${(isProfit ? '+' : '')}\${formatMoney(profit)}</td>
              <td style="text-align:right; font-weight:800; color:\${profitColor};">\${(isProfit ? '+' : '')}\${roi}%</td>
              <td style="text-align:center; white-space:nowrap;">
                <button type="button" onclick="showUserStocksModal('\${escapeJsStr(h.user_id)}', '\${escapeJsStr(h.username)}')" style="background:#0369a1; border:1px solid #38bdf8; color:#fff; padding:3px 7px; border-radius:4px; font-size:0.75rem; cursor:pointer; font-weight:700; margin-right:4px;">포트폴리오</button>
                <button type="button" onclick="execForceSellStock('\${escapeJsStr(h.user_id)}', '\${escapeJsStr(h.stock_id)}', '\${escapeJsStr(h.stock_name)}', \${amt})" style="background:#dc2626; border:1px solid #ef4444; color:#fff; padding:3px 7px; border-radius:4px; font-size:0.75rem; cursor:pointer; font-weight:700;">🚨 강제매도</button>
              </td>
            </tr>
          \`;
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

  // 4. 세금 및 국고 페이지 (/admin/tax)
  app.get('/admin/tax', requireAdminWeb, async (req, res) => {
    try {
      const { getTaxOverview, getTopTaxPayers } = require('../utils/taxEngine');
      const taxOverview = await getTaxOverview();
      const topPayers = await getTopTaxPayers(15);

      let taxPayersRowsHtml = '';
      if (!topPayers.length) {
        taxPayersRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#9ca3af; padding:15px;">아직 세금 납부 기록이 없습니다.</td></tr>';
      } else {
        for (const p of topPayers) {
          taxPayersRowsHtml += \`
            <tr>
              <td style="font-weight:800; color:\${p.rank === 1 ? '#fbbf24' : '#fff'};">\${p.rank === 1 ? '🥇 1' : (p.rank === 2 ? '🥈 2' : (p.rank === 3 ? '🥉 3' : p.rank))}</td>
              <td><b>@\${escapeHtml(p.username)}</b><br><code style="font-size:0.7rem;">\${escapeHtml(p.userId)}</code></td>
              <td style="text-align:right; color:#38bdf8; font-weight:800;">\${escapeHtml(p.totalTaxPaidText)}</td>
              <td style="text-align:right; color:#fbbf24;">\${escapeHtml(p.wealthTaxPaidText)}</td>
              <td style="text-align:right; color:#9ca3af;">\${escapeHtml(p.tradeTaxPaidText)}</td>
              <td style="text-align:center;">\${p.taxCount}회</td>
              <td style="color:#9ca3af; font-size:0.78rem;">\${escapeHtml(p.lastTaxAtText || '-')}</td>
            </tr>
          \`;
        }
      }

      res.render('admin/tax', {
        adminUser: req.adminUser,
        treasuryBalance: safeBigInt(taxOverview.treasury),
        totalTradeTax: safeBigInt(taxOverview.totalTradeTax),
        totalWealthTax: safeBigInt(taxOverview.totalWealthTax),
        taxPayersRowsHtml
      });
    } catch (e) {
      console.error(e);
      res.status(500).send('세금 국고 페이지 로드 실패');
    }
  });

  // 5. 대출 페이지 (/admin/loans)
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
          loanRowsHtml += \`
            <tr>
              <td>#\${l.id}</td>
              <td><b>@\${escapeHtml(l.username)}</b><br><code style="font-size:0.7rem;">\${escapeHtml(l.user_id)}</code></td>
              <td>\${statusBadge}</td>
              <td style="text-align:right;">\${formatMoney(safeBigInt(l.principal))}</td>
              <td style="text-align:right; color:#fbbf24; font-weight:700;">\${formatMoney(safeBigInt(l.remaining_debt))}</td>
              <td style="text-align:right; color:#9ca3af;">\${formatMoney(safeBigInt(l.collateral_locked))}</td>
              <td style="font-size:0.8rem;">\${formatKstDateTime(l.created_at)}</td>
              <td style="font-size:0.8rem;">\${formatKstDateTime(l.due_date)}</td>
              <td style="text-align:center;">
                <button type="button" onclick="adminForceCollectLoan(\${l.id})" style="background:#dc2626; border:none; color:#fff; padding:3px 8px; border-radius:4px; font-size:0.75rem; cursor:pointer;">강제회수</button>
              </td>
            </tr>
          \`;
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

  // 6. 명령 콘솔 페이지 (/admin/console)
  app.get('/admin/console', requireAdminWeb, async (req, res) => {
    res.render('admin/console', {
      adminUser: req.adminUser
    });
  });

  // 7. 보안 및 IP 차단 페이지 (/admin/security)
  app.get('/admin/security', requireAdminWeb, async (req, res) => {
    try {
      const bannedList = getBannedIpsList();
      let bannedRowsHtml = '';
      if (!bannedList.length) {
        bannedRowsHtml = '<tr><td colspan="6" style="text-align:center; color:#9ca3af;">차단된 IP가 없습니다.</td></tr>';
      } else {
        for (const ban of bannedList) {
          const geo = ban.ip ? lookupIp(ban.ip) : { flag: '🌐', countryName: '' };
          bannedRowsHtml += \`
            <tr>
              <td class="cell-mono"><code>\${escapeHtml(ban.ip)}</code></td>
              <td>\${geo.flag} \${escapeHtml(geo.countryName || '-')}</td>
              <td>\${escapeHtml(ban.reason || '-')}</td>
              <td>\${escapeHtml(String(ban.remainingMinutes))}분</td>
              <td>\${escapeHtml(ban.bannedAt || '-')}</td>
              <td><button type="button" onclick="unbanFromLog('\${escapeJsStr(ban.ip)}')" class="btn-rollback">해제</button></td>
            </tr>
          \`;
        }
      }

      const [secRows] = await pool.query('SELECT * FROM security_events ORDER BY id DESC LIMIT 50');
      let secEventRowsHtml = '';
      if (!secRows.length) {
        secEventRowsHtml = '<tr><td colspan="7" style="text-align:center; color:#9ca3af;">보안 이벤트가 없습니다.</td></tr>';
      } else {
        for (const ev of secRows) {
          const flag = ev.country === 'LOCAL' ? '🏠' : getFlagEmoji(ev.country);
          const canBan = ev.ip && ev.ip !== 'DELETED' && ev.ip !== '127.0.0.1';
          secEventRowsHtml += \`
            <tr>
              <td>\${formatKstDateTime(ev.created_at)}</td>
              <td>\${escapeHtml(ev.event_type || '-')}</td>
              <td>\${flag} \${escapeHtml(ev.country_name || ev.country || '-')}</td>
              <td class="cell-mono"><code>\${escapeHtml(ev.ip || '-')}</code></td>
              <td><code>\${escapeHtml(ev.path || '-')}</code></td>
              <td>\${escapeHtml(ev.reason || '-')}</td>
              <td>\${canBan ? \`<button type="button" onclick="banFromLog('\${escapeJsStr(ev.ip)}')" class="btn-rollback">차단</button>\` : '-'}</td>
            </tr>
          \`;
        }
      }

      res.render('admin/security', {
        adminUser: req.adminUser,
        bannedList,
        bannedRowsHtml,
        secEventRowsHtml
      });
    } catch (e) {
      console.error(e);
      res.status(500).send('보안 페이지 로드 실패');
    }
  });

  // 8. 1:1 고객센터 문의 페이지 (/admin/inquiries)
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
            ? \`<span style="background:rgba(16,185,129,0.15); color:#34d399; padding:3px 8px; border-radius:6px; font-weight:700; font-size:0.75rem;">답변완료</span>\`
            : \`<span style="background:rgba(239,68,68,0.15); color:#f87171; padding:3px 8px; border-radius:6px; font-weight:700; font-size:0.75rem;">답변대기</span>\`;

          const replyFormOrAnswer = isAnswered
            ? \`<div style="background:rgba(16,185,129,0.08); border-left:3px solid #10b981; padding:8px 12px; border-radius:6px; font-size:0.82rem; color:#e2e8f0; white-space:pre-wrap;">\${escapeHtml(inq.answer || '')}</div>\`
            : \`
              <div style="display:flex; flex-direction:column; gap:6px;">
                <textarea id="inquiry-ans-\${inq.id}" placeholder="답변을 입력하세요 (제출 시 유저에게 Discord DM 자동 전송)" style="width:100%; min-height:50px; background:#111827; border:1px solid var(--border); color:#fff; padding:6px 10px; border-radius:8px; font-size:0.8rem; font-family:inherit;"></textarea>
                <button type="button" onclick="submitInquiryAnswer(\${inq.id})" style="background:linear-gradient(135deg, #6366f1, #8b5cf6); border:none; color:#fff; font-weight:700; font-size:0.8rem; padding:6px 12px; border-radius:6px; cursor:pointer; align-self:flex-start;">💬 답변 전송 & DM 발송</button>
              </div>
            \`;

          inquiryRowsHtml += \`
            <tr>
              <td>#\${inq.id}</td>
              <td style="font-size:0.8rem;">\${formatKstDateTime(inq.created_at)}</td>
              <td><b>@\${escapeHtml(inq.username)}</b><br><code style="font-size:0.7rem;">\${escapeHtml(inq.user_id)}</code></td>
              <td>\${escapeHtml(inq.category || '일반문의')}</td>
              <td>
                <b>\${escapeHtml(inq.title)}</b><br>
                <span style="font-size:0.8rem; color:#9ca3af; white-space:pre-wrap;">\${escapeHtml(inq.content)}</span>
              </td>
              <td>\${statusHtml}</td>
              <td style="min-width:260px;">\${replyFormOrAnswer}</td>
            </tr>
          \`;
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

  // 9. 실시간 종합 로그 뷰어 페이지 (/admin/logs)
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
        economyRowsHtml += \`
          <tr>
            <td>#\${e.id}</td>
            <td style="font-size:0.8rem;">\${formatKstDateTime(e.created_at)}</td>
            <td><b>@\${escapeHtml(e.username || '유저')}</b><br><code style="font-size:0.7rem;">\${escapeHtml(e.user_id)}</code></td>
            <td><span class="badge-admin">\${escapeHtml(e.type || '-')}</span></td>
            <td style="text-align:right; font-weight:800; color:\${color};">\${isPlus ? '+' : '-'}\${formatMoneyCompact(safeBigInt(e.amount))}</td>
            <td style="text-align:right; color:#9ca3af;">\${formatMoneyCompact(safeBigInt(e.balance_before))}</td>
            <td style="text-align:right; color:#cbd5e1; font-weight:700;">\${formatMoneyCompact(safeBigInt(e.balance_after))}</td>
            <td style="color:#cbd5e1; font-size:0.8rem;">\${escapeHtml(e.description || '-')}</td>
          </tr>
        \`;
      }

      let gambleRowsHtml = '';
      for (const g of gambleLogs) {
        const prof = safeBigInt(g.profit);
        const isWin = prof >= 0n;
        const color = isWin ? '#34d399' : '#f87171';
        gambleRowsHtml += \`
          <tr>
            <td>#\${g.id}</td>
            <td style="font-size:0.8rem;">\${formatKstDateTime(g.created_at)}</td>
            <td><b>@\${escapeHtml(g.username || '유저')}</b></td>
            <td><span class="cmd-tag">\${escapeHtml(g.game || '-')}</span></td>
            <td style="text-align:right;">\${formatMoneyCompact(safeBigInt(g.bet))}</td>
            <td style="text-align:right; font-weight:800; color:\${color};">\${isWin ? '+' : ''}\${formatMoneyCompact(prof)}</td>
            <td style="text-align:right; color:#9ca3af;">\${formatMoneyCompact(safeBigInt(g.balance_before))}</td>
            <td style="text-align:right; color:#fbbf24;">\${formatMoneyCompact(safeBigInt(g.balance_after))}</td>
            <td>\${g.is_rolled_back ? '<span style="color:#f87171;">롤백됨</span>' : \`<button type="button" onclick="rollbackGamble(\${g.id})" class="btn-rollback">롤백</button>\`}</td>
          </tr>
        \`;
      }

      let tradeLogsRowsHtml = '';
      for (const t of tradeLogs) {
        const isBuy = t.action === 'BUY';
        const color = isBuy ? '#38bdf8' : '#fb923c';
        tradeLogsRowsHtml += \`
          <tr>
            <td>#\${t.id}</td>
            <td style="font-size:0.8rem;">\${formatKstDateTime(t.created_at)}</td>
            <td><b>@\${escapeHtml(t.username)}</b></td>
            <td><b>\${escapeHtml(t.stock_name)}</b> (\${escapeHtml(t.stock_id)})</td>
            <td><span style="color:\${color}; font-weight:700;">\${isBuy ? '🛒 매수' : '💰 매도'}</span></td>
            <td style="text-align:right;">\${Number(t.amount).toLocaleString()}주</td>
            <td style="text-align:right; color:#9ca3af;">\${formatMoneyCompact(safeBigInt(t.price))}</td>
            <td style="text-align:right; font-weight:800; color:\${color};">\${formatMoneyCompact(safeBigInt(t.total_price))}</td>
          </tr>
        \`;
      }

      let priceRowsHtml = '';
      for (const p of priceLogs) {
        const isUp = Number(p.diff) >= 0;
        priceRowsHtml += \`
          <tr>
            <td>#\${p.id}</td>
            <td style="font-size:0.8rem;">\${formatKstDateTime(p.created_at)}</td>
            <td><b>\${escapeHtml(p.name || p.stock_id)}</b></td>
            <td style="text-align:right;">\${formatMoneyCompact(safeBigInt(p.prev_price))}</td>
            <td style="text-align:right; font-weight:700; color:\${isUp ? '#34d399' : '#f87171'};">\${formatMoneyCompact(safeBigInt(p.new_price))}</td>
            <td style="text-align:right; font-weight:800; color:\${isUp ? '#34d399' : '#f87171'};">\${isUp ? '+' : ''}\${Number(p.diff_percent || 0).toFixed(2)}%</td>
            <td>\${escapeHtml(p.regime_name || '-')}</td>
            <td style="font-size:0.8rem; color:#9ca3af;">\${escapeHtml(p.reason || '-')}</td>
          </tr>
        \`;
      }

      let webRowsHtml = '';
      for (const w of webLogs) {
        const flag = w.country === 'LOCAL' ? '🏠' : getFlagEmoji(w.country);
        webRowsHtml += \`
          <tr>
            <td style="font-size:0.8rem;">\${formatKstDateTime(w.created_at)}</td>
            <td>\${flag} \${escapeHtml(w.country_name || w.country || '-')}</td>
            <td><code>\${escapeHtml(w.ip)}</code></td>
            <td><b>@\${escapeHtml(w.username || '비회원')}</b></td>
            <td><span class="method-tag">\${escapeHtml(w.method)}</span> <code>\${escapeHtml(w.url)}</code></td>
            <td><span class="\${w.status_code < 400 ? 'status-ok' : 'status-err'}">\${w.status_code}</span></td>
            <td>\${w.duration_ms}ms</td>
            <td>\${w.ip && w.ip !== '127.0.0.1' ? \`<button type="button" onclick="banFromLog('\${escapeJsStr(w.ip)}')" class="btn-rollback">차단</button>\` : '-'}</td>
          </tr>
        \`;
      }

      let cmdRowsHtml = '';
      for (const c of cmdLogs) {
        cmdRowsHtml += \`
          <tr>
            <td style="font-size:0.8rem;">\${formatKstDateTime(c.created_at)}</td>
            <td><b>\${escapeHtml(c.username)}</b></td>
            <td><span class="cmd-tag">/\${escapeHtml(c.command_name)}</span></td>
            <td><code>\${escapeHtml(c.options || '{}')}</code></td>
            <td><span class="\${c.status === 'SUCCESS' ? 'status-ok' : 'status-err'}">\${c.status}</span></td>
            <td>\${c.execution_time_ms}ms</td>
          </tr>
        \`;
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

`;

const finalContent = auditPrefix + ejsRoutes + content.slice(discordAuthIdx);
fs.writeFileSync(serverFile, finalContent, 'utf8');
console.log('✅ server.js 완벽한 EJS 라우트 구조화 완료!');
