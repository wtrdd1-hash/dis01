const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getOrCreateUser } = require('../../config/database');
const { createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { BUSINESS } = require('../../utils/economyBalance');
const {
  listUserBusinesses,
  buyBusiness,
  upgradeBusiness,
  hireStaff,
  upgradeHq,
  setAutoCollect,
  collectBusiness,
  sellBusiness
} = require('../../utils/businessEngine');

const typeChoices = BUSINESS.CATALOG.map((item) => ({
  name: `${item.emoji} ${item.name}`.slice(0, 100),
  value: item.key
}));

function typeOption(option) {
  return option
    .setName('종류')
    .setDescription('사업 종류')
    .setRequired(true)
    .addChoices(...typeChoices);
}

function statusEmbed(username, state) {
  const owned = state.items.filter((item) => item.owned);
  const lines = state.items.map((item) => {
    if (!item.owned) {
      const lock = item.locked ? ` · 선행 ${item.requiresName}` : '';
      return `${item.emoji} ${item.name} — 미보유 · ${formatMoney(item.cost)}${lock}`;
    }
    return `${item.emoji} ${item.name} Lv.${item.level} 알바${item.staff} — 대기 ${formatMoney(item.pending)} · 분당 +${formatMoney(item.incomePerMin)}`;
  });
  const auto = state.autoUnlocked
    ? (state.autoCollect ? '자동수금 ON' : '자동수금 OFF')
    : '자동수금 잠김(본사 1레벨)';
  return new EmbedBuilder()
    .setColor(0xF59E0B)
    .setTitle('🏢 월덕 사업')
    .setDescription(
      `👤 **@${username}** · 본사 Lv.${state.hqLevel}/${state.maxHq} · ${auto}\n` +
      `보유 ${owned.length}/${state.items.length}곳 · 대기 **${formatMoney(state.pendingTotal)}** · 분당 +${formatMoney(state.incomeTotal)}\n\n` +
      lines.join('\n')
    )
    .setFooter({ text: '웹에서도 관리: easy-scraping.com' });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('사업')
    .setDescription('점포를 개업하고 알바·본사·자동수금을 관리합니다.')
    .addSubcommand((sub) => sub.setName('현황').setDescription('내 사업과 대기 수익을 봅니다.'))
    .addSubcommand((sub) => sub.setName('구매').setDescription('새 점포를 개업합니다.').addStringOption(typeOption))
    .addSubcommand((sub) => sub.setName('업글').setDescription('보유 점포를 업그레이드합니다.').addStringOption(typeOption))
    .addSubcommand((sub) => sub.setName('고용').setDescription('점포에 알바를 고용합니다.').addStringOption(typeOption))
    .addSubcommand((sub) => sub.setName('본사').setDescription('본사를 올려 전체 매출과 자동수금을 엽니다.'))
    .addSubcommand((sub) => sub.setName('자동수금').setDescription('1분마다 수익을 현금으로 받을지 켜거나 끕니다.'))
    .addSubcommand((sub) => sub.setName('수금').setDescription('쌓인 사업 수익을 현금으로 받습니다.'))
    .addSubcommand((sub) => sub.setName('매각').setDescription('점포를 팔고 투자금 일부를 돌려받습니다.').addStringOption(typeOption)),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.globalName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL({ size: 64 }));
    const sub = interaction.options.getSubcommand();
    const key = interaction.options.getString('종류');

    try {
      if (sub === '현황') {
        const state = await listUserBusinesses(userId);
        return interaction.reply({ embeds: [statusEmbed(username, state)] });
      }
      let result;
      if (sub === '구매') result = await buyBusiness(userId, username, key);
      else if (sub === '업글') result = await upgradeBusiness(userId, username, key);
      else if (sub === '고용') result = await hireStaff(userId, username, key);
      else if (sub === '본사') result = await upgradeHq(userId, username);
      else if (sub === '자동수금') {
        const state = await listUserBusinesses(userId);
        result = await setAutoCollect(userId, username, !state.autoCollect);
      } else if (sub === '수금') result = await collectBusiness(userId, username, null);
      else if (sub === '매각') result = await sellBusiness(userId, username, key);
      else {
        return interaction.reply({ embeds: [createErrorEmbed('오류', '알 수 없는 명령입니다.')], flags: MessageFlags.Ephemeral });
      }
      const embed = statusEmbed(username, result.state);
      embed.setDescription(`✅ ${result.message}\n💵 현금 **${formatMoney(result.cash)}**\n\n` + embed.data.description);
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      const msg = err && err.code === 'INSUFFICIENT_CASH' ? '보유 현금이 부족합니다.' : (err.message || '처리에 실패했습니다.');
      return interaction.reply({ embeds: [createErrorEmbed('사업 실패', msg)], flags: MessageFlags.Ephemeral });
    }
  }
};
