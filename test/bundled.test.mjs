// The plugin with no engine configured: it starts its own engine, signs in through the browser
// and chats, all against the loopback fake muse.ai. Skipped without Chrome/Edge/Chromium.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import http from "node:http"
import { VERSION } from "../engine/version.mjs"
import os from "node:os"
import path from "node:path"
import { findBrowser, freePort } from "../engine/browser.mjs"
import { MuseWebPlugin } from "../index.mjs"
import { startFakeMuse } from "./fake-muse.mjs"

const skip = findBrowser() ? false : "no Chrome/Edge/Chromium installed"
let fake, home, port, hooks

async function stopEngine() {
  const key = readFileSync(path.join(home, "engine.key"), "utf8").trim()
  await fetch(`http://127.0.0.1:${port}/v1/shutdown`, { method: "POST", headers: { authorization: `Bearer ${key}` } }).catch(() => {})
  for (let i = 0; i < 40; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/v1/health`).then(() => true, () => false)
    if (!up) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

before(async () => {
  if (skip) return
  fake = await startFakeMuse()
  home = mkdtempSync(path.join(os.tmpdir(), "mw-bundled-"))
  port = await freePort()
  delete process.env.MUSE_WEB_ENGINE
  delete process.env.MUSE_WEB_ENGINE_KEY
  Object.assign(process.env, {
    MUSE_WEB_HOME: home,
    MUSE_WEB_ENGINE_PORT: String(port),
    MUSE_WEB_SITE: fake.site,
    MUSE_WEB_PROXY: "direct",
    MUSE_WEB_LOGIN_HEADLESS: "1",
    MUSE_WEB_PREWARM: "0",
  })
})

after(async () => {
  if (skip) return
  await stopEngine()
  await fake.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

async function chat(loaded, content) {
  const res = await loaded.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-muse-session": "bundled-1" },
    body: JSON.stringify({ model: "muse-spark", stream: true, messages: [{ role: "user", content }] }),
  })
  assert.equal(res.status, 200)
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content || "")
    .join("")
}

test("an engine left by an older plugin version is stopped and replaced", { skip, timeout: 60_000 }, async () => {
  let stopped = false
  const old = http.createServer((req, res) => {
    if (req.url === "/v1/shutdown") {
      stopped = true
      res.end("{}")
      old.close()
      old.closeAllConnections?.()
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, engine: "muse-web", version: "0.0.1", accounts: 0 }))
  })
  await new Promise((r) => old.listen(port, "127.0.0.1", r))
  hooks = await MuseWebPlugin()
  const usage = await hooks.auth.usage(async () => ({ type: "oauth", refresh: "muse-none", access: "muse-none", expires: 1 }))
  assert.ok(stopped, "old engine was not asked to stop")
  const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()
  assert.equal(health.version, VERSION)
  assert.equal(usage.signIn, "expired")
})

test("sign in through the browser, chat, refresh, and survive an engine restart", { skip, timeout: 120_000 }, async () => {
  const login = hooks.auth.methods.find((m) => m.type === "oauth")
  const started = await login.authorize()
  assert.match(started.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/login/`))
  assert.equal(started.method, "auto")
  const done = await started.callback()
  assert.equal(done.type, "success")
  assert.match(done.refresh, /^muse-/)
  assert.ok(done.expires > Date.now())
  assert.match(done.accountId, /登录$/)

  const auth = { type: "oauth", refresh: done.refresh, access: done.access, expires: done.expires }
  const loaded = await hooks.auth.loader(async () => auth)
  assert.equal(await chat(loaded, "REPLY:插件自己起的引擎"), "插件自己起的引擎")

  const renewed = await hooks.auth.refresh(auth)
  assert.equal(renewed.refresh, done.refresh)
  assert.ok(renewed.expires > Date.now())

  await stopEngine()
  assert.equal(await chat(loaded, "REPLY:重启后照常"), "重启后照常")
})
