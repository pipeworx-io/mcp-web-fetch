# @pipeworx/web-fetch

Fetch the exact contents of one public URL, live from its origin server, and
get back the bytes (or text decoded from them) with a SHA-256 hash of exactly
what the origin sent, plus the redirect chain and the response headers.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `fetch_url(url, format?, max_bytes?, offset?)` — one GET of one public
  http(s) URL. Returns `status`, `url_final`, `redirects` (present only when the
  URL redirected), `headers` (content-type, content-length, last-modified, etag,
  content-language, date), `content_family` (`text` | `pdf` | `archive` |
  `binary`), `bytes_total`, `sha256` over the complete body, and a window of
  the body:
  - `format: "auto"` (default) — readable text for HTML and PDF, the raw body
    for everything else.
  - `format: "raw"` — the body itself: decoded text for text types, base64 for
    binary (zip, xlsx, gzip, PDF). `sha256_returned` hashes exactly the bytes in
    the window.
  - `format: "text"` — extracted text (`text_extraction`: `html` | `pdf` |
    `none` | `failed`). PDF extraction warnings are passed through in
    `warnings`.
  - `max_bytes` (default 100,000; at most 1,000,000 for text, 512,000 for
    base64) and `offset` page through a large body; follow `next_offset`.

  Text is decoded from the bytes, never guessed: the charset comes from a BOM,
  then the `Content-Type` header, then the page's own `<meta charset>` or XML
  declaration, then UTF-8 if the bytes are valid UTF-8, else windows-1252.
  `charset_source` says which rule decided and `decode_replacements` counts any
  characters lost in decoding (0 means none).

### Checking "verbatim" yourself

`sha256` is taken over the entity body after transfer compression is removed —
the same bytes `curl --compressed -s <url> | shasum -a 256` writes. Two caveats:
a dynamic page can legitimately hash differently a second later, and some
sites serve different content by location, so the answer is verbatim *as
served to this fetch* (`colo`, when known, names the edge location).

### Refusals — always loud, never an empty body

| `error` | when |
|---|---|
| `blocked_url` | `rule`: `scheme` (not http/https), `port` (not 80/443), `userinfo` (`user:pass@`), `private_address`, `dns_private` (the name resolves to a private address), `denylisted_host`, `too_many_redirects`, `invalid_redirect`. Checked on the URL **and every redirect hop**. |
| `upstream_refused` | 401 / 402 / 403 / 407 / 429 / 451, or a bot-wall page (`reason: "bot_wall"`). Carries `status`, a short `body_summary`, and a `hint` naming `archive_evidence`, which is never run automatically. |
| `upstream_down` | 5xx, timeout, connection or DNS failure (`phase`). |
| `upstream_status` | any other non-2xx, e.g. 404. |
| `unsupported_content_type` | images, audio, video, fonts and executables (by declared type or by magic bytes). |
| `too_large` | an `offset` beyond the 10 MB read limit on an origin without byte ranges. |
| `budget_exhausted` | the per-site or hourly limit below; carries `retry_after_s`. |
| `invalid_argument` | a malformed argument. |

## Limits

- One GET, no cookies, no login, no caller headers, no JavaScript execution.
  `likely_needs_js: true` flags a page that renders its content with scripts.
- 10 MB read per call; a larger body returns the first window with
  `truncated: true`, `body_complete: false` and `sha256: null`.
- 25 s per call, at most 4 redirects.
- Per site (registrable domain), across all callers: 30 requests a minute and
  1,000 a day (sec.gov: 5 a minute). A 200 response is reused for 10 minutes
  (`served_from: "cache"`, `cache_age_s`).
- Identifies itself honestly as `Pipeworx/1.0 (pipeworx.io)`; on a 403 it
  retries once as `Pipeworx/1.0 (+https://pipeworx.io; support@pipeworx.io)`
  and reports which it used in `user_agent_used`.

## Auth

Keyless.

## Data sources

- Whatever public URL the caller names. Nothing is fetched except that URL and
  its redirects, plus a DNS-over-HTTPS lookup at
  <https://cloudflare-dns.com/dns-query> to refuse names that resolve to private
  addresses.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "web-fetch": {
      "url": "https://gateway.pipeworx.io/web-fetch/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/web-fetch/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fetch_url \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv","max_bytes":2000}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fetch_url`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-web-fetch` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/web-fetch/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "web-fetch": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-web-fetch"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Web Fetch data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
