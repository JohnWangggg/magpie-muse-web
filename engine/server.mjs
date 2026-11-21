// Loopback HTTP surface of the engine. Same contract as the Python engine:
// chat SSE · 401 sign-in expired · 429 account busy · 503 engine trouble.
import http from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { AuthError, expiryMs, PromptTooLongError, QuotaError, redact, renewSession } from "./muse.mjs"
import { buildPrompt, PromptError } from "./prompt.mjs"
import { functions, parseToolCalls, stripLabels, TOOLS_REMINDER, toolChoiceRequired, toolsPrompt } from "./tools.mjs"

import { VERSION } from "./version.mjs"

export { VERSION }
const MODEL = "muse-spark"
const USAGE_STALE_MS = 30 * 60_000
const USAGE_AFTER_CHAT_MS = 2 * 60_000

class HttpError extends Error {
  constructor(status, message, code = "", retryAfter = 0) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
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

function fail(res, status, message, { code = "", retryAfter = 0 } = {}) {
  const type = status === 401 ? "authentication_error"
    : status === 429 ? "rate_limit_error"
    : status >= 400 && status < 500 ? "invalid_request_error"
    : "engine_error"
  const data = JSON.stringify({ error: { message: redact(message), type, ...(code ? { code } : {}) } })
  const headers = { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) }
  if (retryAfter > 0) headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfter)))
  res.writeHead(status, headers)
  res.end(data)
}

// A GenerationError's message is the only thing the page gave us; turn it into a code the
// gateway and the agent can act on (retry now, wait for the VM, or re-sign-in).
function generationCode(err) {
  const text = String(err?.message || "")
  if (/预热|warming/i.test(text)) return ["vm_warming", 10]
  if (/页面|page|加载/i.test(text)) return ["page_unavailable", 10]
  if (/超时|timeout/i.test(text)) return ["upstream_timeout", 5]
  if (/没有发出去|send/i.test(text)) return ["send_failed", 2]
  return ["engine_unavailable", 5]
}

async function body(req, limit = 8 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, "request too large", "request_too_large")
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid JSON body", "invalid_json")
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

function loginPage(state) {
  const done = state?.status === "done"
  const failed = state?.status === "failed" || !state
  const title = done ? "登录完成" : failed ? "登录没有完成" : "请到另一个浏览器窗口登录 muse.ai"
  const note = done
    ? "可以关掉这个页面，回到 Magpie。"
    : failed
      ? esc(state?.error || "找不到这次登录，请回到 Magpie 重新发起。")
      : `这个页面只显示进度，这里不能登录。请在引擎另外打开的 Chrome、Edge、Chromium 或 Brave 窗口里完成登录。${esc(state.step || "")}${state.note ? `（上一次出错：${esc(state.note)}）` : ""}。登录成功后那个窗口会自动关闭，这个页面也会更新。`
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
    if (!token || !same(token, key)) throw new HttpError(401, "bad engine key", "engine_key_invalid")
  }

  function account(req) {
    const id = String(req.headers["x-muse-account"] || "").trim()
    if (!id) throw new HttpError(400, "missing X-Muse-Account", "account_missing")
    const item = store.get(id)
    if (!item) throw new HttpError(401, "unknown account; sign in again", "account_unknown")
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
      if (err instanceof PromptError) throw new HttpError(400, err.message, "invalid_request")
      throw err
    }
    const toolNote = toolsPrompt(payload.tools, payload.tool_choice)
    const requiredTool = toolChoiceRequired(payload.tools, payload.tool_choice)
    if (toolNote) prompt = { ...prompt, full: `${prompt.full}\n\n${toolNote}`, last: prompt.last && `${prompt.last}\n\n${TOOLS_REMINDER}` }
    if (busy.has(acct.id)) throw new HttpError(429, "account busy", "account_busy", 1)
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
    // A required tool must be parsed before any text goes out; otherwise the client would see a
    // normal answer and never learn that the tool was expected.
    let holding = !!requiredTool
    let pending = ""
    try {
      for await (const delta of muse.chat(acct, prompt, { conversation: session, continuing, signal: ac.signal, timing, expectTools: !!toolNote })) {
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
      let whole = timing.text || text
      let parsed = toolNote ? parseToolCalls(whole, payload.tools) : { calls: [], content: whole }
      let calls = parsed.calls
      let content = parsed.content
      const satisfied = () => requiredTool === "required"
        ? calls.length > 0
        : !requiredTool || calls.some((c) => c.name === requiredTool)
      if (requiredTool && !satisfied() && session) {
        // One repair turn: the model answered with prose although the client required a tool.
        const repair = "你刚才没有按格式调用工具。请只输出一个 tool_call 代码块，里面是一个 JSON 对象：{\"name\": \"工具名\", \"arguments\": {参数}}。不要输出其他文字。"
        let repaired = ""
        try {
          for await (const delta of muse.chat(acct, { full: repair, last: repair, turns: 1 }, { conversation: session, continuing: true, signal: ac.signal, timing: {}, expectTools: true })) repaired += delta
          const again = parseToolCalls(repaired, payload.tools)
          if (again.calls.length) {
            calls = again.calls
            content = again.content
            whole = repaired
            text = repaired
          }
        } catch (err) {
          if (err instanceof AuthError || err instanceof QuotaError) throw err
          // Keep the first answer; the 422 below still tells the client the contract was missed.
        }
      }
      if (requiredTool && !satisfied()) {
        throw new HttpError(422, "model did not call the required tool", "tool_call_not_parsed")
      }
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
      if (err instanceof HttpError) throw err
      await muse.closeTab(acct.id, session).catch(() => {})
      if (err instanceof AuthError) throw new HttpError(401, err.message, "session_expired")
      if (err instanceof QuotaError) {
        setTimeout(() => readUsage(acct, 0), 1500).unref?.()
        throw new HttpError(429, err.message, "quota_spent", 60)
      }
      if (err instanceof PromptTooLongError) throw new HttpError(413, err.message, "prompt_too_long")
      if (!started) {
        const [code, retryAfter] = generationCode(err)
        throw new HttpError(503, err.message || "engine unavailable", code, retryAfter)
      }
      meta.reason = redact(err.message)
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: { message: redact(err.message), type: "engine_error", code: "stream_interrupted" } })}\n\n`)
        res.end("data: [DONE]\n\n")
      }
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
      if (err instanceof AuthError) throw new HttpError(401, err.message, "session_expired")
      const [code, retryAfter] = generationCode(err)
      throw new HttpError(503, err.message, code, retryAfter)
    }
  }

  const routes = {
    "GET /v1/health": (req, res) => json(res, 200, { ok: true, engine: "muse-web", version: VERSION, accounts: store.count() }),
    "GET /v1/models": (req, res) => {
      authorize(req)
      json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "muse.ai" }] })
    },
    // Account handles only: a connector edition needs to let the user pick one without reading
    // the engine's accounts.json or any cookie.
    "GET /v1/accounts": (req, res) => {
      authorize(req)
      const accounts = store.handles().map((id) => {
        const account = store.get(id)
        return { id, label: account.label || "", expires: expiryMs(account.cookies_exp) }
      })
      json(res, 200, { accounts })
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
      // The plugin sends the browser the person picked; an older caller sends no body at all.
      const { browser } = await body(req)
      const id = await logins.start(typeof browser === "string" ? browser.trim() : "")
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
        if (!state) throw new HttpError(404, "no such login", "login_not_found")
        json(res, 200, state)
      } else if (req.method === "GET" && (m = url.pathname.match(/^\/login\/([\w-]+)$/))) {
        const html = loginPage(logins.status(m[1]))
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(html)
      } else throw new HttpError(404, "not found", "not_found")
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      meta.reason = redact(err.message)
      if (!res.headersSent) fail(res, status, err.message, {
        code: err instanceof HttpError ? err.code : "",
        retryAfter: err instanceof HttpError ? err.retryAfter : 0,
      })
      else if (!res.writableEnded) res.end()
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
