// Post-build script to ensure VS Code can find the exports
const fs = require('fs');
const path = require('path');

const extensionPath = path.join(__dirname, 'dist', 'extension.js');
let content = fs.readFileSync(extensionPath, 'utf8');

// Add direct exports at the end of the file, after all functions are defined
const fixExports = `
// Fix exports for VS Code compatibility
if (typeof activate === 'function' && typeof deactivate === 'function') {
  const currentExports = module.exports;
  // Ensure direct access to activate and deactivate
  if (currentExports && currentExports.__esModule) {
    // Keep the __esModule structure but ensure functions are accessible
    if (!currentExports.activate || typeof currentExports.activate !== 'function') {
      currentExports.activate = activate;
    }
    if (!currentExports.deactivate || typeof currentExports.deactivate !== 'function') {
      currentExports.deactivate = deactivate;
    }
  }
}
`;

// Insert before the source map comment
if (content.includes('//# sourceMappingURL')) {
  content = content.replace('//# sourceMappingURL', fixExports + '\n//# sourceMappingURL');
} else {
  content += fixExports;
}

fs.writeFileSync(extensionPath, content, 'utf8');
console.log('✓ Fixed exports for VS Code compatibility');
