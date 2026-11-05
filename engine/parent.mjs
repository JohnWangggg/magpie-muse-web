// The plugin starts the engine detached so it survives a plugin reload or replacement. That also
// means the engine outlives Magpie unless it watches the process that started it: the plugin passes
// MUSE_WEB_PARENT_PID, and an engine started by hand passes nothing and stays independent.

export function parentAlive(pid) {
  const n = Number(pid)
  if (!(Number.isInteger(n) && n > 0)) return true
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    // Only ESRCH proves the process is gone. A permission error or an unsupported signal must not
    // make a healthy engine exit.
    return err.code !== "ESRCH"
  }
}

export function watchParent(pid, gone, { everyMs = 10_000, alive = parentAlive } = {}) {
  const n = Number(pid)
  if (!(Number.isInteger(n) && n > 0) || n === process.pid) return null
  if (!alive(n)) {
    gone()
    return null
  }
  const timer = setInterval(() => {
    if (alive(n)) return
    clearInterval(timer)
    gone()
  }, everyMs)
  timer.unref?.()
  return timer
}
