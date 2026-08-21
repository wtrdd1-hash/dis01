/**
 * 디스코드 /클리커 장르 패널
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { formatMoney, formatNumber } = require('./formatters');
const { clickPower, powerUpgradeCost, autoPerSec } = require('./economyBalance');
const { getGenre, applyGenreReward, rewardPercentForGenre } = require('./mineGenres');
const mine = require('./mineService');
const config = require('../config/config');

const pendingUnlock = new Map();

function buildMineEmbed(userData, state) {
  const clickerLevel = userData.clicker_level || 1;
  const autoLevel = userData.auto_miner_level || 0;
  const current = state.current || getGenre(state.selected);
  const rewardPercent = rewardPercentForGenre(current.id);
  const currentPower = applyGenreReward(clickPower(clickerLevel), current.id);
  const weather = state.weather || { emoji: '☀️', label: '맑음' };
  const badge = current.badge || { emoji: '🌱', name: '견습' };
  const lines = (state.genres || []).map((g) => {
    const lock = g.unlocked ? '✅' : `🔒 ${formatMoney(g.unlockCost)}`;
    const mark = g.id === state.selected ? '▸ ' : '　';
    return `${mark}${g.emoji} ${g.name} · ${lock} · x${Number(g.rewardMultiplier || 1).toFixed(2)} · ${formatNumber(g.clicks || 0)}회`;
  });

  return new EmbedBuilder()
    .setTitle(`${current.emoji} ${current.name}`)
    .setColor((config.colors && config.colors.primary) || 0xF59E0B)
    .setDescription(
      `${current.desc}\n날씨 ${weather.emoji} ${weather.label} · 배지 ${badge.emoji} ${badge.name} · 깊이 ${current.depth || 0}m\n` +
      `웹에서는 장르별 미니게임이 열립니다: https://easy-scraping.com`
    )
    .addFields(
      { name: '💵 현금', value: formatMoney(userData.cash), inline: true },
      { name: '🔨 채굴 파워', value: `Lv.${clickerLevel} (클릭당 +${formatMoney(currentPower)}, 장르 x${(rewardPercent / 100).toFixed(2)})`, inline: true },
      { name: '🤖 자동 채굴', value: `Lv.${autoLevel} (초당 +${formatMoney(autoPerSec(autoLevel))})`, inline: true },
      { name: '광산 목록', value: lines.join('\n').slice(0, 1024) || '-' }
    )
    .setFooter({ text: '해금 비용과 난이도가 높은 장르일수록 인정된 클릭의 현금 보상이 커집니다.' });
}

function buildMineComponents(userId, state, upgradeCost) {
  const genres = state.genres || [];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`mine_sel_${userId}`)
    .setPlaceholder('장르 선택 · 잠긴 항목은 해금 비용이 표시됩니다')
    .addOptions(
      genres.map((g) => ({
        label: `${g.unlocked ? '' : '잠김 '}${g.name}`.slice(0, 100),
        value: g.id,
        emoji: g.emoji,
        description: (g.unlocked
          ? `${g.desc} · ${formatNumber(g.clicks || 0)}회`
          : `해금 ${formatMoney(g.unlockCost)} · 한 번이면 유지`
        ).slice(0, 100),
        default: g.id === state.selected
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(select);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mine_do_${userId}`).setLabel('채굴').setStyle(ButtonStyle.Success).setEmoji('⛏️'),
    new ButtonBuilder().setCustomId(`mine_un_${userId}`).setLabel('장르 해금').setStyle(ButtonStyle.Danger).setEmoji('🔓'),
    new ButtonBuilder().setCustomId(`click_upgrade_${userId}`).setLabel(`곡괭이 ${formatMoney(upgradeCost)}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mine_lb_${userId}`).setLabel('순위').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('웹 채굴장').setStyle(ButtonStyle.Link).setURL('https://easy-scraping.com')
  );
  return [row1, row2, row3];
}

async function panelPayload(userId, userData) {
  const state = await mine.getState(userId);
  const upgradeCost = powerUpgradeCost(userData.clicker_level || 1);
  return {
    embeds: [buildMineEmbed(userData, state)],
    components: buildMineComponents(userId, state, upgradeCost)
  };
}

function ownerIdFrom(customId, prefix) {
  return String(customId || '').slice(prefix.length);
}

function assertOwner(interaction, ownerId) {
  return interaction.user.id === ownerId;
}

async function handleMineSelect(interaction) {
  const ownerId = ownerIdFrom(interaction.customId, 'mine_sel_');
  if (!assertOwner(interaction, ownerId)) {
    return interaction.reply({ content: '본인이 실행한 /클리커 만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
  }
  const genreId = interaction.values && interaction.values[0];
  const { getOrCreateUser } = require('../config/database');
  const userData = await getOrCreateUser(ownerId, interaction.user.globalName || interaction.user.username);
  const unlocked = await mine.isUnlocked(ownerId, genreId);
  if (unlocked) {
    pendingUnlock.delete(ownerId);
    await mine.setSelectedGenre(ownerId, genreId);
  } else {
    pendingUnlock.set(ownerId, genreId);
  }
  const payload = await panelPayload(ownerId, userData);
  if (!unlocked) {
    const g = getGenre(genreId);
    payload.embeds[0].setFooter({
      text: `해금 대기: ${g.emoji} ${g.name} · ${formatMoney(g.unlockCost)} · 아래 해금 버튼을 누르세요`
    });
  }
  return interaction.update(payload);
}

async function handleMineButton(interaction) {
  const id = interaction.customId;
  const { getOrCreateUser, pool } = require('../config/database');
  const { withUserLock } = require('./money');
  const { rollClickBatch, CLICKER } = require('./economyBalance');
  const { pushUserLive } = require('./liveSync');

  if (id.startsWith('mine_do_')) {
    const ownerId = ownerIdFrom(id, 'mine_do_');
    if (!assertOwner(interaction, ownerId)) {
      return interaction.reply({ content: '본인이 실행한 /클리커 만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    return withUserLock(ownerId, async () => {
      const fresh = await getOrCreateUser(ownerId, interaction.user.globalName || interaction.user.username, interaction.user.displayAvatarURL({ size: 64 }));
      const genreId = await mine.getSelectedGenre(ownerId);
      const genre = getGenre(genreId);
      const clickerLevel = fresh.clicker_level || 1;
      const rolled = rollClickBatch(clickerLevel, 1);
      const earned = applyGenreReward(rolled.earned, genreId);
      const bonusTurn = Math.random() < (CLICKER.BONUS_TURN_CHANCE || 0.10);
      let newTurns = fresh.gamble_turns ?? 50;
      if (bonusTurn && newTurns < 50) newTurns += 1;
      await pool.query(
        'UPDATE users SET cash = cash + ?, gamble_turns = ?, total_clicks = total_clicks + 1 WHERE discord_id = ?',
        [earned, newTurns, ownerId]
      );
      await mine.recordClicks(ownerId, genreId, 1, rolled.crits ? 2 : 1, 0);
      try { pushUserLive(ownerId); } catch (e) {}
      try {
        await mine.maybeAnnounceMega({
          userId: ownerId,
          username: fresh.username || interaction.user.globalName || interaction.user.username,
          avatar: fresh.avatar || '',
          genreId,
          critCount: rolled.crits,
          earned
        });
      } catch (e) {}
      let msg = rolled.crits
        ? `${genre.emoji} **${CLICKER.CRIT_MULT}배 크리티컬!** ${genre.flavor} +${formatMoney(earned)} (장르 x${(rewardPercentForGenre(genreId) / 100).toFixed(2)})`
        : `${genre.emoji} ${genre.flavor} +${formatMoney(earned)} (장르 x${(rewardPercentForGenre(genreId) / 100).toFixed(2)})`;
      if (bonusTurn) msg += ' (보너스!)';
      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    });
  }

  if (id.startsWith('mine_un_')) {
    const ownerId = ownerIdFrom(id, 'mine_un_');
    if (!assertOwner(interaction, ownerId)) {
      return interaction.reply({ content: '본인이 실행한 /클리커 만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const target = pendingUnlock.get(ownerId);
    if (!target) {
      return interaction.reply({ content: '먼저 목록에서 잠긴 장르를 선택하세요.', flags: MessageFlags.Ephemeral });
    }
    try {
      const result = await withUserLock(ownerId, () => mine.unlockGenre(ownerId, target));
      pendingUnlock.delete(ownerId);
      try { pushUserLive(ownerId); } catch (e) {}
      const userData = await getOrCreateUser(ownerId, interaction.user.globalName || interaction.user.username);
      const payload = await panelPayload(ownerId, userData);
      const msg = result.already
        ? `${result.genre.emoji} 이미 해금된 장르입니다.`
        : `${result.genre.emoji} ${result.genre.name} 해금 완료! 한 번 해금하면 계속 유지됩니다.`;
      await interaction.update(payload);
      return interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CASH') {
        const g = getGenre(target);
        return interaction.reply({ content: `현금이 부족합니다. 해금 비용 ${formatMoney(g.unlockCost)}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: err.message || '해금에 실패했습니다.', flags: MessageFlags.Ephemeral });
    }
  }

  if (id.startsWith('mine_lb_')) {
    const ownerId = ownerIdFrom(id, 'mine_lb_');
    if (!assertOwner(interaction, ownerId)) {
      return interaction.reply({ content: '본인이 실행한 /클리커 만 조작할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const selected = await mine.getSelectedGenre(ownerId);
    const genre = getGenre(selected);
    const rows = await mine.getLeaderboard(selected, 10);
    const body = rows.length
      ? rows.map((r) => `${r.rank}. ${r.username} · ${formatNumber(r.clicks)}회`).join('\n')
      : '아직 기록이 없습니다.';
    return interaction.reply({
      content: `${genre.emoji} **${genre.name} 순위**\n${body}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

module.exports = {
  panelPayload,
  handleMineSelect,
  handleMineButton
};
