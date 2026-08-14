const { createErrorEmbed } = require('../utils/embedBuilder');
const { logCommandExecution } = require('../utils/logger');
const { getOrCreateUser } = require('../config/database');
const { MessageFlags } = require('discord.js');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client, commandsMap) {
    if (!interaction.isChatInputCommand()) return;

    const command = commandsMap.get(interaction.commandName);
    if (!command) {
      console.warn(`⚠️ 알 수 없는 명령어 수신: ${interaction.commandName}`);
      return;
    }

    const startTime = Date.now();
    try {
      const username = interaction.user.globalName || interaction.user.username || interaction.user.tag;
      const avatarUrl = interaction.user.avatar
        ? `https://cdn.discordapp.com/avatars/${interaction.user.id}/${interaction.user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;
      
      try {
        await getOrCreateUser(interaction.user.id, username, avatarUrl);
      } catch (dbErr) {
        // Continue command execution even if DB sync fails
      }

      await command.execute(interaction, client);
      const durationMs = Date.now() - startTime;
      await logCommandExecution(interaction, 'SUCCESS', durationMs);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await logCommandExecution(interaction, 'ERROR', durationMs, error);

      let title = '명령어 오류';
      let description = '명령어를 처리하는 동안 오류가 발생했습니다.';

      if (error.code === 'ECONNREFUSED') {
        title = 'DB 연결 오류';
        description = '데이터베이스(MySQL) 서버에 연결할 수 없습니다.\nMySQL 서비스가 실행 중인지 확인해 주세요. (`wsl service mysql start`)';
      }

      const embed = createErrorEmbed(title, description);

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }
  }
};
