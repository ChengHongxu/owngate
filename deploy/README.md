# webridge 部署指南

## 前提条件

- Docker Engine 24+ 与 Docker Compose v2
- 外部 nginx 已配置好 TLS 反代（参考 `nginx.example.conf`）

## 快速开始

### 1. 准备环境配置

```sh
cp deploy/.env.example deploy/.env
# 按实际情况编辑 deploy/.env，至少填写 WEBRIDGE_ORIGIN（见下方「访问方式」）
```

### 2. 生成密钥

```sh
mkdir -p deploy/secrets
# 主密钥：加密 vault 中的凭据
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/master_key
# server ↔ browser worker 内部 RPC 的 HMAC 密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/browser_rpc_secret
chmod 0600 deploy/secrets/*
```

两个容器都以 uid 1000 运行，Compose 按宿主文件权限挂载 secret，所以这两个文件的属主须为 uid 1000（或放宽到 0644）。

主密钥一旦生成不要更换——更换后 vault 中所有加密数据将无法解密。
`browser_rpc_secret` 可以随时更换，换完重启 server 和 browser 两个服务即可。
备份 `server-data` 卷时，**不要**将 `master_key` 文件与数据放在同一位置。

### 3. 启动服务

```sh
docker compose -f deploy/docker-compose.yml up -d
```

### 4. 验证

服务启动后，server 监听在：

```
http://localhost:${PORT:-3000}
```

nginx 反代配置参考 `deploy/nginx.example.conf`，需将上游地址指向 `127.0.0.1:${PORT:-3000}`。

## 访问方式

`WEBRIDGE_ORIGIN` 必须与浏览器地址栏里的地址完全一致（协议、主机、端口）。

| 方式 | `WEBRIDGE_ORIGIN` | Passkey | 说明 |
|---|---|---|---|
| 本机 | `http://localhost:3000` | 可用 | WebAuthn 把 localhost 视为安全上下文 |
| 局域网 IP 试用 | `http://192.168.x.x:3000` | 不可用 | WebAuthn 不接受 IP 作 RP ID，且要求 HTTPS；用密码 + TOTP 登录。密码与会话 cookie 明文传输，只在可信网络使用 |
| 正式域名 | `https://webridge.example.com` | 可用 | 同时把 `WEBRIDGE_RP_ID` 设为该域名 |

Passkey 绑定在 RP ID（域名）上。从 IP 或 localhost 换到正式域名后，需要在后台重新注册 Passkey。
敏感操作的审批只接受 Passkey，用 IP 试用时这类操作无法审批；M1 的只读能力不受影响。

## 服务说明

| 服务 | 说明 |
|------|------|
| `server` | Fastify HTTP 服务，暴露 REST + MCP 端点，读取 `/run/secrets/master_key` |
| `browser` | Playwright 浏览器 worker，仅在 `internal` 网络内部可达 |
| `egress` | M0 占位服务，M1 实现按连接出网代理 |

## 安全注意事项

- `deploy/secrets/master_key` 已被 `.gitignore` 排除，确认不要手动提交
- `deploy/.env` 也已被 `.gitignore` 排除
- browser 容器使用 `cap_add: [SYS_ADMIN]` 以支持 Chromium 沙箱，宿主机建议开磁盘加密
