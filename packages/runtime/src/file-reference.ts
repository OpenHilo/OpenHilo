import * as fsPromises from 'fs/promises';
import {createReadStream} from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {AbortError} from '@openhilo/runtime-contracts';

/**
 * Create a FileRef for an existing path on disk.
 * For files: reads content to compute SHA-256 hash.
 * For dirs: uses empty hash (directory content hashing not supported).
 */
export async function makeFileRef(
    absPath: string,
    workspaceDir: string,
    outputKey: string,
): Promise<{ type: 'file_ref'; path: string; hash: string; mtime: number }> {
    try {
        await fsPromises.access(absPath);
    } catch {
        throw new AbortError(`code output '${outputKey}': path '${path.relative(workspaceDir, absPath)}' not found`);
    }
    const stat = await fsPromises.stat(absPath);
    let hash = '';
    if (stat.isFile()) {
        const digest = crypto.createHash('sha256');
        for await (const chunk of createReadStream(absPath)) digest.update(chunk);
        hash = 'sha256:' + digest.digest('hex');
    }
    const mtime = Math.floor(stat.mtimeMs / 1000);
    const relPath = path.relative(workspaceDir, absPath);
    return {type: 'file_ref', path: relPath, hash, mtime};
}

