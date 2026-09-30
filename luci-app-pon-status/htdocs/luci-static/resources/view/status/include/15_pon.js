// SPDX-License-Identifier: Apache-2.0
//

'use strict';
'require baseclass';
'require fs';
'require rpc';
'require uci';

/*
 * PON 光模块 + 端口速率，Status -> Overview 的一个 include 块。
 *
 * 光模块读数（收发光功率 / 温度 / 偏置电流 / 供电电压）来自
 * `/usr/sbin/ponctl status --json` 的 frontend 段，沿用本包原有的实现。
 *
 * 端口速率自己采：相邻两次采样的 {rx,tx}_bytes 差值除以实际经过的时间，
 * 单位 Mibit/s（1024*1024 bit/s）。口径与 luci-app-zn515xg-hw 的
 * 「Pon 端口速率」卡一致（上行取 tx、下行取 rx，上行在上、下行在下）。
 *
 * 连接数（TCP/UDP 总数 + [HW_OFFLOAD] 硬件卸载子集）由 helper 脚本
 * /usr/sbin/ponstat-conn 一次 exec 给出，布局在速率行的右侧。
 *
 * 数据源按优先级：
 *
 *   1) ubus `network.device status` —— LuCI 接口状态页本来就在用的调用，
 *      由 luci-base 的 luci-base-network-status ACL 组授权，返回值里每个
 *      设备名下都带 statistics（含 rx_bytes/tx_bytes）。pon0 在 sysfs 里
 *      是个符号链接，rpcd 的 file.read ACL 匹配走的是解析后的真实路径，
 *      "net/*" 这种通配根本批不下来（在 ponwrt 上实测：
 *      设备上的 ACL 文件正确、rpcd 已重启、重新登录，cat 能读，
 *      LuCI 里 file.read 仍被拒），所以 sysfs 直读只能当备胎。
 *
 *   2) sysfs /sys/class/net/<device>/statistics/{rx,tx}_bytes 直读
 *      （本包 ACL 授权）。只有在 ubus 那边拿不到该设备统计时才用它。
 *
 * 第一次成功的来源会被记住（statsSource），之后的轮询不再重复探测。
 *
 * 采样点按 device 分开存。第一次渲染时没有历史采样，就隔 500 ms 再采
 * 一次，让首屏就有读数；之后每次轮询直接用上次的采样。
 *
 * 计数回绕 / 接口重启会让差值变成负数，那种情况判定为无效读数
 * （返回 null），不显示一个假的尖峰。
 */

/* device -> 上一次 { rx, tx, t(ms) } */
var prevNet = {};

/* 探测后固定的取数来源：'ubus' 或 'sysfs' */
var statsSource = null;

/* 连接数 helper（精确路径 exec，ACL 不涉通配）：数 /proc/net/nf_conntrack
 * 里的 TCP/UDP 条目及 [HW_OFFLOAD] 子集。必须走 helper —— 该文件是
 * st_size 为 0 的伪文件，rpcd 的 file.read 只读得回前 4 KiB。 */
var CONNSTAT = '/usr/sbin/ponstat-conn';

var callDeviceStatus = rpc.declare({
	object: 'network.device',
	method: 'status'
});

function readFrontend(device) {
	var args = (device != null && device !== '')
		? [ '--device', device, 'status', '--json' ]
		: [ 'status', '--json' ];

	return L.resolveDefault(fs.exec_direct('/usr/sbin/ponctl', args), null).then(function(output) {
		if (!output)
			return { error: _('读取失败（设备不可用）') };

		try {
			var snapshot = JSON.parse(output);
			if (snapshot.schema_version !== 1)
				throw new Error('unsupported schema');
			return L.isObject(snapshot.frontend) ? snapshot.frontend : {};
		} catch (e) {
			return { error: _('解析失败') };
		}
	});
}

/* 备用：sysfs 直读一次采样。接口不存在 / ACL 被拒时返回 null */
function sampleSysfs(device) {
	var base = '/sys/class/net/' + device + '/statistics';

	return Promise.all([
		L.resolveDefault(fs.trimmed(base + '/rx_bytes'), null),
		L.resolveDefault(fs.trimmed(base + '/tx_bytes'), null)
	]).then(function(v) {
		var rx = parseInt(v[0]), tx = parseInt(v[1]);

		if (isNaN(rx) || isNaN(tx))
			return null;

		return { rx: rx, tx: tx, t: Date.now() };
	});
}

/* 主：ubus network.device status。调用失败或没有该设备的统计 -> null */
function sampleUbus(device) {
	return L.resolveDefault(callDeviceStatus(), null).then(function(res) {
		var dev = (L.isObject(res) && L.isObject(res[device]))
			? res[device] : null;
		var st = (dev != null && L.isObject(dev.statistics))
			? dev.statistics : null;
		var rx = (st != null) ? parseInt(st.rx_bytes) : NaN;
		var tx = (st != null) ? parseInt(st.tx_bytes) : NaN;

		if (isNaN(rx) || isNaN(tx))
			return null;

		return { rx: rx, tx: tx, t: Date.now() };
	});
}

/* 一次采样：先 ubus，拿不到该设备统计时退回 sysfs；都不行 -> null */
function sampleNet(device) {
	if (statsSource == 'sysfs')
		return sampleSysfs(device);

	return sampleUbus(device).then(function(cur) {
		if (cur != null) {
			statsSource = 'ubus';
			return cur;
		}

		return sampleSysfs(device).then(function(cur2) {
			if (cur2 != null)
				statsSource = 'sysfs';

			return cur2;
		});
	});
}

/* 计数回绕 / 接口重启会算出巨大的假速率，那种情况返回 null */
function netRate(from, to) {
	var dt = (to.t - from.t) / 1000.0;

	if (dt <= 0 || to.rx < from.rx || to.tx < from.tx)
		return null;

	return {
		rx: (to.rx - from.rx) * 8 / 1048576 / dt,
		tx: (to.tx - from.tx) * 8 / 1048576 / dt
	};
}

/* 连接数：一次 helper exec 拿 TCP/UDP 总数与硬件卸载子集，不可用 -> null */
function readConns() {
	return L.resolveDefault(fs.exec(CONNSTAT), null).then(function(res) {
		var vals = {},
		    lines = ((res && res.stdout) || '').split('\n'),
		    i, m;

		for (i = 0; i < lines.length; i++) {
			m = lines[i].match(/^([a-z0-9_]+)=(\d+)$/);

			if (m)
				vals[m[1]] = parseInt(m[2]);
		}

		if (typeof(vals.tcp_total) != 'number' &&
		    typeof(vals.udp_total) != 'number')
			return null;

		function pair(total, npu) {
			return (typeof(total) == 'number')
				? { total: total, npu: (typeof(npu) == 'number') ? npu : 0 }
				: null;
		}

		return { tcp: pair(vals.tcp_total, vals.tcp_npu),
		         udp: pair(vals.udp_total, vals.udp_npu) };
	});
}

/* { rx, tx }，单位 Mibit/s；计数读不到 -> { error: true }（多半是 ACL 没生效
 * 或接口不存在），采样有效但差分无效（回绕/重启）-> null */
function readRate(device) {
	return sampleNet(device).then(function(cur) {
		if (cur == null) {
			/* 读不到计数 —— 以后也采不到，别留着旧采样 */
			delete prevNet[device];
			return { error: true };
		}

		var prev = prevNet[device];

		prevNet[device] = cur;

		if (prev != null) {
			var r = netRate(prev, cur);

			if (r != null)
				return r;
		}

		/* 首次渲染（或上一次采样已失效）：补一次短间隔采样 */
		return new Promise(function(resolve) {
			window.setTimeout(function() {
				sampleNet(device).then(function(cur2) {
					if (cur2 == null) {
						delete prevNet[device];
						resolve({ error: true });
						return;
					}

					prevNet[device] = cur2;
					resolve(netRate(cur, cur2));
				});
			}, 500);
		});
	});
}

function metric(frontend, field, unit, digits) {
	if (frontend.error)
		return frontend.error;
	if (!Object.prototype.hasOwnProperty.call(frontend, field))
		return _('不支持');
	return Number(frontend[field]).toFixed(digits) + ' ' + unit;
}

/* 主题变量 + 字面兜底（兜底值取 luCI 亮色主题的实际定义） */
function css(name, fallback) {
	return 'var(--' + name + ', ' + fallback + ')';
}

var cBorder = css('border-color-low', '#eeeeee');
var cMuted  = css('text-color-medium', '#808080');
var cStrong = css('text-color-highest', '#000000');
var cCool   = css('success-color-high', 'rgb(0, 172, 89)');

var S_RATE_BLOCK = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid ' + cBorder;
/* 一行三列的网格：
 *   (1,1) 端口速率   (1,2) 上行行   (1,3) TCP 行
 *   (2,1) N 秒平均   (2,2) 下行行   (2,3) UDP 行
 * 左列两个标注分别与上下行两行对齐；右列是连接数。
 * 窄屏（手机）要点：所有文字节点 nowrap，禁止逐字竖排断行；列间距收紧；
 * 数值字号略降，保证三列在 360px 宽度内放得下。 */
var S_GRID       = 'display: grid; grid-template-columns: auto auto auto; gap: 8px 8px; align-items: center; justify-content: space-between; min-width: 0';
var S_POS_TITLE  = 'grid-column: 1; grid-row: 1';
var S_POS_NOTE   = 'grid-column: 1; grid-row: 2';
var S_POS_RATE   = 'grid-column: 2; grid-row: 1 / 3; display: flex; flex-direction: column; gap: 8px; min-width: 0';
var S_POS_TCP    = 'grid-column: 3; grid-row: 1';
var S_POS_UDP    = 'grid-column: 3; grid-row: 2';
var S_POS_SPAN   = 'grid-column: 3; grid-row: 1 / 3';
var S_RATE_TITLE = 'font-size: 12px; color: ' + cMuted + '; white-space: nowrap';
/* 「N 秒平均」刻意比「端口速率」小一号 */
var S_NOTE       = 'font-size: 10px; color: ' + cMuted + '; white-space: nowrap';
var S_RATE_ROW   = 'display: flex; align-items: baseline; justify-content: space-between; gap: 5px; min-width: 0';
var S_RATE_LABEL = 'font-size: 12px; color: ' + cMuted + '; white-space: nowrap';
var S_RATE_VALUE = 'font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; color: ' + cStrong + '; white-space: nowrap';
var S_RATE_UNIT  = 'font-size: 10px; color: ' + cMuted + '; margin-left: 2px; white-space: nowrap';
var S_EMPTY      = 'font-size: 13px; color: ' + cMuted;
/* 连接数行：协议标签 + 总数 + 硬件卸载计数（绿色，好消息的颜色）。
 * 「硬件卸载」在窄屏下写成「卸载」——整行要和速率行挤在同一行宽里。 */
var S_CONN_ROW   = 'display: flex; align-items: baseline; gap: 3px; min-width: 0';
var S_CONN_LABEL = 'font-size: 11px; font-weight: 600; color: ' + cMuted + '; white-space: nowrap';
var S_CONN_VALUE = 'font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; color: ' + cStrong + '; white-space: nowrap';
var S_CONN_NPU   = 'font-size: 10px; color: ' + cMuted + '; white-space: nowrap';
var S_CONN_NPU_V = 'font-size: 12px; font-weight: 600; color: ' + cCool + '; white-space: nowrap';

function rateLine(label, value) {
	return E('div', { 'style': S_RATE_ROW }, [
		E('span', { 'style': S_RATE_LABEL }, [ label ]),
		E('span', {}, [
			E('span', { 'style': S_RATE_VALUE }, [ value.toFixed(2) ]),
			E('span', { 'style': S_RATE_UNIT }, [ 'Mibit/s' ])
		])
	]);
}

function connCell(label, c, pos) {
	/* 不给 E() 传 null 子节点（旧版 LuCI 不跳过 null），这里全部非空 */
	return E('div', { 'style': S_CONN_ROW + '; ' + pos }, [
		E('span', { 'style': S_CONN_LABEL }, [ label ]),
		E('span', { 'style': S_CONN_VALUE }, [ String(c.total) ]),
		E('span', { 'style': S_CONN_NPU }, [ _('卸载') ]),
		E('span', { 'style': S_CONN_NPU_V }, [ String(c.npu) ])
	]);
}

function buildRateCells(rate, conns, window) {
	var cells = [];

	cells.push(E('span', { 'style': S_RATE_TITLE + '; ' + S_POS_TITLE },
		[ _('端口速率') ]));

	if (rate && !rate.error)
		cells.push(E('span', { 'style': S_NOTE + '; ' + S_POS_NOTE },
			[ window + ' 秒平均' ]));

	if (rate && !rate.error)
		cells.push(E('div', { 'style': S_POS_RATE }, [
			rateLine(_('上行'), rate.tx),
			rateLine(_('下行'), rate.rx)
		]));
	else
		cells.push(E('div', { 'style': S_EMPTY + '; ' + S_POS_RATE },
			[ rate ? _('读取失败（network.device status 与 sysfs 均不可用）')
			       : _('不可用') ]));

	if (conns && (conns.tcp || conns.udp)) {
		if (conns.tcp)
			cells.push(connCell('TCP', conns.tcp, S_POS_TCP));

		if (conns.udp)
			cells.push(connCell('UDP', conns.udp, S_POS_UDP));
	}
	else {
		cells.push(E('div', { 'style': S_EMPTY + '; ' + S_POS_SPAN },
			[ _('连接数不可用') ]));
	}

	return cells;
}

function renderBox(item) {
	var frontend = item.frontend || {};

	/* 读数是一段时间内的平均，窗口 = 轮询间隔 */
	var window = (+L.env.pollinterval) || 5;

	return E('div', { 'class': 'ifacebox' }, [
		E('div', { 'class': 'ifacebox-head center active' },
			E('strong', item.device)),
		E('div', { 'class': 'ifacebox-body left' }, [
			L.itemlist(E('span'), [
				_('收光功率'), metric(frontend, 'rx_power_dbm', 'dBm', 2),
				_('发光功率'), metric(frontend, 'tx_power_dbm', 'dBm', 2),
				_('光模块温度'), metric(frontend, 'temperature_celsius', '°C', 2),
				_('偏置电流'), metric(frontend, 'tx_bias_ma', 'mA', 2),
				_('供电电压'), metric(frontend, 'voltage_volts', 'V', 4)
			]),
			E('div', { 'style': S_RATE_BLOCK },
				E('div', { 'style': S_GRID },
					buildRateCells(item.rate, item.conns, window)))
		])
	]);
}

return baseclass.extend({
	title: _('PON 光模块'),

	load: function() {
		return uci.load('pon').then(function() {
			var sections = uci.sections('pon', 'xpon').filter(function(section) {
				return section.device;
			});

			if (!sections.length)
				return Promise.reject();

			/* 连接数是整机数据，与具体光口无关，一次 exec 所有卡片共用 */
			return Promise.all([
				readConns(),
				Promise.all(sections.map(function(section) {
					return Promise.all([
						readFrontend(section.device),
						readRate(section.device)
					]).then(function(res) {
						return {
							device: section.device,
							frontend: res[0],
							rate: res[1]
						};
					});
				}))
			]).then(function(res) {
				var conns = res[0];

				res[1].forEach(function(item) {
					item.conns = conns;
				});

				return res[1];
			});
		});
	},

	render: function(data) {
		if (!data || !data.length)
			return null;

		return E('div', { 'id': 'pon_optics_table', 'class': 'network-status-table' },
			data.map(renderBox));
	}
});
