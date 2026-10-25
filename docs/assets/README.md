# README diagram

The diagram illustrates the report-review example: the first Human review requests
changes, AI revises the report, and the second review allows Code to save it.
It is an illustration, not a recorded workflow run or a timing benchmark.

- `workflow.archify.json`: nodes, connections and source references.
- `workflow.playback.cjs`: the two-round animation schedule; branches are mutually exclusive.
- `workflow.css`: README-only presentation: no header, larger node labels and a tight diagram crop.
- `export-gif.cjs`: captures the complete animation with a deterministic browser clock.
- `workflow.gif`: the high-resolution, looping README image.

The exporter preserves Archify's light theme and moving edge layers. Nodes do not
pulse or highlight during playback. The repeated title, subtitle and playback
caption are excluded, along with browser controls and supplementary panels. The
crop contains only the workflow and legend. Drawing tools are not required to
install or use OpenHilo.

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

The export is 20 fps over 11.8 seconds at a 3× pixel scale (4128 × 1410 pixels).
The palette is sampled from complete frames to preserve static text and lines as
well as the animated edges. It checks the captured
edge sequence and rejects frames with multiple active branches. Inspect the image
before replacing `workflow.gif`. Node text bounds are checked after applying the
export styles. To inspect one frame first, add `--preview /tmp/workflow-preview.png`
to the export command; this writes only the preview and does not encode a GIF.

## Layout verification (2026-10-25)

The header-free export retains all seven nodes and the original two-round route.
The 236-frame GIF was decoded to verify its 4128 × 1410 dimensions and 11.8-second
duration. The exporter checked every animated edge against the existing schedule,
and checked node text bounds after applying the larger label styles. A decoded
frame was also inspected at README-like width: labels fit their boxes, the legend
remains visible, and the repeated header is absent.

## Attribution

The diagram uses [Archify](https://github.com/tt-a1i/archify), MIT licensed.
Its [license and attribution](ARCHIFY-LICENSE.txt) accompany the generated asset.
Archify, Playwright and FFmpeg are documentation tools, not OpenHilo runtime dependencies.
