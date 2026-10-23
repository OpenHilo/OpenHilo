# Quickstart

Use a source checkout, Node 22 or 24, npm, Bash and Python 3. No global OpenHilo
installation, server or database is required. See [validation](validation.md)
for tested platforms and the latest CI results.

## Get the source

```sh
git clone https://github.com/eric2610abc/OpenHilo.git
cd OpenHilo
```

Skip these commands if you already have a checkout or unpacked source archive.

## Check your environment

Use the source checkout or unpacked source archive. All `node examples/...` and
`npm run ...` commands below run from its **root**, where `package.json`,
`packages/` and `examples/` live. Do not run them inside an individual example
folder. No published `@openhilo/*` package or global OpenHilo command is needed.

Check `node --version`: the supported majors are **22 and 24**. An
`npm WARN EBADENGINE` on Node 25 (or another major) may leave an installed tree,
but it does not mean that version is validated. Select Node 22 or 24 with your
usual Node manager, verify the active version, then rerun the install/build
commands. For example, **if you already use nvm**:

```sh
nvm install
nvm use
node --version
```

The checkout's `.nvmrc` selects Node 24. Node 22 is also supported. Other Node
managers can select either supported major explicitly. Before installing, check
the executables the examples actually invoke:

```sh
node --version
npm --version
python3 --version
bash --version
```

Python must be available as `python3`; Bash must be available as `bash`. Installing
Node alone does not supply them. These examples use macOS/Linux-style paths and
shell commands; native Windows has not been verified. SDK-only examples need
Node/npm and credentials, but do not execute Python or Bash themselves.

`npm ci --ignore-scripts --no-audit --no-fund` installs the locked dependencies
and links the local workspaces; it requires registry access or a populated npm
cache. It does not publish a package. `npm run build:packages` then generates
required `dist` files. Run installation once per fresh checkout/lockfile change
and rebuild after source changes; do not skip the build in a source archive.

Every `--output` must name a **new directory**. If a command was interrupted or
already completed, retain that directory for inspection and choose another name
for a new run. Quote paths containing spaces. A newly opened terminal used for
recovery must select the same supported Node version and return to this root.

## Build and run your first workflow

From the repository root:

```sh
node --version
python3 --version
bash --version
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
node examples/compose-tasks/run.cjs --provider offline --input examples/compose-tasks/input.sample.json --output /tmp/openhilo-first
```

Enter `Release dates` at the Human question and open `/tmp/openhilo-first/summary.md`.
Offline mode echoes scripted text, including your requirements; it does not call AI.
The workflow still executes real Human and Code steps. To use a real model, complete
Codex setup below and repeat with `--provider codex` and a new output directory.
[Full example and source](../examples/compose-tasks/README.md).

To write your own workflow, follow the [complete minimal host](embedding.md#complete-minimal-host).
To install the libraries into another application, use [local tarballs](#embed-packages-from-local-tarballs).
There is no global `openhilo` application to start after this installation.

## Install and sign in to Codex

Skip this section for scripted offline examples, the local report, or direct SDK
examples. For real Codex workflows, install the CLI separately using the
[official installation guide](https://learn.chatgpt.com/docs/codex/cli).
With npm, one option is:

```sh
npm install -g @openai/codex
codex --version
codex login
codex login status
```

Complete the browser sign-in requested by `codex login` using an account with
Codex access. If you already have a working CLI and login, only check the version
and login status. See [official authentication help](https://learn.chatgpt.com/docs/auth)
for API-key, headless or managed-account setup. OpenHilo uses the CLI's existing
login; do not copy credentials into the repository. These commands install and
configure Codex, not OpenHilo packages, and do not publish anything.

## AI edits files

The [document review example](../examples/document-review/README.md) passes a
requirements file and a directory of reference notes into the workflow, lets Codex create and revise a real Markdown
file, and supports Human review across process restarts. It uses an isolated
`workspace-write` directory; preserve that directory when resuming.

## Code verifies an AI repair

The [script repair example](../examples/script-repair/README.md) runs fixed Python
tests, gives real failures to Codex, then tests the edited script again. It allows
at most two AI repairs; an already-passing script needs none. With Codex installed
and signed in, choose a new output directory:

```sh
node examples/script-repair/run.cjs --output /tmp/openhilo-script-repair
```

The input is copied, not edited in place. Test failures and AI progress appear in
the terminal, and the final script and run records remain available for inspection.

## AI revision and recovery

Complete [Codex setup](#install-and-sign-in-to-codex) first. The example uses your
existing CLI login and checks protocol compatibility during execution.

```sh
codex --version
node examples/review-report/run.cjs --provider codex --input examples/review-report/input.sample.json --output /tmp/openhilo-review-first --defer-human
```

The process creates the first draft, prints `Records: <run directory>` and exits
with status 2 at a saved Human checkpoint. This is expected: no Human result has
been submitted yet. In a new terminal,
return to the repository root and replace the quoted placeholder below with that
exact Records directory (not the top-level output directory). Do not include the
angle brackets:

```sh
node examples/review-report/resume.cjs --provider codex --run-dir '<run directory printed above>'
```

Reply to `approved` with `1` (Yes/true) or `2` (No/false), then type `feedback` (Enter submits an empty string). Both
fields are collected every round. The workflow saves an approved result or uses feedback for another draft. The example
allows at most
three reviews. Ctrl+C or EOF leaves the request waiting. The prompt shows the available choices.
Use `--provider offline` on both commands for an explicitly scripted rehearsal;
it is not evidence of model quality. Never switch providers when resuming this run.

For direct SDK tasks, follow [SDK text](../examples/sdk-text/README.md) or
[SDK tools](../examples/sdk-tools/README.md). They require separate model/API key
configuration; a Codex subscription is not SDK billing authorization. No default
paid model or silent fallback is selected.

## Embed packages from local tarballs

Nothing is published to a registry. First generate and verify local archives:

```sh
npm run check:consumers -- --output /tmp/openhilo-consumer-check
```

Use a new directory. The command prints progress, builds twelve archives from
already-built packages and records their SHA-256 in `report.json`. It installs
separate minimal consumer closures, checks public types and runs offline examples.
Packing is not publishing. Run `npm run build:packages` first after source changes.

For a new compiler-only application, install just its two local core tarballs:

```sh
mkdir /tmp/openhilo-compiler-app
cd /tmp/openhilo-compiler-app
npm init -y
npm install --ignore-scripts --no-audit --no-fund /tmp/openhilo-consumer-check/tarballs/openhilo-compiler-0.1.0.tgz /tmp/openhilo-consumer-check/tarballs/openhilo-itt-contracts-0.1.0.tgz
node node_modules/@openhilo/compiler/dist/cli.js node_modules/@openhilo/compiler/examples/program.json
```

The result has `ok: true`, entries and compiled artifacts. For Runtime+Human,
Runtime+Code, Codex or SDK, the matching consumer `package.json` inside the check
directory shows its exact local closure. Do not replace local paths with registry
package names while these packages are available only as source/local archives. Packaged Runtime
examples are executable from `node_modules/@openhilo/runtime/examples/`; the
root examples remain part of the source checkout.

Only ITT input helpers and Studio contracts advertise ESM entries. Other core
entry points are CommonJS. The Codex `./studio` entry is optional TSX for an
application bundler with React 19; importing the Codex main entry requires no React.

Console presentation: `[log]` progress, timing and usage are dimmed in interactive terminals. Task content and questions
use the terminal default foreground; input prompts may be bold. Errors remain prominent. Piped output, `NO_COLOR`, and
`TERM=dumb` use plain text. Styling never enters saved workflow events.
