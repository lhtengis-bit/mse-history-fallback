// node test/db.test.js   (plain assert, no framework, no connection)
const assert = require('assert')
const { createDb } = require('../src/db')

const ENV = { DB_HOST: 'host-secret.example', DB_PORT: '3307', DB_USERNAME: 'user-secret', DB_PASSWORD: 'pass-secret', DB_DATABASE: 'dbname-secret', DB_TIMEZONE: '+08:00' }

// env values land in the Sequelize options, nothing connects
const db = createDb(ENV)
const cfg = db.sequelize.config
assert.strictEqual(cfg.host, 'host-secret.example')
assert.strictEqual(String(cfg.port), '3307')
assert.strictEqual(cfg.database, 'dbname-secret')
assert.strictEqual(cfg.username, 'user-secret')
assert.strictEqual(cfg.password, 'pass-secret')
assert.strictEqual(db.sequelize.options.dialect, 'mysql')
assert.strictEqual(db.sequelize.options.timezone, '+08:00')
assert.strictEqual(db.sequelize.options.logging, false)

// the model is defined on that connection
assert.strictEqual(db._securitytradingstatus_history.tableName, '_securitytradingstatus_history')
assert.strictEqual(db._securitytradingstatus_history.sequelize, db.sequelize)
assert.ok(db._securitytradingstatus_history.rawAttributes.MarketSegmentID)

// the MSE tables add-on's models share that connection
for (const name of ['mse_company', 'mse_index_daily', 'mse_top20_point', 'mse_orderbook_snapshot']) {
  assert.strictEqual(db[name].tableName, name)
  assert.strictEqual(db[name].sequelize, db.sequelize)
}

// a missing variable throws an error naming it, with none of the values
for (const name of ['DB_HOST', 'DB_DATABASE', 'DB_USERNAME', 'DB_TIMEZONE']) {
  const env = { ...ENV }
  delete env[name]
  assert.throws(() => createDb(env), (err) => {
    assert.ok(err.message.includes(name), `${name} not named`)
    assert.strictEqual(err.variable, name)
    assert.ok(!/secret/.test(err.message), 'a value leaked into the message')
    return true
  })
  env[name] = ''
  assert.throws(() => createDb(env), (err) => err.variable === name)
}

console.log('db tests pass')
