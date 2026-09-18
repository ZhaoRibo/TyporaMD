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
    mode: 'wysiwyg',
    theme: { chromeTheme: 'classic', contentTheme: 'light', codeTheme: 'github', dark: false },
    showToolbar: true,
    showBlockPanel: false,
    exitBlockKeys: 'ctrl+enter',
    exitBlockScope: 'code,math',
    autoSave: false,
    tabSize: 4
  };
  var payload = {
    cdn: '',
    content: '',
    docDirFs: '',
    docDirWebview: '',
    mode: 'wysiwyg'
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
      vscode.postMessage({ type: 'update', content: rawValue() });
    }, 60);
  }

  window.addEventListener('compositionstart', function () { composing = true; });
  window.addEventListener('compositionend', function () { composing = false; queueUpdate(); });

  function flushUpdate() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (composing || !vditor) { return; }
    vscode.postMessage({ type: 'update', content: rawValue() });
  }
  window.addEventListener('beforeunload', flushUpdate);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { flushUpdate(); }
  });

  // ---- local image rewriting (relative paths inside the markdown folder) ----
  // Recover the markdown-facing path from a URL we generated earlier: Vditor may
  // re-render the DOM from a value that still held a resource URL, in which case
  // the original path would otherwise be lost forever.
  function pathFromWebviewUrl(url) {
    if (!url || !payload.docDirWebview) { return null; }
    var base = payload.docDirWebview.replace(/\/$/, '');
    if (!base || url.indexOf(base + '/') !== 0) { return null; }
    var rel = url.slice(base.length + 1);
    try { rel = decodeURIComponent(rel); } catch (_) { /* keep as-is */ }
    return rel || null;
  }

  function localizeImage(img) {
    if (img.__typoraLocal || img.dataset.tpLocal === '1') { return; }
    var src = img.getAttribute('src');
    if (!src) { return; }
    if (!payload.docDirFs || !payload.docDirWebview) { return; }

    // Already a resource URL we produced? Record the path it stands for and stop
    // — it still loads, but the document must keep the relative path.
    if (!img.dataset.tpSrc) {
      var recovered = pathFromWebviewUrl(src);
      if (recovered) { img.dataset.tpSrc = recovered; }
    }
    if (/^(https?:|data:|blob:|vscode-webview-resource:|#)/i.test(src)) { return; }
    // A pasted image arrives as a data: URL and needs no rewriting.
    if (/^data:/i.test(img.src || '')) { return; }

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
    // Remember the markdown-facing path before swapping in the webview URL:
    // Vditor serialises the live DOM back to Markdown, so the resource URL must
    // never reach the file (see rawValue).
    if (!img.dataset.tpSrc) { img.dataset.tpSrc = src; }
    img.setAttribute('src', payload.docDirWebview.replace(/\/$/, '') + '/' + encoded);
  }

  // Vditor turns the live DOM back into Markdown, which would leak the
  // vscode-webview-resource: URLs injected by localizeImage() into the document.
  // Put the original paths back for the duration of getValue() only. Only
  // attributes change here, and the MutationObserver watches childList only, so
  // this cannot feed back into itself.
  function rawValue() {
    if (!vditor) { return ''; }
    var imgs = editorHost ? editorHost.querySelectorAll('img') : [];
    var saved = [];
    for (var i = 0; i < imgs.length; i++) {
      saved.push({
        el: imgs[i],
        src: imgs[i].getAttribute('src'),
        title: imgs[i].getAttribute('title')
      });
      if (imgs[i].dataset.tpSrc) { imgs[i].setAttribute('src', imgs[i].dataset.tpSrc); }
      if (imgs[i].dataset.tpTitle) { imgs[i].setAttribute('title', imgs[i].dataset.tpTitle); }
    }
    var text = '';
    try { text = vditor.getValue(); } catch (_) { /* ignore */ }
    for (var j = 0; j < saved.length; j++) {
      var el = saved[j].el;
      if (saved[j].src === null) { el.removeAttribute('src'); } else { el.setAttribute('src', saved[j].src); }
      if (saved[j].title === null) { el.removeAttribute('title'); } else { el.setAttribute('title', saved[j].title); }
    }
    return text;
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

  // Park the title on a data attribute so the slow native tooltip stays away; the
  // value is restored on write-back (rawValue) and shown by bindImageTip.
  function parkImageTitle(img) {
    var t = img.getAttribute('title');
    if (t) {
      img.dataset.tpTitle = t;
      img.removeAttribute('title');
    }
  }

  function prepareImage(img) {
    parkImageTitle(img);
    localizeImage(img);
  }

  // Localize one element (and its subtree): rewrite relative <img> src to a
  // loadable vscode-webview-resource: URL and bind Cmd/Ctrl+click on links.
  function processNode(n) {
    if (!n || n.nodeType !== 1) { return; }
    if (n.tagName === 'IMG') { prepareImage(n); }
    var imgs = n.querySelectorAll ? n.querySelectorAll('img') : [];
    for (var k = 0; k < imgs.length; k++) { prepareImage(imgs[k]); }
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

  // Vditor floats a block panel (move up/down, delete, set anchor id) whenever the
  // pointer nears a block's left gutter. It overlaps the block badges and is easy
  // to trigger by accident, so it is off unless typoraMd.showBlockPanel is set.
  function setBlockPanelVisibility(show) {
    if (show) { document.body.classList.remove('tp-no-block-panel'); }
    else { document.body.classList.add('tp-no-block-panel'); }
  }

  function applyConfig() {
    setTheme(config.theme);
    setToolbarVisibility(config.showToolbar);
    setBlockPanelVisibility(config.showBlockPanel);
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
        mode: config.mode,            // 'wysiwyg' (markers hidden, closest to Typora) or 'ir' (markers always visible)
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
            bindImageTip();
            bindTablePicker();
            bindCtxMenu();
            bindExitBlock();
            bindImagePaste();
            bindTabKey();
            // Re-create the blank lines the author wrote after code/math blocks.
            // Markdown itself cannot express them (see blankRunsAfterBlocks).
            restoreBlankParagraphs(payload.content);
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
      try { payload.content = rawValue(); } catch (_) { /* ignore */ }
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

  // ---- fast image title tooltip -------------------------------------------
  // The native title tooltip waits about a second and cannot be tuned from JS or
  // CSS, so image titles are parked in data-tp-title (see prepareImage) and shown
  // here instead — and put back on the <img> only while the document is written
  // back (see rawValue), so Markdown keeps its "title".
  var imgTipTimer = null;
  var imgTipTarget = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showImageTip(img) {
    var text = img.dataset.tpTitle || '';
    if (!text) { return; }
    var el = tipNode();
    el.innerHTML = '<div class="tp-tip-name">' + escapeHtml(text) + '</div>';
    el.style.display = 'block';
    positionTip(img.getBoundingClientRect());
  }

  function hideImageTip() {
    if (imgTipTimer) { clearTimeout(imgTipTimer); imgTipTimer = null; }
    if (imgTipTarget) {
      imgTipTarget = null;
      hideTip();
    }
  }

  function bindImageTip() {
    if (!editorHost || editorHost.dataset.tpImgTipBound === '1') { return; }
    editorHost.dataset.tpImgTipBound = '1';
    editorHost.addEventListener('mouseover', function (e) {
      var img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (!img || img === imgTipTarget) { return; }
      if (!img.dataset.tpTitle) { hideImageTip(); return; }
      if (imgTipTimer) { clearTimeout(imgTipTimer); }
      imgTipTarget = img;
      imgTipTimer = setTimeout(function () {
        imgTipTimer = null;
        if (imgTipTarget === img && img.isConnected) { showImageTip(img); }
      }, 60);
    }, true);
    editorHost.addEventListener('mouseout', function (e) {
      var img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (img) { hideImageTip(); }
    }, true);
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

  // ---- escaping a code / math / quote block ---------------------------------
  // Enter inside a code block keeps adding lines — that is what you want while
  // writing code. Jumping out is Cmd/Ctrl+Enter (Typora's shortcut) and is
  // configurable via typoraMd.exitBlockKeys / exitBlockScope.
  function parseExitKeys(spec) {
    var keys = [];
    var parts = String(spec || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var bits = parts[i].trim().toLowerCase().split('+');
      var kept = [];
      for (var b = 0; b < bits.length; b++) {
        if (bits[b]) { kept.push(bits[b]); }
      }
      if (!kept.length) { continue; }
      keys.push({
        key: kept[kept.length - 1],
        shift: kept.indexOf('shift') >= 0,
        accel: kept.indexOf('ctrl') >= 0 || kept.indexOf('cmd') >= 0 || kept.indexOf('meta') >= 0,
        alt: kept.indexOf('alt') >= 0
      });
    }
    return keys;
  }

  function isExitKey(e, keys) {
    var name = String(e.key || '').toLowerCase();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (name !== k.key) { continue; }
      if (!!e.shiftKey !== k.shift) { continue; }
      if (!!e.altKey !== k.alt) { continue; }
      // ctrl and cmd count as the same accelerator, so a shortcut written once
      // behaves the same on macOS and Windows.
      if (k.accel !== !!(e.ctrlKey || e.metaKey)) { continue; }
      return true;
    }
    return false;
  }

  function exitScope() {
    var raw = String(config.exitBlockScope || '').toLowerCase();
    return {
      code: raw.indexOf('code') >= 0,
      math: raw.indexOf('math') >= 0,
      quote: raw.indexOf('quote') >= 0
    };
  }

  function elementOf(node) {
    if (!node) { return null; }
    return node.nodeType === 1 ? node : node.parentNode;
  }

  // Vditor's own empty placeholder paragraph?
  function isBlankParagraph(el) {
    if (!el || el.nodeType !== 1 || el.tagName !== 'P') { return false; }
    return !el.textContent.replace(/[\s\u200b\ufeff]/g, '');
  }

  // Focus the editing surface and drop the caret at the start of `p`.
  function placeCaret(p) {
    if (!p || !p.isConnected) { return false; }
    try {
      var host = p.closest('pre.vditor-reset') || editorHost;
      if (host && host.focus) { host.focus(); }
      var range = document.createRange();
      range.setStart(p, 0);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (_) { return false; }
  }

  function caretElement() {
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) { return elementOf(sel.getRangeAt(0).startContainer); }
    } catch (_) { /* ignore */ }
    return null;
  }

  // The block the caret sits in, if it is one we may jump out of.
  //
  // In WYSIWYG mode a code block is edited in its own textarea, but in IR mode the
  // whole document is one contenteditable root, so the keydown target is always
  // `pre.vditor-reset` — the caret has to be resolved separately, otherwise the
  // closest() lookups below never match.
  function exitTarget(eventTarget) {
    var scope = exitScope();
    var caret = caretElement();
    var nodes = [];
    if (caret) { nodes.push(caret); }
    if (eventTarget && eventTarget !== caret) { nodes.push(eventTarget); }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.closest) { continue; }
      // Only inside our own Vditor instance — the webview may host other inputs,
      // and Vditor parks some of its helper nodes outside the container we hold.
      if (!el.closest('.vditor')) { continue; }

      // Both modes tag the enclosing block with a data-type. In IR mode the caret
      // can sit in the .vditor-ir__node wrapper or in its .vditor-ir__marker--pre
      // fence; in WYSIWYG mode it sits inside a textarea. Walking up to the tagged
      // ancestor covers all of those cases.
      var block = el.closest('[data-type="code-block"], [data-type="math-block"]');
      if (!block && el.tagName === 'TEXTAREA') { block = el.closest('[data-type]'); }
      if (block) {
        var kind = block.getAttribute('data-type');
        if (kind === 'math-block') { return scope.math ? { kind: 'math', block: block } : null; }
        if (kind === 'code-block') { return scope.code ? { kind: 'code', block: block } : null; }
      }

      if (scope.quote) {
        var quote = el.closest('blockquote');
        if (quote) { return { kind: 'quote', block: quote }; }
      }
    }
    return null;
  }

  // The top-level block element that contains `el`. IR nests the marked element
  // inside `.vditor-ir__node` wrappers, so the *innermost* match is not a valid
  // anchor: inserting next to it would drop the new paragraph inside the block.
  function topLevelOf(el) {
    var root = el.closest('pre.vditor-reset') || editorHost;
    if (!root || !root.contains || !root.contains(el)) { return el; }
    var top = el;
    while (top.parentNode && top.parentNode !== root) { top = top.parentNode; }
    return top;
  }

  function leaveExitBlock(target) {
    var block = target.block;
    if (!block || !block.parentNode) { return; }
    // A code block holds a textarea while it is being edited; blur it so Vditor
    // stops treating the block as focused.
    try {
      var ta = block.querySelector('textarea');
      if (ta) { ta.blur(); }
    } catch (_) { /* ignore */ }
    // Land the caret in a blank paragraph right after the block. Vditor keeps a
    // placeholder paragraph after each block *and* renormalises the DOM around
    // the caret, so a paragraph we create ourselves would be merged into the
    // following block — reusing its placeholder is what keeps the caret on a
    // fresh line instead of jumping onto the next block's text.
    setTimeout(function () {
      var anchor = topLevelOf(block);
      if (!anchor || !anchor.parentNode) { return; }
      var next = anchor.nextSibling;
      while (next && next.nodeType !== 1) { next = next.nextSibling; }
      var p = isBlankParagraph(next) ? next : null;
      if (!p) {
        p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        anchor.parentNode.insertBefore(p, anchor.nextSibling);
      }
      placeCaret(p);
      // Vditor may rebuild the paragraph on the next tick; re-seat the caret.
      requestAnimationFrame(function () {
        if (p.isConnected) { placeCaret(p); }
        queueUpdate();
      });
    }, 0);
  }

  function makeBlankParagraph() {
    var p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    return p;
  }

  // Markdown has no way to express a *blank paragraph*: an empty line is only a
  // block separator, so Lute collapses runs of them to one on every load — which
  // silently deletes blank lines the author wrote after a code/math block (and
  // therefore also breaks "exit the block and land on a fresh line").
  //
  // Scan the source and report, for each code/math block in document order, how
  // many blank paragraphs must be recreated after it. A single empty line is the
  // ordinary separator and stays implicit; see the conversion note below.
  function blankRunsAfterBlocks(md) {
    var lines = String(md || '').split('\n');
    var runs = [];
    var i = 0;
    while (i < lines.length) {
      var t = lines[i].trim();
      var endOfBlock = -1;
      if (/^(```|~~~)/.test(t)) {
        var fence = t.slice(0, 3);
        var j = i + 1;
        while (j < lines.length && lines[j].trim().indexOf(fence) !== 0) { j++; }
        endOfBlock = j < lines.length ? j : -1;
        i = j + 1;
      } else if (t.indexOf('$$') === 0) {
        if (t.length > 2 && t.indexOf('$$', 2) === t.length - 2) {
          endOfBlock = i;          // single-line $$...$$
          i = i + 1;
        } else {
          var k = i + 1;
          while (k < lines.length && lines[k].trim() !== '$$') { k++; }
          endOfBlock = k < lines.length ? k : -1;
          i = k + 1;
        }
      } else {
        i++;
        continue;
      }
      if (endOfBlock < 0) { continue; }
      var blanks = 0;
      var p = endOfBlock + 1;
      while (p < lines.length && lines[p].trim() === '') { blanks++; p++; }
      // Blank lines at the very end of the file separate nothing and cannot
      // survive a round-trip, so leave them alone.
      if (p >= lines.length) { blanks = 0; }
      // One blank paragraph serialises to *three* blank lines (Lute writes the
      // block's own line end plus two separators around the paragraph), so the
      // conversion back is: every two extra blank lines = one blank paragraph.
      // Anything in between (e.g. exactly two blank lines) cannot be represented
      // and gets normalised to one — a rounding inherent to Markdown.
      runs.push(blanks > 1 ? Math.floor((blanks - 1) / 2) : 0);
    }
    return runs;
  }

  // Put those blank paragraphs back into the freshly rendered document.
  // Blocks are matched in document order, which is the same order Vditor renders
  // them in, so no fragile text matching is needed.
  function restoreBlankParagraphs(md) {
    var runs;
    try { runs = blankRunsAfterBlocks(md); } catch (_) { return 0; }
    if (!runs.length) { return 0; }
    var root = editorHost ? editorHost.querySelector('pre.vditor-reset') : null;
    if (!root) { return 0; }
    var blocks = root.querySelectorAll('[data-type="code-block"], [data-type="math-block"]');
    var added = 0;
    for (var i = 0; i < runs.length && i < blocks.length; i++) {
      var need = runs[i];
      if (!need) { continue; }
      var anchor = topLevelOf(blocks[i]);
      if (!anchor || !anchor.parentNode) { continue; }
      // Reuse any blank paragraph Vditor already placed there, then top up.
      var ref = anchor.nextSibling;
      var have = 0;
      var scan = ref;
      while (scan && scan.nodeType === 1 && isBlankParagraph(scan)) { have++; scan = scan.nextSibling; }
      for (var k = have; k < need; k++) {
        anchor.parentNode.insertBefore(makeBlankParagraph(), ref);
        added++;
      }
    }
    if (added) { console.log('[blanks] restored ' + added + ' blank line(s)'); }
    return added;
  }

  // Enter on a blank line should create *another* blank line, because in Typora a
  // "blank line" IS a paragraph (each paragraph keeps one empty line before and
  // after it in the source). Vditor instead swallows the empty paragraph, which
  // also drops the two extra blank lines that it stands for in the file.
  // Returns true when the keystroke was handled here.
  function blankLineEnter(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) { return false; }
    var caret = caretElement();
    if (!caret || !caret.closest || !caret.closest('.vditor')) { return false; }
    var p = caret.closest('p');
    if (!p) { return false; }
    // Only ordinary top-level paragraphs: lists, quotes, tables and code all have
    // their own Enter semantics and must not be touched.
    if (p.closest('[data-type="code-block"], [data-type="math-block"], blockquote, li, td, th')) { return false; }
    if (String(p.textContent || '').trim()) { return false; }
    e.preventDefault();
    e.stopPropagation();
    setTimeout(function () {
      var anchor = topLevelOf(p);
      if (!anchor || !anchor.parentNode) { return; }
      var next = makeBlankParagraph();
      anchor.parentNode.insertBefore(next, anchor.nextSibling);
      placeCaret(next);
      requestAnimationFrame(function () {
        if (next.isConnected) { placeCaret(next); }
        queueUpdate();
      });
    }, 0);
    return true;
  }

  function onExitBlockKeydown(e) {
    if (composing) { return; }
    if (blankLineEnter(e)) { return; }
    var keys = parseExitKeys(config.exitBlockKeys);
    if (!keys.length) { return; }
    if (!isExitKey(e, keys)) { return; }
    var target = exitTarget(e.target);
    if (!target) { return; }
    console.log('[exit] jumped out of ' + target.kind + ' block');
    e.preventDefault();
    e.stopPropagation();
    leaveExitBlock(target);
  }

  var exitDocBound = false;

  function bindExitBlock() {
    if (exitDocBound) { return; }
    exitDocBound = true;
    // Bound on document, in the capture phase: Vditor renders a code block as a
    // textarea that it may re-parent, so listening on our editor element alone
    // could miss the keystroke entirely.
    document.addEventListener('keydown', onExitBlockKeydown, true);
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
  // Set while we click Vditor's own code-block button, so the click is not
  // intercepted again (which used to reopen the language dialog forever).
  var insertingCode = false;

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
    // Lute parses a trailing newline as one more (empty) body row, which used to
    // add a row the user never asked for. Keep it only when there is no body row
    // at all: without it that text would not parse as a table.
    var tail = body ? '' : '\n';
    var md = (savedBlockEmpty ? '' : '\n\n') + head + '\n' + sep + body + tail;
    var content = '';
    try { content = rawValue(); } catch (_) { /* ignore */ }
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
    try { after = rawValue(); } catch (_) { /* ignore */ }
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

  function codeButtonOf(target) {
    if (!target || !target.closest) { return null; }
    return target.closest('.vditor-toolbar [data-type="code"]');
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
      if (tableButtonOf(e.target) || codeButtonOf(e.target)) { rememberCaret(); }
    }, true);
    // Capture phase + stopPropagation keeps Vditor's own handler from running
    // before we have had a chance to ask for the parameters it needs.
    editorHost.addEventListener('click', function (e) {
      var item = tableButtonOf(e.target);
      if (item) {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        if (tableAnchor === item) { hideTablePicker(); return; }  // click again = toggle off
        showTablePicker(item);
        return;
      }
      // The code-block button asks for a language first (see showLangInsertDialog) —
      // unless we are the ones clicking it to actually insert the block.
      if (!insertingCode && codeButtonOf(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        showLangInsertDialog();
      }
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

  // ---- right-click menus ---------------------------------------------------
  // Vditor opens its block / table / image panels on hover, all through the same
  // floating .vditor-panel, which is far too easy to trigger by accident — they
  // are hidden unless typoraMd.showBlockPanel is on. Right-clicking is the way in
  // instead: one element renders whichever menu fits what was clicked. Table
  // actions are delegated to Vditor's own buttons so the table-editing logic
  // stays in exactly one place; image actions are handled here.
  var ctxMenuEl = null;
  var ctxMenuKind = null;
  var ctxMenuTarget = null;
  var ctxDocBound = false;

  var TABLE_MENU = [
    { label: '在上方插入行', action: 'insertRow', index: 0, accel: '⇧⌘F' },
    { label: '在下方插入行', action: 'insertRow', index: 1, accel: '⌘=' },
    { label: '在左侧插入列', action: 'insertColumn', index: 0, accel: '⇧⌘G' },
    { label: '在右侧插入列', action: 'insertColumn', index: 1, accel: '⇧⌘=' },
    { sep: true },
    { label: '删除行', action: 'deleteRow', accel: '⌘-' },
    { label: '删除列', action: 'deleteColumn', accel: '⇧⌘-' },
    { sep: true },
    { label: '左对齐', action: 'left', accel: '⇧⌘L' },
    { label: '居中', action: 'center', accel: '⇧⌘C' },
    { label: '右对齐', action: 'right', accel: '⇧⌘R' },
    { sep: true },
    { label: '删除表格', action: 'remove', accel: '' }
  ];

  var IMAGE_MENU = [
    { label: '编辑图片信息…', action: 'editImage' },
    { label: '复制图片路径', action: 'copyImagePath' },
    { sep: true },
    { label: '删除图片', action: 'removeImage', accel: '⇧⌘X' }
  ];

  var CODE_MENU = [
    { label: '编辑代码语言…', action: 'editLanguage' },
    { label: '复制代码', action: 'copyCode' },
    { sep: true },
    { label: '删除代码块', action: 'removeCode' }
  ];

  // Vditor reuses the block panel for table actions; the table one is the panel
  // that carries an insertRow button.
  function tableActionPanel() {
    var panels = document.querySelectorAll('.vditor-panel');
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].querySelector('button[data-type="insertRow"]')) { return panels[i]; }
    }
    return null;
  }

  function ctxMenuItems(kind) {
    if (kind === 'image') { return IMAGE_MENU; }
    if (kind === 'code') { return CODE_MENU; }
    return TABLE_MENU;
  }

  function buildCtxMenu(kind) {
    var items = ctxMenuItems(kind);
    var el = document.createElement('div');
    el.id = 'tp-ctx-menu';
    el.setAttribute('data-tp-kind', kind);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.sep) {
        var sep = document.createElement('div');
        sep.className = 'tp-cm-sep';
        el.appendChild(sep);
        continue;
      }
      var row = document.createElement('div');
      row.className = 'tp-cm-item';
      row.setAttribute('data-action', item.action);
      if (item.index !== undefined) { row.setAttribute('data-index', String(item.index)); }
      row.innerHTML = '<span class="tp-cm-label">' + item.label + '</span>' +
        (item.accel ? '<span class="tp-cm-accel">' + item.accel + '</span>' : '');
      el.appendChild(row);
    }
    // mousedown (not click): preventDefault keeps the caret where the user
    // right-clicked, which Vditor needs to resolve the target row/column.
    el.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var row = e.target && e.target.closest ? e.target.closest('.tp-cm-item') : null;
      if (!row) { return; }
      var idx = row.getAttribute('data-index');
      var action = row.getAttribute('data-action');
      var kind2 = el.getAttribute('data-tp-kind');
      var target = ctxMenuTarget;
      hideCtxMenu();
      // Run on the next tick: Vditor's own mousedown handling runs after ours,
      // and clicking its button synchronously can otherwise be swallowed.
      setTimeout(function () {
        ctxMenuTarget = target;
        if (kind2 === 'image') { runImageAction(action); }
        else if (kind2 === 'code') { runCodeAction(action); }
        else { runTableAction(action, idx === null ? undefined : parseInt(idx, 10)); }
      }, 0);
    });
    document.body.appendChild(el);
    return el;
  }

  function showCtxMenu(kind, target, x, y) {
    if (ctxMenuEl && ctxMenuKind !== kind) { ctxMenuEl.remove(); ctxMenuEl = null; }
    if (!ctxMenuEl) { ctxMenuEl = buildCtxMenu(kind); ctxMenuKind = kind; }
    ctxMenuTarget = target;
    ctxMenuEl.style.display = 'block';
    var w = ctxMenuEl.offsetWidth;
    var h = ctxMenuEl.offsetHeight;
    ctxMenuEl.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    ctxMenuEl.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
  }

  function hideCtxMenu() {
    if (ctxMenuEl) { ctxMenuEl.style.display = 'none'; }
  }

  // ---- image info dialog ---------------------------------------------------
  // Vditor's own image strip (图片地址 / 替代文本 / 标题) is hidden with the
  // other floating panels, so its job moves here.
  var imgDialogEl = null;
  var imgDialogTarget = null;

  function dialogField(el, field) {
    var input = el.querySelector('input[data-field="' + field + '"]');
    return input ? input.value : '';
  }

  function imageDialog() {
    if (imgDialogEl) { return imgDialogEl; }
    var el = document.createElement('div');
    el.id = 'tp-img-dialog';
    el.innerHTML =
      '<div class="tp-dlg-title">图片信息</div>' +
      '<label class="tp-dlg-row"><span>地址</span>' +
      '<input class="tp-dlg-input" data-field="src" placeholder="media/image.png"></label>' +
      '<label class="tp-dlg-row"><span>替代文本</span>' +
      '<input class="tp-dlg-input" data-field="alt" placeholder="图片加载失败时显示，建议填写"></label>' +
      '<label class="tp-dlg-row"><span>标题</span>' +
      '<input class="tp-dlg-input" data-field="title" placeholder="鼠标悬停时显示，可留空"></label>' +
      '<div class="tp-dlg-actions">' +
      '<button type="button" class="tp-dlg-btn" data-act="cancel">取消</button>' +
      '<button type="button" class="tp-dlg-btn tp-dlg-btn--primary" data-act="ok">确定</button>' +
      '</div>';
    // Keep the editor's selection (and Vditor's state) untouched while the dialog
    // is on screen — but inputs must still be able to take focus, so only block
    // the default action for non-editable targets.
    el.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      var t = e.target;
      if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) { e.preventDefault(); }
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); hideImageDialog(); }
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
        e.preventDefault();
        applyImageDialog();
      }
    });
    el.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.tp-dlg-btn') : null;
      if (!btn) { return; }
      if (btn.getAttribute('data-act') === 'ok') { applyImageDialog(); } else { hideImageDialog(); }
    });
    document.body.appendChild(el);
    imgDialogEl = el;
    return el;
  }

  function showImageDialog(img) {
    var el = imageDialog();
    imgDialogTarget = img;
    // data-tp-src holds the markdown-facing path; the src attribute is a
    // vscode-webview-resource: URL and must never be shown to the user.
    var src = img.getAttribute('data-tp-src') || img.getAttribute('src') || '';
    var alt = img.getAttribute('alt') || '';
    var title = img.getAttribute('title') || '';
    el.querySelector('input[data-field="src"]').value = src;
    el.querySelector('input[data-field="alt"]').value = alt;
    el.querySelector('input[data-field="title"]').value = title;
    el.style.display = 'block';
    el.style.left = Math.max(12, (window.innerWidth - el.offsetWidth) / 2) + 'px';
    el.style.top = Math.max(12, Math.min(window.innerHeight * 0.22, window.innerHeight - el.offsetHeight - 12)) + 'px';
    var first = el.querySelector('input[data-field="src"]');
    if (first) { first.focus(); first.select(); }
  }

  function hideImageDialog() {
    if (imgDialogEl) { imgDialogEl.style.display = 'none'; }
    imgDialogTarget = null;
  }

  function applyImageDialog() {
    var img = imgDialogTarget;
    var el = imgDialogEl;
    if (!img || !el) { return; }
    var src = dialogField(el, 'src').trim();
    var alt = dialogField(el, 'alt');
    var title = dialogField(el, 'title').trim();
    hideImageDialog();
    if (!src) { return; }
    // Reset the localisation so a new path gets resolved (and remembered) again.
    img.dataset.tpLocal = '';
    img.dataset.tpSrc = src;
    img.__typoraLocal = false;
    img.setAttribute('src', src);
    img.setAttribute('alt', alt);
    // The title lives on a data attribute while editing (see parkImageTitle).
    img.removeAttribute('title');
    if (title) { img.dataset.tpTitle = title; } else { delete img.dataset.tpTitle; }
    localizeImage(img);
    queueUpdate();
  }

  function runImageAction(action) {
    var img = ctxMenuTarget;
    if (!img || img.tagName !== 'IMG') { return; }
    if (action === 'editImage') { showImageDialog(img); return; }
    if (action === 'copyImagePath') {
      var path = img.getAttribute('data-tp-src') || img.getAttribute('src') || '';
      if (navigator.clipboard && path) {
        navigator.clipboard.writeText(path).catch(function () { /* ignore */ });
      }
      return;
    }
    if (action === 'removeImage') {
      if (img.parentNode) { img.parentNode.removeChild(img); }
      queueUpdate();
    }
  }

  // ---- code block actions ---------------------------------------------------
  // Vditor's language box lives in the floating panel that is hidden by default,
  // so the fenced block's language is edited from here instead.
  var langDialogEl = null;
  var langDialogTarget = null;
  var langDialogBound = false;
  var langDialogMode = 'edit';   // 'edit' (right-click) | 'insert' (toolbar button)

  var QUICK_LANGS = ['js', 'ts', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp',
    'php', 'ruby', 'swift', 'kotlin', 'sql', 'json', 'yaml', 'html', 'css',
    'scss', 'bash', 'powershell', 'markdown'];

  // A fenced block holds two <code> elements: the hidden source view
  // (.vditor-wysiwyg__pre) and the rendered one (.vditor-wysiwyg__preview).
  // Vditor serialises the hidden one, so the language must be read from and
  // written to both.
  function codeElements(code) {
    var block = code && code.closest ? code.closest('[data-type="code-block"]') : null;
    var list = block ? block.querySelectorAll('code') : null;
    return (list && list.length) ? list : [code];
  }

  function languageOf(code) {
    var block = code && code.closest ? code.closest('[data-type="code-block"]') : null;
    var src = block ? block.querySelector('.vditor-wysiwyg__pre code') : null;
    var m = ((src || code).className || '').toString().match(/language-([^\s]+)/);
    return m ? m[1] : '';
  }

  function setCodeLanguage(target, lang) {
    var codes = codeElements(target);
    for (var i = 0; i < codes.length; i++) {
      var rest = (codes[i].className || '').toString().replace(/\blanguage-[^\s]*\s*/g, '').trim();
      codes[i].className = lang ? (rest ? rest + ' language-' + lang : 'language-' + lang) : rest;
    }
    relightCode(target, lang);
  }

  function codeBlockAtCaret() {
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) { return null; }
      var n = sel.getRangeAt(0).startContainer;
      var el = n && n.nodeType === 1 ? n : (n ? n.parentNode : null);
      return el && el.closest ? el.closest('[data-type="code-block"]') : null;
    } catch (_) { return null; }
  }

  function langDialog() {
    if (langDialogEl) { return langDialogEl; }
    var el = document.createElement('div');
    el.id = 'tp-lang-dialog';
    var quick = '';
    for (var q = 0; q < QUICK_LANGS.length; q++) {
      quick += '<button type="button" class="tp-cp-chip" data-lang="' + QUICK_LANGS[q] + '">' + QUICK_LANGS[q] + '</button>';
    }
    el.innerHTML =
      '<div class="tp-dlg-title">代码语言</div>' +
      '<div class="tp-cp-quick">' + quick + '</div>' +
      '<label class="tp-dlg-row"><span>语言</span>' +
      '<input class="tp-dlg-input" data-field="lang" placeholder="js / python / json…，留空为纯文本"></label>' +
      '<div class="tp-dlg-actions">' +
      '<button type="button" class="tp-dlg-btn" data-act="cancel">取消</button>' +
      '<button type="button" class="tp-dlg-btn tp-dlg-btn--primary" data-act="ok">确定</button>' +
      '</div>';
    // mousedown only: the click / keydown handling is delegated on document, and
    // is registered right here so it cannot be lost to binding order.
    el.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      var t = e.target;
      if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) { e.preventDefault(); }
    });
    document.body.appendChild(el);
    langDialogEl = el;
    if (!langDialogBound) {
      langDialogBound = true;
      document.addEventListener('click', function (e) {
        if (!langDialogEl || langDialogEl.style.display !== 'block') { return; }
        var t = e.target;
        if (!t || !t.closest || !langDialogEl.contains(t)) { return; }
        var chip = t.closest('.tp-cp-chip');
        if (chip) {
          // A quick chip applies straight away.
          var input = langDialogEl.querySelector('input[data-field="lang"]');
          if (input) { input.value = chip.getAttribute('data-lang'); }
          applyLangDialog();
          return;
        }
        var btn = t.closest('.tp-dlg-btn');
        if (!btn) { return; }
        if (btn.getAttribute('data-act') === 'ok') { applyLangDialog(); } else { hideLangDialog(); }
      }, true);
      document.addEventListener('keydown', function (e) {
        if (!langDialogEl || langDialogEl.style.display !== 'block') { return; }
        if (e.key === 'Escape') { hideLangDialog(); return; }
        if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && langDialogEl.contains(e.target)) {
          e.preventDefault();
          applyLangDialog();
        }
      });
    }
    return el;
  }

  function placeLangDialog(el) {
    el.style.display = 'block';
    el.style.left = Math.max(12, (window.innerWidth - el.offsetWidth) / 2) + 'px';
    el.style.top = Math.max(12, Math.min(window.innerHeight * 0.22, window.innerHeight - el.offsetHeight - 12)) + 'px';
  }

  function showLangDialog(code) {
    var el = langDialog();
    langDialogMode = 'edit';
    langDialogTarget = code;
    el.querySelector('.tp-dlg-title').textContent = '代码语言';
    el.querySelector('input[data-field="lang"]').value = languageOf(code);
    placeLangDialog(el);
    var first = el.querySelector('input[data-field="lang"]');
    if (first) { first.focus(); first.select(); }
  }

  // Asked for by the toolbar's code-block button, which used to insert a bare
  // fence with no way to pick a language.
  function showLangInsertDialog() {
    var el = langDialog();
    langDialogMode = 'insert';
    langDialogTarget = null;
    el.querySelector('.tp-dlg-title').textContent = '插入代码块';
    el.querySelector('input[data-field="lang"]').value = '';
    placeLangDialog(el);
    var first = el.querySelector('input[data-field="lang"]');
    if (first) { first.focus(); }
  }

  function hideLangDialog() {
    var el = langDialogEl || document.getElementById('tp-lang-dialog');
    if (el) { el.style.display = 'none'; }
    langDialogTarget = null;
  }

  function applyLangDialog() {
    var el = langDialogEl || document.getElementById('tp-lang-dialog');
    if (!el) { return; }
    var lang = dialogField(el, 'lang').trim().replace(/^language-/, '');
    var mode = langDialogMode;
    var target = langDialogTarget;
    hideLangDialog();
    if (mode === 'insert') { insertCodeBlockWithLang(lang); return; }
    if (!target) { return; }
    setCodeLanguage(target, lang);
    queueUpdate();
  }

  // Inserting Markdown fences via insertValue mangles the surrounding paragraph,
  // so let Vditor's own button create the block and only pick the language here.
  function insertCodeBlockWithLang(lang) {
    var native = document.querySelector('.vditor-toolbar [data-type="code"]');
    if (!native) { queueUpdate(); return; }
    if (savedRange) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      } catch (_) { /* ignore */ }
    }
    insertingCode = true;
    try {
      native.click();
    } finally {
      insertingCode = false;
    }
    if (!lang) { queueUpdate(); return; }
    setTimeout(function () {
      var block = codeBlockAtCaret();
      if (block) { setCodeLanguage(block, lang); }
      queueUpdate();
    }, 0);
  }

  // Vditor only highlights at render time, so a language change would not show
  // until the file was reopened. Re-run highlight.js over the rendered copy
  // ourselves. The hidden source view is left as plain text on purpose — that is
  // what Vditor serialises back to Markdown.
  function relightCode(code, lang) {
    var codes = codeElements(code);
    for (var i = 0; i < codes.length; i++) {
      var el = codes[i];
      if (!el.closest || !el.closest('.vditor-wysiwyg__preview')) { continue; }
      if (lang && window.hljs && window.hljs.highlightElement) {
        try { window.hljs.highlightElement(el); } catch (_) { /* ignore */ }
      } else {
        // Plain text: drop the highlight markup and the hljs marker.
        el.textContent = el.textContent;
        el.className = (el.className || '').toString().replace(/\bhljs\b\s*/g, '').trim();
      }
    }
  }

  function runCodeAction(action) {
    var code = ctxMenuTarget;
    if (!code || code.tagName !== 'CODE') { return; }
    if (action === 'editLanguage') { showLangDialog(code); return; }
    if (action === 'copyCode') {
      var text = code.textContent || '';
      if (navigator.clipboard && text) {
        navigator.clipboard.writeText(text).catch(function () { /* ignore */ });
      }
      return;
    }
    if (action === 'removeCode') {
      var block = code.closest('[data-type="code-block"]') || code;
      if (block.parentNode) { block.parentNode.removeChild(block); }
      queueUpdate();
    }
  }

  function runTableAction(action, index, attempt) {
    var td = ctxMenuTarget;
    if (!td || !vditor) { return; }
    // Vditor works out which row/column to touch from the selection alone, and
    // both right-clicking and clicking the menu can leave it elsewhere, so put
    // the caret back in the cell every time. Note: do NOT call focus() here — it
    // resets the selection we just set.
    try {
      var range = document.createRange();
      range.selectNodeContents(td);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { /* ignore */ }
    var panel = tableActionPanel();
    if (!panel) {
      // Vditor builds the panel lazily on the first table interaction; give it a
      // few ticks to appear before giving up.
      if ((attempt || 0) < 6) {
        setTimeout(function () { runTableAction(action, index, (attempt || 0) + 1); }, 80);
      } else {
        console.error('[frontend] table action panel not available: ' + action);
      }
      return;
    }
    var btns = panel.querySelectorAll('button[data-type="' + action + '"]');
    var btn = index === undefined ? btns[0] : btns[index];
    if (btn) {
      btn.click();
    } else {
      console.error('[frontend] table action button not found: ' + action + '#' + index);
    }
    queueUpdate();
  }

  function bindCtxMenu() {
    if (!editorHost || editorHost.dataset.tpCtxBound === '1') { return; }
    editorHost.dataset.tpCtxBound = '1';
    editorHost.addEventListener('contextmenu', function (e) {
      var t = e.target;
      var img = t && t.closest ? t.closest('img') : null;
      // Block-level code only: an inline <code> is not inside a code-block wrapper.
      var code = null;
      if (t && t.closest) {
        var codeEl = t.closest('code');
        if (codeEl && codeEl.closest('[data-type="code-block"]')) { code = codeEl; }
      }
      var cell = t && t.closest ? t.closest('td, th') : null;
      if (img) {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu('image', img, e.clientX, e.clientY);
        return;
      }
      if (code) {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu('code', code, e.clientX, e.clientY);
        return;
      }
      if (cell) {
        e.preventDefault();
        e.stopPropagation();
        // Place the caret where the user right-clicked: preventDefault() above
        // stops the browser from doing it, and Vditor resolves the target row /
        // column from the selection.
        try {
          var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
          if (r) {
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
        } catch (_) { /* ignore */ }
        showCtxMenu('table', cell, e.clientX, e.clientY);
        return;
      }
      hideCtxMenu();
    }, true);
    if (ctxDocBound) { return; }
    ctxDocBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!ctxMenuEl || ctxMenuEl.style.display !== 'block') { return; }
      var t = e.target;
      if (t && t.closest && t.closest('#tp-ctx-menu')) { return; }
      hideCtxMenu();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideCtxMenu(); hideImageDialog(); hideLangDialog(); }
    });
    window.addEventListener('blur', hideCtxMenu);
  }

  function syncContent(content) {
    if (!vditor) { return; }
    if (rawValue() === content) { return; }
    // remember scroll? simplest: replace without disturbing focus
    var el = editorHost ? editorHost.querySelector('.vditor-ir, .vditor-wysiwyg') : null;
    var prev = el ? el.scrollTop : 0;
    try {
      vditor.setValue(content, true);
    } catch (err) { /* ignore */ }
    if (el) { el.scrollTop = prev; }
    // Lute collapses runs of blank lines when it parses; put the author's blank
    // lines back so a save/reload cycle stops eating them.
    restoreBlankParagraphs(content);
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
        config.showBlockPanel = payload.showBlockPanel === true;
        if (typeof payload.exitBlockKeys === 'string') { config.exitBlockKeys = payload.exitBlockKeys; }
        if (typeof payload.exitBlockScope === 'string') { config.exitBlockScope = payload.exitBlockScope; }
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
          if (msg.config.showBlockPanel !== undefined) { config.showBlockPanel = msg.config.showBlockPanel; }
          if (typeof msg.config.exitBlockKeys === 'string') { config.exitBlockKeys = msg.config.exitBlockKeys; }
          if (typeof msg.config.exitBlockScope === 'string') { config.exitBlockScope = msg.config.exitBlockScope; }
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
