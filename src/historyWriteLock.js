// In-process lock so create() and the MSE history fallback never write _securitytradingstatus_history at the same time.
// Each caller waits for the previous holder's promise, so waiters are served in arrival order.
let tail = Promise.resolve()

const acquire = () => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  const ready = tail.then(() => () => release())
  tail = tail.then(() => held)
  return ready.then((rel) => {
    let released = false
    return () => {
      if (released) return
      released = true
      rel()
    }
  })
}

module.exports = { acquire }
