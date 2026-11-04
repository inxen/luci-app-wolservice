'use strict';
'require view';
'require rpc';
'require ui';

var callStatus = rpc.declare({ object: 'wolservice', method: 'getStatus' });
var callLog = rpc.declare({ object: 'wolservice', method: 'getLog', params: [ 'lines' ] });
var callConfig = rpc.declare({ object: 'wolservice', method: 'getConfig' });
var callConfigForm = rpc.declare({ object: 'wolservice', method: 'getConfigForm' });
var callSaveConfigForm = rpc.declare({ object: 'wolservice', method: 'saveConfigForm', params: [ 'fields', 'restart' ] });
var callSave = rpc.declare({ object: 'wolservice', method: 'saveConfig', params: [ 'content', 'restart' ] });
var callAction = rpc.declare({ object: 'wolservice', method: 'serviceAction', params: [ 'action' ] });
var callSettings = rpc.declare({ object: 'wolservice', method: 'applySettings', params: [ 'enabled', 'config_path', 'log_max_size' ] });
var callProbe = rpc.declare({ object: 'wolservice', method: 'probePanel' });
var callRollback = rpc.declare({ object: 'wolservice', method: 'rollbackBinary' });
var callCheckUpdate = rpc.declare({ object: 'wolservice', method: 'checkUpdate' });
var callStartInstall = rpc.declare({ object: 'wolservice', method: 'startInstall', params: [ 'version', 'url', 'digest', 'size', 'asset' ] });
var callJob = rpc.declare({ object: 'wolservice', method: 'getJob' });
var callBegin = rpc.declare({ object: 'wolservice', method: 'uploadBegin', params: [ 'size' ] });
var callChunk = rpc.declare({ object: 'wolservice', method: 'uploadChunk', params: [ 'seq', 'data' ] });
var callEnd = rpc.declare({ object: 'wolservice', method: 'uploadEnd' });
var callAbort = rpc.declare({ object: 'wolservice', method: 'uploadAbort' });

/* uhttpd 转发到 ubus 的单次 JSON-RPC 载荷有大小上限，24KB 原始数据约 32KB base64。 */
var CHUNK = 24 * 1024;

function fmtSize(n) {
	if (n == null || n < 0)
		return '—';
	if (n >= 1048576)
		return (n / 1048576).toFixed(1) + ' MB';
	if (n >= 1024)
		return (n / 1024).toFixed(1) + ' KB';
	return n + ' B';
}

function fmtTime(epoch) {
	if (!epoch)
		return '—';
	var d = new Date(epoch * 1000);
	if (isNaN(d.getTime()))
		return '—';
	var p = function(n) { return n < 10 ? '0' + n : '' + n; };
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
		p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtDateStr(s) {
	if (!s)
		return '—';
	var d = new Date(s);
	if (isNaN(d.getTime()))
		return s;
	return fmtTime(d.getTime() / 1000);
}

function jobIsActive(j) {
	return !!j && (j.phase === 'starting' || j.phase === 'downloading' ||
		j.phase === 'verifying' || j.phase === 'installing');
}

function fmtUptime(sec) {
	if (sec == null || sec < 0)
		return '—';
	sec = Math.floor(sec);
	if (sec < 60)
		return sec + ' 秒';
	if (sec < 3600)
		return Math.floor(sec / 60) + ' 分钟';
	if (sec < 86400)
		return Math.floor(sec / 3600) + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分';
	return Math.floor(sec / 86400) + ' 天 ' + Math.floor((sec % 86400) / 3600) + ' 小时';
}

/* WOL 服务日志是 RFC3339（路由器可能用 UTC），在浏览器按本地时区显示。 */
function fmtLogLine(line) {
	var m = String(line || '').match(/^(time=)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(\s+[\s\S]*)$/);
	if (!m)
		return line;
	var d = new Date(m[2]);
	if (isNaN(d.getTime()))
		return line;
	return m[1] + fmtTime(d.getTime() / 1000) + m[3];
}

function ensureOk(r) {
	if (r && r.ok === false)
		throw new Error(r.error || '操作失败');
	return r;
}

function card(title, children, rightNode) {
	var head = E('div', {
		'style': 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px'
	}, [
		E('h3', { 'style': 'margin:0;padding:0;border:0;font-size:15px' }, title),
		rightNode || E('span', {})
	]);

	var kids = Array.isArray(children) ? children : [ children ];

	return E('div', {
		'class': 'cbi-section',
		'style': 'padding:16px;margin-bottom:16px;border:1px solid rgba(127,127,127,.25);border-radius:6px'
	}, [ head ].concat(kids));
}

function kvGrid(items) {
	return E('div', {
		'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px 24px;' +
			'padding:12px 14px;border-radius:4px;background:rgba(127,127,127,.07)'
	}, items.map(function(it) {
		return E('div', {}, [
			E('div', { 'style': 'font-size:12px;line-height:1.6;opacity:.62' }, it[0]),
			E('div', { 'style': 'font-weight:600;line-height:1.5;word-break:break-all' }, it[1])
		]);
	}));
}

function pill(text, ok) {
	return E('span', {
		'style': 'display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:12px;' +
			'font-size:12px;font-weight:600;white-space:nowrap;' +
			(ok ? 'background:rgba(46,125,50,.12);color:#2e7d32' : 'background:rgba(198,40,40,.12);color:#c62828')
	}, [ E('span', { 'style': 'font-size:10px' }, '●'), text ]);
}

function confirmAction(title, text, fn) {
	ui.showModal(title, [
		E('p', {}, text),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
			E('button', {
				'class': 'cbi-button cbi-button-action important',
				'click': function() { ui.hideModal(); fn(); }
			}, '确定')
		])
	]);
}

function bufToB64(buf) {
	var bytes = new Uint8Array(buf), bin = '';
	for (var i = 0; i < bytes.length; i += 0x8000)
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return window.btoa(bin);
}

function panelBase(st) {
	if (!st || !st.listen_port)
		return null;
	var host = st.listen_host || window.location.hostname;
	if (host.indexOf(':') >= 0 && host.charAt(0) !== '[')
		host = '[' + host + ']';
	var scheme = st.tls ? 'https' : 'http';
	var def = (scheme === 'http' && st.listen_port === 80) || (scheme === 'https' && st.listen_port === 443);
	return scheme + '://' + host + (def ? '' : ':' + st.listen_port);
}

function formText(value, placeholder) {
	return E('input', {
		'type': 'text',
		'class': 'cbi-input-text',
		'style': 'width:100%;box-sizing:border-box',
		'value': value == null ? '' : `${value}`,
		'placeholder': placeholder || ''
	});
}

function formNumber(value, min, max) {
	return E('input', {
		'type': 'number',
		'class': 'cbi-input-text',
		'style': 'width:100%;box-sizing:border-box',
		'min': `${min}`,
		'max': `${max}`,
		'value': value == null ? '' : `${value}`
	});
}

function formCheck(checked) {
	var el = E('input', { 'type': 'checkbox' });
	el.checked = !!checked;
	return el;
}

function formSelect(options, value) {
	var el = E('select', { 'class': 'cbi-input-select', 'style': 'width:100%;box-sizing:border-box' },
		options.map(function(opt) { return E('option', { 'value': opt[0] }, opt[1]); }));
	el.value = value || options[0][0];
	return el;
}

function formRow(label, control, help, wide) {
	return E('div', { 'style': wide ? 'grid-column:1/-1' : '' }, [
		E('div', { 'style': 'font-weight:600;font-size:13px;margin-bottom:6px' }, label),
		control,
		help ? E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:6px' }, help) : E('span', {})
	]);
}

function formSection(title, rows) {
	return E('div', {
		'style': 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(127,127,127,.2)'
	}, [
		E('div', { 'style': 'font-weight:600;margin-bottom:10px' }, title),
		E('div', {
			'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px 18px'
		}, rows)
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callStatus(), null),
			L.resolveDefault(callConfig(), null)
		]);
	},

	render: function(data) {
		var self = this;
		this.n = {};
		this.lastStatus = null;
		this.logCount = 100;
		this.cfgDirty = false;
		this.formDirty = false;
		this.settingsDirty = false;
		this.updateInfo = null;
		this.jobTimer = null;
		this.lastJob = null;
		this.cfgMode = 'form';
		this.activeTab = 'main';
		this.hideSecurityNotice = false;
		try {
			var savedMode = window.localStorage.getItem('wolservice.configMode');
			if (savedMode === 'yaml' || savedMode === 'form')
				this.cfgMode = savedMode;
			var savedTab = window.localStorage.getItem('wolservice.activeTab');
			if (savedTab === 'main' || savedTab === 'other')
				this.activeTab = savedTab;
			this.hideSecurityNotice = window.localStorage.getItem('wolservice.hideSecurityNotice') === '1';
		} catch (e) {}

		function cell() { return E('span', {}, '—'); }
		var n = this.n;

		/* ---------- 状态卡 ---------- */
		n.pillWrap = E('span', {});
		n.bin = cell();
		n.ver = cell();
		n.cfg = cell();
		n.listen = cell();
		n.cfgPanel = cell();
		n.auth = cell();
		n.probe = cell();
		n.secrets = cell();
		n.arch = cell();
		n.lastError = cell();

		n.btnStart = E('button', { 'class': 'cbi-button cbi-button-action important', 'click': ui.createHandlerFn(this, 'onAction', 'start') }, '启动');
		n.btnRestart = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onAction', 'restart') }, '重启');
		n.btnRefresh = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onRefresh') }, '刷新');
		n.btnProbe = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onProbe') }, '检测面板');
		n.btnPanel = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onOpenPanel') }, '打开控制面板');
		n.btnCfgPanel = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onOpenConfigPanel') }, '打开配置中心');

		var statusCard = card('服务状态', [
			kvGrid([
				[ '二进制', n.bin ],
				[ '版本', n.ver ],
				[ '配置文件', n.cfg ],
				[ '监听', n.listen ],
				[ '配置面板', n.cfgPanel ],
				[ '访问保护', n.auth ],
				[ '面板自检', n.probe ],
				[ '凭据文件', n.secrets ],
				[ '系统架构', n.arch ],
				[ '最近告警/错误', n.lastError ]
			]),
			E('div', { 'style': 'margin-top:14px;display:flex;flex-wrap:wrap;gap:8px' },
				[ n.btnStart, n.btnRestart, n.btnProbe, n.btnPanel, n.btnCfgPanel, n.btnRefresh ])
		], n.pillWrap);

		/* ---------- 安全提示 ---------- */
		n.secText = E('div', { 'style': 'font-size:13px;line-height:1.7' });
		n.secDismiss = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'onDismissSecurity')
		}, '不再提示');
		n.secDismiss.id = 'wol-sec-dismiss';
		n.secCard = card('安全提示', n.secText, n.secDismiss);
		n.secCard.id = 'wol-sec-card';
		n.secCard.style.borderColor = 'rgba(198,40,40,.45)';
		n.secCard.style.background = 'rgba(198,40,40,.05)';

		/* ---------- 二进制 ---------- */
		n.updCur = cell();
		n.updSize = cell();
		n.updTime = cell();
		n.updVer = cell();
		n.relLatest = cell();
		n.relDate = cell();
		n.relAsset = cell();
		n.relSize = cell();
		n.relDigest = cell();
		n.updMsg = E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:10px' }, '');
		n.relMsg = E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:10px' }, '尚未检查更新。');
		n.progBar = E('div', { 'style': 'width:0%' });
		n.progBox = E('div', { 'class': 'cbi-progressbar', 'title': '0%' }, [ n.progBar ]);
		n.progText = E('div', { 'class': 'cbi-value-description' }, '');
		n.progWrap = E('div', { 'style': 'margin-top:12px;display:none' }, [ n.progBox, n.progText ]);

		n.uploadBtn = E('button', {
			'class': 'cbi-button',
			'click': function() { self.n.file.click(); }
		}, '手动上传二进制');
		n.file = E('input', {
			'type': 'file',
			'style': 'display:none',
			'change': ui.createHandlerFn(this, 'onFileSelected')
		});
		n.btnRollback = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onRollback') }, '回滚上一版本');
		n.btnCheck = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onCheckUpdate') }, '检查更新');
		n.btnInstallRel = E('button', {
			'class': 'cbi-button cbi-button-action important',
			'disabled': true,
			'click': ui.createHandlerFn(this, 'onInstallRelease')
		}, '安装此版本');

		n.jobBar = E('div', { 'style': 'width:0%' });
		n.jobBox = E('div', { 'class': 'cbi-progressbar', 'title': '0%' }, [ n.jobBar ]);
		n.jobText = E('div', { 'class': 'cbi-value-description' }, '');
		n.jobWrap = E('div', { 'style': 'margin-top:12px;display:none' }, [ n.jobBox, n.jobText ]);

		var updateCard = card('更新版本', [
			kvGrid([
				[ '当前版本', n.updCur ],
				[ '文件大小', n.updSize ],
				[ '安装时间', n.updTime ],
				[ '可回滚版本', n.updVer ],
				[ '最新版本', n.relLatest ],
				[ '发布时间', n.relDate ],
				[ '更新资产', n.relAsset ],
				[ '资产大小', n.relSize ],
				[ 'SHA256', n.relDigest ]
			]),
			E('div', { 'style': 'margin-top:14px;display:flex;flex-wrap:wrap;gap:8px' },
				[ n.btnCheck, n.btnInstallRel, n.uploadBtn, n.btnRollback, n.file ]),
			n.relMsg,
			n.jobWrap,
			n.updMsg,
			n.progWrap,
			E('p', { 'class': 'cbi-value-description', 'style': 'margin:10px 0 0' },
				'来源 GitHub inxen/wolservice；安装前校验资产大小与 SHA256，未提供摘要时只能手动上传。' +
				'手动上传会校验 ELF 并执行 -version 实测，失败自动回滚。')
		]);

		/* ---------- 配置参数：LuCI 表单 / YAML ---------- */
		n.f = {};
		n.f.port = formNumber(8090, 1, 65535);
		n.f.host = formText('', '留空 = 所有地址');
		n.f.title = formText('', '网络唤醒');
		n.f.tlsCert = formText('', '/etc/wol/server.crt');
		n.f.tlsKey = formText('', '/etc/wol/server.key');
		n.f.readTimeout = formText('15s');
		n.f.shutdownTimeout = formText('15s');
		n.f.panel = formCheck(false);
		n.f.authQuickPanel = formCheck(false);
		n.f.authConfigPanel = formCheck(true);
		n.f.authTrustEnabled = formCheck(false);
		n.f.authNetworks = E('textarea', {
			'class': 'cbi-input-text',
			'style': 'width:100%;min-height:90px;box-sizing:border-box;padding:8px;font-family:monospace;font-size:12px',
			'placeholder': '192.168.10.0/24\n192.168.1.0/24',
			'spellcheck': 'false'
		}, '');
		n.f.level = formSelect([ [ 'debug', 'debug' ], [ 'info', 'info' ], [ 'warn', 'warn' ], [ 'error', 'error' ] ], 'info');
		n.f.format = formSelect([ [ 'text', 'text' ], [ 'json', 'json' ] ], 'text');
		n.f.probeInterval = formText('15s');
		n.f.probeTimeout = formText('2s');
		n.f.port.id = 'wol-f-port';
		n.f.host.id = 'wol-f-host';
		n.f.title.id = 'wol-f-title';
		n.f.tlsCert.id = 'wol-f-tlscert';
		n.f.tlsKey.id = 'wol-f-tlskey';
		n.f.readTimeout.id = 'wol-f-readtimeout';
		n.f.shutdownTimeout.id = 'wol-f-shutdowntimeout';
		n.f.panel.id = 'wol-f-panel';
		n.f.authQuickPanel.id = 'wol-f-auth-quick';
		n.f.authConfigPanel.id = 'wol-f-auth-config';
		n.f.authTrustEnabled.id = 'wol-f-auth-trust';
		n.f.authNetworks.id = 'wol-f-auth-networks';
		n.f.level.id = 'wol-f-loglevel';
		n.f.format.id = 'wol-f-logformat';
		n.f.probeInterval.id = 'wol-f-probeinterval';
		n.f.probeTimeout.id = 'wol-f-probetimeout';
		[
			n.f.port, n.f.host, n.f.title, n.f.tlsCert, n.f.tlsKey,
			n.f.readTimeout, n.f.shutdownTimeout, n.f.panel,
			n.f.authQuickPanel, n.f.authConfigPanel,
			n.f.authTrustEnabled, n.f.authNetworks,
			n.f.level, n.f.format, n.f.probeInterval, n.f.probeTimeout
		].forEach(function(node) {
			node.addEventListener('input', function() { self.formDirty = true; });
			node.addEventListener('change', function() { self.formDirty = true; });
		});
		n.f.panel.addEventListener('change', function() { self.updateAuthScope(); });
		n.f.authTrustEnabled.addEventListener('change', function() { self.updateAuthScope(); });
		n.f.authQuickPanel.addEventListener('change', function() { self.updateAuthScope(); });

		n.formMeta = E('div', { 'class': 'cbi-value-description', 'style': 'margin:0 0 8px' }, '');
		n.formMsg = E('div', { 'style': 'margin-top:10px;font-size:13px;line-height:1.6;white-space:pre-wrap' }, '');
		n.formMsg.id = 'wol-form-msg';
		n.btnFormReload = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onFormReload') }, '重新载入');
		n.btnFormSave = E('button', { 'class': 'cbi-button cbi-button-action important', 'click': ui.createHandlerFn(this, 'onFormSave', false) }, '保存配置');
		n.btnFormRestart = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onFormSave', true) }, '保存并重启');
		n.btnFormSave.id = 'wol-form-save';
		n.btnFormRestart.id = 'wol-form-restart';

		n.formPanel = E('div', { 'id': 'wol-form-panel' }, [
			n.formMeta,
			formSection('服务端', [
				formRow('监听端口', n.f.port, '1-65535；留空绑定地址时监听所有网卡'),
				formRow('绑定地址', n.f.host, '可选，如 192.168.1.10 或 IPv6；留空 = 所有地址'),
				formRow('面板标题', n.f.title, '写入浏览器标题和页面标题'),
				formRow('TLS 证书路径', n.f.tlsCert, '与私钥成对配置；修改后需要重启'),
				formRow('TLS 私钥路径', n.f.tlsKey, '与证书成对配置；修改后需要重启'),
				formRow('读取超时', n.f.readTimeout, 'Go duration，如 15s、1m30s；修改后需要重启'),
				formRow('优雅关闭超时', n.f.shutdownTimeout, '收到退出信号后等待连接关闭；修改后需要重启')
			]),
			formSection('配置中心', [
				formRow('启用配置中心（/config）', n.f.panel,
					'关闭后 /config 与 /api/config* 返回 404。密码/会话在 /config 设置；本表单不会写入凭据。')
			]),
			formSection('信任凭据', [
				formRow('快速面板 / API', n.f.authQuickPanel,
					'启用后访问 / 和 /api/devices、/api/reload 等接口需要密码；关闭则快速面板和 API 都不校验。'),
				n.f.authConfigPanelRow = formRow('配置面板', n.f.authConfigPanel,
					'启用后 /config 与 /api/config* 需要访问密码；仅在配置中心启用时生效。'),
				formRow('启用可信网段', n.f.authTrustEnabled,
					'启用后仅下列地址可访问服务（包括登录页）；关闭则允许所有来源。', true),
				formRow('可信网段 / 地址', n.f.authNetworks,
					'每行一个 IPv4/IPv6 地址或 CIDR，例如 192.168.10.0/24；保存前会用 wol -check 校验。', true),
				n.f.authPasswordNote = E('div', {
					'class': 'cbi-value-description',
					'style': 'grid-column:1/-1;margin-top:2px;line-height:1.6'
				}, '')
			]),
			formSection('日志与探测', [
				formRow('日志级别', n.f.level, 'debug/info/warn/error；修改后需要重启'),
				formRow('日志格式', n.f.format, 'text/json；修改后需要重启'),
				formRow('探测间隔', n.f.probeInterval, '全局默认；设备可在 YAML 中覆盖'),
				formRow('探测超时', n.f.probeTimeout, '单个目标探测超时')
			]),
			E('div', { 'style': 'margin-top:14px;display:flex;flex-wrap:wrap;gap:8px' },
				[ n.btnFormReload, n.btnFormSave, n.btnFormRestart ]),
			n.formMsg,
			E('p', { 'class': 'cbi-value-description', 'style': 'margin:10px 0 0' },
				'设备列表、SSH/MQTT 凭据不在本表单中显示或覆盖；请在服务自带 /config 编辑，或切换到 YAML 原文。' +
				'保存会重写 server/config_panel/log/probe/auth 段（注释会丢失），devices 段原样保留；' +
				'监听/TLS/超时/日志级别变更需要重启，其余约 2 秒热重载。' +
				'访问密码保存在加密凭据文件，不在本表单中显示或修改。')
		]);

		n.cfgMeta = E('div', { 'class': 'cbi-value-description', 'style': 'margin:0 0 8px' }, '');
		n.cfgMsg = E('div', { 'style': 'margin-top:10px;font-size:13px;line-height:1.6;white-space:pre-wrap' }, '');
		n.cfgEditor = E('textarea', {
			'style': 'width:100%;height:380px;box-sizing:border-box;padding:10px;font-family:monospace;' +
				'font-size:12px;line-height:1.5;white-space:pre;overflow:auto;border:1px solid rgba(127,127,127,.35);' +
				'border-radius:4px;background:rgba(127,127,127,.04);resize:vertical',
			'spellcheck': 'false',
			'input': function() { self.cfgDirty = true; }
		}, '');
		n.btnCfgReload = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onConfigReload') }, '重新载入');
		n.btnCfgSave = E('button', { 'class': 'cbi-button cbi-button-action important', 'click': ui.createHandlerFn(this, 'onConfigSave', false) }, '校验并保存');
		n.btnCfgRestart = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onConfigSave', true) }, '保存并重启');
		n.yamlPanel = E('div', { 'id': 'wol-yaml-panel' }, [
			n.cfgMeta,
			n.cfgEditor,
			E('div', { 'style': 'margin-top:10px;display:flex;flex-wrap:wrap;gap:8px' },
				[ n.btnCfgReload, n.btnCfgSave, n.btnCfgRestart ]),
			n.cfgMsg,
			E('p', { 'class': 'cbi-value-description', 'style': 'margin:10px 0 0' },
				'直接编辑完整 YAML；保存前用 wol -check 校验；监听/TLS/超时/日志级别变更需要重启。' +
				'设备与 SSH/MQTT 凭据建议在服务自带 /config 中维护。')
		]);

		n.modeFormBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'onConfigMode', 'form')
		}, 'LuCI 表单');
		n.modeYamlBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'onConfigMode', 'yaml')
		}, 'YAML 原文');
		n.modeFormBtn.id = 'wol-mode-form';
		n.modeYamlBtn.id = 'wol-mode-yaml';
		var modeBar = E('div', {
			'style': 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px'
		}, [
			E('span', { 'style': 'font-weight:600' }, '配置方式'),
			n.modeFormBtn,
			n.modeYamlBtn,
			E('span', { 'class': 'cbi-value-description' }, '两种方式编辑同一份 YAML，切换前会提示未保存修改。')
		]);

		var cfgCard = card('配置参数', [
			modeBar,
			n.formPanel,
			n.yamlPanel
		]);

		/* ---------- 日志 ---------- */
		n.logMeta = E('div', { 'class': 'cbi-value-description', 'style': 'margin:0 0 8px' }, '');
		n.log = E('pre', {
			'style': 'max-height:320px;overflow:auto;font-size:12px;line-height:1.45;white-space:pre-wrap;' +
				'word-break:break-all;margin:0;padding:10px;background:rgba(127,127,127,.07);border-radius:4px'
		}, '加载中…');
		n.logSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '100' }, '最近 100 行'),
			E('option', { 'value': '200' }, '最近 200 行'),
			E('option', { 'value': '500' }, '最近 500 行')
		]);

		var logCard = card('日志', [
			n.logMeta,
			n.log,
			E('div', { 'style': 'margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center' }, [
				n.logSel,
				E('button', {
					'class': 'cbi-button',
					'click': function() { self.logCount = +self.n.logSel.value; self.refreshLog(self.logCount); }
				}, '刷新日志')
			])
		]);

		/* ---------- 其他设置 ---------- */
		n.en = E('input', { 'type': 'checkbox' });
		n.cp = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%;max-width:520px' });
		n.lmax = E('input', { 'type': 'number', 'min': '32', 'max': '8192', 'class': 'cbi-input-text', 'style': 'width:120px' });
		[ n.en, n.cp, n.lmax ].forEach(function(node) {
			node.addEventListener('input', function() { self.settingsDirty = true; });
			node.addEventListener('change', function() { self.settingsDirty = true; });
		});
		n.secRestore = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'onRestoreSecurity')
		}, '恢复安全提示');
		n.secRestore.id = 'wol-sec-restore';

		var settingsCard = card('服务设置', [
			E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px' }, [
				E('div', {}, [
					E('label', { 'style': 'display:flex;align-items:center;gap:8px;font-weight:600' }, [ n.en, '启用服务（开机自启并保持运行）' ]),
					E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:6px' },
						'关闭会立即停止进程并取消开机自启；开启会在保存后立即启动。')
				]),
				E('div', {}, [
					E('div', { 'style': 'font-weight:600;margin-bottom:6px' }, '日志上限（KB）'),
					n.lmax,
					E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:6px' },
						'写入 /tmp/log（内存 tmpfs），超过上限自动裁掉前半部分。')
				]),
				E('div', {}, [
					E('div', { 'style': 'font-weight:600;margin-bottom:6px' }, 'YAML 配置路径'),
					n.cp,
					E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:6px' },
						'修改路径不会移动现有文件；服务会使用新路径，配置不存在时自动生成默认配置。')
				])
			]),
			E('p', { 'class': 'cbi-value-description', 'style': 'margin:12px 0 0' },
				'配置中心开关、监听地址、日志级别等 WOL 配置参数已移到「服务状态与配置」页的「配置参数」中。'),
			E('div', { 'style': 'margin-top:14px' },
				E('button', { 'class': 'cbi-button cbi-button-action important', 'click': ui.createHandlerFn(this, 'onSettings') }, '保存设置')),
			E('div', { 'style': 'margin-top:18px;padding-top:14px;border-top:1px solid rgba(127,127,127,.2)' }, [
				E('div', { 'style': 'font-weight:600;margin-bottom:8px' }, '界面'),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:12px;align-items:center' }, [
					n.secRestore,
					E('span', { 'class': 'cbi-value-description' }, '点击后重新显示「服务状态与配置」页的安全提示。')
				])
			])
		]);

		n.tabMain = E('div', { 'id': 'wol-tab-content-main' }, [ statusCard, n.secCard, cfgCard ]);
		n.tabOther = E('div', { 'id': 'wol-tab-content-other', 'style': 'display:none' }, [
			updateCard,
			logCard,
			settingsCard,
			E('p', { 'class': 'cbi-value-description', 'style': 'margin:4px 0 24px' },
				'日志文件 /tmp/log/wolservice.log 位于内存文件系统，重启后清空；访问密码、SSH/MQTT 凭据保存在加密凭据文件中，不会在此页面显示。')
		]);
		n.mainTabBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'onTab', 'main')
		}, '服务状态与配置');
		n.otherTabBtn = E('button', {
			'class': 'cbi-button',
			'click': ui.createHandlerFn(this, 'onTab', 'other')
		}, '更新与其他设置');
		n.mainTabBtn.id = 'wol-tab-main';
		n.otherTabBtn.id = 'wol-tab-other';
		var tabBar = E('div', {
			'style': 'display:flex;gap:4px;border-bottom:1px solid rgba(127,127,127,.25);margin-bottom:16px'
		}, [ n.mainTabBtn, n.otherTabBtn ]);

		var root = E('div', {}, [
			/* 登录模板里隐藏的 cbi-map 会在页面底部生成一套与本页无关的保存/复位按钮。 */
			E('style', {}, 'body[data-page="admin-services-wolservice"] .cbi-page-actions { display:none !important; }'),
			E('h2', {}, 'WOL 网络唤醒'),
			E('div', { 'class': 'cbi-map-descr', 'style': 'margin-bottom:12px' },
				'服务进程、配置、版本更新和日志都在这里。配置参数可以用表单或 YAML 改；设备和凭据在 WOL 自带的 /config 里维护。'),
			tabBar,
			n.tabMain,
			n.tabOther
		]);

		this.applyStatus(data[0]);
		this.applyConfig(data[1]);
		this.applyConfigMode();
		this.applyTab();
		this.loadForm();
		this.refreshLog(100);
		this.resumeJob();

		window.setInterval(function() { self.refresh(); }, 10000);

		return root;
	},

	applyStatus: function(st) {
		var n = this.n;
		if (!st || st.ok === false) {
			if (n) {
				var unknown = pill('状态未知', false);
				if (n.pillWrap.parentNode)
					n.pillWrap.parentNode.replaceChild(unknown, n.pillWrap);
				n.pillWrap = unknown;
				n.secCard.style.display = 'none';
			}
			return;
		}
		this.lastStatus = st;

		var newPill;
		if (st.running)
			newPill = pill('运行中' + (st.pid ? '（PID ' + st.pid + '）' : ''), true);
		else if (st.enabled)
			newPill = pill('已启用，但未运行', false);
		else
			newPill = pill('已停止', false);
		if (n.pillWrap.parentNode)
			n.pillWrap.parentNode.replaceChild(newPill, n.pillWrap);
		n.pillWrap = newPill;

		n.bin.textContent = st.binary_exists
			? '已安装 · ' + fmtSize(st.binary_size)
			: '未安装（请先上传）';
		n.bin.style.color = st.binary_exists ? '' : '#c62828';

		n.ver.textContent = st.binary_version || (st.binary_exists ? (st.binary_error || '无法读取') : '—');
		n.ver.style.color = st.binary_exists && !st.binary_version ? '#c62828' : '';

		if (st.config_exists)
			n.cfg.textContent = st.config_path + ' · ' + (st.config_ok ? ((st.config_devices ?? 0) + ' 台设备') : '校验失败');
		else
			n.cfg.textContent = st.config_path + ' · 不存在';
		n.cfg.style.color = st.config_ok ? '' : '#c62828';

		n.listen.textContent = st.listen
			? st.listen + (st.tls ? '（HTTPS）' : '（HTTP）')
			: '—';

		if (!st.panel_enabled) {
			n.cfgPanel.textContent = '未启用';
			n.cfgPanel.style.color = '';
		}
		else if (st.config_panel_password_set === true) {
			n.cfgPanel.textContent = '已启用 · 密码已设置';
			n.cfgPanel.style.color = '#2e7d32';
		}
		else if (st.config_panel_password_set === false) {
			n.cfgPanel.textContent = '已启用 · 密码未设置';
			n.cfgPanel.style.color = '#c62828';
		}
		else {
			n.cfgPanel.textContent = '已启用 · 密码状态未知';
			n.cfgPanel.style.color = '';
		}

		var ai = (st.panel_probe && st.panel_probe.info && st.panel_probe.info.auth) || null;
		this.authInfo = ai;
		if (!ai) {
			n.auth.textContent = '—';
			n.auth.style.color = '';
		}
		else {
			var scopes = [];
			if (ai.quick_required)
				scopes.push('快速面板 / API');
			if (ai.config_required)
				scopes.push('配置面板');
			var authText = scopes.length ? ('密码：' + scopes.join(' / ')) : '密码保护未启用';
			if (!ai.password_set)
				authText += ' · 未设置密码';
			authText += ai.trusted_networks_enabled
				? (' · 可信网段 ' + (ai.trusted_networks_count || 0) + ' 项')
				: ' · 信任所有地址';
			n.auth.textContent = authText;
			n.auth.style.color = (!ai.password_set && scopes.length) ? '#c62828' : '';
		}

		if (!st.running) {
			n.probe.textContent = '服务未运行，未探测';
			n.probe.style.color = '';
		}
		else if (!st.config_ok) {
			n.probe.textContent = '配置无效，未探测';
			n.probe.style.color = '#c62828';
		}
		else if (st.panel_probe && st.panel_probe.ok) {
			var info = st.panel_probe.info || {};
			n.probe.textContent = '正常 · ' + (info.title || st.title || 'WOL') +
				' · 已运行 ' + fmtUptime(info.uptime_seconds ?? st.uptime_seconds) +
				(info.version ? ' · v' + String(info.version).replace(/^v/, '') : '');
			n.probe.style.color = '#2e7d32';
		}
		else {
			n.probe.textContent = '不可达：' + ((st.panel_probe && st.panel_probe.error) || '未知错误');
			n.probe.style.color = '#c62828';
		}

		var secretsText = st.secrets_exists ? '已生成' : '未生成（尚无凭据）';
		var keyText;
		if (st.key_source === 'embedded')
			keyText = '内嵌（二进制）';
		else if (st.key_source === 'env')
			keyText = '环境变量';
		else if (st.key_source === 'file')
			keyText = '磁盘文件';
		else if (st.key_source === 'none')
			keyText = '未配置';
		else if (st.secrets_key_exists)
			keyText = '磁盘文件（未运行，未确认）';
		else
			keyText = '运行服务后确认';
		n.secrets.textContent = secretsText + ' · 主密钥：' + keyText;
		/* 磁盘密钥是受支持的降级模式，只在安全提示里说明一次，这里不标红 */
		n.secrets.style.color = (st.key_source === 'none' && st.secrets_exists) ? '#c62828' : '';

		n.arch.textContent = st.system_arch || '—';
		var lastErr = st.last_error || st.config_error;
		n.lastError.textContent = lastErr ? fmtLogLine(lastErr) : '无';
		n.lastError.style.color = !lastErr ? '' : (String(lastErr).indexOf('level=WARN') >= 0 ? '#b26a00' : '#c62828');

		n.btnStart.style.display = st.running ? 'none' : '';
		n.btnRestart.style.display = st.running ? '' : 'none';
		n.btnPanel.disabled = !st.listen_port;
		n.btnCfgPanel.disabled = !st.listen_port || !st.panel_enabled;

		if (!this.settingsDirty) {
			n.en.checked = !!st.enabled;
			n.cp.value = st.config_path || '';
			n.lmax.value = st.log_max_size || 256;
		}

		n.updCur.textContent = st.binary_exists ? (st.binary_version || '未知') : '未安装';
		n.updSize.textContent = st.binary_exists ? fmtSize(st.binary_size) : '—';
		n.updTime.textContent = fmtTime(st.binary_mtime);
		n.updVer.textContent = st.can_rollback ? (st.rollback_version || '已备份') : '无';
		n.btnRollback.disabled = !st.can_rollback;

		var warnings = [];
		if (!st.config_exists)
			warnings.push('配置文件不存在；启动服务时会自动生成默认配置。');
		else if (!st.config_ok)
			warnings.push('当前配置校验失败：' + (st.config_error || '详见日志') + ' 服务可能无法启动或仍在运行旧配置。');
		if (st.panel_enabled) {
			if (st.config_panel_password_set === false)
				warnings.push('配置中心 /config 已启用但没设密码：能访问这个端口的人都能改配置。请先在 /config 里设置访问密码。');
			else if (st.config_panel_password_set == null)
				warnings.push('服务自带配置中心 /config 已启用，但暂时无法确认是否设置了密码；请确认后使用。');
		}
		else if (st.config_exists) {
			warnings.push('配置中心没启用；配置可以用本页或 SSH 改。');
		}
		if (ai) {
			var wanted = [];
			if (ai.quick_panel)
				wanted.push('快速面板 / API');
			if (st.panel_enabled && ai.config_panel)
				wanted.push('配置面板');
			if (!ai.password_set && wanted.length) {
				warnings.push('已启用 ' + wanted.join(' / ') + ' 的密码保护，但尚未设置访问密码，这些开关目前不生效；' +
					'请打开 /config →「信任凭据」设置密码。');
			}
			else if (ai.password_set && !wanted.length) {
				warnings.push('已设置访问密码，但快速面板/API、配置面板的密码保护均未启用；任何能访问该端口的人都可以操作。');
			}
			if (ai.trusted_networks_enabled)
				warnings.push('可信网段已启用：仅列表内地址可访问服务；修改前请确认当前管理地址仍在列表内，避免把自己锁在外面。');
		}
		if (st.config_legacy_secrets)
			warnings.push('主配置文件中检测到明文凭据；启动服务一次会自动迁移到加密凭据文件，迁移后请删除旧备份。');
		if (st.key_source === 'file')
			warnings.push('主密钥保存在磁盘密钥文件中，root 可直接读取；建议改用内嵌主密钥的构建。');
		else if (st.key_source === 'none' && st.secrets_exists)
			warnings.push('检测到凭据文件，但未找到可用主密钥；服务可能无法解密凭据。');
		if (st.legacy_key_file === true && st.key_source !== 'file')
			warnings.push('检测到旧磁盘密钥文件；如果凭据仍用它加密，启动服务后会自动迁移到当前主密钥并把文件改名为 .legacy，确认无需回滚后可删除。');
		if (st.listen_host === '127.0.0.1' || st.listen_host === '::1')
			warnings.push('当前仅监听回环地址，其他设备无法访问 WOL 控制面板。');
		if (st.upload_pending)
			warnings.push('检测到未完成的上传缓存；重新上传会自动覆盖，或点击「上传新二进制」重新开始。');

		n.secText.textContent = warnings.join(' ');
		n.secCard.style.display = (warnings.length && !this.hideSecurityNotice) ? '' : 'none';
		this.updateAuthScope();
	},

	applyConfig: function(cfg) {
		var n = this.n;
		if (!n)
			return;
		if (!cfg || cfg.ok === false) {
			n.cfgMeta.textContent = (cfg && cfg.error) || '读取配置失败';
			n.cfgMeta.style.color = '#c62828';
			return;
		}
		n.cfgMeta.style.color = '';
		if (!cfg.exists) {
			n.cfgEditor.value = '';
			n.cfgMeta.textContent = '配置文件 ' + cfg.path + ' 不存在；启动服务会自动生成默认配置，也可以在上方编辑后保存。';
			n.cfgMsg.textContent = '';
			this.cfgDirty = false;
			return;
		}
		n.cfgEditor.value = cfg.content || '';
		n.cfgMeta.textContent = cfg.path + ' · ' + fmtSize(cfg.size) + ' · 修改于 ' + fmtTime(cfg.mtime) +
			(cfg.legacy_secrets ? ' · 检测到明文凭据' : '');
		n.cfgMeta.style.color = cfg.legacy_secrets ? '#c62828' : '';
		n.cfgMsg.textContent = '';
		this.cfgDirty = false;
	},

	refresh: function() {
		var self = this;
		return L.resolveDefault(callStatus(), null).then(function(st) {
			self.applyStatus(st);
		}).catch(function() {});
	},

	onRefresh: function() {
		var self = this;
		return this.refresh().then(function() { return self.refreshLog(self.logCount); });
	},

	onProbe: function() {
		var self = this;
		this.n.probe.textContent = '检测中…';
		this.n.probe.style.color = '';
		return callProbe().then(function(r) {
			if (r && r.ok) {
				var info = r.info || {};
				self.n.probe.textContent = '正常 · ' + (info.title || 'WOL') +
					' · 已运行 ' + fmtUptime(info.uptime_seconds) +
					(info.version ? ' · v' + String(info.version).replace(/^v/, '') : '');
				self.n.probe.style.color = '#2e7d32';
			}
			else {
				self.n.probe.textContent = '不可达：' + ((r && r.error) || '未知错误');
				self.n.probe.style.color = '#c62828';
			}
		}).catch(function(e) {
			self.n.probe.textContent = '检测失败：' + (e.message || e);
			self.n.probe.style.color = '#c62828';
		});
	},

	refreshLog: function(count) {
		var self = this;
		return L.resolveDefault(callLog(count || this.logCount || 100), null).then(function(r) {
			if (!self.n)
				return;
			var lines = (r && r.lines) ? r.lines : [];
			self.n.log.textContent = lines.length ? lines.map(fmtLogLine).join('\n') : '（暂无日志）';
			var st = self.lastStatus;
			self.n.logMeta.textContent = '最近 ' + (count || 100) + ' 行 · /tmp/log/wolservice.log' +
				(st && st.log_file_size ? ' · ' + fmtSize(st.log_file_size) + ' / ' + (st.log_max_size || 256) + ' KB' : '') +
				(st && st.last_error ? ' · 最近告警：' + fmtLogLine(st.last_error) : '');
		}).catch(function(e) {
			if (self.n)
				self.n.log.textContent = '读取日志失败：' + (e.message || e);
		});
	},

	onAction: function(action) {
		var self = this;
		var run = function() {
			return callAction(action).then(function(r) {
				ensureOk(r);
				ui.addNotification(null, E('p', {}, '操作成功：' + action), 'info');
				return self.refresh().then(function() { return self.refreshLog(self.logCount); });
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, '操作失败：' + (e.message || e)), 'danger');
				self.refresh();
			});
		};
		if (action === 'restart')
			confirmAction('确认重启', '确定要重启 WOL 服务吗？', run);
		else
			run();
	},

	onOpenPanel: function() {
		var base = panelBase(this.lastStatus);
		if (base)
			window.open(base + '/', '_blank');
	},

	onOpenConfigPanel: function() {
		var base = panelBase(this.lastStatus);
		if (base)
			window.open(base + '/config', '_blank');
	},

	onFileSelected: function(ev) {
		var self = this;
		var file = ev.target.files[0];
		ev.target.value = '';
		if (!file)
			return;
		if (file.size < 1024 * 1024) {
			ui.addNotification(null, E('p', {}, '文件过小，至少 1MB'), 'danger');
			return;
		}
		if (file.size > 128 * 1024 * 1024) {
			ui.addNotification(null, E('p', {}, '文件过大，上限 128MB'), 'danger');
			return;
		}
		confirmAction('确认安装', '将上传 ' + file.name + '（' + fmtSize(file.size) + '）并替换 /usr/bin/wol。安装后服务会重启，继续？', function() {
			self.n.uploadBtn.disabled = true;
			self.n.updMsg.textContent = '准备上传…';
			self.n.updMsg.style.color = '';
			self.n.progWrap.style.display = '';
			self.updateProgress(0, '准备上传…');

			callBegin(file.size).then(ensureOk).then(function() {
				var seq = 0;
				function step() {
					if (seq * CHUNK >= file.size)
						return callEnd().then(ensureOk).then(function(r) {
							self.n.updMsg.textContent = '安装完成：' + (r.version || '未知版本');
							self.n.updMsg.style.color = '#2e7d32';
							self.n.uploadBtn.disabled = false;
							self.updateProgress(100, '安装完成');
							ui.addNotification(null, E('p', {}, '二进制安装完成：' + (r.version || '未知版本')), 'info');
							self.refresh().then(function() { return self.refreshLog(self.logCount); });
							self.loadConfig();
						});
					var start = seq * CHUNK, end = Math.min(file.size, start + CHUNK);
					return file.slice(start, end).arrayBuffer().then(function(buf) {
						return callChunk(seq, bufToB64(buf)).then(ensureOk);
					}).then(function() {
						var pct = Math.min(99, Math.round(end * 100 / file.size));
						self.updateProgress(pct, '上传中… ' + fmtSize(end) + ' / ' + fmtSize(file.size));
						seq++;
						return step();
					});
				}
				return step();
			}).catch(function(e) {
				callAbort().catch(function() {});
				self.n.uploadBtn.disabled = false;
				self.n.updMsg.textContent = '上传失败：' + (e.message || e);
				self.n.updMsg.style.color = '#c62828';
				self.updateProgress(0, '上传失败');
				ui.addNotification(null, E('p', {}, '上传失败：' + (e.message || e)), 'danger');
				self.refresh();
			});
		});
	},

	updateProgress: function(pct, text) {
		if (!this.n)
			return;
		this.n.progBox.title = pct + '%';
		this.n.progBar.style.width = pct + '%';
		this.n.progText.textContent = text || '';
	},

	onRollback: function() {
		var self = this;
		confirmAction('确认回滚', '将把 /usr/bin/wol 恢复为上一版本并重启服务。继续？', function() {
			return callRollback().then(function(r) {
				ensureOk(r);
				ui.addNotification(null, E('p', {}, '已回滚：' + (r.version || '上一版本')), 'info');
				self.refresh().then(function() { return self.refreshLog(self.logCount); });
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, '回滚失败：' + (e.message || e)), 'danger');
				self.refresh();
			});
		});
	},

	onCheckUpdate: function() {
		var self = this;
		this.n.btnCheck.disabled = true;
		this.n.btnInstallRel.disabled = true;
		this.n.relMsg.style.color = '';
		this.n.relMsg.textContent = '正在查询 GitHub Releases…';
		return callCheckUpdate().then(function(r) {
			self.updateInfo = r;
			self.n.btnCheck.disabled = false;
			self.n.relLatest.textContent = r.latest || '—';
			self.n.relDate.textContent = fmtDateStr(r.published);
			self.n.relAsset.textContent = r.asset || '—';
			self.n.relSize.textContent = fmtSize(r.size);
			self.n.relDigest.textContent = r.digest ? (r.digest.substr(0, 16) + '…') : '未提供';

			var canInstall = false, msg;
			if (!r.ok) {
				msg = '检查失败：' + (r.error || '未知错误');
			}
			else if (!r.digest) {
				msg = '最新版本未提供 SHA256 摘要，出于安全考虑不支持自动安装，请手动上传。';
			}
			else {
				canInstall = true;
				if (r.has_update === false)
					msg = '已是最新版本（' + (r.installed || '未知') + '），仍可强制重装。';
				else if (r.installed)
					msg = '发现新版本：' + r.installed + ' → ' + r.latest;
				else
					msg = '尚未安装二进制，可安装 ' + r.latest;
			}
			if (self.jobTimer)
				canInstall = false;
			self.n.relMsg.textContent = msg;
			self.n.relMsg.style.color = (!r.ok || !r.digest) ? '#c62828' : (r.has_update ? '#2e7d32' : '');
			self.n.btnInstallRel.disabled = !canInstall;
		}).catch(function(e) {
			self.n.btnCheck.disabled = false;
			self.n.relMsg.textContent = '检查失败：' + (e.message || e);
			self.n.relMsg.style.color = '#c62828';
		});
	},

	onInstallRelease: function() {
		var self = this;
		var r = this.updateInfo;
		if (!r || !r.ok || !r.digest || !r.url || !r.asset)
			return;
		confirmAction('确认安装', '将从 GitHub 下载 ' + r.latest + '（' + fmtSize(r.size) +
			'）并安装到 /usr/bin/wol。安装前校验 SHA256，完成后重启服务。继续？', function() {
			self.n.btnInstallRel.disabled = true;
			self.n.relMsg.style.color = '';
			self.n.relMsg.textContent = '正在启动更新任务…';
			return callStartInstall(r.latest, r.url, r.digest, r.size, r.asset).then(ensureOk).then(function() {
				self.startJobPolling();
			}).catch(function(e) {
				self.n.btnInstallRel.disabled = false;
				self.n.relMsg.textContent = '启动更新失败：' + (e.message || e);
				self.n.relMsg.style.color = '#c62828';
			});
		});
	},

	startJobPolling: function() {
		var self = this;
		if (this.jobTimer)
			return;
		this.n.jobWrap.style.display = '';
		this.n.uploadBtn.disabled = true;
		this.n.btnCheck.disabled = true;
		this.n.btnInstallRel.disabled = true;
		this.jobTimer = window.setInterval(function() {
			callJob().then(function(j) {
				self.lastJob = j;
				self.renderJob(j);
				if (jobIsActive(j))
					return;
				window.clearInterval(self.jobTimer);
				self.jobTimer = null;
				self.n.uploadBtn.disabled = false;
				self.n.btnCheck.disabled = false;
				if (j.phase === 'done') {
					self.n.relMsg.textContent = '安装完成：' + (j.version || '未知版本');
					self.n.relMsg.style.color = '#2e7d32';
					ui.addNotification(null, E('p', {}, '二进制更新完成：' + (j.version || '未知版本')), 'info');
				}
				else if (j.phase === 'error') {
					self.n.relMsg.textContent = j.message || '更新失败';
					self.n.relMsg.style.color = '#c62828';
					ui.addNotification(null, E('p', {}, '二进制更新失败：' + (j.message || '未知错误')), 'danger');
				}
				self.refresh().then(function() { return self.refreshLog(self.logCount); });
			}).catch(function() {});
		}, 1200);
	},

	resumeJob: function() {
		var self = this;
		return L.resolveDefault(callJob(), null).then(function(j) {
			self.lastJob = j;
			if (jobIsActive(j)) {
				self.n.jobWrap.style.display = '';
				self.renderJob(j);
				self.startJobPolling();
			}
		});
	},

	renderJob: function(j) {
		if (!j || !this.n)
			return;
		var pct = 0;
		if (j.total > 0 && j.bytes > 0)
			pct = Math.min(100, Math.round(j.bytes * 100 / j.total));
		if (j.phase === 'verifying' || j.phase === 'installing')
			pct = Math.max(pct, 96);
		if (j.phase === 'done')
			pct = 100;
		this.n.jobBox.title = pct + '%';
		this.n.jobBar.style.width = pct + '%';
		var msg = j.message || j.phase || '';
		if (j.phase === 'downloading' && j.total)
			msg += '（' + fmtSize(j.bytes) + ' / ' + fmtSize(j.total) + '）';
		if (j.phase === 'done' && j.version)
			msg += ' · 当前版本 ' + j.version;
		this.n.jobText.textContent = msg;
		this.n.jobText.style.color = j.phase === 'error' ? '#c62828' : '';
	},

	loadConfig: function() {
		var self = this;
		return L.resolveDefault(callConfig(), null).then(function(cfg) {
			self.applyConfig(cfg);
		});
	},

	onConfigReload: function() {
		var self = this;
		var doIt = function() { return self.loadConfig(); };
		if (this.cfgDirty)
			confirmAction('放弃修改', '当前编辑器有未保存的修改，确定重新载入？', doIt);
		else
			doIt();
	},

	onConfigSave: function(restart) {
		var self = this;
		var text = this.n.cfgEditor.value;
		if (!text || !text.trim()) {
			ui.addNotification(null, E('p', {}, '配置内容不能为空'), 'danger');
			return;
		}
		this.n.btnCfgSave.disabled = true;
		this.n.btnCfgRestart.disabled = true;
		this.n.cfgMsg.style.color = '';
		this.n.cfgMsg.textContent = restart ? '正在校验并重启…' : '正在校验…';

		return callSave(text, !!restart).then(function(r) {
			self.n.btnCfgSave.disabled = false;
			self.n.btnCfgRestart.disabled = false;
			if (r && r.ok === false) {
				var msg = '保存失败：' + (r.error || '未知错误');
				if (r.saved)
					msg = '配置已保存，但服务操作失败：' + (r.error || '未知错误');
				self.n.cfgMsg.textContent = msg + (r.output ? '\n' + r.output : '');
				self.n.cfgMsg.style.color = '#c62828';
				ui.addNotification(null, E('p', {}, msg), 'danger');
				return;
			}
			self.cfgDirty = false;
			var note = r.output || 'configuration OK';
			if (r.needs_restart)
				note += '\n注意：监听/TLS/超时/日志级别等变更需要重启服务后生效。';
			else if (r.restarted)
				note += '\n服务已重启。';
			else if (self.lastStatus && self.lastStatus.running)
				note += '\n服务将在约 2 秒内热重载。';
			self.n.cfgMsg.textContent = note;
			self.n.cfgMsg.style.color = r.needs_restart ? '#b26a00' : '#2e7d32';
			ui.addNotification(null, E('p', {}, '配置已保存'), 'info');
			self.loadForm();
			window.setTimeout(function() { self.refresh(); self.refreshLog(self.logCount); }, 2500);
		}).catch(function(e) {
			self.n.btnCfgSave.disabled = false;
			self.n.btnCfgRestart.disabled = false;
			self.n.cfgMsg.textContent = '保存失败：' + (e.message || e);
			self.n.cfgMsg.style.color = '#c62828';
			ui.addNotification(null, E('p', {}, '保存失败：' + (e.message || e)), 'danger');
		});
	},

	applyTab: function() {
		var n = this.n;
		var main = this.activeTab !== 'other';
		n.tabMain.style.display = main ? '' : 'none';
		n.tabOther.style.display = main ? 'none' : '';
		n.mainTabBtn.style.borderBottom = main ? '2px solid #2e7d32' : '2px solid transparent';
		n.mainTabBtn.style.background = main ? 'rgba(46,125,50,.08)' : '';
		n.mainTabBtn.style.fontWeight = main ? '600' : '';
		n.otherTabBtn.style.borderBottom = main ? '2px solid transparent' : '2px solid #2e7d32';
		n.otherTabBtn.style.background = main ? '' : 'rgba(46,125,50,.08)';
		n.otherTabBtn.style.fontWeight = main ? '' : '600';
	},

	onTab: function(tab) {
		if (tab !== 'main' && tab !== 'other')
			return;
		this.activeTab = tab;
		try { window.localStorage.setItem('wolservice.activeTab', tab); } catch (e) {}
		this.applyTab();
	},

	applyConfigMode: function() {
		var n = this.n;
		var form = this.cfgMode !== 'yaml';
		n.formPanel.style.display = form ? '' : 'none';
		n.yamlPanel.style.display = form ? 'none' : '';
		n.modeFormBtn.style.background = form ? 'rgba(46,125,50,.12)' : '';
		n.modeFormBtn.style.borderColor = form ? '#2e7d32' : '';
		n.modeFormBtn.style.fontWeight = form ? '600' : '';
		n.modeYamlBtn.style.background = form ? '' : 'rgba(46,125,50,.12)';
		n.modeYamlBtn.style.borderColor = form ? '' : '#2e7d32';
		n.modeYamlBtn.style.fontWeight = form ? '' : '600';
	},

	onConfigMode: function(mode) {
		if (mode !== 'form' && mode !== 'yaml')
			return;
		if (mode === this.cfgMode)
			return;
		var self = this;
		var apply = function() {
			self.cfgMode = mode;
			try { window.localStorage.setItem('wolservice.configMode', mode); } catch (e) {}
			self.applyConfigMode();
			if (mode === 'form') {
				self.n.formMsg.textContent = '';
				self.n.formMsg.style.color = '';
				self.loadForm();
			}
			else {
				self.n.cfgMsg.textContent = '';
				self.n.cfgMsg.style.color = '';
				self.loadConfig();
			}
		};
		var dirty = (this.cfgMode === 'form' && this.formDirty) || (this.cfgMode === 'yaml' && this.cfgDirty);
		if (dirty)
			confirmAction('切换配置方式', '当前方式有未保存的修改，切换会丢弃这些修改。继续？', apply);
		else
			apply();
	},

	loadForm: function() {
		var self = this;
		return L.resolveDefault(callConfigForm(), null).then(function(r) {
			if (!self.n)
				return;
			if (!r || r.ok === false) {
				self.n.formMeta.textContent = (r && r.error) || '读取配置表单失败';
				self.n.formMeta.style.color = '#c62828';
				return;
			}
			self.formInfo = r;
			self.applyForm(r);
		}).catch(function(e) {
			if (self.n) {
				self.n.formMeta.textContent = '读取配置表单失败：' + (e.message || e);
				self.n.formMeta.style.color = '#c62828';
			}
		});
	},

	updateAuthScope: function() {
		var n = this.n;
		if (!n || !n.f)
			return;
		var cp = !!n.f.panel.checked;
		if (n.f.authConfigPanelRow)
			n.f.authConfigPanelRow.style.display = cp ? '' : 'none';
		var trust = !!n.f.authTrustEnabled.checked;
		n.f.authNetworks.disabled = !trust;
		n.f.authNetworks.style.opacity = trust ? '' : '.55';
		var scopes = !!n.f.authQuickPanel.checked || (cp && !!n.f.authConfigPanel.checked);
		var set = this.lastStatus ? this.lastStatus.config_panel_password_set : null;
		if (!n.f.authPasswordNote)
			return;
		if (set === false && scopes) {
			n.f.authPasswordNote.textContent = '尚未设置访问密码：以上开关暂时不生效。请先打开 /config →「信任凭据」设置访问密码。';
			n.f.authPasswordNote.style.color = '#c62828';
		}
		else {
			n.f.authPasswordNote.textContent = '快速面板/API、配置面板共用一个访问密码；密码在服务自带面板的「信任凭据」中设置，' +
				'不会写入 YAML，也不会在此表单显示。未设置密码时以上开关不生效。';
			n.f.authPasswordNote.style.color = '';
		}
	},

	applyForm: function(r) {
		var n = this.n, v = r.values || {};
		n.f.port.value = v.listen_port == null ? 8090 : v.listen_port;
		n.f.host.value = v.listen_host || '';
		n.f.title.value = v.title || '';
		n.f.tlsCert.value = v.tls_cert || '';
		n.f.tlsKey.value = v.tls_key || '';
		n.f.readTimeout.value = v.read_timeout || '15s';
		n.f.shutdownTimeout.value = v.shutdown_timeout || '15s';
		n.f.panel.checked = !!v.config_panel_enabled;
		n.f.authQuickPanel.checked = !!v.auth_quick_panel;
		n.f.authConfigPanel.checked = v.auth_config_panel !== false;
		n.f.authTrustEnabled.checked = !!v.auth_trusted_enabled;
		n.f.authNetworks.value = v.auth_trusted_networks || '';
		n.f.level.value = v.log_level || 'info';
		n.f.format.value = v.log_format || 'text';
		n.f.probeInterval.value = v.probe_interval || '15s';
		n.f.probeTimeout.value = v.probe_timeout || '2s';

		var notes = [];
		notes.push(r.path + ' · ' + (r.exists ? '已载入' : '不存在，保存时创建'));
		if (r.exists)
			notes.push(r.config_ok ? '校验通过' : ('校验失败：' + (r.config_error || '未知')));
		notes.push((r.devices_count ?? 0) + ' 台设备');
		if (!v.listen_valid)
			notes.push('当前 listen 无法解析，请修正端口/绑定地址');
		if (r.legacy_secrets)
			notes.push('主配置含明文凭据，表单保存已禁用；请先用 /config 或启动服务完成迁移');
		n.formMeta.textContent = notes.join(' · ');
		n.formMeta.style.color = (r.config_ok && !r.legacy_secrets) ? '' : '#c62828';
		n.btnFormSave.disabled = !!r.legacy_secrets;
		n.btnFormRestart.disabled = !!r.legacy_secrets;
		this.formDirty = false;
		this.updateAuthScope();
	},

	gatherForm: function() {
		var f = this.n.f;
		return {
			listen_port: +f.port.value,
			listen_host: f.host.value.trim(),
			title: f.title.value.trim(),
			tls_cert: f.tlsCert.value.trim(),
			tls_key: f.tlsKey.value.trim(),
			read_timeout: f.readTimeout.value.trim(),
			shutdown_timeout: f.shutdownTimeout.value.trim(),
			config_panel_enabled: f.panel.checked,
			auth_quick_panel: f.authQuickPanel.checked,
			auth_config_panel: f.panel.checked && f.authConfigPanel.checked,
			auth_trusted_enabled: f.authTrustEnabled.checked,
			auth_trusted_networks: f.authNetworks.value,
			log_level: f.level.value,
			log_format: f.format.value,
			probe_interval: f.probeInterval.value.trim(),
			probe_timeout: f.probeTimeout.value.trim()
		};
	},

	onFormReload: function() {
		var self = this;
		var doIt = function() {
			self.n.formMsg.textContent = '';
			self.n.formMsg.style.color = '';
			return self.loadForm();
		};
		if (this.formDirty)
			confirmAction('放弃修改', '当前表单有未保存的修改，确定重新载入？', doIt);
		else
			doIt();
	},

	onFormSave: function(restart) {
		var self = this;
		var fields = this.gatherForm();
		if (!isFinite(fields.listen_port) || fields.listen_port < 1 || fields.listen_port > 65535) {
			ui.addNotification(null, E('p', {}, '监听端口必须是 1-65535'), 'danger');
			return;
		}
		this.n.btnFormSave.disabled = true;
		this.n.btnFormRestart.disabled = true;
		this.n.formMsg.style.color = '';
		this.n.formMsg.textContent = restart ? '正在校验并重启…' : '正在校验…';

		return callSaveConfigForm(JSON.stringify(fields), !!restart).then(function(r) {
			self.n.btnFormSave.disabled = !!(self.formInfo && self.formInfo.legacy_secrets);
			self.n.btnFormRestart.disabled = !!(self.formInfo && self.formInfo.legacy_secrets);
			if (r && r.ok === false) {
				var msg = '保存失败：' + (r.error || '未知错误');
				if (r.saved)
					msg = '配置已保存，但服务操作失败：' + (r.error || '未知错误');
				self.n.formMsg.textContent = msg + (r.output ? '\n' + r.output : '');
				self.n.formMsg.style.color = '#c62828';
				ui.addNotification(null, E('p', {}, msg), 'danger');
				return;
			}
			self.formDirty = false;
			var note = r.output || 'configuration OK';
			if (r.needs_restart)
				note += '\n注意：监听/TLS/超时/日志级别等变更需要重启服务后生效。';
			else if (r.restarted)
				note += '\n服务已重启。';
			else if (self.lastStatus && self.lastStatus.running)
				note += '\n服务将在约 2 秒内热重载。';
			self.n.formMsg.textContent = note;
			self.n.formMsg.style.color = r.needs_restart ? '#b26a00' : '#2e7d32';
			ui.addNotification(null, E('p', {}, '配置已保存'), 'info');
			self.refresh().then(function() {
				self.loadForm();
				self.loadConfig();
				self.refreshLog(self.logCount);
			});
		}).catch(function(e) {
			self.n.btnFormSave.disabled = false;
			self.n.btnFormRestart.disabled = false;
			self.n.formMsg.textContent = '保存失败：' + (e.message || e);
			self.n.formMsg.style.color = '#c62828';
			ui.addNotification(null, E('p', {}, '保存失败：' + (e.message || e)), 'danger');
		});
	},

	onDismissSecurity: function() {
		this.hideSecurityNotice = true;
		try { window.localStorage.setItem('wolservice.hideSecurityNotice', '1'); } catch (e) {}
		this.n.secCard.style.display = 'none';
		ui.addNotification(null, E('p', {}, '已隐藏安全提示，可在「更新与其他设置」→「服务设置」中恢复。'), 'info');
	},

	onRestoreSecurity: function() {
		this.hideSecurityNotice = false;
		try { window.localStorage.removeItem('wolservice.hideSecurityNotice'); } catch (e) {}
		if (this.lastStatus)
			this.applyStatus(this.lastStatus);
		this.onTab('main');
		ui.addNotification(null, E('p', {}, '已恢复安全提示。'), 'info');
	},

	onSettings: function() {
		var self = this;
		var en = this.n.en.checked;
		var cp = this.n.cp.value.trim();
		var lmax = +this.n.lmax.value;
		if (!cp || cp.charAt(0) !== '/' || !/\.(yaml|yml)$/.test(cp)) {
			ui.addNotification(null, E('p', {}, '配置路径必须是绝对路径并以 .yaml 或 .yml 结尾'), 'danger');
			return;
		}
		if (!isFinite(lmax) || lmax < 32 || lmax > 8192) {
			ui.addNotification(null, E('p', {}, '日志上限必须是 32-8192 之间的数字'), 'danger');
			return;
		}
		return callSettings(en, cp, lmax).then(function(r) {
			if (r && r.ok === false)
				throw new Error(r.error || '保存失败');
			ui.addNotification(null, E('p', {}, '设置已保存' + (r.action && r.action !== 'noop' ? '（' + r.action + '）' : '')), 'info');
			self.settingsDirty = false;
			self.refresh().then(function() {
				if (self.lastStatus) {
					self.n.en.checked = !!self.lastStatus.enabled;
					self.n.cp.value = self.lastStatus.config_path || cp;
					self.n.lmax.value = self.lastStatus.log_max_size || lmax;
				}
				self.loadConfig();
				self.loadForm();
				return self.refreshLog(self.logCount);
			});
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, '设置保存失败：' + (e.message || e)), 'danger');
			self.refresh();
		});
	}
});
