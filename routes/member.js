const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole, requireFeature } = require('../middleware/auth');
const { getDietForDate } = require('../services/dietService');
const { toDateStr, isValidDate } = require('../utils');
const { ensureReferralCode } = require('../services/referral');
const { getSetting } = require('../services/settings');
const { listPrograms, cleanCodes, splitCodes, programNames, startProgramForMember, staffToNotify, setReview, accessInfo, hasDietAccess } = require('../services/programs');
const { notify } = require('../services/notify');

const router = express.Router();
router.use(requireAuth, requireRole('member'));

const WATER_GOAL = 8;
const STEPS_GOAL = 8000;

const PROFILE_FIELDS = [
  'dob', 'gender', 'address', 'height_cm', 'current_weight_kg', 'target_weight_kg',
  'blood_group', 'medical_conditions', 'allergies', 'food_restrictions',
  'lifestyle', 'diet_preference', 'health_history',
];

function bmi(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

function bmiCategory(value) {
  if (!value) return null;
  if (value < 18.5) return 'Underweight';
  if (value < 25) return 'Normal';
  if (value < 30) return 'Overweight';
  return 'Obese';
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateStr(d);
}

// Lagatar kitne din member active raha (koi meal ya yoga/exercise tick kiya)
async function getStreak(userId) {
  const [rows] = await db.query(
    `SELECT DISTINCT log_date FROM (
        SELECT log_date FROM meal_completions WHERE user_id = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)
        UNION
        SELECT log_date FROM activity_completions WHERE user_id = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)
     ) t`,
    [userId, userId]
  );
  const days = new Set(rows.map((r) => String(r.log_date).slice(0, 10)));
  let streak = 0;
  // Aaj abhi kuch nahi kiya to kal se ginti
  let i = days.has(daysAgo(0)) ? 0 : 1;
  while (days.has(daysAgo(i))) {
    streak++;
    i++;
  }
  return streak;
}

async function getProfile(userId) {
  const [[profile]] = await db.query('SELECT * FROM health_profiles WHERE user_id = ?', [userId]);
  return profile || {};
}

async function programInfo(profile) {
  const codes = splitCodes(profile.condition_codes);
  return {
    codes, names: await programNames(codes), status: profile.plan_review || 'none', note: profile.medical_conditions || '',
    access: profile.user_id ? await accessInfo(profile.user_id) : null,
  };
}

// ---------- 10 BIMARI LIST ----------
router.get('/programs', async (req, res, next) => {
  try {
    const rows = await listPrograms();
    res.json(rows.map((p) => ({
      code: p.code, name: p.name, name_hi: p.name_hi, icon: p.icon, description: p.description,
      fee: Number(p.fee || 0), days: p.duration_days || 30,
    })));
  } catch (err) { next(err); }
});

// ---------- DASHBOARD ----------
router.get('/dashboard', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const today = toDateStr();
    const [[user]] = await db.query('SELECT name FROM users WHERE id = ?', [uid]);
    const profile = await getProfile(uid);
    const [[habits]] = await db.query(
      'SELECT water_glasses, steps, sleep_hours FROM habit_logs WHERE user_id = ? AND log_date = ?',
      [uid, today]
    );
    const [trend] = await db.query(
      `SELECT * FROM (SELECT weight_kg, log_date FROM weight_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT 12) t
        ORDER BY log_date ASC`,
      [uid]
    );
    const [[first]] = await db.query(
      'SELECT weight_kg FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC LIMIT 1',
      [uid]
    );
    const [[pkg]] = await db.query(
      `SELECT p.name, up.end_date FROM user_packages up JOIN packages p ON p.id = up.package_id
        WHERE up.user_id = ? AND up.status = 'active' ORDER BY up.id DESC LIMIT 1`,
      [uid]
    );
    const locked = !(await hasDietAccess(uid));
    const day = locked
      ? { date: today, plan: null, meals: [], activities: { yoga: [], exercise: [] } }
      : await getDietForDate(uid, today);
    const acts = [...day.activities.yoga, ...day.activities.exercise];
    const h = habits || { water_glasses: 0, steps: 0, sleep_hours: 0 };
    const waterGoal = profile.water_goal || WATER_GOAL;
    const stepsGoal = profile.steps_goal || STEPS_GOAL;
    const b = bmi(profile.height_cm, profile.current_weight_kg);
    const start = first?.weight_kg ?? profile.current_weight_kg ?? null;

    res.json({
      name: user?.name,
      date: today,
      weight: {
        current: profile.current_weight_kg ?? null,
        target: profile.target_weight_kg ?? null,
        start,
        change: start != null && profile.current_weight_kg != null
          ? Math.round((profile.current_weight_kg - start) * 10) / 10 : null,
        bmi: b,
        bmi_category: bmiCategory(b),
        trend: trend.map((t) => ({ date: t.log_date, weight: t.weight_kg })),
      },
      rings: {
        diet: { done: day.meals.filter((m) => m.completed).length, total: day.meals.length },
        water: { done: h.water_glasses, total: waterGoal },
        activity: { done: acts.filter((a) => a.completed).length, total: acts.length },
      },
      habits: h,
      goals: { water: waterGoal, steps: stepsGoal, sleep: Number(profile.sleep_goal || 8) },
      plan: day.plan,
      meals: day.meals,
      yoga: day.activities.yoga,
      exercise: day.activities.exercise,
      streak: await getStreak(uid),
      package: pkg || null,
      profile_complete: Boolean(profile.height_cm && profile.current_weight_kg),
      program: await programInfo(profile),
      locked,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- ADVANCED DASHBOARD (insights) ----------
router.get('/insights', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const range = ['30', '90', '365', 'all'].includes(req.query.range) ? req.query.range : '90';
    const profile = await getProfile(uid);
    const waterGoal = profile.water_goal || WATER_GOAL;
    const stepsGoal = profile.steps_goal || STEPS_GOAL;

    const [weights] = await db.query(
      `SELECT weight_kg, log_date FROM weight_logs WHERE user_id = ?
        ${range === 'all' ? '' : 'AND log_date >= DATE_SUB(CURDATE(), INTERVAL ' + Number(range) + ' DAY)'}
        ORDER BY log_date ASC`,
      [uid]
    );
    const [[allW]] = await db.query(
      `SELECT MIN(weight_kg) AS lowest, MAX(weight_kg) AS highest,
              (SELECT weight_kg FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC LIMIT 1) AS start
         FROM weight_logs WHERE user_id = ?`,
      [uid, uid]
    );

    // Pichle 7 din
    const [habitRows] = await db.query(
      `SELECT log_date, water_glasses, steps, sleep_hours FROM habit_logs
        WHERE user_id = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`,
      [uid]
    );
    const habitMap = Object.fromEntries(habitRows.map((r) => [String(r.log_date).slice(0, 10), r]));
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const date = daysAgo(i);
      const d = await getDietForDate(uid, date);
      const acts = [...d.activities.yoga, ...d.activities.exercise];
      const hb = habitMap[date] || {};
      week.push({
        date,
        water: hb.water_glasses || 0,
        steps: hb.steps || 0,
        sleep: Number(hb.sleep_hours || 0),
        meals_done: d.meals.filter((m) => m.completed).length,
        meals_total: d.meals.length,
        activities_done: acts.filter((a) => a.completed).length,
        activities_total: acts.length,
        active_minutes: acts.filter((a) => a.completed).reduce((s, a) => s + (Number(a.duration_min) || 0), 0),
        calories_planned: d.meals.reduce((s, m) => s + (m.calories || 0), 0),
        calories_eaten: d.meals.filter((m) => m.completed).reduce((s, m) => s + (m.calories || 0), 0),
      });
    }

    // Naya member: average sirf join karne ke din se
    const [[joined]] = await db.query('SELECT DATEDIFF(CURDATE(), DATE(created_at)) + 1 AS days FROM users WHERE id = ?', [uid]);
    const n = Math.max(1, Math.min(7, Number(joined?.days) || 7));
    const sum = (k) => week.reduce((s, d) => s + d[k], 0);
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const dietPct = pct(sum('meals_done'), sum('meals_total'));
    const activityPct = pct(sum('activities_done'), sum('activities_total'));
    const avgWater = Math.round((sum('water') / n) * 10) / 10;
    const avgSteps = Math.round(sum('steps') / n);
    const avgSleep = Math.round((sum('sleep') / n) * 10) / 10;

    // Health score 0-100 (sirf motivation ke liye, medical score nahi)
    const sleepScore = avgSleep >= 7 && avgSleep <= 9 ? 100 : Math.max(0, 100 - Math.abs(8 - avgSleep) * 25);
    const score = Math.round(
      dietPct * 0.35 +
      (sum('activities_total') ? activityPct : 50) * 0.25 +
      Math.min(100, (avgWater / waterGoal) * 100) * 0.15 +
      sleepScore * 0.15 +
      Math.min(100, (avgSteps / stepsGoal) * 100) * 0.10
    );

    const [[totals]] = await db.query(
      `SELECT SUM(pa.activity_type = 'yoga') AS yoga, SUM(pa.activity_type = 'exercise') AS exercise
         FROM activity_completions ac JOIN plan_activities pa ON pa.id = ac.plan_activity_id
        WHERE ac.user_id = ?`,
      [uid]
    );

    const b = bmi(profile.height_cm, profile.current_weight_kg);
    res.json({
      range,
      weight: {
        series: weights.map((w) => ({ date: w.log_date, weight: w.weight_kg })),
        current: profile.current_weight_kg ?? null,
        target: profile.target_weight_kg ?? null,
        start: allW?.start ?? null,
        lowest: allW?.lowest ?? null,
        highest: allW?.highest ?? null,
        change: allW?.start != null && profile.current_weight_kg != null
          ? Math.round((profile.current_weight_kg - allW.start) * 10) / 10 : null,
        to_go: profile.target_weight_kg != null && profile.current_weight_kg != null
          ? Math.round((profile.current_weight_kg - profile.target_weight_kg) * 10) / 10 : null,
      },
      bmi: { value: b, category: bmiCategory(b), height_cm: profile.height_cm ?? null },
      week,
      summary: {
        health_score: score,
        diet_adherence: dietPct,
        activity_completion: activityPct,
        avg_water: avgWater,
        avg_steps: avgSteps,
        avg_sleep: avgSleep,
        active_minutes_week: sum('active_minutes'),
        streak: await getStreak(uid),
        total_yoga_sessions: Number(totals?.yoga) || 0,
        total_exercise_sessions: Number(totals?.exercise) || 0,
      },
      goals: { water: waterGoal, steps: stepsGoal },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- START WALK (session) ----------
router.post('/walks', async (req, res, next) => {
  try {
    const steps = Math.round(Number(req.body.steps)), dur = Math.round(Number(req.body.duration_sec));
    const dist = Math.round(Number(req.body.distance_m)), cal = Math.round(Number(req.body.calories));
    if (![steps, dur, dist, cal].every((n) => Number.isFinite(n) && n >= 0) || steps > 100000 || dur > 86400) {
      return res.status(400).json({ message: 'Invalid walk data' });
    }
    if (dur < 10) return res.status(400).json({ message: 'Walk was too short to save' });
    const started = new Date(Date.now() - dur * 1000);
    const [r] = await db.query(
      'INSERT INTO walk_sessions (user_id, started_at, duration_sec, steps, distance_m, calories) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, started, dur, steps, dist, cal]);
    res.status(201).json({ id: r.insertId, message: 'Walk saved' });
  } catch (err) { next(err); }
});

router.get('/walks', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT id, started_at, duration_sec, steps, distance_m, calories FROM walk_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 30', [req.user.id]);
    const [[week]] = await db.query(
      `SELECT COUNT(*) AS walks, COALESCE(SUM(steps),0) AS steps, COALESCE(SUM(distance_m),0) AS distance_m,
              COALESCE(SUM(calories),0) AS calories, COALESCE(SUM(duration_sec),0) AS duration_sec
         FROM walk_sessions WHERE user_id = ? AND started_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`, [req.user.id]);
    const [[p]] = await db.query('SELECT height_cm, current_weight_kg, steps_goal FROM health_profiles WHERE user_id = ?', [req.user.id]);
    // Steps page: aaj ke steps + pichhle 7 din
    const [daily] = await db.query(
      `SELECT log_date, steps FROM habit_logs WHERE user_id = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`, [req.user.id]);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); const key = toDateStr(d);
      days.push({ date: key, steps: Number(daily.find((x) => String(x.log_date).slice(0, 10) === key)?.steps || 0) });
    }
    res.json({
      walks: rows, week, height_cm: p?.height_cm || null, weight_kg: p?.current_weight_kg || null,
      today_steps: days[6].steps, steps_goal: p?.steps_goal || STEPS_GOAL, days,
    });
  } catch (err) { next(err); }
});

// ---------- MERE PACKAGE KE FEATURES (app buttons dikhane/chhupane ke liye) ----------
router.get('/features', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT pf.feature_code FROM user_packages up JOIN package_features pf ON pf.package_id = up.package_id
        WHERE up.user_id = ? AND up.status = 'active' AND pf.enabled = 1
          AND (up.end_date IS NULL OR up.end_date >= CURDATE())
        ORDER BY up.id DESC`, [req.user.id]);
    res.json(rows.map((r) => r.feature_code));
  } catch (err) { next(err); }
});

// ---------- REFER & EARN ----------
router.get('/referrals', async (req, res, next) => {
  try {
    const code = await ensureReferralCode(req.user.id);
    const REFERRAL_POINTS = Number(await getSetting('referral_points')) || 100;
    const [[me]] = await db.query('SELECT reward_points FROM users WHERE id = ?', [req.user.id]);
    const [friends] = await db.query(
      `SELECT name, email_verified, created_at FROM users
        WHERE referred_by = ? AND status <> 'deleted' ORDER BY created_at DESC`,
      [req.user.id]
    );
    const appName = process.env.APP_NAME || 'HealthApp';
    res.json({
      code,
      points: me?.reward_points || 0,
      points_per_referral: REFERRAL_POINTS,
      joined: friends.filter((f) => f.email_verified).length,
      pending: friends.filter((f) => !f.email_verified).length,
      friends: friends.map((f) => ({
        // Privacy: sirf pehla naam
        name: String(f.name || '').split(' ')[0],
        joined: Boolean(f.email_verified),
        date: f.created_at,
      })),
      share_message: `Join me on ${appName} for diet, yoga and health tracking. Use my code ${code} when you sign up!`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- WEIGHT LOG ----------
router.post('/weight', async (req, res, next) => {
  try {
    const w = Number(req.body.weight_kg);
    const date = isValidDate(req.body.date) ? req.body.date : toDateStr();
    if (!w || w < 20 || w > 300) return res.status(400).json({ message: 'Enter a weight between 20 and 300 kg' });
    if (date > toDateStr()) return res.status(400).json({ message: 'Date cannot be in the future' });
    await db.query(
      `INSERT INTO weight_logs (user_id, weight_kg, log_date) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)`,
      [req.user.id, w, date]
    );
    // Profile mein current weight = sabse latest entry
    const [[latest]] = await db.query(
      'SELECT weight_kg FROM weight_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT 1',
      [req.user.id]
    );
    await db.query(
      `INSERT INTO health_profiles (user_id, current_weight_kg) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE current_weight_kg = VALUES(current_weight_kg)`,
      [req.user.id, latest.weight_kg]
    );
    res.json({ message: 'Weight saved', current_weight_kg: latest.weight_kg });
  } catch (err) {
    next(err);
  }
});

router.get('/weight-history', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT weight_kg, log_date FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- YOGA / EXERCISE COMPLETE ----------
router.post('/activities/:id/complete', async (req, res, next) => {
  try {
    const date = isValidDate(req.body.date) ? req.body.date : toDateStr();
    await db.query(
      'INSERT IGNORE INTO activity_completions (user_id, plan_activity_id, log_date) VALUES (?, ?, ?)',
      [req.user.id, req.params.id, date]
    );
    res.json({ completed: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/activities/:id/complete', async (req, res, next) => {
  try {
    const date = isValidDate(req.query.date) ? req.query.date : toDateStr();
    await db.query(
      'DELETE FROM activity_completions WHERE user_id = ? AND plan_activity_id = ? AND log_date = ?',
      [req.user.id, req.params.id, date]
    );
    res.json({ completed: false });
  } catch (err) {
    next(err);
  }
});

// ---------- HEALTH PROFILE ----------
router.get('/profile', requireFeature('health_profile'), async (req, res, next) => {
  try {
    const p = await getProfile(req.user.id);
    const b = bmi(p.height_cm, p.current_weight_kg);
    res.json({ ...p, user_id: req.user.id, bmi: b, bmi_category: bmiCategory(b), program: await programInfo(p) });
  } catch (err) {
    next(err);
  }
});

router.put('/profile', requireFeature('health_profile'), async (req, res, next) => {
  try {
    const data = {};
    for (const f of PROFILE_FIELDS) {
      if (req.body[f] !== undefined) data[f] = req.body[f] === '' ? null : req.body[f];
    }
    const conditionsSent = Array.isArray(req.body.conditions);
    if (!Object.keys(data).length && !conditionsSent) return res.status(400).json({ message: 'Nothing to update' });
    if (!Object.keys(data).length) data.updated_at = new Date();
    const old = await getProfile(req.user.id);

    const cols = Object.keys(data);
    await db.query(
      `INSERT INTO health_profiles (user_id, ${cols.join(', ')})
       VALUES (?, ${cols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
      [req.user.id, ...cols.map((c) => data[c])]
    );

    if (data.current_weight_kg) {
      await db.query(
        `INSERT INTO weight_logs (user_id, weight_kg, log_date) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)`,
        [req.user.id, data.current_weight_kg, toDateStr()]
      );
    }
    // Bimari list se badli -> naya plan (auto) ya admin approval
    let planMessage = null;
    if (conditionsSent) {
      const before = await getProfile(req.user.id);
      const codes = await cleanCodes(req.body.conditions);
      if (codes.join(',') !== splitCodes(before.condition_codes).join(',')) {
        const r = await startProgramForMember(req.user.id, codes, { reason: 'changed' });
        if (r.plan_id) planMessage = 'Your new plan is ready. Your dietitian will check it soon.';
        else if (r.status === 'waiting_approval') planMessage = 'Your dietitian will approve your new plan soon.';
        else if (r.status === 'pending_review') planMessage = 'Your dietitian will update your plan soon.';
      }
    }
    // Member ne apni problem apne shabdon mein likhi -> dietitian/admin ko khabar + Plan approvals mein
    const note = data.medical_conditions === undefined ? undefined : String(data.medical_conditions || '').trim();
    if (note && note !== String(old.medical_conditions || '').trim()) {
      const [[u]] = await db.query('SELECT name FROM users WHERE id = ?', [req.user.id]);
      notify(await staffToNotify(req.user.id), {
        type: 'plan', title: `${u?.name || 'A member'} wrote about their health`,
        body: note.slice(0, 300), link: 'PlanReviews',
      }).catch(() => {});
      const cur = await getProfile(req.user.id);
      if (cur.plan_review !== 'waiting_approval') await setReview(req.user.id, 'pending_review');
      planMessage = planMessage || 'Your dietitian will read it and update your plan.';
    }
    const p = await getProfile(req.user.id);
    const b = bmi(p.height_cm, p.current_weight_kg);
    const program = await programInfo(p);
    if (planMessage && program.access?.required && !program.access.has_access) {
      planMessage = program.access.step === 'pay'
        ? `Your ${program.access.main.name} plan fee is Rs ${program.access.main.fee}. Pay to start; your dietitian will then open your plan.`
        : 'Your dietitian will check it and open your plan soon.';
    }
    res.json({ ...p, bmi: b, bmi_category: bmiCategory(b), program, plan_message: planMessage });
  } catch (err) {
    next(err);
  }
});

// ---------- HABITS ----------
router.get('/habits/today', requireFeature('habits'), async (req, res, next) => {
  try {
    const [[row]] = await db.query(
      'SELECT water_glasses, steps, sleep_hours FROM habit_logs WHERE user_id = ? AND log_date = ?',
      [req.user.id, toDateStr()]
    );
    res.json(row || { water_glasses: 0, steps: 0, sleep_hours: 0 });
  } catch (err) {
    next(err);
  }
});

router.put('/habits/today', requireFeature('habits'), async (req, res, next) => {
  try {
    const water = Math.max(0, parseInt(req.body.water_glasses ?? 0, 10) || 0);
    const steps = Math.max(0, parseInt(req.body.steps ?? 0, 10) || 0);
    const sleep = Math.max(0, parseFloat(req.body.sleep_hours ?? 0) || 0);
    await db.query(
      `INSERT INTO habit_logs (user_id, log_date, water_glasses, steps, sleep_hours)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE water_glasses = VALUES(water_glasses),
         steps = VALUES(steps), sleep_hours = VALUES(sleep_hours)`,
      [req.user.id, toDateStr(), water, steps, sleep]
    );
    res.json({ water_glasses: water, steps, sleep_hours: sleep });
  } catch (err) {
    next(err);
  }
});

// Phone ke step sensor se automatic steps (sirf steps badalta hai, paani/neend nahi)
// GREATEST: agar sensor kam bataye (app restart), to purani badi ginti hi rahe
router.post('/habits/steps', requireFeature('habits'), async (req, res, next) => {
  try {
    const steps = Math.round(Number(req.body.steps));
    if (!Number.isFinite(steps) || steps < 0 || steps > 100000) return res.status(400).json({ message: 'Invalid steps' });
    const date = isValidDate(req.body.date) && req.body.date <= toDateStr() ? req.body.date : toDateStr();
    await db.query(
      `INSERT INTO habit_logs (user_id, log_date, steps) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE steps = GREATEST(steps, VALUES(steps))`,
      [req.user.id, date, steps]
    );
    const [[row]] = await db.query('SELECT steps FROM habit_logs WHERE user_id = ? AND log_date = ?', [req.user.id, date]);
    res.json({ steps: row.steps });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
