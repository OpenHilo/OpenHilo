const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {makeFileRef} = require('@openhilo/runtime/file-reference');

test('large file references preserve content hashes without buffering the whole file', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-reference-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const file = path.join(root, 'large.bin'), chunk = Buffer.alloc(64 * 1024, 97), digest = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'wx');
    try {for (let i = 0; i < 256; i++) {fs.writeSync(fd, chunk); digest.update(chunk);}}
    finally {fs.closeSync(fd);}
    const readFile = fs.promises.readFile;
    fs.promises.readFile = async (...args) => {
        assert.notEqual(args[0], file, 'Must not allocate a whole-file read for a reference');
        return readFile(...args);
    };
    try {
        const ref = await makeFileRef(file, root, 'artifact');
        assert.equal(ref.hash, `sha256:${digest.digest('hex')}`);
        assert.equal(ref.path, 'large.bin');
    } finally {fs.promises.readFile = readFile;}
});
