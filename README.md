# luci-app

面向 OpenWrt / PonWrt 的 LuCI 插件与固件包集合，主要为 **Airoha AN758x（EN7581 / AN7583）PON 光猫机型**服务。

包按目录拆开，每个目录就是一个独立的 OpenWrt 包，可以单独取用、单独编译。

| 包 | 版本 | 作用 | 界面位置 | 额外依赖 |
|---|---|---|---|---|
| `luci-app-natmode` | 0.1.6-r1 | NAT 类型三选一：全锥形 / 受限 / 对称 | 网络 → NAT 类型 | `firewall4`、`kmod-nft-fullcone` |
| `luci-app-pon-status` | 0.4.6-r4 | PON 光模块 + 端口速率 + 连接数概览卡片 | 状态 → 概览 | `airoha-ponctl`、`jsonfilter`、`rpcd-mod-file`、`luci-mod-status` |
| `h3c-fmcs-firmware` | 1.0-r1 | H3C HM2004-DU Micro-OLT FPGA 比特流 | 无界面 | 仅 `@TARGET_airoha` |

三者共同的前提是设备上有 **LuCI + rpcd**。

---

## 安装

### 方式一：直接装现成的包（推荐）

Release 里有每次推送自动打好的包，`snapshot` 这个 tag 始终指向最新一次构建，四种产物：

```text
luci-app-natmode-0.1.6-r1.apk        luci-app-natmode_0.1.6-r1_all.ipk
luci-app-pon-status-0.4.6-r4.apk     luci-app-pon-status_0.4.6-r4_all.ipk
```

- **`.apk`** 给 OpenWrt **25.12 及之后**（包管理器是 apk）：

  ```sh
  apk add --allow-untrusted ./luci-app-pon-status-0.4.6-r4.apk
  ```

- **`.ipk`** 给 OpenWrt **24.10 及更早**（包管理器是 opkg）：

  ```sh
  opkg install ./luci-app-pon-status_0.4.6-r4_all.ipk
  ```

两种包都是**与架构无关的纯数据包**（noarch / `Architecture: all`），ARM64 设备通用，不用挑型号。

装之前请确认上面表格里的依赖已经在设备上。这些不在自动依赖里，得自备——`kmod-nft-fullcone` 和 `airoha-ponctl` 都随 PonWRT 源码树提供。

装完清一下 LuCI 缓存再刷新页面：

```sh
rm -f /tmp/luci-indexcache.*; rm -rf /tmp/luci-modulecache/
```

### 方式二：编进固件

把需要的包目录整个拷到源码树的 `package/` 下（例如 `package/luci-app-pon-status/`），然后：

```sh
./scripts/feeds update -a && ./scripts/feeds install -a
make menuconfig          # LuCI → Applications 里勾选
make package/luci-app-pon-status/compile V=s
```

`h3c-fmcs-firmware` 不在 Firmware 分类里默认可见，需要 `make menuconfig` 时手动打开，且只在 airoha target 下才会出现。它**没有出现在 Release 产物里**（见下方「自动构建」），只能自己编译进固件。

---

## 各包说明

### luci-app-natmode —— NAT 类型选择器

在 **网络 → NAT 类型** 里切换三种模式，底层是写 `firewall.@defaults[0]` 并操作 nftables：

- **全锥形（NAT1）**：开 `fullcone=1`。端点无关映射 + 端点无关过滤，P2P、主机游戏、PT、PCDN 最优。
- **受限型（NAT3）**：netfilter 默认行为，删掉 `fullcone` 即可。
- **对称型（NAT4）**：往 fw4 的 `srcnat_*` 链插入 `masquerade fully-random`，端口完全随机。

两个可选开关：

- `fullcone6`（默认 0）：是否对 IPv6 也开 FullCone。IPv6 一般不做 NAT，收益有限，少数运营商环境下还会导致 IPv6 连接异常，所以默认关。仅在全锥形下生效。
- `auto_offload`（默认 0）：应用 NAT4 时自动关闭路由/NAT 卸载。**这个默认值的含义要特别注意**，见下方提示。

服务 `START=99`，刻意排在 fw4（`START=19`）之后——NAT4 的随机端口规则要插进 fw4 生成的链，链还没生成时注入等于没注入。另外挂了 `interface.*` 触发器：WAN 上线（尤其 PPPoE）会触发 fw4 整表重建，把开机注入的规则抹掉，所以接口事件后延迟 5 秒重跑一次。

### luci-app-pon-status —— PON 概览卡片

在 **状态 → 概览** 加一张「PON 光模块」卡片，显示：

- **光模块读数**：收光功率、发光功率、光模块温度、偏置电流、供电电压，来自 `ponctl status --json` 的 `frontend` 段（`schema_version` 必须为 1）。
- **端口速率**：上行 / 下行，单位 Mibit/s。取相邻两次采样的字节差除以实际经过的时间，口径与「Pon 端口速率」卡一致（上行取 tx、下行取 rx）。计数回绕或接口重启导致差值为负时判定为无效读数，不显示假的尖峰。
- **连接数**：TCP / UDP 总数，以及其中被卸载接管的子集。

取数有两套来源：优先走 ubus `network.device status`（由 luci-base 的 ACL 组授权），拿不到时退回 sysfs 直读。第一次成功的来源会被记住，之后不再重复探测。

连接数必须走 helper 脚本 `ponstat-conn`：`/proc/net/nf_conntrack` 是 `st_size` 为 0 的伪文件，rpcd 的 `file.read` 对这种文件只返回前 4 KiB，数不完整个表。脚本同时兼容内核 5.4 的 `[OFFLOAD]` 和 5.13+ 的 `[HW_OFFLOAD]` 两种标记写法。conntrack 不可读时卡片显示「不可用」，而不是一个假的 0。

### h3c-fmcs-firmware —— HM2004-DU FPGA 比特流

把 `FTTR_TOP.sbit`（2,087,000 字节，紫光同创 Logos-PGL50H 的 `FTTR_TOP` 设计）装到 `/lib/firmware/FTTR_TOP.sbit`。整个包只做这一件事，没有编译步骤、没有 init 脚本、没有任何加载代码。

> **现阶段装上也不会生效。** 当前开源侧没有驱动 `request_firmware` 这个文件，设备树里 FMCS 节点仍是 `disabled` —— 它只是把比特流铺进 rootfs，FPGA 不会自己加载。

依赖 `@TARGET_airoha`，非 airoha target 下 menuconfig 里看不到这个包。

---

## 自动构建

`.github/workflows/build.yml` 在每次推送后跑两类任务：

1. **质量校验**：LuCI 包结构检查、ShellCheck（error 级别阻断、warning 级别只提示）、JSON 语法校验。
2. **打包**（不拉 SDK、不用 docker，几分钟出结果）：
   - `build-apk`：用 apk-tools 官方静态二进制的 `apk mkpkg` 组装，产物给 OpenWrt 25.12+。
   - `build-ipk`：用 tar 按 opkg 格式手工组装，`Architecture` 写 `all`，产物给 24.10 及更早。

打包脚本遍历的是 `luci-app-*/Makefile`，**`h3c-fmcs-firmware` 不匹配这个通配，所以不在 Release 产物里**，需要自己编译进固件。

---

## 几个容易踩的坑

**可执行位。** LuCI 通过 rpcd 调起 `/usr/sbin/natmode-apply`、`/usr/sbin/ponstat-conn`，而 rpcd 的 `file.exec` 拒绝执行没有可执行位的文件。网页上传 / zip 打包这条链路上 x 位反复丢失，症状是页面报「退出码 127」或某项显示「不可用」。两个包都在 `Build/Prepare` 里补了 `chmod`，`pon-status` 还改成经 `/bin/sh` 调起兜底，装完 postinst 再补一次。如果你手工往设备里拷文件，记得：

```sh
chmod 0755 /usr/sbin/natmode-apply /usr/sbin/ponstat-conn
```

**NAT4 默认名不副实。** `auto_offload` 默认是 0，也就是保留路由/NAT 卸载。而卸载（尤其走 PPE 的硬件卸载）会把流量绕过 conntrack 直接转发，nft 的 `fully-random` 根本不参与——NAT4 只是配置上了，实测仍是 NAT3。想要真正的 NAT4 就把它置 1，代价是硬件转发失效、吞吐下降。

**概览卡片在部分固件上不出来。** 正常 LuCI 的 `view/status/index.js` 是运行时扫目录，把 `15_pon.js` 丢进去就会自动出现。但有些分支（例如 QWRT R26.x）把这份 include 列表写死成了固定几个模块名，扫不到新文件。这种情况由 `attach-card` 在装包时注入、卸包时回滚，注入后会做精确串 + 括号计数三重校验，任一项不过就从备份还原，不会把概览页搞白屏。

**FTTR 比特流的合规问题。** 包里装的 `FTTR_TOP.sbit` 是从 H3C 设备提取的厂商 FPGA 二进制，仓库**没有声明**它的分发许可——Makefile 头部的 SPDX 声明只覆盖构建脚本本身。自用没问题，但别默认它可以随公开固件再分发。

---

## 授权

LuCI 应用与脚本：**Apache-2.0**。

`h3c-fmcs-firmware` 中的 `FTTR_TOP.sbit`：**未声明**，属厂商资产。
