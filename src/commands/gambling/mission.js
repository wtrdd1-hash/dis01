const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { formatMoney } = require('../../utils/formatters');
const { createErrorEmbed, createGambleEmbed } = require('../../utils/embedBuilder');
const { getLoopState, claimMission, claimVipDaily } = require('../../utils/casinoLoop');
const { withUserLock } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('미션')
    .setDescription('오늘 카지노 미션과 VIP 일일 보너스')
    .addSubcommand((s) => s.setName('보기').setDescription('진행 상황을 봅니다'))
    .addSubcommand((s) =>
      s.setName('받기')
        .setDescription('완료한 미션 보상을 받습니다')
        .addStringOption((o) => o.setName('코드').setDescription('slot_5 / win_3 / wager_30k / variety_3 / daily_login').setRequired(true))
    )
    .addSubcommand((s) => s.setName('vip').setDescription('VIP 일일 보너스를 받습니다')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    if (sub === '보기') {
      const state = await getLoopState(userId, interaction.user.globalName || interaction.user.username);
      const lines = (state.me.missions || []).map((m) =>
        `${m.claimed ? '✅' : (m.done ? '🎁' : '⏳')} ${m.title} ${m.progress}/${m.target} (+${formatMoney(m.reward)})`
      );
      lines.push(`\n연승 ${state.me.winStreak} / VIP ${state.me.vipName}`);
      lines.push(`잭팟 ${formatMoney(state.jackpot)}`);
      return interaction.reply({
        embeds: [createGambleEmbed('오늘 미션', lines.join('\n'))],
        flags: MessageFlags.Ephemeral
      });
    }
    try {
      if (sub === 'vip') {
        const data = await withUserLock(userId, () => claimVipDaily(userId));
        return interaction.reply({
          embeds: [createGambleEmbed('VIP', `${data.vip} 일일 +${formatMoney(data.reward)}`)],
          flags: MessageFlags.Ephemeral
        });
      }
      const key = interaction.options.getString('코드');
      const data = await withUserLock(userId, () => claimMission(userId, key));
      return interaction.reply({
        embeds: [createGambleEmbed('미션', `보상 +${formatMoney(data.reward)}`)],
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      return interaction.reply({
        embeds: [createErrorEmbed('미션', err.message || '받을 수 없습니다.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
