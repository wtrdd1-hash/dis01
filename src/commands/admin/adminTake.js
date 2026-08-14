const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_take')
    .setDescription('[관리자] 특정 유저의 현금을 차압/몰수합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('돈을 차압할 대상 유저')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('금액')
        .setDescription('차압할 금액')
        .setMinValue(1)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (interaction.user.id !== config.adminId) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const targetUser = interaction.options.getUser('유저');
    const amount = interaction.options.getInteger('금액');

    const userData = await getOrCreateUser(targetUser.id);
    const takeAmount = BigInt(amount);
    const currentCash = BigInt(userData.cash);

    let newCash = currentCash - takeAmount;
    if (newCash < 0n) newCash = 0n;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), targetUser.id]);

    const embed = createAdminEmbed(
      '관리자 자금 몰수 완료',
      `**대상 유저:** <@${targetUser.id}>\n` +
      `**차압 금액:** **${formatMoney(takeAmount)}**\n\n` +
      `💳 **차압 후 유저 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
