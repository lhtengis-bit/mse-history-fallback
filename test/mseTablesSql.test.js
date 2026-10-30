// node test/mseTablesSql.test.js   (plain assert, no framework, no connection)
// The Workbench script and the Sequelize models must describe the same tables: every model column is in its CREATE TABLE and vice versa.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createDb } = require('../src/db')

const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '2026-10-30-mse-tables.sql'), 'utf8')
const db = createDb({ DB_HOST: 'h', DB_USERNAME: 'u', DB_DATABASE: 'd', DB_TIMEZONE: '+08:00' })

const TABLES = ['mse_company', 'mse_index_daily', 'mse_top20_point', 'mse_orderbook_snapshot']
const KEYWORDS = new Set(['PRIMARY', 'UNIQUE', 'KEY'])

try {
  assert.strictEqual((sql.match(/CREATE TABLE/g) || []).length, TABLES.length)
  for (const name of TABLES) {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`))
    assert.ok(m, `${name}: CREATE TABLE not found or not utf8mb4 InnoDB`)
    const columns = m[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((w) => w && !KEYWORDS.has(w) && !w.startsWith('--'))
    const model = db[name]
    assert.ok(model, `${name}: no model`)
    assert.strictEqual(model.tableName, name)
    assert.deepStrictEqual([...columns].sort(), Object.keys(model.rawAttributes).sort(), `${name}: columns differ between SQL and model`)
  }
  // the keys the write rules rely on
  assert.ok(/UNIQUE KEY uq_mse_company_symbol \(symbol\)/.test(sql))
  assert.ok(/UNIQUE KEY uq_mse_index_daily \(index_name, trade_date\)/.test(sql))
  assert.ok(/UNIQUE KEY uq_mse_orderbook_entry \(md_entry_id, date_time\)/.test(sql))
  assert.ok(!/UNIQUE KEY[^\n]*trade_time/.test(sql), 'top20 points must not be unique on time')
  // nothing a MySQL below 8.0 cannot run
  assert.ok(!/\bWITH\b|\bOVER\s*\(|\bLAG\s*\(/i.test(sql.replace(/--[^\n]*/g, '')))

  console.log('mseTablesSql tests pass')
} catch (e) { console.error(e); process.exit(1) }
