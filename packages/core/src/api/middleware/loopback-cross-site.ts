import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { isCrossSiteLoopbackMutation } from "../../lib/cross-site-loopback.js";
import { isLoopbackAddress } from "../../lib/trusted-loopback.js";

function isDirectLoopbackCaller(c: Context): boolean {
  // Truthiness, not presence, to match lib/guardian-session.ts.
  if (c.req.header("x-forwarded-for")) return false;
  try {
    return isLoopbackAddress(getConnInfo(c).remote.address);
  } catch {
    return false;
  }
}

/**
 * Answers 403 to a mutation from a direct loopback caller (the trusted
 * in-container caller of lib/trusted-loopback.ts) when a browser page on
 * another origin sent it. Proxied traffic carries `X-Forwarded-For` and passes
 * through untouched. Register before every route, because Hono runs middleware
 * only for routes registered after it.
 */
export function refuseCrossSiteLoopbackMutations(): MiddlewareHandler {
  return async (c, next) => {
    if (isDirectLoopbackCaller(c) && isCrossSiteLoopbackMutation(c.req.raw)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}
