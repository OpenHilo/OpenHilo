// Local tarball verification only. Installs public dependencies with --no-audit;
// every execution is offline and uses packages unpacked outside the source tree.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {checkPackageContents} = require('./check-packages.cjs');
const scenarios = {
    routing: ['@openhilo/compiler', '@openhilo/runtime'],
    compiler: ['@openhilo/compiler'],
    'runtime-human': ['@openhilo/runtime', '@openhilo/human-terminal'],
    'runtime-code': ['@openhilo/runtime', '@openhilo/code-local'],
    codex: ['@openhilo/ai-codex'],
    sdk: ['@openhilo/ai-sdk'],
    'codex-ui': ['@openhilo/ai-codex'],
};

function dependencyClosure(roots, manifests) {
    const result = new Set();

    function visit(name) {
        if (result.has(name)) return;
        const item = manifests.get(name);
        assert.ok(item, `Missing package ${name} in candidate`);
        result.add(name);
        for (const dependency of Object.keys({...item.dependencies, ...item.optionalDependencies, ...item.peerDependencies})) if (dependency.startsWith('@openhilo/')) visit(dependency);
    }

    roots.forEach(visit);
    return [...result].sort();
}

function assertIsolation(dir, closure) {
    const scope = path.join(dir, 'node_modules/@openhilo');
    const names = fs.readdirSync(scope).map(name => `@openhilo/${name}`).sort();
    assert.deepEqual(names, [...closure].sort(), 'Installed core packages differ from the scenario closure');
    for (const name of names) {
        const location = path.join(dir, 'node_modules', name);
        assert.equal(fs.lstatSync(location).isSymbolicLink(), false, `Source symlink: ${name}`);
        assert.ok(fs.realpathSync(location).startsWith(fs.realpathSync(dir) + path.sep));
    }
}

function readSourceCommit(root) {
    if (!fs.existsSync(path.join(root, '.git'))) return null;
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
    } catch {
        return null;
    } // Source archives and uncommitted repositories have no commit identity.
}

function verifyConsumers(root, output) {
    root = path.resolve(root);
    if (output) {
        output = path.resolve(output);
        assert.ok(!fs.existsSync(output), 'Output directory must be new');
        fs.mkdirSync(output, {recursive: true});
    } else output = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-consumers-'));
    const inside = path.relative(fs.realpathSync(root), fs.realpathSync(output));
    assert.ok(inside.startsWith('..' + path.sep) || path.isAbsolute(inside), 'Consumers must be outside the source tree');
    const stage = path.join(output, 'pack-source'), archiveDir = path.join(output, 'tarballs');
    fs.mkdirSync(stage);
    fs.mkdirSync(archiveDir);
    const report = {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        npm: '',
        sourceCommit: '',
        sourceRemovedBeforeExecution: false,
        packages: [],
        scenarios: []
    };
    const env = {
        ...process.env,
        NODE_PATH: '',
        NODE_OPTIONS: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        HOME: path.join(output, 'home'),
        USERPROFILE: path.join(output, 'home'),
        CODEX_HOME: path.join(output, 'home/codex'),
        npm_config_cache: path.join(output, 'cache'),
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '20000'
    };
    fs.mkdirSync(env.HOME);

    function run(command, args, cwd, offline = false) {
        const runEnv = offline ? {
            ...env,
            NODE_OPTIONS: `--require=${JSON.stringify(path.join(cwd, 'offline-guard.cjs'))} --require=${JSON.stringify(path.join(cwd, 'isolation-guard.cjs'))}`
        } : env;
        try {
            return execFileSync(command, args, {
                cwd,
                env: runEnv,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 180000,
                maxBuffer: 16 * 1024 * 1024
            });
        } catch (error) {
            throw new Error(`${command} ${args.join(' ')} failed in ${path.basename(cwd)}\n${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
        }
    }

    report.npm = run('npm', ['--version'], output).trim();
    report.sourceCommit = readSourceCommit(root);
    const manifests = new Map(), packages = new Map();
    try {
        for (const folder of JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).workspaces) {
            const source = path.join(root, folder),
                manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
            manifests.set(manifest.name, manifest);
            const destination = path.join(stage, folder);
            fs.mkdirSync(destination, {recursive: true});
            // Only the package's declared public files and npm mandatory metadata.
            for (const file of new Set(['package.json', 'LICENSE', 'README.md', ...manifest.files])) {
                assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'Package files must be explicit relative paths');
                fs.cpSync(path.join(source, file), path.join(destination, file), {recursive: true, dereference: true});
            }
            const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', archiveDir], destination));
            checkPackageContents(manifest, new Set(packed.files.map(item => item.path)));
            const archive = path.join(archiveDir, packed.filename);
            packages.set(manifest.name, archive);
            report.packages.push({
                name: manifest.name,
                version: manifest.version,
                file: packed.filename,
                sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
            });
        }
        // Save verification code outside source before removing the exact npm-pack inputs.
        for (const [name, roots] of Object.entries(scenarios)) {
            const dir = path.join(output, name);
            fs.mkdirSync(dir);
            const closure = dependencyClosure(roots, manifests);
            const dependencies = Object.fromEntries(closure.map(name => [name, `file:${packages.get(name)}`]));
            const devDependencies = {
                typescript: '6.0.3',
                '@types/node': '24.19.2', ...(name === 'codex-ui' ? {react: '19.3.1', '@types/react': '19.3.0'} : {})
            };
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
                name: `consumer-${name}`,
                private: true,
                dependencies,
                devDependencies
            }, null, 2));
            fs.copyFileSync(path.join(root, `tests/consumers/${name}.${name === 'codex-ui' ? 'tsx' : 'ts'}`), path.join(dir, `consumer.${name === 'codex-ui' ? 'tsx' : 'ts'}`));
            if (name !== 'codex-ui') fs.copyFileSync(path.join(root, `tests/consumers/${name}.cjs`), path.join(dir, 'consumer.cjs'));
            fs.copyFileSync(path.join(root, 'scripts/offline-guard.cjs'), path.join(dir, 'offline-guard.cjs'));
            fs.writeFileSync(path.join(dir, 'isolation-guard.cjs'), `const M=require('node:module'),p=require('node:path'),f=require('node:fs'),a=require('node:assert/strict');const resolve=M._resolveFilename;const base=f.realpathSync(__dirname)+p.sep;M._resolveFilename=function(...args){const x=resolve.apply(this,args);if(p.isAbsolute(x))a.ok(f.realpathSync(x).startsWith(base),'Resolution outside consumer: '+x);return x;};`);
            if (name === 'codex' || name === 'sdk') {
                fs.mkdirSync(path.join(dir, 'fixtures'));
                const source = name === 'codex' ? 'adapters/ai-codex/test/fixtures/codex.cjs' : 'tests/fixtures/sdk-transport.cjs';
                fs.copyFileSync(path.join(root, source), path.join(dir, 'fixtures', path.basename(source)));
                if (name === 'codex') fs.chmodSync(path.join(dir, 'fixtures/codex.cjs'), 0o644);
            }
            report.scenarios.push({name, closure, status: 'pending'});
        }
        fs.rmSync(stage, {recursive: true});
        report.sourceRemovedBeforeExecution = !fs.existsSync(stage);
        for (const scenario of report.scenarios) {
            const dir = path.join(output, scenario.name);
            console.log(`Installing ${scenario.name}: ${scenario.closure.length} core packages`);
            const install = run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], dir);
            fs.writeFileSync(path.join(dir, 'install.log'), install);
            assertIsolation(dir, scenario.closure);
            const file = scenario.name === 'codex-ui' ? 'consumer.tsx' : 'consumer.ts';
            const types = run(process.execPath, [path.join(dir, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'es2022', '--module', 'node16', '--moduleResolution', 'node16', '--types', scenario.name === 'codex-ui' ? 'node,react' : 'node', ...(scenario.name === 'codex-ui' ? ['--jsx', 'react-jsx'] : []), file], dir, true);
            fs.writeFileSync(path.join(dir, 'types.log'), types);
            if (scenario.name !== 'codex-ui') fs.writeFileSync(path.join(dir, 'run.log'), run(process.execPath, ['consumer.cjs'], dir, true));
            scenario.status = 'passed';
            console.log(`Passed ${scenario.name}: archive runtime + public types`);
        }
    } finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(`Consumer evidence: ${output}`);
    }
    return report;
}

if (require.main === module) {
    try {
        const {values} = require('node:util').parseArgs({options: {output: {type: 'string'}}});
        verifyConsumers(path.resolve(__dirname, '..'), values.output);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = {dependencyClosure, assertIsolation, readSourceCommit, verifyConsumers};
