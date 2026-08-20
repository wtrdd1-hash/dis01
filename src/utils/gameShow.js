/**
 * 카지노 실황 멘트 + 디스코드 단계 연출
 * 배당/확률은 건드리지 않고 보여 주는 연출만 담당한다.
 */
const COLORS = {
  SUCCESS: 0x2ECC71,
  ERROR: 0xE74C3C,
  WARNING: 0xF1C40F,
  GAMBLE: 0x9B59B6
};

function discordEmbed() {
  const { EmbedBuilder } = require('discord.js');
  return EmbedBuilder;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatWon(num) {
  try {
    const n = typeof num === 'bigint' ? num : BigInt(String(num || 0).split('.')[0] || '0');
    return n.toLocaleString('ko-KR') + '원';
  } catch (e) {
    return String(num) + '원';
  }
}

function moneyTail(betAmount, payout, newCash) {
  return (
    `\n\n💰 **배팅금:** ${formatWon(betAmount)}\n` +
    `🎁 **획득금:** ${formatWon(payout)}\n` +
    `💳 **현재 잔액:** **${formatWon(newCash)}**`
  );
}

function slotFlavor(reels, multiplier, isWin) {
  const line = `${reels[0]} ${reels[1]} ${reels[2]}`;
  if (Number(multiplier) >= 50) {
    return pick([
      `세븐이 한 줄로 붙었습니다! ${line}`,
      `릴이 멈추자 장내가 술렁입니다. ${line} 잭팟!`
    ]);
  }
  if (Number(multiplier) >= 20) {
    return `다이아가 세 칸을 채웠습니다. ${line}`;
  }
  if (isWin && Number(multiplier) >= 10) {
    return `트리플 라인! ${line} 배당이 열렸습니다.`;
  }
  if (isWin) {
    return pick([
      `페어가 걸렸습니다. ${line} 소액이지만 살아남았습니다.`,
      `두 칸이 맞았습니다. ${line}`
    ]);
  }
  if (reels[0] === reels[1] || reels[1] === reels[2]) {
    return pick([
      `한 칸만 더였습니다. ${line}`,
      `거의 붙을 뻔했습니다. ${line} 다음 스핀에서.`
    ]);
  }
  return pick([
    `흩어졌습니다. ${line}`,
    `이번 판은 흐름이 없었습니다. ${line}`
  ]);
}

function coinFlavor(choice, result, isWin) {
  const face = result === '앞면' ? '독수리' : '왕관';
  if (isWin) {
    return pick([
      `공중에서 한 바퀴 더 돌더니 ${face}가 위를 향했습니다.`,
      `선택한 ${choice} 그대로 바닥에 붙었습니다.`
    ]);
  }
  return pick([
    `${face}가 나왔습니다. 선택이 한 끗 어긋났습니다.`,
    `마지막 회전에서 반대면으로 넘어갔습니다.`
  ]);
}

function diceFlavor(userTotal, botTotal, isWin, isTie) {
  if (isTie) {
    return pick([
      `나와 딜러가 같은 눈 ${userTotal}. 테이블이 조용해집니다.`,
      `무승부. 칩은 제자리로 돌아갑니다.`
    ]);
  }
  if (isWin) {
    return pick([
      `내 주사위 ${userTotal}, 딜러 ${botTotal}. 테이블을 가져왔습니다.`,
      `마지막 주사위가 기울어 ${userTotal}로 이겼습니다.`
    ]);
  }
  return pick([
    `딜러가 ${botTotal}로 받아쳤습니다. 나는 ${userTotal}.`,
    `한 눈 차이로 밀렸습니다. ${userTotal} vs ${botTotal}`
  ]);
}

function lotteryFlavor(symbols, multiplier, isWin) {
  const line = `${symbols[0]} ${symbols[1]} ${symbols[2]}`;
  if (Number(multiplier) >= 40) return `복권 용지가 빛납니다. ${line}`;
  if (isWin && Number(multiplier) >= 8) return `트리플이 드러났습니다. ${line}`;
  if (isWin) return `두 칸이 같습니다. ${line} 소액 당첨.`;
  return pick([
    `긁고 나니 흩어진 그림입니다. ${line}`,
    `이번 장은 꽝입니다. ${line}`
  ]);
}

function rouletteFlavor(choice, color, emoji, isWin) {
  const names = { RED: '레드', BLACK: '블랙', GREEN: '그린' };
  const landed = names[color] || color;
  const picked = names[choice] || choice;
  if (color === 'GREEN' && isWin) {
    return `구슬이 0에 멈췄습니다. ${emoji} 그린 잭팟!`;
  }
  if (isWin) {
    return pick([
      `구슬이 ${landed}에 안착했습니다. 선택한 색과 같습니다.`,
      `${emoji} ${landed}. 칩이 돌아옵니다.`
    ]);
  }
  if (color === 'GREEN') {
    return `구슬이 0에 들어갔습니다. ${emoji} 내 색은 ${picked}.`;
  }
  return pick([
    `마지막 칸에서 ${landed}로 기울었습니다. 선택은 ${picked}.`,
    `${emoji} ${landed}. 아슬아슬하게 빗나갔습니다.`
  ]);
}

function highlowFlavor(roll, multiplier, isWin) {
  const n = Number(roll);
  if (n >= 90) {
    return pick([
      `${n}! 바늘이 빨간 구간을 뚫고 올라갔습니다.`,
      `대박 구간. ${n}점이 찍혔습니다.`
    ]);
  }
  if (isWin) {
    return pick([
      `${n}. 60선을 넘겼습니다.`,
      `바늘이 ${n}에서 멈췄습니다. 배당 구간.`
    ]);
  }
  if (n >= 55) {
    return `${n}. 60이 코앞이었습니다.`;
  }
  return pick([
    `${n}. 바늘이 중간에 힘을 잃었습니다.`,
    `이번 굴림은 ${n}. 기준선에 닿지 못했습니다.`
  ]);
}

function totoCall(match) {
  if (!match) return '';
  if (match.status !== 'open') {
    if (match.result === 'home') return `${match.home} 승리로 종료`;
    if (match.result === 'away') return `${match.away} 승리로 종료`;
    if (match.result === 'draw') return '무승부로 종료';
    return '경기 종료';
  }
  const sec = Math.max(0, Number(match.remainSec) || 0);
  if (sec > 80) return '경기 시작 · 흐름을 읽는 중';
  if (sec > 40) return `접전 · 남은 ${sec}초`;
  if (sec > 12) return `종료 직전 · ${sec}초`;
  return `휘슬 직전! ${sec}초`;
}

function crashCall(phase, multiplier, crashAt) {
  if (phase === 'betting') return '이륙 전 배팅 창이 열려 있습니다.';
  if (phase === 'flying') {
    const m = Number(multiplier) || 1;
    if (m < 1.3) return '이륙. 아직 낮습니다.';
    if (m < 2) return '상승 중. 탈출 타이밍을 재세요.';
    return `${m.toFixed(2)}x 비행 중. 욕심과 타이밍.`;
  }
  return `CRASH ${Number(crashAt || multiplier).toFixed(2)}x`;
}

async function runStagedEmbed(interaction, steps) {
  if (!Array.isArray(steps) || steps.length === 0) return;
  await interaction.reply({ embeds: [steps[0].embed] });
  for (let i = 1; i < steps.length; i++) {
    const wait = Number(steps[i].delay) || 700;
    await sleep(wait);
    try {
      await interaction.editReply({ embeds: [steps[i].embed] });
    } catch (e) {}
  }
}

function showEmbed(title, description, color) {
  const EmbedBuilder = discordEmbed();
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color || COLORS.GAMBLE)
    .setTimestamp()
    .setFooter({ text: '월덕 카지노' });
}

function reelFrame(parts) {
  const cells = parts.map((p) => p || '❔').join(' │ ');
  return `╔══════════════╗\n║  ${cells}  ║\n╚══════════════╝`;
}

module.exports = {
  pick,
  sleep,
  moneyTail,
  slotFlavor,
  coinFlavor,
  diceFlavor,
  lotteryFlavor,
  rouletteFlavor,
  highlowFlavor,
  totoCall,
  crashCall,
  runStagedEmbed,
  showEmbed,
  reelFrame,
  COLORS
};
