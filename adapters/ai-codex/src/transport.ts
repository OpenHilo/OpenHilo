import {type ChildProcessWithoutNullStreams, spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {registerProcess} from './process-registry';

export type Message = {
    id?: string | number;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number; message: string }
};

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 500;

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
    private chunks: Buffer[] = [];
    private bufferedBytes = 0;
    private stopped = false;
    private exited: Promise<void>;
    private grouped = process.platform !== 'win32';
    private unregister: () => void;
    private reaping?: Promise<void>;

    constructor(cliPath: string, cwd: string, env: NodeJS.ProcessEnv,
                private receive: (message: Message) => void, private failure: (error: Error) => void) {
        this.child = spawn(cliPath, ['app-server', '--listen', 'stdio://'], {
            cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: this.grouped, shell: false,
        });
        this.unregister = this.child.pid ? registerProcess({pid: this.child.pid, grouped: this.grouped}) : () => undefined;
        this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
        this.child.once('error', () => this.fail(new Error('Could not start the configured Codex CLI')));
        this.child.once('close', () => {
            this.fail(new Error('Codex process exited before the operation was confirmed'));
            // Descendants of an exited app-server must not outlive it either.
            void this.reap();
        });
        this.child.stdin.on('error', () => this.fail(new Error('Codex input pipe closed')));
        // Drain diagnostics, but never persist stderr (it may include local configuration or credentials).
        this.child.stderr.resume();
        this.child.stdout.on('data', (chunk: Buffer) => {
            if (this.stopped) return;
            let start = 0;
            for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
                const part = chunk.subarray(start, end);
                if (this.bufferedBytes + part.length > MAX_FRAME_BYTES) return this.overflow();
                const line = Buffer.concat([...this.chunks, part]).toString('utf8');
                this.chunks = [];
                this.bufferedBytes = 0;
                start = end + 1;
                this.handleLine(line);
                if (this.stopped) return;
            }
            const rest = chunk.subarray(start);
            if (this.bufferedBytes + rest.length > MAX_FRAME_BYTES) return this.overflow();
            if (rest.length) {
                this.chunks.push(rest);
                this.bufferedBytes += rest.length;
            }
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
        await this.reap();
    }

    private handleLine(line: string): void {
        if (!line.trim()) return;
        try {
            const message = JSON.parse(line) as Message;
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
            if (message.method) this.receive(message);
            else if (typeof message.id === 'number') {
                const entry = this.pending.get(message.id);
                if (!entry) return;
                this.pending.delete(message.id);
                clearTimeout(entry.timer);
                if (message.error) entry.reject(new Error(`Codex ${entry.method} protocol request failed (${message.error.code}). Check the CLI configuration and app-server compatibility; update Codex or this adapter if needed.`));
                else entry.resolve(message.result);
            }
        } catch {
            this.fail(new Error('Invalid Codex protocol message'));
        }
    }

    private overflow(): void {
        this.chunks = [];
        this.bufferedBytes = 0;
        this.fail(new Error('Codex protocol frame exceeded 4 MiB'));
    }

    private alive(): boolean {
        const pid = this.child.pid;
        if (!pid) return false;
        if (!this.grouped) return this.child.exitCode === null && this.child.signalCode === null;
        try {
            process.kill(-pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private kill(signal: NodeJS.Signals): void {
        if (!this.child.pid) return;
        try {
            if (this.grouped) process.kill(-this.child.pid, signal); else this.child.kill(signal);
        } catch { /* already gone */
        }
    }

    /** SIGTERM the whole group, SIGKILL whatever survives the grace period, then release pipes. */
    private reap(): Promise<void> {
        return this.reaping ??= (async () => {
            this.child.stdin.destroy();
            this.kill('SIGTERM');
            const killAt = Date.now() + KILL_GRACE_MS;
            while (this.alive() && Date.now() < killAt) await delay(10);
            if (this.alive()) this.kill('SIGKILL');
            // A descendant outside the group may still hold stdout/stderr open.
            this.child.stdout.destroy();
            this.child.stderr.destroy();
            await this.exited;
            this.unregister();
        })();
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
