const { EmbedBuilder } = require('discord.js');

const COLORS = {
  PRIMARY: 0x5865F2,   // Discord Blurple
  SUCCESS: 0x2ECC71,   // Green
  ERROR: 0xE74C3C,     // Red
  WARNING: 0xF1C40F,   // Yellow
  GOLD: 0xFFD700,      // Gold Economy
  STOCK: 0x3498DB,     // Blue Stock
  GAMBLE: 0x9B59B6,    // Purple Gamble
  ADMIN: 0xE67E22      // Orange Admin
};

function createBaseEmbed(title, description = '', color = COLORS.PRIMARY) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: '💰 디스코드 경제 & 주식 봇' });
}

function createSuccessEmbed(title, description) {
  return createBaseEmbed(`✅ ${title}`, description, COLORS.SUCCESS);
}

function createErrorEmbed(title, description) {
  return createBaseEmbed(`❌ ${title}`, description, COLORS.ERROR);
}

function createWarningEmbed(title, description) {
  return createBaseEmbed(`⚠️ ${title}`, description, COLORS.WARNING);
}

function createEconomyEmbed(title, description) {
  return createBaseEmbed(title, description, COLORS.GOLD);
}

function createStockEmbed(title, description) {
  return createBaseEmbed(title, description, COLORS.STOCK);
}

function createGambleEmbed(title, description) {
  return createBaseEmbed(title, description, COLORS.GAMBLE);
}

function createAdminEmbed(title, description) {
  return createBaseEmbed(`👑 ${title}`, description, COLORS.ADMIN);
}

module.exports = {
  COLORS,
  createBaseEmbed,
  createSuccessEmbed,
  createErrorEmbed,
  createWarningEmbed,
  createEconomyEmbed,
  createStockEmbed,
  createGambleEmbed,
  createAdminEmbed
};
