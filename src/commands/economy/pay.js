const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('송금')
    .setDescription('다른 유저에게 돈을 송금합니다.')
    .addUserOption(option =>
      option.setName('받을유저')
        .setDescription('돈을 받을 상대방')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('금액')
        .setDescription('송금할 금액 (최소 1,000원)')
        .setMinValue(1000)
        .setRequired(true)
    ),

  async execute(interaction) {
    const sender = interaction.user;
    const recipient = interaction.options.getUser('받을유저');
    const amount = interaction.options.getInteger('금액');

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

    const senderData = await getOrCreateUser(sender.id);
    const recipientData = await getOrCreateUser(recipient.id);

    const senderCash = BigInt(senderData.cash);
    const payAmount = BigInt(amount);

    if (senderCash < payAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('잔액 부족', `보유 현금이 부족합니다!\n현재 현금: **${formatMoney(senderCash)}**`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const newSenderCash = senderCash - payAmount;
    const newRecipientCash = BigInt(recipientData.cash) + payAmount;

    // 트랜잭션 처리
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newSenderCash.toString(), sender.id]);
      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newRecipientCash.toString(), recipient.id]);

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const embed = createSuccessEmbed(
      '송금 성공! 💸',
      `**보낸 사람:** <@${sender.id}>\n` +
      `**받은 사람:** <@${recipient.id}>\n` +
      `**송금 금액:** **${formatMoney(payAmount)}**\n\n` +
      `💳 **송금 후 내 현금:** **${formatMoney(newSenderCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
