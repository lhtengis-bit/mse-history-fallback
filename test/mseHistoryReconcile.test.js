// node test/mseHistoryReconcile.test.js   (plain assert, no framework)
const assert = require('assert')
const { keyOf, planReconcile } = require('../src/mseHistoryReconcile')
const { toCoreFields, toOrderBookFields } = require('../src/mseHistoryMapping')

const RUN = '2026-10-23'
const COLUMNS = ['Symbol', 'MDSubOrderBookType', 'OpeningPrice', 'ClosingPrice', 'HighPrice', 'LowPrice', 'VWAP', 'Volume', 'HighestBidPrice', 'LowestOfferPrice', 'PreviousClose', 'BuyOrderQty', 'SellOrderQty', 'Turnover', 'Trades', 'MDEntryTime', 'companycode', 'MarketSegmentID', 'securityType', 'dates']
const KEPT = ['BuyOrderQty', 'SellOrderQty', 'HighestBidPrice', 'LowestOfferPrice', 'Trades', 'companycode', 'MarketSegmentID']

const mse = (over = {}) => ({ symbol: 'MSE-O-0000', md_sub_order_book_type: 'Regular', opening_price: 395, closing_price: 394.33, high_price: 397.99, low_price: 390, vwap: 393.9, traded_volume: 89612, highest_bid_price: 396.77, lowest_offer_price: 396.78, previous_closing_price: 390.47, md_entry_time: '2026-10-23 12:59:57', buy_order_qty: 14, sell_order_qty: 258, traded_value: 35298763.62, security_type: 'CS', ...over })
const stored = (over = {}) => ({ id: 11, Symbol: 'MSE-O-0000', MDSubOrderBookType: 'Regular', OpeningPrice: '395', ClosingPrice: '394', HighPrice: '397', LowPrice: '390', VWAP: '393', Volume: '50000', HighestBidPrice: '1', LowestOfferPrice: '2', PreviousClose: '390.47', BuyOrderQty: '3', SellOrderQty: '4', Turnover: '100', Trades: '9', MDEntryTime: '2026-10-23 03:00:00', companycode: '7', MarketSegmentID: 'I Classification', securityType: 'CS', dates: RUN, ...over })
const prev = (over = {}) => ({ id: 5, Symbol: 'MSE-O-0000', MDSubOrderBookType: 'Regular', BuyOrderQty: '5000', SellOrderQty: '6000', HighestBidPrice: '390', LowestOfferPrice: '391', Trades: '12', companycode: '7', MarketSegmentID: 'I Classification', securityType: 'CS', dates: '2026-10-22', ...over })
const prevMap = (...rows) => new Map(rows.map((r) => [keyOf(r.Symbol, r.MDSubOrderBookType), r]))
const plan = (mseRows, todayRows = [], previousRows = new Map()) => planReconcile({ mseRows, todayRows, previousRows, runDate: RUN })

try {
  assert.strictEqual(keyOf('MSE-O-0000', 'Regular'), 'MSE-O-0000||Regular')

  // --- missing stock is inserted with the seven columns carried from its latest earlier row
  {
    const r = plan([mse()], [], prevMap(prev()))
    assert.strictEqual(r.inserts.length, 1)
    assert.deepStrictEqual(r.updates, [])
    assert.deepStrictEqual(r.anomalies, [])
    assert.deepStrictEqual(r.newListings, [])
    assert.deepStrictEqual(Object.keys(r).sort(), ['anomalies', 'duplicateKeys', 'inserts', 'newListings', 'qualifyingCount', 'skippedNoTimestamp', 'updates'])
    const ins = r.inserts[0]
    assert.deepStrictEqual(Object.keys(ins).sort(), [...COLUMNS].sort())
    for (const c of COLUMNS) assert.strictEqual(typeof ins[c], 'string', c)
    assert.deepStrictEqual({ BuyOrderQty: ins.BuyOrderQty, SellOrderQty: ins.SellOrderQty, HighestBidPrice: ins.HighestBidPrice, LowestOfferPrice: ins.LowestOfferPrice, Trades: ins.Trades, companycode: ins.companycode, MarketSegmentID: ins.MarketSegmentID }, { BuyOrderQty: '5000', SellOrderQty: '6000', HighestBidPrice: '390', LowestOfferPrice: '391', Trades: '12', companycode: '7', MarketSegmentID: 'I Classification' })
    for (const [k, v] of Object.entries(toCoreFields(mse()))) assert.strictEqual(ins[k], v, k)
    assert.strictEqual(ins.Symbol, 'MSE-O-0000')
    assert.strictEqual(ins.MDSubOrderBookType, 'Regular')
    assert.strictEqual(ins.dates, RUN)
    assert.strictEqual(ins.MDEntryTime, '2026-10-23 04:59:57')
    assert.strictEqual(r.qualifyingCount, 1)
  }

  // --- row the feed froze mid-day is completed
  {
    const row = mse()
    const r = plan([row], [stored({ id: 11, Volume: '50000' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [{ id: 11, fields: toCoreFields(row) }])
    for (const k of KEPT) assert.ok(!(k in r.updates[0].fields), k)
    assert.deepStrictEqual(r.inserts, [])
    assert.deepStrictEqual(r.anomalies, [])
  }

  // --- equal volume is left alone, also against a stored value with a thousands separator
  {
    let r = plan([mse()], [stored({ Volume: '89612' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [])
    assert.deepStrictEqual(r.inserts, [])
    assert.deepStrictEqual(r.anomalies, [])
    r = plan([mse()], [stored({ Volume: '89,612' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [])
    assert.deepStrictEqual(r.anomalies, [])
  }

  // --- stored volume higher than MSE's is reported as an anomaly and not updated
  {
    const r = plan([mse()], [stored({ Volume: '1,000,000' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [])
    assert.deepStrictEqual(r.anomalies, [{ key: 'MSE-O-0000||Regular', stored: 1000000, mse: 89612 }])
  }

  // --- duplicate rows for one key: highest volume compared and updated, ties to the highest id
  {
    const row = mse()
    let r = plan([row], [stored({ id: 11, Volume: '50000' }), stored({ id: 12, Volume: '60000' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [{ id: 12, fields: toCoreFields(row) }])
    assert.deepStrictEqual(r.duplicateKeys, ['MSE-O-0000||Regular'])
    r = plan([row], [stored({ id: 12, Volume: '60000' }), stored({ id: 14, Volume: '60000' }), stored({ id: 13, Volume: '60000' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [{ id: 14, fields: toCoreFields(row) }])
    assert.deepStrictEqual(r.duplicateKeys, ['MSE-O-0000||Regular'])
    // the compared row is the highest-volume one: it equals MSE's, so nothing is updated
    r = plan([row], [stored({ id: 11, Volume: '50000' }), stored({ id: 12, Volume: '89612' })], prevMap(prev()))
    assert.deepStrictEqual(r.updates, [])
    assert.deepStrictEqual(r.duplicateKeys, ['MSE-O-0000||Regular'])
    // a single row reports no duplicates
    assert.deepStrictEqual(plan([row], [stored()], prevMap(prev())).duplicateKeys, [])
  }

  // --- stock with no earlier row is a new listing
  {
    const row = mse({ symbol: 'MSE-N-0001', buy_order_qty: 21, sell_order_qty: 22, highest_bid_price: 10.5, lowest_offer_price: 11 })
    const r = plan([row], [], new Map())
    assert.strictEqual(r.inserts.length, 1)
    const ins = r.inserts[0]
    assert.deepStrictEqual({ BuyOrderQty: ins.BuyOrderQty, SellOrderQty: ins.SellOrderQty, HighestBidPrice: ins.HighestBidPrice, LowestOfferPrice: ins.LowestOfferPrice }, toOrderBookFields(row))
    assert.strictEqual(ins.Trades, '0')
    assert.strictEqual(ins.companycode, '0')
    assert.strictEqual(ins.MarketSegmentID, 'N/A')
    assert.strictEqual(ins.dates, RUN)
    assert.deepStrictEqual(r.newListings, ['MSE-N-0001||Regular'])
  }

  // --- null or empty carried MarketSegmentID is written as N/A
  for (const seg of [null, '', undefined]) {
    const r = plan([mse()], [], prevMap(prev({ MarketSegmentID: seg })))
    assert.strictEqual(r.inserts[0].MarketSegmentID, 'N/A')
    assert.deepStrictEqual(r.newListings, [])
  }

  // --- traded row without a timestamp is skipped and reported; a row dated another day is ignored without a report
  {
    const noTime = mse({ symbol: 'A', md_entry_time: null })
    const emptyTime = mse({ symbol: 'B', md_entry_time: '' })
    const badTime = mse({ symbol: 'C', md_entry_time: '2026-10-23' })
    const noTimeBlock = mse({ symbol: 'D', md_sub_order_book_type: 'Block Trade', closing_price: null, md_entry_time: null })
    const noTimeZeroClose = mse({ symbol: 'E', closing_price: 0, md_entry_time: null })
    const noTimeUntraded = mse({ symbol: 'F', traded_volume: 0, md_entry_time: null })
    const otherDay = mse({ symbol: 'G', md_entry_time: '2026-10-22 12:59:57' })
    const r = plan([noTime, emptyTime, badTime, noTimeBlock, noTimeZeroClose, noTimeUntraded, otherDay])
    assert.deepStrictEqual(r.skippedNoTimestamp, ['A||Regular', 'B||Regular', 'C||Regular', 'D||Block Trade', 'E||Regular'])
    assert.deepStrictEqual(r.inserts, [])
    assert.deepStrictEqual(r.updates, [])
    assert.deepStrictEqual(r.newListings, [])
    assert.strictEqual(r.qualifyingCount, 0)
  }

  // --- Regular row with closing price 0 is excluded; Block Trade row with no closing price is included; qualifyingCount counts only qualifying rows
  {
    const regularZero = mse({ symbol: 'R', closing_price: 0 })
    const block = mse({ symbol: 'B', md_sub_order_book_type: 'Block Trade', closing_price: null })
    const untraded = mse({ symbol: 'U', traded_volume: 0 })
    const r = plan([regularZero, block, untraded], [], new Map())
    assert.strictEqual(r.qualifyingCount, 1)
    assert.strictEqual(r.inserts.length, 1)
    assert.strictEqual(r.inserts[0].Symbol, 'B')
    assert.strictEqual(r.inserts[0].MDSubOrderBookType, 'Block Trade')
    assert.deepStrictEqual(r.skippedNoTimestamp, [])
    assert.deepStrictEqual(r.newListings, ['B||Block Trade'])
  }

  // --- traded Block Trade row with null opening, high, low and vwap is inserted with '0', never 'null' or 'NaN'
  {
    const block = mse({ md_sub_order_book_type: 'Block Trade', opening_price: null, closing_price: null, high_price: null, low_price: null, vwap: null, buy_order_qty: null, sell_order_qty: null, highest_bid_price: null, lowest_offer_price: null })
    const r = plan([block], [], new Map())
    const ins = r.inserts[0]
    for (const c of ['OpeningPrice', 'ClosingPrice', 'HighPrice', 'LowPrice', 'VWAP', 'BuyOrderQty', 'SellOrderQty', 'HighestBidPrice', 'LowestOfferPrice']) assert.strictEqual(ins[c], '0', c)
    for (const c of COLUMNS) assert.ok(!/null|NaN|undefined/.test(ins[c]), c)
  }

  // --- securityType: null from MSE is carried from the earlier row on insert, 'N/A' if none, and omitted on update
  {
    const nullType = mse({ security_type: null })
    let r = plan([nullType], [], prevMap(prev({ securityType: 'PS' })))
    assert.strictEqual(r.inserts[0].securityType, 'PS')
    r = plan([nullType], [], prevMap(prev({ securityType: null })))
    assert.strictEqual(r.inserts[0].securityType, 'N/A')
    r = plan([nullType], [], new Map())
    assert.strictEqual(r.inserts[0].securityType, 'N/A')
    r = plan([nullType], [stored({ Volume: '1' })], prevMap(prev()))
    assert.ok(!('securityType' in r.updates[0].fields))
    // MSE's own value wins over the earlier row
    r = plan([mse({ security_type: 'CS' })], [], prevMap(prev({ securityType: 'PS' })))
    assert.strictEqual(r.inserts[0].securityType, 'CS')
  }

  // --- inputs are not mutated
  {
    const rows = [mse()]
    const today = [stored({ Volume: '1' })]
    const snapshot = JSON.stringify([rows, today])
    plan(rows, today, prevMap(prev()))
    assert.strictEqual(JSON.stringify([rows, today]), snapshot)
  }

  console.log('mseHistoryReconcile tests pass')
} catch (e) { console.error(e); process.exit(1) }
