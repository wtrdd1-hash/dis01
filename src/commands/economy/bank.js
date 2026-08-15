const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, parseMoneyInput } = require('../../utils/formatters');
const { getCurrentInterestRate } = require('../../utils/bankEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('은행')
    .setDescription('🏦 덕스 중앙은행 예금 계좌를 관리하고 이자 수익을 얻습니다.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('정보')
        .setDescription('🏦 내 예금 계좌 현황 및 현재 기준금리를 확인합니다.')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('저금')
        .setDescription('현금을 은행 예금에 저금합니다.')
        .addStringOption(option =>
          option.setName('금액')
            .setDescription('저금할 금액(예: 5만, 1억, 50000) 또는 "올인"')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('인출')
        .setDescription('은행 예금에서 현금을 인출합니다.')
        .addStringOption(option =>
          option.setName('금액')
            .setDescription('인출할 금액(예: 5만, 1억, 50000) 또는 "올인"')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    const userData = await getOrCreateUser(userId, username);
    let cash = BigInt(userData.cash);
    let bank = BigInt(userData.bank);
    const rate = getCurrentInterestRate();
    const ratePercent = (rate * 100).toFixed(2);
    const hourlyExpectedInterest = BigInt(Math.floor(Number(bank) * rate));

    if (subcommand === '정보') {
      const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle('🏦 덕스 중앙은행 계좌 정보 & 기준금리')
        .setDescription(
          `👤 **예금주:** **@${interaction.user.username}**\n\n` +
          `🏦 **보유 예금 잔고:** **${formatMoney(bank)}**\n` +
          `💵 **보유 현금 잔고:** **${formatMoney(cash)}**\n\n` +
          `─────────────────────────────\n` +
          `📈 **중앙은행 기준금리:** **${ratePercent}% / 1시간 주기 (복리)**\n` +
          `🎁 **1시간당 예상 이자:** **+${formatMoney(hourlyExpectedInterest)}**\n` +
          `─────────────────────────────\n` +
          `💡 *은행에 예금해 두시면 1시간마다 자동으로 이자가 복리로 입금됩니다.*`
        )
        .setFooter({ text: '덕스 중앙은행 • 안전한 자산 관리' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (subcommand === '저금') {
      const inputAmount = interaction.options.getString('금액');
      const depositAmount = parseMoneyInput(inputAmount, cash);
      if (!depositAmount || typeof depositAmount !== 'bigint' || depositAmount <= 0n) {
        return interaction.reply({ embeds: [createErrorEmbed('입력 오류', '올바른 금액(예: 5만, 1억, 50000) 또는 "올인"을 입력하세요.')], flags: MessageFlags.Ephemeral });
      }

      if (cash < depositAmount) {
        return interaction.reply({ embeds: [createErrorEmbed('현금 부족', `보유 현금이 부족합니다!\n현재 현금: **${formatMoney(cash)}**`)], flags: MessageFlags.Ephemeral });
      }

      const newCash = cash - depositAmount;
      const newBank = bank + depositAmount;

      await pool.query('UPDATE users SET cash = ?, bank = ? WHERE discord_id = ?', [newCash.toString(), newBank.toString(), userId]);

      const embed = createSuccessEmbed(
        '은행 저금 완료 🏦',
        `**저금된 금액:** **${formatMoney(depositAmount)}**\n\n` +
        `💵 **남은 현금:** **${formatMoney(newCash)}**\n` +
        `🏦 **총 은행 예금:** **${formatMoney(newBank)}**\n\n` +
        `📈 **적용 예금금리:** **${ratePercent}% / 1시간마다 자동 이자 지급**`
      );
      return interaction.reply({ embeds: [embed] });

    } else if (subcommand === '인출') {
      const inputAmount = interaction.options.getString('금액');
      if (bank <= 0n) {
        return interaction.reply({ embeds: [createErrorEmbed('인출 불가', '인출할 은행 예금이 없습니다.')], flags: MessageFlags.Ephemeral });
      }

      const withdrawAmount = parseMoneyInput(inputAmount, bank);
      if (!withdrawAmount || typeof withdrawAmount !== 'bigint' || withdrawAmount <= 0n) {
        return interaction.reply({ embeds: [createErrorEmbed('입력 오류', '올바른 금액(예: 5만, 1억, 50000) 또는 "올인"을 입력하세요.')], flags: MessageFlags.Ephemeral });
      }

      if (bank < withdrawAmount) {
        return interaction.reply({ embeds: [createErrorEmbed('예금 부족', `은행 예금이 부족합니다!\n현재 예금: **${formatMoney(bank)}**`)], flags: MessageFlags.Ephemeral });
      }

      const newCash = cash + withdrawAmount;
      const newBank = bank - withdrawAmount;

      await pool.query('UPDATE users SET cash = ?, bank = ? WHERE discord_id = ?', [newCash.toString(), newBank.toString(), userId]);

      const embed = createSuccessEmbed(
        '은행 인출 완료 🏦',
        `**인출된 금액:** **${formatMoney(withdrawAmount)}**\n\n` +
        `💵 **현재 현금:** **${formatMoney(newCash)}**\n` +
        `🏦 **남은 은행 예금:** **${formatMoney(newBank)}**`
      );
      return interaction.reply({ embeds: [embed] });
    }
  }
};
