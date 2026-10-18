#!/usr/bin/env node
const fs = require('node:fs');
const {parseArgs} = require('node:util');
const {createExampleExecutor, executeTextTask, printResult} = require('../lib/sdk.cjs');

async function summarizeText({executor, text, write}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Provide nonempty text to summarize');
    return executeTextTask({
        executor,
        instruction: 'Summarize the supplied text in one or two concise sentences. Use only the given text; no clarification or business tools are needed. Call finish_task with the summary field.',
        inputs: {text},
        write
    });
}

async function main(args) {
    const {values} = parseArgs({args, options: {provider: {type: 'string'}, input: {type: 'string'}}});
    const executor = createExampleExecutor(values.provider);
    if (!values.input) throw new Error('Usage: node examples/sdk-text/run.cjs --provider openai|anthropic --input <text file>');
    const result = await summarizeText({executor, text: fs.readFileSync(values.input, 'utf8')});
    printResult(result);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {summarizeText, main};
