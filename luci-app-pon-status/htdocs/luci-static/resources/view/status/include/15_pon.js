// SPDX-License-Identifier: Apache-2.0
//

'use strict';
'require baseclass';
'require fs';
'require uci';

/*
 * PON 光模块 + 端口速率，Status -> Overview 的一个 include 块。
 *
 * 光模块读数（收发光功率 / 温度 / 偏置电流 / 供电电压）来自
 * `/usr/sbin/ponctl status --json` 的 frontend 段，沿用本包原有的实现。
 *
 * 端口速率自己采：/sys/class/net/<device>/statistics/{rx,tx}_bytes 相邻两次
 * 采样的差值除以实际经过的时间，单位 Mibit/s（1024*1024 bit/s）。口径与
 * luci-app-zn515xg-hw 的「Pon 端口速率」卡一致（上行取 tx、下行取 rx，
 * 上行在上、下行在下），差别只在取值方式：那个包必须借 helper 脚本 exec，
 * 因为它的连接数数据源 /proc/net/nf_conntrack 是 st_size 为 0 的伪文件、
 * rpcd 的 file.read 只读得回前 4 KiB；sysfs 的 statistics 属性是普通文件，
 * 一次 file.read 就能拿全，所以这里直接读、每次轮询省掉一次 exec。
 *
 * 采样点按 device 分开存（一台机器可能有多个 xpon 段）。第一次渲染时没有
 * 历史采样，就隔 500 ms 再采一次，让首屏就有读数而不是一整轮 pollinterval
 * 的空档；之后每次轮询直接用上次的采样，不再多采。
 *
 * 计数回绕 / 接口重启会让差值变成负数，那种情况直接判定为无效读数
 * （返回 null），不显示一个假的尖峰。
 *
 * 读这些 sysfs 属性的权限由
 * /usr/share/rpcd/acl.d/luci-app-pon-status.json 授予（注意要 file 的
 * *read* 而不仅是 exec —— 本包原来只 exec ponctl）。
 */

/* device -> 上一次 { rx, tx, t(ms) } */
var prevNet = {};

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

/* 一次采样：读 rx/tx 字节计数。接口不存在（或名字不对）时返回 null */
function sampleNet(device) {
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

var S_RATE_BLOCK  = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid ' + cBorder;
var S_RATE_TITLE  = 'font-size: 12px; color: ' + cMuted + '; margin-bottom: 4px';
var S_RATE_ROW    = 'display: flex; align-items: baseline; justify-content: space-between; gap: 8px';
var S_RATE_LABEL  = 'font-size: 12px; color: ' + cMuted;
var S_RATE_VALUE  = 'font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; color: ' + cStrong;
var S_RATE_UNIT   = 'font-size: 11px; color: ' + cMuted + '; margin-left: 3px';
var S_NOTE        = 'font-size: 11px; color: ' + cMuted + '; margin-top: 4px';
var S_EMPTY       = 'font-size: 13px; color: ' + cMuted;

function rateLine(label, value) {
	return E('div', { 'style': S_RATE_ROW }, [
		E('span', { 'style': S_RATE_LABEL }, [ label ]),
		E('span', {}, [
			E('span', { 'style': S_RATE_VALUE }, [ value.toFixed(2) ]),
			E('span', { 'style': S_RATE_UNIT }, [ 'Mibit/s' ])
		])
	]);
}

function buildRate(rate) {
	if (rate && rate.error)
		return E('div', { 'style': S_EMPTY },
			[ _('读取失败（检查 ACL 与接口名，需重新登录）') ]);

	if (!rate)
		return E('div', { 'style': S_EMPTY }, [ _('不可用') ]);

	/* 相邻两次渲染相隔 L.env.pollinterval 秒，所以读数是一段时间内的平均 */
	var window = (+L.env.pollinterval) || 5;

	return E('div', {}, [
		rateLine(_('上行速率'), rate.tx),
		rateLine(_('下行速率'), rate.rx),
		E('div', { 'style': S_NOTE }, [ window + ' 秒平均' ])
	]);
}

function renderBox(item) {
	var frontend = item.frontend || {};

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
			E('div', { 'style': S_RATE_BLOCK }, [
				E('div', { 'style': S_RATE_TITLE }, [ _('端口速率') ]),
				buildRate(item.rate)
			])
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

			return Promise.all(sections.map(function(section) {
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
			}));
		});
	},

	render: function(data) {
		if (!data || !data.length)
			return null;

		return E('div', { 'id': 'pon_optics_table', 'class': 'network-status-table' },
			data.map(renderBox));
	}
});
