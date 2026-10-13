// Find and start a Chromium-family browser on macOS, Windows or Linux.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { CDP, httpJSON } from "./cdp.mjs"

export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const apps = [
      ["Google Chrome", "Google Chrome"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Chromium", "Chromium"],
      ["Brave Browser", "Brave Browser"],
    ]
    const roots = ["/Applications", path.join(env.HOME || "", "Applications")]
    return roots.flatMap((root) => apps.map(([app, bin]) => path.join(root, `${app}.app`, "Contents", "MacOS", bin)))
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)
    const rels = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ]
    return rels.flatMap((rel) => roots.map((root) => path.win32.join(root, ...rel)))
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]
  const dirs = (env.PATH || "/usr/bin:/usr/local/bin").split(path.delimiter).concat(["/usr/bin", "/snap/bin", "/opt/google/chrome"])
  return [...new Set(dirs)].flatMap((dir) => names.map((name) => path.join(dir, name))).concat(["/opt/google/chrome/chrome"])
}

export function findBrowser(env = process.env, platform = process.platform, exists = existsSync) {
  const own = (env.MUSE_WEB_CHROME || "").trim()
  if (own) return exists(own) ? own : null
  return browserCandidates(platform, env).find((p) => exists(p)) ?? null
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// proxy: "" leaves the browser on the system's own setting, "direct" ignores it, a URL forces it.
// hidden: a real window placed off-screen, for sites that treat headless differently.
export function browserArgs({ port, profileDir, headless, hidden = false, proxy, url = "about:blank" }) {
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,900",
    "--proxy-bypass-list=<-loopback>",
    // Cookies go in and out through CDP, so the profile needs no OS keychain; without these
    // macOS asks for one (and shows "keychain not found" under a HOME that has none).
    "--use-mock-keychain",
    "--password-store=basic",
  ]
  if (headless) args.push("--headless=new", "--disable-gpu")
  else if (hidden) args.push("--window-position=-32000,-32000")
  if (proxy === "direct") args.push("--no-proxy-server")
  else if (proxy) args.push(`--proxy-server=${proxy}`)
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox")
  args.push(url)
  return args
}

export async function launchBrowser({ executable, profileDir, headless = true, hidden = false, proxy = "", url, port, waitMs = 30_000 }) {
  if (!executable) throw new Error("没找到 Chrome、Edge 或 Chromium；装一个，或用 MUSE_WEB_CHROME 指定路径")
  mkdirSync(profileDir, { recursive: true })
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(path.join(profileDir, lock), { force: true })
  }
  port ??= await freePort()
  const proc = spawn(executable, browserArgs({ port, profileDir, headless, hidden, proxy, url }), {
    stdio: "ignore",
    windowsHide: headless || hidden,
  })
  let exited = false
  proc.on("exit", () => { exited = true })
  const started = Date.now()
  let last = null
  while (Date.now() - started < waitMs) {
    if (exited) throw new Error("browser exited during start")
    try {
      const v = await httpJSON(`http://127.0.0.1:${port}/json/version`, 1500)
      if (v?.webSocketDebuggerUrl) {
        const browser = await CDP.connect(v.webSocketDebuggerUrl)
        return { proc, port, browser, close: () => stopBrowser(proc, browser) }
      }
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  stopBrowser(proc)
  throw new Error(`browser did not open its debugging port: ${last?.message ?? "timeout"}`)
}

// Resolves once the process is gone: asked politely first, killed after 3 s.
export function stopBrowser(proc, browser) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  const gone = new Promise((resolve) => proc.once("exit", resolve))
  try {
    browser?.send("Browser.close", {}, 3000).catch(() => {})
  } catch {}
  const kill = setTimeout(() => {
    try { proc.kill() } catch {}
  }, 3000)
  return gone.finally(() => clearTimeout(kill))
}
