// Loopback HTTP surface of the engine. Same contract as the Python engine:
// chat SSE · 401 sign-in expired · 429 account busy · 503 engine trouble.
import http from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { AuthError, expiryMs, QuotaError, renewSession } from "./muse.mjs"
import { buildPrompt, PromptError } from "./prompt.mjs"
import { functions, parseToolCalls, stripLabels, TOOLS_REMINDER, toolsPrompt } from "./tools.mjs"

import { VERSION } from "./version.mjs"

export { VERSION }
const MODEL = "muse-spark"
const USAGE_STALE_MS = 30 * 60_000
const USAGE_AFTER_CHAT_MS = 2 * 60_000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function same(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) })
  res.end(data)
}

function fail(res, status, message) {
  json(res, status, { error: { message, type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "engine_error" } })
}

async function body(req, limit = 8 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, "request too large")
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

function loginPage(state) {
  const done = state?.status === "done"
  const failed = state?.status === "failed" || !state
  const title = done ? "登录完成" : failed ? "登录没有完成" : "等待你在弹出的浏览器窗口里登录 muse.ai"
  const note = done
    ? "可以关掉这个页面，回到 Magpie。"
    : failed
      ? esc(state?.error || "找不到这次登录，请回到 Magpie 重新发起。")
      : `${esc(state.step || "")}${state.note ? `（上一次出错：${esc(state.note)}）` : ""}。登录成功后窗口会自动关闭，这里也会自动更新。`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>muse-web 登录</title>
${done || failed ? "" : '<meta http-equiv="refresh" content="2">'}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:30rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}
p{margin:0;opacity:.75}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.5rem;vertical-align:middle;background:${done ? "#2f9e44" : failed ? "#e03131" : "#f59f00"}}
</style></head><body><main><h1><span class="dot"></span>${title}</h1><p>${note}</p></main></body></html>`
}

export function createServer({ muse, logins, store, key, port = 18611, log = () => {}, onActivity = () => {}, onShutdown = () => {}, readUsage = (a, maxAgeMs) => muse.readUsage(a, { maxAgeMs }).catch(() => null), site = muse?.site }) {
  const busy = new Set()

  function authorize(req) {
    const header = String(req.headers.authorization || "")
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!token || !same(token, key)) throw new HttpError(401, "bad engine key")
  }

  function account(req) {
    const id = String(req.headers["x-muse-account"] || "").trim()
    if (!id) throw new HttpError(400, "missing X-Muse-Account")
    const item = store.get(id)
    if (!item) throw new HttpError(401, "unknown account; sign in again")
    return item
  }

  async function chat(req, res, meta) {
    const payload = await body(req)
    const acct = account(req)
    meta.account = acct.id
    let prompt
    try {
      prompt = buildPrompt(payload.messages)
    } catch (err) {
      if (err instanceof PromptError) throw new HttpError(400, err.message)
      throw err
    }
    const toolNote = toolsPrompt(payload.tools, payload.tool_choice)
    if (toolNote) prompt = { ...prompt, full: `${prompt.full}\n\n${toolNote}`, last: prompt.last && `${prompt.last}\n\n${TOOLS_REMINDER}` }
    if (busy.has(acct.id)) throw new HttpError(429, "account busy")
    busy.add(acct.id)
    const session = String(req.headers["x-muse-session"] || "").trim()
    meta.session = session
    // Each conversation has its own tab; the engine knows whether that tab already holds it.
    const continuing = !!(session && prompt.turns > 1)
    const timing = {}
    const stream = payload.stream !== false
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const ac = new AbortController()
    res.on("close", () => { if (!res.writableFinished) ac.abort() })
    let started = false
    let text = ""
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const begin = () => {
      if (started) return
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
      res.write(chunk({ role: "assistant", content: "" }))
      started = true
    }
    // With tools, text goes out a whole line at a time, code block labels left out, and from the
    // first "<", "{" or "`" on it is held back: that may open a tool call.
    let shown = ""
    let holding = false
    let pending = ""
    try {
      for await (const delta of muse.chat(acct, prompt, { conversation: session, continuing, signal: ac.signal, timing })) {
        text += delta
        if (!stream || holding) continue
        let piece = delta
        if (toolNote) {
          pending += delta
          const at = pending.search(/[<{`]/)
          if (at !== -1) {
            piece = pending.slice(0, at)
            holding = true
          } else {
            const nl = pending.lastIndexOf("\n")
            if (nl === -1) continue
            piece = pending.slice(0, nl + 1)
            pending = pending.slice(nl + 1)
          }
          piece = stripLabels(piece)
        }
        if (!piece) continue
        begin()
        res.write(chunk({ content: piece }))
        shown += piece
      }
      const whole = timing.text || text
      const { calls, content } = toolNote ? parseToolCalls(whole, payload.tools) : { calls: [], content: whole }
      const toolCalls = calls.map((c) => ({ id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`, type: "function", function: c }))
      const finish = toolCalls.length ? "tool_calls" : "stop"
      if (toolNote) meta.tools = `${functions(payload.tools).length}→${toolCalls.map((c) => c.function.name).join(",") || "text"}`
      if (!stream) {
        const message = { role: "assistant", content: toolCalls.length ? content || null : whole }
        if (toolCalls.length) message.tool_calls = toolCalls
        json(res, 200, { id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message, finish_reason: finish }] })
        return
      }
      begin()
      // what is left of the text: past what streamed, when the final text still begins with it
      const rest = toolNote ? stripLabels(toolCalls.length ? content : whole) : whole
      const more = rest.startsWith(shown) ? rest.slice(shown.length) : ""
      if (more) res.write(chunk({ content: more }))
      toolCalls.forEach((c, index) => {
        res.write(chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] }))
        res.write(chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] }))
      })
      res.write(chunk({}, finish))
      res.end("data: [DONE]\n\n")
    } catch (err) {
      await muse.closeTab(acct.id, session).catch(() => {})
      if (err instanceof AuthError) throw new HttpError(401, err.message)
      if (err instanceof QuotaError) {
        setTimeout(() => readUsage(acct, 0), 1500).unref?.()
        throw new HttpError(429, err.message)
      }
      if (!started) throw new HttpError(503, err.message || "engine unavailable")
      meta.reason = err.message
      res.end(`data: ${JSON.stringify({ error: { message: err.message, type: "engine_error" } })}\n\n`)
    } finally {
      busy.delete(acct.id)
      // what the answer spent shows on the card soon after, read at most every 2 minutes
      if (!ac.signal.aborted) setTimeout(() => readUsage(acct, USAGE_AFTER_CHAT_MS), 1500).unref?.()
      meta.timing = [
        timing.how && `tab=${timing.how}`,
        timing.sent && `sent=${timing.sent}`,
        timing.tabMs != null && `page=${timing.tabMs}ms`,
        timing.firstMs != null && `first=${timing.firstMs}ms`,
      ].filter(Boolean).join(" ")
    }
  }

  async function refresh(req, res, meta) {
    const acct = account(req)
    meta.account = acct.id
    try {
      const renewed = await renewSession(site, acct.cookies, acct.cookies_exp, { fetchImpl: muse.fetchImpl, wakeVm: false })
      store.update(acct.id, renewed.cookies, renewed.cookies_exp)
      json(res, 200, { expires: expiryMs(renewed.cookies_exp) })
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, err.message)
      throw new HttpError(503, err.message)
    }
  }

  const routes = {
    "GET /v1/health": (req, res) => json(res, 200, { ok: true, engine: "muse-web", version: VERSION, accounts: store.count() }),
    "GET /v1/models": (req, res) => {
      authorize(req)
      json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "muse.ai" }] })
    },
    "POST /v1/chat/completions": async (req, res, meta) => {
      authorize(req)
      await chat(req, res, meta)
    },
    "POST /v1/session/refresh": async (req, res, meta) => {
      authorize(req)
      await refresh(req, res, meta)
    },
    // The account's meters as muse.ai's settings page shows them, read in its browser context;
    // the plan line also says whether the next message is quick (page ready) or has to wake it.
    // A reading older than USAGE_STALE_MS is renewed: waited for when there is none yet.
    "GET /v1/usage": async (req, res, meta) => {
      authorize(req)
      const acct = account(req)
      meta.account = acct.id
      let u = muse.usageOf(acct.id)
      const { ready } = muse.state(acct.id)
      if (ready && !busy.has(acct.id) && (!u || Date.now() - u.at > USAGE_STALE_MS)) {
        const reading = readUsage(acct, USAGE_STALE_MS)
        // under the plugin's 10 s for an engine call; a slower reading shows on the next ask
        if (!u) u = await Promise.race([reading, new Promise((r) => setTimeout(r, 8000))]) || muse.usageOf(acct.id)
      }
      const status = busy.has(acct.id) ? "正在回答" : ready ? "已就绪" : "闲置，下一条约需 30 秒唤醒"
      const expires = expiryMs(acct.cookies_exp)
      json(res, 200, {
        plan: `${u?.plan || "muse.ai"} · ${status}`,
        windows: u?.windows || [],
        ...(acct.label ? { user: acct.label } : {}),
        ...(expires ? { until: new Date(expires).toISOString() } : {}),
      })
    },
    "POST /v1/shutdown": (req, res) => {
      authorize(req)
      json(res, 200, { ok: true })
      res.once("finish", () => onShutdown())
    },
    "POST /v1/login": async (req, res) => {
      authorize(req)
      const id = await logins.start()
      json(res, 200, { id, url: `http://127.0.0.1:${port}/login/${id}` })
    },
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    onActivity()
    const url = new URL(req.url, "http://127.0.0.1")
    const meta = { account: "", session: "", reason: "", timing: "" }
    try {
      const route = routes[`${req.method} ${url.pathname}`]
      let m
      if (route) await route(req, res, meta)
      else if (req.method === "GET" && (m = url.pathname.match(/^\/v1\/login\/([\w-]+)$/))) {
        authorize(req)
        const state = logins.status(m[1])
        if (!state) throw new HttpError(404, "no such login")
        json(res, 200, state)
      } else if (req.method === "GET" && (m = url.pathname.match(/^\/login\/([\w-]+)$/))) {
        const html = loginPage(logins.status(m[1]))
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(html)
      } else throw new HttpError(404, "not found")
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      meta.reason = err.message
      if (!res.headersSent) fail(res, status, err.message)
      else res.end()
    } finally {
      onActivity()
      const at = new Date().toTimeString().slice(0, 8)
      const who = meta.account ? ` account=${meta.account}` : ""
      const ses = meta.session ? ` session=${meta.session.slice(0, 12)}` : ""
      log(`${at} ${res.statusCode} ${req.method} ${url.pathname}${who}${ses} ${Date.now() - t0}ms${meta.timing ? ` ${meta.timing}` : ""}${meta.tools ? ` tools=${meta.tools}` : ""}${meta.reason ? ` reason=${meta.reason}` : ""}`)
    }
  })
  server.requestTimeout = 0
  server.headersTimeout = 30_000
  return server
}
