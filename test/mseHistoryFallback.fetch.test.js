// node test/mseHistoryFallback.fetch.test.js   (plain assert, no framework)
const assert = require('assert')
const { fetchMseLiveRows } = require('../src/mseHistoryFallback')

// A stub client that answers from a queue; an Error in the queue is thrown.
const stubClient = (...answers) => {
  const calls = []
  return { calls, call: async (endpoint, query) => { calls.push([endpoint, query]); const a = answers.shift(); if (a instanceof Error) throw a; return a } }
}
const recordingSleep = () => { const waits = []; const sleep = async ms => { waits.push(ms) }; sleep.waits = waits; return sleep }
const ok = bodyText => ({ status: 200, bodyText, retryAfterSeconds: null })

;(async () => {
  try {
    const rows = [{ symbol: 'TUM-O-0000' }, { symbol: 'APU-O-0000' }]

    // 200 with an array returns the rows, no sleep
    let client = stubClient(ok(JSON.stringify(rows))), sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: true, rows })
    assert.deepStrictEqual(client.calls, [['security_trading', undefined]])
    assert.deepStrictEqual(sleep.waits, [])

    // 429 then 200 sleeps once with (90 + 5) * 1000 and returns the rows
    client = stubClient({ status: 429, bodyText: 'slow down', retryAfterSeconds: 90 }, ok('[]')); sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: true, rows: [] })
    assert.deepStrictEqual(sleep.waits, [95000])
    assert.strictEqual(client.calls.length, 2)

    // 429 without Retry-After waits (120 + 5) * 1000
    client = stubClient({ status: 429, bodyText: '', retryAfterSeconds: null }, ok(JSON.stringify(rows))); sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: true, rows })
    assert.deepStrictEqual(sleep.waits, [125000])

    // 429 then 429 returns ok:false after exactly one retry
    client = stubClient({ status: 429, bodyText: 'secret-body', retryAfterSeconds: 10 }, { status: 429, bodyText: 'secret-body', retryAfterSeconds: 10 }, ok('[]')); sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: false, reason: 'HTTP 429' })
    assert.deepStrictEqual(sleep.waits, [15000])
    assert.strictEqual(client.calls.length, 2, 'never a third call')

    // a client that throws returns ok:false with that reason
    client = stubClient(new Error('MSE login rejected: HTTP 422')); sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: false, reason: 'MSE login rejected: HTTP 422' })
    assert.deepStrictEqual(sleep.waits, [])

    // a client that throws on the retry also returns ok:false
    client = stubClient({ status: 429, bodyText: '', retryAfterSeconds: 1 }, new Error('timeout of 30000ms exceeded')); sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: false, reason: 'timeout of 30000ms exceeded' })

    // a non-200 status returns 'HTTP <status>' and never the body
    client = stubClient({ status: 500, bodyText: 'Bearer abc123 stack trace', retryAfterSeconds: null }); sleep = recordingSleep()
    assert.deepStrictEqual(await fetchMseLiveRows(client, { sleep }), { ok: false, reason: 'HTTP 500' })
    assert.deepStrictEqual(sleep.waits, [])

    // 200 with something that is not a JSON array: exactly 'not a JSON array', never the body
    for (const body of ['<html><body>Maintenance</body></html>', '{"message":"x"}', '[{"symbol":', '', 'null', '"text"']) {
      const r = await fetchMseLiveRows(stubClient(ok(body)), { sleep: recordingSleep() })
      assert.deepStrictEqual(r, { ok: false, reason: 'not a JSON array' }, `body ${JSON.stringify(body)}`)
    }

    console.log('mseHistoryFallback fetch tests pass')
  } catch (e) { console.error(e); process.exit(1) }
})()
