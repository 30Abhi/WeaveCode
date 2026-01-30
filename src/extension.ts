import * as vscode from 'vscode';

// Map untitled/sandbox document URI -> original location info
const sandboxMap = new Map<
	string,
	{ originalUri: string; originalRange: { startLine: number; endLine: number } }
>();


console.log("LOADED EXTENSION FILE");



export function activate(context: vscode.ExtensionContext) {
	try {
		// Main analyze command
		//   console.log("DEBUG SLICER ACTIVATED");
		console.log('DEBUG SLICER: activate() called');


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
						// Create an untitled doc containing a snippet around the requested line
						const targetUri = vscode.Uri.parse(msg.uri);
						const origDoc = await vscode.workspace.openTextDocument(targetUri);
						const targetLine = Math.max(0, (msg.line || 0));
						const startLine = Math.max(0, targetLine - 6);
						const endLine = Math.min(origDoc.lineCount - 1, targetLine + 30); // reasonable window

						const snippetLines = [];
						for (let i = startLine; i <= endLine; i++) {
							snippetLines.push(origDoc.lineAt(i).text);
						}
						const snippet = snippetLines.join('\n');

						// Open an untitled document with same language
						const languageId = origDoc.languageId || undefined;
						const untitledDoc = await vscode.workspace.openTextDocument({ content: snippet, language: languageId });
						const untitledEditor = await vscode.window.showTextDocument(untitledDoc, { preview: false });

						// Store mapping for apply/discard actions
						sandboxMap.set(untitledDoc.uri.toString(), {
							originalUri: targetUri.toString(),
							originalRange: { startLine, endLine }
						});

						vscode.window.showInformationMessage('Sandbox opened. Edit freely. Use "Debug Slicer: Apply Sandbox" to write back or "Debug Slicer: Discard Sandbox" to drop it.');
					}
				} catch (e) {
					vscode.window.showErrorMessage('Debug Slicer error: ' + String(e));
				}
			});
		});

		// Command to apply current active sandbox contents back to original file
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

				// Compute the original range to replace
				const startLine = mapping.originalRange.startLine;
				const endLine = Math.min(mapping.originalRange.endLine, originalDoc.lineCount - 1);
				const replaceRange = new vscode.Range(startLine, 0, endLine, originalDoc.lineAt(endLine).text.length);

				const newText = editor.document.getText();
				const edit = new vscode.WorkspaceEdit();
				edit.replace(originalUri, replaceRange, newText);
				const applied = await vscode.workspace.applyEdit(edit);
				if (applied) {
					// Save the file
					await (await vscode.workspace.openTextDocument(originalUri)).save();
					vscode.window.showInformationMessage('Sandbox changes applied to original file.');
					// Optionally close the sandbox editor
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
					sandboxMap.delete(docUriStr);
				} else {
					vscode.window.showErrorMessage('Failed to apply edits to original file.');
				}
			} catch (e) {
				vscode.window.showErrorMessage('Error applying sandbox: ' + String(e));
			}
		});

		// Command to discard sandbox (close and forget mapping)
		const discardSandboxCmd = vscode.commands.registerCommand('debug-slicer.discardSandbox', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage('Open the sandbox document, then run Discard Sandbox.');
				return;
			}
			const docUriStr = editor.document.uri.toString();
			if (sandboxMap.has(docUriStr)) {
				sandboxMap.delete(docUriStr);
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				vscode.window.showInformationMessage('Sandbox discarded.');
			} else {
				vscode.window.showInformationMessage('This document is not a registered sandbox created by Debug Slicer.');
			}
		});

		context.subscriptions.push(analyzeCmd, applySandboxCmd, discardSandboxCmd);
	} catch (e) {
		console.error("ACTIVATE FAILED", e);
		//   vscode.window.showErrorMessage(String(e));

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
    .item { margin:6px 0; }
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

  <p class="small">Tip: To edit a snippet and then apply it back to the original file, click "Open in Sandbox". After editing the sandbox, run the command "Debug Slicer: Apply Sandbox".</p>

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