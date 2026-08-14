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

    const userData = await getOrCreateUser(targetUser.id);
    const giveAmount = BigInt(amount);
    const newCash = BigInt(userData.cash) + giveAmount;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), targetUser.id]);

    const embed = createAdminEmbed(
      '관리자 자금 지급 완료',
      `**대상 유저:** <@${targetUser.id}>\n` +
      `**지급 금액:** **${formatMoney(giveAmount)}**\n\n` +
      `💳 **지급 후 유저 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
