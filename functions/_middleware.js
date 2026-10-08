// Cloudflare Pages middleware: every alias domain permanently redirects to the
// canonical host, keeping the path and query (e.g. ?preset=volcano).
const CANONICAL = 'tpt3d.codyh.xyz';
const ALIASES = new Set(['tpt.codyh.xyz', 'thepowdertoy.codyh.xyz', 'thepowdertoy3d.codyh.xyz']);

// Multiplayer invite links (?join=CODE, JOIN_PARAM in src/net/multiplayer.js)
// unfurl as an invitation in chats instead of the generic card.
const JOIN_PARAM = 'join';
const INVITE_TITLE = 'Join my world in Powder Toy 3D';
const INVITE_DESCRIPTION = 'A live falling-sand world, simulated on the GPU. Open the link to pour, flood and burn it together, right in your browser.';
const INVITE_TAGS = {
  'meta[property="og:title"]': INVITE_TITLE,
  'meta[name="twitter:title"]': INVITE_TITLE,
  'meta[property="og:description"]': INVITE_DESCRIPTION,
  'meta[name="twitter:description"]': INVITE_DESCRIPTION,
};

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (ALIASES.has(url.hostname)) {
    url.hostname = CANONICAL;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  const res = await next();
  if (!url.searchParams.has(JOIN_PARAM) || !res.headers.get('content-type')?.includes('text/html')) return res;
  let rw = new HTMLRewriter().on('meta[property="og:url"]', { element: (el) => el.setAttribute('content', url.toString()) });
  for (const [sel, text] of Object.entries(INVITE_TAGS)) rw = rw.on(sel, { element: (el) => el.setAttribute('content', text) });
  return rw.transform(res);
}
