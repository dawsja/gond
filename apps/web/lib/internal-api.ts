const INTERNAL = /^\/api\/(llm|mcp)(\/|$)/i;

function decoded(pathname: string): string {
  let path = pathname;
  for (let i = 0; i < 3 && path.includes("%"); i++) {
    try {
      path = decodeURIComponent(path);
    } catch {
      break;
    }
  }
  return path.replace(/\/{2,}/g, "/");
}

// The API resolves `.` and `..` segments (and their escapes) before routing, so the check must too.
function resolved(pathname: string): string {
  try {
    return new URL(pathname, "http://gond.invalid").pathname;
  } catch {
    return pathname;
  }
}

/** The API's LLM and MCP proxies trust a bearer token alone and are for the box on the Compose network, never the internet. */
export function isInternalApiPath(pathname: string): boolean {
  return [pathname, decoded(pathname)].some((path) => INTERNAL.test(path) || INTERNAL.test(resolved(path)) || INTERNAL.test(resolved(decoded(resolved(path)))));
}
