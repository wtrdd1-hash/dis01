const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { logAdminAction } = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_reset')
    .setDescription('[관리자] 특정 유저의 모든 자산과 주식을 초기화합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('초기화할 유저')
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
    const initialCash = config.initialBalance || 10000;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [users] = await connection.query('SELECT * FROM users WHERE discord_id = ? FOR UPDATE', [targetUser.id]);
      const [stockSnap] = await connection.query(
        'SELECT stock_id, amount, total_spent FROM user_stocks WHERE user_id = ?',
        [targetUser.id]
      );
      const before = users[0] || {};
      const snapshot = {
        targetName: targetUser.username,
        cash: String(before.cash ?? 0),
        bank: String(before.bank ?? 0),
        clicker_level: before.clicker_level ?? 1,
        auto_miner_level: before.auto_miner_level ?? 0,
        total_clicks: String(before.total_clicks ?? 0),
        daily_streak: before.daily_streak ?? 0,
        stocks: stockSnap || []
      };

      await connection.query(
        `UPDATE users
         SET cash = ?, bank = 0, clicker_level = 1, auto_miner_level = 0, total_clicks = 0,
             daily_streak = 0, last_daily = NULL, last_work = NULL, last_subsidy = NULL
         WHERE discord_id = ?`,
        [initialCash.toString(), targetUser.id]
      );
      await connection.query('DELETE FROM user_stocks WHERE user_id = ?', [targetUser.id]);

      await connection.commit();
      try { await require('../../utils/loanEngine').closeLoansOnReset(targetUser.id); } catch (e) {}
      await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_RESET_USER', targetUser.id, {
        targetName: targetUser.username,
        snapshot
      });
      try { require('../../utils/liveSync').pushUserLive(targetUser.id); } catch (e) {}
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const embed = createAdminEmbed(
      '관리자 유저 계정 초기화 완료',
      `**대상 유저:** <@${targetUser.id}>\n\n` +
      `• 초기 기본 현금: **${formatMoney(initialCash)}**으로 리셋되었습니다.\n` +
      `• 보유 예금, 클리커, 주식 포트폴리오가 모두 삭제되었습니다.\n` +
      `• 초기화 전 스냅샷은 관리자 감사 로그에 보관됩니다.`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
