// One-shot MSE history fallback (see mseHistoryFallback.js), meant to run on a machine whose IP is allowlisted
// by MSE and that can reach the production database. The OS scheduler starts it (16:20 and 21:20 Mon-Fri); it does not schedule itself.
//   node src/run.js [--dry-run]
// Needs MSE_API_USER / MSE_API_PASS and the database settings in the environment (.env, see .env.example). MSE_FALLBACK_ALERT_EMAIL defaults to it@bdsec.mn.
// Exit code: 0 done, 1 MSE unreachable / write failed / run crashed, 2 MSE login or database settings missing.
// A crash of the run itself (database unreachable, wrong login) also sends one alert mail, unless --dry-run.

const FAILED = new Set(['mse-unreachable', 'write-failed'])

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function main({ db, env, log, run, sendMail, argv, now = new Date() }) {
  const dryRun = argv.includes('--dry-run')
  const alertEmail = env.MSE_FALLBACK_ALERT_EMAIL || 'it@bdsec.mn'
  try {
    if (!env.MSE_API_USER || !env.MSE_API_PASS) {
      log('MSE_API_USER / MSE_API_PASS are not set')
      return 2
    }
    const { createMseFeedClient } = require('./mseFeedClient')
    const client = createMseFeedClient({ env })
    const summary = await run({ db, client, now, log, sendMail, dryRun, alertEmail })
    return FAILED.has(summary.status) ? 1 : 0
  } catch (err) {
    // name and code only: a database error message can carry the database user and host
    const code = err && typeof err.code === 'string' ? err.code : err && err.parent && typeof err.parent.code === 'string' ? err.parent.code : null
    log(`run failed: ${err && err.name}${code === null ? '' : ` code=${code}`}`)
    if (!dryRun) {
      try {
        const what = escapeHtml(`${err && err.name}${code === null ? '' : ` ${code}`}`)
        await sendMail({
          email: alertEmail,
          subject: 'MSE fallback: run crashed',
          html: `<p>The MSE history fallback run on ${now.toISOString()} crashed before finishing; the history table may be incomplete.</p><p>${what}</p>`,
        })
      } catch (_) {
        log('mail not sent')
      }
    }
    return 1
  } finally {
    try {
      await db.sequelize.close()
    } catch (_) {
      // a close error must not change the exit code
    }
  }
}

module.exports = { main }

if (require.main === module) {
  require('dotenv').config()
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`)
  let db, sendMail
  try {
    const { createDb } = require('./db')
    const { createMailer } = require('./mailer')
    db = createDb(process.env)
    sendMail = createMailer({ env: process.env }).sendMail
  } catch (err) {
    // only the variable name, never a value or an error message
    log(err && err.variable ? `environment variable ${err.variable} is not set` : `start-up failed: ${err && err.name}`)
    process.exit(2)
  }
  const { runHistoryFallback } = require('./mseHistoryFallback')
  main({ db, env: process.env, log, run: runHistoryFallback, sendMail, argv: process.argv.slice(2) }).then((code) => process.exit(code))
}
