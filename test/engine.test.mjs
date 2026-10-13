// Engine tests. The browser part drives a real headless Chrome/Edge against a loopback fake
// muse.ai and is skipped when no such browser is installed. Runs under `node --test` and `bun test`.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { browserArgs, findBrowser, freePort } from "../engine/browser.mjs"
import { Logins, noDesktop } from "../engine/login.mjs"
import { expiryMs, labelOf, Muse, parseSetCookies, resetDate, settle, usageCard } from "../engine/muse.mjs"
import { parseToolCalls, toolsPrompt } from "../engine/tools.mjs"
import { VERSION } from "../engine/version.mjs"
import { parseScutil, parseWinProxy, resolveProxy } from "../engine/net.mjs"
import { dataDir, engineKey } from "../engine/paths.mjs"
import { buildPrompt } from "../engine/prompt.mjs"
import { createServer } from "../engine/server.mjs"
import { Store } from "../engine/store.mjs"
import { goodCookies, startFakeMuse } from "./fake-muse.mjs"

describe("pure parts", () => {
  test("prompt: a lone user message goes as is; history becomes labelled blocks", () => {
    assert.deepEqual(buildPrompt([{ role: "user", content: "hi" }]), { full: "hi", last: "hi", turns: 1 })
    const p = buildPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ])
    assert.equal(p.full, "背景与任务设定：\nbe brief\n\n用户：\na\n\n助手：\nb\n\n用户：\nc")
    assert.equal(p.last, "c")
    assert.equal(p.turns, 3)
    assert.throws(() => buildPrompt([]))
    const shot = buildPrompt([{ role: "user", content: [{ type: "input_text", text: "看这张图" }, { type: "image_url", image_url: { url: "data:," } }] }])
    assert.equal(shot.full, "看这张图[图片]")
  })

  test("prompt: tool results and calls are told as text; Codex's sandbox name is softened", () => {
    const p = buildPrompt([
      { role: "system", content: "sandbox: danger-full-access" },
      { role: "user", content: "看看目录" },
      { role: "assistant", content: "我看一下", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{\"path\":\".\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ])
    assert.match(p.full, /standard-workspace-access/)
    assert.doesNotMatch(p.full, /danger-full-access/)
    assert.match(p.full, /助手：\n我看一下\n```tool_call\n\{"name": "ls", "arguments": \{"path":"\."\}\}\n```/)
    assert.equal(p.last, "【工具执行结果：ls】\na.txt")
  })

  test("tools: the prompt says the user's machine is not the model's own, and tool_choice is followed", () => {
    const tools = [{ type: "function", function: { name: "shell", description: "运行命令", parameters: { type: "object", properties: { command: { type: "string", description: "命令" }, opts: { type: "object", properties: { cwd: { type: "string" } } } }, required: ["command"] } } }]
    const note = toolsPrompt(tools)
    assert.match(note, /不在你的工作环境里/)
    assert.match(note, /1\. shell — 运行命令\n   参数：\n   - command \(string, 必填\) 命令\n   - opts \(object, 可选\)\n     - cwd \(string, 可选\)/)
    assert.equal(toolsPrompt(tools, "none"), "")
    assert.equal(toolsPrompt([]), "")
    assert.match(toolsPrompt(tools, "required"), /必须至少调用一个工具/)
    assert.match(toolsPrompt([{ type: "function", name: "shell", parameters: {} }], { type: "function", function: { name: "shell" } }), /必须调用工具 shell/)
  })

  test("tools: replies are parsed into calls of the request's tools only", () => {
    const tools = [{ type: "function", function: { name: "shell" } }, { type: "function", function: { name: "read" } }]
    const two = parseToolCalls('好的：\n\n<tool_call>{"name": "shell", "arguments": {"command": "ls *.js"}}</tool_call>\n<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"a\\"}"}</tool_call>', tools)
    assert.deepEqual(two.calls, [{ name: "shell", arguments: '{"command":"ls *.js"}' }, { name: "read", arguments: '{"path":"a"}' }])
    assert.equal(two.content, "好的：")
    assert.deepEqual(parseToolCalls('<tool_call>{"name": "rm", "arguments": {}}</tool_call>', tools).calls, [])
    assert.deepEqual(parseToolCalls("<tool_call>{broken</tool_call>", tools).calls, [])
    const fenced = parseToolCalls('```json\n[{"name": "shell", "arguments": {"command": "pwd"}}]\n```', tools)
    assert.deepEqual(fenced, { calls: [{ name: "shell", arguments: '{"command":"pwd"}' }], content: "" })
    const shown = parseToolCalls('配置是这样：\n```json\n{"name": "demo", "version": 1}\n```', tools)
    assert.equal(shown.calls.length, 0)
    assert.match(shown.content, /"version": 1/)
    // the page dropped the tags as HTML; the bare objects remain
    const bare = parseToolCalls('我看一下：\n{"name": "shell", "arguments": {"command": "echo \\"}\\""}}\n{"name": "read", "arguments": {"path": "a"}}', tools)
    assert.deepEqual(bare.calls, [{ name: "shell", arguments: '{"command":"echo \\"}\\""}' }, { name: "read", arguments: '{"path":"a"}' }])
    assert.equal(bare.content, "我看一下：")
    assert.equal(parseToolCalls('{"name": "shell", "version": 2}', tools).calls.length, 0)
    // a rendered tool_call code block: no fences left, its label on a line of its own
    const rendered = parseToolCalls('我来找：\ntool_call\n{"name": "shell", "arguments": {"command": "find . -not -path \\"*/node_modules/*\\""}}\n', tools)
    assert.deepEqual(rendered, { calls: [{ name: "shell", arguments: '{"command":"find . -not -path \\"*/node_modules/*\\""}' }], content: "我来找：" })
  })

  test("settle: a restyled list marker is held back and nothing is sent twice", () => {
    let sent = ""
    let out = ""
    for (const txt of ["当前目录：", "当前目录：\n-", "当前目录：\na.txt", "当前目录：\na.txt\u200b\nb.txt"]) {
      const next = settle(sent, txt)
      out += next.delta
      sent = next.sent
    }
    out += settle(sent, "当前目录：\na.txt\nb.txt", true).delta
    assert.equal(out, "当前目录：\na.txt\nb.txt")
    assert.deepEqual(settle("abc def", "abc"), { delta: "", sent: "abc def" })
    assert.equal(settle("", "-", true).delta, "-")
  })

  test("data dir per OS", () => {
    assert.equal(dataDir({}, "darwin", "/Users/a"), "/Users/a/Library/Application Support/muse-web")
    assert.equal(dataDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", "C:\\Users\\a"), "C:\\Users\\a\\AppData\\Roaming\\muse-web")
    assert.equal(dataDir({}, "linux", "/home/a"), "/home/a/.local/share/muse-web")
    assert.equal(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/home/a"), "/x/muse-web")
    assert.equal(dataDir({ MUSE_WEB_HOME: "/own" }, "linux", "/home/a"), "/own")
  })

  test("proxy: own setting, then Magpie's, then the OS, then direct", () => {
    const none = () => { throw new Error("no") }
    assert.equal(resolveProxy({ MUSE_WEB_PROXY: "direct", HTTPS_PROXY: "http://p:1" }, "linux", none), "direct")
    assert.equal(resolveProxy({ MUSE_WEB_PROXY: "127.0.0.1:6154" }, "linux", none), "http://127.0.0.1:6154")
    assert.equal(resolveProxy({ HTTPS_PROXY: "http://p:1" }, "darwin", none), "http://p:1")
    const scutil = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 6154\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 6154\n  HTTPSProxy : 127.0.0.1\n}"
    assert.equal(resolveProxy({}, "darwin", () => scutil), "http://127.0.0.1:6154")
    assert.equal(resolveProxy({}, "linux", none), "direct")
    assert.equal(parseScutil("HTTPSEnable : 0\nHTTPSProxy : x"), "")
    assert.equal(parseWinProxy("0x1", "127.0.0.1:7890"), "http://127.0.0.1:7890")
    assert.equal(parseWinProxy("0x1", "http=h:1;https=h:2"), "http://h:2")
    assert.equal(parseWinProxy("0x0", "127.0.0.1:7890"), "")
  })

  test("browser flags follow the proxy and window mode", () => {
    const base = { port: 1, profileDir: "/p" }
    assert.ok(browserArgs({ ...base, headless: true, proxy: "direct" }).includes("--no-proxy-server"))
    assert.ok(browserArgs({ ...base, headless: false, proxy: "http://h:1" }).includes("--proxy-server=http://h:1"))
    const hidden = browserArgs({ ...base, headless: false, hidden: true, proxy: "" })
    assert.ok(hidden.includes("--window-position=-32000,-32000") && !hidden.some((a) => a.startsWith("--headless")))
    assert.ok(hidden.includes("--use-mock-keychain") && hidden.includes("--password-store=basic"))
  })

  test("a Linux session without a desktop cannot open the sign-in window", () => {
    assert.equal(noDesktop("linux", {}), true)
    assert.equal(noDesktop("linux", { DISPLAY: ":0" }), false)
    assert.equal(noDesktop("linux", { WAYLAND_DISPLAY: "wayland-0" }), false)
    assert.equal(noDesktop("win32", {}), false)
    assert.equal(noDesktop("darwin", {}), false)
  })

  test("cookies: Set-Cookie parsing and expiry", () => {
    const { cookies, exp } = parseSetCookies(["hatch_vml=v; Max-Age=100; HttpOnly", "a=b; Expires=Thu, 01 Jan 2099 00:00:00 GMT"], 1_000_000)
    assert.deepEqual(cookies, { hatch_vml: "v", a: "b" })
    assert.equal(exp.hatch_vml, 1100)
    assert.equal(expiryMs(exp), 1_100_000)
  })

  test("account label: a name muse.ai sends, otherwise the sign-in time; version matches the package", () => {
    assert.equal(labelOf({ status: "assigned", user: { email: "a@b.c" } }), "a@b.c")
    assert.equal(labelOf({ status: "assigned", vm_id: "x" }), "")
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-"))
    try {
      const store = new Store(path.join(dir, "accounts.json"))
      assert.equal(store.add({}, {}, "a@b.c").label, "a@b.c")
      assert.match(store.add({}, {}).label, /^muse\.ai \d{4}-\d{2}-\d{2} \d{2}:\d{2} 登录$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    assert.equal(VERSION, pkg.version)
  })

  test("usage: the settings page's meters become Magpie's windows", () => {
    const now = new Date(2026, 9, 13, 14, 0).getTime()
    assert.equal(resetDate("每周限额将在 10月15日重置", now), new Date(2026, 9, 15).getTime())
    assert.equal(resetDate("Weekly limit resets Oct 15", now), new Date(2026, 9, 15).getTime())
    assert.equal(resetDate("Resets 2 January", now), new Date(2027, 0, 2).getTime())
    assert.equal(resetDate("从不过期", now), null)
    const card = usageCard([
      { name: "免费版", used: 37, texts: ["免费版", "每周限额将在 10月15日重置", "已使用 37%"] },
      { name: "额外的使用额度", used: 0, texts: ["额外的使用额度", "从不过期", "已使用 0%（剩余 10 亿个词元）"] },
    ], now)
    assert.equal(card.plan, "免费版")
    assert.deepEqual(card.windows, [
      { name: "每周", used: 37, resetsAt: new Date(2026, 9, 15).toISOString() },
      { name: "额外额度", used: 0, display: "剩余 10 亿个词元" },
    ])
  })

  test("signing in again to an account already kept renews it under its handle and name", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-"))
    try {
      const store = new Store(path.join(dir, "accounts.json"))
      const first = store.add({ hatch_sess: "a" }, {}, "", "vm-1")
      const again = store.add({ hatch_sess: "b" }, {}, "", "vm-1")
      assert.equal(again.handle, first.handle)
      assert.equal(again.label, first.label)
      assert.equal(again.again, true)
      assert.equal(store.get(first.handle).cookies.hatch_sess, "b")
      assert.notEqual(store.add({ hatch_sess: "c" }, {}, "", "vm-2").handle, first.handle)
      assert.equal(store.count(), 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("key and accounts are private files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-"))
    try {
      const key = engineKey(dir)
      assert.equal(engineKey(dir), key)
      const store = new Store(path.join(dir, "accounts.json"))
      const { handle } = store.add({ hatch_sess: "x" }, {})
      assert.equal(new Store(path.join(dir, "accounts.json")).get(handle).cookies.hatch_sess, "x")
      if (process.platform !== "win32") {
        assert.equal(statSync(path.join(dir, "engine.key")).mode & 0o777, 0o600)
        assert.equal(statSync(path.join(dir, "accounts.json")).mode & 0o777, 0o600)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a settings page with no meters yet backs off like any failed reading", async () => {
    const muse = new Muse({})
    muse.started = Promise.resolve()
    muse.accounts.set("a", { contextId: "c", tabs: new Map() })
    let opened = 0
    muse.openUsage = async () => { opened++; return [] }
    await assert.rejects(muse.readUsage({ id: "a" }), /没有加载出来/)
    assert.equal(await muse.readUsage({ id: "a" }), null)
    assert.equal(opened, 1)
  })
})

const executable = findBrowser()

describe("engine against a fake muse.ai in a real browser", { skip: executable ? false : "no Chrome/Edge/Chromium installed", timeout: 180_000 }, () => {
  let fake, dir, store, muse, logins, server, base, good, expired
  const key = "test-key"

  before(async () => {
    fake = await startFakeMuse()
    dir = mkdtempSync(path.join(os.tmpdir(), "mw-engine-"))
    store = new Store(path.join(dir, "accounts.json"))
    good = store.add(goodCookies(), {}).handle
    expired = store.add({ ...goodCookies(), hatch_sess: "expired" }, {}).handle
    muse = new Muse({ site: fake.site, executable, profileDir: path.join(dir, "browser"), headless: true, proxy: "direct", onCookies: (id, c, e) => store.update(id, c, e) })
    logins = new Logins({ site: fake.site, executable, dir: path.join(dir, "login"), proxy: "direct", headless: true, everyMs: 300, onDone: (c, e, label, vm) => store.add(c, e, label, vm) })
    const port = await freePort()
    server = createServer({ muse, logins, store, key, port, site: fake.site })
    await new Promise((r) => server.listen(port, "127.0.0.1", r))
    base = `http://127.0.0.1:${port}`
  })

  after(async () => {
    logins?.stopAll()
    await muse?.stop()
    server?.closeAllConnections?.()
    await new Promise((r) => server ? server.close(r) : r())
    await fake?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const call = (pathname, { account = good, session, body, method = body ? "POST" : "GET", auth = key } = {}) =>
    fetch(base + pathname, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
        ...(account ? { "x-muse-account": account } : {}),
        ...(session ? { "x-muse-session": session } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  async function sse(res) {
    const text = await res.text()
    let out = ""
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const d = JSON.parse(line.slice(6))
      assert.ok(!d.error, d.error?.message)
      out += d.choices[0].delta.content || ""
    }
    return out
  }

  test("health needs no key; everything else does", async () => {
    const h = await (await fetch(`${base}/v1/health`)).json()
    assert.equal(h.engine, "muse-web")
    assert.equal((await call("/v1/models", { auth: "wrong" })).status, 401)
  })

  test("a chat streams the page's reply", async () => {
    const res = await call("/v1/chat/completions", { session: "s1", body: { model: "muse-spark", messages: [{ role: "user", content: "REPLY:你好世界" }] } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /event-stream/)
    assert.equal(await sse(res), "你好世界")
    assert.equal(fake.state.prompts.at(-1), "REPLY:你好世界")
  })

  test("with tools, a <tool_call> in the reply comes back as tool calls, streamed or not", async () => {
    const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } } }]
    const messages = [{ role: "user", content: "TOOLCALL: 看看目录" }]
    const plain = await (await call("/v1/chat/completions", { session: "t1", body: { stream: false, messages, tools } })).json()
    assert.match(fake.state.prompts.at(-1), /【客户端工具说明】[\s\S]*1\. shell/)
    assert.equal(plain.choices[0].finish_reason, "tool_calls")
    assert.equal(plain.choices[0].message.content, "好的，我来看一下。")
    assert.equal(plain.choices[0].message.tool_calls[0].function.name, "shell")
    assert.equal(plain.choices[0].message.tool_calls[0].function.arguments, '{"command":"ls -la"}')
    await muse.closeTab(good, "t1")

    const raw = await (await call("/v1/chat/completions", { session: "t2", body: { messages, tools } })).text()
    const chunks = raw.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0])
    const content = chunks.map((c) => c.delta.content || "").join("")
    const args = chunks.flatMap((c) => c.delta.tool_calls || []).map((t) => t.function?.arguments || "").join("")
    assert.equal(content, "好的，我来看一下。\n")
    assert.doesNotMatch(content, /tool_call/)
    assert.equal(args, '{"command":"ls -la"}')
    assert.equal(chunks.at(-1).finish_reason, "tool_calls")
    await muse.closeTab(good, "t2")

    const bare = await (await call("/v1/chat/completions", { session: "t3", body: { messages: [{ role: "user", content: "BARETOOL: 看看目录" }], tools } })).text()
    const bareChunks = bare.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0])
    assert.equal(bareChunks.map((c) => c.delta.content || "").join(""), "")
    assert.equal(bareChunks.flatMap((c) => c.delta.tool_calls || []).map((t) => t.function?.arguments || "").join(""), '{"command":"pwd && ls -la"}')
    await muse.closeTab(good, "t3")
  })

  test("a list marker the page restyles away is not sent twice", async () => {
    const res = await call("/v1/chat/completions", { session: "r1", body: { messages: [{ role: "user", content: "RESTYLE: 列个清单" }] } })
    assert.equal(await sse(res), "清单：\n苹果\n香蕉")
    await muse.closeTab(good, "r1")
    const plain = await (await call("/v1/chat/completions", { session: "r2", body: { stream: false, messages: [{ role: "user", content: "RESTYLE: 列个清单" }] } })).json()
    assert.equal(plain.choices[0].message.content, "清单：\n苹果\n香蕉")
    await muse.closeTab(good, "r2")
  })

  test("suggested follow-up buttons in the bubble are not part of the reply", async () => {
    const res = await call("/v1/chat/completions", { session: "g1", body: { messages: [{ role: "user", content: "SUGGEST: 用的什么测试框架" }] } })
    assert.equal(await sse(res), "这个项目用的是 Vitest。")
    await muse.closeTab(good, "g1")
  })

  test("the same session sends only the new message; a new session starts over with the full history", async () => {
    const history = [
      { role: "user", content: "REPLY:你好世界" },
      { role: "assistant", content: "你好世界" },
      { role: "user", content: "REPLY:第二轮" },
    ]
    const r1 = await call("/v1/chat/completions", { session: "s1", body: { messages: history } })
    assert.equal(await sse(r1), "第二轮")
    assert.equal(fake.state.prompts.at(-1), "REPLY:第二轮")

    const r2 = await call("/v1/chat/completions", { session: "s2", body: { messages: history } })
    assert.equal(await sse(r2), "你好世界")
    assert.match(fake.state.prompts.at(-1), /^用户：\nREPLY:你好世界\n\n助手：/)

    // Back to s1: its own tab still holds the thread, so no page load and only the new message.
    const loads = fake.state.pageLoads
    const r3 = await call("/v1/chat/completions", {
      session: "s1",
      body: { messages: [...history, { role: "assistant", content: "第二轮" }, { role: "user", content: "REPLY:回到一" }] },
    })
    assert.equal(await sse(r3), "回到一")
    assert.equal(fake.state.prompts.at(-1), "REPLY:回到一")
    assert.equal(fake.state.pageLoads, loads)
  })

  test("non-streaming requests get one JSON answer", async () => {
    const res = await call("/v1/chat/completions", { session: "s2", body: { stream: false, messages: [{ role: "user", content: "REPLY:整段" }] } })
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "整段")
  })

  test("a second request on a busy account gets 429", async () => {
    const slow = call("/v1/chat/completions", { session: "s3", body: { messages: [{ role: "user", content: "REPLY:慢慢来 DELAY:2500" }] } })
    await new Promise((r) => setTimeout(r, 400))
    const busy = await call("/v1/chat/completions", { session: "s4", body: { messages: [{ role: "user", content: "hi" }] } })
    assert.equal(busy.status, 429)
    assert.equal(await sse(await slow), "慢慢来")
  })

  test("a warmed account's first message reuses the page that warming opened", async () => {
    const handle = store.add(goodCookies(), {}).handle
    const warming = muse.warm(store.get(handle))
    const res = call("/v1/chat/completions", { account: handle, session: "w1", body: { messages: [{ role: "user", content: "REPLY:热好了" }] } })
    await warming
    const loads = fake.state.pageLoads
    const r = await res
    assert.equal(r.status, 200, "a chat during warming waits instead of getting 429")
    assert.equal(await sse(r), "热好了")
    assert.equal(fake.state.pageLoads, loads)
  })

  test("an account muse.ai says is used up is 429 at once, so Magpie moves on", async () => {
    const t0 = Date.now()
    const res = await call("/v1/chat/completions", { session: "q1", body: { messages: [{ role: "user", content: "QUOTA: hi" }] } })
    assert.equal(res.status, 429)
    assert.match((await res.json()).error.message, /额度用完/)
    assert.ok(Date.now() - t0 < 15_000, "no waiting for the first-token timeout")
    // the model saying those words is an answer, not a notice
    const ok = await call("/v1/chat/completions", { session: "q2", body: { messages: [{ role: "user", content: "REPLY:已经达到上限了" }] } })
    assert.equal(await sse(ok), "已经达到上限了")
  })

  test("keep-alive renews the session over HTTP and confirms the VM is running", async () => {
    const wakes = fake.state.wakeCalls
    const { vmState } = await muse.keepAlive(store.get(good))
    assert.equal(vmState, "RUNNING")
    assert.equal(fake.state.wakeCalls, wakes + 1)
    assert.match(store.get(good).cookies.hatch_vml, /^renewed/)
  })

  test("a signed-out account is 401, as is an unknown one", async () => {
    const res = await call("/v1/chat/completions", { account: expired, body: { messages: [{ role: "user", content: "hi" }] } })
    assert.equal(res.status, 401)
    assert.equal((await call("/v1/session/refresh", { account: expired, method: "POST" })).status, 401)
    assert.equal((await call("/v1/usage", { account: "muse-nope" })).status, 401)
  })

  test("the usage card shows the settings page's meters, the account, and whether its page is ready", async () => {
    fake.state.usage.weekly = 37
    muse.usage.delete(good)
    const card = await (await call("/v1/usage")).json()
    assert.equal(card.plan, "免费版 · 已就绪")
    assert.equal(card.windows.length, 2)
    assert.deepEqual({ ...card.windows[0], resetsAt: undefined }, { name: "每周", used: 37, resetsAt: undefined })
    assert.ok(Date.parse(card.windows[0].resetsAt) > Date.now() - 86_400_000)
    assert.deepEqual(card.windows[1], { name: "额外额度", used: 0, display: "剩余 10 亿个词元" })
    assert.match(card.user, /登录$/)
    // a fresh reading is kept: asking again does not open settings again
    const reads = fake.state.usageReads
    await call("/v1/usage")
    assert.equal(fake.state.usageReads, reads)
    const cold = await (await call("/v1/usage", { account: store.add(goodCookies(), { hatch_vml: 1_900_000_000 }).handle })).json()
    assert.match(cold.plan, /闲置/)
    assert.equal(cold.until, new Date(1_900_000_000_000).toISOString())
  })

  test("refresh renews the cookies and reports the expiry", async () => {
    const res = await call("/v1/session/refresh", { method: "POST" })
    assert.equal(res.status, 200)
    const { expires } = await res.json()
    assert.ok(expires > Date.now())
    assert.match(store.get(good).cookies.hatch_vml, /^renewed/)
  })

  test("browser sign-in stores a new account and hands back its handle", async () => {
    const before = store.count()
    const start = await (await call("/v1/login", { account: null, method: "POST" })).json()
    assert.match(start.url, /\/login\//)
    let state
    for (let i = 0; i < 60; i++) {
      state = await (await call(`/v1/login/${start.id}`, { account: null })).json()
      if (state.status !== "pending" && state.status !== "starting") break
      await new Promise((r) => setTimeout(r, 300))
    }
    assert.equal(state.status, "done", state.error)
    assert.match(state.handle, /^muse-/)
    assert.match(state.label, /登录$/)
    assert.equal(store.count(), before + 1)
    assert.match(await (await fetch(start.url)).text(), /登录完成/)

    // the same muse.ai account again: the same handle and name, no new account
    const again = await (await call("/v1/login", { account: null, method: "POST" })).json()
    let state2
    for (let i = 0; i < 60; i++) {
      state2 = await (await call(`/v1/login/${again.id}`, { account: null })).json()
      if (state2.status !== "pending" && state2.status !== "starting") break
      await new Promise((r) => setTimeout(r, 300))
    }
    assert.equal(state2.status, "done", state2.error)
    assert.equal(state2.handle, state.handle)
    assert.equal(state2.label, state.label)
    assert.equal(store.count(), before + 1)
  })

  test("a sign-in whose account does not answer the test message fails, saying why", async () => {
    const was = logins.onDone
    logins.onDone = async () => { throw new Error("已登录，但账号没有回答测试消息：没有回复") }
    try {
      const start = await (await call("/v1/login", { account: null, method: "POST" })).json()
      let state
      for (let i = 0; i < 60; i++) {
        state = await (await call(`/v1/login/${start.id}`, { account: null })).json()
        if (state.status !== "pending" && state.status !== "starting") break
        await new Promise((r) => setTimeout(r, 300))
      }
      assert.equal(state.status, "failed")
      assert.match(state.error, /没有回答测试消息/)
    } finally {
      logins.onDone = was
    }
  })

  test("verify: the account answers a short message in a tab that is closed afterwards", async () => {
    await muse.verify(store.get(good))
    assert.match(fake.state.prompts.at(-1), /连通测试/)
    assert.ok(![...muse.accounts.get(good).tabs.keys()].includes("\u0000verify"))
  })
})
