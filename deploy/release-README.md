# 使用 OwnGate 发布包

本部署包使用已经构建的版本镜像，无需克隆源码、安装 Node.js 或在本机编译。支持 Linux amd64。需要 Docker Engine 24+、Docker Compose 2.24+、OpenSSL，以及正式使用时提供 HTTPS 的宿主机 nginx。

OwnGate 当前面向单人自用或可信局域网。下载版本对应的部署压缩包与 `SHA256SUMS`，在同一目录运行 `sha256sum -c SHA256SUMS`，确认成功后解压。以下命令在解压后包含 `compose.yaml` 的目录执行。

## 首次启动

```sh
cp .env.example .env
```

编辑 `.env`：把 `OWNGATE_ORIGIN` 设为实际访问地址，例如 `https://owngate.example.com`；把 `OWNGATE_RP_ID` 设为相同域名，不含协议与端口。首次本机试用也可保留 `http://localhost:3000` 和 `localhost`。默认端口只绑定 `127.0.0.1`。

为新实例生成四个独立密钥，仅在首次部署执行：

```sh
mkdir -p secrets
(umask 077
  for name in master_key browser_rpc_secret egress_control_secret http_runtime_secret; do
    test ! -e "secrets/$name" || { echo "密钥已存在：$name" >&2; exit 1; }
  done
  for name in master_key browser_rpc_secret egress_control_secret http_runtime_secret; do
    openssl rand -hex 32 > "secrets/$name" || exit 1
  done
)
sudo chown 1000:1000 secrets/*
sudo chmod 0600 secrets/*
```

密钥必须能被容器 UID 1000 读取。`http_runtime_secret` 的权限必须为 0600 或 0400，属主不能为 65534。不要替换已有实例的主密钥，丢失主密钥后不能恢复其中加密的凭据。

```sh
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3000/health
```

使用本机地址访问时，可打开 `http://localhost:3000`。正式域名访问需先按 `nginx.example.conf` 配置域名、证书与反向代理：将其中的 `${OWNGATE_DOMAIN}` 手动替换为实际域名，nginx 不会读取 Compose 的 `.env`。禁止访问 `/internal/` 并关闭 MCP SSE 缓冲。`OWNGATE_ORIGIN` 必须与浏览器地址栏完全一致。不要直接向公网开放后台 HTTP 端口。

首次访问创建管理员，在安全设置配置 Passkey 或 TOTP，再添加连接。验证连接后测试所需能力，为客户端授予最小权限并保存一次性显示的令牌。`/health` 正常不代表目标平台登录或业务查询已经成功。

## 数据与升级

数据库保存在 `owngate_server-data` 卷，浏览器登录资料保存在 `owngate_browser-profiles` 卷。Compose 项目名固定为 `owngate`，更换部署目录时仍应保留这一项目名。`.env`、`secrets/`、数据库和 profile 都属于私有数据。

升级前阅读目标版本的 Release 说明，停服并备份数据卷，分别保管主密钥与数据备份。停止服务使用 `docker compose down`，不要使用删除数据卷的 `down -v`。

用目标版本部署包中的 `compose.yaml` 和示例 nginx 配置更新当前部署目录；保留自己的 `.env`、`secrets/`、数据卷与证书配置。核对新增配置后再次运行 `docker compose pull` 和 `docker compose up -d`。四个服务使用同一版本标签，不要混用版本。

容器启动可能升级数据库；仅换回旧镜像不保证能够降级。需要回退时按该版本说明恢复匹配的数据库、浏览器资料和密钥备份。离线密码恢复、密钥轮换等操作参见对应版本源码中的 `docs/guides/maintenance.md`。

如果拉取 GHCR 镜像出现 401 或 403，先确认发布者已经将四个镜像包设为公开；私有包需要用具有读取权限的 GitHub 身份执行 `docker login ghcr.io`。不要把登录凭据写入 Compose 或 `.env.example`。
