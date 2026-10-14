import * as THREE from 'three';
import { DEVICE_TYPES, FILTER_IDS } from './catalog.js';
import { ELEMENTS } from '../elements.js';
import { deviceHeight } from './validation.js';
import './industry.css';

const box = (parent, size, at, color) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color }));
  mesh.position.set(...at); parent.add(mesh); return mesh;
};
function model(type) {
  const root = new THREE.Group(), color = DEVICE_TYPES[type].color;
  // Sandustry's open handling decks: hardware hugs the sides, not the stream.
  for (const x of [-1.85, 1.85]) box(root, [.24,.38,3.9], [x,1.1,0], color);
  for (const z of [-1.5,0,1.5]) box(root, [3.4,.13,.18], [0,1.06,z], '#424958');
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(.36,.7,3), new THREE.MeshBasicMaterial({ color }));
  arrow.rotation.x = Math.PI / 2; arrow.position.set(1.7,1.5,1.2); root.add(arrow);
  if (type === 'miner') {
    // Tracked drilling agent, not a person: two treads, motor and rotating bit.
    for (const x of [-1.45,1.45]) box(root,[.65,.75,2.9],[x,1.55,0],'#424958');
    box(root,[1.5,1,1.8],[0,2,0],color);
    const drill = new THREE.Mesh(new THREE.ConeGeometry(.7,1.5,6), new THREE.MeshBasicMaterial({color:'#c9ced6'}));
    drill.rotation.x = Math.PI / 2; drill.position.set(0,2,1.25); drill.name = 'drill'; root.add(drill);
    box(root,[.6,.25,.5],[0,2.7,-.5],'#edcf84');
  } else if (type === 'pump') {
    box(root,[.7,4.9,.7],[-1.5,3.2,0],color);
    box(root,[.5,.5,3],[-1.5,5.6,1.2],color);
    box(root,[3.2,.5,.5],[0,5.6,2.5],color);
    box(root,[3.2,.4,.4],[0,1.5,-2.5],'#424958');
  } else if (type === 'lift') {
    for (const x of [-1.6,1.6]) box(root,[.35,2.7,.35],[x,2.1,0],color);
    box(root,[2.8,.2,.6],[0,1.5,0],color);
  } else if (type === 'heater') {
    for (const x of [-1.7,1.7]) { box(root,[.55,1.4,3.6],[x,1.7,0],'#747b89'); box(root,[.15,.3,2.8],[x * .85,1.5,0],color); }
  } else if (type === 'ship') {
    for (const x of [-1.7,1.7]) box(root,[.4,2.3,.4],[x,2.05,1.5],color);
    box(root,[3.6,.45,.45],[0,3.15,1.5],color);
  } else if (type === 'separator') {
    box(root,[.3,1.6,.3],[-1.6,1.8,0],color); box(root,[1.1,.4,.5],[-1.1,2.6,0],color);
    box(root,[1.3,.15,.25],[1,1.3,0],color);
  }
  return root;
}

export function createIndustryView(app, actions) {
  const root = new THREE.Group(); root.name = 'Industry'; app.scene.add(root);
  const templates = Object.fromEntries(Object.keys(DEVICE_TYPES).map(type => [type, model(type)]));
  const ghost = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(4,4,4), new THREE.MeshBasicMaterial({color:'#dcbc74',wireframe:true}));
  frame.position.set(0,2,0); ghost.add(frame);
  const flow = new THREE.Mesh(new THREE.ConeGeometry(.6,1.2,3), new THREE.MeshBasicMaterial({color:'#dcbc74'}));
  flow.rotation.x = Math.PI / 2; flow.position.set(0,1.4,1); ghost.add(flow);
  const inlet = box(ghost,[2,.18,.25],[0,1.2,-2.15],'#7cbdd1');
  const outlet = box(ghost,[2,.18,.25],[0,1.2,2.15],'#dcbc74');
  const reject = new THREE.Mesh(new THREE.ConeGeometry(.4,.9,3), new THREE.MeshBasicMaterial({color:'#e4b45c'}));
  reject.rotation.z = -Math.PI / 2; reject.position.set(1.6,1.4,0); ghost.add(reject);
  const port = box(ghost,[.5,.5,.5],[-2.5,.5,-.5],'#7cbdd1');
  ghost.visible = false; root.add(ghost);
  let ready = false, disposed = false;
  Promise.all([...Object.values(templates),ghost].map(m => app.gpu.three.prepare(m))).then(() => { ready = true; app.requestRender(); }, err => app.hud.toast(`Industry graphics: ${err.message}`));
  const meshes = new Map();
  const panel = document.createElement('section'); panel.className = 'industry panel'; panel.setAttribute('aria-label','Industry construction');
  const button = (text, fn, parent = panel) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = fn; parent.append(b); return b; };
  const top = document.createElement('div'); top.className = 'industry-row'; panel.append(top);
  const toggle = button('Industry · B',actions.toggle,top);
  const count = document.createElement('span'); count.className = 'industry-count'; top.append(count);
  const objective = document.createElement('p'); objective.className = 'industry-objective'; panel.append(objective);
  const controls = document.createElement('div'); panel.append(controls);
  const types = document.createElement('div'); types.className = 'industry-types'; types.setAttribute('role','group'); types.setAttribute('aria-label','Machine'); controls.append(types);
  const typeButtons = Object.fromEntries(Object.entries(DEVICE_TYPES).map(([key,d]) => [key,button(d.name,() => actions.select(key),types)]));
  const row = document.createElement('div'); row.className = 'industry-row'; controls.append(row);
  button('Rotate · R',actions.rotate,row); button('Place',actions.place,row); button('Dismantle',actions.remove,row); button('Cancel · Esc',actions.cancel,row);
  const options = document.createElement('div'); options.className = 'industry-row'; controls.append(options);
  const filterLabel = document.createElement('label'); filterLabel.textContent = 'Sort '; options.append(filterLabel);
  const filter = document.createElement('select'); filter.setAttribute('aria-label','Separator output material'); filterLabel.append(filter);
  for (const id of FILTER_IDS) { const o = document.createElement('option'); o.value = id; o.textContent = ELEMENTS[id].name; filter.append(o); }
  filter.onchange = () => actions.filter(Number(filter.value));
  const powerLabel = document.createElement('label'); options.append(powerLabel);
  const power = document.createElement('input'); power.type = 'checkbox'; power.onchange = () => actions.power(power.checked); powerLabel.append(power,document.createTextNode(' Spark drive'));
  powerLabel.title = 'Spark a conductor beside the blue port: local cell (-1, 0, 1). Unchecked uses the built-in drive.';
  const help = document.createElement('p'); help.className = 'industry-help'; help.textContent = 'Click place · Right-click dismantle · V walk / orbit'; controls.append(help);
  const status = document.createElement('p'); status.className = 'industry-status'; status.setAttribute('role','status'); panel.append(status);
  // The panel is created after app.js registers its existing panels.
  panel.addEventListener('pointerdown', e => e.stopPropagation());
  document.body.append(panel);
  let lastStatus = '';
  return {
    update(state, candidate, result, time) {
      if (disposed) return;
      panel.hidden = !state.active; root.visible = state.active && ready;
      toggle.setAttribute('aria-pressed',String(state.building)); controls.hidden = !state.building;
      count.textContent = `${state.devices.length} / 128`;
      objective.hidden = !state.progression;
      const p = state.progression;
      objective.textContent = p ? `${p.credits} credits · ${typeof p.goal === 'string' ? p.goal : p.hint}${state.assisted ? ' · Sandbox-assisted' : ''}` : '';
      for (const [key,b] of Object.entries(typeButtons)) {
        const d = DEVICE_TYPES[key], can = actions.canBuild(key);
        b.textContent = `${d.name}${p ? ` · ${d.cost}` : ''}`;
        b.disabled = !can.ok; b.title = `${d.description}${can.ok ? '' : ` ${can.reason}`}`;
        b.setAttribute('aria-pressed',String(key === state.selected));
      }
      filterLabel.hidden = state.selected !== 'separator'; filter.value = state.filter; power.checked = state.powered;
      const text = state.building ? (result?.reason || 'Aim at a clear surface. Keep the deck and outlets open.') : (p?.hint || 'Build physical grain-handling machines. Sandbox construction is free.');
      if (text !== lastStatus) { status.textContent = text; lastStatus = text; }
      for (const [id,m] of meshes) if (!state.devices.some(d => d.id === id)) { m.removeFromParent(); meshes.delete(id); }
      for (const d of state.devices) {
        let m = meshes.get(d.id);
        if (!m) { m = templates[d.type].clone(); root.add(m); meshes.set(d.id,m); }
        m.position.set(d.x+2,d.y,d.z+2); m.rotation.y = -d.rotation * Math.PI / 2;
        const drill = m.getObjectByName('drill'); if (drill) drill.rotation.y = time * 4;
      }
      root.scale.setScalar(app.scale); root.position.copy(app.volume.position);
      ghost.visible = state.building && !!candidate;
      if (candidate) {
        const height = deviceHeight(candidate); frame.scale.y = height / 4; frame.position.y = height / 2;
        ghost.position.set(candidate.x+2,candidate.y,candidate.z+2); ghost.rotation.y = -candidate.rotation * Math.PI/2;
        inlet.position.z = candidate.type === 'pump' ? -2.5 : -2.15;
        outlet.position.set(0,candidate.type === 'pump' ? 5.6 : 1.2,candidate.type === 'pump' ? 2.5 : 2.15);
        reject.visible = candidate.type === 'separator';
        const color = result?.ok ? '#b7d077' : '#e5536a'; frame.material.color.set(color); flow.material.color.set(color); port.visible = candidate.powered;
      }
    },
    dispose() {
      disposed = true; root.removeFromParent(); panel.remove();
      for (const m of [...Object.values(templates),ghost]) m.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    },
  };
}
