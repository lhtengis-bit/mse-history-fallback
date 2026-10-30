// node test/mseTables.test.js   (plain assert, no framework, no connection)
// Fake tables behave like the real unique keys: upsert on the key, INSERT IGNORE, delete-by-where.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { runTables } = require('../src/mseTables')

const fixture = (f, n) => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'))
  return JSON.stringify(n ? rows.slice(0, n) : rows)
}
const BODIES = {
  companyinfo: fixture('mse_companyinfo_sample.json'),
  security_index: fixture('mse_security_index_sample.json'),
  top20_index_graph: fixture('mse_top20_index_graph_sample.json'),
  orderbook: fixture('mse_orderbook_sample.json'),
}
const NOW = new Date('2026-10-30T07:10:00Z')

function fakeDb({ failOn } = {}) {
  const store = (name, keyOf) => ({
    rows: new Map(),
    list: [],
    calls: [],
    async bulkCreate(rows, opts = {}) {
      this.calls.push(opts)
      if (failOn === name) throw Object.assign(new Error('secret host and user'), { name: 'SequelizeConnectionError', parent: { code: 'ECONNRESET' } })
      for (const r of rows) {
        if (!keyOf) { this.list.push(r); continue }
        const k = keyOf(r)
        if (this.rows.has(k)) { if (opts.updateOnDuplicate) this.rows.set(k, { ...this.rows.get(k), ...r }) } else this.rows.set(k, r)
      }
    },
    async destroy({ where }) {
      this.list = this.list.filter((r) => !(where.index_name.includes(r.index_name) && where.trade_date.includes(r.trade_date)))
    },
  })
  const db = {
    mse_company: store('mse_company', (r) => r.symbol),
    mse_index_daily: store('mse_index_daily', (r) => `${r.index_name}|${r.trade_date}`),
    mse_top20_point: store('mse_top20_point', null),
    mse_orderbook_snapshot: store('mse_orderbook_snapshot', (r) => `${r.md_entry_id}|${r.date_time}`),
    transactions: 0,
    sequelize: { transaction: async (fn) => { db.transactions++; return fn({ id: 'tx' }) } },
  }
  return db
}

const fakeClient = (overrides = {}) => {
  const calls = []
  return {
    calls,
    async call(endpoint, query) {
      calls.push([endpoint, query])
      const o = overrides[endpoint]
      if (typeof o === 'function') return o(calls.filter((c) => c[0] === endpoint).length)
      return o || { status: 200, bodyText: BODIES[endpoint], retryAfterSeconds: null }
    },
  }
}

const snapshot = (db) => JSON.stringify([db.mse_company.rows, db.mse_index_daily.rows, db.mse_top20_point.list, db.mse_orderbook_snapshot.rows].map((x) => (x instanceof Map ? [...x] : x)))

;(async () => {
  // a full run stores everything once, one call per endpoint, each endpoint named in the log
  let db = fakeDb()
  let client = fakeClient()
  let logs = []
  let out = await runTables({ db, client, now: NOW, log: (l) => logs.push(l), sleep: async () => {} })
  assert.strictEqual(out.status, 'ok')
  assert.deepStrictEqual(client.calls.map((c) => c[0]), ['companyinfo', 'security_index', 'top20_index_graph', 'orderbook'])
  assert.strictEqual(db.mse_company.rows.size, 270)
  assert.strictEqual(db.mse_index_daily.rows.size, 3)
  assert.strictEqual(db.mse_top20_point.list.length, 313)
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 400)
  assert.strictEqual(db.transactions, 1)
  assert.deepStrictEqual(logs, [
    'tables companyinfo status=ok rows=270 skipped=0',
    'tables security_index status=ok rows=3 skipped=0',
    'tables top20_index_graph status=ok rows=313 skipped=0',
    'tables orderbook status=ok rows=400 skipped=0',
  ])
  assert.ok(db.mse_company.calls.every((o) => Array.isArray(o.updateOnDuplicate) && o.updateOnDuplicate.includes('name')))
  assert.ok(db.mse_orderbook_snapshot.calls.every((o) => o.ignoreDuplicates === true))
  assert.ok(db.mse_orderbook_snapshot.calls.length >= 1 && db.mse_company.calls.length === 1, '270 rows is one chunk; orderbook 400 is one chunk')

  // running it again over the same payload changes nothing, including the duplicated 14:05:00 Top 20 pair
  const before = snapshot(db)
  await runTables({ db, client: fakeClient(), now: new Date('2026-10-30T14:10:00Z'), log: () => {}, sleep: async () => {} })
  assert.strictEqual(db.mse_top20_point.list.length, 313)
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 400)
  assert.strictEqual(db.mse_company.rows.size, 270)
  assert.strictEqual(snapshot(db).replace(/"updated_at":"[^"]*"/g, '').length > 0, true)
  const stripTimes = (s) => s.replace(/"(updated_at|fetched_at)":"[^"]*"/g, '')
  assert.strictEqual(stripTimes(snapshot(db)), stripTimes(before))

  // a changed company is updated, a changed order is a NEW orderbook row, a Top 20 day is replaced (fewer points stay fewer)
  const changed = JSON.parse(BODIES.companyinfo)
  changed[0].issued_shares = 123
  const book = JSON.parse(BODIES.orderbook)
  book[0].md_entry_size = 99
  book[0].date_time = '2026-10-30 14:06:00'
  const top = JSON.parse(BODIES.top20_index_graph).slice(0, 10)
  client = fakeClient({
    companyinfo: { status: 200, bodyText: JSON.stringify(changed), retryAfterSeconds: null },
    orderbook: { status: 200, bodyText: JSON.stringify(book), retryAfterSeconds: null },
    top20_index_graph: { status: 200, bodyText: JSON.stringify(top), retryAfterSeconds: null },
  })
  await runTables({ db, client, now: NOW, log: () => {}, sleep: async () => {} })
  assert.strictEqual(db.mse_company.rows.size, 270)
  assert.strictEqual(db.mse_company.rows.get(changed[0].symbol).issued_shares, 123)
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 401)
  assert.strictEqual(db.mse_top20_point.list.length, 10)

  // an empty Top 20 answer deletes nothing and writes nothing
  db = fakeDb()
  await runTables({ db, client: fakeClient(), now: NOW, log: () => {}, sleep: async () => {} })
  logs = []
  out = await runTables({ db, client: fakeClient({ top20_index_graph: { status: 200, bodyText: '[]', retryAfterSeconds: null } }), now: NOW, log: (l) => logs.push(l), sleep: async () => {} })
  assert.strictEqual(out.status, 'ok')
  assert.strictEqual(db.mse_top20_point.list.length, 313)
  assert.ok(logs.includes('tables top20_index_graph status=ok rows=0 skipped=0'))

  // one endpoint down does not stop the others; its reason is the status text, never a body
  db = fakeDb()
  logs = []
  out = await runTables({ db, client: fakeClient({ security_index: { status: 500, bodyText: 'secret body', retryAfterSeconds: null } }), now: NOW, log: (l) => logs.push(l), sleep: async () => {} })
  assert.strictEqual(out.status, 'failed')
  assert.deepStrictEqual(out.failed.map((r) => [r.endpoint, r.status, r.reason]), [['security_index', 'mse-unreachable', 'HTTP 500']])
  assert.strictEqual(db.mse_company.rows.size, 270)
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 400)
  assert.ok(logs.every((l) => !/secret/.test(l)))

  // a database failure on one table is write-failed with the name and MySQL code only, the others still run
  db = fakeDb({ failOn: 'mse_company' })
  logs = []
  out = await runTables({ db, client: fakeClient(), now: NOW, log: (l) => logs.push(l), sleep: async () => {} })
  assert.strictEqual(out.status, 'failed')
  assert.deepStrictEqual(out.failed.map((r) => [r.endpoint, r.status, r.reason]), [['companyinfo', 'write-failed', 'SequelizeConnectionError ECONNRESET']])
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 400)
  assert.ok(logs.every((l) => !/secret/.test(l)))

  // 429: waits Retry-After + 5 s once, then succeeds
  db = fakeDb()
  const sleeps = []
  out = await runTables({
    db,
    client: fakeClient({ orderbook: (n) => (n === 1 ? { status: 429, bodyText: '', retryAfterSeconds: 30 } : { status: 200, bodyText: BODIES.orderbook, retryAfterSeconds: null }) }),
    now: NOW,
    log: () => {},
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.strictEqual(out.status, 'ok')
  assert.deepStrictEqual(sleeps, [35000])
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 400)

  // not a JSON array is a failure of that endpoint only
  out = await runTables({ db: fakeDb(), client: fakeClient({ companyinfo: { status: 200, bodyText: '{"x":1}', retryAfterSeconds: null } }), now: NOW, log: () => {}, sleep: async () => {} })
  assert.deepStrictEqual(out.failed.map((r) => [r.endpoint, r.reason]), [['companyinfo', 'not a JSON array']])

  // dry run: parsed and counted, nothing written
  db = fakeDb()
  logs = []
  out = await runTables({ db, client: fakeClient(), now: NOW, log: (l) => logs.push(l), dryRun: true, sleep: async () => {} })
  assert.strictEqual(out.status, 'dry-run')
  assert.strictEqual(db.mse_company.rows.size + db.mse_index_daily.rows.size + db.mse_top20_point.list.length + db.mse_orderbook_snapshot.rows.size, 0)
  assert.strictEqual(db.transactions, 0)
  assert.ok(logs.includes('tables companyinfo status=dry-run rows=270 skipped=0'))

  // writes go in chunks of 500
  const many = JSON.parse(BODIES.orderbook)
  const big = []
  for (let i = 0; i < 1201; i++) big.push({ ...many[i % many.length], md_entry_id: `id-${i}` })
  db = fakeDb()
  await runTables({ db, client: fakeClient({ orderbook: { status: 200, bodyText: JSON.stringify(big), retryAfterSeconds: null } }), now: NOW, log: () => {}, sleep: async () => {} })
  assert.strictEqual(db.mse_orderbook_snapshot.calls.length, 3)
  assert.strictEqual(db.mse_orderbook_snapshot.rows.size, 1201)

  console.log('mseTables tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
