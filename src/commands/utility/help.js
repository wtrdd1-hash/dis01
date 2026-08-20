const { SlashCommandBuilder } = require('discord.js');
const { createEconomyEmbed } = require('../../utils/embedBuilder');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('도움말')
    .setDescription('사용 가능한 슬래시 명령어 목록을 확인합니다.'),

  async execute(interaction) {
    const embed = createEconomyEmbed(
      '📖 월덕 봇 도움말',
      [
        '**경제**',
        '`/지갑` `/출석` `/지원금` `/송금` `/은행` `/일하기` `/사업` `/순위` `/클리커`',
        '',
        '**주식**',
        '`/주식시세` `/주식차트` `/주식매수` `/주식매도` `/포트폴리오`',
        '',
        '**도박**',
        '`/도박` `/슬롯` `/동전` `/블랙잭` `/룰렛` `/경마` (단승·복승·연승·복연승·쌍승)',
        '',
        '**유틸**',
        '`/문의` `/말하기` `/tts` `/핑` `/도움말`',
        '',
        '웹 대시보드: https://easy-scraping.com  →  상단 ? 또는 키보드 ?'
      ].join('\n')
    );

    await interaction.reply({ embeds: [embed] });
  }
};
