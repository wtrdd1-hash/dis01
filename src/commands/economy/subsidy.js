const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('지원금')
    .setDescription('5분마다 긴급 정부 지원금 5,000원을 수령합니다.'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const avatar = interaction.user.displayAvatarURL({ dynamic: true });

    const userData = await getOrCreateUser(userId, username, avatar);

    const now = new Date();
    const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
    const cooldownMs = (config.subsidyCooldownMinutes || 5) * 60 * 1000; // 5분

    if (lastSubsidy) {
      const diffMs = now.getTime() - lastSubsidy.getTime();
      if (diffMs < cooldownMs) {
        const remainingMs = cooldownMs - diffMs;
        const embed = createWarningEmbed(
          '지원금 쿨타임 대기 중 ⏱️',
          `아직 지원금을 수령하실 수 없습니다!\n\n` +
          `💰 **신청 가능 지원금:** **${formatMoney(config.subsidyAmount || 5000)}**\n` +
          `⏳ **다음 수령까지 남은 시간:** **${formatTimeRemaining(remainingMs)}**`
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }

    const reward = config.subsidyAmount || 5000;
    const newCash = BigInt(userData.cash) + BigInt(reward);

    await pool.query(
      'UPDATE users SET cash = ?, last_subsidy = NOW() WHERE discord_id = ?',
      [newCash.toString(), userId]
    );

    const embed = createSuccessEmbed(
      '정부 지원금 수령 완료! 💸',
      `🎉 **긴급 생활 지원금 ₩5,000 지급 완료!**\n\n` +
      `💰 **획득한 지원금:** **${formatMoney(reward)}**\n` +
      `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n\n` +
      `⏱️ *다음 지원금은 5분 후에 다시 받으실 수 있습니다.*`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
