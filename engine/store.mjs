// Accounts kept by the engine: handle → {cookies, cookies_exp}. Cookies never leave this file
// except into that account's own browser context and muse.ai requests.
import { existsSync, readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { expiryMs } from "./muse.mjs"
import { writePrivate } from "./paths.mjs"

export class Store {
  constructor(file) {
    this.file = file
    this.accounts = {}
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"))
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.accounts = raw
    }
  }

  get(handle) {
    const item = this.accounts[handle]
    return item?.cookies ? { id: handle, label: item.label || "", cookies: item.cookies, cookies_exp: item.cookies_exp || {} } : null
  }

  handles() {
    return Object.keys(this.accounts)
  }

  count() {
    return Object.keys(this.accounts).length
  }

  save() {
    writePrivate(this.file, JSON.stringify(this.accounts, null, 2) + "\n")
  }

  // label: what Magpie shows for the account; the sign-in time when muse.ai names no one.
  // vm: muse.ai's id for the account's VM, one per account. Signing in again to an account
  // already here renews that one, under its handle and name, rather than adding another.
  add(cookies, exp, label = "", vm = "") {
    const known = vm && Object.keys(this.accounts).find((h) => this.accounts[h].vm === vm)
    if (known) {
      this.accounts[known] = { ...this.accounts[known], cookies, cookies_exp: exp || {} }
      this.save()
      return { handle: known, expires: expiryMs(exp), label: this.accounts[known].label, again: true }
    }
    const handle = `muse-${randomBytes(6).toString("hex")}`
    const created = Date.now()
    const name = label || `muse.ai ${new Date(created).toLocaleString("sv-SE").slice(0, 16)} 登录`
    this.accounts[handle] = { cookies, cookies_exp: exp || {}, label: name, created, ...(vm ? { vm } : {}) }
    this.save()
    return { handle, expires: expiryMs(exp), label: name }
  }

  update(handle, cookies, exp, vm = "") {
    if (!this.accounts[handle]) return
    this.accounts[handle] = { ...this.accounts[handle], cookies, cookies_exp: exp || {}, ...(vm ? { vm } : {}) }
    this.save()
  }

  remove(handle) {
    if (!this.accounts[handle]) return
    delete this.accounts[handle]
    this.save()
  }
}
