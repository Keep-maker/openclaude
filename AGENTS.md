# AI Agent 工作约定

## 项目与入口

- 这是 Node.js ESM 模型路由器，运行依赖全部来自标准库。
- Claude Code / HTTP 客户端执行工具；本项目不执行模型返回的 shell、文件或网络工具。
- 先读 `docs/01-Agent配置与使用.md` 和 `docs/02-Docker-Compose部署.md`。
- 路由逻辑在 `src/router`，本机启动/模型选择在 `src/cli`，回归测试在 `test`。

## 配置与运行

- 本机使用 `oc start/status/stop`；容器使用 `docker compose up/ps/logs/down`。
- Compose 运行的是前台 `node src/router/index.js`，不要在容器内运行 `oc start`。
- 无编译步骤，不要引入仅用于容器启动的额外 npm 框架或守护进程。
- 客户端入口是 Anthropic `/v1/messages`，OpenAI-compatible 是上游 provider 类型。
- `subagentModel` 只由 `oc start` 转成客户端变量，服务端不会据此识别子 Agent。
- 模型列表不是授权或可用性证明；工具调用必须保留 ID 并返回配对结果。

## 修改与验证

- 保留本机默认回环监听；Docker 内监听所有接口，宿主机仍只发布回环端口。
- 不要把 `.env`、个人 `.claude`、Key、真实请求日志加入镜像或提交。
- `npm test` 执行完整回归；`npm run test:deployment` 检查前台监听与停止。
- 涉及配置、协议或流式处理的变更，要补足相应回归验证。
- 测试/构建地点遵循当前用户的执行环境约定；用户要求 rsandbox 时在云沙箱执行。
- 记录模拟与真实上游验证边界；未经真实推理，不宣称模型能力或账号登录已验证。
