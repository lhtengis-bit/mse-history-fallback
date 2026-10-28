// node test/historyWriteLock.test.js   (plain assert, no framework)
const assert = require('assert')
const { acquire } = require('../src/historyWriteLock')

const tick = () => new Promise((resolve) => setImmediate(resolve))

;(async () => {
  // --- second acquirer waits until the first releases
  {
    const order = []
    const releaseFirst = await acquire()
    order.push('first')
    const second = acquire().then((release) => { order.push('second'); return release })
    await tick()
    await tick()
    assert.deepStrictEqual(order, ['first'], 'second must not enter while the first holds the lock')
    releaseFirst()
    const releaseSecond = await second
    assert.deepStrictEqual(order, ['first', 'second'], 'second enters only after release()')
    releaseSecond()
  }

  // --- three waiters are served in arrival order
  {
    const order = []
    const releaseHolder = await acquire()
    const waiters = [1, 2, 3].map((n) => acquire().then((release) => { order.push(n); release() }))
    await tick()
    assert.deepStrictEqual(order, [], 'nobody enters while the holder has the lock')
    releaseHolder()
    await Promise.all(waiters)
    assert.deepStrictEqual(order, [1, 2, 3], 'waiters are served in arrival order')
  }

  // --- a holder that throws still releases in try/finally, so the next waiter proceeds
  {
    const order = []
    const failing = (async () => {
      const release = await acquire()
      try {
        order.push('failing')
        throw new Error('boom')
      } finally {
        release()
      }
    })()
    const next = acquire().then((release) => { order.push('next'); release() })
    await assert.rejects(() => failing, /boom/)
    await next
    assert.deepStrictEqual(order, ['failing', 'next'], 'the next waiter proceeds after a holder throws')
  }

  // --- releasing twice does not let a later waiter in early
  {
    const order = []
    const releaseA = await acquire()
    const b = acquire().then((release) => { order.push('b'); return release })
    const c = acquire().then((release) => { order.push('c'); return release })
    releaseA()
    const releaseB = await b
    releaseA() // second call must be a no-op
    await tick()
    await tick()
    assert.deepStrictEqual(order, ['b'], 'c must not enter while b holds the lock, even after a double release of a')
    releaseB()
    const releaseC = await c
    assert.deepStrictEqual(order, ['b', 'c'])
    releaseC()
  }

  console.log('historyWriteLock tests pass')
})().catch((e) => { console.error(e); process.exit(1) })
