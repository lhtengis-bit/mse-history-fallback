// node test/tables.test.js   (plain assert, no framework)
const assert = require('assert')
const { main } = require('../src/tables')

const CREDS = { MSE_API_USER: 'u-secret', MSE_API_PASS: 'p-secret' }
const NOW = new Date('2026-10-30T07:10:00Z')

function harness({ env = CREDS, argv = [], run, mailError, openTunnel } = {}) {
  const h = { logs: [], runCalls: [], closeCalls: 0, mails: [], order: [] }
  h.db = { sequelize: { close: async () => { h.closeCalls++; h.order.push('db-close') } } }
  h.sendMail = async (m) => { h.mails.push(m); if (mailError) throw mailError }
  h.run = async (args) => { h.order.push('run'); h.runCalls.push(args); return run ? run(args) : { status: 'ok', failed: [] } }
  h.exec = () => main({ db: h.db, env, log: (l) => h.logs.push(l), run: h.run, sendMail: h.sendMail, argv, now: NOW, openTunnel })
  return h
}

;(async () => {
  // missing MSE login: one fixed line, no run, exit 2, db closed
  for (const env of [{}, { MSE_API_USER: 'u-secret' }, { MSE_API_PASS: 'p-secret' }]) {
    const h = harness({ env })
    assert.strictEqual(await h.exec(), 2)
    assert.strictEqual(h.runCalls.length, 0)
    assert.ok(/MSE_API_USER/.test(h.logs[0]) && !/secret/.test(h.logs[0]))
    assert.strictEqual(h.closeCalls, 1)
  }

  // a clean run: exit 0, no mail, deps handed to run, dryRun false by default
  let h = harness()
  assert.strictEqual(await h.exec(), 0)
  assert.strictEqual(h.mails.length, 0)
  const a = h.runCalls[0]
  assert.strictEqual(a.db, h.db)
  assert.strictEqual(a.now, NOW)
  assert.strictEqual(typeof a.client.call, 'function')
  assert.strictEqual(a.dryRun, false)
  h = harness({ argv: ['--dry-run'] })
  await h.exec()
  assert.strictEqual(h.runCalls[0].dryRun, true)

  // a failed endpoint: exit 1 and one mail naming it, to the default or configured address; no mail on a dry run
  const failed = [{ endpoint: 'orderbook', status: 'mse-unreachable', reason: 'HTTP 500' }]
  h = harness({ run: async () => ({ status: 'failed', failed }) })
  assert.strictEqual(await h.exec(), 1)
  assert.strictEqual(h.mails.length, 1)
  assert.strictEqual(h.mails[0].email, 'it@bdsec.mn')
  assert.ok(/orderbook: mse-unreachable HTTP 500/.test(h.mails[0].html))
  h = harness({ env: { ...CREDS, MSE_FALLBACK_ALERT_EMAIL: 'ops@example.com' }, run: async () => ({ status: 'failed', failed }) })
  await h.exec()
  assert.strictEqual(h.mails[0].email, 'ops@example.com')
  h = harness({ argv: ['--dry-run'], run: async () => ({ status: 'failed', failed }) })
  assert.strictEqual(await h.exec(), 1)
  assert.strictEqual(h.mails.length, 0)
  h = harness({ mailError: new Error('smtp down'), run: async () => ({ status: 'failed', failed }) })
  assert.strictEqual(await h.exec(), 1)
  assert.deepStrictEqual(h.logs, ['mail not sent'])

  // a crash: name and code only, never the message; one mail; exit 1; db still closed
  h = harness({ run: async () => { throw Object.assign(new Error('boom user-secret'), { name: 'SshTunnelError', code: 'ETIMEDOUT' }) } })
  assert.strictEqual(await h.exec(), 1)
  assert.deepStrictEqual(h.logs, ['tables run failed: SshTunnelError code=ETIMEDOUT'])
  assert.strictEqual(h.mails.length, 1)
  assert.ok(!/secret|boom/.test(h.mails[0].html))
  assert.strictEqual(h.closeCalls, 1)

  // the tunnel opens before the run and closes after the database
  const order = []
  h = harness({ openTunnel: async () => { order.push('open'); return { close: () => order.push('tunnel-close') } } })
  h.db.sequelize.close = async () => { order.push('db-close') }
  h.run = async () => { order.push('run'); return { status: 'ok', failed: [] } }
  await h.exec()
  assert.deepStrictEqual(order, ['open', 'run', 'db-close', 'tunnel-close'])
  // and is closed even when the run throws
  const order2 = []
  h = harness({ openTunnel: async () => ({ close: () => order2.push('tunnel-close') }), run: async () => { throw new Error('x') } })
  assert.strictEqual(await h.exec(), 1)
  assert.deepStrictEqual(order2, ['tunnel-close'])

  console.log('tables tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
