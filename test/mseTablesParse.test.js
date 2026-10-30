// node test/mseTablesParse.test.js   (plain assert, no framework)
// Real responses of 2026-10-30 (orderbook cut to its first 400 rows), in test/fixtures.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { num, parseCompanies, parseIndexDaily, parseTop20, parseOrderbook } = require('../src/mseTablesParse')

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'))
const AT = new Date('2026-10-30T07:10:00Z')

try {
  // num: MSE's "null" string is NULL, real zeros stay zeros
  assert.strictEqual(num('null'), null)
  assert.strictEqual(num(null), null)
  assert.strictEqual(num(''), null)
  assert.strictEqual(num('abc'), null)
  assert.strictEqual(num(0), 0)
  assert.strictEqual(num('614.99'), 614.99)

  // companyinfo: 270 of 270, nothing skipped, symbol and isin unique, the 54 null reg_dates stay NULL
  const companiesRaw = load('mse_companyinfo_sample.json')
  const companies = parseCompanies(companiesRaw, AT)
  assert.strictEqual(companiesRaw.length, 270)
  assert.strictEqual(companies.rows.length, 270)
  assert.strictEqual(companies.skipped, 0)
  assert.strictEqual(new Set(companies.rows.map((r) => r.symbol)).size, 270)
  assert.strictEqual(companies.rows.filter((r) => r.reg_date === null).length, companiesRaw.filter((r) => r.reg_date === null).length)
  assert.ok(companies.rows.every((r) => r.updated_at === AT))
  assert.deepStrictEqual(companies.rows[0], { symbol: 'ZGEB-BD-28/10/29-A0426-11.196', name: companiesRaw[0].name, isin: 'MN0ZGEB13786', reg_date: '2026-10-22', issued_shares: 100000, security_type: 5, updated_at: AT })

  // security_index: 3 rows, names kept, numbers as numbers
  const index = parseIndexDaily(load('mse_security_index_sample.json'), AT)
  assert.strictEqual(index.rows.length, 3)
  assert.deepStrictEqual(index.rows.map((r) => r.index_name), ['Top 20', 'index1cls', 'index2cls'])
  assert.deepStrictEqual(index.rows[0], { index_name: 'Top 20', trade_date: '2026-10-30', index_unit: 67555.17, previous_index_unit: 66832.19, high: 68432.36, low: 66670.93, updated_at: AT })

  // top20_index_graph: all 313 points kept, including the two 14:05:00 rows (closing_price 0 and 1) that share a key
  const top20Raw = load('mse_top20_index_graph_sample.json')
  const top20 = parseTop20(top20Raw, AT)
  assert.strictEqual(top20Raw.length, 313)
  assert.strictEqual(top20.rows.length, 313)
  assert.strictEqual(top20.skipped, 0)
  const pair = top20.rows.filter((r) => r.trade_time === '14:05:00')
  assert.strictEqual(pair.length, 2)
  assert.deepStrictEqual(pair.map((r) => r.closing_price).sort(), [0, 1])
  assert.ok(top20.rows.every((r) => r.trade_date === '2026-10-29' && r.fetched_at === AT))

  // orderbook: every row kept, "null" number_of_orders is NULL, strings become numbers, local date_time kept as text
  const bookRaw = load('mse_orderbook_sample.json')
  const book = parseOrderbook(bookRaw, AT)
  assert.strictEqual(bookRaw.length, 400)
  assert.strictEqual(book.rows.length, 400)
  assert.strictEqual(book.skipped, 0)
  assert.ok(book.rows.every((r) => r.number_of_orders === null))
  assert.ok(book.rows.every((r) => typeof r.md_entry_type === 'number' && typeof r.md_price_level === 'number' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.date_time)))
  assert.strictEqual(new Set(book.rows.map((r) => r.md_entry_id)).size, 400)
  assert.deepStrictEqual(book.rows[0], { mse_id: 79688, symbol: 'MNP-O-0000', md_sub_order_book_type: 'Regular', md_entry_type: 1, md_entry_position_no: 1, md_entry_id: 'O0T6DFcHsE7X', md_entry_px: 617, md_entry_size: 1, number_of_orders: null, md_price_level: 8, date_time: '2026-10-30 14:05:35', fetched_at: AT })

  // rows missing what the table cannot do without are skipped and counted, never thrown on
  const bad = parseCompanies([{ name: 'x' }, null, 'text', { symbol: 'A-O-0000' }], AT)
  assert.deepStrictEqual(bad.rows.map((r) => r.symbol), ['A-O-0000'])
  assert.strictEqual(bad.skipped, 3)
  assert.strictEqual(parseIndexDaily([{ index: 'Top 20', date: '30-10-2026' }], AT).skipped, 1)
  assert.strictEqual(parseTop20([{ index: 'Top 20', date: '2026-10-29', time: '10:00', index_unit: 1 }, { index: 'Top 20', date: '2026-10-29', time: '10:00:00', index_unit: 'null' }], AT).skipped, 2)
  assert.strictEqual(parseOrderbook([{ ...bookRaw[0], md_entry_id: '' }, { ...bookRaw[0], md_entry_px: 'null' }, { ...bookRaw[0], date_time: '2026-10-30T14:05:35' }], AT).skipped, 3)

  console.log('mseTablesParse tests pass')
} catch (e) { console.error(e); process.exit(1) }
