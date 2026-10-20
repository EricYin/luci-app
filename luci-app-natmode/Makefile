# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI NAT mode selector (Full Cone / Restricted / Symmetric)
LUCI_URL:=https://github.com/pbs05/ponwrt
LUCI_DEPENDS:=+luci-base +firewall4 +kmod-nft-fullcone
PKG_VERSION:=0.1.6
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0

LUCI_NAME:=luci-app-natmode

define Build/Prepare/luci-app-natmode
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/sbin/natmode-apply 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/natmode 2>/dev/null || true
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage: feed scanner marker; luci.mk generates the package rules.
