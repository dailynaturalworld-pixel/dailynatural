const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { toDateStr } = require('../utils');
const { createAndSendOtp, verifyOtp } = require('../services/otp');
const { generateCode } = require('../services/referral');
const { getSetting } = require('../services/settings');
const { effectivePerms } = require('../services/access');
const { listPrograms, cleanCodes, startProgramForMember } = require('../services/programs');

const router = express.Router();

function makeToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing in backend/.env');
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, mobile: u.mobile,
    role: u.role, language: u.language, profile_photo: u.profile_photo,
    email_verified: Boolean(u.email_verified), referral_code: u.referral_code, reward_points: u.reward_points || 0,
    permissions: u.role === 'member' ? undefined : effectivePerms(u),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e) => String(e || '').toLowerCase().trim();

// ---------- 10 BIMARI LIST (register screen ke liye, login ki zaroorat nahi) ----------
router.get('/programs', async (req, res, next) => {
  try {
    const rows = await listPrograms();
    res.json(rows.map((p) => ({ code: p.code, name: p.name, name_hi: p.name_hi, icon: p.icon, description: p.description })));
  } catch (err) { next(err); }
});

// ---------- SIGNUP (sirf members) ----------
// Data pehle pending_registrations mein jata hai. OTP sahi hone par hi asli account (users) banta hai.
router.post('/register', async (req, res, next) => {
  try {
    const { name, mobile, password, consent, referral_code } = req.body;
    const email = normEmail(req.body.email);
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (!consent) return res.status(400).json({ message: 'Please accept the health data consent to continue' });

    await db.query('DELETE FROM pending_registrations WHERE expires_at < NOW()');
    const [[existing]] = await db.query("SELECT id, email_verified, role FROM users WHERE email = ? AND status <> 'deleted'", [email]);
    if (existing && (existing.email_verified || existing.role !== 'member')) {
      return res.status(409).json({ message: 'This email is already registered. Please log in.' });
    }

    let referrerId = null;
    if (referral_code && String(referral_code).trim()) {
      const [[ref]] = await db.query("SELECT id FROM users WHERE referral_code = ? AND status = 'active'", [String(referral_code).trim().toUpperCase()]);
      if (!ref) return res.status(400).json({ message: 'This referral code is not valid' });
      referrerId = ref.id;
    }

    const codes = await cleanCodes(req.body.conditions);
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO pending_registrations (email, name, mobile, password_hash, referrer_id, condition_codes, consent_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY))
       ON DUPLICATE KEY UPDATE name = VALUES(name), mobile = VALUES(mobile), password_hash = VALUES(password_hash),
         referrer_id = VALUES(referrer_id), condition_codes = VALUES(condition_codes), consent_at = NOW(), expires_at = VALUES(expires_at)`,
      [email, String(name).trim(), mobile || null, hash, referrerId, codes.join(',') || null]
    );
    const sent = await createAndSendOtp(email, 'register');
    res.status(201).json({ otp_required: true, email, purpose: 'register', message: sent.error || `We sent a 6-digit code to ${email}` });
  } catch (err) {
    next(err);
  }
});

// Pending se asli account banana (OTP sahi hone ke baad)
async function createMemberFromPending(pending) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const code = await generateCode(pending.name);
    const [r] = await conn.query(
      `INSERT INTO users (name, email, mobile, password_hash, role, consent_at, email_verified, referral_code, referred_by)
       VALUES (?, ?, ?, ?, 'member', ?, 1, ?, ?)`,
      [pending.name, pending.email, pending.mobile, pending.password_hash, pending.consent_at, code, pending.referrer_id]
    );
    const userId = r.insertId;
    await conn.query('INSERT INTO health_profiles (user_id) VALUES (?)', [userId]);
    const [[pkg]] = await conn.query('SELECT id, duration_days FROM packages WHERE is_default = 1 AND is_active = 1 LIMIT 1');
    if (pkg) {
      let endDate = null;
      if (pkg.duration_days) { const d = new Date(); d.setDate(d.getDate() + pkg.duration_days); endDate = toDateStr(d); }
      await conn.query(`INSERT INTO user_packages (user_id, package_id, start_date, end_date, note) VALUES (?, ?, ?, ?, 'Default package on signup')`,
        [userId, pkg.id, toDateStr(), endDate]);
    }
    if (pending.referrer_id) {
      const pts = Number(await getSetting('referral_points')) || 100;
      await conn.query('UPDATE users SET reward_points = reward_points + ? WHERE id = ?', [pts, pending.referrer_id]);
      await conn.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)', [pending.referrer_id, 'referral_reward', `+${pts} for user ${userId}`]);
    }
    await conn.query('DELETE FROM pending_registrations WHERE email = ?', [pending.email]);
    await conn.commit();
    return userId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------- LOGIN: password sahi -> member ko email OTP; staff ko seedha token ----------
router.post('/login', async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const { password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) {
      // Register kiya par OTP verify nahi kiya: wapas OTP screen
      const [[pending]] = await db.query('SELECT * FROM pending_registrations WHERE email = ? AND expires_at >= NOW()', [email]);
      if (pending && (await bcrypt.compare(password, pending.password_hash))) {
        const sent = await createAndSendOtp(email, 'register');
        return res.json({ otp_required: true, email, purpose: 'register', message: sent.error || `Please verify your email. We sent a code to ${email}` });
      }
    }
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Email or password is incorrect' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ message: 'This account is inactive. Please contact support.' });
    }
    if (user.role !== 'member') {
      return res.json({ token: makeToken(user), user: publicUser(user) });
    }
    const purpose = user.email_verified ? 'login' : 'register';
    const sent = await createAndSendOtp(email, purpose);
    res.json({
      otp_required: true,
      email,
      purpose,
      message: sent.error || `We sent a 6-digit code to ${email}`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- OTP VERIFY (register / login) ----------
router.post('/verify-otp', async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const purpose = req.body.purpose;
    if (!['register', 'login'].includes(purpose)) return res.status(400).json({ message: 'Invalid request' });
    const [[pending]] = purpose === 'register'
      ? await db.query('SELECT * FROM pending_registrations WHERE email = ? AND expires_at >= NOW()', [email]) : [[null]];
    const [[user]] = await db.query("SELECT * FROM users WHERE email = ? AND status = 'active'", [email]);
    if (!pending && !user) return res.status(400).json({ message: 'Please register again. Your sign-up has expired.' });

    const error = await verifyOtp(email, purpose, req.body.code);
    if (error) return res.status(400).json({ message: error });

    let userId = user?.id;
    if (pending && !user) {
      userId = await createMemberFromPending(pending);
      // Chuni hui bimari ka plan (setting ke hisaab se turant ya approval ke baad)
      const codes = await cleanCodes(pending.condition_codes);
      if (codes.length) {
        try { await startProgramForMember(userId, codes); } catch (e) { console.warn('Program start failed:', e.message); }
      }
    } else if (user && !user.email_verified) {
      await db.query('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]); // purane (v3-v7) unverified accounts
      await db.query('DELETE FROM pending_registrations WHERE email = ?', [email]);
    }
    const [[fresh]] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
    res.json({ token: makeToken(fresh), user: publicUser(fresh) });
  } catch (err) {
    next(err);
  }
});

router.post('/resend-otp', async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const purpose = req.body.purpose;
    if (!['register', 'login', 'reset'].includes(purpose)) return res.status(400).json({ message: 'Invalid request' });
    const [[user]] = await db.query("SELECT id FROM users WHERE email = ? AND status = 'active'", [email]);
    const [[pending]] = purpose === 'register' ? await db.query('SELECT email FROM pending_registrations WHERE email = ? AND expires_at >= NOW()', [email]) : [[null]];
    if (!user && !pending) return res.json({ message: 'If this email is registered, a new code has been sent' });
    const sent = await createAndSendOtp(email, purpose);
    if (sent.error) return res.status(429).json({ message: sent.error, wait: sent.wait });
    res.json({ message: `A new code was sent to ${email}` });
  } catch (err) {
    next(err);
  }
});

// ---------- FORGOT PASSWORD ----------
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email' });
    const [[user]] = await db.query("SELECT id FROM users WHERE email = ? AND status = 'active'", [email]);
    if (user) {
      const sent = await createAndSendOtp(email, 'reset');
      if (sent.error) return res.status(429).json({ message: sent.error, wait: sent.wait });
    }
    // Same jawab dono case mein (privacy: kisi ko pata na chale email registered hai ya nahi)
    res.json({ message: 'If this email is registered, we sent a 6-digit code to it', email });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const { code, new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    const [[user]] = await db.query("SELECT id FROM users WHERE email = ? AND status = 'active'", [email]);
    if (!user) return res.status(400).json({ message: 'Code not found. Please ask for a new code.' });
    const error = await verifyOtp(email, 'reset', code);
    if (error) return res.status(400).json({ message: error });
    const hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', [hash, user.id]);
    await db.query('INSERT INTO activity_logs (user_id, action) VALUES (?, ?)', [user.id, 'password_reset']);
    res.json({ message: 'Password changed. You can log in now.' });
  } catch (err) {
    next(err);
  }
});

// ---------- MY ACCOUNT ----------
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(publicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const { name, mobile, language } = req.body;
    await db.query(
      `UPDATE users SET
         name = COALESCE(?, name),
         mobile = COALESCE(?, mobile),
         language = COALESCE(?, language)
       WHERE id = ?`,
      [name || null, mobile || null, ['en', 'hi'].includes(language) ? language : null, req.user.id]
    );
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { old_password, new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length || !(await bcrypt.compare(old_password || '', rows[0].password_hash))) {
      return res.status(400).json({ message: 'Old password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ message: 'Password changed' });
  } catch (err) {
    next(err);
  }
});

// ---------- DELETE ACCOUNT (Google Play requirement) ----------
// Personal data hata diya jata hai, account "deleted" mark hota hai
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body;
    const [rows] = await db.query('SELECT password_hash, role FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    if (rows[0].role !== 'member') {
      return res.status(400).json({ message: 'Staff accounts are removed by the admin' });
    }
    if (!(await bcrypt.compare(password || '', rows[0].password_hash))) {
      return res.status(400).json({ message: 'Password is incorrect' });
    }
    await require('./reports').deleteUserReportFiles(req.user.id);
    await db.query('DELETE FROM health_profiles WHERE user_id = ?', [req.user.id]);
    await db.query('DELETE FROM weight_logs WHERE user_id = ?', [req.user.id]);
    await db.query('DELETE FROM habit_logs WHERE user_id = ?', [req.user.id]);
    await db.query('DELETE FROM group_members WHERE user_id = ?', [req.user.id]);
    await db.query("DELETE FROM diet_plans WHERE target_type = 'member' AND target_id = ?", [req.user.id]);
    await db.query(
      `UPDATE users SET name = 'Deleted user', email = CONCAT('deleted_', id, '@deleted.local'),
         mobile = NULL, profile_photo = NULL, status = 'deleted' WHERE id = ?`,
      [req.user.id]
    );
    await db.query('INSERT INTO activity_logs (user_id, action) VALUES (?, ?)', [req.user.id, 'account_deleted']);
    res.json({ message: 'Your account has been deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
