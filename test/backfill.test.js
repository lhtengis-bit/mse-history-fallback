// node test/backfill.test.js   (plain assert, no framework)
const assert = require('assert')
const { parseArgs, main } = require('../src/backfill')
const { runHistoryFallback } = require('../src/mseHistoryFallback')

const TODAY = '2026-10-30'
const NOW = new Date('2026-10-30T08:00:00Z')
const CREDS = { MSE_API_USER: 'u-secret', MSE_API_PASS: 'p-secret' }

;(async () => {
  // arguments: weekdays only, oldest first, --to defaults to --from, --dry-run
  assert.deepStrictEqual(parseArgs(['--from', '2026-10-21', '--to', '2026-10-22'], TODAY), { dates: ['2026-10-21', '2026-10-22'], dryRun: false })
  assert.deepStrictEqual(parseArgs(['--from', '2026-10-22', '--dry-run'], TODAY), { dates: ['2026-10-22'], dryRun: true })
  assert.deepStrictEqual(parseArgs(['--from', '2026-10-23', '--to', '2026-10-27'], TODAY).dates, ['2026-10-23', '2026-10-26', '2026-10-27'])
  assert.deepStrictEqual(parseArgs(['--from', '2026-10-24', '--to', '2026-10-25'], TODAY).dates, [])
  assert.deepStrictEqual(parseArgs(['--from', '2026-10-29'], TODAY).dates, ['2026-10-29'])
  // refused: no --from, bad format, not a calendar day, reversed, today or later
  for (const argv of [[], ['--from'], ['--from', '21-10-2026'], ['--from', '2026-02-30'], ['--from', '2026-10-22', '--to', '2026-10-21'], ['--from', TODAY], ['--from', '2026-10-29', '--to', '2026-11-02']]) {
    assert.throws(() => parseArgs(argv, TODAY), (e) => e instanceof Error && e.message.length > 0, JSON.stringify(argv))
  }

  // main: one run per weekday, no mail, dry-run passed on, the date handed to run, tunnel opened first and closed last, exit code per status
  const harness = ({ argv, env = CREDS, statuses = {}, throwOn } = {}) => {
    const h = { logs: [], runs: [], order: [] }
    h.db = { sequelize: { close: async () => { h.order.push('db-close') } } }
    h.run = async (a) => {
      h.runs.push(a)
      if (throwOn === a.date) throw Object.assign(new Error('ssh down user-secret'), { name: 'SshTunnelError', code: 'ETIMEDOUT' })
      return { status: statuses[a.date] || 'repaired' }
    }
    h.openTunnel = async () => { h.order.push('open'); return { close: () => h.order.push('tunnel-close') } }
    h.exec = () => main({ db: h.db, env, log: (l) => h.logs.push(l), run: h.run, argv, now: NOW, openTunnel: h.openTunnel })
    return h
  }
  let h = harness({ argv: ['--from', '2026-10-21', '--to', '2026-10-22', '--dry-run'] })
  assert.strictEqual(await h.exec(), 0)
  assert.deepStrictEqual(h.runs.map((r) => r.date), ['2026-10-21', '2026-10-22'])
  assert.ok(h.runs.every((r) => r.dryRun === true && r.now === NOW && typeof r.sendMail === 'function'))
  assert.strictEqual(await h.runs[0].sendMail({ email: 'x' }), undefined)
  assert.deepStrictEqual(h.order, ['open', 'db-close', 'tunnel-close'])
  h = harness({ argv: ['--from', '2026-10-21'] })
  await h.exec()
  assert.strictEqual(h.runs[0].dryRun, false)

  // one failed day does not stop the others, and the exit code is 1
  h = harness({ argv: ['--from', '2026-10-21', '--to', '2026-10-23'], statuses: { '2026-10-21': 'mse-unreachable' } })
  assert.strictEqual(await h.exec(), 1)
  assert.strictEqual(h.runs.length, 3)
  h = harness({ argv: ['--from', '2026-10-21'], statuses: { '2026-10-21': 'write-failed' } })
  assert.strictEqual(await h.exec(), 1)

  // bad arguments / no MSE login: exit 2, nothing opened or run, db still closed
  h = harness({ argv: [] })
  assert.strictEqual(await h.exec(), 2)
  h = harness({ argv: ['--from', '2026-10-21'], env: {} })
  assert.strictEqual(await h.exec(), 2)
  assert.deepStrictEqual(h.order, ['db-close'])
  assert.strictEqual(h.runs.length, 0)
  // a range with no weekdays is not an error and opens nothing
  h = harness({ argv: ['--from', '2026-10-24', '--to', '2026-10-25'] })
  assert.strictEqual(await h.exec(), 0)
  assert.deepStrictEqual(h.order, ['db-close'])

  // a crash: name and code only, exit 1, still closed
  h = harness({ argv: ['--from', '2026-10-21'], throwOn: '2026-10-21' })
  assert.strictEqual(await h.exec(), 1)
  assert.deepStrictEqual(h.logs, ['backfill failed: SshTunnelError code=ETIMEDOUT'])
  assert.deepStrictEqual(h.order, ['open', 'db-close', 'tunnel-close'])

  // the date reaches MSE's history call, and rows are matched against that day, not today
  const stored = []
  const inserted = []
  const table = {
    async findAll({ where }) { return typeof where.dates === 'string' ? stored.filter((r) => r.dates === where.dates) : [] },
    async bulkCreate(rows) { inserted.push(...rows) },
    async update() {},
  }
  const calls = []
  const client = {
    async call(endpoint, query) {
      calls.push([endpoint, query])
      const row = { symbol: 'AAA-O-0000', md_sub_order_book_type: 'Regular', opening_price: 10, closing_price: 11, high_price: 12, low_price: 9, vwap: 10.5, traded_volume: 500, previous_closing_price: 10, md_entry_time: '2026-10-22 12:59:57', traded_value: 5250, security_type: 'CS', dates: '2026-10-22' }
      return { status: 200, bodyText: JSON.stringify([row]), retryAfterSeconds: null }
    },
  }
  const logs = []
  const summary = await runHistoryFallback({ db: { _securitytradingstatus_history: table }, client, now: NOW, log: (l) => logs.push(l), sendMail: async () => {}, sleep: async () => {}, date: '2026-10-22' })
  assert.deepStrictEqual(calls, [['security_trading_history', { date: '2026-10-22' }]])
  assert.strictEqual(summary.runDate, '2026-10-22')
  assert.strictEqual(summary.status, 'repaired')
  assert.strictEqual(inserted.length, 1)
  assert.strictEqual(inserted[0].dates, '2026-10-22')
  assert.strictEqual(inserted[0].MDEntryTime, '2026-10-22 12:59:57')
  assert.ok(logs[0].includes('2026-10-22'))

  console.log('backfill tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
