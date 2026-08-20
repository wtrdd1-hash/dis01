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
    .setName('예약매수')
    .setDescription('📋 원하는 가격 이하로 내려오면 자동 매수 (지정가 주문)')
    .addStringOption(opt => opt.setName('종목코드').setDescription('종목 ID (예: WTRD, BIOX)').setRequired(true))
    .addStringOption(opt => opt.setName('지정가격').setDescription('이 가격 이하가 되면 자동 매수 (예: 50000, 5만)').setRequired(true))
    .addStringOption(opt => opt.setName('수량').setDescription('매수할 수량 (예: 10, 0.5)').setRequired(true))
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
        content: '❌ 지정가를 올바르게 입력해주세요. (예: `50000`, `5만`, `1억`)',
        flags: MessageFlags.Ephemeral
      });
    }

    // 수량 파싱
    const units = amountToUnits(amountInput.replace(/,/g, ''));
    if (units <= 0n) {
      return interaction.reply({
        content: '❌ 수량을 올바르게 입력해주세요. (예: `10`, `0.5`, `100`)',
        flags: MessageFlags.Ephemeral
      });
    }
    const amountStr = unitsToAmountStr(units);

    // 현재가 조회
    const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
    if (!stocks.length) {
      return interaction.reply({
        content: `❌ \`${stockId}\` 종목을 찾을 수 없습니다.`,
        flags: MessageFlags.Ephemeral
      });
    }
    const currentPrice = safeBigInt(stocks[0].price);

    // 예상 비용 계산
    const totalCost = mulPriceAmount(limitPrice, amountStr);
    const taxQuote = quoteTradeTax(userId, totalCost);

    try {
      const result = await placeLimitOrder(userId, username, stockId, 'BUY', limitPrice, amountStr, expireHours || null);
      const expireText = expireHours > 0 ? `${expireHours}시간 후` : '무기한';
      const embed = new EmbedBuilder()
        .setColor(0x10B981)
        .setTitle('📋 예약 매수 주문 등록 완료')
        .setDescription(
          `**${stocks[0].name}** (\`${stockId}\`) 예약 매수가 등록되었습니다.\n` +
          `현재가(${formatMoney(currentPrice)})가 지정가(${formatMoney(limitPrice)}) **이하**로 내려오면 자동 체결됩니다.`
        )
        .addFields(
          { name: '🏷️ 지정가', value: formatMoney(limitPrice), inline: true },
          { name: '📊 수량', value: `${amountStr}주`, inline: true },
          { name: '💰 예상 결제 금액', value: formatMoney(taxQuote.netBuy), inline: true },
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
