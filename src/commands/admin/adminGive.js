const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_give')
    .setDescription('[관리자] 특정 유저에게 지원금/현금을 지급합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('돈을 받 대상 유저')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('금액')
        .setDescription('지급할 금액')
        .setMinValue(1)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const targetUser = interaction.options.getUser('유저');
    const amount = interaction.options.getInteger('금액');

    const userData = await getOrCreateUser(targetUser.id, targetUser.username, targetUser.displayAvatarURL());
    const giveAmount = BigInt(amount);
    const beforeCash = BigInt(userData.cash || 0);
    const newCash = beforeCash + giveAmount;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), targetUser.id]);

    // 경제 로그 기록
    await pool.query(`
      INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
      VALUES (?, ?, 'ADMIN_GIVE', ?, ?, ?, ?)
    `, [targetUser.id, targetUser.username, giveAmount.toString(), beforeCash.toString(), newCash.toString(), `👑 [디스코드 관리자 지급] +${formatMoney(giveAmount)} (관리자: @${interaction.user.username})`]);

    try {
      const { logAdminAction } = require('../../utils/logger');
      await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_GIVE_MONEY', targetUser.id, { amount: giveAmount.toString(), targetName: targetUser.username });
    } catch (e) {}

    const embed = createAdminEmbed(
      '👑 관리자 자금 지급 완료',
      `**대상 유저:** <@${targetUser.id}> (@${targetUser.username})\n` +
      `**지급 금액:** **+${formatMoney(giveAmount)}**\n\n` +
      `💳 **지급 전 잔액:** ${formatMoney(beforeCash)}\n` +
      `💳 **지급 후 유저 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
