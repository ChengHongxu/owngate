# webridge 部署指南

## 前提条件

- Docker Engine 24+ 与 Docker Compose v2
- 外部 nginx 已配置好 TLS 反代（参考 `nginx.example.conf`）

## 快速开始

### 1. 准备环境配置

```sh
cp deploy/.env.example deploy/.env
# 按实际情况编辑 deploy/.env，至少填写 WEBRIDGE_DOMAIN 和 BROWSER_RPC_SECRET
```

### 2. 生成主密钥

```sh
mkdir -p deploy/secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  > deploy/secrets/master_key
chmod 0600 deploy/secrets/master_key
```

主密钥一旦生成不要更换——更换后 vault 中所有加密数据将无法解密。
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
