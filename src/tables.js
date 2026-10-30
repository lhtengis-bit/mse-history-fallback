// One-shot run of the MSE tables add-on (see mseTables.js), on the same allowlisted machine as run.js. The OS scheduler starts it; it does not schedule itself.
//   node src/tables.js [--dry-run]
// Same .env as run.js (MSE login, database, optional SSH tunnel). --dry-run fetches and parses everything but writes nothing and sends no mail.
// Exit code: 0 done, 1 an endpoint failed or the run crashed, 2 MSE login or database settings missing.
// A failed endpoint or a crash sends one alert mail (MSE_FALLBACK_ALERT_EMAIL, default it@bdsec.mn).

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function main({ db, env, log, run, sendMail, argv, now = new Date(), openTunnel }) {
  const dryRun = argv.includes('--dry-run')
  const alertEmail = env.MSE_FALLBACK_ALERT_EMAIL || 'it@bdsec.mn'
  const alert = async (subject, detail) => {
    if (dryRun) return
    try {
      await sendMail({ email: alertEmail, subject, html: `<p>The MSE tables run on ${now.toISOString()}:</p><p>${escapeHtml(detail)}</p>` })
    } catch (_) {
      log('mail not sent')
    }
  }
  let tunnel
  try {
    if (!env.MSE_API_USER || !env.MSE_API_PASS) {
      log('MSE_API_USER / MSE_API_PASS are not set')
      return 2
    }
    if (openTunnel) tunnel = await openTunnel()
    const { createMseFeedClient } = require('./mseFeedClient')
    const client = createMseFeedClient({ env })
    const summary = await run({ db, client, now, log, dryRun })
    if (summary.failed.length) await alert('MSE tables: endpoint failed', summary.failed.map((r) => `${r.endpoint}: ${r.status} ${r.reason || ''}`.trim()).join('; '))
    return summary.failed.length ? 1 : 0
  } catch (err) {
    // name and code only: a database error message can carry the database user and host
    const code = err && typeof err.code === 'string' ? err.code : err && err.parent && typeof err.parent.code === 'string' ? err.parent.code : null
    const what = `${err && err.name}${code === null ? '' : ` code=${code}`}`
    log(`tables run failed: ${what}`)
    await alert('MSE tables: run crashed', what)
    return 1
  } finally {
    try {
      await db.sequelize.close()
    } catch (_) {
      // a close error must not change the exit code
    }
    try {
      if (tunnel) tunnel.close()
    } catch (_) {
      // nor must a tunnel close error
    }
  }
}

module.exports = { main }

if (require.main === module) {
  require('dotenv').config()
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`)
  let db, sendMail, openTunnel
  try {
    const { createDb } = require('./db')
    const { createMailer } = require('./mailer')
    db = createDb(process.env)
    sendMail = createMailer({ env: process.env }).sendMail
    if (process.env.SSH_HOST) {
      const tunnel = require('./tunnel')
      tunnel.tunnelConfig(process.env)
      openTunnel = () => tunnel.openTunnel(process.env)
    }
  } catch (err) {
    // only the variable name, never a value or an error message
    log(err && err.variable ? `environment variable ${err.variable} is not set` : `start-up failed: ${err && err.name}`)
    process.exit(2)
  }
  const { runTables } = require('./mseTables')
  main({ db, env: process.env, log, run: runTables, sendMail, argv: process.argv.slice(2), openTunnel }).then((code) => process.exit(code))
}
