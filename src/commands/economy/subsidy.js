const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');
const { safeBigInt, applyCashDelta, withUserLock, tryClaimCooldown } = require('../../utils/money');
const { SUBSIDY, subsidyStatus, STOCK_VALUE_SQL } = require('../../utils/economyBalance');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('지원금')
    .setDescription('정부 지원금을 수령합니다. (순자산 5만원 미만, 현금+예금 부족 시 2분)'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const avatar = interaction.user.displayAvatarURL({ dynamic: true });

    return withUserLock(userId, async () => {
      const userData = await getOrCreateUser(userId, username, avatar);
      const userCash = safeBigInt(userData.cash);
      const userBank = safeBigInt(userData.bank);
      const [stockSum] = await pool.query(`
        SELECT ${STOCK_VALUE_SQL} AS v
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [userId]);
      const stockVal = safeBigInt(stockSum[0]?.v);
      const status = subsidyStatus(userCash, userBank, stockVal);

      if (!status.eligible) {
        const embed = createWarningEmbed(
          '지원금 대상 아님',
          `순자산이 **${formatMoney(SUBSIDY.WEALTH_CAP)}** 이상이면 지원금을 받을 수 없습니다.\n\n` +
          `💎 **현재 순자산:** **${formatMoney(status.net)}** (현금+예금+주식)`
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const isBroke = status.isBroke;

      const now = new Date();
      const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
      const cooldownMs = isBroke ? SUBSIDY.BROKE_COOLDOWN_MS : (config.subsidyCooldownMinutes || 10) * 60 * 1000;

      if (lastSubsidy) {
        const diffMs = now.getTime() - lastSubsidy.getTime();
        if (diffMs < cooldownMs) {
          const remainingMs = cooldownMs - diffMs;
          const embed = createWarningEmbed(
            '지원금 쿨타임 대기 중 ⏱️',
            `아직 지원금 쿨타임이 남아있습니다!\n\n` +
            `💰 **신청 가능 지원금:** **${formatMoney(isBroke ? SUBSIDY.BROKE_AMOUNT : (config.subsidyAmount || 2000))}**\n` +
            `⏳ **다음 수령까지 남은 시간:** **${formatTimeRemaining(remainingMs)}**`
          );
          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      }

      const baseAmount = isBroke ? SUBSIDY.BROKE_AMOUNT : (config.subsidyAmount || SUBSIDY.NORMAL_AMOUNT);

      let mult = 1.0;
      try {
        const { getDynamicSettings } = require('../../utils/economyBalancer');
        const dyn = getDynamicSettings();
        if (dyn && dyn.subsidyMultiplier) mult = dyn.subsidyMultiplier;
      } catch (e) {}

      const reward = Math.max(500, Math.round(baseAmount * mult));
      const claimed = await tryClaimCooldown(userId, 'last_subsidy', cooldownMs);
      if (!claimed) {
        const embed = createWarningEmbed(
          '지원금 쿨타임 대기 중 ⏱️',
          '아직 지원금 쿨타임이 남아있습니다!'
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const { grantTreasurySubsidy, readTreasury } = require('../../utils/taxEngine');
      const subResult = await grantTreasurySubsidy(userId, username, reward, isBroke ? '무일푼 긴급 구제 지원금' : '정기 생활 기본소득');
      const newCash = subResult.newCash;
      const treasuryLeft = subResult.newTreasury;

      const title = isBroke ? '🚨 무일푼 긴급 구제 지원금 수령! 💸' : '🏛️ 정부 국고 긴급 기본소득 수령 완료! 💸';
      const desc = isBroke
        ? `🎉 **잔고 부족 상태로 국고에서 긴급 지원금이 지급되었습니다.**\n\n` +
          `💰 **지급된 지원금:** **+${formatMoney(reward)}**\n` +
          `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n` +
          `🏛️ **국고 잔액:** **${formatMoney(treasuryLeft)}**\n\n` +
          `⏱️ *다음 긴급 지원금은 2분 후에 다시 받으실 수 있습니다.*`
        : `🎉 **정기 긴급 생활 기본소득 +${formatMoney(reward)} 국고 지급 완료!**\n\n` +
          `💰 **획득한 지원금:** **+${formatMoney(reward)}**\n` +
          `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n` +
          `🏛️ **국고 잔액:** **${formatMoney(treasuryLeft)}**\n\n` +
          `⏱️ *다음 정기 지원금은 10분 후에 다시 받으실 수 있습니다.*`;

      const embed = createSuccessEmbed(title, desc);
      await interaction.reply({ embeds: [embed] });
    });
  }
};
