const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { applyCashTakeClamped, isAllInAmount } = require('../../utils/money');
const { parseAdminMoney, MONEY_UNITS } = require('../../utils/moneyScale');
const { logAdminAction } = require('../../utils/logger');

const unitChoices = MONEY_UNITS.map((u) => ({
  name: u.exp === 0 ? '원' : `${u.label} (10^${u.exp})`,
  value: u.label
}));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_take')
    .setDescription('[관리자] 특정 유저의 현금을 차압/몰수합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('돈을 차압할 대상 유저')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('금액')
        .setDescription('숫자, 5만, 500양, 전액')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('단위')
        .setDescription('금액이 숫자일 때 곱할 단위')
        .addChoices(...unitChoices)
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const targetUser = interaction.options.getUser('유저');
    const rawAmount = interaction.options.getString('금액');
    const unit = interaction.options.getString('단위') || '원';

    let takeAmount;
    try {
      takeAmount = isAllInAmount(rawAmount) ? 'ALL' : parseAdminMoney(rawAmount, unit);
    } catch (e) {
      return interaction.reply({
        embeds: [createErrorEmbed('금액 오류', e.message || '금액이 너무 큽니다.')],
        flags: MessageFlags.Ephemeral
      });
    }
    if (takeAmount !== 'ALL' && (!takeAmount || takeAmount <= 0n)) {
      return interaction.reply({
        embeds: [createErrorEmbed('금액 오류', '1원 이상이어야 합니다. 예: 5만, 전액')],
        flags: MessageFlags.Ephemeral
      });
    }

    await getOrCreateUser(targetUser.id, targetUser.username, targetUser.displayAvatarURL());
    const result = await applyCashTakeClamped(targetUser.id, takeAmount);
    const targetName = targetUser.username || `유저_${String(targetUser.id).slice(-4)}`;
    const requestedText = takeAmount === 'ALL' ? '전액' : formatMoney(takeAmount);

    await pool.query(`
      INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
      VALUES (?, ?, 'ADMIN_TAKE', ?, ?, ?, ?)
    `, [
      targetUser.id,
      targetName,
      result.actual.toString(),
      result.before.toString(),
      result.after.toString(),
      `👑 [디스코드 관리자 회수] -${formatMoney(result.actual)} (요청 ${requestedText}, 관리자: @${interaction.user.username})`
    ]);

    try {
      await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAKE_MONEY', targetUser.id, {
        requested: takeAmount === 'ALL' ? 'ALL' : takeAmount.toString(),
        actual: result.actual.toString(),
        targetName,
        beforeCash: result.before.toString(),
        afterCash: result.after.toString()
      });
    } catch (e) {}

    const negativeNote = result.after < 0n
      ? `\n⚠️ **마이너스 채무 잔고로 전환되었습니다.**`
      : '';

    const embed = createAdminEmbed(
      '👑 관리자 자금 몰수/차감 완료',
      `**대상 유저:** <@${targetUser.id}> (@${targetName})\n` +
      `**차감 금액:** **-${formatMoney(result.actual)}**${negativeNote}\n\n` +
      `💳 **차감 전 잔액:** ${formatMoney(result.before)}\n` +
      `💳 **차감 후 유저 현금:** **${formatMoney(result.after)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
