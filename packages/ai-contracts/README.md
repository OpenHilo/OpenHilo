# AI task contracts

该包定义“调用 AI 完成工作”的公共契约，供 OpenHilo Runtime、生成服务和 AI 实现共同使用。
包包含契约、纯校验与协作执行生命周期；生产适配器位于独立包中。本包没有运行时第三方依赖。

TaskRequest 保存任务说明、结构化数据和能力要求；ExecutionHost 提供实时事件、工具宿主与取消信号。
TaskRequest 必须通过 JSON 往返；host 不能持久化。会话标识不得携带访问凭据。
start 拒绝表示执行前失败；返回执行句柄后的失败通过 result 表达。
onEvent 是同步有序通知，实现必须交付与执行状态隔离的事件快照；每个消费者负责隔离自己的异常，result 是最终状态的权威来源。
任务结果只接受通过输出契约验证的结构化字段。file/dir 字段是路径字符串，产物通过独立引用描述。

公共边界分为三部分：任务描述与输出契约由 `TaskRequest` 承载；实时事件、工具和可选工作区由 `ExecutionHost` 提供；模型、CLI
路径与提供方特定配置由具体适配器管理。应用自己的业务策略与数据库配置不属于公共 AI 任务参数。

continue 表示继续会话；reconnect 表示重连；二者均不自动保证工作流崩溃恢复。
任务超时、取消或输出失败不能证明工具副作用未发生。retryable 与 safeToReplay 分开解释。
available 是带观测时间的快照，不能保证随后执行一定成功。缺失用量不表示零。
advisory 预算只是目标，hard 预算必须通过能力检查。

测试专用 ScriptedExecutor 支持输出和串行提问，支持宿主取消与期限；不执行工具、不访问工作区、不报告用量、不持久化、不续接会话。
问题选项默认是建议项（optionsMode=suggested），允许自由回答或附加上下文；显式 exclusive 才限制答案为选项值。
每个 questionId 在一次尝试中唯一；重复已接受的回答返回 duplicate，内容不替换原回答；终止后其他回答返回 closed。
Runtime dispatcher 和生成服务通过本包连接独立 AI 适配器。

开发命令从仓库根执行：

    node node_modules/typescript/bin/tsc -p packages/ai-contracts/tsconfig.test.json
    node node_modules/jest/bin/jest.js --config packages/ai-contracts/jest.config.cjs --runInBand
    node node_modules/typescript/bin/tsc -p packages/ai-contracts/tsconfig.json

## Cooperative execution helper

`createTaskExecution(request, host, operation)` implements ordered events, correlated
questions, terminal output validation, cancellation and deadlines for adapter authors.
Call `assertCanStart` first. The operation receives an abort signal and must stop its
work and finish cleanup before settling. A cancellation request does not roll back
prior tool effects. `cancel()` waits for cleanup; a backend that ignores the signal
can therefore delay settlement. Each adapter must propagate this signal to its own backend.

The helper snapshots JSON data before notifying observers. Observer exceptions and
nested event mutations cannot alter pending questions or the authoritative result.

An execution may expose an opaque `session` reference before its outcome, so a host
can persist the identity while waiting for input. This is not a reconnect guarantee:
check the executor's `reconnect` capability and method. An unknown execution must not
be silently restarted. `releaseSession`, when provided, frees an idle continuation
session after the workflow is finished; it is separate from cancelling an active
attempt. Both capabilities are optional; check the executor interface before using them.

## Execution health and stopping

The cooperative helper emits `health` events independently of model output and exposes
`execution.health` while the attempt is live. Defaults in `host.monitoring` are:

| Option           | Default    | Meaning                                                       |
|------------------|------------|---------------------------------------------------------------|
| `heartbeatMs`    | 5,000 ms   | Report liveness even without provider output                  |
| `slowAfterMs`    | 60,000 ms  | Active execution duration, excluding time waiting for a user  |
| `stalledAfterMs` | 180,000 ms | No new progress, or a tool invocation exceeding this duration |
| `stopGraceMs`    | 10,000 ms  | Stopping/cleanup has not drained within this duration         |

Threshold crossing is reported on the next heartbeat. `condition: 'stalled'` is a
watchdog warning, not proof of a deadlock; long tools can legitimately exceed the
threshold. Health includes `phase`, elapsed/idle/phase duration, active tool count,
`stalledTools`, `observedAt` and the heartbeat interval. Heartbeats and unchanged usage
receipts do not count as progress. Implementations may emit `phase` (`starting`,
`model`, `cleanup`); tool and question phases are derived by the helper. A tool that
asks a question should pass its event call ID to `context.ask(question, toolCallId)`
to pause that tool's watchdog; other concurrent tools remain monitored. No input,
output, prompt or tool arguments are included in health snapshots.

Cancellation/deadline expiry immediately changes `execution.state` to `stopping`
and emits health with `stopReason`. `cancel()` and `result` still wait for real cleanup:
a noncooperative tool retains its resource/session ownership. An observer can act on
stopping/stalled telemetry without waiting for `cancel()` to resolve. Do not implement
a timeout by pretending effects ended or by automatically replaying the task.
The default active execution budget is twelve hours. An explicit host `deadlineAt`
sets the initial budget; adapters can also accept a configured timeout. Pending
user questions pause that budget until all questions are answered. Monitoring
thresholds alone never cancel or retry. Health exposes `activeElapsedMs` and
`remainingMs`; the projected `deadlineAt` is omitted while waiting and moves
forward after the answer. Manual cancellation remains available during waits.
Timeouts settle explicitly and never authorize automatic replay.

A heartbeat shows that the host event loop can run, not that the remote model is
making progress. Consumers should independently detect stale `observedAt` snapshots
(for example, max(three heartbeat intervals, 15 seconds)); a blocked event loop or
lost worker cannot emit its own warning. External `AiTaskExecutor` implementations
that do not use this helper must supply equivalent health events to participate.

## Type and level routing

The optional `@openhilo/ai-contracts/routing` entry provides `configureAiRouting(routes, factory)`. It resolves `TaskRequest.aiSelection`, delegates to one configured executor and wraps its sessions. It adds no provider dependency or retry policy. See [AI routing](../../docs/ai-routing.md) for the host contract and a runnable example.

### Nested output contracts

`TaskRequest.output` retains the named transport kinds. Optional `outputShapes` refines
those fields using the serializable `InputShape` data contract from
`@openhilo/itt-contracts/run-inputs`. Call `validateOutputs(output, value, outputShapes)`
before reporting completion. Validation preserves values and identifies missing or
incorrect nested fields (for example, `plan.urls` or `plan.queries[0]`); it never
coerces values, substitutes defaults, or retries the task.

The compiler emits these shapes for AI declarations with explicit TypeScript return
types, including nested objects, arrays, optional fields, unions, literals, tuples
and records. Extra object fields remain compatible with TypeScript structural typing.
`unknown`/`any` remain unstructured JSON. Existing snapshots without `outputShapes`
retain kind-only validation; recompile workflow source to opt into nested checks.
Runtime dispatch checks outputs again even when a custom executor reports success.
An invalid result is `invalid_output` with `safeToReplay: false`, since validation
cannot prove that an AI task performed no external effects.
