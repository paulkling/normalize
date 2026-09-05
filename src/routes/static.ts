import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/**
 * Files in `public/` served at the web root.
 *
 * Listed explicitly rather than mounted as a wildcard so a file can never shadow an API route,
 * and so the set of publicly readable files is obvious from this file alone.
 */
export const PUBLIC_FILES = ["/favicon.ico", "/icon-32.png", "/icon-180.png", "/icon.png"] as const;

const CACHE_CONTROL = "public, max-age=86400";

export function staticRoutes() {
  const app = new Hono();
  for (const file of PUBLIC_FILES) {
    // serveStatic builds its Response before onFound runs, so the cache header is added on the way out.
    app.use(file, async (c, next) => {
      await next();
      if (c.res.ok) c.res.headers.set("cache-control", CACHE_CONTROL);
    });
    app.use(file, serveStatic({ path: `./public${file}` }));
  }
  return app;
}
