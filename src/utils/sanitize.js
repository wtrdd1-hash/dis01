/**
 * URL·아바타·문의 이미지 등 공개 출력용 값 검증
 */
const ALLOWED_INQUIRY_CATEGORIES = new Set([
  '🐞 버그 / 오류 제보',
  '💡 기능 제안 / 아이디어',
  '💰 계정 / 자산 복구 문의',
  '💬 기타 1:1 일반 문의',
  '일반 문의',
  '시스템 오류',
  '경제/계정',
  '기능 건의',
  '기타'
]);

const DISCORD_CDN_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net'
]);

const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
const MAX_INQUIRY_IMAGE_BYTES = 1.5 * 1024 * 1024;
const STOCK_ID_RE = /^[A-Za-z0-9]{1,16}$/;

function sanitizeInquiryCategory(raw) {
  const value = String(raw || '').trim();
  if (ALLOWED_INQUIRY_CATEGORIES.has(value)) return value;
  return '일반 문의';
}

function isDiscordCdnUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && DISCORD_CDN_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (e) {
    return false;
  }
}

function safeImageUrl(url) {
  const value = String(url || '').trim();
  if (/^\/uploads\/inquiries\/[A-Za-z0-9._-]+\.(jpg|jpeg|png)$/i.test(value)) return value;
  if (isDiscordCdnUrl(value)) return value;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol === 'https:' &&
      (host === 'easy-scraping.com' || host === 'www.easy-scraping.com') &&
      /^\/uploads\/inquiries\/[A-Za-z0-9._-]+\.(jpg|jpeg|png)$/i.test(parsed.pathname)
    ) {
      return parsed.pathname;
    }
  } catch (e) {}
  return '';
}

function safeAvatarUrl(userId, avatar) {
  const av = String(avatar || '').trim();
  if (!av) return DEFAULT_AVATAR;
  if (isDiscordCdnUrl(av)) return av;
  const id = String(userId || '');
  if (/^\d{5,32}$/.test(id) && /^[a-zA-Z0-9_-]+$/.test(av)) {
    return `https://cdn.discordapp.com/avatars/${id}/${av}.png`;
  }
  return DEFAULT_AVATAR;
}

function parseInquiryImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const matches = dataUrl.trim().match(/^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!matches) return null;
  let buf;
  try {
    buf = Buffer.from(matches[2].replace(/\s/g, ''), 'base64');
  } catch (e) {
    return null;
  }
  if (!buf || buf.length < 24 || buf.length > MAX_INQUIRY_IMAGE_BYTES) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
  const isJpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (isPng) return { ext: 'png', buf };
  if (isJpg) return { ext: 'jpg', buf };
  return null;
}

function isValidStockId(stockId) {
  return STOCK_ID_RE.test(String(stockId || ''));
}

module.exports = {
  ALLOWED_INQUIRY_CATEGORIES,
  DEFAULT_AVATAR,
  MAX_INQUIRY_IMAGE_BYTES,
  sanitizeInquiryCategory,
  safeImageUrl,
  safeAvatarUrl,
  parseInquiryImage,
  isValidStockId,
  isDiscordCdnUrl
};
