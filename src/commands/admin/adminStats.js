const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatNumber } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_stats')
    .setDescription('[관리자] 경제 시스템 통계 및 데이터베이스 상태를 확인합니다.'),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const [userStats] = await pool.query(`
      SELECT
        COUNT(*) as total_users,
        SUM(cash) as total_cash,
        SUM(bank) as total_bank
      FROM users
    `);

    const [stockStats] = await pool.query(`
      SELECT SUM(us.amount * s.price) as total_stock_val
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
    `);

    const stat = userStats[0];
    const totalUsers = stat.total_users || 0;
    const totalCash = BigInt(stat.total_cash || 0);
    const totalBank = BigInt(stat.total_bank || 0);
    const totalStockVal = BigInt(stockStats[0].total_stock_val || 0);
    const grandNetWorth = totalCash + totalBank + totalStockVal;

    const adminListDisplay = config.adminIds.map(id => `\`${id}\``).join(', ');

    const embed = createAdminEmbed(
      '📊 봇 서버 & 경제 시스템 상태 통계',
      `**관리자 ID 목록:** ${adminListDisplay}\n` +
      `**DB 접속 주소:** \`${config.db.host}:${config.db.port}\` (WSL MySQL)\n\n` +
      `👤 **총 가입 유저 수:** **${formatNumber(totalUsers)}명**\n` +
      `💵 **시중 유통 현금:** ${formatMoney(totalCash)}\n` +
      `🏦 **은행 총 예치금:** ${formatMoney(totalBank)}\n` +
      `📊 **유저 주식 시가총액:** ${formatMoney(totalStockVal)}\n` +
      `💎 **전체 서버 총 통화량:** **${formatMoney(grandNetWorth)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
