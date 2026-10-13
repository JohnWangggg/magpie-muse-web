// Engine process. The plugin starts it detached with Magpie's own Bun; `node main.mjs` works too.
// Settings (all optional): MUSE_WEB_HOME, MUSE_WEB_ENGINE_PORT, MUSE_WEB_PROXY, MUSE_WEB_BROWSER
// (headless | hidden | show), MUSE_WEB_CHROME, MUSE_WEB_SITE, MUSE_WEB_IDLE_MIN.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import { findBrowser } from "./browser.mjs"
import { Logins } from "./login.mjs"
import { Muse, QuotaError } from "./muse.mjs"
import { proxiedFetch, resolveProxy } from "./net.mjs"
import { dataDir, engineKey, enginePort } from "./paths.mjs"
import { createServer, VERSION } from "./server.mjs"
import { Store } from "./store.mjs"

const env = process.env
const dir = dataDir(env)
mkdirSync(dir, { recursive: true })
const logFile = path.join(dir, "engine.log")

function log(line) {
  process.stderr.write(line + "\n")
  try {
    if (statSync(logFile, { throwIfNoEntry: false })?.size > 5 << 20) renameSync(logFile, `${logFile}.1`)
    appendFileSync(logFile, line + "\n")
  } catch {}
}

const masked = (url) => String(url).replace(/\/\/[^@/]+@/, "//***@")
const key = engineKey(dir)
const port = enginePort(env)
const site = (env.MUSE_WEB_SITE || "https://muse.ai").replace(/\/+$/, "")
const proxy = resolveProxy(env)
const fetchImpl = proxiedFetch(proxy)
const executable = findBrowser(env)
const mode = ["headless", "hidden", "show"].includes(env.MUSE_WEB_BROWSER) ? env.MUSE_WEB_BROWSER : "headless"
const idleMs = (Number(env.MUSE_WEB_IDLE_MIN) || 60) * 60_000
const prewarm = env.MUSE_WEB_PREWARM !== "0"
const verifyLogin = env.MUSE_WEB_VERIFY_LOGIN !== "0"

const store = new Store(path.join(dir, "accounts.json"))
const muse = new Muse({
  site,
  executable,
  profileDir: path.join(dir, "browser"),
  headless: mode === "headless",
  hidden: mode === "hidden",
  proxy,
  fetchImpl,
  onCookies: (id, cookies, exp, vm) => store.update(id, cookies, exp, vm),
})
const logins = new Logins({
  site,
  executable,
  dir: path.join(dir, "login"),
  proxy,
  fetchImpl,
  headless: env.MUSE_WEB_LOGIN_HEADLESS === "1", // tests only: a person has to see the sign-in window
  onDone: async (c, e, label, vm) => {
    const saved = store.add(c, e, label, vm)
    // the account's context still holds the cookies of before
    if (saved.again) await muse.closeAccount(saved.handle).catch(() => {})
    woken.set(saved.handle, Date.now())
    if (verifyLogin) {
      const t0 = Date.now()
      const at = new Date().toTimeString().slice(0, 8)
      try {
        await muse.verify(store.get(saved.handle))
        log(`${at} verify account=${saved.handle} ${Date.now() - t0}ms`)
      } catch (err) {
        log(`${at} verify account=${saved.handle} failed reason=${err.message}`)
        // a used-up account is still a working sign-in
        if (!(err instanceof QuotaError)) {
          if (!saved.again) {
            await muse.closeAccount(saved.handle).catch(() => {})
            store.remove(saved.handle)
          }
          throw new Error(`已登录，但账号没有回答测试消息：${err.message}`)
        }
      }
    }
    if (prewarm) warm([saved.handle])
    return saved
  },
})

// One account at a time, so a cold start does not open every page at once.
async function warm(handles) {
  for (const handle of handles) {
    const account = store.get(handle)
    if (!account) continue
    const t0 = Date.now()
    try {
      await muse.warm(account)
      log(`${new Date().toTimeString().slice(0, 8)} warm account=${handle} ${Date.now() - t0}ms`)
      await readUsage(account)
    } catch (err) {
      log(`${new Date().toTimeString().slice(0, 8)} warm account=${handle} failed reason=${err.message}`)
    }
  }
}

async function readUsage(account, maxAgeMs = 0) {
  const t0 = Date.now()
  const at = () => new Date().toTimeString().slice(0, 8)
  try {
    const u = await muse.readUsage(account, { maxAgeMs })
    if (u && u.at >= t0) log(`${at()} usage account=${account.id} ${Date.now() - t0}ms ${u.windows.map((w) => `${w.name}=${w.used}%`).join(" ")}`)
  } catch (err) {
    log(`${at()} usage account=${account.id} failed reason=${err.message}`)
  }
}

let lastUse = Date.now()
const server = createServer({
  muse,
  logins,
  store,
  key,
  port,
  site,
  log,
  onActivity: () => { lastUse = Date.now() },
  readUsage,
  onShutdown: () => shutdown("asked to stop"),
})

// Keep-alive as muse2api 1.6.1 has it: not a heartbeat, but a renewal and VM wake for an
// account nobody has woken for 6 hours. It is not use: the idle clock below doesn't move.
const KEEPALIVE_EVERY_MS = 6 * 3600_000
const woken = new Map(store.handles().map((h) => [h, Date.now()]))
setInterval(async () => {
  for (const handle of store.handles()) {
    const account = store.get(handle)
    if (!account || Date.now() - (woken.get(handle) || 0) < KEEPALIVE_EVERY_MS) continue
    woken.set(handle, Date.now())
    const at = new Date().toTimeString().slice(0, 8)
    try {
      const { vmState } = await muse.keepAlive(account)
      log(`${at} keepalive account=${handle} vm=${vmState || "?"}`)
    } catch (err) {
      log(`${at} keepalive account=${handle} failed reason=${err.message}`)
    }
  }
}, 30 * 60_000).unref()

// The browser is the heavy part; let it go when nobody has used the engine for a while.
setInterval(() => {
  if (muse.started && Date.now() - lastUse > idleMs) {
    log(`${new Date().toTimeString().slice(0, 8)} idle — browser closed until the next request`)
    muse.stop()
  }
}, 60_000).unref()

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    const other = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json()).catch(() => null)
    if (other?.engine === "muse-web") {
      log(`another muse-web engine already serves port ${port}; leaving it running`)
      process.exit(0)
    }
    log(`port ${port} is taken by something else; set MUSE_WEB_ENGINE_PORT`)
    process.exit(1)
  }
  log(`engine error: ${err.message}`)
  process.exit(1)
})

server.listen(port, "127.0.0.1", () => {
  log(
    `muse-web engine ${VERSION} listening on http://127.0.0.1:${port} · ${store.count()} accounts · ` +
      `browser ${executable ? `${path.basename(executable)} (${mode})` : "not found"} · proxy ${masked(proxy)} · data ${dir}`,
  )
  if (prewarm && executable) warm(store.handles())
})

async function shutdown(why) {
  log(`${new Date().toTimeString().slice(0, 8)} engine stopping (${why})`)
  logins.stopAll()
  await muse.stop().catch(() => {})
  process.exit(0)
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(sig))
