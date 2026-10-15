import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findBrowser, launchBrowser, sweepProfiles } from "../engine/browser.mjs"
import { Muse } from "../engine/muse.mjs"

const executable = findBrowser()

test("a browser left in the legacy profile cannot block a new engine", { skip: !executable, timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-recovery-"))
  const opts = { executable, profileDir: path.join(root, "browser"), headless: true, proxy: "direct" }
  let old, next
  const muse = new Muse({ ...opts, site: "http://127.0.0.1" })
  try {
    old = await launchBrowser(opts)
    next = await muse.start()
    assert.notEqual(next.profileDir, old.profileDir)
    assert.notEqual(next.proc.pid, old.proc.pid)
    assert.ok(await next.browser.send("Browser.getVersion"))
    // Recovery must neither kill another browser nor delete its singleton lock.
    assert.ok(await old.browser.send("Browser.getVersion"))
    await muse.stop()
    assert.equal(existsSync(next.profileDir), false)
  } finally {
    await muse.stop()
    await old?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("leftover temporary profiles are removed unless a live browser holds them", { skip: process.platform === "win32" && "symlinks need extra rights on Windows" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-sweep-"))
  const profile = (name, pid) => {
    const dir = path.join(root, name)
    mkdirSync(path.join(dir, "Default"), { recursive: true })
    if (pid) symlinkSync(`${os.hostname()}-${pid}`, path.join(dir, "SingletonLock"))
    return dir
  }
  try {
    const gone = profile("run-gone", 2_147_000_000)
    const unlocked = profile("run-unlocked")
    const live = profile("run-live", process.pid)
    const other = profile("legacy-keep")
    await sweepProfiles(root)
    assert.equal(existsSync(gone), false)
    assert.equal(existsSync(unlocked), false)
    assert.equal(existsSync(live), true)
    assert.equal(existsSync(other), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed spawn rejects and removes its temporary profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-spawn-"))
  try {
    await assert.rejects(launchBrowser({ executable: path.join(root, "missing-browser"), profileDir: root, temporary: true }), { code: "ENOENT" })
    assert.deepEqual(readdirSync(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
