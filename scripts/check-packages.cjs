// Validate metadata and every public archive entry; never publish/install a package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

function checkPackageContents(manifest, files) {
    const required = ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'package.json', manifest.main, manifest.types,
        ...strings(manifest.exports), ...strings(manifest.typesVersions), ...strings(manifest.bin)].filter(Boolean);
    if (manifest.name === '@openhilo/code-local') required.push('dist/_itt_runner.py');
    if (required.some(file => file.includes('/esm/'))) required.push('dist/esm/package.json');
    for (const file of required) assert.ok(files.has(file.replace(/^\.\//, '')), `${manifest.name}: archive missing ${file.replace(/^\.\//, '')}`);
    for (const file of files) assert.ok(!/(^|\/)(node_modules|\.env(?:\.[^/]*)?|\.git|\.codex|\.claude)(\/|$)/.test(file), `${manifest.name}: unintended archive entry ${file}`);
}

function checkPackages(root, pack = false) {
    const directories = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).workspaces;
    const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    const temporary = pack ? fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-package-check-')) : undefined;
    try {
        const names = new Set();
        for (const folder of directories) {
            const dir = path.join(root, folder), manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
            assert.ok(manifest.name.startsWith('@openhilo/'));
            assert.ok(!names.has(manifest.name));
            names.add(manifest.name);
            assert.equal(manifest.private, true, `${folder}: release remains explicit`);
            assert.equal(manifest.license, 'MIT');
            assert.equal(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), license);
            // Check filesystem AND package contents; npm files filters may hide valid exports.
            const files = new Set();

            function walk(base, prefix = '') {
                for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
                    if (entry.name === 'node_modules') continue;
                    const rel = prefix + entry.name;
                    if (entry.isDirectory()) walk(path.join(base, entry.name), rel + '/');
                    else files.add(rel);
                }
            }

            walk(dir);
            checkPackageContents(manifest, files);
            if (temporary) {
                const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--cache', path.join(temporary, 'cache'), '--pack-destination', temporary], {
                    cwd: dir,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                }));
                checkPackageContents(manifest, new Set(packed.files.map(file => file.path)));
            }
            console.log(`checked ${manifest.name}${pack ? ' archive' : ''}`);
        }
    } finally {
        if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
    }
}

if (require.main === module) {
    try {
        checkPackages(path.resolve(__dirname, '..'), process.argv.includes('--pack'));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = {checkPackageContents, checkPackages};
