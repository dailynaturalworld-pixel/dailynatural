const db = require('../config/db');

// Expo push (phone par notification). Fail ho to bhi app chalta rahe.
async function sendPush(userIds, title, body, data = {}) {
  if (!userIds.length) return;
  try {
    const [rows] = await db.query('SELECT token FROM push_tokens WHERE user_id IN (?)', [userIds]);
    const messages = rows
      .filter((r) => /^Expo(nent)?PushToken\[/.test(r.token))
      .map((r) => ({ to: r.token, title, body, data, sound: 'default' }));
    for (let i = 0; i < messages.length; i += 100) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
    }
  } catch (err) {
    console.warn('Push send failed:', err.message);
  }
}

/**
 * Ek ya kai users ko notification (app ke andar + phone push)
 * type: chat | report | appointment | plan | broadcast | general
 * link: app ki screen ka naam (Chat, Reports, Appointments, Diet...)
 */
async function notify(userIds, { type = 'general', title, body = '', link = null }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(Number))];
  if (!ids.length) return 0;
  await db.query(
    'INSERT INTO notifications (user_id, type, title, body, link) VALUES ?',
    [ids.map((id) => [id, type, String(title).slice(0, 150), String(body || '').slice(0, 500), link])]
  );
  sendPush(ids, title, body, { link });
  return ids.length;
}

// Plan ke target ke hisaab se member ids
async function memberIdsForTarget(targetType, targetId) {
  if (targetType === 'member') return [Number(targetId)];
  if (targetType === 'group') {
    const [rows] = await db.query(
      `SELECT gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND u.status = 'active'`, [targetId]);
    return rows.map((r) => r.user_id);
  }
  const [rows] = await db.query("SELECT id FROM users WHERE role = 'member' AND status = 'active'");
  return rows.map((r) => r.id);
}

module.exports = { notify, memberIdsForTarget };
