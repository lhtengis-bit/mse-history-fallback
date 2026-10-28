// SMTP mail for the alert. Silent on purpose: nothing is logged (SMTP responses and errors carry host, port and
// addresses); a failed send throws and the caller decides what to say.
const nodemailer = require('nodemailer')

function createMailer({ env, createTransport = nodemailer.createTransport } = {}) {
  async function sendMail({ email, cc, subject, html }) {
    const transporter = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
    await transporter.sendMail({
      from: `${env.SMTP_FROM} <${env.SMTP_FROM_EMAIL}>`,
      to: email,
      cc,
      subject,
      html,
    })
  }
  return { sendMail }
}

module.exports = { createMailer }
