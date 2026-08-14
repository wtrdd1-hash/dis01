const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../../config/database');
const { createStockEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatPercent } = require('../../utils/formatters');
const { getLastNews, getCurrentMarketRegime } = require('../../utils/stockEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('주식시세')
    .setDescription('실시간 주식 시장 시세 및 거시 경제 국면 정보를 확인합니다.'),

  async execute(interaction) {
    const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY price DESC');

    const regime = getCurrentMarketRegime();
    const news = getLastNews();

    let headerStr = `🌐 **거시 경제 국면:** **${regime ? regime.name : '정상'}**\n_${regime ? regime.desc : ''}_\n\n`;

    if (news) {
      headerStr += `📰 **시장 주요 속보:** ${news.text}\n\n`;
    }

    let description = headerStr + '📊 **실시간 종목 시세 목록** (2분마다 변동)\n\n';

    for (const s of stocks) {
      const price = BigInt(s.price);
      const prevPrice = BigInt(s.prev_price);
      const diff = price - prevPrice;
      const rate = prevPrice > 0n ? (Number(diff) / Number(prevPrice)) * 100 : 0;

      description += `**\`[${s.stock_id}]\` ${s.name}**\n` +
        `• 현재가: **${formatMoney(price)}** | 변동률: **${formatPercent(rate)}**\n` +
        `----------------------------------------\n`;
    }

    const embed = createStockEmbed(
      '📈 디스코드 실시간 주식 시장 시세표',
      description
    );

    await interaction.reply({ embeds: [embed] });
  }
};
