# OwnGate

OwnGate 是自托管的个人网络资产网关。你在自己的服务中管理网站连接，再通过 **MCP、CLI 或 HTTP API**，向 Agent 和脚本开放明确授权的数据。

网站凭据保留在服务端；每个客户端使用独立令牌，按连接、能力和字段范围授权。三个入口共用权限校验、结果过滤、缓存与审计。

## 当前范围

项目仍处于开发阶段，面向单人自用和可信局域网，尚不适合直接暴露公网或作为多租户服务。当前以只读查询为主，生产站点写执行关闭；提案与审批框架不代表已支持网站写入。

- **连接**：New API 的账户、用量与管理查询；Bilibili、知乎、小红书、X 的浏览器会话与只读能力；受限声明式 HTTP / OpenAPI 扩展。
- **接入**：Web 后台管理连接和客户端，MCP 发现与调用能力，CLI 按连接名称查询，HTTP API 供自建应用使用。
- **运行**：持久查询任务、UTC cron 监控、SMTP 通知；独立浏览器 profile、出网控制、加密凭据与离线恢复工具。

各平台的实测范围不同。社交网站接口与风控会变化，部分数据可能未知或仅部分可用。请先阅读[实现边界](docs/explanation/product-scope.md)，不要把本地夹具测试视为所有真实平台已经通过验收。

## 开始使用

需要 Linux amd64、Docker Engine 24+、Docker Compose 2.24+，以及正式使用时提供 HTTPS 的反向代理。

1. 按[交互式安装指南](deploy/release-README.md#交互式安装推荐)选择目录、地址和端口，自动下载版本部署包、生成密钥，并选择是否启动；也可按同页步骤手动部署；需要自行构建时使用[源码部署指南](deploy/README.md)。
2. 按[首次使用](docs/guides/first-query.md)创建管理员、添加连接并完成一次只读查询。
3. 创建限定权限的客户端，按[客户端接入](docs/guides/connect-clients.md)连接 MCP、CLI 或 HTTP API。

交互式安装：

```sh
curl -fsSL https://raw.githubusercontent.com/ChengHongxu/owngate/main/deploy/install.sh | bash
```

脚本默认仅监听本机，首次安装会生成独立密钥，并询问是否启动。已有实例请按[升级步骤](deploy/release-README.md#数据与升级)保留配置与数据。

正式发行提供 Linux amd64 的四个服务镜像和版本部署包，不要求安装全局 CLI。开发者也可以从源码构建；CLI 构建后可用 `node apps/cli/dist/bin.js` 调用。

## 文档

| 你要做什么 | 入口 |
|---|---|
| 浏览全部用户与贡献者文档 | [文档导航](docs/README.md) |
| 部署、备份或恢复服务 | [部署指南](deploy/README.md) · [离线维护](docs/guides/maintenance.md) |
| 编写调用脚本或接入 Agent | [客户端接入](docs/guides/connect-clients.md) · [客户端接口参考](docs/reference/client-interfaces.md) |
| 导入或开发连接器 | [扩展指南与格式参考](docs/extensions.md) · [New API 接口范围](connectors/newapi/README.md) |
| 理解设计和安全边界 | [架构](docs/explanation/architecture.md) · [产品范围](docs/explanation/product-scope.md) |
| 修改代码、运行测试或提交贡献 | [贡献指南](CONTRIBUTING.md) · [测试指南](docs/guides/testing.md) |

## 本地开发

需要 Node.js 24+、pnpm 11，具体版本以 [package.json](package.json) 为准。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm typecheck:tests
pnpm test
```

启动开发服务前请按[贡献指南](CONTRIBUTING.md)设置持久主密钥和数据路径。真实浏览器连接还需要 browser 与 egress 服务，仅启动后台不能提供远程登录。
