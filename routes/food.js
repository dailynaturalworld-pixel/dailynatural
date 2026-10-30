const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { requireAuth, requireRole, requireFeature } = require('../middleware/auth');
const { getSettings } = require('../services/settings');
const { staffCanAccess, imageUpload, authAny } = require('../services/access');
const { askAI, parseJson } = require('../services/ai');
const { getDietForDate } = require('../services/dietService');
const { toDateStr, isValidDate } = require('../utils');

const router = express.Router();
const files = imageUpload('food');
const member = [requireAuth, requireRole('member'), requireFeature('ai_food_scan')];
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];


const SYSTEM = `You are a nutrition assistant inside an Indian diet and health app.
You look at a photo of a plate or meal and estimate what is on it and its nutrition.
You know Indian home food well (roti, chapati, paratha, rice, dal, sabzi, paneer, curd, raita, poha, upma, idli, dosa, sambar, khichdi, chole, rajma, salad, sweets, snacks) as well as common international food.
Estimate portion size from the plate, bowls (katori), spoons and hands visible in the photo. Assume typical home cooking with normal oil unless the photo clearly shows otherwise.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{
  "is_food": true,
  "items": [
    { "name": "Chapati", "portion": "2 medium", "calories": 240, "protein_g": 7, "carbs_g": 44, "fat_g": 4, "confidence": "high" }
  ],
  "health_note": "One or two short, friendly sentences about this meal for this person."
}
Rules:
- "confidence" is "high", "medium" or "low".
- Numbers are whole numbers for one portion as seen in the photo.
- If the photo has no food, reply {"is_food": false, "items": [], "health_note": "I could not see any food in this photo."}
- Never give medical advice or diagnose. Keep the note practical (e.g. add salad, less oil, good protein).
- Write the note in simple English.`;

function sumItems(items) {
  const t = { total_calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const it of items) {
    const f = Number(it.factor) || 1;
    t.total_calories += (Number(it.calories) || 0) * f;
    t.protein_g += (Number(it.protein_g) || 0) * f;
    t.carbs_g += (Number(it.carbs_g) || 0) * f;
    t.fat_g += (Number(it.fat_g) || 0) * f;
  }
  return {
    total_calories: Math.round(t.total_calories),
    protein_g: Math.round(t.protein_g * 10) / 10,
    carbs_g: Math.round(t.carbs_g * 10) / 10,
    fat_g: Math.round(t.fat_g * 10) / 10,
  };
}

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 15).map((it) => ({
    name: String(it.name || 'Food').slice(0, 80),
    portion: String(it.portion || '').slice(0, 60),
    calories: Math.max(0, Math.min(3000, Math.round(Number(it.calories) || 0))),
    protein_g: Math.max(0, Math.min(300, Number(it.protein_g) || 0)),
    carbs_g: Math.max(0, Math.min(500, Number(it.carbs_g) || 0)),
    fat_g: Math.max(0, Math.min(300, Number(it.fat_g) || 0)),
    confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium',
    factor: [0.5, 1, 1.5, 2, 2.5, 3].includes(Number(it.factor)) ? Number(it.factor) : 1,
  }));
}

function shape(r) {
  let items = [];
  try { items = JSON.parse(r.items || '[]'); } catch {}
  return { ...r, log_date: String(r.log_date).slice(0, 10), items, has_photo: Boolean(r.photo_file), photo_file: undefined };
}

function guessMeal() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h >= 19) return 'dinner';
  return 'snack';
}

// ---------- AI SCAN ----------
router.post('/scan', ...member, files.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Take or choose a photo of your food' });
    const settings = await getSettings();
    const limit = Number(settings.ai_daily_scan_limit) || 20;
    const DAILY_LIMIT = () => limit;
    if (settings.ai_food_enabled !== '1') {
      files.remove(req.file.filename);
      return res.status(503).json({ message: 'AI food scan is turned off by the admin right now.' });
    }
    const [[used]] = await db.query(
      "SELECT COUNT(*) AS c FROM food_logs WHERE user_id = ? AND source = 'ai' AND DATE(created_at) = CURDATE()", [req.user.id]);
    if (used.c >= DAILY_LIMIT()) {
      files.remove(req.file.filename);
      return res.status(429).json({ message: `You have used all ${DAILY_LIMIT()} food scans for today. Try again tomorrow.` });
    }

    // Member ki jaankari: AI ka note uske hisaab se
    const [[p]] = await db.query(
      'SELECT medical_conditions, allergies, diet_preference, food_restrictions FROM health_profiles WHERE user_id = ?', [req.user.id]);
    const today = await getDietForDate(req.user.id, toDateStr());
    const planned = today.meals.reduce((s, m) => s + (m.calories || 0), 0);
    const context = [
      p?.medical_conditions && `Health conditions: ${p.medical_conditions}`,
      today.plan?.health_condition && `Plan is for: ${today.plan.health_condition}`,
      p?.diet_preference && `Diet: ${p.diet_preference}`,
      p?.allergies && `Allergies: ${p.allergies}`,
      p?.food_restrictions && `Avoids: ${p.food_restrictions}`,
      planned && `Planned calories today: about ${planned} kcal`,
    ].filter(Boolean).join('. ');

    const data = fs.readFileSync(req.file.path).toString('base64');
    const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype) ? req.file.mimetype : 'image/jpeg';
    let result;
    try {
      const text = await askAI({
        system: SYSTEM,
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: `About this person: ${context || 'no details given'}. What is on this plate and how much nutrition does it have?` },
        ],
      });
      result = parseJson(text);
    } catch (e) {
      files.remove(req.file.filename);
      return res.status(e.status || 502).json({ message: e.status ? e.message : 'AI could not read this photo. Please try a clearer photo.' });
    }

    if (!result.is_food || !Array.isArray(result.items) || !result.items.length) {
      files.remove(req.file.filename);
      return res.status(422).json({ message: result.health_note || 'I could not see any food in this photo. Try again with the plate clearly visible.' });
    }

    const items = cleanItems(result.items);
    const totals = sumItems(items);
    const meal = MEALS.includes(req.body.meal_type) ? req.body.meal_type : guessMeal();
    const [r] = await db.query(
      `INSERT INTO food_logs (user_id, log_date, meal_type, photo_file, items, total_calories, protein_g, carbs_g, fat_g, ai_note, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai')`,
      [req.user.id, toDateStr(), meal, req.file.filename, JSON.stringify(items), totals.total_calories,
       totals.protein_g, totals.carbs_g, totals.fat_g, String(result.health_note || '').slice(0, 600)]
    );
    const [[row]] = await db.query('SELECT * FROM food_logs WHERE id = ?', [r.insertId]);
    res.status(201).json({ ...shape(row), scans_left: DAILY_LIMIT() - used.c - 1 });
  } catch (err) { next(err); }
});

// ---------- FOOD LOG ----------
router.get('/logs', ...member, async (req, res, next) => {
  try {
    const date = isValidDate(req.query.date) ? req.query.date : toDateStr();
    const [rows] = await db.query('SELECT * FROM food_logs WHERE user_id = ? AND log_date = ? ORDER BY created_at ASC', [req.user.id, date]);
    const logs = rows.map(shape);
    const day = await getDietForDate(req.user.id, date);
    const total = logs.reduce((s, l) => ({
      calories: s.calories + l.total_calories, protein_g: s.protein_g + Number(l.protein_g),
      carbs_g: s.carbs_g + Number(l.carbs_g), fat_g: s.fat_g + Number(l.fat_g),
    }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
    ['protein_g', 'carbs_g', 'fat_g'].forEach((k) => { total[k] = Math.round(total[k] * 10) / 10; });
    res.json({ date, logs, total, planned_calories: day.meals.reduce((s, m) => s + (m.calories || 0), 0) || null });
  } catch (err) { next(err); }
});

router.put('/logs/:id', ...member, async (req, res, next) => {
  try {
    const [[row]] = await db.query('SELECT * FROM food_logs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ message: 'Not found' });
    const items = req.body.items ? cleanItems(req.body.items) : JSON.parse(row.items || '[]');
    if (!items.length) return res.status(400).json({ message: 'Keep at least one food item, or delete this meal' });
    const totals = sumItems(items);
    const meal = MEALS.includes(req.body.meal_type) ? req.body.meal_type : row.meal_type;
    await db.query(
      'UPDATE food_logs SET items = ?, meal_type = ?, total_calories = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?',
      [JSON.stringify(items), meal, totals.total_calories, totals.protein_g, totals.carbs_g, totals.fat_g, row.id]
    );
    const [[fresh]] = await db.query('SELECT * FROM food_logs WHERE id = ?', [row.id]);
    res.json(shape(fresh));
  } catch (err) { next(err); }
});

router.delete('/logs/:id', ...member, async (req, res, next) => {
  try {
    const [[row]] = await db.query('SELECT photo_file FROM food_logs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ message: 'Not found' });
    await db.query('DELETE FROM food_logs WHERE id = ?', [req.params.id]);
    files.remove(row.photo_file);
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

router.get('/photo/:id', authAny, async (req, res, next) => {
  try {
    const [[row]] = await db.query('SELECT user_id, photo_file FROM food_logs WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ message: 'Not found' });
    const ok = req.user.role === 'member' ? row.user_id === req.user.id : await staffCanAccess(req.user, row.user_id);
    if (!ok) return res.status(404).json({ message: 'Not found' });
    files.send(res, row.photo_file);
  } catch (err) { next(err); }
});

// ---------- STAFF ----------
router.get('/staff/:memberId', requireAuth, async (req, res, next) => {
  try {
    const uid = Number(req.params.memberId);
    if (!(await staffCanAccess(req.user, uid))) return res.status(403).json({ message: 'Not allowed' });
    const [rows] = await db.query('SELECT * FROM food_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [uid]);
    res.json(rows.map(shape));
  } catch (err) { next(err); }
});

module.exports = router;
