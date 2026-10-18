import {compileProgram, type ProgramInput} from '@openhilo/compiler';
import {parseRunInputs} from '@openhilo/itt-contracts/run-inputs';

const input: ProgramInput = {
    files: {'main.ts': 'export async function main(){ return {}; }'},
    entries: [{file: 'main.ts', exportName: 'main'}]
};
const result = compileProgram(input);
export const values = parseRunInputs({n: '2'}, {n: {kind: 'number'}}, 'typed-text-v1');
export const ok: boolean = result.ok;
