// Pulls MSE's four non-trading endpoints and stores them (tables in sql/2026-10-30-mse-tables.sql). One endpoint failing does not stop the others.
// Write rules: companyinfo and security_index upsert on their key; top20_index_graph replaces each trade date it carries (MSE repeats some
// seconds, so there is no natural key); orderbook only appends states it has not stored yet. Re-running over the same payload changes nothing.

const { fetchMseLiveRows } = require('./mseHistoryFallback')
const { parseCompanies, parseIndexDaily, parseTop20, parseOrderbook } = require('./mseTablesParse')

const CHUNK = 500
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chunks = (rows) => {
  const out = []
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK))
  return out
}

const upsert = (table, updateOnDuplicate) => async (db, rows) => {
  for (const part of chunks(rows)) await db[table].bulkCreate(part, { updateOnDuplicate })
}

const writeCompanies = upsert('mse_company', ['name', 'isin', 'reg_date', 'issued_shares', 'security_type', 'updated_at'])
const writeIndexDaily = upsert('mse_index_daily', ['index_unit', 'previous_index_unit', 'high', 'low', 'updated_at'])

// each (index, date) carried by the payload is deleted and re-inserted in one transaction; a date the payload does not carry is never touched
async function writeTop20(db, rows) {
  const names = [...new Set(rows.map((r) => r.index_name))]
  const dates = [...new Set(rows.map((r) => r.trade_date))]
  await db.sequelize.transaction(async (transaction) => {
    await db.mse_top20_point.destroy({ where: { index_name: names, trade_date: dates }, transaction })
    for (const part of chunks(rows)) await db.mse_top20_point.bulkCreate(part, { transaction })
  })
}

// INSERT IGNORE against the unique (md_entry_id, date_time): a state already stored is skipped, a changed order is a new row
async function writeOrderbook(db, rows) {
  for (const part of chunks(rows)) await db.mse_orderbook_snapshot.bulkCreate(part, { ignoreDuplicates: true })
}

const ENDPOINTS = [
  { endpoint: 'companyinfo', parse: parseCompanies, write: writeCompanies },
  { endpoint: 'security_index', parse: parseIndexDaily, write: writeIndexDaily },
  { endpoint: 'top20_index_graph', parse: parseTop20, write: writeTop20 },
  { endpoint: 'orderbook', parse: parseOrderbook, write: writeOrderbook },
]

// Safe text for a failed database call: the error name and a MySQL code, never the message (it can hold the database user and host).
const writeFailureReason = (e) => `${e && e.name}${e && e.parent && typeof e.parent.code === 'string' ? ` ${e.parent.code}` : ''}`

async function runEndpoint({ endpoint, parse, write }, { db, client, now, dryRun, sleep }) {
  const fetched = await fetchMseLiveRows(client, { sleep, endpoint })
  if (!fetched.ok) return { endpoint, status: 'mse-unreachable', reason: fetched.reason }
  const { rows, skipped } = parse(fetched.rows, now)
  const result = { endpoint, status: dryRun ? 'dry-run' : 'ok', rows: rows.length, skipped }
  if (dryRun || rows.length === 0) return result
  try {
    await write(db, rows)
  } catch (e) {
    return { ...result, status: 'write-failed', reason: writeFailureReason(e) }
  }
  return result
}

async function runTables({ db, client, now = new Date(), log, dryRun = false, sleep = defaultSleep }) {
  const results = []
  for (const spec of ENDPOINTS) {
    const r = await runEndpoint(spec, { db, client, now, dryRun, sleep })
    results.push(r)
    log(`tables ${r.endpoint} status=${r.status}${r.rows === undefined ? '' : ` rows=${r.rows} skipped=${r.skipped}`}${r.reason ? ` reason=${r.reason}` : ''}`)
  }
  const failed = results.filter((r) => r.status === 'mse-unreachable' || r.status === 'write-failed')
  return { status: failed.length ? 'failed' : dryRun ? 'dry-run' : 'ok', results, failed }
}

module.exports = { ENDPOINTS, runTables }
