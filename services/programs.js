// Bimari programs: member bimari chunta hai -> us bimari ka ready plan (template) se uska special plan banta hai.
// Settings mein plan_mode:
//   auto     = plan turant shuru, dietitian/admin baad mein check karke approve/edit karte hain
//   approval = pehle admin/dietitian approve karega, tab plan shuru hoga
const db = require('../config/db');
const { toDateStr, clampPlanDays } = require('../utils');
const { getSetting } = require('./settings');
const { notify } = require('./notify');
const { normalizeTemplateMeals, datedMeals, dateOnly } = require('./templateDays');

const MAX_CONDITIONS = 2;

async function listPrograms({ activeOnly = true } = {}) {
  try {
    const [rows] = await db.query(
      `SELECT cp.*, t.name AS template_name, t.duration_days
         FROM condition_programs cp LEFT JOIN plan_templates t ON t.id = cp.template_id
        ${activeOnly ? 'WHERE cp.is_active = 1' : ''}
        ORDER BY cp.sort_order, cp.name`);
    return rows;
  } catch {
    return []; // purana database (v8) jisme table nahi hai
  }
}

// "diabetes, bp" / ['diabetes','bp'] -> sirf valid codes, max 2
async function cleanCodes(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const wanted = [...new Set(raw.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];
  const valid = (await listPrograms()).map((p) => p.code);
  return wanted.filter((c) => valid.includes(c)).slice(0, MAX_CONDITIONS);
}

const splitCodes = (s) => String(s || '').split(',').map((c) => c.trim()).filter(Boolean);

async function programNames(codes) {
  const list = splitCodes(Array.isArray(codes) ? codes.join(',') : codes);
  if (!list.length) return [];
  const [rows] = await db.query('SELECT code, name FROM condition_programs WHERE code IN (?)', [list]);
  return list.map((c) => rows.find((r) => r.code === c)?.name).filter(Boolean);
}

async function loadTemplate(templateId) {
  if (!templateId) return null;
  const [[t]] = await db.query('SELECT * FROM plan_templates WHERE id = ?', [templateId]);
  if (!t) return null;
  let data = {};
  try { data = JSON.parse(t.data); } catch {}
  data.meals = normalizeTemplateMeals(data.meals, t.created_at, clampPlanDays(t.duration_days));
  return { ...t, data };
}

async function insertMealsAndActivities(conn, planId, meals, activities) {
  await conn.query('DELETE FROM diet_plan_meals WHERE plan_id = ?', [planId]);
  await conn.query('DELETE FROM plan_activities WHERE plan_id = ?', [planId]);
  const m = (meals || []).filter((x) => x.meal_type && x.items);
  if (m.length) {
    await conn.query(
      `INSERT INTO diet_plan_meals (plan_id, day_of_week, specific_date, meal_type, meal_time, items, portion_size, alternatives, calories, sort_order) VALUES ?`,
      [m.map((x, i) => [planId, x.specific_date ? null : (x.day_of_week || null), x.specific_date || null, x.meal_type, x.meal_time || null, x.items,
        x.portion_size || null, x.alternatives || null, x.calories ? Number(x.calories) : null, i])]);
  }
  const a = (activities || []).filter((x) => x.activity_id && ['yoga', 'exercise'].includes(x.activity_type));
  if (a.length) {
    await conn.query(
      `INSERT INTO plan_activities (plan_id, activity_type, activity_id, day_of_week, time_slot, duration_min, sets, reps, notes, sort_order) VALUES ?`,
      [a.map((x, i) => [planId, x.activity_type, Number(x.activity_id), x.day_of_week || null, x.time_slot || null,
        x.duration_min ? Number(x.duration_min) : null, x.sets ? Number(x.sets) : null, x.reps || null, x.notes || null, i])]);
  }
}

// Bimari codes -> plan ka content (pehli bimari = diet + yoga; doosri ki yoga/exercise bhi judti hai)
async function buildProgramContent(codes, templateId = null) {
  const programs = await listPrograms({ activeOnly: false });
  const chosen = codes.map((c) => programs.find((p) => p.code === c)).filter(Boolean);
  const main = chosen[0];
  const tpl = await loadTemplate(templateId || main?.template_id);
  if (!tpl) return null;
  const activities = [...(tpl.data.activities || [])];
  for (const extra of chosen.slice(1)) {
    const t2 = await loadTemplate(extra.template_id);
    for (const a of t2?.data.activities || []) {
      if (!activities.some((x) => x.activity_type === a.activity_type && Number(x.activity_id) === Number(a.activity_id))) activities.push(a);
    }
  }
  const names = chosen.map((p) => p.name);
  let instructions = tpl.data.instructions || '';
  if (names.length > 1) instructions += `\n\nYour plan covers: ${names.join(' + ')}. Yoga and exercise for both are included.`;
  return { tpl, main, names, meals: tpl.data.meals || [], activities, instructions };
}

/**
 * Bimari ke template se member ka special plan banana (aaj se shuru).
 * Purane auto program plans band ho jaate hain (staff ke haath se bane plan nahi chhede jaate).
 */
async function createProgramPlan(userId, codes, { byUserId = null, templateId = null } = {}) {
  const c = await buildProgramContent(codes, templateId);
  if (!c) return null;
  const start = toDateStr();
  const days = clampPlanDays(c.tpl.duration_days);
  const end = new Date(); end.setDate(end.getDate() + days - 1);
  const title = c.names.length ? `${c.names.join(' + ')} plan` : c.tpl.name.replace(/^Program:\s*/, '');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "UPDATE diet_plans SET is_active = 0 WHERE target_type = 'member' AND target_id = ? AND program_code IS NOT NULL AND is_active = 1",
      [userId]);
    const [r] = await conn.query(
      `INSERT INTO diet_plans (title, description, target_type, target_id, start_date, end_date, health_condition, instructions, program_code, created_by)
       VALUES (?, ?, 'member', ?, ?, ?, ?, ?, ?, ?)`,
      [title, `Made from "${c.tpl.name}"`, userId, start, toDateStr(end),
       c.main?.plan_condition || c.tpl.health_condition || null, c.instructions, c.main?.code || 'custom', byUserId]);
    await insertMealsAndActivities(conn, r.insertId, datedMeals(c.meals, start, days), c.activities);
    await conn.commit();
    return r.insertId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Admin ne bimari ka plan badla -> us bimari wale sab members ke chalu auto plans mein naya khana/yoga (dates wahi)
async function refreshProgramPlans(code) {
  const [plans] = await db.query(
    `SELECT dp.id, dp.target_id, dp.start_date, dp.end_date, hp.condition_codes FROM diet_plans dp
       LEFT JOIN health_profiles hp ON hp.user_id = dp.target_id
      WHERE dp.program_code = ? AND dp.target_type = 'member' AND dp.is_active = 1 AND dp.end_date >= CURDATE()`, [code]);
  let n = 0;
  for (const p of plans) {
    const codes = splitCodes(p.condition_codes);
    const c = await buildProgramContent(codes[0] === code ? codes : [code]);
    if (!c) continue;
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE diet_plans SET instructions = ? WHERE id = ?', [c.instructions, p.id]);
      const start = dateOnly(p.start_date);
      const days = Math.max(1, Math.round((Date.parse(`${dateOnly(p.end_date)}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1);
      await insertMealsAndActivities(conn, p.id, datedMeals(c.meals, start, days), c.activities);
      await conn.commit();
      n++;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
  return n;
}

// Member ke paas staff ka banaya (program ke bahar ka) chalu special plan hai?
async function hasCustomPlan(userId) {
  const [[row]] = await db.query(
    `SELECT id FROM diet_plans WHERE target_type = 'member' AND target_id = ? AND is_active = 1
        AND program_code IS NULL AND end_date >= CURDATE() LIMIT 1`, [userId]);
  return Boolean(row);
}

async function setReview(userId, status, byUserId = null) {
  await db.query(
    `UPDATE health_profiles SET plan_review = ?, plan_review_at = NOW(), reviewed_by = ? WHERE user_id = ?`,
    [status, byUserId, userId]);
}

async function staffToNotify(userId) {
  const [rows] = await db.query(
    `SELECT id FROM users WHERE status = 'active' AND (role = 'admin'
        OR id = (SELECT assigned_dietitian_id FROM users WHERE id = ?))`, [userId]);
  return rows.map((r) => r.id);
}

/**
 * Member ne bimari chuni (register par ya profile mein badli). Setting ke hisaab se:
 * auto -> turant starter plan + staff ko "check karein"; approval -> staff approve karega.
 */
async function startProgramForMember(userId, codes, { reason = 'new' } = {}) {
  await db.query('UPDATE health_profiles SET condition_codes = ? WHERE user_id = ?', [codes.join(',') || null, userId]);
  if (!codes.length) {
    await setReview(userId, 'none');
    return { status: 'none' };
  }
  const needsAccess = (await getSetting('diet_needs_access')) !== '0';
  const mode = needsAccess ? 'approval' : (await getSetting('plan_mode')) === 'approval' ? 'approval' : 'auto';
  const [[u]] = await db.query('SELECT name FROM users WHERE id = ?', [userId]);
  const names = (await programNames(codes)).join(' + ');
  let planId = null;
  let status;
  if (mode === 'auto' && !(await hasCustomPlan(userId))) {
    planId = await createProgramPlan(userId, codes);
    status = 'pending_review';
  } else {
    status = mode === 'auto' ? 'pending_review' : 'waiting_approval';
  }
  await setReview(userId, status);
  const what = reason === 'changed' ? 'changed their health problem to' : 'joined with';
  notify(await staffToNotify(userId), {
    type: 'plan',
    title: status === 'waiting_approval' ? 'New member waiting for plan approval' : 'Check starter plan of new member',
    body: `${u?.name || 'A member'} ${what} ${names}. Open "Plan approvals" in admin panel.`,
    link: 'PlanReviews',
  }).catch(() => {});
  if (planId) {
    notify(userId, {
      type: 'plan', title: 'Your starter plan is ready',
      body: `We made a ${names} plan for you. Your dietitian will check it soon.`, link: 'Diet',
    }).catch(() => {});
  }
  return { status, plan_id: planId };
}

// ================= ACCESS + FEES =================
async function needsAccess() {
  return (await getSetting('diet_needs_access')) !== '0';
}

// Member diet dekh sakta hai? (setting band ho to sab dekhte hain)
async function hasDietAccess(userId) {
  if (!(await needsAccess())) return true;
  const [[hp]] = await db.query(
    'SELECT plan_access, access_until FROM health_profiles WHERE user_id = ?', [userId]);
  if (!hp || !hp.plan_access) return false;
  return !hp.access_until || String(hp.access_until).slice(0, 10) >= toDateStr();
}

// Bimari plan ki payment hui? (pichhli access khatam hone ke baad ki payment hi gini jaati hai)
async function paidFor(userId, code) {
  if (!code) return null;
  const [[hp]] = await db.query('SELECT access_until FROM health_profiles WHERE user_id = ?', [userId]);
  const [[pay]] = await db.query(
    `SELECT id, amount, method, receipt_no, paid_at FROM payments
      WHERE user_id = ? AND program_code = ? AND status = 'paid' AND paid_at > ?
      ORDER BY id DESC LIMIT 1`, [userId, code, hp?.access_until ? `${String(hp.access_until).slice(0, 10)} 23:59:59` : '2000-01-01']);
  return pay || null;
}

/**
 * App ke liye poori halat:
 * step: choose (bimari nahi chuni) | pay (fees baaki) | waiting (admin access dega) | active (diet dikh rahi)
 */
async function accessInfo(userId) {
  const [[hp]] = await db.query('SELECT * FROM health_profiles WHERE user_id = ?', [userId]);
  const codes = splitCodes(hp?.condition_codes);
  const programs = await listPrograms({ activeOnly: false });
  const main = programs.find((p) => p.code === codes[0]) || null;
  const access = await hasDietAccess(userId);
  const required = await needsAccess();
  const paid = main ? await paidFor(userId, main.code) : null;
  const fee = main ? Number(main.fee || 0) : 0;
  let step = 'active';
  if (!access) {
    if (!main && !hp?.medical_conditions) step = 'choose';
    else if (fee > 0 && !paid) step = 'pay';
    else step = 'waiting';
  }
  return {
    required, has_access: access, access_until: hp?.access_until ? String(hp.access_until).slice(0, 10) : null, step,
    main: main ? { code: main.code, name: main.name, fee, days: clampPlanDays(main.duration_days), description: main.description } : null,
    paid: paid ? { amount: Number(paid.amount), method: paid.method, receipt_no: paid.receipt_no, paid_at: paid.paid_at, id: paid.id } : null,
  };
}

// Admin ne access di: plan banao (zaroorat ho to), access_until = plan ki aakhri tareekh
async function giveAccess(userId, { byUserId = null, templateId = null } = {}) {
  const [[hp]] = await db.query('SELECT condition_codes FROM health_profiles WHERE user_id = ?', [userId]);
  const codes = splitCodes(hp?.condition_codes);
  const [[active]] = await db.query(
    `SELECT id, program_code, end_date FROM diet_plans WHERE target_type = 'member' AND target_id = ? AND is_active = 1
        AND end_date >= CURDATE() ORDER BY created_at DESC LIMIT 1`, [userId]);
  let planId = active?.id || null;
  const outdated = active && active.program_code && codes.length && active.program_code !== codes[0];
  if (templateId || !active || outdated) {
    if (!codes.length && !templateId) return { error: 'Choose a ready plan for this member, or make one with "Make plan".' };
    planId = await createProgramPlan(userId, codes, { byUserId, templateId });
    if (!planId) return { error: 'No ready plan found. Set a plan for this problem in "Disease programs".' };
  }
  const [[plan]] = await db.query('SELECT end_date FROM diet_plans WHERE id = ?', [planId]);
  await db.query(
    `UPDATE health_profiles SET plan_access = 1, access_until = ?, plan_review = 'approved', plan_review_at = NOW(), reviewed_by = ?
      WHERE user_id = ?`, [plan ? String(plan.end_date).slice(0, 10) : null, byUserId, userId]);
  return { plan_id: planId };
}

async function removeAccess(userId, byUserId = null) {
  await db.query('UPDATE health_profiles SET plan_access = 0, reviewed_by = ? WHERE user_id = ?', [byUserId, userId]);
}

module.exports = {
  MAX_CONDITIONS, listPrograms, cleanCodes, splitCodes, programNames, loadTemplate,
  createProgramPlan, refreshProgramPlans, buildProgramContent, insertMealsAndActivities, staffToNotify, startProgramForMember, setReview, hasCustomPlan,
  needsAccess, hasDietAccess, paidFor, accessInfo, giveAccess, removeAccess,
};
