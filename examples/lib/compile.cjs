// Example-only adapter around the public compiler. Not a new framework API.
const fs = require('node:fs');
const path = require('node:path');
const {compileProgram} = require('@openhilo/compiler');

function compileFiles({files, entries, outputDir}) {
    if (fs.existsSync(outputDir)) throw new Error(`Artifact directory already exists: ${outputDir}`);
    const sources = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));
    const compiled = compileProgram({files: sources, entries});
    if (!compiled.ok) throw new Error('Workflow compilation failed:\n' + compiled.diagnostics.map(d => `${d.file ?? ''}${d.line ? ':' + d.line : ''}: ${d.message}`).join('\n'));
    if (compiled.entries.length !== 1) throw new Error('These examples require one entry workflow');
    fs.mkdirSync(outputDir, {recursive: true});
    for (const artifact of compiled.artifacts) {
        for (const [suffix, data] of [['itt.impl.json', artifact.implementation], ['itt.json', artifact.declaration], ['sourcemap.json', artifact.sourceMap]]) {
            fs.writeFileSync(path.join(outputDir, `${artifact.id}.${suffix}`), JSON.stringify(data, null, 2) + '\n', {flag: 'wx'});
        }
    }
    for (const [name, text] of Object.entries(sources)) {
        const file = path.join(outputDir, 'sources', name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, text, {flag: 'wx'});
    }
    return {entryFile: path.join(outputDir, `${compiled.entries[0]}.itt.impl.json`), artifactsDir: outputDir};
}

module.exports = {compileFiles};
