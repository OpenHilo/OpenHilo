import {type ChildProcessWithoutNullStreams, spawn} from 'node:child_process';

export type Message = {
    id?: string | number;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number; message: string }
};

/** Owned stdio process: bounded framing, correlated requests, no shell or retries. */
export class CodexTransport {
    private child: ChildProcessWithoutNullStreams;
    private pending = new Map<number, {
        method: string;
        resolve(value: any): void;
        reject(error: Error): void;
        timer: NodeJS.Timeout
    }>();
    private nextId = 0;
    private buffer = '';
    private stopped = false;
    private exited: Promise<void>;

    constructor(cliPath: string, cwd: string, env: NodeJS.ProcessEnv,
                private receive: (message: Message) => void, private failure: (error: Error) => void) {
        this.child = spawn(cliPath, ['app-server', '--listen', 'stdio://'], {
            cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false,
        });
        this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
        this.child.once('error', () => this.fail(new Error('Could not start the configured Codex CLI')));
        this.child.once('close', () => this.fail(new Error('Codex process exited before the operation was confirmed')));
        this.child.stdin.on('error', () => this.fail(new Error('Codex input pipe closed')));
        // Drain diagnostics, but never persist stderr (it may include local configuration or credentials).
        this.child.stderr.resume();
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => {
            this.buffer += chunk;
            for (; ;) {
                const end = this.buffer.indexOf('\n');
                if (end < 0) break;
                if (end > 4 * 1024 * 1024) {
                    this.fail(new Error('Codex protocol frame exceeded 4 MiB'));
                    return;
                }
                const line = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end + 1);
                if (!line.trim()) continue;
                try {
                    const message = JSON.parse(line) as Message;
                    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
                    if (message.method) this.receive(message);
                    else if (typeof message.id === 'number') {
                        const entry = this.pending.get(message.id);
                        if (!entry) continue;
                        this.pending.delete(message.id);
                        clearTimeout(entry.timer);
                        if (message.error) entry.reject(new Error(`Codex ${entry.method} protocol request failed (${message.error.code}). Check the CLI configuration and app-server compatibility; update Codex or this adapter if needed.`));
                        else entry.resolve(message.result);
                    }
                } catch {
                    this.fail(new Error('Invalid Codex protocol message'));
                    return;
                }
            }
            if (this.buffer.length > 4 * 1024 * 1024) this.fail(new Error('Codex protocol frame exceeded 4 MiB'));
        });
    }

    send(message: Message): void {
        if (this.stopped) throw new Error('Codex transport is closed');
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }

    request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
        if (this.stopped) return Promise.reject(new Error('Codex transport is closed'));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Codex ${method} request timed out`));
            }, timeoutMs);
            this.pending.set(id, {method, resolve, reject, timer});
            try {
                this.send({id, method, params});
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    async close(): Promise<void> {
        this.fail(new Error('Codex transport closed'));
        const kill = (signal: NodeJS.Signals) => {
            if (!this.child.pid) return;
            try {
                if (process.platform !== 'win32') process.kill(-this.child.pid, signal); else this.child.kill(signal);
            } catch { /* already gone */
            }
        };
        this.child.stdin.destroy();
        kill('SIGTERM');
        const timer = setTimeout(() => kill('SIGKILL'), 500);
        try {
            await this.exited;
        } finally {
            clearTimeout(timer);
        }
    }

    private fail(error: Error): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const item of this.pending.values()) {
            clearTimeout(item.timer);
            item.reject(error);
        }
        this.pending.clear();
        this.failure(error);
    }
}
