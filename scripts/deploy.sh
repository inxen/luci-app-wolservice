#!/bin/sh
# luci-app-wolservice 直接部署脚本
#
# 把 LuCI 文件（可选 WOL 二进制）打包，经 SSH 传到路由器的 /tmp，
# 执行远程 install-on-router.sh。密码由 ssh 自己提示，本脚本不保存凭据。
#
# 示例：
#   sh scripts/deploy.sh --host root@192.168.1.1 --binary wol-linux-arm64 --start
#   sh scripts/deploy.sh --host root@192.168.1.1 --no-binary          # 只更新 LuCI 文件
#   sh scripts/deploy.sh --stage-only                              # 只生成 tar.gz 供检查/手工上传
#
# 可用环境变量：WOL_HOST / WOL_SSH_PORT / WOL_SSH_KEY / WOL_BINARY / WOL_SSH_OPTS

set -eu

HOST="${WOL_HOST:-}"
PORT="${WOL_SSH_PORT:-22}"
KEY="${WOL_SSH_KEY:-}"
BIN="${WOL_BINARY:-}"
START=0
STAGE_ONLY=0
NO_BINARY=0
TARBALL=""
SSH_OPTS="${WOL_SSH_OPTS:-}"

usage() {
	cat <<'EOF'
用法：sh scripts/deploy.sh --host root@<router> [选项]

  --host USER@HOST      SSH 目标（也可用 WOL_HOST）
  --port PORT           SSH 端口，默认 22
  --key FILE            SSH 私钥
  --binary FILE         WOL 二进制；默认找仓库根目录的 wol-linux-arm64
  --no-binary           不更新 /usr/bin/wol
  --start               安装后启用并启动服务（首次安装常用）
  --stage-only          只生成 tar.gz，不连接路由器
  --tar FILE            stage-only 输出路径，默认 ./dist/luci-app-wolservice-deploy.tar.gz
  -h, --help            显示帮助

说明：
  * 已存在的 /etc/config/wolservice 会保留；首次安装自动生成默认配置。
  * 远程安装脚本会先执行 ucode -c 语法检查，再重启 rpcd。
  * 更新二进制时先执行 -version 验证，失败不会替换现有文件。
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--host) HOST="$2"; shift 2 ;;
		--port) PORT="$2"; shift 2 ;;
		--key) KEY="$2"; shift 2 ;;
		--binary) BIN="$2"; shift 2 ;;
		--no-binary) BIN=""; NO_BINARY=1; shift ;;
		--start) START=1; shift ;;
		--stage-only) STAGE_ONLY=1; shift ;;
		--tar) TARBALL="$2"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
	esac
done

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ "$NO_BINARY" = "0" ] && [ -z "$BIN" ]; then
	if [ -f "$ROOT/wol-linux-arm64" ]; then
		BIN="$ROOT/wol-linux-arm64"
	elif [ -f "$ROOT/wol-linux-arm" ]; then
		BIN="$ROOT/wol-linux-arm"
	fi
fi

if [ "$NO_BINARY" = "0" ] && [ -z "$BIN" ]; then
	echo "WARN: 未找到默认 WOL 二进制，本次只更新 LuCI 文件；可用 --binary 指定。" >&2
fi

if [ -n "$BIN" ] && [ ! -f "$BIN" ]; then
	echo "找不到二进制：$BIN" >&2
	echo "请从 https://github.com/inxen/wolservice/releases 下载对应架构的 wol，或用 --binary 指定。" >&2
	exit 1
fi

if [ -z "$TARBALL" ]; then
	TARBALL="$ROOT/dist/luci-app-wolservice-deploy.tar.gz"
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM

cp -a "$ROOT/root/etc" "$STAGE/"
cp -a "$ROOT/root/usr" "$STAGE/"
mkdir -p "$STAGE/www/luci-static/resources/view/wolservice"
cp -f "$ROOT/htdocs/luci-static/resources/view/wolservice/overview.js" \
	"$STAGE/www/luci-static/resources/view/wolservice/overview.js"
cp -f "$ROOT/scripts/install-on-router.sh" "$STAGE/install.sh"

# UCI 默认配置作为 .default 安装，远程脚本只在目标不存在时使用，避免升级覆盖设置
mv -f "$STAGE/etc/config/wolservice" "$STAGE/etc/config/wolservice.default"

if [ -n "$BIN" ]; then
	mkdir -p "$STAGE/usr/bin"
	cp -f "$BIN" "$STAGE/usr/bin/wol"
fi

mkdir -p "$(dirname -- "$TARBALL")"
tar -czf "$TARBALL" -C "$STAGE" .
echo "staged: $TARBALL"

if [ "$STAGE_ONLY" = "1" ]; then
	exit 0
fi

if [ -z "$HOST" ]; then
	echo "缺少 --host（或用 WOL_HOST 指定 root@路由器地址）" >&2
	exit 1
fi

SSH_ARGS="-p $PORT"
if [ -n "$KEY" ]; then
	SSH_ARGS="$SSH_ARGS -i $KEY"
fi
if [ -n "$SSH_OPTS" ]; then
	SSH_ARGS="$SSH_ARGS $SSH_OPTS"
fi

REMOTE_START=""
if [ "$START" = "1" ]; then
	REMOTE_START="start"
fi

# shellcheck disable=SC2086
tar -czf - -C "$STAGE" . | ssh $SSH_ARGS "$HOST" \
	"rm -rf /tmp/wolservice-deploy && mkdir -p /tmp/wolservice-deploy && \
	 tar -xzf - -C /tmp/wolservice-deploy && \
	 sh /tmp/wolservice-deploy/install.sh $REMOTE_START && \
	 rm -rf /tmp/wolservice-deploy"

HOST_ONLY=${HOST#*@}
echo "done: http://$HOST_ONLY/cgi-bin/luci/admin/services/wolservice"
