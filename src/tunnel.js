// SSH tunnel to the production MySQL, the same idea as MySQL Workbench's "Standard TCP/IP over SSH": log in to
// production over SSH with a password and listen on 127.0.0.1:DB_PORT here, forwarding to MySQL on production's own localhost.
// Used only when SSH_HOST is set; then DB_HOST must be 127.0.0.1 and DB_PORT a free local port. Errors carry a name and a code, never
// a message (it can hold the host and user).
const net = require('net')

function tunnelConfig(env) {
  for (const name of ['SSH_USERNAME', 'SSH_PASSWORD', 'DB_PORT']) {
    // name only: a value must never reach a log
    if (!env[name]) throw Object.assign(new Error(`environment variable ${name} is not set`), { variable: name })
  }
  return {
    host: env.SSH_HOST,
    port: Number(env.SSH_PORT || 22),
    username: env.SSH_USERNAME,
    password: env.SSH_PASSWORD,
    localPort: Number(env.DB_PORT),
    remotePort: Number(env.SSH_REMOTE_PORT || 3306),
  }
}

// Resolves { close } once the SSH login worked and the local port is listening.
function openTunnel(env, { Client = require('ssh2').Client } = {}) {
  const cfg = tunnelConfig(env)
  return new Promise((resolve, reject) => {
    const client = new Client()
    const fail = (err) => {
      client.end()
      reject(Object.assign(new Error('ssh tunnel failed'), { name: 'SshTunnelError', code: err && (err.level || err.code) }))
    }
    client.once('error', fail)
    client.once('ready', () => {
      client.removeListener('error', fail)
      client.on('error', () => {}) // a drop after this point surfaces as a database connection error
      const server = net.createServer((socket) => {
        client.forwardOut('127.0.0.1', socket.remotePort, '127.0.0.1', cfg.remotePort, (err, stream) => {
          if (err) return socket.destroy()
          stream.on('error', () => socket.destroy())
          socket.on('error', () => stream.destroy())
          socket.pipe(stream).pipe(socket)
        })
      })
      server.once('error', fail)
      server.listen(cfg.localPort, '127.0.0.1', () => {
        server.removeListener('error', fail)
        resolve({
          close: () => {
            server.close()
            client.end()
          },
        })
      })
    })
    client.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 20000, keepaliveInterval: 15000 })
  })
}

module.exports = { tunnelConfig, openTunnel }
