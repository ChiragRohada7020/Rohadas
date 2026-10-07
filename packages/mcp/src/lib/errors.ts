/**
 * MCP tool error normalization.
 *
 * All tool handlers are wrapped with wrapTool() to ensure errors are returned
 * as structured MCP content rather than thrown exceptions. The MCP SDK itself
 * handles uncaught exceptions, but we want to give the AI agent a useful, plain
 * English message rather than a raw JSON error envelope.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RohadasApiError, formatRohadasError, type RohadasError } from "../client.js";

type ToolHandler<T> = (input: T) => Promise<CallToolResult>;

/**
 * Wrap a tool handler in error normalization.
 *
 * - Successful calls pass through unchanged.
 * - RohadasApiError is translated to a structured, agent-readable error message.
 * - Any other thrown error is collapsed to a safe api_error (no stack traces exposed).
 */
export function wrapTool<T>(handler: ToolHandler<T>): ToolHandler<T> {
  return async (input: T): Promise<CallToolResult> => {
    try {
      return await handler(input);
    } catch (err) {
      const hisaaboErr = toRohadasError(err);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: formatRohadasError(hisaaboErr),
          },
        ],
      };
    }
  };
}

function toRohadasError(err: unknown): RohadasError {
  if (err instanceof RohadasApiError) {
    return err.hisaaboError;
  }
  // Sanitize network errors — don't leak hostnames, IPs, or ports to the AI agent
  if (err instanceof Error) {
    if (err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT")) {
      return { code: "api_error", message: "Unable to connect to the Rohadas API. Check that the server is running and HISAABO_API_URL is correct." };
    }
    if (err.message.includes("ENOTFOUND")) {
      return { code: "api_error", message: "Cannot resolve the Rohadas API hostname. Check HISAABO_API_URL." };
    }
    if (err.name === "AbortError" || err.message.includes("timeout")) {
      return { code: "api_error", message: "Request to the Rohadas API timed out (30s). The server may be overloaded." };
    }
    return { code: "api_error", message: err.message };
  }
  return { code: "api_error", message: "An unexpected error occurred. Check server logs." };
}
