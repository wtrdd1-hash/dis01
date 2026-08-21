'use strict';

const UserModel = require('../../models/UserModel');
const StockModel = require('../../models/StockModel');
const CosmeticLoadoutService = require('../../core/economy/CosmeticLoadoutService');
const { getPublicTaxView } = require('../../utils/taxEngine');
const { getPublicLoanView } = require('../../utils/loanEngine');
const { safeBigInt } = require('../../utils/money');
const { sendPublicError } = require('../httpSafe');
const config = require('../../config/bot');
const session = require('../session');

class UserController {
  static async getMe(req, res) {
    const discordUser = req.sessionUser;
    const playUser = discordUser || session.getLocalUser(req);
    if (!playUser) return res.json({ success: false, loggedIn: false });

    try {
      const userData = await UserModel.findById(playUser.id, playUser.username, playUser.avatar || null);
      const { holdings, totalStockVal } = await StockModel.getUserHoldings(playUser.id);
      const { loadout } = await CosmeticLoadoutService.getUserLoadout(playUser.id);

      const cash = safeBigInt(userData.cash);
      const bank = safeBigInt(userData.bank);
      const netWorth = cash + bank + totalStockVal;

      const now = new Date();
      const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;
      const canDaily = !lastDaily || (now.getTime() - lastDaily.getTime() >= 24 * 60 * 60 * 1000);
      const canSubsidy = netWorth < 50000n;

      const tax = await (async () => {
        try { return await getPublicTaxView(playUser.id); } catch (e) { return null; }
      })();

      const loan = await (async () => {
        try { return await getPublicLoanView(playUser.id); } catch (e) { return null; }
      })();

      res.json({
        success: true,
        loggedIn: true,
        discord: !!discordUser,
        local: !discordUser,
        user: {
          id: playUser.id,
          username: userData.username || playUser.username,
          avatar: userData.avatar || playUser.avatar,
          cash: cash.toString(),
          bank: bank.toString(),
          stockVal: totalStockVal.toString(),
          netWorth: netWorth.toString(),
          clicker_level: Number(userData.clicker_level || 1),
          auto_miner_level: Number(userData.auto_miner_level || 0),
          total_clicks: Number(userData.total_clicks || 0),
          daily_streak: Number(userData.daily_streak || 0),
          canDaily,
          canSubsidy,
          stocks: holdings,
          loadout: loadout || {},
          tax,
          loan,
          isAdmin: !!(discordUser && config.isAdmin(discordUser.id))
        }
      });
    } catch (err) {
      sendPublicError(res, err);
    }
  }

  static async claimDaily(req, res) {
    const playUser = req.sessionUser || session.getLocalUser(req);
    if (!playUser) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const result = await UserModel.claimDaily(playUser.id);
      res.json(result);
    } catch (err) {
      sendPublicError(res, err);
    }
  }

  static async transferBank(req, res) {
    const playUser = req.sessionUser || session.getLocalUser(req);
    if (!playUser) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const { type, amount } = req.body || {};
      const result = await UserModel.transferBank(playUser.id, type, amount);
      res.json(result);
    } catch (err) {
      sendPublicError(res, err);
    }
  }
}

module.exports = UserController;
