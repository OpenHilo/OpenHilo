#!/usr/bin/env node
const fs = require('node:fs');
const {parseArgs} = require('node:util');
const {createToolHost} = require('@openhilo/tool-host');
const {createExampleExecutor, executeTextTask, printResult} = require('../lib/sdk.cjs');

async function lookupCatalog({executor, catalog, id, write}) {
    if (!Array.isArray(catalog) || catalog.some(item => !item || typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string' || typeof item.description !== 'string') || new Set(catalog.map(item => item.id)).size !== catalog.length) throw new Error('Catalog requires unique id, title, description string fields');
    if (typeof id !== 'string' || !id.trim()) throw new Error('Provide a nonempty --id');
    const records = new Map(catalog.map(item => [item.id, {
        id: item.id,
        title: item.title,
        description: item.description
    }]));
    let lookedUpRequestedItem = false;
    const tools = createToolHost([{
        name: 'lookup', description: 'Read one catalog item by ID; reports found=false if absent. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {id: {type: 'string', minLength: 1}},
            required: ['id'],
            additionalProperties: false
        }, readOnly: true,
        async handler(args) {
            if (args.id === id) lookedUpRequestedItem = true;
            const item = records.get(args.id);
            return item ? {found: true, item} : {found: false, id: args.id};
        },
    }]);
    const result = await executeTextTask({
        executor,
        instruction: 'Use lookup to find the supplied id, then summarize the returned item in one short sentence. If missing, state that it was not found. Do not invent facts or ask questions. Finish with the summary field.',
        inputs: {id},
        tools,
        write
    });
    if (!lookedUpRequestedItem) throw new Error('Model finished without a valid lookup of the requested item; summary not accepted.');
    return result;
}

async function main(args) {
    const {values} = parseArgs({
        args,
        options: {provider: {type: 'string'}, catalog: {type: 'string'}, id: {type: 'string'}}
    });
    const executor = createExampleExecutor(values.provider);
    if (!values.catalog || !values.id) throw new Error('Usage: node examples/sdk-tools/run.cjs --provider openai|anthropic --catalog <json> --id <item id>');
    const result = await lookupCatalog({
        executor,
        catalog: JSON.parse(fs.readFileSync(values.catalog, 'utf8')),
        id: values.id
    });
    printResult(result);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {lookupCatalog, main};
