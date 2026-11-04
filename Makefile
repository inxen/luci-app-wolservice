# SPDX-License-Identifier: MIT
#
# luci-app-wolservice —— WOL 网络唤醒服务的 LuCI 控制器
# 二进制不随本包分发：在页面内上传，或随固件/单独包安装到 /usr/bin/wol。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wolservice
PKG_VERSION:=0.6.6
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=cinho

include $(INCLUDE_DIR)/package.mk

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-wolservice
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=WOL service controller
  DEPENDS:=+luci-base +ca-bundle
  PKGARCH:=all
  URL:=https://github.com/inxen/luci-app-wolservice
endef

define Package/luci-app-wolservice/description
 WOL 网络唤醒服务的 LuCI 控制器：服务启停、二进制上传与回滚、
 YAML 配置校验/保存、运行日志，以及跳转服务自带控制面板。
 服务二进制不随本包分发。
endef

define Package/luci-app-wolservice/conffiles
/etc/config/wolservice
endef

define Package/luci-app-wolservice/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	chmod 600 /etc/config/wolservice 2>/dev/null
	mkdir -p /etc/wol 2>/dev/null
	chmod 700 /etc/wol 2>/dev/null
	rm -f /tmp/luci-indexcache*.json 2>/dev/null
	/etc/init.d/rpcd restart 2>/dev/null
}
exit 0
endef

define Package/luci-app-wolservice/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/wolservice stop 2>/dev/null
	/etc/init.d/wolservice disable 2>/dev/null
}
exit 0
endef

define Package/luci-app-wolservice/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_DIR) $(1)/usr/libexec/wolservice
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/wolservice

	$(INSTALL_CONF) ./root/etc/config/wolservice $(1)/etc/config/wolservice
	$(INSTALL_BIN) ./root/etc/init.d/wolservice $(1)/etc/init.d/wolservice
	$(INSTALL_BIN) ./root/etc/uci-defaults/60_luci-wolservice $(1)/etc/uci-defaults/60_luci-wolservice
	$(INSTALL_BIN) ./root/usr/libexec/wolservice/run.sh $(1)/usr/libexec/wolservice/run.sh
	$(INSTALL_BIN) ./root/usr/libexec/wolservice/logd.sh $(1)/usr/libexec/wolservice/logd.sh
	$(INSTALL_BIN) ./root/usr/libexec/wolservice/install-job.sh $(1)/usr/libexec/wolservice/install-job.sh

	$(INSTALL_DATA) ./root/usr/share/rpcd/ucode/wolservice $(1)/usr/share/rpcd/ucode/wolservice
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-wolservice.json $(1)/usr/share/rpcd/acl.d/luci-app-wolservice.json
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-wolservice.json $(1)/usr/share/luci/menu.d/luci-app-wolservice.json
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/wolservice/overview.js $(1)/www/luci-static/resources/view/wolservice/overview.js
endef

$(eval $(call BuildPackage,luci-app-wolservice))
