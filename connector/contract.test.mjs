import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { MuseWebConnectorPlugin } from "./index.mjs"

let server, base
const seen = []

before(async () => {
  server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const send = (status, value) => {
        const data = JSON.stringify(value)
        res.writeHead(status, { "content-type": "application/json" })
        res.end(data)
      }
      if (req.url === "/v1/health") return send(200, { engine: "muse-web", version: "0.6.0", accounts: 1 })
      if (req.url === "/v1/accounts") return send(200, { accounts: [{ id: "muse-abc", label: "muse.ai test" }] })
      if (req.url === "/v1/login" && req.method === "POST") return send(200, { id: "login-1", url: "http://127.0.0.1/login/login-1" })
      if (req.url === "/v1/login/login-1") return send(200, { status: "done", handle: "muse-abc", expires: Date.now() + 86_400_000, label: "muse.ai test" })
      if (req.url === "/v1/session/refresh") return send(200, { expires: Date.now() + 86_400_000 })
      if (req.url === "/v1/usage") return send(200, {
        plan: "muse.ai · 已就绪",
        user: "muse.ai test",
        windows: [{ name: "每周", used: 12, resetsAt: "2026-11-25T00:00:00.000Z" }],
      })
      if (req.url === "/v1/chat/completions") return send(200, { ok: true })
      send(404, { error: { message: "not found" } })
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const boot = (engine = base, key = "secret") => MuseWebConnectorPlugin({}, { engine, key })

test("config points the provider at the running engine", async () => {
  const hooks = await boot()
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider["muse-web"]
  assert.equal(provider.api, `${base}/v1`)
  assert.equal(provider.models["muse-spark"].tool_call, true)
  assert.equal(provider.models["muse-spark"].limit.context, 128_000)
})

test("both sign-in methods are offered, without a browser of its own", async () => {
  const hooks = await boot()
  assert.deepEqual(hooks.auth.methods.map((m) => m.type), ["oauth", "api"])
  assert.equal(hooks.auth.maxConcurrency, 1)
  assert.equal(typeof hooks.auth.methods[0].authorize, "function")
})

test("an engine off this machine has to be https", async () => {
  const clear = await boot("http://10.0.0.7:18611")
  await assert.rejects(clear.config({}), /本机回环/)
  const secure = await boot("https://engine.example")
  const cfg = {}
  await secure.config(cfg)
  assert.equal(cfg.provider["muse-web"].api, "https://engine.example/v1")
})

test("the loader forwards the account handle and engine key", async () => {
  const hooks = await boot()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "muse-abc" }))
  const res = await loader.fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-muse-session": "s1" },
    body: "{}",
  })
  assert.equal(res.status, 200)
  const hit = seen.filter((item) => item.url === "/v1/chat/completions").at(-1)
  assert.equal(hit.headers.authorization, "Bearer secret")
  assert.equal(hit.headers["x-muse-account"], "muse-abc")
  assert.equal(hit.headers["x-muse-session"], "s1")
})

test("usage and refresh come from the engine", async () => {
  const hooks = await boot()
  const card = await hooks.auth.usage(async () => ({ type: "api", key: "muse-abc" }))
  assert.equal(card.plan, "muse.ai · 已就绪")
  assert.equal(card.windows[0].name, "每周")
  assert.equal(card.signIn, "kept")
  const refreshed = await hooks.auth.refresh({ type: "api", key: "muse-abc", expires: 1 })
  assert.ok(refreshed.expires > Date.now())
})

test("sign-in goes through the engine and returns its handle", async () => {
  const hooks = await boot()
  const method = hooks.auth.methods[0]
  const login = await method.authorize()
  assert.equal(login.method, "auto")
  assert.match(login.url, /\/login\/login-1$/)
  const done = await login.callback()
  assert.equal(done.type, "success")
  assert.equal(done.refresh, "muse-abc")
})

test("an engine that is down is a clear error, not a made-up sign-in", async () => {
  const hooks = await boot("http://127.0.0.1:1", "secret")
  await assert.rejects(hooks.auth.refresh({ type: "api", key: "muse-abc" }), /引擎没有响应/)
  await assert.rejects(hooks.auth.methods[0].authorize(), /引擎没有响应/)
})
