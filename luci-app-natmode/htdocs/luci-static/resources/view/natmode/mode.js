// SPDX-License-Identifier: Apache-2.0
//

'use strict';
'require view';
'require form';
'require fs';
'require ui';

function parseStatus(text) {
	var st = { mode: '?', effective: '?', fullcone: '0',
	           random_rules: '0', srcnat_chains: '0', offload: 'off',
	           fullcone6: '0', fullcone6_opt: '0',
	           fw_mode: 'restricted', module: '?', synced: '0', healed: '0' };
	(text || '').split('\n').forEach(function(line) {
		var kv = line.split('=');
		if (kv.length >= 2)
			st[kv[0].trim()] = kv.slice(1).join('=').trim();
	});
	return st;
}

function modeLabel(m) {
	switch (m) {
		case 'fullcone':   return _('全锥形NAT') + '（NAT1）';
		case 'restricted': return _('受限型NAT') + '（NAT3）';
		case 'symmetric':  return _('全对称型NAT') + '（NAT4）';
		default:           return m;
	}
}

function pageCss() {
	return [
		'.natmode-page{font-size:.9rem;line-height:1.6}',
		'.natmode-page .cbi-map-descr{line-height:1.6;padding:.1rem .2rem .5rem;opacity:.85}',
		'.natmode-page .cbi-value{display:block;line-height:1.6;padding:.6rem .9rem}',
		'.natmode-page .cbi-value:nth-of-type(2n){background:transparent}',
		'.natmode-page .cbi-value-title{display:block;float:none;width:auto;text-align:left;padding:0 0 .3rem;font-weight:600;line-height:1.5}',
		'.natmode-page .cbi-value-field{display:block;width:auto}',
		'.natmode-page .cbi-value-description{display:block;padding:.45rem .1rem 0;line-height:1.55;opacity:.62}',
		'.natmode-page .nat-opt{display:flex;align-items:flex-start;margin:.5rem 0;padding:.6rem .75rem;border:1px solid var(--lighter);border-radius:.55rem;background:var(--white);cursor:pointer}',
		'.natmode-page .nat-opt.checked{border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary)}',
		'.natmode-page .nat-opt input[type="radio"]{flex:0 0 auto;width:1.1rem;height:1.1rem;margin:.18rem .6rem 0 0}',
		'.natmode-page .nat-opt input[type="radio"]+label{margin:0}',
		'.natmode-page .nat-opt span{flex:1 1 auto;display:block;min-width:0}',
		'.natmode-page .nat-choice strong{display:block;font-weight:600;line-height:1.5}',
		'.natmode-page .nat-choice .nat-choice-desc{display:block;font-size:.78rem;opacity:.6;line-height:1.55;margin-top:.1rem}',
		'.natmode-page .cbi-checkbox.nat-check{display:flex;align-items:center;margin:.2rem 0;padding:.55rem .75rem;border:1px solid var(--lighter);border-radius:.55rem;background:var(--white);cursor:pointer}',
		'.natmode-page .nat-check-title{flex:1 1 auto;font-weight:500;line-height:1.5}',
		'.natmode-page .nat-check input[type="checkbox"]{flex:0 0 auto;width:1.15rem !important;height:1.15rem !important;margin:0 0 0 .6rem}',
		'.natmode-page .cbi-page-actions{padding:.4rem 0 0}',
		'.natmode-page .cbi-page-actions .cbi-button{width:100%;padding:.75rem 1rem;font-size:1rem;border-radius:.55rem}'
	].join('\n');
}

function radioChoice(title, desc) {
	return E('span', { 'class': 'nat-choice' }, [
		E('strong', {}, title),
		E('span', { 'class': 'nat-choice-desc' }, desc)
	]);
}

function beautifyPage(root) {
	var frame = root.querySelector('[id="cbid.natmode.main.mode"]');
	if (frame) {
		var brs = frame.querySelectorAll(':scope > br');
		Array.prototype.forEach.call(brs, function(br) { br.parentNode.removeChild(br); });

		var inputs = frame.querySelectorAll(':scope > input[type="radio"]');
		Array.prototype.forEach.call(inputs, function(input) {
			var label = input.nextElementSibling;       
			var span = label ? label.nextElementSibling : null; 
			var card = E('div', { 'class': 'nat-opt' + (input.checked ? ' checked' : '') });
			frame.insertBefore(card, input);
			card.appendChild(input);
			if (label) card.appendChild(label);
			if (span) card.appendChild(span);
			card.addEventListener('click', function(ev) {
				if (ev.target === input || ev.target.tagName === 'LABEL') return;
				if (!input.checked) input.click();
			});
		});

		frame.addEventListener('change', function() {
			var cards = frame.querySelectorAll('.nat-opt');
			Array.prototype.forEach.call(cards, function(c) {
				var i = c.querySelector('input[type="radio"]');
				c.classList.toggle('checked', !!(i && i.checked));
			});
		});
	}

	[ 'cbid.natmode.main.fullcone6', 'cbid.natmode.main.auto_offload' ]
		.forEach(function(cbid) {
			var cb = root.querySelector('[id="' + cbid + '"]');
			if (!cb || !cb.classList.contains('cbi-checkbox'))
				return;
			var optDiv = cb.closest('.cbi-value');
			var title = optDiv ? optDiv.querySelector('.cbi-value-title') : null;
			if (title) {
				cb.insertBefore(E('strong', { 'class': 'nat-check-title' },
					[ title.textContent ]), cb.firstChild);
				title.style.display = 'none';
			}
			cb.classList.add('nat-check');
			cb.addEventListener('click', function(ev) {
				var input = cb.querySelector('input[type="checkbox"]');
				if (!input || ev.target === input || ev.target.tagName === 'LABEL')
					return;
				input.click();
			});
		});
}

function offloadLabel(v) {
	switch (v) {
		case 'hw':  return _('硬件卸载');
		case 'sw':  return _('软件卸载');
		default:    return _('关闭');
	}
}

function fwPageLabel(st) {
	if (st.fw_mode === 'fullcone')
		return _('已勾选「启用 FullCone NAT」');
	if (st.effective === 'symmetric')
		return _('未勾选（防火墙页无法表达 NAT4，随机端口仅本页可见）');
	return _('未勾选「启用 FullCone NAT」');
}

function renderStatus(st) {
	var rows = [
		_('当前模式'),        modeLabel(st.effective),
		_('FullCone 开关'),   (st.fullcone === '1' ? _('已启用') : _('已关闭')),
		_('IPv6 FullCone'),   (st.fullcone6 === '1' ? _('已启用') : _('已关闭'))
			+ (st.effective === 'fullcone' ? '' : _('（仅全锥形时生效）')),
		_('防火墙页对应状态'), fwPageLabel(st),
		_('随机端口规则'),    (st.random_rules !== '0'
			? _('已注入 ') + st.random_rules + _(' 条') : _('无')),
		_('srcnat 链'),       st.srcnat_chains + _(' 个'),
		_('路由/NAT 卸载'),   offloadLabel(st.offload),
		_('fullcone 内核模块'), (st.module === 'loaded' ? _('已加载') : _('未加载'))
	];

	var notice = [];  
	var warn = [];    
	if (st.synced === '1')
		notice.push(E('p', {}, _('已与防火墙同步：检测到你在「网络 → 防火墙 → 常规设置」'
			+ '改动过 FullCone 开关，本页已按实际生效状态更新为 ')
			+ modeLabel(st.effective) + _('。')));

	if (st.healed === '1')
		notice.push(E('p', {}, _('已自动修复：NAT4 的随机端口规则此前被防火墙重载清除，现已重新注入。')));

	if (st.effective !== 'symmetric' && st.random_rules !== '0')
		warn.push(E('p', {}, _('检测到残留的随机端口规则 ')
			+ st.random_rules + _(' 条，但当前不是全对称型NAT（NAT4）。'
			+ '这会让实际 NAT 行为既不是干净的 NAT3 也不是 NAT4。'
			+ '下次打开本页或执行 natmode-apply status 会自动清理。')));

	if (st.module !== 'loaded' && st.effective === 'fullcone')
		warn.push(E('p', {}, _('未检测到 nft_fullcone 模块，全锥形可能不生效。')));

	if (st.effective === 'symmetric' && st.offload !== 'off')
		warn.push(E('p', {}, _('NAT4 与路由/NAT 卸载互斥：卸载流量绕过 conntrack，'
			+ '随机端口规则不参与转发，实测仍是 NAT3。'
			+ '请关闭卸载，或勾选下方「应用 NAT4 时自动关闭卸载」后重新保存。')));
	else if (st.effective === 'fullcone' && st.offload !== 'off')
		warn.push(E('p', {}, _('已开启路由/NAT 卸载，卸载流量绕过 conntrack，'
			+ '可能使全锥形行为不稳定。测 NAT 类型时建议临时关闭卸载。')));

	if (st.effective === 'symmetric' && st.srcnat_chains === '0')
		warn.push(E('p', {}, _('未找到 fw4 的 srcnat_<zone> 链：'
			+ 'WAN 区域可能未启用 MASQUERADE，随机端口规则无处可插。')));

	var table = E('table', { 'class': 'table' });
	for (var i = 0; i < rows.length; i += 2) {
		table.appendChild(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'width': '33%' }, [ rows[i] ]),
			E('td', { 'class': 'td left' }, [ rows[i + 1] || '?' ])
		]));
	}

	var children = [ E('h3', _('当前状态')), table ];
	notice.forEach(function(w) {
		children.push(E('div', { 'class': 'alert-message notice' }, [ w ]));
	});
	warn.forEach(function(w) {
		children.push(E('div', { 'class': 'alert-message warning' }, [ w ]));
	});

	return E('div', { 'class': 'cbi-section' }, children);
}

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/usr/sbin/natmode-apply', ['status']), '');
	},

	render: function(statusText) {
		var st = parseStatus(statusText);
		var m = new form.Map('natmode', _('NAT 类型'),
			_('选择路由器对内网出向连接的 NAT 行为。数字越小越宽松，P2P / 游戏 / PT 体验越好。')
			+ _('改动后请点击下方「应用 NAT 模式」按钮立即生效。'));

		var s = m.section(form.NamedSection, 'main', 'natmode');
		s.anonymous = false;
		var o = s.option(form.ListValue, 'mode', _('NAT 类型'));
		o.widget = 'radio';
		o.orientation = 'vertical';
		o.value('fullcone', radioChoice(
			_('全锥形NAT') + '（NAT1）',
			_('最宽松，端点无关映射 + 端点无关过滤。游戏联机、PT 做种、PCDN 最优。')));
		o.value('restricted', radioChoice(
			_('受限型NAT') + '（NAT3）',
			_('系统默认。端点无关映射 + 地址端口相关过滤，日常上网无影响。')));
		o.value('symmetric', radioChoice(
			_('全对称型NAT') + '（NAT4）',
			_('端口完全随机，映射不可预测，打洞基本不可用。仅用于特殊合规场景。')));
		o.default = 'fullcone';
		
		var o6 = s.option(form.Flag, 'fullcone6',
			_('同时开启 IPv6 FullCone NAT'),
			_('对应 firewall.@defaults[0].fullcone6。'
			+ 'IPv6 通常有公网前缀、不做 NAT，收益有限；'
			+ '少数环境下反而会导致 IPv6 连接异常，故默认关闭。'
			+ '仅在选择「全锥形NAT（NAT1）」时生效，其余模式下该键会被删除。'));
		o6.default = '0';

		var oc = s.option(form.Flag, 'auto_offload',
			_('应用 NAT4 时自动关闭路由/NAT 卸载'),
			_('NAT4 的随机端口依赖 nft masquerade，而卸载（尤其硬件卸载走 PPE）'
			+ '会把流量绕过 conntrack 直接转发 —— 两者互斥，开着卸载 NAT4 实测仍是 NAT3。'
			+ '勾选后，选择「全对称型NAT」时会自动关闭卸载（代价：吞吐下降）。'));
		oc.default = '0';

		function readSelection() {
			return {
				mode: o.formvalue('main') || 'fullcone',
				fc6:  o6.formvalue('main') || '0',
				off:  oc.formvalue('main') || '0'
			};
		}

		function runApply(sel) {
			return fs.exec('/usr/sbin/natmode-apply',
				['apply', sel.mode, sel.fc6, sel.off])
				.then(function(res) {
					if (res && typeof res.code === 'number' && res.code !== 0)
						throw new Error((res.stderr || res.stdout ||
							'natmode-apply 退出码 ' + res.code).trim());
				});
		}

		var origApply = (ui.changes && typeof ui.changes.apply === 'function')
			? ui.changes.apply : null;

		if (origApply && !ui.changes.__natmodeHooked) {
			ui.changes.__natmodeHooked = true;
			ui.changes.apply = function() {
				var args = arguments;
				var sel = readSelection();
				return runApply(sel)
					.catch(function(e) {
						ui.addNotification(null,
							E('p', _('应用 NAT 模式失败：')
								+ (e && e.message ? e.message : e)), 'error');
					})
					.then(function() {
						return origApply.apply(ui.changes, args);
					});
			};
		}

		var applyBtn = E('button', {
			'class': 'cbi-button cbi-button-apply important',
			'click': ui.createHandlerFn(m, function(ev) {
				var sel = readSelection();
				return runApply(sel)
					.then(function() {
						if (origApply)
							return origApply.call(ui.changes);
						return null;
					})
					.then(function() {
						ui.addNotification(null,
							E('p', _('NAT 模式已应用，防火墙已重载。')), 'success');
						window.setTimeout(function() {
							window.location.reload();
						}, 1500);
					})
					.catch(function(e) {
						ui.addNotification(null,
							E('p', _('应用失败：')
								+ (e && e.message ? e.message : e)), 'error');
					});
			})
		}, _('应用 NAT 模式'));

		return m.render().then(function(nodes) {
			var kids = [ E('style', { 'type': 'text/css' }, [ pageCss() ]), renderStatus(st) ];
			if (Array.isArray(nodes))
				kids = kids.concat(nodes);
			else if (nodes != null)
				kids.push(nodes);
			kids.push(E('div', { 'class': 'cbi-page-actions' }, [ applyBtn ]));
			var root = E('div', { 'class': 'natmode-page' }, kids);
			beautifyPage(root);
			return root;
		});
	}
});
