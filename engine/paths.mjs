import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"

export const DEFAULT_PORT = 18611

export function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.MUSE_WEB_HOME) return env.MUSE_WEB_HOME
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "muse-web")
  if (platform === "win32") return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "muse-web")
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "muse-web")
}

export function enginePort(env = process.env) {
  const n = Number(env.MUSE_WEB_ENGINE_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

// Owner-only where the platform has modes; Windows keeps the user profile's own ACL.
export function writePrivate(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch {}
  renameSync(tmp, file)
}

export function engineKey(dir) {
  const file = path.join(dir, "engine.key")
  if (existsSync(file)) {
    const key = readFileSync(file, "utf8").trim()
    if (key) return key
  }
  const key = randomBytes(24).toString("hex")
  writePrivate(file, key + "\n")
  return key
}
