/**
 * 🎛️ 경제 수동 컨트롤 모듈 (Economy Controls)
 *
 * 관리자 페이지에서 세금·금리·시장국면·자동모드를 수동으로 조절합니다.
 * - 자동모드 ON (auto):  economyBalancer가 자동으로 결정
 * - 자동모드 OFF (manual): 관리자가 설정한 값 그대로 유지
 * - 강제 자동모드 (force): 관리자가 한 사이클만 자동 실행 후 OFF
 *
 * 변경 이력은 economy_settings 테이블에 모두 기록됩니다.
 */
const { pool } = require('../config/database');

const ALLOWED_TAX_RATE_MAX = 0.15;
const ALLOWED_TAX_RATE_MIN = 0;

let manualState = {
  // 자동모드: 'auto' | 'manual' | 'paused'
  autoMode: 'auto',
  // 관리자 잠금: true인 경우 자동조절이 이 값을 덮지 않음 (단 applyAutoBalancing에서 autoMode='manual' 시 그대로 사용)
  taxPolicyLocked: false,
  // 마지막 관리자 변경 시각
  lastChangedAt: 0,
  // 마지막 관리자 ID
  lastChangedBy: null,
  // 변경 이력 (메모리 큐, 최근 20건만 유지)
  history: []
};

let __loaded = false;

async function loadManualState() {
  if (__loaded) return;
  try {
    const [rows] = await pool.query(
      `SELECT key_name, value FROM economy_settings WHERE key_name IN ('autoMode','taxPolicyLocked','lastChangedAt','lastChangedBy')`
    );
    for (const r of rows) {
      if (r.key_name === 'autoMode' && ['auto','manual','paused'].includes(r.value)) {
        manualState.autoMode = r.value;
      }
      if (r.key_name === 'taxPolicyLocked') {
        manualState.taxPolicyLocked = r.value === '1' || r.value === 'true';
      }
      if (r.key_name === 'lastChangedAt') {
        const n = Number(r.value);
        if (Number.isFinite(n)) manualState.lastChangedAt = n;
      }
      if (r.key_name === 'lastChangedBy') {
        manualState.lastChangedBy = String(r.value || '');
      }
    }
    __loaded = true;
  } catch (e) {}
}

async function persistManualState() {
  try {
    const updates = [
      ['autoMode', manualState.autoMode],
      ['taxPolicyLocked', manualState.taxPolicyLocked ? '1' : '0'],
      ['lastChangedAt', String(manualState.lastChangedAt)],
      ['lastChangedBy', manualState.lastChangedBy || '']
    ];
    for (const [k, v] of updates) {
      await pool.query(
        `INSERT INTO economy_settings (key_name, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()`,
        [k, String(v)]
      );
    }
  } catch (e) {}
}

function pushHistory(entry) {
  manualState.history.unshift(entry);
  if (manualState.history.length > 20) manualState.history.length = 20;
}

/**
 * 관리자가 자동모드를 변경 (ON/OFF/PAUSED)
 */
async function setAutoMode(mode, changedBy = 'admin') {
  if (!['auto', 'manual', 'paused'].includes(mode)) {
    return { success: false, error: 'autoMode는 auto|manual|paused 중 하나여야 합니다.' };
  }
  manualState.autoMode = mode;
  if (mode === 'manual') {
    manualState.taxPolicyLocked = true;
  } else if (mode === 'auto') {
    manualState.taxPolicyLocked = false;
  }
  manualState.lastChangedAt = Date.now();
  manualState.lastChangedBy = changedBy;

  try {
    const { updateDynamicSetting } = require('./economyBalancer');
    updateDynamicSetting('autoMode', mode);
    updateDynamicSetting('taxPolicyLocked', manualState.taxPolicyLocked);
  } catch (e) {}

  pushHistory({ ts: manualState.lastChangedAt, key: 'autoMode', value: mode, by: changedBy });
  await persistManualState();
  return { success: true, autoMode: manualState.autoMode, taxPolicyLocked: manualState.taxPolicyLocked };
}

/**
 * 관리자가 수동 잠금 (자동모드를 잠시 중단하고 관리자 값 유지)
 */
async function lockTaxPolicy(locked, changedBy = 'admin') {
  manualState.taxPolicyLocked = !!locked;
  manualState.lastChangedAt = Date.now();
  manualState.lastChangedBy = changedBy;

  try {
    const { updateDynamicSetting } = require('./economyBalancer');
    updateDynamicSetting('taxPolicyLocked', manualState.taxPolicyLocked);
  } catch (e) {}

  pushHistory({ ts: manualState.lastChangedAt, key: 'taxPolicyLocked', value: locked ? '1' : '0', by: changedBy });
  await persistManualState();
  return { success: true, locked: manualState.taxPolicyLocked };
}

/**
 * 관리자가 다중 설정을 한 번에 업데이트 (패널용)
 */
async function bulkUpdate(updates, changedBy = 'admin') {
  if (!updates || typeof updates !== 'object') {
    return { success: false, error: '업데이트 객체가 필요합니다.' };
  }
  const allowedKeys = new Set([
    'taxRate', 'bankInterestRate', 'wealthTaxMultiplier',
    'forcedRegimeIndex', 'wealthThresholdForTax',
    'subsidyMultiplier', 'autoMode', 'taxPolicyLocked'
  ]);
  const applied = [];
  const skipped = [];

  const { getDynamicSettings, updateDynamicSetting } = require('./economyBalancer');

  for (const [k, v] of Object.entries(updates)) {
    if (!allowedKeys.has(k)) { skipped.push({ key: k, reason: '허용된 키 아님' }); continue; }
    let normalized = v;
    if (k === 'taxRate') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < ALLOWED_TAX_RATE_MIN || n > ALLOWED_TAX_RATE_MAX) {
        skipped.push({ key: k, reason: `세율은 ${ALLOWED_TAX_RATE_MIN}~${ALLOWED_TAX_RATE_MAX} 범위` });
        continue;
      }
      normalized = n;
    } else if (k === 'bankInterestRate') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 0.0001) {
        skipped.push({ key: k, reason: '금리는 0~0.0001 (분당)' });
        continue;
      }
      normalized = n;
    } else if (k === 'wealthTaxMultiplier') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0.1 || n > 5) {
        skipped.push({ key: k, reason: '부유세 배율은 0.1x~5.0x' });
        continue;
      }
      normalized = n;
    } else if (k === 'forcedRegimeIndex') {
      if (v === null || v === '' || v === 'null' || v === undefined) {
        normalized = null;
      } else {
        const n = Number(v);
        const { MARKET_REGIMES } = require('./stockEngine');
        const maxRegime = (Array.isArray(MARKET_REGIMES) ? MARKET_REGIMES.length : 9) - 1;
        if (!Number.isInteger(n) || n < 0 || n > maxRegime) {
          skipped.push({ key: k, reason: `국면 인덱스는 null 또는 0~${maxRegime}` });
          continue;
        }
        normalized = n;
      }
      try {
        const { setMarketRegime } = require('./stockEngine');
        setMarketRegime(normalized);
      } catch (e) {}
    } else if (k === 'wealthThresholdForTax') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 100000 || n > 10000000000) {
        skipped.push({ key: k, reason: '재산세 기준은 10만~100억' });
        continue;
      }
      normalized = n;
    } else if (k === 'subsidyMultiplier') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0.1 || n > 5) {
        skipped.push({ key: k, reason: '지원금 배율은 0.1x~5x' });
        continue;
      }
      normalized = n;
    } else if (k === 'autoMode') {
      if (!['auto', 'manual', 'paused'].includes(v)) {
        skipped.push({ key: k, reason: 'auto|manual|paused 중 하나' });
        continue;
      }
    } else if (k === 'taxPolicyLocked') {
      normalized = v === '1' || v === true || v === 'true';
    }

    const oldVal = getDynamicSettings()[k];
    updateDynamicSetting(k, normalized);

    try {
      if (normalized === null) {
        await pool.query('DELETE FROM economy_settings WHERE key_name = ?', [k]);
      } else {
        await pool.query(
          `INSERT INTO economy_settings (key_name, value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()`,
          [k, String(normalized)]
        );
      }
    } catch (e) {
      // DB 오류 시 롤백 및 에러 노출
      updateDynamicSetting(k, oldVal);
      return { success: false, error: `DB 저장 실패: ${e.message}`, applied, skipped };
    }

    manualState.lastChangedAt = Date.now();
    manualState.lastChangedBy = changedBy;
    pushHistory({ ts: manualState.lastChangedAt, key: k, oldVal, value: normalized, by: changedBy });
    applied.push({ key: k, value: normalized });
  }

  if (applied.length === 0) {
    return { success: false, error: '모든 변경이 거부됨', applied, skipped };
  }

  // 자동모드가 manual로 전환되면 잠금도 함께 ON
  if (applied.some(a => a.key === 'autoMode' && a.value === 'manual')) {
    manualState.taxPolicyLocked = true;
    manualState.autoMode = 'manual';
    updateDynamicSetting('taxPolicyLocked', true);
  } else if (applied.some(a => a.key === 'autoMode' && a.value === 'auto')) {
    manualState.taxPolicyLocked = false;
    manualState.autoMode = 'auto';
    updateDynamicSetting('taxPolicyLocked', false);
  }
  await persistManualState();
  return { success: true, applied, skipped, autoMode: manualState.autoMode, taxPolicyLocked: manualState.taxPolicyLocked };
}

/**
 * 자동조절 사이클 결과를 보고 manual 모드면 자동 적용 무효화
 * economyBalancer.js의 cycle에 호출됨
 */
function gateAutoChanges(autoSettings) {
  if (manualState.autoMode === 'manual') {
    // 관리자가 manual 모드인 경우 자동 설정의 세율·금리·국면만 덮지 않음
    const dyn = (() => {
      try { return require('./economyBalancer').getDynamicSettings(); } catch (e) { return null; }
    })();
    if (dyn) {
      autoSettings.taxRate = dyn.taxRate;
      autoSettings.wealthTaxMultiplier = dyn.wealthTaxMultiplier;
      autoSettings.bankInterestRate = dyn.bankInterestRate;
      autoSettings.forcedRegimeIndex = dyn.forcedRegimeIndex;
      autoSettings.wealthThresholdForTax = dyn.wealthThresholdForTax;
      autoSettings.taxPolicyLocked = true;
    }
  }
  return autoSettings;
}

function getManualState() {
  return {
    autoMode: manualState.autoMode,
    taxPolicyLocked: manualState.taxPolicyLocked,
    lastChangedAt: manualState.lastChangedAt,
    lastChangedBy: manualState.lastChangedBy,
    history: manualState.history.slice(0, 10)
  };
}

function summarizeCurrentSettings() {
  let dyn = null;
  try {
    const { getDynamicSettings } = require('./economyBalancer');
    dyn = getDynamicSettings();
  } catch (e) {}

  if (!dyn) return null;
  return {
    autoMode: manualState.autoMode,
    taxPolicyLocked: manualState.taxPolicyLocked,
    taxRate: dyn.taxRate,
    taxRatePercent: (Number(dyn.taxRate || 0) * 100).toFixed(2) + '%',
    wealthTaxMultiplier: dyn.wealthTaxMultiplier,
    bankInterestRate: dyn.bankInterestRate,
    bankInterestRateAnnualPercent: (Number(dyn.bankInterestRate || 0) * 60 * 24 * 365 * 100).toFixed(2) + '%',
    wealthThresholdForTax: dyn.wealthThresholdForTax,
    forcedRegimeIndex: dyn.forcedRegimeIndex,
    subsidyMultiplier: dyn.subsidyMultiplier,
    subsidyThresholdForBonus: dyn.subsidyThresholdForBonus,
    lastChangedAt: manualState.lastChangedAt,
    lastChangedBy: manualState.lastChangedBy
  };
}

module.exports = {
  loadManualState,
  setAutoMode,
  lockTaxPolicy,
  bulkUpdate,
  gateAutoChanges,
  getManualState,
  summarizeCurrentSettings,
  ALLOWED_TAX_RATE_MIN,
  ALLOWED_TAX_RATE_MAX
};
