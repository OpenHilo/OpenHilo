// Read-only architecture check. Does not load application code or install dependencies.
const fs = require('node:fs');
const path = require('node:path');
const {isBuiltin} = require('node:module');
const ts = require('typescript');
const names = list => list.map(name => '@openhilo/' + name);
const policy = {
    'ai-contracts': names(['itt-contracts']), 'itt-contracts': [], 'studio-contracts': names(['itt-contracts']),
    'human-contracts': names(['itt-contracts']),
    'human-terminal': names(['human-contracts', 'itt-contracts']),
    'runtime-contracts': names(['ai-contracts', 'itt-contracts']),
    runtime: names(['human-contracts', 'ai-contracts', 'itt-contracts', 'runtime-contracts']),
    compiler: [...names(['itt-contracts']), 'typescript'],
    'tool-host': [...names(['ai-contracts']), 'ajv', 'ajv-formats'],
    'ai-codex': [...names(['ai-contracts', 'studio-contracts']), 'react'],
    'ai-sdk': [...names(['ai-contracts', 'tool-host']), 'openai', '@anthropic-ai/sdk'],
    'code-local': names(['itt-contracts', 'runtime-contracts', 'runtime']),
};
// Exact source/built sites: the deployment owner supplies an absolute composition
// module. These are not permission to dynamically load modules anywhere else.
const dynamicSites = {};
const sourceExtension = /\.(?:[cm]?[jt]sx?|css)$/;
const slash = value => value.split(path.sep).join('/');
const inside = (root, file) => {
    const rel = path.relative(root, file);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

function checkBoundaries(root) {
    root = fs.realpathSync(root);
    const errors = [], packages = new Map(), visited = new Set(), dynamic = new Set();
    const report = (file, message, line) => errors.push(`${slash(path.relative(root, file))}${line ? ':' + line : ''}: ${message}`);
    for (const group of ['packages', 'adapters', 'apps']) {
        const directory = path.join(root, group);
        if (!fs.existsSync(directory)) continue;
        for (const entry of fs.readdirSync(directory).sort()) {
            const dir = path.join(directory, entry), file = path.join(dir, 'package.json');
            if (fs.lstatSync(dir).isSymbolicLink()) {
                report(dir, 'workspace package symlinks are not allowed');
                continue;
            }
            if (!fs.existsSync(file)) continue;
            const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (packages.has(manifest.name)) report(file, `duplicate package ${manifest.name}`);
            packages.set(manifest.name, {
                dir, file, manifest,
                allowed: policy[manifest.name?.replace('@openhilo/', '')],
                dependencies: {...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies}
            });
        }
    }

    function checkEdge(owner, specifier, file, line) {
        if (isBuiltin(specifier)) return;
        const dependency = packageName(specifier);
        if (dependency !== owner.manifest.name && !owner.allowed?.includes(dependency)) report(file, `forbidden dependency direction: ${owner.manifest.name} -> ${dependency}`, line);
        if (dependency !== owner.manifest.name && !Object.hasOwn(owner.dependencies, dependency)) report(file, `undeclared dependency ${dependency}`, line);
        if (dependency.startsWith('@openhilo/')) {
            const target = packages.get(dependency);
            const key = specifier === dependency ? '.' : '.' + specifier.slice(dependency.length);
            if (!target) report(file, `unknown workspace package ${dependency}`, line);
            else if (!Object.hasOwn(target.manifest.exports ?? {}, key)) report(file, `non-public package entry ${specifier}`, line);
        }
    }

    function resolveLocal(file, specifier) {
        const exact = path.resolve(path.dirname(file), specifier);
        const sourceEquivalent = exact.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts');
        const candidates = [exact, sourceEquivalent, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.d.ts'].map(extension => exact + extension)];
        return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    }

    function reference(owner, file, specifier, line) {
        if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
            if (specifier.split(/[\\/]/).includes('node_modules')) {
                report(file, 'use a declared package entry instead of a relative node_modules import', line);
                return;
            }
            const lexical = path.resolve(path.dirname(file), specifier);
            if (!inside(owner.dir, lexical)) {
                report(file, `relative/absolute import escapes its package: ${specifier}`, line);
                return;
            }
            const target = resolveLocal(file, specifier);
            if (!target) {
                report(file, `unresolved local import ${specifier}`, line);
                return;
            }
            if (!inside(owner.dir, fs.realpathSync(target))) {
                report(file, `import symlink escapes its package: ${specifier}`, line);
                return;
            }
            inspect(owner, target);
        } else checkEdge(owner, specifier, file, line);
    }

    function inspect(owner, file) {
        if (visited.has(file) || !sourceExtension.test(file)) return;
        visited.add(file);
        const text = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.css')) {
            const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
            for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) reference(owner, file, match[1]);
            for (const match of css.matchAll(/@source\s+["']([^"']+)["']/g)) {
                const target = path.resolve(path.dirname(file), match[1]);
                if (!inside(owner.dir, target) || (fs.existsSync(target) && !inside(owner.dir, fs.realpathSync(target)))) report(file, `CSS source escapes its package: ${match[1]}`);
            }
            return;
        }
        const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        for (const diagnostic of ast.parseDiagnostics) report(file, ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
        for (const ref of ast.referencedFiles) reference(owner, file, ref.fileName);
        for (const ref of ast.typeReferenceDirectives) if (ref.fileName !== 'node') checkEdge(owner, ref.fileName, file);

        function visit(node) {
            let specifier;
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
            if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
            if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(ast);
                if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ['require', 'require.resolve', 'module.require', 'module["require"]', "module['require']", 'require["resolve"]', "require['resolve']"].includes(callee)) {
                    specifier = node.arguments[0];
                    if (node.arguments.length !== 1 || !specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
                        const site = slash(path.relative(root, file));
                        if (dynamicSites[site] === node.getText(ast)) dynamic.add(site);
                        else report(file, `unapproved dynamic module load: ${node.getText(ast)}`, ast.getLineAndCharacterOfPosition(node.getStart()).line + 1);
                        specifier = undefined;
                    }
                }
            }
            if (specifier) {
                const line = ast.getLineAndCharacterOfPosition(specifier.getStart()).line + 1;
                if (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) reference(owner, file, specifier.text, line);
                else report(file, 'module specifier must be a literal', line);
            }
            ts.forEachChild(node, visit);
        }

        visit(ast);
    }

    function walk(owner, dir) {
        if (!fs.existsSync(dir)) return;
        if (fs.lstatSync(dir).isSymbolicLink()) {
            report(dir, 'production source symlinks are not allowed');
            return;
        }
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (['node_modules', 'test', 'tests', '__tests__'].includes(entry.name)) continue;
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                report(file, 'production source symlinks are not allowed');
                continue;
            }
            if (entry.isDirectory()) walk(owner, file); else inspect(owner, file);
        }
    }

    for (const owner of packages.values()) {
        if (!owner.allowed) {
            report(owner.file, `package has no architecture policy: ${owner.manifest.name}`);
            continue;
        }
        if (!owner.manifest.exports || typeof owner.manifest.exports !== 'object' || !Object.hasOwn(owner.manifest.exports, '.'))
            report(owner.file, 'workspace package requires an explicit root export');
        for (const dependency of Object.keys(owner.dependencies)) checkEdge(owner, dependency, owner.file);
        for (const source of ['src', 'client/src', 'studio']) walk(owner, path.join(owner.dir, source));
        for (const target of [...strings(owner.manifest.exports), ...strings(owner.manifest.bin)]) {
            const file = path.resolve(owner.dir, target);
            if (!inside(owner.dir, file)) report(owner.file, `public entry escapes package: ${target}`);
            else if (!fs.existsSync(file) || !fs.statSync(file).isFile()) report(owner.file, `missing built public entry: ${target} (build packages first)`);
            else if (!inside(owner.dir, fs.realpathSync(file))) report(owner.file, `public entry symlink escapes package: ${target}`);
            else inspect(owner, file);
        }
    }
    if (!packages.size) report(path.join(root, 'package.json'), 'no workspace packages found');
    const complete = new Set();

    function acyclic(name, chain = []) {
        if (chain.includes(name)) {
            report(packages.get(name).file, `workspace dependency cycle: ${[...chain, name].join(' -> ')}`);
            return;
        }
        if (complete.has(name)) return;
        for (const dependency of Object.keys(packages.get(name).dependencies)) if (packages.has(dependency)) acyclic(dependency, [...chain, name]);
        complete.add(name);
    }

    for (const name of packages.keys()) acyclic(name);
    return {
        packages: packages.size,
        files: visited.size,
        dynamicSites: [...dynamic].sort(),
        errors: [...new Set(errors)].sort()
    };
}

if (require.main === module) {
    const result = checkBoundaries(path.resolve(__dirname, '..'));
    if (result.errors.length) {
        console.error(result.errors.join('\n'));
        process.exitCode = 1;
    } else console.log(`Checked ${result.packages} packages and ${result.files} source/public-entry files; ${result.dynamicSites.length} explicit source/built composition sites.`);
}
module.exports = {checkBoundaries};
