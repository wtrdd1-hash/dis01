const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const { createStockEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { generateAsciiChart } = require('../../utils/stockEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('주식차트')
    .setDescription('특정 종목의 가격 변동 추이 차트를 확인합니다.')
    .addStringOption(option =>
      option.setName('종목코드')
        .setDescription('종목 ID (예: NVDA, SAM, AAPL, BTC, ETH, BIO)')
        .setRequired(true)
    ),

  async execute(interaction) {
    const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();

    const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockIdInput]);
    if (stocks.length === 0) {
      return interaction.reply({
        embeds: [createErrorEmbed('종목 없음', `\`${stockIdInput}\` 종목을 찾을 수 없습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const stock = stocks[0];

    const [historyRows] = await pool.query(`
      SELECT price
      FROM stock_history
      WHERE stock_id = ?
      ORDER BY id ASC
      LIMIT 30
    `, [stockIdInput]);

    const priceList = historyRows.map(r => r.price);
    const chartAscii = generateAsciiChart(priceList);

    const embed = createStockEmbed(
      `📉 ${stock.name} (\`${stock.stock_id}\`) 가격 변동 차트`,
      `**현재가:** **${formatMoney(stock.price)}** (이전가: ${formatMoney(stock.prev_price)})\n\n` +
      `**최근 주가 추이 그래프**\n` +
      chartAscii
    );

    await interaction.reply({ embeds: [embed] });
  }
};
