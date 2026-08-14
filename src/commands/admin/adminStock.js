const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { updateStockPrices } = require('../../utils/stockEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_stock')
    .setDescription('[관리자] 특정 종목의 가격을 수동으로 변경하거나 주가 변동 이벤트를 실행합니다.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('가격구현')
        .setDescription('특정 주식의 시세를 수동 설정합니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('종목 ID (예: NVDA, BTC)')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName('설정가격')
            .setDescription('새로 설정할 가격 (원)')
            .setMinValue(10)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('강제변동')
        .setDescription('전체 주식 시장의 시세를 강제로 1회 갱신합니다.')
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === '강제변동') {
      await updateStockPrices();
      const embed = createAdminEmbed(
        '관리자 주가 강제 갱신 완료',
        '전체 주식 시장의 종목 시세가 강제로 1회 갱신되었습니다!'
      );
      return interaction.reply({ embeds: [embed] });
    } else if (subcommand === '가격구현') {
      const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
      const newPriceInt = interaction.options.getInteger('설정가격');

      const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockIdInput]);
      if (stocks.length === 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('종목 없음', `\`${stockIdInput}\` 종목을 찾을 수 없습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }

      const stock = stocks[0];
      const newPrice = BigInt(newPriceInt);

      await pool.query(
        'UPDATE stocks SET prev_price = price, price = ?, updated_at = NOW() WHERE stock_id = ?',
        [newPrice.toString(), stockIdInput]
      );

      await pool.query(
        'INSERT INTO stock_history (stock_id, price) VALUES (?, ?)',
        [stockIdInput, newPrice.toString()]
      );

      const embed = createAdminEmbed(
        '관리자 주가 조절 완료',
        `**종목:** ${stock.name} (\`${stockIdInput}\`)\n` +
        `**기존 가격:** ${formatMoney(stock.price)}\n` +
        `**변경된 신규 가격:** **${formatMoney(newPrice)}**`
      );

      return interaction.reply({ embeds: [embed] });
    }
  }
};
