const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { planDaysError } = require('../utils');
const { requireAuth, requireRole } = require('../middleware/auth');
const { PERMS, STAFF, effectivePerms, perm, staffCanAccess } = require('../services/access');
const { getSettings, saveSettings } = require('../services/settings');
const { toDateStr } = require('../utils');
const { getPlanForDate } = require('../services/dietService');
const { emailConfigured } = require('../services/mailer');

// Mahine ke har din kaunsa plan (calendar ke liye)
async function monthPlans(userId, month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const p = await getPlanForDate(userId, date);
    let special = false;
    if (p) { const [[x]] = await db.query('SELECT COUNT(*) AS c FROM diet_plan_meals WHERE plan_id = ? AND specific_date = ?', [p.id, date]); special = x.c > 0; }
    out.push({ date, plan_id: p?.id || null, title: p?.title || null, type: p?.target_type || null, condition: p?.health_condition || null, special_day: special });
  }
  return out;
}
module.exports.monthPlans = monthPlans;

const router = express.Router();
router.use(requireAuth, requireRole(...STAFF));
const adminOnly = requireRole('admin');
const log = (uid, action, details = null) =>
  db.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)', [uid, action, details]);

// =============== MEMBER PROFILE EDIT ===============
const PROFILE_FIELDS = ['dob', 'gender', 'address', 'height_cm', 'current_weight_kg', 'target_weight_kg', 'blood_group',
  'medical_conditions', 'allergies', 'food_restrictions', 'lifestyle', 'diet_preference', 'health_history',
  'water_goal', 'steps_goal', 'sleep_goal'];

router.put('/members/:id/profile', perm('members_edit'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await staffCanAccess(req.user, id))) return res.status(403).json({ message: 'This member is not assigned to you' });
    const { name, mobile } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ message: 'Name cannot be empty' });
    if (name !== undefined || mobile !== undefined) {
      await db.query("UPDATE users SET name = COALESCE(?, name), mobile = ? WHERE id = ? AND role = 'member'",
        [name ? String(name).trim() : null, mobile || null, id]);
    }
    const data = {};
    for (const f of PROFILE_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f] === '' ? null : req.body[f];
    if (data.gender && !['male', 'female', 'other'].includes(data.gender)) return res.status(400).json({ message: 'Invalid gender' });
    if (data.diet_preference && !['veg', 'non_veg', 'eggetarian', 'vegan', 'jain'].includes(data.diet_preference)) return res.status(400).json({ message: 'Invalid diet preference' });
    const cols = Object.keys(data);
    if (cols.length) {
      await db.query(
        `INSERT INTO health_profiles (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
        [id, ...cols.map((c) => data[c])]
      );
      if (data.current_weight_kg) {
        await db.query(`INSERT INTO weight_logs (user_id, weight_kg, log_date) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)`, [id, data.current_weight_kg, toDateStr()]);
      }
    }
    await log(req.user.id, 'member_profile_edited', `member ${id}`);
    res.json({ message: 'Profile saved' });
  } catch (err) { next(err); }
});

// =============== STAFF MANAGE ===============
router.get('/staff/permissions', adminOnly, (req, res) => res.json(PERMS));

router.get('/staff-full', adminOnly, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.mobile, u.role, u.status, u.permissions, u.created_at,
              (SELECT COUNT(*) FROM users m WHERE m.assigned_dietitian_id = u.id AND m.status <> 'deleted') AS member_count
         FROM users u WHERE u.role IN ('admin','dietitian','coach','doctor','trainer') ORDER BY u.role, u.name`);
    res.json(rows.map((r) => ({ ...r, permissions: effectivePerms(r), custom: Boolean(r.permissions) })));
  } catch (err) { next(err); }
});

router.patch('/staff/:id', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [[s]] = await db.query("SELECT id, role FROM users WHERE id = ? AND role IN ('admin','dietitian','coach','doctor','trainer')", [id]);
    if (!s) return res.status(404).json({ message: 'Staff not found' });
    const { name, mobile, role, status, permissions } = req.body;
    if (id === req.user.id && (status === 'inactive' || (role && role !== 'admin'))) {
      return res.status(400).json({ message: 'You cannot deactivate yourself or remove your own admin role' });
    }
    if (role && !STAFF.includes(role)) return res.status(400).json({ message: 'Invalid role' });
    if (status && !['active', 'inactive'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    let permJson;
    if (permissions === null) permJson = null; // role ke default par wapas
    else if (Array.isArray(permissions)) permJson = JSON.stringify(permissions.filter((p) => PERMS[p]));
    await db.query(
      `UPDATE users SET name = COALESCE(?, name), mobile = COALESCE(?, mobile), role = COALESCE(?, role),
         status = COALESCE(?, status) ${permJson !== undefined ? ', permissions = ?' : ''} WHERE id = ?`,
      [name || null, mobile ?? null, role || null, status || null, ...(permJson !== undefined ? [permJson] : []), id]
    );
    if (status === 'inactive') await db.query('UPDATE users SET assigned_dietitian_id = NULL WHERE assigned_dietitian_id = ?', [id]);
    await log(req.user.id, 'staff_updated', `staff ${id}${status ? ` status=${status}` : ''}`);
    res.json({ message: 'Staff updated' });
  } catch (err) { next(err); }
});

router.post('/staff/:id/reset-password', adminOnly, async (req, res, next) => {
  try {
    const pw = String(req.body.new_password || '');
    if (pw.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    const [r] = await db.query(
      "UPDATE users SET password_hash = ? WHERE id = ? AND role IN ('admin','dietitian','coach','doctor','trainer')",
      [await bcrypt.hash(pw, 10), req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Staff not found' });
    await log(req.user.id, 'staff_password_reset', `staff ${req.params.id}`);
    res.json({ message: 'Password changed. Share it with them privately.' });
  } catch (err) { next(err); }
});

router.delete('/staff/:id', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ message: 'You cannot delete your own account' });
    const [[s]] = await db.query("SELECT id, name FROM users WHERE id = ? AND role IN ('admin','dietitian','coach','doctor','trainer')", [id]);
    if (!s) return res.status(404).json({ message: 'Staff not found' });
    // Purani chat/replies sambhal kar rakhne ke liye account hata nahi, band karte hain
    await db.query("UPDATE users SET status = 'deleted', email = CONCAT('deleted_', id, '@deleted.local') WHERE id = ?", [id]);
    await db.query('UPDATE users SET assigned_dietitian_id = NULL WHERE assigned_dietitian_id = ?', [id]);
    await log(req.user.id, 'staff_deleted', s.name);
    res.json({ message: 'Staff removed' });
  } catch (err) { next(err); }
});

// =============== PACKAGES ===============
router.get('/features', async (req, res, next) => {
  try { const [rows] = await db.query('SELECT code, name FROM features ORDER BY name'); res.json(rows); } catch (err) { next(err); }
});

async function savePackageFeatures(pkgId, features) {
  const [all] = await db.query('SELECT code FROM features');
  const on = new Set(Array.isArray(features) ? features : []);
  await db.query(
    'INSERT INTO package_features (package_id, feature_code, enabled) VALUES ? ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)',
    [all.map((f) => [pkgId, f.code, on.has(f.code) ? 1 : 0])]
  );
}

function validPackage(b) {
  if (!b.name || !String(b.name).trim()) return 'Package name is required';
  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0 || price > 1000000) return 'Price must be 0 or more';
  if (b.duration_days !== null && b.duration_days !== '' && b.duration_days !== undefined) {
    const d = Number(b.duration_days);
    if (!Number.isInteger(d) || d < 1 || d > 3650) return 'Duration must be 1 to 3650 days (or empty for no end)';
  }
  return null;
}

router.post('/packages', adminOnly, async (req, res, next) => {
  try {
    const err = validPackage(req.body);
    if (err) return res.status(400).json({ message: err });
    const b = req.body;
    const [r] = await db.query('INSERT INTO packages (name, description, price, duration_days, is_active) VALUES (?, ?, ?, ?, ?)',
      [String(b.name).trim(), b.description || null, Number(b.price), b.duration_days ? Number(b.duration_days) : null, b.is_active === false ? 0 : 1]);
    await savePackageFeatures(r.insertId, b.features);
    if (b.is_default) await db.query('UPDATE packages SET is_default = (id = ?)', [r.insertId]);
    await log(req.user.id, 'package_created', b.name);
    res.status(201).json({ id: r.insertId });
  } catch (err) { next(err); }
});

router.put('/packages/:id', adminOnly, async (req, res, next) => {
  try {
    const err = validPackage(req.body);
    if (err) return res.status(400).json({ message: err });
    const b = req.body;
    const [r] = await db.query('UPDATE packages SET name = ?, description = ?, price = ?, duration_days = ?, is_active = ? WHERE id = ?',
      [String(b.name).trim(), b.description || null, Number(b.price), b.duration_days ? Number(b.duration_days) : null, b.is_active === false ? 0 : 1, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Package not found' });
    await savePackageFeatures(Number(req.params.id), b.features);
    if (b.is_default) await db.query('UPDATE packages SET is_default = (id = ?)', [req.params.id]);
    await log(req.user.id, 'package_updated', b.name);
    res.json({ message: 'Package saved' });
  } catch (err) { next(err); }
});

router.delete('/packages/:id', adminOnly, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT is_default FROM packages WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ message: 'Package not found' });
    if (p.is_default) return res.status(400).json({ message: 'This is the default package for new members. Make another package default first.' });
    const [[used]] = await db.query('SELECT (SELECT COUNT(*) FROM user_packages WHERE package_id = ?) + (SELECT COUNT(*) FROM payments WHERE package_id = ?) AS c', [req.params.id, req.params.id]);
    if (used.c) {
      await db.query('UPDATE packages SET is_active = 0 WHERE id = ?', [req.params.id]);
      return res.json({ message: 'This package has members, so it was switched off instead of deleted.' });
    }
    await db.query('DELETE FROM packages WHERE id = ?', [req.params.id]);
    res.json({ message: 'Package deleted' });
  } catch (err) { next(err); }
});

// =============== SETTINGS ===============
router.get('/settings', adminOnly, async (req, res, next) => {
  try {
    const ai = require('../services/ai');
    res.json({ ...(await getSettings()), ai_key_set: ai.aiConfigured(), ai_name: ai.aiName(), ai_provider: ai.provider(),
      email_set: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS), payments_set: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) });
  } catch (err) { next(err); }
});

router.put('/settings', adminOnly, async (req, res, next) => {
  try {
    const b = req.body;
    if (b.ai_daily_scan_limit !== undefined) {
      const n = Number(b.ai_daily_scan_limit);
      if (!Number.isInteger(n) || n < 0 || n > 200) return res.status(400).json({ message: 'Daily scan limit must be 0 to 200' });
    }
    if (b.referral_points !== undefined) {
      const n = Number(b.referral_points);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return res.status(400).json({ message: 'Referral points must be 0 to 10000' });
    }
    if (b.ai_food_enabled !== undefined) b.ai_food_enabled = b.ai_food_enabled === true || b.ai_food_enabled === '1' ? '1' : '0';
    await saveSettings(b);
    await log(req.user.id, 'settings_updated', Object.keys(b).join(', '));
    res.json({ message: 'Settings saved' });
  } catch (err) { next(err); }
});

// =============== ANALYTICS ===============
router.get('/analytics', adminOnly, async (req, res, next) => {
  try {
    const q = async (sql, p = []) => (await db.query(sql, p))[0];
    const months = await q(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS c FROM users
        WHERE role = 'member' AND status <> 'deleted' AND created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 5 MONTH)
        GROUP BY month ORDER BY month`);
    const monthList = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthList.push({ month: key, label: d.toLocaleDateString('en-IN', { month: 'short' }), count: Number(months.find((m) => m.month === key)?.c || 0) });
    }
    const [[totals]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE role='member' AND status='active') AS members,
              (SELECT COUNT(DISTINCT user_id) FROM (
                 SELECT user_id FROM meal_completions WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                 UNION SELECT user_id FROM activity_completions WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                 UNION SELECT user_id FROM habit_logs WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                 UNION SELECT user_id FROM food_logs WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)) a) AS active_7d,
              (SELECT COUNT(*) FROM meal_completions WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)) AS meals_7d,
              (SELECT COUNT(*) FROM activity_completions WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)) AS workouts_7d,
              (SELECT COUNT(*) FROM food_logs WHERE source='ai' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS ai_scans_7d,
              (SELECT COUNT(*) FROM member_reports WHERE status='pending') AS reports_pending,
              (SELECT COUNT(*) FROM appointments WHERE status IN ('requested','confirmed') AND appt_date >= CURDATE()) AS appts_upcoming,
              (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid' AND paid_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS revenue_month,
              (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid') AS revenue_total`);
    const weightLoss = await q(
      `SELECT ROUND(SUM(GREATEST(f.weight_kg - hp.current_weight_kg, 0)), 1) AS kg
         FROM health_profiles hp JOIN users u ON u.id = hp.user_id AND u.status = 'active'
         JOIN (SELECT w.user_id, w.weight_kg FROM weight_logs w
                 JOIN (SELECT user_id, MIN(log_date) d FROM weight_logs GROUP BY user_id) m ON m.user_id = w.user_id AND m.d = w.log_date) f
           ON f.user_id = hp.user_id`);
    const conditions = await q(
      `SELECT health_condition AS name, COUNT(*) AS c FROM diet_plans
        WHERE health_condition IS NOT NULL AND is_active = 1 AND end_date >= CURDATE() GROUP BY health_condition ORDER BY c DESC LIMIT 8`);
    const packages = await q(
      `SELECT p.name, COUNT(*) AS c FROM user_packages up JOIN packages p ON p.id = up.package_id
        JOIN users u ON u.id = up.user_id AND u.status = 'active'
        WHERE up.status = 'active' GROUP BY p.id ORDER BY c DESC`);
    const inactive = await q(
      `SELECT u.id, u.name, u.email,
              GREATEST(COALESCE((SELECT MAX(log_date) FROM meal_completions WHERE user_id = u.id), '2000-01-01'),
                       COALESCE((SELECT MAX(log_date) FROM habit_logs WHERE user_id = u.id), '2000-01-01'),
                       COALESCE((SELECT MAX(log_date) FROM activity_completions WHERE user_id = u.id), '2000-01-01')) AS last_active
         FROM users u WHERE u.role = 'member' AND u.status = 'active'
        HAVING last_active < DATE_SUB(CURDATE(), INTERVAL 6 DAY) ORDER BY last_active DESC LIMIT 15`);
    const daily = await q(
      `SELECT log_date, COUNT(DISTINCT user_id) AS c FROM (
         SELECT user_id, log_date FROM meal_completions WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
         UNION ALL SELECT user_id, log_date FROM activity_completions WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
         UNION ALL SELECT user_id, log_date FROM habit_logs WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)) t
       GROUP BY log_date`);
    const dailyList = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); const key = toDateStr(d);
      dailyList.push({ date: key, count: Number(daily.find((x) => String(x.log_date).slice(0, 10) === key)?.c || 0) });
    }
    res.json({
      totals: { ...totals, revenue_month: Number(totals.revenue_month), revenue_total: Number(totals.revenue_total), weight_lost_kg: Number(weightLoss[0]?.kg || 0) },
      signups: monthList, daily_active: dailyList, conditions, packages,
      inactive: inactive.map((m) => ({ ...m, last_active: String(m.last_active).startsWith('2000') ? null : String(m.last_active).slice(0, 10) })),
    });
  } catch (err) { next(err); }
});

// =============== PLAN TEMPLATES ===============
const { normalizeTemplateMeals, templateMealsError } = require('../services/templateDays');
router.get('/templates', perm('plans'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT t.id, t.name, t.health_condition, t.duration_days, t.created_at, u.name AS created_by_name, t.data
         FROM plan_templates t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.name`);
    res.json(rows.map((r) => {
      let d = {}; try { d = JSON.parse(r.data); } catch {}
      return { ...r, data: undefined, meal_count: (d.meals || []).length, activity_count: (d.activities || []).length };
    }));
  } catch (err) { next(err); }
});

router.get('/templates/:id', perm('plans'), async (req, res, next) => {
  try {
    const [[t]] = await db.query('SELECT * FROM plan_templates WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ message: 'Template not found' });
    let data = {}; try { data = JSON.parse(t.data); } catch {}
    data.meals = normalizeTemplateMeals(data.meals, t.created_at, Number(t.duration_days) || 30);
    res.json({ ...t, data });
  } catch (err) { next(err); }
});

router.post('/templates', perm('plans'), async (req, res, next) => {
  try {
    const { name, health_condition, duration_days, instructions, meals, activities } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Give the template a name' });
    if ((!Array.isArray(meals) || !meals.length) && (!Array.isArray(activities) || !activities.length)) {
      return res.status(400).json({ message: 'Add at least one meal, yoga or exercise first' });
    }
    const days = Number(duration_days) || 30;
    const lenErr = planDaysError(days);
    if (lenErr) return res.status(400).json({ message: lenErr });
    // Member plan se template: tareekh -> Day number (plan ki start date se)
    const cleanMeals = normalizeTemplateMeals(meals || [], req.body.ref_date || toDateStr(), days);
    const dayErr = templateMealsError(cleanMeals, days);
    if (dayErr) return res.status(400).json({ message: dayErr });
    const data = JSON.stringify({ instructions: instructions || '', meals: cleanMeals, activities: activities || [] });
    const [r] = await db.query('INSERT INTO plan_templates (name, health_condition, duration_days, data, created_by) VALUES (?, ?, ?, ?, ?)',
      [String(name).trim(), health_condition || null, days, data, req.user.id]);
    await log(req.user.id, 'template_created', name);
    res.status(201).json({ id: r.insertId, message: 'Saved as template' });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', perm('plans'), async (req, res, next) => {
  try {
    await db.query('DELETE FROM plan_templates WHERE id = ?', [req.params.id]);
    res.json({ message: 'Template deleted' });
  } catch (err) { next(err); }
});

// =============== OTP LOG (sirf testing ke liye number dikhta hai) ===============
router.get('/otp-log', adminOnly, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT id, email, purpose, debug_code, used, attempts, created_at, expires_at, expires_at < NOW() AS expired
         FROM email_otps ORDER BY id DESC LIMIT 100`);
    res.json({ email_configured: emailConfigured(), rows: rows.map((r) => ({ ...r, expired: Boolean(r.expired) })) });
  } catch (err) { next(err); }
});

// =============== MEMBER CALENDAR ===============
router.get('/members/:id/calendar', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await staffCanAccess(req.user, id))) return res.status(403).json({ message: 'Not allowed' });
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : toDateStr().slice(0, 7);
    res.json({ month, days: await monthPlans(id, month) });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.monthPlans = monthPlans;
