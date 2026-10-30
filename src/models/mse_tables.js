// The four MSE datafeed tables (sql/2026-10-30-mse-tables.sql). Dates and times that MSE sends as local text are STRING so they
// are written exactly as sent, the same way the history model keeps MDEntryTime; updated_at / fetched_at are real Dates.
module.exports = function (sequelize, DataTypes) {
  const id = { autoIncrement: true, type: DataTypes.BIGINT, allowNull: false, primaryKey: true }
  const options = (tableName) => ({ sequelize, tableName, timestamps: false })

  const mse_company = sequelize.define(
    'mse_company',
    {
      id,
      symbol: { type: DataTypes.STRING(100), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: true },
      isin: { type: DataTypes.STRING(20), allowNull: true },
      reg_date: { type: DataTypes.DATEONLY, allowNull: true },
      issued_shares: { type: DataTypes.BIGINT, allowNull: true },
      security_type: { type: DataTypes.INTEGER, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    },
    options('mse_company')
  )

  const mse_index_daily = sequelize.define(
    'mse_index_daily',
    {
      id,
      index_name: { type: DataTypes.STRING(50), allowNull: false },
      trade_date: { type: DataTypes.DATEONLY, allowNull: false },
      index_unit: { type: DataTypes.DECIMAL(18, 4), allowNull: true },
      previous_index_unit: { type: DataTypes.DECIMAL(18, 4), allowNull: true },
      high: { type: DataTypes.DECIMAL(18, 4), allowNull: true },
      low: { type: DataTypes.DECIMAL(18, 4), allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    },
    options('mse_index_daily')
  )

  const mse_top20_point = sequelize.define(
    'mse_top20_point',
    {
      id,
      index_name: { type: DataTypes.STRING(50), allowNull: false },
      trade_date: { type: DataTypes.DATEONLY, allowNull: false },
      trade_time: { type: DataTypes.STRING(8), allowNull: false },
      index_unit: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
      closing_price: { type: DataTypes.DECIMAL(18, 4), allowNull: true },
      fetched_at: { type: DataTypes.DATE, allowNull: false },
    },
    options('mse_top20_point')
  )

  const mse_orderbook_snapshot = sequelize.define(
    'mse_orderbook_snapshot',
    {
      id,
      mse_id: { type: DataTypes.BIGINT, allowNull: true },
      symbol: { type: DataTypes.STRING(100), allowNull: false },
      md_sub_order_book_type: { type: DataTypes.STRING(30), allowNull: false },
      md_entry_type: { type: DataTypes.INTEGER, allowNull: false },
      md_entry_position_no: { type: DataTypes.INTEGER, allowNull: true },
      md_entry_id: { type: DataTypes.STRING(40), allowNull: false },
      md_entry_px: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
      md_entry_size: { type: DataTypes.BIGINT, allowNull: false },
      number_of_orders: { type: DataTypes.INTEGER, allowNull: true },
      md_price_level: { type: DataTypes.INTEGER, allowNull: true },
      date_time: { type: DataTypes.STRING(19), allowNull: false },
      fetched_at: { type: DataTypes.DATE, allowNull: false },
    },
    options('mse_orderbook_snapshot')
  )

  return { mse_company, mse_index_daily, mse_top20_point, mse_orderbook_snapshot }
}
