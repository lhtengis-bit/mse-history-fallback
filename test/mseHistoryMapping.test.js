// node test/mseHistoryMapping.test.js   (plain assert, no framework)
// The rows below are real MSE rows (history call of 2026-10-22, live call of 2026-10-23).
const assert = require('assert')
const { toEntryTime, formatNumber, isFresh, qualifies, toCoreFields, toOrderBookFields } = require('../src/mseHistoryMapping')

try {
  // --- toEntryTime: Ulaanbaatar time, stored as it comes (the table's rows end at 12:59:xx); a malformed time throws
  assert.strictEqual(toEntryTime('2026-10-22 12:59:57'), '2026-10-22 12:59:57')
  assert.strictEqual(toEntryTime('2026-10-23 03:30:00'), '2026-10-23 03:30:00')
  assert.throws(() => toEntryTime('2026-10-22T12:59:57'))

  // --- formatNumber: at most 6 decimals, no trailing zeros, null or undefined is '0' (never 'null' or 'NaN')
  assert.strictEqual(formatNumber(393.9070129394531), '393.907013')
  assert.strictEqual(formatNumber(257400), '257400')
  assert.strictEqual(formatNumber(1194948.1), '1194948.1')
  assert.strictEqual(formatNumber('12.50'), '12.5')
  assert.strictEqual(formatNumber(null), '0')
  assert.strictEqual(formatNumber(undefined), '0')

  // --- toCoreFields / toOrderBookFields
  const row = { symbol: 'MSE-O-0000', md_sub_order_book_type: 'Regular', opening_price: 395, closing_price: 394.33, high_price: 397.99, low_price: 390, vwap: 393.9070129394531, traded_volume: 89612, highest_bid_price: 396.77, lowest_offer_price: 396.78, previous_closing_price: 390.47, md_entry_time: '2026-10-22 12:59:57', buy_order_qty: 14, sell_order_qty: 258, traded_value: 35298763.62, security_type: 'CS' }
  assert.deepStrictEqual(toCoreFields(row), { OpeningPrice: '395', ClosingPrice: '394.33', HighPrice: '397.99', LowPrice: '390', VWAP: '393.907013', Volume: '89612', PreviousClose: '390.47', Turnover: '35298763.62', MDEntryTime: '2026-10-22 12:59:57', securityType: 'CS' })
  assert.ok(!('securityType' in toCoreFields({ ...row, security_type: null })), 'a null security type is omitted')
  assert.ok(!('securityType' in toCoreFields({ ...row, security_type: '' })), 'an empty security type is omitted')
  assert.deepStrictEqual(toOrderBookFields(row), { BuyOrderQty: '14', SellOrderQty: '258', HighestBidPrice: '396.77', LowestOfferPrice: '396.78' })
  assert.deepStrictEqual(
    toOrderBookFields({ ...row, buy_order_qty: null, sell_order_qty: null, highest_bid_price: null, lowest_offer_price: null }),
    { BuyOrderQty: '0', SellOrderQty: '0', HighestBidPrice: '0', LowestOfferPrice: '0' }
  )

  // --- isFresh / qualifies
  const live = { symbol: 'TUM-O-0000', md_sub_order_book_type: 'Regular', closing_price: 503.13, traded_volume: 21450, md_entry_time: '2026-10-23 12:59:54' }
  assert.strictEqual(isFresh(live, '2026-10-23'), true)
  assert.strictEqual(isFresh(live, '2026-10-24'), false)
  assert.strictEqual(isFresh({ ...live, md_entry_time: null }, '2026-10-23'), false)
  assert.strictEqual(qualifies(live, '2026-10-23'), true)
  for (const odd of ['2026-10-23', '2026-10-23 ', '2026-10-23T12:59:54', '2026-10-23 12:59:54.123', '2026-10-23 12:59', '2026-10-23 12:59:54Z', '2026-10-23 1:59:54']) {
    assert.strictEqual(isFresh({ ...live, md_entry_time: odd }, '2026-10-23'), false, `isFresh rejects ${odd}`)
    assert.strictEqual(qualifies({ ...live, md_entry_time: odd }, '2026-10-23'), false, `qualifies rejects ${odd}`)
  }
  assert.strictEqual(qualifies(live, '2026-10-24'), false, 'a stale row does not qualify')
  assert.strictEqual(qualifies({ ...live, closing_price: 0 }, '2026-10-23'), false, 'a Regular row needs a closing price')
  assert.strictEqual(qualifies({ ...live, md_sub_order_book_type: 'Block Trade', closing_price: null }, '2026-10-23'), true, 'a block trade has no closing price')
  assert.strictEqual(qualifies({ ...live, traded_volume: 0 }, '2026-10-23'), false)
  assert.strictEqual(qualifies({ ...live, md_entry_time: null }, '2026-10-23'), false)

  console.log('mseHistoryMapping tests pass')
} catch (e) { console.error(e); process.exit(1) }
