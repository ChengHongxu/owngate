# 接入 Agent、命令行和应用

先完成[首次使用](first-query.md)，在后台创建客户端并保存其令牌，授予所需连接、能力和字段权限。同一客户端身份可以使用全部接口；接入方式不改变权限范围。

## MCP 客户端

支持 Streamable HTTP 的客户端直接配置服务器的 `/mcp` 地址，例如 `https://owngate.example.com/mcp`，认证使用客户端 Bearer 令牌。具体配置格式以你的 MCP 客户端为准，后台「客户端 → 接入方法」提供可复制内容。

连接后按以下顺序发现并调用：

1. `list_connections` 获取获准连接。
2. `list_capabilities` 或 `describe_capability` 读取能力的输入、输出和调用策略。
3. `query` 执行查询；需要持久任务时使用 `task_submit`，随后读取 `task_result`。

只支持 stdio 的本地客户端可使用 CLI 桥接。先在本机按下一节登录，再将命令配置为 `node`，参数配置为本仓库构建产物的绝对路径及 `mcp`：

```json
{
  "mcpServers": {
    "owngate": {
      "command": "node",
      "args": ["/absolute/path/to/owngate/apps/cli/dist/bin.js", "mcp"]
    }
  }
}
```

桥接进程读取本机 CLI 配置；运行 MCP 客户端的用户和环境必须能访问该配置。不要把令牌写入公开的 MCP 配置示例。

## CLI

在仓库根目录构建后登录，令牌通过隐藏输入提示录入：

```sh
pnpm build
node apps/cli/dist/bin.js login --server https://owngate.example.com
node apps/cli/dist/bin.js status
node apps/cli/dist/bin.js conn ls
```

假设你将一个连接命名为 `AFF`，可以直接使用名称，不需要复制 ID：

```sh
node apps/cli/dist/bin.js cap ls AFF
node apps/cli/dist/bin.js cap show AFF account.balance
node apps/cli/dist/bin.js query AFF account.balance
node apps/cli/dist/bin.js conn use AFF
node apps/cli/dist/bin.js query account.balance --json
```

能力标识来自当前连接的能力目录，`account.balance` 仅是 New API 等连接的示例，其他平台应替换成目录中的真实能力。脚本可以用 `--token-stdin` 登录，避免把令牌放在 shell 参数中。选择器、异步任务和输出规则见[接口参考](../reference/client-interfaces.md)。

## HTTP API

在私有环境中设置服务器地址和客户端令牌，再发现获准资源：

```sh
export OWNGATE_SERVER=https://owngate.example.com
read -r -s OWNGATE_TOKEN
export OWNGATE_TOKEN
curl --fail-with-body "$OWNGATE_SERVER/api/connections" \
  -H "Authorization: Bearer $OWNGATE_TOKEN"
```

从响应取连接 ID 后查询其能力目录：

```sh
export OWNGATE_CONNECTION_ID='替换为获准的连接ID'
curl --fail-with-body "$OWNGATE_SERVER/api/connections/$OWNGATE_CONNECTION_ID/capabilities" \
  -H "Authorization: Bearer $OWNGATE_TOKEN"
```

对支持 `account.balance` 的连接执行查询：

```sh
curl --fail-with-body "$OWNGATE_SERVER/api/invoke" \
  -H "Authorization: Bearer $OWNGATE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"connection_id\":\"$OWNGATE_CONNECTION_ID\",\"capability_id\":\"account.balance\",\"input\":{}}"
```

以上 shell 示例使用 Bash / Zsh。使用结束后清除环境中的令牌：`unset OWNGATE_TOKEN`。不要将带认证参数的命令或进程诊断发到公开日志。

## 持续运行的小工具

让应用的可信宿主管理认证、定时调用和生命周期。宿主可以复用已认证的 MCP 连接，也可以从服务端调用 HTTP API；Agent 获得 MCP 工具访问权不代表它能读取宿主保存的令牌。

生成的 UI 通过宿主桥梁请求获准数据，界面和调度由宿主决定。OwnGate 不托管生成的 UI，也不签发专供浏览器公开使用的令牌。关闭会话后仍要运行的挂件，需要宿主提供持久进程或任务管理。

轮询需要考虑连接器缓存、冷却期和平台限流。`no_cache` 仅跳过 OwnGate 查询缓存，不绕过上游缓存或风控。每 5 秒请求不保证取得每 5 秒更新的数据，尤其不适合浏览器社交连接。
