const { createErrorEmbed } = require('../utils/embedBuilder');
const { logCommandExecution, logComponentInteraction, logWarn, logError } = require('../utils/logger');
const { getOrCreateUser } = require('../config/database');
const { MessageFlags } = require('discord.js');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client, commandsMap) {
    // 1. 버튼이나 셀렉트메뉴 등의 상호작용 로그 및 클리커 버튼 처리
    if (interaction.isButton()) {
      logComponentInteraction(interaction);

      if (interaction.customId.startsWith('click_mine_') || interaction.customId.startsWith('click_upgrade_')) {
        const targetUserId = interaction.customId.split('_')[2];
        if (interaction.user.id !== targetUserId) {
          return interaction.reply({ content: '❌ 본인이 실행한 /클리커 메시지의 버튼만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
        }

        const userData = await getOrCreateUser(interaction.user.id, interaction.user.globalName || interaction.user.username);
        const { pool } = require('../config/database');
        const { formatMoney } = require('../utils/formatters');

        if (interaction.customId.startsWith('click_mine_')) {
          const clickerLevel = userData.clicker_level || 1;
          const power = clickerLevel * 100;
          const isCrit = Math.random() < 0.15;
          const reward = isCrit ? power * 5 : power;
          const bonusTurn = Math.random() < 0.15;

          const newCash = BigInt(userData.cash || 0) + BigInt(reward);
          let newTurns = userData.gamble_turns ?? 50;
          if (bonusTurn && newTurns < 50) newTurns += 1;
          const totalClicks = BigInt(userData.total_clicks || 0) + 1n;

          await pool.query('UPDATE users SET cash = ?, gamble_turns = ?, total_clicks = ? WHERE discord_id = ?', [
            newCash.toString(), newTurns, totalClicks.toString(), interaction.user.id
          ]);

          let msg = isCrit ? `✨ **5배 크리티컬 대박!** +${formatMoney(reward)} 채굴!` : `⛏️ +${formatMoney(reward)} 채굴 성공!`;
          if (bonusTurn) msg += ` (⚡ **도박 턴 +1** 획득!)`;

          return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        } else if (interaction.customId.startsWith('click_upgrade_')) {
          const clickerLevel = userData.clicker_level || 1;
          const cost = BigInt(clickerLevel * 10000);
          const userCash = BigInt(userData.cash || 0);

          if (userCash < cost) {
            return interaction.reply({ content: `❌ 현금이 부족합니다! (필요: ${formatMoney(cost)}, 보유: ${formatMoney(userCash)})`, flags: MessageFlags.Ephemeral });
          }

          const newCash = userCash - cost;
          const newLevel = clickerLevel + 1;
          await pool.query('UPDATE users SET cash = ?, clicker_level = ? WHERE discord_id = ?', [newCash.toString(), newLevel, interaction.user.id]);

          return interaction.reply({
            content: `🔨 **곡괭이 강화 성공 (Lv.${newLevel})!** 클릭당 채굴량: +${formatMoney(newLevel * 100)}`,
            flags: MessageFlags.Ephemeral
          });
        }
      }
    } else if (interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      logComponentInteraction(interaction);
    }

    // 2. 슬래시 명령어 처리
    if (!interaction.isChatInputCommand()) return;

    const command = commandsMap.get(interaction.commandName);
    if (!command) {
      logWarn('Interaction', `알 수 없는 명령어 수신: /${interaction.commandName} (User: ${interaction.user.tag})`);
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
        logWarn('Database', `유저 동기화 실패 (${interaction.user.id}): ${dbErr.message}`);
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
        description = '데이터베이스(MySQL) 서버에 연결할 수 없습니다.\nMySQL 서비스가 실행 중인지 확인해 주세요.';
      }

      const embed = createErrorEmbed(title, description);

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        logError('Interaction', '에러 응답 전송 실패', replyErr);
      }
    }
  }
};
