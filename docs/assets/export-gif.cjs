#!/usr/bin/env node
// Documentation-only export of the illustrated two-round workflow.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {spawnSync} = require('node:child_process');
const {parseArgs} = require('node:util');
const {timeline} = require('./workflow.playback.cjs');
async function main(args) {
    const {values} = parseArgs({args, options: {input: {type: 'string'}, output: {type: 'string'}, preview: {type: 'string'}}});
    if (!values.input || !values.output) throw new Error('Use --input <Archify HTML> --output <new GIF>');
    const input = path.resolve(values.input), output = path.resolve(values.output);
    if (fs.existsSync(output)) throw new Error('Output already exists; choose a new GIF path');
    const ffmpeg = process.env.FFMPEG || 'ffmpeg';
    const version = spawnSync(ffmpeg, ['-version'], {encoding:'utf8'});
    if (version.error || version.status !== 0) throw new Error('Install FFmpeg to export GIF');
    const {chromium} = require(process.env.OPENHILO_DOCS_PLAYWRIGHT || 'playwright');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-gif-'));
    let browser;
    try {
        let html = fs.readFileSync(input, 'utf8');
        if (!html.includes('id="archify-diagram-title"')) throw new Error('Expected rendered Archify HTML');
        html = html.replace('</head>', '<style>' + fs.readFileSync(path.join(__dirname,'workflow.css'),'utf8') + '</style></head>');
        html = html.replace('</body>', '<script>' + fs.readFileSync(path.join(__dirname,'workflow.playback.cjs'),'utf8') + '</script></body>');
        const pageFile = path.join(temp, 'diagram.html'); fs.writeFileSync(pageFile, html);
        browser = await chromium.launch({headless:true});
        const page = await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:3});
        await page.route(/^https?:/,route=>route.abort());
        const start = new Date('2026-01-01T00:00:00Z');
        await page.clock.install({time:start});
        await page.clock.pauseAt(start);
        await page.goto(pathToFileURL(pageFile).href+'?theme=light');
        await page.addStyleTag({content:'.toolbar,.diagram-nav,.reader-rail,.cards,#node-outline {visibility:hidden!important} .pulse-dot {animation:none!important}'});
        await page.evaluate(()=>window.Archify.motionGovernor.resume({persist:false}));
        await page.clock.runFor(50);
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => [...document.querySelectorAll('svg [data-node-id]')].flatMap(node => {
            const box = node.querySelector('rect')?.getBBox();
            if (!box) return [];
            return [...node.querySelectorAll('text')].filter(text => {
                const b = text.getBBox();
                return b.x < box.x + 3 || b.x + b.width > box.x + box.width - 3;
            }).map(text => `${node.dataset.nodeId}: ${text.textContent}`);
        }));
        if (overflow.length) throw new Error('Node text exceeds its box: ' + overflow.join(', '));
        const clip = await page.evaluate(()=>{
            const diagram=document.querySelector('.diagram-container').getBoundingClientRect();
            return {x:Math.floor(diagram.x), y:Math.floor(diagram.y), width:Math.ceil(diagram.width), height:Math.ceil(diagram.height)};
        });
        if (values.preview) {
            const preview = path.resolve(values.preview);
            if (fs.existsSync(preview)) throw new Error('Preview already exists; choose a new path');
            await page.screenshot({path:preview, clip});
            console.log(JSON.stringify({preview, clip}));
            return;
        }
        const fps=20, count=Math.round(timeline().duration*fps);
        const visited=[];
        for(let i=0;i<count;i++) {
            const state = await page.evaluate(()=>{
                const svg=document.querySelector('.diagram-container svg');
                const active=[...svg.querySelectorAll('path[data-animate="edge"]')].filter(path=>{
                    for(let next=path.nextElementSibling;next?.hasAttribute('data-ambient-flow-overlay');next=next.nextElementSibling)
                        if(Number(next.style.opacity)>0.01) return true;
                    return false;
                }).map(path=>`${path.dataset.edgeFrom}:${path.dataset.edgeTo}`);
                return {edge:svg.dataset.demoEdge,active};
            });
            if(state.active.length>1) throw new Error('More than one edge animated at once');
            if(state.edge && visited.at(-1)!==state.edge) visited.push(state.edge);
            await page.screenshot({path:path.join(temp,`frame-${String(i).padStart(4,'0')}.png`),clip});
            if(i<count-1) await page.clock.runFor(1000/fps);
            if(i%60===0) console.log(`Captured ${i+1}/${count} frames`);
        }
        const expected=timeline().steps.filter(s=>s.to).map(s=>`${s.from}:${s.to}`);
        if(JSON.stringify(visited)!==JSON.stringify(expected)) throw new Error('Captured route differs from the two-round schedule: '+JSON.stringify(visited));
        const encoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-n','-framerate',String(fps),'-i',path.join(temp,'frame-%04d.png'),'-filter_complex','split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle','-loop','0',output],{encoding:'utf8'});
        if(encoded.error||encoded.status!==0) throw new Error(encoded.error?.message||encoded.stderr||'GIF encoding failed');
        console.log(JSON.stringify({output,frames:count,fps,duration:count/fps,bytes:fs.statSync(output).size,verifiedRoute:visited}));
    } finally {
        await browser?.close(); fs.rmSync(temp,{recursive:true,force:true});
    }
}
if(require.main===module) main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={main};
