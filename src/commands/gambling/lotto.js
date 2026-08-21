'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getCurrentLottoRound, buyLottoTicket, getUserLottoTickets } = require('../../utils/lottoEngine');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('로또')
    .setDescription('주간 메가 로또 6/45 복권을 구매하거나 누적 잭팟 상금을 조회합니다.')
    .addSubcommand(sub =>
      sub
        .setName('자동구매')
        .setDescription('랜덤 자동 번호로 로또 1장을 구매합니다 (1,000원).')
    )
    .addSubcommand(sub =>
      sub
        .setName('수동구매')
        .setDescription('1~45 중 원하는 번호 6개를 직접 입력하여 구매합니다 (1,000원).')
        .addStringOption(opt =>
          opt.setName('번호')
            .setDescription('1부터 45 사이의 6개 번호 (예: 7, 14, 21, 28, 35, 42)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('조회')
        .setDescription('현재 회차 누적 상금 및 내가 구매한 로또 티켓 목록을 조회합니다.')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL());

    if (subcommand === '자동구매') {
      try {
        const result = await buyLottoTicket(userId, username, null, true);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle(`🎟️ [제 ${result.roundNumber}회 메가 로또 6/45] 자동 발권 완료!`)
          .setDescription(`**@${username}** 님, 자동 번호 생성이 완료되었습니다.`)
          .addFields(
            { name: '🎲 발권 번호', value: `\`[ ${result.numberStr} ]\``, inline: false },
            { name: '티켓 가격', value: '1,000원', inline: true },
            { name: '잔여 현금', value: formatMoney(result.afterCash), inline: true },
            { name: '추첨 일시', value: '2일마다 저녁 9:00 (2일 주기 자동 추첨)', inline: false }
          )
          .setFooter({ text: '판매금의 30%는 국고로 소각되며, 70%는 잭팟 상금 풀에 누적됩니다.' })
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (subcommand === '수동구매') {
      const inputStr = interaction.options.getString('번호');
      try {
        const result = await buyLottoTicket(userId, username, inputStr, false);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle(`🎟️ [제 ${result.roundNumber}회 메가 로또 6/45] 수동 발권 완료!`)
          .setDescription(`**@${username}** 님, 수동 번호 발권이 완료되었습니다.`)
          .addFields(
            { name: '🎲 발권 번호', value: `\`[ ${result.numberStr} ]\``, inline: false },
            { name: '티켓 가격', value: '1,000원', inline: true },
            { name: '잔여 현금', value: formatMoney(result.afterCash), inline: true },
            { name: '추첨 일시', value: '2일마다 저녁 9:00 (2일 주기 자동 추첨)', inline: false }
          )
          .setFooter({ text: '판매금의 30%는 국고로 소각되며, 70%는 잭팟 상금 풀에 누적됩니다.' })
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (subcommand === '조회') {
      const round = await getCurrentLottoRound();
      const tickets = await getUserLottoTickets(userId, round.round_number);

      const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle(`🎰 [제 ${round.round_number}회 메가 로또 6/45] 현황`)
        .addFields(
          { name: '💰 현재 총 잭팟 풀', value: `**${formatMoney(round.jackpot_pool)}**`, inline: true },
          { name: '🔥 현재까지 소각액', value: `**${formatMoney(round.total_burned)}**`, inline: true },
          { name: '🎟️ 총 판매 티켓', value: `${(BigInt(round.total_sales) / 1000n).toLocaleString()}장`, inline: true }
        )
        .setTimestamp();

      if (tickets.length > 0) {
        const ticketList = tickets.map((t, idx) => `**#${idx + 1}** \`[ ${t.numbers} ]\` (${t.is_auto ? '자동' : '수동'})`).join('\n');
        embed.addFields({ name: `📋 내가 보유한 로또 티켓 (${tickets.length}장)`, value: ticketList, inline: false });
      } else {
        embed.addFields({ name: '📋 내가 보유한 로또 티켓', value: '이번 회차에 구매한 로또가 없습니다. `/로또 자동구매`로 도전해보세요!', inline: false });
      }

      return interaction.reply({ embeds: [embed] });
    }
  }
};
