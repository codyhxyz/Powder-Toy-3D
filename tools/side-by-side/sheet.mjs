// The side-by-side run's contact sheet (tools/side-by-side.mjs writes it as
// index.html beside the shots): every pair, A left and B right, with what to
// judge in it, the pixel difference between the sides, how long the harness
// took over each side, and the run's metadata (commits, devices, settings,
// what isn't deterministic). Self-contained: relative links to the run's own
// files, no scripts but the clip flipbook's (used when ffmpeg made no video).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => (x == null ? '–' : `${(100 * x).toFixed(x < 0.001 && x > 0 ? 3 : 1)}%`);
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const secs = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);

// one line saying how close the sides are: identical, near (under a level), or differing
function verdict(d) {
  if (!d) return '';
  if (d.max === 0) return '<span class="tag same">identical</span>';
  if (d.over8 === 0) return '<span class="tag near">within 8 levels</span>';
  return '<span class="tag diff">differ</span>';
}

function diffTable(d, clip) {
  if (!d) return '<p class="muted">no difference measured (a side failed)</p>';
  const rows = [
    ['mean |A−B|', `${num(d.mean, 3)} / 255`],
    ['pixels > 8 levels', pct(d.over8)],
    ['pixels > 32 levels', pct(d.over32)],
    ['largest', `${d.max} / 255`],
    ['PSNR', d.max === 0 ? '∞ (identical)' : `${num(d.psnr, 1)} dB`],
  ];
  if (clip) {
    rows.push(['frames identical', `${d.framesSame} of ${d.frames}`]);
    rows.push(['first frame differing', d.firstDiff == null ? 'none' : `${d.firstDiff} (t = ${num(d.firstDiffT, 2)} s)`]);
    rows.push(['worst frame', `${d.worst} (mean ${num(d.worstMean, 3)})`]);
  }
  return `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

// the harness's wall time over each side: compiles, readbacks and the other
// side's load in it, so it is no measure of either build's speed
function sideTimes(shot) {
  const waits = (s) => (s?.describe?.meshWaits ?? []).map((w) => `${w.at}: ${w.meshes} in ${w.s} s${w.stillParked ? `, ${w.stillParked} never` : ''}`).join('; ');
  const cell = (s) => (s?.error
    ? `<td class="err">${esc(s.error)}</td>`
    : !s ? '<td class="muted">not captured</td>'
    : `<td>${secs(s?.ms?.prepare)} prepare · ${secs(s?.ms?.capture)} capture${s?.frames ? ` · ${s.frames} frames` : ''}${s?.bootMs ? ` (after a ${secs(s.bootMs)} boot)` : ''}${waits(s) ? `<br><span class="muted">meshes compiled before the next frame: ${esc(waits(s))}</span>` : ''}${s?.errors?.length ? `<br><span class="err">${s.errors.length} page errors: ${esc(s.errors[0])}</span>` : ''}</td>`);
  return `<table class="kv"><tr><th>A</th>${cell(shot.a)}</tr><tr><th>B</th>${cell(shot.b)}</tr></table>`;
}

function media(shot) {
  const s = shot.name;
  if (shot.unpaired) return `<p class="err">not paired: ${esc(shot.unpaired)}</p>`;
  if (shot.kind === 'still') {
    if (!shot.files?.ab) return '<p class="err">no composite</p>';
    return `<a href="${s}/ab.png"><img class="pair" src="${s}/ab.png" alt="${esc(shot.title)}: A left, B right"></a>
      <p class="files"><a href="${s}/a.png">A</a> · <a href="${s}/b.png">B</a>${shot.files.diff ? ` · <a href="${s}/diff.png">|A−B| ×4</a>` : ''}</p>`;
  }
  const videos = shot.files?.videos ?? (shot.files?.video ? [shot.files.video] : []);
  if (videos.length) {
    const type = (f) => (f.endsWith('.webm') ? 'video/webm' : 'video/mp4');
    return `<video class="pair" controls loop muted playsinline preload="metadata">${videos.map((f) => `<source src="${s}/${f}" type="${type(f)}">`).join('')}</video>
      <p class="files">${videos.map((f) => `<a href="${s}/${f}">${f}</a>`).join(' · ')} · frames: <a href="${s}/a/">A</a>, <a href="${s}/b/">B</a>, <a href="${s}/ab/">A|B</a></p>`;
  }
  if (shot.files?.frames) {
    return `<div class="flip" data-dir="${s}/ab/" data-n="${shot.files.frames}" data-fps="${shot.fps}">
        <img class="pair" src="${s}/ab/0001.png" alt="${esc(shot.title)}: A left, B right">
        <button type="button">Play</button></div>
      <p class="files">no ffmpeg on this machine: a flipbook of the frames · <a href="${s}/ab/">A|B frames</a></p>`;
  }
  return '<p class="err">no frames</p>';
}

// the capture's time: this run's, or every run's that put shots on the sheet (--append)
function runTime(meta) {
  const runs = (meta.runs ?? []).filter((r) => !r.recompose);
  if (runs.length < 2) return secs(runs[0]?.ms ?? meta.ms);
  return `${secs(runs.reduce((t, r) => t + (r.ms ?? 0), 0))} over ${runs.length} runs`;
}

// a shot captured by an earlier run (--append) with other settings than the sheet's header says
function captureNote(sh, meta) {
  const c = sh.capture;
  if (!c || meta.runs?.length < 2) return '';
  const bits = [c.size, c.quality, c.timeScale !== 1 && `time ×${c.timeScale}`, c.box && `box ${c.box}`, c.win && `window ${c.win}`].filter(Boolean);
  return ` · ${esc(bits.join(', '))}`;
}

/**
 * The sheet's HTML for a run: { meta, shots } as tools/side-by-side.mjs keeps
 * them in run.json.
 */
export function sheetHtml(run) {
  const { meta, shots } = run;
  const sides = ['a', 'b'].map((k) => meta.sides[k]);
  const sideRow = (s, k) => `<tr><th>${k.toUpperCase()}</th><td><b>${esc(s.label)}</b><br>
      <span class="muted">${esc(s.url)}</span><br>
      ${esc(s.adapter ?? 'adapter unknown')}</td></tr>`;
  const engineNotes = [...new Set(shots.flatMap((sh) => [...(sh.a?.describe?.nondeterminism ?? []), ...(sh.b?.describe?.nondeterminism ?? [])]))];
  const firstDescribe = shots.find((sh) => sh.a?.describe)?.a.describe;
  const body = shots.map((sh) => `
    <section id="${esc(sh.name)}">
      <h2>${esc(sh.title)} <span class="muted">${esc(sh.name)} · ${sh.kind === 'clip' ? `${sh.seconds} s clip at ${sh.fps} fps` : 'still'}${captureNote(sh, meta)}</span> ${verdict(sh.diff)}</h2>
      <p class="look">${esc(sh.look)}</p>
      ${media(sh)}
      <div class="cols">
        <div><h3>A vs B</h3>${diffTable(sh.diff, sh.kind === 'clip')}</div>
        <div><h3>Harness time</h3>${sideTimes(sh)}<p class="muted">The tool's wall time over each side, with pipeline compiles, screenshot readbacks and, unless --serial, the other side's load on the same GPU: not frame or step cost. Speed is the raster bench's and power.mjs's to measure (docs/v2.md 11, Week 0).</p></div>
        <div><h3>On a phone</h3><p><code>?shot=${esc(sh.name)}</code> on either build (src/shot.js): the same scene, camera and time, then it's yours</p></div>
      </div>
    </section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Side by side</title>
<style>
  :root { --bg: #f6f5f2; --fg: #1d1d1f; --muted: #6b6b70; --card: #ffffff; --line: #dedcd6; --same: #2f7d4f; --near: #8a6d1a; --diff: #b23a3a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151517; --fg: #ececee; --muted: #9a9aa2; --card: #1f1f23; --line: #34343a; --same: #6fcf97; --near: #e2c25a; --diff: #ff8a8a; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 0 0 4px; }
  h3 { font-size: 13px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  section, .meta { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin: 14px 0; }
  .muted { color: var(--muted); font-weight: normal; font-size: 13px; }
  .look { margin: 0 0 10px; }
  .pair { display: block; width: 100%; height: auto; border-radius: 4px; background: #000; image-rendering: auto; }
  .files { margin: 4px 0 8px; font-size: 13px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  table.kv { border-collapse: collapse; font-size: 13px; }
  table.kv th { text-align: left; padding: 2px 12px 2px 0; color: var(--muted); font-weight: normal; vertical-align: top; }
  table.kv td { padding: 2px 0; }
  .tag { font-size: 12px; padding: 1px 7px; border-radius: 10px; border: 1px solid currentColor; vertical-align: middle; }
  .same { color: var(--same); } .near { color: var(--near); } .diff, .err { color: var(--diff); }
  ul { margin: 4px 0; padding-left: 20px; }
  code { font-size: 13px; }
  a { color: inherit; }
  nav a { margin-right: 10px; white-space: nowrap; }
  .flip button { margin-top: 6px; }
</style>
</head>
<body>
<main>
  <h1>Side by side</h1>
  <p class="muted">${esc(meta.started)} · ${esc(meta.host)} · ${shots.length} shots · A left, B right</p>
  ${meta.warning ? `<p class="err"><b>${esc(meta.warning)}</b></p>` : ''}
  <nav>${shots.map((sh) => `<a href="#${esc(sh.name)}">${esc(sh.name)}</a>`).join(' ')}</nav>
  <div class="meta">
    <div class="cols">
      <div><h3>Builds</h3><table class="kv">${sides.map((s, i) => sideRow(s, ['a', 'b'][i])).join('')}</table></div>
      <div><h3>Capture</h3><table class="kv">
        <tr><th>viewport</th><td>${esc(meta.size)}</td></tr>
        <tr><th>quality</th><td>${esc(meta.quality)}</td></tr>
        <tr><th>clips</th><td>${esc(meta.clipSeconds)} s at ${esc(meta.fps)} fps</td></tr>
        <tr><th>settings</th><td>${esc(meta.settings)}</td></tr>
        ${meta.timeScale !== 1 ? `<tr><th>game time</th><td class="err">every shot's time and a clip's lead-in ×${esc(meta.timeScale)}, its settle in full (a smoke run, not the shot list's times)</td></tr>` : ''}
        <tr><th>boxes, worlds</th><td>${esc(meta.box ? `boxes at ${meta.box}³` : 'boxes at their own size')}, ${esc(meta.win ? `world windows ${meta.win} wide` : 'world windows at their own size')}</td></tr>
        <tr><th>engine</th><td>${esc(firstDescribe ? `${firstDescribe.engine}; a game second = ${firstDescribe.gameSecond}` : '–')}</td></tr>
        <tr><th>tool</th><td>${esc(meta.tool)}</td></tr>
        <tr><th>run time</th><td>${runTime(meta)}</td></tr>
      </table></div>
      <div><h3>Not deterministic</h3><ul>${[...meta.nondeterminism, ...engineNotes].map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
    </div>
  </div>
  ${body}
</main>
<script>
  // the clips' flipbook, when there is no video
  for (const f of document.querySelectorAll('.flip')) {
    const img = f.querySelector('img'), btn = f.querySelector('button');
    const n = +f.dataset.n, fps = +f.dataset.fps, dir = f.dataset.dir;
    const frames = Array.from({ length: n }, (_, i) => { const im = new Image(); im.src = dir + String(i + 1).padStart(4, '0') + '.png'; return im; });
    let timer = null, i = 0;
    btn.onclick = () => {
      if (timer) { clearInterval(timer); timer = null; btn.textContent = 'Play'; return; }
      btn.textContent = 'Pause';
      timer = setInterval(() => { i = (i + 1) % n; img.src = frames[i].src; }, 1000 / fps);
    };
  }
</script>
</body>
</html>
`;
}
