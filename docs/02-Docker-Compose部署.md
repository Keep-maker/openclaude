# Docker Compose 文件与部署指南

前篇：[Agent 配置与使用说明](01-Agent配置与使用.md)。本篇针对交付目录内已经修改的源码；远端 GitHub 尚未推送这些文件，重新克隆原仓库不会自动得到本次改造。

## 1. 结构、依赖与方案选择

```text
bin/openclaude                 CLI 命令入口
src/cli/                      本机 daemon、Claude Code 启动与模型选择
src/router/                   HTTP 路由、OAuth、协议转换与 SSE 修复
test/                         Node 内置测试，模拟上游
Dockerfile                    单阶段运行镜像
docker-compose.yml            默认 router + 可选 Ollama profile
docker-compose.dev.yml        源码只读挂载与 Node watch
.env.example                  Compose 环境变量模板
docker/config/config.json     容器配置，目录只读挂载
docs/                         完整中文文档和验证记录
AGENTS.md                     面向 AI Agent 的项目说明
```

运行依赖仅为 Node.js 标准库，无 `dependencies/devDependencies`、lockfile、数据库或编译产物。构建镜像只复制所需源码，不运行 `npm install`、`npm ci` 或全局安装公共 npm 包，因此不会意外丢失 fork 的 Agnes 适配。

可选方案比较：

| 方案 | 适用情形 | 取舍 |
|---|---|---|
| **router 入容器，Claude Code 留在开发机（本交付）** | 已有 Claude Code 登录与本机工作区 | 配置少，工具访问仍在本机；容器凭据与客户端凭据需要明确区分 |
| router + Ollama 同一 Compose | 部署机器有模型推理资源 | 服务名连接、模型卷持久化；模型下载与内存需求额外计算 |
| Claude Code 也放入容器 | 必须隔离工具执行的环境 | 还要管理 Claude Code 安装、登录、用户 ID 和项目挂载；当前需求无需引入 |

没有编译产物可从 builder 阶段筛选，多阶段构建在这里不会带来实际收益，故使用单阶段镜像。Node 镜像按本次实际验证摘要固定；Ollama 固定版本标签，可在生产进一步换成你审核过的摘要。

## 2. 已落实的代码调整

1. `src/router/index.js` 增加 `OPENCLAUDE_HOST`：本机默认仍为 `127.0.0.1`，容器设为 `0.0.0.0`，解决映射端口无法连接的问题。
2. 前台入口用 `pathToFileURL()` 判断当前模块，兼容 Windows 路径。Linux 云测试已运行，Windows 前台执行尚未实测。
3. 前台进程处理 SIGTERM/SIGINT：停止接受新连接，最多等待 10 秒完成请求；超时以非零状态退出。Compose 给出 15 秒停止宽限期。超长推理在更新部署时仍可能被中断。
4. `npm start` 提供纯 router 前台入口；增加监听/停止回归测试，并纳入完整 `npm test`。
5. `.gitignore` 忽略私有 `.env`；`.dockerignore` 采用构建文件白名单。

Compose 中 Node 直接作为应用进程运行，由 Docker init 转发信号、Compose 管理重启。不要用 `oc start` 做容器 CMD：它会后台启动 router，并尝试执行容器里没有安装的 `claude`。

## 3. 前置条件

- Docker Engine ≥20.10（使用 `host-gateway`）；生产优先选择仍受维护的 Docker 版本。
- Docker Compose v2；本次验证使用独立命令 `docker-compose` v2.29.7。如果系统提供 `docker compose` 插件，使用下文命令即可；只有独立命令时，将下文 `docker compose` 替换为 `docker-compose`。
- Windows/macOS 可使用提供 Linux 容器的 Docker Desktop。Node 和 Claude Code 只需安装在实际运行客户端的电脑上，单纯运行 router 的服务器无需安装它们。
- 网络可访问选用的镜像仓库和上游 API。镜像拉取失败时使用你已配置并信任的镜像加速器，不要删除已有配置。

## 4. 默认部署：只启动 router

在交付的源码根目录执行：

```bash
cp .env.example .env
# 编辑 .env：例如填写 AGNES_API_KEY；不使用的 Key 保持为空。
# 编辑 docker/config/config.json：核对 API 地址和模型名称。
docker compose config --quiet
docker compose up -d --build router
docker compose ps
docker compose logs --tail=100 router
curl --fail-with-body http://127.0.0.1:11436/openclaude/status
```

PowerShell 文件复制与探活：

```powershell
Copy-Item .env.example .env
docker compose config --quiet
docker compose up -d --build router
Invoke-RestMethod 'http://127.0.0.1:11436/openclaude/status'
```

已有 `.env` 时直接编辑，不要覆盖现有密钥。默认返回类似：

```json
{"ok":true,"providers":["claude","ollama-local","ollama-cloud","agnes"]}
```

这只说明进程可达，provider 列表包含默认/配置项，不证明任何账号或模型可用。没有设置 Key、没有启动 Ollama 时，router 仍可健康运行；需要按前篇示例发起真实模型请求验证你选择的后端。

### 配置与网络说明

- 默认服务只有 router；不会启动或下载 Ollama 模型。
- 容器内部地址 `0.0.0.0:11436`，宿主机只发布 `127.0.0.1:11436`。改宿主机端口请设置 `.env` 中的 `OPENCLAUDE_PUBLISH_PORT`，不要只改 JSON `port`；Compose 已固定内部端口。
- `./docker/config` 整个目录只读挂载到 `/etc/openclaude`，便于编辑器原子替换文件后让下一请求读到新配置。该目录必须存在，文件需让容器 UID 1000 可读；推荐非敏感模板目录 755、JSON 644。
- 配置 JSON 只保存 Key 的环境变量模板。它也被复制进镜像作为独立 `docker run` 的默认值，**不要在此文件写真实 Key**。
- router 是无状态服务，不需要数据卷；流调试目录用 16 MiB tmpfs，可写但重建丢失；stdout/stderr 由 Docker 轮转日志收集。
- `backend` 是项目隔离的 bridge 网络。需要访问外部 API，故不设置 `internal:true`。只将受信任服务接入该网络。
- router 删除所有 capabilities、启用 `no-new-privileges`、只读根文件系统、以 `node` 用户运行，内存限制 512 MiB。它会缓冲请求与部分工具调用，高并发或大上下文需要实测和入口限制。

`.env` 用于 Compose 插值，不会自动把所有字段传入容器。本文件明确传入 `AGNES_API_KEY/OLLAMA_API_KEY` 等变量；新增 `MY_PROVIDER_KEY` 时，还需要在 `router.environment` 中加入 `MY_PROVIDER_KEY: ${MY_PROVIDER_KEY:-}`。同名 shell 变量可能覆盖 `.env`，参见 [Docker 环境变量优先级](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/)。`docker compose config` 会展开密钥，排错时优先使用 `config --quiet`，不要分享展开后的内容。

## 5. 让宿主机 Claude Code 连接容器

### A. 保留宿主机 Anthropic 登录，按名称切换第三方模型

默认方案不把个人 OAuth 凭据复制进镜像或容器。先在宿主机正常登录 `claude`，再在一个干净的终端中：

```bash
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
export ANTHROPIC_BASE_URL=http://127.0.0.1:11436
claude
```

PowerShell：

```powershell
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:11436'
claude
```

这里清除的是当前 shell 的覆盖，适用于订阅 OAuth 工作流。使用 Anthropic API Key 的用户应保留自己的 `ANTHROPIC_API_KEY`。router 会转发客户端实际发出的鉴权头，第三方 provider 则使用容器里的独立 Key。此流程按项目的 passthrough 机制配置，尚未在本次沙箱用真实 Claude Code 登录验证；安装版本若改变第三方网关鉴权行为，以实际请求和官方文档为准。

会话中使用 `/model agnes:agnes-2.5-flash` 或 `/model ollama-local:<实际模型>`。不要再执行 `oc start`，因为它会尝试创建本机 daemon，与容器抢占端口。诊断容器用 `docker compose ps/logs` 和 HTTP 状态接口。

### B. 只用第三方模型，并启用发现

把 Key 保存在服务器 `.env` 后，在客户端设置固定占位 Bearer 来启用发现：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:11436
export ANTHROPIC_AUTH_TOKEN=oc-discovery-sentinel-do-not-store
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
export CLAUDE_CODE_SUBAGENT_MODEL=agnes:agnes-2.5-flash
# 仅在不使用 Anthropic 且验证过替代模型后，显式替换后台 Haiku 路径。
export ANTHROPIC_DEFAULT_HAIKU_MODEL=agnes:agnes-2.5-flash
claude --model agnes:agnes-2.5-flash
```

PowerShell 对应方式是 `$env:变量名 = '值'`。该模式对第三方推理不需要真实 Anthropic Bearer；如果切回 Anthropic 模型，容器没有 OAuth 就会失败。覆盖后台 Haiku 会改变 classifier 等内部任务的模型，兼容性需验证。发现模式的上游功能差异见前篇。

直接启动 `claude` 不会读取 openclaude JSON 的 `subagentModel/internalClassifierModel`，所以这里必须在客户端设置这些变量，修改后重启客户端。仅调整服务器 JSON 无法更改已启动的 Agent 模型偏好。

### C. 必须同时使用发现与 Anthropic 订阅时

容器不能读取宿主机的 macOS Keychain。项目支持手动提供 `OPENCLAUDE_OAUTH_TOKEN`，可在个人部署中增加以下覆盖文件 `docker-compose.oauth.yml`：

```yaml
services:
  router:
    environment:
      OPENCLAUDE_OAUTH_TOKEN: ${OPENCLAUDE_OAUTH_TOKEN:?请先在本机环境中提供有效的OAuth访问令牌}
```

只在受信任的部署环境设置变量，并执行：

```bash
docker compose -f docker-compose.yml -f docker-compose.oauth.yml up -d --force-recreate router
```

客户端使用上述 sentinel + discovery，但不需要将所有后台模型换成 Agnes。显式 token 不会自动刷新，过期需由用户更新并重建容器；更适合短期诊断，日常优先 A。这里不提供获取或打印个人 token 的脚本，也未在云沙箱中传入任何真实凭据。

如果选择文件凭据挂载，需确保 UID 1000 可读、只读挂载、客户端持续负责刷新，并考虑宿主机原子替换单文件后需重建挂载。不要为方便把整个个人目录放进镜像。

## 6. 可选 Ollama 部署与宿主机后端

### 同一 Compose 管理 Ollama

```bash
docker compose --profile ollama up -d --build
docker compose ps
# 服务就绪后显式下载一个实际需要的模型，不会在启动时自动下载。
docker compose exec ollama ollama pull qwen2.5-coder:0.5b
docker compose exec ollama ollama list
curl --fail-with-body http://127.0.0.1:11436/v1/models
```

上面的 0.5b 仅作为低内存部署连通示例，不代表适合 Claude Code 工具任务。工具可靠性需使用实际支持工具的模型验证；大模型需相应提高 `OLLAMA_MEMORY_LIMIT` 并提供真实可用资源。本次 3.6 GiB 服务器没有拉取模型或进行推理负载测试。

router 中 `ollama-local.baseUrl` 已设为 `http://ollama:11434`，通过 Compose DNS 访问；Ollama 无宿主机端口发布。模型与 Ollama 状态保存在项目命名的 `ollama-data` 卷中，普通 `down` 保留，`down -v` 会删除模型数据，不用于日常停止。

router 不依赖可选服务就绪才能启动，避免纯云 API 部署被 Ollama 阻塞；首次发现为空时，等 Ollama 就绪并下载模型后重新读取列表或重启客户端。

`profiles` 允许按需启动可选服务，具体规则见 [Docker profiles 文档](https://docs.docker.com/compose/how-tos/profiles/)。本方案默认 CPU 部署，不配置 GPU；需要 GPU 时再为目标机器安装相应容器运行支持并增加资源声明。

### 使用宿主机已有 Ollama

不启用 profile，修改 `docker/config/config.json` 中完整的 provider：

```json
"ollama-local": {
  "type": "ollama",
  "baseUrl": "http://host.docker.internal:11434"
}
```

Compose 已加入 `host-gateway` 映射。在原生 Linux 上，宿主机 Ollama 仅绑定 `127.0.0.1` 时，容器通过宿主机网关通常访问不到；需要让 Ollama 监听容器可达的宿主机地址，并通过防火墙只允许所需来源。若不想调整宿主监听，采用同 Compose 服务更直接。

容器内的 `127.0.0.1` 指容器自身，不能用它连接宿主机 Ollama。其他自建 OpenAI-compatible 网关也遵循同一规则。

## 7. 开发、生产、更新与停止

| 项目 | 开发 | 生产 / 长期运行 |
|---|---|---|
| 源码 | 挂载 `src`，`node --watch` | 镜像内固定源码，不挂载源码 |
| 重启 | 手工观察，`restart: no` | `unless-stopped` |
| 配置 | 目录只读挂载，按请求重读 | 同样挂载；保留可追踪的配置版本 |
| 镜像 | 可重建的本地标签 | Node 摘要 + 源码提交固定，自定义不可变应用标签 |
| 凭据 | 本人测试 Key | 限权服务 Key、受限文件权限；需要时对接外部密钥管理 |
| 访问 | 宿主机回环端口 | 回环 + SSH 隧道；共享入口须另加认证/TLS/限流 |

开发启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build router
```

`src` 变更触发 Node 重启；`package.json` 或镜像配置变更仍需重建镜像。Windows/macOS 文件共享的 watch 事件是否可靠需在目标主机验证；若未触发，手动 `restart router`。

常用维护：

```bash
# 修改 JSON provider：下一请求重读；可用实际请求验证。
# 修改 .env：必须重建容器以更新进程环境。
docker compose up -d --force-recreate router
# 修改源代码：重建镜像并更新 router。
docker compose up -d --build router
# 临时停止，保留容器与卷。
docker compose stop router
# 停止项目；如启用了 Ollama，显式包含同一 profile。
docker compose --profile ollama down
```

升级之前保存当前应用镜像标签、配置和源码版本。例如设置 `OPENCLAUDE_IMAGE=openclaude:release-20260906` 再构建；后续升级使用新标签。回滚时把该变量改回旧标签并执行 `docker compose up -d --no-build --pull never router`。不要用相同可变标签覆盖掉唯一的回滚镜像；数据库迁移不适用于本项目。

生产镜像更新由运维主动触发：即使主标签还是 Node 22，也需更新 Dockerfile 中的摘要才能纳入后续安全修复。Ollama 标签也应按自身兼容性验证后升级。

### 远程使用

在客户端建立隧道（替换用户和服务器地址）：

```bash
ssh -N -L 11436:127.0.0.1:11436 user@your-server
```

保持该终端运行，客户端仍连接 `http://127.0.0.1:11436`。本地端口被占用时改 `-L 21436:127.0.0.1:11436`，并相应更新客户端 URL。

当前 router 无入口鉴权。Compose 的回环发布是默认访问边界，但旧 Docker 版本存在网络隔离行为差异，不能将回环映射作为任意宿主环境下的完整防火墙替代品；公网服务器需同时控制主机/云网络入站访问。本次没有开放任何公网端口。

## 8. 验收、日志和边界

```bash
docker compose config --quiet
docker compose ps
docker compose logs --tail=100 router
curl --fail-with-body http://127.0.0.1:11436/openclaude/status
```

镜像自带 Node fetch 健康检查，无需额外安装 curl。Docker 的 `unhealthy` 状态本身不会自动重启容器，`unless-stopped` 针对进程退出；真实上游异常需另行监控。

临时将 `.env` 中 `OPENCLAUDE_DEBUG_STREAM=1` 后重建容器；复现后可导出：

```bash
docker compose cp router:/home/node/.openclaude/stream-debug.log ./stream-debug.log
```

调试日志保存在 tmpfs，容器重建/停止后可能丢失，容量只有 16 MiB；写满后现有代码可能静默丢日志。诊断结束关闭该变量，并先脱敏再分享日志。

完整测试使用 Node 内置框架和模拟上游，不会消费真实账号额度。执行地点遵循用户的 rsandbox 约定；本次实际运行记录、镜像与 Compose 验证范围见 [验证记录](03-验证记录.md)。真实 Claude Code 登录、Agnes/Ollama Cloud 配额及模型推理、GPU、Windows Docker Desktop 行为不属于本次已验证范围。

## 9. 完整部署文件

以下内容从交付文件直接收录，与本次验证所用文件保持一致。

### Dockerfile

```dockerfile
# 固定已核验的 Node 22 镜像摘要；升级时更新摘要并重新验证。
ARG NODE_IMAGE=node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    OPENCLAUDE_HOME=/etc/openclaude \
    OPENCLAUDE_HOST=0.0.0.0 \
    OPENCLAUDE_PORT=11436 \
    OPENCLAUDE_DISABLE_KEYCHAIN=1
WORKDIR /app
# 项目无第三方 npm 依赖和编译步骤，无需 npm install 或多阶段构建。
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY docker/config/config.json /etc/openclaude/config.json
RUN mkdir -p /home/node/.openclaude && chown node:node /home/node/.openclaude
USER node
EXPOSE 11436
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.OPENCLAUDE_PORT+'/openclaude/status',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/router/index.js"]
```

### docker-compose.yml

```yaml
services:
  router:
    image: ${OPENCLAUDE_IMAGE:-openclaude:local}
    build:
      context: .
    init: true
    restart: unless-stopped
    environment:
      OPENCLAUDE_HOST: 0.0.0.0
      OPENCLAUDE_PORT: "11436"
      OPENCLAUDE_HOME: /etc/openclaude
      OPENCLAUDE_DISABLE_KEYCHAIN: "1"
      OPENCLAUDE_DEBUG_STREAM: ${OPENCLAUDE_DEBUG_STREAM:-0}
      AGNES_API_KEY: ${AGNES_API_KEY:-}
      OLLAMA_API_KEY: ${OLLAMA_API_KEY:-}
      NODE_OPTIONS: --max-old-space-size=384
    ports:
      - "127.0.0.1:${OPENCLAUDE_PUBLISH_PORT:-11436}:11436"
    volumes:
      - type: bind
        source: ./docker/config
        target: /etc/openclaude
        read_only: true
        bind:
          create_host_path: false
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
      - /home/node/.openclaude:size=16m,uid=1000,gid=1000,mode=0700
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 512m
    pids_limit: 100
    stop_grace_period: 15s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - backend

  ollama:
    image: ${OLLAMA_IMAGE:-ollama/ollama:0.14.0}
    profiles: [ollama]
    restart: unless-stopped
    environment:
      OLLAMA_HOST: 0.0.0.0:11434
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: [CMD, ollama, list]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    mem_limit: ${OLLAMA_MEMORY_LIMIT:-2g}
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - backend

networks:
  backend:
    driver: bridge

volumes:
  ollama-data:
```

### docker-compose.dev.yml

```yaml
services:
  router:
    restart: "no"
    environment:
      NODE_ENV: development
    command: [node, --watch, src/router/index.js]
    volumes:
      - ./src:/app/src:ro
```

### .env.example

```dotenv
# 复制为 .env，按需要填写。宿主机同名环境变量优先于本文件。
# 宿主机发布端口；容器内部端口固定为 11436。
OPENCLAUDE_PUBLISH_PORT=11436
OPENCLAUDE_IMAGE=openclaude:local
AGNES_API_KEY=
OLLAMA_API_KEY=
OPENCLAUDE_DEBUG_STREAM=0
# 仅 --profile ollama 启动时使用。生产可进一步固定为镜像摘要。
OLLAMA_IMAGE=ollama/ollama:0.14.0
OLLAMA_MEMORY_LIMIT=2g
```

### .dockerignore

```dockerignore
**
!Dockerfile
!package.json
!bin/
!bin/**
!src/
!src/**
!docker/
!docker/config/
!docker/config/config.json
```

### docker/config/config.json

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
      "baseUrl": "http://ollama:11434"
    },
    "ollama-cloud": {
      "type": "ollama",
      "baseUrl": "https://ollama.com",
      "apiKey": "$OLLAMA_API_KEY"
    },
    "agnes": {
      "type": "openai-compatible",
      "baseUrl": "https://api.agnes-ai.cn/v1",
      "apiKey": "$AGNES_API_KEY",
      "chatPath": "chat/completions",
      "timeoutMs": 60000,
      "models": [
        { "id": "agnes-2.5-flash", "display_name": "Agnes 2.5 Flash" },
        { "id": "agnes-2.0-flash", "display_name": "Agnes 2.0 Flash" }
      ]
    }
  }
}
```
