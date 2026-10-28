// node test/mseFeedClient.retryAfter.test.js   (plain assert, no framework, no network)
// The http stub answers the login first, then the endpoint. axios lowercases header names.
const assert = require('assert')
const { createMseFeedClient } = require('../src/mseFeedClient')

const clientAnswering = (endpointAnswer) =>
  createMseFeedClient({
    http: {
      post: async (url) => {
        if (url.endsWith('/login')) return { status: 200, data: { success: true, access_token: '1|abc' } }
        return endpointAnswer
      },
    },
    env: { MSE_API_USER: 'u', MSE_API_PASS: 'p' },
  })

;(async () => {
  let r = await clientAnswering({ status: 429, data: 'slow down', headers: { 'retry-after': '90' } }).call('security_trading_history')
  assert.strictEqual(r.status, 429)
  assert.strictEqual(r.retryAfterSeconds, 90, '429 with retry-after "90" gives 90')

  r = await clientAnswering({ status: 200, data: '[1]', headers: {} }).call('security_trading_history')
  assert.strictEqual(r.retryAfterSeconds, null, 'no header gives null')

  r = await clientAnswering({ status: 200, data: '[1]' }).call('security_trading_history')
  assert.strictEqual(r.retryAfterSeconds, null, 'no headers object gives null')

  r = await clientAnswering({ status: 429, data: 'x', headers: { 'retry-after': 'soon' } }).call('security_trading_history')
  assert.strictEqual(r.retryAfterSeconds, null, 'a non-numeric header gives null')

  console.log('mseFeedClient retryAfter tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
