import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolved appearance for the editor: the overall chrome theme Vditor understands
 * ('classic' | 'dark'), the content-theme file name and the highlight.js style.
 */
export interface ResolvedTheme {
  dark: boolean;
  chromeTheme: 'classic' | 'dark';
  contentTheme: 'light' | 'dark';
  codeTheme: 'github' | 'github-dark';
}

export function resolveTheme(themeSetting: string, kind?: vscode.ColorThemeKind): ResolvedTheme {
  let dark: boolean;
  switch (themeSetting) {
    case 'dark':
      dark = true;
      break;
    case 'light':
      dark = false;
      break;
    default: {
      const colorKind = kind ?? vscode.window.activeColorTheme.kind;
      dark = colorKind === vscode.ColorThemeKind.Dark || colorKind === vscode.ColorThemeKind.HighContrast;
    }
  }
  const cfg = vscode.workspace.getConfiguration('typoraMd');
  const codeThemeSetting = cfg.get<string>('codeTheme', 'auto');
  const codeTheme: ResolvedTheme['codeTheme'] =
    codeThemeSetting === 'auto' ? (dark ? 'github-dark' : 'github') : (codeThemeSetting as ResolvedTheme['codeTheme']);
  return {
    dark,
    chromeTheme: dark ? 'dark' : 'classic',
    contentTheme: dark ? 'dark' : 'light',
    codeTheme,
  };
}

/** Sent from the extension host to a freshly created webview. */
export interface InitPayload {
  content: string;
  cdn: string;
  docDirFs: string;
  docDirWebview: string;
  mode: string;
  theme: ResolvedTheme;
  showToolbar: boolean;
  autoSave: boolean;
}

/** A markdown link click resolved by the host so local paths can be opened. */
async function openLink(
  doc: vscode.TextDocument,
  href: string,
  column: vscode.ViewColumn | undefined
): Promise<void> {
  const trimmed = (href || '').trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const target = vscode.Uri.parse(trimmed);
    const isHttp = target.scheme === 'http' || target.scheme === 'https';
    if (isHttp) {
      void vscode.env.openExternal(target);
      return;
    }
    void vscode.commands.executeCommand('vscode.open', target);
    return;
  }
  if (doc.uri.scheme !== 'file') {
    return;
  }
  const target = vscode.Uri.file(path.resolve(path.dirname(doc.uri.fsPath), decodeURI(trimmed)));
  try {
    const stat = await vscode.workspace.fs.stat(target);
    if (stat.type === vscode.FileType.Directory) {
      await vscode.commands.executeCommand('revealInExplorer', target);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', target, {
      viewColumn: column ?? vscode.ViewColumn.Active,
      preview: true,
    });
  } catch {
    vscode.window.showWarningMessage(`[Typora] Could not open link: ${trimmed}`);
  }
}

export class TyporaEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly output: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Diagnostic log channel: the webview forwards console/heartbeat messages
    // here so failures are visible in View > Output > "Typora Markdown" without
    // needing Webview Developer Tools.
    this.output = vscode.window.createOutputChannel('Typora Markdown');
    context.subscriptions.push(this.output);
  }

  private log(msg: string): void {
    this.output.appendLine(msg);
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const { webview } = webviewPanel;
    this.log(`[resolve] ${document.uri.toString()} (${document.getText().length} chars)`);
    const extRoot = this.context.extensionUri;
    const mediaDir = vscode.Uri.joinPath(extRoot, 'media');

    const vditorRoot = vscode.Uri.joinPath(mediaDir, 'vditor');
    const vditorCss = webview.asWebviewUri(vscode.Uri.joinPath(vditorRoot, 'dist', 'index.css'));
    const vditorJs = webview.asWebviewUri(vscode.Uri.joinPath(vditorRoot, 'dist', 'index.min.js'));
    // Vditor's "ant" icon set is injected as an SVG <symbol> sprite at runtime by
    // js/icons/ant.js. We preload it in the HTML so the sprite exists before the
    // toolbar renders (toolbar <use> refs would otherwise stay blank).
    const vditorIconsJs = webview.asWebviewUri(
      vscode.Uri.joinPath(vditorRoot, 'dist', 'js', 'icons', 'ant.js')
    );
    const wysiwygCss = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'wysiwyg.css'));
    const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'main.js'));
    const cdn = webview.asWebviewUri(vditorRoot).toString();

    // Local images inside the same folder as the markdown are whitelisted so the
    // webview may render them.
    let docDirFs = '';
    let docDirWebview = '';
    const localRoots: vscode.Uri[] = [extRoot];
    if (document.uri.scheme === 'file') {
      docDirFs = path.dirname(document.uri.fsPath);
      docDirWebview = webview.asWebviewUri(vscode.Uri.file(docDirFs)).toString();
      localRoots.push(vscode.Uri.file(docDirFs));
    }

    const cfg = vscode.workspace.getConfiguration('typoraMd');
    const themeSetting = cfg.get<string>('theme', 'auto');
    const syncDelayMs = cfg.get<number>('syncDelayMs', 250);
    // Editing mode may be switched at runtime; switching reloads the webview.
    let currentMode = cfg.get<string>('mode', 'ir');

    webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots,
    };

    webview.html = buildHtml({
      webview,
      vditorCss: vditorCss.toString(),
      vditorJs: vditorJs.toString(),
      vditorIconsJs: vditorIconsJs.toString(),
      wysiwygCss: wysiwygCss.toString(),
      mainJs: mainJs.toString(),
    });
    this.log('[resolve] webview html set');

    let isDisposed = false;
    let updateCounter = 0;
    let applyTimer: NodeJS.Timeout | undefined;
    let pendingContent: string | undefined;

    const post = (msg: unknown): void => {
      if (!isDisposed) {
        void webviewPanel.webview.postMessage(msg);
      }
    };

    const currentTheme = (): ResolvedTheme => resolveTheme(themeSetting);

    const sendInit = (): void => {
      // Read the live configuration so a rebuild (mode switch → reload) gets the
      // latest mode/theme/toolbar/autoSave instead of stale resolve-time values.
      const cfgNow = vscode.workspace.getConfiguration('typoraMd');
      const payload: InitPayload = {
        content: document.getText(),
        cdn,
        docDirFs,
        docDirWebview,
        mode: cfgNow.get<string>('mode', 'ir'),
        theme: resolveTheme(cfgNow.get<string>('theme', 'auto')),
        showToolbar: cfgNow.get<boolean>('showToolbar', true),
        autoSave: cfgNow.get<boolean>('autoSave', false),
      };
      post({ type: 'init', payload });
    };

    // Write-through of the whole document (debounced) so the file always matches
    // what the user sees. VS Code keeps the document "dirty" until it is saved.
    const applyPending = async (): Promise<void> => {
      if (applyTimer) {
        clearTimeout(applyTimer);
        applyTimer = undefined;
      }
      if (pendingContent === undefined) {
        return;
      }
      const next = pendingContent;
      pendingContent = undefined;
      const current = document.getText();
      if (next === current) {
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      const end = document.positionAt(current.length);
      edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), next);
      try {
        await vscode.workspace.applyEdit(edit);
        const autoSaveNow = vscode.workspace.getConfiguration('typoraMd').get<boolean>('autoSave', false);
        if (autoSaveNow && document.isDirty) {
          await document.save();
        }
      } catch {
        vscode.window.showErrorMessage('[Typora] Failed to write changes back to the file.');
      }
    };

    webviewPanel.webview.onDidReceiveMessage(
      (msg) => {
        switch (msg.type) {
          case 'ready':
            // The webview script posts `ready` as soon as it loads (not after
            // Vditor is built), so we respond with `init`. We only init once per
            // editor: a second `ready` from Vditor's `after` must not rebuild the
            // editor. (Previously the host waited for a `ready` that only fired
            // after Vditor was built, while Vditor itself waited for `init` —
            // a deadlock that left the editor permanently blank.)
            // The webview script posts `ready` on every (re)load. We respond with
            // a fresh `init` each time — no one-shot guard here, because a mode
            // switch rebuilds the page and that rebuild needs its own `init`.
            this.log('[host] sending init');
            sendInit();
            break;
          case 'update': {
            if (typeof msg.content !== 'string') {
              return;
            }
            updateCounter++;
            if (updateCounter === 1 || updateCounter % 200 === 0) {
              this.log(`[host] update #${updateCounter} len=${msg.content.length}`);
            }
            pendingContent = msg.content;
            if (applyTimer) {
              clearTimeout(applyTimer);
            }
            applyTimer = setTimeout(() => {
              void applyPending();
            }, syncDelayMs);
            break;
          }
          case 'flush':
            void applyPending();
            break;
          case 'save':
            void (async () => {
              await applyPending();
              if (document.isDirty) {
                await document.save();
              }
            })();
            break;
          case 'openLink':
            void openLink(document, typeof msg.href === 'string' ? msg.href : '', webviewPanel.viewColumn);
            break;
          case 'log':
            this.log(`[webview/${msg.level ?? 'log'}] ${typeof msg.text === 'string' ? msg.text : String(msg)}`);
            break;
          case 'ping':
            // Heartbeat from the webview; if it stops arriving the main thread is
            // busy/blocked. Log sparsely to keep the channel readable.
            if (typeof msg.n === 'number' && msg.n % 15 === 0) {
              this.log(`[hb] webview alive (ping #${msg.n})`);
            }
            break;
          default:
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );

    // External change: a real content change on a *clean* document means the file
    // changed on disk / through another editor (our own edits keep it dirty).
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (e.contentChanges.length === 0 || e.document.isDirty) {
        return;
      }
      const text = e.document.getText();
      if (text !== pendingContent) {
        post({ type: 'sync', content: text });
      }
    });

    // Live theme switching (no editor recreation needed).
    const themeKindSub = vscode.window.onDidChangeActiveColorTheme(() => {
      post({ type: 'theme', theme: currentTheme() });
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('typoraMd')) {
        return;
      }
      const cfgNow = vscode.workspace.getConfiguration('typoraMd');
      const newMode = cfgNow.get<string>('mode', 'ir');
      const theme = resolveTheme(cfgNow.get<string>('theme', 'auto'));
      const showToolbar = cfgNow.get<boolean>('showToolbar', true);
      const autoSave = cfgNow.get<boolean>('autoSave', false);
      const modeChanged = newMode !== currentMode;
      if (modeChanged) {
        currentMode = newMode;
        this.log(`[host] config: mode -> ${newMode} (webview rebuilds in place)`);
      }
      // Flush pending edits, then hand the full settings to the webview. The
      // webview rebuilds in place for a mode change; other settings apply live.
      void (async () => {
        await applyPending();
        post({ type: 'config', config: { mode: newMode, theme, showToolbar, autoSave } });
      })();
    });

    const focusSub = vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) {
        void applyPending();
      }
    });

    webviewPanel.onDidDispose(() => {
      this.log('[host] editor disposed');
      isDisposed = true;
      if (applyTimer) {
        clearTimeout(applyTimer);
        applyTimer = undefined;
      }
      if (pendingContent !== undefined) {
        const next = pendingContent;
        pendingContent = undefined;
        if (next !== document.getText()) {
          const edit = new vscode.WorkspaceEdit();
          const end = document.positionAt(document.getText().length);
          edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), end), next);
          void vscode.workspace.applyEdit(edit);
        }
      }
      changeSub.dispose();
      themeKindSub.dispose();
      configSub.dispose();
      focusSub.dispose();
    });
  }
}

function buildHtml(opts: {
  webview: vscode.Webview;
  vditorCss: string;
  vditorJs: string;
  vditorIconsJs: string;
  wysiwygCss: string;
  mainJs: string;
}): string {
  const csp = [
    "default-src 'none'",
    `img-src ${opts.webview.cspSource} data: blob: https: http:`,
    `style-src ${opts.webview.cspSource} 'unsafe-inline'`,
    `font-src ${opts.webview.cspSource} data:`,
    `script-src ${opts.webview.cspSource}`,
    // Vditor loads Lute/KaTeX/icons dynamically; some paths use fetch/XHR or a
    // Web Worker. Blocking those (connect-src 'none', no worker-src) left a
    // blank editor, so allow local resources plus standard http(s) fallbacks.
    `worker-src ${opts.webview.cspSource} blob:`,
    `connect-src ${opts.webview.cspSource} https: http:`,
    `media-src ${opts.webview.cspSource} data: https: http:`,
    "object-src 'none'",
    "frame-src 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Typora Markdown</title>
<link rel="stylesheet" href="${opts.vditorCss}">
<link rel="stylesheet" href="${opts.wysiwygCss}">
<style>
  /* Avoid an unstyled flash: reveal the page only once Vditor finished building. */
  html, body, #app { height: 100%; margin: 0; padding: 0; }
  #app { opacity: 0; }
  body[data-typora-ready="1"] #app { opacity: 1; }
</style>
</head>
<body data-typora-ready="0">
  <div id="app"><div id="vditor"></div></div>
  <script src="${opts.vditorIconsJs}"></script>
  <script src="${opts.vditorJs}"></script>
  <script src="${opts.mainJs}"></script>
</body>
</html>`;
}
