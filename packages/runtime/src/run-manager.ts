/**
 * RunManager — Shadow 目录生命周期管理（架构 §2.2）
 *
 * start 时：创建 Shadow 目录结构、写 run.json、写 run.lock
 * resume 时：校验 status、检查 PID 锁、更新 run.lock
 * 运行中：update_status 更新 run.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {RunJson, RunStatus} from './types';

// ── RunManager ────────────────────────────────────────────────────────────────

export class RunManager {
    private runJson: RunJson;
    private ownedLock?: {dev: number; ino: number};

    private constructor(
        public readonly runDir: string,
        runJson: RunJson,
    ) {
        this.runJson = runJson;
    }

    get runId(): string {
        return this.runJson.run_id;
    }

    get workdir(): string {
        return this.runJson.workdir;
    }

    get intent(): string {
        return this.runJson.intent;
    }

    /**
     * start 时：在 runsDir 下创建新的 run 目录，初始化所有文件。
     */
    static create(opts: {
        runsDir: string;
        intent: string;
        workdir: string;
    }): RunManager {
        const runId = generateRunId();
        const hash8 = crypto
            .createHash('sha1')
            .update(path.resolve(opts.workdir))
            .digest('hex')
            .slice(0, 8);
        const basename = path.basename(path.resolve(opts.workdir));
        const workdirSegment = `${hash8}-${basename}`;
        const runDir = path.join(opts.runsDir, opts.intent, workdirSegment, runId);

        // 创建 Shadow 目录结构
        fs.mkdirSync(runDir, {recursive: true});
        fs.mkdirSync(path.join(runDir, 'io_records'));
        fs.mkdirSync(path.join(runDir, '.snapshot'));

        const now = new Date().toISOString();
        const runJson: RunJson = {
            run_id: runId,
            intent: opts.intent,
            workdir: opts.workdir,
            status: 'running',
            created_at: now,
            updated_at: now,
        };

        const mgr = new RunManager(runDir, runJson);
        mgr.writeRunJson();
        mgr.writeLock();
        return mgr;
    }

    /**
     * resume 时：读取已有 run 目录，校验 status 和 PID 锁。
     * 不允许 resume 的状态 → 抛出 Error。
     */
    static resume(runDir: string): RunManager {
        const runJsonPath = path.join(runDir, 'run.json');
        const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8')) as RunJson;

        // 校验 status
        const nonResumable = ['completed', 'aborted'];
        if (nonResumable.includes(runJson.status)) {
            throw new Error(
                `Cannot resume run with status "${runJson.status}". Use 'start' to create a new run.`,
            );
        }

        const mgr = new RunManager(runDir, runJson);
        mgr.writeLock();
        try {
            // The previous owner may have advanced while this caller was reading.
            mgr.runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')) as RunJson;
            if (nonResumable.includes(mgr.runJson.status)) {
                throw new Error(`Cannot resume run with status "${mgr.runJson.status}". Use 'start' to create a new run.`);
            }
            return mgr;
        } catch (error) {
            mgr.release();
            throw error;
        }
    }

    // ── 静态工厂 ──────────────────────────────────────────────────────────────

    /** 更新 run.json 的 status 字段，保留磁盘上已有的额外字段 */
    update_status(status: RunStatus): void {
        this.runJson.status = status;
        this.runJson.updated_at = new Date().toISOString();
        // Read current file to preserve any extra fields (e.g. ittPath, inputs written by platform)
        const runJsonPath = path.join(this.runDir, 'run.json');
        let onDisk: Record<string, unknown> = {};
        try {
            onDisk = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8')) as Record<string, unknown>;
        } catch { /* first write — no file yet */
        }
        const merged = {...onDisk, status, updated_at: this.runJson.updated_at};
        this.writeRunJson(merged);
    }

    /** Release only this process's lock after executor/resource cleanup has settled. */
    release(): void {
        const owned = this.ownedLock;
        if (!owned) return;
        const lock = path.join(this.runDir, 'run.lock');
        try {
            const stat = fs.statSync(lock);
            // A later manager in the same process is a different owner. Acquirers
            // cannot replace our existing lock while this PID is alive.
            if (stat.dev === owned.dev && stat.ino === owned.ino && fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.ownedLock = undefined;
    }

    // ── 私有方法 ──────────────────────────────────────────────────────────────

    private writeRunJson(value: unknown = this.runJson): void {
        const file = path.join(this.runDir, 'run.json');
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {flag: 'wx', mode: 0o600});
            fs.renameSync(temporary, file);
        } finally {
            fs.rmSync(temporary, {force: true});
        }
    }

    private writeLock(): void {
        const lock = path.join(this.runDir, 'run.lock');
        const guard = path.join(this.runDir, 'run.lock.guard');
        // Serialize stale-lock removal as well as creation. O_EXCL alone cannot
        // stop a stale contender from unlinking another contender's new lock.
        try {
            fs.mkdirSync(guard, {mode: 0o700});
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            throw new Error('Run lock transition is busy or interrupted; retry after the active process settles, or inspect run.lock.guard before recovering it.');
        }
        try {
            let previous: string | undefined;
            try {previous = fs.readFileSync(lock, 'utf8').trim();}
            catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
            if (previous !== undefined) {
                const pid = Number(previous);
                if (!/^[1-9]\d*$/.test(previous) || !Number.isSafeInteger(pid) || pid > 0x7fffffff) {
                    throw new Error('Invalid run lock PID; inspect the lock and active processes before recovery.');
                }
                if (isProcessAlive(pid)) throw new Error(`Run is already running (PID ${pid}). Cannot resume while process is still running.`);
                fs.unlinkSync(lock);
            }
            const fd = fs.openSync(lock, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, String(process.pid), 'utf8');
                const stat = fs.fstatSync(fd);
                this.ownedLock = {dev: stat.dev, ino: stat.ino};
            } finally {
                fs.closeSync(fd);
            }
        } finally {
            fs.rmdirSync(guard);
        }
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function generateRunId(): string {
    const now = new Date();
    const yyyyMMdd =
        String(now.getFullYear()) +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0');
    const rand = crypto.randomBytes(4).toString('hex').slice(0, 6);
    return `run_${yyyyMMdd}_${rand}`;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM and other inconclusive failures do not establish a dead owner.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}
