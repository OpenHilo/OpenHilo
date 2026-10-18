const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('typescript');
// Runs unmodified selected upstream files on native Node/V8 as a reference only.
// These results must never be reported as OpenHilo conformance results.
function verifyOriginals(root, manifest) {
    for (const [file, hash] of Object.entries(manifest.supportFiles)) {
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), hash);
    }
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const seen = new Set();
    const report = [];
    for (const entry of manifest.cases) {
        const key = entry.source + '/' + entry.path;
        if (seen.has(key)) continue;
        seen.add(key);
        const code = read(key);
        assert.equal(crypto.createHash('sha256').update(code).digest('hex'), entry.sha256);
        if (entry.source === 'test262' && /negative:\s*\n\s*phase: parse/.test(code)) {
            assert.throws(() => new vm.Script(code, {filename: key}), {name: 'SyntaxError'});
        } else {
            const context = vm.createContext({});
            if (entry.source === 'test262') {
                new vm.Script(read('test262/harness/sta.js') + '\n' + read('test262/harness/assert.js')).runInContext(context, {timeout: 1000});
            } else if (entry.source === 'v8') {
                new vm.Script(read('v8/test/mjsunit/mjsunit.js')).runInContext(context, {timeout: 1000});
            }
            const selection = manifest.nativeReferenceSelections[key];
            let executable = code;
            if (selection) {
                const ast = ts.createSourceFile(key, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
                const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && selection.functions.includes(node.name?.text));
                assert.equal(functions.length, selection.functions.length, 'all selected original functions must exist');
                executable = functions.map(node => node.getText(ast)).join('\n') + '\n' + selection.calls.map(name => name + '();').join('\n');
            }
            new vm.Script(executable, {filename: key}).runInContext(context, {timeout: 3000});
        }
        report.push({
            source: entry.source,
            path: entry.path,
            status: 'native-reference-passed',
            selection: manifest.nativeReferenceSelections[key]?.functions ?? 'whole-file'
        });
    }
    return report;
}

module.exports = {verifyOriginals};
