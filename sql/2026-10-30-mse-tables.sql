-- MSE datafeed tables, filled by `npm run tables` (src/tables.js). Safe to run twice: every statement is IF NOT EXISTS.
-- In MySQL Workbench: set the production database as the default schema first (right-click it > Set as Default Schema), then run the whole script.
-- MySQL older than 8.0 is fine: nothing here needs a CTE or a window function.

-- companyinfo: one row per security, refreshed on every run (matched on symbol)
CREATE TABLE IF NOT EXISTS mse_company (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  symbol        VARCHAR(100)    NOT NULL,
  name          VARCHAR(255)    NULL,
  isin          VARCHAR(20)     NULL,
  reg_date      DATE            NULL,
  issued_shares BIGINT UNSIGNED NULL,
  security_type TINYINT         NULL COMMENT 'MSE code as sent: 1 to 5, no mapping guessed',
  updated_at    DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mse_company_symbol (symbol),
  KEY ix_mse_company_isin (isin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- security_index: one row per index per day, the latest values win (matched on index_name + trade_date)
CREATE TABLE IF NOT EXISTS mse_index_daily (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  index_name          VARCHAR(50)     NOT NULL,
  trade_date          DATE            NOT NULL,
  index_unit          DECIMAL(18,4)   NULL,
  previous_index_unit DECIMAL(18,4)   NULL,
  high                DECIMAL(18,4)   NULL,
  low                 DECIMAL(18,4)   NULL,
  updated_at          DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mse_index_daily (index_name, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- top20_index_graph: intraday points. Not unique on time (MSE repeats some seconds), so a day is replaced as a whole
CREATE TABLE IF NOT EXISTS mse_top20_point (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  index_name    VARCHAR(50)     NOT NULL,
  trade_date    DATE            NOT NULL,
  trade_time    TIME            NOT NULL,
  index_unit    DECIMAL(18,4)   NOT NULL,
  closing_price DECIMAL(18,4)   NULL,
  fetched_at    DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY ix_mse_top20_point_day (index_name, trade_date, trade_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- orderbook: append-only history of resting orders. date_time is the order's own last-change time (Ulaanbaatar local),
-- so (md_entry_id, date_time) is one state of one order and a repeated run adds nothing
CREATE TABLE IF NOT EXISTS mse_orderbook_snapshot (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mse_id                 BIGINT UNSIGNED NULL COMMENT 'id as MSE sent it, informational only',
  symbol                 VARCHAR(100)    NOT NULL,
  md_sub_order_book_type VARCHAR(30)     NOT NULL,
  md_entry_type          TINYINT         NOT NULL COMMENT '0 or 1, as sent',
  md_entry_position_no   INT             NULL,
  md_entry_id            VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'case-sensitive: ids differing only by case are different orders',
  md_entry_px            DECIMAL(18,4)   NOT NULL,
  md_entry_size          BIGINT          NOT NULL,
  number_of_orders       INT             NULL,
  md_price_level         TINYINT         NULL,
  date_time              DATETIME        NOT NULL,
  fetched_at             DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mse_orderbook_entry (md_entry_id, date_time),
  KEY ix_mse_orderbook_symbol_time (symbol, date_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
