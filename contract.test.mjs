import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import test from "node:test"

import { MuseWebPlugin } from "./index.mjs"

function listen() {
  const seen = []
  let mode = "ok"
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || "",
        account: req.headers["x-muse-account"] || "",
        session: req.headers["x-muse-session"] || "",
        body,
      })
      if (req.url === "/mode") {
        mode = body.trim() || "ok"
        res.writeHead(204)
        res.end()
        return
      }
      if (mode === "401") {
        const payload = JSON.stringify({ error: { message: "session refused", type: "authentication_error" } })
        res.writeHead(401, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (mode === "429") {
        const payload = JSON.stringify({ error: { message: "account busy", type: "rate_limit_error" } })
        res.writeHead(429, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (req.url === "/v1/session/refresh") {
        const payload = JSON.stringify({ expires: 1800000000000 })
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      if (req.url === "/v1/usage") {
        const payload = JSON.stringify(mode === "card"
          ? { plan: "muse.ai 网页 · 已就绪", windows: [], user: "muse.ai 2026-10-13 14:03 登录", until: "2026-10-20T06:03:00.000Z" }
          : { error: "no structured quota" })
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      const stream = body.includes('"stream":true') || body.includes('"stream": true')
      if (stream) {
        const payload = [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"muse-spark","choices":[{"index":0,"delta":{"content":"muse-spark-ok"},"finish_reason":null}]}',
          "",
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"muse-spark","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n")
        res.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
        return
      }
      const payload = JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "muse-spark",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "muse-spark-ok" } }],
      })
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
      res.end(payload)
    })
  })
  return { server, seen, setMode: async (next) => {
    mode = next
  } }
}

async function boot() {
  const fake = listen()
  fake.server.listen(0, "127.0.0.1")
  await once(fake.server, "listening")
  const { port } = fake.server.address()
  process.env.MUSE_WEB_ENGINE = `http://127.0.0.1:${port}`
  process.env.MUSE_WEB_ENGINE_KEY = "engine-test-key"
  const hooks = await MuseWebPlugin()
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "acct-handle-1" }))
  return {
    ...fake,
    hooks,
    loaded,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise((resolve, reject) => fake.server.close((err) => err ? reject(err) : resolve())),
  }
}

test("forwards the named account and streams without content-length", async () => {
  const fx = await boot()
  try {
    const headersOut = { headers: {} }
    await fx.hooks["chat.headers"]({ sessionID: "sess-9", model: { providerID: "muse-web" } }, headersOut)
    assert.equal(headersOut.headers["x-muse-session"], "sess-9")
    const res = await fx.loaded.fetch(fx.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer acct-handle-1",
        "x-muse-session": headersOut.headers["x-muse-session"],
      },
      body: JSON.stringify({ model: "muse-spark", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.equal(res.headers.has("content-length"), false)
    assert.match(text, /muse-spark-ok/)
    const hit = fx.seen.find((r) => r.url === "/v1/chat/completions")
    assert.equal(hit.authorization, "Bearer engine-test-key")
    assert.equal(hit.account, "acct-handle-1")
    assert.equal(hit.session, "sess-9")
    assert.doesNotMatch(hit.authorization, /acct-handle-1/)
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  } finally {
    await fx.close()
  }
})

test("401 is marked expired and 429 stays an OpenAI error", async () => {
  const fx = await boot()
  try {
    await fx.setMode("401")
    const denied = await fx.loaded.fetch(fx.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer acct-handle-1" },
      body: JSON.stringify({ model: "muse-spark", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(denied.status, 401)
    assert.equal(denied.headers.get("x-magpie-sign-in"), "expired")
    assert.equal(denied.headers.has("content-length"), false)
    const deniedBody = await denied.json()
    assert.equal(deniedBody.error.type, "authentication_error")

    await fx.setMode("429")
    const busy = await fx.loaded.fetch(fx.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "muse-spark", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(busy.status, 429)
    assert.equal(busy.headers.get("x-magpie-sign-in"), null)
    const busyBody = await busy.json()
    assert.equal(busyBody.error.message, "account busy")
    assert.equal(busyBody.error.type, "rate_limit_error")
  } finally {
    await fx.close()
  }
})

test("chat.headers ignores other providers", async () => {
  const hooks = await MuseWebPlugin()
  const output = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "sess-9", model: { providerID: "openai" } }, output)
  assert.deepEqual(output.headers, {})
})

test("refresh exchanges only expiry and a refusal expires the sign-in", async () => {
  const fx = await boot()
  try {
    fx.seen.length = 0
    const kept = await fx.hooks.auth.refresh({ type: "api", key: "acct-handle-1", cookies: "must-not-leave" })
    assert.deepEqual(kept, { expires: 1_800_000_000_000 })
    const hit = fx.seen.at(-1)
    assert.equal(hit.url, "/v1/session/refresh")
    assert.equal(hit.method, "POST")
    assert.equal(hit.account, "acct-handle-1")
    assert.equal(hit.authorization, "Bearer engine-test-key")
    assert.doesNotMatch(hit.body, /must-not-leave/)

    await fx.setMode("401")
    await assert.rejects(
      () => fx.hooks.auth.refresh({ type: "api", key: "acct-handle-1" }),
      (err) => err.signIn === "expired" && err.message === "session refused",
    )
  } finally {
    await fx.close()
  }
})

test("usage returns an error instead of a made-up window", async () => {
  const fx = await boot()
  try {
    const missing = await fx.hooks.auth.usage(async () => ({ type: "api", key: "acct-handle-1" }))
    assert.deepEqual(missing, { error: "no structured quota" })
    assert.equal(missing.windows, undefined)
    assert.equal(missing.signIn, undefined)
    const hit = fx.seen.at(-1)
    assert.equal(hit.url, "/v1/usage")
    assert.equal(hit.account, "acct-handle-1")
    assert.equal(hit.authorization, "Bearer engine-test-key")
  } finally {
    await fx.close()
  }
})

test("api and oauth logins both name the account", async () => {
  const fx = await boot()
  try {
    const kept = await fx.hooks.auth.refresh({ type: "oauth", refresh: "acct-handle-2", access: "acct-handle-2", expires: 1 })
    assert.deepEqual(kept, { access: "acct-handle-2", refresh: "acct-handle-2", expires: 1_800_000_000_000 })
    assert.equal(fx.seen.at(-1).account, "acct-handle-2")
    assert.deepEqual(fx.hooks.auth.methods.map((m) => m.type), ["oauth", "api"])
  } finally {
    await fx.close()
  }
})

test("the usage card shows the account the engine describes, without inventing a quota", async () => {
  const fx = await boot()
  try {
    await fx.setMode("card")
    const card = await fx.hooks.auth.usage(async () => ({ type: "oauth", refresh: "acct-handle-1", access: "acct-handle-1", expires: 1 }))
    assert.deepEqual(card, {
      plan: "muse.ai 网页 · 已就绪",
      user: "muse.ai 2026-10-13 14:03 登录",
      until: "2026-10-20T06:03:00.000Z",
      windows: [],
      signIn: "kept",
    })
  } finally {
    await fx.close()
  }
})

test("config describes the model and keeps what the user configured", async () => {
  const hooks = await MuseWebPlugin()
  const cfg = { provider: { "muse-web": { name: "我的 Muse", models: { extra: { name: "Extra" } } } } }
  await hooks.config(cfg)
  const p = cfg.provider["muse-web"]
  assert.equal(p.name, "我的 Muse")
  assert.equal(p.models["muse-spark"].attachment, false)
  assert.deepEqual(p.models["muse-spark"].modalities, { input: ["text"], output: ["text"] })
  assert.ok(p.models["muse-spark"].limit.context > 0)
  assert.equal(p.models.extra.name, "Extra")
  assert.equal(hooks.auth.refreshLead, 600_000)
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  assert.match(hooks.auth.icon, /^data:image\/svg\+xml;base64,/)
  assert.equal(pkg.magpie.icon, hooks.auth.icon, "package.json's icon is icon.svg's")
  assert.ok(pkg.files.includes("icon.svg"))
})

test("an unreachable engine is an error, not an expired sign-in", async () => {
  const fx = await boot()
  await fx.close()
  const usage = await fx.hooks.auth.usage(async () => ({ type: "api", key: "acct-handle-1" }))
  assert.deepEqual(usage, { error: "engine unreachable" })
  await assert.rejects(
    () => fx.hooks.auth.refresh({ type: "api", key: "acct-handle-1" }),
    (err) => err.message === "engine unreachable" && err.signIn === undefined,
  )
})

