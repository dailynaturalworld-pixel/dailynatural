// Plan ki PDF member tak: app ke Chat mein file + notification + (email set ho to) email attachment
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const { planPdfBuffer } = require('./pdf');
const { sendPlanEmail } = require('./mailer');
const { notify } = require('./notify');

const CHAT_DIR = require('../config/paths').uploadPath('chat');
const pretty = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };

async function sendPlanPdf(memberId, byUser, planId = null) {
  const out = await planPdfBuffer(memberId, planId);
  if (!out) return { error: 'This member has no running plan to send.' };
  const { buffer, plan } = out;
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_plan.pdf`;
  fs.writeFileSync(path.join(CHAT_DIR, fileName), buffer);

  const text = `📄 Your diet plan PDF: ${plan.title} (${pretty(plan.start_date)} – ${pretty(plan.end_date)}). Tap to open or download.`;
  await db.query(
    `INSERT INTO chat_messages (member_id, sender_id, sender_role, message, image_file, read_by_member, read_by_staff)
     VALUES (?, ?, ?, ?, ?, 0, 1)`, [memberId, byUser?.id || null, byUser?.role || 'admin', text, fileName]);
  await notify(memberId, { type: 'plan', title: 'Your plan PDF is ready', body: `${plan.title}. Open Chat to see or download it.`, link: 'Chat' });

  let emailed = false;
  try {
    const [[u]] = await db.query('SELECT name, email FROM users WHERE id = ?', [memberId]);
    const safe = String(plan.title).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'plan';
    emailed = (await sendPlanEmail(u.email, u.name, plan.title, buffer, `${safe}.pdf`)).sent;
  } catch (e) { console.warn('Plan email failed:', e.message); }
  return { ok: true, emailed, plan_id: plan.id };
}

module.exports = { sendPlanPdf };
