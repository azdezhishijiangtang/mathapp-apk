/* 原生容器桥（Capacitor APK 专用）。浏览器里全部退化为直连，不影响网页版。
 * 作用：
 *   1) 统一 apiFetch：优先打 APK 内 proot 起的本地 Python 服务（127.0.0.1:8117）；
 *   2) nativeLLMCall：WebView 里的 fetch 受 CORS 限制，改走原生 HTTP 直连模型；
 *   3) 启动时探测本地后端，把结果告诉界面。
 */
(function () {
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  window.isNativeApp = function () { return isNative; };

  var LB = 'http://127.0.0.1:8117';
  var lbUp = null;
  var starting = false;

  function probe() {
    if (lbUp !== null) return Promise.resolve(lbUp);
    return fetch(LB + '/api/health').then(function (r) { lbUp = !!r.ok; return lbUp; })
      .catch(function () { lbUp = false; return false; });
  }
  window.lbProbe = probe;
  window.lbReset = function () { lbUp = null; };
  window.lbStarting = function (v) { starting = !!v; };

  window.apiFetch = function (path, init) {
    if (!isNative) return fetch(path, init);
    return probe().then(function (ok) {
      if (ok) return fetch(LB + path, init);
      throw new Error(starting ? '本地引擎正在启动，请稍候再试' : '本地验证引擎未就绪');
    });
  };

  /* 直连模型（非流式）。opt 与 core.js 的 callLLM 同形。 */
  window.nativeLLMCall = function (messages, opt, S) {
    var http = cap && cap.Plugins && cap.Plugins.CapacitorHttp;
    if (!http) return Promise.reject(new Error('原生 HTTP 插件不可用'));
    var flat = (typeof window.flattenSystem === 'function') ? window.flattenSystem(messages) : messages;
    var base = String((opt.base !== undefined ? opt.base : S.cfg.base) || '').replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('请先在设置里填写 API 地址'));
    var body = {
      model: opt.model || S.cfg.model,
      messages: flat,
      max_tokens: opt.maxTokens || S.cfg.maxTokens,
      temperature: opt.temp === undefined ? S.cfg.temp : opt.temp,
      stream: false
    };
    if (opt.thinking === false) body.thinking = { type: 'disabled' };
    var t0 = Date.now();
    if (opt.onNote) opt.onNote('原生模式：一次性返回，无逐字流式');
    return http.post({
      url: base + '/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (opt.key !== undefined ? opt.key : S.cfg.key)
      },
      data: body, connectTimeout: 30000, readTimeout: 600000, responseType: 'json'
    }).then(function (res) {
      if (res.status >= 400) {
        var e = res.data && res.data.error;
        var msg = (e && (e.message || e)) || ('HTTP ' + res.status);
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      var d = res.data || {};
      var m = (d.choices || [{}])[0] || {};
      var content = (m.message || {}).content || '';
      if (content && opt.onText) opt.onText(content);
      return {
        content: content,
        reasoning: (m.message || {}).reasoning_content || '',
        finish: m.finish_reason || '',
        usage: d.usage || {},
        secs: (Date.now() - t0) / 1000
      };
    });
  };

  /* 原生启动流程：让 APK 内的本地后端起来，再探测一次 */
  window.bootBackend = function () {
    if (!isNative) return Promise.resolve(false);
    var be = cap.Plugins && cap.Plugins.LocalBackend;
    if (!be) return probe();
    starting = true;
    return be.start().then(function (r) {
      starting = false;
      lbUp = null;
      return probe();
    }).catch(function () { starting = false; return probe(); });
  };

  /* ---------- 引擎包（rootfs）安装与状态 ---------- */
  function be() { return (cap && cap.Plugins && cap.Plugins.LocalBackend) || null; }

  window.engineStatus = function () {
    var b = be();
    if (!isNative || !b) return Promise.resolve({ installed: true, ready: false, native: false });
    return b.status();
  };

  /* 监听安装进度，回调 {phase,pct,msg}；返回取消函数 */
  window.onInstallProgress = function (cb) {
    var b = be();
    if (!isNative || !b || !b.addListener) return function () {};
    var h = b.addListener('installProgress', function (d) { try { cb(d || {}); } catch (e) { } });
    return function () { Promise.resolve(h).then(function (h2) { if (h2 && h2.remove) h2.remove(); }); };
  };

  /* 打开系统文件选择器挑 rootfs.tar.gz → 拷贝 → 解压 → 启动 */
  window.engineInstall = function () {
    var b = be();
    if (!isNative || !b) return Promise.reject(new Error('仅 APK 内可用'));
    return b.pickAndInstall();
  };

  /* 单文件 APK：直接解压 APK 内置的 assets/rootfs.tar.gz */
  window.engineInstallAuto = function () {
    var b = be();
    if (!isNative || !b) return Promise.reject(new Error('仅 APK 内可用'));
    return b.installFromAssets();
  };

  window.engineStart = function () {
    var b = be();
    if (!isNative || !b) return Promise.reject(new Error('仅 APK 内可用'));
    return b.start().then(function (r) { lbUp = null; return r; });
  };

  window.engineLog = function () {
    var b = be();
    if (!isNative || !b) return Promise.resolve({ text: '(浏览器模式无本地后端日志)' });
    return b.log();
  };
})();
