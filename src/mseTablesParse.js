// Pure parsers for MSE's four non-trading endpoints (companyinfo, security_index, top20_index_graph, orderbook).
// Each takes the decoded JSON array and returns { rows, skipped }: rows shaped for the tables in sql/2026-10-30-mse-tables.sql,
// skipped = rows missing a field the table cannot do without. Nothing here touches the network or the database.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}:\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// MSE sends the string "null" for an empty number (orderbook.number_of_orders); null, '' and anything non-numeric are NULL too
const num = (v) => {
  if (v === null || v === undefined || v === '' || v === 'null') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const dateOnly = (v) => (typeof v === 'string' && DATE.test(v) ? v : null)

const collect = (rows, build) => {
  const out = []
  let skipped = 0
  for (const row of rows) {
    const parsed = row && typeof row === 'object' ? build(row) : null
    if (parsed) out.push(parsed)
    else skipped++
  }
  return { rows: out, skipped }
}

const parseCompanies = (rows, updatedAt) =>
  collect(rows, (r) => {
    const symbol = text(r.symbol)
    if (!symbol) return null
    return { symbol, name: text(r.name), isin: text(r.isin), reg_date: dateOnly(r.reg_date), issued_shares: num(r.issued_shares), security_type: num(r.security_type), updated_at: updatedAt }
  })

const parseIndexDaily = (rows, updatedAt) =>
  collect(rows, (r) => {
    const index_name = text(r.index)
    const trade_date = dateOnly(r.date)
    if (!index_name || !trade_date) return null
    return { index_name, trade_date, index_unit: num(r.index_unit), previous_index_unit: num(r.previous_index_unit), high: num(r.high), low: num(r.low), updated_at: updatedAt }
  })

const parseTop20 = (rows, fetchedAt) =>
  collect(rows, (r) => {
    const index_name = text(r.index)
    const trade_date = dateOnly(r.date)
    const index_unit = num(r.index_unit)
    if (!index_name || !trade_date || typeof r.time !== 'string' || !TIME.test(r.time) || index_unit === null) return null
    return { index_name, trade_date, trade_time: r.time, index_unit, closing_price: num(r.closing_price), fetched_at: fetchedAt }
  })

// date_time stays Ulaanbaatar local text, exactly as sent
const parseOrderbook = (rows, fetchedAt) =>
  collect(rows, (r) => {
    const symbol = text(r.symbol)
    const md_entry_id = text(r.md_entry_id)
    const md_entry_px = num(r.md_entry_px)
    const md_entry_size = num(r.md_entry_size)
    const md_entry_type = num(r.md_entry_type)
    if (!symbol || !md_entry_id || md_entry_px === null || md_entry_size === null || md_entry_type === null || typeof r.date_time !== 'string' || !DATE_TIME.test(r.date_time)) return null
    return {
      mse_id: num(r.id),
      symbol,
      md_sub_order_book_type: text(r.md_sub_order_book_type) || 'Regular',
      md_entry_type,
      md_entry_position_no: num(r.md_entry_position_no),
      md_entry_id,
      md_entry_px,
      md_entry_size,
      number_of_orders: num(r.number_of_orders),
      md_price_level: num(r.md_price_level),
      date_time: r.date_time,
      fetched_at: fetchedAt,
    }
  })

module.exports = { num, parseCompanies, parseIndexDaily, parseTop20, parseOrderbook }
