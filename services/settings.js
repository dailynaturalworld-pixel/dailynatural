const db = require('../config/db');

// Admin panel se badalne wali settings (default ke saath)
const DEFAULTS = {
  ai_food_enabled: '1',
  ai_daily_scan_limit: process.env.AI_DAILY_SCAN_LIMIT || '20',
  referral_points: '100',
  support_email: '',
  diet_needs_access: '1', // 1 = diet tabhi dikhe jab admin access de
  plan_mode: 'auto', // auto = bimari plan turant; approval = admin approve kare tab
};

async function getSettings() {
  try {
    const [rows] = await db.query('SELECT setting_key, setting_value FROM app_settings');
    const out = { ...DEFAULTS };
    rows.forEach((r) => { if (r.setting_key in DEFAULTS) out[r.setting_key] = r.setting_value; });
    return out;
  } catch {
    return { ...DEFAULTS }; // purane database mein table na ho to bhi chale
  }
}

async function getSetting(key) {
  return (await getSettings())[key];
}

async function saveSettings(obj) {
  const rows = Object.entries(obj).filter(([k]) => k in DEFAULTS).map(([k, v]) => [k, String(v ?? '')]);
  if (!rows.length) return;
  await db.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES ? ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [rows]
  );
}

module.exports = { getSettings, getSetting, saveSettings, DEFAULTS };
