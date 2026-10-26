import { expect, test } from "bun:test";
import { isInternalApiPath } from "../lib/internal-api";

test("the LLM and MCP proxies are refused from outside", () => {
  for (const path of ["/api/llm", "/api/llm/anthropic/v1/messages", "/api/mcp/mcp_1/mcp", "/api/mcp", "/API/LLM/openai", "/api//llm/openai", "/api/%6Clm/openai/responses", "/api/%256Dcp/x/mcp", "/api/mcp%2Fx/mcp"]) {
    expect(isInternalApiPath(path)).toBe(true);
  }
});

test("everything else under /api still goes through", () => {
  for (const path of ["/api", "/api/me", "/api/mcp-servers", "/api/mcp-servers/oauth/callback", "/api/mcp-servers/mcp_1/login", "/api/models", "/api/providers", "/api/llmish", "/api/threads/llm"]) {
    expect(isInternalApiPath(path)).toBe(false);
  }
});
