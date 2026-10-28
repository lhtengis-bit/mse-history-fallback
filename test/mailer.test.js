// node test/mailer.test.js   (plain assert, no framework, no network)
const assert = require('assert')
const { createMailer } = require('../src/mailer')

const ENV = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'MSE fallback', SMTP_FROM_EMAIL: 'alerts@example.com' }

function stub(fail) {
  const s = { configs: [], sent: [] }
  s.createTransport = (cfg) => {
    s.configs.push(cfg)
    return { sendMail: async (m) => { s.sent.push(m); if (fail) throw fail } }
  }
  return s
}

;(async () => {
  // transport config and message are passed through
  const s = stub()
  const { sendMail } = createMailer({ env: ENV, createTransport: s.createTransport })
  await sendMail({ email: 'it@example.com', cc: 'cc@example.com', subject: 'subj', html: '<p>hi</p>' })
  assert.strictEqual(s.configs.length, 1)
  assert.deepStrictEqual(s.configs[0], {
    host: 'smtp.example.com',
    port: '587',
    secure: false,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: 'u', pass: 'p' },
  })
  assert.deepStrictEqual(s.sent, [{ from: 'MSE fallback <alerts@example.com>', to: 'it@example.com', cc: 'cc@example.com', subject: 'subj', html: '<p>hi</p>' }])

  // a failing send rejects with the original error
  const boom = new Error('smtp down')
  const bad = createMailer({ env: ENV, createTransport: stub(boom).createTransport })
  await assert.rejects(bad.sendMail({ email: 'a@b.c', subject: 's', html: 'h' }), (err) => err === boom)

  // nothing is written to the console, on success or failure
  const seen = []
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const k of Object.keys(saved)) console[k] = (...a) => seen.push(a)
  try {
    await sendMail({ email: 'a@b.c', subject: 's', html: 'h' })
    await bad.sendMail({ email: 'a@b.c', subject: 's', html: 'h' }).catch(() => {})
  } finally {
    Object.assign(console, saved)
  }
  assert.deepStrictEqual(seen, [])

  console.log('mailer tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
