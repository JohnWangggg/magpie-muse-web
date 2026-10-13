import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dataDir, enginePort } from "./engine/paths.mjs"
import { VERSION } from "./engine/version.mjs"

const PROVIDER = "muse-web"
const MODEL = "muse-spark"
const CONTROL_TIMEOUT_MS = 10_000
const ENGINE_START_MS = 20_000
// the engine's 15 minutes to sign in, then the test message it sends to the new account
const LOGIN_LIMIT_MS = 18 * 60_000
const REFRESH_LEAD_MS = 10 * 60_000
// muse.ai names no limits. These are what one web prompt comfortably holds, so clients
// compact long conversations before the page has to take them.
const CONTEXT_TOKENS = 128_000
const OUTPUT_TOKENS = 16_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_MAIN = path.join(HERE, "engine", "main.mjs")
const ICON = (() => {
  try {
    return `data:image/svg+xml;base64,${readFileSync(path.join(HERE, "icon.svg")).toString("base64")}`
  } catch {
    return ""
  }
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// An engine at least as new as this plugin is kept: a Magpie that has not reloaded the plugin
// yet must not keep replacing the engine a newer copy of the plugin started.
function current(version) {
  if (!version) return false
  const a = version.split(".").map(Number)
  const b = VERSION.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return true
}

function originFrom(value) {
  return String(value).trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function isOurs(input) {
  const id = input?.model?.providerID || input?.provider?.info?.id || input?.message?.model?.providerID || ""
  return id === PROVIDER || id === `${PROVIDER}-plugin`
}

function handleOf(auth) {
  const value = auth?.type === "api" ? auth.key : auth?.type === "oauth" ? auth.refresh || auth.access : ""
  return typeof value === "string" ? value.trim() : ""
}

function engineHeaders(key, handle) {
  const headers = {}
  if (handle) headers["x-muse-account"] = handle
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

function structured(windows) {
  return Array.isArray(windows) && windows.length > 0 && windows.every((item) => {
    return item && typeof item.name === "string" && item.name.trim() !== "" && typeof item.used === "number" && item.used >= 0 && item.used <= 100
  })
}

export const MuseWebPlugin = async (_input, options) => {
  const opt = options && typeof options === "object" ? options : {}
  // An engine named in options or MUSE_WEB_ENGINE is run by someone else; otherwise the plugin runs its own.
  const external = () => Boolean(opt.engine || process.env.MUSE_WEB_ENGINE)
  const engineOrigin = () => originFrom(opt.engine || process.env.MUSE_WEB_ENGINE || `http://127.0.0.1:${enginePort()}`)
  const engineBaseURL = () => `${engineOrigin()}/v1`
  const engineKey = () => {
    const own = String(opt.key ?? process.env.MUSE_WEB_ENGINE_KEY ?? "").trim()
    if (own || external()) return own
    const file = path.join(dataDir(), "engine.key")
    return existsSync(file) ? readFileSync(file, "utf8").trim() : ""
  }

  // The running engine's version, or "" when nothing of ours answers.
  async function running() {
    try {
      const res = await fetch(`${engineOrigin()}/v1/health`, { signal: AbortSignal.timeout(1500) })
      const body = res.ok ? await res.json() : null
      return body?.engine === "muse-web" ? String(body.version || "?") : ""
    } catch {
      return ""
    }
  }

  async function retire() {
    await fetch(`${engineOrigin()}/v1/shutdown`, {
      method: "POST",
      headers: engineHeaders(engineKey(), ""),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch(() => {})
    const end = Date.now() + 8000
    while (Date.now() < end && (await running())) await sleep(250)
  }

  let starting = null
  let checkedAt = 0
  // Makes sure the bundled engine answers, starting it with this runtime (Magpie's Bun) if needed.
  function ensureEngine({ force = false } = {}) {
    if (external()) return Promise.resolve(true)
    if (!force && Date.now() - checkedAt < 30_000) return Promise.resolve(true)
    starting ??= (async () => {
      const version = await running()
      if (current(version)) return true
      // An engine left from an older plugin version is replaced; same data dir, same accounts.
      if (version) await retire()
      const child = spawn(process.execPath, [ENGINE_MAIN], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
      })
      child.on("error", () => {})
      child.unref()
      const end = Date.now() + ENGINE_START_MS
      while (Date.now() < end) {
        await sleep(300)
        if (current(await running())) return true
      }
      return false
    })().then((ok) => {
      if (ok) checkedAt = Date.now()
      starting = null
      return ok
    })
    return starting
  }

  // Returns null when the engine is down or silent, so callers never mistake that for a refused sign-in.
  async function control(pathname, method, handle) {
    if (!(await ensureEngine())) return null
    try {
      return await fetch(`${engineOrigin()}${pathname}`, {
        method,
        headers: engineHeaders(engineKey(), handle),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
    } catch {
      checkedAt = 0
      return null
    }
  }

  async function browserLogin() {
    const res = await control("/v1/login", "POST", "")
    if (!res?.ok) throw new Error(res ? `muse-web 引擎没能开始登录（HTTP ${res.status}）` : "muse-web 引擎没有启动；日志在数据目录的 engine.log")
    const { id, url } = await res.json()
    return {
      url,
      instructions: "在弹出的浏览器窗口里登录 muse.ai。登录后窗口会自动关闭，引擎再发一条测试消息，账号能回答才算登录成功。",
      method: "auto",
      async callback() {
        const end = Date.now() + LOGIN_LIMIT_MS
        while (Date.now() < end) {
          await sleep(1500)
          const poll = await control(`/v1/login/${id}`, "GET", "")
          if (!poll) continue
          if (!poll.ok) return { type: "failed", error: `muse-web 登录状态读不到（HTTP ${poll.status}）` }
          const state = await poll.json()
          if (state.status === "done") {
            const expires = Number.isFinite(state.expires) ? state.expires : Date.now() + 86_400_000
            return {
              type: "success",
              refresh: state.handle,
              access: state.handle,
              expires,
              ...(state.label ? { accountId: state.label } : {}),
              ...(state.label?.includes("@") ? { email: state.label } : {}),
            }
          }
          if (state.status === "failed") return { type: "failed", error: `muse.ai 登录：${state.error || "没有完成"}` }
        }
        return { type: "failed", error: "muse.ai 登录：没有在时限内完成" }
      },
    }
  }

  // Start (and so pre-warm) the engine as soon as Magpie loads the plugin, not at the first message.
  if (!external()) ensureEngine().catch(() => {})

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Muse Web",
        npm: "@ai-sdk/openai-compatible",
        api: engineBaseURL(),
        ...was,
        models: {
          // Text in, text out through the web chat; images and files never reach the page.
          // Tools are told in the prompt and the model's <tool_call> tags come back as tool calls.
          [MODEL]: {
            name: "Muse Spark",
            reasoning: false,
            attachment: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
          ...(was.models ?? {}),
        },
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      ...(ICON ? { icon: ICON } : {}),
      // magpie renews the sign-in this long before it ends, through refresh() below
      refreshLead: REFRESH_LEAD_MS,
      methods: [
        { type: "oauth", label: "muse.ai（浏览器登录）", authorize: browserLogin },
        { type: "api", label: "引擎账号 ID（高级：配合自己运行的引擎）", placeholder: "muse-xxxxxxxxxxxx" },
      ],
      async refresh(auth) {
        const handle = handleOf(auth)
        if (!handle) throw Object.assign(new Error("muse-web account has no engine handle"), { signIn: "expired" })
        const res = await control("/v1/session/refresh", "POST", handle)
        if (!res) throw new Error("engine unreachable")
        if (res.status === 401) throw Object.assign(new Error("session refused"), { signIn: "expired" })
        if (!res.ok) throw new Error("session refresh unavailable")
        const body = await res.json()
        if (typeof body.expires !== "number" || !Number.isFinite(body.expires)) {
          throw new Error("session refresh returned no expiry")
        }
        return auth?.type === "oauth" ? { access: handle, refresh: handle, expires: body.expires } : { expires: body.expires }
      },
      async usage(getAuth) {
        const handle = handleOf(await getAuth())
        if (!handle) return { error: "muse-web account has no engine handle", signIn: "expired" }
        const res = await control("/v1/usage", "GET", handle)
        if (!res) return { error: "engine unreachable" }
        if (res.status === 401) return { error: "session refused", signIn: "expired" }
        let body = {}
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        if (!res.ok) return { error: "usage unavailable" }
        const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")
        const card = {
          ...(text(body.plan) ? { plan: text(body.plan) } : {}),
          ...(text(body.user) ? { user: text(body.user) } : {}),
          ...(text(body.until) ? { until: text(body.until) } : {}),
        }
        if (structured(body.windows)) return { ...card, windows: body.windows, signIn: "kept" }
        // No quota to show is not an error when the engine described the account.
        if (card.plan) return { ...card, windows: [], signIn: "kept" }
        return { error: text(body.error) || "no structured quota" }
      },
      async loader(getAuth) {
        return {
          baseURL: engineBaseURL(),
          async fetch(input, init) {
            const auth = await getAuth()
            const handle = handleOf(auth)
            if (!handle) throw Object.assign(new Error("muse-web account has no engine handle"), { signIn: "expired" })
            const incoming = new Headers(init?.headers)
            const send = async () => {
              await ensureEngine()
              const headers = new Headers(engineHeaders(engineKey(), handle))
              for (const name of ["content-type", "accept", "x-muse-session"]) {
                const value = incoming.get(name)
                if (value) headers.set(name, value)
              }
              return fetch(input, { method: init?.method, headers, body: init?.body, signal: init?.signal })
            }
            let res
            try {
              res = await send()
            } catch (err) {
              // The engine may have been stopped or crashed since the last check; start it and try once more.
              if (external() || init?.signal?.aborted || !(await ensureEngine({ force: true }))) throw err
              res = await send()
            }
            const out = new Headers(res.headers)
            out.delete("content-length")
            if (res.status === 401) out.set("x-magpie-sign-in", "expired")
            else if (res.ok) out.set("x-magpie-sign-in", "kept")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },
    },

    "chat.headers": async (input, output) => {
      if (!isOurs(input)) return
      if (input.sessionID) output.headers["x-muse-session"] = input.sessionID
    },
  }
}
