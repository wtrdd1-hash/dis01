const { createErrorEmbed } = require('../utils/embedBuilder');
const { logCommandExecution, logComponentInteraction, logWarn, logError } = require('../utils/logger');
const { getOrCreateUser } = require('../config/database');
const { withUserLock } = require('../utils/money');
const { checkUserBanStatus } = require('../utils/userBanEngine');
const { MessageFlags } = require('discord.js');

async function replyEphemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client, commandsMap) {
    try {
      const banInfo = await checkUserBanStatus(interaction.user?.id, { failClosed: true });
      if (banInfo.isBanned) {
        const remaining = banInfo.isPermanent ? '영구 제한' : `${banInfo.remainingText || '일시 제한'} 남음`;
        return replyEphemeral(interaction, `🚫 계정 이용이 제한되었습니다. (${remaining})\n사유: ${banInfo.reason || '관리자 지정 제한'}`);
      }
    } catch (err) {
      logError('Interaction', '유저 차단 상태 확인 실패', err);
      return replyEphemeral(interaction, '⚠️ 사용자 이용 가능 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }

    // 1. 버튼이나 셀렉트메뉴 등의 상호작용 로그 및 클리커 버튼 처리
    if (interaction.isButton()) {
      logComponentInteraction(interaction);

      if (interaction.customId.startsWith('mine_')) {
        const mineDiscord = require('../utils/mineDiscord');
        return mineDiscord.handleMineButton(interaction);
      }

      if (interaction.customId.startsWith('click_mine_') || interaction.customId.startsWith('click_upgrade_')) {
        const targetUserId = interaction.customId.split('_')[2];
        if (interaction.user.id !== targetUserId) {
          return interaction.reply({ content: '❌ 본인이 실행한 /클리커 메시지의 버튼만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
        }

        const { pool } = require('../config/database');
        const { formatMoney } = require('../utils/formatters');
        const { rollClickBatch, clickPower, powerUpgradeCost, CLICKER } = require('../utils/economyBalance');

        if (interaction.customId.startsWith('click_mine_')) {
          return withUserLock(interaction.user.id, async () => {
            const fresh = await getOrCreateUser(interaction.user.id, interaction.user.globalName || interaction.user.username);
            const clickerLevel = fresh.clicker_level || 1;
            const rolled = rollClickBatch(clickerLevel, 1);
            const reward = rolled.earned;
            const isCrit = rolled.crits > 0;
            const bonusTurn = Math.random() < (CLICKER.BONUS_TURN_CHANCE || 0.10);

            let newTurns = fresh.gamble_turns ?? 50;
            if (bonusTurn && newTurns < 50) newTurns += 1;

            await pool.query(
              'UPDATE users SET cash = cash + ?, gamble_turns = ?, total_clicks = total_clicks + 1 WHERE discord_id = ?',
              [reward, newTurns, interaction.user.id]
            );
            try { require('../utils/liveSync').pushUserLive(interaction.user.id); } catch (e) {}
            try {
              const mine = require('../utils/mineService');
              await mine.recordClicks(interaction.user.id, 'classic', 1, isCrit ? 2 : 1, 0);
            } catch (e) {}

            let msg = isCrit
              ? `✨ **${CLICKER.CRIT_MULT}배 크리티컬 대박!** +${formatMoney(reward)} 채굴!`
              : `⛏️ +${formatMoney(reward)} 채굴 성공!`;
            if (bonusTurn) msg += ` (보너스!)`;

            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
          });
        } else if (interaction.customId.startsWith('click_upgrade_')) {
          return withUserLock(interaction.user.id, async () => {
            const fresh = await getOrCreateUser(interaction.user.id, interaction.user.globalName || interaction.user.username);
            const clickerLevel = fresh.clicker_level || 1;
            const cost = powerUpgradeCost(clickerLevel);
            const [deduct] = await pool.query(
              'UPDATE users SET cash = cash - ?, clicker_level = clicker_level + 1 WHERE discord_id = ? AND cash >= ?',
              [cost, interaction.user.id, cost]
            );
            if (!deduct.affectedRows) {
              return interaction.reply({ content: `❌ 현금이 부족합니다! (필요: ${formatMoney(cost)})`, flags: MessageFlags.Ephemeral });
            }
            const newLevel = clickerLevel + 1;
            try { require('../utils/liveSync').pushUserLive(interaction.user.id); } catch (e) {}

            return interaction.reply({
              content: `🔨 **곡괭이 강화 성공 (Lv.${newLevel})!** 클릭당 채굴량: +${formatMoney(clickPower(newLevel))}`,
              flags: MessageFlags.Ephemeral
            });
          });
        }
      }
    } else if (interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      logComponentInteraction(interaction);
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mine_sel_')) {
        const mineDiscord = require('../utils/mineDiscord');
        return mineDiscord.handleMineSelect(interaction);
      }
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

      const LOAN_BLOCK_COMMANDS = {
        슬롯: true,
        동전: true,
        도박: true,
        룰렛: true,
        블랙잭: true,
        경마: true,
        크래시: true,
        주식매수: true
      };
      let subName = null;
      try { subName = interaction.options.getSubcommand(false); } catch (e) {}
      const totoBet = interaction.commandName === '토토' && subName === '배팅';
      if (LOAN_BLOCK_COMMANDS[interaction.commandName] || totoBet) {
        try {
          await require('../utils/loanEngine').assertLoanPlayAllowed(interaction.user.id);
        } catch (loanErr) {
          if (loanErr && loanErr.code === 'LOAN_BLOCK') {
            return interaction.reply({
              embeds: [createErrorEmbed('대출 연체', loanErr.message)],
              flags: MessageFlags.Ephemeral
            });
          }
          throw loanErr;
        }
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
