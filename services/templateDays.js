// Ready plan (template) mein tareekh nahi, "Day number" (Day 1 ... Day 90) save hota hai.
// Member ko plan dete waqt Day number ko uski start date se asli tareekh mein badla jata hai:
//   start 15 Dec  ->  Day 1 = 15 Dec, Day 12 = 26 Dec
const { isValidDate, planDays } = require('../utils');

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}

const dateOnly = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};

const validDayNo = (n, days) => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= days;

/**
 * Template ke meals ko saaf format mein: har meal ya to roz, ya hafte ka din, ya Day number.
 * Purane templates mein agar asli tareekh (specific_date) padi hai to use refDate se Day number banaya jata hai.
 */
function normalizeTemplateMeals(meals, refDate, days = 90) {
  const ref = dateOnly(refDate);
  return (meals || []).map((m) => {
    const out = { ...m };
    let dayNo = out.day_no != null && out.day_no !== '' ? Number(out.day_no) : null;
    if (!dayNo && out.specific_date && ref && isValidDate(dateOnly(out.specific_date))) {
      dayNo = planDays(ref, dateOnly(out.specific_date));
      dayNo = Math.max(1, Math.min(days, dayNo));
    }
    delete out.specific_date;
    if (dayNo) { out.day_no = dayNo; out.day_of_week = null; } else out.day_no = null;
    return out;
  });
}

// Day number -> member ki asli tareekh. Plan ki lambai se bahar wale din chhod diye jaate hain.
function datedMeals(meals, startDate, days) {
  const start = dateOnly(startDate);
  const out = [];
  for (const m of meals || []) {
    const { day_no: dayNo, ...rest } = m;
    if (dayNo) {
      if (!validDayNo(dayNo, days)) continue;
      out.push({ ...rest, day_of_week: null, specific_date: addDays(start, Number(dayNo) - 1) });
    } else if (rest.specific_date && !dayNo) {
      out.push({ ...rest, specific_date: null }); // tareekh bina Day number: roz wala maan lo
    } else out.push({ ...rest, specific_date: null });
  }
  return out;
}

// Template save karne se pehle jaanch: Day number plan ki lambai ke andar ho
function templateMealsError(meals, days) {
  for (const m of meals || []) {
    if (m.day_no != null && m.day_no !== '' && !validDayNo(m.day_no, days)) {
      return `Day ${m.day_no} is outside the plan. This plan has Day 1 to Day ${days}.`;
    }
  }
  return null;
}

module.exports = { normalizeTemplateMeals, datedMeals, templateMealsError, addDays, dateOnly };
