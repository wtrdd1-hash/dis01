const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, computePayout, applyCashDelta, parseCasinoGambleBet, casinoTooSmallMessage } = require('../../utils/money');
const { rollHighLow, scaleGambleMultiplier } = require('../../utils/economyBalance');
const { highlowFlavor, runStagedEmbed, showEmbed, moneyTail, COLORS } = require('../../utils/gameShow');

function meterBar(roll) {
  const n = Math.max(0, Math.min(100, Number(roll) || 0));
  const filled = Math.round(n / 10);
  return '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '` ' + n;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('도박')
    .setDescription('🎲 주사위 롤(1~100) 확률 도박을 진행합니다.')
    .addStringOption((option) =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액, 한글 단위(예: 5만), 또는 "전액"/"올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
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

    const rolled = rollHighLow();
    const roll = rolled.roll;
    const multiplier = scaleGambleMultiplier(rolled.multiplier);
    let resultTitle = '';

    if (roll >= 90) {
      resultTitle = `🔥 주사위 \`${roll}\` | **대박 3.5배 잭팟 당첨!!** 🎯`;
    } else if (roll >= 60) {
      resultTitle = `✨ 주사위 \`${roll}\` | **승리! 1.8배 획득!** 🎲`;
    } else {
      resultTitle = `💀 주사위 \`${roll}\` | **패배... 60 미만입니다.**`;
    }

    const payout = computePayout(betAmount, multiplier);
    const profit = payout - betAmount;
    const newCash = await applyCashDelta(userId, profit);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "dice", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const flavor = highlowFlavor(roll, rolled.multiplier, rolled.isWin);
    const money = moneyTail(betAmount, payout, newCash);
    const mid = Math.max(1, Math.floor(roll * 0.45));

    await runStagedEmbed(interaction, [
      { embed: showEmbed('🎲 하이로우', `기준: 60 이상 1.8배 / 90 이상 3.5배\n${meterBar(0)}\n주사위를 굴립니다...`, COLORS.GAMBLE) },
      { delay: 700, embed: showEmbed('🎲 바늘 상승', `${meterBar(mid)}\n아직 올라가는 중...`, COLORS.WARNING) },
      {
        delay: 800,
        embed: showEmbed(
          rolled.isWin ? '🎲 적중' : '🎲 결과',
          `${meterBar(roll)}\n\n${resultTitle}\n_${flavor}_${money}`,
          rolled.isWin ? COLORS.SUCCESS : COLORS.ERROR
        )
      }
    ]);
  }
};
