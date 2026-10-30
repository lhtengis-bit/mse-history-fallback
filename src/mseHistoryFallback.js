// Fetches MSE's live security_trading rows, then reconciles them into _securitytradingstatus_history. MSE allows one request per endpoint per 120 seconds and answers 429 with Retry-After.
// The reason of a failure is the client's own message, 'HTTP <status>' or 'not a JSON array': never the response body.

const moment = require('moment-timezone')
const { Op } = require('sequelize')
const { qualifies } = require('./mseHistoryMapping')
const { keyOf, planReconcile } = require('./mseHistoryReconcile')
const { buildFallbackEmail } = require('./mseHistoryFallbackEmail')
const historyWriteLock = require('./historyWriteLock')

const DEFAULT_ALERT_EMAIL = 'it@bdsec.mn'
const DEFAULT_RETRY_AFTER_SECONDS = 120
const SAFETY_MARGIN_SECONDS = 5

// One call, one outcome: { res } on a response, { reason } when the client threw.
async function attempt(client, endpoint, query) {
  try {
    return { res: await client.call(endpoint, query) }
  } catch (e) {
    return { reason: e.message }
  }
}

// By default today's live rows; a past date is read from security_trading_history?date=.
async function fetchMseLiveRows(client, { sleep, endpoint = 'security_trading', query }) {
  let { res, reason } = await attempt(client, endpoint, query)
  if (res && res.status === 429) {
    await sleep(((res.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) + SAFETY_MARGIN_SECONDS) * 1000);
    ({ res, reason } = await attempt(client, endpoint, query))
  }
  if (!res) return { ok: false, reason }
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` }
  let rows
  try { rows = JSON.parse(res.bodyText) } catch (e) { return { ok: false, reason: 'not a JSON array' } }
  if (!Array.isArray(rows)) return { ok: false, reason: 'not a JSON array' }
  return { ok: true, rows }
}


const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Today's stored rows, and the latest earlier row of every wanted stock that has none today (first seen per key wins).
// Earlier rows cannot change during a run, so a caller that already has previousRows passes them and the query is skipped.
async function loadState(table, mseRows, runDate, knownPreviousRows) {
  const todayRows = await table.findAll({ where: { dates: runDate }, raw: true })
  const stored = new Set(todayRows.map((r) => keyOf(r.Symbol, r.MDSubOrderBookType)))
  const missing = new Set()
  for (const row of mseRows) {
    const key = keyOf(row.symbol, row.md_sub_order_book_type)
    if (qualifies(row, runDate) && !stored.has(key)) missing.add(key)
  }
  const previousRows = knownPreviousRows || new Map()
  if (!knownPreviousRows && missing.size > 0) {
    const symbols = [...new Set(mseRows.filter((r) => missing.has(keyOf(r.symbol, r.md_sub_order_book_type))).map((r) => r.symbol))]
    const earlier = await table.findAll({ where: { Symbol: symbols, dates: { [Op.lt]: runDate } }, order: [['dates', 'DESC'], ['id', 'DESC']], raw: true })
    for (const row of earlier) {
      const key = keyOf(row.Symbol, row.MDSubOrderBookType)
      if (missing.has(key) && !previousRows.has(key)) previousRows.set(key, row)
    }
  }
  return { todayRows, previousRows }
}

const plan = async (table, mseRows, runDate, knownPreviousRows) => {
  const { todayRows, previousRows } = await loadState(table, mseRows, runDate, knownPreviousRows)
  return { ...planReconcile({ mseRows, todayRows, previousRows, runDate }), todayRows, previousRows }
}

// Safe text for a failed database call: the error name and a MySQL code, never the message (it can hold the database user and host).
const writeFailureReason = (e) => `${e && e.name}${e && e.parent && typeof e.parent.code === 'string' ? ` ${e.parent.code}` : ''}`

const summarise = (runDate, status, p, reason) => {
  const summary = {
    runDate,
    status,
    inserts: p.inserts.length,
    updates: p.updates.length,
    anomalies: p.anomalies,
    duplicateKeys: p.duplicateKeys,
    newListings: p.newListings,
    skippedNoTimestamp: p.skippedNoTimestamp,
  }
  if (reason !== undefined) summary.reason = reason
  return summary
}

const EMPTY_PLAN = { inserts: [], updates: [], anomalies: [], duplicateKeys: [], newListings: [], skippedNoTimestamp: [], qualifyingCount: 0 }

// What a dry run would write, one line per row: symbols, ids and numbers only.
const dryRunLines = (runDate, p) => {
  const storedById = new Map(p.todayRows.map((r) => [r.id, r]))
  const prefix = `mse-history-fallback ${runDate} dry-run`
  return [
    ...p.inserts.map((r) => `${prefix} insert ${keyOf(r.Symbol, r.MDSubOrderBookType)} volume=${r.Volume}`),
    ...p.updates.map((u) => {
      const stored = storedById.get(u.id)
      return `${prefix} update ${keyOf(stored.Symbol, stored.MDSubOrderBookType)} id=${u.id} stored=${stored.Volume} mse=${u.fields.Volume}`
    }),
  ]
}

const hasFlags = (p) => p.anomalies.length + p.duplicateKeys.length + p.skippedNoTimestamp.length > 0

// Without a dry run: what the plan means. repaired > flagged > healthy; non-trading-day when nothing qualified and nothing was skipped.
const statusOf = (p) => {
  if (p.inserts.length + p.updates.length > 0) return 'repaired'
  if (hasFlags(p)) return 'flagged'
  return p.qualifyingCount === 0 ? 'non-trading-day' : 'healthy'
}

async function runHistoryFallback({ db, client, now, log = console.log, sendMail, sleep = defaultSleep, lock = historyWriteLock, dryRun = false, alertEmail = DEFAULT_ALERT_EMAIL, date }) {
  // date (YYYY-MM-DD): repair that finished day from MSE's history call instead of today from the live call
  const runDate = date || moment(now).tz('Asia/Ulaanbaatar').format('YYYY-MM-DD')
  const table = db._securitytradingstatus_history

  const finish = async (summary, detailLines = []) => {
    log(`mse-history-fallback ${runDate} status=${summary.status} inserts=${summary.inserts} updates=${summary.updates} anomalies=${summary.anomalies.length} duplicateKeys=${summary.duplicateKeys.length} newListings=${summary.newListings.length} skipped=${summary.skippedNoTimestamp.length}${summary.reason === undefined ? '' : ` reason=${summary.reason}`}`)
    detailLines.forEach((line) => log(line))
    const mail = dryRun ? null : buildFallbackEmail(summary)
    if (mail) {
      try {
        await sendMail({ email: alertEmail, subject: mail.subject, html: mail.html })
      } catch (e) {
        log('mse-history-fallback mail not sent')
      }
    }
    return summary
  }

  // Never hold the lock here: this call may wait out MSE's rate limit.
  const fetched = await fetchMseLiveRows(client, date ? { sleep, endpoint: 'security_trading_history', query: { date } } : { sleep })
  if (!fetched.ok) return finish(summarise(runDate, 'mse-unreachable', EMPTY_PLAN, fetched.reason))
  const mseRows = fetched.rows.filter((r) => r && typeof r === 'object')

  const first = await plan(table, mseRows, runDate)
  const status = statusOf(first)
  if (status === 'healthy' || status === 'non-trading-day') return finish(summarise(runDate, status, first))
  if (dryRun) return finish(summarise(runDate, 'dry-run', first), dryRunLines(runDate, first))

  // Under the lock the table can have changed since the first read, so read and plan again before writing.
  // Earlier rows are reused from the first pass; a stock whose today row vanished meanwhile has no previous row here and is planned as a new listing.
  const release = await lock.acquire()
  let final, writeError
  try {
    final = await plan(table, mseRows, runDate, first.previousRows)
    if (final.inserts.length > 0) await table.bulkCreate(final.inserts)
    for (const u of final.updates) await table.update(u.fields, { where: { id: u.id } })
  } catch (e) {
    writeError = e
  } finally {
    release()
  }
  // The counts are what was attempted: inserts written before a later failure are not hidden.
  if (writeError) return finish(summarise(runDate, 'write-failed', final || EMPTY_PLAN, writeFailureReason(writeError)))
  return finish(summarise(runDate, statusOf(final), final))
}

module.exports = { fetchMseLiveRows, runHistoryFallback }
