# 🔪 Debug Slicer

**Isolate, debug, and safely edit specific code paths in massive codebases.**

Debug Slicer is a VS Code extension designed to cure "file fatigue." When working with files containing thousands of lines of code, tracking down a specific function, its callers, and related variables can be overwhelming.

Debug Slicer allows you to select a symbol, instantly extract *only* the relevant code blocks into a clean "Sandbox" file, edit them in isolation with **Live Sync**, and safely choose to keep or discard your changes.

---

## 🎯 Purpose

The primary purpose of Debug Slicer is to **reduce cognitive load during manual debugging and refactoring.** Instead of scrolling up and down a 3,000-line file trying to remember how `functionA` interacts with `functionB`, Debug Slicer extracts both functions, places them side-by-side in a temporary sandbox, and hides the 2,900 lines of irrelevant noise. It gives you a surgically precise view of your code's execution path.

## 🛠️ Use Cases

* **Targeted Debugging:** You are tracing a bug in a specific utility function. Use Debug Slicer to extract the function and every place it is called within the file. Add your `console.log`s or breakpoints in the clean sandbox without losing your place.
* **Safe Refactoring:** You need to change a function's signature. Extract the function and all its references. Update the signature and fix all the callers in one unified, clutter-free view.
* **Code Comprehension (Legacy Code):** You are exploring a massive, poorly documented legacy file. Click on a confusing variable or class, slice it out, and immediately see exactly where and how it is manipulated.
* **Experimentation:** Try out a risky change in the Sandbox. If it breaks, simply hit "Discard" to revert the original file to its exact pristine state.

## 🔭 Scope & Features

Debug Slicer leverages VS Code's native Language Server Protocol (LSP) to understand your code's structure, making it incredibly robust.

* **Smart Context Extraction:** It doesn't just copy single lines; it intelligently finds the boundaries of the enclosing Functions, Methods, or Classes so you get the full context.
* **Auto-Merging:** If a function and its reference are right next to each other, Debug Slicer automatically merges them into a single continuous block to prevent duplicates.
* **⚡ Live Sync Engine:** When enabled, any edits made in the Sandbox are instantly applied to the original file in the background. Our custom "Shift Calculus" engine perfectly tracks line additions and deletions so the files stay perfectly mirrored.
* **Safe Discard:** Made a mess? The extension keeps a pristine backup of the original text in memory. One click restores your file exactly as it was before you started slicing.
* **Universal Language Support:** Sandboxes are generated using dynamic comment separators tailored to your file type. Whether you are using `/* */` in TypeScript, `#` in Python, or `` in HTML, the sandbox remains syntax-error-free.

---

## 🚀 How to Use

1. **Analyze:** Place your cursor on any variable, function, or class. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`Debug Slicer: Analyze Symbol`**.
2. **Review:** A side panel will open showing all files containing references or definitions for that symbol.
3. **Slice:** Click **"Slice File into Sandbox ⚡"** on a file card. A new temporary file will open containing only the relevant code blocks separated by ✂️ markers.
4. **Edit & Sync:** Run **`Debug Slicer: Toggle Live Sync`** (or use your custom keybinding). Start editing the sandbox! The original file will update automatically.
5. **Finalize:**
* Run **`Debug Slicer: Apply Sandbox`** to close the sandbox and keep all your changes.
* Run **`Debug Slicer: Discard Sandbox`** to close the sandbox and revert the original file to its original state.



---

## ⌨️ Commands

| Command                                       Description |

 `debug-slicer.analyze` - Analyzes the symbol under the cursor and opens  the Webview panel. 
 `debug-slicer.toggleLiveSync` - Toggles the background syncing of edits from the sandbox to the original file. 
 `debug-slicer.applySandbox` - Keeps all synced changes and cleans up the sandbox session. 
 `debug-slicer.discardSandbox` - Reverts all affected regions in the original file and closes the sandbox. 

*Tip: We highly recommend binding `debug-slicer.toggleLiveSync` to a keyboard shortcut like `Ctrl+Alt+S` in your VS Code settings for rapid toggling!*

---

## 🌍 Supported Languages

Because Debug Slicer relies on the Language Server Protocol (LSP) for structural boundary detection, it works best with languages that have full extension support in VS Code.

**Tier 1 (Full Support):**

* TypeScript / JavaScript
* Java
* Python
* C# / C++
* Go
* Rust
* HTML / XML / CSS / PHP

**Fallback Mode:**
If a language does not provide exact symbol boundaries, Debug Slicer gracefully falls back to extracting a 9-line chunk (4 lines above and below the reference) to ensure you still get the context you need.

---

## ⚠️ Important Notes

* **Do not delete the `✂️ --- DEBUG SLICE --- ✂️` separators** in the sandbox file. The extension relies on these to map your edits back to the correct locations in the original file. If you accidentally delete one, simply use `Undo` (`Ctrl+Z`) to restore it.

---

### Would you like me to help you format the `package.json` file so these commands and their titles show up cleanly in the VS Code Command Palette?