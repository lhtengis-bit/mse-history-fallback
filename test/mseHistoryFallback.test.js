// node test/mseHistoryFallback.test.js   (plain assert, no framework)
const assert = require('assert')
const { Op } = require('sequelize')
const { runHistoryFallback } = require('../src/mseHistoryFallback')
const { keyOf } = require('../src/mseHistoryReconcile')

const RUN = '2026-10-23'
const NOW = new Date('2026-10-23T05:00:00Z') // 13:00 in Ulaanbaatar
const ALERT = 'alert@example.test'

const mseRow = (symbol, type, volume, extra = {}) => ({
  id: 1, symbol, md_sub_order_book_type: type, opening_price: 10, closing_price: type === 'Regular' ? 11 : null, high_price: 12, low_price: 9,
  vwap: 10.5, traded_volume: volume, previous_closing_price: 10, md_entry_time: `${RUN} 12:59:57`, traded_value: volume * 10.5,
  buy_order_qty: 7, sell_order_qty: 8, highest_bid_price: 5, lowest_offer_price: 6, security_type: 'CS', ...extra,
})

const histRow = (symbol, type, volume, dates, extra = {}) => ({
  Symbol: symbol, MDSubOrderBookType: type, OpeningPrice: '10', ClosingPrice: '11', HighPrice: '12', LowPrice: '9', VWAP: '10.5', Volume: String(volume),
  HighestBidPrice: '111', LowestOfferPrice: '222', PreviousClose: '10', BuyOrderQty: '333', SellOrderQty: '444', Turnover: '1', Trades: '55',
  MDEntryTime: `${dates} 04:00:00`, companycode: '9001', MarketSegmentID: 'SEG1', securityType: 'CS', dates, ...extra,
})

// A stateful stub table. Reads and writes are logged with whether the lock was held, so ordering can be asserted.
const stubWorld = ({ rows = [], bulkCreateError = null, updateError = null } = {}) => {
  const state = { held: false, acquires: 0, releases: 0, events: [], table: [], nextId: 1, earlierQueries: 0 }
  const add = (row) => { const copy = { ...row, id: state.nextId++ }; state.table.push(copy); return copy }
  rows.forEach(add)
  const note = (name) => state.events.push({ name, held: state.held })
  const table = {
    async findAll(options) {
      note('findAll')
      assert.strictEqual(options.raw, true, 'reads use raw: true')
      const { where } = options
      if (typeof where.dates === 'string') return state.table.filter((r) => r.dates === where.dates).map((r) => ({ ...r }))
      assert.deepStrictEqual(options.order, [['dates', 'DESC'], ['id', 'DESC']], 'earlier rows ordered newest first')
      const bound = where.dates[Op.lt]
      state.earlierQueries += 1
      assert.ok(Array.isArray(where.Symbol) && typeof bound === 'string', 'earlier rows are asked for by symbol list and Op.lt date')
      return state.table.filter((r) => where.Symbol.includes(r.Symbol) && r.dates < bound).map((r) => ({ ...r }))
        .sort((a, b) => (a.dates < b.dates ? 1 : a.dates > b.dates ? -1 : b.id - a.id))
    },
    async bulkCreate(newRows) {
      note('bulkCreate')
      if (bulkCreateError) throw bulkCreateError
      newRows.forEach(add)
    },
    async update(fields, options) {
      note('update')
      if (updateError) throw updateError
      const target = state.table.find((r) => r.id === options.where.id)
      assert.ok(target, 'update targets an existing id')
      Object.assign(target, fields)
    },
  }
  const lock = (onAcquire) => ({
    async acquire() {
      assert.strictEqual(state.held, false, 'lock is not re-entrant: acquired while held')
      state.acquires += 1
      state.held = true
      note('acquire')
      if (onAcquire) onAcquire(state, add)
      return () => { state.held = false; state.releases += 1; note('release') }
    },
  })
  const todayRows = () => state.table.filter((r) => r.dates === RUN)
  return { state, db: { _securitytradingstatus_history: table }, lock, add, todayRows }
}

const stubClient = (world, ...answers) => {
  const client = { calls: 0, heldDuringCall: [] }
  client.call = async () => {
    client.calls += 1
    client.heldDuringCall.push(world.state.held)
    const a = answers.length > 1 ? answers.shift() : answers[0]
    if (a instanceof Error) throw a
    return a
  }
  return client
}
const okBody = (rows) => ({ status: 200, bodyText: JSON.stringify(rows), retryAfterSeconds: null })

const harness = (world, { client, now = NOW, dryRun = false, lock, failMail = false } = {}) => {
  const logs = [], mails = [], sleeps = []
  const args = {
    db: world.db, client, now, dryRun, alertEmail: ALERT, lock: lock || world.lock(),
    log: (line) => { logs.push(String(line)) },
    sendMail: async (mail) => { if (failMail) throw new Error('smtp down'); mails.push(mail) },
    sleep: async (ms) => { sleeps.push([ms, world.state.held]) },
  }
  return { args, logs, mails, sleeps, run: () => runHistoryFallback(args) }
}

const snapshot = (world) => JSON.stringify(world.state.table)

;(async () => {
  try {
    // healthy day: matching rows, nothing written, no mail
    {
      const w = stubWorld({ rows: [histRow('AAA-O-0000', 'Regular', 1000, RUN), histRow('BBB-O-0000', 'Block Trade', 20, RUN)] })
      const h = harness(w, { client: stubClient(w, okBody([mseRow('AAA-O-0000', 'Regular', 1000), mseRow('BBB-O-0000', 'Block Trade', 20), mseRow('CCC-O-0000', 'Regular', 0, { closing_price: 0, md_entry_time: null })])) })
      const before = snapshot(w)
      const s = await h.run()
      assert.strictEqual(s.status, 'healthy')
      assert.strictEqual(s.runDate, RUN)
      assert.strictEqual(s.inserts, 0)
      assert.strictEqual(s.updates, 0)
      assert.strictEqual(snapshot(w), before)
      assert.strictEqual(h.mails.length, 0)
      assert.strictEqual(h.logs.length, 1)
      assert.ok(h.logs[0].includes('healthy'))
      assert.strictEqual(w.state.events.filter((e) => e.name === 'bulkCreate' || e.name === 'update').length, 0)
    }

    // frozen feed: partial and missing rows are written, exactly one mail, counts in the summary
    const frozenWorld = () => stubWorld({ rows: [
      histRow('AAA-O-0000', 'Regular', 400, RUN, { ClosingPrice: '0', MDEntryTime: `${RUN} 02:00:00` }),
      histRow('BBB-O-0000', 'Regular', 50, '2026-10-21', { MarketSegmentID: 'OLD' }),
      histRow('BBB-O-0000', 'Regular', 50, '2026-10-22', { MarketSegmentID: 'SEG2', Trades: '77', companycode: '8002', BuyOrderQty: '5', SellOrderQty: '6', HighestBidPrice: '7', LowestOfferPrice: '8' }),
      histRow('BBB-O-0000', 'Block Trade', 5, '2026-10-22', { MarketSegmentID: 'WRONGTYPE' }),
    ] })
    const frozenRows = () => [mseRow('AAA-O-0000', 'Regular', 1000), mseRow('BBB-O-0000', 'Regular', 500), mseRow('CCC-O-0000', 'Block Trade', 20)]
    let frozen
    {
      const w = frozenWorld()
      frozen = w
      const h = harness(w, { client: stubClient(w, okBody(frozenRows())) })
      const s = await h.run()
      assert.strictEqual(s.status, 'repaired')
      assert.strictEqual(s.inserts, 2)
      assert.strictEqual(s.updates, 1)
      assert.deepStrictEqual(s.newListings, [keyOf('CCC-O-0000', 'Block Trade')])
      assert.deepStrictEqual(s.anomalies, [])
      assert.strictEqual(h.mails.length, 1)
      assert.strictEqual(h.mails[0].email, ALERT)
      assert.ok(h.mails[0].subject.includes('2 шинэ') && h.mails[0].subject.includes('1 шинэчлэгдсэн'), h.mails[0].subject)
      assert.ok(typeof h.mails[0].html === 'string' && h.mails[0].html.length > 0)
      assert.strictEqual(h.logs.length, 1)

      const today = w.todayRows()
      assert.strictEqual(today.length, 3)
      const a = today.find((r) => r.Symbol === 'AAA-O-0000')
      assert.strictEqual(a.Volume, '1000')
      assert.strictEqual(a.ClosingPrice, '11')
      assert.strictEqual(a.MDEntryTime, `${RUN} 04:59:57`)
      assert.strictEqual(a.BuyOrderQty, '333', 'the existing row keeps its order book columns')
      assert.strictEqual(a.MarketSegmentID, 'SEG1')
      assert.strictEqual(a.dates, RUN)
      const b = today.find((r) => r.Symbol === 'BBB-O-0000')
      assert.strictEqual(b.Volume, '500')
      assert.strictEqual(b.MarketSegmentID, 'SEG2', 'carried from the latest earlier row of the same type')
      assert.strictEqual(b.Trades, '77')
      assert.strictEqual(b.companycode, '8002')
      assert.strictEqual(b.BuyOrderQty, '5')
      assert.strictEqual(b.LowestOfferPrice, '8')
      const c = today.find((r) => r.Symbol === 'CCC-O-0000')
      assert.strictEqual(c.MarketSegmentID, 'N/A')
      assert.strictEqual(c.Trades, '0')
      assert.strictEqual(c.companycode, '0')
      assert.strictEqual(c.BuyOrderQty, '7', 'a new listing uses MSE order book values')
      assert.strictEqual(c.ClosingPrice, '0')

      // lock discipline: MSE call outside the lock, reads and writes inside it, released once
      assert.deepStrictEqual(w.state.events.filter((e) => e.name === 'findAll').map((e) => e.held), [false, false, true], 'two loads before the lock, only today\'s rows are re-read inside it')
      assert.strictEqual(w.state.earlierQueries, 1, 'earlier rows are queried once, the locked plan reuses them')
      assert.ok(w.state.events.filter((e) => e.name === 'bulkCreate' || e.name === 'update').every((e) => e.held))
      assert.deepStrictEqual(h.args.client.heldDuringCall, [false])
      assert.strictEqual(w.state.acquires, 1)
      assert.strictEqual(w.state.releases, 1)
      assert.strictEqual(w.state.held, false)
    }

    // second run straight after the first changes nothing and sends nothing
    {
      const w = frozen
      const before = snapshot(w)
      const h = harness(w, { client: stubClient(w, okBody(frozenRows())) })
      const s = await h.run()
      assert.strictEqual(s.status, 'healthy')
      assert.strictEqual(s.inserts, 0)
      assert.strictEqual(s.updates, 0)
      assert.strictEqual(snapshot(w), before)
      assert.strictEqual(h.mails.length, 0)
      assert.strictEqual(w.todayRows().length, 3)
    }

    // MSE unreachable: status mse-unreachable, no writes, one mail containing the reason
    {
      const w = frozenWorld()
      const before = snapshot(w)
      const h = harness(w, { client: stubClient(w, { status: 422, bodyText: 'nope', retryAfterSeconds: null }) })
      const s = await h.run()
      assert.strictEqual(s.status, 'mse-unreachable')
      assert.strictEqual(s.reason, 'HTTP 422')
      assert.strictEqual(snapshot(w), before)
      assert.strictEqual(w.state.acquires, 0)
      assert.strictEqual(h.mails.length, 1)
      assert.ok(h.mails[0].html.includes('HTTP 422'))
      assert.ok(h.mails[0].subject.includes(RUN))
      assert.strictEqual(h.logs.length, 1)
      assert.ok(h.logs[0].includes('status=mse-unreachable') && h.logs[0].includes('reason=HTTP 422'), h.logs[0])
      assert.ok(!h.logs[0].includes('nope'), 'the response body is never logged')
    }

    // non-trading day: no fresh traded rows, no writes, no mail (stale rows count as not fresh)
    {
      const w = stubWorld()
      const h = harness(w, { client: stubClient(w, okBody([
        mseRow('AAA-O-0000', 'Regular', 0, { closing_price: 0, md_entry_time: null }),
        mseRow('BBB-O-0000', 'Regular', 900, { md_entry_time: '2026-10-22 12:59:57' }),
      ])) })
      const s = await h.run()
      assert.strictEqual(s.status, 'non-trading-day')
      assert.strictEqual(w.state.table.length, 0)
      assert.strictEqual(w.state.acquires, 0)
      assert.strictEqual(h.mails.length, 0)
      assert.strictEqual(h.logs.length, 1)
    }

    // flagged: a stored volume higher than MSE's is reported, never lowered; one mail
    {
      const w = stubWorld({ rows: [histRow('AAA-O-0000', 'Regular', 2000, RUN)] })
      const h = harness(w, { client: stubClient(w, okBody([mseRow('AAA-O-0000', 'Regular', 1000)])) })
      const s = await h.run()
      assert.strictEqual(s.status, 'flagged')
      assert.strictEqual(s.anomalies.length, 1)
      assert.strictEqual(w.todayRows()[0].Volume, '2000')
      assert.strictEqual(w.todayRows().length, 1)
      assert.strictEqual(h.mails.length, 1)
      assert.strictEqual(w.state.held, false)
    }

    // dry run: nothing written, nothing mailed, status dry-run with the would-be counts
    {
      const w = frozenWorld()
      const before = snapshot(w)
      const h = harness(w, { client: stubClient(w, okBody(frozenRows())), dryRun: true })
      const s = await h.run()
      assert.strictEqual(s.status, 'dry-run')
      assert.strictEqual(s.inserts, 2)
      assert.strictEqual(s.updates, 1)
      assert.deepStrictEqual(s.newListings, [keyOf('CCC-O-0000', 'Block Trade')])
      assert.strictEqual(snapshot(w), before)
      assert.strictEqual(w.state.acquires, 0)
      assert.strictEqual(h.mails.length, 0)
      assert.deepStrictEqual(h.logs, [
        'mse-history-fallback 2026-10-23 status=dry-run inserts=2 updates=1 anomalies=0 duplicateKeys=0 newListings=1 skipped=0',
        'mse-history-fallback 2026-10-23 dry-run insert BBB-O-0000||Regular volume=500',
        'mse-history-fallback 2026-10-23 dry-run insert CCC-O-0000||Block Trade volume=20',
        'mse-history-fallback 2026-10-23 dry-run update AAA-O-0000||Regular id=1 stored=400 mse=1000',
      ])
      assert.strictEqual(w.state.events.filter((e) => e.name === 'bulkCreate' || e.name === 'update').length, 0)

      // with nothing to do, a dry run reports the usual healthy / non-trading-day
      const w2 = stubWorld({ rows: [histRow('AAA-O-0000', 'Regular', 1000, RUN)] })
      assert.strictEqual((await harness(w2, { client: stubClient(w2, okBody([mseRow('AAA-O-0000', 'Regular', 1000)])), dryRun: true }).run()).status, 'healthy')
      const w3 = stubWorld()
      assert.strictEqual((await harness(w3, { client: stubClient(w3, okBody([])), dryRun: true }).run()).status, 'non-trading-day')

      // an unreachable MSE in a dry run still sends no mail
      const w4 = stubWorld()
      const h4 = harness(w4, { client: stubClient(w4, new Error('HTTP 500')), dryRun: true })
      assert.strictEqual((await h4.run()).status, 'mse-unreachable')
      assert.strictEqual(h4.mails.length, 0)
      assert.strictEqual(h4.logs.length, 1)
      assert.ok(h4.logs[0].includes('status=mse-unreachable') && h4.logs[0].includes('reason=HTTP 500'), h4.logs[0])
    }

    // row added by someone else while waiting for the lock is not duplicated
    {
      const w = stubWorld()
      const rows = [mseRow('AAA-O-0000', 'Regular', 1000), mseRow('BBB-O-0000', 'Regular', 500)]
      const raced = w.lock((state, add) => { add(histRow('AAA-O-0000', 'Regular', 1000, RUN)) })
      const h = harness(w, { client: stubClient(w, okBody(rows)), lock: raced })
      const s = await h.run()
      assert.strictEqual(w.todayRows().filter((r) => r.Symbol === 'AAA-O-0000').length, 1, 'no duplicate for the raced key')
      assert.strictEqual(w.todayRows().filter((r) => r.Symbol === 'BBB-O-0000').length, 1)
      assert.strictEqual(w.todayRows().length, 2)
      assert.strictEqual(s.status, 'repaired')
      assert.strictEqual(s.inserts, 1, 'the summary counts what was actually written')
      assert.strictEqual(h.mails.length, 1)
      assert.strictEqual(w.state.held, false)
      assert.strictEqual(w.state.earlierQueries, 1, 'one earlier-rows query for a run that writes')
    }

    // a stock whose today row vanishes under the lock has no reused previous row: it is planned as a new listing
    {
      const w = stubWorld({ rows: [histRow('AAA-O-0000', 'Regular', 1000, RUN), histRow('BBB-O-0000', 'Regular', 50, '2026-10-22')] })
      const vanish = w.lock((state) => { state.table = state.table.filter((r) => !(r.Symbol === 'AAA-O-0000' && r.dates === RUN)) })
      const h = harness(w, { client: stubClient(w, okBody([mseRow('AAA-O-0000', 'Regular', 1000), mseRow('BBB-O-0000', 'Regular', 500)])), lock: vanish })
      const s = await h.run()
      assert.strictEqual(s.status, 'repaired')
      assert.strictEqual(s.inserts, 2)
      assert.deepStrictEqual(s.newListings, [keyOf('AAA-O-0000', 'Regular')])
      assert.strictEqual(w.state.earlierQueries, 1)
    }

    // run date is the Ulaanbaatar date
    {
      const w = stubWorld()
      const rows = [mseRow('AAA-O-0000', 'Regular', 1000, { md_entry_time: '2026-10-24 12:59:57' })]
      const h = harness(w, { client: stubClient(w, okBody(rows)), now: new Date('2026-10-23T16:30:00Z') })
      const s = await h.run()
      assert.strictEqual(s.runDate, '2026-10-24')
      assert.strictEqual(s.status, 'repaired')
      assert.strictEqual(w.state.table[0].dates, '2026-10-24')
    }

    // a mail failure does not throw
    {
      const w = frozenWorld()
      const h = harness(w, { client: stubClient(w, okBody(frozenRows())), failMail: true })
      const s = await h.run()
      assert.strictEqual(s.status, 'repaired')
      assert.strictEqual(w.todayRows().length, 3)
      assert.ok(h.logs.some((l) => l.includes('mail')), 'the failure is logged')
      assert.ok(!h.logs.join('\n').includes('smtp down'), 'the mail error text is not logged')
      const w2 = stubWorld()
      const h2 = harness(w2, { client: stubClient(w2, new Error('HTTP 500')), failMail: true })
      assert.strictEqual((await h2.run()).status, 'mse-unreachable')
    }

    // the log output never contains the strings "Bearer" or "access_token"
    {
      const w = stubWorld()
      const h = harness(w, { client: stubClient(w, { status: 401, bodyText: 'login failed: Bearer abc.def access_token=zzz', retryAfterSeconds: null }), failMail: true })
      const s = await h.run()
      assert.strictEqual(s.status, 'mse-unreachable')
      const all = h.logs.join('\n')
      assert.ok(all.includes('reason=HTTP 401'), all)
      assert.ok(!all.includes('Bearer') && !all.includes('access_token') && !all.includes('zzz'))
      const w2 = frozenWorld()
      const h2 = harness(w2, { client: stubClient(w2, okBody(frozenRows())), failMail: true })
      await h2.run()
      assert.ok(!h2.logs.join('\n').includes('Bearer') && !h2.logs.join('\n').includes('access_token'))
    }

    // rows that are not plain objects are ignored, the valid row still lands
    {
      const w = stubWorld()
      const h = harness(w, { client: stubClient(w, okBody([null, 7, mseRow('AAA-O-0000', 'Regular', 1000)])) })
      const s = await h.run()
      assert.strictEqual(s.status, 'repaired')
      assert.strictEqual(s.inserts, 1)
      assert.strictEqual(w.todayRows().length, 1)
    }

    // the retry wait happens outside the lock
    {
      const w = stubWorld()
      const client = stubClient(w, { status: 429, bodyText: '', retryAfterSeconds: 30 }, okBody([mseRow('AAA-O-0000', 'Regular', 1000)]))
      const h = harness(w, { client })
      const s = await h.run()
      assert.strictEqual(s.status, 'repaired')
      assert.deepStrictEqual(h.sleeps, [[35000, false]])
      assert.deepStrictEqual(client.heldDuringCall, [false, false])
    }

    // a failing write: lock released, no throw, status write-failed, one mail, a safe reason
    {
      const dbError = Object.assign(new Error('Access denied for user secretuser@10.0.0.9'), { name: 'SequelizeDatabaseError', parent: { code: 'ER_NO_DEFAULT_FOR_FIELD' } })
      const w = stubWorld({ bulkCreateError: dbError })
      const h = harness(w, { client: stubClient(w, okBody([mseRow('AAA-O-0000', 'Regular', 1000)])) })
      const s = await h.run()
      assert.strictEqual(s.status, 'write-failed')
      assert.strictEqual(s.reason, 'SequelizeDatabaseError ER_NO_DEFAULT_FOR_FIELD')
      assert.strictEqual(s.inserts, 1, 'the attempted counts are kept')
      assert.strictEqual(w.state.held, false)
      assert.strictEqual(w.state.releases, 1)
      assert.strictEqual(await w.lock().acquire().then((r) => { r(); return 'ok' }), 'ok', 'the lock can be acquired again')
      assert.strictEqual(h.mails.length, 1)
      assert.strictEqual(h.mails[0].email, ALERT)
      assert.ok(h.mails[0].html.includes('SequelizeDatabaseError ER_NO_DEFAULT_FOR_FIELD') && h.mails[0].html.includes(RUN))
      assert.ok(!h.mails[0].html.includes('secretuser') && !h.mails[0].subject.includes('secretuser'), 'the mail has no error message')
      assert.strictEqual(h.logs.length, 1)
      assert.ok(h.logs[0].includes('status=write-failed') && h.logs[0].includes('reason=SequelizeDatabaseError ER_NO_DEFAULT_FOR_FIELD'), h.logs[0])
      assert.ok(!h.logs.join('\n').includes('secretuser') && !h.logs.join('\n').includes('10.0.0.9'), 'the log has no error message')

      // an error without a string parent code: the name only
      const w2 = stubWorld({ bulkCreateError: Object.assign(new Error('secretuser'), { parent: { code: 1062 } }) })
      const h2 = harness(w2, { client: stubClient(w2, okBody([mseRow('AAA-O-0000', 'Regular', 1000)])) })
      const s2 = await h2.run()
      assert.strictEqual(s2.status, 'write-failed')
      assert.strictEqual(s2.reason, 'Error')
      assert.strictEqual(h2.mails.length, 1)
    }

    // bulkCreate works and a later update throws: the inserts stay counted, still write-failed
    {
      const dbError = Object.assign(new Error('Access denied for user secretuser@10.0.0.9'), { name: 'SequelizeDatabaseError', parent: { code: 'ER_LOCK_DEADLOCK' } })
      const w = frozenWorld()
      const failing = stubWorld({ rows: w.state.table.map(({ id, ...r }) => r), updateError: dbError })
      const h = harness(failing, { client: stubClient(failing, okBody(frozenRows())) })
      const s = await h.run()
      assert.strictEqual(s.status, 'write-failed')
      assert.strictEqual(s.reason, 'SequelizeDatabaseError ER_LOCK_DEADLOCK')
      assert.strictEqual(s.inserts, 2, 'inserts already written are not hidden')
      assert.strictEqual(s.updates, 1)
      assert.strictEqual(failing.todayRows().length, 3, 'the inserts did land')
      assert.strictEqual(failing.state.held, false)
      assert.strictEqual(h.mails.length, 1)
      assert.ok(!h.mails[0].html.includes('secretuser') && !h.logs.join('\n').includes('secretuser'))
    }

    // a read error under the lock is the same: write-failed, lock released, one mail
    {
      const readError = Object.assign(new Error('secretuser'), { name: 'SequelizeConnectionError', parent: { code: 'ECONNRESET' } })
      const w = stubWorld({ rows: [histRow('AAA-O-0000', 'Regular', 400, RUN)] })
      const realFindAll = w.db._securitytradingstatus_history.findAll
      let reads = 0
      w.db._securitytradingstatus_history.findAll = async (o) => { if (++reads === 2) throw readError; return realFindAll(o) }
      const h = harness(w, { client: stubClient(w, okBody([mseRow('AAA-O-0000', 'Regular', 1000)])) })
      const s = await h.run()
      assert.strictEqual(s.status, 'write-failed')
      assert.strictEqual(s.reason, 'SequelizeConnectionError ECONNRESET')
      assert.strictEqual(s.inserts, 0)
      assert.strictEqual(w.state.held, false)
      assert.strictEqual(h.mails.length, 1)
      assert.ok(!h.logs.join('\n').includes('secretuser'))
    }

    // a dry run never reaches the write path
    {
      const w = stubWorld({ bulkCreateError: new Error('must not be called'), updateError: new Error('must not be called') })
      const h = harness(w, { client: stubClient(w, okBody([mseRow('AAA-O-0000', 'Regular', 1000)])), dryRun: true })
      assert.strictEqual((await h.run()).status, 'dry-run')
    }

    console.log('mseHistoryFallback tests pass')
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
})()
