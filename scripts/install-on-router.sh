#!/bin/sh
# 在路由器上安装/更新 luci-app-wolservice。
# 由 deploy.sh 解压到 /tmp/wolservice-deploy 后执行；也可手工运行。
# 用法：sh install.sh [start]
#   start：首次安装后启用并启动服务；否则保持现有启用状态。

set -e

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
START="${1:-}"
CONF=/etc/config/wolservice
BIN=/usr/bin/wol
PREV=/usr/bin/wol.prev
NEW=/usr/bin/.wol.new

if [ ! -f "$SRC/etc/config/wolservice.default" ]; then
	echo "安装包不完整：缺少 etc/config/wolservice.default" >&2
	exit 1
fi

# 先做语法检查，避免复制坏插件后 rpcd 加载失败
if command -v ucode >/dev/null 2>&1; then
	ucode -c "$SRC/usr/share/rpcd/ucode/wolservice"
fi

mkdir -p /etc/wol
chmod 700 /etc/wol 2>/dev/null

if [ ! -f "$CONF" ]; then
	cp -f "$SRC/etc/config/wolservice.default" "$CONF"
fi

warn=0
for f in \
	etc/init.d/wolservice \
	etc/uci-defaults/60_luci-wolservice \
	usr/libexec/wolservice/run.sh \
	usr/libexec/wolservice/logd.sh \
	usr/libexec/wolservice/install-job.sh \
	usr/share/rpcd/ucode/wolservice \
	usr/share/rpcd/acl.d/luci-app-wolservice.json \
	usr/share/luci/menu.d/luci-app-wolservice.json
do
	if [ ! -f "$SRC/$f" ]; then
		echo "WARN: 缺少 $f" >&2
		warn=1
		continue
	fi
	mkdir -p "$(dirname "/$f")"
	cp -f "$SRC/$f" "/$f"
done

mkdir -p /www/luci-static/resources/view/wolservice
cp -f "$SRC/www/luci-static/resources/view/wolservice/overview.js" \
	/www/luci-static/resources/view/wolservice/overview.js

chmod 600 "$CONF"
chmod 755 /etc/init.d/wolservice /etc/uci-defaults/60_luci-wolservice \
	/usr/libexec/wolservice/run.sh /usr/libexec/wolservice/logd.sh \
	/usr/libexec/wolservice/install-job.sh
chmod 644 /usr/share/rpcd/ucode/wolservice \
	/usr/share/rpcd/acl.d/luci-app-wolservice.json \
	/usr/share/luci/menu.d/luci-app-wolservice.json \
	/www/luci-static/resources/view/wolservice/overview.js

if [ -f "$SRC/usr/bin/wol" ]; then
	if [ -f "$BIN" ]; then
		cp -f "$BIN" "$PREV" 2>/dev/null || true
		chmod 755 "$PREV" 2>/dev/null || true
	fi
	cp -f "$SRC/usr/bin/wol" "$NEW"
	chmod 755 "$NEW"
	if "$NEW" -version >/dev/null 2>&1; then
		mv -f "$NEW" "$BIN"
		chmod 755 "$BIN"
	else
		rm -f "$NEW"
		echo "WARN: 新二进制无法在当前系统运行（架构不匹配或文件损坏），保留现有 $BIN" >&2
		warn=1
	fi
fi

# 让 LuCI 重建菜单/模块索引
rm -f /tmp/luci-indexcache*.json 2>/dev/null || true
/etc/init.d/rpcd restart 2>/dev/null || true

if [ "$START" = "start" ]; then
	uci set wolservice.main.enabled='1'
	uci commit wolservice
	/etc/init.d/wolservice enable 2>/dev/null || true
	/etc/init.d/wolservice restart
else
	if [ "$(uci -q get wolservice.main.enabled)" = "1" ]; then
		/etc/init.d/wolservice restart
	fi
fi

if [ "$warn" = "1" ]; then
	echo "installed with warnings"
else
	echo "installed"
fi
