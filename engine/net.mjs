// One proxy decision for both the browser and the engine's own requests:
// MUSE_WEB_PROXY ("direct" or a URL) → the proxy Magpie passes in → the OS proxy → direct.
import { execFileSync } from "node:child_process"

const ENV_NAMES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]

function asUrl(value) {
  const v = String(value || "").trim()
  if (!v) return ""
  return /^[a-z][\w+.-]*:\/\//i.test(v) ? v : `http://${v}`
}

export function parseScutil(out) {
  const get = (k) => (String(out).match(new RegExp(`\\b${k}\\s*:\\s*(\\S+)`)) || [])[1]
  for (const kind of ["HTTPS", "HTTP"]) {
    if (get(`${kind}Enable`) === "1" && get(`${kind}Proxy`)) return `http://${get(`${kind}Proxy`)}:${get(`${kind}Port`) || 80}`
  }
  if (get("SOCKSEnable") === "1" && get("SOCKSProxy")) return `socks5://${get("SOCKSProxy")}:${get("SOCKSPort") || 1080}`
  return ""
}

// Windows "ProxyServer" is either host:port or "http=h:p;https=h:p;socks=h:p".
export function parseWinProxy(enable, server) {
  if (!/0x1\b/.test(String(enable)) || !server) return ""
  const s = String(server).trim()
  if (!s.includes("=")) return asUrl(s)
  const parts = Object.fromEntries(s.split(";").map((p) => p.split("=").map((x) => x.trim())))
  if (parts.https) return asUrl(parts.https)
  if (parts.http) return asUrl(parts.http)
  if (parts.socks) return `socks5://${parts.socks}`
  return ""
}

export function systemProxy(platform = process.platform, run = execFileSync) {
  try {
    if (platform === "darwin") return parseScutil(run("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 }))
    if (platform === "win32") {
      const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
      const q = (v) => {
        const out = run("reg", ["query", key, "/v", v], { encoding: "utf8", timeout: 3000, windowsHide: true })
        return (String(out).match(new RegExp(`${v}\\s+REG_\\w+\\s+(.+)`)) || [])[1]?.trim() || ""
      }
      return parseWinProxy(q("ProxyEnable"), q("ProxyServer"))
    }
  } catch {}
  return ""
}

// Returns "direct" or a proxy URL.
export function resolveProxy(env = process.env, platform = process.platform, run = execFileSync) {
  const own = String(env.MUSE_WEB_PROXY || "").trim()
  if (own) return own === "direct" ? "direct" : asUrl(own)
  for (const name of ENV_NAMES) {
    const v = asUrl(env[name])
    if (v) return v
  }
  return systemProxy(platform, run) || "direct"
}

// fetch that goes through the same proxy. Bun takes it per request; Node reads it from the
// environment when started with NODE_USE_ENV_PROXY=1 (the plugin starts the engine that way).
export function proxiedFetch(proxy, base = globalThis.fetch) {
  if (!proxy || proxy === "direct" || typeof globalThis.Bun === "undefined") return base
  return (url, init = {}) => base(url, { ...init, proxy })
}
