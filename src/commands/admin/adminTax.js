const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { logAdminAction } = require('../../utils/logger');
const { setTaxPolicyOverride } = require('../../utils/economyBalancer');
const {
  getTaxOverview,
  previewCollectFromUser,
  collectFromUser,
  previewWealthTax,
  collectWealthTax,
  previewFlatCollect,
  collectFlatFromAll,
  refundFromTreasury,
  withdrawTreasuryByAdmin,
  previewSettleRefund,
  settleTaxRefund
} = require('../../utils/taxEngine');

function ephemeralError(message) {
  return {
    embeds: [createErrorEmbed('세금 처리 실패', message)],
    flags: MessageFlags.Ephemeral
  };
}

function previewText(preview) {
  const lines = [
    `대상 **${preview.count || preview.payerCount || 0}명**`,
    `합계 **${preview.totalText || preview.refundPoolText || preview.levyText || '0원'}**`
  ];
  if (preview.note) lines.push(preview.note);
  if (preview.periodCollectedText) {
    lines.push(`기간 징수 ${preview.periodCollectedText}`);
    lines.push(`국고 잔여(환급 후) ${preview.remainTreasuryText}`);
  }
  const samples = preview.samples || [];
  if (samples.length) {
    lines.push(samples.map((s) => `• @${s.username} ${s.levyText || s.refundText}`).join('\n'));
  }
  return lines.join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_tax')
    .setDescription('[관리자] 세금 징수, 세율 잠금, 국고 환급/연말정산')
    .addSubcommand((sub) => sub.setName('현황').setDescription('세율·국고·다음 자산세 시각'))
    .addSubcommand((sub) =>
      sub.setName('징수')
        .setDescription('특정 유저 현금 징수')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addStringOption((o) =>
          o.setName('방식')
            .setDescription('징수 방식')
            .setRequired(true)
            .addChoices(
              { name: '지정 금액', value: 'amount' },
              { name: '현금 비율(%)', value: 'cash_percent' },
              { name: '현재 세율', value: 'policy_rate' },
              { name: '임시 세율(%)', value: 'custom_rate' }
            )
        )
        .addStringOption((o) => o.setName('값').setDescription('금액 또는 % (현재 세율이면 생략 가능)'))
        .addStringOption((o) => o.setName('사유').setDescription('로그에 남길 사유'))
        .addBooleanOption((o) => o.setName('실행').setDescription('true면 징수, false/생략이면 미리보기'))
    )
    .addSubcommand((sub) =>
      sub.setName('자산세')
        .setDescription('기준 초과 유저 자산세 즉시 징수')
        .addBooleanOption((o) => o.setName('실행').setDescription('true면 징수, 생략이면 미리보기'))
    )
    .addSubcommand((sub) =>
      sub.setName('전원')
        .setDescription('일반 유저 전원 현금 징수')
        .addStringOption((o) =>
          o.setName('방식')
            .setDescription('징수 방식')
            .setRequired(true)
            .addChoices(
              { name: '지정 금액', value: 'amount' },
              { name: '현금 비율(%)', value: 'cash_percent' },
              { name: '현재 세율', value: 'policy_rate' },
              { name: '임시 세율(%)', value: 'custom_rate' }
            )
        )
        .addStringOption((o) => o.setName('값').setDescription('금액 또는 %'))
        .addBooleanOption((o) => o.setName('실행').setDescription('true면 징수, 생략이면 미리보기'))
        .addStringOption((o) => o.setName('사유').setDescription('사유'))
    )
    .addSubcommand((sub) =>
      sub.setName('세율')
        .setDescription('세율·기준을 바꾸고 자동 조절에서 잠금')
        .addNumberOption((o) => o.setName('퍼센트').setDescription('0~15').setMinValue(0).setMaxValue(15))
        .addStringOption((o) => o.setName('기준').setDescription('자산세 기준 (예: 500만, 1양)'))
    )
    .addSubcommand((sub) => sub.setName('자동').setDescription('세금 정책을 자동 조절에 맡김'))
    .addSubcommand((sub) =>
      sub.setName('환급')
        .setDescription('국고에서 특정 유저에게 환급')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addStringOption((o) => o.setName('금액').setDescription('환급 금액 (예: 5만, 500양)').setRequired(true))
        .addStringOption((o) => o.setName('사유').setDescription('사유'))
    )
    .addSubcommand((sub) =>
      sub.setName('출금')
        .setDescription('국고에서 관리자 지갑 또는 특정 유저에게 자금 출금')
        .addStringOption((o) => o.setName('금액').setDescription('출금 금액 (예: 1000만, 500양)').setRequired(true))
        .addUserOption((o) => o.setName('수령자').setDescription('수령할 유저 (비우면 관리자 본인 지갑)'))
        .addStringOption((o) => o.setName('사유').setDescription('출금 사유'))
    )
    .addSubcommand((sub) =>
      sub.setName('연말정산')
        .setDescription('기간 납세액 비례 환급. 나머지는 국고에 남김')
        .addNumberOption((o) => o.setName('퍼센트').setDescription('환급 비율 0~100').setMinValue(0).setMaxValue(100).setRequired(true))
        .addIntegerOption((o) => o.setName('시간').setDescription('최근 몇 시간 (기본 8760=1년)').setMinValue(1).setMaxValue(10000))
        .addBooleanOption((o) => o.setName('실행').setDescription('true면 환급, 생략이면 미리보기'))
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const sub = interaction.options.getSubcommand();
    try {
      if (sub === '현황') {
        const tax = await getTaxOverview();
        const nextMin = Math.max(0, Math.ceil((Number(tax.nextCycleAt) - Date.now()) / 60000));
        const embed = createAdminEmbed(
          '🏛️ 세금 · 국고',
          `세율 **${(tax.rate * 100).toFixed(1)}%** ${tax.locked ? '(잠금)' : '(자동)'}\n` +
          `자산세 기준 **${formatMoney(tax.threshold)}** (현금+예금)\n` +
          `국고 **${formatMoney(tax.treasury)}**\n` +
          `24시간 징수 **${formatMoney(tax.last24h)}**\n` +
          `다음 자동 자산세 약 **${nextMin}분** 후`
        );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === '징수') {
        const user = interaction.options.getUser('유저');
        const mode = interaction.options.getString('방식');
        const value = interaction.options.getString('값');
        const run = interaction.options.getBoolean('실행') === true;
        const reason = interaction.options.getString('사유') || `디스코드 관리자 징수 (@${interaction.user.username})`;
        if (!run) {
          const preview = await previewCollectFromUser(user.id, mode, value);
          return interaction.reply({
            embeds: [createAdminEmbed('세금 미리보기', `<@${user.id}> ${previewText(preview)}\n실행하려면 \`실행: True\``)],
            flags: MessageFlags.Ephemeral
          });
        }
        const result = await collectFromUser(user.id, mode, value, reason);
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_COLLECT', user.id, result);
        return interaction.reply({
          embeds: [createAdminEmbed('세금 징수', `<@${user.id}> **-${result.tookText}**\n현금 ${formatMoney(result.before)} → ${formatMoney(result.after)}`)]
        });
      }

      if (sub === '자산세') {
        const run = interaction.options.getBoolean('실행') === true;
        if (!run) {
          const preview = await previewWealthTax();
          return interaction.reply({
            embeds: [createAdminEmbed('자산세 미리보기', `${previewText(preview)}\n실행하려면 \`실행: True\``)],
            flags: MessageFlags.Ephemeral
          });
        }
        const result = await collectWealthTax();
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_WEALTH', 'wealth', {
          count: result.count,
          collected: result.collected.toString()
        });
        return interaction.reply({
          embeds: [createAdminEmbed('자산세 징수', `${result.count}명, ${formatMoney(result.collected)} 국고 흡수`)]
        });
      }

      if (sub === '전원') {
        const mode = interaction.options.getString('방식');
        const value = interaction.options.getString('값');
        const run = interaction.options.getBoolean('실행') === true;
        const reason = interaction.options.getString('사유') || `디스코드 전원 징수 (@${interaction.user.username})`;
        if (!run) {
          const preview = await previewFlatCollect(mode, value);
          return interaction.reply({
            embeds: [createAdminEmbed('전원 징수 미리보기', `${previewText(preview)}\n실행하려면 \`실행: True\``)],
            flags: MessageFlags.Ephemeral
          });
        }
        const result = await collectFlatFromAll(mode, value, reason);
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_FLAT', 'flat', result);
        return interaction.reply({
          embeds: [createAdminEmbed('전원 징수', `${result.count}명, ${result.collectedText}`)]
        });
      }

      if (sub === '세율') {
        const pct = interaction.options.getNumber('퍼센트');
        const threshold = interaction.options.getString('기준');
        const payload = { locked: true };
        if (pct !== null) payload.rate = pct / 100;
        if (threshold !== null) payload.threshold = threshold;
        const settings = await setTaxPolicyOverride(payload);
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_POLICY', 'lock', payload);
        return interaction.reply({
          embeds: [createAdminEmbed(
            '세금 정책 잠금',
            `세율 **${(settings.taxRate * 100).toFixed(1)}%**\n기준 **${formatMoney(settings.wealthThresholdForTax)}**\n자동 조절이 덮지 않습니다. \`/admin_tax 자동\` 으로 해제.`
          )]
        });
      }

      if (sub === '자동') {
        await setTaxPolicyOverride({ locked: false });
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_POLICY', 'auto', {});
        return interaction.reply({
          embeds: [createAdminEmbed('세금 자동 조절', '잠금을 풀었습니다. 다음 주기부터 세율이 다시 계산됩니다.')]
        });
      }

      if (sub === '환급') {
        const user = interaction.options.getUser('유저');
        const amount = interaction.options.getString('금액');
        const reason = interaction.options.getString('사유') || `디스코드 국고 환급 (@${interaction.user.username})`;
        const result = await refundFromTreasury(user.id, amount, reason);
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_REFUND', user.id, result);
        return interaction.reply({
          embeds: [createAdminEmbed('국고 환급', `<@${user.id}> **+${result.gaveText}**\n남은 국고 ${formatMoney(result.treasury)}`)]
        });
      }

      if (sub === '출금') {
        const amount = interaction.options.getString('금액');
        const user = interaction.options.getUser('수령자');
        const reason = interaction.options.getString('사유') || `디스코드 관리자 국고 출금 (@${interaction.user.username})`;
        const targetId = user ? user.id : interaction.user.id;
        const result = await withdrawTreasuryByAdmin(interaction.user.id, amount, targetId, reason);
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_WITHDRAW', targetId, result);
        return interaction.reply({
          embeds: [createAdminEmbed(
            '🏛️ 국고 자금 출금 완료',
            `수령자: <@${result.recipientId}>\n출금액: **+${result.withdrawnText}**\n변동 후 지갑: **${formatMoney(result.after)}**\n국고 잔액: **${result.treasuryText}**`
          )]
        });
      }

      if (sub === '연말정산') {
        const percent = interaction.options.getNumber('퍼센트');
        const hours = interaction.options.getInteger('시간') || (24 * 365);
        const run = interaction.options.getBoolean('실행') === true;
        if (!run) {
          const preview = await previewSettleRefund(percent, hours);
          return interaction.reply({
            embeds: [createAdminEmbed('연말정산 미리보기', `${previewText(preview)}\n실행하려면 \`실행: True\``)],
            flags: MessageFlags.Ephemeral
          });
        }
        const result = await settleTaxRefund(percent, hours, `디스코드 연말정산 (@${interaction.user.username})`);
        await logAdminAction(interaction.user.id, interaction.user.username, 'DISCORD_TAX_SETTLE', 'settle', result);
        return interaction.reply({
          embeds: [createAdminEmbed('연말정산', `${result.count}명에게 ${result.givenText} 환급. 남은 국고 ${result.leftoverText}`)]
        });
      }
    } catch (err) {
      return interaction.reply(ephemeralError(err.message || '처리에 실패했습니다.'));
    }
  }
};
