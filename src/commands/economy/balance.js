const { SlashCommandBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createEconomyEmbed } = require('../../utils/embedBuilder');
const { evalStockValue, computeNetWorth, NET_WORTH_SQL } = require('../../utils/economyBalance');
const { formatMoney, formatPercent, safeBigInt } = require('../../utils/formatters');
const { cohortOf, whereCohort } = require('../../utils/economyCohort');
const { getPublicTaxView } = require('../../utils/taxEngine');
const { getPublicLoanView } = require('../../utils/loanEngine');

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
      const amountNum = Number(item.amount);
      const spent = safeBigInt(item.total_spent);
      const evalValue = evalStockValue(item.amount, item.price);
      const profitLoss = evalValue - spent;
      const roiPercent = spent > 0n ? (Number(profitLoss) / Number(spent)) * 100 : 0;

      stockValue += evalValue;
      totalSpent += spent;

      const avgPrice = amountNum > 0 ? safeBigInt(Math.round(Number(spent) / amountNum)) : 0n;
      const displayAmount = (amountNum % 1 === 0) ? amountNum.toLocaleString() : amountNum.toFixed(4);
      stockListText += `• **\`[${item.stock_id}]\` ${item.name}**: ${displayAmount}주 (평단 ${formatMoney(avgPrice)})\n` +
        `  └ 매수 ${formatMoney(spent)} ➔ 평가 ${formatMoney(evalValue)} | 손익 **${formatMoney(profitLoss)}** (${formatPercent(roiPercent)})\n`;
    }

    const totalProfitLoss = stockValue - totalSpent;
    const totalRoiPercent = totalSpent > 0n ? (Number(totalProfitLoss) / Number(totalSpent)) * 100 : 0;

    const cash = safeBigInt(userData.cash);
    const bank = safeBigInt(userData.bank);
    const netWorth = computeNetWorth(cash, bank, stockValue);

    // 같은 그룹(일반 유저 / 관리자) 안에서만 순위 계산
    const cohort = cohortOf(targetUser.id);
    const filter = whereCohort('u.discord_id', cohort);
    const groupLabel = cohort === 'admin' ? '관리자' : '일반 유저';
    const [rankRows] = await pool.query(`
      SELECT 
        u.discord_id, 
        ${NET_WORTH_SQL} AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      WHERE ${filter.sql}
      GROUP BY u.discord_id, u.cash, u.bank
      ORDER BY net DESC
    `, filter.params);

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

    const cashBadge = cash < 0n ? `🚨 **${formatMoney(cash)}** \`(마이너스 빚/부채)\`` : formatMoney(cash);
    const bankBadge = bank < 0n ? `🚨 **${formatMoney(bank)}** \`(마이너스 통장)\`` : formatMoney(bank);
    const netBadge = netWorth < 0n ? `🚨 **${formatMoney(netWorth)}** \`(채무 초과 상태)\`` : `**${formatMoney(netWorth)}**`;

    const embed = createEconomyEmbed(
      embedTitle,
      `🏆 **${groupLabel} 순자산 순위:** **${rankBadge}** (${groupLabel} **${totalUsers}명** 중 **${rankNum}등** | 상위 **${percentile}%**)`
    )
      .setThumbnail(avatarUrl)
      .addFields(
        { name: `🏆 ${groupLabel} 순자산 순위`, value: `**${rankBadge}**\n└ ${groupLabel} **${totalUsers}명** 중 **${rankNum}위** (상위 ${percentile}%)`, inline: false },
        { name: '💵 보유 현금', value: cashBadge, inline: true },
        { name: '🏦 은행 예금', value: bankBadge, inline: true },
        { name: '📊 주식 평가금액', value: stockSummaryText, inline: true },
        { name: '💎 총 순자산 (현금+예금+주식)', value: netBadge, inline: false }
      );

    if (stocksRows.length > 0) {
      embed.addFields({
        name: `📈 보유 주식 손익 현황 (총 손익: ${formatMoney(totalProfitLoss)} / ${formatPercent(totalRoiPercent)})`,
        value: stockListText,
        inline: false
      });
    }

    if (isSelf) {
      const tax = await getPublicTaxView(targetUser.id);
      if (tax.exempt) {
        embed.addFields({ name: '🏛️ 세금', value: '관리자 계정은 세금이 없습니다.', inline: false });
      } else {
        const nextMin = Math.max(0, Math.ceil((Number(tax.nextWealthTaxAt) - Date.now()) / 60000));
        const levy = safeBigInt(tax.estimatedLevy);
        const nextLine = tax.rate > 0
          ? `\n다음 자산세 약 **${nextMin}분** 후` + (levy > 0n ? ` · 이번 회차 예상 **${formatMoney(levy)}**` : '')
          : '\n지금은 자산세를 걷지 않습니다.';
        embed.addFields({
          name: '🏛️ 세금',
          value: (tax.rate > 0
            ? `거래·송금세 **${tax.rateText}**\n자산세: 현금+예금 **${formatMoney(tax.threshold)}** 초과 시 현금·예금에서 회수`
            : '현재 거래세 없음 (경제 안정)') + nextLine,
          inline: false
        });
      }

      try {
        const loan = await getPublicLoanView(targetUser.id);
        if (loan.exempt) {
          embed.addFields({ name: '💳 대출', value: '관리자 계정은 대출할 수 없습니다.', inline: false });
        } else if (loan.hasLoan) {
          const dueLine = loan.overdue
            ? '**연체** — 카지노·주식 매수가 막혀 있습니다.'
            : `만기까지 약 **${Math.floor((Number(loan.dueInSec) || 0) / 3600)}시간 ${Math.floor(((Number(loan.dueInSec) || 0) % 3600) / 60)}분**`;
          embed.addFields({
            name: loan.overdue ? '💳 대출 (연체)' : '💳 대출',
            value: `채무 **${formatMoney(loan.debt)}** (원금 ${formatMoney(loan.principal)} + 이자 ${formatMoney(loan.interest)})\n담보 예금 **${formatMoney(loan.collateral)}**\n${dueLine}`,
            inline: false
          });
        } else if (isSelf) {
          embed.addFields({
            name: '💳 대출',
            value: `한도 **${formatMoney(loan.maxBorrow || 0)}** · 이자 ${loan.rateText || '시간당 0.15%'} · 만기 ${loan.termHours || 24}시간\n\`/은행 대출\` 로 받고 \`/은행 상환\` 으로 갚습니다.`,
            inline: false
          });
        }
      } catch (e) {}
    }

    await interaction.reply({ embeds: [embed] });
  }
};
