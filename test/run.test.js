// node test/run.test.js   (plain assert, no framework)
const assert = require('assert')
const { main } = require('../src/run')

// requiring the runner must not have loaded the database or the mailer
assert.ok(!Object.keys(require.cache).some((k) => /src[\\/](db|mailer)\.js$/.test(k)), 'db or mailer loaded at require time')
const { spawnSync } = require('child_process')
const os = require('os')
const path = require('path')

const CREDS = { MSE_API_USER: 'u-secret', MSE_API_PASS: 'p-secret' }
const NOW = new Date('2026-10-12T08:20:00Z')

function harness({ env = CREDS, argv = [], run, closeError, mailError } = {}) {
  const h = { logs: [], runCalls: [], closeCalls: 0, mails: [] }
  h.db = { sequelize: { close: async () => { h.closeCalls++; if (closeError) throw closeError } } }
  h.sendMail = async (m) => { h.mails.push(m); if (mailError) throw mailError }
  h.run = async (args) => { h.runCalls.push(args); return run ? run(args) : { status: 'healthy' } }
  h.exec = () => main({ db: h.db, env, log: (l) => h.logs.push(l), run: h.run, sendMail: h.sendMail, argv, now: NOW })
  return h
}

;(async () => {
  // missing credentials: one fixed line, no run, exit 2, db still closed
  for (const env of [{}, { MSE_API_USER: 'u-secret' }, { MSE_API_PASS: 'p-secret' }]) {
    const h = harness({ env })
    assert.strictEqual(await h.exec(), 2)
    assert.strictEqual(h.runCalls.length, 0)
    assert.strictEqual(h.logs.length, 1)
    assert.ok(/MSE_API_USER/.test(h.logs[0]) && !/secret/.test(h.logs[0]))
    assert.strictEqual(h.closeCalls, 1)
  }

  // run receives the deps, dryRun false by default, default alert address
  let h = harness()
  assert.strictEqual(await h.exec(), 0)
  assert.strictEqual(h.runCalls.length, 1)
  const a = h.runCalls[0]
  assert.strictEqual(a.db, h.db)
  assert.strictEqual(a.now, NOW)
  assert.strictEqual(a.sendMail, h.sendMail)
  assert.strictEqual(typeof a.client.call, 'function')
  assert.strictEqual(a.dryRun, false)
  assert.strictEqual(a.alertEmail, 'it@bdsec.mn')
  assert.strictEqual(typeof a.log, 'function')
  assert.strictEqual(h.closeCalls, 1)

  // --dry-run and the alert address from the environment
  h = harness({ env: { ...CREDS, MSE_FALLBACK_ALERT_EMAIL: 'ops@example.com' }, argv: ['--dry-run'] })
  await h.exec()
  assert.strictEqual(h.runCalls[0].dryRun, true)
  assert.strictEqual(h.runCalls[0].alertEmail, 'ops@example.com')
  h = harness({ argv: ['--other'] })
  await h.exec()
  assert.strictEqual(h.runCalls[0].dryRun, false)

  // exit code per summary status
  const codes = { healthy: 0, 'non-trading-day': 0, repaired: 0, flagged: 0, 'dry-run': 0, 'mse-unreachable': 1, 'write-failed': 1 }
  for (const [status, code] of Object.entries(codes)) {
    h = harness({ run: async () => ({ status }) })
    assert.strictEqual(await h.exec(), code, status)
    assert.strictEqual(h.closeCalls, 1, status)
  }

  // run throws: name and code only, never the message
  const boom = Object.assign(new Error('Access denied for user secretuser@10.0.0.9'), { name: 'SequelizeAccessDeniedError', parent: { code: 'ER_ACCESS_DENIED_ERROR' } })
  h = harness({ run: async () => { throw boom } })
  assert.strictEqual(await h.exec(), 1)
  assert.deepStrictEqual(h.logs, ['run failed: SequelizeAccessDeniedError code=ER_ACCESS_DENIED_ERROR'])
  assert.ok(!h.logs.join('\n').includes('secretuser'))
  assert.strictEqual(h.closeCalls, 1)

  // err.code wins over parent.code; no code at all leaves the suffix off
  h = harness({ run: async () => { throw Object.assign(new Error('x'), { name: 'E', code: 'TOP', parent: { code: 'PARENT' } }) } })
  await h.exec()
  assert.deepStrictEqual(h.logs, ['run failed: E code=TOP'])
  h = harness({ run: async () => { throw new TypeError('x') } })
  await h.exec()
  assert.deepStrictEqual(h.logs, ['run failed: TypeError'])

  // a close error never changes the exit code
  h = harness({ closeError: new Error('close boom secretuser'), run: async () => ({ status: 'repaired' }) })
  assert.strictEqual(await h.exec(), 0)
  assert.strictEqual(h.closeCalls, 1)
  h = harness({ closeError: new Error('close boom'), run: async () => ({ status: 'write-failed' }) })
  assert.strictEqual(await h.exec(), 1)
  h = harness({ closeError: new Error('close boom'), run: async () => { throw new Error('x') } })
  assert.strictEqual(await h.exec(), 1)
  h = harness({ closeError: new Error('close boom'), env: {} })
  assert.strictEqual(await h.exec(), 2)

  // a crash sends exactly one alert mail: recipient, subject, name and code in the body, never the message
  h = harness({ run: async () => { throw boom } })
  await h.exec()
  assert.strictEqual(h.mails.length, 1)
  assert.deepStrictEqual(Object.keys(h.mails[0]).sort(), ['email', 'html', 'subject'])
  assert.strictEqual(h.mails[0].email, 'it@bdsec.mn')
  assert.strictEqual(h.mails[0].subject, 'MSE fallback: run crashed')
  assert.ok(h.mails[0].html.includes('SequelizeAccessDeniedError ER_ACCESS_DENIED_ERROR'))
  assert.ok(h.mails[0].html.includes('2026-10-12T08:20:00.000Z'))
  assert.ok(!h.mails[0].html.includes('secretuser') && !h.mails[0].html.includes('Access denied'))
  h = harness({ env: { ...CREDS, MSE_FALLBACK_ALERT_EMAIL: 'ops@example.com' }, run: async () => { throw boom } })
  await h.exec()
  assert.strictEqual(h.mails[0].email, 'ops@example.com')

  // no code: the body carries the name alone
  h = harness({ run: async () => { throw new TypeError('x') } })
  await h.exec()
  assert.ok(h.mails[0].html.includes('TypeError') && !h.mails[0].html.includes('null') && !h.mails[0].html.includes('undefined'))

  // name and code are HTML-escaped
  h = harness({ run: async () => { throw Object.assign(new Error('x'), { name: `<b>&"'`, code: '<i>' }) } })
  await h.exec()
  assert.ok(h.mails[0].html.includes('&lt;b&gt;&amp;&quot;&#39; &lt;i&gt;'))
  assert.ok(!h.mails[0].html.includes('<b>') && !h.mails[0].html.includes('<i>'))

  // no mail on a dry-run crash, on missing credentials, or when run returns a failed status
  h = harness({ argv: ['--dry-run'], run: async () => { throw boom } })
  assert.strictEqual(await h.exec(), 1)
  assert.strictEqual(h.mails.length, 0)
  h = harness({ env: {} })
  await h.exec()
  assert.strictEqual(h.mails.length, 0)
  h = harness({ run: async () => ({ status: 'mse-unreachable' }) })
  await h.exec()
  assert.strictEqual(h.mails.length, 0)

  // a failing mail never changes the exit code, never throws, and the db is still closed
  h = harness({ mailError: new Error('smtp down secretuser'), run: async () => { throw boom } })
  assert.strictEqual(await h.exec(), 1)
  assert.deepStrictEqual(h.logs, ['run failed: SequelizeAccessDeniedError code=ER_ACCESS_DENIED_ERROR', 'mail not sent'])
  assert.strictEqual(h.closeCalls, 1)
  h = harness({ mailError: new Error('smtp down'), closeError: new Error('close boom'), run: async () => { throw boom } })
  assert.strictEqual(await h.exec(), 1)

  // the real entry point, in a directory without a .env: a missing database variable exits 2 with a fixed line naming it
  const RUN = path.join(__dirname, '..', 'src', 'run.js')
  const entry = (env) => spawnSync(process.execPath, [RUN], { cwd: os.tmpdir(), env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' })
  let r = entry({ DB_USERNAME: 'user-secret', DB_DATABASE: 'db-secret', DB_TIMEZONE: '+08:00' })
  assert.strictEqual(r.status, 2)
  assert.ok(/^\S+ environment variable DB_HOST is not set\n$/.test(r.stdout), r.stdout)
  assert.ok(!/secret/.test(r.stdout + r.stderr))
  // requiring the runner prints nothing
  r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(RUN)})`], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0)
  assert.strictEqual(r.stdout + r.stderr, '')
  // database settings present, MSE login missing: nothing connects, exit 2, MSE variable named
  r = entry({ DB_HOST: 'host-secret.invalid', DB_USERNAME: 'user-secret', DB_DATABASE: 'db-secret', DB_TIMEZONE: '+08:00' })
  assert.strictEqual(r.status, 2)
  assert.ok(/MSE_API_USER/.test(r.stdout) && !/secret/.test(r.stdout + r.stderr), r.stdout + r.stderr)

  console.log('runMseHistoryFallback tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
