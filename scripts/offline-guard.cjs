// A regression guard, not a sandbox. Tests may replace fetch with scripted transports.
const cp = require('node:child_process');
const path = require('node:path');
const forbiddenCommands = /^(claude(?:-.*)?|codex(?:-.*)?|tmux|docker|security)$/;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[name];
    cp[name] = function (command, ...args) {
        if (typeof command === 'string' && forbiddenCommands.test(path.basename(command))) throw new Error(`Live provider/credential command forbidden in offline tests: ${path.basename(command)}`);
        return original.call(this, command, ...args);
    };
}
const local = hostname => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);

function assertLocal(value) {
    const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url);
    if (!local(url.hostname)) throw new Error('External network requests are forbidden in offline tests');
}

if (globalThis.fetch) {
    const original = globalThis.fetch;
    globalThis.fetch = function (input, init) {
        assertLocal(input);
        return original.call(this, input, init);
    };
}
for (const name of ['node:http', 'node:https']) {
    const module = require(name);
    for (const method of ['get', 'request']) {
        const original = module[method];
        module[method] = function (input, ...args) {
            if (typeof input === 'string' || input instanceof URL) assertLocal(input);
            else if (!input?.socketPath && !local(input?.hostname ?? input?.host ?? 'localhost')) throw new Error('External HTTP requests are forbidden in offline tests');
            return original.call(this, input, ...args);
        };
    }
}
