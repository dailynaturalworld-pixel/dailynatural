const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../services/notify');
const { toDateStr } = require('../utils');

const router = express.Router();
const RZP = () => process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com';
const configured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const authHeader = () => 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');

// Payment ho gaya -> package chalu, ya bimari plan ki fees jama (admin access dega)
async function activate(paymentId, providerPaymentId = null) {
  const [[p]] = await db.query(
    `SELECT p.*, pk.duration_days, pk.name AS package_name, cp.name AS program_name
       FROM payments p LEFT JOIN packages pk ON pk.id = p.package_id LEFT JOIN condition_programs cp ON cp.code = p.program_code
      WHERE p.id = ?`, [paymentId]);
  if (!p || p.status === 'paid') return p;
  const receipt = `HA-${new Date().getFullYear()}-${String(p.id).padStart(5, '0')}`;
  await db.query("UPDATE payments SET status = 'paid', paid_at = NOW(), provider_payment_id = COALESCE(?, provider_payment_id), receipt_no = ? WHERE id = ? AND status <> 'paid'",
    [providerPaymentId, receipt, p.id]);

  if (p.program_code) {
    await db.query("UPDATE health_profiles SET plan_review = 'waiting_approval', plan_review_at = NOW() WHERE user_id = ? AND plan_access = 0", [p.user_id]);
    await db.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)', [p.user_id, 'program_paid', `${p.program_name} ${receipt}`]);
    const [[u]] = await db.query('SELECT name FROM users WHERE id = ?', [p.user_id]);
    const [staff] = await db.query(
      `SELECT id FROM users WHERE status = 'active' AND (role = 'admin' OR id = (SELECT assigned_dietitian_id FROM users WHERE id = ?))`, [p.user_id]);
    await notify(staff.map((x) => x.id), {
      type: 'plan', title: `${u?.name || 'A member'} paid for ${p.program_name}`,
      body: `Rs ${Number(p.amount)} received (${receipt}). Open "Plan approvals" and give access.`, link: 'PlanReviews',
    });
    await notify(p.user_id, {
      type: 'general', title: 'Payment received',
      body: `Receipt ${receipt}. Your dietitian will check your details and open your ${p.program_name} plan soon.`, link: 'MyPlan',
    });
    return p;
  }

  const end = p.duration_days ? (() => { const d = new Date(); d.setDate(d.getDate() + p.duration_days); return toDateStr(d); })() : null;
  await db.query("UPDATE user_packages SET status = 'expired' WHERE user_id = ? AND status = 'active'", [p.user_id]);
  await db.query('INSERT INTO user_packages (user_id, package_id, start_date, end_date, price_paid, note) VALUES (?, ?, ?, ?, ?, ?)',
    [p.user_id, p.package_id, toDateStr(), end, p.amount, `Paid online · ${receipt}`]);
  await db.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)', [p.user_id, 'package_purchased', `${p.package_name} ${receipt}`]);
  await notify(p.user_id, { type: 'general', title: `${p.package_name} is active`, body: `Payment received. Receipt ${receipt}.`, link: 'Membership' });
  return p;
}

// Razorpay payment link banana (package ya bimari plan dono ke liye)
async function makeLink(userId, paymentId, amount, title) {
  const [[u]] = await db.query('SELECT name, email, mobile FROM users WHERE id = ?', [userId]);
  const body = {
    amount: Math.round(Number(amount) * 100), currency: 'INR', accept_partial: false,
    description: `${process.env.APP_NAME || 'HealthApp'} - ${title}`,
    reference_id: `HA${paymentId}`,
    customer: { name: u.name, email: u.email, ...(u.mobile ? { contact: u.mobile } : {}) },
    notify: { email: true, sms: false }, reminder_enable: false,
    ...(process.env.PAYMENT_CALLBACK_URL ? { callback_url: process.env.PAYMENT_CALLBACK_URL, callback_method: 'get' } : {}),
  };
  const resp = await fetch(`${RZP()}/v1/payment_links`, { method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.short_url) {
    console.error('Razorpay error:', resp.status, data?.error?.description || data);
    await db.query("UPDATE payments SET status = 'failed' WHERE id = ?", [paymentId]);
    return null;
  }
  await db.query('UPDATE payments SET provider_link_id = ?, link_url = ? WHERE id = ?', [data.id, data.short_url, paymentId]);
  return data.short_url;
}

// ---------- MEMBER ----------
router.get('/packages', requireAuth, requireRole('member'), async (req, res, next) => {
  try {
    const [pkgs] = await db.query('SELECT id, name, description, price, duration_days, is_default FROM packages WHERE is_active = 1 ORDER BY price');
    const [feats] = await db.query(
      `SELECT pf.package_id, f.code, f.name FROM package_features pf JOIN features f ON f.code = pf.feature_code WHERE pf.enabled = 1 ORDER BY f.name`);
    const [[current]] = await db.query(
      `SELECT up.package_id, up.start_date, up.end_date, p.name FROM user_packages up JOIN packages p ON p.id = up.package_id
        WHERE up.user_id = ? AND up.status = 'active' ORDER BY up.id DESC LIMIT 1`, [req.user.id]);
    res.json({
      payments_enabled: configured(),
      current: current || null,
      packages: pkgs.map((p) => ({ ...p, price: Number(p.price), features: feats.filter((f) => f.package_id === p.id).map((f) => f.name) })),
    });
  } catch (err) { next(err); }
});

router.post('/checkout', requireAuth, requireRole('member'), async (req, res, next) => {
  try {
    const [[pkg]] = await db.query('SELECT * FROM packages WHERE id = ? AND is_active = 1', [req.body.package_id]);
    if (!pkg) return res.status(404).json({ message: 'Package not found' });
    if (Number(pkg.price) <= 0) return res.status(400).json({ message: 'This package is free' });
    if (!configured()) return res.status(503).json({ message: 'Online payment is not set up yet. Please contact your dietitian.' });
    const [r] = await db.query('INSERT INTO payments (user_id, package_id, amount) VALUES (?, ?, ?)', [req.user.id, pkg.id, pkg.price]);
    const url = await makeLink(req.user.id, r.insertId, pkg.price, pkg.name);
    if (!url) return res.status(502).json({ message: 'Could not start the payment. Please try again.' });
    res.status(201).json({ payment_id: r.insertId, url });
  } catch (err) { next(err); }
});

// Bimari plan ki fees (member ne jo bimari chuni hai, uski main bimari ki fees)
router.post('/program-checkout', requireAuth, requireRole('member'), async (req, res, next) => {
  try {
    const { accessInfo } = require('../services/programs');
    const info = await accessInfo(req.user.id);
    if (!info.main) return res.status(400).json({ message: 'Choose your health problem first.' });
    if (info.has_access) return res.status(400).json({ message: 'Your plan is already open.' });
    if (info.paid) return res.status(400).json({ message: 'You have already paid. Your dietitian will give access soon.' });
    if (info.main.fee <= 0) return res.status(400).json({ message: 'This plan is free. Your dietitian will give access soon.' });
    if (!configured()) return res.status(503).json({ message: 'Online payment is not set up yet. Please pay your dietitian by UPI or cash; they will open your plan.' });
    const [r] = await db.query('INSERT INTO payments (user_id, program_code, amount) VALUES (?, ?, ?)', [req.user.id, info.main.code, info.main.fee]);
    const url = await makeLink(req.user.id, r.insertId, info.main.fee, `${info.main.name} plan`);
    if (!url) return res.status(502).json({ message: 'Could not start the payment. Please try again.' });
    res.status(201).json({ payment_id: r.insertId, url });
  } catch (err) { next(err); }
});

// App wapas aaye to status check (webhook na bhi aaye to)
router.get('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT * FROM payments WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ message: 'Not found' });
    if (p.status === 'created' && p.provider_link_id && configured()) {
      const resp = await fetch(`${RZP()}/v1/payment_links/${p.provider_link_id}`, { headers: { Authorization: authHeader() } });
      const data = await resp.json().catch(() => ({}));
      if (data.status === 'paid') await activate(p.id, data.payments?.[0]?.payment_id || null);
      else if (['cancelled', 'expired'].includes(data.status)) await db.query('UPDATE payments SET status = ? WHERE id = ?', [data.status, p.id]);
    }
    const [[fresh]] = await db.query('SELECT id, status, receipt_no FROM payments WHERE id = ?', [p.id]);
    res.json(fresh);
  } catch (err) { next(err); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.amount, p.status, p.receipt_no, p.paid_at, p.created_at, p.method,
              COALESCE(pk.name, CONCAT(cp.name, ' plan')) AS package_name
         FROM payments p LEFT JOIN packages pk ON pk.id = p.package_id LEFT JOIN condition_programs cp ON cp.code = p.program_code
        WHERE p.user_id = ? AND p.status <> 'created' ORDER BY p.id DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------- ADMIN ----------
router.get('/staff/all', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, u.name AS member_name, u.email AS member_email, COALESCE(pk.name, CONCAT(cp.name, ' plan')) AS package_name
         FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN packages pk ON pk.id = p.package_id
         LEFT JOIN condition_programs cp ON cp.code = p.program_code ORDER BY p.id DESC LIMIT 300`);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------- RAZORPAY WEBHOOK (server.js mein raw body ke saath) ----------
async function webhook(req, res) {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const sig = req.headers['x-razorpay-signature'];
    if (!secret || !sig) return res.status(400).send('missing');
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (expected.length !== String(sig).length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)))) {
      return res.status(400).send('bad signature');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'payment_link.paid') {
      const linkId = event.payload?.payment_link?.entity?.id;
      const payId = event.payload?.payment?.entity?.id || null;
      const [[p]] = await db.query('SELECT id FROM payments WHERE provider_link_id = ?', [linkId]);
      if (p) await activate(p.id, payId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('error');
  }
}

module.exports = router;
module.exports.webhook = webhook;
module.exports.activate = activate;
