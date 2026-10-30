const PDFDocument = require('pdfkit');
const db = require('../config/db');
const { getPlanForDate } = require('./dietService');
const { toDateStr } = require('../utils');

const GREEN = '#1F7A4D', DARK = '#14532D', MUTED = '#5E7266', MINT = '#E8F5EC';
const APP = () => process.env.APP_NAME || 'HealthApp';
const MEAL = { early_morning: 'Early morning', breakfast: 'Breakfast', mid_morning: 'Mid-morning', lunch: 'Lunch', evening_snack: 'Evening snack', dinner: 'Dinner', bedtime: 'Bedtime' };
const MEAL_ORDER = Object.keys(MEAL);
const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pretty = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };

function header(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 90).fill(DARK);
  doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text(APP(), 40, 26);
  doc.fontSize(11).font('Helvetica').fillColor('#A9CDB6').text(title, 40, 56);
  if (subtitle) doc.text(subtitle, 40, 56, { align: 'right', width: doc.page.width - 80 });
  doc.y = 110; doc.fillColor('#1C2B23');
}
function section(doc, title) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(14).fillColor(GREEN).text(title, 40);
  doc.moveTo(40, doc.y + 2).lineTo(doc.page.width - 40, doc.y + 2).strokeColor('#D5E6DB').lineWidth(1).stroke();
  doc.moveDown(0.5).fillColor('#1C2B23').font('Helvetica').fontSize(10.5);
}
function footer(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor(MUTED).text(
      `${APP()} · This plan is diet and wellness guidance and does not replace advice from your doctor. · Page ${i + 1} of ${range.count}`,
      40, doc.page.height - 40, { width: doc.page.width - 80, align: 'center' });
  }
}

// Kaunsa plan: diya gaya id, warna aaj chal raha, warna member ka sabse naya chalu/aane wala special plan
async function pickPlan(userId, planId = null) {
  if (planId) {
    const [[p]] = await db.query('SELECT * FROM diet_plans WHERE id = ?', [planId]);
    return p || null;
  }
  const today = await getPlanForDate(userId, toDateStr());
  if (today) return today;
  const [[next]] = await db.query(
    `SELECT * FROM diet_plans WHERE target_type = 'member' AND target_id = ? AND is_active = 1 AND end_date >= CURDATE()
      ORDER BY start_date LIMIT 1`, [userId]);
  return next || null;
}

// Plan PDF ka poora content doc par likhna. Plan na ho to null.
async function drawPlan(doc, userId, planId = null) {
  const [[u]] = await db.query('SELECT u.name, hp.current_weight_kg, hp.target_weight_kg, hp.medical_conditions FROM users u LEFT JOIN health_profiles hp ON hp.user_id = u.id WHERE u.id = ?', [userId]);
  const plan = await pickPlan(userId, planId);
  if (!plan) return null;
  const [meals] = await db.query('SELECT * FROM diet_plan_meals WHERE plan_id = ? ORDER BY sort_order', [plan.id]);
  const [acts] = await db.query(
    `SELECT pa.*, COALESCE(y.name, e.name) AS name, y.sanskrit_name, COALESCE(pa.duration_min, y.duration_min, e.duration_min) AS dur,
            COALESCE(pa.sets, e.sets) AS s, COALESCE(pa.reps, e.reps) AS r, COALESCE(y.precautions, e.precautions) AS precautions
       FROM plan_activities pa LEFT JOIN yoga_library y ON pa.activity_type='yoga' AND y.id = pa.activity_id
       LEFT JOIN exercise_library e ON pa.activity_type='exercise' AND e.id = pa.activity_id
      WHERE pa.plan_id = ? ORDER BY pa.activity_type DESC, pa.sort_order`, [plan.id]);
  header(doc, `Personal plan for ${u?.name || 'Member'}`, `${pretty(plan.start_date)} – ${pretty(plan.end_date)}`);

  doc.font('Helvetica-Bold').fontSize(18).fillColor(DARK).text(plan.title);
  const facts = [plan.health_condition && `For: ${plan.health_condition}`, u?.current_weight_kg && `Weight: ${u.current_weight_kg} kg`, u?.target_weight_kg && `Target: ${u.target_weight_kg} kg`].filter(Boolean).join('   ·   ');
  if (facts) doc.font('Helvetica').fontSize(10.5).fillColor(MUTED).text(facts);
  if (plan.instructions) {
    doc.moveDown(0.6);
    const y = doc.y; const h = doc.heightOfString(plan.instructions, { width: doc.page.width - 110 }) + 20;
    doc.rect(40, y, doc.page.width - 80, h).fill(MINT);
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10).text('Instructions', 52, y + 8);
    doc.font('Helvetica').fillColor('#1C2B23').text(plan.instructions, 52, doc.y + 2, { width: doc.page.width - 110 });
    doc.y = y + h + 6;
  }

  // Meals: roz wale + din ke hisaab wale
  const groups = [['Every day', meals.filter((m) => !m.day_of_week && !m.specific_date)]];
  for (let d = 1; d <= 7; d++) { const g = meals.filter((m) => m.day_of_week === d); if (g.length) groups.push([`Only on ${DAY[d]}`, g]); }
  const special = meals.filter((m) => m.specific_date);
  const dates = [...new Set(special.map((m) => String(m.specific_date).slice(0, 10)))].sort();
  for (const d of dates) groups.push([`Only on ${pretty(d)} (special day)`, special.filter((m) => String(m.specific_date).slice(0, 10) === d)]);
  for (const [title, list] of groups) {
    if (!list.length) continue;
    section(doc, `Diet · ${title}`);
    list.sort((a, b) => MEAL_ORDER.indexOf(a.meal_type) - MEAL_ORDER.indexOf(b.meal_type));
    for (const m of list) {
      if (doc.y > doc.page.height - 90) doc.addPage();
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(GREEN).text(MEAL[m.meal_type], 40, y, { width: 130 });
      if (m.meal_time) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(m.meal_time, 40, doc.y, { width: 130 });
      const leftEnd = doc.y;
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#1C2B23').text(m.items, 180, y, { width: doc.page.width - 300 });
      const extra = [m.portion_size && `Portion: ${m.portion_size}`, m.alternatives && `Instead: ${m.alternatives}`].filter(Boolean).join('   ');
      if (extra) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(extra, 180, doc.y, { width: doc.page.width - 300 });
      const rightEnd = doc.y;
      if (m.calories) doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(`${m.calories} kcal`, doc.page.width - 110, y, { width: 70, align: 'right' });
      doc.y = Math.max(leftEnd, rightEnd) + 8;
    }
    const kcal = list.reduce((s, m) => s + (m.calories || 0), 0);
    if (kcal) doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(`Total: about ${kcal} kcal`, 40, doc.y, { align: 'right', width: doc.page.width - 80 });
  }

  for (const [type, label] of [['yoga', 'Yoga'], ['exercise', 'Exercise']]) {
    const list = acts.filter((a) => a.activity_type === type && a.name);
    if (!list.length) continue;
    section(doc, label);
    for (const a of list) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      const amount = a.s ? `${a.s} sets × ${a.r}` : `${a.dur || '-'} min`;
      const when = [a.day_of_week ? DAY[a.day_of_week] : 'Every day', a.time_slot].filter(Boolean).join(', ');
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#1C2B23').text(`${a.name}${a.sanskrit_name ? ` (${a.sanskrit_name})` : ''}`, 40, doc.y, { continued: true })
        .font('Helvetica').fillColor(MUTED).text(`   ${amount} · ${when}`);
      if (a.notes) doc.fontSize(9).fillColor(GREEN).text(`Coach: ${a.notes}`);
      if (a.precautions) doc.fontSize(9).fillColor('#8A5A12').text(`Precaution: ${a.precautions}`);
      doc.moveDown(0.4);
    }
  }
  footer(doc);
  return plan;
}

// Browser/app mein PDF kholna
async function planPdf(res, userId, planId = null) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  const plan = await drawPlan(doc, userId, planId);
  if (!plan) return res.status(404).json({ message: 'No plan is running for this member' });
  doc.end(); await done;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${APP()}-plan-${toDateStr()}.pdf"`);
  res.end(Buffer.concat(chunks));
}

// PDF ko file/email ke liye Buffer mein
async function planPdfBuffer(userId, planId = null) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  const plan = await drawPlan(doc, userId, planId);
  if (!plan) { doc.end(); await done; return null; }
  doc.end(); await done;
  return { buffer: Buffer.concat(chunks), plan };
}

async function receiptPdf(res, payment) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${payment.receipt_no || 'receipt'}.pdf"`);
  doc.pipe(res);
  header(doc, 'Payment receipt', payment.receipt_no || '');
  const rows = [['Receipt no.', payment.receipt_no], ['Date', payment.paid_at ? pretty(payment.paid_at) : '-'], ['Name', payment.member_name],
    ['Email', payment.member_email], ['Package', payment.package_name], ['Valid', payment.valid_text || '-'],
    ['Payment ID', payment.provider_payment_id || '-'], ['Amount paid', `Rs. ${Number(payment.amount).toFixed(2)}`]];
  doc.moveDown(1);
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(k, 40, y, { width: 160 });
    doc.font('Helvetica-Bold').fillColor('#1C2B23').text(String(v ?? '-'), 200, y);
    doc.moveDown(0.6);
  }
  doc.moveDown(1).font('Helvetica').fontSize(10).fillColor(MUTED).text('Thank you for your payment. This is a computer generated receipt.');
  footer(doc);
  doc.end();
}

module.exports = { planPdf, planPdfBuffer, receiptPdf };
