const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createEconomyEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('순위')
    .setDescription('서버 내 일반 유저 종합 순자산 TOP 10 부자 순위표를 확인합니다.'),

  async execute(interaction) {
    const adminIds = config.adminIds && config.adminIds.length > 0 ? config.adminIds : ['0'];

    const [rows] = await pool.query(`
      SELECT 
        u.discord_id, 
        (u.cash + u.bank + COALESCE(SUM(us.amount * s.price), 0)) AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      WHERE u.discord_id NOT IN (?)
      GROUP BY u.discord_id, u.cash, u.bank
      ORDER BY net DESC
    `, [adminIds]);

    if (rows.length === 0) {
      const embed = createEconomyEmbed('🏆 종합 자산가 순위표', '등록된 유저가 없습니다.');
      return interaction.reply({ embeds: [embed] });
    }

    const top10 = rows.slice(0, 10);
    const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let description = '';

    for (let i = 0; i < top10.length; i++) {
      const row = top10[i];
      const emoji = rankEmojis[i] || '🔹';
      const net = BigInt(row.net || 0);
      description += `${emoji} <@${row.discord_id}> - **${formatMoney(net)}**\n`;
    }

    const myRankIndex = rows.findIndex(r => r.discord_id === interaction.user.id);
    if (myRankIndex !== -1) {
      const myNet = BigInt(rows[myRankIndex].net || 0);
      description += `\n─────────────────────\n👤 **내 순위:** **${myRankIndex + 1}위** / ${rows.length}명 (${formatMoney(myNet)})`;
    }

    const embed = createEconomyEmbed(
      '🏆 TOP 10 종합 자산가 순위표 (현금+예금+주식)',
      description
    );

    await interaction.reply({ embeds: [embed] });
  }
};
