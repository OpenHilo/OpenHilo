#!/usr/bin/env node
import {readFileSync} from 'fs';
import {compileProgram, type ProgramInput} from './program';

/** Thin file adapter: one JSON virtual-source bundle in, one compilation result on stdout. */
export function main(args: string[]): number {
    if (args.length !== 1 || args[0] === '--help') {
        process.stderr.write('Usage: openhilo-compile <program.json>\nThe input contains files, entries, and optional systemMethods. No code or models are executed.\n');
        return args[0] === '--help' ? 0 : 2;
    }
    try {
        const input = JSON.parse(readFileSync(args[0], 'utf8')) as ProgramInput;
        const result = compileProgram(input);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.ok ? 0 : 1;
    } catch {
        process.stderr.write('Unable to read a valid JSON compilation input.\n');
        return 2;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
