// Sign-in in a visible browser window with a throwaway profile. Done when muse.ai has set the
// core cookies and /api/session accepts them; the cookies (httpOnly included) are read through
// CDP, never typed or seen by the user. Signing in sets only hatch_sess and the device cookie and
// leaves the user on the home page; the gateway and VM cookies come once the chat page loads,
// so the window is sent there.
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import path from "node:path"
import { launchBrowser } from "./browser.mjs"
import { CDP } from "./cdp.mjs"
import { AuthError, ESSENTIAL, renewSession } from "./muse.mjs"

// A sign-in window needs a desktop. Linux servers and SSH sessions often have none.
export function noDesktop(platform = process.platform, env = process.env) {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

export class Logins {
  constructor({ site, executable, dir, proxy = "", fetchImpl = fetch, everyMs = 2000, limitMs = 15 * 60_000, headless = false, onDone }) {
    this.site = site.replace(/\/+$/, "")
    this.host = new URL(this.site).hostname
    Object.assign(this, { executable, dir, proxy, fetchImpl, everyMs, limitMs, headless, onDone })
    this.runs = new Map() // id → {status, step, handle?, expires?, error?, stop?}
  }

  // Closes every sign-in window still open, e.g. when the engine stops.
  stopAll() {
    for (const run of this.runs.values()) run.stop?.()
  }

  async openChat(port) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json())
    const tab = list.find((t) => t.type === "page")
    if (!tab) return
    const page = await CDP.connect(tab.webSocketDebuggerUrl)
    try {
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
    } finally {
      page.close()
    }
  }

  async start() {
    const id = randomBytes(9).toString("base64url")
    const profileDir = path.join(this.dir, id)
    const run = { status: "starting" }
    this.runs.set(id, run)
    if (!this.headless && noDesktop()) {
      Object.assign(run, { status: "failed", error: "这台 Linux 没有图形桌面（DISPLAY / WAYLAND_DISPLAY 都没设），弹不出登录窗口；请在有桌面的会话里登录" })
      return id
    }
    let opened
    try {
      opened = await launchBrowser({ executable: this.executable, profileDir, headless: this.headless, proxy: this.proxy, url: `${this.site}/` })
    } catch (err) {
      Object.assign(run, { status: "failed", error: `打不开浏览器: ${err.message}` })
      return id
    }
    run.status = "pending"
    run.step = "等你在窗口里登录"
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      opened.close().then(() => rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })).catch(() => {})
    }
    const finish = (fields) => {
      if (run.status !== "pending") return
      Object.assign(run, fields)
      close()
    }
    run.stop = () => finish({ status: "failed", error: "引擎停止了，登录没有完成" })
    opened.proc.on("exit", () => { if (!closed) finish({ status: "failed", error: "登录窗口在登录完成前被关掉了" }) })
    const started = Date.now()
    let busy = false
    let sentToChat = 0
    const timer = setInterval(async () => {
      if (busy || run.status !== "pending") return
      if (Date.now() - started > this.limitMs) return finish({ status: "failed", error: "登录超时" })
      busy = true
      try {
        const got = await this.cookies(opened.browser)
        if (got.cookies.hatch_sess && !ESSENTIAL.every((n) => got.cookies[n]) && Date.now() - sentToChat > 20_000) {
          sentToChat = Date.now()
          run.step = "已登录，正在打开聊天页领取会话"
          await this.openChat(opened.port)
        }
        if (ESSENTIAL.every((n) => got.cookies[n])) {
          run.step = "正在向 muse.ai 确认会话"
          const renewed = await renewSession(this.site, got.cookies, got.exp, { fetchImpl: this.fetchImpl, wakeVm: false })
          // the window has done its part; onDone may still be checking the account answers
          close()
          run.step = "已领到会话，正在发一条测试消息确认账号能回答"
          try {
            const saved = await this.onDone(renewed.cookies, renewed.cookies_exp, renewed.label, renewed.vm)
            finish({ status: "done", handle: saved.handle, expires: saved.expires, label: saved.label })
          } catch (err) {
            finish({ status: "failed", error: err.message })
          }
        }
      } catch (err) {
        if (!(err instanceof AuthError)) run.note = err.message
      } finally {
        busy = false
      }
    }, this.everyMs)
    return id
  }

  async cookies(browser) {
    const { cookies = [] } = await browser.send("Storage.getCookies", {})
    const out = { cookies: {}, exp: {} }
    for (const c of cookies) {
      const domain = String(c.domain || "").replace(/^\./, "")
      if (domain !== this.host && !this.host.endsWith(`.${domain}`)) continue
      out.cookies[c.name] = c.value
      if (c.expires > 0) out.exp[c.name] = Math.floor(c.expires)
    }
    return out
  }

  status(id) {
    const run = this.runs.get(id)
    if (!run) return null
    const { status, step, note, handle, expires, label, error } = run
    return {
      status,
      ...(status === "pending" ? { step, ...(note ? { note } : {}) } : {}),
      ...(handle ? { handle, expires, label } : {}),
      ...(error ? { error } : {}),
    }
  }
}
