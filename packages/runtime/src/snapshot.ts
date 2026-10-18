import * as fs from 'fs';
import * as path from 'path';
import type {CFGITT} from '@openhilo/itt-contracts';
import {AbortError} from './types';

/** Runtime snapshots are immutable run-local artifacts, including legacy .itt.json files. */
export function readSnapshot(snapshotDir: string, intent: string): CFGITT {
    const directory = path.resolve(snapshotDir);
    for (const suffix of ['.itt.impl.json', '.itt.json']) {
        const candidate = path.resolve(directory, intent + suffix);
        if (!candidate.startsWith(directory + path.sep)) throw new AbortError('ITT snapshot path escapes its directory');
        if (!fs.existsSync(candidate)) continue;
        const actualDirectory = fs.realpathSync(directory), actual = fs.realpathSync(candidate);
        if (actualDirectory !== path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory)) ||
            !actual.startsWith(actualDirectory + path.sep) || !fs.statSync(actual).isFile()) throw new AbortError('ITT snapshot resolves outside its directory');
        return JSON.parse(fs.readFileSync(actual, 'utf8')) as CFGITT;
    }
    throw new AbortError(`ITT not found in snapshot: ${intent}`);
}
