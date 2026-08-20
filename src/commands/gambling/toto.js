const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { formatMoney } = require('../../utils/formatters');
const { createErrorEmbed, createGambleEmbed } = require('../../utils/embedBuilder');
const { listOpenMatches, placeTotoBet } = require('../../utils/totoEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('토토')
    .setDescription('가상 경기 승부예측')
    .addSubcommand((sub) => sub.setName('목록').setDescription('진행 중인 경기를 봅니다'))
    .addSubcommand((sub) =>
      sub.setName('배팅')
        .setDescription('경기에 배팅합니다')
        .addIntegerOption((o) => o.setName('경기').setDescription('경기 번호').setRequired(true))
        .addStringOption((o) =>
          o.setName('선택').setDescription('home / draw / away').setRequired(true)
            .addChoices(
              { name: '홈', value: 'home' },
              { name: '무', value: 'draw' },
              { name: '원정', value: 'away' }
            )
        )
        .addStringOption((o) => o.setName('금액').setDescription('배팅 금액 또는 올인').setRequired(true))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === '목록') {
      const matches = await listOpenMatches();
      const open = matches.filter((m) => m.status === 'open').slice(0, 6);
      if (!open.length) {
        return interaction.reply({ embeds: [createErrorEmbed('토토', '열린 경기가 없습니다. 잠시 후 다시 확인하세요.')], flags: MessageFlags.Ephemeral });
      }
      const lines = open.map((m) =>
        `#${m.id} [${m.sport}] ${m.home} vs ${m.away}\n홈 ${m.oddsHome} / 무 ${m.oddsDraw} / 원정 ${m.oddsAway}`
      ).join('\n\n');
      return interaction.reply({
        embeds: [createGambleEmbed('가상 토토', lines)],
        flags: MessageFlags.Ephemeral
      });
    }

    const matchId = interaction.options.getInteger('경기');
    const pick = interaction.options.getString('선택');
    const amount = interaction.options.getString('금액');
    try {
      const data = await placeTotoBet(
        { id: interaction.user.id, username: interaction.user.globalName || interaction.user.username },
        matchId,
        pick,
        amount
      );
      return interaction.reply({
        embeds: [createGambleEmbed('토토 배팅', `${data.message}\n배팅 ${formatMoney(data.bet)}\n잔액 ${formatMoney(data.newCash)}`)],
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      return interaction.reply({
        embeds: [createErrorEmbed('토토', err.message || '배팅에 실패했습니다.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
