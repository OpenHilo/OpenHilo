import {createHash} from 'node:crypto';
import {AI_LEVELS, AI_TYPES, parseAiSelection, type AiSelection} from '@openhilo/itt-contracts/ai-selection';
import type {AiExecution, AiTaskExecutor, ExecutionHost} from './execution';
import type {Capability, JsonObject, SessionRef, TaskRequest, TaskResult} from './data';
import {assertCanStart, ContractError, isJsonValue} from './validation';

export interface ConfiguredAiTarget { executor: AiTaskExecutor; identity: JsonObject }
interface RouteGroup { defaultLevel: string; levels: Record<string, JsonObject> }
export type AiRoutes = Record<string, RouteGroup>;
const reject = (message: string): never => { throw new ContractError({code:'invalid_request',message:`AI routing: ${message}`,retryable:false,safeToReplay:true}); };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
    return value;
}

/** Shape-only validation. Provider-specific fields remain the factory's responsibility. */
export function parseAiRoutes(value: unknown): AiRoutes {
    if (!object(value) || !Object.hasOwn(value,'default')) return reject('routes.default is required');
    for (const [type, group] of Object.entries(value)) {
        if (!(AI_TYPES as readonly string[]).includes(type)) return reject('unknown route type');
        if (!object(group) || Object.keys(group).some(k=>!['defaultLevel','levels'].includes(k)) ||
            !(AI_LEVELS as readonly unknown[]).includes(group.defaultLevel) || !object(group.levels) ||
            !Object.hasOwn(group.levels,group.defaultLevel as string)) return reject(`invalid defaultLevel/levels for ${type}`);
        for (const [level, config] of Object.entries(group.levels)) {
            if (!(AI_LEVELS as readonly string[]).includes(level) || !object(config)) return reject(`expected a direct execution configuration in ${type}/${level}`);
        }
    }
    return clone(value) as unknown as AiRoutes;
}

/** Each configuration is passed to a host factory; users do not register target IDs. */
export function configureAiRouting(value: unknown, factory: (config: JsonObject) => ConfiguredAiTarget): RoutingTaskExecutor {
    const routes = parseAiRoutes(value);
    const targets = new Map<string, ConfiguredAiTarget>();
    for (const [type, group] of Object.entries(routes)) for (const [level, config] of Object.entries(group.levels)) {
        const target = factory(clone(config));
        if (!target?.executor?.id?.trim() || !Array.isArray(target.executor.capabilities) || typeof target.executor.start !== 'function' || !object(target.identity))
            return reject('factory must supply an executor and a non-secret identity description');
        if (target.executor.capabilities.includes('model_selection')) return reject('nested routing executors are unsupported');
        targets.set(`${type}/${level}`, {executor: target.executor, identity: clone(target.identity)});
    }
    return new RoutingTaskExecutor(routes, targets);
}

/** Immutable dispatch table; no retries, load balancing, tools, or provider policy. */
export class RoutingTaskExecutor implements AiTaskExecutor {
    readonly id: string;
    readonly capabilities: readonly Capability[];
    private readonly routes: AiRoutes;
    private readonly targets: ReadonlyMap<string, ConfiguredAiTarget>;
    constructor(routes: AiRoutes, targets: ReadonlyMap<string, ConfiguredAiTarget>) {
        this.routes = parseAiRoutes(routes);
        this.targets = new Map([...targets].map(([key,t])=>[key,{executor:t.executor,identity:clone(t.identity)}]));
        const description = Object.fromEntries(Object.entries(this.routes).map(([type,g])=>[type,{
            defaultLevel:g.defaultLevel, levels:Object.fromEntries(Object.keys(g.levels).map(level=>{
                const target=this.targets.get(`${type}/${level}`);
                if (!target) return reject(`missing internal target ${type}/${level}`);
                return [level,{executor:target.executor.id,identity:target.identity}];
            }))
        }]));
        this.id = 'openhilo.ai-routing.v1:' + createHash('sha256').update(JSON.stringify(canonical(description))).digest('hex');
        this.capabilities = Object.freeze([...new Set<Capability>(['model_selection', ...[...this.targets.values()].flatMap(t=>t.executor.capabilities)])]);
    }
    private resolve(selection?: AiSelection): string {
        let parsed: AiSelection;
        try { parsed=parseAiSelection(selection ?? {}); } catch { return reject('invalid AI selection'); }
        const type=parsed.type ?? 'default';
        const group=this.routes[type];
        if (!group) return reject(`missing route ${type}`);
        const key=`${type}/${parsed.level ?? group.defaultLevel}`;
        if (!this.targets.has(key)) return reject(`missing route ${key}`);
        return key;
    }
    private wrap(session: SessionRef, route: string): SessionRef {
        const target=this.targets.get(route)!;
        if (!object(session) || session.executorId!==target.executor.id || !Number.isSafeInteger(session.version) || session.version<1 ||
            typeof session.opaqueId!=='string' || !session.opaqueId.trim() ||
            (session.workspaceId!==undefined && (typeof session.workspaceId!=='string' || !session.workspaceId.trim()))) return reject('invalid target session');
        return {executorId:this.id,version:1,opaqueId:Buffer.from(JSON.stringify({route,session})).toString('base64url'),
            ...(session.workspaceId ? {workspaceId:session.workspaceId} : {})};
    }
    private unwrap(session: SessionRef): {route:string; session:SessionRef} {
        if (!object(session) || session.executorId!==this.id || session.version!==1 || typeof session.opaqueId!=='string') return reject('session identity mismatch');
        let decoded: unknown;
        try { decoded=JSON.parse(Buffer.from(session.opaqueId,'base64url').toString('utf8')); } catch { return reject('invalid routing session'); }
        if (!object(decoded) || Object.keys(decoded).some(k=>!['route','session'].includes(k)) || typeof decoded.route!=='string' ||
            !this.targets.has(decoded.route) || !object(decoded.session)) return reject('invalid routing session');
        const inner=decoded.session as unknown as SessionRef;
        this.wrap(inner,decoded.route); // same validation for every continuation/release entry
        if (inner.workspaceId!==session.workspaceId) return reject('session workspace mismatch');
        return {route:decoded.route,session:clone(inner)};
    }
    private result(result: TaskResult, route: string): TaskResult {
        if (!result.session) return result;
        // The authoritative result must still settle when a target reports a malformed session.
        try { return {...result,session:this.wrap(result.session,route)}; }
        catch {
            return {status:'failed',error:{code:'executor_failed',message:'AI routing: target returned an invalid session reference',retryable:false,safeToReplay:false},...(result.usage ? {usage:result.usage} : {})};
        }
    }
    private host(host: ExecutionHost, route: string): ExecutionHost {
        return {...host,onEvent:event=>host.onEvent(event.type==='terminal' ? {...event,result:this.result(event.result,route)} : event)};
    }
    private execution(execution: AiExecution, route: string): AiExecution {
        const result=execution.result.then(value=>this.result(value,route));
        const router=this;
        return {
            get session(){return execution.session ? router.wrap(execution.session,route) : undefined},
            get state(){return execution.state}, get health(){return execution.health}, result,
            answer:(id,value)=>execution.answer(id,value), cancel:reason=>execution.cancel(reason)
        };
    }
    async start(request: TaskRequest, host: ExecutionHost): Promise<AiExecution> {
        assertCanStart(request,host,this.id,this.capabilities);
        if (request.profile!==undefined) return reject('profile cannot override a routed configuration');
        const route=this.resolve(request.aiSelection);
        const target=this.targets.get(route)!.executor;
        const child=clone(request);
        delete child.aiSelection;
        child.requiredCapabilities=child.requiredCapabilities.filter(c=>c!=='model_selection');
        if (request.continuation) {
            const original=this.unwrap(request.continuation);
            if (original.route!==route) return reject('continuation route mismatch');
            child.continuation=original.session;
        }
        assertCanStart(child,host,target.id,target.capabilities);
        return this.execution(await target.start(child,this.host(host,route)),route);
    }
    async releaseSession(session: SessionRef): Promise<void> {
        const original=this.unwrap(session);
        await this.targets.get(original.route)!.executor.releaseSession?.(original.session);
    }
    async reconnect(session: SessionRef, host: ExecutionHost): Promise<AiExecution> {
        const original=this.unwrap(session), target=this.targets.get(original.route)!.executor;
        if (session.workspaceId!==undefined && session.workspaceId!==host.workspace?.id) return reject('session workspace mismatch');
        if (!target.reconnect || !target.capabilities.includes('reconnect')) throw new ContractError({code:'unsupported_capability',message:'Selected executor does not support reconnect',retryable:false,safeToReplay:true});
        return this.execution(await target.reconnect(original.session,this.host(host,original.route)),original.route);
    }
}
