// Deterministic filesystem adapter for offline example tests; never a real model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {fileURLToPath} = require('node:url');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {runDocumentReview} = require('../../examples/document-review/run.cjs');
const {resumeDocumentReview} = require('../../examples/document-review/resume.cjs');
const {exitCode} = require('../../examples/document-review/host.cjs');
const aiExecutor = {
    id: 'test.document-files', capabilities: ['structured_output', 'workspace'],
    start(request, host) {
        return Promise.resolve(createTaskExecution(request, host, async () => {
            const workspace = fileURLToPath(host.workspace.uri);
            assert.equal(typeof request.inputs.brief, 'string');
            const brief = fs.readFileSync(path.join(workspace, request.inputs.brief), 'utf8');
            assert.equal(request.inputs.references, 'references');
            const reference = fs.readFileSync(path.join(workspace, request.inputs.references, 'club.md'), 'utf8');
            const mode = process.env.DOCUMENT_FIXTURE_MODE;
            let document = request.inputs.document ?? 'draft.md';
            if (request.inputs.document) {
                assert.equal(typeof document, 'string');
                const previous = fs.readFileSync(path.join(workspace, document), 'utf8');
                if (mode === 'different-path') document = 'other.md';
                fs.writeFileSync(path.join(workspace, document), previous + '\nRevision: ' + request.inputs.feedback + '\n');
            } else if (mode !== 'missing-file') {
                if (mode === 'outside-path') document = '../outside.md';
                fs.writeFileSync(path.join(workspace, document), mode === 'empty-file' ? '  ' : '# Draft\n' + brief + '\n' + reference);
            }
            return {status: 'completed', outputs: {document}, artifacts: []};
        }));
    },
};
(async () => {
    const [mode, first, second, flag] = process.argv.slice(2);
    const result = mode === 'start'
        ? await runDocumentReview({input: first, output: second, deferHuman: flag === 'defer', aiExecutor})
        : await resumeDocumentReview({runDir: first, aiExecutor});
    process.exitCode = exitCode(result);
})().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
