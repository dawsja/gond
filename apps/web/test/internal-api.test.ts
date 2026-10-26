import { expect, test } from "bun:test";
import { isInternalApiPath } from "../lib/internal-api";

test("the LLM and MCP proxies are refused from outside", () => {
  for (const path of ["/api/llm", "/api/llm/anthropic/v1/messages", "/api/mcp/mcp_1/mcp", "/api/mcp", "/API/LLM/openai", "/api//llm/openai", "/api/%6Clm/openai/responses", "/api/%256Dcp/x/mcp", "/api/mcp%2Fx/mcp", "/api/./llm/anthropic/v1/messages", "/api/x/../llm/anthropic/v1/messages", "/api/%2e/llm/x", "/api/%2E%2E/api/mcp/x", "/api/a/%2e%2e/mcp/x/mcp", "/api/%252e/llm/x", "/api\\..\\api/llm/x"]) {
    expect(isInternalApiPath(path)).toBe(true);
  }
});

test("everything else under /api still goes through", () => {
  for (const path of ["/api", "/api/me", "/api/mcp-servers", "/api/mcp-servers/oauth/callback", "/api/mcp-servers/mcp_1/login", "/api/models", "/api/providers", "/api/llmish", "/api/threads/llm", "/api/./me", "/api/threads/../me"]) {
    expect(isInternalApiPath(path)).toBe(false);
  }
});
