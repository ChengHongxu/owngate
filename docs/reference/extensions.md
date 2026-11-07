# 扩展格式参考

操作步骤见[扩展导入](../extensions.md)。本页描述当前受限清单与 OpenAPI 契约。

## 兼容范围

| 项目 | 当前支持 |
|---|---|
| 原生清单 | 声明式 `http`、单值 `config` / 授权字段、能力输入与输出映射；不支持代码适配器、额外 discovery 请求；schema 引用需提前展开 |
| OpenAPI 版本 | 3.0.x；3.1 及其他版本需要先转换 |
| 服务器 | 使用首个固定、绝对 HTTP(S) `servers` 地址；保留其路径前缀；不支持 URL 变量、路径级或操作级服务器覆盖 |
| 认证 | 整个连接器共用一种 Bearer 或请求头 API Key；不支持查询字符串凭据、Cookie 安全方案、OAuth 流程或操作间不同的认证定义 |
| 输入参数 | `path` / `query` 中有明确类型的字符串、整数、数值和布尔值；查询参数使用独立 URL 编码，省略未填写的可选项，保留其 schema 默认值 |
| 响应 | HTTP 200 或 201 的 `application/json`，必须声明 schema；OpenAPI 响应映射到结果的 `data.result` |
| Schema | 明确类型的标量、对象、数组及 nullable；OpenAPI 支持 `#/components/schemas/...` 本地引用，不支持远程、文件及循环引用 |
| 连接入口与验证 | 原生顶层 `views` / `verification`；OpenAPI 顶层 `x-owngate-views` / `x-owngate-verification`；可用 `x-owngate-config` 增加非秘密的单值配置，不能覆盖生成的 `base_url` |
| 暂不支持的结构 | `oneOf` / `anyOf` / `allOf`、动态对象、未支持的 schema 约束会拒绝导入；对象/数组参数或不支持的位置会让对应操作保持禁用 |

输出只保留声明的字段，额外上游字段不会直接传给客户端。`x-sensitivity`、`x-secret`、`writeOnly` 和 `x-unit` 可随 OpenAPI schema 保留；原生输出字段也可声明 `sensitivity` 和 `unit`。实际币种与单位需来自站点文档，导入器不会自动推算。字段过滤、授权、审计与普通连接使用同一调用入口。

原始文档及展开后的清单各自最多 128 KiB，每次最多 50 个操作。文档结构最多嵌套 24 层，展开后的 schema / 引用最多 8 层；YAML 别名数量受限，并拒绝重复键、特殊执行标签和危险对象键。认证请求头中的实际凭据、授权字段的默认值和示例值也会被拒绝。

## 结果展示

适配器负责获取和整理数据，`output` Schema 描述字段，`presentation` 选择后台的展示方式。没有展示声明时，后台根据 Schema 自动展示标量、嵌套对象和数组；字段名优先使用 `title`，时间可用 `format: date-time`，单位使用 `x-unit`。数组默认预览 5 条，更多记录与长正文按需展开；完整 JSON 保留在「详细数据」中。

原生清单在对应能力上声明 `presentation`，路径相对于查询结果的 `data`。下面的表格从 `data.records` 取数据，列路径相对于每条记录：

```yaml
capabilities:
  - id: records.list
    title: 记录列表
    kind: query
    effect: read
    request: { method: GET, path: /api/records }
    output:
      records:
        from: $.data.items
        schema:
          type: array
          items:
            type: object
            additionalProperties: false
            properties:
              title: { type: string, title: 标题 }
              count: { type: integer, title: 次数, x-unit: requests }
              created_at: { type: string, format: date-time, title: 创建时间 }
              url: { type: string, format: uri, title: 原文 }
    presentation:
      type: table
      items: $.records
      max_rows: 5
      columns:
        - { path: title, label: 标题 }
        - { path: count, label: 次数, format: number }
        - { path: created_at, label: 创建时间, format: datetime }
        - { path: url, label: 原文, format: link }
```

OpenAPI 在操作上使用 `x-owngate-presentation`。由于导入器保留 `data.result` 包装，响应 Schema 中的 `items` 数组对应 `$.result.items`；各列仍相对于数组元素：

```yaml
paths:
  /records:
    get:
      operationId: records.list
      x-owngate-presentation:
        type: table
        items: $.result.items
        columns:
          - { path: title, label: 标题 }
          - { path: count, label: 次数, format: number }
      responses:
        '200':
          description: 查询结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      type: object
                      properties:
                        title: { type: string, title: 标题 }
                        count: { type: integer, x-unit: requests }
```

扩展能力的 `id` 需以英文字母开头，其后只含英文字母、数字、点、下划线或短横线，总长度不超过 128 字符。OpenAPI 的 `operationId` 会先将范围外的字符替换为下划线，处理后仍需满足该规则且不能重复；示例中的 `records.list` 可直接使用。

| `type` | 用途 | 可选配置 |
|---|---|---|
| `auto` | 按 Schema 自动展示 | `max_rows` |
| `stats` | 紧凑数值与资料摘要 | `fields`；字段可设 `prominent: true` 突出显示 |
| `table` | 多条结构相同的记录 | 必填 `items`；可选 `columns`、`max_rows` |
| `list` | 字符串列表或记录列表 | 必填 `items`；可选 `fields`、`max_rows` |
| `feed` | 标准社交内容列表 | 必填 `items`；可选 `max_rows` |
| `json` | 直接打开详细数据 | 无需字段绑定 |

`feed` 使用标准内容字段 `title`、`text`、`author.name`、`published_at`、`metrics`、`url`；自定义结构可选 `auto`、`table` 或 `list`。`fields` 只用于 `stats` 和 `list`，分别相对于 `data` 和数组元素；`columns` 只用于 `table`，相对于数组元素。声明时各支持 1–12 项，包含必填的 `path`、可选的 `label`（1–80 字符）、`format` 和 `prominent`；`format` 可选 `text`、`number`、`datetime`、`link`、`badge`。`max_rows` 为 1–20 的整数，数组默认预览 5 条。

“显示更多”只展开本次查询已取得的数据，不会额外请求平台。为限制页面体积，每个集合最多预览 50 条，自动表格最多 6 列，整体展示最多 400 个节点、5 层结构，单段文本预览最多 4000 字符；超出部分仍可在「详细数据」中查看。需要下一页时，使用能力的分页参数重新查询。

路径只支持 `$`、`$.foo.bar` 或 `foo.bar` 形式的静态属性，最多 128 字符、8 段；每段以英文字母或下划线开头，只含英文字母、数字、下划线或短横线。不支持索引、通配符、表达式或危险对象键，同一字段也不能重复绑定。导入时会核对路径和 Schema，数组来源、数值、时间与链接格式绑定不匹配时拒绝安装；不能用展示声明引用未声明的上游字段。

展示声明随能力目录传递，不写入业务结果、缓存或审计。前端只显示当前权限已允许的数据，运行结果中的字段状态与单位优先于静态 Schema；未知值保留未知，真实零值保留为零，空单位不会被静态币种覆盖。链接只接受不含嵌入凭据的 HTTP(S) 地址；不执行 HTML、脚本或模板，也不自动加载外部图片。

## 连接入口与验证

所有连接共用详情页和能力弹窗。配置表单来自 `config`，凭据表单来自 `auth`，普通查询的参数与结果来自能力的 `input`、`output` 和 `presentation`；界面不根据连接器 ID 增加业务入口。

可选顶层 `verification` 指定点击「验证连接」时读取的能力；`auth` 可指定其中一个用于验证授权的查询。授权验证成功只解除较早的认证阻断，其他未测试查询显示「待验证」，保留各自更新的实测结果。公开查询成功不会证明账户已认证，单个其他接口的认证失败也不会把整个连接标成需要重新登录。网络和限流故障显示「暂不可用」，缺少实现或响应解析需要调整时显示「适配异常」。未声明验证计划时，浏览器连接使用 `login.whoami`，其他连接选择无需额外参数的只读查询。导入时未勾选的能力始终禁用，不会被验证或视图重新启用。

可选顶层 `views` 声明额外的组合入口，目前支持 `comparison`。下面是一个库存比较示例，假设对应能力与输出 Schema 已声明：

```yaml
config:
  count_unit: { type: string, enum: [unknown, pieces], default: unknown }
verification:
  capabilities: [session.check]
  auth: session.check
views:
  - id: stock-audit
    type: comparison
    title: 库存与供应量
    source:
      capability: stock.snapshot
      items: entries
      id: sku
      label: title
      value: quantity
      updated_at: checked_at
      updated_at_format: iso8601
      unit: { config: count_unit, allowed: [pieces] }
    detail: { capability: stock.entry, input: sku, id: sku }
    target: { capability: supplier.capacity, value: available }
```

`source.items` 相对于源结果的 `data`，`id`、`label`、`value`、`updated_at` 相对于数组元素；`detail.id` 和 `target.value` 分别相对于各自结果的 `data`。时间格式支持 `iso8601` 或 `unix_seconds`。详情查询的绑定参数必须是单个输入字段，类型与源记录 ID 一致；其他必填参数需要默认值。源和详情必须引用已声明的只读查询，入口还会根据当前连接的角色和启用状态筛选。

目标能力属于用户明确选择的另一个连接，可来自不同连接器，不要求在源清单中声明。保存关联时读取一次详情以确认记录 ID，不会猜测名称、地址或凭据的对应关系。打开弹窗只读取元数据与已保存关联，点击「读取并比较」才执行业务查询；每次最多处理 100 条记录，关联同一目标时复用本次结果，不额外预查询。

源单位必须来自明确确认的字符串枚举配置，目标单位来自运行结果的字段元数据。数值、可见状态、源更新时间及相同单位都明确时才计算差额；缺失关联、单位不同或单项失败保留各自状态。修改连接或视图后的迟到响应不能生成旧的可比较值。关联按连接、视图和记录 ID 隔离，读取和执行均受管理员认证约束，保存、删除和比较执行另需二次验证。

OpenAPI 使用同一结构，将上例顶层键改为 `x-owngate-config`、`x-owngate-verification` 和 `x-owngate-views`。OpenAPI 结果有 `data.result` 包装，因此 `source.items`、`detail.id` 和 `target.value` 需要包含 `result` 前缀；行内字段仍相对于数组元素。声明只支持静态路径、最多 8 个视图，不支持脚本、HTML 或任意自定义组件。预览会返回规范化声明，声明变更参与安装指纹，安装后随扩展持久保存并在重启时恢复。

## 版本与恢复

安装会保存规范化清单、选中的能力和 SHA-256 指纹。服务重启时先恢复扩展，再恢复已有连接；定义损坏或指纹不一致的扩展显示为未加载，不注册其能力。

连接器 ID 不允许覆盖，当前没有原地更新、切换启用范围或删除安装的入口。升级时使用新的 ID，创建并验证新连接，再迁移客户端授权。后续内置连接器若使用了已安装扩展的 ID，服务会停止启动，要求先迁移冲突扩展；已有连接不会自动使用另一个实现。

## 后台 API

所有接口需要管理员会话，安装接口另需二次验证：

| 接口 | 请求 / 响应 |
|---|---|
| `GET /admin/extensions` | 已安装扩展及加载状态，不返回凭据 |
| `POST /admin/extensions/preview` | 请求 `{format: 'manifest' \| 'openapi', source, id?}`；返回配置/授权字段定义、操作列表、允许选择范围及 `fingerprint`；不写数据库、不执行上游请求 |
| `POST /admin/extensions` | 传入同一源文档与 `enabled_capabilities: string[]`、`preview_fingerprint`；重新编译校验，创建新连接器，返回 201 |

并发安装相同 ID 时只有一个请求能成功。与内置或已有数据库连接器冲突、源文档与预览不一致时返回 409；选择写操作或不符合条件的操作时返回 400。


## 实现与验证位置

编译、OpenAPI 转换和展示声明位于 `packages/connector-runtime`；安装及恢复位于 `apps/server/src/extensions`。相关契约测试为 `openapi.test.ts`、`presentation.test.ts`、`connector-views.test.ts` 和 server 的 `extensions.test.ts`、`connector-views-extension.test.ts`。测试使用临时数据库和本地上游，不访问用户账号。

返回[文档导航](../README.md)。
