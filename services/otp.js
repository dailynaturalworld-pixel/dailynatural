const crypto = require('crypto');
const db = require('../config/db');
const { sendOtpEmail, emailConfigured } = require('./mailer');

const EXPIRY_MIN = 10;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

function hash(code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'otp').update(String(code)).digest('hex');
}

// Naya OTP banao aur email karo. Return: { ok } ya { error, wait }
async function createAndSendOtp(email, purpose) {
  const [[last]] = await db.query(
    `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM email_otps
      WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1`,
    [email, purpose]
  );
  if (last && last.age < RESEND_SECONDS) {
    return { error: `Please wait ${RESEND_SECONDS - last.age} seconds before asking for a new code`, wait: RESEND_SECONDS - last.age };
  }
  const code = String(crypto.randomInt(100000, 1000000));
  // Purane code band nahi karte: user pichhle email ka code daale to bhi (10 min ke andar) chale
  await db.query(
    `INSERT INTO email_otps (email, purpose, code_hash, debug_code, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${EXPIRY_MIN} MINUTE))`,
    [email, purpose, hash(code), emailConfigured() ? null : code] // Gmail set hote hi number save nahi hota
  );
  await sendOtpEmail(email, code, purpose);
  return { ok: true };
}

// OTP check. Return: null (sahi) ya error message
// Pichhle 10 minute ke koi bhi unused code chalega (user ne Resend dabaya ho to bhi purana code kaam kare)
async function verifyOtp(email, purpose, code) {
  const [rows] = await db.query(
    `SELECT id, code_hash, attempts FROM email_otps
      WHERE email = ? AND purpose = ? AND used = 0 AND expires_at >= NOW()
      ORDER BY id DESC LIMIT 5`,
    [email, purpose]
  );
  if (!rows.length) {
    const [[any]] = await db.query('SELECT id FROM email_otps WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1', [email, purpose]);
    return any ? 'This code has expired. Please tap "Resend code".' : 'Code not found. Please ask for a new code.';
  }
  const latest = rows[0];
  if (latest.attempts >= MAX_ATTEMPTS) return 'Too many wrong tries. Please tap "Resend code".';
  const given = hash(String(code || '').replace(/\D/g, ''));
  const match = rows.find((r) => r.code_hash === given);
  if (!match) {
    await db.query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [latest.id]);
    const left = MAX_ATTEMPTS - latest.attempts - 1;
    return left > 0 ? `Wrong code. ${left} tries left.` : 'Too many wrong tries. Please tap "Resend code".';
  }
  // Sahi: is email ke saare khule codes band
  await db.query('UPDATE email_otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0', [email, purpose]);
  return null;
}

module.exports = { createAndSendOtp, verifyOtp, RESEND_SECONDS };
