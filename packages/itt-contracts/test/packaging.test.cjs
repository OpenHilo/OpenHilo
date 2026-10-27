const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');

test('published ESM modules contain no extensionless relative imports', () => {
    const dist = path.join(__dirname, '../dist');
    const modules = fs.readdirSync(dist).filter(file => file.endsWith('.mjs'));
    assert.deepEqual(modules.sort(), ['ai-selection.mjs', 'human-output.mjs', 'run-inputs.mjs']);
    for (const file of modules) {
        for (const [, target] of fs.readFileSync(path.join(dist, file), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]*)['"]/g)) {
            assert.match(target, /^\.\/[\w-]+\.mjs$/, `${file}: ${target}`);
            assert.ok(fs.existsSync(path.join(dist, target)), `${file}: ${target}`);
        }
    }
});

test('every workspace build removes stale dist output before compiling', () => {
    const clean = `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})" && `;
    for (const dir of JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces) {
        const {build} = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).scripts ?? {};
        if (build) assert.ok(build.startsWith(clean), `${dir}: ${build}`);
    }
});
