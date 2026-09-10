import { Router } from "express";

const GOOGLE_API_ORIGIN = "https://generativelanguage.googleapis.com";

type JsonNode = unknown;

function collapseNullableType(node: Record<string, unknown>) {
  if (!Array.isArray(node.type)) return;
  const types = node.type as unknown[];
  const hasNull = types.includes("null");
  const nonNull = types.filter((t) => t !== "null");
  if (hasNull) node.nullable = true;
  if (nonNull.length >= 1) node.type = nonNull[0];
  else delete node.type;
}

/**
 * Gemini's function-calling schema is a restricted subset of JSON Schema (roughly
 * OpenAPI 3.0) and its converter rejects the *entire request* if any schema anywhere
 * contains a key it doesn't recognize — no lenient/ignore-unknown-fields behavior like
 * Anthropic/OpenAI's converters have. Two distinct sources of unrecognized keys have
 * shown up so far:
 *   - Zod v4's own JSON Schema output uses draft-2020-12 constructs (`exclusiveMinimum`/
 *     `exclusiveMaximum` as numbers, `type` as an array, `anyOf: [X, {type:"null"}]` for
 *     nullable fields) that predate what Gemini's schema was built against.
 *   - Vendor-extension keys individual MCP servers attach to a property's own schema —
 *     e.g. GitHub's remote MCP server tags some parameters with `x-mcp-header` (a hint to
 *     fill that value from an HTTP header rather than the model). These are legitimate,
 *     just not part of the JSON Schema spec Gemini validates against.
 * This walks a tool's `parameters` schema and rewrites/strips those into forms Gemini
 * accepts, regardless of which tool or server originated them.
 */
function sanitizeSchema(node: JsonNode): JsonNode {
  if (Array.isArray(node)) {
    return node.map(sanitizeSchema);
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;

    if (Array.isArray(obj.anyOf)) {
      const branches = obj.anyOf as Record<string, unknown>[];
      const nonNullBranches = branches.filter((b) => b?.type !== "null");
      if (nonNullBranches.length === 1) {
        const { anyOf, ...rest } = obj;
        void anyOf;
        const merged = { ...rest, ...(nonNullBranches[0] as object) };
        if (nonNullBranches.length !== branches.length) merged.nullable = true;
        return sanitizeSchema(merged);
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // `x-` is the standard JSON Schema convention for vendor/tool-specific extensions —
      // never part of the spec proper, so never something Gemini's validator will accept.
      if (key.startsWith("x-")) continue;
      if (key === "exclusiveMinimum" && typeof value === "number") {
        result.minimum = value;
        continue;
      }
      if (key === "exclusiveMaximum" && typeof value === "number") {
        result.maximum = value;
        continue;
      }
      result[key] = sanitizeSchema(value);
    }
    collapseNullableType(result);
    return result;
  }
  return node;
}

interface GeminiFunctionDeclaration {
  parameters?: unknown;
  [key: string]: unknown;
}

interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  [key: string]: unknown;
}

interface GeminiRequestBody {
  tools?: GeminiTool[];
  [key: string]: unknown;
}

function sanitizeRequestBody(body: GeminiRequestBody): GeminiRequestBody {
  if (!Array.isArray(body.tools)) return body;
  return {
    ...body,
    tools: body.tools.map((tool) =>
      Array.isArray(tool.functionDeclarations)
        ? {
            ...tool,
            functionDeclarations: tool.functionDeclarations.map((fn) => ({
              ...fn,
              parameters: fn.parameters ? sanitizeSchema(fn.parameters) : fn.parameters,
            })),
          }
        : tool
    ),
  };
}

const HOP_BY_HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding"]);

export function geminiProxyRouter() {
  const router = Router();

  router.use(async (req, res) => {
    try {
      const targetUrl = `${GOOGLE_API_ORIGIN}${req.url}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body && Object.keys(req.body).length > 0;
      const outgoingBody = hasBody ? sanitizeRequestBody(req.body as GeminiRequestBody) : undefined;

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      if (outgoingBody) headers["content-type"] = "application/json";

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: outgoingBody ? JSON.stringify(outgoingBody) : undefined,
      });

      res.status(upstream.status);
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);

      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  return router;
}
