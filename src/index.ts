interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * web-fetch — fetch ONE public URL live from its origin, verbatim.
 *
 * Returns the bytes (or text decoded from those bytes) together with a SHA-256
 * of exactly what the origin sent, the redirect chain, and the response
 * headers that matter for provenance. Keyless.
 *
 * Every refusal is loud and named (`blocked_url`, `upstream_refused`,
 * `upstream_down`, `upstream_status`, `unsupported_content_type`, `too_large`,
 * `budget_exhausted`, `invalid_argument`) — never an empty body and never
 * `found: false`. The logic lives in ./core.ts.
 */

import { fetchUrl, type KvLike, type StoreLike } from './core.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'fetch_url',
    description:
      'Fetch the exact contents of ONE public web URL live from its origin server and return them verbatim with a SHA-256 hash of the bytes received. ' +
      'Use it to read a specific page, raw data file (CSV, TSV, .dat, JSON, XML), API endpoint or PDF whose address you already know. ' +
      'format "auto" (default) returns readable text for HTML and PDF and the raw body for everything else; "raw" returns the body itself (decoded text, or base64 for binary such as zip/xlsx); "text" forces text extraction. ' +
      'Large bodies page with max_bytes and offset. Also returns url_final, the redirect chain, status, response headers, charset and how it was chosen. ' +
      'Refusals are explicit: blocked_url (private address, disallowed port or scheme, credentials in the URL), upstream_refused (the site answered 401/403/429 or a bot wall; the response names archive_evidence as a place to look for a capture), upstream_down, upstream_status (e.g. 404). ' +
      'Does not run JavaScript, log in, send cookies or search; for a past version of a page use archive_evidence. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The absolute http(s) URL to fetch, e.g. "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv". http:// is tried over https first.',
        },
        format: {
          type: 'string',
          enum: ['auto', 'raw', 'text'],
          description: 'auto (default): text for HTML and PDF, raw for everything else. raw: the body as received. text: readable text extracted from HTML/PDF.',
        },
        max_bytes: {
          type: 'number',
          description: 'Size of the returned window. Default 100000. Maximum 1000000 for text, 512000 for base64 (binary).',
        },
        offset: {
          type: 'number',
          description: 'Where the window starts: a byte offset into the body (raw), or a character offset into the extracted text (text). Use next_offset from the previous call to page. Default 0.',
        },
      },
      required: ['url'],
    },
  },
];

function kvFrom(args: Record<string, unknown>): KvLike | null {
  const kv = args._cacheKv as KvLike | undefined;
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? kv : null;
}

function storeFrom(): StoreLike | null {
  const c = (globalThis as unknown as { caches?: { default?: StoreLike } }).caches?.default;
  return c && typeof c.match === 'function' ? c : null;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'fetch_url':
      return fetchUrl(args, {
        kv: kvFrom(args),
        store: storeFrom(),
        internal: args._wfInternal === true,
        denyHosts: Array.isArray(args._wfDenyHosts) ? (args._wfDenyHosts as unknown[]).filter((h): h is string => typeof h === 'string') : [],
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
