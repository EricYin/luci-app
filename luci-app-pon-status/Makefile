# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI PON optics, port rate and connection counters (overview card)
LUCI_URL:=https://github.com/pbs05/openwrt-pon-userspace
LUCI_DEPENDS:=+luci-base +luci-mod-status +airoha-ponctl +jsonfilter +rpcd-mod-file
PKG_VERSION:=0.4.6
PKG_RELEASE:=4

PKG_LICENSE:=Apache-2.0

define Build/Prepare/luci-app-pon-status
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/sbin/ponstat-conn
endef

define Package/luci-app-pon-status/postinst
[ -n "$${IPKG_INSTROOT}" ] || { \
	chmod 0755 /usr/sbin/ponstat-conn 2>/dev/null; \
	[ -x /usr/share/luci-app-pon-status/attach-card ] && /usr/share/luci-app-pon-status/attach-card attach; \
	rm -f /tmp/luci-indexcache.*; \
	rm -rf /tmp/luci-modulecache/; \
	/etc/init.d/rpcd reload 2>/dev/null; \
	exit 0; \
}
endef

define Package/luci-app-pon-status/prerm
[ -n "$${IPKG_INSTROOT}" ] || { \
	[ -x /usr/share/luci-app-pon-status/attach-card ] && /usr/share/luci-app-pon-status/attach-card detach; \
	rm -f /tmp/luci-indexcache.*; \
	rm -rf /tmp/luci-modulecache/; \
	exit 0; \
}
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage: feed scanner marker; luci.mk generates the package rules.
