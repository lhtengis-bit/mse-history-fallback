// Builds the Sequelize connection and the one model the fallback writes. Nothing connects until the first query.
const { Sequelize, DataTypes } = require('sequelize')

const REQUIRED = ['DB_HOST', 'DB_DATABASE', 'DB_USERNAME', 'DB_TIMEZONE']

function createDb(env = process.env) {
  for (const name of REQUIRED) {
    // name only: a value (host, user) must never reach a log
    if (!env[name]) throw Object.assign(new Error(`environment variable ${name} is not set`), { variable: name })
  }
  const sequelize = new Sequelize(env.DB_DATABASE, env.DB_USERNAME, env.DB_PASSWORD, {
    host: env.DB_HOST,
    port: env.DB_PORT,
    dialect: 'mysql',
    timezone: env.DB_TIMEZONE,
    logging: false,
  })
  const _securitytradingstatus_history = require('./models/_securitytradingstatus_history')(sequelize, DataTypes)
  return { sequelize, _securitytradingstatus_history }
}

module.exports = { createDb }
