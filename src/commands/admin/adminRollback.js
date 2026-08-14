const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { logAdminAction } = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_rollback')
    .setDescription('[관리자] 특정 유저의 최근 도박 이력을 조회하고 이전 잔고로 롤백 복구합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('도박 이력을 복구할 유저')
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
    const connection = await pool.getConnection();

    try {
      const [logs] = await connection.query(`
        SELECT * FROM gambling_logs 
        WHERE user_id = ? AND is_rolled_back = 0 
        ORDER BY id DESC LIMIT 1
      `, [targetUser.id]);

      if (logs.length === 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('복구 불가', `<@${targetUser.id}> 유저의 롤백 가능한 최근 도박 기록이 없습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }

      const log = logs[0];
      const balanceBefore = BigInt(log.balance_before);
      const profit = BigInt(log.profit);

      await connection.beginTransaction();

      // 유저의 잔고를 도박 이전 잔고로 원상 복구
      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [balanceBefore.toString(), targetUser.id]);

      // 롤백 완료 처리
      await connection.query('UPDATE gambling_logs SET is_rolled_back = 1, rolled_back_at = NOW() WHERE id = ?', [log.id]);

      await connection.commit();

      // 관리자 감사 로그 기록
      await logAdminAction(interaction.user.id, interaction.user.tag, 'ROLLBACK_GAMBLE', targetUser.id, {
        logId: log.id,
        game: log.game,
        profit: profit.toString(),
        restoredBalance: balanceBefore.toString()
      });

      const embed = createAdminEmbed(
        '🔄 관리자 자산 롤백 복구 완료',
        `**대상 유저:** <@${targetUser.id}>\n\n` +
        `• **복구된 도박 건:** \`#${log.id}\` (${log.game})\n` +
        `• **변동되었던 손익:** ${profit >= 0n ? '+' : ''}${formatMoney(profit)}\n` +
        `• **도박 이전 잔고로 복구:** **${formatMoney(balanceBefore)}**\n` +
        `• **복구 상태:** 정상 복구 완료 (DB 영구 갱신)`
      );

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await connection.rollback().catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }
};
