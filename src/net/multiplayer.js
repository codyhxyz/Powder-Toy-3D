import { applyGuestStroke } from './edits.js';
import { ELEMENTS, TOOLS, PROP_TOOL } from '../elements.js';
import { propRangeError, runFill, PROP_FIELDS } from '../editing.js';
import { createPacker, createUnpacker, encodeFrame, decodeFrame, xorInto, FRAME_KEY, FRAME_DELTA } from './codec.js';
import { createRemoteCursors } from './cursors.js';
import { createChat, MAX_CHAT_CHARS } from './chat.js';
import { sessionToken } from '../account.js';
import { h } from '../ui/dom.js';
import './net.css';
import { stamp, validPose, leash } from './protocol.js';

// Multiplayer: one player hosts and runs the simulation; guests see the
// host's world (streamed, ~100 ms behind) from their own camera, send paint
// strokes to the host, and everyone sees everyone's brush. Anyone can play,
// signed in or not: signed-in players show by their first name (the relay
// looks it up from their session), others as Host / Guest <n>. T opens chat.
//
// Roles: 'solo' (no session), 'host', 'guest'. All traffic goes through the
// relay (relay/worker.js): JSON text for presence, paint and control, binary
// for world frames (host → guests).

// Production builds need VITE_RELAY_URL (the deployed relay); without one,
// multiplayer stays hidden. Dev uses a local `wrangler dev` relay.
const DEV_RELAY_PORT = 8787; // `wrangler dev` default
const RELAY_URL = import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? `ws://${location.hostname}:${DEV_RELAY_PORT}` : null);
const JOIN_PARAM = 'join';
const ROOM_CODE_LENGTH = 8;
const WS_PROTOCOL = 'tpt3d'; // relay/worker.js: ['tpt3d', <session token>] signs the player in

const STREAM_INTERVAL_MS = 100;       // world frames to guests (10 per second)
const PRESENCE_INTERVAL_MS = 50;      // cursor updates (20 per second)
const MAX_BUFFERED_BYTES = 1 << 20;   // skip a world frame while this much is still queued on the socket
const KEY_REQUEST_COOLDOWN_MS = 1000; // a guest that lost sync asks for a keyframe at most this often
const CURSOR_STEPS_PER_CELL = 10;     // cursor positions are rounded to a tenth of a cell
const MIN_BRUSH_RADIUS = 1;           // the dock's brush-size range; guests' strokes are clamped to it
const MAX_BRUSH_RADIUS = 24;
const BRUSH_SHAPES = new Set([0, 1]); // sphere, cube (see brush.js)
const MAX_WIND_CELLS = 64;            // the Wind tool's drag in a frame (cells; shaders/passes.js caps its speed anyway)
const MAX_FILLS_PER_FRAME = 1;        // guests' flood fills the host runs a frame (each reads the world back)
// The scoreboard's ping (ui/scoreboard.js): the host times a round trip to each guest
// through the relay this often, Source's rate (player_resource.cpp updates every
// player's ping each 20th think of 0.1 s), and sends everyone the table, with its own
// kills and deaths (only the host can drop in). The host's own ping is 0, a listen server's.
const PING_INTERVAL_MS = 2000;

const PEER_COLORS = ['#ffb84d', '#5ad1ff', '#ff6fa8', '#8ce36b', '#c49bff', '#ff8a5c', '#4de0c0', '#f4e04d'];
const PAINTABLE = new Set([...ELEMENTS.map((e) => e.id), ...TOOLS.filter((t) => t.key !== 'SIGN').map((t) => t.id)]);
// what floods (app.js fills: elements, Erase and the Property tool, as in TPT)
const FILL_TOOLS = (tool) => (tool >= 0 && tool < ELEMENTS.length) || tool === TOOLS.find((t) => t.key === 'ERASE').id || tool === PROP_TOOL;
const GUEST_BLOCKED = 'Only the host can do that';
const HOST_AWAY = 'The host switched to another tab, so the world is paused until they come back';
const HOST_BACK = 'The host is back';
const STOPPED_HOSTING = 'Stopped hosting';
const LEFT_WORLD = 'You left the host\'s world';
// World co-op shares one host-led loaded area, not independent streaming.
const COOP_ONLY = 'World co-op uses Sandbox exploration. Switch to Sandbox to host.';
const CLOSE_NORMAL = 1000; // WebSocket close code for a deliberate disconnect

const ICON_PLAYERS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>';

const peerName = (p) => p.name ?? (p.role === 'host' ? 'Host' : `Guest ${p.n}`);
const peerColor = (p) => PEER_COLORS[p.n % PEER_COLORS.length];
const inviteURL = (room) => {
  const u = new URL(location.href);
  u.search = new URLSearchParams({ [JOIN_PARAM]: room }).toString();
  return u.toString();
};
const sameDims = (g, dims) => g.nx === dims[0] && g.ny === dims[1] && g.nz === dims[2];

// app hooks:
//   getSim(), getVolume()   current simulation and volume mesh (both are rebuilt on grid size changes)
//   setGrid(dims, metadata) rebuild only when the received map changes; false if unsupported
//   inWorld()               the grid is World's host-led window (docs/scaling.md D11)
//   score()                 your [kills, deaths] on the scoreboard (the host sends its own to the guests)
// gpu: the device (src/gpu), for the remote cursors' brushes (a pipeline of
// ours, brush.js); the stream's kernels use each simulation's own.
export function createMultiplayer({ gpu, scene, camera, hud, getSim, getVolume, setGrid, inWorld = () => false, score = () => null,
  getMetadata = () => null, commitFrame = () => {}, canHost = () => true, canStream = () => true, sessionChanged = () => {},
  getPose = () => null, avatars = null, catchUp = () => {},
}) {
  let role = 'solo';
  let socket = null, room = null, me = null;
  let joiningAs = null; // the role we asked the relay for, until it welcomes us
  const peers = new Map();
  const pings = new Map();   // id → round trip (ms): the host's measures, a guest's copy of the host's table
  let hostScore = null, lastPing = 0;
  const cursors = createRemoteCursors({ gpu, scene, camera, getVolume });

  // host state (the codec's kernels: a capture is recorded into the frame and
  // read back a few frames later, never a stall; docs/webgpu.md G4)
  const packer = createPacker();
  let sent = null, sentDims = '', scratch = null, seq = 0, wantKey = false, lastStream = 0;
  let sending = Promise.resolve(); // captures are encoded and sent strictly in order
  const strokes = [];
  const fills = [];   // guests' flood fills (src/editing.js runFill), run one at a time
  let filling = false;

  // guest state
  const unpacker = createUnpacker();
  let world = null, worldDims = null, worldSeq = 0, worldDirty = false, lastKeyRequest = 0;
  let frames = Promise.resolve();
  let epoch = 0, receivedMeta = null, committedMeta = null, sentMeta = '', lastReceived = 0, hostAway = false;
  let lastPose = 0, poseSeq = 0, frozen = false, cursorStamp = null, avatarMap = null;
  const poses = new Map();

  let lastPresence = 0, lastPresenceJSON = '';

  const chat = createChat({
    onSend(text) {
      if (send({ t: 'chat', text }) && me) chat.say(peerName(me), peerColor(me), text); // the relay doesn't echo to the sender
    },
  });

  // ---- connection ----
  function connect(asRole, code) {
    epoch++;
    room = code;
    joiningAs = asRole;
    sessionChanged(asRole);
    const token = sessionToken();
    const ws = new WebSocket(`${RELAY_URL}/room/${encodeURIComponent(code)}?role=${asRole}`, token ? [WS_PROTOCOL, token] : []);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (socket !== ws) return;
      try { typeof e.data === 'string' ? onMessage(JSON.parse(e.data), asRole) : onFrame(e.data); }
      catch (err) { console.warn('multiplayer: invalid message', err); }
    };
    ws.onclose = (e) => {
      if (socket !== ws) return;
      end(e.reason || (role === 'solo' ? 'Could not reach the multiplayer server' : 'Lost connection to the multiplayer server'));
    };
    socket = ws;
  }

  function end(reason) {
    const wasGuest = role === 'guest' || joiningAs === 'guest';
    frozen = wasGuest && inWorld();
    epoch++; worldDirty = false; receivedMeta = committedMeta = null; sentMeta = ''; worldDims = null; lastReceived = 0;
    frames = sending = Promise.resolve(); seq = worldSeq = poseSeq = 0; hostAway = false;
    poses.clear(); avatars?.clear(); sessionChanged('solo');
    socket = null; role = 'solo'; me = null; room = null; sent = null; world = null; joiningAs = null;
    peers.clear();
    pings.clear();
    hostScore = null;
    cursors.clear();
    chat.clear();
    strokes.length = 0;
    fills.length = 0;
    if (new URLSearchParams(location.search).has(JOIN_PARAM)) history.replaceState(null, '', location.pathname);
    hud.toast(frozen ? `${reason}. Reload or choose a map to play solo.` : wasGuest ? `${reason}. You can keep playing with this world on your own.` : reason);
    closePanel();
    syncButton();
  }

  // Stop hosting (which ends the room for every guest) or leave the host's world.
  function stop() {
    const asRole = role === 'solo' ? joiningAs : role;
    const ws = socket;
    socket = null;
    ws?.close(CLOSE_NORMAL);
    end(asRole === 'guest' ? LEFT_WORLD : STOPPED_HOSTING);
  }

  const send = (msg) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  };

  // Relay messages: welcome { id, n, role, peers }, join { id, n, role }, leave { id }, refused { reason };
  // everything else is another player's message with `from` set to their id.
  function onMessage(m, asRole) {
    const from = peers.get(m.from);
    switch (m.t) {
      case 'refused': {
        const ws = socket;
        socket = null;
        ws?.close();
        end(m.reason);
        return;
      }
      case 'welcome':
        role = asRole;
        frozen = false;
        sessionChanged(role);
        me = { id: m.id, n: m.n, role: m.role, name: m.name ?? null };
        for (const p of m.peers) peers.set(p.id, p);
        if (role === 'guest') { lastKeyRequest = -Infinity; requestKey(); hud.toast(`Joined as ${peerName(me)}. Waiting for host terrain…`); }
        break;
      case 'join':
        peers.set(m.id, m);
        chat.notice(`${peerName(m)} joined`);
        if (role === 'host') wantKey = true;
        lastPresenceJSON = ''; // so the newcomer gets our cursor without waiting for us to move
        break;
      case 'leave': {
        const p = peers.get(m.id);
        if (p?.role === 'host') { // don't wait for the relay to close the socket
          const ws = socket;
          socket = null;
          ws?.close();
          end('The host left');
          return;
        }
        if (p) chat.notice(`${peerName(p)} left`);
        peers.delete(m.id);
        pings.delete(m.id);
        cursors.remove(m.id); avatars?.remove(m.id); poses.delete(m.id);
        break;
      }
      case 'pose': {
        const meta = role === 'host' ? getMetadata() : committedMeta;
        const id = role === 'host' ? m.from : m.peer ?? m.from;
        if (!from || (role === 'guest' && from.role !== 'host') || !peers.has(id) || id === me?.id || !validPose(m, meta)) break;
        const prev = poses.get(id), now = performance.now();
        if (prev && m.seq <= prev.seq) break;
        if (role === 'host') {
          const g = getSim().g, bounds = leash(meta, [g.nx, g.ny, g.nz], m.p);
          const fast = prev && m.warp === prev.warp && Math.hypot(...m.p.map((v, i) => v - prev.p[i])) > 16 + 200 * Math.min(1, (now - prev.at) / 1000);
          if (m.active && (bounds.outside || fast)) { send({ t: 'catchup', peer: id, map: meta.id }); break; }
          send({ ...m, t: 'pose', to: undefined, peer: id });
        }
        poses.set(id, { ...m, at: now }); avatars?.set(id, m);
        break;
      }
      case 'catchup':
        if (role === 'guest' && from?.role === 'host' && m.peer === me?.id && m.map === committedMeta?.id) catchUp();
        break;
      case 'cursor':
        if (from && validContext(m) && (m.c === null || bounded(m.c))) cursors.set(m.from, { name: peerName(from), color: peerColor(from) }, m);
        break;
      case 'paint':
        if (role === 'host' && from?.role === 'guest' && strokes.length < 128 && validContext(m) && validStroke(m)) strokes.push(m);
        break;
      case 'fill':
        if (role === 'host' && from?.role === 'guest' && fills.length < 8 && validContext(m) && validFill(m)) fills.push(m);
        break;
      case 'chat':
        if (from && typeof m.text === 'string') chat.say(peerName(from), peerColor(from), m.text.slice(0, MAX_CHAT_CHARS));
        break;
      case 'key':
        if (role === 'host' && from?.role === 'guest') wantKey = true;
        break;
      case 'away':
        if (from?.role === 'host') { hostAway = !!m.away; hud.toast(m.away ? HOST_AWAY : HOST_BACK); }
        break;
      case 'ping':   // the host's: answer it, and keep its table and its score
        if (from?.role !== 'host') return;
        send({ t: 'pong', to: 'host', at: m.at });
        pings.clear();
        for (const [id, ms] of Object.entries(m.pings ?? {})) if (Number.isFinite(ms)) pings.set(id, ms);
        hostScore = Array.isArray(m.kd) && m.kd.length === 2 && m.kd.every(Number.isFinite) ? m.kd : null;
        return;
      case 'pong':   // a guest's answer: its round trip
        if (role === 'host' && from && Number.isFinite(m.at)) pings.set(m.from, Math.max(0, Math.round(performance.now() - m.at)));
        return;
    }
    syncButton();
  }

  // a guest's Wind drag (null when it has none, or an invalid one), clamped to MAX_WIND_CELLS a frame per axis
  function strokeWind(w) {
    if (!Array.isArray(w) || w.length !== 3 || !w.every(Number.isFinite)) return null;
    return w.map((x) => Math.min(Math.max(x, -MAX_WIND_CELLS), MAX_WIND_CELLS));
  }

  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  // TPT's editing tools (src/editing.js) on a stroke: a line's end e, a box's grow g,
  // the target filter f, specific delete d, the Property tool's [field, value] p
  const context = () => stamp(role === 'host' ? getMetadata() : committedMeta);
  const validContext = (m) => m.context === context() || (!context() && m.context == null);
  const bounded = (v) => vec3(v) && v.every((n, i) => n >= 0 && n < [getSim().g.nx, getSim().g.ny, getSim().g.nz][i]);
  function validEdits(m) {
    const maxDim = Math.max(...['nx', 'ny', 'nz'].map((k) => getSim().g[k]));
    return (m.e === undefined || bounded(m.e)) && (m.g === undefined || (vec3(m.g) && m.g.every((v) => Math.abs(v) <= maxDim)))
      && (m.f === undefined || (Number.isInteger(m.f) && m.f >= -1 && m.f < ELEMENTS.length))
      && (m.tool !== PROP_TOOL || (Array.isArray(m.p) && Number.isInteger(m.p[0]) && m.p[0] >= 0 && m.p[0] < PROP_FIELDS.length && !propRangeError(m.p[0], m.p[1])));
  }
  function validStroke(m) {
    return bounded(m.c) && PAINTABLE.has(m.tool) &&
      Number.isFinite(m.r) && Number.isFinite(m.rate) && m.rate >= 0 && m.rate <= 100 && BRUSH_SHAPES.has(m.shape) && validEdits(m);
  }
  function validFill(m) {
    return bounded(m.c) && m.c.every(Number.isInteger) && Number.isInteger(m.id) && m.id >= 0 && m.id < ELEMENTS.length
      && Number.isInteger(m.top) && m.top >= 0 && m.top < getSim().g.ny && FILL_TOOLS(m.tool) && Number.isFinite(m.r) && Number.isFinite(m.rate) && BRUSH_SHAPES.has(m.shape) && validEdits(m);
  }
  const xyz = (v) => [v.x, v.y, v.z];
  // a stroke's editing fields as sent (validEdits) and as Simulation.paint takes them
  const editsOut = ({ end, grow, filter = -1, erase, prop }) => ({
    ...(end ? { e: xyz(end) } : {}), ...(grow ? { g: grow } : {}), ...(filter >= 0 ? { f: filter } : {}),
    ...(erase ? { d: 1 } : {}), ...(prop ? { p: [prop.field, prop.value] } : {}),
  });
  const editsIn = (m) => ({
    end: m.e ? { x: m.e[0], y: m.e[1], z: m.e[2] } : undefined, grow: m.g ?? null, filter: m.f ?? -1,
    erase: !!m.d, prop: m.p ? { field: m.p[0], value: m.p[1] } : null,
  });

  // ---- host: stream the world ----
  async function sendCapture({ bytes, dims, meta, release }, generation) {
    const key = wantKey;
    wantKey = false;
    try {
      if (epoch !== generation || role !== 'host') return;
      const dimsKey = dims.join('x'), metadataKey = JSON.stringify(meta);
      const fresh = key || !sent || sentDims !== dimsKey || stamp(meta) !== stamp(sentMeta ? JSON.parse(sentMeta) : null);
      if (!fresh) {
        scratch ??= new Uint8Array(bytes.length);
        const changed = xorInto(scratch, bytes, sent);
        if (!changed && metadataKey === sentMeta && !meta) return;
        // Heartbeats distinguish a quiet world from a stale host.
      }
      const frame = await encodeFrame(fresh ? FRAME_KEY : FRAME_DELTA, seq + 1, dims, fresh ? bytes : scratch, meta);
      if (epoch !== generation || role !== 'host' || !socket) return;
      sentMeta = metadataKey;
      socket.send(frame);
      seq++;
      if (fresh) { sent = new Uint8Array(bytes.length); scratch = new Uint8Array(bytes.length); sentDims = dimsKey; }
      sent.set(bytes);
    } catch (err) {
      wantKey ||= key;
      console.error('multiplayer: could not send the world', err);
    } finally {
      release();
    }
  }

  // ---- guest: receive the world ----
  function onFrame(buf) {
    const generation = epoch;
    frames = frames.then(() => applyFrame(buf, generation)).catch((err) => { if (epoch === generation) requestKey(); console.error('multiplayer: bad world frame', err); });
  }

  async function applyFrame(buf, generation) {
    if (role !== 'guest' || epoch !== generation) return;
    const { kind, seq: n, dims, body, meta } = await decodeFrame(buf);
    if (role !== 'guest' || epoch !== generation) return;
    if (kind === FRAME_KEY) {
      const previousSim = getSim();
      if (!setGrid(dims, meta)) { socket?.close(); end('The host is using a map this version or device cannot load'); return; }
      if (meta?.id !== receivedMeta?.id || getSim() !== previousSim) {
        avatars?.clear(); poses.clear(); cursors.clear(); committedMeta = null; lastReceived = 0;
      }
      world = body;
      worldDims = dims;
    } else if (kind === FRAME_DELTA && world && n === worldSeq + 1 && body.length === world.length && sameDims(getSim().g, dims) && stamp(meta) === stamp(receivedMeta)) {
      xorInto(world, world, body);
    } else {
      requestKey();
      return;
    }
    worldSeq = n;
    receivedMeta = meta;
    worldDirty = true;
  }

  function requestKey() {
    const now = performance.now();
    if (now - lastKeyRequest < KEY_REQUEST_COOLDOWN_MS) return;
    lastKeyRequest = now;
    send({ t: 'key', to: 'host' });
  }

  // ---- toolbar button ----
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn net-btn', innerHTML: ICON_PLAYERS });
  const badge = Object.assign(document.createElement('span'), { className: 'net-badge' });
  button.append(badge);
  button.addEventListener('click', onButton);
  if (RELAY_URL) document.querySelector('.toolbar')?.append(button);

  // Session panel: who's here, the invite link, and the way out.
  const panelTitle = h('h2');
  const panelCount = h('p');
  const peerList = h('ul.net-peers');
  const copyBtn = h('button.btn.grow', { type: 'button', text: 'Copy invite link', on: { click: () => room && copyInvite(room, 'Invite link copied') } });
  const stopBtn = h('button.btn.grow.danger', { type: 'button', on: { click: stop } });
  const panel = h('div.popover.net-panel.panel', { role: 'dialog', 'aria-label': 'Play together' },
    h('header', {}, panelTitle, panelCount), peerList, h('div.btn-row', {}, copyBtn, stopBtn));
  if (RELAY_URL) document.body.append(panel);

  let panelOpen = false;
  function openPanel() { panelOpen = true; panel.classList.add('open'); button.setAttribute('aria-expanded', 'true'); }
  function closePanel() { panelOpen = false; panel.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); }
  addEventListener('pointerdown', (e) => { if (panelOpen && !panel.contains(e.target) && !button.contains(e.target)) closePanel(); });

  async function onButton() {
    if (role === 'solo' && !socket) {
      if (!canHost() || frozen) { hud.toast(frozen ? 'Reload or choose a map before hosting.' : COOP_ONLY, { kind: 'error' }); return; }
      const code = crypto.randomUUID().replaceAll('-', '').slice(0, ROOM_CODE_LENGTH);
      connect('host', code);
      syncButton();
      openPanel();
      await copyInvite(code, 'Hosting. Invite link copied — send it to a friend');
    } else if (panelOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  async function copyInvite(code, message) {
    try {
      await navigator.clipboard.writeText(inviteURL(code));
      hud.toast(message);
    } catch {
      hud.toast(`Invite link: ${inviteURL(code)}`);
    }
  }

  function syncButton() {
    const guests = [...peers.values()].filter((p) => p.role === 'guest').length + (role === 'guest' ? 1 : 0);
    button.classList.toggle('on', role !== 'solo');
    badge.textContent = role === 'solo' ? '' : String(guests + 1);
    button.title = role === 'solo' ? (socket ? 'Connecting to the multiplayer server' : 'Play together: host this world and copy an invite link')
      : role === 'host' ? `Hosting · ${guests} ${guests === 1 ? 'guest' : 'guests'} · click for the invite link or to stop hosting`
        : 'Playing in the host\'s world · click for the invite link or to leave';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-haspopup', 'dialog');

    const hosting = (role === 'solo' ? joiningAs : role) !== 'guest';
    panelTitle.textContent = role === 'solo' ? 'Connecting…' : hosting ? 'Hosting this world' : 'In the host\'s world';
    panelCount.textContent = role === 'solo' ? '' : `${guests + 1} ${guests ? 'players' : 'player'}`;
    stopBtn.textContent = hosting ? 'Stop hosting' : 'Leave';
    stopBtn.title = hosting ? 'Disconnect every guest and play on your own' : inWorld() ? 'Disconnect; reload or choose a map to play solo' : 'Keep this world and play on your own';
    copyBtn.disabled = !room;
    const everyone = me ? [{ ...me, you: true }, ...peers.values()] : [];
    everyone.sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : a.n - b.n));
    peerList.replaceChildren(...everyone.map((p) => h('li', { style: { '--peer': peerColor(p) } },
      h('span.dot'), h('span', { text: peerName(p) }), p.name && p.role === 'host' ? h('span.host', { text: 'host' }) : null,
      p.you ? h('span.you', { text: 'you' }) : null)));
  }
  syncButton();

  // A background tab stops animating, and with it the host's simulation and stream.
  document.addEventListener('visibilitychange', () => { if (role === 'host') send({ t: 'away', away: document.hidden }); });

  const joinCode = new URLSearchParams(location.search).get(JOIN_PARAM);
  if (joinCode && RELAY_URL) connect('guest', joinCode);

  return {
    get role() { return role; },
    get replica() { return frozen || role === 'guest' || joiningAs === 'guest'; },
    get frozen() { return frozen; },
    resumeSolo() { if (role === 'solo') frozen = false; },
    get metadata() { return committedMeta; },
    get terrainReady() { return !!world && !!lastReceived; },
    get stale() { return role !== 'guest' || hostAway || !lastReceived || performance.now() - lastReceived > 2500; },
    get isGuest() { return role === 'guest'; },
    get joining() { return role === 'guest' || joiningAs === 'guest'; },   // a guest, or on the way to being one
    get panelOpen() { return panelOpen; },
    // everyone in the session, you first ([] solo), for the scoreboard: { id, name, color, role, you,
    // ping (ms; null till measured), kd ([kills, deaths]: the host's own, sent with its pings) }
    get players() {
      if (!me) return [];
      const ping = (p) => (p.role === 'host' ? 0 : pings.get(p.id) ?? null);
      return [{ ...me, you: true }, ...peers.values()].map((p) => ({
        id: p.id, name: peerName(p), color: peerColor(p), role: p.role, you: !!p.you, ping: ping(p),
        kd: p.role === 'host' && !p.you ? hostScore : null,
      }));
    },
    // Chat is for sessions; solo, T keeps toggling the element dock.
    get chatAvailable() { return role !== 'solo'; },
    openChat: () => chat.open(),
    closePanel,

    // Guests: shows a toast and returns true for host-only actions.
    guard() {
      if (role !== 'guest' && joiningAs !== 'guest' && !frozen) return false;
      hud.toast(frozen ? 'Reload or choose a map to play solo.' : GUEST_BLOCKED, { kind: 'error' });
      return true;
    },

    guardEntities() {
      if (role === 'solo' && !frozen && joiningAs !== 'guest') return false;
      if (role === 'host' && !inWorld()) return false;
      hud.toast('Co-op shares terrain and exploring bodies, not signs, decoration, NPCs or vehicles.');
      return true;
    },

    // Guests follow the host's map; hosts can freely choose another World or box.
    guardWorld() {
      if (role !== 'guest' && joiningAs !== 'guest') return false;
      hud.toast(GUEST_BLOCKED, { kind: 'error' });
      return true;
    },

    // Guests send their strokes to the host instead of painting locally.
    paint({ center, radius, shape, tool, rate, replace, wind, ...edits }) {
      send({ t: 'paint', context: context(), to: 'host', c: xyz(center), r: radius, shape, tool, rate, replace, w: wind, ...editsOut(edits) });
    },
    // ...and their flood fills (src/editing.js runFill's request), which the host reads its world for.
    fill({ cell, id, maxY, stroke: { radius, shape, tool, rate, replace, ...edits } }) {
      send({ t: 'fill', context: context(), to: 'host', c: cell, id, top: maxY, r: radius, shape, tool, rate, replace, ...editsOut({ ...edits, filter: -1 }) });
    },

    // Once per frame, before the world is drawn.
    // cursor: { visible, center (grid cells), radius, shape, tool, painting }
    update(dt, cursor) {
      const now = performance.now();
      const sim = getSim();
      const currentMap = role === 'host' ? getMetadata()?.id : committedMeta?.id;
      if (currentMap !== avatarMap) { avatars?.clear(); poses.clear(); avatarMap = currentMap; }
      if (context() !== cursorStamp) { cursors.clear(); cursorStamp = context(); }

      if (role === 'host') {
        for (const s of strokes) {
          if (!validContext(s)) continue;
          applyGuestStroke(sim, s, { wind: strokeWind(s.w), edits: editsIn(s), minRadius: MIN_BRUSH_RADIUS, maxRadius: MAX_BRUSH_RADIUS });
        }
        strokes.length = 0;
        for (let i = 0; i < MAX_FILLS_PER_FRAME && fills.length && !filling; i++) {
          const f = fills.shift();
          if (!validContext(f)) continue;
          const generation = epoch;
          filling = true;
          const stroke = { radius: Math.min(Math.max(f.r, MIN_BRUSH_RADIUS), MAX_BRUSH_RADIUS), shape: f.shape, tool: f.tool, rate: f.rate, replace: !!f.replace, ...editsIn(f) };
          runFill(sim, { cell: f.c, id: f.id, maxY: f.top, stroke }, { valid: () => generation === epoch && role === 'host' && validContext(f) })
            .catch((err) => console.error('multiplayer: a guest\'s fill failed', err))
            .finally(() => { filling = false; });
        }
        const hasGuests = [...peers.values()].some((p) => p.role === 'guest');
        if (hasGuests && now - lastPing >= PING_INTERVAL_MS) {
          lastPing = now;
          send({ t: 'ping', at: now, pings: Object.fromEntries(pings), kd: score() });
        }
        if (hasGuests && canStream() && now - lastStream >= STREAM_INTERVAL_MS && socket.bufferedAmount < MAX_BUFFERED_BYTES) {
          const generation = epoch;
          const capture = packer.pack(sim, getMetadata);
          if (capture) {
            lastStream = now;
            sending = sending.then(() => capture).then((c) => sendCapture(c, generation))
              .catch((err) => console.error('multiplayer: could not capture the world', err));
          }
        }
      }

      // (a keyframe at another size rebuilt the grid first: applyFrame's setGrid)
      if (role === 'guest' && worldDirty && sameDims(sim.g, worldDims)) {
        const generation = epoch, meta = receivedMeta, bytes = world.slice();
        unpacker.unpack(sim, bytes, {
          valid: () => epoch === generation && role === 'guest' && getSim() === sim,
          commit: () => { commitFrame(meta); committedMeta = meta; lastReceived = performance.now(); },
        }).catch((err) => console.error('multiplayer: could not unpack the world', err));
        worldDirty = false;
      }

      // Alone in the room: nobody to show the cursor to, so don't wake the relay (a join resends it).
      if (role !== 'solo' && peers.size && now - lastPresence >= PRESENCE_INTERVAL_MS) {
        const q = (v) => Math.round(v * CURSOR_STEPS_PER_CELL) / CURSOR_STEPS_PER_CELL;
        const json = JSON.stringify(cursor.visible
          ? { t: 'cursor', context: context(), c: cursor.center.toArray().map(q), r: cursor.radius, shape: cursor.shape, tool: cursor.tool, painting: cursor.painting }
          : { t: 'cursor', context: context(), c: null });
        if (json !== lastPresenceJSON) {
          socket?.readyState === WebSocket.OPEN && socket.send(json);
          lastPresenceJSON = json;
          lastPresence = now;
        }
      }

      if (role !== 'solo' && peers.size && now - lastPose >= PRESENCE_INTERVAL_MS) {
        const meta = role === 'host' ? getMetadata() : committedMeta;
        const pose = getPose();
        if (meta && pose) send({ ...pose, t: 'pose', map: meta.id, seq: ++poseSeq, ...(role === 'guest' ? { to: 'host' } : {}) });
        lastPose = now;
      }
      avatars?.update(dt);
      cursors.update(dt);
    },
  };
}
