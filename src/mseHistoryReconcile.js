// Pure planner: given MSE's rows, today's stored history rows and each stock's latest earlier row,
// decide what to insert, update and flag. No network, no database, no environment, no clock.
const { qualifies, isFresh, toCoreFields, toOrderBookFields } = require('./mseHistoryMapping')

const keyOf = (symbol, type) => `${symbol}||${type}`

const isBlank = (v) => v === null || v === undefined || v === ''

// The columns of a stock's earlier row that MSE's feed does not carry, kept on insert.
const carried = (value, fallback) => (isBlank(value) ? fallback : String(value))

// Stored volumes are strings, sometimes with thousands separators.
const storedVolume = (row) => {
  const n = Number(String(row.Volume).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

// A full strict time, whatever date it carries.
const hasFullTime = (row) => typeof row.md_entry_time === 'string' && isFresh(row, row.md_entry_time.slice(0, 10))

// One stored row per key is compared: highest volume, ties to the highest id.
const pickStored = (rows) => rows.reduce((best, row) => {
  if (!best) return row
  const v = storedVolume(row)
  const bv = storedVolume(best)
  return v > bv || (v === bv && row.id > best.id) ? row : best
}, null)

const buildInsert = (row, runDate, earlier) => {
  const core = toCoreFields(row)
  const book = earlier
    ? { BuyOrderQty: carried(earlier.BuyOrderQty, '0'), SellOrderQty: carried(earlier.SellOrderQty, '0'), HighestBidPrice: carried(earlier.HighestBidPrice, '0'), LowestOfferPrice: carried(earlier.LowestOfferPrice, '0') }
    : toOrderBookFields(row)
  return {
    Symbol: String(row.symbol),
    MDSubOrderBookType: String(row.md_sub_order_book_type),
    OpeningPrice: core.OpeningPrice,
    ClosingPrice: core.ClosingPrice,
    HighPrice: core.HighPrice,
    LowPrice: core.LowPrice,
    VWAP: core.VWAP,
    Volume: core.Volume,
    HighestBidPrice: book.HighestBidPrice,
    LowestOfferPrice: book.LowestOfferPrice,
    PreviousClose: core.PreviousClose,
    BuyOrderQty: book.BuyOrderQty,
    SellOrderQty: book.SellOrderQty,
    Turnover: core.Turnover,
    Trades: earlier ? carried(earlier.Trades, '0') : '0',
    MDEntryTime: core.MDEntryTime,
    companycode: earlier ? carried(earlier.companycode, '0') : '0',
    MarketSegmentID: earlier ? carried(earlier.MarketSegmentID, 'N/A') : 'N/A',
    securityType: core.securityType !== undefined ? core.securityType : earlier ? carried(earlier.securityType, 'N/A') : 'N/A',
    dates: runDate,
  }
}

const planReconcile = ({ mseRows, todayRows, previousRows, runDate }) => {
  const plan = { inserts: [], updates: [], anomalies: [], duplicateKeys: [], newListings: [], skippedNoTimestamp: [], qualifyingCount: 0 }

  // One qualifying MSE row per key (highest volume), in feed order.
  const wanted = new Map()
  for (const row of mseRows) {
    const key = keyOf(row.symbol, row.md_sub_order_book_type)
    if (qualifies(row, runDate)) {
      plan.qualifyingCount += 1
      const held = wanted.get(key)
      if (!held || Number(row.traded_volume) > Number(held.traded_volume)) wanted.set(key, row)
    } else if (Number(row.traded_volume) > 0 && !hasFullTime(row)) {
      plan.skippedNoTimestamp.push(key)
    }
  }

  const storedByKey = new Map()
  for (const row of todayRows) {
    const key = keyOf(row.Symbol, row.MDSubOrderBookType)
    if (!storedByKey.has(key)) storedByKey.set(key, [])
    storedByKey.get(key).push(row)
  }

  for (const [key, row] of wanted) {
    const rows = storedByKey.get(key)
    if (!rows) {
      const earlier = previousRows.get(key)
      if (!earlier) plan.newListings.push(key)
      plan.inserts.push(buildInsert(row, runDate, earlier))
      continue
    }
    if (rows.length > 1) plan.duplicateKeys.push(key)
    const target = pickStored(rows)
    const stored = storedVolume(target)
    const mse = Number(row.traded_volume)
    if (mse > stored) plan.updates.push({ id: target.id, fields: toCoreFields(row) })
    else if (mse < stored) plan.anomalies.push({ key, stored, mse })
  }

  return plan
}

module.exports = { keyOf, planReconcile }
