/**
 * 🦆 디스코드 명령어 임베드 디자인 통일 헬퍼
 *
 * 모든 명령어가 일관된 디자인 패턴을 따르도록 강제합니다:
 * - 색상: 카테고리별 통일 (현금=초록, 주식=노랑, 카지노=빨강, 사업=보라, 은행=파랑)
 * - 푸터: "🦆 WTRD · 실행 시각 · /도움말" 통일
 * - 썸네일: 유저 아바타 (조회)
 * - 필드: 라벨에는 카테고리 이모지 항상
 * - 수치는 tabular-nums (가독성)
 */

const COLORS = {
  cash: 0x34d399,       // #34d399 에메랄드
  bank: 0x60a5fa,       // #60a5fa 파랑
  stock: 0xfbbf24,      // #fbbf24 골드
  business: 0xa78bfa,   // #a78bfa 보라
  gamble: 0xf87171,     // #f87171 빨강
  loan: 0xfb923c,       // #fb923c 주황
  info: 0x38bdf8,       // #38bdf8 인포 블루
  positive: 0x22c55e,   // #22c55e 그린
  negative: 0xef4444,   // #ef4444 레드
  warning: 0xf59e0b,    // #f59e0b 앰버
  premium: 0xa855f7,    // #a855f7 퍼플
  neutral: 0x6366f1     // #6366f1 인디고
};

/**
 * 통일된 푸터 생성
 */
function buildFooter(interaction) {
  const now = new Date();
  const ts = now.toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const avatarUrl = (interaction && interaction.client && interaction.client.user && typeof interaction.client.user.displayAvatarURL === 'function')
    ? interaction.client.user.displayAvatarURL()
    : '';
  const footer = { text: `🦆 WTRD · ${ts} · /도움말` };
  // iconURL은 Discord.js가 URL 검증을 하므로 빈 문자열이면 생략
  if (avatarUrl && avatarUrl.startsWith('http')) footer.iconURL = avatarUrl;
  return footer;
}

/**
 * 통일된 임베드 빌더
 */
function wEmbed({ interaction, category = 'info', title, desc = '', fields = [], thumbnail = null, image = null }) {
  const color = COLORS[category] || COLORS.info;
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp(new Date());
  if (desc) embed.setDescription(desc);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);
  if (fields && fields.length > 0) embed.addFields(...fields);
  const footer = buildFooter(interaction || { client: { user: { displayAvatarURL: () => '' } } });
  embed.setFooter(footer);
  return embed;
}

/**
 * 에러 임베드
 * @param {object} interactionOrTitle - Discord interaction 객체 또는 임베드 제목 문자열
 * @param {string} message - 에러 메시지
 * @param {string} [detail] - 상세 정보(선택)
 */
function errorEmbed(interactionOrTitle, message, detail) {
  const { EmbedBuilder } = require('discord.js');
  // 시그니처 호환: (title, message) 또는 (interaction, message, detail) 둘 다 지원
  let title, desc;
  if (typeof interactionOrTitle === 'string') {
    title = interactionOrTitle;
    desc = message;
    detail = undefined;
  } else {
    title = '❌ 오류';
    desc = detail ? `${message}\n\`\`\`${String(detail).slice(0, 1500)}\`\`\`` : message;
  }
  const footer = buildFooter(typeof interactionOrTitle === 'object' && interactionOrTitle
    ? interactionOrTitle
    : { client: { user: { displayAvatarURL: () => '' } } });
  return new EmbedBuilder()
    .setColor(COLORS.negative)
    .setTitle(title)
    .setDescription(desc)
    .setTimestamp(new Date())
    .setFooter(footer);
}

/**
 * 성공 임베드
 */
function successEmbed(interaction, title, desc) {
  return wEmbed({
    interaction, category: 'positive',
    title: '✓ ' + title, desc
  });
}

/**
 * 정보 임베드
 */
function infoEmbed(interaction, title, desc) {
  return wEmbed({
    interaction, category: 'info',
    title: 'ℹ ' + title, desc
  });
}

/**
 * 관리자 임베드 (별칭)
 */
function adminEmbed(interaction, title, desc, opts = {}) {
  return wEmbed({
    interaction, category: opts.category || 'info',
    title, desc, fields: opts.fields, thumbnail: opts.thumbnail
  });
}

/**
 * 도박 임베드 (별칭)
 */
function gambleEmbed(interaction, title, desc, opts = {}) {
  return wEmbed({
    interaction, category: 'gamble',
    title, desc, fields: opts.fields
  });
}

/**
 * 경제/주식 임베드 (별칭)
 */
function economyEmbed(interaction, title, desc, opts = {}) {
  return wEmbed({
    interaction, category: opts.category || 'cash',
    title, desc, fields: opts.fields, thumbnail: opts.thumbnail, image: opts.image
  });
}

function stockEmbed(interaction, title, desc, opts = {}) {
  return wEmbed({
    interaction, category: 'stock',
    title, desc, fields: opts.fields, thumbnail: opts.thumbnail, image: opts.image
  });
}

module.exports = {
  COLORS,
  wEmbed,
  errorEmbed,
  successEmbed,
  infoEmbed,
  buildFooter,
  adminEmbed,
  gambleEmbed,
  economyEmbed,
  stockEmbed
};

// 🔁 별칭(alias): 옛 create* 함수명을 사용하는 호출부 호환을 위해 즉시 매핑
const _origExport = module.exports;
_origExport.createErrorEmbed = errorEmbed;
_origExport.createSuccessEmbed = successEmbed;
_origExport.createInfoEmbed = infoEmbed;
_origExport.createAdminEmbed = adminEmbed;
_origExport.createGambleEmbed = gambleEmbed;
_origExport.createEconomyEmbed = economyEmbed;
_origExport.createStockEmbed = stockEmbed;
