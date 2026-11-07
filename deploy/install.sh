#!/usr/bin/env bash
# Install a fresh OwnGate instance from a verified release bundle.
set -euo pipefail
umask 077

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：bash install.sh [选项]
  --version VERSION  指定版本（例如 0.1.4），默认最新正式 Release
  --dir PATH         安装目录，默认 ./owngate
  --origin URL       访问地址，默认 http://localhost:3000
  --port PORT        本机监听端口，默认 3000
  --start            安装后拉取镜像并启动
  --yes              使用参数和默认值，无交互
  --private          使用已认证的 gh 下载私有仓库 Release
  --repo OWNER/REPO  发布仓库，默认 ChengHongxu/owngate
  --help             显示帮助
仅支持首次安装、Linux amd64。不会覆盖已有目录内容、密钥或数据卷。
HELP
}
version='' install_dir='./owngate' origin='' port=3000 start=false interactive=true private=false
repo=ChengHongxu/owngate
while (($#)); do
  case "$1" in
    --version|--dir|--origin|--port|--repo)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail "$1 缺少参数"
      case "$1" in
        --version) version=${2#v};; --dir) install_dir=$2;; --origin) origin=$2;;
        --port) port=$2;; --repo) repo=$2;;
      esac
      shift 2;;
    --start) start=true; shift;; --yes) interactive=false; shift;;
    --private) private=true; shift;; --help) usage; exit 0;;
    *) fail "未知选项：$1";;
  esac
done
[[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$ ]] || fail '仓库名称无效'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail '当前发布仅支持 Linux amd64'
for tool in curl tar sha256sum openssl docker find mktemp awk cp chmod chown; do
  command -v "$tool" >/dev/null || fail "请先安装 $tool"
done
compose_version=$(docker compose version --short) || fail '需要 Docker Compose 2.24+'
compose_version=${compose_version#v}
[[ "$compose_version" =~ ^([0-9]+)\.([0-9]+) ]] || fail '无法识别 Compose 版本'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 24) )) || fail '需要 Docker Compose 2.24+'
docker info >/dev/null 2>&1 || fail '无法访问 Docker，请先启动 Docker 并配置当前用户的访问权限'
engine_version=$(docker version --format '{{.Server.Version}}')
[[ "$engine_version" =~ ^([0-9]+)\. ]] && (( BASH_REMATCH[1] >= 24 )) || fail '需要 Docker Engine 24+'
if $private; then
  command -v gh >/dev/null || fail '私有发布需要安装 gh 并执行 gh auth login'
fi
# Read prompts from the terminal, not stdin: stdin may contain this script (curl | bash).
prompt() {
  local answer
  printf '%s [%s]：' "$1" "$2" > /dev/tty
  IFS= read -r answer < /dev/tty || fail '终端输入中断'
  REPLY=${answer:-$2}
}
if $interactive; then
  ( : < /dev/tty ) 2>/dev/null || fail '没有交互终端；自动安装请加 --yes'
  prompt '安装目录' "$install_dir"; install_dir=$REPLY
  prompt '本机端口' "$port"; port=$REPLY
  prompt '访问地址（正式部署填写 HTTPS 地址）' "${origin:-http://localhost:$port}"; origin=$REPLY
fi
origin=${origin:-http://localhost:$port}
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || fail '端口必须为 1–65535'
port=$((10#$port))
# Accept only localhost HTTP or a DNS hostname with HTTPS. Never interpolate shell/env syntax.
if [[ "$origin" =~ ^http://localhost(:[0-9]{1,5})?$ ]]; then
  rp_id=localhost
elif [[ "$origin" =~ ^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?$ ]]; then
  rp_id=${BASH_REMATCH[1]}
  [[ "$rp_id" == *.* && ! "$rp_id" =~ ^[0-9.]+$ && "$rp_id" != *..* ]] || fail 'HTTPS 地址需要有效域名'
else
  fail '访问地址须为 http://localhost[:端口] 或 https://域名[:端口]，不含路径或尾斜线'
fi
[[ -n "$install_dir" && ! -L "$install_dir" ]] || fail '安装目录无效或为符号链接'
if [[ -e "$install_dir" ]]; then
  [[ -d "$install_dir" && -z $(find "$install_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail '安装目录非空；请按升级文档操作，不会覆盖现有实例'
fi
for volume in owngate_server-data owngate_browser-profiles; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    fail "发现已有数据卷 $volume；请按升级/恢复文档操作，不能为旧数据生成新密钥"
  fi
done
if [[ -z "$version" ]]; then
  if $private; then
    tag=$(gh api "repos/$repo/releases/latest" --jq .tag_name)
  else
    url=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 --output /dev/null --write-out '%{url_effective}' "https://github.com/$repo/releases/latest")
    tag=${url##*/}
  fi
  [[ "$tag" == v* ]] || fail '无法获取最新 Release；私有仓库请使用 --private'
  version=${tag#v}
fi
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] || fail '版本格式无效'
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
archive="owngate-deploy-$version.tar.gz"
printf '下载 OwnGate %s（%s）…\n' "$version" "$repo"
if $private; then
  gh release download "v$version" --repo "$repo" --dir "$temporary" --pattern "$archive" --pattern SHA256SUMS
else
  for asset in "$archive" SHA256SUMS; do
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 \
      "https://github.com/$repo/releases/download/v$version/$asset" -o "$temporary/$asset"
  done
fi
# Only verify the exact asset; never interpret arbitrary paths from a checksum file.
expected=$(awk -v name="$archive" '$2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {print $1}' "$temporary/SHA256SUMS")
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail '校验文件缺失或有重复条目'
printf '%s  %s\n' "$expected" "$archive" | (cd "$temporary" && sha256sum -c -) || fail '部署包校验失败'
# Extract only the four known regular files, never archive paths or symlinks.
mkdir "$temporary/bundle"
for file in compose.yaml .env.example nginx.example.conf README.md; do
  entry="owngate-deploy-$version/$file"
  listing=$(tar -tvzf "$temporary/$archive" -- "$entry")
  [[ "$listing" == -* && "$listing" != *$'\n'* ]] || fail "部署包条目不是唯一的普通文件：$file"
  tar -xOzf "$temporary/$archive" -- "$entry" > "$temporary/bundle/$file"
done
cat > "$temporary/bundle/.env" <<ENV
PORT=$port
BIND_HOST=127.0.0.1
OWNGATE_ORIGIN=$origin
OWNGATE_RP_ID=$rp_id
LOG_LEVEL=info
ENV
docker compose --project-directory "$temporary/bundle" -f "$temporary/bundle/compose.yaml" config --quiet
printf '\n版本：%s\n目录：%s\n访问地址：%s\n监听：127.0.0.1:%s\n' "$version" "$install_dir" "$origin" "$port"
if $interactive; then
  prompt '是否安装' 'y'; [[ "$REPLY" == y || "$REPLY" == Y ]] || { printf '已取消。\n'; exit 0; }
  if ! $start; then
    prompt '安装后是否拉取镜像并启动' 'y'; [[ "$REPLY" != y && "$REPLY" != Y ]] || start=true
  fi
fi
# A narrowly scoped privilege elevation is needed only for secret file ownership.
owner_command=(chown)
if (( EUID != 0 && EUID != 1000 )); then
  command -v sudo >/dev/null || fail '设置容器密钥属主需要 sudo（UID 1000）'
  printf '需要 sudo 将四个密钥文件的属主设为容器 UID 1000。\n'
  sudo -v
  owner_command=(sudo chown)
fi
mkdir "$temporary/bundle/secrets"
for name in master_key browser_rpc_secret egress_control_secret http_runtime_secret; do
  openssl rand -hex 32 > "$temporary/bundle/secrets/$name"
done
mkdir -p -- "$install_dir"
# Copy before chown: UID 1000 may differ from the installing user.
cp -R -- "$temporary/bundle/." "$install_dir/"
for name in master_key browser_rpc_secret egress_control_secret http_runtime_secret; do
  chmod 0600 -- "$install_dir/secrets/$name"
  "${owner_command[@]}" 1000:1000 -- "$install_dir/secrets/$name"
done
printf '\n配置和密钥已保存到 %s，请备份 secrets/，不要重新生成。\n' "$install_dir"
if $start; then
  (
    cd -- "$install_dir" &&
    docker compose pull &&
    docker compose up -d &&
    docker compose ps
  ) || fail "配置已保留；请进入 $install_dir 排查并重试 docker compose pull / up -d；私有镜像需先 docker login ghcr.io"
  printf '启动命令已完成。请检查 docker compose ps 和 /health，再打开 %s 创建管理员。\n' "$origin"
else
  printf '进入安装目录后执行 docker compose pull 和 docker compose up -d 启动。\n'
fi
if [[ "$origin" == https:* ]]; then
  printf '请按 nginx.example.conf 配置域名和 HTTPS 反向代理，后端保持仅绑定本机。\n'
fi
