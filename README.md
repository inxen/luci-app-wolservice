# luci-app-wolservice

[WOL 网络唤醒服务](https://github.com/inxen/wolservice) 的 LuCI 控制页，用在 OpenWrt / ImmortalWrt 上。LuCI 只做控制器，WOL 二进制单独安装，页面负责进程、配置、更新和日志。

配置字段的含义以服务仓库的 [config.md](https://github.com/inxen/wolservice/blob/main/config.md) 为准，这里不重复。

## 页面

分两个 Tab：

- **服务状态与配置**：运行状态、版本、YAML 校验、设备数、`/api/info` 自检、凭据文件、最近告警；下面是配置参数和安全提示。
- **更新与其他设置**：手动上传、GitHub Release 更新、回滚、日志、服务开关和界面选项。

配置参数可以在「LuCI 表单」和「YAML 原文」之间切换。表单只管 `server`、`config_panel`、`auth`、`log`、`probe` 这些全局项，保存时 `devices` 原样保留；设备和 SSH/IoT 凭据还是在 WOL 自带的 `/config` 里改。

## 兼容性

在 ImmortalWrt 25.12.2 (aarch64) 上实际跑过，用 LuCI JS 视图，适用于 OpenWrt 24.10+ / ImmortalWrt 25.12+。包本身不带 WOL 二进制。

## 安装

### 直接部署

需要路由器能 SSH，本机有 `ssh`、`scp`、`tar`，以及一个和路由器架构匹配的二进制（从 [Releases](https://github.com/inxen/wolservice/releases) 下载 `wol-linux-arm64` 之类）。

```sh
sh scripts/deploy.sh --host root@<路由器IP> --binary /path/to/wol-linux-arm64 --start
```

脚本会把 LuCI 文件和二进制打包，传到 `/tmp/wolservice-deploy`，先 `ucode -c` 检查插件，再复制文件、收紧权限、清理 LuCI 菜单缓存并重启 rpcd。`--start` 会启用并启动服务，不加就保持原来的启用状态。

已有的 `/etc/config/wolservice` 不会被覆盖，SSH 密码由 `ssh` 自己提示。

```sh
# 只更新 LuCI 文件
sh scripts/deploy.sh --host root@<路由器IP> --no-binary

# 只打 tar.gz，不连路由器
sh scripts/deploy.sh --stage-only

# 指定端口或私钥
sh scripts/deploy.sh --host root@<路由器IP> --port 2222 --key ~/.ssh/id_ed25519
```

### SDK 构建 APK

```sh
cp -a luci-app-wolservice <sdk>/package/
cd <sdk>
make defconfig
make package/luci-app-wolservice/compile V=s
# ImmortalWrt 25.12: bin/packages/<arch>/base/luci-app-wolservice-*.apk
# OpenWrt 24.10:    bin/packages/<arch>/base/luci-app-wolservice-*.ipk
```

装完包之后还要放二进制：从 Release 下载对应架构的 `wol`，在面板里上传，或者手工放到 `/usr/bin/wol`。

## 首次使用

1. 打开 LuCI → 服务 → WOL 网络唤醒。
2. 没有二进制的话，先上传或部署一个。
3. 点「启动」。首次启动会在 `/etc/wol/wol.yaml` 生成默认配置，监听 `8090`。
4. 用「打开配置中心」进入 `/config`，添加设备、设置访问密码。
5. 改过监听地址、TLS、超时或日志级别，用「保存并重启」；其他字段大约 2 秒热重载。

## 凭据

- 主配置 `wol.yaml` 不含敏感值，访问密码、SSH 密码/私钥、IoT 密钥都在 `wol.secrets.yaml`，由 WOL 服务加密保存。
- 推荐用内嵌了主密钥的二进制：Release 产物都是这样，页面会显示「主密钥：内嵌（二进制）」。自己构建时让 `build.sh` 读到 `.wol-embedded-key` 或 `WOL_EMBEDDED_KEY` 即可。
- 旧部署的磁盘 key 文件会在首次启动时用于解密，然后改用内嵌密钥重新加密，文件改名为 `wol.secrets.key.legacy`，确认不回滚后可以删。
- LuCI 不读取、不回显加密凭据。设备凭据在 `/config` 里填；输入框留空表示保持原值。

## 更新

- **手动上传**：分块上传，先查 ELF，再在路由器上执行 `-version`，通过后原子替换当前二进制。启动失败会自动回滚到 `/usr/bin/wol.prev`。
- **GitHub 更新**：从 `inxen/wolservice` 的 Latest Release 按架构选资产（`aarch64` → `wol-linux-arm64`，`armv7/armv6` → `wol-linux-arm`，`x86_64` → `wol-linux-amd64`，`mipsle` → `wol-linux-mipsle`），校验大小和 SHA256 后后台安装。Release 里没有 digest 时不能自动安装，只能手动上传。

官方 Release 共用一把内嵌主密钥，升级不会出现 secrets 解不开的问题；代价是这把密钥能从公开二进制里提取出来，加密只防配置文件外流。

## 安全

- ACL 只给 `luci-app-wolservice`，默认只有 root 能进。
- UCI 配置 0600，`/etc/wol` 0700，secrets 由服务以 0600 创建。
- 这个页面和 WOL 面板都不要直接挂到公网，远程用 VPN 或内网穿透。
- WOL 自带的配置面板默认开启且没有密码。装好后第一件事是去 `/config` 设访问密码，按需开启快速面板/API 和配置面板，必要时再开可信网段。
- 页面能读主配置、能往路由器写文件，只给可信管理员用。

## 目录

```
Makefile                              OpenWrt 包定义（PKGARCH:=all）
root/etc/config/wolservice            UCI 默认配置（conffile, 0600）
root/etc/init.d/wolservice            procd 服务
root/etc/uci-defaults/60_luci-wolservice
root/usr/libexec/wolservice/run.sh    日志重定向 + exec
root/usr/libexec/wolservice/logd.sh   日志裁剪
root/usr/libexec/wolservice/install-job.sh  Release 下载/校验/安装
root/usr/share/rpcd/ucode/wolservice  状态、配置、上传、安装、服务动作
root/usr/share/rpcd/acl.d/            访问控制
root/usr/share/luci/menu.d/           菜单
htdocs/luci-static/resources/view/wolservice/overview.js
scripts/deploy.sh                     SSH 直接部署
scripts/install-on-router.sh          远程安装脚本
```

## 卸载

```sh
/etc/init.d/wolservice stop
/etc/init.d/wolservice disable
rm -f /etc/init.d/wolservice /etc/uci-defaults/60_luci-wolservice \
  /usr/libexec/wolservice/run.sh /usr/libexec/wolservice/logd.sh \
  /usr/libexec/wolservice/install-job.sh \
  /usr/share/rpcd/ucode/wolservice \
  /usr/share/rpcd/acl.d/luci-app-wolservice.json \
  /usr/share/luci/menu.d/luci-app-wolservice.json \
  /www/luci-static/resources/view/wolservice/overview.js
rm -f /tmp/luci-indexcache*.json
/etc/init.d/rpcd restart
```

配置文件、`/etc/wol`、`/usr/bin/wol` 和 `wol.prev` 按需保留。APK/IPK 安装的包用 `apk del luci-app-wolservice` 或 `opkg remove luci-app-wolservice`。

## 已知限制

- GitHub 检查和下载要求路由器能访问 `api.github.com` 和 `github.com`。
- 直接部署不登记包管理器数据库；需要统一管理就用 SDK 构建。
- 表单保存会重写全局配置段，段内注释会丢；`devices` 段保留。
- 日志在 tmpfs，重启清空。
- YAML/表单切换和安全提示隐藏只记在浏览器 localStorage。

## License

MIT。结构参考 [luci-app-komariagent](https://github.com/inxen/luci-app-komariagent)（MIT）。
