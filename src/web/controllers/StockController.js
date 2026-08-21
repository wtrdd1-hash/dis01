'use strict';

const StockModel = require('../../models/StockModel');
const { sendPublicError } = require('../httpSafe');
const session = require('../session');

class StockController {
  static async getStocks(req, res) {
    try {
      const stocks = await StockModel.getAllStocks();
      res.json({ success: true, stocks });
    } catch (err) {
      sendPublicError(res, err);
    }
  }

  static async buyStock(req, res) {
    const playUser = req.sessionUser || session.getLocalUser(req);
    if (!playUser) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const { stockId, amount } = req.body || {};
      const result = await StockModel.buyStock(playUser.id, stockId, amount);
      res.json(result);
    } catch (err) {
      sendPublicError(res, err);
    }
  }

  static async sellStock(req, res) {
    const playUser = req.sessionUser || session.getLocalUser(req);
    if (!playUser) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const { stockId, amount } = req.body || {};
      const result = await StockModel.sellStock(playUser.id, stockId, amount);
      res.json(result);
    } catch (err) {
      sendPublicError(res, err);
    }
  }
}

module.exports = StockController;
