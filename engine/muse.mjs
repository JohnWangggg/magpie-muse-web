// Drives muse.ai's web chat for one named account at a time per page.
// The page logic is ported from muse2api's MuseEngine chat path (MIT, MUSE2API Authors):
// renew_session_http, _apply_cookies, _wait_ws_ready, reset_thread, ensure_page, _send,
// _poll_chat and chat_stream. Selectors and timings are kept as muse2api has them, except the
// first-token wait, raised from 40 s to 90 s after cold starts were measured at 30–47 s.
import { randomUUID } from "node:crypto"
import { CDP } from "./cdp.mjs"
import { launchBrowser } from "./browser.mjs"

export const ESSENTIAL = ["hatch_sess", "hatch_gw", "hatch_vml", "hatch_native_auth_device"]

export class AuthError extends Error {}
export class GenerationError extends Error {}
// muse.ai says the account has used up its allowance: another account should answer.
export class QuotaError extends GenerationError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"

export function cookieHeader(cookies) {
  return Object.entries(cookies || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ")
}

// Set-Cookie lines → {cookies, exp} with exp in unix seconds.
export function parseSetCookies(lines, now = Date.now()) {
  const cookies = {}
  const exp = {}
  for (const line of lines || []) {
    const [pair, ...attrs] = String(line).split(";")
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (value) cookies[name] = value
    for (const attr of attrs) {
      const [k, ...rest] = attr.split("=")
      const key = k.trim().toLowerCase()
      const v = rest.join("=").trim()
      if (key === "max-age" && /^-?\d+$/.test(v)) exp[name] = Math.floor(now / 1000) + Number(v)
      else if (key === "expires" && !(name in exp)) {
        const t = Date.parse(v)
        if (Number.isFinite(t)) exp[name] = Math.floor(t / 1000)
      }
    }
  }
  return { cookies, exp }
}

// The session cookie that decides expiry, in milliseconds; null when unknown.
export function expiryMs(exp) {
  const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  if (pos(exp?.hatch_vml)) return pos(exp.hatch_vml) * 1000
  const vals = ESSENTIAL.map((n) => pos(exp?.[n])).filter(Boolean)
  return vals.length ? Math.min(...vals) * 1000 : null
}

// A readable name for the account from /api/session, when muse.ai sends one. Never a cookie.
export function labelOf(body) {
  for (const src of [body, body?.user, body?.account, body?.profile]) {
    if (!src || typeof src !== "object") continue
    for (const k of ["email", "user_email", "username", "display_name", "name"]) {
      const v = src[k]
      if (typeof v === "string" && v.trim() && v.length <= 120) return v.trim()
    }
  }
  return ""
}

export async function renewSession(site, cookies, expires, { fetchImpl = fetch, wakeVm = true } = {}) {
  let cur = { ...(cookies || {}) }
  const exp = { ...(expires || {}) }
  const headers = {
    "user-agent": UA,
    origin: site,
    referer: `${site}/thread/new`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie: cookieHeader(cur),
  }
  let res
  try {
    res = await fetchImpl(`${site}/api/session`, { headers, redirect: "manual", signal: AbortSignal.timeout(12_000) })
  } catch (err) {
    throw new GenerationError(`/api/session 网络请求失败 (${err?.name || "Error"})；请检查网络或代理`)
  }
  if (res.status === 401) throw new AuthError("会话认证失败 (/api/session HTTP 401)，需要重新登录")
  if (res.status !== 200) {
    throw new GenerationError(res.status === 403
      ? "/api/session HTTP 403：访问被拒绝，请检查出口地区或代理；不能据此判定登录失效"
      : `/api/session HTTP ${res.status}：上游请求未成功`)
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new GenerationError("/api/session 返回的不是 JSON；会话状态未确认")
  }
  if (!body || body.status !== "assigned") {
    throw new GenerationError("/api/session 没有返回 assigned 会话；请在官网检查账号状态")
  }
  const set = parseSetCookies(typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [])
  cur = { ...cur, ...set.cookies }
  Object.assign(exp, set.exp)
  if (wakeVm && body.vm_id && body.vm_state !== "DISABLED") {
    try {
      await fetchImpl(`${site}/api/hatch/vm/wake`, {
        method: "POST",
        headers: { ...headers, cookie: cookieHeader(cur), "content-type": "application/json" },
        body: JSON.stringify({ vm_id: body.vm_id, retry_count: 0, connect_attempt_id: randomUUID() }),
        signal: AbortSignal.timeout(8000),
      })
    } catch {}
  }
  return {
    cookies: cur,
    cookies_exp: exp,
    label: labelOf(body),
    vm: typeof body.vm_id === "string" ? body.vm_id : "",
    vmState: typeof body.vm_state === "string" ? body.vm_state : "",
  }
}

// Settings → General → Usage, as the page draws it. Each meter is a progressbar whose
// aria-label names it and whose aria-valuenow is the percent used; the row beside it says when
// it resets or that it never expires, and what is left. Read by structure, not by language.
function usageOnPage() {
  const bars = [...document.querySelectorAll('[role="progressbar"][aria-valuenow]')]
  return bars.map((bar) => {
    const row = bar.parentElement
    const texts = row ? [...row.querySelectorAll('[data-slot="text"]')].map((e) => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean) : []
    return { name: bar.getAttribute("aria-label") || texts[0] || "", used: Number(bar.getAttribute("aria-valuenow")), texts }
  }).filter((m) => m.name && Number.isFinite(m.used))
}

// The settings button is the bottom one of the left rail, a menu that opens on a key press.
// The server's HTML already has it; it answers only once the page has hydrated.
function settingsButton() {
  const h = document.querySelector("[data-hatch-shell-hydration-state]")
  if (h && h.getAttribute("data-hatch-shell-hydration-state") !== "hydrated") return false
  const r = (e) => e.getBoundingClientRect()
  const rail = [...document.querySelectorAll("button, [role=button]")].filter((e) => e.offsetParent && r(e).left < 80 && r(e).width > 0)
  rail.sort((a, b) => r(b).top - r(a).top)
  if (!rail[0]) return false
  rail[0].focus()
  return true
}

// In that menu, Settings is the item with the "⌘," / "Ctrl+," shortcut.
function settingsItem() {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const it = items.find((e) => /,\s*$/.test((e.innerText || "").trim())) || items.find((e) => /设置|settings/i.test(e.innerText || ""))
  if (!it) return false
  it.focus()
  return true
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

// "每周限额将在 10月15日重置" / "Weekly limit resets Oct 15" → that day's local midnight, this
// year or the next; null when the line names no day.
export function resetDate(text, now = Date.now()) {
  const s = String(text || "")
  let m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  let month, day
  if (m) [month, day] = [Number(m[1]) - 1, Number(m[2])]
  else if ((m = s.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/)) && MONTHS.includes(m[1].toLowerCase())) [month, day] = [MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])]
  else if ((m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\b/)) && MONTHS.includes(m[2].toLowerCase())) [month, day] = [MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])]
  else return null
  const year = new Date(now).getFullYear()
  let at = new Date(year, month, day).getTime()
  if (at < now - 86_400_000) at = new Date(year + 1, month, day).getTime()
  return at
}

// The page's meters → Magpie's usage windows and plan name.
export function usageCard(meters, now = Date.now()) {
  const windows = []
  let plan = ""
  for (const m of meters || []) {
    const [, note = "", detail = ""] = m.texts || []
    const resets = resetDate(note, now)
    const left = detail.match(/[（(]([^）)]+)[）)]/)?.[1] || ""
    const weekly = /每周|weekly|week/i.test(note)
    const daily = /每日|每天|daily|day/i.test(note) && !weekly
    const extra = !resets && (/额外|extra|additional/i.test(m.name) || /不过期|never/i.test(note))
    if (!plan && resets) plan = m.name
    windows.push({
      name: weekly ? "每周" : daily ? "每日" : extra ? "额外额度" : m.name,
      used: Math.max(0, Math.min(100, m.used)),
      ...(resets ? { resetsAt: new Date(resets).toISOString() } : {}),
      ...(left ? { display: left } : {}),
    })
  }
  return { plan, windows }
}

const READY_JS = `(function(){
  if (document.readyState !== 'complete') return 'loading';
  if (!document.querySelector('textarea')) return 'no-ta';
  var h = document.querySelector('[data-hatch-shell-hydration-state]');
  if (h && h.getAttribute('data-hatch-shell-hydration-state') !== 'hydrated') return 'hydrating';
  var b = document.body ? (document.body.innerText || '') : '';
  if (b.indexOf('Connecting...') !== -1) return 'connecting';
  return 'ready';
})()`

const NEEDS_NAV_JS = (forChat) => `(function(forChat){
  var d = document.querySelector('[role="dialog"]');
  if (d) { var b = d.querySelector('button[aria-label*="close" i], button'); if (b) b.click(); }
  var scope = document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
  var bubbleCount = scope ? scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]').length : 0;
  var hasAtts = document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length > 0;
  var hasStop = !!(document.querySelector('[data-testid="hatch-composer-stop-button"]')
    || document.querySelector('button[aria-label*="Stop" i]')
    || document.querySelector('button[aria-label*="停止"]'));
  var bodyTxt = document.body ? (document.body.innerText || '') : '';
  var hasStuck = bodyTxt.indexOf('Still sending') !== -1 || bodyTxt.indexOf('Connecting...') !== -1;
  if (hasStop) return 'stop-button';
  if (hasStuck) return 'stuck';
  if (hasAtts) return 'attachments';
  if (forChat) return bubbleCount >= 24 ? 'long-thread' : '';
  return ((window.location.pathname !== '/thread/new') || bubbleCount > 0) ? 'not-new' : '';
})(${forChat ? "true" : "false"})`

const FRESH_JS = `(function(){
  return document.readyState === 'complete'
    && !!document.querySelector('textarea')
    && document.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]').length === 0;
})()`

const POLL_JS = `(function(){
  var els=[...document.querySelectorAll('*')].filter(function(e){
    var s=getComputedStyle(e);
    return (s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+100;});
  els.sort(function(a,b){return b.scrollHeight-a.scrollHeight;});
  if(els[0])els[0].scrollTop=els[0].scrollHeight;
  var scope=document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]')||document.body;
  var bs=[].slice.call(scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]'))
    .filter(function(b){return /hatch-agent-bubble-bg/.test(b.className||'');});
  // the reply is the bubble's .prose; suggested follow-up buttons sit beside it in the same bubble
  function said(b){var p=b.querySelectorAll('.prose');
    return (p.length?[].map.call(p,function(x){return x.innerText||'';}).join('\\n\\n'):(b.innerText||'')).trim();}
  var nonEmpty=bs.filter(function(b){return said(b).length>0;});
  var txt=nonEmpty.length?said(nonEmpty[nonEmpty.length-1]):'';
  var stop=!!(document.querySelector('[data-testid="hatch-composer-stop-button"]')
    ||document.querySelector('button[aria-label*="Stop" i]')
    ||document.querySelector('button[aria-label*="停止"]'));
  return JSON.stringify({cnt:nonEmpty.length,txt:txt,stop:stop});
})()`

const SETTER_JS = (text) => `(function(t){var ta=document.querySelector('textarea');
  if(!ta) return 0; ta.focus();
  var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
  s.call(ta,t);
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  ta.dispatchEvent(new Event('change',{bubbles:true}));
  return (ta.value||'').length;})(${JSON.stringify(text)})`

const SEND_BUTTON_JS = `(function(){var b=[...document.querySelectorAll('button,[role=button]')]
  .filter(function(x){return x.offsetParent!==null;})
  .find(function(x){return /发送|send/i.test(x.getAttribute('aria-label')||'')
    ||/发送|send/i.test(x.getAttribute('data-testid')||'')
    ||/send/i.test(x.innerText||'');});
  if(!b)return 'no-button'; if(b.disabled)return 'disabled'; b.click(); return 'clicked';})()`

const SIGNED_OUT = /log in|sign in|create an account|登录|use another account/

// The page's own text outside the conversation's bubbles: what muse.ai says, not the model.
const NOTICE_JS = `(function(){
  var t = document.body ? (document.body.innerText || '') : '';
  document.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]').forEach(function(b){
    var s = (b.innerText || '').trim(); if (s) t = t.split(s).join(' ');
  });
  return t.slice(-1500);
})()`
// muse.ai's own wording ("已用完使用额度" is its zh_CN string) and muse2api's list.
const QUOTA_SPENT = /已用完使用额度|额度不足|积分不足|达到上限|out of credits|usage limit|reached your (?:weekly )?limit|token limit/i
const WARM = "\u0000warm" // the spare tab a warm-up opens, handed to the next new conversation
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g
// a line that is so far only a list marker, heading mark or fence: the page may restyle it away
const UNSETTLED_TAIL = /(^|\n)[ \t]*(?:[-*+>#]+|\d+[.)]|`{1,3})?[ \t]*$/

// The next piece of a reply to stream, given what has been sent and the bubble's text now. The
// page restyles text while it streams (a "-" becomes a list item), so a bubble that no longer
// starts with what was sent gives only what lies past their common start, and one that shrank
// gives nothing until it grows past it. final: the reply is done; nothing is held back.
export function settle(sent, txt, final = false) {
  let t = txt.replace(ZERO_WIDTH, "")
  if (!final) {
    const m = t.match(UNSETTLED_TAIL)
    if (m) t = t.slice(0, m.index + m[1].length)
  }
  if (t.startsWith(sent)) return { delta: t.slice(sent.length), sent: t }
  if (t.length <= sent.length) return { delta: "", sent }
  let i = 0
  while (sent[i] === t[i]) i++
  return { delta: t.slice(i), sent: t }
}

const USAGE_RETRY_MS = 2 * 60_000
const VERIFY = "\u0000verify"
const VERIFY_PROMPT = "这是一条连通测试，请只回复：OK"

export class Muse {
  constructor({
    site = "https://muse.ai",
    executable,
    profileDir,
    headless = true,
    hidden = false,
    proxy = "",
    fetchImpl = fetch,
    firstTokenMs = 90_000,
    chatTimeoutMs = 300_000,
    loadMs = 30_000,
    maxTabs = 3,
    onCookies = () => {},
  }) {
    this.site = site.replace(/\/+$/, "")
    this.host = new URL(this.site).hostname
    this.opts = { executable, profileDir, headless, hidden, proxy }
    this.fetchImpl = fetchImpl
    this.firstTokenMs = firstTokenMs
    this.chatTimeoutMs = chatTimeoutMs
    this.loadMs = loadMs
    this.onCookies = onCookies
    this.maxTabs = maxTabs
    // account id → {contextId, tabs: Map(conversation → {page, used, at}), lastRenew, warming}
    this.accounts = new Map()
    // account id → {at, plan, windows}; survives the browser closing, read again when it runs
    this.usage = new Map()
    this.reading = new Map()
    // account id → when its last reading failed; a VM still connecting isn't asked every poll
    this.usageFailed = new Map()
    this.started = null
  }

  usageOf(accountId) {
    return this.usage.get(accountId) || null
  }

  // Reads the account's usage in a throwaway tab of its context, once at a time. Never starts
  // the browser or a context for it: an idle account keeps the last reading.
  readUsage(account, { maxAgeMs = 0 } = {}) {
    const a = this.accounts.get(account.id)
    const had = this.usage.get(account.id)
    if (had && Date.now() - had.at < maxAgeMs) return Promise.resolve(had)
    if (!this.started || !a?.contextId) return Promise.resolve(had || null)
    if (this.reading.has(account.id)) return this.reading.get(account.id)
    if (Date.now() - (this.usageFailed.get(account.id) || 0) < USAGE_RETRY_MS) return Promise.resolve(had || null)
    const run = this.openUsage(a).then((meters) => {
      if (!meters.length) throw new GenerationError("设置页的使用情况没有加载出来（账号的虚拟机可能还在预热）")
      const got = { at: Date.now(), ...usageCard(meters) }
      this.usage.set(account.id, got)
      this.usageFailed.delete(account.id)
      return got
    }).catch((err) => {
      this.usageFailed.set(account.id, Date.now())
      throw err
    }).finally(() => this.reading.delete(account.id))
    this.reading.set(account.id, run)
    return run
  }

  async openUsage(a) {
    const { browser, port } = await this.start()
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId: a.contextId, background: true })
    // a cold browser can take longer than 15 s to answer a navigation while it loads other tabs
    const page = await CDP.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, { timeoutMs: this.loadMs + 15_000 })
    const press = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) })
      }
    }
    const until = async (fn, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await page.js(`(${fn})()`).catch(() => false)) return true
        await sleep(250)
      }
      return false
    }
    try {
      await page.send("Page.enable")
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
      if (!(await until(settingsButton, this.loadMs))) throw new GenerationError("没有找到设置按钮")
      let open = false
      for (let i = 0; i < 3 && !open; i++) {
        await sleep(i ? 1000 : 600)
        await page.js(`(${settingsButton})()`).catch(() => false)
        await press()
        open = await until(settingsItem, 2500)
      }
      if (!open) throw new GenerationError("设置菜单没有打开")
      await press()
      // the meters come over the VM's connection: placeholders until it is up
      const shown = await until(() => document.querySelectorAll('[role="progressbar"][aria-valuenow]').length > 0, 20_000)
      return shown ? (await page.js(`(${usageOnPage})()`)) || [] : []
    } finally {
      page.close()
      await browser.send("Target.closeTarget", { targetId }).catch(() => {})
    }
  }

  start() {
    this.started ??= launchBrowser({ ...this.opts }).catch((err) => {
      this.started = null
      throw new GenerationError(`浏览器启动失败: ${err.message}`)
    })
    return this.started
  }

  async stop() {
    const running = await this.started?.catch(() => null)
    for (const a of this.accounts.values()) for (const t of a.tabs.values()) t.page.close()
    this.accounts.clear()
    this.started = null
    await running?.close()
  }

  // Whether the account has a page open in a running browser, and how many conversations.
  state(accountId) {
    const a = this.accounts.get(accountId)
    const tabs = a ? [...a.tabs.values()].filter((t) => !t.page.closed).length : 0
    return { ready: !!(this.started && a?.contextId && tabs), tabs }
  }

  acct(accountId) {
    let a = this.accounts.get(accountId)
    if (!a) {
      a = { contextId: null, tabs: new Map(), lastRenew: 0, warming: null }
      this.accounts.set(accountId, a)
    }
    return a
  }

  // Drops the account's whole browser context: its cookies, storage and every tab.
  async closeAccount(accountId) {
    const a = this.accounts.get(accountId)
    if (!a) return
    for (const t of a.tabs.values()) t.page.close()
    a.tabs.clear()
    if (a.contextId) {
      const { browser } = await this.start()
      await browser.send("Target.disposeBrowserContext", { browserContextId: a.contextId }).catch(() => {})
    }
    a.contextId = null
  }

  // Closes one conversation's tab; the account's context (and its VM connection) stays.
  async closeTab(accountId, key = "") {
    const a = this.accounts.get(accountId)
    const t = a?.tabs.get(key)
    if (!t) return
    a.tabs.delete(key)
    t.page.close()
    const { browser } = await this.start()
    await browser.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {})
  }

  async setCookies(browser, contextId, cookies, expires) {
    const now = Date.now() / 1000
    const secure = this.site.startsWith("https:")
    for (const [name, value] of Object.entries(cookies || {})) {
      if (!value) continue
      const e = Number(expires?.[name])
      const at = Number.isFinite(e) && e > now + 3600 ? e : now + 7 * 86400
      for (const domain of [`.${this.host}`, this.host]) {
        await browser.send("Storage.setCookies", {
          browserContextId: contextId,
          cookies: [{ name, value, domain, path: "/", secure, expires: at }],
        }).catch(() => {})
      }
    }
  }

  async waitReady(page, ms) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if ((await page.js(READY_JS).catch(() => "")) === "ready") return true
      await sleep(80)
    }
    return false
  }

  // The account's browser context, created once and kept: a fresh context has to handshake
  // with the VM again (tens of seconds), a new tab in a kept one is ready in about a second.
  // Cookies are renewed every 10 minutes and written into the context.
  async context(account) {
    const a = this.acct(account.id)
    const { browser } = await this.start()
    let { cookies, cookies_exp: exp } = account
    let renewed = false
    if (Date.now() - a.lastRenew > 600_000) {
      try {
        const r = await renewSession(this.site, cookies, exp, { fetchImpl: this.fetchImpl })
        cookies = r.cookies
        exp = r.cookies_exp
        a.lastRenew = Date.now()
        renewed = true
        this.onCookies(account.id, cookies, exp, r.vm)
      } catch (err) {
        if (err instanceof AuthError) {
          await this.closeAccount(account.id)
          throw err
        }
      }
    }
    if (!a.contextId) {
      const ctx = await browser.send("Target.createBrowserContext", { disposeOnDetach: false })
      a.contextId = ctx.browserContextId
      await this.setCookies(browser, a.contextId, cookies, exp)
    } else if (renewed) {
      await this.setCookies(browser, a.contextId, cookies, exp)
    }
    return a
  }

  async openTab(account, a) {
    const { browser, port } = await this.start()
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId: a.contextId })
    const page = await CDP.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, { timeoutMs: 180_000 })
    await page.send("Network.enable")
    await page.send("Page.enable")
    await page.send("Runtime.enable")
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})
    await page.send("Page.navigate", { url: `${this.site}/thread/new` })
    const end = Date.now() + this.loadMs
    while (Date.now() < end) {
      await sleep(150)
      if (await page.js("!!document.querySelector('textarea')").catch(() => false)) {
        await this.waitReady(page, 15_000)
        return { page, targetId, used: false, at: Date.now() }
      }
    }
    const body = String((await page.js("document.body ? document.body.innerText.slice(0,1200) : ''").catch(() => "")) || "").toLowerCase()
    page.close()
    await browser.send("Target.closeTarget", { targetId }).catch(() => {})
    if (SIGNED_OUT.test(body)) {
      await this.closeAccount(account.id)
      throw new AuthError("会话已被 muse.ai 登出，需要重新登录")
    }
    throw new GenerationError("muse.ai 页面加载超时（没出现聊天输入框）；未确认登录失效")
  }

  // The tab for one conversation of this account; each conversation keeps its own thread.
  // fresh: this conversation has nothing on the page yet.
  async tab(account, key = "") {
    const a = await this.context(account)
    let t = a.tabs.get(key)
    if (t && !t.page.closed && (await t.page.js("!!document.querySelector('textarea')").catch(() => false))) {
      t.at = Date.now()
      return { tab: t, fresh: !t.used, how: "kept" }
    }
    const lost = t ? (t.page.closed ? "lost:closed" : "lost:no-input") : ""
    if (t) await this.closeTab(account.id, key)
    const spare = a.tabs.get(WARM)
    let how = "new"
    if (spare && !spare.used && !spare.page.closed) {
      a.tabs.delete(WARM)
      t = spare
      how = "spare"
    } else {
      t = await this.openTab(account, a)
    }
    if (lost) how = `${how}(${lost})`
    t.at = Date.now()
    a.tabs.set(key, t)
    while (a.tabs.size > this.maxTabs) {
      const [oldest] = [...a.tabs].filter(([k]) => k !== key).sort((x, y) => x[1].at - y[1].at)[0]
      await this.closeTab(account.id, oldest)
    }
    return { tab: t, fresh: true, how }
  }

  // Moves the page to a new thread when it has to; returns why, or false.
  async resetThread(page, forChat) {
    try {
      const why = await page.js(NEEDS_NAV_JS(forChat))
      if (!why) return false
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
      const end = Date.now() + 10_000
      while (Date.now() < end) {
        await sleep(80)
        if (await page.js(FRESH_JS).catch(() => false)) break
      }
      await this.waitReady(page, 12_000)
      return why
    } catch {
      return false
    }
  }

  async send(page, prompt) {
    await page.js(`(function(){var ta=document.querySelector('textarea');if(ta){ta.scrollIntoView({block:'center',inline:'nearest'});ta.focus();}})()`).catch(() => {})
    await sleep(100)
    const rect = await page.js("(function(){var t=document.querySelector('textarea');if(!t)return null;var r=t.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()")
    if (!rect) throw new GenerationError("找不到聊天输入框")
    const c = JSON.parse(rect)
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 1 })
    }
    await sleep(100)
    const len = (await page.js(SETTER_JS(prompt))) || 0
    if (!len && prompt.length < 500) {
      await page.send("Input.insertText", { text: prompt })
      await page.js(SETTER_JS(prompt))
    }
    const end = Date.now() + 3000
    while (Date.now() < end) {
      if ((await page.js(SEND_BUTTON_JS)) === "clicked") {
        await sleep(300)
        return "clicked"
      }
      await sleep(80)
    }
    for (const modifiers of [1, 0]) {
      for (const type of ["keyDown", "char", "keyUp"]) {
        const params = { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers }
        if (type === "char") Object.assign(params, { text: "\r", unmodifiedText: "\r" })
        await page.send("Input.dispatchKeyEvent", params)
      }
      await sleep(1000)
      if (await page.js("!(document.querySelector('textarea')||{value:''}).value").catch(() => false)) return "enter-sent"
    }
    return "not-sent"
  }

  async poll(page) {
    try {
      const d = JSON.parse((await page.js(POLL_JS)) || "{}")
      return { cnt: Number(d.cnt) || 0, txt: String(d.txt || "").trim(), stop: !!d.stop }
    } catch {
      return { cnt: 0, txt: "", stop: false }
    }
  }

  // Renews the account's session over HTTP and wakes its VM without a page. A 200 from wake
  // only means muse.ai took the request (muse2api 1.6.1): the session is read again for the
  // VM's state, RUNNING being the only proof it is up.
  async keepAlive(account) {
    const r = await renewSession(this.site, account.cookies, account.cookies_exp, { fetchImpl: this.fetchImpl })
    this.onCookies(account.id, r.cookies, r.cookies_exp, r.vm)
    let vmState = r.vmState
    if (r.vm && vmState !== "RUNNING") {
      await sleep(3000)
      vmState = (await renewSession(this.site, r.cookies, r.cookies_exp, { fetchImpl: this.fetchImpl, wakeVm: false }).catch(() => null))?.vmState || vmState
    }
    return { vmState }
  }

  // Opens the account's chat page and wakes its VM ahead of the first message. A chat that
  // arrives meanwhile waits for this and then reuses the page.
  warm(account) {
    const a = this.acct(account.id)
    a.warming ??= (async () => {
      await this.context(account)
      if (![...a.tabs.values()].some((t) => !t.used && !t.page.closed)) a.tabs.set(WARM, await this.openTab(account, a))
      return true
    })().finally(() => { a.warming = null })
    return a.warming
  }

  // A sign-in counts once the account has answered: a short message in a tab of its own,
  // closed after the first text. Throws as chat does (AuthError, QuotaError, GenerationError).
  async verify(account) {
    try {
      for await (const delta of this.chat(account, { full: VERIFY_PROMPT, last: VERIFY_PROMPT, turns: 1 }, { conversation: VERIFY })) {
        if (delta.trim()) return
      }
      throw new GenerationError("测试消息没有得到回复")
    } finally {
      await this.closeTab(account.id, VERIFY).catch(() => {})
    }
  }

  // Yields text deltas for one conversation on the named account. prompt is {full, last}: last
  // is sent only when the caller says the conversation continues and its tab still holds it.
  // timing, when given, gets tabMs (getting the page ready) and firstMs (send → first text).
  async *chat(account, prompt, { conversation = "", continuing = false, signal, timing = {} } = {}) {
    const t0 = Date.now()
    await this.accounts.get(account.id)?.warming?.catch(() => {})
    const { tab, fresh, how } = await this.tab(account, conversation)
    timing.how = how
    const page = tab.page
    await page.send("Page.bringToFront").catch(() => {})
    const moved = await this.resetThread(page, true)
    if (moved) timing.how += `+reset(${moved})`
    const text = continuing && !fresh && !moved && prompt.last ? prompt.last : prompt.full
    timing.sent = text === prompt.full ? "full" : "last"
    tab.used = true
    timing.tabMs = Date.now() - t0
    const base = await this.poll(page)
    await this.send(page, text)
    const sentAt = Date.now()
    const deadline = sentAt + this.chatTimeoutMs
    const firstBy = Math.min(deadline, sentAt + this.firstTokenMs)
    let sent = ""
    let last = null
    let stable = 0
    let got = false
    let lastNotice = sentAt
    // the bubble's whole final text goes in timing.text: what was streamed may carry restyling
    const flush = () => {
      timing.text = (last || "").replace(ZERO_WIDTH, "")
      const next = settle(sent, last || "", true)
      sent = next.sent
      return next.delta
    }
    while (Date.now() < firstBy) {
      if (signal?.aborted) return
      await sleep(60)
      const { cnt, txt } = await this.poll(page)
      if (!txt || (cnt <= base.cnt && txt === base.txt)) {
        if (Date.now() - lastNotice > 2000) {
          lastNotice = Date.now()
          const notice = String((await page.js(NOTICE_JS).catch(() => "")) || "")
          if (QUOTA_SPENT.test(notice)) throw new QuotaError("muse.ai 说这个账号的使用额度用完了")
        }
        if (Date.now() - sentAt > 14_000) {
          const tail = String((await page.js("document.body.innerText.slice(-500)").catch(() => "")) || "")
          if (tail.includes("Still sending") || tail.includes("Connecting...")) throw new GenerationError("云端 VM 连接超时 (Still sending)")
        }
        continue
      }
      const { delta, sent: next } = settle(sent, txt)
      if (delta) {
        sent = next
        last = txt
        got = true
        timing.firstMs = Date.now() - sentAt
        yield delta
        break
      }
    }
    if (!got) {
      const body = String((await page.js("document.body.innerText").catch(() => "")) || "")
      if (/正在预热|warming up/i.test(body)) throw new GenerationError("muse.ai 这个账号的虚拟机还在预热，没有回答")
      throw new GenerationError("等待助手首字响应超时")
    }
    while (Date.now() < deadline) {
      if (signal?.aborted) return
      await sleep(60)
      const { txt, stop } = await this.poll(page)
      if (!txt) continue
      if (txt !== last) {
        const { delta, sent: next } = settle(sent, txt)
        sent = next
        if (delta) yield delta
        last = txt
        stable = 0
      } else {
        stable += 1
        if ((!stop && stable >= 3) || (stop && stable >= 80)) {
          const tail = flush()
          if (tail) yield tail
          return
        }
      }
    }
    throw new GenerationError("等待助手回复超时")
  }
}
