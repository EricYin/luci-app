#!/usr/bin/env bash
#
# LuCI 包结构校验
#
# 下面这些问题都不会导致编译失败，但装到路由器上会表现为
# 「菜单不出现 / 点进去空白页 / fs.exec 被 rpcd 拒绝」，排查成本很高，
# 所以放在 CI 里当门禁。
#
#   1. Makefile 没 include $(TOPDIR)/feeds/luci/luci.mk  -> feed 扫描器不认这个包
#   2. menu.d 的 action.path 指向的 view .js 文件不存在    -> 点了空白页
#   3. 缺 rpcd/acl.d/<包名>.json                          -> fs.exec / uci 被拒绝
#   4. depends.acl 里的名字和包名对不上                    -> 菜单被隐藏
#   5. /usr/sbin、/etc/init.d 下的脚本没有执行位              -> 装上去跑不了
#
# 用法：bash .github/scripts/check-luci-structure.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

fail=0
warn=0
ok()   { printf '[ ok ] %s\n' "$*"; }
bad()  { printf '[FAIL] %s\n' "$*"; fail=$((fail + 1)); }
wrn()  { printf '[warn] %s\n' "$*"; warn=$((warn + 1)); }
info() { printf '       %s\n' "$*"; }

# 取文件在 git 索引里记录的模式。之所以不用 [ -x ]：
# Windows 工作区不保存执行位，Git for Windows 会把所有文件都当成可执行，
# 本地测出来全是「有执行位」，问题要到 CI/路由器上才暴露。
# 索引里的模式才是最终打进 ipk 的那个。
mode_of() {
	local m
	m="$(git ls-files -s -- "$1" 2>/dev/null | awk 'NR==1{print $1}')"
	if [ -n "$m" ]; then
		printf '%s' "$m"
	elif [ -x "$1" ]; then
		printf '100755'
	else
		printf '100644'
	fi
}

if ! command -v jq >/dev/null 2>&1; then
	echo "jq is required" >&2
	exit 2
fi

shopt -s nullglob
pkgs=(luci-app-*/)
shopt -u nullglob

if [ "${#pkgs[@]}" -eq 0 ]; then
	bad "仓库根目录下没有 luci-app-* 包目录"
	exit 1
fi

for d in "${pkgs[@]}"; do
	p="${d%/}"
	echo
	echo "==== $p"

	# ---------- Makefile ----------
	mf="$p/Makefile"
	if [ ! -f "$mf" ]; then
		bad "$p: 缺少 Makefile"
		continue
	fi
	grep -q 'feeds/luci/luci.mk' "$mf" \
		|| bad "$mf: 未 include \$(TOPDIR)/feeds/luci/luci.mk，feed 扫描器不会识别该包"
	grep -qE '^LUCI_TITLE:='   "$mf" || bad "$mf: 缺少 LUCI_TITLE"
	grep -qE '^LUCI_DEPENDS:=' "$mf" || wrn "$mf: 缺少 LUCI_DEPENDS"
	grep -qE '^PKG_VERSION:='  "$mf" || bad "$mf: 缺少 PKG_VERSION"
	grep -qE '^PKG_RELEASE:='  "$mf" || bad "$mf: 缺少 PKG_RELEASE"
	grep -qE '^PKG_LICENSE:='  "$mf" || wrn "$mf: 缺少 PKG_LICENSE"
	grep -q 'luci-base'        "$mf" || wrn "$mf: LUCI_DEPENDS 未包含 luci-base"

	# 依赖里出现非官方包名时提示一下（CI 里编不出来的依赖会被静默丢弃）
	deps="$(sed -n 's/^LUCI_DEPENDS:=//p' "$mf")"
	for dep in ${deps//+/ }; do
		case "$dep" in
			luci-*|kmod-*|jsonfilter|firewall4|nftables|ucode|rpcd|openssl|curl|uhttpd) ;;
			'') ;;
			*) wrn "$mf: 依赖 $dep 不是常见的官方包名，确认它有可用的 feed（否则打包时该依赖会被丢弃）" ;;
		esac
	done
	ok "$mf"

	# ---------- rpcd ACL ----------
	acl="$p/root/usr/share/rpcd/acl.d/$p.json"
	if [ -f "$acl" ]; then
		if jq empty "$acl" 2>/dev/null; then
			ok "$acl"
		else
			bad "$acl: JSON 语法错误"
		fi
		while IFS= read -r path; do
			[ -n "$path" ] || continue
			case "$path" in
				/usr/sbin/*|/usr/bin/*|/sbin/*|/bin/*|/etc/init.d/*)
					bin="${path%% *}"
					[ -e "$p/root$bin" ] \
						|| info "$acl: 授权了 $path，包内没有 root$bin（应由其他包提供，确认一下）"
					;;
			esac
		done < <(jq -r '[.. | objects | select(has("file")) | .file | keys[]] | unique[]' "$acl" 2>/dev/null | tr -d '\r' || true)
	else
		bad "$p: 缺少 $acl，页面里的 fs.exec / uci 调用会被 rpcd 拒绝"
	fi

	# ---------- LuCI 菜单 ----------
	menu="$p/root/usr/share/luci/menu.d/$p.json"
	views=()
	mapfile -t views < <(find "$p/htdocs/luci-static/resources/view" -type f -name '*.js' 2>/dev/null | sort)

	if [ -f "$menu" ]; then
		if jq empty "$menu" 2>/dev/null; then
			ok "$menu"
		else
			bad "$menu: JSON 语法错误"
		fi

		apaths=()
		mapfile -t apaths < <(jq -r '[.. | objects | select(.action?.path) | .action.path] | .[]' "$menu" 2>/dev/null | tr -d '\r' || true)
		if [ "${#apaths[@]}" -eq 0 ]; then
			wrn "$menu: 没有任何 action.path"
		fi
		for ap in "${apaths[@]}"; do
			f="$p/htdocs/luci-static/resources/view/$ap.js"
			if [ -f "$f" ]; then
				ok "action.path '$ap' -> $f"
			else
				bad "$menu: action.path '$ap' 指向的 $f 不存在，表现为菜单点进去是空白页"
			fi
		done

		while IFS= read -r dep; do
			[ -n "$dep" ] || continue
			[ "$dep" = "$p" ] || wrn "$menu: depends.acl 写的是 '$dep'，与包名 '$p' 不一致，菜单会被隐藏"
		done < <(jq -r '[.. | objects | select(.depends?.acl) | .depends.acl[]] | unique[]' "$menu" 2>/dev/null | tr -d '\r' || true)
	elif [ "${#views[@]}" -eq 0 ]; then
		bad "$p: 既没有 $menu，也没有 htdocs/luci-static/resources/view/ 下的任何 .js"
	else
		info "$p: 无独立菜单项（overview/status 型插件），view 文件：${views[*]}"
	fi

	# ---------- status 页 include 命名 ----------
	inc_dir="$p/htdocs/luci-static/resources/view/status/include"
	if [ -d "$inc_dir" ]; then
		while IFS= read -r f; do
			bn="$(basename "$f")"
			case "$bn" in
				[0-9][0-9]_*.js) ok "status include $bn" ;;
				*) wrn "$inc_dir/$bn: 建议命名为 NN_xxx.js，数字前缀决定它在概览页的排序位置" ;;
			esac
		done < <(find "$inc_dir" -type f -name '*.js' 2>/dev/null | sort)
	fi

	# ---------- 可执行位 ----------
	# /usr/sbin、/usr/bin 下的工具和 /etc/init.d、/etc/uci-defaults 下的脚本，
	# 在 ipk 里必须带执行位，否则装到路由器上执行时报 Permission denied。
	while IFS= read -r f; do
		case "$(basename "$f")" in
			*.sh|*.json|*.js|*.lua|*.uc|*.po|*.pot) continue ;;
		esac
		if [ "$(mode_of "$f")" = "100755" ]; then
			ok "可执行位 $f"
		else
			# 必须是 FAIL 而不是 warn：没有执行位时 rpcd 的 file.exec 会直接
			# 拒绝（页面报「退出码 127」），内核 exec 也拒绝（Permission
			# denied），功能是彻底坏的，不是「可能有问题」。
			# 另外 luci.mk 用 cp -pR 原样搬运权限，固件预装时 postinst 不执行，
			# 仓库里的 100644 会一路带进固件，没有任何补救机会。
			bad "$f: 缺少执行位（git 里应为 100755）。用"
			info "       git update-index --chmod=+x $f"
			info "       修正。装到路由器上会 Permission denied / rpcd 退出码 127"
		fi
	done < <(find "$p/root/usr/sbin" "$p/root/usr/bin" \
	              "$p/root/etc/init.d" "$p/root/etc/uci-defaults" \
	              -type f 2>/dev/null | sort)
done

echo
echo "==================== 结构校验结果 ===================="
echo "错误 $fail 个，警告 $warn 个"
if [ "$fail" -gt 0 ]; then
	echo "存在错误，校验不通过"
	exit 1
fi
if [ "$warn" -gt 0 ]; then
	echo "校验通过（有警告，见上）"
fi
