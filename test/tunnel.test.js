// node test/tunnel.test.js   (plain assert, fake SSH client, real local sockets)
const assert = require('assert')
const net = require('net')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const { tunnelConfig, openTunnel } = require('../src/tunnel')

const ENV = { SSH_HOST: 'prod-secret.invalid', SSH_USERNAME: 'user-secret', SSH_PASSWORD: 'pass-secret', DB_PORT: '0' }

// stands in for ssh2's Client: forwardOut hands back a stream that echoes what it is sent
function fakeClient({ failWith, forwardError } = {}) {
  return class FakeClient extends EventEmitter {
    constructor() {
      super()
      FakeClient.last = this
      this.forwards = []
      this.ended = 0
    }
    connect(opts) {
      this.opts = opts
      process.nextTick(() => (failWith ? this.emit('error', failWith) : this.emit('ready')))
    }
    forwardOut(srcIp, srcPort, dstIp, dstPort, cb) {
      this.forwards.push({ dstIp, dstPort })
      if (forwardError) return cb(new Error('refused'))
      cb(null, new PassThrough())
    }
    end() {
      this.ended++
    }
  }
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

;(async () => {
  // config: required variables are named, never their values; defaults for the SSH and remote ports
  for (const name of ['SSH_USERNAME', 'SSH_PASSWORD', 'DB_PORT']) {
    assert.throws(() => tunnelConfig({ ...ENV, [name]: '' }), (e) => e.variable === name && !/secret/.test(e.message))
  }
  assert.deepStrictEqual(tunnelConfig({ ...ENV, DB_PORT: '13306' }), { host: 'prod-secret.invalid', port: 22, username: 'user-secret', password: 'pass-secret', localPort: 13306, remotePort: 3306 })
  assert.strictEqual(tunnelConfig({ ...ENV, SSH_PORT: '2222', SSH_REMOTE_PORT: '3307' }).port, 2222)
  assert.strictEqual(tunnelConfig({ ...ENV, SSH_PORT: '2222', SSH_REMOTE_PORT: '3307' }).remotePort, 3307)

  // login with the password, listen locally, forward to production's localhost:3306, data flows both ways
  const port = await freePort()
  const Client = fakeClient()
  const tunnel = await openTunnel({ ...ENV, DB_PORT: String(port) }, { Client })
  assert.strictEqual(Client.last.opts.host, 'prod-secret.invalid')
  assert.strictEqual(Client.last.opts.username, 'user-secret')
  assert.strictEqual(Client.last.opts.password, 'pass-secret')
  const echoed = await new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write('ping'))
    c.once('data', (d) => { c.destroy(); resolve(d.toString()) })
    c.once('error', reject)
  })
  assert.strictEqual(echoed, 'ping')
  assert.deepStrictEqual(Client.last.forwards, [{ dstIp: '127.0.0.1', dstPort: 3306 }])

  // close stops the listener and ends the SSH session
  tunnel.close()
  assert.strictEqual(Client.last.ended, 1)
  await new Promise((r) => setTimeout(r, 50))
  await assert.rejects(new Promise((resolve, reject) => { const c = net.connect(port, '127.0.0.1', () => resolve()); c.once('error', reject) }))

  // a refused forward drops that one connection and nothing else
  const port2 = await freePort()
  const t2 = await openTunnel({ ...ENV, DB_PORT: String(port2) }, { Client: fakeClient({ forwardError: true }) })
  await new Promise((resolve) => { const c = net.connect(port2, '127.0.0.1'); c.once('close', resolve); c.once('error', () => {}) })
  t2.close()

  // SSH failure: name and code only, never the message, host or password; the SSH session is ended
  const bad = Object.assign(new Error('All configured authentication methods failed for user-secret@prod-secret.invalid'), { level: 'client-authentication' })
  const BadClient = fakeClient({ failWith: bad })
  await assert.rejects(openTunnel(ENV, { Client: BadClient }), (e) => {
    assert.strictEqual(e.name, 'SshTunnelError')
    assert.strictEqual(e.code, 'client-authentication')
    assert.ok(!/secret/.test(e.message))
    return true
  })
  assert.strictEqual(BadClient.last.ended, 1)

  // local port taken: same safe error
  const taken = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => taken.once('listening', r))
  await assert.rejects(openTunnel({ ...ENV, DB_PORT: String(taken.address().port) }, { Client: fakeClient() }), (e) => e.name === 'SshTunnelError' && e.code === 'EADDRINUSE')
  taken.close()

  console.log('tunnel tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
