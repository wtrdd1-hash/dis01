const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, computePayout, applyCashDelta, parseCasinoGambleBet, casinoTooSmallMessage } = require('../../utils/money');
const { flipCoin, COIN_WIN_MULT, scaleGambleMultiplier } = require('../../utils/economyBalance');
const { coinFlavor, runStagedEmbed, showEmbed, moneyTail, COLORS } = require('../../utils/gameShow');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('동전')
    .setDescription('🪙 동전 앞/뒷면 맞추기 도박을 진행합니다.')
    .addStringOption((option) =>
      option.setName('선택')
        .setDescription('앞면 또는 뒷면')
        .setRequired(true)
        .addChoices(
          { name: '앞면 🪙', value: '앞면' },
          { name: '뒷면 🪙', value: '뒷면' }
        )
    )
    .addStringOption((option) =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액, 한글 단위(예: 5만), 또는 "전액"/"올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const choice = interaction.options.getString('선택');
    const betInput = interaction.options.getString('배팅금액').trim();
    const userId = interaction.user.id;

    const userData = await getOrCreateUser(userId);
    const userCash = safeBigInt(userData.cash);

    const betAmount = parseCasinoGambleBet(betInput, userCash);
    if (betAmount === null) {
      return interaction.reply({
        embeds: [createErrorEmbed('입력 오류', '배팅 금액은 1,000원 이상의 정수, 한글 단위(예: 5만), 또는 "전액"/"올인"이어야 합니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const tooSmall = casinoTooSmallMessage(betInput, userCash, betAmount);
    if (tooSmall) {
      return interaction.reply({
        embeds: [createErrorEmbed('배팅 제한', tooSmall)],
        flags: MessageFlags.Ephemeral
      });
    }

    if (userCash < betAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `보유 현금(${formatMoney(userCash)})이 배팅금(${formatMoney(betAmount)})보다 부족합니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const coinSide = flipCoin().result;
    const isWin = choice === coinSide;
    const multiplier = isWin ? scaleGambleMultiplier(COIN_WIN_MULT) : 0;
    const payout = computePayout(betAmount, multiplier);
    const profit = payout - betAmount;
    const newCash = await applyCashDelta(userId, profit);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "coinflip", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const flavor = coinFlavor(choice, coinSide, isWin);
    const face = coinSide === '앞면' ? '🦅 앞면' : '👑 뒷면';
    const money = moneyTail(betAmount, payout, newCash);

    await runStagedEmbed(interaction, [
      { embed: showEmbed('🪙 동전 던지기', `선택을 걸었습니다: **${choice}**\n동전을 공중으로 던집니다...`, COLORS.GAMBLE) },
      { delay: 700, embed: showEmbed('🪙 회전 중', '마지막 한 바퀴...', COLORS.WARNING) },
      {
        delay: 800,
        embed: showEmbed(
          isWin ? '🪙 적중' : '🪙 반대면',
          `**결과:** ${face} | **선택:** ${choice}\n\n${isWin ? `🎉 **승리! ${COIN_WIN_MULT}배**` : '💀 **패배**'}\n_${flavor}_${money}`,
          isWin ? COLORS.SUCCESS : COLORS.ERROR
        )
      }
    ]);
  }
};
