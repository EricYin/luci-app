# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI PON optics, port rate and connection counters (overview card)
LUCI_URL:=https://github.com/pbs05/openwrt-pon-userspace
LUCI_DEPENDS:=+luci-base +luci-mod-status +airoha-ponctl +jsonfilter +rpcd-mod-file
PKG_VERSION:=0.4.1
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0

#
# 下面两个 define 必须出现在 include luci.mk **之前**：luci.mk 末尾才
# $(eval $(call BuildPackage,...))，而且它自己的 postinst 是
# `ifndef Package/$(PKG_NAME)/postinst` 包着的 —— 先定义就生效，放到
# include 之后再定义就来不及了。PKG_NAME 由 luci.mk 从目录名推出，
# 所以这里只能写死包名。
#

# rpcd 的 file.exec 拒绝执行没有可执行位的文件。luci.mk 装 root/ 用的是
# `cp -pR`（照搬源码树的权限），0755 很容易在「zip 打进打出 / 走一趟
# Windows」时丢掉 —— 结果就是脚本装上了却 Permission denied，页面上只剩
# 「连接数不可用」。所以在这里把即将被打进包的副本改成 0755，不再赌源码
# 树的权限位。
define Build/Prepare/luci-app-pon-status
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/sbin/ponstat-conn
endef

# 装完再 chmod 一次兜底，同时保留 luci.mk 默认 postinst 做的两件事：清
# LuCI 缓存、reload rpcd（新装的 ACL 要 reload 才读得到）。
define Package/luci-app-pon-status/postinst
[ -n "$${IPKG_INSTROOT}" ] || { \
	chmod 0755 /usr/sbin/ponstat-conn 2>/dev/null; \
	rm -f /tmp/luci-indexcache.*; \
	rm -rf /tmp/luci-modulecache/; \
	/etc/init.d/rpcd reload 2>/dev/null; \
	exit 0; \
}
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage: feed scanner marker; luci.mk generates the package rules.
