import { E } from '../../elements.js';
import { controlCell } from '../../industry/catalog.js';

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const key = p => p.join(',');

// Standard four-neighbour BFS on the service tray, avoiding other nets' risers.
function trayPath(start, end, size, blocked) {
  const [nx, , nz] = size, count = nx * nz;
  const at = ([x, z]) => z * nx + x, goal = at(end);
  const previous = new Int32Array(count).fill(-1), queue = [at(start)];
  previous[queue[0]] = queue[0];
  for (let i = 0; i < queue.length && previous[goal] === -1; i++) {
    const n = queue[i], x = n % nx, z = Math.floor(n / nx);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, zz = z + dz;
      if (xx < 5 || xx >= nx - 5 || zz < 5 || zz >= nz - 5) continue;
      const next = zz * nx + xx;
      if (previous[next] !== -1 || blocked.has(`${xx},${zz}`)) continue;
      previous[next] = n; queue.push(next);
    }
  }
  if (previous[goal] === -1) throw new Error(`No isolated cable route from ${start} to ${end}.`);
  const path = [];
  for (let n = goal; ; n = previous[n]) {
    path.push([n % nx, Math.floor(n / nx)]);
    if (previous[n] === n) break;
  }
  return path.reverse();
}

// Authored wiring only: after generation, ordinary native material rules own
// every signal. No runtime station registry turns machines or lamps on.
export function stampControlStations({ box, set, size, devices, stations }) {
  const byId = new Map(devices.map(d => [d.id, d]));
  if (byId.size !== devices.length) throw new Error('Duplicate authored machine id.');
  if (new Set(stations.map(s => s.id)).size !== stations.length) throw new Error('Duplicate control station id.');
  const lowestTray = size[1] - 2 - 2 * (stations.length - 1);
  if (stations.length && lowestTray < 78) throw new Error('Too many independently isolated control trays.');
  const wires = new Map(), protectedCells = new Map(), circuits = [], plaques = [];
  const inside = p => p.every((n, i) => Number.isInteger(n) && n >= 0 && n < size[i]);
  const protect = (p, id, net, extra) => {
    if (!inside(p) || !Number.isInteger(id)) throw new Error(`Invalid control cell: ${p} / ${id}`);
    const old = protectedCells.get(key(p));
    if (old && (old.net !== net || old.id !== id)) throw new Error(`Control components collide at ${p}`);
    protectedCells.set(key(p), { p, id, net, extra });
  };
  const addWire = (p, net) => {
    if (!inside(p)) throw new Error(`Cable outside map: ${p}`);
    const old = wires.get(key(p));
    if (old && old.net !== net) throw new Error(`Short between control nets at ${p}`);
    wires.set(key(p), { p: [...p], net });
  };
  const line = (a, b, net) => {
    const changed = a.map((v, i) => v !== b[i] ? i : -1).filter(i => i >= 0);
    if (changed.length > 1) throw new Error('A cable segment must be face-connected.');
    const p = [...a], axis = changed[0];
    addWire(p, net);
    if (axis == null) return;
    while (p[axis] !== b[axis]) { p[axis] += Math.sign(b[axis] - p[axis]); addWire([...p], net); }
  };
  for (const [index, station] of stations.entries()) {
    if (!Array.isArray(station.at) || station.at.length !== 3 || !station.at.every(Number.isInteger) ||
      !Array.isArray(station.devices) || !Array.isArray(station.lamps ?? []) ||
      !(station.devices.length || station.lamps?.length) ||
      ['pulse', 'initialOn', 'startStop'].some(k => station[k] !== undefined && typeof station[k] !== 'boolean') ||
      (station.startStop && station.pulse)) throw new Error('Invalid authored control station.');
    const [x, y, z] = station.at, net = station.id;
    if (!inside([x, y, z]) || !inside([x + 7, y + 5, z + 3])) throw new Error('Control station outside map.');
    const gate = [x + 2, y + 3, z + 1], supply = [x + 2, y + 3, z + 2];
    const indicator = [x + 4, y + 3, z + 1], source = [x + 3, y + 3, z + 1];
    const inputs = station.devices.map(id => {
      const device = byId.get(id);
      if (!device || !device.powered) throw new Error(`Station ${net} needs a powered native device: ${id}`);
      return controlCell(device);
    });
    const lamps = station.lamps ?? [];
    const terminals = [...inputs, ...lamps];
    const columns = [source, ...terminals.map(([xx, yy, zz]) => [xx - 2, yy, zz])];
    box(x, y, z, x + 8, y + 2, z + 4, E.INSULATOR);
    box(x, y + 2, z, x + 8, y + 6, z + 2, E.EMPTY);
    box(x, y + 2, z + 2, x + 8, y + 6, z + 4, E.CERAMIC);
    protect(gate, station.pulse ? E.BUTTON : E.SWITCH, net, { life: station.initialOn && !station.pulse ? 10 : 0 });
    protect(supply, E.BATTERY, net);
    protect(indicator, E.LAMP, net);
    let buttons = null;
    if (station.startStop) {
      // TPT's proven PSCN-set / NSCN-reset SWCH latch. Each momentary
      // contact needs supply; the relay's separate battery feeds the drive.
      buttons = { start: [x + 1, y + 4, z + 1], stop: [x + 1, y + 2, z + 1] };
      protect(buttons.start, E.BUTTON, net, { life: 0 });
      protect(buttons.stop, E.BUTTON, net, { life: 0 });
      protect([x + 1, y + 5, z + 1], E.BATTERY, net);
      protect([x, y + 2, z + 1], E.BATTERY, net);
      protect([x + 1, y + 3, z + 1], E.PSCN, net);
      protect([x + 2, y + 2, z + 1], E.NSCN, net);
      // The operator touches buttons, not the relay hidden behind its window.
      for (const [xx, yy] of [[x + 2, y + 3], [x + 1, y + 3], [x + 1, y + 5], [x, y + 2]]) {
        set(xx, yy, z, E.GLASS);
      }
      plaques.push(
        { cell: buttons.start, normal: [0, 0, -1], text: 'START / Powered contact -> PSCN -> native latching relay.' },
        { cell: buttons.stop, normal: [0, 0, -1], text: 'STOP / NSCN resets the relay. Gravity and existing heat continue.' },
      );
    }
    for (const input of inputs) protect(input, E.CONTACTOR, net);
    for (const lamp of lamps) protect(lamp, E.LAMP, net);
    addWire(source, net);
    const trayY = lowestTray + 2 * index;
    for (const p of columns) line(p, [p[0], trayY, p[2]], net);
    for (const [i, p] of terminals.entries()) line(columns[i + 1], [p[0] - 1, p[1], p[2]], net);
    circuits.push({ id: net, gate, supply, indicator, inputs, lamps, columns, trayY, buttons, label: station.label ?? net });
    plaques.push({ cell: [x + 2, y + 1, z], normal: [0, 0, -1],
      text: `${station.label ?? net} / E or hit: ${station.pulse ? 'pulse' : station.startStop ? 'START / STOP' : 'run / stop'} / Lamp: ENABLE`.slice(0, 80) });
  }
  // Each net has its own height; avoid every foreign vertical drop at that
  // height too, so stacked trays cannot accidentally join their circuits.
  for (const circuit of circuits) {
    const blocked = new Set();
    for (const other of circuits) if (other !== circuit) for (const [x, , z] of other.columns) {
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) blocked.add(`${x + dx},${z + dz}`);
    }
    const source = circuit.columns[0];
    for (const target of circuit.columns.slice(1)) {
      const path = trayPath([source[0], source[2]], [target[0], target[2]], size, blocked);
      for (const [x, z] of path) addWire([x, circuit.trayY, z], circuit.id);
    }
  }
  for (const wire of wires.values()) {
    const component = protectedCells.get(key(wire.p));
    if (component) throw new Error(`A cable replaces a component at ${wire.p}`);
    for (const d of FACES) {
      const q = wire.p.map((v, i) => v + d[i]), other = wires.get(key(q)) ?? protectedCells.get(key(q));
      if (other && other.net !== wire.net) throw new Error(`Adjacent control nets short at ${wire.p}`);
    }
  }
  for (const component of protectedCells.values()) for (const d of FACES) {
    const q = component.p.map((v, i) => v + d[i]), other = protectedCells.get(key(q));
    if (other && other.net !== component.net) throw new Error(`Adjacent control components short at ${component.p}`);
  }
  // Clear glass sleeves make native travelling sparks visible. They do not
  // carry signals; breaking a wire really interrupts its downstream circuit.
  for (const { p } of wires.values()) for (const d of FACES) {
    const q = p.map((v, i) => v + d[i]);
    if (inside(q) && !wires.has(key(q)) && !protectedCells.has(key(q))) set(...q, E.GLASS);
  }
  for (const { p } of wires.values()) set(...p, E.METAL);
  for (const { p, id, extra } of protectedCells.values()) set(...p, id, extra);
  return { circuits, plaques };
}
