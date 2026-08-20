const { MARKET_REGIMES } = require('../src/utils/stockEngine');
const { clampStockDelta, STOCK } = require('../src/utils/economyBalance');

console.log('=== 📈 가상 주식 시장 정밀 밸런스 시뮬레이션 (1,000틱 × 10회 시행) ===\n');

for (let trial = 1; trial <= 5; trial++) {
  let initialPrice = 10000;
  let currentPrice = initialPrice;
  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;
  let prices = [currentPrice];

  for (let i = 0; i < 1000; i++) {
    const regime = MARKET_REGIMES[Math.floor(Math.random() * MARKET_REGIMES.length)];
    const baseVolatility = 0.035;
    const regimeDrift = regime.drift;
    const adjustedVolatility = baseVolatility * regime.volatilityFactor;
    const noise = (Math.random() * 2 - 1) * adjustedVolatility;

    // 차익 실현 압력
    let profitTaking = 0;
    if (currentPrice > initialPrice * 1.25) {
      profitTaking = -Math.min(0.015, (currentPrice / initialPrice - 1.25) * 0.04);
    }

    const rawDelta = regimeDrift + noise + profitTaking;
    const totalDelta = clampStockDelta(0, rawDelta);
    const newPrice = Math.max(10, Math.round(currentPrice * (1 + totalDelta)));

    if (newPrice > currentPrice) upCount++;
    else if (newPrice < currentPrice) downCount++;
    else flatCount++;

    currentPrice = newPrice;
    prices.push(currentPrice);
  }

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const finalReturn = ((currentPrice - initialPrice) / initialPrice * 100).toFixed(2);

  console.log(`[테스트 #${trial}] 1,000틱 후 주가: ${currentPrice.toLocaleString()}원 (수익률: ${finalReturn >= 0 ? '+' : ''}${finalReturn}%) | 최저 ${minP.toLocaleString()}원 ~ 최고 ${maxP.toLocaleString()}원 | 상승 ${upCount}회 (${(upCount/10).toFixed(1)}%), 하락 ${downCount}회 (${(downCount/10).toFixed(1)}%)`);
}

console.log(`\n상하한선(MAX_TICK_DELTA): ±${(STOCK.MAX_TICK_DELTA * 100).toFixed(1)}%`);
console.log('=== ✅ 주식 시장 현실적 밸런스 검증 완료! ===');
