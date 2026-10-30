const db = require('../config/db');
const { isoDayOfWeek } = require('../utils');

const MEAL_ORDER = ['early_morning', 'breakfast', 'mid_morning', 'lunch', 'evening_snack', 'dinner', 'bedtime'];

/**
 * Kisi member ke liye kisi date par kaunsa diet plan lagega.
 * Priority: individual (member) > group > common (all)
 */
async function getPlanForDate(userId, dateStr) {
  const [plans] = await db.query(
    `SELECT dp.*,
            CASE dp.target_type WHEN 'member' THEN 3 WHEN 'group' THEN 2 ELSE 1 END AS priority,
            mg.name AS group_name
       FROM diet_plans dp
       LEFT JOIN member_groups mg ON dp.target_type = 'group' AND mg.id = dp.target_id
      WHERE dp.is_active = 1
        AND ? BETWEEN dp.start_date AND dp.end_date
        AND (
              dp.target_type = 'all'
           OR (dp.target_type = 'member' AND dp.target_id = ?)
           OR (dp.target_type = 'group' AND dp.target_id IN
                 (SELECT group_id FROM group_members WHERE user_id = ?))
        )
      ORDER BY priority DESC, dp.created_at DESC
      LIMIT 1`,
    [dateStr, userId, userId]
  );
  return plans[0] || null;
}

/**
 * Plan ke meals jo kisi date par dikhne chahiye.
 * Agar us date ke liye "specific_date" wale meals hain (jaise fasting day), sirf wahi.
 * Warna: roz wale (day_of_week NULL) + us din ke (day_of_week = 1..7).
 */
async function getMealsForDate(planId, dateStr, userId = null) {
  const [special] = await db.query(
    'SELECT * FROM diet_plan_meals WHERE plan_id = ? AND specific_date = ?',
    [planId, dateStr]
  );
  let meals = special;
  if (!special.length) {
    const [regular] = await db.query(
      `SELECT * FROM diet_plan_meals
        WHERE plan_id = ? AND specific_date IS NULL
          AND (day_of_week IS NULL OR day_of_week = ?)`,
      [planId, isoDayOfWeek(dateStr)]
    );
    meals = regular;
  }

  if (userId && meals.length) {
    const [done] = await db.query(
      `SELECT meal_id FROM meal_completions
        WHERE user_id = ? AND log_date = ? AND meal_id IN (?)`,
      [userId, dateStr, meals.map((m) => m.id)]
    );
    const doneSet = new Set(done.map((d) => d.meal_id));
    meals = meals.map((m) => ({ ...m, completed: doneSet.has(m.id) }));
  }

  return meals.sort(
    (a, b) =>
      MEAL_ORDER.indexOf(a.meal_type) - MEAL_ORDER.indexOf(b.meal_type) ||
      (a.sort_order || 0) - (b.sort_order || 0)
  );
}

/**
 * Plan ke Yoga aur Exercise jo us date (weekday) par hain, library details ke saath.
 */
async function getActivitiesForDate(planId, dateStr, userId = null) {
  const [rows] = await db.query(
    `SELECT pa.*,
            COALESCE(y.name, e.name) AS name,
            y.sanskrit_name,
            COALESCE(y.category, e.category) AS category,
            y.difficulty,
            y.benefits,
            COALESCE(y.instructions, e.instructions) AS instructions,
            COALESCE(y.precautions, e.precautions) AS precautions,
            COALESCE(y.video_url, e.video_url) AS video_url,
            COALESCE(y.video_file, e.video_file) AS video_file,
            COALESCE(y.image_file, e.image_file) AS image_file,
            y.image_url,
            e.calories_burn,
            COALESCE(pa.duration_min, y.duration_min, e.duration_min) AS duration,
            COALESCE(pa.sets, e.sets) AS sets_final,
            COALESCE(pa.reps, e.reps) AS reps_final
       FROM plan_activities pa
       LEFT JOIN yoga_library y ON pa.activity_type = 'yoga' AND y.id = pa.activity_id
       LEFT JOIN exercise_library e ON pa.activity_type = 'exercise' AND e.id = pa.activity_id
      WHERE pa.plan_id = ? AND (pa.day_of_week IS NULL OR pa.day_of_week = ?)
      ORDER BY pa.activity_type, pa.sort_order`,
    [planId, isoDayOfWeek(dateStr)]
  );
  let items = rows.filter((r) => r.name).map((r) => ({
    id: r.id,
    type: r.activity_type,
    name: r.name,
    sanskrit_name: r.sanskrit_name,
    category: r.category,
    difficulty: r.difficulty,
    time_slot: r.time_slot,
    duration_min: r.duration,
    sets: r.sets_final,
    reps: r.reps_final,
    notes: r.notes,
    benefits: r.benefits,
    instructions: r.instructions,
    precautions: r.precautions,
    video_url: r.video_url,
    image_url: r.image_url,
    activity_id: r.activity_id,
    has_video_file: Boolean(r.video_file),
    has_image_file: Boolean(r.image_file),
    calories_burn: r.calories_burn,
    completed: false,
  }));
  if (userId && items.length) {
    const [done] = await db.query(
      `SELECT plan_activity_id FROM activity_completions
        WHERE user_id = ? AND log_date = ? AND plan_activity_id IN (?)`,
      [userId, dateStr, items.map((i) => i.id)]
    );
    const set = new Set(done.map((d) => d.plan_activity_id));
    items = items.map((i) => ({ ...i, completed: set.has(i.id) }));
  }
  return {
    yoga: items.filter((i) => i.type === 'yoga'),
    exercise: items.filter((i) => i.type === 'exercise'),
  };
}

async function getDietForDate(userId, dateStr) {
  const plan = await getPlanForDate(userId, dateStr);
  if (!plan) return { date: dateStr, plan: null, meals: [], activities: { yoga: [], exercise: [] } };
  const meals = await getMealsForDate(plan.id, dateStr, userId);
  const activities = await getActivitiesForDate(plan.id, dateStr, userId);
  return {
    date: dateStr,
    plan: {
      id: plan.id,
      title: plan.title,
      description: plan.description,
      instructions: plan.instructions,
      type: plan.target_type,          // member = special plan
      health_condition: plan.health_condition,
      group_name: plan.group_name,
      start_date: plan.start_date,
      end_date: plan.end_date,
      pdf_url: plan.pdf_url,
    },
    meals,
    activities,
  };
}

module.exports = { getPlanForDate, getMealsForDate, getActivitiesForDate, getDietForDate, MEAL_ORDER };
