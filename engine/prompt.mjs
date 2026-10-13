// An OpenAI messages array → the text typed into the web page.
// full: system text and every turn, for a page that has none of this conversation yet.
// last: the final user message, for a page that already holds the earlier turns.

import { callsAsText } from "./tools.mjs"

export class PromptError extends Error {}

const TEXT_PARTS = new Set(["text", "input_text", "output_text"])
// The page takes text only: an image or file is named in place, so the rest of the message still goes.
const OTHER_PARTS = { image_url: "[图片]", input_image: "[图片]", image: "[图片]", file: "[文件]", input_file: "[文件]", input_audio: "[音频]" }

function text(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new PromptError("unsupported message content")
  return content.map((item) => {
    if (typeof item === "string") return item
    if (!item || typeof item !== "object") throw new PromptError("unsupported message content")
    const type = item.type || "text"
    if (TEXT_PARTS.has(type)) return item.text || ""
    return OTHER_PARTS[type] ?? `[${type}]`
  }).join("")
}

export function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new PromptError("messages is empty")
  const system = []
  const turns = []
  const toolNames = new Map()
  for (const message of messages) {
    if (!message || typeof message !== "object") throw new PromptError("unsupported message")
    const role = String(message.role || "").trim().toLowerCase()
    let body = text(message.content).trim()
    // The page has no tools: calls are written as the tags the model is asked for, results as text.
    if (role === "tool") {
      const name = toolNames.get(message.tool_call_id)
      if (body) turns.push(["user", `【工具执行结果${name ? `：${name}` : ""}】\n${body}`])
      continue
    }
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const c of message.tool_calls) if (c?.id) toolNames.set(c.id, c.function?.name || c.name || "")
      body = [body, callsAsText(message.tool_calls)].filter(Boolean).join("\n")
    }
    if (!body) continue
    // Codex's sandbox name reads as a request for full access, which the model tends to refuse.
    if (role === "system" || role === "developer") system.push(body.replaceAll("danger-full-access", "standard-workspace-access"))
    else turns.push([role, body])
  }
  if (!system.length && !turns.length) throw new PromptError("messages is empty")
  const final = turns.at(-1)
  const last = final && final[0] !== "assistant" ? final[1] : ""
  if (!system.length && turns.length === 1 && turns[0][0] === "user") return { full: turns[0][1], last, turns: 1 }
  const blocks = []
  if (system.length) blocks.push("背景与任务设定：\n" + system.join("\n\n"))
  for (const [role, body] of turns) blocks.push(`${role === "assistant" ? "助手" : "用户"}：\n${body}`)
  return { full: blocks.join("\n\n"), last, turns: turns.length }
}
