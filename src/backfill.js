// Backfill of finished days, by hand: repairs _securitytradingstatus_history for past dates from MSE's history call
// (security_trading_history?date=), with the same rules as the scheduled run (see mseHistoryFallback.js).
//   node src/backfill.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]
// Weekdays from --from to --to (default: --from alone), oldest first, one MSE call per day: MSE allows one per 120 s, so a day takes about two minutes.
// Today and the future are refused (the scheduled run does today). No alert mail; the log shows one summary line per day.
// With SSH_HOST set it opens the same SSH tunnel as run.js. Exit code: 0 done, 1 a day failed or the run crashed, 2 bad arguments or settings missing.

const moment = require('moment-timezone')

const FAILED = new Set(['mse-unreachable', 'write-failed'])
const DATE = /^\d{4}-\d{2}-\d{2}$/
const USAGE = 'usage: node src/backfill.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]'

const valueOf = (argv, flag) => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

// The weekdays to repair, or an Error whose message is safe to print.
function parseArgs(argv, today) {
  const from = valueOf(argv, '--from')
  const to = valueOf(argv, '--to') || from
  if (!DATE.test(from || '') || !DATE.test(to)) throw new Error(USAGE)
  const start = moment.utc(from, 'YYYY-MM-DD', true)
  const end = moment.utc(to, 'YYYY-MM-DD', true)
  if (!start.isValid() || !end.isValid()) throw new Error(`not a calendar date. ${USAGE}`)
  if (end.isBefore(start)) throw new Error(`--to is before --from. ${USAGE}`)
  if (!end.isBefore(moment.utc(today, 'YYYY-MM-DD'))) throw new Error('only finished days can be backfilled; today is the scheduled run\'s job')
  const dates = []
  for (const d = start.clone(); !d.isAfter(end); d.add(1, 'day')) {
    if (d.isoWeekday() <= 5) dates.push(d.format('YYYY-MM-DD'))
  }
  return { dates, dryRun: argv.includes('--dry-run') }
}

async function main({ db, env, log, run, argv, now = new Date(), openTunnel }) {
  let tunnel
  try {
    let parsed
    try {
      parsed = parseArgs(argv, moment(now).tz('Asia/Ulaanbaatar').format('YYYY-MM-DD'))
    } catch (err) {
      log(err.message)
      return 2
    }
    if (!env.MSE_API_USER || !env.MSE_API_PASS) {
      log('MSE_API_USER / MSE_API_PASS are not set')
      return 2
    }
    if (parsed.dates.length === 0) {
      log('no weekdays in that range')
      return 0
    }
    if (openTunnel) tunnel = await openTunnel()
    const { createMseFeedClient } = require('./mseFeedClient')
    const client = createMseFeedClient({ env })
    let failed = 0
    for (const date of parsed.dates) {
      const summary = await run({ db, client, now, log, sendMail: async () => {}, dryRun: parsed.dryRun, date })
      if (FAILED.has(summary.status)) failed += 1
    }
    return failed ? 1 : 0
  } catch (err) {
    // name and code only: a database or SSH error message can carry the host and user
    const code = err && typeof err.code === 'string' ? err.code : err && err.parent && typeof err.parent.code === 'string' ? err.parent.code : null
    log(`backfill failed: ${err && err.name}${code === null ? '' : ` code=${code}`}`)
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

module.exports = { parseArgs, main }

if (require.main === module) {
  require('dotenv').config()
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`)
  let db, openTunnel
  try {
    const { createDb } = require('./db')
    db = createDb(process.env)
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
  const { runHistoryFallback } = require('./mseHistoryFallback')
  main({ db, env: process.env, log, run: runHistoryFallback, argv: process.argv.slice(2), openTunnel }).then((code) => process.exit(code))
}
