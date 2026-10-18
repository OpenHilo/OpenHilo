import {useEffect} from 'react';
import {type CodexExecutionConfig, parseAiExecutionConfig} from '@openhilo/studio-contracts/ai-config';

type Props = {
    config: Record<string, unknown>;
    savedConfig: Record<string, unknown>;
    onChange(patch: Record<string, unknown>): void;
    onValidityChange(valid: boolean): void
};

function CodexSettings({config, onChange, onValidityChange}: Props) {
    const raw = config.ai_execution as Partial<CodexExecutionConfig> | undefined;
    const selected: CodexExecutionConfig = raw?.adapter === 'codex' ? raw as CodexExecutionConfig : {adapter: 'codex'};
    let error = '';
    try {
        parseAiExecutionConfig(selected);
    } catch (e) {
        error = (e as Error).message;
    }
    const valid = !error;
    useEffect(() => {
        onValidityChange(valid);
    }, [valid, onValidityChange]);
    const update = (patch: Partial<CodexExecutionConfig>) => onChange({ai_execution: Object.fromEntries(Object.entries({...selected, ...patch}).filter(([, value]) => value !== undefined))});
    const inputClass = 'w-full rounded border p-2 bg-transparent';
    return <div className="space-y-3">
        <p className="text-sm">Uses Codex CLI installed on the server. No version-number restriction; protocol errors
            are reported when they occur. Sign in using the CLI; credentials are not entered here.</p>
        <label className="block">Codex executable path<input className={inputClass} value={selected.cli_path ?? ''}
                                                             placeholder="codex (PATH)"
                                                             onChange={e => update({cli_path: e.target.value || undefined})}/></label>
        <label className="block">Codex model<input className={inputClass} value={selected.model ?? ''}
                                                   placeholder="CLI default"
                                                   onChange={e => update({model: e.target.value || undefined})}/></label>
        <label className="block">Codex reasoning effort<select className={inputClass} value={selected.effort ?? ''}
                                                               onChange={e => update({effort: e.target.value as CodexExecutionConfig['effort'] || undefined})}>
            <option value="">CLI default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
        </select></label>
        <label className="block">Codex sandbox<select className={inputClass}
                                                      value={selected.sandbox ?? 'workspace-write'}
                                                      onChange={e => update({sandbox: e.target.value as CodexExecutionConfig['sandbox']})}>
            <option value="read-only">Read only</option>
            <option value="workspace-write">Workspace write</option>
        </select></label>
        <label className="block">Codex home (optional)<input className={inputClass} value={selected.codex_home ?? ''}
                                                             placeholder="CLI default"
                                                             onChange={e => update({codex_home: e.target.value || undefined})}/></label>
        <label className="block">Codex timeout (milliseconds)<input className={inputClass} type="number" min="1"
                                                                    max="2147483647" value={selected.timeout_ms ?? ''}
                                                                    placeholder="300000"
                                                                    onChange={e => update({timeout_ms: e.target.value ? Number(e.target.value) : undefined})}/></label>
        {error && <p role="alert">{error}</p>}
    </div>;
}

export const codexStudioSettings = {
    id: 'codex', label: 'Codex CLI', Editor: CodexSettings,
    createPatch(config: Record<string, unknown>): Record<string, unknown> {
        const raw = config.ai_execution as { adapter?: string } | undefined;
        return {ai_execution: parseAiExecutionConfig(raw?.adapter === 'codex' ? raw : {adapter: 'codex'})};
    },
};
