// Runs the complete core suite with temporary data and no live provider calls.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-offline-suite-'));
const guard = path.join(root, 'scripts/offline-guard.cjs');
const env = {
    ...process.env,
    HOME: temporary,
    USERPROFILE: temporary,
    NODE_ENV: 'test',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    CODEX_HOME: path.join(temporary, 'codex'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'OpenHilo Test',
    GIT_AUTHOR_EMAIL: 'offline@localhost',
    GIT_COMMITTER_NAME: 'OpenHilo Test',
    GIT_COMMITTER_EMAIL: 'offline@localhost',
    NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
};

function run(args) {
    const result = spawnSync(process.execPath, args, {cwd: root, env, stdio: 'inherit'});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Offline test command failed (${result.status ?? result.signal})`);
}

try {
    const directories = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).workspaces;
    const files = directories.flatMap(dir => {
        const testDir = path.join(dir, 'test');
        return fs.existsSync(path.join(root, testDir)) ? fs.readdirSync(path.join(root, testDir)).filter(file => file.endsWith('.test.cjs')).map(file => path.join(testDir, file)) : [];
    });
    files.push(...fs.readdirSync(path.join(root, 'tests/integration')).filter(file => file.endsWith('.test.cjs')).map(file => path.join('tests/integration', file)));
    console.log(`Running ${files.length} core test files with temporary HOME and live-call guard.`);
    run(['--test', '--test-concurrency=1', ...files.sort()]);
    run([require.resolve('jest/bin/jest'), '--config', 'packages/ai-contracts/jest.config.cjs', '--runInBand']);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    fs.rmSync(temporary, {recursive: true, force: true});
}
