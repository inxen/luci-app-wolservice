#!/bin/sh
# GitHub Release 更新任务（由 rpcd ucode 插件以 setsid 方式拉起）
# 参数：URL SHA256 SIZE VERSION ASSET
# 下载到 /tmp，校验大小与 SHA256 后原子替换 /usr/bin/wol。

URL="$1"
DIGEST="$2"
SIZE="$3"
VERSION="$4"
ASSET="$5"

S=/tmp/wolservice.install.status
T=""
NEW=/usr/bin/.wol.new
BIN=/usr/bin/wol
PREV=/usr/bin/wol.prev
umask 077

st() {
	if [ -n "$T" ]; then
		printf '{"phase":"%s","message":"%s","total":%s,"file":"%s"}\n' "$1" "$2" "$SIZE" "$T" > "$S"
	else
		printf '{"phase":"%s","message":"%s","total":%s}\n' "$1" "$2" "$SIZE" > "$S"
	fi
}

T=$(mktemp /tmp/wolservice.download.XXXXXX 2>/dev/null) || T="/tmp/wolservice.download.$$"
st downloading "正在下载"

if command -v curl >/dev/null 2>&1; then
	curl -fL --max-time 300 -o "$T" "$URL" >/dev/null 2>&1 || {
		st error "下载失败（网络不可达或 GitHub 拒绝连接）"
		rm -f "$T"
		exit 1
	}
elif command -v uclient-fetch >/dev/null 2>&1; then
	uclient-fetch -q -O "$T" --timeout=30 "$URL" >/dev/null 2>&1 || {
		st error "下载失败（网络不可达或 GitHub 拒绝连接）"
		rm -f "$T"
		exit 1
	}
elif command -v wget >/dev/null 2>&1; then
	wget -q -O "$T" "$URL" >/dev/null 2>&1 || {
		st error "下载失败（网络不可达或 GitHub 拒绝连接）"
		rm -f "$T"
		exit 1
	}
else
	st error "缺少下载工具（curl / uclient-fetch / wget）"
	exit 1
fi

GOT=$(wc -c < "$T" 2>/dev/null | tr -d ' ')
if [ "$GOT" != "$SIZE" ]; then
	st error "大小校验失败：收到 $GOT 字节，期望 $SIZE"
	rm -f "$T"
	exit 1
fi

st verifying "正在校验 SHA256"
ACT=$(sha256sum "$T" 2>/dev/null | cut -d' ' -f1)
if [ "$ACT" != "$DIGEST" ]; then
	st error "SHA256 校验失败（文件可能被篡改或下载损坏）"
	rm -f "$T"
	exit 1
fi

st installing "正在安装"
if ! cp -f "$T" "$NEW" || ! chmod 755 "$NEW"; then
	st error "写入临时二进制失败"
	rm -f "$T" "$NEW"
	exit 1
fi

if ! "$NEW" -version >/dev/null 2>&1; then
	st error "二进制无法在当前系统运行（架构不匹配或文件损坏）"
	rm -f "$T" "$NEW"
	exit 1
fi

if [ -f "$BIN" ]; then
	cp -f "$BIN" "$PREV" 2>/dev/null || true
	chmod 755 "$PREV" 2>/dev/null || true
fi

if ! mv -f "$NEW" "$BIN" || ! chmod 755 "$BIN"; then
	st error "替换 $BIN 失败"
	rm -f "$T" "$NEW"
	exit 1
fi
rm -f "$T"

if [ "$(uci -q get wolservice.main.enabled)" = "1" ]; then
	/etc/init.d/wolservice restart >/dev/null 2>&1 || true
	sleep 2
	if command -v jsonfilter >/dev/null 2>&1; then
		RUNNING=$(ubus call service list '{"name":"wolservice"}' 2>/dev/null | jsonfilter -e '@["wolservice"].instances.main.running' 2>/dev/null)
		if [ "$RUNNING" != "true" ]; then
			if [ -f "$PREV" ]; then
				cp -f "$PREV" "$BIN" 2>/dev/null && chmod 755 "$BIN" 2>/dev/null
				/etc/init.d/wolservice restart >/dev/null 2>&1 || true
			fi
			st error "新二进制启动失败，已回滚"
			exit 1
		fi
	fi
fi

st done "安装完成"
exit 0
