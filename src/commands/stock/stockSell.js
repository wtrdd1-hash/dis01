const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatNumber } = require('../../utils/formatters');
const { safeBigInt, withUserLock, isAllInAmount } = require('../../utils/money');
const { quoteTradeTax, applyCreditMinusTax } = require('../../utils/taxEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('주식매도')
    .setDescription('보유 중인 주식을 매도합니다.')
    .addStringOption(option =>
      option.setName('종목코드')
        .setDescription('종목 ID (예: WTRD, AICH, SPAC, BIOX, LUXU, AUTO, MINE, CASN, BANK, NEKO, CHKN, SLOT, SCRP)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('수량')
        .setDescription('매도할 수량 (숫자 또는 "전량")')
        .setRequired(true)
    ),

  async execute(interaction) {
    const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
    const amountInput = interaction.options.getString('수량').trim();
    const userId = interaction.user.id;

    // 보유 주식 조회
    const [userStocks] = await pool.query(`
      SELECT us.*, s.name, s.price
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.user_id = ? AND us.stock_id = ?
    `, [userId, stockIdInput]);

    const { amountToUnits, unitsToAmountStr, mulPriceAmount } = require('../../utils/moneyScale');
    if (userStocks.length === 0 || amountToUnits(userStocks[0].amount) <= 0n) {
      return interaction.reply({
        embeds: [createErrorEmbed('매도 불가', `\`${stockIdInput}\` 종목을 보유하고 있지 않습니다. \`/포트폴리오\`를 확인하세요.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const holding = userStocks[0];
    const currentUnits = amountToUnits(holding.amount);
    const stockPrice = safeBigInt(holding.price);
    const totalSpent = safeBigInt(holding.total_spent);

    let sellUnits = 0n;
    if (isAllInAmount(amountInput)) {
      sellUnits = currentUnits;
    } else {
      const cleaned = amountInput.replace(/,/g, '').trim();
      sellUnits = amountToUnits(cleaned);
      if (sellUnits <= 0n) {
        const { parseMoneyInput } = require('../../utils/moneyScale');
        const parsed = parseMoneyInput(cleaned);
        if (typeof parsed === 'bigint' && parsed > 0n) sellUnits = parsed * 10000n;
      }
      if (sellUnits <= 0n) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '매도 수량은 0.0001 이상의 수 또는 "전액" / "전량"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (sellUnits > currentUnits) {
      return interaction.reply({
        embeds: [createErrorEmbed('수량 초과', `보유 수량(${unitsToAmountStr(currentUnits)}주)보다 많은 수량을 매도할 수 없습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const sellAmountStr = unitsToAmountStr(sellUnits);
    const totalProceeds = mulPriceAmount(stockPrice, sellAmountStr);
    await getOrCreateUser(userId);

    const spentDeduction = currentUnits > 0n ? (totalSpent * sellUnits) / currentUnits : 0n;
    const newTotalSpent = totalSpent > spentDeduction ? totalSpent - spentDeduction : 0n;
    const newUnits = currentUnits - sellUnits;

    const taxQuote = quoteTradeTax(userId, totalProceeds);
    const newCash = await withUserLock(userId, async () => {
      const credited = await applyCreditMinusTax(
        userId,
        interaction.user.username,
        totalProceeds,
        taxQuote.tax,
        'TAX_TRADE',
        `주식 매도 거래세 [${holding.stock_id}]`
      );
      const after = credited.after;
      if (newUnits <= 0n) {
        await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [userId, stockIdInput]);
      } else {
        await pool.query(
          'UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?',
          [unitsToAmountStr(newUnits), newTotalSpent.toString(), userId, stockIdInput]
        );
      }
      return after;
    });

    const displaySellAmount = unitsToAmountStr(sellUnits);
    const displayRemainAmount = unitsToAmountStr(newUnits);

    const taxLine = taxQuote.tax > 0n
      ? `**거래세 (${(taxQuote.rate * 100).toFixed(1)}%):** -${formatMoney(taxQuote.tax)}\n`
      : '';
    const embed = createSuccessEmbed(
      '주식 매도 완료',
      `**종목:** \`[${holding.stock_id}]\` ${holding.name}\n` +
      `**매도 수량:** **${displaySellAmount}주**\n` +
      `**체결 단가:** ${formatMoney(stockPrice)}\n` +
      `**매도 대금:** ${formatMoney(totalProceeds)}\n` +
      taxLine +
      `**실수령:** **+${formatMoney(taxQuote.netSell)}**\n\n` +
      `💳 **현재 보유 현금:** ${formatMoney(newCash)}\n` +
      `📦 **남은 주식 수량:** ${displayRemainAmount}주`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
