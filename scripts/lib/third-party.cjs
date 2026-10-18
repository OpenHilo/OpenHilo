const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const posix = path.posix;

function dependencyEdges(manifest) {
    const names = new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.optionalDependencies || {}), ...Object.keys(manifest.peerDependencies || {})]);
    return [...names].sort().map(name => ({
        name,
        optional: Object.hasOwn(manifest.optionalDependencies || {}, name) || (!Object.hasOwn(manifest.dependencies || {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true)
    }));
}

function resolveDependency(packages, from, name) {
    let base = from;
    while (true) {
        const candidate = posix.join(base, 'node_modules', name);
        if (packages[candidate]) {
            const entry = packages[candidate];
            if (!entry.link) return candidate;
            assert.ok(packages[entry.resolved], `Missing workspace target: ${candidate}`);
            return entry.resolved;
        }
        if (!base || base === '.') return undefined;
        base = posix.dirname(base);
        if (base === '.') base = '';
    }
}

function closure(packages, starts, stopAt = () => false) {
    const included = new Set(), absentOptional = [];

    function visit(key) {
        if (included.has(key)) return;
        const entry = packages[key];
        assert.ok(entry, `Missing lock entry: ${key}`);
        included.add(key);
        if (stopAt(key)) return;
        for (const edge of dependencyEdges(entry)) {
            const resolved = resolveDependency(packages, key, edge.name);
            if (resolved !== undefined) visit(resolved);
            else if (edge.optional) absentOptional.push({from: key, name: edge.name});
            else throw new Error(`Unresolved required dependency ${edge.name} from ${key}`);
        }
    }

    starts.forEach(visit);
    return {keys: [...included].sort(), absentOptional};
}

function licenseFiles(directory, relative = '') {
    return fs.readdirSync(path.join(directory, relative), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) return [];
        const name = posix.join(relative, entry.name);
        if (entry.isDirectory()) return licenseFiles(directory, name);
        return /^(licen[cs]e|copying|notice|copyright|third.?party.?notices)(\b|[._-])/i.test(entry.name) && !/\.(js|ts|map|json)$/.test(entry.name) ? [name] : [];
    });
}

function externalName(key, entry) {
    return entry.name || key.slice(key.lastIndexOf('node_modules/') + 13);
}

function generate(root) {
    const lockFile = path.join(root, 'package-lock.json'), lock = json(lockFile),
        manifest = json(path.join(root, 'package.json'));
    const folders = manifest.workspaces;
    assert.ok(Array.isArray(folders), 'Explicit package workspaces required');
    const overridesDir = path.join(root, 'docs/third-party-sources');
    const overrides = fs.existsSync(path.join(overridesDir, 'index.json')) ? json(path.join(overridesDir, 'index.json')) : {};
    const outputs = new Map(), records = new Map();
    for (const folder of ['', ...folders]) {
        const pkg = json(path.join(root, folder, 'package.json'));
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) assert.deepEqual(pkg[field] || {}, lock.packages[folder]?.[field] || {}, `${folder}: ${field} differs from lock`);
    }
    const graph = closure(lock.packages, ['', ...folders]);

    function record(key) {
        if (records.has(key)) return records.get(key);
        const entry = lock.packages[key], name = externalName(key, entry), dir = path.join(root, key),
            installed = json(path.join(dir, 'package.json'));
        assert.equal(installed.name, name, 'installed package name differs from lock');
        assert.equal(installed.version, entry.version, 'installed version differs from lock');
        const texts = licenseFiles(dir).map(file => ({
            source: `${name}@${entry.version}/${file}`,
            content: fs.readFileSync(path.join(dir, file), 'utf8')
        }));
        for (const addition of overrides[`${name}@${entry.version}`] || []) {
            const content = fs.readFileSync(path.join(overridesDir, addition.file), 'utf8');
            assert.equal(sha256(content), addition.sha256, `${name}: upstream license hash changed`);
            texts.push({source: addition.url, note: addition.note, content});
        }
        assert.ok(texts.length, `${name}@${entry.version}: no license text; add a reviewed version-bound upstream source`);
        const value = {
            name,
            version: entry.version,
            license: entry.license ?? installed.license ?? null,
            integrity: entry.integrity ?? null,
            texts
        };
        records.set(key, value);
        return value;
    }

    const external = keys => keys.filter(key => key.includes('node_modules/') && !lock.packages[key].link);

    function render(items, title) {
        const unique = new Map();
        for (const item of items) {
            const id = `${item.name}@${item.version}`;
            if (unique.has(id)) assert.deepEqual(unique.get(id).texts, item.texts); else unique.set(id, item);
        }
        const ordered = [...unique.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
        return `THIRD-PARTY NOTICES — ${title}\n\nGenerated from the standalone package-lock.json by scripts/third-party-notices.cjs.\nPreserve these notices when redistributing. Each component retains its own license;\nOpenHilo's MIT license does not relicense it. This conservative runtime dependency\ninventory is not a claim that every listed file is bundled. Optional peers absent\nfrom the lock are recorded in docs/third-party-inventory.json, not installed.\n\n` + (ordered.length ? ordered.map(r => `================================================================================\n${r.name}@${r.version}\nDeclared license: ${typeof r.license === 'string' ? r.license : JSON.stringify(r.license)}\nIntegrity: ${r.integrity ?? 'not recorded'}\n\n` + r.texts.map(t => `--- ${t.source} ---\n${t.note ? t.note + '\n' : ''}SHA-256: ${sha256(t.content)}\n\n${t.content}${t.content.endsWith('\n') ? '' : '\n'}`).join('\n')).join('\n') : 'No external runtime dependencies in this package closure.\n');
    }

    const all = external(graph.keys).map(record);
    for (const folder of folders) outputs.set(`${folder}/THIRD_PARTY_NOTICES.txt`, render(external(closure(lock.packages, [folder]).keys).map(record), json(path.join(root, folder, 'package.json')).name));
    const inventory = {
        formatVersion: 1,
        scope: 'Standalone lock only; runtime dependency license texts. Development-only entries are inventoried without claiming their code is distributed. Optional React is supplied by UI consumers.',
        locks: [{
            path: 'package-lock.json',
            sha256: sha256(fs.readFileSync(lockFile)),
            absentOptional: graph.absentOptional
        }],
        packages: []
    };
    for (const [key, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        if (!key.includes('node_modules/') || entry.link) continue;
        inventory.packages.push({
            path: key,
            name: externalName(key, entry),
            version: entry.version,
            license: entry.license ?? null,
            integrity: entry.integrity ?? null,
            dev: !!entry.dev,
            optional: !!entry.optional,
            runtime: graph.keys.includes(key),
            texts: records.get(key)?.texts.map(t => ({
                source: t.source,
                sha256: sha256(t.content), ...(t.note ? {note: t.note} : {})
            })) ?? []
        });
    }
    outputs.set('THIRD_PARTY_NOTICES.txt', render(all, 'OpenHilo core runtime dependencies'));
    outputs.set('docs/third-party-inventory.json', JSON.stringify(inventory, null, 2) + '\n');
    return outputs;
}

module.exports = {dependencyEdges, resolveDependency, closure, licenseFiles, generate};
