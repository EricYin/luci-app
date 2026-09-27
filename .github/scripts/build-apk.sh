#!/usr/bin/env bash
#
# 无 SDK 打包：把仓库根目录下的纯 LuCI 应用直接组装成 OpenWrt 25.12 的 apk。
#
# 为什么不用官方 SDK 容器（gh-action-sdk）：
#   * SDK 每次 job 都要拉镜像 + 初始化 feeds，固定开销数分钟；
#   * 本仓库的包是纯数据包（js/shell/json，无 C 代码），不需要交叉编译器；
#   * 依赖（firewall4 / kmod-nft-fullcone 等）只写进包元数据，不需要真的构建。
#
# 为什么打 apk 而不是 ipk：
#   * OpenWrt 25.12 起包管理器从 opkg/.ipk 切换到 apk-tools 3 的 .apk
#     （ADB 容器格式，见 downloads.openwrt.org/releases/25.12.5/ 的包目录）；
#   * 手工拼 tar 无法生成 ADB 格式，必须用 apk-tools 官方的 `apk mkpkg`，
#     与 buildroot 25.12 打包走同一条路径（include/package-pack.mk 的 apk 分支）。
#
# 注意：产物未签名，设备上安装需要
#   apk add --allow-untrusted ./<pkg>.apk
#
# 用法：build-apk.sh <apk.static 路径> [输出目录，默认 dist]
set -euo pipefail

APK_IN="${1:?usage: build-apk.sh <apk.static> [out-dir]}"
OUT_DIR="${2:-dist}"

# sudo 下相对路径会失效，全部转成绝对路径
APK="$(cd "$(dirname "$APK_IN")" && pwd)/$(basename "$APK_IN")"
OUT="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"

# 取 Makefile 中 KEY:=value 的 value（保留右侧原样）
field() {
	local mk="$1" key="$2"
	sed -n "s/^${key}:=//p" "$mk" | tail -1
}

# LUCI_DEPENDS 是 ipk 记法："+luci-base +firewall4"；
# apk 依赖语法没有 '+' 前缀，转成空格分隔的 "luci-base firewall4"
# （apk 的依赖串按 apk_dep_split 切分，支持版本约束，原样保留即可）
normalize_depends() {
	local deps="$1" out="" dep
	read -r -a words <<<"$deps" || true
	for dep in "${words[@]}"; do
		dep="${dep#+}"
		[ -n "$dep" ] || continue
		out+="${out:+ }${dep}"
	done
	printf '%s' "$out"
}

pkg_count=0
for mk in luci-app-*/Makefile; do
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

	idir="build/$name"
	rm -rf "$idir"
	mkdir -p "$idir"

	# root/ 覆盖到 /，htdocs/ 覆盖到 /www（LuCI 打包约定，与 luci.mk 一致）
	if [ -d "$pkg_dir/root" ]; then
		cp -a "$pkg_dir/root/." "$idir/"
	fi
	if [ -d "$pkg_dir/htdocs" ]; then
		mkdir -p "$idir/www"
		cp -a "$pkg_dir/htdocs/." "$idir/www/"
	fi

	# OpenWrt 约定：包内自带文件清单（对应 include/package-pack.mk 生成的
	# lib/apk/packages/<pkg>.list）。先 find 再写入，避免把清单本身算进去。
	tmp_list="$(mktemp)"
	(
		cd "$idir" &&
			find . \( -type f -o -type l \) -printf '/%P\n' | sort >"$tmp_list"
	)
	mkdir -p "$idir/lib/apk/packages"
	mv "$tmp_list" "$idir/lib/apk/packages/${name}.list"

	# 组装 mkpkg 参数。sudo 是为了让包内文件记录为 root:root
	# （buildroot 用 fakeroot 达成同一效果；runner 用户对静态二进制
	# 无法用 fakeroot，sudo 最直接）。
	args=(
		mkpkg
		--info "name:${name}"
		--info "version:${version}-${release}"
		--info "description:${title}"
		--info "arch:noarch"
		--files "$idir"
		--output "$OUT/${name}-${version}-${release}.apk"
	)
	if [ -n "$license" ]; then
		args+=(--info "license:${license}")
	fi
	if [ -n "$url" ]; then
		args+=(--info "url:${url}")
	fi
	if [ -n "$depends" ]; then
		args+=(--info "depends:${depends}")
	fi

	sudo "$APK" "${args[@]}"
	pkg_count=$((pkg_count + 1))
	echo "built $OUT/${name}-${version}-${release}.apk"
done

if [ "$pkg_count" -eq 0 ]; then
	echo 'no luci-app-* package found' >&2
	exit 1
fi
echo "done: $pkg_count package(s)"
