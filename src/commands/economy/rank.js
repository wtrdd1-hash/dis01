const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../../config/database');
const { createEconomyEmbed } = require('../../utils/embedBuilder');
const { NET_WORTH_SQL } = require('../../utils/economyBalance');
const { formatMoney, safeBigInt } = require('../../utils/formatters');
const { cohortOf, whereCohort } = require('../../utils/economyCohort');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('순위')
    .setDescription('같은 그룹(일반 유저 / 관리자) 안의 종합 순자산 TOP 10을 확인합니다.'),

  async execute(interaction) {
    const cohort = cohortOf(interaction.user.id);
    const filter = whereCohort('u.discord_id', cohort);
    const groupLabel = cohort === 'admin' ? '관리자' : '일반 유저';

    const [rows] = await pool.query(`
      SELECT 
        u.discord_id, 
        u.cash, 
        u.bank,
        ${NET_WORTH_SQL} AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      WHERE ${filter.sql}
      GROUP BY u.discord_id, u.cash, u.bank
      ORDER BY net DESC
    `, filter.params);

    if (rows.length === 0) {
      const embed = createEconomyEmbed('🏆 종합 자산가 순위표', `${groupLabel} 그룹에 등록된 계정이 없습니다.`);
      return interaction.reply({ embeds: [embed] });
    }

    const top10 = rows.slice(0, 10);
    const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let description = '';

    for (let i = 0; i < top10.length; i++) {
      const row = top10[i];
      const emoji = rankEmojis[i] || '🔹';
      const net = safeBigInt(row.net);
      description += `${emoji} <@${row.discord_id}> - **${formatMoney(net)}**\n`;
    }

    const myRankIndex = rows.findIndex(r => r.discord_id === interaction.user.id);
    if (myRankIndex !== -1) {
      const myNet = safeBigInt(rows[myRankIndex].net);
      description += `\n─────────────────────\n👤 **내 순위:** **${myRankIndex + 1}위** / ${rows.length}명 (${formatMoney(myNet)})`;
    }

    const embed = createEconomyEmbed(
      `🏆 ${groupLabel} TOP 10 종합 자산가 (현금+예금+주식)`,
      description
    );

    await interaction.reply({ embeds: [embed] });
  }
};
