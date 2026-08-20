const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');
const { updateStockPrices, adjustStockPrice, adjustAllStocksRatio } = require('../../utils/stockEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_stock')
    .setDescription('[관리자] 주식 가격을 수동 조절하거나 비율(%) 일괄 변동 이벤트를 실행합니다.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('가격구현')
        .setDescription('특정 주식의 시세를 수동 설정합니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('종목 ID (예: WTRD, MINE, CASN, BANK, NEKO, SCRP, CHKN, SLOT)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('설정가격')
            .setDescription('새 가격 (예: 10000, 5만, 1양)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('비율조절')
        .setDescription('전 종목의 가격을 지정 비율(%)만큼 일괄 조절합니다. (예: 10 = +10%, -15 = -15%)')
        .addIntegerOption(option =>
          option.setName('변동비율')
            .setDescription('변동할 비율 (%) (예: 10, 20, -10, -20)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('강제변동')
        .setDescription('유저 상황 및 시황을 반영하여 전체 주식 시장 시세를 강제로 1회 갱신합니다.')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('상장폐지')
        .setDescription('부실 종목을 상장폐지하고 주주들에게 청산금을 환급합니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('상장폐지할 종목 ID (예: WTRD, MINE, BIOX 등)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('청산단가')
            .setDescription('주당 청산금 (기본: 30원)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('사유')
            .setDescription('상장폐지 사유')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('재상장')
        .setDescription('상장폐지된 종목을 거래소에 전격 재상장(Re-IPO)합니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('재상장할 종목 ID (예: WTRD, MINE, CASN 등)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('재상장가')
            .setDescription('새 기준 시작가 (예: 5000, 1만, 기본: 1000원)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('사유')
            .setDescription('재상장 승인 사유')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('액면분할')
        .setDescription('초고가 주식을 1:N 비율로 액면분할하여 주가를 낮추고 주식 수를 늘립니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('액면분할할 종목 ID (예: WTRD, SCRP 등)')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName('분할비율')
            .setDescription('1주당 분할할 배수 (예: 2=1:2분할, 5=1:5분할, 10=1:10분할)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('사유')
            .setDescription('액면분할 사유 (기본: 유동성 공급 및 거래 활성화)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('기업분할')
        .setDescription('모회사에서 핵심 사업부를 떼어내어 신설회사로 인적분할 상장하고 주주들에게 신주를 배정합니다.')
        .addStringOption(option =>
          option.setName('모회사코드')
            .setDescription('분할할 모회사 종목 ID (예: SCRP, SPAC, BIOX 등)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('신설코드')
            .setDescription('새로 상장할 신설 자회사 종목 ID (예: SCRP_AI, SPAC_R)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('신설회사명')
            .setDescription('신설 자회사 종목명 (예: 이지스크랩 인공지능, 덕스 에어로로봇)')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName('자회사비율')
            .setDescription('신설 자회사 가치 비중 % (예: 40 = 자회사 40%, 모회사 60%)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('사유')
            .setDescription('인적분할 상장 사유')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('신규상장')
        .setDescription('대기 중인 혁신 기업을 주식 시장에 신규 IPO 상장합니다.')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('추가')
        .setDescription('관리자가 원하는 커스텀 주식을 즉시 신규 상장합니다.')
        .addStringOption(option =>
          option.setName('종목코드')
            .setDescription('종목 ID (2~10자 영문 대문자, 예: GOOGL, SAM, META)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('종목명')
            .setDescription('종목명 (예: 구글 알파벳, 삼성 전자)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('공모가')
            .setDescription('시작 공모가 (예: 5000, 1만, 50만)')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('섹터')
            .setDescription('업종/섹터 (예: IT/기술, 반도체, 바이오, 엔터)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('기업설명')
            .setDescription('기업 상세 설명')
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === '강제변동') {
      await updateStockPrices();
      const embed = createAdminEmbed(
        '📈 관리자 주가 강제 갱신 완료',
        '유저 실거래량 및 유동성 상황이 반영되어 전체 주식 시장의 종목 시세가 갱신되었습니다!'
      );
      return interaction.reply({ embeds: [embed] });
    } else if (subcommand === '비율조절') {
      const pct = interaction.options.getInteger('변동비율');
      const results = await adjustAllStocksRatio(pct, `관리자(@${interaction.user.username}) 디스코드 명령어 조절`);
      const summaryList = results.map(r => `• **${r.name}** (\`${r.stockId}\`): ${formatMoney(r.oldPrice)} ➔ **${formatMoney(r.newPrice)}** (${r.rate > 0 ? '+' : ''}${r.rate}%)`).join('\n');

      const embed = createAdminEmbed(
        `📊 전 종목 ${pct > 0 ? '+' : ''}${pct}% 일괄 가격 조절 완료`,
        `**조절 사유:** 관리자 수동 시장 개입\n\n${summaryList}`
      );
      return interaction.reply({ embeds: [embed] });
    } else if (subcommand === '가격구현') {
      const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
      const rawPrice = interaction.options.getString('설정가격');
      const { parseAdminMoney } = require('../../utils/moneyScale');
      let newPriceInt;
      try {
        newPriceInt = parseAdminMoney(rawPrice, '원');
      } catch (e) {
        return interaction.reply({
          embeds: [createErrorEmbed('주가 조절 실패', e.message || '가격을 확인하세요.')],
          flags: MessageFlags.Ephemeral
        });
      }
      if (!newPriceInt || newPriceInt < 10n) {
        return interaction.reply({
          embeds: [createErrorEmbed('주가 조절 실패', '주가는 최소 10원 이상이어야 합니다. 예: 10000, 5만, 1양')],
          flags: MessageFlags.Ephemeral
        });
      }

      try {
        const result = await adjustStockPrice(stockIdInput, newPriceInt, `관리자(@${interaction.user.username}) 디스코드 명령어 지정가 조절`);
        const embed = createAdminEmbed(
          '관리자 주가 조절 완료',
          `**종목:** ${result.name} (\`${result.stockId}\`)\n` +
          `**기존 가격:** ${formatMoney(result.oldPrice)}\n` +
          `**변경된 신규 가격:** **${formatMoney(result.newPrice)}** (${result.rate > 0 ? '+' : ''}${result.rate}%)`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('주가 조절 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '상장폐지') {
      const stockId = interaction.options.getString('종목코드').toUpperCase().trim();
      const rawLiq = interaction.options.getString('청산단가') || '30';
      const reason = interaction.options.getString('사유') || `관리자(@${interaction.user.username}) 직권 상장폐지`;
      const { parseAdminMoney } = require('../../utils/moneyScale');
      const { executeDelisting } = require('../../utils/stockEngine');

      try {
        const parsedLiq = parseAdminMoney(rawLiq, '원') || 30n;
        const res = await executeDelisting(stockId, reason, parsedLiq);

        const embed = createAdminEmbed(
          '💥 [상장폐지 & 청산 완료]',
          `**종목명:** ${res.stockName} (\`${res.stockId}\`)\n` +
          `**청산 사유:** ${reason}\n` +
          `**청산 주주 수:** ${res.liquidatedUsers}명\n` +
          `**총 환급 청산금:** **${res.totalPayoutText}**\n\n` +
          `💡 해당 종목의 주식은 전량 소각되었으며 주주들에게 현금으로 청산금이 지급되었습니다.`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('상장폐지 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '재상장') {
      const stockId = interaction.options.getString('종목코드').toUpperCase().trim();
      const rawPrice = interaction.options.getString('재상장가') || '1000';
      const reason = interaction.options.getString('사유') || `관리자(@${interaction.user.username}) 특별 승인 재상장`;
      const { parseAdminMoney } = require('../../utils/moneyScale');
      const { relistStock } = require('../../utils/stockEngine');

      try {
        const parsedPrice = parseAdminMoney(rawPrice, '원') || 1000n;
        const res = await relistStock(stockId, { price: parsedPrice, reason });

        const embed = createAdminEmbed(
          '🎉 [기업 회생 & 거래소 전격 재상장 완료]',
          `**기업명:** **${res.stockName}** (\`${res.stockId}\`)\n` +
          `**재상장 기준가:** **${res.priceFormatted}**\n` +
          `**섹터:** \`${res.sector || '기타'}\`\n` +
          `**승인 사유:** ${res.reason}\n\n` +
          `✨ 거래소에 전격 재상장(Relisting) 완료되어 금일부터 정상 거래 및 소수점 매매가 재개됩니다!`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('재상장 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '액면분할') {
      const stockId = interaction.options.getString('종목코드').toUpperCase().trim();
      const ratio = interaction.options.getInteger('분할비율');
      const reason = interaction.options.getString('사유') || `관리자(@${interaction.user.username}) 주식 액면분할 단행`;
      const { executeStockSplit } = require('../../utils/stockEngine');

      try {
        const res = await executeStockSplit(stockId, ratio, reason);

        const embed = createAdminEmbed(
          '⚡ [주식 액면분할 (Stock Split) 단행 완료]',
          `**종목명:** **${res.stockName}** (\`${res.stockId}\`)\n` +
          `**분할 비율:** **1 : ${res.ratio}**\n` +
          `**주가 변동:** **${res.oldPriceFormatted}** ➔ **${res.newPriceFormatted}** (1/${res.ratio}로 조정)\n` +
          `**배정 대상 주주:** 총 **${res.affectedUsers}명** (보유 주식 수 ${res.ratio}배 자동 증가)\n` +
          `**분할 사유:** ${res.reason}\n\n` +
          `💡 모든 주주의 총 보유 평가액과 매수 원금 가치는 100% 온전하게 보존되었습니다.`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('액면분할 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '기업분할') {
      const parentStockId = interaction.options.getString('모회사코드').toUpperCase().trim();
      const newStockId = interaction.options.getString('신설코드').toUpperCase().trim();
      const newStockName = interaction.options.getString('신설회사명').trim();
      const rawRatio = interaction.options.getInteger('자회사비율') || 40;
      const reason = interaction.options.getString('사유') || `관리자(@${interaction.user.username}) 기업 인적분할 단행`;
      const { executeSpinOff } = require('../../utils/stockEngine');

      try {
        const ratio = Math.max(0.1, Math.min(0.9, rawRatio / 100));
        const res = await executeSpinOff(parentStockId, newStockId, newStockName, ratio, null, reason);

        const embed = createAdminEmbed(
          '🏢 [기업 인적분할 (Corporate Spin-off) 신규 상장 완료]',
          `**존속 모회사:** **${res.parentName}** (\`${res.parentStockId}\`)\n` +
          `  └ 조정 주가: **${res.parentNewPriceFormatted}** (${100 - Math.round(res.splitRatio * 100)}% 가치)\n\n` +
          `**신설 자회사:** **${res.newStockName}** (\`${res.newStockId}\`)\n` +
          `  └ 신규 공모가: **${res.newStockPriceFormatted}** (${Math.round(res.splitRatio * 100)}% 가치)\n\n` +
          `**주주 무상 신주 배정:** 모회사 주주 총 **${res.affectedUsers}명**에게 1:1 지분율대로 [${res.newStockName}] 신주 100% 무상 배정 완료!\n` +
          `**분할 사유:** ${res.reason}\n\n` +
          `✨ 두 종목 모두 실시간 매매 및 소수점 거래가 즉시 시작됩니다.`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('기업분할 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '신규상장') {
      const { launchNewIPOStock } = require('../../utils/stockEngine');
      try {
        const ipo = await launchNewIPOStock();
        if (!ipo) {
          return interaction.reply({
            embeds: [createErrorEmbed('신규 상장 실패', '대기 중인 신규 IPO 후보가 없습니다.')],
            flags: MessageFlags.Ephemeral
          });
        }

        const embed = createAdminEmbed(
          '🚀 [신규 혁신 기업 IPO 공모 상장 완료]',
          `**기업명:** ${ipo.name} (\`${ipo.stock_id}\`)\n` +
          `**공모가:** **${formatMoney(ipo.price)}**\n` +
          `**섹터:** ${ipo.sector}\n` +
          `**기업 개요:** ${ipo.description}\n\n` +
          `🎉 가상 주식 거래소에 신규 상장되어 지금 즉시 웹 및 디스코드에서 매매가 가능합니다!`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('신규 상장 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (subcommand === '추가') {
      const stockId = interaction.options.getString('종목코드').toUpperCase().trim();
      const name = interaction.options.getString('종목명').trim();
      const rawPrice = interaction.options.getString('공모가');
      const sector = interaction.options.getString('섹터') || '신규상장';
      const description = interaction.options.getString('기업설명') || '관리자 신규 상장 기업';

      const { parseAdminMoney } = require('../../utils/moneyScale');
      const { createCustomStock } = require('../../utils/stockEngine');

      let parsedPrice;
      try {
        parsedPrice = parseAdminMoney(rawPrice, '원');
      } catch (e) {
        return interaction.reply({
          embeds: [createErrorEmbed('신규 상장 실패', '공모가 형식을 확인하세요. 예: 5000, 1만, 50만')],
          flags: MessageFlags.Ephemeral
        });
      }

      if (!parsedPrice || parsedPrice < 10n) {
        return interaction.reply({
          embeds: [createErrorEmbed('신규 상장 실패', '공모가는 최소 10원 이상이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }

      try {
        const result = await createCustomStock({
          stockId,
          name,
          price: parsedPrice,
          sector,
          description
        });

        const embed = createAdminEmbed(
          '👑 [관리자 커스텀 주식 신규 상장 완료]',
          `**기업명:** **${result.name}** (\`${result.stockId}\`)\n` +
          `**공모가:** **${result.priceFormatted}**\n` +
          `**업종/섹터:** \`${result.sector}\`\n` +
          `**기업 설명:** ${result.description}\n\n` +
          `🎉 가상 주식 거래소에 즉시 상장 완료되었습니다! (웹 대시보드 & 디스코드에서 바로 거래 가능)`
        );
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({
          embeds: [createErrorEmbed('신규 상장 실패', err.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};
