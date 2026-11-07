# 客户端接口参考

客户端令牌使用 `Authorization: Bearer <token>`，用于数据读取，不授予管理员后台权限。上手配置见[客户端接入](../guides/connect-clients.md)。

## CLI

本仓库构建后的入口是 `node apps/cli/dist/bin.js`；下文用 `owngate` 表示该命令。完整选项以 `--help` 为准。

| 命令 | 用途 |
|---|---|
| `login --server <url>` | 保存服务器与客户端令牌；交互输入令牌不回显，支持 `--token-stdin` |
| `status` | 检查本机配置与服务可达性 |
| `conn ls` | 列出当前令牌获准的连接 |
| `conn use <selector>` | 设置默认连接；`--clear` 清除 |
| `cap ls [selector]` | 列出获准能力 |
| `cap show <selector> <capability>` | 查看输入输出和策略 |
| `query [selector] <capability>` | 执行只读查询 |
| `task ls` / `task get <id>` / `task events <id>` | 列出任务、读取结果或过程记录 |
| `task cancel <id>` | 取消排队任务，或停止等待正在执行的任务 |
| `mcp` | 将当前服务器转发为 stdio MCP |

连接选择器支持名称、完整 ID、唯一连接器类型和至少 4 字符的唯一 ID 前缀；有歧义时返回候选，不自动猜测。省略连接时使用已设置的默认连接或唯一获准连接。默认连接保存在本机配置中，切换服务器或令牌时清除。

CLI 默认配置为 `~/.owngate/config.json`，`OWNGATE_CONFIG_DIR` 可指定目录，`OWNGATE_TIMEOUT_MS` 可设置请求超时。配置文件包含令牌，应按私有凭据保管。

查询选项：

| 选项 | 语义 |
|---|---|
| `-p name=value` | 可重复，值尝试按 JSON 解析，普通文本保留字符串 |
| `--input '<json>'` | 输入 JSON 对象；`-p` 可覆盖其中字段 |
| `--all` / `--tag <tag>` | 查询全部或某标签的获准个人连接；与显式连接互斥 |
| `--no-cache` | 跳过 OwnGate 查询缓存 |
| `--async` | 单连接任务提交后立即返回 |
| `--wait <duration>` | 长任务等待时长，默认 `30s`；到期不重新提交 |
| `--json` | 输出完整 JSON；非终端默认 JSON |
| `--verbose` | stderr 中输出技术诊断 |

终端默认紧凑显示，错误信息写入 stderr。结果状态退出码为 `ok=0`、`error=1`、`partial=3`、`pending=4`、`needs_approval=5`、`needs_reauth=6`、`forbidden=7`、`unsupported=8`、`unknown_outcome=9`；CLI 用法错误或 `INVALID_PARAMS` 使用 2。

## HTTP API

| 方法与路径 | 请求 / 结果 |
|---|---|
| `GET /api/connections` | 返回当前令牌获准的连接，不含秘密或连接配置 |
| `GET /api/connections/:id/capabilities` | 返回该连接的获准能力与 Schema |
| `POST /api/invoke` | `{connection_id, capability_id, input?, no_cache?}`，返回结果信封 |
| `POST /api/query` | 批量查询，支持 `connection_ids` 或个人连接 `all` / `tag` |
| `POST /api/tasks` | 提交同一调用结构，返回 202 任务票据 |
| `GET /api/tasks` | 列出当前客户端可见任务 |
| `GET /api/tasks/:id` | 读取任务状态与结果 |
| `GET /api/tasks/:id/events?after=<id>` | 读取指定数字事件 ID 之后的过程记录 |
| `POST /api/tasks/:id/cancel` | 请求取消任务 |

`POST /api/invoke` 可携带 `Prefer: respond-async`；只有已授权且声明 `long_running` 的能力才协商异步并返回 202，其余走普通查询。超时不会触发第二次提交。任务提交成功不代表查询成功，应读取任务最终状态。

未知或未获准的连接对客户端均不可发现。任务读取按当前权限重新验证，撤销授权后不能凭旧任务 ID 继续取得数据。取消已运行任务只停止本地等待，不确认远端请求已经停止。

## MCP

远程端点为 `/mcp`，支持 Streamable HTTP，使用客户端 Bearer 令牌。工具目录按当前权限提供以下通用工具：

| 工具 | 用途 |
|---|---|
| `list_connections` | 发现获准连接 |
| `list_capabilities` / `describe_capability` | 读取能力输入输出、状态与策略 |
| `query` / `query_many` | 单个或多个连接的只读查询 |
| `task_submit` / `task_status` / `task_result` / `task_cancel` | 持久任务生命周期 |
| `propose_action` | 提交具体内容供人工审查，不执行网站写入 |
| `pause_actions` | 停止动作，客户端不能借此恢复或审批 |

后台可以为客户端固定少量能力工具，通用发现工具仍用于读取完整契约。资源 `owngate://connections` 和 `owngate://capabilities` 提供当前获准目录。实际完整 JSON Schema 以工具发现结果为准。

## 结果与刷新

结果区分 `success`、`partial` 和 `error`，并保留状态、来源、字段可见状态、单位、时间及错误。数值为零与未知不同；缺失字段或部分条目失败不能由调用方默认为完整成功。

`no_cache: true` 仅绕过 OwnGate 查询缓存，仍受上游缓存、角色、冷却期、预算和限流影响。网站响应中的文本是非可信数据，不能作为 Agent 指令。接口不提供宿主认证密钥读取，也不管理生成 UI 的生命周期。

返回[文档导航](../README.md)。
