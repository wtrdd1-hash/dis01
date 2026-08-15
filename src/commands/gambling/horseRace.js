const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createGambleEmbed, createErrorEmbed, createSuccessEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { getDynamicSettings } = require('../../utils/economyBalancer');

// 🏇 출전마 정보 (번호, 이름, 이모지, 배당률, 가중치)
const HORSES = [
  { id: 1, name: '황금번개', emoji: '⚡', odds: 2.0, weight: 45, desc: '안정적인 1위 후보 (정배당 2.0배)' },
  { id: 2, name: '질풍노도', emoji: '🌪️', odds: 3.0, weight: 30, desc: '폭발적인 가속력 (중배당 3.0배)' },
  { id: 3, name: '다크호스', emoji: '🖤', odds: 5.0, weight: 18, desc: '언더독의 반란 (고배당 5.0배)' },
  { id: 4, name: '월덕스피릿', emoji: '🦆', odds: 8.0, weight: 10, desc: '월덕 커뮤니티 대표마 (초고배당 8.0배)' },
  { id: 5, name: '로또잭팟', emoji: '💎', odds: 15.0, weight: 5, desc: '인생역전 한방 (잭팟 15.0배)' }
];

const TRACK_LENGTH = 14; // 트랙 길이

function renderTrack(horsesState) {
  return horsesState.map(h => {
    const pos = Math.min(TRACK_LENGTH, Math.max(0, h.pos));
    const leftTrack = '━'.repeat(pos);
    const rightTrack = '━'.repeat(TRACK_LENGTH - pos);
    const isFinished = pos >= TRACK_LENGTH;
    const runner = isFinished ? '🏆' : `${h.horse.emoji}🏇`;
    return `**${h.horse.id}번** [${leftTrack}${runner}${rightTrack}] 🏁 \`${h.horse.name}\``;
  }).join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('경마')
    .setDescription('🏇 월덕 그랑프리 경마 배팅에 참여합니다.')
    .addStringOption(opt =>
      opt
        .setName('배팅금액')
        .setDescription('배팅할 금액 (최소 1,000원 또는 "올인")')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt
        .setName('말번호')
        .setDescription('우승할 말을 선택하세요 (1~5번)')
        .setRequired(true)
        .addChoices(
          { name: '1번 ⚡ 황금번개 (배당 2.0x / 정배)', value: 1 },
          { name: '2번 🌪️ 질풍노도 (배당 3.0x / 균형)', value: 2 },
          { name: '3번 🖤 다크호스 (배당 5.0x / 복병)', value: 3 },
          { name: '4번 🦆 월덕스피릿 (배당 8.0x / 고배당)', value: 4 },
          { name: '5번 💎 로또잭팟 (배당 15.0x / 대박)', value: 5 }
        )
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const betInput = interaction.options.getString('배팅금액').trim();
    const chosenHorseId = interaction.options.getInteger('말번호');

    const chosenHorse = HORSES.find(h => h.id === chosenHorseId);
    if (!chosenHorse) {
      return interaction.reply({
        embeds: [createErrorEmbed('선택 오류', '1번부터 5번 사이의 출전마를 선택해주세요.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const userData = await getOrCreateUser(userId, username);
    const userCash = BigInt(userData.cash || 0);

    let betAmount = 0n;
    if (betInput === '올인' || betInput === '전체' || betInput === 'all') {
      betAmount = userCash;
    } else {
      const parsed = parseInt(betInput.replace(/[^0-9]/g, ''), 10);
      if (isNaN(parsed) || parsed <= 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '배팅 금액은 1,000원 이상의 정수 또는 "올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      betAmount = BigInt(parsed);
    }

    if (betAmount < 1000n) {
      return interaction.reply({
        embeds: [createErrorEmbed('배팅 제한', '최소 배팅 금액은 1,000원입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (userCash < betAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `보유 현금(${formatMoney(userCash)})이 배팅금(${formatMoney(betAmount)})보다 부족합니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    // ── 사전 차감 (동시성 방지) ──────────────────────
    let balanceBefore = userCash;
    let tempCash = userCash - betAmount;
    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [tempCash.toString(), userId]);

    // ── 경기 시뮬레이션 계산 ────────────────────────
    // 가중치 기반 최종 우승마 결정
    const totalWeight = HORSES.reduce((acc, h) => acc + h.weight, 0);
    let rand = Math.random() * totalWeight;
    let winnerHorse = HORSES[0];
    for (const h of HORSES) {
      if (rand < h.weight) {
        winnerHorse = h;
        break;
      }
      rand -= h.weight;
    }

    // 동적 경제 조절 배율 적용
    let dynMultiplier = 1.0;
    try {
      const dyn = getDynamicSettings();
      if (dyn && dyn.gamblingPayoutMultiplier) dynMultiplier = dyn.gamblingPayoutMultiplier;
    } catch (e) {}

    const isWin = (winnerHorse.id === chosenHorse.id);
    const finalOdds = chosenHorse.odds * dynMultiplier;
    const payout = isWin ? BigInt(Math.round(Number(betAmount) * finalOdds)) : 0n;
    const profit = payout - betAmount;
    const finalCash = tempCash + payout;

    // ── 레이스 애니메이션 준비 ───────────────────────
    let horsesState = HORSES.map(h => ({
      horse: h,
      pos: 0,
      speed: h.id === winnerHorse.id ? 3.5 : (Math.random() * 1.8 + 1.2)
    }));

    const initialEmbed = new EmbedBuilder()
      .setColor(0xF59E0B)
      .setTitle('🏇 [월덕 그랑프리] 탕! 경주가 시작되었습니다! 🚩')
      .setDescription(
        `**내 배팅:** \`${chosenHorse.id}번 ${chosenHorse.name}\` (${chosenHorse.odds}배)\n` +
        `**배팅금:** **${formatMoney(betAmount)}**\n\n` +
        renderTrack(horsesState)
      )
      .setFooter({ text: '🏇 결승선을 향해 힘차게 질주하는 중...' })
      .setTimestamp();

    await interaction.reply({ embeds: [initialEmbed] });

    // ── 3단계 레이스 애니메이션 ─────────────────────
    const steps = [
      { delay: 1200, title: '🏃💨 [월덕 그랑프리] 선두권 쟁탈전 치열!' },
      { delay: 1200, title: '🔥 [월덕 그랑프리] 마지막 코너 진입! 라스트 스퍼트!' },
    ];

    for (let step = 0; step < steps.length; step++) {
      await new Promise(res => setTimeout(res, steps[step].delay));
      horsesState.forEach(h => {
        const boost = (h.horse.id === winnerHorse.id) ? (Math.random() * 3 + 2.5) : (Math.random() * 3 + 1);
        h.pos += Math.round(boost);
        if (h.pos >= TRACK_LENGTH - 1 && h.horse.id !== winnerHorse.id) {
          h.pos = TRACK_LENGTH - 2; // 우승마 제외 결승선 직전 유지
        }
      });

      const stepEmbed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle(`🏇 ${steps[step].title}`)
        .setDescription(
          `**내 배팅:** \`${chosenHorse.id}번 ${chosenHorse.name}\` (${chosenHorse.odds}배)\n` +
          `**배팅금:** **${formatMoney(betAmount)}**\n\n` +
          renderTrack(horsesState)
        )
        .setFooter({ text: '🏇 결승선을 향해 질주 중...' });

      try {
        await interaction.editReply({ embeds: [stepEmbed] });
      } catch (e) {}
    }

    // ── 결승선 통과 (최종 결과) ─────────────────────
    await new Promise(res => setTimeout(res, 1200));

    horsesState.forEach(h => {
      if (h.horse.id === winnerHorse.id) {
        h.pos = TRACK_LENGTH;
      } else {
        h.pos = Math.min(TRACK_LENGTH - 1, h.pos + 2);
      }
    });

    // DB 정산 및 로그 기록
    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [finalCash.toString(), userId]);

    try {
      await pool.query(`
        INSERT INTO gambling_logs 
          (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, 'horse_race', ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        betAmount.toString(),
        payout.toString(),
        profit.toString(),
        balanceBefore.toString(),
        finalCash.toString(),
        JSON.stringify({
          chosenHorse: chosenHorse.name,
          winnerHorse: winnerHorse.name,
          odds: finalOdds,
          isWin
        })
      ]);
    } catch (e) {}

    // 최종 결과 임베드
    const resultEmbed = new EmbedBuilder()
      .setColor(isWin ? 0x10B981 : 0xEF4444)
      .setTitle(isWin ? '🎉 [경마 우승!] 축하합니다! 배당금 적중! 🏆' : '💀 [경마 패배] 아쉽게도 탈락했습니다! 💸')
      .setDescription(
        renderTrack(horsesState) +
        `\n\n─────────────────────────────\n` +
        `🏆 **1위 우승마:** **${winnerHorse.id}번 ${winnerHorse.emoji} ${winnerHorse.name}**\n` +
        `🎯 **내가 선택한 말:** **${chosenHorse.id}번 ${chosenHorse.emoji} ${chosenHorse.name}**\n\n` +
        (isWin 
          ? `💰 **배팅금:** ${formatMoney(betAmount)}\n` +
            `📈 **적용 배당률:** **${finalOdds.toFixed(1)}배**\n` +
            `🎁 **총 수령 상금:** **+${formatMoney(payout)}** (+${formatMoney(profit)} 순수익)\n`
          : `💸 **손실 금액:** -${formatMoney(betAmount)}\n`) +
        `💳 **현재 보유 현금:** **${formatMoney(finalCash)}**`
      )
      .setFooter({ text: '월덕 그랑프리 경마장 • 언제든 다시 도전하세요!' })
      .setTimestamp();

    try {
      await interaction.editReply({ embeds: [resultEmbed] });
    } catch (e) {}
  }
};
