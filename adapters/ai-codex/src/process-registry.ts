import * as os from 'os';

/**
 * Live subprocess groups do not receive terminal signals, so they are stopped
 * when the host exits or is interrupted. Handlers are installed only while a
 * group is live; an otherwise-unhandled signal still terminates the host.
 */
export interface LiveProcess {
    pid: number;
    grouped: boolean;
}

const live = new Set<LiveProcess>();
const HOST_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_GRACE_MS = 1000;
let terminating = false;

function signalProcess(entry: LiveProcess, signal: NodeJS.Signals | 0): boolean {
    try {
        process.kill(entry.grouped ? -entry.pid : entry.pid, signal);
        return true;
    } catch {
        return false;
    }
}

function signalAll(signal: NodeJS.Signals): void {
    for (const entry of live) signalProcess(entry, signal);
}

function onExit(): void {
    // No asynchronous grace period exists once the host is exiting.
    signalAll('SIGTERM');
    signalAll('SIGKILL');
}

function reraise(signal: NodeJS.Signals): void {
    uninstall();
    // Node restores the default disposition once no listeners remain.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), 100);
}

function onSignal(signal: NodeJS.Signals): void {
    signalAll('SIGTERM');
    // Another listener owns the host's response; the exit hook still applies.
    if (process.listenerCount(signal) > 1) return;
    if (terminating) {
        signalAll('SIGKILL');
        reraise(signal);
        return;
    }
    terminating = true;
    const deadline = Date.now() + SIGNAL_GRACE_MS;
    const poll = () => {
        if (Date.now() < deadline && [...live].some(entry => signalProcess(entry, 0))) {
            setTimeout(poll, 10);
            return;
        }
        signalAll('SIGKILL');
        reraise(signal);
    };
    poll();
}

function install(): void {
    process.on('exit', onExit);
    for (const signal of HOST_SIGNALS) process.on(signal, onSignal);
}

function uninstall(): void {
    process.removeListener('exit', onExit);
    for (const signal of HOST_SIGNALS) process.removeListener(signal, onSignal);
}

export function registerProcess(entry: LiveProcess): () => void {
    if (live.size === 0 && !terminating) install();
    live.add(entry);
    return () => {
        if (!live.delete(entry)) return;
        if (live.size === 0 && !terminating) uninstall();
    };
}
