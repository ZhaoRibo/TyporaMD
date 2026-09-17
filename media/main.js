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
    autoSave: false,
    tabSize: 4
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

    // Resolve the image path (absolute, or relative to the document folder) into
    // clean segments — dropping "." and collapsing "..".
    var baseSegs = splitSegments('', payload.docDirFs);
    var absSegs = splitSegments(payload.docDirFs, src);
    // The webview may only read the document folder (localResourceRoots), so the
    // image has to live inside it. Note `asWebviewUri(docDir)` is a *full*
    // resource URL that already contains the folder path — appending another
    // absolute path would duplicate it (the old bug) — so append the path
    // relative to the document folder instead.
    if (absSegs.length <= baseSegs.length) { return; }
    var insideFolder = true;
    for (var b = 0; b < baseSegs.length; b++) {
      if (absSegs[b] !== baseSegs[b]) { insideFolder = false; break; }
    }
    if (!insideFolder) { return; }
    var encoded = absSegs.slice(baseSegs.length).map(encodeURIComponent).join('/');
    if (!encoded) { return; }
    img.__typoraLocal = true;
    img.dataset.tpLocal = '1';
    img.setAttribute('src', payload.docDirWebview.replace(/\/$/, '') + '/' + encoded);
  }

  // Resolve `p` (absolute, or relative to `base`) into clean path segments.
  function splitSegments(base, p) {
    var segs = [];
    if (base && p.charAt(0) !== '/') {
      var bs = base.split('/');
      for (var i = 0; i < bs.length; i++) {
        if (bs[i] && bs[i] !== '.') { segs.push(bs[i]); }
      }
    }
    var ps = p.split('/');
    for (var j = 0; j < ps.length; j++) {
      var s = ps[j];
      if (!s || s === '.') { continue; }
      if (s === '..') { segs.pop(); } else { segs.push(s); }
    }
    return segs;
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

  // ---- Tab key -------------------------------------------------------------
  // Behaviour by caret position (Typora-like):
  //   * table cell                 -> move to the next cell (Vditor native)
  //   * list item at line start    -> change nesting level
  //   * anywhere else              -> insert an indentation of spaces
  // Notes:
  //   - Headings and blockquotes deliberately get NO special behaviour: both
  //     proved unreliable (heading markers desynced; blockquote indentation
  //     produced stray quote lines), so they fall through to plain indentation.
  //   - Never insert a real tab character: the Markdown engine treats it as a
  //     code-block marker (it split a paragraph in testing).
  //   - Always preventDefault(): the browser's default Tab moves focus away.
  //   - We manipulate the DOM directly instead of using execCommand('indent'):
  //     that turned lists into blockquotes, only worked one level deep and
  //     inserted a line break for empty items.
  //   - Do NOT dispatch a synthetic `input` event after DOM edits: Vditor then
  //     re-renders and the caret jumps back to the start of the line.
  /** Spaces inserted by Tab — from `typoraMd.tabSize` (`0` is resolved by the host). */
  function indentText() {
    var n = config.tabSize > 0 ? config.tabSize : 4;
    return new Array(n + 1).join(' ');
  }

  function closestTag(el, tags) {
    while (el && el !== editorHost) {
      if (el.tagName && tags.indexOf(el.tagName) >= 0) { return el; }
      el = el.parentElement;
    }
    return null;
  }

  /** True when the caret is at the very start of `block` (no content before it). */
  function caretAtLineStart(block) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) { return false; }
    var range = sel.getRangeAt(0);
    var pre = document.createRange();
    pre.selectNodeContents(block);
    try {
      pre.setEnd(range.startContainer, range.startOffset);
    } catch (err) {
      return false;
    }
    var text = pre.toString()
      .replace(/^[\s\u00a0]+/, '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s*/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/^[>\s]*/, '');
    return text.length === 0;
  }

  /** Put the caret at the start of `node`, skipping IR marker elements. */
  function placeCaretStartAt(node) {
    var range = document.createRange();
    var child = node.firstChild;
    while (child && child.nodeType === 1 && child.classList &&
      child.classList.contains('vditor-ir__marker')) {
      child = child.nextSibling;
    }
    if (child) {
      range.setStartBefore(child);
    } else {
      range.selectNodeContents(node);
    }
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Insert indentation at the caret (execCommand keeps Vditor's input in sync). */
  function insertIndent() {
    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, indentText());
    } catch (err) {
      inserted = false;
    }
    if (inserted) { return; }
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) { return; }
    var range = sel.getRangeAt(0);
    var node = document.createTextNode(indentText());
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Nest `li` into a sub-list of `targetLi`. */
  function nestUnder(li, targetLi) {
    var sub = null;
    for (var i = 0; i < targetLi.children.length; i++) {
      var child = targetLi.children[i];
      if (child.tagName === 'UL' || child.tagName === 'OL') { sub = child; }
    }
    if (!sub) {
      sub = document.createElement(li.parentElement.tagName.toLowerCase());
      targetLi.appendChild(sub);
    }
    sub.appendChild(li);
    return true;
  }

  /**
   * Move a list item one level deeper.
   * Normally the item nests under its previous sibling item. When it is the first
   * item of its (sub-)list there is no sibling to nest under, so we indent the
   * *parent* item instead — that carries this item along and lets nesting go past
   * a single level. (Markdown cannot skip levels, so a top-level first item still
   * has nowhere to go.)
   */
  function indentListItem(li) {
    if (!li.parentElement) { return false; }
    var prev = li.previousElementSibling;
    while (prev && prev.tagName !== 'LI') { prev = prev.previousElementSibling; }
    if (prev) {
      return nestUnder(li, prev);
    }
    var list = li.parentElement;
    var parentLi = list.parentElement && list.parentElement.tagName === 'LI' ? list.parentElement : null;
    if (parentLi) {
      return indentListItem(parentLi);
    }
    return false;
  }

  /** Move a list item one level up (out of its parent list item). */
  function outdentListItem(li) {
    var list = li.parentElement;
    var parentLi = list && list.parentElement && list.parentElement.tagName === 'LI' ? list.parentElement : null;
    if (!parentLi || !parentLi.parentElement) { return false; }
    parentLi.parentElement.insertBefore(li, parentLi.nextElementSibling);
    if (!list.children.length) { list.remove(); }
    return true;
  }

  function onTabKeydown(e) {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) { return; }
    if (!editorHost) { return; }
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) { return; }
    var node = sel.anchorNode;
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || !editorHost.contains(el)) { return; }

    // 1) Table: Vditor moves between cells on Tab natively — leave it alone.
    if (closestTag(el, ['TABLE', 'TD', 'TH'])) {
      return;
    }

    // 2) List item at the start of the line: change the nesting level.
    var li = closestTag(el, ['LI']);
    if (li && caretAtLineStart(li)) {
      e.preventDefault();
      e.stopPropagation();
      var changed = e.shiftKey ? outdentListItem(li) : indentListItem(li);
      if (changed) {
        placeCaretStartAt(li);
        console.log('[tab] list ' + (e.shiftKey ? 'outdent' : 'indent') + ' ok');
      } else {
        console.log('[tab] list ' + (e.shiftKey ? 'outdent' : 'indent') + ' skipped');
      }
      queueUpdate();
      hideTip();
      return;
    }

    // 3) Everything else — headings, quotes, plain text, code, mid-line, end of
    //    line — insert indentation spaces (no focus jump, no special handling).
    e.preventDefault();
    e.stopPropagation();
    insertIndent();
    console.log('[tab] insert indent (' + indentText().length + ' spaces)');
    queueUpdate();
    hideTip();
  }

  function bindTabKey() {
    if (!editorHost || editorHost.dataset.tpTab === '1') { return; }
    editorHost.dataset.tpTab = '1';
    editorHost.addEventListener('keydown', onTabKeydown, true);
  }

  // ---- paste image handling -----------------------------------------------
  // Vditor's default paste inlines the image as a base64 data: URL, turning a
  // screenshot into hundreds of thousands of characters inside the markdown
  // file. We intercept image pastes (capture phase, before Vditor), hand the
  // bytes to the host to save next to the document, then insert a clean
  // relative-path image reference.
  var imageSeq = 0;

  function clipboardImage(e) {
    var dt = e.clipboardData;
    if (!dt) { return null; }
    var i;
    var files = dt.files || [];
    for (i = 0; i < files.length; i++) {
      if (files[i] && files[i].type && files[i].type.indexOf('image/') === 0) { return files[i]; }
    }
    var items = dt.items || [];
    for (i = 0; i < items.length; i++) {
      if (items[i] && items[i].kind === 'file' &&
        items[i].type && items[i].type.indexOf('image/') === 0) {
        return items[i].getAsFile();
      }
    }
    return null;
  }

  function onImagePaste(e) {
    var file = clipboardImage(e);
    if (!file) { return; } // text / code paste: keep Vditor's default handling
    e.preventDefault();
    e.stopPropagation();
    var id = ++imageSeq;
    var reader = new FileReader();
    reader.onload = function () {
      vscode.postMessage({ type: 'saveImage', id: id, dataUrl: reader.result });
    };
    reader.onerror = function () {
      console.error('[frontend] failed to read pasted image');
    };
    reader.readAsDataURL(file);
  }

  function bindImagePaste() {
    if (!editorHost || editorHost.dataset.tpPaste === '1') { return; }
    editorHost.dataset.tpPaste = '1';
    editorHost.addEventListener('paste', onImagePaste, true);
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
            bindTablePicker();
            bindImagePaste();
            bindTabKey();
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

  // ---- table size picker ---------------------------------------------------
  // Vditor's stock table button drops a hard-coded 3x3 table. Typora asks for the
  // size first, so we intercept the click (capture phase, before Vditor's own
  // delegate sees it) and show a hover grid instead.
  var TP_TABLE_MAX = 10;
  var tablePickerEl = null;
  var tableAnchor = null;
  var savedRange = null;
  var savedBlockEmpty = true;
  var tableDocBound = false;

  function tablePicker() {
    if (tablePickerEl) { return tablePickerEl; }
    var el = document.createElement('div');
    el.id = 'tp-table-picker';
    el.innerHTML = '<div class="tp-tp-head">插入表格</div>' +
      '<div class="tp-tp-grid"></div>' +
      '<div class="tp-tp-size">选择行列数</div>';
    var grid = el.querySelector('.tp-tp-grid');
    grid.style.gridTemplateColumns = 'repeat(' + TP_TABLE_MAX + ', 16px)';
    for (var r = 1; r <= TP_TABLE_MAX; r++) {
      for (var c = 1; c <= TP_TABLE_MAX; c++) {
        var cell = document.createElement('span');
        cell.className = 'tp-tp-cell';
        cell.setAttribute('data-r', String(r));
        cell.setAttribute('data-c', String(c));
        grid.appendChild(cell);
      }
    }
    grid.addEventListener('mouseover', function (e) {
      var cell = e.target && e.target.closest ? e.target.closest('.tp-tp-cell') : null;
      if (!cell) { return; }
      markTablePicker(parseInt(cell.getAttribute('data-r'), 10), parseInt(cell.getAttribute('data-c'), 10));
    });
    grid.addEventListener('mouseleave', function () { markTablePicker(0, 0); });
    grid.addEventListener('click', function (e) {
      var cell = e.target && e.target.closest ? e.target.closest('.tp-tp-cell') : null;
      if (!cell) { return; }
      var rows = parseInt(cell.getAttribute('data-r'), 10);
      var cols = parseInt(cell.getAttribute('data-c'), 10);
      hideTablePicker();
      insertTableMarkdown(rows, cols);
    });
    document.body.appendChild(el);
    tablePickerEl = el;
    return el;
  }

  // Light up every cell up to (rows, cols) and refresh the size caption.
  function markTablePicker(rows, cols) {
    if (!tablePickerEl) { return; }
    var cells = tablePickerEl.querySelectorAll('.tp-tp-cell');
    for (var i = 0; i < cells.length; i++) {
      var on = rows > 0 &&
        parseInt(cells[i].getAttribute('data-r'), 10) <= rows &&
        parseInt(cells[i].getAttribute('data-c'), 10) <= cols;
      if (on) { cells[i].classList.add('is-on'); }
      else { cells[i].classList.remove('is-on'); }
    }
    var size = tablePickerEl.querySelector('.tp-tp-size');
    if (size) {
      size.textContent = rows > 0 ? rows + ' 行 × ' + cols + ' 列' : '选择行列数';
    }
  }

  function showTablePicker(anchor) {
    var el = tablePicker();
    markTablePicker(0, 0);
    el.style.display = 'block';
    var rect = anchor.getBoundingClientRect();
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var left = Math.max(6, Math.min(rect.left - 4, window.innerWidth - w - 6));
    var top = rect.bottom + 8;
    if (top + h > window.innerHeight - 6) { top = Math.max(6, rect.top - h - 8); }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    tableAnchor = anchor;
  }

  function hideTablePicker() {
    if (tablePickerEl) { tablePickerEl.style.display = 'none'; }
    tableAnchor = null;
  }

  // True when the given node sits in a block with no visible text: a blank
  // paragraph, an empty list item, and so on. Vditor pads empty blocks with a
  // zero-width space, so that has to be stripped before deciding.
  function blockIsEmpty(node) {
    var block = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
    var blocks = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV'];
    while (block && block !== editorHost && blocks.indexOf(block.tagName) < 0) {
      block = block.parentNode;
    }
    if (!block || block === editorHost) { return true; }
    return (block.textContent || '').replace(/\u200b/g, '').trim() === '';
  }

  // Remember the caret before the picker takes focus away from the editor.
  // A stale range would send the table somewhere the user never clicked, so the
  // first thing we do is drop it and only re-arm it when the caret really is
  // inside the editor.
  function rememberCaret() {
    savedRange = null;
    savedBlockEmpty = true;
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) { return; }
      var range = sel.getRangeAt(0);
      var node = range.startContainer;
      var host = node && node.nodeType === 1 ? node : (node ? node.parentNode : null);
      if (host && editorHost && editorHost.contains(host)) {
        savedRange = range.cloneRange();
        savedBlockEmpty = blockIsEmpty(node);
      }
    } catch (_) { /* ignore */ }
  }

  function appendBlock(md, content) {
    try { vditor.setValue(content.replace(/\s*$/, '') + '\n\n' + md); } catch (_) { /* ignore */ }
    queueUpdate();
  }

  function insertTableMarkdown(rows, cols) {
    if (!vditor) { return; }
    var head = '|';
    var sep = '|';
    for (var c = 0; c < cols; c++) { head += '  |'; sep += ' --- |'; }
    var body = '';
    for (var r = 1; r < rows; r++) {
      body += '\n|';
      for (var k = 0; k < cols; k++) { body += '  |'; }
    }
    // Mid-paragraph the table must start on a line of its own, otherwise the
    // surrounding text gets swallowed into the first header cell (Typora does
    // the same). In an already-empty block it goes in place.
    var md = (savedBlockEmpty ? '' : '\n\n') + head + '\n' + sep + body + '\n';
    var content = '';
    try { content = vditor.getValue(); } catch (_) { /* ignore */ }
    // No caret inside the editor (e.g. the button was clicked right after the
    // document opened): append at the end instead of letting insertValue decide.
    if (!savedRange) {
      appendBlock(md.replace(/^\n+/, ''), content);
      return;
    }
    try {
      vditor.focus();
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      vditor.insertValue(md);
    } catch (err) {
      console.error('[frontend] insert table failed: ' +
        (err && err.message ? err.message : String(err)));
    }
    var after = '';
    try { after = vditor.getValue(); } catch (_) { /* ignore */ }
    if (after === content) { appendBlock(md.replace(/^\n+/, ''), content); return; }
    queueUpdate();
  }

  // The toolbar can be re-created by Vditor (mode switches, re-renders), so the
  // buttons are matched on Vditor's own `data-type` marker rather than on the
  // labels we add for the tooltips.
  function tableButtonOf(target) {
    if (!target || !target.closest) { return null; }
    return target.closest('[data-type="table"]') || target.closest('[data-tp-tool="table"]');
  }

  function bindTablePicker() {
    if (!editorHost) { return; }
    // Listen on the container, not on .vditor-toolbar: the toolbar element is
    // replaced on rebuild (which used to drop the binding and make the button
    // fall back to Vditor's fixed 3x3 insert).
    if (editorHost.dataset.tpTableBound === '1') { return; }
    editorHost.dataset.tpTableBound = '1';
    // The caret must be captured on mousedown: by click time the editor has
    // already lost focus and the selection is gone.
    editorHost.addEventListener('mousedown', function (e) {
      if (tableButtonOf(e.target)) { rememberCaret(); }
    }, true);
    // Capture phase + stopPropagation keeps Vditor's own handler (which inserts
    // the hard-coded 3x3) from ever running.
    editorHost.addEventListener('click', function (e) {
      var item = tableButtonOf(e.target);
      if (!item) { return; }
      e.preventDefault();
      e.stopPropagation();
      hideTip();
      if (tableAnchor === item) { hideTablePicker(); return; }  // click again = toggle off
      showTablePicker(item);
    }, true);
    // Document-level listeners must survive toolbar rebuilds, so bind them once.
    if (tableDocBound) { return; }
    tableDocBound = true;
    // Clicking elsewhere, or the window losing focus, dismisses the picker.
    document.addEventListener('mousedown', function (e) {
      if (!tablePickerEl || tablePickerEl.style.display !== 'block') { return; }
      var t = e.target;
      if (t && t.closest && (t.closest('#tp-table-picker') || tableButtonOf(t))) { return; }
      hideTablePicker();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideTablePicker(); }
    });
    window.addEventListener('blur', hideTablePicker);
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
        if (typeof payload.tabSize === 'number' && payload.tabSize > 0) { config.tabSize = payload.tabSize; }
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
          if (typeof msg.config.tabSize === 'number' && msg.config.tabSize > 0) { config.tabSize = msg.config.tabSize; }
          if (msg.config.theme) { setTheme(msg.config.theme); }
          if (modeChanged) {
            rebuildEditor();
          } else {
            applyConfig();
          }
        }
        break;
      case 'imageSaved': {
        if (!vditor || typeof msg.relPath !== 'string') { break; }
        try {
          vditor.insertValue('![](' + msg.relPath + ')');
          flushUpdate();
        } catch (err) {
          console.error('[frontend] insert saved image failed: ' +
            (err && err.message ? err.message : String(err)));
        }
        break;
      }
      case 'imageError':
        console.error('[frontend] save pasted image failed: ' + (msg.message || ''));
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
