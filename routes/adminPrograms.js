// Admin: Bimari programs (plan badalna) + naye members ke plan approve karna
const express = require('express');
const db = require('../config/db');
const { planDaysError, toDateStr } = require('../utils');
const { requireAuth, requireRole } = require('../middleware/auth');
const { STAFF, perm } = require('../services/access');
const { notify } = require('../services/notify');
const { sendPlanPdf } = require('../services/planDelivery');
const { staffCanAccess } = require('../services/access');
const {
  listPrograms, cleanCodes, splitCodes, programNames, createProgramPlan, refreshProgramPlans, setReview,
  accessInfo, giveAccess, removeAccess, needsAccess,
} = require('../services/programs');

const { normalizeTemplateMeals, templateMealsError } = require('../services/templateDays');
const router = express.Router();
router.use(requireAuth, requireRole(...STAFF));
const planPerm = perm('plans');
const MEAL_TYPES = ['early_morning', 'breakfast', 'mid_morning', 'lunch', 'evening_snack', 'dinner', 'bedtime'];
const log = (uid, action, details = null) =>
  db.query('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)', [uid, action, details]);

// Dietitian: apne assigned + abhi kisi ko assign nahi hue members. Admin: sab.
function memberScope(user) {
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  return { sql: '(u.assigned_dietitian_id = ? OR u.assigned_dietitian_id IS NULL)', params: [user.id] };
}

async function canReview(user, memberId) {
  const s = memberScope(user);
  const [[row]] = await db.query(`SELECT u.id FROM users u WHERE u.id = ? AND u.role = 'member' AND ${s.sql}`, [memberId, ...s.params]);
  return Boolean(row);
}

// =============== BIMARI PROGRAMS ===============
router.get('/programs', async (req, res, next) => {
  try {
    const rows = await listPrograms({ activeOnly: false });
    const [counts] = await db.query("SELECT condition_codes FROM health_profiles WHERE condition_codes IS NOT NULL AND condition_codes <> ''");
    const [templates] = await db.query('SELECT id, name, health_condition, duration_days FROM plan_templates ORDER BY name');
    res.json({
      programs: rows.map((p) => ({
        ...p,
        is_active: Boolean(p.is_active),
        members: counts.filter((c) => splitCodes(c.condition_codes).includes(p.code)).length,
      })),
      templates,
    });
  } catch (err) { next(err); }
});

// =============== NAYI BIMARI JODNA ===============
const ICONS = ['medkit-outline', 'heart-outline', 'pulse-outline', 'water-outline', 'leaf-outline', 'nutrition-outline', 'body-outline',
  'fitness-outline', 'eye-outline', 'flower-outline', 'moon-outline', 'sunny-outline', 'bandage-outline', 'thermometer-outline',
  'woman-outline', 'man-outline', 'happy-outline', 'sparkles-outline', 'cut-outline', 'trending-down-outline', 'trending-up-outline'];
router.get('/program-icons', (req, res) => res.json(ICONS));

router.post('/programs', planPerm, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ message: 'Write the name of the health problem, like "Migraine"' });
    const [[dupe]] = await db.query('SELECT code FROM condition_programs WHERE LOWER(name) = LOWER(?)', [name]);
    if (dupe) return res.status(409).json({ message: `"${name}" is already in the list` });
    const fee = req.body.fee === undefined || req.body.fee === '' ? 0 : Number(req.body.fee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1000000) return res.status(400).json({ message: 'Enter a valid fee (0 = free)' });
    const icon = ICONS.includes(req.body.icon) ? req.body.icon : 'medkit-outline';
    const description = String(req.body.description || '').trim().slice(0, 300) || null;

    // code: naam se (jaise "Kidney care" -> kidney_care), unique
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'problem';
    let code = base;
    for (let i = 2; ; i++) {
      const [[x]] = await db.query('SELECT code FROM condition_programs WHERE code = ?', [code]);
      if (!x) break;
      code = `${base}_${i}`;
    }

    // Ready plan: chune hue template ki COPY banti hai, taaki is bimari ka plan alag se badla ja sake
    let templateId = null;
    if (req.body.copy_from_template_id) {
      const [[t]] = await db.query('SELECT * FROM plan_templates WHERE id = ?', [req.body.copy_from_template_id]);
      if (!t) return res.status(400).json({ message: 'That ready plan was not found' });
      // Copy mein purani tareekhein bhi Day number ban jaati hain
      let d = {}; try { d = JSON.parse(t.data); } catch {}
      d.meals = normalizeTemplateMeals(d.meals, t.created_at, Number(t.duration_days) || 30);
      const [r] = await db.query('INSERT INTO plan_templates (name, health_condition, duration_days, data, created_by) VALUES (?, ?, ?, ?, ?)',
        [`Program: ${name}`, name, t.duration_days || 30, JSON.stringify(d), req.user.id]);
      templateId = r.insertId;
    }
    const [[mx]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM condition_programs');
    await db.query(
      `INSERT INTO condition_programs (code, name, name_hi, icon, description, plan_condition, template_id, fee, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [code, name, name, icon, description, name, templateId, Math.round(fee * 100) / 100, Number(mx.m) + 1]);
    await log(req.user.id, 'program_created', `${code} (${name})`);
    res.status(201).json({ code, template_id: templateId, message: `"${name}" added. Members can now choose it in the app.` });
  } catch (err) { next(err); }
});

// Bimari hatana: sirf tab jab koi member ise use na kar raha ho (warna "Hide" kariye)
router.delete('/programs/:code', planPerm, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT name FROM condition_programs WHERE code = ?', [req.params.code]);
    if (!p) return res.status(404).json({ message: 'Program not found' });
    const [rows] = await db.query("SELECT condition_codes FROM health_profiles WHERE condition_codes IS NOT NULL AND condition_codes <> ''");
    const used = rows.filter((r) => splitCodes(r.condition_codes).includes(req.params.code)).length;
    if (used) return res.status(400).json({ message: `${used} member(s) have chosen "${p.name}". Untick "Show in app" to hide it instead of deleting.` });
    await db.query('DELETE FROM condition_programs WHERE code = ?', [req.params.code]);
    await log(req.user.id, 'program_deleted', `${req.params.code} (${p.name})`);
    res.json({ message: `"${p.name}" removed from the list. Its ready plan is still in Plan templates.` });
  } catch (err) { next(err); }
});

router.put('/programs/:code', planPerm, async (req, res, next) => {
  try {
    const { name, name_hi, description, is_active } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ message: 'Name cannot be empty' });
    const sets = [];
    const vals = [];
    if (name !== undefined) { sets.push('name = ?'); vals.push(String(name).trim().slice(0, 80)); }
    if (name_hi !== undefined) { sets.push('name_hi = ?'); vals.push(name_hi || null); }
    if (description !== undefined) { sets.push('description = ?'); vals.push(description || null); }
    if (req.body.icon !== undefined && ICONS.includes(req.body.icon)) { sets.push('icon = ?'); vals.push(req.body.icon); }
    if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
    if ('fee' in req.body) {
      const fee = Number(req.body.fee);
      if (!Number.isFinite(fee) || fee < 0 || fee > 1000000) return res.status(400).json({ message: 'Enter a valid fee (0 = free)' });
      sets.push('fee = ?'); vals.push(Math.round(fee * 100) / 100);
    }
    if ('template_id' in req.body) { sets.push('template_id = ?'); vals.push(req.body.template_id ? Number(req.body.template_id) : null); }
    if (!sets.length) return res.status(400).json({ message: 'Nothing to change' });
    const [r] = await db.query(`UPDATE condition_programs SET ${sets.join(', ')} WHERE code = ?`, [...vals, req.params.code]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Program not found' });
    await log(req.user.id, 'program_updated', req.params.code);
    res.json({ message: 'Saved' });
  } catch (err) { next(err); }
});

// Bimari ka naya plan un sab members ko bhi jinka abhi is bimari ka auto plan chal raha hai
router.post('/programs/:code/apply-all', planPerm, async (req, res, next) => {
  try {
    const n = await refreshProgramPlans(req.params.code);
    await log(req.user.id, 'program_applied_all', `${req.params.code}: ${n} plans`);
    res.json({ updated: n, message: n ? `Updated the plan of ${n} member(s)` : 'No member has a running plan for this problem' });
  } catch (err) { next(err); }
});

// Template (ready plan) ko wahin edit karna
router.put('/templates/:id', planPerm, async (req, res, next) => {
  try {
    const { name, health_condition, duration_days, instructions, meals, activities } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Give the plan a name' });
    const m = Array.isArray(meals) ? meals : [];
    const a = Array.isArray(activities) ? activities : [];
    if (!m.length && !a.length) return res.status(400).json({ message: 'Add at least one meal, yoga or exercise first' });
    for (const x of m) {
      if (!MEAL_TYPES.includes(x.meal_type)) return res.status(400).json({ message: 'Invalid meal type' });
      if (!x.items || !String(x.items).trim()) return res.status(400).json({ message: 'Every meal needs food items' });
    }
    for (const x of a) {
      if (!['yoga', 'exercise'].includes(x.activity_type) || !x.activity_id) return res.status(400).json({ message: 'Choose a yoga or exercise for every row' });
    }
    const days = Number(duration_days) || 30;
    const lenErr = planDaysError(days);
    if (lenErr) return res.status(400).json({ message: lenErr });
    const cleanMeals = normalizeTemplateMeals(m, req.body.ref_date || toDateStr(), days);
    const dayErr = templateMealsError(cleanMeals, days);
    if (dayErr) return res.status(400).json({ message: dayErr });
    const data = JSON.stringify({ instructions: instructions || '', meals: cleanMeals, activities: a });
    const [r] = await db.query('UPDATE plan_templates SET name = ?, health_condition = ?, duration_days = ?, data = ? WHERE id = ?',
      [String(name).trim(), health_condition || null, days, data, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Template not found' });
    await log(req.user.id, 'template_updated', `template ${req.params.id}`);
    const [programs] = await db.query('SELECT code, name FROM condition_programs WHERE template_id = ?', [req.params.id]);
    res.json({ message: 'Plan saved', programs });
  } catch (err) { next(err); }
});

// =============== PLAN APPROVALS (naye members) ===============
const CHOSE = "((hp.condition_codes IS NOT NULL AND hp.condition_codes <> '') OR (hp.medical_conditions IS NOT NULL AND hp.medical_conditions <> ''))";
// Access wala tareeka: jinke paas access nahi + bimari chuni/likhi. Warna purana: review baaki
const pendingWhere = async () => ((await needsAccess())
  ? `(hp.plan_access = 0 AND ${CHOSE})`
  : "hp.plan_review IN ('pending_review','waiting_approval')");

router.get('/plan-reviews', async (req, res, next) => {
  try {
    const s = memberScope(req.user);
    const status = req.query.status || 'pending';
    const PENDING = await pendingWhere();
    let where = PENDING;
    if (status === 'approved') where = (await needsAccess()) ? 'hp.plan_access = 1' : "hp.plan_review = 'approved'";
    if (status === 'all') where = "((hp.condition_codes IS NOT NULL AND hp.condition_codes <> '') OR (hp.medical_conditions IS NOT NULL AND hp.medical_conditions <> ''))";
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.mobile, u.created_at, hp.condition_codes, hp.plan_review, hp.plan_review_at,
              hp.current_weight_kg, hp.height_cm, hp.medical_conditions, rv.name AS reviewed_by_name,
              (SELECT JSON_OBJECT('id', dp.id, 'title', dp.title, 'start_date', dp.start_date, 'end_date', dp.end_date, 'program_code', dp.program_code)
                 FROM diet_plans dp WHERE dp.target_type = 'member' AND dp.target_id = u.id AND dp.is_active = 1 AND dp.end_date >= CURDATE()
                ORDER BY dp.created_at DESC LIMIT 1) AS plan
         FROM users u JOIN health_profiles hp ON hp.user_id = u.id
         LEFT JOIN users rv ON rv.id = hp.reviewed_by
        WHERE u.role = 'member' AND u.status = 'active' AND ${where} AND ${s.sql}
        ORDER BY hp.plan_review_at DESC, u.id DESC LIMIT 300`, s.params);
    const [[c]] = await db.query(
      `SELECT COUNT(*) AS n FROM users u JOIN health_profiles hp ON hp.user_id = u.id
        WHERE u.role = 'member' AND u.status = 'active' AND ${PENDING} AND ${s.sql}`, s.params);
    const out = [];
    for (const r of rows) {
      let plan = r.plan || null;
      if (typeof plan === 'string') { try { plan = JSON.parse(plan); } catch { plan = null; } }
      out.push({
        ...r, plan, conditions: splitCodes(r.condition_codes), condition_names: await programNames(r.condition_codes),
        access: await accessInfo(r.id),
      });
    }
    res.json({ rows: out, counts: { to_check: Number(c.n || 0), pending_review: Number(c.n || 0), waiting_approval: 0 } });
  } catch (err) { next(err); }
});

// GIVE ACCESS: plan nahi hai to bimari ke ready plan (ya chuna hua template) se banta hai; member ko diet dikhne lagti hai
router.post('/plan-reviews/:id/approve', planPerm, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await canReview(req.user, id))) return res.status(403).json({ message: 'This member is not assigned to you' });
    const r = await giveAccess(id, { byUserId: req.user.id, templateId: req.body.template_id || null });
    if (r.error) return res.status(400).json({ message: r.error });
    await log(req.user.id, 'plan_access_given', `member ${id} plan ${r.plan_id}`);
    notify(id, {
      type: 'plan', title: 'Your plan is open',
      body: `${req.user.name || 'Your dietitian'} checked your details. Your diet and yoga plan is ready in the app.`, link: 'Diet',
    }).catch(() => {});
    // Plan ki PDF bhi member ko (Chat + email)
    let pdfText = '';
    if (req.body.send_pdf !== false) {
      try {
        const sent = await sendPlanPdf(id, req.user, r.plan_id);
        if (sent.ok) pdfText = sent.emailed ? ' Plan PDF sent in Chat and by email.' : ' Plan PDF sent in Chat.';
      } catch (e) { console.warn('PDF send failed:', e.message); }
    }
    res.json({ message: `Access given. Member can now see the diet plan.${pdfText}`, plan_id: r.plan_id });
  } catch (err) { next(err); }
});

// Plan PDF member ko bhejna (Chat mein file + notification + email agar set ho)
router.post('/members/:id/send-plan-pdf', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await staffCanAccess(req.user, id))) return res.status(403).json({ message: 'Not allowed' });
    const r = await sendPlanPdf(id, req.user, req.body.plan_id ? Number(req.body.plan_id) : null);
    if (r.error) return res.status(400).json({ message: r.error });
    await log(req.user.id, 'plan_pdf_sent', `member ${id} plan ${r.plan_id}`);
    res.json({ message: r.emailed ? 'Plan PDF sent in the app Chat and by email.' : 'Plan PDF sent in the app Chat. (Email is not set up, so no email.)' });
  } catch (err) { next(err); }
});

// Fees haath se mili (cash / UPI): admin "Mark paid"
router.post('/plan-reviews/:id/mark-paid', planPerm, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await canReview(req.user, id))) return res.status(403).json({ message: 'This member is not assigned to you' });
    const info = await accessInfo(id);
    if (!info.main) return res.status(400).json({ message: 'This member has not chosen a health problem from the list' });
    const amount = req.body.amount === undefined || req.body.amount === '' ? info.main.fee : Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: 'Enter a valid amount' });
    const [r] = await db.query(
      `INSERT INTO payments (user_id, program_code, method, amount, status, provider, paid_at)
       VALUES (?, ?, 'manual', ?, 'paid', ?, NOW())`, [id, info.main.code, amount, String(req.body.note || 'cash/UPI').slice(0, 20)]);
    const receipt = `HA-${new Date().getFullYear()}-${String(r.insertId).padStart(5, '0')}`;
    await db.query('UPDATE payments SET receipt_no = ? WHERE id = ?', [receipt, r.insertId]);
    await log(req.user.id, 'program_marked_paid', `member ${id} ${info.main.code} Rs ${amount}`);
    res.json({ message: `Marked as paid (Rs ${amount}). Receipt ${receipt}.` });
  } catch (err) { next(err); }
});

// Access band karna
router.post('/plan-reviews/:id/remove-access', planPerm, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await canReview(req.user, id))) return res.status(403).json({ message: 'This member is not assigned to you' });
    await removeAccess(id, req.user.id);
    await log(req.user.id, 'plan_access_removed', `member ${id}`);
    res.json({ message: 'Access removed. The member cannot see the diet plan now.' });
  } catch (err) { next(err); }
});

// Admin member ki bimari badal sakta hai (naya plan bana kar access bhi deta hai)
router.put('/members/:id/conditions', planPerm, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await canReview(req.user, id))) return res.status(403).json({ message: 'This member is not assigned to you' });
    const codes = await cleanCodes(req.body.conditions);
    await db.query('INSERT INTO health_profiles (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = user_id', [id]);
    await db.query('UPDATE health_profiles SET condition_codes = ? WHERE user_id = ?', [codes.join(',') || null, id]);
    let planId = null;
    if (codes.length && req.body.make_plan !== false) {
      planId = await createProgramPlan(id, codes, { byUserId: req.user.id });
      const r = await giveAccess(id, { byUserId: req.user.id });
      planId = r.plan_id || planId;
      const names = (await programNames(codes)).join(' + ');
      notify(id, { type: 'plan', title: 'Your plan was updated', body: `Your dietitian set a ${names} plan for you.`, link: 'Diet' }).catch(() => {});
    } else if (!codes.length) {
      await setReview(id, 'none', req.user.id);
    }
    await log(req.user.id, 'member_conditions_changed', `member ${id}: ${codes.join(',')}`);
    res.json({ message: planId ? 'Saved, new plan made and access given' : 'Saved', plan_id: planId, conditions: codes });
  } catch (err) { next(err); }
});

module.exports = router;
