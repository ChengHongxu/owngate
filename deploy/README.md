# 从源码部署 OwnGate

本指南用于单人自用或可信局域网部署。需要 Docker Engine 24+、Docker Compose v2，以及提供 HTTPS 的宿主机 nginx。下方密钥生成示例还需要 Node.js 24+。配置参考 [docker-compose.yml](docker-compose.yml)、[.env.example](.env.example) 和 [nginx.example.conf](nginx.example.conf)。所有命令在仓库根目录执行。

已有版本时可直接使用 GitHub Release 部署包，按[发布包部署说明](release-README.md)拉取镜像；以下步骤用于在本机从源码构建。版本发布流程见[发布指南](../docs/guides/releases.md)。

## 首次部署

```sh
cp deploy/.env.example deploy/.env
# 编辑 OWNGATE_ORIGIN、OWNGATE_RP_ID，填写实际的 HTTPS 域名。
```

生成四个独立密钥。示例不包含任何可直接使用的生产密钥：

```sh
mkdir -p deploy/secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/master_key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/browser_rpc_secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/egress_control_secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/http_runtime_secret
chmod 0600 deploy/secrets/*
# Linux 上确保 server/browser/egress 的 uid 1000 能读取：
sudo chown 1000:1000 deploy/secrets/*
```

Compose 本地文件型 secret 保留宿主文件权限，不能依靠 `mode` 自动修正权限。`http_runtime_secret` 必须为 0600 或 0400、属主不能为 65534，否则 HTTP runtime 拒绝启动。server、browser 和 egress 以 UID 1000 运行；HTTP runtime 的控制进程以 root 启动，子进程强制降为 UID 65534，不能通过 Compose `user` 覆盖该行为。

主密钥用于逐记录信封加密。启动时会在事务中升级旧格式并校验主密钥，错误密钥会阻止启动。不要直接替换主密钥；轮换使用[离线 `vault rekey`](../docs/guides/maintenance.md)。备份数据库时，把主密钥与数据库分开保存；浏览器 profile 包含会话 cookie，也应作为敏感备份处理。

三个控制密钥可分别轮换，换后同时重启其共享服务：`browser_rpc_secret` 对应 server/browser，`egress_control_secret` 对应 browser/egress，`http_runtime_secret` 对应 server/http-runtime。

```sh
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
curl --fail http://127.0.0.1:3000/health
```

首次 `server-data` 卷继承 `/data` 的 UID 1000 权限。升级保留数据卷、浏览器 profile 卷与密钥。默认只在 `127.0.0.1:${PORT:-3000}` 发布 server HTTP 端口，局域网通过 nginx HTTPS 访问；nginx 配置必须拒绝 `/internal/`，并为 MCP SSE 关闭缓冲。

首次访问先创建唯一管理员，在「安全设置」完成 MFA，再添加连接与授权。只有后台会话可管理连接、签发令牌、修改授权与审批；MCP、HTTP API 和 CLI 共用同一客户端身份及其专用令牌。创建客户端只需名称与有效期，连接、能力和字段范围单独授权；新授权默认隐藏个人信息，接入方式不会改变数据可见范围。

MCP 客户端配置服务的 `/mcp` 地址与客户端 Bearer 令牌，使用标准工具发现连接、读取能力 Schema 和执行查询。HTTP API 使用同一客户端授权。外部应用的界面、调度和持续运行由其宿主管理；宿主可复用已经认证的 MCP 连接。`OWNGATE_ORIGIN` 配置为后台实际访问地址，用于认证来源检查和 Passkey。

## 服务与数据

| 服务 | 网络与权限 | 持久数据 / 密钥 |
|---|---|---|
| `server` | 内部网 + API 出网，UID 1000；唯一对外入口 | SQLite、主密钥、browser/HTTP 控制密钥 |
| `http-runtime` | 仅内部网；root 控制进程、65534 子进程、只读文件系统 | 仅 HTTP 控制密钥；没有数据库、业务凭据、主密钥或 profile |
| `browser` | 仅内部网，UID 1000；Chromium 沙箱与每连接 profile | browser/egress 控制密钥、浏览器 profile |
| `egress` | 内部网 + 独立出网 | egress 控制密钥；验证每连接代理密码、域名白名单和短租约，拒绝内网/特殊 IP 与 DNS 重绑定 |

SMTP、监控条件与计划在后台配置，整体加密存储。计划采用 UTC 五字段 cron，停机错过的周期不补跑。CLI/MCP 获得的任务 ID 只代表已提交，读取结果仍验证当前授权。

## 访问方式

`OWNGATE_ORIGIN` 必须与浏览器地址栏里的地址完全一致（协议、主机、端口）。

`GET /health` 成功只说明当前端口有服务响应，不能证明该进程包含 `/admin/overview`。遇到概览 404 时应核对代理目标、响应进程和构建版本。构建不会更新已运行的 Node 进程；若进程启动早于新构建，应使用原配置与同一持久主密钥重新启动既有服务。

| 方式 | `OWNGATE_ORIGIN` | Passkey | 说明 |
|---|---|---|---|
| 本机 | `http://localhost:3000` | 可用 | WebAuthn 把 localhost 视为安全上下文 |
| 局域网 IP 试用 | `http://192.168.x.x:3000` | 不可用 | 显式设置 `BIND_HOST` 为局域网 IP；用密码 + TOTP，明文 HTTP 仅供可信网络临时试用 |
| 正式域名 | `https://owngate.example.com` | 可用 | 同时把 `OWNGATE_RP_ID` 设为该域名 |

Passkey 绑定在 RP ID 上，更换域名后需要重新注册。签发令牌、修改授权、远程登录、导入 cookie、监控与扩展安装要求最近一次二次验证。首次 MFA 设置需要再次验证密码；已注册 Passkey 后，敏感操作与凭据管理必须使用 Passkey，不能降级为密码加 TOTP。生产不会接受 `DEV_SKIP_AUTH` 绕过认证。

## 验证与维护

首次部署后按[首次使用](../docs/guides/first-query.md)创建管理员、验证连接并配置客户端。`GET /health` 只检查服务响应，真实浏览器登录还依赖 browser、egress、共享 RPC 密钥与网络。

容器隔离、浏览器和 UI 检查见[测试指南](../docs/guides/testing.md)。这些检查使用隔离夹具，不替代目标平台、真实邮箱、实体认证器与备份恢复的验收。

密码恢复、主密钥轮换与丢失后的凭据重置见[离线维护](../docs/guides/maintenance.md)。不要直接替换主密钥；已有数据库必须使用与它匹配的密钥。

`deploy/.env`、`deploy/secrets`、数据库和浏览器 profile 不得提交。浏览器容器使用 `SYS_ADMIN` / `SYS_CHROOT` 支持 Chromium 沙箱，建议宿主磁盘加密并定期备份。
