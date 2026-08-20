const { SlashCommandBuilder } = require('discord.js');
const { getOrCreateUser } = require('../../config/database');
const { panelPayload } = require('../../utils/mineDiscord');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('클리커')
    .setDescription('⛏️ 장르별 채굴과 곡괭이 강화를 진행합니다.'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const userData = await getOrCreateUser(userId, interaction.user.globalName || interaction.user.username);
    const payload = await panelPayload(userId, userData);
    await interaction.reply(payload);
  }
};
