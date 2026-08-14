const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

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

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query(
        'UPDATE users SET cash = ?, bank = 0, daily_streak = 0, last_daily = NULL, last_work = NULL WHERE discord_id = ?',
        [config.initialBalance.toString(), targetUser.id]
      );
      await connection.query('DELETE FROM user_stocks WHERE user_id = ?', [targetUser.id]);

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const embed = createAdminEmbed(
      '관리자 유저 계정 초기화 완료',
      `**대상 유저:** <@${targetUser.id}>\n\n` +
      `• 초기 기본 현금: **10,000,000원**으로 리셋되었습니다.\n` +
      `• 보유 예금 및 주식 포트폴리오가 모두 삭제되었습니다.`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
