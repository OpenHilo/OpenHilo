const fs = require('node:fs');
const path = require('node:path');
const {generate} = require('./lib/third-party.cjs');
const root = path.resolve(__dirname, '..');
try {
    const outputs = generate(root), write = process.argv.includes('--write');
    for (const [relative, contents] of outputs) {
        const file = path.join(root, relative);
        if (write) {
            fs.mkdirSync(path.dirname(file), {recursive: true});
            fs.writeFileSync(file, contents);
        } else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents) throw new Error(`Stale or missing ${relative}; run npm run notices:update after reviewing dependency changes.`);
    }
    console.log(`${write ? 'Generated' : 'Verified'} ${outputs.size} dependency inventory/notice artifacts.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
