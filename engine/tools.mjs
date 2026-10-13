// Tool calling over a web chat that has none. The request's tools are described in the prompt and
// the model asks for one in a tool_call code block, which is parsed back into OpenAI tool_calls.
// muse.ai's assistant runs commands in its own cloud VM, so the prompt has to say plainly that the
// user's machine is not that VM; told only "you may call these tools", it answers from its own.
// The reply is read as rendered: outside a code block markdown eats backslashes, asterisks and
// anything shaped like an HTML tag, so a call written there arrives broken.

const ARGS_IN_HISTORY = 1500

// [{name, description, parameters}] from Chat Completions tools ({type:"function", function})
// and Responses-style ones ({type:"function", name, parameters}). Other kinds are left out.
export function functions(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .map((t) => (t && typeof t === "object" ? (t.function && typeof t.function === "object" ? t.function : t) : null))
    .filter((f) => f && typeof f.name === "string" && f.name && (f.type === undefined || f.type === "function" || f.parameters))
    .map((f) => ({ name: f.name, description: String(f.description || "").trim(), parameters: f.parameters }))
}

// The function tool_choice names, "none", "required", or "" (the model decides).
function choice(toolChoice) {
  if (toolChoice === "none" || toolChoice === "required") return toolChoice
  if (toolChoice && typeof toolChoice === "object") return toolChoice.function?.name || toolChoice.name || ""
  return ""
}

function typeOf(spec) {
  if (!spec || typeof spec !== "object") return "any"
  if (Array.isArray(spec.enum)) return spec.enum.map((v) => JSON.stringify(v)).join(" | ")
  if (spec.type === "array") return `array<${typeOf(spec.items)}>`
  return Array.isArray(spec.type) ? spec.type.join(" | ") : spec.type || (spec.properties ? "object" : "any")
}

function params(schema, indent = "   ") {
  const props = schema && typeof schema === "object" ? schema.properties : null
  if (!props || !Object.keys(props).length) return `${indent}（无参数）`
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(props).map(([name, spec]) => {
    const desc = spec && typeof spec === "object" && spec.description ? ` ${String(spec.description).trim()}` : ""
    const line = `${indent}- ${name} (${typeOf(spec)}, ${required.has(name) ? "必填" : "可选"})${desc}`
    const inner = spec?.type === "object" ? spec : spec?.type === "array" && spec.items?.type === "object" ? spec.items : null
    return inner?.properties ? `${line}\n${params(inner, indent + "  ")}` : line
  }).join("\n")
}

// The protocol appended to a whole conversation; "" when there are no tools or tool_choice is "none".
export function toolsPrompt(tools, toolChoice) {
  const list = functions(tools)
  const pick = choice(toolChoice)
  if (!list.length || pick === "none") return ""
  const lines = [
    "【客户端工具说明】",
    "这段对话来自用户本机的一个客户端。用户的文件、项目和命令行都在他自己的电脑上，不在你的工作环境里；你自己的沙箱、虚拟机和内置工具碰不到用户的电脑，所以不要用它们来查看或修改用户的文件、运行用户的命令。",
    "客户端可以替你在用户电脑上执行下面这些工具。需要时输出一个 tool_call 代码块，块里只有一个 JSON 对象，客户端执行后会把结果发回给你：",
    "```tool_call",
    '{"name": "工具名", "arguments": {参数}}',
    "```",
    "一次需要多个就输出多个代码块。工具调用一定要放在代码块里，参数必须是合法 JSON，按下面每个工具的参数说明填写。不需要工具时直接用自然语言回答。",
    "不要让用户自己去运行命令、复制粘贴结果：需要用户电脑上的什么信息或操作，就直接调用工具。",
  ]
  if (pick === "required") lines.push("这一轮必须至少调用一个工具。")
  else if (pick) lines.push(`这一轮必须调用工具 ${pick}。`)
  lines.push("", "可用工具：")
  list.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.name}${f.description ? ` — ${f.description}` : ""}`, "   参数：", params(f.parameters, "   "))
  })
  return lines.join("\n")
}

// Appended to a message sent into a conversation that already holds the protocol.
export const TOOLS_REMINDER = "（用户电脑上的操作仍然用 tool_call 代码块请求客户端执行。）"

// An assistant turn's tool calls as the code blocks the model is asked to write.
export function callsAsText(toolCalls) {
  return toolCalls.map((c) => {
    const name = c?.function?.name || c?.name || ""
    let args = c?.function?.arguments ?? c?.arguments ?? "{}"
    if (typeof args !== "string") args = JSON.stringify(args)
    if (args.length > ARGS_IN_HISTORY) args = args.slice(0, ARGS_IN_HISTORY) + "…（已截断）"
    return "```tool_call\n" + `{"name": ${JSON.stringify(name)}, "arguments": ${args}}` + "\n```"
  }).join("\n")
}

const TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
const FENCE = /```(?:tool_call|json|JSON)?\s*([\s\S]*?)```/g

function asCall(obj, names) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const name = obj.name || obj.tool || obj.function?.name
  if (typeof name !== "string" || !names.has(name)) return null
  let args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.function?.arguments ?? {}
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  return { name, arguments: JSON.stringify(args) }
}

function parseJSON(raw) {
  const body = raw.trim().replace(/^```(?:tool_call|json|JSON)?\s*/, "").replace(/\s*```$/, "")
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

// Each top-level {...} in text that parses as JSON, with where it lies.
function bareObjects(text) {
  const found = []
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0
    let inString = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (ch === "\\") j++
        else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}" && --depth === 0) {
        try {
          found.push({ start: i, end: j + 1, value: JSON.parse(text.slice(i, j + 1)) })
          i = j
        } catch {}
        break
      }
    }
  }
  return found
}

// {calls: [{name, arguments}], content} from a reply. Only names among the request's tools count,
// so a reply that merely shows some JSON stays text. <tool_call> tags first; failing those, a
// ```json block holding a call (or an array of them), the shape muse2api asks for; failing those,
// a bare {"name", "arguments"} object: muse.ai's renderer drops a tag it takes for HTML.
export function parseToolCalls(text, tools) {
  const names = new Set(functions(tools).map((f) => f.name))
  const calls = []
  let content = text
  for (const m of text.matchAll(TAG)) {
    const parsed = parseJSON(m[1])
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = asCall(item, names)
      if (call) calls.push(call)
    }
  }
  if (calls.length) content = text.replace(TAG, "")
  else {
    for (const m of text.matchAll(FENCE)) {
      const parsed = parseJSON(m[1])
      const found = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => asCall(item, names))
      if (found.length && found.every(Boolean)) {
        calls.push(...found)
        content = content.replace(m[0], "")
      }
    }
  }
  if (!calls.length) {
    const bare = bareObjects(text).filter((o) => o.value && ("arguments" in o.value || "parameters" in o.value) && asCall(o.value, names))
    for (const o of bare.reverse()) {
      calls.unshift(asCall(o.value, names))
      content = content.slice(0, o.start) + content.slice(o.end)
    }
  }
  if (calls.length) content = stripLabels(content)
  return { calls, content: content.replace(/\n{3,}/g, "\n\n").trim() }
}

// A rendered code block leaves its language label and copy button behind as lines of their own.
export function stripLabels(text) {
  return text.replace(/^[ \t]*(?:tool_call|json|JSON|复制|复制代码|Copy|Copy code)[ \t]*(?:\n|$)/gm, "")
}
