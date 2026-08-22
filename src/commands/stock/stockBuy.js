const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, withUserLock, isAllInAmount } = require('../../utils/money');
const { quoteTradeTax, maxBuyShareUnits, applyDebitWithTax } = require('../../utils/taxEngine');
const { amountToUnits, unitsToAmountStr, mulPriceAmount, parseMoneyInput } = require('../../utils/moneyScale');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('주식매수')
    .setDescription('원하는 주식을 매수합니다.')
    .addStringOption(option =>
      option.setName('종목코드')
        .setDescription('종목 ID (예: WTRD, AICH, SPAC, BIOX, LUXU, AUTO, MINE, CASN, BANK, NEKO, CHKN, SLOT, SCRP)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('수량')
        .setDescription('매수할 수량 (소수점 또는 "올인")')
        .setRequired(true)
    ),

  async execute(interaction) {
    const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
    const amountInput = interaction.options.getString('수량').trim();
    const userId = interaction.user.id;
    try {
      await require('../../utils/loanEngine').assertLoanPlayAllowed(userId);
    } catch (err) {
      if (err && err.code === 'LOAN_BLOCK') {
        return interaction.reply({
          embeds: [createErrorEmbed('대출 연체', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
      throw err;
    }

    const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockIdInput]);
    if (stocks.length === 0) {
      return interaction.reply({
        embeds: [createErrorEmbed('종목 없음', `\`${stockIdInput}\` 종목을 찾을 수 없습니다. \`/주식시세\`에서 종목 코드를 확인하세요.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const stock = stocks[0];
    const stockPrice = safeBigInt(stock.price);
    const userData = await getOrCreateUser(userId);
    const userCash = safeBigInt(userData.cash);
    const { getStockMaxBuyLimit } = require('../../utils/stockEngine');
    const buyLimitInfo = getStockMaxBuyLimit(stock);

    let tradeUnits = 0n;
    if (isAllInAmount(amountInput)) {
      tradeUnits = maxBuyShareUnits(userCash, stockPrice, userId);
      if (tradeUnits > buyLimitInfo.maxUnits) {
        tradeUnits = buyLimitInfo.maxUnits; // 1회 최대 구매 한도로 자동 캡
      }
    } else {
      const cleaned = amountInput.replace(/,/g, '').trim();
      tradeUnits = amountToUnits(cleaned);
      if (tradeUnits <= 0n) {
        const parsed = parseMoneyInput(cleaned);
        if (typeof parsed === 'bigint' && parsed > 0n) tradeUnits = parsed * 10000n;
      }
      if (tradeUnits <= 0n) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '매수 수량은 0.0001주 이상, 한글 단위(예: 5만), 또는 "전액" / "전량" / "올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      const maxUnits = maxBuyShareUnits(userCash, stockPrice, userId);
      if (tradeUnits > maxUnits && maxUnits > 0n && tradeUnits - maxUnits <= 10000n) {
        tradeUnits = maxUnits;
      }
    }

    // 🛡️ [주식별 & 거시경제 연동 1회 최대 구매 한도 검증]
    if (tradeUnits > buyLimitInfo.maxUnits) {
      return interaction.reply({
        embeds: [createErrorEmbed(
          '매수 한도 초과 ⚠️',
          `**[${stock.name}]** 종목의 현재 경제 국면(**${buyLimitInfo.regimeName}**) 기준 1회 최대 구매 가능 수량은 **${buyLimitInfo.maxSharesText}**입니다.\n` +
          `*(적용 규정: ${buyLimitInfo.policyName})*`
        )],
        flags: MessageFlags.Ephemeral
      });
    }

    // 🛡️ [종목별 전체 발행 / 총 구매 한도 (Total Supply Limit) 검증 - 모든 유저 합산]
    const maxLimit = stock.max_buy_limit != null && Number(stock.max_buy_limit) > 0 ? Number(stock.max_buy_limit) : null;
    if (maxLimit !== null) {
      const [sumRows] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total_held FROM user_stocks WHERE stock_id = ?', [stock.stock_id]);
      const currentTotalHeld = Number(sumRows[0]?.total_held || 0);
      const buyAmountNum = Number(unitsToAmountStr(tradeUnits));
      if (currentTotalHeld >= maxLimit) {
        return interaction.reply({
          embeds: [createErrorEmbed(
            '종목 매진 (발행 한도 소진) ⚠️',
            `**[${stock.name}]** 종목은 전체 발행 주식(총 **${maxLimit.toLocaleString()}주**)이 모두 소진되어 더 이상 매수할 수 없습니다.\n다른 유저가 매도할 때까지 기다려주세요.`
          )],
          flags: MessageFlags.Ephemeral
        });
      }
      if (currentTotalHeld + buyAmountNum > maxLimit) {
        const remaining = Math.max(0, maxLimit - currentTotalHeld);
        return interaction.reply({
          embeds: [createErrorEmbed(
            '발행 한도 초과 ⚠️',
            `**[${stock.name}]** 종목의 남은 매수 가능 잔여 수량은 **${remaining.toLocaleString()}주**입니다.\n(총 발행 한도: ${maxLimit.toLocaleString()}주 / 현재 소진: ${currentTotalHeld.toLocaleString()}주)`
          )],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (tradeUnits <= 0n) {
      return interaction.reply({
        embeds: [createErrorEmbed('매수 불가', '매수할 수 있는 현금이 부족하거나 수량이 0주입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const countDecStr = unitsToAmountStr(tradeUnits);
    const totalCost = mulPriceAmount(stockPrice, countDecStr);
    const taxQuote = quoteTradeTax(userId, totalCost);

    if (userCash < taxQuote.netBuy) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `매수 금액(${formatMoney(taxQuote.netBuy)})이 보유 현금(${formatMoney(userCash)})보다 많습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    let newCash;
    try {
      newCash = await withUserLock(userId, async () => {
        const paid = await applyDebitWithTax(
          userId,
          interaction.user.username,
          totalCost,
          taxQuote.tax,
          'TAX_TRADE',
          `주식 매수 거래세 [${stock.stock_id}]`
        );
        await pool.query(`
          INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            amount = amount + VALUES(amount),
            total_spent = total_spent + VALUES(total_spent)
        `, [userId, stock.stock_id, countDecStr, totalCost.toString()]);
        return paid.after;
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CASH') {
        return interaction.reply({
          embeds: [createErrorEmbed('현금 부족', `매수 금액(${formatMoney(taxQuote.netBuy)})이 보유 현금보다 많습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }
      throw err;
    }

    const taxLine = taxQuote.tax > 0n
      ? `**거래세 (${(taxQuote.rate * 100).toFixed(1)}%):** ${formatMoney(taxQuote.tax)}\n`
      : '';
    const embed = createSuccessEmbed(
      '주식 매수 완료 📈',
      `**종목:** ${stock.name} (\`${stock.stock_id}\`)\n` +
      `**매수 수량:** **${countDecStr}주**\n` +
      `**주당 가격:** ${formatMoney(stockPrice)}\n` +
      `**주식 대금:** ${formatMoney(totalCost)}\n` +
      taxLine +
      `**총 결제:** **${formatMoney(taxQuote.netBuy)}**\n\n` +
      `💳 **매수 후 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
