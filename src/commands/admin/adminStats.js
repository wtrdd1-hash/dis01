const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatNumber } = require('../../utils/formatters');
const { whereNotAdmin, whereIsAdmin } = require('../../utils/economyCohort');
const { getTaxOverview } = require('../../utils/taxEngine');

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

    const userFilter = whereNotAdmin('discord_id');
    const adminFilter = whereIsAdmin('discord_id');
    const userStockFilter = whereNotAdmin('us.user_id');
    const adminStockFilter = whereIsAdmin('us.user_id');

    const [[userStats]] = await pool.query(`
      SELECT
        COUNT(*) as total_users,
        COALESCE(SUM(cash), 0) as total_cash,
        COALESCE(SUM(bank), 0) as total_bank
      FROM users
      WHERE ${userFilter.sql}
    `, userFilter.params);

    const [[adminStats]] = await pool.query(`
      SELECT
        COUNT(*) as total_users,
        COALESCE(SUM(cash), 0) as total_cash,
        COALESCE(SUM(bank), 0) as total_bank
      FROM users
      WHERE ${adminFilter.sql}
    `, adminFilter.params);

    const [[userStockStats]] = await pool.query(`
      SELECT COALESCE(SUM(us.amount * s.price), 0) as total_stock_val
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE ${userStockFilter.sql}
    `, userStockFilter.params);

    const [[adminStockStats]] = await pool.query(`
      SELECT COALESCE(SUM(us.amount * s.price), 0) as total_stock_val
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE ${adminStockFilter.sql}
    `, adminStockFilter.params);

    function pack(stat, stockRow) {
      const cash = BigInt(stat.total_cash || 0);
      const bank = BigInt(stat.total_bank || 0);
      const stock = BigInt(stockRow.total_stock_val || 0);
      return {
        count: Number(stat.total_users || 0),
        cash,
        bank,
        stock,
        net: cash + bank + stock
      };
    }

    const users = pack(userStats, userStockStats);
    const admins = pack(adminStats, adminStockStats);
    const tax = await getTaxOverview();

    const adminListDisplay = config.adminIds.map(id => `\`${id}\``).join(', ');

    const embed = createAdminEmbed(
      '📊 봇 서버 & 경제 시스템 상태 통계',
      `**관리자 ID 목록:** ${adminListDisplay}\n` +
      `**DB:** 로컬 MySQL\n\n` +
      `👤 **일반 유저** (${formatNumber(users.count)}명)\n` +
      `├ 시중 유통 현금: ${formatMoney(users.cash)}\n` +
      `├ 은행 총 예치금: ${formatMoney(users.bank)}\n` +
      `├ 주식 시가총액: ${formatMoney(users.stock)}\n` +
      `└ 유저 통화량: **${formatMoney(users.net)}**\n\n` +
      `👑 **관리자 계정** (${formatNumber(admins.count)}명, 유저 경제와 별도)\n` +
      `├ 현금: ${formatMoney(admins.cash)}\n` +
      `├ 예금: ${formatMoney(admins.bank)}\n` +
      `├ 주식: ${formatMoney(admins.stock)}\n` +
      `└ 관리자 자산: **${formatMoney(admins.net)}**\n\n` +
      `🏛️ **세금** (일반 유저만, 관리자 면제)\n` +
      `├ 거래세율: **${(tax.rate * 100).toFixed(1)}%**\n` +
      `├ 자산세 기준(현금+예금): ${formatMoney(tax.threshold)}\n` +
      `├ 최근 24시간 징수: ${formatMoney(tax.last24h)}\n` +
      `└ 국고(시중 흡수): **${formatMoney(tax.treasury)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
