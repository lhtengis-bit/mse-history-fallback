// Client for MSE's official datafeed API (https://documenter.getpostman.com/view/53055331/2sBXqJM2LJ).
// Documented flow: POST {base}/login?username=..&password=.. returns a bearer token, then every endpoint is a POST
// with `Authorization: Bearer <token>`. The login comes from MSE_API_USER / MSE_API_PASS in the server environment
// only; neither the password nor the token is ever logged, returned or put in an error message.
const axios = require('axios')

const DEFAULT_BASE = 'https://tradingapi.mse.mn/api'
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }

// The login answer, as seen on 2026-10-20: { success, message, access_token, refresh_token }. The access token is NOT a
// JWT (it starts with digits), so it is taken by field name. The other names are fallbacks in case MSE changes the
// layout; a JWT-looking string anywhere in the answer is the last resort. The refresh token is not used: the
// documentation lists no refresh call, so an expired token is handled by logging in again.
function findToken(value) {
  const named = (o) => {
    if (!o || typeof o !== 'object') return null
    for (const k of ['access_token', 'accessToken', 'token']) if (typeof o[k] === 'string' && o[k]) return o[k]
    return null
  }
  if (typeof value === 'string') return value.startsWith('eyJ') ? value : null
  const direct = named(value) || named(value && value.data)
  if (direct) return direct
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const found = typeof v === 'string' ? (v.startsWith('eyJ') ? v : null) : v && typeof v === 'object' ? findToken(v) : null
      if (found) return found
    }
  }
  return null
}

function createMseFeedClient({ http = axios, env = process.env } = {}) {
  const base = env.MSE_API_BASE || DEFAULT_BASE
  const timeout = Number(env.MSE_API_TIMEOUT_MS) || 60000
  let token = null

  async function login() {
    const username = env.MSE_API_USER
    const password = env.MSE_API_PASS
    if (!username || !password) throw new Error('MSE_API_USER / MSE_API_PASS are not set')
    let res
    try {
      res = await http.post(`${base}/login`, null, {
        params: { username, password },
        headers: JSON_HEADERS,
        timeout,
        validateStatus: () => true,
      })
    } catch (err) {
      // axios errors carry the request config (and so the password): report only the code
      throw new Error(`MSE login request failed: ${err.code || 'network error'}`)
    }
    if (res.status !== 200) throw new Error(`MSE login rejected: HTTP ${res.status}`)
    if (res.data && res.data.success === false) {
      throw new Error(`MSE login rejected: ${String(res.data.message || 'success=false').slice(0, 120)}`)
    }
    token = findToken(res.data)
    if (!token) throw new Error('MSE login answered 200 but no token was found in the response')
  }

  // Returns { status, bodyText, retryAfterSeconds }: the body exactly as the server sent it. Logs in on first use and once more on a 401.
  async function call(endpoint, query = {}) {
    if (!token) await login()
    const send = () =>
      http.post(`${base}/${endpoint}`, null, {
        params: query,
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
        timeout,
        responseType: 'text',
        transformResponse: (d) => d,
        validateStatus: () => true,
      })
    let res
    try {
      res = await send()
      if (res.status === 401) {
        await login()
        res = await send()
      }
    } catch (err) {
      if (/^MSE login/.test(err.message)) throw err
      throw new Error(`MSE ${endpoint} request failed: ${err.code || 'network error'}`)
    }
    const raw = res.headers && res.headers['retry-after']
    const secs = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
    const retryAfterSeconds = Number.isFinite(secs) && secs >= 0 ? secs : null
    return { status: res.status, bodyText: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), retryAfterSeconds }
  }

  return { call, login }
}

module.exports = { createMseFeedClient, findToken }
