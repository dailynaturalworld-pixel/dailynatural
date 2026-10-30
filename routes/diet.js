const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole, requireFeature } = require('../middleware/auth');
const { getDietForDate } = require('../services/dietService');
const { toDateStr, parseDate, isValidDate } = require('../utils');

const { hasDietAccess } = require('../services/programs');

const router = express.Router();
router.use(requireAuth, requireRole('member'), requireFeature('diet'));

// Admin ne access nahi di -> diet nahi dikhegi (locked)
router.use(async (req, res, next) => {
  try { req.dietLocked = !(await hasDietAccess(req.user.id)); next(); } catch (err) { next(err); }
});
const lockedDay = (date) => ({ date, plan: null, meals: [], activities: { yoga: [], exercise: [] }, locked: true });
const dietFor = (req, date) => (req.dietLocked ? lockedDay(date) : getDietForDate(req.user.id, date));

// Aaj ki (ya kisi date ki) diet
router.get('/today', async (req, res, next) => {
  try {
    const date = isValidDate(req.query.date) ? req.query.date : toDateStr();
    res.json(await dietFor(req, date));
  } catch (err) {
    next(err);
  }
});

// 7 din ki diet (weekly view)
router.get('/week', async (req, res, next) => {
  try {
    const start = isValidDate(req.query.start) ? parseDate(req.query.start) : new Date();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(await dietFor(req, toDateStr(d)));
    }
    res.json(days);
  } catch (err) {
    next(err);
  }
});

// Mahine ka calendar (kis din kaunsa plan)
router.get('/month', async (req, res, next) => {
  try {
    const { monthPlans } = require('./adminExtra');
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : toDateStr().slice(0, 7);
    if (req.dietLocked) return res.json({ month, days: [], locked: true });
    res.json({ month, days: await monthPlans(req.user.id, month) });
  } catch (err) {
    next(err);
  }
});

// Diet history: purane plans jo is member par lage the
router.get('/history', async (req, res, next) => {
  try {
    if (req.dietLocked) return res.json([]);
    const [rows] = await db.query(
      `SELECT dp.id, dp.title, dp.target_type, dp.start_date, dp.end_date, dp.pdf_url
         FROM diet_plans dp
        WHERE dp.start_date <= CURDATE()
          AND (dp.target_type = 'all'
            OR (dp.target_type = 'member' AND dp.target_id = ?)
            OR (dp.target_type = 'group' AND dp.target_id IN
                 (SELECT group_id FROM group_members WHERE user_id = ?)))
        ORDER BY dp.start_date DESC
        LIMIT 50`,
      [req.user.id, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Meal complete mark karna
router.post('/meals/:mealId/complete', async (req, res, next) => {
  try {
    const date = isValidDate(req.body.date) ? req.body.date : toDateStr();
    await db.query(
      'INSERT IGNORE INTO meal_completions (user_id, meal_id, log_date) VALUES (?, ?, ?)',
      [req.user.id, req.params.mealId, date]
    );
    res.json({ completed: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/meals/:mealId/complete', async (req, res, next) => {
  try {
    const date = isValidDate(req.query.date) ? req.query.date : toDateStr();
    await db.query(
      'DELETE FROM meal_completions WHERE user_id = ? AND meal_id = ? AND log_date = ?',
      [req.user.id, req.params.mealId, date]
    );
    res.json({ completed: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
