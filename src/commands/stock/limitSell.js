'use strict';

const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt } = require('../../utils/money');
const { amountToUnits, unitsToAmountStr, mulPriceAmount } = require('../../utils/moneyScale');
const { quoteTradeTax } = require('../../utils/taxEngine');
const { placeLimitOrder } = require('../../utils/limitOrderEngine');
const { pool } = require('../../config/database');

const EXPIRE_CHOICES = [
  { name: '1시간', value: 1 },
  { name: '6시간', value: 6 },
  { name: '24시간', value: 24 },
  { name: '72시간 (3일)', value: 72 },
  { name: '무기한', value: 0 }
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('예약매도')
    .setDescription('📋 원하는 가격 이상으로 오르면 자동 매도 (지정가 주문)')
    .addStringOption(opt => opt.setName('종목코드').setDescription('종목 ID (예: WTRD, BIOX)').setRequired(true))
    .addStringOption(opt => opt.setName('지정가격').setDescription('이 가격 이상이 되면 자동 매도 (예: 100000, 10만)').setRequired(true))
    .addStringOption(opt => opt.setName('수량').setDescription('매도할 수량 (예: 10, 0.5, 전량)').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('만료시간').setDescription('주문 유효 기간 (기본: 무기한)')
        .setRequired(false)
        .addChoices(...EXPIRE_CHOICES)
    ),

  async execute(interaction) {
    const stockId = interaction.options.getString('종목코드').toUpperCase().trim();
    const priceInput = interaction.options.getString('지정가격').trim();
    const amountInput = interaction.options.getString('수량').trim();
    const expireHours = interaction.options.getInteger('만료시간') ?? 0;
    const userId = interaction.user.id;
    const username = interaction.user.username;

    // 지정가 파싱
    let limitPrice;
    try {
      const { parseMoneyInput } = require('../../utils/moneyScale');
      const parsed = parseMoneyInput(priceInput);
      limitPrice = typeof parsed === 'bigint' ? parsed : safeBigInt(parsed);
    } catch (e) {
      limitPrice = safeBigInt(priceInput.replace(/,/g, ''));
    }

    if (limitPrice <= 0n) {
      return interaction.reply({
        content: '❌ 지정가를 올바르게 입력해주세요. (예: `100000`, `10만`, `1억`)',
        flags: MessageFlags.Ephemeral
      });
    }

    // 보유 수량 조회 후 파싱
    const [holdRows] = await pool.query(
      `SELECT us.amount, s.name, s.price FROM user_stocks us
       JOIN stocks s ON us.stock_id = s.stock_id
       WHERE us.user_id = ? AND us.stock_id = ?`,
      [userId, stockId]
    );
    if (!holdRows.length || amountToUnits(holdRows[0].amount) <= 0n) {
      return interaction.reply({
        content: `❌ \`${stockId}\` 종목을 보유하고 있지 않습니다.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const holdUnits = amountToUnits(holdRows[0].amount);
    const currentPrice = safeBigInt(holdRows[0].price);
    const stockName = holdRows[0].name;

    // 수량 파싱 (전량 지원)
    let units;
    const cleaned = amountInput.replace(/,/g, '').trim().toLowerCase();
    if (['전량', 'all', '전체', '올인'].includes(cleaned)) {
      units = holdUnits;
    } else {
      units = amountToUnits(cleaned);
    }
    if (units <= 0n || units > holdUnits) {
      return interaction.reply({
        content: `❌ 매도 수량이 올바르지 않습니다. 보유 수량: **${unitsToAmountStr(holdUnits)}주**`,
        flags: MessageFlags.Ephemeral
      });
    }
    const amountStr = unitsToAmountStr(units);
    const totalProceeds = mulPriceAmount(limitPrice, amountStr);
    const taxQuote = quoteTradeTax(userId, totalProceeds);

    try {
      const result = await placeLimitOrder(userId, username, stockId, 'SELL', limitPrice, amountStr, expireHours || null);
      const expireText = expireHours > 0 ? `${expireHours}시간 후` : '무기한';
      const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle('📋 예약 매도 주문 등록 완료')
        .setDescription(
          `**${stockName}** (\`${stockId}\`) 예약 매도가 등록되었습니다.\n` +
          `현재가(${formatMoney(currentPrice)})가 지정가(${formatMoney(limitPrice)}) **이상**으로 오르면 자동 체결됩니다.`
        )
        .addFields(
          { name: '🏷️ 지정가', value: formatMoney(limitPrice), inline: true },
          { name: '📊 수량', value: `${amountStr}주`, inline: true },
          { name: '💰 예상 수령 금액', value: formatMoney(taxQuote.netSell), inline: true },
          { name: '⏰ 유효 기간', value: expireText, inline: true },
          { name: '🔢 주문 ID', value: `#${result.orderId}`, inline: true },
          { name: '📌 현재가', value: formatMoney(currentPrice), inline: true }
        )
        .setFooter({ text: '/예약조회 로 내 주문 목록 확인 | /예약취소 로 취소 가능' })
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({
        content: `❌ ${err.message}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
