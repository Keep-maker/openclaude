# Agent 配置与使用说明

适用源码：`Keep-maker/openclaude`，基线提交 `cb06ba81e400f11f404d978e621792543ead758a`（2026-09-05）；本交付补充了容器运行支持。先阅读本篇，再阅读 [Docker Compose 部署指南](02-Docker-Compose部署.md)。

## 1. 项目定位与调用链

openclaude 是 Claude Code 的模型网关。真正读取文件、执行终端命令、编辑代码的 Agent 是运行在开发机上的 Claude Code，openclaude 不执行这些工具，也不托管工作区或 Agent 会话。

```text
Claude Code / 自建 Messages API Agent
  → openclaude 的 Anthropic Messages 接口
    → claude：Anthropic 协议与客户端鉴权转发
    → ollama-local / ollama-cloud：Ollama Anthropic 兼容接口
    → agnes / 自定义 provider：转换成 OpenAI Chat Completions
```

- HTTP 请求中的 `model` 决定 provider；前缀取配置中最长匹配项。
- `ollama-local:qwen2.5-coder:7b` → provider 为 `ollama-local`，上游模型为 `qwen2.5-coder:7b`。
- 没有已配置 provider 前缀时，整个字符串交给 `defaultProvider`。拼错前缀可能被当作默认 provider 的模型名，不一定返回“未知 provider”。
- `claude-ol-agnes:agnes-2.5-flash` 是模型发现接口生成的兼容 ID，可直接使用。`claude-ol-` 只是发现包装，并不表示请求会发给 Anthropic。

该 fork 已包含 Agnes/OpenAI-compatible 适配。npm 元数据仍指向 `@aliildan/openclaude` 上游，直接安装 npm 公共包不能保证包含这个 fork 的补丁；请从本源码安装。

## 2. 环境准备与本机快速启动

### 前置条件

- 源码声明 Node.js ≥20；本次容器验证使用 Node.js 22.23.2。
- Claude Code 命令 `claude` 已安装并可由 PATH 找到。仓库 README 声明需要 ≥2.1.129；版本相关能力以安装版本的 `claude --help` 和官方文档为准。
- 走 Anthropic 订阅时，先直接启动 `claude` 完成登录。仅使用第三方 provider 的 HTTP 客户端不需要 Anthropic OAuth。
- 可选 Ollama ≥0.14，模型需支持预期的工具调用；有图片任务时，还需相应视觉能力。模型标签与实际可用性以你的后端为准。
- 项目只有 Node 标准库依赖，没有数据库、Redis、前端或编译步骤。

```bash
git clone https://github.com/Keep-maker/openclaude.git
cd openclaude
# 将本交付修改应用到源码后执行；从交付目录使用则无需重新克隆。
npm install -g .
oc help
```

不想全局安装时，CLI 也可通过 `node bin/openclaude help` 调用。

先用 `oc status` 生成默认配置，再编辑用户目录下的配置文件；已有配置请合并 provider，不要直接覆盖个人设置。

```bash
oc status
# 可选：已有 Ollama 服务时
ollama pull qwen2.5-coder:7b
oc list
oc start
```

Ollama 未作为服务启动时，在另一个终端运行 `ollama serve`。无需为了使用 Agnes 而启动 Ollama；启动提示“未发现 Ollama 模型”不代表 Agnes 不可用。

PowerShell 设置 Agnes Key：

```powershell
$env:AGNES_API_KEY = '替换为你的实际密钥'
oc start --model agnes:agnes-2.5-flash
```

Linux/macOS：

```bash
export AGNES_API_KEY='替换为你的实际密钥'
oc start --model agnes:agnes-2.5-flash
```

上述 provider 必须先加入配置。若路由守护进程已在运行，新终端设置的 Key 不会进入旧进程：先 `oc stop`，再从设置好环境变量的终端 `oc start`。

## 3. 配置文件与目录

| 内容 | 默认位置 / 作用 |
|---|---|
| 路由配置 | Linux/macOS：`~/.openclaude/config.json`；Windows：`%USERPROFILE%\.openclaude\config.json` |
| 自定义配置目录 | `OPENCLAUDE_HOME`，目录内文件名仍为 `config.json`；不是配置文件路径 |
| 守护进程状态 | 上述目录的 `router.pid`、`router.log` |
| 模型状态记录 | 上述目录的 `subagent-active`、`internal-classifier-active`，仅辅助 CLI 展示 |
| OAuth 来源 | `OPENCLAUDE_OAUTH_TOKEN` → macOS Keychain → `~/.claude/.credentials.json` |
| 自动生成的斜杠命令 | `~/.claude/commands/model-subagent.md`、`model-internal-classifier.md`，已有文件不会覆盖 |
| 流调试日志 | 固定在用户 home 下的 `~/.openclaude/stream-debug.log`，不跟随 `OPENCLAUDE_HOME` |

路由器逐请求重读 JSON。改 provider 地址、模型清单通常下一次请求生效；JSON 解析失败时会记录错误并继续使用上一份有效配置。首次启动的无效 JSON 会导致启动失败。监听地址/端口变更要重启。子 Agent 与 classifier 的选择由客户端启动时读取，必须重启 Claude Code 会话。

加载逻辑是顶层默认值合并，以及按 provider 名称合并；同名 provider 对象整体替换，不做其字段的递归合并。因此覆盖 `ollama-local` 时应写全 `type` 和 `baseUrl`。从文件省略默认 provider 不会删除它；当前没有 `enabled:false` 开关。

### 完整本机配置示例

```json
{
  "port": 11436,
  "defaultProvider": "claude",
  "providers": {
    "claude": {
      "type": "anthropic-passthrough",
      "baseUrl": "https://api.anthropic.com"
    },
    "ollama-local": {
      "type": "ollama",
      "baseUrl": "http://127.0.0.1:11434"
    },
    "ollama-cloud": {
      "type": "ollama",
      "baseUrl": "https://ollama.com",
      "apiKey": "$OLLAMA_API_KEY"
    },
    "agnes": {
      "type": "openai-compatible",
      "baseUrl": "https://api.agnes-ai.cn/v1",
      "apiKey": "${AGNES_API_KEY}",
      "chatPath": "chat/completions",
      "timeoutMs": 60000,
      "models": [
        { "id": "agnes-2.5-flash", "display_name": "Agnes 2.5 Flash", "description": "Agnes 模型" },
        "agnes-2.0-flash"
      ],
      "requestDefaults": { "temperature": 0 }
    }
  }
}
```

Agnes 地址和模型来自仓库示例，并未用真实账号验证当前可用性。对接自己的 OpenAI-compatible 服务时，把 provider 名称、`baseUrl`、Key 变量名和模型列表换成实际值。

| 字段 | 说明 |
|---|---|
| `port` | 默认 11436；本机 daemon 以此端口启动 |
| `defaultProvider` | 不带已知前缀的模型路由目的地，通常保留 `claude` |
| `providers.<名称>.type` | 只支持 `anthropic-passthrough`、`ollama`、`openai-compatible` |
| `baseUrl` | Anthropic/Ollama 通常填服务根地址；OpenAI-compatible 填含 `/v1` 的 API 根地址 |
| `apiKey` | Ollama/OpenAI-compatible 上游密钥模板；不用于鉴别访问路由器的客户端 |
| `chatPath` | OpenAI-compatible 专用，默认 `chat/completions`；与 `baseUrl` 拼接，避免重复 `/v1` |
| `models` | OpenAI-compatible 专用发现列表，可为字符串或含 `id/display_name/description` 的对象；不是访问白名单 |
| `headers` | OpenAI-compatible 专用自定义请求头，值支持环境变量；同名头会覆盖默认头 |
| `timeoutMs` | OpenAI-compatible 等待响应头的超时，默认 60000；不限制后续流总时长 |
| `requestDefaults` | OpenAI-compatible 额外请求字段，最后合并；除了 `model/messages`，可覆盖客户端字段，应谨慎使用 |
| `subagentModel` | 由 `oc start` 写入客户端 `CLAUDE_CODE_SUBAGENT_MODEL`，不是服务端按角色自动分流规则 |
| `internalClassifierModel` | 由 `oc start` 写入客户端 `ANTHROPIC_DEFAULT_HAIKU_MODEL`，建议保留默认 |

插值支持 `$NAME` / `${NAME}`，变量名区分大小写，缺失值替换为空字符串。只有代码明确调用插值的 `apiKey` 和 OpenAI-compatible `headers` 支持它；`baseUrl`、`models`、`port` 不支持。Node 本机启动不会自动读取 `.env`。

OpenAI-compatible 未写 `apiKey` 时，发送推理请求会默认读取 `$AGNES_API_KEY`；空 Key 不支持免鉴权上游。若本地兼容服务接受任意 Bearer，可显式配置其允许的占位值。Anthropic passthrough 不读取 provider 的 `apiKey`，而是转发客户端请求头。

## 4. 环境变量速查

### 路由进程读取

| 变量 | 默认 / 用途 |
|---|---|
| `OPENCLAUDE_HOME` | `~/.openclaude`，配置和本机 daemon 状态目录 |
| `OPENCLAUDE_PORT` | **前台入口**覆盖 JSON 端口；`oc start` 的 daemon 会用 JSON `port` 重设它 |
| `OPENCLAUDE_HOST` | **本次新增**，本机默认 `127.0.0.1`；容器设为 `0.0.0.0` |
| `AGNES_API_KEY` | 示例第三方 Key；仅使用对应 provider 时必需 |
| `OLLAMA_API_KEY` | Ollama Cloud Key；本地 Ollama 通常不需要 |
| `OPENCLAUDE_OAUTH_TOKEN` | 可选显式 OAuth access token，优先级最高；不会自动刷新，也不检查该显式值的有效期 |
| `OPENCLAUDE_DISABLE_KEYCHAIN` | `1` 禁止 Keychain 查询；容器已设置 |
| `OPENCLAUDE_QUIET` | 任意非空值抑制路由通用日志；`0` 也会生效，不覆盖所有 provider 日志 |
| `OPENCLAUDE_DEBUG_STREAM` | 严格等于 `1` 时记录上游和修复后 SSE；可能包含完整提示词、代码和工具参数 |

### 本机启动器 / Claude Code 读取

| 变量 | 作用 |
|---|---|
| `OPENCLAUDE_BRIDGE=aggressive` | 额外将 Sonnet、Opus 别名绑定到 Ollama |
| `OPENCLAUDE_DEBUG` | 非空时输出 CLI 异常栈 |
| `ANTHROPIC_BASE_URL` | Claude Code 访问的网关根 URL；`oc start` 自动设置，本机直连容器时手动设置 |
| `ANTHROPIC_AUTH_TOKEN` | Claude Code 发出的 Bearer；发现模式下启动器强制替换为固定 sentinel |
| `ANTHROPIC_API_KEY` | API Key 接入 Anthropic 时由客户端提供；路由器只转发收到的 `x-api-key`，不会自动把容器同名环境变量变成上游鉴权 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` 启用网关模型发现；`oc start` 默认设置 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子 Agent 模型，客户端启动时读取 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku / 内部任务模型，影响安全分类等后台任务 |
| `ANTHROPIC_CUSTOM_MODEL_OPTION*` | 启动器设置 Custom 模型 ID、名称、描述 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL*` / `ANTHROPIC_DEFAULT_OPUS_MODEL*` | aggressive 模式下的模型 ID、名称、描述 |

把 `subagentModel` / `internalClassifierModel` 从配置删掉，不一定清除你原先手工设置的同名客户端环境变量；先从 shell 中移除相关覆盖，再重启会话。`--no-discovery` 只是不主动注入变量，也不会清理父 shell 里已有的 sentinel 或发现变量。

## 5. CLI 与典型工作流

| 命令 | 用途 |
|---|---|
| `oc help` / `oc --help` | 命令帮助；`openclaude` 与 `oc` 等价 |
| `oc start` | 启动/复用后台 router，再启动前台 Claude Code；退出 Claude Code 后 router 通常仍运行 |
| `oc start --no-discovery` | 不注入发现用 sentinel；适合优先保留原登录行为 |
| `oc start --bridge=aggressive` | 用前两个 Ollama 模型绑定 Sonnet/Opus，第三个绑定 Custom |
| `oc status` | 本机 PID 状态、配置和模型覆盖信息；不是 Docker 容器状态查询 |
| `oc stop` | 终止本机 daemon；不管理 Docker 容器 |
| `oc list` | 只枚举 `ollama-local` 的 `/api/tags`，不列 Agnes 或所有 provider |
| `oc model-subagent` | 交互式选择菜单；非 TTY 下只展示，不阻塞等待 |
| `oc model-subagent 1` | 保存当前菜单第 1 项，下次会话生效；索引随模型列表变化 |
| `oc model-subagent default` | 删除配置覆盖；`0` 等价 |
| `oc internal-classifier` / `oc internal-classifier default` | 查看/恢复 classifier 覆盖 |
| `npm start` | **本次新增脚本**：仅前台 router，适合进程管理器或开发调试 |

`oc start --bridge=conservative` 是识别的参数，但当前代码中环境变量 `OPENCLAUDE_BRIDGE=aggressive` 仍会优先生效；需要保守模式时先清除该环境变量。

启动器仅过滤三个自有 bridge/discovery 参数，其余参数原样交给 `claude`。虽然旧帮助展示 `-- claude args`，当前实现不会移除独立的 `--` 分隔符。建议直接写：

```bash
oc start --model agnes:agnes-2.5-flash
oc start --no-discovery --model ollama-local:qwen2.5-coder:7b
oc start --model agnes:agnes-2.5-flash -p '用中文解释当前目录的项目结构'
```

`--model`、`-p/--print`、`--output-format json` 属于 Claude Code，具体组合以 `claude --help` 为准。CLI 非交互模式的参数说明可参考 [Claude Code CLI 文档](https://code.claude.com/docs/en/cli-reference)。

### 会话内切换模型

```text
/model
/model agnes:agnes-2.5-flash
/model ollama-local:qwen2.5-coder:7b
/model sonnet
```

保留 Anthropic 作为主模型、让 Ollama 处理子任务：

```bash
oc model-subagent qwen2.5-coder:7b
oc start
```

选择器只接受菜单中的本地 Ollama 模型和硬编码 Anthropic 选项，不接受任意 Agnes 名称。要用 Agnes 处理子任务，在 JSON 顶层添加：

```json
"subagentModel": "agnes:agnes-2.5-flash"
```

然后退出并重新 `oc start`。当前校验只验证 `ollama-local` 模型是否安装，对其他 provider 不验证服务可用性。`oc status` 的 active 文件是单份共享记录，且选择命令会提前更新该文件，因此不能据它证明已有会话已切换成功；以重启后启动输出和实际请求为准。

### 发现与登录行为

默认发现模式设置 `ANTHROPIC_AUTH_TOKEN=oc-discovery-sentinel-do-not-store`。当请求到 Anthropic provider 时，router 将这个特殊 Bearer 换成读取到的 OAuth；发给 Ollama/Agnes 则使用该 provider 自己的 Key。

sentinel 是固定的公开标记，不是密码，不能用于保护公网服务。旧凭据文件/Keychain 中过期的 token 会被忽略；router 自己不会刷新它。没有 OAuth 时，启动器会警告，但这不一定影响已经正确设置 Key 的 Agnes 请求。

仓库启动器注明发现模式会影响 Remote Control、`/schedule`、claude.ai MCP connectors、notification preferences；这是版本相关的上游行为，不能把发现模式等同于保留所有订阅功能。优先保持原登录路径时用 `--no-discovery`，并确认父环境没有遗留发现变量。

## 6. AI Agent 通过 HTTP 正确交互

这是 **Anthropic Messages 入口**，不是 OpenAI `/v1/chat/completions` 服务，也不是 MCP Server。客户端应使用以下接口：

| 方法与路径 | 作用 |
|---|---|
| `GET /openclaude/status` | 进程存活与 provider 名称；不检测 Key、模型或上游可用性 |
| `GET /v1/models` 或 `/models` | 可发现模型；OpenAI-compatible 来自配置，Ollama 来自 `/api/tags` |
| `POST /v1/messages` | 完整聊天历史、模型、工具定义；支持 `stream` |
| `POST /v1/messages/count_tokens` | 相同模型路由；OpenAI-compatible 本地估算，其他 provider 转发，Ollama 可能不支持 |
| `HEAD /` / `GET /` | 可达性探测 |

发现列表不会列出所有 Anthropic 模型，也不代表模型已授权或能够推理。Ollama 的发现请求当前不附带 provider Key；要求鉴权的 `/api/tags` 可能发现为空，但已知模型 ID 的推理仍可能成功。`models` 配置也不限制用户直接请求其他模型。

### 最小调用示例

以下 Bash/curl 示例假定路由器进程已经配置好 Agnes Key；不需要把 Agnes Key 再发给本地路由器。

```bash
curl --fail-with-body http://127.0.0.1:11436/openclaude/status
curl --fail-with-body http://127.0.0.1:11436/v1/models
curl --fail-with-body http://127.0.0.1:11436/v1/messages \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"agnes:agnes-2.5-flash","max_tokens":256,"stream":false,"messages":[{"role":"user","content":"用中文介绍你能完成的任务"}]}'
```

PowerShell 原生请求：

```powershell
$body = @{
  model = 'agnes:agnes-2.5-flash'
  max_tokens = 256
  stream = $false
  messages = @(@{ role = 'user'; content = '你好，请用中文回复' })
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11436/v1/messages' `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

直接调用 Anthropic provider 则必须提供有效的客户端 Bearer 或 `x-api-key`。不要把 Agnes Key 当作 Anthropic Key，也不要把它当成本地入口鉴权。

### 工具调用闭环

1. Agent 发送 `tools`：每项包含 `name`、`description`、`input_schema`。
2. 收到 assistant 的 `content`，完整保存，并查看 `stop_reason`。
3. 若为 `tool_use`，提取每个 block 的 `id/name/input`；由客户端校验权限、参数和执行环境，再执行工具。
4. 把 assistant 原始 `content` 加入历史；随后在一个 user 消息中为所有工具 ID 返回对应 `tool_result`。
5. 连同完整历史继续请求；直到 `end_turn`。达到 `max_tokens` 或轮次上限应明确报告截断，不能当作任务完成。

示意历史片段：

```json
[
  { "role": "user", "content": "计算 2 加 3" },
  { "role": "assistant", "content": [
    { "type": "tool_use", "id": "toolu_1", "name": "add", "input": { "a": 2, "b": 3 } }
  ] },
  { "role": "user", "content": [
    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "5" }
  ] }
]
```

工具失败时，返回带 `is_error:true` 的 `tool_result`，不要伪造成功。多个 tool_use 必须逐一匹配 ID。openclaude 会清洗不合法 ID、修补悬空结果；客户端仍应保留完整配对，不能依赖修补代替协议正确性。

### SSE 与重试

- 使用支持 Anthropic SSE 的解析器，按空行分隔事件；一个 TCP chunk 可能只有半个 UTF-8 字符或多个事件，不能按网络 chunk 直接解析 JSON。
- 遵循 `message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`；以 block 的 index 关联内容。
- OpenAI-compatible 的工具参数先缓冲，结束后串行输出完整工具 block，所以暂时看不到参数不一定表示卡死。
- HTTP 200 的流内也可能出现 `error`；没有成功结束事件、流中断或终止错误均不能报告成功。
- 400 优先修请求；401 检查对应 provider Key/OAuth；429 做有上限的指数退避并参考上游 `Retry-After`（若返回）；502/504 检查网络与上游，有限重试。
- 客户端要设自己的总请求期限和最大工具轮次。已执行的写文件、发消息等工具具有副作用，不能因网络重试再次无条件执行；由客户端按会话与工具调用 ID 去重。

## 7. 注意事项、排错与最佳实践

| 现象 | 检查 / 处理 |
|---|---|
| `claude` 无法启动 | `claude --version`、PATH；没有安装 CLI 时只能运行 router 或自建 HTTP 客户端 |
| 没有 Agnes 模型 | 是否在正确 config 中配置 `models`；router 进程能否读取 Key；是否启用发现；用 `/v1/models` 查看实际返回 |
| 修改 Key 仍然 401 | 本机重启 daemon；Compose 修改 `.env` 后用 `up -d --force-recreate router`，单纯 `restart` 不更新环境 |
| Anthropic 401 | 是否发出了 sentinel、router 是否有可读取且有效的 OAuth；默认 Docker 方案不携带宿主凭据 |
| `Content block not found` | 临时启用流调试，先小规模验证串行工具，再验证并行工具；日志分享前去掉代码和敏感内容 |
| `/compact` 或 token 统计异常 | 兼容 provider 的 token 数是估算；Ollama 可能没有 count_tokens 接口 |
| 图片消失 | Ollama 路径会按模型能力剥离不支持的图片；兼容网关是否支持视觉需自行验证 |
| `default is temporarily unavailable` | 检查 aggressive/Haiku/classifier 覆盖，先恢复 Anthropic 默认后台模型 |
| 容器健康但推理失败 | 健康检查只证明 router 进程可达；再检查实际模型、网络、Key 和响应 |

推荐让主会话保留质量稳定的模型，先把范围清楚的代码阅读任务交给较小模型；使用工具任务前验证 JSON 参数、工具结果回放与取消行为。不要为了降低开销直接改安全分类器。

项目没有入口认证、请求体大小上限、租户隔离、服务端限流、Key 池、自动故障切换或对话持久化。适合可信单用户/小范围网络内使用。远程连接优先 SSH 隧道；确需共享时，应在入口增加 TLS、身份验证、请求大小和并发限制，并为 SSE 关闭反向代理缓冲。

## 8. 可交给 AI Agent 的操作约定

项目根目录另附 [AGENTS.md](../AGENTS.md)。在其他项目使用时可复用以下约定：

```text
你通过 openclaude 使用模型，工具执行仍由 Claude Code/客户端负责。
先检查 /openclaude/status，再读取 /v1/models；只使用已确认的 provider:model ID。
遵守实际执行环境与用户授权，不把模型输出直接交给 shell 执行。
不要输出、读取展示或提交 .env、OAuth 文件、API Key 和完整流调试日志。
本机 daemon 用 oc 管理；Compose 容器用 docker compose 管理，避免双启动抢占端口。
只有 oc start 会把 JSON 中的 subagentModel 转成客户端环境变量；直接连接容器时在启动 claude 前设置。
正确配对 tool_use/tool_result，保留 ID，校验工具参数，限制重试与最大轮次。
禁止把 HTTP 200、进程健康或模型出现在列表中当作任务完成证据。
代码变更后执行适当测试，说明使用的是模拟上游还是真实账号。
```

## 9. 实现依据

主要依据是该基线的 `src/router/config.js`、`index.js`、`auth.js`、`provider/*.js`、`src/cli/commands/start.js`、`model-selector.js`，而不是仅凭旧 README 推断。协议适配细节见 [仓库中文 README](../README_zh-CN.md)，Claude Code 网关接入概念见 [官方网关说明](https://code.claude.com/docs/en/llm-gateway)。本交付验证结果另见 [验证记录](03-验证记录.md)。
