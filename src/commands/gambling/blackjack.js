const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags
} = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createGambleEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  // 셔플
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calculateScore(cards) {
  let score = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.value === 'A') {
      aces += 1;
      score += 11;
    } else if (['K', 'Q', 'J'].includes(card.value)) {
      score += 10;
    } else {
      score += parseInt(card.value, 10);
    }
  }

  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }

  return score;
}

function formatHand(cards, hideSecond = false) {
  if (hideSecond && cards.length >= 2) {
    return `${cards[0].suit}${cards[0].value} [🂠 카드 가림]`;
  }
  return cards.map(c => `${c.suit}${c.value}`).join(' ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('🃏 대화형 버튼 클릭 기반 블랙잭 카지노 게임을 플레이합니다.')
    .addStringOption(option =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액 또는 "올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const betInput = interaction.options.getString('배팅금액').trim();
    const userId = interaction.user.id;

    const userData = await getOrCreateUser(userId);
    const userCash = BigInt(userData.cash);

    let betAmount = 0n;
    if (betInput === '올인' || betInput === '전체' || betInput === 'all') {
      betAmount = userCash;
    } else {
      const parsed = parseInt(betInput, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '배팅 금액은 1,000원 이상의 정수 또는 "올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      betAmount = BigInt(parsed);
    }

    if (betAmount < 1000n) {
      return interaction.reply({
        embeds: [createErrorEmbed('배팅 제한', '최소 배팅 금액은 1,000원입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (userCash < betAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `보유 현금(${formatMoney(userCash)})이 배팅금(${formatMoney(betAmount)})보다 부족합니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const deck = createDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];

    let playerScore = calculateScore(playerHand);
    let dealerScore = calculateScore(dealerHand);

    // 즉시 블랙잭 판정
    if (playerScore === 21) {
      const payout = BigInt(Math.floor(Number(betAmount) * 2.5));
      const profit = payout - betAmount;
      const newCash = userCash + profit;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);

      const embed = createGambleEmbed(
        '🃏 블랙잭 - 💥 내츄럴 블랙잭 잭팟!',
        `👤 **내 패 (${playerScore}점):** ${formatHand(playerHand)}\n` +
        `🤖 **딜러 패 (${dealerScore}점):** ${formatHand(dealerHand)}\n\n` +
        `🎉 **21점 블랙잭으로 2.5배 당첨금을 획득하셨습니다!**\n\n` +
        `💰 **배팅금:** ${formatMoney(betAmount)}\n` +
        `🎁 **획득금:** ${formatMoney(payout)}\n` +
        `💳 **현재 잔액:** **${formatMoney(newCash)}**`
      );
      return interaction.reply({ embeds: [embed] });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hit').setLabel('🎯 히트 (Hit)').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('stand').setLabel('✋ 스탠드 (Stand)').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('double').setLabel('💰 더블다운 (Double Down)').setStyle(ButtonStyle.Danger)
    );

    const renderGameEmbed = (statusText = '당신의 선택을 아래 버튼으로 선택하세요.') => {
      return createGambleEmbed(
        '🃏 블랙잭 (Blackjack)',
        `👤 **내 패 (${calculateScore(playerHand)}점):** ${formatHand(playerHand)}\n` +
        `🤖 **딜러 패:** ${formatHand(dealerHand, true)}\n\n` +
        `💵 **현재 배팅금:** ${formatMoney(betAmount)}\n` +
        `💡 ${statusText}`
      );
    };

    const response = await interaction.reply({
      embeds: [renderGameEmbed()],
      components: [row],
      fetchReply: true
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 45000 // 45초 제한시간
    });

    collector.on('collect', async i => {
      if (i.user.id !== userId) {
        return i.reply({ content: '이 게임은 명령어를 실행한 유저만 조작할 수 있습니다.', ephemeral: true });
      }

      if (i.customId === 'double') {
        const doubleBet = betAmount * 2n;
        if (userCash < doubleBet) {
          return i.reply({ content: '더블다운을 위한 잔액이 부족합니다.', ephemeral: true });
        }
        betAmount = doubleBet;
        playerHand.push(deck.pop());
        playerScore = calculateScore(playerHand);
        collector.stop('finished');
        await i.deferUpdate();
        return;
      }

      if (i.customId === 'hit') {
        playerHand.push(deck.pop());
        playerScore = calculateScore(playerHand);

        if (playerScore >= 21) {
          collector.stop('finished');
          await i.deferUpdate();
          return;
        }

        // 더블다운 버튼 비활성화 후 메시지 업데이트
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hit').setLabel('🎯 히트 (Hit)').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('stand').setLabel('✋ 스탠드 (Stand)').setStyle(ButtonStyle.Success)
        );

        await i.update({
          embeds: [renderGameEmbed('한 장 더 받으시겠습니까, 혹은 멈추시겠습니까?')],
          components: [updatedRow]
        });
      } else if (i.customId === 'stand') {
        collector.stop('finished');
        await i.deferUpdate();
      }
    });

    collector.on('end', async (collected, reason) => {
      // 딜러 턴 (17점 이상이 될 때까지 계속 뽑기)
      playerScore = calculateScore(playerHand);
      if (playerScore <= 21) {
        while (calculateScore(dealerHand) < 17) {
          dealerHand.push(deck.pop());
        }
      }
      dealerScore = calculateScore(dealerHand);

      let multiplier = 0;
      let outcomeMsg = '';

      if (playerScore > 21) {
        multiplier = 0;
        outcomeMsg = '💀 **버스트! 21점을 초과하여 패배하셨습니다.**';
      } else if (dealerScore > 21) {
        multiplier = 2;
        outcomeMsg = '🎉 **딜러 버스트! 딜러가 21점을 넘겨 승리하셨습니다! (2배)**';
      } else if (playerScore > dealerScore) {
        multiplier = 2;
        outcomeMsg = '🎉 **승리! 딜러보다 높은 점수로 승리하셨습니다! (2배)**';
      } else if (playerScore === dealerScore) {
        multiplier = 1;
        outcomeMsg = '👔 **무승부! 배팅금을 돌려받습니다.**';
      } else {
        multiplier = 0;
        outcomeMsg = '💀 **패배! 딜러의 점수가 더 높습니다.**';
      }

      const payout = betAmount * BigInt(multiplier);
      const profit = payout - betAmount;
      const newCash = userCash + profit;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);
      await pool.query(
        'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "blackjack", ?, ?, ?)',
        [userId, betAmount.toString(), payout.toString(), profit.toString()]
      );

      const finalEmbed = createGambleEmbed(
        '🃏 블랙잭 게임 종료 결과',
        `👤 **내 패 (${playerScore}점):** ${formatHand(playerHand)}\n` +
        `🤖 **딜러 패 (${dealerScore}점):** ${formatHand(dealerHand)}\n\n` +
        `${outcomeMsg}\n\n` +
        `💰 **최종 배팅금:** ${formatMoney(betAmount)}\n` +
        `🎁 **획득금:** ${formatMoney(payout)}\n` +
        `💳 **현재 잔액:** **${formatMoney(newCash)}**`
      );

      await interaction.editReply({ embeds: [finalEmbed], components: [] });
    });
  }
};
