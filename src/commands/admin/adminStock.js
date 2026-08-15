const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { updateStockPrices, adjustStockPrice, adjustAllStocksRatio } = require('../../utils/stockEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_stock')
    .setDescription('[관리자] 주식 가격을 수동 조절하거나 비율(%) 일괄 변동 이벤트를 실행합니다.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('가격구현')
        .setDescription('특정 주식의 시세를 수동 설정합니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('종목 ID (예: WTRD, MINE, CASN, BANK, NEKO, SCRP, CHKN, SLOT)')
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
        .setName('비율조절')
        .setDescription('전 종목의 가격을 지정 비율(%)만큼 일괄 조절합니다. (예: 10 = +10%, -15 = -15%)')
        .addIntegerOption(option =>
          option.setName('변동비율')
            .setDescription('변동할 비율 (%) (예: 10, 20, -10, -20)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('강제변동')
        .setDescription('유저 상황 및 시황을 반영하여 전체 주식 시장 시세를 강제로 1회 갱신합니다.')
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
        '📈 관리자 주가 강제 갱신 완료',
        '유저 실거래량 및 유동성 상황이 반영되어 전체 주식 시장의 종목 시세가 갱신되었습니다!'
      );
      return interaction.reply({ embeds: [embed] });
    } else if (subcommand === '비율조절') {
      const pct = interaction.options.getInteger('변동비율');
      const results = await adjustAllStocksRatio(pct, `관리자(@${interaction.user.username}) 디스코드 명령어 조절`);
      const summaryList = results.map(r => `• **${r.name}** (\`${r.stockId}\`): ${formatMoney(r.oldPrice)} ➔ **${formatMoney(r.newPrice)}** (${r.rate > 0 ? '+' : ''}${r.rate}%)`).join('\n');

      const embed = createAdminEmbed(
        `📊 전 종목 ${pct > 0 ? '+' : ''}${pct}% 일괄 가격 조절 완료`,
        `**조절 사유:** 관리자 수동 시장 개입\n\n${summaryList}`
      );
      return interaction.reply({ embeds: [embed] });
    } else if (subcommand === '가격구현') {
      const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
      const newPriceInt = interaction.options.getInteger('설정가격');

      try {
        const result = await adjustStockPrice(stockIdInput, newPriceInt, `관리자(@${interaction.user.username}) 디스코드 명령어 지정가 조절`);
        const embed = createAdminEmbed(
          '관리자 주가 조절 완료',
          `**종목:** ${result.name} (\`${result.stockId}\`)\n` +
          `**기존 가격:** ${formatMoney(result.oldPrice)}\n` +
          `**변경된 신규 가격:** **${formatMoney(result.newPrice)}** (${result.rate > 0 ? '+' : ''}${result.rate}%)`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('주가 조절 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};
