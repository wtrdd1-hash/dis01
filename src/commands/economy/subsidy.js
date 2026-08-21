const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');
const { safeBigInt, withUserLock, tryClaimCooldown } = require('../../utils/money');
const { SUBSIDY } = require('../../utils/economyBalance');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('지원금')
    .setDescription('기초 생활 지원금을 수령합니다. (순자산 2만원 이하 유저 대상, 24시간 1회 2,000원)'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const avatar = interaction.user.displayAvatarURL({ dynamic: true });

    return withUserLock(userId, async () => {
      const userData = await getOrCreateUser(userId, username, avatar);
      const userCash = safeBigInt(userData.cash);
      const userBank = safeBigInt(userData.bank);
      const [stockSum] = await pool.query(`
        SELECT COALESCE(SUM(us.amount * s.price), 0) AS v
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [userId]);
      const stockVal = safeBigInt(stockSum[0]?.v);
      const netWorth = userCash + userBank + stockVal;

      if (netWorth > BigInt(SUBSIDY.MAX_NET_WORTH)) {
        const embed = createWarningEmbed(
          '지원금 신청 대상 아님 ❌',
          `기초 생활 지원금은 순자산 **${formatMoney(SUBSIDY.MAX_NET_WORTH)}** 이하인 유저만 신청 가능합니다.\n\n` +
          `💎 **현재 내 순자산:** **${formatMoney(netWorth)}** (현금+예금+주식)`
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const now = new Date();
      const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
      const cooldownMs = SUBSIDY.COOLDOWN_MS;

      if (lastSubsidy) {
        const diffMs = now.getTime() - lastSubsidy.getTime();
        if (diffMs < cooldownMs) {
          const remainingMs = cooldownMs - diffMs;
          const embed = createWarningEmbed(
            '지원금 쿨타임 대기 중 ⏱️',
            `지원금은 하루 1회만 수령하실 수 있습니다!\n\n` +
            `💰 **지원금 액수:** **${formatMoney(SUBSIDY.AMOUNT)}**\n` +
            `⏳ **다음 수령까지 남은 시간:** **${formatTimeRemaining(remainingMs)}**`
          );
          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      }

      const reward = SUBSIDY.AMOUNT;
      const claimed = await tryClaimCooldown(userId, 'last_subsidy', cooldownMs);
      if (!claimed) {
        const embed = createWarningEmbed(
          '지원금 쿨타임 대기 중 ⏱️',
          '지원금은 하루 1회만 수령하실 수 있습니다!'
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const { grantTreasurySubsidy } = require('../../utils/taxEngine');
      const subResult = await grantTreasurySubsidy(userId, username, safeBigInt(reward), `🏛️ [기초 생활 지원금] ${username} 지원금 지급`);
      const newCash = subResult.newCash;
      const treasuryLeft = subResult.newTreasury;

      const embed = createSuccessEmbed(
        '기초 생활 지원금 수령 완료! 🏛️',
        `성공적으로 정부 지원금을 수령하셨습니다.\n\n` +
        `💰 **수령 지원금:** **+${formatMoney(reward)}** (🏛️ 국고 지급)\n` +
        `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n` +
        `🏛️ **국고 잔액:** **${formatMoney(treasuryLeft)}**\n` +
        `⏱️ **다음 수령 가능:** 24시간 후`
      );

      await interaction.reply({ embeds: [embed] });
    });
  }
};
