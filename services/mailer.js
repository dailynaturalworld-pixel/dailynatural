const nodemailer = require('nodemailer');

const APP_NAME = process.env.APP_NAME || 'HealthApp';
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const port = Number(process.env.SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const PURPOSE_TEXT = {
  register: 'verify your email and finish creating your account',
  login: 'log in to your account',
  reset: 'reset your password',
};

async function sendOtpEmail(email, code, purpose) {
  const subject = `${code} is your ${APP_NAME} code`;
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:24px;border:1px solid #D5E6DB;border-radius:16px">
    <h2 style="color:#1F7A4D;margin:0 0 8px">${APP_NAME}</h2>
    <p style="color:#1C2B23;font-size:15px">Use this code to ${PURPOSE_TEXT[purpose]}:</p>
    <div style="font-size:34px;letter-spacing:10px;font-weight:bold;color:#14532D;background:#E8F5EC;padding:16px;text-align:center;border-radius:12px">${code}</div>
    <p style="color:#5E7266;font-size:13px">This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
  </div>`;

  if (!transporter) {
    // Testing mode: email set nahi hai, isliye code terminal mein dikhayenge
    console.log(`\n[OTP] ${purpose.toUpperCase()} code for ${email}: ${code}  (email not configured, set SMTP_* in .env)\n`);
    return { sent: false };
  }
  await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: email, subject, html,
    text: `Your ${APP_NAME} code is ${code}. It expires in 10 minutes.` });
  return { sent: true };
}

// Plan PDF email ke saath (email set na ho to chupchaap chhod do)
async function sendPlanEmail(email, name, planTitle, pdfBuffer, fileName) {
  if (!transporter) return { sent: false };
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER, to: email,
    subject: `Your ${APP_NAME} diet plan: ${planTitle}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #D5E6DB;border-radius:16px">
      <h2 style="color:#1F7A4D;margin:0 0 8px">${APP_NAME}</h2>
      <p style="color:#1C2B23;font-size:15px">Hi ${name || ''},</p>
      <p style="color:#1C2B23;font-size:15px">Your diet, yoga and exercise plan <b>${planTitle}</b> is attached as a PDF. You can also see it any time in the app.</p>
      <p style="color:#5E7266;font-size:13px">This plan is diet and wellness guidance and does not replace advice from your doctor.</p></div>`,
    attachments: [{ filename: fileName, content: pdfBuffer, contentType: 'application/pdf' }],
  });
  return { sent: true };
}

module.exports = { sendOtpEmail, sendPlanEmail, emailConfigured: () => Boolean(transporter) };
