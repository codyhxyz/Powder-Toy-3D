// Where the relay (relay/worker.js) lives. Production builds point at the
// deployed one through VITE_RELAY_URL (.env.production); dev servers use a local
// `wrangler dev`. Without either there's no relay, and what needs it hides.
// (net/multiplayer.js keeps its own copy of this.)

const DEV_RELAY_PORT = 8787; // `wrangler dev` default

// ws(s):// base, for multiplayer rooms
export const RELAY_URL = import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? `ws://${location.hostname}:${DEV_RELAY_PORT}` : null);

// http(s):// base of the same host, for fetch (the free AI, accounts); '' without a relay
export const RELAY_HTTP = RELAY_URL ? RELAY_URL.replace(/^ws/, 'http') : '';

// A plain ws:// relay is a local `wrangler dev` one: the deployed relay is wss://.
export const LOCAL_RELAY = !!RELAY_URL?.startsWith('ws://');
