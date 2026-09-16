import * as vscode from 'vscode';
import { TyporaEditorProvider } from './editor';

export const VIEW_TYPE = 'typoraMd.editor';

/** Files the user explicitly chose to view as plain markdown source. */
const sourceModeUris = new Set<string>();

function isMarkdownFile(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' && doc.uri.scheme === 'file';
}

function readConfig(): { autoOpen: boolean } {
  return { autoOpen: vscode.workspace.getConfiguration('typoraMd').get<boolean>('autoOpen', true) };
}

/** Re-open `uri` in the same-tab WYSIWYG (custom) editor. */
async function openInWysiwyg(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: column,
      preview: false,
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `[Typora] Could not open the WYSIWYG view: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new TyporaEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Explicit "open in WYSIWYG" (command, explorer/tab context menu, keybinding).
  context.subscriptions.push(
    vscode.commands.registerCommand('typoraMd.openWysiwyg', (uri?: vscode.Uri) => {
      if (uri) {
        void openInWysiwyg(uri);
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('[Typora] No active file to open.');
        return;
      }
      if (!isMarkdownFile(editor.document)) {
        vscode.window.showWarningMessage('[Typora] The active file is not a markdown file.');
        return;
      }
      void openInWysiwyg(editor.document.uri, editor.viewColumn);
    })
  );

  // Explicit "open as source": remember the choice so auto-open leaves it alone.
  context.subscriptions.push(
    vscode.commands.registerCommand('typoraMd.openAsText', async (uri?: vscode.Uri) => {
      let target = uri;
      if (!target) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('[Typora] No active file to open.');
          return;
        }
        target = editor.document.uri;
      }
      sourceModeUris.add(target.toString());
      await vscode.commands.executeCommand('vscode.open', target, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('typoraMd.setTheme', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Auto', description: 'Follow the active VS Code color theme', value: 'auto' },
          { label: 'Light', description: 'Light (paper) appearance', value: 'light' },
          { label: 'Dark', description: 'Dark appearance', value: 'dark' },
        ],
        { placeHolder: 'Pick the Typora editor theme' }
      );
      if (!pick) {
        return;
      }
      const cfg = vscode.workspace.getConfiguration('typoraMd');
      const current = cfg.get<string>('theme', 'auto');
      const target = current === pick.value ? 'auto' : pick.value;
      await cfg.update('theme', target, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('typoraMd.toggleToolbar', async () => {
      const cfg = vscode.workspace.getConfiguration('typoraMd');
      await cfg.update('showToolbar', !cfg.get<boolean>('showToolbar', true), vscode.ConfigurationTarget.Global);
    })
  );

  // ---- Auto-open -----------------------------------------------------------
  // When a markdown file is opened into a *text* tab and autoOpen is on (and the
  // user did not explicitly ask for source view), migrate that text tab IN PLACE to
  // the WYSIWYG (custom) editor: open the WYSIWYG view, then close the text tab it
  // replaced — so we get a single same-tab Typora-style editor, not a duplicate.
  //
  // We only ever flip while the file is actually visible as a *text* tab. Once it
  // lives in the WYSIWYG editor, or has no tab at all (e.g. right after the user
  // closed it), we do nothing — that is what stops the "close it and it instantly
  // reopens" loop.

  /** All text-editor tabs currently showing `uri`. */
  function textTabsFor(uri: vscode.Uri): vscode.Tab[] {
    const uriKey = uri.toString();
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriKey) {
          tabs.push(tab);
        }
      }
    }
    return tabs;
  }

  const pendingFlips = new Map<string, NodeJS.Timeout>();

  /** When one of our WYSIWYG tabs is closed, remember when (to detect "Reopen With…"). */
  const closedWysiwygTabs = new Map<string, number>();

  function scheduleFlip(doc: vscode.TextDocument): void {
    if (!isMarkdownFile(doc) || !readConfig().autoOpen) {
      return;
    }
    const key = doc.uri.toString();
    if (sourceModeUris.has(key)) {
      return;
    }
    const existing = pendingFlips.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    pendingFlips.set(
      key,
      setTimeout(() => {
        pendingFlips.delete(key);
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== key) {
          return;
        }
        // Only flip while the file is still open as a *text* tab. If it is already
        // in the WYSIWYG editor (no text tab), or the user closed it meanwhile,
        // there is nothing to migrate.
        if (textTabsFor(doc.uri).length === 0) {
          return;
        }
        void openInWysiwyg(doc.uri, editor.viewColumn).then(() => {
          // Close the text tab(s) the WYSIWYG view replaced, so we don't leave a
          // duplicate behind (best effort; if the user moved it meanwhile, keep it).
          for (const tab of textTabsFor(doc.uri)) {
            void vscode.window.tabGroups.close(tab);
          }
        });
      }, 120)
    );
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => scheduleFlip(doc)));

  // Auto-open is tied to a document *being opened*, NOT to the active editor
  // changing. Reacting to active-editor changes meant that picking another
  // editor via "Reopen Editor With…" (which activates a text editor) was
  // immediately overridden and the file flipped back to the WYSIWYG view,
  // ignoring the user's explicit choice.
  //
  // Belt and braces: if our editor tab is closed and the same file reappears as
  // a text tab right after, treat that as an explicit "view as source" choice.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      const now = Date.now();
      for (const tab of e.closed) {
        if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE) {
          closedWysiwygTabs.set(tab.input.uri.toString(), now);
        }
      }
      for (const tab of e.opened) {
        if (!(tab.input instanceof vscode.TabInputText)) {
          continue;
        }
        const key = tab.input.uri.toString();
        const closedAt = closedWysiwygTabs.get(key);
        if (closedAt !== undefined && now - closedAt < 2000) {
          closedWysiwygTabs.delete(key);
          sourceModeUris.add(key);
        }
      }
    })
  );

  // Markdown files already open when the extension activates.
  for (const doc of vscode.workspace.textDocuments) {
    scheduleFlip(doc);
  }

  // Clean up suppression entries when a document closes.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      sourceModeUris.delete(doc.uri.toString());
    })
  );
}

export function deactivate(): void {
  /* nothing to tear down */
}
