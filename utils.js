// Local date ko "YYYY-MM-DD" format mein badalna
function toDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "YYYY-MM-DD" se Date object (local time)
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// 1 = Monday ... 7 = Sunday
function isoDayOfWeek(dateStr) {
  const day = parseDate(dateStr).getDay();
  return day === 0 ? 7 : day;
}

function isValidDate(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(parseDate(str));
}

// Diet plan ki lambai: kam se kam 7 din, zyada se zyada 90 din
const PLAN_MIN_DAYS = 7;
const PLAN_MAX_DAYS = 90;
const planDays = (start, end) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
const clampPlanDays = (d) => Math.max(PLAN_MIN_DAYS, Math.min(PLAN_MAX_DAYS, Math.round(Number(d)) || 30));
const planDaysError = (d) => (d < PLAN_MIN_DAYS || d > PLAN_MAX_DAYS
  ? `A diet plan must be ${PLAN_MIN_DAYS} to ${PLAN_MAX_DAYS} days long (this one is ${d} days).` : null);

module.exports = {
  PLAN_MIN_DAYS, PLAN_MAX_DAYS, planDays, clampPlanDays, planDaysError, toDateStr, parseDate, isoDayOfWeek, isValidDate };
