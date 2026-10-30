const crypto = require('crypto');
const db = require('../config/db');

const REFERRAL_POINTS = 100; // refer karne wale ko kitne points milenge

async function generateCode(name) {
  const base = (String(name || '').replace(/[^a-zA-Z]/g, '').toUpperCase() + 'HEALTH').slice(0, 4);
  for (let i = 0; i < 10; i++) {
    const code = base + String(crypto.randomInt(1000, 10000));
    const [[exists]] = await db.query('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!exists) return code;
  }
  return base + Date.now().toString(36).toUpperCase().slice(-6);
}

// Member ka code (purane users ke liye bhi bana deta hai)
async function ensureReferralCode(userId) {
  const [[u]] = await db.query('SELECT name, referral_code FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  if (u.referral_code) return u.referral_code;
  const code = await generateCode(u.name);
  await db.query('UPDATE users SET referral_code = ? WHERE id = ?', [code, userId]);
  return code;
}

module.exports = { generateCode, ensureReferralCode, REFERRAL_POINTS };
