const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDietForDate } = require('../services/dietService');
const { toDateStr, isValidDate, planDays, planDaysError } = require('../utils');
const { notify, memberIdsForTarget } = require('../services/notify');
const { perm } = require('../services/access');
const { sendPlanPdf } = require('../services/planDelivery');
const planPerm = perm('plans');
const libPerm = perm('libraries');

const router = express.Router();
const STAFF = ['admin', 'dietitian', 'coach', 'doctor', 'trainer'];
router.use(requireAuth, requireRole(...STAFF));
const adminOnly = requireRole('admin');
const dietStaff = requireRole('admin', 'dietitian');

async function log(userId, action, details = null) {
  await db.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
}

// Dietitian sirf apne assigned members dekh sakta hai
async function canAccessMember(req, memberId) {
  if (req.user.role === 'admin') return true;
  const [[row]] = await db.query(
    "SELECT id FROM users WHERE id = ? AND role = 'member' AND assigned_dietitian_id = ?",
    [memberId, req.user.id]
  );
  return Boolean(row);
}

// =============== DASHBOARD ===============
router.get('/stats', async (req, res, next) => {
  try {
    const scope = req.user.role === 'admin' ? '' : 'AND assigned_dietitian_id = ' + Number(req.user.id);
    const [[m]] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(status = 'active') AS active,
              SUM(status = 'inactive') AS inactive,
              SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_this_week
         FROM users WHERE role = 'member' AND status <> 'deleted' ${scope}`
    );
    const [[plans]] = await db.query(
      "SELECT COUNT(*) AS active_plans FROM diet_plans WHERE is_active = 1 AND CURDATE() BETWEEN start_date AND end_date"
    );
    const [[special]] = await db.query(
      "SELECT COUNT(*) AS c FROM diet_plans WHERE target_type = 'member' AND is_active = 1 AND end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)"
    );
    const [[groups]] = await db.query('SELECT COUNT(*) AS c FROM member_groups');
    const [[pendingReports]] = await db.query(
      `SELECT COUNT(*) AS c FROM member_reports mr JOIN users u ON u.id = mr.user_id
        WHERE mr.status = 'pending' ${scope.replace('assigned_dietitian_id', 'u.assigned_dietitian_id')}`
    );
    const [recent] = await db.query(
      `SELECT id, name, email, created_at FROM users
        WHERE role = 'member' AND status <> 'deleted' ${scope}
        ORDER BY created_at DESC LIMIT 5`
    );
    res.json({
      members: {
        total: Number(m.total) || 0,
        active: Number(m.active) || 0,
        inactive: Number(m.inactive) || 0,
        new_this_week: Number(m.new_this_week) || 0,
      },
      active_plans: plans.active_plans,
      special_plans_ending_soon: special.c,
      groups: groups.c,
      pending_reports: pendingReports.c,
      recent_members: recent,
    });
  } catch (err) {
    next(err);
  }
});

// =============== MEMBERS ===============
router.get('/members', async (req, res, next) => {
  try {
    const params = [];
    let where = "u.role = 'member' AND u.status <> 'deleted'";
    if (req.query.status && ['active', 'inactive'].includes(req.query.status)) {
      where += ' AND u.status = ?';
      params.push(req.query.status);
    }
    if (req.query.search) {
      where += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ?)';
      const s = `%${req.query.search}%`;
      params.push(s, s, s);
    }
    if (req.user.role !== 'admin') {
      where += ' AND u.assigned_dietitian_id = ?';
      params.push(req.user.id);
    }
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.mobile, u.status, u.created_at, u.email_verified,
              (SELECT COUNT(*) FROM member_reports mr WHERE mr.user_id = u.id AND mr.status = 'pending') AS pending_reports,
              hp.current_weight_kg, hp.target_weight_kg,
              d.name AS dietitian_name,
              (SELECT p.name FROM user_packages up JOIN packages p ON p.id = up.package_id
                 WHERE up.user_id = u.id AND up.status = 'active' ORDER BY up.id DESC LIMIT 1) AS package_name
         FROM users u
         LEFT JOIN health_profiles hp ON hp.user_id = u.id
         LEFT JOIN users d ON d.id = u.assigned_dietitian_id
        WHERE ${where}
        ORDER BY u.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/members/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await canAccessMember(req, id))) return res.status(403).json({ message: 'Not allowed' });
    const [[user]] = await db.query(
      `SELECT u.id, u.name, u.email, u.mobile, u.status, u.language, u.consent_at, u.created_at, u.assigned_dietitian_id,
              u.email_verified, u.referral_code, u.reward_points, r.name AS referred_by_name,
              (SELECT COUNT(*) FROM users x WHERE x.referred_by = u.id) AS referral_count
         FROM users u LEFT JOIN users r ON r.id = u.referred_by WHERE u.id = ? AND u.role = 'member'`,
      [id]
    );
    if (!user) return res.status(404).json({ message: 'Member not found' });
    const [[profile]] = await db.query('SELECT * FROM health_profiles WHERE user_id = ?', [id]);
    const [groups] = await db.query(
      'SELECT g.id, g.name FROM group_members gm JOIN member_groups g ON g.id = gm.group_id WHERE gm.user_id = ?',
      [id]
    );
    const [packages] = await db.query(
      `SELECT up.*, p.name AS package_name FROM user_packages up
         JOIN packages p ON p.id = up.package_id WHERE up.user_id = ? ORDER BY up.id DESC`,
      [id]
    );
    const [weights] = await db.query(
      'SELECT weight_kg, log_date FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC',
      [id]
    );
    const [specialPlans] = await db.query(
      `SELECT id, title, start_date, end_date, is_active FROM diet_plans
        WHERE target_type = 'member' AND target_id = ? ORDER BY start_date DESC`,
      [id]
    );
    const today = await getDietForDate(id, toDateStr());
    const [reports] = await db.query(
      `SELECT id, title, report_type, report_date, status, created_at,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = member_reports.id) AS reply_count
         FROM member_reports WHERE user_id = ? ORDER BY created_at DESC`,
      [id]
    );
    res.json({ user, profile: profile || null, groups, packages, weights, special_plans: specialPlans, today_diet: today, reports });
  } catch (err) {
    next(err);
  }
});

// Admin naya member add kare
router.post('/members', adminOnly, async (req, res, next) => {
  try {
    const { name, email, mobile, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required' });
    const [exists] = await db.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (exists.length) return res.status(409).json({ message: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.query(
      "INSERT INTO users (name, email, mobile, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 'member', 1)",
      [name, email.toLowerCase(), mobile || null, hash]
    );
    await db.query('INSERT INTO health_profiles (user_id) VALUES (?)', [r.insertId]);
    const [[pkg]] = await db.query('SELECT id FROM packages WHERE is_default = 1 AND is_active = 1 LIMIT 1');
    if (pkg) {
      await db.query(
        "INSERT INTO user_packages (user_id, package_id, start_date, created_by, note) VALUES (?, ?, CURDATE(), ?, 'Added by admin')",
        [r.insertId, pkg.id, req.user.id]
      );
    }
    await log(req.user.id, 'member_created', `member ${r.insertId}`);
    res.status(201).json({ id: r.insertId, pdf_sent: pdfSent });
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:id', adminOnly, async (req, res, next) => {
  try {
    const sets = [];
    const params = [];
    if (req.body.status !== undefined) {
      if (!['active', 'inactive'].includes(req.body.status)) return res.status(400).json({ message: 'Invalid status' });
      sets.push('status = ?');
      params.push(req.body.status);
    }
    if (req.body.assigned_dietitian_id !== undefined) {
      sets.push('assigned_dietitian_id = ?');
      params.push(req.body.assigned_dietitian_id || null);
    }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND role = 'member'`, [...params, req.params.id]);
    await log(req.user.id, 'member_updated', `member ${req.params.id}`);
    res.json({ message: 'Member updated' });
  } catch (err) {
    next(err);
  }
});

// =============== STAFF (dietitian, coach...) ===============
router.get('/staff', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      "SELECT id, name, email, mobile, role, status FROM users WHERE role IN ('admin','dietitian','coach','doctor','trainer') ORDER BY role, name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/staff', adminOnly, async (req, res, next) => {
  try {
    const { name, email, mobile, password, role } = req.body;
    if (!name || !email || !password || !STAFF.includes(role)) {
      return res.status(400).json({ message: 'Name, email, password and a valid role are required' });
    }
    const [exists] = await db.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (exists.length) return res.status(409).json({ message: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.query(
      'INSERT INTO users (name, email, mobile, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 1)',
      [name, email.toLowerCase(), mobile || null, hash, role]
    );
    await log(req.user.id, 'staff_created', `${role} ${r.insertId}`);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    next(err);
  }
});

// =============== GROUPS ===============
router.get('/groups', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT g.*, COUNT(gm.user_id) AS member_count FROM member_groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
        GROUP BY g.id ORDER BY g.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/groups/:id', async (req, res, next) => {
  try {
    const [[group]] = await db.query('SELECT * FROM member_groups WHERE id = ?', [req.params.id]);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    const [members] = await db.query(
      `SELECT u.id, u.name, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND u.status <> 'deleted' ORDER BY u.name`,
      [req.params.id]
    );
    res.json({ ...group, members });
  } catch (err) {
    next(err);
  }
});

router.post('/groups', planPerm, async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ message: 'Group name is required' });
    const [r] = await db.query('INSERT INTO member_groups (name, description) VALUES (?, ?)', [name, description || null]);
    await log(req.user.id, 'group_created', name);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    next(err);
  }
});

router.delete('/groups/:id', adminOnly, async (req, res, next) => {
  try {
    await db.query('DELETE FROM member_groups WHERE id = ?', [req.params.id]);
    await db.query("UPDATE diet_plans SET is_active = 0 WHERE target_type = 'group' AND target_id = ?", [req.params.id]);
    await log(req.user.id, 'group_deleted', `group ${req.params.id}`);
    res.json({ message: 'Group deleted' });
  } catch (err) {
    next(err);
  }
});

router.post('/groups/:id/members', planPerm, async (req, res, next) => {
  try {
    const ids = (req.body.user_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ message: 'Select at least one member' });
    await db.query(
      'INSERT IGNORE INTO group_members (group_id, user_id) VALUES ?',
      [ids.map((uid) => [Number(req.params.id), uid])]
    );
    res.json({ message: 'Members added' });
  } catch (err) {
    next(err);
  }
});

router.delete('/groups/:id/members/:userId', planPerm, async (req, res, next) => {
  try {
    await db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
    res.json({ message: 'Member removed' });
  } catch (err) {
    next(err);
  }
});

// =============== FOOD LIBRARY ===============
router.get('/foods', async (req, res, next) => {
  try {
    const [rows] = await db.query('SELECT * FROM foods ORDER BY category, name');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/foods', libPerm, async (req, res, next) => {
  try {
    const { name, serving, calories, category } = req.body;
    if (!name) return res.status(400).json({ message: 'Food name is required' });
    const [r] = await db.query(
      'INSERT INTO foods (name, serving, calories, category) VALUES (?, ?, ?, ?)',
      [name, serving || null, calories || null, category || null]
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    next(err);
  }
});

router.delete('/foods/:id', libPerm, async (req, res, next) => {
  try {
    await db.query('DELETE FROM foods WHERE id = ?', [req.params.id]);
    res.json({ message: 'Food deleted' });
  } catch (err) {
    next(err);
  }
});

// =============== DIET PLANS ===============
const MEAL_TYPES = ['early_morning', 'breakfast', 'mid_morning', 'lunch', 'evening_snack', 'dinner', 'bedtime'];

function validatePlan(body) {
  const { title, target_type, target_id, start_date, end_date, meals } = body;
  if (!title) return 'Plan title is required';
  if (!['all', 'group', 'member'].includes(target_type)) return 'Choose who this plan is for';
  if (target_type !== 'all' && !target_id) return 'Choose a group or member';
  if (!isValidDate(start_date) || !isValidDate(end_date)) return 'Start and end date are required';
  if (end_date < start_date) return 'End date must be after start date';
  const lenErr = planDaysError(planDays(start_date, end_date));
  if (lenErr) return lenErr;
  const acts = Array.isArray(body.activities) ? body.activities : [];
  if ((!Array.isArray(meals) || !meals.length) && !acts.length) return 'Add at least one meal, yoga or exercise';
  for (const a of acts) {
    if (!['yoga', 'exercise'].includes(a.activity_type) || !a.activity_id) return 'Choose a yoga or exercise for every row';
  }
  for (const m of meals || []) {
    if (!MEAL_TYPES.includes(m.meal_type)) return 'Invalid meal type';
    if (!m.items || !String(m.items).trim()) return 'Every meal needs food items';
    if (m.specific_date && !isValidDate(m.specific_date)) return 'Invalid specific date in a meal';
  }
  return null;
}

async function saveActivities(conn, planId, activities = []) {
  await conn.query('DELETE FROM plan_activities WHERE plan_id = ?', [planId]);
  if (!activities.length) return;
  const rows = activities.map((a, i) => [
    planId, a.activity_type, Number(a.activity_id),
    a.day_of_week ? Number(a.day_of_week) : null,
    a.time_slot || null,
    a.duration_min ? Number(a.duration_min) : null,
    a.sets ? Number(a.sets) : null,
    a.reps || null,
    a.notes || null,
    i,
  ]);
  await conn.query(
    `INSERT INTO plan_activities
       (plan_id, activity_type, activity_id, day_of_week, time_slot, duration_min, sets, reps, notes, sort_order)
     VALUES ?`,
    [rows]
  );
}

async function saveMeals(conn, planId, meals = []) {
  await conn.query('DELETE FROM diet_plan_meals WHERE plan_id = ?', [planId]);
  if (!meals.length) return;
  const rows = meals.map((m, i) => [
    planId,
    m.day_of_week ? Number(m.day_of_week) : null,
    m.specific_date || null,
    m.meal_type,
    m.meal_time || null,
    String(m.items).trim(),
    m.portion_size || null,
    m.alternatives || null,
    m.calories ? Number(m.calories) : null,
    i,
  ]);
  await conn.query(
    `INSERT INTO diet_plan_meals
       (plan_id, day_of_week, specific_date, meal_type, meal_time, items, portion_size, alternatives, calories, sort_order)
     VALUES ?`,
    [rows]
  );
}

router.get('/diet-plans', async (req, res, next) => {
  try {
    const params = [];
    let where = '1 = 1';
    if (req.query.target_type) {
      where += ' AND dp.target_type = ?';
      params.push(req.query.target_type);
    }
    if (req.query.status === 'current') where += ' AND CURDATE() BETWEEN dp.start_date AND dp.end_date';
    if (req.query.status === 'upcoming') where += ' AND dp.start_date > CURDATE()';
    if (req.query.status === 'past') where += ' AND dp.end_date < CURDATE()';
    const [rows] = await db.query(
      `SELECT dp.*,
              CASE dp.target_type
                WHEN 'member' THEN (SELECT name FROM users WHERE id = dp.target_id)
                WHEN 'group' THEN (SELECT name FROM member_groups WHERE id = dp.target_id)
                ELSE 'All members' END AS target_name,
              (SELECT COUNT(*) FROM diet_plan_meals WHERE plan_id = dp.id) AS meal_count,
              (SELECT COUNT(*) FROM plan_activities WHERE plan_id = dp.id AND activity_type = 'yoga') AS yoga_count,
              (SELECT COUNT(*) FROM plan_activities WHERE plan_id = dp.id AND activity_type = 'exercise') AS exercise_count
         FROM diet_plans dp WHERE ${where}
        ORDER BY dp.start_date DESC, dp.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/diet-plans/:id', async (req, res, next) => {
  try {
    const [[plan]] = await db.query('SELECT * FROM diet_plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    const [meals] = await db.query('SELECT * FROM diet_plan_meals WHERE plan_id = ? ORDER BY sort_order', [plan.id]);
    const [activities] = await db.query(
      `SELECT pa.*, COALESCE(y.name, e.name) AS name FROM plan_activities pa
         LEFT JOIN yoga_library y ON pa.activity_type = 'yoga' AND y.id = pa.activity_id
         LEFT JOIN exercise_library e ON pa.activity_type = 'exercise' AND e.id = pa.activity_id
        WHERE pa.plan_id = ? ORDER BY pa.activity_type, pa.sort_order`,
      [plan.id]
    );
    res.json({ ...plan, meals, activities });
  } catch (err) {
    next(err);
  }
});

router.post('/diet-plans', planPerm, async (req, res, next) => {
  const error = validatePlan(req.body);
  if (error) return res.status(400).json({ message: error });
  if (req.body.target_type === 'member' && !(await canAccessMember(req, req.body.target_id))) {
    return res.status(403).json({ message: 'This member is not assigned to you' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const b = req.body;
    const [r] = await conn.query(
      `INSERT INTO diet_plans (title, description, target_type, target_id, start_date, end_date, health_condition, instructions, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.title, b.description || null, b.target_type, b.target_type === 'all' ? null : b.target_id,
       b.start_date, b.end_date, b.health_condition || null, b.instructions || null, req.user.id]
    );
    await saveMeals(conn, r.insertId, b.meals || []);
    await saveActivities(conn, r.insertId, b.activities || []);
    await conn.commit();
    await log(req.user.id, 'diet_plan_created', `plan ${r.insertId} for ${b.target_type} ${b.target_id || ''}`);
    let pdfSent = false;
    if (b.send_pdf && b.target_type === 'member') {
      try { pdfSent = Boolean((await sendPlanPdf(Number(b.target_id), req.user, r.insertId)).ok); } catch (e) { console.warn('PDF send failed:', e.message); }
    }
    if (b.target_type !== 'all') {
      notify(await memberIdsForTarget(b.target_type, b.target_id), {
        type: 'plan', title: 'Your new plan is ready', body: `${b.title} starts ${b.start_date}. Open the app to see your diet, yoga and exercise.`, link: 'Home',
      }).catch(() => {});
    }
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.put('/diet-plans/:id', planPerm, async (req, res, next) => {
  const error = validatePlan(req.body);
  if (error) return res.status(400).json({ message: error });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const b = req.body;
    const [r] = await conn.query(
      `UPDATE diet_plans SET title = ?, description = ?, target_type = ?, target_id = ?,
         start_date = ?, end_date = ?, health_condition = ?, instructions = ?, is_active = ?
       WHERE id = ?`,
      [b.title, b.description || null, b.target_type, b.target_type === 'all' ? null : b.target_id,
       b.start_date, b.end_date, b.health_condition || null, b.instructions || null,
       b.is_active === false ? 0 : 1, req.params.id]
    );
    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ message: 'Plan not found' });
    }
    await saveMeals(conn, req.params.id, b.meals || []);
    await saveActivities(conn, req.params.id, b.activities || []);
    await conn.commit();
    await log(req.user.id, 'diet_plan_updated', `plan ${req.params.id}`);
    let pdfSent = false;
    if (b.send_pdf && b.target_type === 'member') {
      try { pdfSent = Boolean((await sendPlanPdf(Number(b.target_id), req.user, Number(req.params.id))).ok); } catch (e) { console.warn('PDF send failed:', e.message); }
    }
    res.json({ message: 'Plan updated', pdf_sent: pdfSent });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.delete('/diet-plans/:id', planPerm, async (req, res, next) => {
  try {
    await db.query('DELETE FROM diet_plans WHERE id = ?', [req.params.id]);
    await log(req.user.id, 'diet_plan_deleted', `plan ${req.params.id}`);
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    next(err);
  }
});

// Preview: kisi member ko kisi date par kaunsi diet dikhegi
router.get('/members/:id/diet-preview', async (req, res, next) => {
  try {
    const date = isValidDate(req.query.date) ? req.query.date : toDateStr();
    res.json(await getDietForDate(Number(req.params.id), date));
  } catch (err) {
    next(err);
  }
});

// =============== HEALTH CONDITIONS (bimariyan) ===============
const CONDITIONS = [
  'Diabetes', 'Thyroid', 'PCOD/PCOS', 'High BP', 'Cholesterol', 'Weight loss', 'Weight gain', 'Hair fall',
  'Back pain', 'Joint pain', 'Digestion', 'Stress', 'General fitness',
];
router.get('/conditions', (req, res) => res.json(CONDITIONS));

// =============== YOGA & EXERCISE LIBRARY ===============
function libraryRoutes(path, table, fields) {
  router.get(path, async (req, res, next) => {
    try {
      const [rows] = await db.query(`SELECT * FROM ${table} ORDER BY name`);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });
  const pick = (body) => fields.map((f) => (body[f] === '' || body[f] === undefined ? null : body[f]));
  router.post(path, libPerm, async (req, res, next) => {
    try {
      if (!req.body.name) return res.status(400).json({ message: 'Name is required' });
      const [r] = await db.query(
        `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        pick(req.body)
      );
      await log(req.user.id, `${table}_created`, req.body.name);
      res.status(201).json({ id: r.insertId });
    } catch (err) {
      next(err);
    }
  });
  router.put(`${path}/:id`, libPerm, async (req, res, next) => {
    try {
      if (!req.body.name) return res.status(400).json({ message: 'Name is required' });
      await db.query(
        `UPDATE ${table} SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
        [...pick(req.body), req.params.id]
      );
      res.json({ message: 'Saved' });
    } catch (err) {
      next(err);
    }
  });
  router.delete(`${path}/:id`, libPerm, async (req, res, next) => {
    try {
      const type = table === 'yoga_library' ? 'yoga' : 'exercise';
      const [[used]] = await db.query(
        'SELECT COUNT(*) AS c FROM plan_activities WHERE activity_type = ? AND activity_id = ?',
        [type, req.params.id]
      );
      if (used.c) return res.status(400).json({ message: `This is used in ${used.c} plan(s). Remove it from those plans first.` });
      const [[media]] = await db.query(`SELECT image_file, video_file FROM ${table} WHERE id = ?`, [req.params.id]);
      await db.query(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
      if (media) { const { remove } = require('./media'); remove(media.image_file); remove(media.video_file); }
      res.json({ message: 'Deleted' });
    } catch (err) {
      next(err);
    }
  });
}

libraryRoutes('/yoga', 'yoga_library', [
  'name', 'sanskrit_name', 'category', 'duration_min', 'difficulty', 'benefits',
  'instructions', 'precautions', 'good_for', 'image_url', 'video_url',
]);
libraryRoutes('/exercises', 'exercise_library', [
  'name', 'category', 'duration_min', 'sets', 'reps', 'calories_burn',
  'instructions', 'precautions', 'good_for', 'video_url',
]);

// =============== PACKAGES ===============
router.get('/packages', async (req, res, next) => {
  try {
    const [pkgs] = await db.query('SELECT * FROM packages ORDER BY id');
    const [features] = await db.query(
      `SELECT pf.package_id, f.code, f.name, pf.enabled FROM package_features pf
         JOIN features f ON f.code = pf.feature_code ORDER BY f.name`
    );
    res.json(pkgs.map((p) => ({ ...p, features: features.filter((f) => f.package_id === p.id) })));
  } catch (err) {
    next(err);
  }
});

// Admin kisi member ko package de (free ya paid)
router.post('/members/:id/package', adminOnly, async (req, res, next) => {
  try {
    const { package_id, start_date, end_date, granted_free, price_paid, note } = req.body;
    if (!package_id) return res.status(400).json({ message: 'Choose a package' });
    await db.query("UPDATE user_packages SET status = 'expired' WHERE user_id = ? AND status = 'active'", [req.params.id]);
    await db.query(
      `INSERT INTO user_packages (user_id, package_id, start_date, end_date, granted_free, price_paid, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, package_id, isValidDate(start_date) ? start_date : toDateStr(),
       isValidDate(end_date) ? end_date : null, granted_free ? 1 : 0, price_paid || 0, note || null, req.user.id]
    );
    await log(req.user.id, 'package_assigned', `member ${req.params.id} package ${package_id}`);
    res.json({ message: 'Package assigned' });
  } catch (err) {
    next(err);
  }
});

// =============== ACTIVITY LOG ===============
router.get('/activity', adminOnly, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT a.*, u.name AS user_name FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
