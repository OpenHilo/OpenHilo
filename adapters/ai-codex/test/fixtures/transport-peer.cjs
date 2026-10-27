#!/usr/bin/env node
// Transport-only peer: behaviour selected by PEER_MODE; never calls a model.
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const mode = process.env.PEER_MODE;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
if (process.env.PEER_PGID_FILE) {
    // A TERM-ignoring descendant in the same process group, holding no pipes.
    spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    fs.writeFileSync(process.env.PEER_PGID_FILE, String(process.pid));
}
if (mode === 'exit-on-term') process.on('SIGTERM', () => process.exit(0));
if (mode === 'hold-pipes') {
    // An escaped descendant (own session) keeps stdout open after the group is gone.
    const escaped = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio: ['ignore', 'inherit', 'inherit'], detached: true});
    escaped.unref();
    fs.writeFileSync('escaped.pid', String(escaped.pid));
    process.on('SIGTERM', () => process.exit(0));
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    input += chunk;
    for (let end = input.indexOf('\n'); end >= 0; end = input.indexOf('\n')) {
        const m = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        if (mode === 'flood') {
            // An unterminated frame far beyond the limit, in multibyte characters.
            const chunk = '"'.padEnd(64 * 1024, '中');
            let sent = 0;
            const write = () => {
                while (sent < 64) {
                    sent++;
                    if (!process.stdout.write(chunk)) return process.stdout.once('drain', write);
                }
            };
            write();
        } else if (mode === 'multibyte-limit') {
            // 1.5M three-byte characters: under 4 MiB characters, over 4 MiB bytes.
            send({id: m.id, result: {text: '中'.repeat(1.5 * 1024 * 1024)}});
        } else if (mode === 'string-id') send({id: String(m.id), result: {ok: true, id: String(m.id)}});
        else if (mode === 'null-id-error') send({id: null, error: {code: -32700, message: 'Parse error'}});
        else send({id: m.id, result: {ok: true}});
    }
});
