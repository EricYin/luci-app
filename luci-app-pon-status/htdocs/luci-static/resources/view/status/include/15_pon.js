// SPDX-License-Identifier: Apache-2.0
//

'use strict';
'require baseclass';
'require fs';
'require uci';


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

function netRate(from, to) {
	var dt = (to.t - from.t) / 1000.0;

	if (dt <= 0 || to.rx < from.rx || to.tx < from.tx)
		return null;

	return {
		rx: (to.rx - from.rx) * 8 / 1048576 / dt,
		tx: (to.tx - from.tx) * 8 / 1048576 / dt
	};
}

function readRate(device) {
	return sampleNet(device).then(function(cur) {
		if (cur == null) {

			delete prevNet[device];
			return null;
		}

		var prev = prevNet[device];

		prevNet[device] = cur;

		if (prev != null) {
			var r = netRate(prev, cur);

			if (r != null)
				return r;
		}

		return new Promise(function(resolve) {
			window.setTimeout(function() {
				sampleNet(device).then(function(cur2) {
					if (cur2 == null) {
						delete prevNet[device];
						resolve(null);
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
	if (!rate)
		return E('div', { 'style': S_EMPTY }, [ _('不可用') ]);

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
