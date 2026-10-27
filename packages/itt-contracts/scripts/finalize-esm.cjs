// Publish the explicit browser modules as .mjs, rewriting their local ESM dependencies.
const fs = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../dist');
const build = path.join(dist, 'esm-build');
const manifest = require('../package.json');
const modules = Object.values(manifest.exports).map(entry => entry.import).filter(Boolean)
    .map(target => path.posix.basename(target, '.mjs'));
// Static `from '...'`, side-effect `import '...'` and dynamic `import('...')` specifiers.
const specifier = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]*)\2/g;

for (const name of modules) {
    const source = fs.readFileSync(path.join(build, `${name}.js`), 'utf8');
    const output = source.replace(specifier, (match, prefix, quote, target) => {
        const bare = target.replace(/\.js$/, '');
        if (!modules.includes(path.posix.normalize(bare))) {
            throw new Error(`${name}.js imports ${target}, which is not a published ESM module`);
        }
        return `${prefix}${quote}./${path.posix.normalize(bare)}.mjs${quote}`;
    });
    const remaining = [...output.matchAll(specifier)].map(match => match[3]).filter(target => !target.endsWith('.mjs'));
    if (remaining.length) throw new Error(`${name}.mjs retains unrewritten relative imports: ${remaining.join(', ')}`);
    fs.writeFileSync(path.join(dist, `${name}.mjs`), output);
}
fs.rmSync(build, {recursive: true, force: true});
