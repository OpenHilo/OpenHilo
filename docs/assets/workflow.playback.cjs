// Review-only playback: reuse Archify's SVG paths, comet layers and Live/Still controls.
// This is an illustrative route schedule, not a workflow execution trace.
const routes = [
    {label: 'Revise, then pass · false → next round → true', nodes: ['write', 'review', 'choice', 'again', 'write', 'review', 'choice', 'save', 'result']}
];
function timeline() {
    let time = 0;
    const steps = [];
    for (const route of routes) {
        let round = 0;
        for (let i = 0; i < route.nodes.length - 1; i++) {
            const from = route.nodes[i], to = route.nodes[i + 1];
            if (from === 'write') round++;
            const label = `Round ${round} · ${round === 1 ? 'request revision (approved = false)' : 'approve (approved = true)'}`;
            const dwell = from === 'review' || from === 'choice' ? 0.7 : 0.25;
            steps.push({from, to, label, start: time, depart: time + dwell, end: time + dwell + 0.85});
            time += dwell + 0.85;
        }
        steps.push({from: route.nodes.at(-1), label: 'Complete · revised, approved, saved', start: time, end: time + 1.2});
        time += 1.2;
    }
    return {steps, duration: time};
}
if (typeof module !== 'undefined') module.exports = {routes, timeline};
else (() => {
    const svg = document.querySelector('.diagram-container svg');
    const plan = timeline();
    const edges = new Map();
    for (const path of svg.querySelectorAll('path[data-animate="edge"]')) {
        const layers = [];
        for (let e = path.nextElementSibling; e?.hasAttribute('data-ambient-flow-overlay'); e = e.nextElementSibling) {
            e.style.setProperty('animation', 'none', 'important');
            e.style.opacity = '0';
            layers.push({element: e, shift: parseFloat(e.style.getPropertyValue('--flow-shift')) || 0});
        }
        edges.set(`${path.dataset.edgeFrom}:${path.dataset.edgeTo}`, {layers, length: path.getTotalLength()});
    }
    for (const step of plan.steps) {
        if (step.to && !edges.has(`${step.from}:${step.to}`)) throw new Error(`Missing authored edge ${step.from}:${step.to}`);
    }
    const nodes = new Map([...svg.querySelectorAll('[data-node-id]')].map(n => [n.dataset.nodeId, n]));
    for (const node of nodes.values()) for (const shape of node.querySelectorAll('[data-animate="node"]')) {
        shape.style.setProperty('animation', 'none', 'important');
        shape.style.opacity = '1';
    }
    const subtitle = document.querySelector('.subtitle');
    const status = document.createElement('span');
    status.className = 'demo-path';
    subtitle.append(status);
    let elapsed = 0, previous;
    function frame(now) {
        const paused = Archify.motionGovernor.isPaused() || !!Archify.motionGovernor.owner() || document.hidden;
        if (previous !== undefined && !paused) elapsed += Math.min((now - previous) / 1000, 0.1);
        previous = now;
        const time = elapsed % plan.duration;
        const step = plan.steps.find(s => time >= s.start && time < s.end);
        for (const edge of edges.values()) for (const layer of edge.layers) layer.element.style.opacity = '0';
        status.textContent = `Illustrative path: ${step.label}${paused ? ' · paused' : ''}`;
        svg.dataset.demoEdge = '';
        if (!paused && step.to && time >= step.depart) {
            const edge = edges.get(`${step.from}:${step.to}`);
            const p = Math.min(1, (time - step.depart) / (step.end - step.depart));
            const eased = p * p * (3 - 2 * p);
            const fade = Math.min(1, p / 0.1, (1 - p) / 0.15);
            svg.dataset.demoEdge = `${step.from}:${step.to}`;
            for (const {element, shift} of edge.layers) {
                const peak = parseFloat(getComputedStyle(element).getPropertyValue('--flow-peak')) || 0.5;
                element.style.opacity = String(Math.max(0, fade * peak));
                if (element.tagName.toLowerCase() === 'circle') {
                    element.style.opacity = '0'; // No landing pulse on the node.
                } else element.style.strokeDashoffset = String((1 - eased) * edge.length + shift);
            }
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();
