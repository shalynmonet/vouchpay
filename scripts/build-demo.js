// Builds dist/demo.html: one self-contained file that runs fully in the browser with simulated payouts.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('public/index.html');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + read('public/styles.css') + '\n</style>');
html = html.replace('<script src="engine.js"></script>', () => '<script>\n' + read('src/engine.js') + '\n</script>');
html = html.replace('<script src="app.js"></script>', () => '<script>\n' + read('public/app.js') + '\n</script>');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'demo.html'), html);
console.log('Wrote dist/demo.html (' + Math.round(html.length / 1024) + ' KB)');
