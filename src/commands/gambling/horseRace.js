const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, applyCashDelta, getUserCash, parseCasinoGambleBet, casinoTooSmallMessage, withUserLock, computePayout } = require('../../utils/money');
const { HORSES, HORSE_BET_MODES, runHorseRace, validateHorseBet } = require('../../utils/horseRace');

const TRACK_LENGTH = 14;

function renderTrack(horsesState) {
  return horsesState.map((h) => {
    const pos = Math.min(TRACK_LENGTH, Math.max(0, h.pos));
    const leftTrack = '━'.repeat(pos);
    const rightTrack = '━'.repeat(TRACK_LENGTH - pos);
    const isFinished = pos >= TRACK_LENGTH;
    const runner = isFinished ? '🏆' : `${h.horse.emoji}🏇`;
    return `**${h.horse.id}번** [${leftTrack}${runner}${rightTrack}] 🏁 \`${h.horse.name}\``;
  }).join('\n');
}

function modeChoices() {
  return Object.values(HORSE_BET_MODES).map((m) => ({
    name: `${m.name} — ${m.desc}`,
    value: m.id
  }));
}

function horseChoices() {
  return HORSES.map((h) => ({
    name: `${h.id}번 ${h.emoji} ${h.name}`,
    value: h.id
  }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('경마')
    .setDescription('🏇 월덕 그랑프리 — 단승·복승·연승·복연승·쌍승 배팅')
    .addStringOption((opt) =>
      opt
        .setName('배팅금액')
        .setDescription('배팅할 금액, 한글 단위(예: 5만), 또는 "전액"/"올인"')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('배팅종류')
        .setDescription('단승(1착) / 복승(1·2착) / 연승(1~3착) / 복연승 / 쌍승')
        .setRequired(true)
        .addChoices(...modeChoices())
    )
    .addIntegerOption((opt) =>
      opt
        .setName('말번호')
        .setDescription('단승·복승·연승은 이 말 / 쌍승은 1착 예상')
        .setRequired(true)
        .addChoices(...horseChoices())
    )
    .addIntegerOption((opt) =>
      opt
        .setName('말번호2')
        .setDescription('복연승·쌍승일 때 두 번째 말 (쌍승은 2착 예상)')
        .setRequired(false)
        .addChoices(...horseChoices())
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const betInput = interaction.options.getString('배팅금액').trim();
    const mode = interaction.options.getString('배팅종류');
    const horseId = interaction.options.getInteger('말번호');
    const horseId2 = interaction.options.getInteger('말번호2');

    const picked = validateHorseBet({ mode, horseId, horseId2 });
    if (picked.error) {
      return interaction.reply({
        embeds: [createErrorEmbed('선택 오류', picked.error)],
        flags: MessageFlags.Ephemeral
      });
    }

    let raced;
    let betAmount;
    let payout;
    let profit;
    let finalCash;
    let balanceBefore;
    let finalOdds;
    try {
      const locked = await withUserLock(userId, async () => {
        const userData = await getOrCreateUser(userId, username);
        const userCash = safeBigInt(userData.cash);
        const parsed = parseCasinoGambleBet(betInput, userCash);
        if (parsed === null) {
          const err = new Error('BET_INVALID');
          err.code = 'BET_INVALID';
          throw err;
        }
        const tooSmall = casinoTooSmallMessage(betInput, userCash, parsed);
        if (tooSmall) {
          const err = new Error(tooSmall);
          err.code = 'BET_MIN';
          throw err;
        }
        if (userCash < parsed) {
          const err = new Error('INSUFFICIENT_CASH');
          err.code = 'INSUFFICIENT_CASH';
          err.cash = userCash;
          err.bet = parsed;
          throw err;
        }

        const result = runHorseRace({ mode, horseId, horseId2 });
        if (result.error) {
          const err = new Error(result.error);
          err.code = 'BET_SELECT';
          throw err;
        }

        // ── 배팅금 먼저 차감 ─────────────────────────────────────────
        await applyCashDelta(userId, -parsed, { skipLog: true });

        // ── 당첨 시에만 총 상금(배팅금 + 순익)을 별도 입금 ────────────
        const multiplier = result.isWin ? (Number(result.multiplier) || 0) : 0;
        let pay = 0n;
        if (result.isWin && multiplier > 1) {
          pay = computePayout(parsed, multiplier);
          // 상금이 0이면 배팅금이라도 환급
          if (pay <= 0n) pay = parsed;
          await applyCashDelta(userId, pay, { skipLog: true });
        }

        const pr = pay - parsed; // 순익 (패배면 -parsed)
        const after = await getUserCash(userId); // 최종 잔고 정확하게 재조회
        return {
          result,
          parsed,
          pay,
          pr,
          after,
          before: userCash,
          odds: result.isWin ? multiplier : result.multiplier
        };
      });
      raced = locked.result;
      betAmount = locked.parsed;
      payout = locked.pay;
      profit = locked.pr;
      finalCash = locked.after;
      balanceBefore = locked.before;
      finalOdds = locked.odds;
    } catch (err) {
      if (err.code === 'BET_SELECT') {
        return interaction.reply({
          embeds: [createErrorEmbed('선택 오류', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
      if (err.code === 'BET_INVALID') {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '배팅 금액은 1,000원 이상의 정수, 한글 단위(예: 5만), 또는 "전액"/"올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      if (err.code === 'BET_MIN') {
        return interaction.reply({
          embeds: [createErrorEmbed('배팅 제한', err.message || '최소 배팅 금액은 1,000원입니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      if (err.code === 'INSUFFICIENT_CASH') {
        return interaction.reply({
          embeds: [createErrorEmbed('현금 부족', `보유 현금(${formatMoney(err.cash)})이 배팅금(${formatMoney(err.bet)})보다 부족합니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }
      if (err.code === 'MONEY_OVERFLOW') {
        return interaction.reply({
          embeds: [createErrorEmbed('금액 한도', err.message || '금액이 허용 한도를 넘습니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      throw err;
    }

    const pickLine = raced.pick2
      ? `${raced.pick1.emoji} ${raced.pick1.displayName} + ${raced.pick2.emoji} ${raced.pick2.displayName}`
      : `${raced.pick1.emoji} ${raced.pick1.displayName}`;

    const cond = raced.card.condition;
    let horsesState = HORSES.map((h) => ({
      horse: h,
      pos: 0
    }));

    const initialEmbed = new EmbedBuilder()
      .setColor(0xF59E0B)
      .setTitle(`🏇 [월덕 그랑프리] 탕! ${cond.emoji} ${cond.name} 주로 출발!`)
      .setDescription(
        `**배팅:** \`${raced.modeName}\` · ${pickLine}\n` +
        `**배당:** **${finalOdds.toFixed(1)}배** · **배팅금:** **${formatMoney(betAmount)}**\n` +
        `${cond.emoji} ${cond.desc}\n\n` +
        renderTrack(horsesState)
      )
      .setFooter({ text: '🏇 결승선을 향해 힘차게 질주하는 중...' })
      .setTimestamp();

    await interaction.reply({ embeds: [initialEmbed] });

    const steps = [
      { delay: 1200, title: `🏃💨 선두권 쟁탈전 · ${cond.name} 주로` },
      { delay: 1200, title: '🔥 마지막 코너 진입! 라스트 스퍼트!' }
    ];

    for (let step = 0; step < steps.length; step++) {
      await new Promise((res) => setTimeout(res, steps[step].delay));
      horsesState.forEach((h) => {
        const place = raced.ranking.findIndex((r) => r.id === h.horse.id);
        const boost = place === 0 ? Math.random() * 3 + 2.5 : Math.random() * 3 + 1;
        h.pos += Math.round(boost);
        if (place > 0 && h.pos >= TRACK_LENGTH - place) {
          h.pos = TRACK_LENGTH - 1 - place;
        }
      });

      const stepEmbed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle(`🏇 ${steps[step].title}`)
        .setDescription(
          `**배팅:** \`${raced.modeName}\` · ${pickLine}\n` +
          `**배팅금:** **${formatMoney(betAmount)}**\n\n` +
          renderTrack(horsesState)
        )
        .setFooter({ text: '🏇 결승선을 향해 질주 중...' });

      try {
        await interaction.editReply({ embeds: [stepEmbed] });
      } catch (e) {}
    }

    await new Promise((res) => setTimeout(res, 1100));
    horsesState.forEach((h) => {
      const place = raced.ranking.findIndex((r) => r.id === h.horse.id);
      h.pos = place === 0 ? TRACK_LENGTH : Math.max(0, TRACK_LENGTH - 1 - place);
    });

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
          mode: raced.mode,
          modeName: raced.modeName,
          condition: cond.id,
          chosenHorse: raced.pick1.name,
          chosenHorse2: raced.pick2 ? raced.pick2.name : null,
          winnerHorse: raced.ranking[0].name,
          second: raced.ranking[1].name,
          third: raced.ranking[2].name,
          odds: finalOdds,
          isWin: raced.isWin
        })
      ]);
    } catch (e) {}

    const podium =
      `🥇 **1착** ${raced.ranking[0].emoji} ${raced.ranking[0].displayName}\n` +
      `🥈 **2착** ${raced.ranking[1].emoji} ${raced.ranking[1].displayName}\n` +
      `🥉 **3착** ${raced.ranking[2].emoji} ${raced.ranking[2].displayName}`;

    const resultEmbed = new EmbedBuilder()
      .setColor(raced.isWin ? 0x10B981 : 0xEF4444)
      .setTitle(raced.isWin ? `🎉 [${raced.modeName} 적중!] 배당금 지급! 🏆` : `💀 [${raced.modeName} 불발] 다음 레이스에서!`)
      .setDescription(
        renderTrack(horsesState) +
        `\n\n─────────────────────────────\n` +
        podium +
        `\n\n🎯 **내 배팅:** **${raced.modeName}** · ${pickLine}\n` +
        `${cond.emoji} **주로:** ${cond.name} — ${cond.desc}\n\n` +
        (raced.isWin
          ? `📈 **적용 배당:** **${finalOdds.toFixed(1)}배**\n🎁 **수령 상금:** **+${formatMoney(payout)}** (순익 ${formatMoney(profit)})\n`
          : `💸 **손실:** -${formatMoney(betAmount)}\n`) +
        `💳 **현재 현금:** **${formatMoney(finalCash)}**\n\n` +
        `_${raced.flavor}_`
      )
      .setFooter({ text: '월덕 그랑프리 · 단승/복승/연승/복연승/쌍승' })
      .setTimestamp();

    try {
      await interaction.editReply({ embeds: [resultEmbed] });
    } catch (e) {}
  }
};
