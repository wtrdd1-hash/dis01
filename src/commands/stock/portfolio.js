const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../../config/database');
const { createStockEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatNumber, formatPercent } = require('../../utils/formatters');
const { evalStockValue } = require('../../utils/economyBalance');
const { safeBigInt } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('포트폴리오')
    .setDescription('보유 중인 주식 포트폴리오 및 손익 현황을 확인합니다.'),

  async execute(interaction) {
    const userId = interaction.user.id;

    const [rows] = await pool.query(`
      SELECT us.amount, us.total_spent, s.stock_id, s.name, s.price
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.user_id = ? AND us.amount > 0
    `, [userId]);

    if (rows.length === 0) {
      const embed = createStockEmbed(
        '📊 주식 포트폴리오',
        '현재 보유 중인 주식이 없습니다.\n`/주식시세` 확인 후 `/주식매수`로 주식을 구매해 보세요!'
      );
      return interaction.reply({ embeds: [embed] });
    }

    let totalInvestment = 0n;
    let totalEvaluation = 0n;
    let fieldsText = '';

    for (const r of rows) {
      const amountNum = Number(r.amount);
      const spent = BigInt(String(r.total_spent || 0).split('.')[0] || '0');
      const currentPrice = safeBigInt(r.price);
      const evalValue = evalStockValue(r.amount, r.price);

      totalInvestment += spent;
      totalEvaluation += evalValue;

      const avgPrice = amountNum > 0 ? BigInt(Math.round(Number(spent) / amountNum)) : 0n;
      const profitLoss = evalValue - spent;
      const roiPercent = spent > 0n ? (Number(profitLoss) / Number(spent)) * 100 : 0;
      const displayAmount = (amountNum % 1 === 0) ? amountNum.toLocaleString() : amountNum.toFixed(4);

      fieldsText += `**\`[${r.stock_id}]\` ${r.name}**\n` +
        `• 보유 수량: ${displayAmount}주\n` +
        `• 평단가: ${formatMoney(avgPrice)} | 현재가: ${formatMoney(currentPrice)}\n` +
        `• 매수금액: ${formatMoney(spent)} | 평가금액: ${formatMoney(evalValue)}\n` +
        `• 손익: **${formatMoney(profitLoss)}** (${formatPercent(roiPercent)})\n` +
        `----------------------------------------\n`;
    }

    const totalProfitLoss = totalEvaluation - totalInvestment;
    const totalRoi = totalInvestment > 0n ? (Number(totalProfitLoss) / Number(totalInvestment)) * 100 : 0;

    const header = `💎 **총 매수금액:** ${formatMoney(totalInvestment)}\n` +
      `📊 **총 평가금액:** ${formatMoney(totalEvaluation)}\n` +
      `📈 **총 평가손익:** **${formatMoney(totalProfitLoss)}** (${formatPercent(totalRoi)})\n\n` +
      `**보유 종목 상세 리스트**\n` +
      `----------------------------------------\n`;

    const embed = createStockEmbed(
      `📊 ${interaction.user.username} 님의 주식 포트폴리오`,
      header + fieldsText
    );

    await interaction.reply({ embeds: [embed] });
  }
};
