# New API 接口范围

本清单以 QuantumNous/new-api 官方项目的公开管理 API 为依据，核对提交为 [`45746eee4de25ab1eb75d4b7fbb8de2199483ea3`](https://github.com/QuantumNous/new-api/tree/45746eee4de25ab1eb75d4b7fbb8de2199483ea3)。本地 HTTP fixture 按这些返回结构构造，不表示已访问用户站点或验证所有 fork。

普通用户连接使用 `role: user`，这也是默认值；管理员连接明确选择 `role: admin`。管理员视角继续受站点令牌权限约束，选择 admin 不会为令牌增加权限。此处使用管理访问令牌（PAT），不读取渠道密钥，也不把 PAT 当作上游模型调用密钥。

| 能力 | 官方路由 | 视角 |
| --- | --- | --- |
| `account.balance` / `account.usage` | `GET /api/user/self` | user / admin |
| `model.list` | `GET /api/user/models` | user / admin |
| `model.prices` | `GET /api/pricing` | user / admin |
| `usage.logs` / `usage.summary` | `GET /api/log/self` / `/api/log/self/stat` | user / admin |
| `system.status` | `GET /api/status/test` | admin |
| `channel.list` / `channel.balance` | `GET /api/channel/` / `/api/channel/:id` | admin |
| `admin.logs` / `admin.usage` | `GET /api/log/` / `/api/log/stat` | admin |
| `admin.users` | `GET /api/user/` | admin |

接口来源：[API 路由](https://github.com/QuantumNous/new-api/blob/45746eee4de25ab1eb75d4b7fbb8de2199483ea3/router/api-router.go)、[渠道路由](https://github.com/QuantumNous/new-api/blob/45746eee4de25ab1eb75d4b7fbb8de2199483ea3/router/channel-router.go)、[用量控制器](https://github.com/QuantumNous/new-api/blob/45746eee4de25ab1eb75d4b7fbb8de2199483ea3/controller/log.go)、[价格结构](https://github.com/QuantumNous/new-api/blob/45746eee4de25ab1eb75d4b7fbb8de2199483ea3/model/pricing.go)。

分页使用 `p` / `page_size`，每页最多 100 条，时间过滤为 Unix 秒。默认参数在通过输入 schema 校验后提供给模板；输入中的模型名称会 URL 编码。数组输出只保留 schema 明确声明的字段，渠道 `key`、`settings`、`header_override`、用户密码和访问令牌等不进入统一结果。日志正文和 `other` 字段也不返回。

`quota` 只在站点公开的 `quota_per_unit` 或用户明确配置的比例有效时换算为美元，否则保留原始 `quota` 及单位。模型 `quota_type`、`model_price` 和倍率保持站点语义，不拼成一个未经确认的“每百万 token 价格”。

渠道余额来自站点缓存，带 `balance_updated_time`；没有调用 `update_balance`、渠道测试、获取密钥或任何写接口。部分这些操作虽然使用 GET，也会更新站点或发起上游请求，因此没有导入。渠道币种默认 `unknown`：只有用户确认并配置 `channel_balance_unit: USD`，且独立上游连接的余额字段也为 USD，才计算缓存减上游的差额；结果保留两个采样时间，不自动认定差额为账务异常。

渠道与上游通过后台显式选择并写入通用 `comparison_links`，按连接、视图和记录 ID 隔离；旧 `channel_upstream_links` 通过一次性迁移保留。不会根据地址、名称或秘密值猜测映射。缺失映射、未知单位和上游错误分别保留，整页返回 partial。

后台不再为此连接器提供专属查询页。`verification` 声明整体验证只查询 `account.balance`，`views` 中的 `channel-upstreams` 声明源列表、行详情、目标能力、数值及时间字段和单位确认配置。界面与服务使用通用比较组件，其他连接器和扩展也能声明相同类型的视图；是否显示入口取决于声明及当前连接的能力角色与启用状态。普通用户继续在能力卡片内查询，管理员视角额外显示清单声明的「渠道与上游对账」。

本地集成回归在 `apps/server/test/newapi.test.ts`，覆盖全部声明路径、普通用户越权、嵌套 PII、秘密字段过滤、默认分页、模板编码、映射持久化和逐行对账。未知 fork 的路径或返回结构不匹配时应显示实际失败/缺失数据，需要单独适配，不能推定已经兼容。
