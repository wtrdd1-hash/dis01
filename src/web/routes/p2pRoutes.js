const express = require('express');
const {
  registerLenderLicense,
  createLoanOffer,
  acceptLoanOffer,
  repayLoan,
  requestCourtForeclosure,
  getMyP2PLoans,
  LICENSE_FEE
} = require('../../utils/p2pLoanEngine');
const { safeBigInt, parseKoreanOrNumericAmount } = require('../../utils/money');
const { pool, getOrCreateUser } = require('../../config/database');

function createP2PRoutes(getSessionUser) {
  const router = express.Router();

  async function resolveUser(req) {
    let session = typeof getSessionUser === 'function' ? getSessionUser(req) : null;
    if (!session && req.session) {
      session = req.session.user || req.session.localUser;
    }
    if (!session || !session.id) return null;
    try {
      await getOrCreateUser(session.id, session.username || '손님', session.avatar || '');
    } catch (e) {}
    return session;
  }

  // 1. 내 대부업/대출 상태 조회
  router.get('/state', async (req, res) => {
    const session = await resolveUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다. (Discord 또는 웹 계정으로 로그인해주세요)' });

    try {
      const data = await getMyP2PLoans(session.id);
      return res.json({ success: true, data });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. 대부업 면허 취득 (50만원 면허세)
  router.post('/license', async (req, res) => {
    const session = await resolveUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const result = await registerLenderLicense(session.id, req.body.businessName);
      return res.json({ success: true, result, message: `대부업 면허(${result.businessName})가 성공적으로 발급되었습니다!` });
    } catch (err) {
      if (err && err.code === 'INSUFFICIENT_CASH') {
        return res.status(400).json({ success: false, error: '면허세(500,000원)를 납부할 현금이 부족합니다.' });
      }
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 3. 대출 제안
  router.post('/offer', async (req, res) => {
    const session = await resolveUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const { targetInput, principal, interestRate, durationHours, collateralType, collateralStockId, collateralStockAmt, collateralBankAmt } = req.body;

      // 타겟 유저 찾기 (ID 또는 닉네임)
      let borrowerId = String(targetInput || '').trim();
      if (!/^\d{17,20}$/.test(borrowerId)) {
        const cleanNick = borrowerId.replace(/^@/, '');
        const [uRows] = await pool.query('SELECT discord_id FROM users WHERE username = ? LIMIT 1', [cleanNick]);
        if (!uRows.length) return res.status(404).json({ success: false, error: `차입자 '${borrowerId}' 유저를 찾을 수 없습니다.` });
        borrowerId = uRows[0].discord_id;
      }

      const pBig = parseKoreanOrNumericAmount(principal);
      if (!pBig || pBig <= 0n) return res.status(400).json({ success: false, error: '원금 금액이 올바르지 않습니다.' });

      let bAmtBig = 0n;
      if (collateralBankAmt) {
        bAmtBig = parseKoreanOrNumericAmount(collateralBankAmt) || 0n;
      }

      const offer = await createLoanOffer({
        lenderId: session.id,
        borrowerId,
        principal: pBig,
        interestRatePercent: Number(interestRate),
        durationHours: Number(durationHours) || 24,
        collateralType: collateralType || 'none',
        collateralStockId,
        collateralStockAmt: Number(collateralStockAmt) || 0,
        collateralBankAmt: bAmtBig
      });

      return res.json({ success: true, offer, message: `대출 계약서 #${offer.loanId}가 등록되었습니다.` });
    } catch (err) {
      if (err && err.code === 'INSUFFICIENT_CASH') {
        return res.status(400).json({ success: false, error: '대출을 지급할 보유 현금이 부족합니다.' });
      }
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 4. 계약 수락
  router.post('/accept', async (req, res) => {
    const session = await resolveUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const loanId = Number(req.body.loanId);
      const result = await acceptLoanOffer(loanId, session.id);
      return res.json({ success: true, result, message: `대출 #${loanId} 계약이 체결되고 대출금이 지급되었습니다!` });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 5. 상환
  router.post('/repay', async (req, res) => {
    const session = await resolveUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const loanId = Number(req.body.loanId);
      const result = await repayLoan(loanId, session.id);
      return res.json({ success: true, result, message: `대출 #${loanId} 상환이 완료되고 담보가 반환되었습니다!` });
    } catch (err) {
      if (err && err.code === 'INSUFFICIENT_CASH') {
        return res.status(400).json({ success: false, error: '상환할 현금이 부족합니다.' });
      }
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 6. 법원 강제징수 신청
  router.post('/foreclose', async (req, res) => {
    const session = await resolveUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const loanId = Number(req.body.loanId);
      const result = await requestCourtForeclosure(loanId, session.id);
      return res.json({ success: true, result, message: `⚖️ 법원이 강제 집행을 자동 승인하고 채무자의 담보/자산을 압류 집행했습니다!` });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = createP2PRoutes;
