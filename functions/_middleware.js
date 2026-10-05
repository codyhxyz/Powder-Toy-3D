// Cloudflare Pages middleware: every alias domain permanently redirects to the
// canonical host, keeping the path and query (e.g. ?preset=volcano).
const CANONICAL = 'tpt3d.codyh.xyz';
const ALIASES = new Set(['tpt.codyh.xyz', 'thepowdertoy.codyh.xyz', 'thepowdertoy3d.codyh.xyz']);

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (ALIASES.has(url.hostname)) {
    url.hostname = CANONICAL;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
