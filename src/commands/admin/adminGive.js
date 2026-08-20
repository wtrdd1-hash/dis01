const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { applyCashGiveLocked } = require('../../utils/money');
const { parseAdminMoney, MONEY_UNITS } = require('../../utils/moneyScale');

const unitChoices = MONEY_UNITS.map((u) => ({
  name: u.exp === 0 ? '원' : `${u.label} (10^${u.exp})`,
  value: u.label
}));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_give')
    .setDescription('[관리자] 특정 유저에게 지원금/현금을 지급합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('돈을 받을 대상 유저')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('금액')
        .setDescription('숫자 또는 5만, 1억, 500양')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('단위')
        .setDescription('금액이 숫자일 때 곱할 단위')
        .addChoices(...unitChoices)
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('국고에서_지급')
        .setDescription('True: 국고 잔액에서 차감 / False: 직권 즉시 발행 (기본값: False)')
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
    const isTreasury = interaction.options.getBoolean('국고에서_지급') === true;

    let giveAmount;
    try {
      giveAmount = parseAdminMoney(rawAmount, unit);
    } catch (e) {
      return interaction.reply({
        embeds: [createErrorEmbed('금액 오류', e.message || '금액이 너무 큽니다.')],
        flags: MessageFlags.Ephemeral
      });
    }
    if (!giveAmount || giveAmount <= 0n) {
      return interaction.reply({
        embeds: [createErrorEmbed('금액 오류', '1원 이상이어야 합니다. 예: 5만, 1억, 500양')],
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      await getOrCreateUser(targetUser.id, targetUser.username, targetUser.displayAvatarURL());
      const { before: beforeCash, after: newCash } = await applyCashGiveLocked(targetUser.id, giveAmount);

      let treasuryLeft = null;
      if (isTreasury) {
        const { takeTreasury } = require('../../utils/taxEngine');
        const res = await takeTreasury(giveAmount, true);
        treasuryLeft = res.treasury;

        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'TAX_REFUND', ?, ?, ?, ?)
        `, [targetUser.id, targetUser.username, giveAmount.toString(), beforeCash.toString(), newCash.toString(), `🏛️ [국고 지원금 지급] +${formatMoney(giveAmount)} (관리자: @${interaction.user.username}, 국고 잔액: ${formatMoney(treasuryLeft)})`]);
      } else {
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'ADMIN_GIVE', ?, ?, ?, ?)
        `, [targetUser.id, targetUser.username, giveAmount.toString(), beforeCash.toString(), newCash.toString(), `👑 [직권 관리자 지급] +${formatMoney(giveAmount)} (관리자: @${interaction.user.username})`]);
      }

      try {
        const { logAdminAction } = require('../../utils/logger');
        await logAdminAction(interaction.user.id, interaction.user.username, isTreasury ? 'DISCORD_GIVE_TREASURY' : 'DISCORD_GIVE_MONEY', targetUser.id, {
          amount: giveAmount.toString(),
          targetName: targetUser.username,
          source: isTreasury ? 'treasury' : 'direct',
          treasuryLeft: treasuryLeft ? treasuryLeft.toString() : undefined
        });
      } catch (e) {}

      const embed = createAdminEmbed(
        isTreasury ? '🏛️ 국고 지원금 지급 완료' : '👑 관리자 직권 자금 지급 완료',
        `**대상 유저:** <@${targetUser.id}> (@${targetUser.username})\n` +
        `**지급 방식:** ${isTreasury ? '🏛️ **국고 잔액 차감 지원**' : '⚡ **관리자 직권 즉시 발행**'}\n` +
        `**지급 금액:** **+${formatMoney(giveAmount)}**\n\n` +
        `💳 **지급 전 잔액:** ${formatMoney(beforeCash)}\n` +
        `💳 **지급 후 유저 현금:** **${formatMoney(newCash)}**` +
        (isTreasury ? `\n🏛️ **국고 잔액:** **${formatMoney(treasuryLeft)}**` : '')
      );

      await interaction.reply({ embeds: [embed] });
    } catch (e) {
      await interaction.reply({
        embeds: [createErrorEmbed('지급 실패', e.code === 'MONEY_OVERFLOW' ? e.message : '처리 중 오류가 발생했습니다.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
