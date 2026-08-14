const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createGambleEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

const SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '7️⃣', '💎'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('🎰 슬롯머신 도박을 진행합니다.')
    .addStringOption(option =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액 또는 "올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const betInput = interaction.options.getString('배팅금액').trim();
    const userId = interaction.user.id;

    const userData = await getOrCreateUser(userId);
    const userCash = BigInt(userData.cash);

    let betAmount = 0n;
    if (betInput === '올인' || betInput === '전체' || betInput === 'all') {
      betAmount = userCash;
    } else {
      const parsed = parseInt(betInput, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '배팅 금액은 1,000원 이상의 정수 또는 "올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      betAmount = BigInt(parsed);
    }

    if (betAmount < 1000n) {
      return interaction.reply({
        embeds: [createErrorEmbed('배팅 제한', '최소 배팅 금액은 1,000원입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (userCash < betAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `보유 현금(${formatMoney(userCash)})이 배팅금(${formatMoney(betAmount)})보다 부족합니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    // 슬롯 릴 돌리기
    const reel1 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const reel2 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
    const reel3 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];

    let multiplier = 0;
    let resultMsg = '';

    if (reel1 === '💎' && reel2 === '💎' && reel3 === '💎') {
      multiplier = 25;
      resultMsg = '💎💎💎 **초호화 다이아몬드 잭팟!! 25배 대박 당첨!** 💎💎💎';
    } else if (reel1 === '7️⃣' && reel2 === '7️⃣' && reel3 === '7️⃣') {
      multiplier = 15;
      resultMsg = '7️⃣7️⃣7️⃣ **럭키 세븐 잭팟! 15배 당첨!** 7️⃣7️⃣7️⃣';
    } else if (reel1 === '🔔' && reel2 === '🔔' && reel3 === '🔔') {
      multiplier = 8;
      resultMsg = '🔔🔔🔔 **골든벨 3개 일치! 8배 당첨!** 🔔';
    } else if (reel1 === '🍇' && reel2 === '🍇' && reel3 === '🍇') {
      multiplier = 4;
      resultMsg = '🍇🍇🍇 **포도 3개 일치! 4배 당첨!**';
    } else if (reel1 === '🍋' && reel2 === '🍋' && reel3 === '🍋') {
      multiplier = 2.5;
      resultMsg = '🍋🍋🍋 **레몬 3개 일치! 2.5배 획득!**';
    } else if (reel1 === '🍒' && reel2 === '🍒' && reel3 === '🍒') {
      multiplier = 2;
      resultMsg = '🍒🍒🍒 **체리 3개 일치! 2배 획득!**';
    } else if ([reel1, reel2, reel3].filter(r => r === '🍒').length >= 2) {
      multiplier = 1.2;
      resultMsg = '🍒🍒 **체리 2개 적중! 1.2배 획득!**';
    } else {
      multiplier = 0;
      resultMsg = '💀 **빗나갔습니다! 다음 스핀에 도전하세요.**';
    }

    const payout = betAmount * BigInt(multiplier);
    const profit = payout - betAmount;
    const newCash = userCash + profit;

    // 데이터베이스 업데이트 및 로그
    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "slot", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const embed = createGambleEmbed(
      '🎰 슬롯머신 결과',
      `╔═════════════╗\n` +
      `║  [ ${reel1} | ${reel2} | ${reel3} ]  ║\n` +
      `╚═════════════╝\n\n` +
      `${resultMsg}\n\n` +
      `💰 **배팅금:** ${formatMoney(betAmount)}\n` +
      `🎁 **획득금:** ${formatMoney(payout)}\n` +
      `💳 **현재 잔액:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
