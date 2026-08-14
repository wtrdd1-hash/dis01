const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createGambleEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('동전')
    .setDescription('🪙 동전 앞/뒷면 맞추기 도박을 진행합니다.')
    .addStringOption(option =>
      option.setName('선택')
        .setDescription('앞면 또는 뒷면')
        .setRequired(true)
        .addChoices(
          { name: '앞면 🪙', value: '앞면' },
          { name: '뒷면 🪙', value: '뒷면' }
        )
    )
    .addStringOption(option =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액 또는 "올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const choice = interaction.options.getString('선택');
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

    const coinSide = Math.random() < 0.5 ? '앞면' : '뒷면';
    const isWin = choice === coinSide;

    // 1.95배 당첨금
    const payout = isWin ? BigInt(Math.floor(Number(betAmount) * 1.95)) : 0n;
    const profit = payout - betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "coinflip", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const embed = createGambleEmbed(
      '🪙 동전 던지기 결과',
      `**동전 결과:** \`${coinSide}\` | **내 선택:** \`${choice}\`\n\n` +
      `${isWin ? '🎉 **승리! 1.95배 당첨금을 받았습니다!**' : '💀 **패배... 예상과 다른 면이 나왔습니다.**'}\n\n` +
      `💰 **배팅금:** ${formatMoney(betAmount)}\n` +
      `🎁 **획득금:** ${formatMoney(payout)}\n` +
      `💳 **현재 잔액:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
