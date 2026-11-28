// Connector edition: talk to a muse-web engine you run yourself. This package never starts a
// browser, never reads cookie files and never spawns a process; it only speaks HTTP to
// MUSE_WEB_ENGINE (or the `engine` option). Use the full magpie-muse-web package when you want
// the bundled engine.
const PROVIDER = "muse-web"
const MODEL = "muse-spark"
const CONTROL_TIMEOUT_MS = 10_000
const LOGIN_LIMIT_MS = 18 * 60_000
const REFRESH_LEAD_MS = 10 * 60_000
const CONTEXT_TOKENS = 128_000
const OUTPUT_TOKENS = 16_000
const DEFAULT_ENGINE = "http://127.0.0.1:18611"
const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNkQ1QkZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRTI1NDlBIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTUiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNMTQgNDdWMjFsMTIuNSAxNUwzOSAyMXYyNiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHBhdGggZD0iTTQ5LjUgOS41bDIuMyA2LjIgNi4yIDIuMy02LjIgMi4zLTIuMyA2LjItMi4zLTYuMi02LjItMi4zIDYuMi0yLjN6IiBmaWxsPSIjZmZmIi8+PC9zdmc+"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function originFrom(value) {
  return String(value).trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

// A loopback address is this machine; anything else must be https, so the engine key and the
// account handle never cross a network in the clear. One engine shared by several machines is a
// pool of web accounts behind one key, which is why the documented setup keeps it on loopback.
function checkedOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    throw new Error(`引擎地址不是有效的 URL：${origin}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const local = host === "localhost" || host === "::1" || /^127\./.test(host)
  if (!local && url.protocol !== "https:") {
    throw new Error(`引擎地址必须是本机回环（127.0.0.1 / localhost），或者用 https://；不向 ${origin} 明文发送 engine key 和账号句柄`)
  }
  return origin
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
  if (!Array.isArray(windows)) return []
  return windows.filter((item) => {
    return item && typeof item.name === "string" && item.name.trim() !== "" && typeof item.used === "number" && item.used >= 0 && item.used <= 100
  })
}

export const MuseWebConnectorPlugin = async (_input, options) => {
  const opt = options && typeof options === "object" ? options : {}
  const engineOrigin = () => checkedOrigin(originFrom(opt.engine || process.env.MUSE_WEB_ENGINE || DEFAULT_ENGINE))
  const engineBaseURL = () => `${engineOrigin()}/v1`
  const engineKey = () => String(opt.key ?? process.env.MUSE_WEB_ENGINE_KEY ?? "").trim()

  async function control(pathname, method, handle) {
    const origin = engineOrigin()
    try {
      return await fetch(`${origin}${pathname}`, {
        method,
        headers: engineHeaders(engineKey(), handle),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
    } catch {
      return null
    }
  }

  function unreachable() {
    return new Error(`muse-web 引擎没有响应（${engineOrigin()}）。先启动引擎，并设置 MUSE_WEB_ENGINE / MUSE_WEB_ENGINE_KEY。`)
  }

  async function engineLogin() {
    const res = await control("/v1/login", "POST", "")
    if (!res?.ok) throw res ? new Error(`muse-web 引擎没有开始登录（HTTP ${res.status}）`) : unreachable()
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
      refreshLead: REFRESH_LEAD_MS,
      methods: [
        { type: "oauth", label: "在已运行的引擎里登录 muse.ai", authorize: engineLogin },
        { type: "api", label: "引擎账号 ID（GET /v1/accounts 里的 id）", placeholder: "muse-xxxxxxxxxxxx" },
      ],
      async refresh(auth) {
        const handle = handleOf(auth)
        if (!handle) throw Object.assign(new Error("muse-web account has no engine handle"), { signIn: "expired" })
        const res = await control("/v1/session/refresh", "POST", handle)
        if (!res) throw unreachable()
        if (res.status === 401) throw Object.assign(new Error("session refused"), { signIn: "expired" })
        if (!res.ok) throw new Error("session refresh unavailable")
        const body = await res.json()
        const expires = Number.isFinite(body.expires)
          ? body.expires
          : Number.isFinite(auth?.expires) && auth.expires > Date.now()
            ? auth.expires
            : Date.now() + 86_400_000
        return auth?.type === "oauth" ? { access: handle, refresh: handle, expires } : { expires }
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
        const windows = structured(body.windows)
        if (windows.length) return { ...card, windows, signIn: "kept" }
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
            const headers = new Headers(engineHeaders(engineKey(), handle))
            for (const name of ["content-type", "accept", "x-muse-session"]) {
              const value = incoming.get(name)
              if (value) headers.set(name, value)
            }
            try {
              return await fetch(input, { method: init?.method, headers, body: init?.body, signal: init?.signal })
            } catch {
              throw unreachable()
            }
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

export const MuseWebPlugin = MuseWebConnectorPlugin
