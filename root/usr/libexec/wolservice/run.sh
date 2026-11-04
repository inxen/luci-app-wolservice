#!/bin/sh
# WOL 服务启动包装：stdout/stderr 写入 tmpfs，不进 syslog。
# 由 /etc/init.d/wolservice 作为 procd 主实例调用。

CONF="${WOL_CONFIG:-/etc/wol/wol.yaml}"
MAX_KB="${WOL_LOG_MAX_KB:-256}"
LOG_DIR=/tmp/log
LOG=$LOG_DIR/wolservice.log

case "$MAX_KB" in
	''|*[!0-9]*) MAX_KB=256 ;;
esac
[ "$MAX_KB" -lt 32 ] && MAX_KB=32
[ "$MAX_KB" -gt 8192 ] && MAX_KB=8192
LIMIT=$((MAX_KB * 1024))

mkdir -p "$LOG_DIR"
[ -f "$LOG" ] || : > "$LOG"
chmod 644 "$LOG" 2>/dev/null

if [ -f "$LOG" ]; then
	SZ=$(wc -c < "$LOG" 2>/dev/null)
	if [ -n "$SZ" ] && [ "$SZ" -gt "$LIMIT" ]; then
		tail -c $((LIMIT / 2)) "$LOG" > "$LOG.tmp" 2>/dev/null &&
			cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
	fi
fi

echo "$(date '+%Y/%m/%d %H:%M:%S') --- wolservice starting (config: $CONF) ---" >> "$LOG"

exec /usr/bin/wol -config "$CONF" >> "$LOG" 2>&1
