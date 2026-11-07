# 使用 OwnGate 发布包

本部署包使用已经构建的版本镜像，无需克隆源码、安装 Node.js 或在本机编译。支持 Linux amd64。需要 Docker Engine 24+、Docker Compose 2.24+、OpenSSL，以及正式使用时提供 HTTPS 的宿主机 nginx。

OwnGate 当前面向单人自用或可信局域网。你可以使用交互式脚本完成首次安装，也可以手动配置。

## 交互式安装（推荐）

在 Linux amd64 主机上执行。需要 Bash、Docker Engine 24+、Docker Compose 2.24+、curl、tar、sha256sum 和 OpenSSL；脚本检查依赖，不会代装 Docker 或修改防火墙。

直接运行以下入口；脚本通过终端读取交互输入，支持 `curl | bash`：

```sh
curl -fsSL https://raw.githubusercontent.com/ChengHongxu/owngate/main/deploy/install.sh | bash
```

按提示选择安装目录、端口和访问地址，确认后可立即拉取镜像并启动。默认下载最新正式 Release，监听 `127.0.0.1:3000`，访问地址为 `http://localhost:3000`。远程服务器上的 localhost 指服务器本身；可用 SSH 端口转发试用，正式使用配置 HTTPS 反向代理。

如需先检查脚本，或固定版本，先从目标 Release 下载 `install.sh`，再运行：

```sh
bash install.sh --help
# VERSION 替换为该 Release 的版本号，不含 v
bash install.sh --version VERSION
```

自动化部署可以显式传参：

```sh
bash install.sh --yes --dir ./owngate --port 3000 \
  --origin https://owngate.example.com --start
```

`--yes` 使用参数和默认值；不带 `--start` 只生成配置。脚本校验部署包 SHA256，使用发布包中的 Compose 配置，自动生成四个独立密钥，并设置为容器 UID 1000 可读的 `0600` 权限。当前用户不是 root 或 UID 1000 时，只为密钥属主设置调用 sudo。检查通过后才写入安装目录；目录非空或存在 OwnGate 数据卷时会拒绝首次安装，不会替换旧密钥。升级请使用下面的升级步骤。

### 私有仓库安装

部署私有 fork 时，匿名 curl 无法下载。先通过 `gh auth login` 登录有仓库读取权限的身份，再获取脚本并执行：

```sh
gh api repos/ChengHongxu/owngate/contents/deploy/install.sh \
  --jq .content | base64 --decode > install.sh
bash install.sh --private
```

私有发布包通过 `gh` 下载，镜像仍由 Docker 拉取。启动前需要另行执行 `docker login ghcr.io`，使用具有镜像读取权限的身份；`gh auth login` 不会自动登录 Docker。也可先完成配置，登录后再手动启动。

脚本不安装 nginx 或证书。使用 HTTPS 地址时，按生成目录中的 `nginx.example.conf` 配好反向代理。镜像拉取或启动失败时，配置与密钥会保留；进入安装目录执行 `docker compose pull`、`docker compose up -d` 重试，使用 `docker compose logs` 查看错误。不要为重试删除密钥或数据卷。

## 手动安装

下载版本对应的部署压缩包与 `SHA256SUMS`，在同一目录运行 `sha256sum --ignore-missing -c SHA256SUMS`，确认部署包显示 `OK` 后解压。以下命令在解压后包含 `compose.yaml` 的目录执行。

### 配置与首次启动

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
