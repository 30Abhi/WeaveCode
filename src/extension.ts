import * as vscode from 'vscode';

// -----------------------------------------------------------------------------
// TYPES & STATE
// -----------------------------------------------------------------------------

type RegionMapping = {
	id: string; // e.g. "region_0"
	originalRange: { startLine: number; endLine: number }; // The current position in the live original file
	originalContent: string; // The pristine backup text for discarding
};

type SandboxMapping = {
	originalUri: string;
	regions: RegionMapping[];
	isLive: boolean;
	debounce: ReturnType<typeof setTimeout> | null;
	backupUri?: vscode.Uri;
	mutex: boolean;
};

const sandboxMap = new Map<string, SandboxMapping>();
const SEPARATOR_REGEX = /\/\* ✂️ --- DEBUG SLICE: (region_\d+) --- ✂️ \*\/\r?\n/g;

// -----------------------------------------------------------------------------
// CORE ACTIVATION
// -----------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
	console.log('DEBUG SLICER: Multi-Region Edition Activated');

	const analyzeCmd = vscode.commands.registerCommand('debug-slicer.analyze', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open a file and place the cursor on a symbol.');
			return;
		}

		const position = editor.selection.active;
		const uri = editor.document.uri;

		const defs = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, position)) || [];
		const refs = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position)) || [];

		// Group findings by File Path
		const mapByFile = new Map<string, { uri: string; fsPath: string; lines: Set<number> }>();
		const addLoc = (loc: vscode.Location) => {
			if (!loc.uri) return;
			const key = loc.uri.toString();
			if (!mapByFile.has(key)) {
				mapByFile.set(key, { uri: key, fsPath: loc.uri.fsPath, lines: new Set() });
			}
			mapByFile.get(key)!.lines.add(loc.range.start.line);
		};

		defs.forEach(addLoc);
		refs.forEach(addLoc);

		// Convert Map to array and sort the lines
		const fileGroups = Array.from(mapByFile.values()).map(g => ({
			uri: g.uri,
			fsPath: g.fsPath,
			lines: Array.from(g.lines).sort((a, b) => a - b)
		}));

		const panel = vscode.window.createWebviewPanel('debugSlicer', 'Debug Slicer', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
		panel.webview.html = buildWebviewHtml(fileGroups);

		panel.webview.onDidReceiveMessage(async msg => {
			if (msg.command === 'openFileSandbox') {
				await openUnifiedSandbox(msg.uri, msg.lines, context);
			}
		});
	});

	// Apply sandbox (accept)
	const applySandboxCmd = vscode.commands.registerCommand('debug-slicer.applySandbox', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const docUriStr = editor.document.uri.toString();
		const mapping = sandboxMap.get(docUriStr);
		if (!mapping) {
			vscode.window.showInformationMessage('Not a registered sandbox.');
			return;
		}

		vscode.window.showInformationMessage('Changes kept. Cleaning up sandbox...');
		if (mapping.backupUri) {
			try { await vscode.workspace.fs.delete(mapping.backupUri); } catch (e) { }
		}
		sandboxMap.delete(docUriStr);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	// Discard sandbox
	const discardSandboxCmd = vscode.commands.registerCommand('debug-slicer.discardSandbox', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const docUriStr = editor.document.uri.toString();
		const mapping = sandboxMap.get(docUriStr);
		if (!mapping) return;

		try {
			const originalUri = vscode.Uri.parse(mapping.originalUri);
			const originalDoc = await vscode.workspace.openTextDocument(originalUri);
			const edit = new vscode.WorkspaceEdit();

			// Restore all original backup texts using current ranges
			for (const region of mapping.regions) {
				const replaceRange = new vscode.Range(region.originalRange.startLine, 0, region.originalRange.endLine, originalDoc.lineAt(Math.min(region.originalRange.endLine, originalDoc.lineCount - 1)).text.length);
				edit.replace(originalUri, replaceRange, region.originalContent);
			}

			await vscode.workspace.applyEdit(edit);
			await originalDoc.save();

			if (mapping.backupUri) {
				try { await vscode.workspace.fs.delete(mapping.backupUri); } catch (e) { }
			}

			sandboxMap.delete(docUriStr);
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			vscode.window.showInformationMessage('Sandbox discarded. All segments reverted.');
		} catch (e) {
			vscode.window.showErrorMessage('Error discarding: ' + e);
		}
	});

	const toggleLiveSyncCmd = vscode.commands.registerCommand('debug-slicer.toggleLiveSync', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const docUriStr = editor.document.uri.toString();
		const mapping = sandboxMap.get(docUriStr);
		if (!mapping) return;

		mapping.isLive = !mapping.isLive;
		vscode.window.showInformationMessage(mapping.isLive ? 'Live Sync Enabled.' : 'Live Sync Disabled.');
	});

	const changeListener = vscode.workspace.onDidChangeTextDocument(async (e) => {
		const doc = e.document;
		if (doc.isUntitled !== true) return;

		const mapping = sandboxMap.get(doc.uri.toString());
		if (!mapping || !mapping.isLive) return;

		if (mapping.debounce) clearTimeout(mapping.debounce);
		mapping.debounce = setTimeout(async () => {
			if (mapping.mutex) return;
			mapping.mutex = true;
			try {
				await applySandboxSegmentsToOriginal(mapping, doc);
			} catch (err) {
				console.error('Sync error:', err);
			} finally {
				mapping.mutex = false;
			}
		}, 300);
	});

	context.subscriptions.push(analyzeCmd, applySandboxCmd, discardSandboxCmd, toggleLiveSyncCmd, changeListener);
}

// -----------------------------------------------------------------------------
// THE ENGINE LOGIC
// -----------------------------------------------------------------------------

async function openUnifiedSandbox(uriStr: string, targetLines: number[], context: vscode.ExtensionContext) {
	const targetUri = vscode.Uri.parse(uriStr);
	const origDoc = await vscode.workspace.openTextDocument(targetUri);

	// 1. Get Symbols to find exact boundaries
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', targetUri) || [];

	// 2. Map lines to exact symbol boundaries
	let ranges = targetLines.map(line => {
		const sym = findSymbolAtLine(symbols, line);
		if (sym) return { startLine: sym.range.start.line, endLine: sym.range.end.line };
		return { startLine: Math.max(0, line - 4), endLine: Math.min(origDoc.lineCount - 1, line + 4) };
	});

	// 3. MERGE OVERLAPPING RANGES (So we don't copy the same function twice)
	ranges.sort((a, b) => a.startLine - b.startLine);
	const mergedRanges: { startLine: number; endLine: number }[] = [];
	for (const r of ranges) {
		if (mergedRanges.length === 0) {
			mergedRanges.push(r);
		} else {
			const last = mergedRanges[mergedRanges.length - 1];
			// If they overlap or are very close (within 2 lines)
			if (r.startLine <= last.endLine + 2) {
				last.endLine = Math.max(last.endLine, r.endLine);
			} else {
				mergedRanges.push(r);
			}
		}
	}

	// 4. Generate the Unified Sandbox Content
	const regions: RegionMapping[] = [];
	let sandboxText = "";

	mergedRanges.forEach((range, idx) => {
		const id = `region_${idx}`;
		const startOffset = origDoc.offsetAt(new vscode.Position(range.startLine, 0));
		const endOffset = origDoc.offsetAt(new vscode.Position(range.endLine, origDoc.lineAt(range.endLine).text.length));
		const content = origDoc.getText().substring(startOffset, endOffset);

		regions.push({ id, originalRange: { ...range }, originalContent: content });
		sandboxText += `/* ✂️ --- DEBUG SLICE: ${id} --- ✂️ */\n${content}\n\n`;
	});

	// 5. Create Sandbox
	const untitledDoc = await vscode.workspace.openTextDocument({ content: sandboxText, language: origDoc.languageId });
	await vscode.window.showTextDocument(untitledDoc, { preview: false });

	// 6. Register Session
	const docKey = untitledDoc.uri.toString();
	sandboxMap.set(docKey, { originalUri: targetUri.toString(), regions, isLive: false, debounce: null, mutex: false });

	vscode.window.showInformationMessage(`Sandbox created with ${regions.length} segments. Toggle Live Sync to begin editing.`);
}

async function applySandboxSegmentsToOriginal(mapping: SandboxMapping, sandboxDoc: vscode.TextDocument) {
	const sandboxText = sandboxDoc.getText();
	const parts = sandboxText.split(SEPARATOR_REGEX);

	// Parts array structure: [0: junk before first separator, 1: "region_0", 2: "code...", 3: "region_1", 4: "code..."]
	const parsedCodeBlocks = new Map<string, string>();

	for (let i = 1; i < parts.length; i += 2) {
		const regionId = parts[i];
		let code = parts[i + 1];
		// Strip the trailing double newline we added during generation to prevent file bloat
		code = code.replace(/\r?\n\r?\n$/, '');
		parsedCodeBlocks.set(regionId, code);
	}

	// Guard: Ensure user didn't accidentally delete a separator
	if (parsedCodeBlocks.size !== mapping.regions.length) {
		vscode.window.showErrorMessage("Live Sync Error: A ✂️ separator was deleted. Undo your last action to restore it.");
		return;
	}

	const originalUri = vscode.Uri.parse(mapping.originalUri);
	const originalDoc = await vscode.workspace.openTextDocument(originalUri);
	const edit = new vscode.WorkspaceEdit();

	// Build the bulk edit using CURRENT ranges
	for (const region of mapping.regions) {
		const newCode = parsedCodeBlocks.get(region.id)!;
		const endLine = Math.min(region.originalRange.endLine, originalDoc.lineCount - 1);
		const replaceRange = new vscode.Range(region.originalRange.startLine, 0, endLine, originalDoc.lineAt(endLine).text.length);
		edit.replace(originalUri, replaceRange, newCode);
	}

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) return;

	await originalDoc.save();

	// ---------------------------------------------------
	// THE SHIFT CALCULUS: Update line numbers for NEXT time
	// ---------------------------------------------------
	let currentShift = 0;
	for (const region of mapping.regions) {
		const newCode = parsedCodeBlocks.get(region.id)!;
		const newCodeLineCount = newCode.split(/\r?\n/).length;
		const oldLineCount = (region.originalRange.endLine - region.originalRange.startLine) + 1;

		// Apply any cumulative shifts from regions above this one
		region.originalRange.startLine += currentShift;
		region.originalRange.endLine = region.originalRange.startLine + newCodeLineCount - 1;

		// Calculate the difference this specific region caused to pass down the chain
		currentShift += (newCodeLineCount - oldLineCount);
	}
}

// Helper: Find exact symbol boundary (UPGRADED for Functions/Classes)
function findSymbolAtLine(symbols: vscode.DocumentSymbol[], targetLine: number): vscode.DocumentSymbol | undefined {
	let bestMatch: vscode.DocumentSymbol | undefined = undefined;

	// We only want to extract large structural blocks, not single variable lines
	const validContainers = [
		vscode.SymbolKind.Function,
		vscode.SymbolKind.Method,
		vscode.SymbolKind.Class,
		vscode.SymbolKind.Constructor
	];

	for (const symbol of symbols) {
		// Check if the target line falls anywhere inside this symbol
		if (symbol.range.start.line <= targetLine && symbol.range.end.line >= targetLine) {

			// If this is a Function/Method/Class, mark it as our best guess
			if (validContainers.includes(symbol.kind)) {
				bestMatch = symbol;
			}

			// Keep digging to see if there is a nested function (like a callback inside a function)
			if (symbol.children && symbol.children.length > 0) {
				const childMatch = findSymbolAtLine(symbol.children, targetLine);

				// Only overwrite our best match if the child was ALSO a valid container 
				// (This ignores small variables inside the function)
				if (childMatch && validContainers.includes(childMatch.kind)) {
					bestMatch = childMatch;
				}
			}

			// Return the enclosing function/class. 
			// Fallback to the raw symbol if it's not inside a function (e.g., a global variable)
			return bestMatch || symbol;
		}
	}
	return undefined;
}

export function deactivate() {
	sandboxMap.clear();
}

// -----------------------------------------------------------------------------
// WEBVIEW HTML (Updated for File Grouping)
// -----------------------------------------------------------------------------

function buildWebviewHtml(fileGroups: { uri: string; fsPath: string; lines: number[] }[]) {
	const dataJson = JSON.stringify(fileGroups);

	return `<!doctype html>
<html>
<head>
  <style>
    body{ font-family: sans-serif; padding: 12px; }
    .file-card { border: 1px solid #444; padding: 10px; margin-bottom: 12px; border-radius: 6px; background: #1e1e1e; color: #d4d4d4;}
    .file-title { font-weight: bold; margin-bottom: 8px; font-size: 14px; word-break: break-all; }
    .badge { background: #007acc; color: white; padding: 2px 6px; border-radius: 10px; font-size: 11px; margin-left: 6px;}
    button { background: #0e639c; color: white; border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; width: 100%;}
    button:hover { background: #1177bb; }
  </style>
</head>
<body>
  <h2>Debug Slicer Results</h2>
  <p style="font-size: 12px; color: #888;">Select a file to slice out all its relevant components.</p>
  <div id="container"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const fileGroups = ${dataJson};
    const container = document.getElementById('container');

    if (fileGroups.length === 0) {
        container.innerHTML = '<i>No usages found.</i>';
    } else {
        fileGroups.forEach(group => {
            const div = document.createElement('div');
            div.className = 'file-card';
            
            const title = document.createElement('div');
            title.className = 'file-title';
            // Show only the file name, not full path, for cleaner UI
            const fileName = group.fsPath.split(/[\\\\/]/).pop(); 
            title.innerHTML = \`\${fileName} <span class="badge">\${group.lines.length} refs</span>\`;
            
            const btn = document.createElement('button');
            btn.textContent = 'Slice File into Sandbox ⚡';
            btn.onclick = () => vscode.postMessage({ command: 'openFileSandbox', uri: group.uri, lines: group.lines });
            
            div.appendChild(title);
            div.appendChild(btn);
            container.appendChild(div);
        });
    }
  </script>
</body>
</html>`;
}