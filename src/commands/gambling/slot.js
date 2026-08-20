const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, computePayout, applyCashDelta, parseCasinoGambleBet, casinoTooSmallMessage } = require('../../utils/money');
const { spinSlot, scaleGambleMultiplier } = require('../../utils/economyBalance');
const { slotFlavor, runStagedEmbed, showEmbed, reelFrame, moneyTail, COLORS } = require('../../utils/gameShow');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('🎰 슬롯머신 도박을 진행합니다.')
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

    const spun = spinSlot();
    const [reel1, reel2, reel3] = spun.reels;
    const multiplier = scaleGambleMultiplier(spun.multiplier);
    let resultMsg = '';

    if (spun.multiplier >= 50) {
      resultMsg = '7️⃣7️⃣7️⃣ **럭키 세븐 잭팟! 50배 당첨!** 7️⃣7️⃣7️⃣';
    } else if (spun.multiplier >= 20) {
      resultMsg = '💎💎💎 **초호화 다이아몬드 잭팟!! 20배 대박 당첨!** 💎💎💎';
    } else if (spun.multiplier >= 10) {
      resultMsg = `${reel1}${reel2}${reel3} **트리플 적중! ${spun.multiplier}배 당첨!**`;
    } else if (spun.multiplier > 0) {
      resultMsg = `${reel1}${reel2}${reel3} **페어 적중! ${spun.multiplier}배 획득!**`;
    } else {
      resultMsg = '💀 **빗나갔습니다! 다음 스핀에 도전하세요.**';
    }

    const payout = computePayout(betAmount, multiplier);
    const profit = payout - betAmount;
    const newCash = await applyCashDelta(userId, profit);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "slot", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const flavor = slotFlavor(spun.reels, spun.multiplier, spun.isWin);
    const money = moneyTail(betAmount, payout, newCash);
    const finalColor = spun.isWin ? COLORS.SUCCESS : COLORS.ERROR;

    await runStagedEmbed(interaction, [
      { embed: showEmbed('🎰 슬롯 회전', `${reelFrame(['❔', '❔', '❔'])}\n릴이 돌아가기 시작합니다...`, COLORS.GAMBLE) },
      { delay: 700, embed: showEmbed('🎰 1릴 정지', `${reelFrame([reel1, '❔', '❔'])}\n첫 칸이 멈췄습니다.`, COLORS.GAMBLE) },
      { delay: 700, embed: showEmbed('🎰 2릴 정지', `${reelFrame([reel1, reel2, '❔'])}\n마지막 릴이 돕니다...`, COLORS.WARNING) },
      {
        delay: 800,
        embed: showEmbed(
          spun.isWin ? '🎰 슬롯 적중' : '🎰 슬롯 결과',
          `${reelFrame([reel1, reel2, reel3])}\n\n${resultMsg}\n_${flavor}_${money}`,
          finalColor
        )
      }
    ]);
  }
};
