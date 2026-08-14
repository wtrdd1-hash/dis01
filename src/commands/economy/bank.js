const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, parseMoneyInput } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('은행')
    .setDescription('은행 예금 계좌에 현금을 저금하거나 인출합니다.')
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
    const inputAmount = interaction.options.getString('금액');
    const userId = interaction.user.id;

    const userData = await getOrCreateUser(userId);
    let cash = BigInt(userData.cash);
    let bank = BigInt(userData.bank);

    if (subcommand === '저금') {
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
        `🏦 **총 은행 예금:** **${formatMoney(newBank)}**`
      );
      return interaction.reply({ embeds: [embed] });

    } else if (subcommand === '인출') {
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
