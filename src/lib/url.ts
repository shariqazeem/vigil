/**
 * Where a redirect goes. Behind nginx, Next builds `req.url` from the address it listens on
 * (localhost:3100), so a form post would bounce the browser to a URL that does not exist. The
 * public origin wins whenever it is configured.
 */
export function absolute(path: string, req: Request): URL {
  return new URL(path, process.env.WARDEN_BASE_URL?.trim() || req.url);
}
