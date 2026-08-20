const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { formatMoney } = require('../../utils/formatters');
const { createErrorEmbed, createGambleEmbed } = require('../../utils/embedBuilder');
const { publicState, placeCrashBet } = require('../../utils/crashEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('크래시')
    .setDescription('공유 크래시. 목표 배율에 자동 탈출합니다.')
    .addStringOption((o) => o.setName('금액').setDescription('배팅 금액 또는 올인').setRequired(true))
    .addNumberOption((o) => o.setName('목표배율').setDescription('이 배율에서 자동 탈출 (예: 1.5)').setMinValue(1.01).setMaxValue(100)),

  async execute(interaction) {
    const amount = interaction.options.getString('금액');
    const autoAt = interaction.options.getNumber('목표배율') || 1.5;
    const snap = publicState();
    if (snap.phase !== 'betting') {
      return interaction.reply({
        embeds: [createErrorEmbed('크래시', `지금은 ${snap.phase} 구간입니다. 다음 배팅 시간을 기다리세요. 현재 ${snap.multiplier}x`)],
        flags: MessageFlags.Ephemeral
      });
    }
    try {
      const data = await placeCrashBet(
        { id: interaction.user.id, username: interaction.user.globalName || interaction.user.username },
        amount,
        autoAt
      );
      return interaction.reply({
        embeds: [createGambleEmbed('크래시 배팅', `${autoAt}배에서 자동 탈출합니다.\n배팅 ${formatMoney(data.bet)}\n잔액 ${formatMoney(data.newCash)}`)],
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      return interaction.reply({
        embeds: [createErrorEmbed('크래시', err.message || '배팅에 실패했습니다.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
