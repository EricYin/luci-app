# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI NAT mode selector (Full Cone / Restricted / Symmetric)
LUCI_URL:=https://github.com/pbs05/ponwrt
LUCI_DEPENDS:=+luci-base +firewall4 +kmod-nft-fullcone
PKG_VERSION:=0.1.6
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0

# 把包名钉死，保证下面的 Build/Prepare 钩子名字不随目录名变化。
LUCI_NAME:=luci-app-natmode

# ── 可执行位保险 ────────────────────────────────────────────────────
# luci.mk 打包 root/ 用的是 cp -pR，源文件的权限会被原样带进固件；而
# luci.mk 的 postinst 在 IPKG_INSTROOT 非空时（也就是「编译固件时预装」
# 的场景）整段被跳过，里面的 chmod 根本不会执行。
# 结果：只要仓库里 natmode-apply 是 0644（例如经网页 / GitHub API 上传
# 丢失了可执行位），固件里的脚本就没有 x 位 —— 内核 exec 和 rpcd 的
# file.exec 都会拒绝，页面上表现为「应用失败：natmode-apply 退出码 127」。
# 这里在 Build/Prepare 里补权限，发生在 cp -pR 之后、打包之前，
# 编译期生效，不依赖 postinst。
define Build/Prepare/luci-app-natmode
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/sbin/natmode-apply 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/natmode 2>/dev/null || true
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage: feed scanner marker; luci.mk generates the package rules.
