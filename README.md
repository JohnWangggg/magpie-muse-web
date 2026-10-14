<p align="center"><img src="icon.svg" width="72" height="72" alt=""></p>

<h1 align="center">magpie-muse-web</h1>

<p align="center">
  把 <a href="https://muse.ai">muse.ai</a> 的网页账号接进 <a href="https://github.com/yetone/magpie">Magpie</a>：
  每个账号在浏览器窗口里登录一次，就能在 Codex、OpenCode 等 Agent 里用 Muse Spark，
  支持工具调用，并在额度卡片上看到每个账号的用量。
</p>

<p align="center">
  Provider id：<code>muse-web</code> · 模型：<code>muse-web/muse-spark</code> · macOS / Windows / Linux · MIT
</p>

---

muse.ai 没有公开 API。这个插件自带一个本机引擎，用一个无头 Chrome 打开 muse.ai 的聊天页，
把 Magpie 发来的 Chat Completions 请求变成网页上的一条消息，再把回复流式送回去。

登录多个账号后，选哪个账号、忙时换号、失败重试都交给 Magpie 自己的调度；引擎只执行被点名的那一个账号。

## 环境要求

- [Magpie](https://github.com/yetone/magpie)，在 0.1.1223 上验证过。
- 本机装有 Chrome、Edge、Chromium 或 Brave 中的任意一个。不用另装 Node 或 Python，引擎用 Magpie 自带的 Bun 运行。
- 能访问 muse.ai 的网络。需要代理时见[设置](#设置)。

## 安装

```sh
magpie plugin add github:JohnWangggg/magpie-muse-web
magpie plugin login muse-web
```

也可以在 Magpie 的插件页添加 `github:JohnWangggg/magpie-muse-web`，然后在账号页登录 `muse-web`。
想登录多个账号，就多登录几次。

更新用 `magpie plugin update`；卸载用 `magpie plugin rm`，后面跟 `magpie plugin list` 里显示的名字。
卸载不会删除引擎的数据目录（见[登录信息存在哪](#登录信息存在哪)），不再使用时可以手动删掉。

想跑本地副本：

```sh
git clone https://github.com/JohnWangggg/magpie-muse-web.git
magpie plugin add ./magpie-muse-web
```

## 在 Agent 里使用

```sh
magpie codex muse-web/muse-spark       # 让 Codex 用 Muse Spark
magpie opencode muse-web/muse-spark    # 让 OpenCode 用 Muse Spark
magpie provider test muse-web          # 发一条真实的小请求，检查整条链路
```

也可以在 Magpie 配置的任何 Agent 里选 `muse-web/muse-spark`。Agent 的请求经 Magpie 网关分到各个账号。

插件按 OpenCode 插件规范编写。不经过 Magpie、直接装进 OpenCode 的用法还没有实测；
多账号调度和额度卡片是 Magpie 的功能，OpenCode 自己只保存一个登录。

## 和 muse2api 方案怎么选

[muse2api](https://github.com/czg86389-hub/muse2api) 是一个独立运行的 muse.ai 转 API 服务，
[magpie-muse2api-plugin](https://github.com/d0nkey8urger-bot/magpie-muse2api-plugin) 把它接进 Magpie。两者的区别：

| | magpie-muse-web | muse2api + 插件 |
|---|---|---|
| Magpie 里看到的 | 每个 muse.ai 账号单独一个 | 一个 key，账号池在 muse2api 里 |
| 选号、换号 | Magpie 按账号调度 | muse2api 自己调度 |
| 额度卡片 | 每个账号的每周用量和重置时间 | 账号池里有几个可用 |
| 运行依赖 | 只要一个浏览器 | Docker 或 Python，外加浏览器 |
| 后台进程 | 跟着 Magpie 走，闲置时关浏览器 | 常驻服务，Magpie 关掉后还在 |
| 工具调用 | 支持 | muse2api 默认关闭 |
| 生图、生视频、给其他工具用 | 不支持 | 支持 |

只在 Magpie 里用、想让 Magpie 管理多个账号，选这个插件；要生图生视频，或者要给 Magpie 以外的工具一个统一的 API，选 muse2api。
两者的 provider id 不同（`muse-web` 和 `muse2api`），可以同时安装。

## 登录

- **muse.ai（浏览器登录）**：弹出一个独立的浏览器窗口打开 muse.ai，照常登录即可，什么都不用复制。
  登录后引擎会打开一次聊天页领取会话，然后关掉窗口，再发一条很短的测试消息：
  账号真的能回答，才算登录成功。账号额度已用完的也算成功，只是暂时用不了。
  账号默认以登录时间命名，例如「muse.ai 2026-10-13 14:03 登录」。
  15 分钟内没登录完，这次登录作废，并说明卡在哪一步。
- **引擎账号 ID（高级）**：自己另外运行引擎（`MUSE_WEB_ENGINE`）时，填引擎给出的账号 ID。

测试消息会在 muse.ai 的对话记录里留下一条“连通测试”。

再登录一次同一个 muse.ai 账号，会更新原来那个账号（按 muse.ai 给每个账号分配的虚拟机 ID 识别），
名字和位置都不变，不会多出一个。

没有桌面的 Linux 打不开登录窗口，插件会直接说明。

### 登录信息存在哪

Magpie 里只存引擎账号 ID，cookie 留在引擎的数据目录里，文件只有当前用户可读：

| 系统 | 数据目录 |
|---|---|
| macOS | `~/Library/Application Support/muse-web` |
| Windows | `%APPDATA%\muse-web` |
| Linux | `$XDG_DATA_HOME/muse-web`，默认 `~/.local/share/muse-web` |

目录里有 `accounts.json`（账号和 cookie）、`engine.key`（Magpie 访问引擎用的密钥）、
`engine.log`（请求日志，超过 5 MB 轮转）和浏览器配置。日志不记录对话内容和 cookie。

Magpie 在会话到期前 10 分钟自动续期；续不上时额度卡片显示「已过期」，重新登录即可。

## 对话

请求走 OpenAI 兼容的 Chat Completions，流式和非流式都支持。

- 每个账号在浏览器里只开一个页面，一直连着 muse.ai 的虚拟机。每个 Magpie 会话对应 muse.ai 的一个对话，切换会话就在这个页面里跳到对应的对话，不重新加载，约 0.5 秒。
- 同一会话继续聊时回到它的对话，只发最新一条消息。新会话、页面卡住或对话太长时开新对话，把整段历史一次发过去。
- 一个账号同时只回答一条（`maxConcurrency: 1`），忙时返回 429，由 Magpie 换账号。
- 页面提示额度用完（「已用完使用额度」等）时立刻返回 429，不用等首字超时。只看页面自己的提示，模型回答里出现这些字不算。
- 登录失效返回 401，Magpie 会提示重新登录。
- 只发文本：消息里的图片、文件换成「[图片]」「[文件]」字样，其余内容照常发送。
- 页面在回答下方显示的“建议回复”按钮不算回答内容。

### 工具调用

muse.ai 的网页没有工具接口，而且它的助手自带云端虚拟机，默认会在自己的虚拟机里执行命令，而不是请求你的电脑。
插件这样处理：

1. 请求带 `tools` 时，把工具列表写进提示词，并明确告诉模型：用户的文件和命令行在用户自己的电脑上，它的虚拟机碰不到；
2. 要求模型把工具调用写成 `tool_call` 代码块，里面是 `{"name": ..., "arguments": ...}`。
   必须用代码块，因为页面会按 Markdown 渲染回答，代码块外的反斜杠、星号和尖括号标签会被改掉；
3. 引擎从回答里解析出调用，只认请求里真有的工具名，作为标准的 `tool_calls` 返回，`finish_reason` 是 `tool_calls`；
4. 工具结果和历史里的工具调用以同样的格式写回提示词。

流式回答里，正文按整行发出；从可能是工具调用的位置起先压住，回答结束后再发剩余正文和 `tool_calls`。

这是靠提示词实现的，不是原生的函数调用：模型偶尔不按格式回答，或者不调用工具，直接让你自己去运行命令。
这时就当成普通文本回答返回。`tool_choice` 为 `none` 时不写工具说明；为 `required` 或指定工具时，提示词会要求模型必须调用。

## 模型

| 模型 | 输入 / 输出 | 上下文 | 工具调用 | 费用 |
|---|---|---|---|---|
| `muse-spark` | 文本 / 文本 | 按 128K 声明，输出 16K | 支持（见上） | 记为 0 |

muse.ai 没有公开上下文上限。按 128K 声明，是为了让客户端在对话过长前自己压缩。

## 额度卡片

额度取自 muse.ai 自己的「设置 → 使用情况」：引擎在账号的浏览器里开一个临时标签页读取，读完就关。

- **每周**：方案的每周限额用了多少，什么时候重置。
- **额外额度**：额外额度用了多少、还剩多少（例如「剩余 10 亿个词元」）。
- **状态**：`免费版 · 已就绪`，也可能是 `正在回答`，或 `闲置，下一条约需 30 秒唤醒`。

引擎预热后读一次；每次回答结束后最多每 2 分钟读一次；卡片数据超过 30 分钟也会重读。
账号的虚拟机还在预热时读不到数据，2 分钟后再试。浏览器因闲置关掉后，不会为了读额度把它重新打开，卡片显示上一次的读数。

## 速度

- 账号页面已连上时，不管是新会话还是继续旧会话，准备页面约 0.5 秒，首字通常 2～5 秒，主要是 muse.ai 自己生成的时间。
- 只有打开页面时要连 muse.ai 的虚拟机，约 10～20 秒：引擎刚启动、浏览器闲置后被关掉、页面卡住需要重新加载时。
- 闲置超过 60 分钟，引擎会关掉浏览器省资源（`MUSE_WEB_IDLE_MIN` 可调长）。
- Magpie 加载插件时就启动引擎；引擎启动和每次登录后都会预热各账号，第一条消息不用等冷启动。
- 引擎每 30 分钟检查一次：超过 6 小时没被唤醒的账号，会续一次会话并唤醒它的虚拟机。这不计入使用，也不会推迟浏览器的闲置关闭。

## 设置

都是可选的环境变量，在启动 Magpie 的环境里设置：

| 变量 | 作用 | 默认 |
|---|---|---|
| `MUSE_WEB_PROXY` | 代理地址，或 `direct` 表示直连 | 依次用 `https_proxy` 等环境变量、系统代理，都没有就直连 |
| `MUSE_WEB_BROWSER` | `headless`、`hidden`（窗口放到屏幕外）或 `show` | `headless` |
| `MUSE_WEB_CHROME` | 浏览器可执行文件路径 | 自动查找 |
| `MUSE_WEB_IDLE_MIN` | 闲置多少分钟后关浏览器 | `60` |
| `MUSE_WEB_PREWARM` | 设为 `0` 时不预热 | 预热 |
| `MUSE_WEB_VERIFY_LOGIN` | 设为 `0` 时登录后不发测试消息 | 发送 |
| `MUSE_WEB_ENGINE_PORT` | 引擎端口 | `18611` |
| `MUSE_WEB_HOME` | 数据目录 | 见上表 |
| `MUSE_WEB_ENGINE` | 改用自己运行的引擎地址，插件不再自己启动引擎 | 插件自带 |

## 排查问题

先看数据目录里的 `engine.log`。每条请求一行，写明用了哪个账号、页面是复用（`kept`）还是新开（`new`）、是回到旧对话（`back`）还是开新对话（`new-thread`）、发了整段历史还是最新一条、首字用时；
带工具的请求还会写 `tools=2→shell`（请求里有 2 个工具，模型调用了 shell）或 `tools=2→text`（模型直接用文字回答）。

| 现象 | 原因和处理 |
|---|---|
| 卡片显示「已过期」或请求返回 401 | 会话失效，重新登录该账号 |
| 一直返回 429 | 账号正忙，或额度已用完，看卡片上的每周用量 |
| 首字等了很久，提示虚拟机正在预热 | muse.ai 那边的虚拟机还没就绪，稍后再试 |
| 卡片上没有百分比 | 虚拟机还在连接，2 分钟后自动重读 |
| 登录失败：「已登录，但账号没有回答测试消息」 | 会话拿到了但对话不通，常见于虚拟机还在预热，稍后重新登录 |
| Agent 说它看不到你的文件，或让你自己运行命令 | 模型这次没按工具格式回答，重试或换种说法；日志里会是 `tools=…→text` |
| 连不上 muse.ai | 检查网络，或用 `MUSE_WEB_PROXY` 指定代理 |

## 不支持

- 把图片、文件真正传给 muse.ai，以及生图、生视频。
- 账号密码登录：只支持在浏览器窗口里登录。
- Responses、Messages 接口：引擎只提供 Chat Completions，Agent 的其他接口由 Magpie 转换。

## 开发

```sh
npm test    # 插件契约 + 引擎测试；引擎测试用真实无头 Chrome 对着本机的仿 muse.ai 页面
```

没装浏览器时，用到浏览器的测试会自动跳过。Linux 环境可以用 Docker 跑：

```sh
docker build -t magpie-muse-web-linux-test test/linux
docker run --rm -v "$PWD:/plugin:ro" -w /plugin magpie-muse-web-linux-test node --test contract.test.mjs "test/*.test.mjs"
```

代码结构：

| 文件 | 内容 |
|---|---|
| `index.mjs` | Magpie / OpenCode 插件：登录方式、续期、额度卡片、启动引擎 |
| `engine/main.mjs` | 引擎入口：登录后的测试消息、预热、保活、闲置关浏览器 |
| `engine/server.mjs` | 引擎的 HTTP 接口（对话、登录、续期、额度） |
| `engine/muse.mjs` | 浏览器里的 muse.ai 页面操作 |
| `engine/tools.mjs` | 工具调用：提示词和解析 |
| `engine/prompt.mjs` | 把对话历史拼成发到页面的文本 |
| `engine/login.mjs` | 浏览器登录窗口 |
| `engine/store.mjs` | 账号存储 |

## 致谢

页面操作逻辑移植自 [muse2api](https://github.com/czg86389-hub/muse2api)（MIT），许可证见 [LICENSE](LICENSE)。
登录后发测试消息的做法参考了 [magpie-muse2api-plugin](https://github.com/d0nkey8urger-bot/magpie-muse2api-plugin)。

## 声明

这是非官方的社区插件，和 muse.ai、Magpie 都没有关联。它通过 muse.ai 的网页会话工作，
muse.ai 改版后可能失效；请遵守 muse.ai 的服务条款，账号使用风险由使用者自己承担。

## English

An unofficial [Magpie](https://github.com/yetone/magpie) provider plugin for muse.ai.
Sign in to each muse.ai account in a browser window; Magpie then chats with Muse Spark
(`muse-web/muse-spark`) through a headless Chrome the plugin's local engine drives,
schedules requests across the accounts, and shows each account's weekly usage on its card.
Tool calls are supported through the prompt: the model writes them in `tool_call` code blocks,
which come back as standard `tool_calls`. Install with
`magpie plugin add github:JohnWangggg/magpie-muse-web`, then `magpie plugin login muse-web`.
Needs Chrome, Edge, Chromium or Brave. Text only. MIT licensed.
