const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, applyCashDelta, withUserLock } = require('../../utils/money');
const { parseAdminMoney, MONEY_UNITS } = require('../../utils/moneyScale');
const { quoteTransferTax, applyDebitWithTax } = require('../../utils/taxEngine');

const unitChoices = MONEY_UNITS.map((u) => ({
  name: u.exp === 0 ? '원' : `${u.label} (10^${u.exp})`,
  value: u.label
}));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('송금')
    .setDescription('다른 유저에게 돈을 송금합니다.')
    .addUserOption(option =>
      option.setName('받을유저')
        .setDescription('돈을 받을 상대방')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('금액')
        .setDescription('숫자 또는 5만, 1억, 500양')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('단위')
        .setDescription('금액이 숫자일 때 곱할 단위')
        .addChoices(...unitChoices)
        .setRequired(false)
    ),

  async execute(interaction) {
    const sender = interaction.user;
    const recipient = interaction.options.getUser('받을유저');
    const rawAmount = interaction.options.getString('금액');
    const unit = interaction.options.getString('단위') || '원';

    if (recipient.id === sender.id) {
      return interaction.reply({
        embeds: [createErrorEmbed('송금 오류', '자기 자신에게는 송금할 수 없습니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (recipient.bot) {
      return interaction.reply({
        embeds: [createErrorEmbed('송금 오류', '봇에게는 송금할 수 없습니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    let payAmount;
    try {
      payAmount = parseAdminMoney(rawAmount, unit);
    } catch (e) {
      if (e && e.code === 'MONEY_OVERFLOW') {
        return interaction.reply({
          embeds: [createErrorEmbed('금액 한도', e.message)],
          flags: MessageFlags.Ephemeral
        });
      }
      throw e;
    }

    if (!payAmount || typeof payAmount !== 'bigint' || payAmount < 1000n) {
      return interaction.reply({
        embeds: [createErrorEmbed('송금 오류', '최소 1,000원 이상이어야 합니다. 예: 5만, 1억, 500양')],
        flags: MessageFlags.Ephemeral
      });
    }

    const senderData = await getOrCreateUser(sender.id);
    await getOrCreateUser(recipient.id);

    const senderCash = safeBigInt(senderData.cash);

    const taxQuote = quoteTransferTax(sender.id, recipient.id, payAmount);
    if (senderCash < payAmount + taxQuote.tax) {
      return interaction.reply({
        embeds: [createErrorEmbed('잔액 부족', `보유 현금이 부족합니다!\n현재 현금: **${formatMoney(senderCash)}**${taxQuote.tax > 0n ? `\n송금세: **${formatMoney(taxQuote.tax)}**` : ''}`)],
        flags: MessageFlags.Ephemeral
      });
    }

    let newSenderCash;
    try {
      newSenderCash = await withUserLock(sender.id, async () => {
        const paid = await applyDebitWithTax(
          sender.id,
          sender.username,
          payAmount,
          taxQuote.tax,
          'TAX_TRANSFER',
          `유저 송금세 → ${recipient.id}`
        );
        await applyCashDelta(recipient.id, payAmount, {
          logType: 'PAY_RECEIVE',
          description: `💸 ${sender.username} 님으로부터 유저 송금 수령 (+${formatMoney(payAmount)})`
        });
        return paid.after;
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CASH') {
        return interaction.reply({
          embeds: [createErrorEmbed('잔액 부족', `보유 현금이 부족합니다!\n현재 현금: **${formatMoney(senderCash)}**`)],
          flags: MessageFlags.Ephemeral
        });
      }
      if (err.code === 'MONEY_OVERFLOW') {
        return interaction.reply({
          embeds: [createErrorEmbed('금액 한도', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
      throw err;
    }

    const taxLine = taxQuote.tax > 0n
      ? `**송금세 (${(taxQuote.rate * 100).toFixed(1)}%):** ${formatMoney(taxQuote.tax)}\n`
      : '';
    const embed = createSuccessEmbed(
      '송금 성공! 💸',
      `**보낸 사람:** <@${sender.id}>\n` +
      `**받은 사람:** <@${recipient.id}>\n` +
      `**송금 금액:** **${formatMoney(payAmount)}**\n` +
      taxLine +
      `\n💳 **송금 후 내 현금:** **${formatMoney(newSenderCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
