---
title: Claude Code OpenTelemetry 数据结构
document_type: reference
status: current
audience:
  - 集成者
  - 维护者
  - 安全与可观测性团队
owners:
  - opencode-plugin-otel 维护者
created: 2026-07-14
updated: 2026-07-14
source_of_truth:
  - https://code.claude.com/docs/en/monitoring-usage.md
related:
  - ../../README.md
---

# Claude Code OpenTelemetry 数据结构

## 范围与权威来源

本文用于查询 Claude Code 原生 OpenTelemetry 上传的数据、OTLP 结构、关联字段、默认脱敏行为及与 SigNoz 展示层的映射，不代表本仓库插件已经实现全部同名信号。

字段和默认行为以 [Anthropic Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage.md) 为权威来源，以 [SigNoz Claude Code Monitoring](https://signoz.io/docs/claude-code-monitoring/) 为接入与展示参考。外部资料访问及 SigNoz 实测日期为 2026-07-14；Claude Code Traces 仍处于 Beta，使用时应按实际版本复核。

## 默认行为

Claude Code 的 OpenTelemetry 默认关闭。设置 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 后，还必须为需要的信号配置 exporter 才会上传数据：

| 信号           | 开启方式                                                                   | 上传内容                                                                                  | OTLP 路径（HTTP） |
| -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------- |
| Metrics        | `OTEL_METRICS_EXPORTER=otlp`                                             | 会话数、Token、成本、代码改动、提交、PR、权限决策和活跃时间等数值时间序列                 | `/v1/metrics`   |
| Logs/Events    | `OTEL_LOGS_EXPORTER=otlp`                                                | 每次提示、模型请求、工具调用、权限决策、错误、认证、MCP、插件、Skill 和 Hook 等结构化事件 | `/v1/logs`      |
| Traces（Beta） | `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` 和 `OTEL_TRACES_EXPORTER=otlp` | 一次交互下的模型请求、工具、权限等待和执行耗时及父子关系                                  | `/v1/traces`    |

默认遥测以结构化元数据为主，但并非匿名数据：已认证场景可包含邮箱、账号和组织标识。用户提示词、助手回答、工具参数、工具输入输出和完整 API body 默认不上传，只有显式打开相应内容开关后才会上传。

SigNoz 文档重点介绍 Metrics 与 Logs/Events；Anthropic 当前官方规范还包含 Beta Traces，以及 SigNoz 页面尚未完整列出的较新事件和敏感内容开关。因此应以 Anthropic 官方 Monitoring 页面作为字段权威来源。

## 数据在 OTLP 中的结构

Claude Code 使用标准 OTLP 导出。三类信号都先按 Resource 和 instrumentation scope 分组，再承载具体数据。下列 JSON 是便于理解的概念结构，不是 protobuf 的逐字 JSON 编码：

```json
{
  "resource": {
    "attributes": {
      "service.name": "claude-code",
      "service.version": "<Claude Code 版本>",
      "<OTEL_RESOURCE_ATTRIBUTES 中的键>": "<值>"
    }
  },
  "scope": {
    "name": "com.anthropic.claude_code.events",
    "version": "<Claude Code 版本>"
  },
  "records": []
}
```

后端通常会把 Resource、scope 和记录属性展平。SigNoz 日志详情中看到的 `service.name`、`otel.library.name`、`session.id` 等字段，是 OTLP 不同层级经过存储映射后的视图，不代表发送端把所有字段放在同一个 JSON 对象中。

### Metric 结构

每个 Metric 包含名称、类型、单位和一个或多个 data point。Claude Code 的指标主要是 Counter，默认聚合时态为 `delta`。

```json
{
  "name": "claude_code.token.usage",
  "type": "Sum/Counter",
  "unit": "tokens",
  "aggregationTemporality": "DELTA",
  "dataPoints": [
    {
      "startTimeUnixNano": "...",
      "timeUnixNano": "...",
      "asInt": 1234,
      "attributes": {
        "session.id": "...",
        "user.id": "...",
        "model": "claude-sonnet-5",
        "type": "input",
        "query_source": "main"
      }
    }
  ]
}
```

`prompt.id` 不会进入指标，因为每个提示都会产生新 UUID，作为 label 会造成无界基数。`session.id` 默认进入指标，也可能产生较高基数，可通过 `OTEL_METRICS_INCLUDE_SESSION_ID=false` 关闭。

### Log/Event 结构

Claude Code 事件通过 OTel Logs 协议发送。日志 body 通常是带 `claude_code.` 前缀的事件名，attributes 存放事件字段：

```json
{
  "timeUnixNano": "...",
  "body": "claude_code.api_request",
  "attributes": {
    "event.name": "api_request",
    "event.timestamp": "2026-07-14T00:00:00.000Z",
    "event.sequence": 8,
    "session.id": "...",
    "prompt.id": "...",
    "user.id": "...",
    "model": "claude-sonnet-5",
    "cost_usd": 0.0123,
    "duration_ms": 2450,
    "input_tokens": 1200,
    "output_tokens": 280,
    "cache_read_tokens": 600,
    "cache_creation_tokens": 0,
    "request_id": "req_...",
    "speed": "normal",
    "query_source": "repl_main_thread"
  }
}
```

`event.sequence` 用于同一会话内排序；`prompt.id` 把一次用户提示触发的 `user_prompt`、多次 `api_request`、`tool_decision` 和 `tool_result` 关联起来。它们比按时间窗口拼接可靠。

### Trace 结构

每次用户交互产生一个根 span，模型、工具和 Hook 是其子 span：

```text
claude_code.interaction
├── claude_code.llm_request
├── claude_code.hook
└── claude_code.tool
    ├── claude_code.tool.blocked_on_user
    └── claude_code.tool.execution
```

主要 span 内容如下：

| Span                                 | 主要字段                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude_code.interaction`          | `user_prompt_length`、`interaction.sequence`、`interaction.duration_ms`；提示正文受开关控制                                                 |
| `claude_code.llm_request`          | `model`、`query_source`、`duration_ms`、`ttft_ms`、四类 Token、`request_id`、`attempt`、`success`、`status_code`、`stop_reason` |
| `claude_code.tool`                 | `tool_name`、`duration_ms`、`result_tokens`、`tool_use_id`；文件路径、命令、Skill 和子代理名称受开关控制                                  |
| `claude_code.tool.blocked_on_user` | `duration_ms`、`decision`、`source`                                                                                                         |
| `claude_code.tool.execution`       | `duration_ms`、`tool_use_id`、`success`、错误类别                                                                                           |
| `claude_code.hook`                 | Hook 名称、匹配数量、成功/阻断/失败数量和总耗时；还需要详细 Beta tracing 条件                                                                     |

`llm_request`、`tool.execution` 和 `hook` 失败时会设置 OTel span status `ERROR`。Tracing 仍处于 Beta，名称和字段可能随 Claude Code 版本变化。

## 通用属性

Metrics、Events 和 Spans 共享或复用以下身份与运行环境属性：

| 属性                                   | 含义                                                                       | 默认行为                                             |
| -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `session.id`                         | 会话唯一标识                                                               | 默认包含；指标可关闭                                 |
| `user.id`                            | 首次运行生成并保存在`~/.claude.json` 的随机安装标识                      | 始终包含；Gateway 登录时可变为 IdP subject           |
| `user.email`                         | OAuth 或 Gateway 登录邮箱                                                  | 可用时包含                                           |
| `user.account_uuid`                  | 已认证账号 UUID                                                            | 可用时包含；指标可关闭                               |
| `user.account_id`                    | 与 Anthropic Admin API 对应的账号 ID                                       | 可用时包含；指标可关闭                               |
| `organization.id`                    | 已认证组织 UUID                                                            | 可用时包含                                           |
| `terminal.type`                      | `vscode`、`cursor`、`tmux`、`iTerm.app` 等                         | 检测到时包含                                         |
| `app.version`                        | Claude Code 版本                                                           | 由`OTEL_METRICS_INCLUDE_VERSION` 控制，默认关闭    |
| `app.entrypoint`                     | `cli`、`sdk-cli`、`sdk-ts`、`sdk-py`、`claude-vscode` 等启动入口 | 由`OTEL_METRICS_INCLUDE_ENTRYPOINT` 控制，默认关闭 |
| `prompt.id`                          | 一次用户提示及其后续事件的关联 UUID                                        | 仅 Events，不进入 Metrics                            |
| `workspace.host_paths`               | Desktop App 选择的宿主机工作区目录数组                                     | 仅 Events，适用时包含                                |
| `workflow.run_id`、`workflow.name` | Workflow 运行及名称                                                        | 仅相关事件，部分字段受脱敏开关控制                   |
| `OTEL_RESOURCE_ATTRIBUTES` 中的键    | 团队、部门、成本中心等自定义维度                                           | Resource 中包含，默认也复制到 metric data point      |

这些字段足以把活动关联到具体安装、邮箱、账号、组织、会话乃至工作区，因此“默认不上传提示正文”不等于“默认数据不可识别”。

## 上传的 Metrics

| Metric                                  | 单位   | 值与关键维度                                                                                                                               |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude_code.session.count`           | count  | 会话启动次数；`start_type=fresh/resume/continue/agents_view`                                                                             |
| `claude_code.token.usage`             | tokens | Token 数；`type=input/output/cacheRead/cacheCreation`、`model`、`query_source`、`speed`、`effort` 及 Agent/Skill/Plugin/MCP 归因 |
| `claude_code.cost.usage`              | USD    | 每次 API 请求估算成本；模型、来源、速度、effort 及 Agent/Skill/Plugin/MCP 归因                                                             |
| `claude_code.lines_of_code.count`     | count  | 添加或删除行数；`type=added/removed`、`model`                                                                                          |
| `claude_code.commit.count`            | count  | Claude Code 创建的 Git commit 数                                                                                                           |
| `claude_code.pull_request.count`      | count  | 通过 shell 或 MCP 创建的 PR/MR 数                                                                                                          |
| `claude_code.code_edit_tool.decision` | count  | Edit、Write、NotebookEdit 的接受/拒绝；含`tool_name`、`decision`、`source`、`language`                                             |
| `claude_code.active_time.total`       | s      | 排除空闲后的活跃时间；`type=user/cli`                                                                                                    |

成本是估算值，财务对账应使用 Anthropic Console 或云服务商账单。`query_source` 在指标中使用 `main`、`subagent`、`auxiliary` 分类，在事件和 span 中可能是 `repl_main_thread`、`compact` 或具体子代理来源，两者不要直接假设为同一枚举。

## 上传的 Events

事件数量会随 Claude Code 版本增长。SigNoz 页面列出的核心事件及 Anthropic 当前规范中的主要补充如下。

| Event                                   | 触发时机                           | 主要上传字段                                                                                 |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `claude_code.user_prompt`             | 用户提交提示                       | 长度、命令名/来源；提示正文默认脱敏                                                          |
| `claude_code.assistant_response`      | API 返回文本回答                   | 回答长度、模型、请求 ID、来源；正文默认脱敏，v2.1.193+                                       |
| `claude_code.api_request`             | 模型请求完成                       | 模型、成本、耗时、四类 Token、请求 ID、速度、来源、effort、Agent/Skill/Plugin/MCP 归因       |
| `claude_code.api_error`               | 模型请求失败                       | 模型、错误、HTTP 状态、耗时、总尝试数、请求 ID、来源与归因                                   |
| `claude_code.api_refusal`             | API 以`refusal` 停止             | 模型、请求 ID、attempt、是否服务端 fallback、是否存在类别/解释；具体类别受开关控制           |
| `claude_code.api_retries_exhausted`   | 重试全部耗尽                       | 模型、错误、总尝试数、总重试耗时、状态码                                                     |
| `claude_code.api_request_body`        | 显式开启原始 body 后，每次请求尝试 | 请求 JSON 或本地文件路径、长度、截断标记、模型和来源                                         |
| `claude_code.api_response_body`       | 显式开启原始 body 后，请求成功     | 响应 JSON 或本地文件路径、长度、截断标记、模型、来源和请求 ID                                |
| `claude_code.tool_decision`           | 工具权限接受/拒绝                  | 工具名、`tool_use_id`、decision、source；工具参数受开关控制                                |
| `claude_code.tool_result`             | 已接受的工具执行结束               | 工具名、`tool_use_id`、成功、耗时、错误类别、输入/输出字节数、权限来源；详细输入受开关控制 |
| `claude_code.permission_mode_changed` | 权限模式切换                       | 前后模式及触发原因                                                                           |
| `claude_code.mcp_server_connection`   | MCP 连接、失败或断开               | 状态、传输类型、server scope、耗时和错误码                                                   |
| `claude_code.auth`                    | `/login` 或 `/logout` 完成     | action、success、认证方式和错误类别                                                          |
| `claude_code.compaction`              | 上下文压缩完成                     | 自动/手动触发、成功、压缩前后 Token、耗时                                                    |
| `claude_code.internal_error`          | 捕获未预期内部错误                 | 错误名称和错误码                                                                             |
| `claude_code.plugin_installed`        | 插件安装完成                       | 插件、Marketplace 和安装触发来源                                                             |
| `claude_code.plugin_loaded`           | 会话开始时插件已激活               | 插件、scope、版本和启用来源                                                                  |
| `claude_code.skill_activated`         | Claude 或`/` 命令调用 Skill      | Skill 名、触发方式、来源、种类及插件归属；第三方名称默认泛化                                 |
| `claude_code.hook_registered`         | Hook 注册                          | Hook 事件、类型、来源、safe mode、匹配器和插件归属；细节受开关控制                           |
| `claude_code.hook_execution_start`    | 一组匹配 Hook 开始                 | Hook 事件/名称、数量、策略来源和 safe mode                                                   |
| `claude_code.hook_execution_complete` | 一组匹配 Hook 完成                 | Hook 事件/名称、成功/阻断数量和总耗时                                                        |
| `claude_code.feedback_survey`         | 会话质量调查显示或作答             | 事件类型、调查类型和回答                                                                     |

同一逻辑信息可能同时存在于不同信号中。例如 Token 和成本既有可聚合的 Metric，也会出现在逐请求的 `api_request` Event 和 `llm_request` Span 中。Metric 适合趋势、仪表盘和告警；Event 适合审计和单次请求排查；Trace 适合观察一次交互的时序和父子关系。

## 敏感内容与开关

| 开关                               | 默认                       | 开启后新增上传内容                                                             | 风险                                                          |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `OTEL_LOG_USER_PROMPTS=1`        | 关闭                       | `user_prompt` 事件和 `interaction` span 中的提示正文                       | 可能包含源代码、凭据、个人信息和业务数据                      |
| `OTEL_LOG_ASSISTANT_RESPONSES=1` | 关闭；未设置时跟随上一开关 | `assistant_response` 中最多 60 KB 回答文本                                   | 可能复述提示或仓库内容；需要 v2.1.193+                        |
| `OTEL_LOG_TOOL_DETAILS=1`        | 关闭                       | 文件路径、shell 命令、搜索词、MCP/Skill/工作流名称、工具参数和约 4K 的工具输入 | 即使不记录提示，也可能间接暴露提示中的敏感值                  |
| `OTEL_LOG_TOOL_CONTENT=1`        | 关闭                       | Trace span event 中完整工具输入和输出，每属性最多 60 KB                        | 可直接上传读取的文件和命令输出；依赖 Traces                   |
| `OTEL_LOG_RAW_API_BODIES=1`      | 关闭                       | 请求/响应完整 JSON，内联最多 60 KB                                             | 包含整个会话历史、system prompt、messages 和 tools；风险最高  |
| `OTEL_LOG_RAW_API_BODIES=file:`  | 关闭                       | OTLP 事件上传本地`body_ref` 绝对路径，未截断 body 写到本地文件               | Collector 不收到 body，但本地磁盘保留完整内容且路径本身会上传 |

`OTEL_LOG_RAW_API_BODIES` 隐含同意暴露其他内容开关覆盖的数据。历史 assistant turn 的 extended-thinking 会被脱敏，但不能据此把原始 body 视为低风险数据。

建议生产环境：

1. 默认只启用 Metrics 和不含正文的 Events。
2. 将邮箱、账号 UUID、会话 ID 和自定义资源属性纳入个人信息与高基数治理。
3. 内容类开关仅在隔离环境、短时间排障且后端已获准存储代码与对话时开启。
4. 在 Collector 增加 attributes/redaction processor，移除不需要的身份、路径、命令和错误文本。
5. 对 `OTEL_EXPORTER_OTLP_HEADERS` 使用密钥管理，避免写入仓库或日志。

## SigNoz 页面与官方规范差异

截至调研日期，SigNoz 页面可作为接入和仪表盘指南，但不是完整 schema 参考：

| 项目     | SigNoz 页面                                             | Anthropic 当前官方规范                                                                            |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 信号     | 重点描述 Metrics、Logs/Events                           | 另有 Beta Traces                                                                                  |
| Events   | 列出核心 API、工具、认证、MCP、插件、Skill、Hook 等事件 | 还包括较新的`assistant_response`、`api_refusal`、原始 request/response body、更多 Hook 字段等 |
| 内容开关 | 主要提示`OTEL_LOG_USER_PROMPTS`                       | 还定义 assistant response、tool details、tool content、raw API body 的独立风险边界                |
| 结构展示 | 展示 SigNoz 中展平后的日志/指标属性                     | 说明 Resource、data point、LogRecord、Span 层级及关联方式                                         |
| 关联     | 强调`prompt.id`                                       | Traces 另提供`trace_id`/`span_id` 父子模型，工具可用 `tool_use_id` 关联                     |

因此，接入 SigNoz 时可沿用其 endpoint、ingestion key 和 dashboard 配置；设计采集白名单、数据分级、存储周期和兼容实现时，应按 Claude Code 具体版本对应的 Anthropic 官方 Monitoring 页面复核。

## SigNoz 实测验证

2026-07-14 在 SigNoz 中抽查 Claude Code `2.1.209` 的实际 Logs 和 Traces，结果与本文主体结论一致：

| 检查项         | 实测结果                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trace 层级     | 一条 Trace 包含父`claude_code.interaction` 和子 `claude_code.llm_request`，通过同一 `trace_id`、`parent_span_id` 和 `CHILD_OF` 关联                |
| LLM span       | 包含`model`、`gen_ai.system`、`gen_ai.request.model`、`llm_request.context`、`duration_ms`、`attempt`、`success`、`status_code` 和 `error` |
| 重试信息       | `llm_request` 中存在 `gen_ai.request.attempt` span event，包含 attempt 和 client request ID                                                              |
| 错误状态       | HTTP 403 请求的 span status 为`ERROR`，状态消息与错误字段一致                                                                                              |
| Logs/Event     | 观察到`user_prompt`、`assistant_response`、`api_request`、`api_error` 和 `mcp_server_connection`                                                   |
| 内容脱敏       | `user_prompt.prompt` 与 `assistant_response.response` 均为 `<REDACTED>`，但长度字段仍会上传                                                            |
| 身份信息       | 默认事件和 span 中可见组织 ID、账号 ID/UUID、用户邮箱、持久化用户 ID、会话 ID 和终端类型                                                                     |
| OTLP 层级      | `service.name`、`service.version`、OS 和 host 架构出现在 Resource；事件字段出现在 Log attributes；scope 为 `com.anthropic.claude_code.events`          |
| 事件关联       | 交互内的`user_prompt`、`assistant_response` 和 `api_error` 带 `prompt.id`、`trace_id` 和 `span_id`                                               |
| 非交互事件关联 | 抽查的`mcp_server_connection` 带 `session.id` 和 `prompt.id`，但 `trace_id`、`span_id` 为空                                                        |

实测环境把默认 `service.name=claude-code` 覆盖为自定义服务名。这符合 OTel Resource 可配置行为，也说明在 SigNoz 中筛选 Claude Code 数据时不能只依赖默认 service name，事件/Span 名的 `claude_code.` 前缀和 instrumentation scope 更稳定。

日志与 Trace 的关联能力具有事件类型和版本差异。不能假设所有 `claude_code.*` LogRecord 都有 trace context；查询与审计应同时保留 `trace_id`、`session.id`、`prompt.id`、`tool_use_id` 和 `event.sequence` 等关联路径。

## 与本仓库的关系

本仓库目标是让 opencode 输出接近 Claude Code 的可观测信号，但两者并非完全同构：

- 设置 `OPENCODE_METRIC_PREFIX=claude_code.` 只改变指标名前缀，不会自动补齐 Claude Code 的全部字段、事件和语义。
- 本仓库当前 README 列出的 opencode 指标包含 Claude Code 没有的扩展项，例如 `session.duration`、`session.token.total`、`model.usage` 和 `retry.count`。
- Dashboard 兼容应逐项核对 metric 名、单位、类型、temporality、attribute 名和枚举值，不能只核对名称前缀。
- Claude Code 的内容采集开关是其原生 CLI 行为；本仓库使用 `OPENCODE_*` 配置，不能直接假设 `OTEL_LOG_*` 开关对插件生效。

## 参考资料

1. [SigNoz：Claude Code Monitoring &amp; Observability with OpenTelemetry](https://signoz.io/docs/claude-code-monitoring/)
2. [Anthropic：Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage.md)
3. [Anthropic：Agent SDK Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability)
4. [OpenTelemetry Protocol Specification](https://opentelemetry.io/docs/specs/otlp/)
5. [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
