// Build a self-contained explanation from the deployed map's actual configuration.
// CPU only. Optional image inputs record evidence; they never alter game geometry.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ELEMENTS } from '../src/elements.js';
import { createFold } from '../src/world/scenes/descent/terrainFold.js';

const root = new URL('../', import.meta.url);
const path = p => fileURLToPath(new URL(p, root));
const read = p => fs.readFileSync(path(p));
const route = JSON.parse(read('public/local-maps/noita-terrain/route.json'));
const config = JSON.parse(read('tools/noita-terrain-source.json'));
const fold = createFold(route.fold);
const evidence = path('public/noita-evidence/');
fs.mkdirSync(evidence, { recursive: true });
for (const [flag, name] of [['--coal-shot', 'coal-live.webp'], ['--reference', 'noita-reference.webp']]) {
  const i = process.argv.indexOf(flag);
  if (i >= 0) {
    if (!process.argv[i + 1]) throw new Error(`Missing image after ${flag}`);
    execFileSync('magick', [process.argv[i + 1], '-quality', '85', `${evidence}${name}`]);
  }
}
const image = file => `data:image/webp;base64,${read(`public/noita-evidence/${file}`).toString('base64')}`;
const proof = JSON.parse(read('public/noita-evidence/coal-proof.json'));
const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const n = x => Number(x.toFixed(2));
const colors = {
  holyMountain:'#80672f',coal:'#777063',mountainCoal:'#80672f',snow:'#3f6c89',
  mountainSnow:'#80672f',hiisi:'#4c6474',mountainHiisi:'#80672f',
  jungle:'#506d2b',mountainJungle:'#80672f',vault:'#3f5e51',
  mountainVault:'#80672f',crypt:'#6a5b3a',arena:'#934323',
};
const top = 1024, bottom = config.sourceY[1];
const vy = y => 54 + (y - top) / (bottom - top) * 602;
const bands = route.regions.map(r =>
  `<path d="M 37 ${n(vy(r.core[0]))} H 394" class="band-line"/><title>${esc(r.key)}: ${r.core.join('–')}</title>`
).join('');
const sourceDiagram = `<svg viewBox="0 0 520 720" role="img" aria-labelledby="source-title source-desc">
  <title id="source-title">Noita's main descent in two dimensions</title>
  <desc id="source-desc">Wide biome areas stacked vertically, separated by Holy Mountains. This is a schematic of source ranges, not a drawing of caves.</desc>
  <text x="36" y="27" class="axis">LEFT / RIGHT IN THE ORIGINAL MAP</text>
  ${route.sections.map(s => {
    const [a,b] = s.sourceRange, y = vy(a), h = vy(b)-y;
    const holy = s.label === 'Holy Mountain';
    return `<rect x="${holy?66:37}" y="${n(y)}" width="${holy?299:357}" height="${n(h-2)}" fill="${colors[s.key]}"/>
      <text x="${holy?79:50}" y="${n(y+h/2+5)}" class="${holy?'holy-label':'biome-label'}">${esc(s.label)}</text>`;
  }).join('')}
  <g class="chunk-lines">${bands}</g>
  <path d="M 430 59 V 650 l -6 -10 m 6 10 l 6 -10" fill="none" stroke="#352f29" stroke-width="2"/>
  <text x="446" y="340" class="axis" transform="rotate(90 446 340)">DOWN THROUGH THE WORLD</text>
  <text x="36" y="690" class="note">Schematic. Widths and cave shapes are not shown.</text>
</svg>`;

// Coordinate diagram, not invented room geometry or a proposed new design.
const project = (x, y) => {
  const theta = route.fold.angleStart + (x-route.fold.sourceMinX) / route.fold.sourceWidth * route.fold.angleSpan;
  return [260 + 200*Math.cos(theta), 80 + (y-top)/(bottom-top)*540 + 48*Math.sin(theta)];
};
const arc = (a,b,y) => Array.from({length:65},(_,i)=>project(a+(b-a)*i/64,y));
const points = ps => ps.map(p=>p.map(n).join(',')).join(' ');
const sectionBounds = s => {
  if (s.key === 'arena') return [1536,4136];
  const rows = Object.entries(config.rowEnvelopes).filter(([row])=>
    (Number(row)-14)*512 < s.sourceRange[1] && (Number(row)-13)*512 > s.sourceRange[0]);
  return [Math.min(...rows.map(([,v])=>(v[0]-35)*512)),
    Math.max(...rows.map(([,v])=>(v[1]+1-35)*512))];
};
const curtain = route.sections.map(s => {
  const [a,b] = sectionBounds(s), [y0,y1] = s.sourceRange;
  return `<polygon points="${points([...arc(a,b,y0),...arc(a,b,y1).reverse()])}" fill="${colors[s.key]}" fill-opacity=".8" stroke="#f6f2e9" stroke-width="1"/>`;
}).join('');
const seamLines = route.regions.filter(r=>r.core[0]>top).map(r=>{
  const s=route.sections[r.sectionIndex], [a,b]=sectionBounds(s);
  return `<polyline points="${points(arc(a,b,r.core[0]))}" class="band-line"/>`;
}).join('');
const fixedX = [project(-677,1350),project(-677,12800)];
const foldedDiagram = `<svg viewBox="0 0 520 720" role="img" aria-labelledby="fold-title fold-desc">
  <title id="fold-title">What the current conversion actually does</title>
  <desc id="fold-desc">Horizontal coordinates curve around a large arc. Every biome stays at its original vertical depth. This is a curved vertical sheet, not an authored route folding through three-dimensional rooms.</desc>
  <polyline points="${points(arc(-4608,4608,1024))}" fill="none" stroke="#74695c" stroke-dasharray="4 5"/>
  ${curtain}
  <g class="chunk-lines">${seamLines}</g>
  <polyline points="${points(fixedX)}" fill="none" stroke="#a32922" stroke-width="3" stroke-dasharray="7 5"/>
  <circle cx="${n(fixedX[0][0])}" cy="${n(fixedX[0][1])}" r="5" fill="#a32922"/>
  <text x="21" y="24" class="axis">HORIZONTAL X BENT AROUND AN ARC</text>
  <text x="21" y="675" class="note">Same source X stays at the same world X/Z.</text>
  <text x="21" y="697" class="note">Coordinate diagram only. No cave geometry shown.</text>
</svg>`;

const coal = route.sections.find(s=>s.key==='coal');
const [ct,cb] = coal.sourceRange, width=route.fold.sourceWidth;
const raster = new Uint8Array(width*(cb-ct)).fill(255);
for (const r of route.regions) {
  const a=Math.max(ct,r.core[0]),b=Math.min(cb,r.core[1]);
  if (a>=b) continue;
  // Native plane only: v2 packs append the inflation depth and backdrop planes.
  const bytes=gunzipSync(read(`public/local-maps/noita-terrain/${r.file}`)).subarray(0,width*r.sourceHeight);
  if (createHash('sha256').update(bytes).digest('hex')!==r.sha256) throw new Error(`Bad source hash: ${r.key}`);
  raster.set(bytes.subarray((a-r.sourceTop)*width,(b-r.sourceTop)*width),(a-ct)*width);
}
const rgb = Buffer.alloc(1024*256*3);
for(let y=0;y<256;y++) for(let x=0;x<1024;x++) {
  const sx=-2048+x*4+2,sy=ct+y*4+2;
  const index=raster[(sy-ct)*width+sx-route.fold.sourceMinX];
  const hex=index===255?'332d29':index===0?'101116':ELEMENTS[route.palette[index].element].color.slice(1);
  const v=parseInt(hex,16),i=(y*1024+x)*3;
  rgb[i]=v>>16&255;rgb[i+1]=v>>8&255;rgb[i+2]=v&255;
}
const coalPng=execFileSync('magick',['ppm:-','png:-'],{input:Buffer.concat([Buffer.from('P6\n1024 256\n255\n'),rgb]),maxBuffer:8*1024*1024});
const coalSvg=`<svg viewBox="0 0 1024 256" role="img" aria-label="Actual Coal Pits source material raster, recolored using our element palette. Red circle marks the screenshot's approximate feet position.">
<image width="1024" height="256" href="data:image/png;base64,${coalPng.toString('base64')}"/>
<circle cx="364.625" cy="187.25" r="13" fill="none" stroke="#fff" stroke-width="4"/><circle cx="364.625" cy="187.25" r="9" fill="none" stroke="#e64832" stroke-width="4"/>
</svg>`;
const count = route.regions.filter(r=>r.sectionIndex===route.sections.indexOf(coal)).length;
if(count!==4 || route.regions.length!==51) throw new Error('Snapshot changed: revise the explanatory copy before publishing.');
let html=read('docs/noita-map-explained.template.html').toString();
for(const [key,value] of Object.entries({
  SOURCE_DIAGRAM:sourceDiagram,FOLDED_DIAGRAM:foldedDiagram,COAL_RASTER:coalSvg,
  COAL_SCREENSHOT:image('coal-live.webp'),NOITA_REFERENCE:image('noita-reference.webp'),
  RADIUS:Math.round(fold.radius),SOURCE_HASH:route.source.materialRasterSha256,
  ORIGINAL_CHUNK:`data:image/png;base64,${read('public/noita-evidence/original-coal-chunk.png').toString('base64')}`,
  PUBLISHED_CHUNK:`data:image/png;base64,${read('public/noita-evidence/published-coal-chunk.png').toString('base64')}`,
  CHUNK_HASH:proof.original_sha256,
})) html=html.replaceAll(`{{${key}}}`,String(value));
if(/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('Unresolved report field');
fs.writeFileSync(path('public/noita-map-explained.html'),html);
console.log(`Built public/noita-map-explained.html (${Buffer.byteLength(html)} bytes). CPU only; no game changes.`);
