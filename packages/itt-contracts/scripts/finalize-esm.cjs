// Publish the explicit browser modules with their local ESM dependency.
const fs = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../dist');
fs.copyFileSync(path.join(dist, 'esm-build/human-output.js'), path.join(dist, 'human-output.mjs'));
fs.writeFileSync(path.join(dist, 'run-inputs.mjs'), fs.readFileSync(path.join(dist, 'esm-build/run-inputs.js'), 'utf8').replace("'./human-output'", "'./human-output.mjs'"));
fs.copyFileSync(path.join(dist, 'esm-build/ai-selection.js'), path.join(dist, 'ai-selection.mjs'));
fs.rmSync(path.join(dist, 'esm-build'), {recursive: true, force: true});
