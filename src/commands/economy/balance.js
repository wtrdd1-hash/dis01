const { SlashCommandBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createEconomyEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatPercent, formatNumber } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('지갑')
    .setDescription('내 지갑 잔액, 은행 예금, 주식 매수금액/평가금액/수익률 및 순자산을 조회합니다.'),

  async execute(interaction) {
    const targetUser = interaction.user;
    const userData = await getOrCreateUser(targetUser.id);

    // 주식 상세 및 평가금액 계산
    const [stocksRows] = await pool.query(`
      SELECT us.amount, us.total_spent, s.stock_id, s.name, s.price
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.user_id = ? AND us.amount > 0
    `, [targetUser.id]);

    let stockValue = 0n;
    let totalSpent = 0n;
    let stockListText = '';

    for (const item of stocksRows) {
      const amount = BigInt(item.amount);
      const spent = BigInt(item.total_spent);
      const currentPrice = BigInt(item.price);
      const evalValue = amount * currentPrice;
      const profitLoss = evalValue - spent;
      const roiPercent = spent > 0n ? (Number(profitLoss) / Number(spent)) * 100 : 0;

      stockValue += evalValue;
      totalSpent += spent;

      const avgPrice = amount > 0n ? spent / amount : 0n;
      stockListText += `• **\`[${item.stock_id}]\` ${item.name}**: ${formatNumber(amount)}주 (평단 ${formatMoney(avgPrice)})\n` +
        `  └ 매수 ${formatMoney(spent)} ➔ 평가 ${formatMoney(evalValue)} | 손익 **${formatMoney(profitLoss)}** (${formatPercent(roiPercent)})\n`;
    }

    const totalProfitLoss = stockValue - totalSpent;
    const totalRoiPercent = totalSpent > 0n ? (Number(totalProfitLoss) / Number(totalSpent)) * 100 : 0;

    const cash = BigInt(userData.cash);
    const bank = BigInt(userData.bank);
    const netWorth = cash + bank + stockValue;

    // 전체 순위 계산 (총 순자산 기준)
    const [rankRows] = await pool.query(`
      SELECT 
        u.discord_id, 
        (u.cash + u.bank + COALESCE(SUM(us.amount * s.price), 0)) AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      GROUP BY u.discord_id, u.cash, u.bank
      ORDER BY net DESC
    `);
    
    const userRankIndex = rankRows.findIndex(r => r.discord_id === targetUser.id);
    const rankText = userRankIndex !== -1 ? `${userRankIndex + 1}위 / ${rankRows.length}명` : '순위 밖';

    const stockSummaryText = stocksRows.length > 0
      ? `${formatMoney(stockValue)}\n(매수: ${formatMoney(totalSpent)} | 손익: ${formatPercent(totalRoiPercent)})`
      : '0원';

    const embed = createEconomyEmbed(
      `💳 ${targetUser.username} 님의 자산 보고서`,
      `**순자산 순위:** 🏆 \`${rankText}\``
    )
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '💵 보유 현금', value: formatMoney(cash), inline: true },
        { name: '🏦 은행 예금', value: formatMoney(bank), inline: true },
        { name: '📊 주식 평가금액', value: stockSummaryText, inline: true },
        { name: '💎 총 순자산', value: formatMoney(netWorth), inline: false }
      );

    if (stocksRows.length > 0) {
      embed.addFields({
        name: `📈 보유 주식 손익 현황 (총 손익: ${formatMoney(totalProfitLoss)} / ${formatPercent(totalRoiPercent)})`,
        value: stockListText,
        inline: false
      });
    }

    await interaction.reply({ embeds: [embed] });
  }
};
