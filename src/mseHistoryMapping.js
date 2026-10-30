// Pure mapping from an MSE security_trading / history row to the columns of _securitytradingstatus_history.
// No network, no database, no environment, no machine time zone.
const moment = require('moment-timezone')

const TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss'

// MSE sends Ulaanbaatar time and the history table stores it as it comes (trade_realtime posts the live table's local time unchanged:
// every stored day ends at 12:59:xx, not 04:59:xx), so there is no conversion; the format is only validated.
const toEntryTime = (local) => {
  const parsed = moment.utc(local, TIME_FORMAT, true)
  if (!parsed.isValid()) throw new Error(`invalid md_entry_time: ${local}`)
  return parsed.format(TIME_FORMAT)
}

// A history row stores every value as a string. null, undefined, empty or non-numeric gives '0'.
const formatNumber = (value) => {
  if (value === null || value === undefined || value === '') return '0'
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return String(Number(n.toFixed(6)))
}

// Fresh means a full, strictly formatted time dated the run date, so a row that passes can always go through toEntryTime.
const isFresh = (row, runDate) => typeof row.md_entry_time === 'string' && moment.utc(row.md_entry_time, TIME_FORMAT, true).isValid() && row.md_entry_time.slice(0, 10) === runDate

const qualifies = (row, runDate) => {
  if (!isFresh(row, runDate)) return false
  if (!(Number(row.traded_volume) > 0)) return false
  if (row.md_sub_order_book_type === 'Regular' && !(Number(row.closing_price) > 0)) return false
  return true
}

const toCoreFields = (row) => {
  const fields = {
    OpeningPrice: formatNumber(row.opening_price),
    ClosingPrice: formatNumber(row.closing_price),
    HighPrice: formatNumber(row.high_price),
    LowPrice: formatNumber(row.low_price),
    VWAP: formatNumber(row.vwap),
    Volume: formatNumber(row.traded_volume),
    PreviousClose: formatNumber(row.previous_closing_price),
    Turnover: formatNumber(row.traded_value),
    MDEntryTime: toEntryTime(row.md_entry_time),
  }
  if (row.security_type !== null && row.security_type !== undefined && row.security_type !== '') fields.securityType = String(row.security_type)
  return fields
}

const toOrderBookFields = (row) => ({
  BuyOrderQty: formatNumber(row.buy_order_qty),
  SellOrderQty: formatNumber(row.sell_order_qty),
  HighestBidPrice: formatNumber(row.highest_bid_price),
  LowestOfferPrice: formatNumber(row.lowest_offer_price),
})

module.exports = { toEntryTime, formatNumber, isFresh, qualifies, toCoreFields, toOrderBookFields }
