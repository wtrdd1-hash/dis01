const { pool } = require('../src/config/database');

async function liquidateAndResetStocks() {
  const connection = await pool.getConnection();
  try {
    console.log('🔄 [주식 전량 현금 환급 및 초기 시작가 리셋] 시작...');
    await connection.beginTransaction();

    // 1. 현재 모든 주식 종목의 현재 가격 조회
    const [stocks] = await connection.query('SELECT stock_id, name, price FROM stocks');
    const priceMap = {};
    stocks.forEach(s => {
      priceMap[s.stock_id] = { name: s.name, price: BigInt(s.price) };
    });

    // 2. 현재 주식을 보유 중인 모든 유저 목록 조회
    const [holdings] = await connection.query(`
      SELECT us.user_id, us.stock_id, us.amount, us.total_spent, u.username, u.cash
      FROM user_stocks us
      JOIN users u ON us.user_id = u.discord_id
      WHERE us.amount > 0
    `);

    console.log(`📊 보유 주식 건수: ${holdings.length}건`);

    let totalRefundedMoney = 0n;
    const userRefundSummary = {};

    for (const h of holdings) {
      const stockInfo = priceMap[h.stock_id];
      if (!stockInfo) continue;

      const shareCount = Number(h.amount);
      const curPrice = Number(stockInfo.price);
      // 현재 주가 기준으로 전액 환급
      const refundAmount = BigInt(Math.floor(shareCount * curPrice));
      if (refundAmount <= 0n) continue;

      const beforeCash = BigInt(h.cash || 0);
      const afterCash = beforeCash + refundAmount;

      // 유저 현금에 추가
      await connection.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [refundAmount.toString(), h.user_id]);

      // 거래 내역 기록 (SELL)
      const uName = h.username || `유저_${h.user_id.slice(-4)}`;
      try {
        await connection.query(`
          INSERT INTO stock_transactions (user_id, username, stock_id, action, amount, price, total_price)
          VALUES (?, ?, ?, 'SELL', ?, ?, ?)
        `, [h.user_id, uName, h.stock_id, h.amount, curPrice.toString(), refundAmount.toString()]);
      } catch (txErr) {
        await connection.query(`
          INSERT INTO stock_transactions (user_id, stock_id, action, amount, price, total_price)
          VALUES (?, ?, 'SELL', ?, ?, ?)
        `, [h.user_id, h.stock_id, h.amount, curPrice.toString(), refundAmount.toString()]).catch(() => {});
      }

      // 경제 로그 기록
      const displayCount = (shareCount % 1 === 0) ? shareCount.toLocaleString() : shareCount.toFixed(4);
      await connection.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'STOCK_SELL', ?, ?, ?, ?)
      `, [
        h.user_id, h.username || `유저_${h.user_id.slice(-4)}`, refundAmount.toString(),
        beforeCash.toString(), afterCash.toString(),
        `🔄 [시스템 주식 전량 환급] ${stockInfo.name} (${displayCount}주) 현재가 매도 정산 (+${refundAmount.toLocaleString()}원)`
      ]);

      totalRefundedMoney += refundAmount;
      if (!userRefundSummary[h.user_id]) {
        userRefundSummary[h.user_id] = { username: h.username, totalRefund: 0n };
      }
      userRefundSummary[h.user_id].totalRefund += refundAmount;
    }

    // 3. user_stocks 보유 수량 전량 0으로 초기화
    await connection.query('DELETE FROM user_stocks');

    // 4. 주식 가격을 초반 시작 가격으로 전면 리셋
    const initialStocks = [
      { stock_id: 'WTRD', price: 50000n, prev_price: 49500n, name: '월덕 인터내셔널 (지주사)' },
      { stock_id: 'MINE', price: 12500n, prev_price: 12100n, name: '월덕 광업 & 제련 (채굴/골드)' },
      { stock_id: 'CASN', price: 35000n, prev_price: 33800n, name: '황금오리 카지노 & 엔터 (게이밍)' },
      { stock_id: 'BANK', price: 85000n, prev_price: 84200n, name: '덕스 중앙은행 & 파이낸스 (금융)' },
      { stock_id: 'NEKO', price: 8800n, prev_price: 9200n, name: '네코 에너지 & 냥코 랩스 (양자)' },
      { stock_id: 'CHKN', price: 3500n, prev_price: 3450n, name: '황금닭 치킨 & 푸드 테크 (소비재)' },
      { stock_id: 'SLOT', price: 100n,  prev_price: 100n,  name: '럭키세븐 다이아 복권 (초보입문/국민주)' },
      { stock_id: 'SCRP', price: 120000n, prev_price: 118000n, name: '이지스크랩 데이터 테크 (빅데이터)' }
    ];

    for (const initS of initialStocks) {
      await connection.query(`
        UPDATE stocks
        SET price = ?, prev_price = ?, high_24h = ?, low_24h = ?, volume_24h = 0, updated_at = NOW()
        WHERE stock_id = ?
      `, [initS.price.toString(), initS.prev_price.toString(), initS.price.toString(), initS.price.toString(), initS.stock_id]);

      // 히스토리 초기화 및 기준가 추가
      await connection.query('DELETE FROM stock_history WHERE stock_id = ?', [initS.stock_id]);
      await connection.query('INSERT INTO stock_history (stock_id, price) VALUES (?, ?)', [initS.stock_id, initS.price.toString()]);
    }

    await connection.commit();
    console.log('✅ [완료] 모든 유저의 주식이 현재가로 100% 전량 현금 환급되었습니다!');
    console.log(`💰 총 환급된 금액: ${totalRefundedMoney.toLocaleString()}원 (${Object.keys(userRefundSummary).length}명)`);
    console.log('📈 모든 주식의 가격이 초기 기준 가격으로 리셋되었습니다.');
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('❌ 주식 환급 및 리셋 처리 실패:', error);
  } finally {
    connection.release();
    process.exit(0);
  }
}

liquidateAndResetStocks();
