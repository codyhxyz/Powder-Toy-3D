import { ELEMENTS, TOOLS } from '../elements.js';
import { createPacker, createUnpacker, encodeFrame, decodeFrame, xorInto, FRAME_KEY, FRAME_DELTA } from './codec.js';
import { createRemoteCursors } from './cursors.js';
import './net.css';

// Multiplayer: one player hosts and runs the simulation; guests see the
// host's world (streamed, ~100 ms behind) from their own camera, send paint
// strokes to the host, and everyone sees everyone's brush.
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

const STREAM_INTERVAL_MS = 100;       // world frames to guests (10 per second)
const PRESENCE_INTERVAL_MS = 50;      // cursor updates (20 per second)
const MAX_BUFFERED_BYTES = 1 << 20;   // skip a world frame while this much is still queued on the socket
const KEY_REQUEST_COOLDOWN_MS = 1000; // a guest that lost sync asks for a keyframe at most this often
const CURSOR_STEPS_PER_CELL = 10;     // cursor positions are rounded to a tenth of a cell
const MIN_BRUSH_RADIUS = 1;           // the dock's brush-size range; guests' strokes are clamped to it
const MAX_BRUSH_RADIUS = 24;
const BRUSH_SHAPES = new Set([0, 1]); // sphere, cube (see brush.js)

const PEER_COLORS = ['#ffb84d', '#5ad1ff', '#ff6fa8', '#8ce36b', '#c49bff', '#ff8a5c', '#4de0c0', '#f4e04d'];
const PAINTABLE = new Set([...ELEMENTS.map((e) => e.id), ...TOOLS.filter((t) => t.key !== 'SIGN').map((t) => t.id)]);
const GUEST_BLOCKED = 'Only the host can do that';

const ICON_PLAYERS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>';

const peerName = (p) => (p.role === 'host' ? 'Host' : `Guest ${p.n}`);
const peerColor = (p) => PEER_COLORS[p.n % PEER_COLORS.length];
const inviteURL = (room) => {
  const u = new URL(location.href);
  u.search = new URLSearchParams({ [JOIN_PARAM]: room }).toString();
  return u.toString();
};
const sameDims = (g, dims) => g.nx === dims[0] && g.ny === dims[1] && g.nz === dims[2];

// app hooks:
//   getSim(), getVolume()   current simulation and volume mesh (both are rebuilt on grid size changes)
//   setGrid([nx, ny, nz])   rebuild the world at the host's grid size; returns false if unsupported
export function createMultiplayer({ renderer, scene, camera, hud, getSim, getVolume, setGrid }) {
  let role = 'solo';
  let socket = null, room = null, me = null;
  const peers = new Map();
  const cursors = createRemoteCursors({ scene, camera, getVolume });

  // host state
  const packer = createPacker(renderer);
  let sent = null, sentDims = '', scratch = null, seq = 0, wantKey = false, lastStream = 0;
  let sending = Promise.resolve(); // captures are encoded and sent strictly in order
  const strokes = [];

  // guest state
  const unpacker = createUnpacker();
  let world = null, worldSeq = 0, worldDirty = false, lastKeyRequest = 0;
  let frames = Promise.resolve();

  let lastPresence = 0, lastPresenceJSON = '';

  // ---- connection ----
  function connect(asRole, code) {
    room = code;
    const ws = new WebSocket(`${RELAY_URL}/room/${encodeURIComponent(code)}?role=${asRole}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => (typeof e.data === 'string' ? onMessage(JSON.parse(e.data), asRole) : onFrame(e.data));
    ws.onclose = (e) => {
      if (socket !== ws) return;
      end(e.reason || (role === 'solo' ? 'Could not reach the multiplayer server' : 'Lost connection to the multiplayer server'));
    };
    socket = ws;
  }

  function end(reason) {
    const wasGuest = role === 'guest';
    socket = null; role = 'solo'; me = null; room = null; sent = null; world = null;
    peers.clear();
    cursors.clear();
    strokes.length = 0;
    if (new URLSearchParams(location.search).has(JOIN_PARAM)) history.replaceState(null, '', location.pathname);
    hud.toast(wasGuest ? `${reason}. You can keep playing with this world on your own.` : reason);
    syncButton();
  }

  const send = (msg) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));

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
        me = { id: m.id, n: m.n, role: m.role };
        for (const p of m.peers) peers.set(p.id, p);
        if (role === 'guest') hud.toast(`Joined the host's world as ${peerName(me)}`);
        break;
      case 'join':
        peers.set(m.id, m);
        hud.toast(`${peerName(m)} joined`);
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
        if (p) hud.toast(`${peerName(p)} left`);
        peers.delete(m.id);
        cursors.remove(m.id);
        break;
      }
      case 'cursor':
        if (from) cursors.set(m.from, { name: peerName(from), color: peerColor(from) }, m);
        break;
      case 'paint':
        if (role === 'host' && validStroke(m)) strokes.push(m);
        break;
      case 'key':
        if (role === 'host') wantKey = true;
        break;
    }
    syncButton();
  }

  function validStroke(m) {
    return Array.isArray(m.c) && m.c.length === 3 && m.c.every(Number.isFinite) && PAINTABLE.has(m.tool) &&
      Number.isFinite(m.r) && Number.isFinite(m.rate) && BRUSH_SHAPES.has(m.shape);
  }

  // ---- host: stream the world ----
  async function sendCapture({ bytes, dims, release }) {
    const key = wantKey;
    wantKey = false;
    try {
      const dimsKey = dims.join('x');
      const fresh = key || !sent || sentDims !== dimsKey;
      if (!fresh) {
        scratch ??= new Uint8Array(bytes.length);
        if (!xorInto(scratch, bytes, sent)) return; // nothing changed (paused, or a still world)
      }
      const frame = await encodeFrame(fresh ? FRAME_KEY : FRAME_DELTA, seq + 1, dims, fresh ? bytes : scratch);
      if (role !== 'host' || !socket) return;
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
    frames = frames.then(() => applyFrame(buf)).catch((err) => console.error('multiplayer: bad world frame', err));
  }

  async function applyFrame(buf) {
    if (role !== 'guest') return;
    const { kind, seq: n, dims, body } = await decodeFrame(buf);
    if (kind === FRAME_KEY) {
      if (!sameDims(getSim().g, dims) && !setGrid(dims)) { socket?.close(); end('The host is using a grid size this version does not know'); return; }
      world = body;
    } else if (kind === FRAME_DELTA && world && n === worldSeq + 1 && body.length === world.length) {
      xorInto(world, world, body);
    } else {
      requestKey();
      return;
    }
    worldSeq = n;
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

  async function onButton() {
    if (role === 'solo' && !socket) {
      const code = crypto.randomUUID().replaceAll('-', '').slice(0, ROOM_CODE_LENGTH);
      connect('host', code);
      await copyInvite(code, 'Hosting. Invite link copied — send it to a friend');
    } else if (room) {
      await copyInvite(room, 'Invite link copied');
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
    button.title = role === 'solo' ? 'Play together: host this world and copy an invite link'
      : role === 'host' ? `Hosting · ${guests} ${guests === 1 ? 'guest' : 'guests'} · click to copy the invite link`
        : 'Playing in the host\'s world · click to copy the invite link';
    button.setAttribute('aria-label', button.title);
  }
  syncButton();

  const joinCode = new URLSearchParams(location.search).get(JOIN_PARAM);
  if (joinCode && RELAY_URL) connect('guest', joinCode);

  return {
    get role() { return role; },
    get isGuest() { return role === 'guest'; },

    // Guests: shows a toast and returns true for host-only actions.
    guard() {
      if (role !== 'guest') return false;
      hud.toast(GUEST_BLOCKED);
      return true;
    },

    // Guests send their strokes to the host instead of painting locally.
    paint({ center, radius, shape, tool, rate, replace }) {
      send({ t: 'paint', to: 'host', c: center.toArray(), r: radius, shape, tool, rate, replace });
    },

    // Once per frame, before the world is drawn.
    // cursor: { visible, center (grid cells), radius, shape, tool, painting }
    update(dt, cursor) {
      const now = performance.now();
      const sim = getSim();

      if (role === 'host') {
        for (const s of strokes) {
          sim.paint({
            center: { x: s.c[0], y: s.c[1], z: s.c[2] }, radius: Math.min(Math.max(s.r, MIN_BRUSH_RADIUS), MAX_BRUSH_RADIUS),
            shape: s.shape, tool: s.tool, rate: s.rate, replace: !!s.replace,
          });
        }
        strokes.length = 0;
        const hasGuests = [...peers.values()].some((p) => p.role === 'guest');
        if (hasGuests && now - lastStream >= STREAM_INTERVAL_MS && socket.bufferedAmount < MAX_BUFFERED_BYTES) {
          const capture = packer.pack(sim);
          if (capture) {
            lastStream = now;
            sending = sending.then(() => capture).then(sendCapture)
              .catch((err) => console.error('multiplayer: could not capture the world', err));
          }
        }
      }

      if (role === 'guest' && worldDirty) {
        unpacker.unpack(sim, world);
        worldDirty = false;
      }

      if (role !== 'solo' && now - lastPresence >= PRESENCE_INTERVAL_MS) {
        const q = (v) => Math.round(v * CURSOR_STEPS_PER_CELL) / CURSOR_STEPS_PER_CELL;
        const json = JSON.stringify(cursor.visible
          ? { t: 'cursor', c: cursor.center.toArray().map(q), r: cursor.radius, shape: cursor.shape, tool: cursor.tool, painting: cursor.painting }
          : { t: 'cursor', c: null });
        if (json !== lastPresenceJSON) {
          socket?.readyState === WebSocket.OPEN && socket.send(json);
          lastPresenceJSON = json;
          lastPresence = now;
        }
      }

      cursors.update(dt);
    },
  };
}
