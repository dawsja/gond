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

/** The API's LLM and MCP proxies trust a bearer token alone and are for the box on the Compose network, never the internet. */
export function isInternalApiPath(pathname: string): boolean {
  return INTERNAL.test(pathname) || INTERNAL.test(decoded(pathname));
}
