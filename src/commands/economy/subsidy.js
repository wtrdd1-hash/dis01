const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('지원금')
    .setDescription('정부 지원금을 수령합니다. (잔고 0원/부족 시 쿨타임 없이 무제한 즉시 지급)'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const avatar = interaction.user.displayAvatarURL({ dynamic: true });

    const userData = await getOrCreateUser(userId, username, avatar);
    const userCash = BigInt(userData.cash || 0);
    const userBank = BigInt(userData.bank || 0);
    const isBroke = (userCash + userBank <= 0n || userCash < 1000n);

    const now = new Date();
    const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
    const cooldownMs = (config.subsidyCooldownMinutes || 10) * 60 * 1000; // 10분

    // 잔고가 있을 때만 10분 쿨타임 체크 (돈이 없거나 파산 상태면 무제한 즉시 지급)
    if (!isBroke && lastSubsidy) {
      const diffMs = now.getTime() - lastSubsidy.getTime();
      if (diffMs < cooldownMs) {
        const remainingMs = cooldownMs - diffMs;
        const embed = createWarningEmbed(
          '지원금 쿨타임 대기 중 ⏱️',
          `아직 지원금 쿨타임이 남아있습니다!\n\n` +
          `💰 **신청 가능 지원금:** **${formatMoney(config.subsidyAmount || 5000)}**\n` +
          `⏳ **다음 수령까지 남은 시간:** **${formatTimeRemaining(remainingMs)}**\n\n` +
          `💡 *잔고가 0원이거나 부족한 경우 쿨타임 없이 즉시 지원금을 받으실 수 있습니다.*`
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }

    const baseAmount = isBroke ? 3000 : (config.subsidyAmount || 2000);

    // 🏦 자동 경제 조절 장치: 현재 경제 상황에 맞춘 동적 배율 적용
    let mult = 1.0;
    try {
      const { getDynamicSettings } = require('../../utils/economyBalancer');
      const dyn = getDynamicSettings();
      if (dyn && dyn.subsidyMultiplier) mult = dyn.subsidyMultiplier;
    } catch (e) {}

    const reward = Math.max(500, Math.round(baseAmount * mult));
    const newCash = userCash + BigInt(reward);

    await pool.query(
      'UPDATE users SET cash = ?, last_subsidy = NOW() WHERE discord_id = ?',
      [newCash.toString(), userId]
    );

    const title = isBroke ? '🚨 무일푼 긴급 구제 지원금 즉시 수령! 💸' : '정부 긴급 기본소득 수령 완료! 💸';
    const desc = isBroke 
      ? `🎉 **잔고 부족(파산) 상태로 쿨타임 없이 긴급 지원금이 지급되었습니다!**\n\n` +
        `💰 **지급된 지원금:** **+${formatMoney(reward)}**\n` +
        `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n\n` +
        `💡 *돈이 없을 때마다 언제든 클릭/명령어로 지원금을 계속 충전하세요!*`
      : `🎉 **정기 긴급 생활 기본소득 +${formatMoney(reward)} 지급 완료!**\n\n` +
        `💰 **획득한 지원금:** **${formatMoney(reward)}**\n` +
        `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n\n` +
        `⏱️ *다음 정기 지원금은 10분 후에 다시 받으실 수 있습니다.*`;

    const embed = createSuccessEmbed(title, desc);
    await interaction.reply({ embeds: [embed] });
  }
};
