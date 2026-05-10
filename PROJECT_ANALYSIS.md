# open-antigravity 项目分析与优化建议

## 结论摘要

`open-antigravity` 是一个目标明确、代码量较小的 TypeScript HTTP 代理项目：它将本机 Antigravity 的 `language_server` 暴露成 OpenAI / Anthropic 兼容 API，方便 Claude Code、Cursor、Continue、OpenAI SDK、Anthropic SDK 等客户端通过 `base_url + key` 调用。

当前项目已经完成了最难的核心链路：发现本机 Antigravity language server、读取本地认证信息、创建/复用 cascade、发送消息、订阅状态流、转换为 OpenAI/Anthropic 响应格式。

但整体成熟度更接近“个人本地实验/调试工具”，距离安全、可维护、可发布的稳定代理服务还有明显优化空间。最值得优先处理的是：

1. 请求处理健壮性：已增加默认 1MiB 请求体大小限制与 400/413 错误返回；仍需补 request timeout 与 `Content-Type` 校验。
2. 安全默认值：默认监听 `0.0.0.0`、无认证、CORS 全开放、自动批准/自动执行风险较高；若明确仅本机使用，优先级可降为 P1。
3. Anthropic system array 兼容问题：底层支持数组格式，但路由层会丢弃。
4. 日志脱敏：已将请求、状态流、prompt/response、gRPC body 等详细日志改为默认关闭；需要 `DEBUG=1` / `DEBUG_GRPC=1` 才输出。
5. 测试不足：有 smoke 测试，但缺少低成本单元测试与 CI。
6. `converter.ts` 过大：核心状态机、流式/非流式逻辑、自动审批、诊断日志集中在一个文件。

## 已验证事项

执行过以下检查：

```bash
npm run build
npm audit --omit=dev
```

结果：

- `npm run build` 通过。
- 手动验证请求体超限返回 `413 payload_too_large`。
- 手动验证 JSON 格式错误返回 `400 invalid_json`。
- 手动验证 `DEBUG=0` 时 health 请求不会输出 access log、workspace 路径或 API key 前缀。
- `npm audit --omit=dev` 显示 0 vulnerabilities。
- 未执行 `npm run smoke`，因为它要求本地代理服务与 Antigravity 桌面应用已运行。

## 项目结构概览

```text
open-antigravity
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
└── src
    ├── index.ts
    ├── converter.ts
    ├── models.ts
    ├── smoke.ts
    ├── utils.ts
    ├── routes
    │   ├── anthropic.ts
    │   └── openai.ts
    └── bridge
        ├── discovery.ts
        ├── grpc.ts
        └── statedb.ts
```

主要职责：

- `src/index.ts`：HTTP server、路由分发、CORS、health、debug endpoint。
- `src/routes/openai.ts`：OpenAI `/v1/chat/completions` 与 `/v1/models` 兼容响应。
- `src/routes/anthropic.ts`：Anthropic `/v1/messages` 兼容响应。
- `src/converter.ts`：核心桥接逻辑，负责创建 cascade、发送消息、监听回复、流式输出、自动批准阻塞步骤。
- `src/bridge/discovery.ts`：通过系统进程和端口信息发现 Antigravity `language_server`。
- `src/bridge/statedb.ts`：读取 Antigravity 本地 `state.vscdb` 中的 API key。
- `src/bridge/grpc.ts`：封装 gRPC-Web / Connect 调用。
- `src/models.ts`：外部模型名到 Antigravity 内部模型 ID 的映射。
- `src/smoke.ts`：端到端 smoke 测试。

## 架构图

```text
╭────────────────────────────────────╮
│ OpenAI / Anthropic SDK / cURL      │
╰──────────────────┬─────────────────╯
                   │ HTTP :4000
                   ▼
╭────────────────────────────────────╮
│ src/index.ts                       │
│ - 路由分发                         │
│ - CORS                             │
│ - health/debug                     │
╰───────────┬─────────────┬──────────╯
            │             │
            ▼             ▼
╭────────────────╮   ╭──────────────────╮
│ routes/openai  │   │ routes/anthropic  │
╰────────┬───────╯   ╰─────────┬────────╯
         │                     │
         ╰──────────┬──────────╯
                    ▼
╭────────────────────────────────────╮
│ src/converter.ts                   │
│ - 创建 / 复用 cascade              │
│ - 发消息                           │
│ - 监听 stream state updates        │
│ - 自动批准阻塞步骤                 │
╰──────────────────┬─────────────────╯
                   ▼
╭────────────────────────────────────╮
│ bridge/*                           │
│ - discovery: 找 language_server    │
│ - statedb: 读本地 state.vscdb key  │
│ - grpc: gRPC-Web / Connect 调用    │
╰──────────────────┬─────────────────╯
                   ▼
╭────────────────────────────────────╮
│ Antigravity language_server        │
╰────────────────────────────────────╯
```

## 综合评分

| 维度 | 分数 | 关键证据 |
|---|:---:|---|
| 项目定位 | 4/5 | README 说明清楚，目标用户和协议兼容场景明确。 |
| 架构设计 | 3.5/5 | 分层清晰：`routes` / `converter` / `bridge`；但核心状态机过度集中在一个文件。 |
| 代码质量 | 3/5 | TypeScript strict 开启，但大量 `any` 削弱类型安全；日志和调试代码偏多。 |
| 安全性 | 2/5 | 默认监听 `0.0.0.0`、无认证、CORS `*`、自动执行/自动批准、日志打印 Authorization。 |
| 测试覆盖 | 2.5/5 | 有 smoke 测试，但缺少单元测试、CI、协议格式测试。 |
| 可维护性 | 3/5 | 代码量小易理解，但 `converter.ts` 和 streaming/non-streaming 重复逻辑明显。 |
| 依赖健康 | 4/5 | 运行时零依赖，`npm audit --omit=dev` 无漏洞。 |
| 发布成熟度 | 2/5 | README 写 MIT 但无 LICENSE 文件；`start` 依赖 `tsx` devDependency，不适合生产安装。 |
| 跨平台鲁棒性 | 2.5/5 | Windows/macOS/Linux 有考虑，但依赖 `sqlite3`、`lsof`、`netstat`、进程命令解析，脆弱。 |
| API 兼容性 | 3/5 | 基础 OpenAI/Anthropic message 能转发，但 tools、多模态、usage、token count 等是简化实现。 |

## 主要优化建议

### P1：安全默认值风险较高

如果服务面向局域网或公网，这是高风险问题；如果明确仅本机使用，风险主要来自默认配置不够收敛，因此降为 P1。

主要风险：

- 默认监听地址是 `0.0.0.0`。
- README 中说明 OpenAI `api_key` / Anthropic `x-api-key` 可以任意填写。
- CORS 全开放。
- 请求日志会打印 `authorization` 等请求头。
- gRPC 配置中开启了自动命令执行与自动 artifact review。
- `converter.ts` 会自动批准阻塞的 `NOTIFY_USER` 步骤。

这意味着如果服务暴露到局域网或公网，其他人可能通过该代理驱动本机 Antigravity 执行 agentic 操作。

建议：

1. 默认改成 `HOST=127.0.0.1`。
2. 增加 `PROXY_API_KEY`，设置后必须校验 `Authorization` / `x-api-key`。
3. 日志中隐藏 Authorization、x-api-key、csrf、apiKey。
4. `/debug/model-configs` 默认关闭，改成 `DEBUG_ENDPOINTS=1` 才开启。
5. 自动批准和自动命令执行改成显式 opt-in，例如：
   - `AUTO_APPROVE_ARTIFACTS=1`
   - `AUTO_EXECUTION=eager|off`

### P0：请求体处理健壮性（大小限制已处理）

当前已在 `src/index.ts` 增加 `MAX_BODY_SIZE`，默认 `1048576` 字节（1MiB），适合普通 chat 文本请求。超限请求会返回 `413 payload_too_large`，JSON 格式错误会返回 `400 invalid_json`。

剩余问题包括：

- 没有 request timeout。
- 没有 `Content-Type` 校验。

后续建议：

1. 非 JSON 返回 `415 Unsupported Media Type`。
2. 对 HTTP server 设置 `requestTimeout` / `headersTimeout`。

### P1：Anthropic `system` 数组格式被路由层丢掉

`converter.ts` 实际支持 Anthropic system 为数组格式，但 `routes/anthropic.ts` 只在 `system` 是 string 时传入，否则传 `undefined`。

这会导致 Claude Code / Anthropic SDK 发送 content block 数组形式 system prompt 时被静默丢弃。

建议将：

```ts
system: typeof system === 'string' ? system : undefined,
```

改为：

```ts
system,
```

同时把 `CompletionRequest.system` 类型从 `string` 改成更宽的 `unknown` 或专门的 Anthropic content block 类型。

### P1：`converter.ts` 过大，且 streaming / non-streaming 逻辑重复

`converter.ts` 是项目最大文件，约 729 行。它同时负责：

- 文本提取。
- workspace 解析。
- cascade 创建。
- message 发送。
- 状态流监听。
- 自动审批。
- streaming delta 计算。
- 诊断日志。

其中 `complete()` 和 `completeStream()` 在创建 cascade、构造 prompt、workspace 处理方面有明显重复。

建议小步重构，不要一次性大拆：

1. 抽出 `buildPrompt(messages, system)`。
2. 抽出 `createOrReuseCascade(conn, conversationId)`。
3. 抽出共享的 `handleStepUpdate()` 或 `CascadeStateTracker`。
4. 保持外部 API 不变，先加单元测试再拆。

### P1：大量调试日志默认开启，可能泄露内容和拖慢服务（已处理）

当前已改为默认关闭详细调试日志：

- 请求 access log、Anthropic body 摘要、count_tokens 摘要需要 `DEBUG=1` 才输出。
- `converter.ts` 中状态流、step 诊断、prompt/response 长度、timeout recent update bodies 需要 `DEBUG=1` 才输出。
- gRPC request / response body 需要 `DEBUG_GRPC=1` 才输出。
- debug 请求头中 `Authorization` / `x-api-key` / `x-codeium-csrf-token` / `cookie` 会脱敏。

后续建议：

1. 后续如继续扩展日志，统一使用轻量 logger，避免直接 `console.log`。
2. 可进一步把 startup 状态、warning、error 分成 `LOG_LEVEL`。

### P1：`statedb.ts` 使用 shell 拼接调用 sqlite3，可移植性和健壮性一般

当前通过 `execSync` 执行 `sqlite3` 命令读取本地状态库。

问题：

- 依赖系统安装 `sqlite3`。
- 同步阻塞进程。
- 每次调用都可能触发 sqlite 查询。
- 错误被吞掉，不容易定位问题。

建议：

1. 至少加 TTL 缓存，例如 5-30 秒。
2. sqlite3 不存在时给明确日志。
3. 如果接受依赖，可使用 Node SQLite 包；如果坚持零依赖，可先做缓存和更好的错误提示。

### P1：`discovery.ts` 同步执行系统命令，平台兼容风险较大

语言服务发现依赖：

- Windows：PowerShell + `netstat -ano`。
- Unix：`ps aux` + `lsof`。

已有 3 秒缓存，这是好的。但问题仍然存在：

- 同步阻塞 Node event loop。
- `lsof` 可能不存在。
- 进程命令行解析依赖 Antigravity 内部参数格式。
- workspace id decode 有天然歧义。

建议：

1. 增加 `ANTIGRAVITY_PORT` / `ANTIGRAVITY_CSRF` 手动覆盖，跳过发现逻辑。
2. discovery 失败时输出操作建议。
3. 缓存 apiKey 和 discovery 结果分开管理。
4. 后续可改成异步 child process，避免阻塞。

### P1：OpenAI / Anthropic 兼容性仍是基础兼容

当前支持：

- OpenAI `/v1/chat/completions`。
- Anthropic `/v1/messages`。
- SSE streaming。
- `/v1/models`。
- `/v1/messages/count_tokens` stub。

但限制明显：

- OpenAI route 解构了 `max_tokens` 但未使用。
- Anthropic route 解构了 `metadata` 但未使用。
- token count 是粗略估算。
- OpenAI usage 全是 0。
- Anthropic streaming 的 output tokens 固定为 10。
- `extractText()` 只保留 text block，tool/image 等 block 会丢弃。

建议：

1. README 明确列出“不支持 tools / image / tool_result / 准确 token usage”。
2. 对无法支持的字段返回明确 warning 或 400，而不是静默忽略。
3. 如果 Claude Code 需要 tool_result，至少把非 text block 序列化进 prompt。

### P2：模型映射硬编码，容易随 Antigravity 更新失效

模型映射写死在 `src/models.ts`，例如 `MODEL_PLACEHOLDER_M35`、`MODEL_PLACEHOLDER_M26` 等。

优点是简单。问题是 `MODEL_PLACEHOLDER_*` 很可能随 Antigravity 版本/账号变化。

建议：

1. 增加启动时或首次请求时动态读取模型配置。
2. 读取失败再 fallback 到硬编码。
3. `/v1/models` 应尽量来自真实配置，而不是静态表。
4. debug endpoint 加权限保护。

### P2：类型安全被大量 `any` 抵消

虽然 `tsconfig` 开启了 `strict: true`，但代码中大量使用 `any`：

- route body 是 `any`。
- converter 内部 state update / steps 基本全是 `any`。
- grpc response 也是 `any`。

建议：

1. 先为外部请求定义最小类型：
   - `OpenAIChatCompletionRequest`
   - `AnthropicMessagesRequest`
   - `AnthropicContentBlock`
2. 为 Antigravity update 定义“只覆盖已使用字段”的窄类型。
3. 保留未知字段为 `unknown`，避免全局 `any`。

### P2：测试策略偏 smoke，缺少低成本单元测试

已有 smoke 测试不错，覆盖 health、token count、models、fast path、non-streaming、streaming。

但它依赖真实 Antigravity 和代理服务，不适合 CI 中稳定运行。

建议新增基于 Node 内置 `node:test` 的单元测试，不一定引入 Jest/Vitest。

优先测：

1. `resolveModelId()`。
2. `extractText()` / `extractSystemText()`，需要先 export 或间接测试。
3. OpenAI / Anthropic SSE 格式。
4. request body 超限 / invalid JSON。
5. `decodeWorkspaceId()` 的 Windows / Unix 样例。

### P2：发布元数据不完整

当前问题：

- README 写 MIT，但仓库没有 `LICENSE` 文件。
- `package.json` 没有 `license` 字段。
- `start` 使用 `tsx src/index.ts`，但 `tsx` 是 devDependency，不适合生产安装。

建议：

1. 添加 `LICENSE`。
2. `package.json` 加 `"license": "MIT"`。
3. 如果要发布/生产运行：
   - `build`: `tsc`
   - `start`: `node dist/index.js`
   - `dev`: `tsx watch src/index.ts`
4. 或者把 `tsx` 移到 dependencies，但不如 `node dist/index.js` 清晰。

## 优先级执行路线

### 第一阶段：请求处理健壮性

1. `[已完成]` `parseBody` 加 size limit，默认 `MAX_BODY_SIZE=1048576`。
2. `[已完成]` invalid JSON 返回 400。
3. `[已完成]` body 超限返回 413。
4. `[待处理]` server 设置 timeout。
5. `[待处理]` 非支持 method / content-type 返回更清楚的错误。

### 第二阶段：安全默认值收敛

1. 默认 `HOST=127.0.0.1`。
2. 增加可选强制认证 `PROXY_API_KEY`。
3. 移除/脱敏 Authorization、x-api-key、apiKey、csrf 日志。
4. 关闭默认 debug endpoint。
5. 自动执行/自动批准改成 opt-in。

### 第三阶段：兼容性修复

1. 修复 Anthropic system array 被丢弃的问题。
2. 明确不支持的 API 字段。
3. 改善 token usage / count_tokens 的行为说明。

### 第四阶段：可维护性重构

1. 给日志分级。
2. `[已完成]` 默认关闭 gRPC body dump。
3. 抽出 cascade 初始化公共函数。
4. 抽出 prompt 构造公共函数。
5. 后续再拆状态追踪逻辑。

### 第五阶段：测试与 CI

1. 加 `npm test`。
2. 用 `node:test` 做无依赖单元测试。
3. 添加 GitHub Actions：`npm ci && npm run build && npm test`。
4. smoke 测试保留为手动/本地 E2E。

## 核心优势

1. 定位明确：目标就是把 Antigravity 变成 OpenAI / Anthropic 兼容 API，README 使用方式清晰。
2. 依赖少，部署简单：运行时代码基本只使用 Node 内置模块，依赖面小。
3. 对 Antigravity 内部行为理解较深：例如必须先订阅再发送消息、需要 `UpdateConversationAnnotations` 等经验，是项目最有价值的部分。

## 主要风险

1. 安全边界过于宽松：默认监听所有网卡、无认证、CORS 全开、自动执行/自动批准，组合风险较大。
2. 依赖 Antigravity 内部实现，易碎：`MODEL_PLACEHOLDER_*`、进程参数、gRPC method、state update shape 都不是稳定公开 API。
3. 测试覆盖不足，未来改动容易破坏兼容性：当前只有 smoke 测试，缺少协议转换、SSE、错误处理、模型映射等单元测试。

## 适合与不适合场景

### 适合

- 个人本机使用。
- 临时让 Claude Code / Cursor / Continue 调用 Antigravity。
- 研究 Antigravity 本地 language_server 行为。
- 内网受控环境下的实验性代理。

### 不适合

- 暴露到公网。
- 多用户共享服务。
- 企业生产环境。
- 对安全审计、权限隔离、稳定 SLA 有要求的场景。
- 需要完整 OpenAI / Anthropic tools、多模态、准确 token accounting 的场景。

## 替代方案对比

| 方案 | 优势 | 劣势 |
|---|---|---|
| 当前项目 `open-antigravity` | 专门桥接 Antigravity；代码小；容易改。 | 安全/测试/兼容性还不成熟；依赖内部 API。 |
| LiteLLM | 成熟的 OpenAI-compatible proxy，支持多 provider、鉴权、日志、限流。 | 不直接支持 Antigravity 本地 language_server。 |
| one-api / new-api | 多模型统一网关、管理界面、key 管理成熟。 | 同样不解决 Antigravity bridge；重量更大。 |
| Antigravity-Mobility-CLI | bridge 层来源项目，可能更接近底层探索。 | 不一定提供 OpenAI/Anthropic 兼容 HTTP API。 |

## 最终建议

下一步最建议直接做一轮“小而关键”的代码优化：

1. request timeout / `Content-Type` 校验。
2. 默认 localhost。
3. 可选 API key 鉴权。
4. 日志脱敏。
5. 修复 Anthropic system array。

这些改动范围小，但能显著提升安全性、健壮性和实际可用性。
