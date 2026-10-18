import * as fs from 'fs/promises';
import * as path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {randomUUID} from 'crypto';
import type {Artifact, ExecutionHost, JsonObject, OutputContract} from '@openhilo/ai-contracts';
import type {RegisteredTool} from '@openhilo/tool-host';
import {fail} from './errors';

export async function localWorkspace(workspace: NonNullable<ExecutionHost['workspace']>) {
    if (!workspace.uri.startsWith('file:')) return fail('unsupported_capability', 'SDK workspace requires a local file URI');
    const root = await fs.realpath(fileURLToPath(workspace.uri));
    if (!(await fs.stat(root)).isDirectory()) return fail('invalid_request', 'Workspace must be a directory');

    async function resolve(relative: string, parents = false): Promise<string> {
        const target = path.resolve(root, relative);
        const rel = path.relative(root, target);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return fail('invalid_request', 'Path escapes the workspace');
        const parts = rel.split(path.sep).filter(Boolean);
        if (parts.includes('.git')) return fail('invalid_request', 'Repository metadata is not a workspace tool target');
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            current = path.join(current, parts[i]);
            try {
                if ((await fs.lstat(current)).isSymbolicLink()) return fail('invalid_request', 'Workspace tools do not follow symlinks');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                if (parents && i < parts.length - 1) await fs.mkdir(current);
                else if (i < parts.length - 1) throw error;
            }
        }
        return target;
    }

    const pathSchema = {
        type: 'object',
        properties: {path: {type: 'string'}},
        required: ['path'],
        additionalProperties: false
    };
    const tools: RegisteredTool[] = [
        {
            name: 'workspace_read',
            description: 'Read a UTF-8 workspace file (at most 1 MiB).',
            inputSchema: pathSchema,
            readOnly: true,
            async handler(args, {signal}) {
                const target = await resolve(args.path as string);
                const stat = await fs.stat(target);
                if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('File must be regular and at most 1 MiB');
                return {content: await fs.readFile(target, {encoding: 'utf8', signal})};
            }
        },
        {
            name: 'workspace_list',
            description: 'List direct children of a workspace directory.',
            inputSchema: pathSchema,
            readOnly: true,
            async handler(args, {signal}) {
                const target = await resolve(args.path as string);
                signal.throwIfAborted();
                return (await fs.readdir(target, {withFileTypes: true})).filter(entry => entry.name !== '.git').map(entry => ({
                    name: entry.name,
                    kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file'
                }));
            }
        },
        {
            name: 'workspace_write',
            description: 'Write UTF-8 content to a workspace file, replacing it atomically and creating parent directories.',
            inputSchema: {
                type: 'object',
                properties: {path: {type: 'string', minLength: 1}, content: {type: 'string', maxLength: 1024 * 1024}},
                required: ['path', 'content'],
                additionalProperties: false
            },
            async handler(args, {signal}) {
                signal.throwIfAborted();
                const target = await resolve(args.path as string, true);
                if (target === root) throw new Error('Workspace root is not a file target');
                const temporary = path.join(path.dirname(target), `.openhilo-${randomUUID()}.tmp`);
                try {
                    await fs.writeFile(temporary, args.content as string, {
                        encoding: 'utf8',
                        signal,
                        flag: 'wx',
                        mode: 0o600
                    });
                    signal.throwIfAborted();
                    await resolve(args.path as string);
                    await fs.rename(temporary, target);
                    return {path: path.relative(root, target)};
                } finally {
                    await fs.unlink(temporary).catch(error => {
                        if (error.code !== 'ENOENT') throw error;
                    });
                }
            }
        },
    ];
    return {
        root, tools, async artifacts(outputs: JsonObject, contract: OutputContract): Promise<Artifact[]> {
            const artifacts: Artifact[] = [];
            for (const [key, kind] of Object.entries(contract)) {
                if (kind !== 'file' && kind !== 'dir') continue;
                const target = await resolve(outputs[key] as string);
                const stat = await fs.stat(target);
                if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return fail('invalid_output', `Output ${key} is not a ${kind}`, false);
                artifacts.push({
                    uri: pathToFileURL(target).href,
                    kind: kind === 'file' ? 'file' : 'directory',
                    origin: 'openhilo.ai-sdk'
                });
            }
            return artifacts;
        }
    };
}
