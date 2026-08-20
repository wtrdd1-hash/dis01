const { SlashCommandBuilder } = require('discord.js');
const { createCustomEmbed } = require('../../utils/embedBuilder');
const {
  registerLenderLicense,
  createLoanOffer,
  acceptLoanOffer,
  repayLoan,
  requestCourtForeclosure,
  getMyP2PLoans,
  LICENSE_FEE
} = require('../../utils/p2pLoanEngine');
const { formatMoney } = require('../../utils/formatters');
const { parseKoreanOrNumericAmount } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('대부업')
    .setDescription('🏦 유저 간 P2P 사채/대부업, 담보 대출 및 법원 강제 징수 시스템')
    
    // 1. 면허 발급
    .addSubcommand(sub =>
      sub.setName('면허발급')
        .setDescription('🏛️ 50만원 면허세를 국고에 납부하고 공인 대부업 면허를 취득합니다.')
        .addStringOption(opt =>
          opt.setName('상호명')
            .setDescription('대부업체 상호명 (예: 황금오리 파이낸셜, 덕스 캐피탈)')
            .setRequired(false)
        )
    )

    // 2. 대출 제안
    .addSubcommand(sub =>
      sub.setName('대출제안')
        .setDescription('💰 다른 유저에게 담보 대출을 제안합니다. (면허 소지자 전용)')
        .addUserOption(opt => opt.setName('차입자').setDescription('돈을 빌릴 유저').setRequired(true))
        .addStringOption(opt => opt.setName('원금').setDescription('빌려줄 금액 (예: 100만, 500000)').setRequired(true))
        .addNumberOption(opt => opt.setName('이자율').setDescription('약정 이자율 % (법정 최고 이자율 최대 30% 이하)').setRequired(true))
        .addIntegerOption(opt => opt.setName('만기시간').setDescription('만기 기간 (시간 단위, 예: 24, 72)').setRequired(true))
        .addStringOption(opt =>
          opt.setName('담보종류')
            .setDescription('담보 설정 종류 (주식 / 예금 / 무담보)')
            .setRequired(true)
            .addChoices(
              { name: '📈 주식 담보', value: 'stock' },
              { name: '🏦 예금 담보', value: 'bank' },
              { name: '❌ 무담보 (신용)', value: 'none' }
            )
        )
        .addStringOption(opt => opt.setName('담보주식종목').setDescription('주식 담보일 때 종목 코드 (예: WTRD, MINE, TECH, AICH 등)').setRequired(false))
        .addNumberOption(opt => opt.setName('담보주식수').setDescription('주식 담보일 때 주식 수량').setRequired(false))
        .addStringOption(opt => opt.setName('담보예금액').setDescription('예금 담보일 때 동결할 예금 금액 (예: 50만)').setRequired(false))
    )

    // 3. 계약 수락
    .addSubcommand(sub =>
      sub.setName('계약수락')
        .setDescription('🤝 제안받은 대출 계약을 승인하고 담보 동결 후 대출금을 수령합니다.')
        .addIntegerOption(opt => opt.setName('대출번호').setDescription('승인할 대출 계약 ID 번호').setRequired(true))
    )

    // 4. 대출 상환
    .addSubcommand(sub =>
      sub.setName('상환')
        .setDescription('💸 빌린 원금과 이자를 상환하고 동결된 담보를 돌려받습니다. (이자소득세 15% 국고 원천징수)')
        .addIntegerOption(opt => opt.setName('대출번호').setDescription('상환할 대출 계약 ID 번호').setRequired(true))
    )

    // 5. 법원 강제 징수
    .addSubcommand(sub =>
      sub.setName('법원강제징수')
        .setDescription('⚖️ 만기가 지난 미변제 채무에 대해 법원에 강제 집행 및 담보/자산 압류를 신청합니다.')
        .addIntegerOption(opt => opt.setName('대출번호').setDescription('강제 집행을 신청할 대출 ID 번호').setRequired(true))
    )

    // 6. 내역 조회
    .addSubcommand(sub =>
      sub.setName('내역')
        .setDescription('📋 나의 대부업 면허 상태 및 대출/대여 계약 현황을 조회합니다.')
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.globalName || interaction.user.username;

    try {
      // 1. 면허 발급
      if (sub === '면허발급') {
        const businessName = interaction.options.getString('상호명');
        const res = await registerLenderLicense(userId, businessName);

        const embed = createCustomEmbed({
          title: `🏛️ [국세청 / 금융감독원] 대부업 등록 면허증 발급 완료`,
          description: `**@${username}** 님에게 공식 **P2P 대부업 면허**가 발급되었습니다.`,
          color: 0x10b981,
          fields: [
            { name: '🏢 상호명', value: `\`${res.businessName}\``, inline: true },
            { name: '🏛️ 납부 면허세 (국고 귀속)', value: `\`${formatMoney(LICENSE_FEE)}\``, inline: true },
            { name: '📜 법정 규정 준수 안내', value: '• 법정 최고 이자율: **최대 30% 이하**\n• 이자 소득세: 이자 발생 시 **15% 국고 원천징수**\n• 만기 연체 시: **법원 강제 징수(담보 압류) 신청 가능**', inline: false }
          ]
        });
        return interaction.editReply({ embeds: [embed] });
      }

      // 2. 대출 제안
      if (sub === '대출제안') {
        const target = interaction.options.getUser('차입자');
        const principalStr = interaction.options.getString('원금');
        const interestRate = interaction.options.getNumber('이자율');
        const hours = interaction.options.getInteger('만기시간');
        const cType = interaction.options.getString('담보종류');
        const stockId = interaction.options.getString('담보주식종목');
        const stockAmt = interaction.options.getNumber('담보주식수');
        const bankStr = interaction.options.getString('담보예금액');

        const principalBig = parseKoreanOrNumericAmount(principalStr);
        if (!principalBig || principalBig <= 0n) {
          return interaction.editReply({ content: '대출 원금 금액이 올바르지 않습니다. (예: 100만, 500000)' });
        }

        let bankAmtBig = 0n;
        if (bankStr) {
          bankAmtBig = parseKoreanOrNumericAmount(bankStr) || 0n;
        }

        const offer = await createLoanOffer({
          lenderId: userId,
          borrowerId: target.id,
          principal: principalBig,
          interestRatePercent: interestRate,
          durationHours: hours,
          collateralType: cType,
          collateralStockId: stockId,
          collateralStockAmt: stockAmt,
          collateralBankAmt: bankAmtBig
        });

        let colText = '❌ 무담보 (신용 대출)';
        if (cType === 'stock') colText = `📈 주식 담보: **${offer.collateralStockId} ${offer.collateralStockAmount}주**`;
        if (cType === 'bank') colText = `🏦 예금 담보: **${formatMoney(offer.collateralBankAmount)}**`;

        const embed = createCustomEmbed({
          title: `📝 [대출 계약서] P2P 대출 제안서 등록 (대출번호 #${offer.loanId})`,
          description: `**${offer.lenderBusiness}** (@${username}) 대부업자가 <@${target.id}> 님에게 대출을 제안했습니다.`,
          color: 0x38bdf8,
          fields: [
            { name: '💰 대출 원금', value: `**${offer.principalText}**`, inline: true },
            { name: '📊 약정 이자율', value: `**${offer.interestRate}%** (+${offer.interestAmountText})`, inline: true },
            { name: '💎 총 만기 상환액', value: `**${offer.totalDueText}**`, inline: true },
            { name: '⏱️ 대출 기간 / 만기', value: `**${offer.durationHours}시간**`, inline: true },
            { name: '🔒 담보 설정 조건', value: colText, inline: true },
            { name: '👉 수락 방법', value: `차입자 <@${target.id}> 님이 \`/대부업 계약수락 ${offer.loanId}\` 명령어를 입력하면 담보 동결과 함께 대출금이 지급됩니다.`, inline: false }
          ]
        });
        return interaction.editReply({ embeds: [embed] });
      }

      // 3. 계약 수락
      if (sub === '계약수락') {
        const loanId = interaction.options.getInteger('대출번호');
        const res = await acceptLoanOffer(loanId, userId);

        const embed = createCustomEmbed({
          title: `🤝 [계약 체결] 대출 계약 체결 및 원금 지급 완료`,
          description: `대출번호 **#${res.loanId}** 계약이 정상 체결되었습니다. 담보가 동결되었으며 대출 원금이 지갑으로 지급되었습니다.`,
          color: 0x10b981,
          fields: [
            { name: '💵 수령 원금', value: `**${res.principalText}**`, inline: true },
            { name: '💎 만기 상환 총액', value: `**${res.totalDueText}**`, inline: true },
            { name: '⏰ 만기 일시', value: `\`${new Date(res.dueAt).toLocaleString('ko-KR')}\``, inline: false },
            { name: '⚠️ 주의 사항', value: '만기일까지 상환하지 않을 경우 채권자가 법원에 **강제 징수(담보 몰수 및 계좌 압류)**를 신청할 수 있습니다.', inline: false }
          ]
        });
        return interaction.editReply({ embeds: [embed] });
      }

      // 4. 대출 상환
      if (sub === '상환') {
        const loanId = interaction.options.getInteger('대출번호');
        const res = await repayLoan(loanId, userId);

        const embed = createCustomEmbed({
          title: `🎉 [대출 완제] 대출금 전액 상환 및 담보 반환 완료`,
          description: `대출번호 **#${res.loanId}** 원리금이 성공적으로 상환되었으며 동결되었던 담보가 전액 반환되었습니다.`,
          color: 0x10b981,
          fields: [
            { name: '💸 상환 총액', value: `**${res.repaidTotalText}**`, inline: true },
            { name: '🏛️ 이자소득세 (15% 국고 납부)', value: `\`${res.taxPaidText}\``, inline: true },
            { name: '💰 채권자 실수령액', value: `**${res.netLenderText}**`, inline: true }
          ]
        });
        return interaction.editReply({ embeds: [embed] });
      }

      // 5. 법원 강제 징수
      if (sub === '법원강제징수') {
        const loanId = interaction.options.getInteger('대출번호');
        const res = await requestCourtForeclosure(loanId, userId);

        const embed = createCustomEmbed({
          title: `⚖️ [대법원 판결] 강제 집행 승인 및 즉시 압류 집행 명령`,
          description: `대출번호 **#${loanId}** 건에 대한 채무 불이행이 확인되어 법원이 **강제 징수 및 담보 몰수를 자동 승인**하고 즉시 집행했습니다.`,
          color: 0xef4444,
          fields: [
            { name: '⚖️ 법원 판결', value: `\`${res.verdict}\``, inline: false },
            { name: '📋 청구 채권액', value: `**${res.claimedAmountText}**`, inline: true },
            { name: '💰 강제 회수 총액', value: `**${res.recoveredAmountText}**`, inline: true },
            { name: '🏛️ 법원 집행 수수료 (5% 국고)', value: `\`${res.courtFeeText}\``, inline: true },
            { name: '💵 채권자 최종 배당액', value: `**${res.netLenderText}**`, inline: true },
            { name: '📝 집행 상세 내역', value: res.executionDetails.map(d => `• ${d}`).join('\n') || '집행 완료', inline: false }
          ]
        });
        return interaction.editReply({ embeds: [embed] });
      }

      // 6. 내역 조회
      if (sub === '내역') {
        const data = await getMyP2PLoans(userId);

        let licText = '❌ 미보유 (`/대부업 면허발급`으로 취득 가능)';
        if (data.lenderLicense) {
          licText = `✅ **공인 면허 보유** (상호: \`${data.lenderLicense.business_name}\` | 누적 대출: ${formatMoney(data.lenderLicense.total_lent)} | 납부 세금: ${formatMoney(data.lenderLicense.total_tax_paid)})`;
        }

        let lentText = data.lentList.length === 0 ? '대여(빌려준) 내역이 없습니다.' : data.lentList.map(l => {
          const st = l.status === 'active' ? '🟢 진행중' : (l.status === 'repaid' ? '🔵 상환완료' : (l.status === 'foreclosed' ? '🔴 강제집행' : '🟡 대기'));
          return `• **[#${l.id}]** 차입자 <@${l.borrower_id}> | 원금 ${formatMoney(l.principal)} | 이자 ${l.interest_rate}% | 만기 ${new Date(l.due_at).toLocaleDateString()} | ${st}`;
        }).join('\n');

        let borrowedText = data.borrowedList.length === 0 ? '차입(빌린) 내역이 없습니다.' : data.borrowedList.map(l => {
          const st = l.status === 'active' ? '🟢 진행중' : (l.status === 'repaid' ? '🔵 상환완료' : (l.status === 'foreclosed' ? '🔴 강제집행' : '🟡 대기'));
          return `• **[#${l.id}]** 채권자 <@${l.lender_id}> | 상환액 **${formatMoney(l.total_due)}** | 만기 ${new Date(l.due_at).toLocaleDateString()} | ${st}`;
        }).join('\n');

        const embed = createCustomEmbed({
          title: `📋 @${username} 님의 P2P 대부업 & 대출 장부 현황`,
          description: `대부업 면허 상태 및 실시간 대출/대여 계약 내역입니다.`,
          color: 0x38bdf8,
          fields: [
            { name: '🏢 대부업 공식 면허', value: licText, inline: false },
            { name: '💰 내가 빌려준 대출 (채권)', value: lentText, inline: false },
            { name: '💳 내가 빌린 대출 (채무)', value: borrowedText, inline: false }
          ]
        });
        return interaction.editReply({ embeds: [embed] });
      }

    } catch (err) {
      console.error('대부업 실행 오류:', err);
      return interaction.editReply({ content: `❌ **오류:** ${err.message || '요청을 처리하지 못했습니다.'}` });
    }
  }
};
