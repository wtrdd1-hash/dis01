const { SlashCommandBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createEconomyEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatPercent, formatNumber } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('지갑')
    .setDescription('지갑 잔액, 은행 예금, 주식 평가금, 순자산 및 서버 내 순위(등수)를 조회합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('자산을 조회할 대상 유저 (선택하지 않으면 본인)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('유저') || interaction.user;
    const isSelf = targetUser.id === interaction.user.id;

    const username = targetUser.globalName || targetUser.username || targetUser.tag;
    const avatarUrl = targetUser.displayAvatarURL({ dynamic: true });

    const userData = await getOrCreateUser(targetUser.id, username, avatarUrl);

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

    const cash = BigInt(userData.cash || 0);
    const bank = BigInt(userData.bank || 0);
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

    const totalUsers = rankRows.length || 1;
    const userRankIndex = rankRows.findIndex(r => r.discord_id === targetUser.id);
    const rankNum = userRankIndex !== -1 ? userRankIndex + 1 : totalUsers;

    // 랭킹 메달 및 텍스트 구성
    let rankBadge = '';
    if (rankNum === 1) rankBadge = '🥇 1위 (서버 최고 부자)';
    else if (rankNum === 2) rankBadge = '🥈 2위';
    else if (rankNum === 3) rankBadge = '🥉 3위';
    else if (rankNum <= 10) rankBadge = `🏅 TOP 10 (${rankNum}위)`;
    else rankBadge = `🏆 ${rankNum}위`;

    const percentile = ((rankNum / totalUsers) * 100).toFixed(1);

    const stockSummaryText = stocksRows.length > 0
      ? `${formatMoney(stockValue)}\n(매수원금: ${formatMoney(totalSpent)} | 총손익: ${formatPercent(totalRoiPercent)})`
      : '0원';

    const embedTitle = isSelf
      ? `💳 @${username} 님의 실시간 지갑 & 자산 보고서`
      : `💳 @${username} 님의 자산 조회 결과`;

    const embed = createEconomyEmbed(
      embedTitle,
      `🏆 **순자산 순위:** **${rankBadge}** (전체 **${totalUsers}명** 중 **${rankNum}등** | 상위 **${percentile}%**)`
    )
      .setThumbnail(avatarUrl)
      .addFields(
        { name: '🏆 서버 순자산 순위', value: `**${rankBadge}**\n└ 전체 **${totalUsers}명** 중 **${rankNum}위** (상위 ${percentile}%)`, inline: false },
        { name: '💵 보유 현금', value: formatMoney(cash), inline: true },
        { name: '🏦 은행 예금', value: formatMoney(bank), inline: true },
        { name: '📊 주식 평가금액', value: stockSummaryText, inline: true },
        { name: '💎 총 순자산 (현금+예금+주식)', value: `**${formatMoney(netWorth)}**`, inline: false }
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
