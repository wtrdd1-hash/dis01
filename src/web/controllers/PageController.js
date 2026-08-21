'use strict';

const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const session = require('../session');
const CosmeticLoadoutService = require('../../core/economy/CosmeticLoadoutService');
const UserModel = require('../../models/UserModel');
const StockModel = require('../../models/StockModel');
const { getCurrentMarketRegime } = require('../../utils/stockEngine');

class PageController {
  static async getCommonData(req, res) {
    const discordUser = session.getSessionUser(req);
    let currentUser = null;

    if (discordUser && discordUser.id) {
      session.touchSessionCookie(req, res, discordUser);
      currentUser = {
        id: discordUser.id,
        username: discordUser.username || '사용자',
        avatar: discordUser.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png',
        isDiscordUser: true
      };
    }

    const isAdmin = Boolean(currentUser && config.isAdmin(currentUser.id));

    let userBalance = { cash: 0n, bank: 0n };
    let userLoadout = {};

    if (currentUser) {
      try {
        userBalance = await UserModel.getBalance(currentUser.id);
      } catch (e) {}

      try {
        const loadoutRes = await CosmeticLoadoutService.getUserLoadout(currentUser.id);
        if (loadoutRes && loadoutRes.loadout) userLoadout = loadoutRes.loadout;
      } catch (e) {}
    }

    const cashFormatted = Number(userBalance.cash).toLocaleString();
    const bankFormatted = Number(userBalance.bank).toLocaleString();

    return {
      user: currentUser,
      userAssets: {
        cash: userBalance.cash,
        bank: userBalance.bank,
        cashFormatted,
        bankFormatted
      },
      userLoadout,
      isAdmin
    };
  }

  static async renderHome(req, res) {
    const discordUser = session.getSessionUser(req);
    if (discordUser && discordUser.id) {
      return res.redirect(302, '/stocks');
    }

    try {
      const { renderLandingPage } = require('../landingPage');
      const stocks = await StockModel.getAllStocks();
      const regime = getCurrentMarketRegime();
      const [leaderboard] = await pool.query(`
        SELECT discord_id, username, cash, bank, (cash + bank) AS net_worth
        FROM users ORDER BY net_worth DESC LIMIT 10
      `);

      const html = renderLandingPage({
        stocks,
        leaderboard,
        regime,
        news: null,
        treasuryBalance: '500000000',
        discordLoginUrl: '/auth/discord'
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      console.error('[PageController] renderLandingPage fallback:', e);
      res.render('landing');
    }
  }

  static async renderPlaza(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      const loadout = common.userLoadout || {};
      const isUnlocked = Boolean(loadout.NAME_COLOR || loadout.PROFILE_FRAME || loadout.BADGE || loadout.TITLE);

      res.render('plaza', {
        ...common,
        isUnlocked,
        pageTitle: 'VIP 메타버스 라운지',
        activePage: 'plaza'
      });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }

  static async renderStocks(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      const stocks = await StockModel.getAllStocks();
      const regime = getCurrentMarketRegime();
      let holdings = [];
      let totalStockVal = 0n;
      try {
        holdings = await StockModel.getUserHoldings(common.user.id);
        totalStockVal = holdings.reduce((sum, h) => sum + BigInt(h.evalVal || 0), 0n);
      } catch (e) {}

      res.render('stocks', {
        ...common,
        stocks,
        regime,
        holdings,
        totalStockVal,
        pageTitle: '실시간 주식 거래소',
        activePage: 'stocks'
      });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }

  static async renderCasino(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      res.render('casino', { ...common, pageTitle: '카지노 & 핫게임', activePage: 'casino' });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }

  static async renderArcade(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      res.render('arcade', { ...common, pageTitle: '보석 맞추기 퍼즐', activePage: 'casino' });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }

  static async renderMining(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      res.render('mining', { ...common, pageTitle: '채굴 & 대장간', activePage: 'mining' });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }

  static async renderRanking(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      const [leaderboard] = await pool.query(`
        SELECT discord_id, username, cash, bank, (cash + bank) AS net_worth
        FROM users ORDER BY net_worth DESC LIMIT 50
      `);
      res.render('ranking', { ...common, leaderboard, pageTitle: '자산 순위', activePage: 'ranking' });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }

  static async renderShop(req, res) {
    const discordUser = session.getSessionUser(req);
    if (!discordUser || !discordUser.id) {
      return res.redirect(302, '/');
    }

    try {
      const common = await PageController.getCommonData(req, res);
      const PrestigeShopService = require('../../core/economy/PrestigeShopService');
      const WorkshopService = require('../../core/economy/WorkshopService');
      const DuckHouseService = require('../../core/economy/DuckHouseService');
      const InventoryModel = require('../../models/InventoryModel');

      const userId = common.user.id;
      const catalog = await PrestigeShopService.listCatalog({ userId });
      const recipes = await WorkshopService.listRecipes();
      
      let house = { level: 1, levelName: '기본 방', maxSlots: 3, slots: [] };
      let pedestals = [];
      let inventory = [];
      let shards = 0;

      try {
        const houseState = await DuckHouseService.getDuckHouse(userId);
        if (houseState) {
          house = houseState.house;
          pedestals = houseState.slots;
        }
      } catch (e) {}

      try {
        inventory = await InventoryModel.getUserInventory(userId);
      } catch (e) {}

      try {
        const materials = await WorkshopService.getUserMaterials(userId);
        shards = Number(materials.goldenFeatherShards || 0);
      } catch (e) {}

      res.render('shop', {
        ...common,
        catalog,
        recipes,
        loadout: common.userLoadout,
        shards,
        house,
        pedestals,
        inventory,
        userCash: common.userAssets.cash,
        userBank: common.userAssets.bank,
        megaphoneActive: false,
        megaphoneMessage: '',
        pageTitle: '명품관 & 외형 드레스룸',
        activePage: 'shop'
      });
    } catch (e) {
      res.status(500).send('서버 오류: ' + e.message);
    }
  }
}

module.exports = PageController;
