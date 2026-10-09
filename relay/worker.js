import { DurableObject } from 'cloudflare:workers';
import { handleAI } from './ai.js';
import { handleAuth, userForToken } from './auth.js';

export { AiQuota } from './ai.js';

// Multiplayer relay: one Durable Object per room, a dumb message hub.
//   wss://<relay>/room/<code>?role=host|guest
// The same Worker also serves the free construction AI (ai.js) under /ai/.
// Relay → player: welcome { id, n, role, name, peers }, join { id, n, role, name },
// leave { id }, refused { reason } (then the socket closes).
// The host's binary messages (world frames) go to every guest. JSON messages
// go to everyone else in the room, or only to the host when they carry
// { to: 'host' }; the relay stamps them with { from: <sender id> }. It also
// announces arrivals and departures and closes the room when the host leaves.
// Player identity lives in each socket's attachment, so the object can
// hibernate between messages.
// Signed-in players open the socket with the subprotocols ['tpt3d', <session
// token>] (a browser WebSocket can't send an Authorization header); the relay
// looks the token up and gives them their first name. Signed-out players have
// name null and show as Host / Guest <n>. Chat { t: 'chat', text } goes to
// everyone, with the relay's name for the sender, never one the client claims.

const MAX_ROOM_CODE = 64;
const ROOM_PATH = new RegExp(`^/room/([A-Za-z0-9_-]{1,${MAX_ROOM_CODE}})$`);
const ROLES = new Set(['host', 'guest']);
const HOST_NUMBER = 0; // guests are numbered from 1, reusing gaps
const WS_PROTOCOL = 'tpt3d';          // first subprotocol; the second is the session token
const MAX_PLAYER_NAME_CHARS = 16;     // Minecraft's username limit
const MAX_CHAT_CHARS = 256;           // Minecraft's chat limit (src/net/chat.js matches)
const CHAT_MIN_INTERVAL_MS = 500;     // one chat line per player per half second
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Message types only the relay sends; players can't forge them (say, a fake
// "leave" with the host's id that would end everyone else's session).
const RELAY_TYPES = new Set(['welcome', 'join', 'leave', 'refused']);

// Pages that may open rooms. A script can send any Origin header, so this
// stops other sites from reusing the relay, not a determined client.
const SITE_HOSTS = new Set(['tpt3d.codyh.xyz']);
const PAGES_HOST = 'tpt3d.pages.dev'; // Cloudflare Pages previews: <hash>.tpt3d.pages.dev
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PRIVATE_LAN = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/; // `vite --host` on a home network

function allowedOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname;
  if (url.protocol === 'https:') return SITE_HOSTS.has(host) || host === PAGES_HOST || host.endsWith(`.${PAGES_HOST}`);
  return url.protocol === 'http:' && (DEV_HOSTS.has(host) || PRIVATE_LAN.test(host));
}

// Application close codes (4000–4999); the reason is shown to the player.
const CLOSE = { BAD_REQUEST: 4000, NO_HOST: 4001, HOST_TAKEN: 4002, HOST_LEFT: 4003 };

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/ai/')) return handleAI(request, env, ctx, allowedOrigin);
    if (new URL(request.url).pathname.startsWith('/auth/')) return handleAuth(request, env, ctx, allowedOrigin); // accounts (auth.js)
    const room = new URL(request.url).pathname.match(ROOM_PATH)?.[1];
    if (!room) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!allowedOrigin(request.headers.get('Origin'))) return new Response('Origin not allowed', { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class Room extends DurableObject {
  lastChat = new WeakMap(); // socket → time of its last chat line (resets if the room hibernates, which is fine)

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const signedIn = offered[0] === WS_PROTOCOL;
    const user = signedIn ? await userForToken(offered[1], this.env) : null;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // A browser drops the socket unless the reply names one of the subprotocols it offered.
    const upgrade = () => new Response(null, { status: 101, webSocket: client, headers: signedIn ? { 'Sec-WebSocket-Protocol': WS_PROTOCOL } : {} });

    const peers = this.peers();
    const hasHost = peers.some((p) => p.role === 'host');
    // The close reason doesn't survive closing before the upgrade completes, so say it first.
    const refuse = (code, reason) => {
      server.send(JSON.stringify({ t: 'refused', reason }));
      server.close(code, reason);
      return upgrade();
    };
    if (!ROLES.has(role)) return refuse(CLOSE.BAD_REQUEST, 'Unknown role');
    if (role === 'host' && hasHost) return refuse(CLOSE.HOST_TAKEN, 'Someone is already hosting this room');
    if (role === 'guest' && !hasHost) return refuse(CLOSE.NO_HOST, 'No one is hosting this room');

    const me = { id: crypto.randomUUID(), n: role === 'host' ? HOST_NUMBER : nextGuestNumber(peers), role, name: playerName(user) };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ t: 'welcome', ...me, peers }));
    this.broadcast(JSON.stringify({ t: 'join', ...me }), server);
    return upgrade();
  }

  async webSocketMessage(ws, data) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    if (typeof data !== 'string') {
      if (me.role === 'host') this.broadcast(data, ws, 'guest');
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object' || RELAY_TYPES.has(msg.t)) return;
    if (msg.t === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.replace(CONTROL_CHARS, '').trim() : '';
      const now = Date.now();
      if (!text || text.length > MAX_CHAT_CHARS || now - (this.lastChat.get(ws) ?? 0) < CHAT_MIN_INTERVAL_MS) return;
      this.lastChat.set(ws, now);
      msg = { t: 'chat', text };
    }
    msg.from = me.id;
    this.broadcast(JSON.stringify(msg), ws, msg.to === 'host' ? 'host' : null);
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    try { ws.serializeAttachment(null); } catch { /* already closed */ }
    this.broadcast(JSON.stringify({ t: 'leave', id: me.id }), ws);
    if (me.role === 'host') {
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        try {
          other.serializeAttachment(null);
          other.close(CLOSE.HOST_LEFT, 'The host left');
        } catch { /* already closed */ }
      }
    }
    try { ws.close(); } catch { /* already closed */ }
  }

  peers() {
    return this.ctx.getWebSockets().map((ws) => { try { return ws.deserializeAttachment(); } catch { return null; } }).filter(Boolean);
  }

  broadcast(data, except, onlyRole = null) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        const p = ws.deserializeAttachment();
        if (p && (!onlyRole || p.role === onlyRole)) ws.send(data);
      } catch { /* closing */ }
    }
  }
}

// The first word of the account's name, cleaned and bounded; null when signed out.
function playerName(user) {
  const first = typeof user?.name === 'string' ? user.name.replace(CONTROL_CHARS, '').trim().split(/\s+/)[0] : '';
  return first ? first.slice(0, MAX_PLAYER_NAME_CHARS) : null;
}

function nextGuestNumber(peers) {
  const taken = new Set(peers.map((p) => p.n));
  let n = HOST_NUMBER + 1;
  while (taken.has(n)) n++;
  return n;
}
