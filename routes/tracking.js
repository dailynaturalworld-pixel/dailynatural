const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole, requireFeature } = require('../middleware/auth');
const { staffCanAccess, imageUpload, authAny } = require('../services/access');
const { toDateStr, isValidDate } = require('../utils');

const router = express.Router();
const diaryFiles = imageUpload('diary');
const photoFiles = imageUpload('progress');
const member = [requireAuth, requireRole('member')];
const num = (v, min, max) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

// ================= DAILY DIARY =================
router.get('/diary', ...member, requireFeature('diary'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT entry_date, mood, energy, sleep_quality, note, photo_file IS NOT NULL AS has_photo
         FROM diary_entries WHERE user_id = ? ORDER BY entry_date DESC LIMIT 60`, [req.user.id]);
    res.json(rows.map((r) => ({ ...r, entry_date: String(r.entry_date).slice(0, 10), has_photo: Boolean(r.has_photo) })));
  } catch (err) { next(err); }
});

router.put('/diary/:date', ...member, requireFeature('diary'), diaryFiles.single('photo'), async (req, res, next) => {
  try {
    const date = req.params.date;
    if (!isValidDate(date) || date > toDateStr()) { diaryFiles.remove(req.file?.filename); return res.status(400).json({ message: 'Choose today or a past date' }); }
    const mood = num(req.body.mood, 1, 5), energy = num(req.body.energy, 1, 5), sleep = num(req.body.sleep_quality, 1, 5);
    if ([mood, energy, sleep].includes(undefined)) { diaryFiles.remove(req.file?.filename); return res.status(400).json({ message: 'Ratings must be 1 to 5' }); }
    const note = String(req.body.note || '').slice(0, 3000) || null;
    const [[old]] = await db.query('SELECT photo_file FROM diary_entries WHERE user_id = ? AND entry_date = ?', [req.user.id, date]);
    let photo = old?.photo_file || null;
    if (req.file) { diaryFiles.remove(photo); photo = req.file.filename; }
    if (req.body.remove_photo === '1' && !req.file) { diaryFiles.remove(photo); photo = null; }
    await db.query(
      `INSERT INTO diary_entries (user_id, entry_date, mood, energy, sleep_quality, note, photo_file) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE mood = VALUES(mood), energy = VALUES(energy), sleep_quality = VALUES(sleep_quality),
         note = VALUES(note), photo_file = VALUES(photo_file)`,
      [req.user.id, date, mood, energy, sleep, note, photo]
    );
    res.json({ message: 'Diary saved' });
  } catch (err) { next(err); }
});

router.get('/diary-photo/:userId/:date', authAny, async (req, res, next) => {
  try {
    const uid = Number(req.params.userId);
    const ok = req.user.role === 'member' ? req.user.id === uid : await staffCanAccess(req.user, uid);
    if (!ok) return res.status(404).json({ message: 'Not found' });
    const [[r]] = await db.query('SELECT photo_file FROM diary_entries WHERE user_id = ? AND entry_date = ?', [uid, req.params.date]);
    diaryFiles.send(res, r?.photo_file);
  } catch (err) { next(err); }
});

// ================= BODY MEASUREMENTS =================
const M_FIELDS = ['waist_cm', 'hip_cm', 'chest_cm', 'arm_cm', 'thigh_cm'];

router.get('/measurements', ...member, requireFeature('progress'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT log_date, ${M_FIELDS.join(', ')} FROM body_measurements WHERE user_id = ? ORDER BY log_date ASC`, [req.user.id]);
    res.json(rows.map((r) => ({ ...r, log_date: String(r.log_date).slice(0, 10) })));
  } catch (err) { next(err); }
});

router.post('/measurements', ...member, requireFeature('progress'), async (req, res, next) => {
  try {
    const date = isValidDate(req.body.date) ? req.body.date : toDateStr();
    if (date > toDateStr()) return res.status(400).json({ message: 'Date cannot be in the future' });
    const vals = M_FIELDS.map((f) => num(req.body[f], 10, 300));
    if (vals.includes(undefined)) return res.status(400).json({ message: 'Measurements must be between 10 and 300 cm' });
    if (vals.every((v) => v === null)) return res.status(400).json({ message: 'Enter at least one measurement' });
    await db.query(
      `INSERT INTO body_measurements (user_id, log_date, ${M_FIELDS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ${M_FIELDS.map((f) => `${f} = COALESCE(VALUES(${f}), ${f})`).join(', ')}`,
      [req.user.id, date, ...vals]
    );
    res.json({ message: 'Measurements saved' });
  } catch (err) { next(err); }
});

// ================= PROGRESS PHOTOS =================
router.get('/photos', ...member, requireFeature('progress'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT id, photo_date, pose, weight_kg FROM progress_photos WHERE user_id = ? ORDER BY photo_date ASC, id ASC', [req.user.id]);
    res.json(rows.map((r) => ({ ...r, photo_date: String(r.photo_date).slice(0, 10) })));
  } catch (err) { next(err); }
});

router.post('/photos', ...member, requireFeature('progress'), photoFiles.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a photo' });
    const date = isValidDate(req.body.date) && req.body.date <= toDateStr() ? req.body.date : toDateStr();
    const pose = ['front', 'side', 'back'].includes(req.body.pose) ? req.body.pose : 'front';
    const [[p]] = await db.query('SELECT current_weight_kg FROM health_profiles WHERE user_id = ?', [req.user.id]);
    await db.query('INSERT INTO progress_photos (user_id, photo_date, pose, file_name, weight_kg) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, date, pose, req.file.filename, p?.current_weight_kg ?? null]);
    res.status(201).json({ message: 'Photo saved' });
  } catch (err) { next(err); }
});

router.delete('/photos/:id', ...member, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT file_name FROM progress_photos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ message: 'Not found' });
    await db.query('DELETE FROM progress_photos WHERE id = ?', [req.params.id]);
    photoFiles.remove(p.file_name);
    res.json({ message: 'Photo deleted' });
  } catch (err) { next(err); }
});

router.get('/photo/:id', authAny, async (req, res, next) => {
  try {
    const [[p]] = await db.query('SELECT user_id, file_name FROM progress_photos WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ message: 'Not found' });
    const ok = req.user.role === 'member' ? req.user.id === p.user_id : await staffCanAccess(req.user, p.user_id);
    if (!ok) return res.status(404).json({ message: 'Not found' });
    photoFiles.send(res, p.file_name);
  } catch (err) { next(err); }
});

// ================= GOALS =================
router.get('/goals', ...member, async (req, res, next) => {
  try {
    const [[g]] = await db.query('SELECT water_goal, steps_goal, sleep_goal, target_weight_kg FROM health_profiles WHERE user_id = ?', [req.user.id]);
    res.json({ water_goal: g?.water_goal ?? 8, steps_goal: g?.steps_goal ?? 8000, sleep_goal: Number(g?.sleep_goal ?? 8), target_weight_kg: g?.target_weight_kg ?? null });
  } catch (err) { next(err); }
});

router.put('/goals', ...member, async (req, res, next) => {
  try {
    const water = num(req.body.water_goal, 1, 20), steps = num(req.body.steps_goal, 500, 50000), sleep = num(req.body.sleep_goal, 4, 12);
    const target = num(req.body.target_weight_kg, 20, 300);
    if ([water, steps, sleep, target].includes(undefined)) {
      return res.status(400).json({ message: 'Water 1-20 glasses, steps 500-50,000, sleep 4-12 hours, target weight 20-300 kg' });
    }
    await db.query(
      `INSERT INTO health_profiles (user_id, water_goal, steps_goal, sleep_goal, target_weight_kg) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE water_goal = COALESCE(VALUES(water_goal), water_goal), steps_goal = COALESCE(VALUES(steps_goal), steps_goal),
         sleep_goal = COALESCE(VALUES(sleep_goal), sleep_goal), target_weight_kg = COALESCE(VALUES(target_weight_kg), target_weight_kg)`,
      [req.user.id, water, steps, sleep, target]
    );
    res.json({ message: 'Goals saved' });
  } catch (err) { next(err); }
});

// ================= BADGES =================
function longestStreak(dates) {
  const set = new Set(dates);
  let best = 0;
  for (const d of set) {
    const prev = new Date(d); prev.setDate(prev.getDate() - 1);
    if (set.has(toDateStr(prev))) continue; // streak ki shuruaat nahi
    let len = 0; const cur = new Date(d);
    while (set.has(toDateStr(cur))) { len++; cur.setDate(cur.getDate() + 1); }
    best = Math.max(best, len);
  }
  return best;
}

router.get('/badges', ...member, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [[p]] = await db.query('SELECT current_weight_kg, target_weight_kg, water_goal FROM health_profiles WHERE user_id = ?', [uid]);
    const [[first]] = await db.query('SELECT weight_kg FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC LIMIT 1', [uid]);
    const [[counts]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM weight_logs WHERE user_id = ?) AS weights,
              (SELECT COUNT(*) FROM meal_completions WHERE user_id = ?) AS meals,
              (SELECT COUNT(*) FROM activity_completions ac JOIN plan_activities pa ON pa.id = ac.plan_activity_id WHERE ac.user_id = ? AND pa.activity_type = 'yoga') AS yoga,
              (SELECT COUNT(*) FROM activity_completions ac JOIN plan_activities pa ON pa.id = ac.plan_activity_id WHERE ac.user_id = ? AND pa.activity_type = 'exercise') AS exercise,
              (SELECT COUNT(*) FROM member_reports WHERE user_id = ?) AS reports,
              (SELECT COUNT(*) FROM diary_entries WHERE user_id = ?) AS diary,
              (SELECT COUNT(*) FROM users WHERE referred_by = ? AND email_verified = 1) AS referrals`,
      [uid, uid, uid, uid, uid, uid, uid]
    );
    const [activeDays] = await db.query(
      `SELECT DISTINCT log_date FROM (SELECT log_date FROM meal_completions WHERE user_id = ?
         UNION SELECT log_date FROM activity_completions WHERE user_id = ?) t`, [uid, uid]);
    const best = longestStreak(activeDays.map((r) => String(r.log_date).slice(0, 10)));
    const [waterDays] = await db.query('SELECT log_date FROM habit_logs WHERE user_id = ? AND water_glasses >= ?', [uid, p?.water_goal || 8]);
    const waterBest = longestStreak(waterDays.map((r) => String(r.log_date).slice(0, 10)));
    const start = Number(first?.weight_kg || p?.current_weight_kg || 0);
    const cur = Number(p?.current_weight_kg || start);
    const gaining = p?.target_weight_kg != null && Number(p.target_weight_kg) > start;
    const moved = Math.max(0, Math.round((gaining ? cur - start : start - cur) * 10) / 10);
    const verb = gaining ? 'gained' : 'lost';

    const defs = [
      ['first_weight', 'First step', 'Log your weight for the first time', 'scale', counts.weights, 1],
      ['streak_3', '3-day streak', 'Follow your plan 3 days in a row', 'flame', best, 3],
      ['streak_7', 'Week warrior', 'Follow your plan 7 days in a row', 'flame', best, 7],
      ['streak_30', 'Unstoppable', 'Follow your plan 30 days in a row', 'trophy', best, 30],
      ['kg_2', `2 kg ${verb}`, `You have ${verb} 2 kg`, 'trending-down', moved, 2],
      ['kg_5', `5 kg ${verb}`, `You have ${verb} 5 kg`, 'medal', moved, 5],
      ['kg_10', `10 kg ${verb}`, `You have ${verb} 10 kg`, 'ribbon', moved, 10],
      ['meals_50', 'Clean eater', 'Tick 50 planned meals', 'restaurant', counts.meals, 50],
      ['yoga_10', 'Yogi', 'Finish 10 yoga sessions', 'leaf', counts.yoga, 10],
      ['exercise_10', 'Fit & strong', 'Finish 10 exercise sessions', 'barbell', counts.exercise, 10],
      ['water_7', 'Hydration hero', `Reach your water goal 7 days in a row`, 'water', waterBest, 7],
      ['diary_7', 'Mindful', 'Write 7 diary entries', 'book', counts.diary, 7],
      ['report_1', 'Health check', 'Upload your first report', 'document-text', counts.reports, 1],
      ['referral_1', 'Friend maker', 'Invite a friend who joins', 'gift', counts.referrals, 1],
    ];
    const badges = defs.map(([code, title, description, icon, value, goal]) => ({
      code, title, description, icon,
      earned: Number(value) >= goal,
      progress: Math.min(1, Number(value) / goal),
      progress_text: `${Math.min(Number(value), goal)} / ${goal}`,
    }));
    res.json({ earned: badges.filter((b) => b.earned).length, total: badges.length, best_streak: best, badges });
  } catch (err) { next(err); }
});

// ================= STAFF: member ki tracking =================
router.get('/staff/:memberId', requireAuth, async (req, res, next) => {
  try {
    const uid = Number(req.params.memberId);
    if (!(await staffCanAccess(req.user, uid))) return res.status(403).json({ message: 'Not allowed' });
    const [diary] = await db.query(
      `SELECT entry_date, mood, energy, sleep_quality, note, photo_file IS NOT NULL AS has_photo
         FROM diary_entries WHERE user_id = ? ORDER BY entry_date DESC LIMIT 14`, [uid]);
    const [measurements] = await db.query(
      `SELECT log_date, ${M_FIELDS.join(', ')} FROM body_measurements WHERE user_id = ? ORDER BY log_date DESC LIMIT 10`, [uid]);
    const [photos] = await db.query('SELECT id, photo_date, pose, weight_kg FROM progress_photos WHERE user_id = ? ORDER BY photo_date ASC', [uid]);
    const fix = (rows, k) => rows.map((r) => ({ ...r, [k]: String(r[k]).slice(0, 10) }));
    res.json({ diary: fix(diary, 'entry_date'), measurements: fix(measurements, 'log_date'), photos: fix(photos, 'photo_date') });
  } catch (err) { next(err); }
});

module.exports = router;
