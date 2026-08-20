const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, parseMoneyInput } = require('../../utils/formatters');
const { safeBigInt, applyBankTransfer } = require('../../utils/money');
const { getCurrentInterestRate } = require('../../utils/bankEngine');
const { BANK } = require('../../utils/economyBalance');
const { getPublicLoanView, borrowLoan, repayLoan, getLockedCollateral } = require('../../utils/loanEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('은행')
    .setDescription('🏦 덕스 중앙은행 예금 계좌를 관리하고 이자 수익을 얻습니다.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('정보')
        .setDescription('🏦 내 예금 계좌 현황 및 현재 기준금리를 확인합니다.')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('저금')
        .setDescription('현금을 은행 예금에 저금합니다.')
        .addStringOption(option =>
          option.setName('금액')
            .setDescription('저금할 금액(예: 5만, 1억, 50000) 또는 "올인"')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('인출')
        .setDescription('은행 예금에서 현금을 인출합니다.')
        .addStringOption(option =>
          option.setName('금액')
            .setDescription('인출할 금액(예: 5만, 1억, 50000) 또는 "올인"')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('대출')
        .setDescription('예금을 담보로 대출을 받습니다.')
        .addStringOption(option =>
          option.setName('금액')
            .setDescription('대출 금액(예: 5만, 올인) — 예금의 50%까지')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('상환')
        .setDescription('대출을 갚습니다. 금액을 생략하면 전액입니다.')
        .addStringOption(option =>
          option.setName('금액')
            .setDescription('상환 금액 또는 "전액"')
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    const userData = await getOrCreateUser(userId, username);
    let cash = safeBigInt(userData.cash);
    let bank = safeBigInt(userData.bank);
    const rate = getCurrentInterestRate();
    const hourlyPct = (rate * 60 * 100).toFixed(3);
    const { mulRate } = require('../../utils/moneyScale');
    const hourlyExpected = mulRate(bank, rate * 60);

    if (subcommand === '정보') {
      const loan = await getPublicLoanView(userId);
      let loanText = '';
      if (loan.exempt) {
        loanText = `\n💳 **대출:** 관리자 계정은 대출할 수 없습니다.`;
      } else if (loan.hasLoan) {
        const dueLine = loan.overdue
          ? '**연체** — 카지노·주식 매수가 막혀 있습니다.'
          : `만기까지 약 **${Math.floor((Number(loan.dueInSec) || 0) / 3600)}시간 ${Math.floor(((Number(loan.dueInSec) || 0) % 3600) / 60)}분**`;
        loanText =
          `\n💳 **대출 채무:** **${formatMoney(loan.debt)}** (원금 ${formatMoney(loan.principal)} + 이자 ${formatMoney(loan.interest)})\n` +
          `🔒 **담보 예금:** **${formatMoney(loan.collateral)}** (인출 불가)\n` +
          `⏰ ${dueLine}`;
      } else {
        const creditPct = Math.round((Number(loan.creditFactor) || 1) * 100);
        loanText =
          `\n💳 **대출 한도:** **${formatMoney(loan.maxBorrow || 0)}** (예금의 50% · 신용 ${creditPct}%)\n` +
          `📈 대출 이자 **${loan.rateText || '시간당 0.15%'}**, 만기 **${loan.termHours || 24}시간**\n` +
          `💡 \`/은행 대출\` 로 받고 \`/은행 상환\` 으로 갚습니다.`;
      }
      const embed = new EmbedBuilder()
        .setColor(loan.overdue ? 0xEF4444 : 0x3B82F6)
        .setTitle('🏦 덕스 중앙은행 계좌 정보 & 실시간 기준금리')
        .setDescription(
          `👤 **예금주:** **@${interaction.user.username}**\n\n` +
          `🏦 **보유 예금 잔고:** **${formatMoney(bank)}**\n` +
          `💵 **보유 현금 잔고:** **${formatMoney(cash)}**\n\n` +
          `─────────────────────────────\n` +
          `📈 **중앙은행 기준금리:** **시간당 ${hourlyPct}%** (${BANK.LABEL} 기준, 1분마다 분할 지급)\n` +
          `🎁 **1시간 예상 이자:** **+${formatMoney(hourlyExpected)}**\n` +
          `─────────────────────────────` +
          loanText +
          `\n\n💡 *은행에 예금해 두시면 1분마다 이자가 자동으로 입금됩니다. 담보 예금에도 이자가 붙습니다.*`
        )
        .setFooter({ text: '덕스 중앙은행 • 안전한 자산 관리' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (subcommand === '저금') {
      const inputAmount = interaction.options.getString('금액');
      const depositAmount = parseMoneyInput(inputAmount, cash);
      if (!depositAmount || typeof depositAmount !== 'bigint' || depositAmount <= 0n) {
        return interaction.reply({ embeds: [createErrorEmbed('입력 오류', '올바른 금액(예: 5만, 1억, 50000) 또는 "올인"을 입력하세요.')], flags: MessageFlags.Ephemeral });
      }

      if (cash < depositAmount) {
        return interaction.reply({ embeds: [createErrorEmbed('현금 부족', `보유 현금이 부족합니다!\n현재 현금: **${formatMoney(cash)}**`)], flags: MessageFlags.Ephemeral });
      }

      let newCash;
      let newBank;
      try {
        const moved = await applyBankTransfer(userId, -depositAmount, depositAmount);
        newCash = moved.cash;
        newBank = moved.bank;
      } catch (err) {
        if (err.code === 'INSUFFICIENT_FUNDS') {
          return interaction.reply({ embeds: [createErrorEmbed('현금 부족', `보유 현금이 부족합니다!\n현재 현금: **${formatMoney(cash)}**`)], flags: MessageFlags.Ephemeral });
        }
        throw err;
      }

      const embed = createSuccessEmbed(
        '은행 저금 완료 🏦',
        `**저금된 금액:** **${formatMoney(depositAmount)}**\n\n` +
        `💵 **남은 현금:** **${formatMoney(newCash)}**\n` +
        `🏦 **총 은행 예금:** **${formatMoney(newBank)}**\n\n` +
        `📈 **적용 예금금리:** **시간당 ${hourlyPct}%** (1분마다 분할 지급)`
      );
      return interaction.reply({ embeds: [embed] });

    } else if (subcommand === '인출') {
      const inputAmount = interaction.options.getString('금액');
      let locked = 0n;
      try { locked = await getLockedCollateral(userId); } catch (e) {}
      const freeBank = bank > locked ? bank - locked : 0n;
      if (freeBank <= 0n) {
        return interaction.reply({
          embeds: [createErrorEmbed('인출 불가', locked > 0n
            ? `담보로 묶인 예금 **${formatMoney(locked)}**은 인출할 수 없습니다. 대출을 먼저 갚으세요.`
            : '인출할 은행 예금이 없습니다.')],
          flags: MessageFlags.Ephemeral
        });
      }

      const withdrawAmount = parseMoneyInput(inputAmount, freeBank);
      if (!withdrawAmount || typeof withdrawAmount !== 'bigint' || withdrawAmount <= 0n) {
        return interaction.reply({ embeds: [createErrorEmbed('입력 오류', '올바른 금액(예: 5만, 1억, 50000) 또는 "올인"을 입력하세요.')], flags: MessageFlags.Ephemeral });
      }

      if (withdrawAmount > freeBank) {
        return interaction.reply({
          embeds: [createErrorEmbed('예금 부족', `인출 가능 예금은 **${formatMoney(freeBank)}**입니다.` + (locked > 0n ? `\n담보 잠금: **${formatMoney(locked)}**` : ''))],
          flags: MessageFlags.Ephemeral
        });
      }

      let newCash;
      let newBank;
      try {
        const moved = await applyBankTransfer(userId, withdrawAmount, -withdrawAmount);
        newCash = moved.cash;
        newBank = moved.bank;
      } catch (err) {
        if (err.code === 'INSUFFICIENT_FUNDS' || err.code === 'COLLATERAL_LOCKED') {
          return interaction.reply({
            embeds: [createErrorEmbed('인출 불가', err.code === 'COLLATERAL_LOCKED' ? err.message : `은행 예금이 부족합니다!\n현재 예금: **${formatMoney(bank)}**`)],
            flags: MessageFlags.Ephemeral
          });
        }
        throw err;
      }

      const embed = createSuccessEmbed(
        '은행 인출 완료 🏦',
        `**인출된 금액:** **${formatMoney(withdrawAmount)}**\n\n` +
        `💵 **현재 현금:** **${formatMoney(newCash)}**\n` +
        `🏦 **남은 은행 예금:** **${formatMoney(newBank)}**`
      );
      return interaction.reply({ embeds: [embed] });
    } else if (subcommand === '대출') {
      const inputAmount = interaction.options.getString('금액');
      try {
        const loan = await borrowLoan(userId, username, inputAmount);
        const embed = createSuccessEmbed(
          '대출 실행 💳',
          `**받은 금액:** **${formatMoney(loan.principal)}** (현금으로 입금)\n` +
          `🔒 **담보 예금:** **${formatMoney(loan.collateral)}** (만기까지 인출 불가)\n` +
          `📈 **이자:** ${loan.rateText} · **만기:** ${loan.termHours}시간\n\n` +
          `💵 **현금:** **${formatMoney(loan.cash)}**\n` +
          `🏦 **예금:** **${formatMoney(loan.bank)}**\n\n` +
          `갚을 때는 \`/은행 상환\` 을 쓰세요. 이자는 그때까지 붙은 분만 냅니다.`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('대출 불가', err.message || '대출을 처리할 수 없습니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '상환') {
      const inputAmount = interaction.options.getString('금액');
      try {
        const loan = await repayLoan(userId, username, inputAmount);
        const embed = createSuccessEmbed(
          loan.hasLoan ? '일부 상환 완료 💳' : '대출 완납 💳',
          loan.hasLoan
            ? `남은 채무 **${formatMoney(loan.debt)}** (원금 ${formatMoney(loan.principal)} + 이자 ${formatMoney(loan.interest)})\n` +
              `🔒 남은 담보 **${formatMoney(loan.collateral)}**\n\n` +
              `💵 **현금:** **${formatMoney(loan.cash)}**\n🏦 **예금:** **${formatMoney(loan.bank)}**`
            : `대출을 모두 갚았습니다. 담보 예금이 풀렸습니다.\n\n💵 **현금:** **${formatMoney(loan.cash)}**\n🏦 **예금:** **${formatMoney(loan.bank)}**`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('상환 불가', err.message || '상환을 처리할 수 없습니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};
