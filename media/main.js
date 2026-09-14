// Typora-like WYSIWYG webview client.
// Renders Vditor inside the extension's webview and writes edits back to the
// markdown document through the extension host (postMessage -> applyEdit).
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  // ---- diagnostics --------------------------------------------------------
  // Forward console output + a heartbeat to the host's "Typora Markdown" output
  // channel so we can see what the webview is doing without Developer Tools.
  (function () {
    function fwd(level) {
      return function () {
        try {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            try { parts.push(typeof a === 'string' ? a : JSON.stringify(a)); }
            catch (_) { parts.push(String(a)); }
          }
          vscode.postMessage({ type: 'log', level: level, text: parts.join(' ') });
        } catch (_) { /* ignore */ }
      };
    }
    console.log = fwd('log');
    console.warn = fwd('warn');
    console.error = fwd('error');
    var hbCount = 0;
    setInterval(function () {
      hbCount++;
      try { vscode.postMessage({ type: 'ping', n: hbCount }); } catch (_) { /* ignore */ }
    }, 2000);
  })();
  var state = { inited: false };
  var vditor = null;
  // Our own reference to the container element. Vditor 4 exposes no reliable
  // `.element`, so all DOM lookups use this instead of vditor.element.
  var editorHost = null;
  // ---- fatal-error surface ------------------------------------------------
  // If anything below fails we show readable text instead of a permanently blank
  // (opacity:0) page, so real failures are diagnosable instead of looking like
  // an empty editor.
  var readyDone = false;
  var readyWatchdog = null;
  var fatalShown = false;
  function showFatal(msg) {
    if (fatalShown) { return; }
    fatalShown = true;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    var app = document.getElementById('app');
    if (!app) { return; }
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;overflow:auto;box-sizing:border-box;padding:24px;' +
      'background:#1e1e1e;color:#f48771;font:13px/1.6 -apple-system,"Segoe UI",sans-serif;' +
      'white-space:pre-wrap;word-break:break-all;';
    box.textContent = '[Typora] 编辑器初始化失败：\n' + msg;
    app.textContent = '';
    app.appendChild(box);
    document.body.setAttribute('data-typora-ready', '1');
  }
  window.addEventListener('error', function (e) {
    if (readyDone || fatalShown) { return; }
    if (e && e.target && e.target.tagName) {
      var tag = e.target.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'LINK') {
        showFatal('关键资源加载失败: ' + (e.target.src || e.target.href || tag));
      }
      return;
    }
    if (e && e.message) {
      showFatal(e.message + (e.filename ? '\n  at ' + e.filename + ':' + e.lineno : ''));
    } else {
      showFatal(String(e));
    }
  });

  // ---- config ----
  var config = {
    mode: 'ir',
    theme: { chromeTheme: 'classic', contentTheme: 'light', codeTheme: 'github', dark: false },
    showToolbar: true,
    autoSave: false
  };
  var payload = {
    cdn: '',
    content: '',
    docDirFs: '',
    docDirWebview: '',
    mode: 'ir'
  };

  // Toolbar definition. The DOM order of the rendered toolbar matches this list
  // (entries other than "|"), which lets us label each button for hover help.
  var toolbarSpec = [
    'headings', 'bold', 'italic', 'strike', '|',
    'line', 'quote', 'code', 'inline-code', '|',
    'list', 'ordered-list', 'check', '|',
    'link', 'table', '|',
    'undo', 'redo'
  ];

  // Hover-help text: name + keyboard shortcut / markdown typing hint.
  var TOOL_HELP = {
    headings: { name: '标题', shortcut: '', typing: '行首输入 # ~ ###### 加空格，或点击选级别' },
    bold: { name: '加粗', shortcut: '⌘B / Ctrl+B', typing: '**文字**' },
    italic: { name: '斜体', shortcut: '⌘I / Ctrl+I', typing: '*文字*' },
    strike: { name: '删除线', shortcut: '', typing: '~~文字~~' },
    line: { name: '分割线', shortcut: '', typing: '单独一行输入 --- 后回车' },
    quote: { name: '引用', shortcut: '', typing: '行首输入 > 加空格' },
    code: { name: '代码块', shortcut: '', typing: '单独一行输入 ``` 后回车' },
    'inline-code': { name: '行内代码', shortcut: '', typing: '`代码`' },
    list: { name: '无序列表', shortcut: '', typing: '行首输入 - 或 * 加空格' },
    'ordered-list': { name: '有序列表', shortcut: '', typing: '行首输入 1. 加空格' },
    check: { name: '任务列表', shortcut: '', typing: '行首输入 - [ ] 加空格' },
    link: { name: '链接', shortcut: '⌘K / Ctrl+K', typing: '[文字](https://…)' },
    table: { name: '表格', shortcut: '', typing: '点击后在下拉里点选行列数' },
    undo: { name: '撤销', shortcut: '⌘Z / Ctrl+Z', typing: '' },
    redo: { name: '重做', shortcut: '⇧⌘Z / Ctrl+Y', typing: '' }
  };

  // ---- composition (IME) guard ----
  var composing = false;
  var sendTimer = null;

  function queueUpdate() {
    if (composing) { return; }
    if (sendTimer) { clearTimeout(sendTimer); }
    sendTimer = setTimeout(function () {
      sendTimer = null;
      if (!vditor) { return; }
      vscode.postMessage({ type: 'update', content: vditor.getValue() });
    }, 60);
  }

  window.addEventListener('compositionstart', function () { composing = true; });
  window.addEventListener('compositionend', function () { composing = false; queueUpdate(); });

  function flushUpdate() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (composing || !vditor) { return; }
    vscode.postMessage({ type: 'update', content: vditor.getValue() });
  }
  window.addEventListener('beforeunload', flushUpdate);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { flushUpdate(); }
  });

  // ---- local image rewriting (relative paths inside the markdown folder) ----
  function localizeImage(img) {
    if (img.__typoraLocal || img.dataset.tpLocal === '1') { return; }
    var src = img.getAttribute('src');
    if (!src) { return; }
    if (/^(https?:|data:|blob:|vscode-webview-resource:|#)/i.test(src)) { return; }
    if (!payload.docDirFs || !payload.docDirWebview) { return; }
    // src may already be resolved by the browser if it was inserted as a data URL
    var resolved = img.src || src;
    if (/^vscode-webview-resource:|^data:/i.test(resolved)) { return; }

    var rel = src;
    var base = payload.docDirFs.replace(/\/$/, '');
    if (rel.charAt(0) === '/') { rel = rel.slice(1); base = ''; }
    var joined = (base ? base + '/' : '') + rel;
    var out = [];
    var parts = joined.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '.' || p === '') { continue; }
      if (p === '..') { out.pop(); } else { out.push(p); }
    }
    var norm = out.map(encodeURIComponent).join('/');
    if (!norm) { return; }
    img.__typoraLocal = true;
    img.dataset.tpLocal = '1';
    img.setAttribute('src', payload.docDirWebview.replace(/\/$/, '') + '/' + norm);
  }

  function handleLinkClick(e) {
    var node = e.target;
    while (node && node.tagName && node.tagName.toLowerCase() !== 'a') { node = node.parentNode; }
    if (!node || !node.tagName || node.tagName.toLowerCase() !== 'a') { return; }
    var href = node.getAttribute('href') || node.getAttribute('data-href') || '';
    if (!href) { return; }
    var isModifier = e.metaKey || e.ctrlKey;
    if (e.type === 'auxclick' && e.button === 1) { isModifier = true; }
    if (!isModifier) { return; }
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'openLink', href: href });
  }

  var observer = null;

  // Localize one element (and its subtree): rewrite relative <img> src to a
  // loadable vscode-webview-resource: URL and bind Cmd/Ctrl+click on links.
  function processNode(n) {
    if (!n || n.nodeType !== 1) { return; }
    if (n.tagName === 'IMG') { localizeImage(n); }
    var imgs = n.querySelectorAll ? n.querySelectorAll('img') : [];
    for (var k = 0; k < imgs.length; k++) { localizeImage(imgs[k]); }
    var as = n.querySelectorAll ? n.querySelectorAll('a') : [];
    for (var m = 0; m < as.length; m++) {
      if (as[m].dataset && as[m].dataset.tpLink !== '1') {
        as[m].addEventListener('auxclick', handleLinkClick);
        as[m].dataset.tpLink = '1';
      }
    }
  }

  function startObserver() {
    if (observer || !editorHost) { return; }
    var root = editorHost;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          processNode(added[j]);
        }
      }
    });
    // Images/links already rendered before the observer started (e.g. the initial
    // document) never trigger "added", so process them now or they'd stay broken.
    processNode(root);
    observer.observe(root, { childList: true, subtree: true });
  }

  // ---- theme application ----
  function setTheme(theme) {
    if (!theme) { theme = config.theme; }
    config.theme = theme;
    if (vditor && theme.chromeTheme) {
      try {
        vditor.setTheme(
          theme.chromeTheme,
          theme.contentTheme,
          theme.codeTheme,
          payload.cdn + '/dist/css/content-theme'
        );
      } catch (err) { /* ignore */ }
    }
    document.body.setAttribute('data-tp-theme', theme.dark ? 'dark' : 'light');
  }

  function setToolbarVisibility(show) {
    if (show) { document.body.classList.remove('tp-no-toolbar'); }
    else { document.body.classList.add('tp-no-toolbar'); }
  }

  function applyConfig() {
    setTheme(config.theme);
    setToolbarVisibility(config.showToolbar);
  }

  // ---- editor creation ----
  function createEditor() {
    var el = document.getElementById('app');
    editorHost = el;
    el.textContent = '';
    var suppress = false;
    var suppressTimer = null;
    readyDone = false;
    readyWatchdog = setTimeout(function () {
      showFatal('Vditor 在 10 秒内未完成初始化（after 回调未执行）。\n' +
        '常见原因：内部资源被 CSP 拦截、cdn 路径不对、或脚本报错。\n' +
        '请在命令面板运行 "Developer: Open Webview Developer Tools" 查看 Console 中的红色错误。');
    }, 10000);
    try {
      vditor = new Vditor(el, {
        height: '100%',
        mode: config.mode,            // 'ir' (instant rendering) or 'wysiwyg'
        lang: 'zh_CN',
        icon: 'ant',
        theme: config.theme.chromeTheme,
        cache: { enable: false },
        value: payload.content,
        cdn: payload.cdn,
        preview: {
          math: { engine: 'KaTeX' },
          theme: { current: config.theme.contentTheme, path: payload.cdn + '/dist/css/content-theme' },
          hljs: { style: config.theme.codeTheme, lineNumber: false }
        },
        counter: { enable: false },
        toolbar: toolbarSpec,
        toolbarConfig: { pin: false },
        input: function () { queueUpdate(); },
        after: function () {
          console.log('[frontend] vditor after() fired');
          if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
          readyDone = true;
          if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; }
          // Post-init decorations must never keep the page invisible: always
          // reach data-typora-ready="1". Wrap extras so an error can't blank the
          // editor — it is surfaced via console (forwarded to the output channel).
          try {
            setTheme(config.theme);
            setToolbarVisibility(config.showToolbar);
            startObserver();
            bindToolbarHelp();
          } catch (err) {
            console.error('[frontend] post-init step failed: ' + (err && err.message ? err.message : String(err)));
          }
          document.body.setAttribute('data-typora-ready', '1');
        }
      });
      // Suppress echo loops triggered by programmatic setValue.
      var origSetValue = vditor.setValue.bind(vditor);
      vditor.setValue = function (value, clearStack) {
        suppress = true;
        if (suppressTimer) { clearTimeout(suppressTimer); }
        suppressTimer = setTimeout(function () { suppress = false; }, 500);
        return origSetValue(value, clearStack);
      };
    } catch (err) {
      if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
      showFatal('Vditor 构造失败: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // Rebuild the editor IN PLACE (used when switching mode). We deliberately do
  // NOT location.reload() the whole page — reloading proved unreliable inside the
  // VS Code webview (a second reload could leave the page blank/grey with no
  // further host handshake, logs or heartbeats). Here we keep the current content,
  // tear the old Vditor instance down and create a fresh one for the new mode.
  function rebuildEditor() {
    flushUpdate();
    if (vditor) {
      try { payload.content = vditor.getValue(); } catch (_) { /* ignore */ }
      try { vditor.destroy(); } catch (_) { /* ignore */ }
      vditor = null;
    }
    if (observer) {
      try { observer.disconnect(); } catch (_) { /* ignore */ }
      observer = null;
    }
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    console.log('[frontend] rebuild editor in place (mode=' + config.mode + ')');
    createEditor();
  }

  // ---- toolbar hover-help --------------------------------------------------
  // On hover over a toolbar button show a tooltip with the function name, its
  // keyboard shortcut and the Markdown typing hint. Vditor's own tooltip only
  // shows a bare name, so we disable it (CSS) and render this richer one.
  var tipEl = null;
  var tipTarget = null;

  function tipNode() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.id = 'tp-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function positionTip(rect) {
    var el = tipNode();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = el.offsetWidth || 220;
    var h = el.offsetHeight || 64;
    var left = Math.max(6, Math.min(rect.left + rect.width / 2 - w / 2, vw - w - 6));
    var top = rect.bottom + 8;
    if (top + h > vh - 6) {
      top = rect.top - h - 8;
    }
    el.style.left = left + 'px';
    el.style.top = Math.max(6, top) + 'px';
  }

  function showTip(tool, rect) {
    var help = TOOL_HELP[tool];
    if (!help) { return; }
    var el = tipNode();
    var html = '<div class="tp-tip-name">' + help.name + '</div>';
    if (help.shortcut) {
      html += '<div class="tp-tip-k">快捷键：<span class="tp-tip-code">' + help.shortcut + '</span></div>';
    }
    if (help.typing) {
      html += '<div class="tp-tip-k">键入：<span class="tp-tip-code">' + help.typing + '</span></div>';
    }
    el.innerHTML = html;
    el.style.display = 'block';
    positionTip(rect);
  }

  function hideTip() {
    if (tipEl) { tipEl.style.display = 'none'; }
    tipTarget = null;
  }

  function bindToolbarHelp() {
    if (!editorHost) { return; }
    var bar = editorHost.querySelector('.vditor-toolbar');
    if (!bar) { return; }
    if (bar.dataset.tpBound === '1') { return; }
    bar.dataset.tpBound = '1';
    // Label each button with its tool name, matching the configured order.
    var names = toolbarSpec.filter(function (t) { return t !== '|'; });
    var idx = 0;
    for (var i = 0; i < bar.children.length; i++) {
      var ch = bar.children[i];
      if (ch.classList && ch.classList.contains('vditor-toolbar__item') && idx < names.length) {
        ch.dataset.tpTool = names[idx];
        idx++;
      }
    }
    bar.addEventListener('mouseover', function (e) {
      var t = e.target;
      var item = t && t.closest ? t.closest('[data-tp-tool]') : null;
      if (!item) { return; }
      if (item === tipTarget) { return; }
      tipTarget = item;
      showTip(item.dataset.tpTool, item.getBoundingClientRect());
    });
    bar.addEventListener('mouseout', function (e) {
      var to = e.relatedTarget;
      if (to && to.closest && to.closest('[data-tp-tool]')) { return; }
      hideTip();
    });
    bar.addEventListener('mousedown', hideTip);
  }

  function syncContent(content) {
    if (!vditor) { return; }
    if (vditor.getValue() === content) { return; }
    // remember scroll? simplest: replace without disturbing focus
    var el = editorHost ? editorHost.querySelector('.vditor-ir, .vditor-wysiwyg') : null;
    var prev = el ? el.scrollTop : 0;
    try {
      vditor.setValue(content, true);
    } catch (err) { /* ignore */ }
    if (el) { el.scrollTop = prev; }
  }

  // ---- message handling from extension host ----
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    switch (msg.type) {
      case 'init':
        console.log('[frontend] init received; mode=' + (payload && payload.mode));
        payload = msg.payload || payload;
        config.mode = payload.mode || config.mode;
        config.theme = payload.theme || config.theme;
        config.showToolbar = payload.showToolbar !== false;
        state.inited = true;
        applyConfig();
        createEditor();
        break;
      case 'sync':
        syncContent(msg.content);
        break;
      case 'theme':
        setTheme(msg.theme);
        break;
      case 'config':
        if (msg.config) {
          var modeChanged = !!msg.config.mode && msg.config.mode !== config.mode;
          if (modeChanged) {
            config.mode = msg.config.mode;
            console.log('[frontend] mode -> ' + config.mode + '; rebuilding in place');
          }
          if (msg.config.showToolbar !== undefined) { config.showToolbar = msg.config.showToolbar; }
          if (msg.config.theme) { setTheme(msg.config.theme); }
          if (modeChanged) {
            rebuildEditor();
          } else {
            applyConfig();
          }
        }
        break;
    }
  });

  // Command+S / Ctrl+S -> ask host to save the document.
  window.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      flushUpdate();
      vscode.postMessage({ type: 'save' });
    }
  });

  // Boot handshake: tell the host the webview script is up so it sends `init`
  // back. This must NOT wait for Vditor's `after` — waiting created a deadlock
  // (host only sent init after `ready`, which only fired once Vditor was built,
  // which itself waited for `init`) → permanently blank page.
  console.log('[frontend] boot: webview script loaded, posting ready');
  vscode.postMessage({ type: 'ready' });
})();
