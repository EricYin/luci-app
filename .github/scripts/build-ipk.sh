#!/usr/bin/env bash
#
# 无 SDK / 无 docker 打包 ipk —— 给 OpenWrt 24.10 及更早分支（opkg）的设备用。
#
# 为什么不走官方 SDK 容器（openwrt/gh-action-sdk）：
#   * 它要从 ghcr 拉 SDK 镜像跑 docker，冷启动数分钟，还得赌对应 tag 没 404；
#   * 本仓库的包是纯数据包（js/shell/json，无 C 代码），不需要交叉编译器；
#   * 依赖（firewall4 / kmod-nft-fullcone 等）只是写进元数据，不需要真编。
#
# ipk 格式（opkg）：一个 gzip tar，按顺序放三个成员
#   ./debian-binary    内容固定 "2.0\n"
#   ./control.tar.gz   ./control（外加 ./conffiles、./postinst）
#   ./data.tar.gz      包内文件，路径带 ./ 前缀
# 与 buildroot 的 scripts/ipkg-build 产出一致，opkg 可直接识别。
#
# 用法（在仓库根目录执行）：
#   bash .github/scripts/build-ipk.sh [输出目录，默认 dist]
#
# 环境变量：
#   IPK_ARCH       control 里的 Architecture 字段，默认 all
#                  （纯数据包本来就是 noarch；arm64 / x86 设备都能装。
#                   只有当你想让包名打上 aarch64_cortex-a53 之类的标签时才改，
#                   前提是设备 /etc/opkg.conf 里列了该 arch 条目）
#   IPK_MAINTAINER control 里的 Maintainer 字段，默认 qwe-qaq
set -euo pipefail

OUT_DIR="${1:-dist}"
ARCH="${IPK_ARCH:-all}"
MAINTAINER="${IPK_MAINTAINER:-qwe-qaq}"

OUT="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
# 临时目录放仓库内而不用 mktemp：某些环境（Windows 的 mktemp）会返回
# `C:\...` 这种带冒号的路径，tar 会把它当成远程主机地址直接报错。
TMP="$PWD/.ipk-build"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# 取 Makefile 中 KEY:=value 的 value（保留右侧原样）
field() {
	local mk="$1" key="$2"
	sed -n "s/^${key}:=//p" "$mk" | tail -1
}

# LUCI_DEPENDS 是 ipk 记法 "+luci-base +firewall4"；
# control 的 Depends 用逗号分隔，去掉 '+' 前缀。
normalize_depends() {
	local deps="$1" out="" dep
	read -r -a words <<<"$deps" || true
	for dep in "${words[@]}"; do
		dep="${dep#+}"
		[ -n "$dep" ] || continue
		out+="${out:+", "}${dep}"
	done
	printf '%s' "$out"
}

# 统一的 tar 选项：文件一律记成 root:root，固定 mtime 让产物可复现
TAR_OPTS=(--owner=0 --group=0 --numeric-owner --mtime=@0)

pkg_count=0
for mk in luci-app-*/Makefile; do
	[ -f "$mk" ] || continue
	pkg_dir="${mk%Makefile}"
	name="$(basename "$pkg_dir")"
	version="$(field "$mk" PKG_VERSION)"
	release="$(field "$mk" PKG_RELEASE)"
	title="$(field "$mk" LUCI_TITLE)"
	url="$(field "$mk" LUCI_URL)"
	license="$(field "$mk" PKG_LICENSE)"
	depends="$(normalize_depends "$(field "$mk" LUCI_DEPENDS)")"

	if [ -z "$version" ] || [ -z "$release" ]; then
		echo "$mk: missing PKG_VERSION / PKG_RELEASE" >&2
		exit 1
	fi
	if [ -z "$title" ]; then
		echo "$mk: missing LUCI_TITLE" >&2
		exit 1
	fi

	work="$TMP/$name"
	rm -rf "$work"
	mkdir -p "$work/data" "$work/control"
	idir="$work/data"   # 包内文件（对应设备上的 /）
	cdir="$work/control" # control.tar.gz 内容

	# root/ 覆盖到 /，htdocs/ 覆盖到 /www（与 luci.mk 一致）
	if [ -d "$pkg_dir/root" ]; then
		cp -a "$pkg_dir/root/." "$idir/"
	fi
	if [ -d "$pkg_dir/htdocs" ]; then
		mkdir -p "$idir/www"
		cp -a "$pkg_dir/htdocs/." "$idir/www/"
	fi

	# ── 可执行位保险 ──────────────────────────────────────────────────
	# Windows 工作区 / GitHub API 上传都会丢执行位，而 ipk 里的 postinst
	# 只在真正装到设备上时才跑，装之前脚本没 x 位就是 127。这里在打包前
	# 按 Linux 约定补一次，比 luci.mk 的 Build/Prepare 钩子更靠得住。
	while IFS= read -r f; do
		chmod 0755 "$f"
	done < <(find "$idir" -type f \
		\( -path '*/usr/sbin/*' -o -path '*/usr/bin/*' \
		-o -path '*/etc/init.d/*' -o -path '*/etc/uci-defaults/*' \) 2>/dev/null || true)

	# ── conffiles：/etc 下的文件都是配置文件，升级时不能被覆盖 ──────
	# （buildroot 的 ipkg-build 也是这么生成的）
	conffiles="$cdir/conffiles"
	# 注意：find 的 -printf '%P' 是「去掉起始点前缀」的相对路径，
	# 从 $idir/etc 起算会把 /etc 也吃掉（写成 /config/natmode），
	# 所以这里把 etc 前缀显式写回去。
	if [ -d "$idir/etc" ]; then
		find "$idir/etc" -type f -printf '/etc/%P\n' | sort >"$conffiles"
	else
		: >"$conffiles"
	fi

	# ── control ──────────────────────────────────────────────────────
	size="$(du -sk "$idir" | cut -f1)"
	{
		printf 'Package: %s\n' "$name"
		printf 'Version: %s-r%s\n' "$version" "$release"
		printf 'Depends: %s\n' "$depends"
		printf 'Section: luci\n'
		printf 'Architecture: %s\n' "$ARCH"
		printf 'Maintainer: %s\n' "$MAINTAINER"
		[ -n "$license" ] && printf 'License: %s\n' "$license"
		[ -n "$url" ] && printf 'URL: %s\n' "$url"
		printf 'Installed-Size: %s\n' "$size"
		printf 'Description: %s\n' "$title"
	} >"$cdir/control"

	# ── postinst：清 LuCI 缓存 + reload rpcd（新装的 ACL 要 reload 才读得到）
	cat >"$cdir/postinst" <<'EOS'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
	exit 0
}
exit 0
EOS
	chmod 0755 "$cdir/postinst"

	tar -czf "$work/control.tar.gz" "${TAR_OPTS[@]}" --sort=name \
		-C "$cdir" ./control ./conffiles ./postinst
	tar -czf "$work/data.tar.gz" "${TAR_OPTS[@]}" --sort=name \
		-C "$idir" .
	printf '2.0\n' >"$work/debian-binary"

	# 外层：三个成员的顺序不能变（debian-binary 必须在最前），所以这里
	# 不能用 --sort=name，按给定顺序写。
	ipk="$OUT/${name}_${version}-r${release}_${ARCH}.ipk"
	tar -czf "$ipk" "${TAR_OPTS[@]}" \
		-C "$work" ./debian-binary ./control.tar.gz ./data.tar.gz

	pkg_count=$((pkg_count + 1))
	echo "built $ipk"
done

if [ "$pkg_count" -eq 0 ]; then
	echo 'no luci-app-* package found' >&2
	exit 1
fi
echo "done: $pkg_count package(s)"
