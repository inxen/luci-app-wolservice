#!/bin/sh
# 日志大小守护：/tmp 是 tmpfs，超过上限就裁掉前半部分。
# 用 cat tmp > log 保持 inode 不变，避免服务继续写入已删除的文件。

LOG=/tmp/log/wolservice.log

while :; do
	MAX_KB=$(uci -q get wolservice.main.log_max_size)
	case "$MAX_KB" in
		''|*[!0-9]*) MAX_KB=256 ;;
	esac
	[ "$MAX_KB" -lt 32 ] && MAX_KB=32
	[ "$MAX_KB" -gt 8192 ] && MAX_KB=8192
	LIMIT=$((MAX_KB * 1024))

	if [ -f "$LOG" ]; then
		SZ=$(wc -c < "$LOG" 2>/dev/null)
		if [ -n "$SZ" ] && [ "$SZ" -gt "$LIMIT" ]; then
			tail -c $((LIMIT / 2)) "$LOG" > "$LOG.tmp" 2>/dev/null &&
				cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
		fi
	fi

	sleep 20
done
