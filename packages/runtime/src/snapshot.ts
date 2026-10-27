import * as fs from 'fs';
import * as path from 'path';
import {type CFGITT, IttValidator} from '@openhilo/itt-contracts';
import {AbortError} from './types';

const SUFFIXES = ['.itt.impl.json', '.itt.json'] as const;

/** Contained real path of one snapshot variant, or undefined when it does not exist. */
export function snapshotFile(snapshotDir: string, intent: string, suffix: typeof SUFFIXES[number]): string | undefined {
    const directory = path.resolve(snapshotDir);
    const candidate = path.resolve(directory, intent + suffix);
    if (!candidate.startsWith(directory + path.sep)) throw new AbortError('ITT snapshot path escapes its directory');
    if (!fs.existsSync(candidate)) return undefined;
    const actualDirectory = fs.realpathSync(directory), actual = fs.realpathSync(candidate);
    if (actualDirectory !== path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory)) ||
        !actual.startsWith(actualDirectory + path.sep) || !fs.statSync(actual).isFile()) throw new AbortError('ITT snapshot resolves outside its directory');
    return actual;
}

/** Runtime snapshots are immutable run-local artifacts, including legacy .itt.json files. */
export function readSnapshot(snapshotDir: string, intent: string): CFGITT {
    for (const suffix of SUFFIXES) {
        const actual = snapshotFile(snapshotDir, intent, suffix);
        if (!actual) continue;
        let itt: CFGITT;
        try {
            itt = JSON.parse(fs.readFileSync(actual, 'utf8')) as CFGITT;
        } catch (error) {
            throw new AbortError(`ITT snapshot ${intent} is not valid JSON: ${(error as Error).message}`);
        }
        const {errors} = new IttValidator().validate(itt);
        if (errors.length) throw new AbortError(`ITT snapshot ${intent} is invalid:\n${errors.join('\n')}`);
        return itt;
    }
    throw new AbortError(`ITT not found in snapshot: ${intent}`);
}
