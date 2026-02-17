import * as vscode from 'vscode';

/**
 * Debug Slicer extension with sandbox + live-sync support
 *
 * Commands (IDs used in this file; add them to package.json contributes.commands if you want them in the palette):
 * - debug-slicer.analyze
 * - debug-slicer.applySandbox
 * - debug-slicer.discardSandbox
 * - debug-slicer.toggleLiveSync
 *
 * Behavior:
 * - "Open in Sandbox" opens an untitled doc with a snippet, registers a mapping (with a backup of original content).
 * - Toggle Live Sync: when enabled, changes in the sandbox get debounced and written to the original file on disk (and saved).
 * - Apply Sandbox: copy the sandbox content to original, save and cleanup backup.
 * - Discard Sandbox: restore original content from the backup and cleanup.
 */

type SandboxMapping = {
	originalUri: string;
	originalRange: { startLine: number; endLine: number };
	originalContent: string; // exact original range content (backup)
	isLive: boolean;
	debounce: ReturnType<typeof setTimeout> | null;
	backupUri?: vscode.Uri; // persisted backup path
	mutex: boolean;
};

const sandboxMap = new Map<string, SandboxMapping>();

/**
 * Recursively searches through document symbols to find the smallest symbol 
 * (function, class, etc.) that completely contains the target line.
 */
function findSymbolAtLine(symbols: vscode.DocumentSymbol[], targetLine: number): vscode.DocumentSymbol | undefined {
	for (const symbol of symbols) {
		// Check if the target line falls inside this symbol's range
		if (symbol.range.start.line <= targetLine && symbol.range.end.line >= targetLine) {
			// Check if there's a smaller child symbol inside this one that also matches
			if (symbol.children && symbol.children.length > 0) {
				const childMatch = findSymbolAtLine(symbol.children, targetLine);
				if (childMatch) {
					return childMatch; // Return the more specific inner symbol
				}
			}
			return symbol; // If no children match, return this symbol
		}
	}
	return undefined;
}

export function activate(context: vscode.ExtensionContext) {
	// Register Analyze command (existing functionality)
	const analyzeCmd = vscode.commands.registerCommand('debug-slicer.analyze', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open a file and place the cursor on a symbol before running Debug Slicer.');
			return;
		}

		const position = editor.selection.active;
		const uri = editor.document.uri;

		// Get definitions (may be empty)
		const defs = (await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeDefinitionProvider',
			uri,
			position
		)) || [];

		// Get references (may include definitions too)
		const refs = (await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeReferenceProvider',
			uri,
			position
		)) || [];

		// Map to a serializable structure for webview
		const defsSerializable = defs
			.filter(loc => !!loc && !!(loc as any).uri)
			.map(loc => ({
				uri: loc.uri.toString(),
				fsPath: loc.uri.fsPath,
				line: loc.range.start.line,
				character: loc.range.start.character
			}));

		const refsSerializable = refs
			.filter(loc => !!loc && !!(loc as any).uri)
			.map(loc => ({
				uri: loc.uri.toString(),
				fsPath: loc.uri.fsPath,
				line: loc.range.start.line,
				character: loc.range.start.character
			}));

		// Create webview panel
		const panel = vscode.window.createWebviewPanel(
			'debugSlicer',
			'Debug Slicer',
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		panel.webview.html = buildWebviewHtml(defsSerializable, refsSerializable);

		// Handle messages from webview
		panel.webview.onDidReceiveMessage(async msg => {
			try {
				if (msg.command === 'open') {
					const targetUri = vscode.Uri.parse(msg.uri);
					const doc = await vscode.workspace.openTextDocument(targetUri);
					const ed = await vscode.window.showTextDocument(doc, { preview: false });
					const pos = new vscode.Position(msg.line || 0, msg.character || 0);
					ed.selection = new vscode.Selection(pos, pos);
					ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				} else if (msg.command === 'openInSandbox') {

					// 1) prepare snippet and originalContent backup
					// 2) open untitled doc with snippet
					// 3) store mapping keyed by untitledDoc.uri
					const targetUri = vscode.Uri.parse(msg.uri);
					const origDoc = await vscode.workspace.openTextDocument(targetUri);
					const targetLine = Math.max(0, (msg.line || 0));
					let startLine = targetLine;
					let endLine = targetLine;

						// 1. Ask VS Code for the structure of the document
					const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
						'vscode.executeDocumentSymbolProvider',
						targetUri
					);

					if (symbols && symbols.length > 0) {
						// 2. Find the specific function/class the user clicked on
						// console.log("Symbols-> ",symbols)
						const matchingSymbol = findSymbolAtLine(symbols, targetLine);

						if (matchingSymbol) {
							startLine = matchingSymbol.range.start.line;
							endLine = matchingSymbol.range.end.line;
						} else {
							// Fallback if no symbol is found (e.g., plain text)
							startLine = Math.max(0, targetLine - 10);
							endLine = Math.min(origDoc.lineCount - 1, targetLine + 10);
						}
					} else {
						// Fallback if the language doesn't support symbols
						startLine = Math.max(0, targetLine - 10);
						endLine = Math.min(origDoc.lineCount - 1, targetLine + 10);
					}


					const snippetLines: string[] = [];
					for (let i = startLine; i <= endLine; i++) {
						snippetLines.push(origDoc.lineAt(i).text);
					}
					const snippet = snippetLines.join('\n');

					// Compute original content backup BEFORE creating the untitled doc
					const originalText = origDoc.getText();
					const originalRangeStartOffset = origDoc.offsetAt(new vscode.Position(startLine, 0));
					const originalRangeEndOffset = origDoc.offsetAt(new vscode.Position(endLine, origDoc.lineAt(endLine).text.length));
					const originalContent = originalText.substring(originalRangeStartOffset, originalRangeEndOffset);

					// 2️⃣ Create sandbox document (untitled)
					const languageId = origDoc.languageId || undefined;
					const untitledDoc = await vscode.workspace.openTextDocument({ content: snippet, language: languageId });
					await vscode.window.showTextDocument(untitledDoc, { preview: false });

					// 3️⃣ Register mapping using the real untitledDoc.uri
					sandboxMap.set(untitledDoc.uri.toString(), {
						originalUri: targetUri.toString(),
						originalRange: { startLine, endLine },
						originalContent,
						isLive: false,
						debounce: null,
						backupUri: undefined,
						mutex: false
					});

					// Persist backup to storage (recoverable if VS Code crashes)
					try {
						const backupsDir = vscode.Uri.joinPath(context.globalStorageUri, 'backups');
						await vscode.workspace.fs.createDirectory(backupsDir);
						const safeName = encodeURIComponent(targetUri.fsPath).slice(0, 180) + '-' + Date.now() + '.bak';
						const backupUri = vscode.Uri.joinPath(backupsDir, safeName);
						await vscode.workspace.fs.writeFile(backupUri, Buffer.from(originalContent, 'utf8'));
						const mapping = sandboxMap.get(untitledDoc.uri.toString());
						if (mapping) mapping.backupUri = backupUri;
					} catch (err) {
						console.warn('Could not write backup:', err);
					}

					vscode.window.showInformationMessage('Sandbox opened. Edit freely. Use "Debug Slicer: Toggle Live Sync" to enable live sync, "Debug Slicer: Apply Sandbox" to write back or "Debug Slicer: Discard Sandbox" to drop it.');
				}
			} catch (e) {
				vscode.window.showErrorMessage('Debug Slicer error: ' + String(e));
			}
		});
	});

	// Apply sandbox (accept) - copies sandbox content to original and removes mapping/backup
	const applySandboxCmd = vscode.commands.registerCommand('debug-slicer.applySandbox', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open the sandbox (untitled) editor whose changes you want to apply, then run this command.');
			return;
		}
		const docUriStr = editor.document.uri.toString();
		const mapping = sandboxMap.get(docUriStr);
		if (!mapping) {
			vscode.window.showInformationMessage('This document is not a registered sandbox created by Debug Slicer.');
			return;
		}

		try {
			const originalUri = vscode.Uri.parse(mapping.originalUri);
			const originalDoc = await vscode.workspace.openTextDocument(originalUri);

			// compute replaceRange using mapping (clamp to current doc)
			const startLine = mapping.originalRange.startLine;
			const endLine = Math.min(mapping.originalRange.endLine, originalDoc.lineCount - 1);
			const replaceRange = new vscode.Range(startLine, 0, endLine, originalDoc.lineAt(endLine).text.length);

			const newText = editor.document.getText();
			const edit = new vscode.WorkspaceEdit();
			edit.replace(originalUri, replaceRange, newText);
			const applied = await vscode.workspace.applyEdit(edit);
			if (applied) {
				// save file to disk so dev server picks it up
				await (await vscode.workspace.openTextDocument(originalUri)).save();
				vscode.window.showInformationMessage('Sandbox changes applied to original file.');

				// cleanup backup
				if (mapping.backupUri) {
					try { await vscode.workspace.fs.delete(mapping.backupUri); } catch (e) { /* ignore delete errors */ }
				}

				// cleanup mapping and close sandbox
				sandboxMap.delete(docUriStr);
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			} else {
				vscode.window.showErrorMessage('Failed to apply edits to original file.');
			}
		} catch (e) {
			vscode.window.showErrorMessage('Error applying sandbox: ' + String(e));
		}
	});

	// Discard sandbox (restore original) - restores backup content to original file and removes mapping
	const discardSandboxCmd = vscode.commands.registerCommand('debug-slicer.discardSandbox', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open the sandbox document, then run Discard Sandbox.');
			return;
		}
		const docUriStr = editor.document.uri.toString();
		const mapping = sandboxMap.get(docUriStr);
		if (mapping) {
			try {
				const originalUri = vscode.Uri.parse(mapping.originalUri);
				const originalDoc = await vscode.workspace.openTextDocument(originalUri);

				const startLine = mapping.originalRange.startLine;
				const endLine = Math.min(mapping.originalRange.endLine, originalDoc.lineCount - 1);
				const replaceRange = new vscode.Range(startLine, 0, endLine, originalDoc.lineAt(endLine).text.length);

				const edit = new vscode.WorkspaceEdit();
				edit.replace(originalUri, replaceRange, mapping.originalContent);
				await vscode.workspace.applyEdit(edit);
				await (await vscode.workspace.openTextDocument(originalUri)).save();

				// cleanup backup file on disk
				if (mapping.backupUri) {
					try { await vscode.workspace.fs.delete(mapping.backupUri); } catch (e) { /* ignore */ }
				}

				// cleanup mapping and close sandbox
				sandboxMap.delete(docUriStr);
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				vscode.window.showInformationMessage('Sandbox discarded and original file restored.');
			} catch (e) {
				vscode.window.showErrorMessage('Error discarding sandbox: ' + String(e));
			}
		} else {
			vscode.window.showInformationMessage('This document is not a registered sandbox created by Debug Slicer.');
		}
	});

	// Toggle Live Sync for current active sandbox editor
	const toggleLiveSyncCmd = vscode.commands.registerCommand('debug-slicer.toggleLiveSync', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open the sandbox (untitled) document to toggle Live Sync.');
			return;
		}
		const docUri = editor.document.uri.toString();
		const mapping = sandboxMap.get(docUri);
		if (!mapping) {
			vscode.window.showInformationMessage('This document is not a registered sandbox created by Debug Slicer.');
			return;
		}

		mapping.isLive = !mapping.isLive;
		if (mapping.isLive) {
			vscode.window.showInformationMessage('Live Sync enabled for this sandbox. Edits will be applied to original file.');
		} else {
			vscode.window.showInformationMessage('Live Sync disabled for this sandbox.');
		}
	});

	// Watch for sandbox document changes and apply to original if live sync is enabled
	// Watch for sandbox document changes and apply to original if live sync is enabled
	const changeListener = vscode.workspace.onDidChangeTextDocument(async (e) => {
		const doc = e.document;
		const docKey = doc.uri.toString();

		// Strict guard: only respond to untitled sandbox documents (prevents accidental triggers)
		// If you ever use a different scheme for sandboxes (e.g. 'file' with temp files), adjust this check.
		if (doc.isUntitled !== true) {
			// Not an untitled sandbox document: ignore
			return;
		}

		const mapping = sandboxMap.get(docKey);
		if (!mapping) return;             // no mapping for this untitled doc (not our sandbox)
		if (!mapping.isLive) return;      // live sync not enabled, do nothing

		// Debounce updates to avoid too many writes
		if (mapping.debounce) clearTimeout(mapping.debounce);
		mapping.debounce = setTimeout(async () => {
			if (mapping.mutex) return; // avoid overlapping syncs
			mapping.mutex = true;
			try {
				await applySandboxToOriginal(mapping, doc);
			} catch (err) {
				console.error('Live sync error:', err);
			} finally {
				mapping.mutex = false;
			}
		}, 250);
	});

	// Optional: cleanup or notify on close (we keep mapping so user can apply/discard later)
	const closeListener = vscode.workspace.onDidCloseTextDocument((doc) => {
		// We don't auto-discard. Keep mapping so user can re-open or run apply/discard commands.
		// Optionally, you may auto-discard here by calling discard logic.
	});

	context.subscriptions.push(analyzeCmd, applySandboxCmd, discardSandboxCmd, toggleLiveSyncCmd, changeListener, closeListener);
}

/**
 * Helper: Apply the sandbox text to the original file (used by live sync).
 * Does a full replace of the original recorded range with the sandbox text, then saves the original file.
 */
async function applySandboxToOriginal(mapping: SandboxMapping, sandboxDoc: vscode.TextDocument) {
	try {
		const originalUri = vscode.Uri.parse(mapping.originalUri);
		const originalDoc = await vscode.workspace.openTextDocument(originalUri);

		// compute replacement range (clamp endLine)
		const startLine = mapping.originalRange.startLine;
		const endLine = Math.min(mapping.originalRange.endLine, originalDoc.lineCount - 1);
		const replaceRange = new vscode.Range(startLine, 0, endLine, originalDoc.lineAt(endLine).text.length);

		const sandboxText = sandboxDoc.getText();
		const edit = new vscode.WorkspaceEdit();
		edit.replace(originalUri, replaceRange, sandboxText);

		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			vscode.window.showErrorMessage('Debug Slicer: failed to apply live edit to original file.');
			return;
		}

		// save file to disk so dev server picks it up
		await (await vscode.workspace.openTextDocument(originalUri)).save();

		// update stored endLine to reflect new snippet size (so future replaces use correct range)
		const snippetLineCount = sandboxText.split(/\r?\n/).length;
		mapping.originalRange.endLine = mapping.originalRange.startLine + snippetLineCount - 1;
	} catch (err) {
		console.error('applySandboxToOriginal error:', err);
		vscode.window.showErrorMessage('Debug Slicer live-sync error: ' + String(err));
	}
}

export function deactivate() {
	sandboxMap.clear();
}

/**
 * Build a simple webview HTML rendering definitions & references lists.
 * Each item has "Open" and "Open in Sandbox" actions.
 */
function buildWebviewHtml(defs: { uri: string; fsPath: string; line: number; character: number }[], refs: { uri: string; fsPath: string; line: number; character: number }[]) {
	const defsJson = JSON.stringify(defs);
	const refsJson = JSON.stringify(refs);

	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';">
  <style>
    body{ font-family: sans-serif; padding: 12px; }
    h2 { margin: 8px 0 6px 0; }
    .item { margin:6px 0; display:flex; align-items:center; gap:8px; }
    .path { color:#0066cc; cursor:pointer; text-decoration:underline; }
    button { margin-left:8px; }
    .section { border: 1px solid #ddd; padding:8px; margin-bottom:10px; border-radius:6px; }
    .small { color:#666; font-size:12px; }
  </style>
</head>
<body>
  <h1>Debug Slicer</h1>

  <div class="section">
    <h2>Definitions (${defs.length})</h2>
    <div id="defs"></div>
  </div>

  <div class="section">
    <h2>References (${refs.length})</h2>
    <div id="refs"></div>
  </div>

  <p class="small">Tip: To edit a snippet and then apply it back to the original file, click "Open in Sandbox". After editing the sandbox, use "Debug Slicer: Toggle Live Sync" to enable live-sync, "Debug Slicer: Apply Sandbox" to accept changes, or "Debug Slicer: Discard Sandbox" to restore original content.</p>

  <script>
    const vscode = acquireVsCodeApi();
    const defs = ${defsJson};
    const refs = ${refsJson};

    function createEntry(el, it) {
      const div = document.createElement('div');
      div.className = 'item';
      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = it.fsPath + ':' + (it.line + 1);
      path.onclick = () => vscode.postMessage({ command: 'open', uri: it.uri, line: it.line, character: it.character });

      const sandboxBtn = document.createElement('button');
      sandboxBtn.textContent = 'Open in Sandbox';
      sandboxBtn.onclick = () => vscode.postMessage({ command: 'openInSandbox', uri: it.uri, line: it.line, character: it.character });

      div.appendChild(path);
      div.appendChild(sandboxBtn);
      el.appendChild(div);
    }

    const defsDiv = document.getElementById('defs');
    if (defs.length === 0) defsDiv.innerHTML = '<i>No definitions found.</i>';
    else defs.forEach(d => createEntry(defsDiv, d));

    const refsDiv = document.getElementById('refs');
    if (refs.length === 0) refsDiv.innerHTML = '<i>No references found.</i>';
    else refs.forEach(r => createEntry(refsDiv, r));
  </script>
</body>
</html>`;
}