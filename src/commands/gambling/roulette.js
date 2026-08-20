const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, computePayout, applyCashDelta, parseCasinoGambleBet, casinoTooSmallMessage } = require('../../utils/money');
const { spinRoulette, scaleGambleMultiplier } = require('../../utils/economyBalance');
const { rouletteFlavor, runStagedEmbed, showEmbed, moneyTail, COLORS } = require('../../utils/gameShow');

const COLOR_LABEL = { RED: '🔴 레드', BLACK: '⚫ 블랙', GREEN: '🟢 그린' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('룰렛')
    .setDescription('🎡 카지노 룰렛 (레드/블랙/잭팟 그린) 도박을 진행합니다.')
    .addStringOption((option) =>
      option.setName('색상')
        .setDescription('배팅할 색상 선택')
        .setRequired(true)
        .addChoices(
          { name: '🔴 레드 (2배 / 47%)', value: 'RED' },
          { name: '⚫ 블랙 (2배 / 47%)', value: 'BLACK' },
          { name: '🟢 그린 잭팟 (15배 / 6%)', value: 'GREEN' }
        )
    )
    .addStringOption((option) =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액, 한글 단위(예: 5만), 또는 "전액"/"올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const colorChoice = interaction.options.getString('색상');
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

    const spun = spinRoulette();
    const outcomeColor = spun.color;
    const outcomeEmoji = spun.emoji;

    let multiplier = 0;
    if (colorChoice === outcomeColor) {
      multiplier = scaleGambleMultiplier(spun.winMult);
    }

    const payout = computePayout(betAmount, multiplier);
    const profit = payout - betAmount;
    const newCash = await applyCashDelta(userId, profit);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "roulette", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const isWin = multiplier > 0;
    const flavor = rouletteFlavor(colorChoice, outcomeColor, outcomeEmoji, isWin);
    const money = moneyTail(betAmount, payout, newCash);

    await runStagedEmbed(interaction, [
      { embed: showEmbed('🎡 룰렛 회전', `칩을 ${COLOR_LABEL[colorChoice] || colorChoice}에 올렸습니다.\n휠이 돌아가기 시작합니다...`, COLORS.GAMBLE) },
      { delay: 800, embed: showEmbed('🎡 구슬이 느려집니다', '마지막 칸을 스치며 속도를 줄입니다...', COLORS.WARNING) },
      {
        delay: 900,
        embed: showEmbed(
          isWin ? '🎡 적중' : '🎡 빗나감',
          `**정지:** ${outcomeEmoji} ${COLOR_LABEL[outcomeColor] || outcomeColor}\n**선택:** ${COLOR_LABEL[colorChoice] || colorChoice}\n\n${isWin ? `🎉 **${multiplier}배 당첨**` : '💀 **패배**'}\n_${flavor}_${money}`,
          isWin ? COLORS.SUCCESS : COLORS.ERROR
        )
      }
    ]);
  }
};
