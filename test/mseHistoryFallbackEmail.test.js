// node test/mseHistoryFallbackEmail.test.js   (plain assert, no framework)
// Assertions are on numbers, dates, symbols and keys, never on wording.
const assert = require('assert')
const { buildFallbackEmail } = require('../src/mseHistoryFallbackEmail')

const base = { runDate: '2026-10-23', status: 'repaired', inserts: 7, updates: 3, anomalies: [], duplicateKeys: [], newListings: [], skippedNoTimestamp: [] }

try {
  // --- repaired: subject has the run date and both counts, HTML lists every symbol and key
  const repaired = buildFallbackEmail({
    ...base,
    updates: 4,
    anomalies: [{ key: 'APU-O-0000||Regular', stored: '100', mse: '250' }],
    duplicateKeys: ['TTL-O-0000||Regular'],
    newListings: ['NEWCO-O-0000', 'ZZZ-O-0000'],
    skippedNoTimestamp: ['NOTIME-O-0000']
  })
  assert.ok(repaired, 'repaired builds an email')
  assert.strictEqual(typeof repaired.subject, 'string')
  assert.strictEqual(typeof repaired.html, 'string')
  assert.ok(repaired.subject.includes('2026-10-23'), 'subject has the run date')
  assert.ok(repaired.subject.includes('(7 '), 'subject has the insert count right after the opening bracket')
  assert.ok(repaired.subject.includes(', 4 '), 'subject has the update count (4 does not occur in the run date)')
  assert.ok(!repaired.subject.includes(', 3 '), 'subject does not carry the old update count')
  for (const s of ['2026-10-23', 'NEWCO-O-0000', 'ZZZ-O-0000', 'APU-O-0000||Regular', 'TTL-O-0000||Regular', 'NOTIME-O-0000', '100', '250']) {
    assert.ok(repaired.html.includes(s), `html lists ${s}`)
  }

  // --- flagged: no writes, only anomalies, still an email
  const flagged = buildFallbackEmail({ ...base, status: 'flagged', inserts: 0, updates: 0, anomalies: [{ key: 'APU-O-0000||Regular', stored: '100', mse: '250' }] })
  assert.ok(flagged, 'flagged builds an email')
  assert.ok(flagged.subject.includes('2026-10-23'))
  assert.ok(flagged.html.includes('APU-O-0000||Regular'))

  // --- mse-unreachable: run date in the subject, reason in the HTML
  const down = buildFallbackEmail({ ...base, status: 'mse-unreachable', inserts: 0, updates: 0, reason: 'HTTP 503 from history call' })
  assert.ok(down, 'mse-unreachable builds an email')
  assert.ok(down.subject.includes('2026-10-23'))
  assert.ok(down.html.includes('HTTP 503 from history call'))

  // --- write-failed: run date in the subject, reason in the HTML
  const failed = buildFallbackEmail({ ...base, status: 'write-failed', inserts: 5, updates: 2, reason: 'SequelizeDatabaseError ER_NO_DEFAULT_FOR_FIELD' })
  assert.ok(failed, 'write-failed builds an email')
  assert.strictEqual(typeof failed.subject, 'string')
  assert.ok(failed.subject.includes('2026-10-23'), 'subject has the run date')
  assert.ok(failed.html.includes('2026-10-23'), 'html has the run date')
  assert.ok(failed.html.includes('SequelizeDatabaseError ER_NO_DEFAULT_FOR_FIELD'), 'html has the reason')
  assert.notStrictEqual(failed.subject, buildFallbackEmail({ ...base, status: 'mse-unreachable' }).subject, 'own subject')
  assert.notStrictEqual(failed.html, buildFallbackEmail({ ...base, status: 'flagged' }).html, 'own body')
  const evilFailed = buildFallbackEmail({ ...base, status: 'write-failed', reason: '<script>alert("x")</script>&' })
  assert.ok(!evilFailed.html.includes('<script>') && !evilFailed.subject.includes('<script>'), 'the write-failed reason is escaped')
  assert.ok(evilFailed.html.includes('&lt;script&gt;') && evilFailed.html.includes('&amp;'))
  assert.ok(buildFallbackEmail({ ...base, status: 'write-failed' }).html.length > 0, 'write-failed without a reason still builds')

  // --- healthy, non-trading-day and dry-run send nothing
  for (const status of ['healthy', 'non-trading-day', 'dry-run']) {
    assert.strictEqual(buildFallbackEmail({ ...base, status }), null, `${status} returns null`)
  }

  // --- every interpolated value is HTML-escaped
  const evil = buildFallbackEmail({
    ...base,
    newListings: ['A<b>&C'],
    duplicateKeys: ['K<i>&1'],
    skippedNoTimestamp: ['S<u>&2'],
    anomalies: [{ key: 'X<s>&Y', stored: '<1>', mse: '&2' }]
  })
  for (const raw of ['A<b>&C', 'K<i>&1', 'S<u>&2', 'X<s>&Y']) assert.ok(!evil.html.includes(raw), `${raw} is not raw in the html`)
  assert.ok(evil.html.includes('A&lt;b&gt;&amp;C'), 'a symbol with < and & appears escaped')
  assert.ok(evil.html.includes('X&lt;s&gt;&amp;Y'), 'an anomaly key is escaped')
  assert.ok(evil.html.includes('&lt;1&gt;'), 'an anomaly value is escaped')
  const evilDown = buildFallbackEmail({ ...base, status: 'mse-unreachable', reason: '<script>alert("x")</script>&' })
  assert.ok(!evilDown.html.includes('<script>'), 'the reason is escaped')
  assert.ok(evilDown.html.includes('&lt;script&gt;') && evilDown.html.includes('&amp;'))

  // --- non-numeric counts are coerced to 0, never interpolated raw (subject and html)
  for (const status of ['repaired', 'flagged']) {
    const bad = buildFallbackEmail({ ...base, status, inserts: '<img src=x>', updates: NaN })
    assert.ok(!bad.subject.includes('<img'), status + ' subject has no raw <img')
    assert.ok(!bad.html.includes('<img'), status + ' html has no raw <img')
    assert.ok(bad.subject.includes('(0 ') && bad.subject.includes(', 0 '), status + ' subject shows 0 for both counts')
    assert.strictEqual(bad.html.split('<strong>0</strong>').length - 1, 2, status + ' html shows 0 for both counts')
  }

  // --- mse-unreachable without a reason still builds
  assert.ok(buildFallbackEmail({ ...base, status: 'mse-unreachable' }).html.length > 0)

  console.log('mseHistoryFallbackEmail tests pass')
} catch (e) { console.error(e); process.exit(1) }
