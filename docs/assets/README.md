# README diagram

The diagram illustrates the report-review example: the first Human review requests
changes, AI revises the report, and the second review allows Code to save it.
It is an illustration, not a recorded workflow run or a timing benchmark.

- `workflow.archify.json`: nodes, connections and source references.
- `workflow.playback.cjs`: the two-round animation schedule; branches are mutually exclusive.
- `workflow.css`: presentation adjustments for the diagram caption.
- `export-gif.cjs`: captures the complete animation with a deterministic browser clock.
- `workflow.gif`: the high-resolution, looping README image.

The exporter preserves Archify's light theme and moving edge layers. Nodes do not
pulse or highlight during playback. Browser controls and supplementary panels are
excluded from the image. Drawing tools are not required to install or use OpenHilo.

## Regenerate

Use Node, Git, FFmpeg and Playwright 1.58 or later in a separate tooling directory.
From the repository root, choose unused temporary paths:

```sh
git clone https://github.com/tt-a1i/archify.git /tmp/openhilo-archify
git -C /tmp/openhilo-archify checkout 25cf37080fc8b1dbe758a4efc3935b55f3327083
npm install --prefix /tmp/openhilo-drawing-tools --no-audit --no-fund playwright
/tmp/openhilo-drawing-tools/node_modules/.bin/playwright install chromium
node /tmp/openhilo-archify/archify/bin/archify.mjs finalize architecture docs/assets/workflow.archify.json /tmp/openhilo-workflow.html --repo-root . --quality showcase --json
OPENHILO_DOCS_PLAYWRIGHT=/tmp/openhilo-drawing-tools/node_modules/playwright node docs/assets/export-gif.cjs --input /tmp/openhilo-workflow.html --output /tmp/openhilo-workflow.gif
```

Archify's browser check requires Chrome/Chromium; set `ARCHIFY_CHROME` to the
installed executable if it cannot be detected. The GIF exporter uses isolated
Playwright Chromium, blocks HTTP(S) requests, and does not overwrite existing
output files. `FFMPEG` optionally selects a particular FFmpeg executable.

The export is 20 fps over 11.8 seconds at a 3× pixel scale (4320 × 1911 pixels).
The palette is sampled from complete frames to preserve static text and lines as
well as the animated edges. It checks the captured
edge sequence and rejects frames with multiple active branches. Inspect the image
before replacing `workflow.gif`.

## Attribution

The diagram uses [Archify](https://github.com/tt-a1i/archify), MIT licensed.
Its [license and attribution](ARCHIFY-LICENSE.txt) accompany the generated asset.
Archify, Playwright and FFmpeg are documentation tools, not OpenHilo runtime dependencies.
