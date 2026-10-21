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
 * Decode a body from its BYTES, choosing the charset in a stated order and
 * saying which rule chose it.
 *
 * Why this exists (fleet #2742, #2729): the egress relay read an ISO-8859-1
 * page with `Response.text()`, which assumes UTF-8 when the header carries no
 * charset, and re-wrapped the result. Every 0xA7 byte -- the section sign in a
 * statute index -- became EF BF BD (U+FFFD), and the output still read as
 * plausible text. The bytes were gone before anything could notice. The rule
 * that follows from it: read bytes, hash bytes, THEN decode, and never let the
 * decoder guess silently.
 *
 * Resolution order (reported as `charset_source`):
 *   1. `bom`           a byte-order mark (UTF-8, UTF-16LE, UTF-16BE)
 *   2. `content-type`  `charset=` on the Content-Type header
 *   3. `html-meta`     `<meta charset>` or `http-equiv` Content-Type in the
 *                      first 1,024 bytes
 *   4. `xml-decl`      `<?xml ... encoding="...">` at the start of the body
 *   5. `utf8-valid`    the bytes decode as UTF-8 with `fatal: true`
 *   6. `fallback`      windows-1252, which is what WHATWG decodes `iso-8859-1`
 *                      as anyway, and which maps every byte to a character
 *
 * A label the runtime's TextDecoder does not know is skipped and the next rule
 * is tried; `ignored_labels` names it so a caller can see the page lied.
 *
 * `decode_replacements` counts U+FFFD characters that DECODING introduced --
 * the ones already present in the source as UTF-8 EF BF BD are subtracted.
 * Non-zero means the text is lossy; the bytes (and any hash over them) are not.
 */

type CharsetSource = 'bom' | 'content-type' | 'html-meta' | 'xml-decl' | 'utf8-valid' | 'fallback';

interface CharsetChoice {
  /** The WHATWG encoding name TextDecoder resolved the label to. */
  charset: string;
  charset_source: CharsetSource;
  /** Labels found in the header/meta/decl that TextDecoder rejected. */
  ignored_labels: string[];
  /** BOM bytes to skip (TextDecoder strips a matching BOM itself; kept for callers that slice). */
  bom_length: number;
}

interface DecodedText extends CharsetChoice {
  text: string;
  decode_replacements: number;
}

const META_SCAN_BYTES = 1024;

/** Normalize a label through TextDecoder; null when the runtime does not know it. */
function resolveLabel(label: string): string | null {
  const l = label.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!l) return null;
  try {
    return new TextDecoder(l).encoding;
  } catch {
    return null;
  }
}

/** The `charset=` parameter of a Content-Type header value, or null. */
function contentTypeCharset(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = /;\s*charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

function bomOf(b: Uint8Array): { charset: string; length: number } | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { charset: 'utf-8', length: 3 };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { charset: 'utf-16be', length: 2 };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { charset: 'utf-16le', length: 2 };
  return null;
}

/** ASCII view of the first `n` bytes. Bytes > 0x7F become '?' so regexes stay ASCII-only. */
function asciiHead(b: Uint8Array, n: number): string {
  const end = Math.min(b.length, n);
  let s = '';
  for (let i = 0; i < end; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : '?';
  return s;
}

function metaCharset(head: string): string | null {
  // <meta charset="x"> and <meta http-equiv="Content-Type" content="text/html; charset=x">
  // both reduce to "charset=" inside a <meta ...> tag.
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(head))) {
    const c = /charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(m[0]);
    if (c) return c[1];
  }
  return null;
}

function xmlDeclCharset(head: string): string | null {
  const m = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/i.exec(head);
  return m ? m[1] : null;
}

function isValidUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Choose a charset for `bytes` without decoding the whole body. */
function chooseCharset(bytes: Uint8Array, contentType?: string | null): CharsetChoice {
  const ignored: string[] = [];
  const bom = bomOf(bytes);
  if (bom) return { charset: bom.charset, charset_source: 'bom', ignored_labels: ignored, bom_length: bom.length };

  const header = contentTypeCharset(contentType);
  if (header) {
    const r = resolveLabel(header);
    if (r) return { charset: r, charset_source: 'content-type', ignored_labels: ignored, bom_length: 0 };
    ignored.push(header);
  }

  const head = asciiHead(bytes, META_SCAN_BYTES);
  const meta = metaCharset(head);
  if (meta) {
    let r = resolveLabel(meta);
    // HTML spec: a meta declaring UTF-16 is a lie (the meta itself was readable
    // as ASCII), so it means UTF-8.
    if (r === 'utf-16le' || r === 'utf-16be') r = 'utf-8';
    if (r) return { charset: r, charset_source: 'html-meta', ignored_labels: ignored, bom_length: 0 };
    ignored.push(meta);
  }

  const decl = xmlDeclCharset(head);
  if (decl) {
    const r = resolveLabel(decl);
    if (r) return { charset: r, charset_source: 'xml-decl', ignored_labels: ignored, bom_length: 0 };
    ignored.push(decl);
  }

  if (isValidUtf8(bytes)) return { charset: 'utf-8', charset_source: 'utf8-valid', ignored_labels: ignored, bom_length: 0 };
  return { charset: 'windows-1252', charset_source: 'fallback', ignored_labels: ignored, bom_length: 0 };
}

function countFffdInText(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\uFFFD'); i !== -1; i = s.indexOf('\uFFFD', i + 1)) n++;
  return n;
}

function countEfBfBd(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0xef && b[i + 1] === 0xbf && b[i + 2] === 0xbd) {
      n++;
      i += 2;
    }
  }
  return n;
}

/**
 * Decode `bytes` with an already-chosen charset (e.g. one chosen over a whole
 * body, applied to a window of it). Counts only the U+FFFD that decoding
 * introduced.
 */
function decodeWithCharset(bytes: Uint8Array, charset: string): { text: string; decode_replacements: number } {
  // TextDecoder strips a BOM that matches its own encoding; ignoreBOM:false is the default.
  const text = new TextDecoder(charset).decode(bytes);
  const present = charset === 'utf-8' ? countEfBfBd(bytes) : 0;
  return { text, decode_replacements: Math.max(0, countFffdInText(text) - present) };
}

/**
 * Decode `bytes` to text. `bytes` is never modified; hash it before or after,
 * the answer is the same.
 */
function decodeBytes(bytes: Uint8Array, contentType?: string | null): DecodedText {
  const choice = chooseCharset(bytes, contentType);
  return { ...choice, ...decodeWithCharset(bytes, choice.charset) };
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}


/**
 * Minimal text extractor for simple, text-based PDFs — the kind a
 * mail-merge/print pipeline produces (Word or LibreOffice "export to PDF"),
 * not a scanned image. Built for Kentucky's per-statute PDFs
 * (apps.legislature.ky.gov/law/statutes/statute.aspx?id=...), which ARE
 * exactly that shape: one object tree, FlateDecode content streams, standard
 * TrueType fonts. This is the capability the state-law survey flagged as
 * "the largest single win available" (docs/state-law-probe.md) — several
 * state statute sites serve text ONLY as a per-section PDF, with no HTML
 * fallback, and until now this repo had no way to read one.
 *
 * WHAT THIS DOES NOT DO: parse a general PDF. No encryption, no cross-
 * reference recovery for a damaged file, no image/OCR, no custom
 * `/Differences` glyph encodings, no LZW or RunLength filters, no multi-byte
 * codespaces other than the 2-byte one every sampled font used. Most objects
 * this needs — Catalog, Pages, a leaf Page, its Resources/Font dict, its
 * Contents stream(s), a Type0 font's ToUnicode CMap — are found by scanning
 * for `N 0 obj ... endobj` directly in the file bytes. If a producer moves
 * one into a compressed object stream and this extractor still cannot find
 * it (see the next paragraph for what IS handled), extraction degrades to
 * `pages_found: 0` / empty text rather than silently returning garbage —
 * check `warnings` before trusting a thin result.
 *
 * COMPRESSED OBJECT STREAMS (`/Type/ObjStm`) ARE SUPPORTED (fleet #2744,
 * added for Wyoming's statute PDFs, which — unlike Kentucky's — are
 * cross-reference-STREAM files whose Catalog and Pages root are themselves
 * compressed into an ObjStm: `5205 0 obj` never appears literally in the
 * file; it exists only as entry in a decompressed `/Type/ObjStm` stream).
 * Every direct `/Type/ObjStm` object found in the file is inflated up front;
 * its header (`/N` object pairs starting at byte `/First`) is parsed into a
 * `(object number -> dict text)` map, and `getObject` falls back to that map
 * whenever the direct byte-scan finds nothing. Per the PDF spec a compressed
 * object can never itself contain a stream (Contents, ToUnicode CMaps, and
 * ObjStm/XRef streams are therefore always direct objects, found the
 * original way) — so this fallback only ever needs to resolve plain
 * dictionaries/arrays (Catalog, Pages, Font, sometimes Page), which is
 * exactly what Wyoming's shape needs. An ObjStm nested inside another
 * ObjStm via `/Extends` is NOT walked — not observed in any file tested.
 *
 * ALSO FIXED HERE: the Catalog/Pages discovery no longer requires `/Type`
 * to be the first thing found after `<<` in a Catalog's own dictionary text
 * — the original `<<[^>]*\/Type\s*\/Catalog` regex broke the moment any
 * NESTED dict (e.g. `/MarkInfo<</Marked true>>`) appeared earlier in the
 * same object, because `[^>]*` cannot cross that inner `>>`. Wyoming's real
 * Catalog objects are exactly this shape (`/Lang(...)/MarkInfo<<...>>
 * /Metadata .../Pages .../Type/Catalog/ViewerPreferences<<...>>`, `/Type`
 * nowhere near the start). Discovery now finds `/Type/Catalog` (or
 * `/Type/Pages`) as plain text anywhere — direct or inside a decompressed
 * ObjStm — and locates its OWN object number by nearest preceding
 * `N 0 obj` marker, which works regardless of what else is in the dict.
 *
 * TWO FONT SHAPES, BOTH NEEDED (confirmed against real KRS statute PDFs,
 * fleet #2734):
 *   - Simple TrueType/Type1 with `/Encoding/WinAnsiEncoding` — the common
 *     case. WinAnsiEncoding is BY DESIGN identical to Windows code page 1252
 *     (that is what "WinAnsi" means), so the raw string-literal bytes decode
 *     directly via `TextDecoder('windows-1252')` with no per-glyph table of
 *     our own to get wrong.
 *   - Type0/CIDFontType2 with `/Encoding/Identity-H` — seen even inside an
 *     otherwise-simple statute, apparently whenever the PDF producer's text
 *     shaping fell back to a subset-embedded font for one run (KRS 532.025's
 *     closing sentence, which includes a curly apostrophe, was entirely in
 *     this font while the rest of the document used WinAnsi). Each character
 *     is a 2-byte CID with NO inherent meaning; the `/ToUnicode` CMap
 *     attached to the font is the only place the real Unicode value lives
 *     (`beginbfchar`/`beginbfrange` blocks). Skipping this font shape would
 *     have truncated or corrupted exactly the statutes that happen to use a
 *     special character — not a rare edge case, a silent one.
 *
 * Verified end-to-end against two real KRS statutes during this pack's
 * build: a single-page WinAnsi-only PDF (507.020, Murder) and a four-page PDF
 * mixing both font shapes (532.025, including the CID-encoded sentence
 * naming "Kimber's Law") — both reproduced the statute's true text exactly,
 * eyeballed against the rendered PDF.
 *
 * INDIRECT /Length (fleet #2743): extended for North Dakota's Century Code
 * chapter PDFs (ndlegis.gov/cencode/t*.pdf), whose content streams all write
 * `/Length` as an indirect reference ("/Length 3 0 R") rather than inlining
 * the literal integer the way every sampled KRS PDF did. The referenced
 * object is resolved (it is always a bare integer object, never itself a
 * stream) rather than falling back to scanning for the "endstream" keyword —
 * that fallback slices in the EOL bytes between the compressed data and the
 * keyword, which this repo's own Node zlib rejects as "trailing junk" even
 * though the compressed payload is intact (Workers' DecompressionStream may
 * be more lenient, but Node is what `prepush-tests.mjs` runs, so the bug was
 * real either way). Verified against ND Century Code chapter 12.1-16
 * (Homicide, t12-1c16.pdf) — every content stream in that 9-page PDF uses
 * the indirect form.
 *
 * THREE FIXES PORTED FROM mcps/guam-code's PACK-LOCAL FORK (fleet #2904,
 * folding in #2888's src/gu-pdf-extract.ts -- nothing about them was
 * actually Guam-specific, which is why they live here now instead of only
 * in that fork):
 *   1. inflate()'s two stream writes were fire-and-forget
 *      (void writer.write(...) / void writer.close()). A malformed deflate
 *      stream (real, not hypothetical -- seen across several Guam chapter
 *      PDFs) rejects that detached promise UNHANDLED, invisible to any
 *      try/catch wrapped around this function's caller and fatal to the
 *      whole Node process; in a Worker it is an unhandled rejection on a
 *      live request. Both writes now carry a no-op .catch() -- the real
 *      failure still surfaces through reader.read() below, which every
 *      caller already handles.
 *   2. A literal (parenthesized) string run was decoded by passing its raw
 *      windows-1252-decoded bytes through unchanged, which is correct for a
 *      WinAnsi font but wrong for a mapped1/cid font whose code space only
 *      means anything via its own /ToUnicode CMap -- the same lookup a hex
 *      string run already gets. Guam's PDF producer writes several of its
 *      non-WinAnsi subset-embedded fonts' text as literal strings rather
 *      than hex, which this extractor previously decoded as line-noise
 *      control characters instead of the real text.
 *   3. decompressedStream now retries a /FlateDecode stream with its tail
 *      trimmed 1-4 bytes before giving up. Several real PDFs declare a
 *      /Length a few bytes LONGER than the true deflate stream (confirmed
 *      on Guam's 21gc033.pdf object 2: /Length says 96, the deflate stream
 *      completes at byte 95, byte 96 is one stray trailing byte). Python's
 *      zlib tolerates trailing garbage by default; the Workers/Node
 *      DecompressionStream used here does not and throws "Trailing junk
 *      found after the end of the compressed stream" -- the true stream
 *      length is always <= the declared one in every sample seen, never
 *      longer, so trimming is safe.
 */

interface PdfExtractResult {
  /** Extracted text, pages joined with a blank line. Empty string if nothing
   *  could be read — check `warnings`, not just truthiness, before deciding
   *  that means the document has no text. */
  text: string;
  /** Number of leaf /Type/Page objects found via the Pages tree (the WHOLE
   *  document's page count, even when `pageRange` restricted extraction to
   *  a subset — see `extractedPages` for how many were actually read). */
  pages: number;
  /** Number of pages actually extracted into `text`. Equal to `pages`
   *  unless a `pageRange` option restricted the run. */
  extractedPages: number;
  /** Non-fatal problems found while extracting (unknown font, missing
   *  ToUnicode, etc). A non-empty array does not mean the text is wrong, but
   *  it means something was guessed rather than read. */
  warnings: string[];
}

interface PdfExtractOptions {
  /** Restrict extraction to a slice of the document's leaf pages, bounded by
   *  PAGE OBJECT NUMBERS rather than page indexes — built for sources (e.g.
   *  New Mexico's NMOneSource chapter PDFs, fleet #2884) whose per-section
   *  bookmarks in `extractPdfOutline`'s output give a /Dest page object
   *  directly, with no indexing step of their own needed. `fromPageObj` is
   *  resolved to its position in document order and extraction starts
   *  there; `toPageObj` (also resolved to its position) is the LAST page
   *  included — pass the object a FOLLOWING bookmark points to and extract
   *  up to (not including) it by resolving that page's own PRECEDING page
   *  instead, since this is page-granularity, not byte-granularity. If
   *  `fromPageObj` is not found among the document's pages, this option is
   *  ignored and the whole document is extracted (a safe fallback, not a
   *  silent wrong answer — a warning is added). */
  pageRange?: { fromPageObj: number; toPageObj?: number };

  /** Called right after a font's own /ToUnicode CMap is parsed (for either
   *  a Type0 font's CID map or a simple font's 1-byte map), before it is
   *  used to decode any text. Return a REPLACEMENT map to override specific
   *  codes, or return nothing (undefined) to use the parsed map unchanged.
   *  Built for mcps/guam-code (fleet #2888/#2904): one embedded symbol font
   *  per chapter PDF carries a /ToUnicode CMap that is itself wrong in the
   *  SOURCE file (confirmed by eye against the rendered PDF — not a general
   *  parsing defect this shared extractor could detect), so the fix is
   *  keyed by matching `fontDict` against something only that caller's PDFs
   *  produce (there, a font name) rather than built into this file. */
  fontCMapOverride?: (fontDict: string, map: Map<number, number>) => Map<number, number> | void;
}

interface PdfOutlineEntry {
  /** The bookmark's own text, verbatim (e.g. "30-2-1. Murder." or
   *  "ARTICLE 1  General Provisions" or "ANNOTATIONS"). */
  title: string;
  /** The PDF page OBJECT NUMBER this bookmark's /Dest (or /A GoTo action)
   *  points to, or null if neither was found on this node. Pass this
   *  straight into `extractPdfText`'s `pageRange` option — no index lookup
   *  needed on the caller's side. */
  pageObjNum: number | null;
  /** Nesting depth in the outline tree, root's children = 0. A section's
   *  own "ANNOTATIONS" child (depth = section's depth + 1) is how a caller
   *  distinguishes statutory text from case annotations that start on the
   *  same page — see mcps/new-mexico-code for the worked example. */
  depth: number;
}

type FontDecoder =
  | { kind: 'winansi' }
  | { kind: 'cid'; map: Map<number, number> }
  // Simple (1-byte-code) font decoded via its own /ToUnicode CMap rather than
  // WinAnsi — see fontDecoderFor's comment on North Dakota's subsetted fonts.
  | { kind: 'mapped1'; map: Map<number, number> };

/** Inflate one `/FlateDecode` stream using the platform's own zlib — no
 *  dependency, works identically in the Workers runtime and in Node (used by
 *  this repo's prepush tests), because both implement the standard
 *  CompressionStream/DecompressionStream API over the zlib wire format PDF's
 *  FlateDecode filter already uses. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  // Fire-and-forget on purpose: the actual decompression result/error comes
  // through reader.read() below, which every caller already wraps in a
  // try/catch. Without a .catch() here, a malformed deflate stream rejects
  // this DETACHED write/close promise UNHANDLED -- invisible to that
  // try/catch and fatal to the whole process (ported from
  // mcps/guam-code's gu-pdf-extract.ts FORK FIX 3/3, fleet #2888/#2904;
  // confirmed crashing scripts/bake-sections.mjs outright on real Guam
  // chapter PDFs). The no-op .catch() here does not hide a real failure --
  // it still surfaces through reader.read() for the caller to see.
  const writeDone = writer.write(bytes).catch(() => {});
  const closeDone = writer.close().catch(() => {});
  void writeDone;
  void closeDone;
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Undo PDF string-literal escaping — `\(`, `\)`, `\\`, `\n`/`\r`/`\t`,
 * octal `\ddd`, and a trailing backslash-newline line continuation — on a
 * windows-1252-decoded slice. Safe to run on the decoded string rather than
 * raw bytes: every character this function inspects or produces (backslash,
 * parens, digits, the letters n/r/t/b/f) is plain ASCII, which windows-1252
 * never remaps, so the 1-byte-per-character alignment this relies on holds
 * throughout.
 */
function unescapePdfLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[i + 1];
    if (next === undefined) continue;
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b' || next === 'f') { i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next >= '0' && next <= '7') {
      let oct = next, j = i + 1, k = 0;
      while (k < 2 && s[j + 1] >= '0' && s[j + 1] <= '7') { j++; oct += s[j]; k++; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j;
    } else if (next === '\n') { i++; }
    else if (next === '\r') { i++; if (s[i + 1] === '\n') i++; }
    else { out += next; i++; }
  }
  return out;
}

/**
 * Recover the ORIGINAL raw byte (0-255) that `new TextDecoder('latin1')`
 * produced a given codepoint for. This exists because the WHATWG Encoding
 * Standard makes "latin1" an ALIAS for "windows-1252", not true ISO-8859-1 —
 * every browser and Node's TextDecoder follow that spec. Bytes 0x00-0x7F and
 * 0xA0-0xFF decode as identity either way, but bytes 0x80-0x9F come back as
 * windows-1252's typographic symbols (0x99 -> U+2122 "™", 0x87 -> U+2021
 * "‡", …) instead of themselves — so `charCodeAt(i) & 0xff`, used everywhere
 * else in this file to recover a raw byte from a decoded string, silently
 * returns the WRONG byte for any of those 32 codepoints (U+2122 & 0xff is
 * 0x22, not the real 0x99).
 *
 * This only matters where the decoded character is being used as DATA (a
 * CID half-byte, a `mapped1` font's 1-byte code) rather than as the actual
 * text it renders (a true WinAnsi-encoded character, where the windows-1252
 * reading IS the correct glyph — see `fontDecoderFor`'s `'winansi'` kind,
 * which returns the decoded string unchanged on purpose and must NOT be
 * routed through this function). Found on mainland China's NPC/MOJ law PDFs
 * (cn-law, fleet #3136): Founder PDFGenerator (方正) writes CJK body text as
 * LITERAL strings under a Type0/Identity-H CID font, and roughly an eighth
 * of all 2-byte CIDs have at least one half-byte landing in 0x80-0x9F —
 * `合` (U+5408, CID 0x0F87) was coming back as `骨` (U+9AA8) because its low
 * byte 0x87 decoded to U+2021, and `U+2021 & 0xff` (0x21) is a different,
 * also-valid CID that happens to mean `骨` in the same font.
 */
function rawByteFromLatin1Char(code: number): number {
  const b = WIN1252_HIGH_TO_BYTE.get(code);
  return b !== undefined ? b : code & 0xff;
}
// windows-1252's 0x80-0x9F table (the WHATWG "windows-1252" index), inverted
// codepoint -> original byte. 0x81/0x8D/0x8F/0x90/0x9D are undefined in that
// table and decode as themselves (identity), so they need no entry here.
const WIN1252_HIGH_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

interface RawObject {
  dict: string;
  streamBytes: Uint8Array | null;
}

/** Extract readable text from a simple, non-encrypted, non-scanned PDF. */
async function extractPdfText(buf: ArrayBuffer, options?: PdfExtractOptions): Promise<PdfExtractResult> {
  const bytes = new Uint8Array(buf);
  // windows-1252 decode is total (every byte maps to exactly one UTF-16 code
  // unit) and length-preserving, so a match index found in `scan` is also a
  // valid BYTE offset into `bytes` — used below to slice stream data without
  // ever routing binary bytes through a lossy string round-trip.
  const scan = new TextDecoder('windows-1252').decode(bytes);
  const warnings: string[] = [];
  const objCache = new Map<number, RawObject | null>();

  // Byte offset of every DIRECT "N 0 obj" marker, sorted, for two uses: (1)
  // the object-lookup fallback stays regex-per-object the same as before;
  // (2) `objNumBefore` below answers "which object's text is this index
  // inside", which is how Catalog/Pages/ObjStm discovery works regardless of
  // what else that object's dictionary contains — see the file header.
  const objStarts: { index: number; num: number }[] = [];
  // Object number -> index right after its "N 0 obj" marker (i.e. where the
  // dictionary text begins), for every object found by the SAME forward
  // scan that builds objStarts — first occurrence wins, matching what a
  // one-shot `.exec` would find. This turns getDirectObject's lookup from
  // one full-document regex scan PER DISTINCT OBJECT NUMBER into one O(1)
  // map read: with a large page-tree walk (New Mexico's chapter PDFs run
  // 657-1,138+ pages, fleet #2884) the old per-call scan made even a
  // `pageRange`-restricted extraction cost nearly as much as extracting the
  // whole document, because walking the Pages tree alone touches every
  // page's object once regardless of how many are actually rendered —
  // measured 1,611ms for a 56-of-1,138-page extraction before this fix vs.
  // 1,699ms for the full document. The fallback regex scan below is kept
  // for any object this forward pass didn't catch (none observed, but
  // cheaper to keep than to prove impossible).
  const objEndByNum = new Map<number, number>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
      const num = parseInt(m[1], 10);
      if (!objEndByNum.has(num)) objEndByNum.set(num, m.index + m[0].length);
    }
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function getDirectObject(n: number): RawObject | null {
    if (objCache.has(n)) return objCache.get(n) ?? null;
    const fastEnd = objEndByNum.get(n);
    let objStart: number;
    if (fastEnd !== undefined) {
      objStart = fastEnd;
    } else {
      const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
      const m = re.exec(scan);
      if (!m) { objCache.set(n, null); return null; }
      objStart = m.index + m[0].length;
    }
    const endobjIdx = scan.indexOf('endobj', objStart);
    const streamIdx = scan.indexOf('stream', objStart);
    let dict: string;
    let streamBytes: Uint8Array | null = null;
    if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
      dict = scan.slice(objStart, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      // Matches EITHER "/Length 428" (literal) or "/Length 12 0 R"
      // (indirect) — group 2 is present only for the indirect form. Written
      // this way ON PURPOSE instead of the more obvious
      // `/\/Length\s+(\d+)(?!\s+0\s+R)/` for a literal: that negative
      // lookahead is a backtracking trap for any MULTI-DIGIT indirect
      // reference. On "/Length 12 0 R", a greedy `(\d+)` first tries "12",
      // the lookahead correctly forbids it (followed by " 0 R") — but the
      // engine then backtracks `\d+` down to "1", at which point the
      // lookahead is checked against "2 0 R", which does NOT start with
      // whitespace, so the forbidden pattern no longer matches and the
      // lookahead (wrongly) PASSES. The match silently becomes "1" instead
      // of failing, so this object's /Length reads as the literal integer 1
      // instead of as a reference to resolve — exactly the shape of North
      // Dakota's Century Code chapter PDFs (fleet #2743), whose indirect
      // Length refs are almost all two or more digits. An explicit optional
      // group has nothing to backtrack: `(\d+)` greedily keeps "12" and the
      // optional `(\s+0\s+R)?` either matches right after it or doesn't.
      const lenDictMatch = /\/Length\s+(\d+)(\s+0\s+R)?/.exec(dict);
      let dataEnd = -1;
      if (lenDictMatch) {
        if (!lenDictMatch[2]) {
          dataEnd = dataStart + parseInt(lenDictMatch[1], 10);
        } else {
          // Indirect reference. The referenced object is a bare integer
          // ("12 0 obj\n4541\nendobj"), never itself a stream, so resolving
          // it through the same getObject() is safe (no recursion risk back
          // onto object n). Falling back to scanning for the "endstream"
          // keyword instead — which the pre-fix code did unconditionally
          // here — slices in the EOL bytes PDF producers place between the
          // compressed data and that keyword, which Node's strict zlib
          // rejects as "trailing junk" even though the compressed payload
          // itself is intact.
          const lenObj = getObject(parseInt(lenDictMatch[1], 10));
          const lenVal = lenObj ? parseInt(lenObj.dict.trim(), 10) : NaN;
          if (Number.isFinite(lenVal) && lenVal >= 0) dataEnd = dataStart + lenVal;
        }
      }
      if (dataEnd === -1) dataEnd = scan.indexOf('endstream', dataStart);
      streamBytes = bytes.slice(dataStart, dataEnd);
    } else {
      dict = scan.slice(objStart, endobjIdx === -1 ? scan.length : endobjIdx);
    }
    const result = { dict, streamBytes };
    objCache.set(n, result);
    return result;
  }

  // Compressed objects (inside a /Type/ObjStm) — object number -> dict text.
  // Populated below, before any Catalog/Pages/Font lookup runs, because a
  // compressed Catalog or Pages root (Wyoming's shape) must resolve exactly
  // like a direct one from that point on. Never holds a stream: the PDF spec
  // forbids a compressed object from containing one.
  const compressedObjects = new Map<number, string>();
  {
    const objStmNums: number[] = [];
    const re = /\/Type\s*\/ObjStm\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      const n = objNumBefore(m.index);
      if (n !== null) objStmNums.push(n);
    }
    for (const n of objStmNums) {
      const obj = getDirectObject(n);
      if (!obj || !obj.streamBytes) { warnings.push(`ObjStm ${n} has no stream data`); continue; }
      let data: Uint8Array;
      if (/\/Filter\s*\/FlateDecode/.test(obj.dict)) {
        try {
          data = await inflate(obj.streamBytes);
        } catch (e) {
          warnings.push(`inflate failed for ObjStm ${n}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      } else {
        data = obj.streamBytes;
      }
      const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
      const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
      if (!nMatch || !firstMatch) { warnings.push(`ObjStm ${n} missing /N or /First`); continue; }
      const count = parseInt(nMatch[1], 10);
      const first = parseInt(firstMatch[1], 10);
      const header = new TextDecoder('latin1').decode(data.slice(0, first)).trim().split(/\s+/).map((x) => parseInt(x, 10));
      const entries: { num: number; offset: number }[] = [];
      for (let i = 0; i + 1 < header.length && entries.length < count; i += 2) {
        entries.push({ num: header[i], offset: header[i + 1] });
      }
      const body = new TextDecoder('windows-1252').decode(data);
      for (let i = 0; i < entries.length; i++) {
        const start = first + entries[i].offset;
        const end = i + 1 < entries.length ? first + entries[i + 1].offset : data.length;
        if (start < 0 || end > data.length || start > end) {
          warnings.push(`ObjStm ${n} entry ${entries[i].num} has an out-of-range offset, skipped`);
          continue;
        }
        compressedObjects.set(entries[i].num, body.slice(start, end));
      }
    }
  }

  // The lookup every caller below actually uses: direct object text, falling
  // back to a compressed one. Never both — a given object number is either
  // found literally in the file or inside exactly one ObjStm, not both.
  function getObject(n: number): RawObject | null {
    const direct = getDirectObject(n);
    if (direct) return direct;
    const compressed = compressedObjects.get(n);
    if (compressed !== undefined) return { dict: compressed, streamBytes: null };
    return null;
  }

  async function decompressedStream(n: number): Promise<Uint8Array | null> {
    const obj = getObject(n);
    if (!obj || !obj.streamBytes) return null;
    if (/\/FlateDecode/.test(obj.dict)) {
      // Ported from mcps/guam-code's gu-pdf-extract.ts FORK FIX (fleet
      // #2888/#2904): several real PDFs store a /Length a small number of
      // bytes LONGER than the TRUE deflate stream length (confirmed on
      // Guam's 21gc033.pdf object 2: /Length says 96, the deflate stream is
      // complete at byte 95, and the 96th byte is one stray trailing byte).
      // Python's zlib tolerates trailing garbage by default; the
      // Workers/Node DecompressionStream used here does not and throws
      // "Trailing junk found after the end of the compressed stream".
      // Rather than fail the whole page, retry with the slice trimmed one
      // byte shorter a few times -- the true stream length is always <= the
      // declared one in every sample seen, never longer.
      for (let trim = 0; trim <= 4 && trim < obj.streamBytes.length; trim++) {
        try {
          return await inflate(trim === 0 ? obj.streamBytes : obj.streamBytes.subarray(0, obj.streamBytes.length - trim));
        } catch (e) {
          if (trim === 4) {
            warnings.push(`inflate failed for object ${n} even after trimming trailing bytes: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }
        }
      }
      return null;
    }
    return obj.streamBytes;
  }

  // Catalog -> Pages -> Kids, walked in document order. Falls back to the
  // first /Type/Pages object if no /Type/Catalog is found. Both searches
  // look for the TYPE MARKER as plain text first (direct text, or inside any
  // decompressed ObjStm body) and then find which object that text belongs
  // to — see the file header for why this replaced a single greedy regex.
  let pagesRef: number | null = null;
  function findObjWithType(typeName: string): number | null {
    const directIdx = scan.search(new RegExp(`/Type\\s*/${typeName}\\b`));
    if (directIdx !== -1) {
      const n = objNumBefore(directIdx);
      if (n !== null) return n;
    }
    const typeRe = new RegExp(`/Type\\s*/${typeName}\\b`);
    for (const [num, text] of compressedObjects) {
      if (typeRe.test(text)) return num;
    }
    return null;
  }
  const catNum = findObjWithType('Catalog');
  if (catNum !== null) {
    const catObj = getObject(catNum);
    const pm = catObj ? /\/Pages\s+(\d+)\s+0\s+R/.exec(catObj.dict) : null;
    if (pm) pagesRef = parseInt(pm[1], 10);
  }
  if (pagesRef === null) {
    pagesRef = findObjWithType('Pages');
  }

  const leafPages: number[] = [];
  function walkPages(n: number, depth: number): void {
    if (depth > 12) { warnings.push('Pages tree exceeded depth 12, stopped walking'); return; }
    const obj = getObject(n);
    if (!obj) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(obj.dict)) { leafPages.push(n); return; }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
    if (!kidsMatch) return;
    for (const km of kidsMatch[1].matchAll(/(\d+)\s+0\s+R/g)) walkPages(parseInt(km[1], 10), depth + 1);
  }
  if (pagesRef !== null) walkPages(pagesRef, 0);
  else warnings.push('no /Type/Catalog or /Type/Pages object found');

  const totalPages = leafPages.length;
  let pagesToExtract = leafPages;
  if (options?.pageRange) {
    const { fromPageObj, toPageObj } = options.pageRange;
    const fromIdx = leafPages.indexOf(fromPageObj);
    if (fromIdx === -1) {
      warnings.push(
        `pageRange.fromPageObj ${fromPageObj} is not a leaf page in this document — extracting the whole document instead of the requested range.`,
      );
    } else {
      let toIdx = leafPages.length - 1;
      if (toPageObj !== undefined) {
        const foundToIdx = leafPages.indexOf(toPageObj);
        // toPageObj not found, or found strictly BEFORE fromIdx (a bad or
        // out-of-order bookmark), falls back to end-of-document rather than
        // producing a negative-length slice. Equal to fromIdx is normal and
        // valid — a section whose first bookmarked child (e.g. its own
        // "ANNOTATIONS") starts on the SAME page is a single-page range,
        // not an error.
        if (foundToIdx >= fromIdx) toIdx = foundToIdx;
        else if (foundToIdx !== -1) {
          warnings.push(
            `pageRange.toPageObj ${toPageObj} resolves to a page before fromPageObj ${fromPageObj} — extracting through end of document instead.`,
          );
        } else {
          warnings.push(`pageRange.toPageObj ${toPageObj} is not a leaf page in this document — extracting through end of document instead.`);
        }
      }
      pagesToExtract = leafPages.slice(fromIdx, toIdx + 1);
    }
  }

  /** Parse a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks into
   *  a code -> Unicode-codepoint map. Shared between Type0's 2-byte CIDs and
   *  a simple font's 1-byte codes — the CMap text format is identical either
   *  way; only how the caller SLICES its hex string differs (see decodeRun). */
  async function parseToUnicodeCMap(cmapObjNum: number): Promise<Map<number, number>> {
    const cmapBytes = await decompressedStream(cmapObjNum);
    const cmapText = cmapBytes ? new TextDecoder('latin1').decode(cmapBytes) : '';
    const map = new Map<number, number>();
    for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1], 16), parseInt(pair[2].slice(0, 4), 16));
      }
    }
    for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(triple[1], 16), hi = parseInt(triple[2], 16), base = parseInt(triple[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base + (c - lo));
      }
    }
    return map;
  }

  async function fontDecoderFor(fontObjNum: number): Promise<FontDecoder> {
    const obj = getObject(fontObjNum);
    if (!obj) return { kind: 'winansi' };
    if (/\/Subtype\s*\/Type0\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (!tuMatch) {
        warnings.push(`Type0 font object ${fontObjNum} has no /ToUnicode; its text will show as U+FFFD`);
        return { kind: 'cid', map: new Map() };
      }
      const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
      return { kind: 'cid', map: options?.fontCMapOverride?.(obj.dict, map) ?? map };
    }
    // Simple font. Every KRS sample used /WinAnsiEncoding, which decodes
    // directly as windows-1252 bytes below — unchanged. North Dakota's
    // Century Code PDFs (fleet #2743) use simple TrueType fonts that declare
    // NO /Encoding at all: their embedded subsets number glyphs 0, 1, 2... in
    // whatever order the subsetter emitted them, with no relationship to any
    // standard code page — reading code 0x01 as the WinAnsi byte 0x01 (a
    // control character) produces blank/garbled output, not a wrong letter.
    // Those fonts DO carry a /ToUnicode CMap (the same mechanism Type0 fonts
    // use above, just keyed by a 1-byte code instead of a 2-byte CID), which
    // is the only place the real character is recorded — use it whenever the
    // font isn't declared WinAnsi rather than guessing.
    if (!/\/Encoding\s*\/WinAnsiEncoding\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (tuMatch) {
        const parsedMap = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
        const map = options?.fontCMapOverride?.(obj.dict, parsedMap) ?? parsedMap;
        if (map.size) return { kind: 'mapped1', map };
      }
      warnings.push(`font object ${fontObjNum} has a non-WinAnsi simple encoding and no usable /ToUnicode; decoded as WinAnsi anyway`);
    }
    return { kind: 'winansi' };
  }

  const TOKEN_RE =
    /\/(\S+)\s+[\d.]+\s+Tf|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^()])*)\)\s*Tj|1\s+0\s+0\s+1\s+[\d.-]+\s+([\d.-]+)\s+Tm/g;
  // Third alternative (bare number) added for Indonesia's JDIH statute PDFs
  // (jdih.setneg.go.id, fleet #3121): that producer never writes a literal
  // space byte between words — "REPUBLIK INDONESIA" is encoded as one TJ run
  // `[(…K)-269.0(I)…]`, where the -269 IS the word gap, not kerning. Every
  // sampled font's intra-word kerning tops out around +-30 (observed: 2.0,
  // -2.9, -14.0, -24.0); the real word gaps in the same document measured
  // -269, -286, -290, -692, -1396, -1400 — two clusters with nothing between
  // them, so a flat threshold cleanly separates "kerning" from "space" without
  // needing the current font size (the TJ number is already in thousandths of
  // text space, before the Tfs/Th scale-up ISO 32000 §9.4.3 applies).
  const TJ_PIECE_RE = /\(((?:\\.|[^()])*)\)|<([0-9A-Fa-f\s]*)>|(-?\d+(?:\.\d+)?)/g;
  const TJ_WORD_GAP_THRESHOLD = -100;

  function decodeRun(dec: FontDecoder, literal: string | undefined, hex: string | undefined): string {
    if (literal !== undefined) {
      const unescaped = unescapePdfLiteral(literal);
      // Ported from mcps/guam-code's gu-pdf-extract.ts FORK FIX 1/2 (fleet
      // #2888/#2904): a WinAnsi run's literal-string bytes ARE already the
      // correct windows-1252 text (unchanged below) -- but a non-WinAnsi
      // simple font ('mapped1') or a Type0 font ('cid') can ALSO show up as
      // a literal string rather than hex. Guam's PDF producer writes
      // several of its subset-embedded fonts' text this way; passing the
      // raw byte through unchanged (the old behavior here) skips that
      // font's /ToUnicode map entirely and produces line-noise control
      // characters instead of the real character -- route it through the
      // SAME decoder a hex run below already uses.
      //
      // 'cid' (Type0/Identity-H) is a 2-BYTE code space, same as the hex-
      // string path below -- a literal string's BYTES must be paired up
      // big-endian into one CID per pair, not looked up one byte at a time.
      // Found on mainland China's NPC/MOJ law PDFs (cn-law, fleet #3136):
      // Founder PDFGenerator (方正), the producer behind flk.npc.gov.cn's
      // and xzfg.moj.gov.cn's statute PDFs, writes most CJK body text as
      // literal strings like `(\000I)Tj` under a Type0 CID font rather than
      // as hex strings -- the shape this branch was missing. Decoding each
      // byte separately (the pre-fix behavior) looks up CID 0x00 and CID
      // 0x49 independently instead of the real CID 0x0049, so virtually
      // every CJK glyph misses its ToUnicode entry and comes back as
      // U+FFFD -- silently: no warning, a non-empty result, just wrong.
      // Measured against 中华人民共和国个人信息保护法 (PIPL)'s official
      // gazette PDF: 18,929 of 19,858 extracted characters were U+FFFD
      // before this fix (95%), 0 after, and `第十三条` (Article 13) and its
      // neighbors read correctly. If the literal string has an odd byte
      // count (shouldn't happen for a well-formed 2-byte-code run), the
      // trailing lone byte is silently dropped rather than guessed at.
      if (dec.kind === 'winansi') return unescaped;
      if (dec.kind === 'cid') {
        let out = '';
        for (let i = 0; i + 2 <= unescaped.length; i += 2) {
          const code =
            (rawByteFromLatin1Char(unescaped.charCodeAt(i)) << 8) | rawByteFromLatin1Char(unescaped.charCodeAt(i + 1));
          out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
        }
        return out;
      }
      let out = '';
      for (let i = 0; i < unescaped.length; i++) {
        const code = rawByteFromLatin1Char(unescaped.charCodeAt(i));
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    const cleaned = (hex ?? '').replace(/\s+/g, '');
    let out = '';
    if (dec.kind === 'mapped1') {
      // 1-byte code per glyph (a simple font's code space), unlike Type0's
      // 2-byte CIDs below — see fontDecoderFor.
      for (let i = 0; i + 2 <= cleaned.length; i += 2) {
        const code = parseInt(cleaned.slice(i, i + 2), 16);
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    for (let i = 0; i + 4 <= cleaned.length; i += 4) {
      const cid = parseInt(cleaned.slice(i, i + 4), 16);
      if (dec.kind === 'cid') out += String.fromCodePoint(dec.map.get(cid) ?? 0xfffd);
      else out += String.fromCharCode(cid & 0xff);
    }
    return out;
  }

  const pageTexts: string[] = [];
  for (const pn of pagesToExtract) {
    const page = getObject(pn);
    if (!page) continue;

    let resourcesDict = page.dict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
    if (resRef) {
      const ro = getObject(parseInt(resRef[1], 10));
      if (ro) resourcesDict = ro.dict;
    }
    // /Font is usually inline in Resources, but North Dakota's Century Code
    // PDFs (fleet #2743) write it as an indirect reference ("/Font 18 0 R")
    // to a separate dict object — resolve that one hop before giving up.
    let fontDictBody: string | null = null;
    const inlineFontMatch = /\/Font\s*<<([^>]*)>>/.exec(resourcesDict);
    if (inlineFontMatch) {
      fontDictBody = inlineFontMatch[1];
    } else {
      const fontRefMatch = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);
      if (fontRefMatch) {
        const fontObj = getObject(parseInt(fontRefMatch[1], 10));
        if (fontObj) fontDictBody = fontObj.dict;
      }
    }
    const fontMap = new Map<string, FontDecoder>();
    if (fontDictBody) {
      for (const fm of fontDictBody.matchAll(/\/(\S+?)\s+(\d+)\s+0\s+R/g)) {
        fontMap.set(fm[1], await fontDecoderFor(parseInt(fm[2], 10)));
      }
    }

    const contentsMatch = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(page.dict);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10))
      : [];
    let raw = '';
    for (const cr of contentRefs) {
      const dec = await decompressedStream(cr);
      if (dec) raw += new TextDecoder('latin1').decode(dec) + '\n';
    }

    let out = '';
    let currentFont: string | null = null;
    let lastY: number | null = null;
    for (const m of raw.matchAll(TOKEN_RE)) {
      if (m[1] !== undefined) { currentFont = m[1]; continue; }
      if (m[5] !== undefined) {
        const y = parseFloat(m[5]);
        if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
        lastY = y;
        continue;
      }
      const dec = (currentFont && fontMap.get(currentFont)) || { kind: 'winansi' as const };
      if (m[2] !== undefined) {
        for (const piece of m[2].matchAll(TJ_PIECE_RE)) {
          if (piece[3] !== undefined) {
            // A big negative adjustment between two TJ pieces with no
            // literal space byte at all — see TJ_PIECE_RE's comment above.
            // Skip if `out` already ends in whitespace so a producer that
            // DOES write literal spaces never gets a doubled one.
            if (parseFloat(piece[3]) <= TJ_WORD_GAP_THRESHOLD && !/\s$/.test(out)) out += ' ';
            continue;
          }
          out += decodeRun(dec, piece[1], piece[2]);
        }
      } else if (m[3] !== undefined) {
        out += decodeRun(dec, undefined, m[3]);
      } else if (m[4] !== undefined) {
        out += decodeRun(dec, m[4], undefined);
      }
    }
    pageTexts.push(out.trim());
  }

  return { text: pageTexts.join('\n\n'), pages: totalPages, extractedPages: pagesToExtract.length, warnings };
}

/**
 * Parse a PDF's outline (bookmark) tree into a flat, document-order list of
 * {title, pageObjNum, depth} entries — WITHOUT decompressing any content
 * stream, so this is orders of magnitude cheaper than `extractPdfText` and
 * safe to run just to decide WHERE to extract from. Built for
 * mcps/new-mexico-code (fleet #2884): NMOneSource publishes each NMSA 1978
 * CHAPTER as one PDF (657-1,138+ pages observed) but bookmarks every
 * ARTICLE heading (depth 0), every SECTION citation (depth 1, e.g.
 * "30-2-1. Murder."), and that section's own "ANNOTATIONS" sub-heading
 * (depth 2) — giving a caller everything needed to resolve a bare citation
 * straight to a page RANGE via `extractPdfText`'s `pageRange` option,
 * without ever extracting pages the caller didn't ask for.
 *
 * Assumes outline objects are DIRECT (never compressed into an /ObjStm) —
 * true of every source sampled while building this. A PDF whose outline IS
 * compressed, or that has no /Outlines at all, returns an empty array
 * rather than guessing; check for that before concluding a citation isn't
 * bookmarked.
 */
function extractPdfOutline(buf: ArrayBuffer): PdfOutlineEntry[] {
  const bytes = new Uint8Array(buf);
  const scan = new TextDecoder('windows-1252').decode(bytes);

  const objStarts: { index: number; num: number }[] = [];
  // See extractPdfText's identical map for why: one O(1) lookup per object
  // instead of one full-document regex scan — an outline tree with ~1,400
  // bookmarks (New Mexico's larger chapters) made this function itself the
  // bottleneck before this fix (measured 2.8s on Chapter 30's 5.8MB PDF).
  const objEndByNum = new Map<number, number>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
      const num = parseInt(m[1], 10);
      if (!objEndByNum.has(num)) objEndByNum.set(num, m.index + m[0].length);
    }
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  const dictCache = new Map<number, string | null>();
  function dictOf(n: number): string | null {
    if (dictCache.has(n)) return dictCache.get(n) ?? null;
    let start: number;
    const fastEnd = objEndByNum.get(n);
    if (fastEnd !== undefined) {
      start = fastEnd;
    } else {
      const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
      const m = re.exec(scan);
      if (!m) { dictCache.set(n, null); return null; }
      start = m.index + m[0].length;
    }
    const end = scan.indexOf('endobj', start);
    const dict = end === -1 ? scan.slice(start, Math.min(scan.length, start + 4000)) : scan.slice(start, end);
    dictCache.set(n, dict);
    return dict;
  }

  // Prefer the Catalog's own /Outlines reference; fall back to the first
  // direct /Type/Outlines object found anywhere (same "search for the type
  // marker as plain text" approach extractPdfText uses for Catalog/Pages).
  let outlinesRoot: number | null = null;
  const catIdx = scan.search(/\/Type\s*\/Catalog\b/);
  if (catIdx !== -1) {
    const catNum = objNumBefore(catIdx);
    const catDict = catNum !== null ? dictOf(catNum) : null;
    const om = catDict ? /\/Outlines\s+(\d+)\s+0\s+R/.exec(catDict) : null;
    if (om) outlinesRoot = parseInt(om[1], 10);
  }
  if (outlinesRoot === null) {
    const outIdx = scan.search(/\/Type\s*\/Outlines\b/);
    if (outIdx !== -1) outlinesRoot = objNumBefore(outIdx);
  }
  if (outlinesRoot === null) return [];

  function pageObjOf(dict: string): number | null {
    const destMatch = /\/Dest\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (destMatch) return parseInt(destMatch[1], 10);
    const actionMatch = /\/A\s*<<[^>]*\/D\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (actionMatch) return parseInt(actionMatch[1], 10);
    return null;
  }

  const entries: PdfOutlineEntry[] = [];
  const seen = new Set<number>();
  function walk(n: number, depth: number): void {
    if (depth > 20 || seen.has(n)) return; // guards a malformed/cyclic tree
    seen.add(n);
    const dict = dictOf(n);
    if (!dict) return;
    const titleMatch = /\/Title\s*\(((?:\\.|[^()])*)\)/.exec(dict);
    if (titleMatch) {
      entries.push({ title: unescapePdfLiteral(titleMatch[1]).replace(/\s+/g, ' ').trim(), pageObjNum: pageObjOf(dict), depth });
    }
    const firstMatch = /\/First\s+(\d+)\s+0\s+R/.exec(dict);
    if (firstMatch) walk(parseInt(firstMatch[1], 10), titleMatch ? depth + 1 : depth);
    const nextMatch = /\/Next\s+(\d+)\s+0\s+R/.exec(dict);
    if (nextMatch) walk(parseInt(nextMatch[1], 10), depth);
  }
  const rootDict = dictOf(outlinesRoot);
  const rootFirst = rootDict ? /\/First\s+(\d+)\s+0\s+R/.exec(rootDict) : null;
  if (rootFirst) walk(parseInt(rootFirst[1], 10), 0);

  return entries;
}


/**
 * SSRF guard for fetching user- or registry-supplied URLs.
 *
 * Workers that fetch URLs an attacker can influence (submission test_endpoint,
 * scraper introspect remote_url, gateway generate_llms_txt) must run the target
 * through this first. Cloudflare Workers don't route to RFC-1918 by default, but
 * the worker is still an open-fetch primitive against internal CF services,
 * cloud metadata endpoints, and tenant-private origins reachable from egress —
 * so we enforce https-only and block private / loopback / link-local / metadata
 * hosts before the fetch.
 */

// Hostnames that must never be fetched, regardless of resolution.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

/** Parse a dotted-quad IPv4 string into its 4 octets, or null if not IPv4. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Expand an IPv6 literal to its 8 numeric groups, or null if it isn't one.
 *
 * Needed because you cannot pattern-match IPv6 as text: `::ffff:127.0.0.1`,
 * `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:0001` are the same address, and
 * WHATWG URL rewrites whichever you typed into the compressed hex form. The
 * guard has to compare numbers, not strings.
 */
function expandIpv6(host: string): number[] | null {
  let h = host.split('%')[0]; // drop any zone id (fe80::1%eth0)
  if (!h.includes(':')) return null;

  // A trailing dotted quad (::ffff:127.0.0.1) is legal IPv6 text. URL normally
  // normalizes it away, but accept it so callers passing a raw hostname — not
  // one that round-tripped through URL — get the same verdict.
  const lastColon = h.lastIndexOf(':');
  const tail = h.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = parseIpv4(tail);
    if (!o) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/**
 * The IPv4 address embedded in an IPv6 literal, for the three prefixes that
 * carry one, or null. Each is a way to name an IPv4 destination in IPv6 syntax,
 * so each is a way to smuggle 127.0.0.1 or 169.254.169.254 past a v4-only check.
 */
function embeddedIpv4(g: number[]): [number, number, number, number] | null {
  const low32 = (): [number, number, number, number] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  const zeroTo5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (zeroTo5 && g[5] === 0xffff) return low32(); // ::ffff:0:0/96  IPv4-mapped
  if (zeroTo5 && g[5] === 0) return low32();      // ::/96          IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return low32(); // 64:ff9b::/96 + /48  NAT64
  return null;
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 169 && b === 254) return true;           // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                         // multicast / reserved
  return false;
}

/** True if the URL is safe to fetch (https + public host). */
function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https only — blocks http://, file://, gopher://, ftp://, data:, etc.
  if (u.protocol !== 'https:') return false;

  let host = u.hostname.toLowerCase();
  if (!host) return false;
  // URL.hostname returns IPv6 literals bracketed (e.g. "[fc00::1]"); strip them
  // so the prefix/equality checks below see the bare address.
  const isV6 = host.startsWith('[') && host.endsWith(']');
  if (isV6) host = host.slice(1, -1);

  if (BLOCKED_HOSTNAMES.has(host)) return false;
  // Any *.localhost / *.internal / *.local
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;

  // IPv6 literals: block loopback (::1), unspecified (::), unique-local (fc00::/7),
  // and link-local (fe80::/10).
  if (isV6 || host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (host.startsWith('fc') || host.startsWith('fd')) return false; // unique-local
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return false; // link-local

    // An IPv6 literal can carry an IPv4 destination inside it (IPv4-mapped,
    // IPv4-compatible, NAT64). Decode it and apply the same v4 rules, so
    // [::ffff:169.254.169.254] is blocked exactly like 169.254.169.254.
    //
    // This previously matched on a dotted quad in the tail — which URL never
    // produces, since it serializes IPv6 in hex — so the check was dead code
    // and mapped loopback/metadata addresses passed (2026-08-01 review).
    const groups = expandIpv6(host);
    if (groups) {
      const v4 = embeddedIpv4(groups);
      if (v4 && isPrivateIpv4(v4)) return false;
    }
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) return !isPrivateIpv4(ipv4);

  return true;
}

/** Throws an Error with a stable code-ish message if the URL isn't safe to fetch. */
function assertPublicHttpUrl(raw: string): URL {
  if (!isPublicHttpUrl(raw)) {
    throw new Error(`blocked_url: refusing to fetch non-public or non-https URL`);
  }
  return new URL(raw);
}

// Path, query, fragment, userinfo, backslash, whitespace. Every one of these
// makes `https://${host}/api/...` mean something other than it reads as.
const HOSTNAME_FORBIDDEN = /[/?#@\\\s]/;

/**
 * Validate a caller-supplied HOSTNAME that a pack will interpolate into a URL
 * (`https://${host}/api/...`). Returns the normalized `hostname[:port]`.
 *
 * Use this instead of a hand-rolled strip-and-hope (fleet #214). Pinning the
 * scheme to https:// looks like protection and is not — the host segment is
 * still attacker-controlled, and two shapes walk straight past a protocol pin:
 *
 *   QUERY TRUNCATION  host = "evil.example/collect?x="
 *     `https://evil.example/collect?x=/api/v1/timelines/tag/x` — the API path
 *     the pack appended is now part of the QUERY STRING of an attacker's URL.
 *     The pack believes it called a Mastodon endpoint. It called whatever it
 *     was pointed at, and hands the body back to the caller.
 *
 *   USERINFO CONFUSION  host = "mastodon.social@evil.example"
 *     Everything before `@` is credentials, so this fetches evil.example while
 *     reading as legitimate in a log line or a code review.
 *
 * Stripping a leading `https://` and trailing slashes — the common shape in
 * these packs — defeats neither, and a `.replace(/\/.*$/, '')` that removes a
 * path still leaves `?`, `#` and `@` untouched (verified live against three
 * packs on 2026-08-10 before this landed).
 *
 * Rejects rather than sanitizes. A host with a path in it is not a typo we
 * should guess at, and silently truncating to `evil.example` would still fetch
 * a host the caller never legitimately meant.
 *
 * @param raw   the caller-supplied value; a leading scheme and trailing
 *              slashes are tolerated because callers habitually paste URLs.
 * @param label argument name, so the error tells the agent what to fix.
 */
function assertPublicHostname(raw: unknown, label = 'host'): string {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) throw new Error(`blocked_host: ${label} is empty`);

  const stripped = input.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!stripped || HOSTNAME_FORBIDDEN.test(stripped)) {
    throw new Error(
      `blocked_host: ${label} "${input}" must be a bare hostname — no path, query string, fragment, "@" or whitespace.`,
    );
  }

  let u: URL;
  try {
    u = new URL(`https://${stripped}/`);
  } catch {
    throw new Error(`blocked_host: ${label} "${input}" is not a valid hostname.`);
  }

  // Reuse the vetted private/loopback/link-local/IPv6-mapped logic rather than
  // re-deriving it per pack — the packs' inlined copies each missed something
  // different (CGNAT 100.64/10 in one, IPv4-mapped IPv6 in another).
  //
  // Runs BEFORE the parse-equality check below so the caller gets the
  // informative reason. [::ffff:169.254.169.254] canonicalizes to
  // [::ffff:a9fe:a9fe], which trips equality too — "non-public host" is the
  // answer worth giving.
  if (!isPublicHttpUrl(u.toString())) {
    throw new Error(`blocked_host: refusing to fetch non-public host "${input}"`);
  }

  // Last-resort catch-all: the parser must agree with what we were handed.
  // Anything that survives the character check but still reparses into a
  // DIFFERENT host is the class of trick this function exists to stop, so treat
  // disagreement as hostile rather than trying to enumerate the tricks.
  //
  // Two legitimate transformations are exempt, or this would reject real hosts:
  //   - IDN punycoding (münchen.de → xn--mnchen-3ya.de). Every attack shape
  //     above is ASCII, so skipping non-ASCII costs the guard nothing.
  //   - IPv6 canonicalization ([2001:0db8::1] → [2001:db8::1]). The address is
  //     already fully validated above, where it matters.
  const asciiOnly = !/[^\x20-\x7E]/.test(stripped);
  const isV6Literal = stripped.startsWith('[');
  const expected = stripped.toLowerCase().replace(/:\d+$/, '');
  if (asciiOnly && !isV6Literal && u.hostname !== expected) {
    throw new Error(
      `blocked_host: ${label} "${input}" did not parse as the hostname it appears to be (got "${u.hostname}").`,
    );
  }

  return u.host;
}

/**
 * Validate a single DNS LABEL that a pack interpolates before a FIXED suffix
 * (`https://${sub}.freshdesk.com`, `https://${region}.api.riotgames.com`).
 *
 * A different problem from assertPublicHostname, and stricter: because the
 * suffix is fixed, the only escape is a character that ends the label early, so
 * a positive charset is both sufficient and simpler than parsing. Do NOT swap
 * these two — validating a label with assertPublicHostname would accept dots
 * and a port, and validating a hostname with this would reject every real one.
 *
 * These packs send credentials, so a label that escapes the suffix is a key
 * leak, not just an SSRF.
 */
function assertHostLabel(raw: unknown, label = 'subdomain'): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(v)) {
    throw new Error(
      `blocked_host: ${label} "${v}" must be a bare DNS label — letters, digits and hyphens only (e.g. "mycompany").`,
    );
  }
  return v.toLowerCase();
}

/**
 * Fetch a URL with SSRF protection that ALSO covers redirects.
 *
 * A plain `fetch(url)` uses `redirect: 'follow'`, which silently defeats an
 * `isPublicHttpUrl()` pre-check: a public URL can return a 3xx to a private /
 * loopback / metadata host and the runtime follows it without re-validation
 * (and a hostname can resolve to a private address regardless). safeFetch
 * validates the initial URL AND every redirect hop — it fetches with
 * `redirect: 'manual'`, re-runs isPublicHttpUrl on each `Location`, and
 * refuses to follow a hop to a non-public / non-https target.
 *
 * Throws `blocked_url: …` if the initial URL or any hop is unsafe, or if the
 * redirect budget is exceeded. Callers already wrap probes in try/catch, so a
 * blocked redirect flows through their normal failure path (submission stays
 * pending, monitor records a down check, introspection error, etc.).
 *
 * Method + body from `init` are preserved across hops (every hop is validated,
 * so re-issuing the request to a vetted public host is safe); any caller-set
 * `redirect` is overridden to 'manual'.
 *
 * Credential headers are DROPPED on a cross-origin hop. Built-in fetch does
 * this for you; a manual redirect loop has to do it by hand, and skipping it
 * turns "public host redirects us somewhere" into "public host harvests our
 * Authorization header" — the initial host chooses the Location, so it chooses
 * where the credential goes.
 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'];

/** Strip credential headers from `init`, used when a redirect crosses origins. */
function stripCredentials(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const h = new Headers(init.headers as HeadersInit);
  let removed = false;
  for (const name of CREDENTIAL_HEADERS) {
    if (h.has(name)) {
      h.delete(name);
      removed = true;
    }
  }
  return removed ? { ...init, headers: h } : init;
}

async function safeFetch(
  raw: string,
  init?: RequestInit,
  opts?: { maxRedirects?: number } & SafeFetchExtendedOptions,
): Promise<Response> {
  // Opt-in hardening (fleet #2729/#2847). Only a caller that passes one of the
  // extended options takes the extended path; every existing caller passes at
  // most `maxRedirects` and runs the original loop below, unchanged.
  if (opts && usesExtendedOptions(opts)) return safeFetchExtended(raw, init, opts);
  const maxRedirects = opts?.maxRedirects ?? 3;
  const origin = assertPublicHttpUrl(raw).origin;
  let target = assertPublicHttpUrl(raw).toString();
  let reqInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...reqInit, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error(`blocked_url: too many redirects (>${maxRedirects})`);
    let next: string;
    try {
      // Resolve relative Location against the current target before validating.
      next = new URL(location, target).toString();
    } catch {
      throw new Error('blocked_url: invalid redirect location');
    }
    if (!isPublicHttpUrl(next)) throw new Error('blocked_url: redirect to non-public URL');
    if (new URL(next).origin !== origin) reqInit = stripCredentials(reqInit);
    target = next;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPT-IN HARDENING for fetching an arbitrary caller-named URL (fleet #2729,
// docs/verbatim-fetch-design.md §3; built in #2847).
//
// Everything below is reached ONLY when a caller passes one of these options to
// safeFetch. The https-only, any-port, lexical-only behaviour above is a
// standing invariant for every existing caller and is not changed: a call with
// no options, or with `maxRedirects` alone, never enters this code.
//
// What it adds, each enforced on the initial URL AND on every redirect hop:
//   allowHttp       accept http:// as well as https:// (https→http hops too;
//                   the caller sees them through onHop and says so)
//   allowedPorts    refuse any explicit port not in the list
//   refuseUserinfo  refuse `user:pass@host` — we never send credentials
//   resolvePublic   resolve the host over DNS-over-HTTPS (A + AAAA) and refuse
//                   if ANY answer is non-public: `10.0.0.1.nip.io` passes every
//                   lexical check above and still points at private space
//   denyHost        caller-supplied denylist (our own hosts, abuse complaints)
//   onHop           observe every response in the chain (status + Location)
//
// Refusals throw BlockedUrlError, whose message still starts `blocked_url:` so
// any existing catch that keys on that prefix keeps working, and which carries
// the RULE that fired so the caller can name it.
// ─────────────────────────────────────────────────────────────────────────────

type BlockedUrlRule =
  | 'invalid_url'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'private_address'
  | 'dns_private'
  | 'denylisted_host'
  | 'too_many_redirects'
  | 'invalid_redirect';

class BlockedUrlError extends Error {
  readonly rule: BlockedUrlRule;
  /** The URL (initial or redirect target) that tripped the rule. */
  readonly url: string;
  /** 0 = the URL the caller passed; n = the n-th redirect target. */
  readonly hop: number;
  constructor(rule: BlockedUrlRule, detail: string, url: string, hop: number) {
    super(`blocked_url: ${rule}: ${detail}`);
    this.name = 'BlockedUrlError';
    this.rule = rule;
    this.url = url;
    this.hop = hop;
  }
}

/** The host could not be resolved at all (NXDOMAIN, no A/AAAA, or the DoH lookup itself failed). Fails closed. */
class DnsLookupError extends Error {
  readonly kind: 'nxdomain' | 'no_address' | 'lookup_failed';
  readonly host: string;
  constructor(kind: DnsLookupError['kind'], host: string, detail: string) {
    super(`dns_lookup_failed: ${kind}: ${host}: ${detail}`);
    this.name = 'DnsLookupError';
    this.kind = kind;
    this.host = host;
  }
}

interface PublicResolutionOptions {
  /** DoH JSON endpoint. Default https://cloudflare-dns.com/dns-query */
  endpoint?: string;
  /** Per-lookup bound. Default 3000 ms. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface SafeFetchExtendedOptions {
  allowHttp?: boolean;
  allowedPorts?: number[];
  refuseUserinfo?: boolean;
  resolvePublic?: boolean | PublicResolutionOptions;
  /** Return a reason string to refuse a host, or null to allow it. Receives the lowercased hostname. */
  denyHost?: (hostname: string) => string | null;
  onHop?: (hop: { url: string; status: number; location: string | null }) => void;
}

function usesExtendedOptions(o: SafeFetchExtendedOptions): boolean {
  return (
    o.allowHttp !== undefined ||
    o.allowedPorts !== undefined ||
    o.refuseUserinfo !== undefined ||
    o.resolvePublic !== undefined ||
    o.denyHost !== undefined ||
    o.onHop !== undefined
  );
}

function bareHost(u: URL): string {
  const h = u.hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || host.includes(':');
}

/** True when an address from a DNS answer is public, by the same rules as a URL literal. */
function isPublicAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  if (!a) return false;
  return isPublicHttpUrl(a.includes(':') ? `https://[${a}]/` : `https://${a}/`);
}

/**
 * Lexical checks for one URL in the chain, by the opted-in rules. Returns the
 * parsed URL or throws BlockedUrlError naming the rule.
 */
function checkUrlByRules(raw: string, opts: SafeFetchExtendedOptions, hop = 0): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('invalid_url', 'not a parseable absolute URL', raw, hop);
  }
  const httpOk = opts.allowHttp === true && u.protocol === 'http:';
  if (u.protocol !== 'https:' && !httpOk) {
    throw new BlockedUrlError('scheme', `${u.protocol.replace(/:$/, '')} is not allowed (${opts.allowHttp ? 'http or https' : 'https'} only)`, raw, hop);
  }
  if (opts.refuseUserinfo && (u.username || u.password)) {
    throw new BlockedUrlError('userinfo', 'URLs carrying user:password@ credentials are refused', raw, hop);
  }
  if (opts.allowedPorts) {
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!opts.allowedPorts.includes(port)) {
      throw new BlockedUrlError('port', `port ${port} is not allowed (allowed: ${opts.allowedPorts.join(', ')})`, raw, hop);
    }
  }
  // Host rules: reuse the vetted lexical guard on an https URL carrying only the host.
  if (!isPublicHttpUrl(`https://${u.hostname}/`)) {
    throw new BlockedUrlError('private_address', `${u.hostname} is a private, loopback, link-local, metadata or reserved address`, raw, hop);
  }
  if (opts.denyHost) {
    const reason = opts.denyHost(bareHost(u));
    if (reason) throw new BlockedUrlError('denylisted_host', reason, raw, hop);
  }
  return u;
}

type DohAnswer = { type?: number; data?: string; TTL?: number };
const dnsVerdictCache = new Map<string, { addresses: string[]; expires: number }>();

async function dohQuery(host: string, type: 'A' | 'AAAA', o: PublicResolutionOptions): Promise<{ status: number; answers: DohAnswer[] }> {
  const endpoint = o.endpoint ?? 'https://cloudflare-dns.com/dns-query';
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
    });
  } catch (e) {
    throw new DnsLookupError('lookup_failed', host, `DoH ${type} request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new DnsLookupError('lookup_failed', host, `DoH ${type} returned HTTP ${res.status}`);
  let j: { Status?: number; Answer?: DohAnswer[] };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    throw new DnsLookupError('lookup_failed', host, `DoH ${type} body is not JSON`);
  }
  return { status: j.Status ?? -1, answers: Array.isArray(j.Answer) ? j.Answer : [] };
}

/**
 * Resolve `host` over DNS-over-HTTPS (A and AAAA) and throw BlockedUrlError
 * (`dns_private`) if ANY address is non-public. Throws DnsLookupError when the
 * name does not resolve or the lookup fails — fail closed: an unverifiable
 * host is not fetched.
 *
 * Residual risk, accepted in the design: the runtime resolves the name again
 * when it connects, so a TOCTOU window remains. The backstop is that Workers
 * egress is not a route into our infrastructure and no credential is attached.
 *
 * Public verdicts are cached per isolate for the record TTL (60 s minimum).
 */
async function assertPublicResolution(host: string, o: PublicResolutionOptions = {}, hop = 0, url = host): Promise<string[]> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIpLiteral(h)) {
    if (!isPublicAddress(h)) throw new BlockedUrlError('dns_private', `${h} is not a public address`, url, hop);
    return [h];
  }
  const hit = dnsVerdictCache.get(h);
  if (hit && hit.expires > Date.now()) return hit.addresses;

  const [a, aaaa] = await Promise.all([dohQuery(h, 'A', o), dohQuery(h, 'AAAA', o)]);
  if (a.status === 3 && aaaa.status === 3) throw new DnsLookupError('nxdomain', h, 'the name does not exist');
  if (a.status !== 0 && aaaa.status !== 0) {
    throw new DnsLookupError('lookup_failed', h, `DoH status A=${a.status} AAAA=${aaaa.status}`);
  }
  const addrs = [...a.answers, ...aaaa.answers].filter((r) => (r.type === 1 || r.type === 28) && typeof r.data === 'string');
  if (addrs.length === 0) throw new DnsLookupError('no_address', h, 'no A or AAAA records');
  const bad = addrs.find((r) => !isPublicAddress(String(r.data)));
  if (bad) {
    throw new BlockedUrlError('dns_private', `${h} resolves to ${bad.data}, which is not a public address`, url, hop);
  }
  const ttl = Math.max(60, Math.min(...addrs.map((r) => (typeof r.TTL === 'number' ? r.TTL : 60))));
  const addresses = addrs.map((r) => String(r.data));
  dnsVerdictCache.set(h, { addresses, expires: Date.now() + ttl * 1000 });
  return addresses;
}

/** Test seam: forget cached DNS verdicts. */
function clearPublicResolutionCache(): void {
  dnsVerdictCache.clear();
}

async function vetHop(raw: string, opts: SafeFetchExtendedOptions, hop: number): Promise<URL> {
  const u = checkUrlByRules(raw, opts, hop);
  if (opts.resolvePublic) {
    const ro = typeof opts.resolvePublic === 'object' ? opts.resolvePublic : {};
    await assertPublicResolution(bareHost(u), ro, hop, raw);
  }
  return u;
}

async function safeFetchExtended(
  raw: string,
  init: RequestInit | undefined,
  opts: { maxRedirects?: number } & SafeFetchExtendedOptions,
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let target = await vetHop(raw, opts, 0);
  const origin = target.origin;
  let reqInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target.toString(), { ...reqInit, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    opts.onHop?.({ url: target.toString(), status: res.status, location });
    if (!location) return res;
    // Release the redirect body; we never read it.
    try { await res.body?.cancel(); } catch { /* already consumed or not cancellable */ }
    if (hop >= maxRedirects) {
      throw new BlockedUrlError('too_many_redirects', `more than ${maxRedirects} redirects`, target.toString(), hop + 1);
    }
    let next: string;
    try {
      next = new URL(location, target).toString();
    } catch {
      throw new BlockedUrlError('invalid_redirect', `unparseable Location ${location.slice(0, 120)}`, target.toString(), hop + 1);
    }
    target = await vetHop(next, opts, hop + 1);
    if (target.origin !== origin) reqInit = stripCredentials(reqInit);
  }
}
/**
 * web-fetch core: fetch ONE public URL live from its origin and return the
 * bytes (or text decoded from them) with a SHA-256 of exactly what arrived.
 *
 * Contract: docs/verbatim-fetch-design.md in the Pipeworx monorepo (fleet
 * #2729), built in #2847. Everything that can be refused is refused LOUDLY and
 * by name — never an empty body, never `found: false`.
 *
 * Kept free of module-scope I/O and with every side-effecting dependency
 * injectable (KV, the response store, the clock) so the unit tests can drive
 * each branch without a network.
 */


// ── constants (design §2, §4) ───────────────────────────────────────────────

/** Two honest identifications; one is sent per attempt, the other only on a 403 retry (design §1/§4). */
export const UA_PLAIN = 'Pipeworx/1.0 (pipeworx.io)';
export const UA_CONTACT = 'Pipeworx/1.0 (+https://pipeworx.io; support@pipeworx.io)';
/** Hosts that only accept the contact form; sending it first saves them a refused request. */
const CONTACT_FIRST = ['sec.gov'];

export const READ_CAP = 10 * 1024 * 1024;
export const DEFAULT_WINDOW = 100_000;
export const TEXT_WINDOW_MAX = 1_000_000;
export const BASE64_WINDOW_MAX = 512_000;
const TOTAL_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 4;
const STORE_TTL_S = 600;
const REFUSAL_SUMMARY_CHARS = 300;

export const BUDGETS = { hostPerMinute: 30, hostPerDay: 1000, globalPerHour: 600 };
const HOST_OVERRIDES: Record<string, { hostPerMinute?: number; hostPerDay?: number }> = {
  // SEC rate-limits by egress IP and every caller shares ours.
  'sec.gov': { hostPerMinute: 5 },
};

/** Public brand hosts we never fetch through ourselves (loops / amplification). The gateway adds its private infrastructure hosts via `_wfDenyHosts`. */
const OWN_HOST_SUFFIXES = ['pipeworx.io', 'mojibake.ai'];

// ── types ───────────────────────────────────────────────────────────────────

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface StoreLike {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}

export interface FetchDeps {
  kv?: KvLike | null;
  store?: StoreLike | null;
  /** Gateway-asserted: the caller is our own traffic (exempt from the global ceiling). */
  internal?: boolean;
  /** Extra host suffixes to refuse (gateway-injected). */
  denyHosts?: string[];
  now?: () => number;
}

export type ContentFamily = 'text' | 'pdf' | 'archive' | 'binary';

export interface Audit {
  domain: string;
  outcome: string;
  content_family: string;
  bytes_read: number;
  http_status: number;
  latency_ms: number;
}

type Hop = { status: number; location: string };

// ── helpers ────────────────────────────────────────────────────────────────

const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'nhs.uk', 'police.uk',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au', 'asn.au',
  'co.nz', 'govt.nz', 'org.nz', 'ac.nz', 'co.jp', 'go.jp', 'ac.jp', 'or.jp', 'ne.jp',
  'co.kr', 'go.kr', 'or.kr', 'ac.kr', 'com.br', 'gov.br', 'org.br', 'com.cn', 'gov.cn', 'edu.cn', 'org.cn',
  'co.in', 'gov.in', 'nic.in', 'ac.in', 'co.za', 'gov.za', 'org.za', 'ac.za', 'com.mx', 'gob.mx',
  'com.ar', 'gob.ar', 'com.tr', 'gov.tr', 'com.sg', 'gov.sg', 'com.hk', 'gov.hk', 'com.tw', 'gov.tw',
  'co.il', 'gov.il', 'ac.il', 'com.my', 'gov.my', 'co.id', 'go.id', 'or.id', 'ac.id', 'co.th', 'go.th',
  'gc.ca', 'gov.ie', 'gouv.fr', 'gv.at', 'ac.at', 'co.at', 'gob.es', 'com.es', 'gov.pl', 'com.pl',
]);

/**
 * Approximate registrable domain (eTLD+1) for budgets and the audit row. No
 * public-suffix list ships in a Worker, so this covers the common two-level
 * suffixes and otherwise takes the last two labels. An IP literal is itself.
 */
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join('.');
  if (SECOND_LEVEL.has(last2)) return labels.slice(-3).join('.');
  return last2;
}

function hostMatches(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase().replace(/^\./, '');
  return host === s || host.endsWith(`.${s}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function mimeOf(ct: string | null): string {
  return (ct ?? '').split(';')[0].trim().toLowerCase();
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** Executable and media magic numbers we refuse to relay regardless of the declared type. */
export function refusedMagic(b: Uint8Array): string | null {
  if (startsWith(b, [0x4d, 0x5a])) return 'MZ (Windows executable)';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return '\\x7fELF (Linux executable)';
  for (const sig of [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]]) {
    if (startsWith(b, sig)) return 'Mach-O (macOS executable)';
  }
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'PNG image';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'JPEG image';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'GIF image';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && b.length >= 12 && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'WebP image';
  return null;
}

const TEXT_APPLICATION = /^application\/(?:json|xml|javascript|ecmascript|x-javascript|x-ndjson|ndjson|yaml|x-yaml|csv|x-www-form-urlencoded|sql|rtf|x-tex|geo\+json|ld\+json)$|\+(?:json|xml)$/;
const ARCHIVE_TYPES = /^application\/(?:zip|x-zip-compressed|gzip|x-gzip|x-tar|x-7z-compressed|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.[\w.-]+|msword|vnd\.oasis\.opendocument\.[\w.-]+)$/;

/** Declared-type verdict before any body byte is read. `sniff` = decide from the bytes. */
export function classifyDeclared(mime: string): { family: ContentFamily | 'sniff' } | { refuse: string } {
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream' || mime === 'application/unknown') return { family: 'sniff' };
  if (/^(?:image|audio|video|font)\//.test(mime) || /^application\/(?:x-)?font/.test(mime) || mime === 'application/vnd.ms-fontobject') {
    return { refuse: mime };
  }
  if (/^application\/(?:x-msdownload|x-msdos-program|x-executable|x-mach-binary|x-sharedlib|vnd\.microsoft\.portable-executable|x-dosexec)$/.test(mime)) {
    return { refuse: mime };
  }
  if (mime.startsWith('text/') || TEXT_APPLICATION.test(mime)) return { family: 'text' };
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return { family: 'pdf' };
  if (ARCHIVE_TYPES.test(mime)) return { family: 'archive' };
  return { refuse: mime };
}

/** Family from the leading bytes, for a missing or octet-stream type. */
export function sniffFamily(b: Uint8Array): ContentFamily {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x1f, 0x8b])) return 'archive';
  // NUL-free is text: valid UTF-8, or a single-byte charset the decoder will
  // pick out later (Latin-1, windows-125x). A NUL in the first 8 KB is binary.
  return b.subarray(0, 8192).includes(0) ? 'binary' : 'text';
}

function trimUtf8Tail(b: Uint8Array): Uint8Array {
  // Back off up to 3 bytes so a window never ends inside a UTF-8 sequence.
  for (let k = 1; k <= 3 && k <= b.length; k++) {
    const c = b[b.length - k];
    if ((c & 0xc0) === 0x80) continue; // continuation byte; keep looking for the lead
    if (c >= 0xc0) {
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
      return need > k ? b.subarray(0, b.length - k) : b;
    }
    return b;
  }
  return b;
}

function looksHtml(mime: string, b: Uint8Array): boolean {
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true;
  if (mime && mime !== 'application/octet-stream' && mime !== 'text/plain') return false;
  const head = new TextDecoder('windows-1252').decode(b.subarray(0, 1024)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

const NAMED_ENTITIES: Record<string, string> = {
  sect: '§', para: '¶', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷', plusmn: '±',
  frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à',
  ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', ntilde: 'ñ', ccedil: 'ç', shy: '', zwnj: '', zwj: '',
};

function decodeRemainingEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => safeCodePoint(parseInt(d, 10), m))
    .replace(/&([a-z][a-z0-9]{1,8});/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function safeCodePoint(cp: number, fallback: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fallback;
  return String.fromCodePoint(cp);
}

const BREAK = '\uE000';
/**
 * Readable text from HTML: drop script/style/noscript/template/svg and
 * comments, turn block boundaries into line breaks, then run each line through
 * the shared stripMarkup (which removes tags and collapses whitespace).
 */
export function htmlToText(html: string): { text: string; scripts: number; title: string | null } {
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, BREAK)
    .replace(/<\/?(?:p|div|li|ul|ol|tr|table|thead|tbody|section|article|header|footer|nav|aside|main|h[1-6]|pre|blockquote|dd|dt|dl|figure|figcaption|form|fieldset|address|details|summary)\b[^>]*>/gi, BREAK)
    .replace(/<\/t[dh]\s*>/gi, ' \t ');
  s = stripMarkup(s);
  const lines = s.split(BREAK).map((l) => decodeRemainingEntities(l).replace(/[ \t]+/g, ' ').trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l || (out.length && out[out.length - 1] !== '')) out.push(l);
  }
  return { text: out.join('\n').trim(), scripts, title: title ? decodeRemainingEntities(stripMarkup(title)) : null };
}

/** Strong bot-wall signals only — a page that merely mentions "captcha" is content. */
export function botWallSignal(headers: Headers, bodyHead: string): string | null {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') return 'cf-mitigated: challenge';
  const h = bodyHead.slice(0, 200_000);
  if (/<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(h)) return 'Cloudflare challenge page';
  if (/cf-chl-|challenge-platform\/h\//i.test(h)) return 'Cloudflare challenge script';
  if (/_Incapsula_Resource/i.test(h)) return 'Imperva/Incapsula challenge';
  if (/px-captcha|perimeterx/i.test(h)) return 'PerimeterX challenge';
  if (/geo\.captcha-delivery\.com|datadome/i.test(h)) return 'DataDome challenge';
  if (/<title>\s*(?:Access Denied|Attention Required!?[^<]*|Pardon Our Interruption|Request unsuccessful)[^<]*<\/title>/i.test(h)) return 'bot-wall page title';
  return null;
}

// ── budgets (design §4: vendor_free posture, fail open) ─────────────────────

type BudgetVerdict =
  | { ok: true; state: 'ok' | 'not_enforced' }
  | { ok: false; which: 'host_minute' | 'host_day' | 'global_hour'; limit: number; retry_after_s: number };

async function readCount(kv: KvLike, key: string): Promise<number> {
  const v = await kv.get(key);
  const n = v === null ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function takeGlobal(kv: KvLike | null | undefined, internal: boolean, nowMs: number): Promise<BudgetVerdict> {
  if (!kv) return { ok: true, state: 'not_enforced' };
  if (internal) return { ok: true, state: 'ok' };
  const hour = Math.floor(nowMs / 3_600_000);
  const key = `wf:b:g:${hour}`;
  try {
    const n = await readCount(kv, key);
    if (n >= BUDGETS.globalPerHour) {
      return { ok: false, which: 'global_hour', limit: BUDGETS.globalPerHour, retry_after_s: Math.ceil(((hour + 1) * 3_600_000 - nowMs) / 1000) };
    }
    await kv.put(key, String(n + 1), { expirationTtl: 7200 });
    return { ok: true, state: 'ok' };
  } catch {
    return { ok: true, state: 'not_enforced' };
  }
}

export async function takeHost(kv: KvLike | null | undefined, domain: string, nowMs: number): Promise<BudgetVerdict> {
  if (!kv) return { ok: true, state: 'not_enforced' };
  const o = HOST_OVERRIDES[domain] ?? {};
  const perMin = o.hostPerMinute ?? BUDGETS.hostPerMinute;
  const perDay = o.hostPerDay ?? BUDGETS.hostPerDay;
  const minute = Math.floor(nowMs / 60_000);
  const day = Math.floor(nowMs / 86_400_000);
  const mk = `wf:b:m:${domain}:${minute}`;
  const dk = `wf:b:d:${domain}:${day}`;
  try {
    const [m, d] = await Promise.all([readCount(kv, mk), readCount(kv, dk)]);
    if (m >= perMin) return { ok: false, which: 'host_minute', limit: perMin, retry_after_s: Math.ceil(((minute + 1) * 60_000 - nowMs) / 1000) };
    if (d >= perDay) return { ok: false, which: 'host_day', limit: perDay, retry_after_s: Math.ceil(((day + 1) * 86_400_000 - nowMs) / 1000) };
    await Promise.all([kv.put(mk, String(m + 1), { expirationTtl: 120 }), kv.put(dk, String(d + 1), { expirationTtl: 172_800 })]);
    return { ok: true, state: 'ok' };
  } catch {
    return { ok: true, state: 'not_enforced' };
  }
}

// ── the stored-response layer (Workers Cache API, 10 minutes, 200s only) ────
// hosting-claims-ok: describes a 10-minute client-side response store keyed by URL, not a dataset copy
interface StoredMeta {
  status: number; url_final: string; redirects: Hop[]; fetched_at: string; user_agent_used: string;
  headers: Record<string, string | null>; colo: string | null;
}

async function storeKey(url: string): Promise<Request> {
  const hex = await sha256Hex(new TextEncoder().encode(`v1 ${url}`));
  return new Request(`https://web-fetch-store.pipeworx.invalid/${hex}`);
}

async function storeGet(store: StoreLike | null | undefined, url: string, nowMs: number): Promise<{ meta: StoredMeta; bytes: Uint8Array; age_s: number } | null> {
  if (!store) return null;
  try {
    const hit = await store.match(await storeKey(url));
    if (!hit) return null;
    const metaRaw = hit.headers.get('x-wf-meta');
    if (!metaRaw) return null;
    const meta = JSON.parse(decodeURIComponent(metaRaw)) as StoredMeta;
    const age_s = Math.max(0, Math.round((nowMs - Date.parse(meta.fetched_at)) / 1000));
    if (!(age_s <= STORE_TTL_S)) return null;
    return { meta, bytes: new Uint8Array(await hit.arrayBuffer()), age_s };
  } catch {
    return null;
  }
}

async function storePut(store: StoreLike | null | undefined, url: string, meta: StoredMeta, bytes: Uint8Array): Promise<void> {
  if (!store) return;
  try {
    await store.put(
      await storeKey(url),
      new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': `public, max-age=${STORE_TTL_S}`,
          'x-wf-meta': encodeURIComponent(JSON.stringify(meta)),
        },
      }),
    );
  } catch {
    /* an optimisation; a failed put never fails the call */
  }
}

// ── reading ─────────────────────────────────────────────────────────────────

async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; overCap: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), overCap: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let overCap = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > cap) {
      chunks.push(value.subarray(0, cap - n));
      n = cap;
      overCap = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { bytes: out, overCap };
}

function pickHeaders(h: Headers): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of ['content-type', 'content-length', 'last-modified', 'etag', 'content-language', 'date']) out[k] = h.get(k);
  return out;
}

function coloOf(h: Headers): string | null {
  const ray = h.get('cf-ray');
  const m = ray ? /-([A-Z]{3})$/.exec(ray) : null;
  return m ? m[1] : null;
}

// ── results ─────────────────────────────────────────────────────────────────

type Result = Record<string, unknown> & { _audit: Audit };

// REFUSED_CLASS, not `auth_required` (fleet #2856). error-class.ts states the
// dividing line for auth_required as WHAT FIXES IT: a credential. web-fetch
// fronts no key and accepts none, so a remote origin's 401/403/429 or bot wall
// is never fixed by one. Tagging it auth_required made the gateway attach
//   credential: { holder: 'caller', state: 'absent',
//     detail: 'web-fetch requires an API key and Pipeworx does not front one
//              for it. Pass your own to proceed.' }
// to a KEYLESS pack, and set error_class auth_required -> HTTP 401. For the
// one pack whose whole purpose is serving the 134 callers the paid
// firecrawl/jina gates turned away, "bring a key" is the most
// counterproductive sentence we could emit, and there is no key to bring.
//
// DROPPING the token is NOT sufficient and was the first thing tried:
// classifyToolError matches a bare 401 anywhere in the message and re-derives
// auth_required, while a bare 403 lands on the throttle rule -- so the class
// would silently depend on which digits the origin happened to return. It has
// to be explicit.
//
// NAMING THE TRADE-OFF rather than pretending this is exact: `upstream_throttled`
// slightly overstates "retrying will help" for a hard bot wall. It is still the
// least-false option available. `upstream_down` (HTTP 502) would book a healthy
// site as OUR outage and park web-fetch on the problem-tool ranking as normal
// operation, since being refused by some sites is the steady state for a URL
// fetcher; `user_error` (HTTP 400) would blame arguments that were valid. This
// maps to HTTP 429 "not your fault, not permanent", is already what a bare 403
// resolves to today, and is exactly right for the 429s that dominate the class.
// The precise, caller-facing truth is carried by the fields that are not a
// guess: error: 'upstream_refused', reason, and the archive_evidence hint.
const REFUSED_CLASS = 'upstream_throttled' as const;

function refusal(
  error: string,
  classToken: 'user_error' | 'auth_required' | 'upstream_down' | 'upstream_throttled' | 'not_found' | null,
  message: string,
  extra: Record<string, unknown>,
  audit: Audit,
): Result {
  return { error, message: classToken ? `${classToken}: ${message}` : message, ...extra, _audit: audit };
}

// ── main ────────────────────────────────────────────────────────────────────

export async function fetchUrl(args: Record<string, unknown>, deps: FetchDeps = {}): Promise<Result> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const audit: Audit = { domain: '', outcome: 'ok', content_family: '', bytes_read: 0, http_status: 0, latency_ms: 0 };
  const rawUrlForEcho = typeof args.url === 'string' ? args.url.trim().slice(0, 2048) : null;
  const done = (r: Result, outcome: string): Result => {
    // Every answer, refusals included, says which URL it is about.
    if (!('url_requested' in r)) (r as Record<string, unknown>).url_requested = rawUrlForEcho;
    // `redirects` and `warnings` are present only when non-empty: an answer
    // whose only arrays are [] reads as a zero-row result to every emptiness
    // check in the fleet (scripts/lib/payload-emptiness.mjs), and "no
    // redirects, no warnings" is the common, healthy case.
    for (const k of ['redirects', 'warnings'] as const) {
      const v = (r as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.length === 0) delete (r as Record<string, unknown>)[k];
    }
    audit.outcome = outcome;
    audit.latency_ms = Math.max(0, now() - t0);
    return r;
  };
  const invalid = (msg: string) =>
    done(refusal('invalid_argument', 'user_error', msg, {}, audit), 'invalid_argument');

  // ── arguments ──
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (!rawUrl) return invalid('url is required: one absolute http(s) URL, e.g. "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv".');
  const format = args.format === undefined || args.format === null || args.format === '' ? 'auto' : String(args.format);
  if (!['auto', 'raw', 'text'].includes(format)) return invalid(`format must be one of auto, raw, text (got "${format}").`);
  const maxReq = args.max_bytes === undefined || args.max_bytes === null ? DEFAULT_WINDOW : Number(args.max_bytes);
  if (!Number.isInteger(maxReq) || maxReq < 1) return invalid(`max_bytes must be a positive integer (got ${JSON.stringify(args.max_bytes)}).`);
  const offset = args.offset === undefined || args.offset === null ? 0 : Number(args.offset);
  if (!Number.isInteger(offset) || offset < 0) return invalid(`offset must be a non-negative integer (got ${JSON.stringify(args.offset)}).`);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return done(refusal('blocked_url', 'user_error', `"${rawUrl.slice(0, 200)}" is not an absolute URL. Pass the full address including https://.`, { rule: 'invalid_url' }, audit), 'blocked_invalid_url');
  }
  audit.domain = registrableDomain(parsed.hostname);

  const denySuffixes = [...OWN_HOST_SUFFIXES, ...(deps.denyHosts ?? [])].filter(Boolean);
  const denyHost = (h: string): string | null =>
    denySuffixes.some((s) => hostMatches(h, s)) ? 'Pipeworx does not fetch its own service hosts through this tool' : null;
  const ssrfOpts: SafeFetchExtendedOptions & { maxRedirects: number } = {
    allowHttp: true,
    allowedPorts: [443, 80],
    refuseUserinfo: true,
    resolvePublic: true,
    denyHost,
    maxRedirects: MAX_REDIRECTS,
  };

  const blocked = (e: BlockedUrlError) =>
    done(
      refusal('blocked_url', 'user_error', `${e.message.replace(/^blocked_url:\s*/, '')}${e.hop > 0 ? ` (at redirect hop ${e.hop})` : ''}.`, { rule: e.rule, hop: e.hop }, audit),
      `blocked_${e.rule}`,
    );

  // Lexical rules first — a refused URL costs no budget and no DNS lookup.
  try {
    checkUrlByRules(rawUrl, ssrfOpts, 0);
  } catch (e) {
    if (e instanceof BlockedUrlError) return blocked(e);
    throw e;
  }
  // Operator denylist (abuse complaints).
  if (deps.kv) {
    try {
      const why = await deps.kv.get(`wf:deny:${audit.domain}`);
      if (why !== null) {
        return done(
          refusal('blocked_url', 'user_error', `${audit.domain} is on the operator denylist${why ? ` (${why.slice(0, 120)})` : ''}.`, { rule: 'denylisted_host', hop: 0 }, audit),
          'blocked_denylisted_host',
        );
      }
    } catch { /* fail open */ }
  }

  const g = await takeGlobal(deps.kv, deps.internal === true, t0);
  if (!g.ok) {
    return done(
      refusal('budget_exhausted', 'upstream_throttled', `the hourly ceiling for this tool across all callers (${g.limit}) is reached. Retry after ${g.retry_after_s}s.`, { budget: g.which, retry_after_s: g.retry_after_s }, audit),
      `budget_${g.which}`,
    );
  }
  let budgetState: 'ok' | 'not_enforced' = g.state;

  // ── stored response (10 min, 200s only) ──
  const normalized = parsed.toString();
  const stored = await storeGet(deps.store, normalized, t0);

  let status: number;
  let urlFinal: string;
  let redirects: Hop[];
  let fetchedAt: string;
  let uaUsed = UA_PLAIN;
  let headersOut: Record<string, string | null>;
  let colo: string | null;
  let bytes: Uint8Array;
  let overCap = false;
  let rangeTotal: number | null = null;
  let rangeServed = false;
  let servedFrom: 'origin' | 'cache' = 'origin';
  let cacheAge: number | null = null;
  let mime: string;

  if (stored) {
    servedFrom = 'cache';
    cacheAge = stored.age_s;
    ({ status, url_final: urlFinal, redirects, fetched_at: fetchedAt, user_agent_used: uaUsed, headers: headersOut, colo } = stored.meta);
    bytes = stored.bytes;
    audit.http_status = status;
    mime = mimeOf(headersOut['content-type']);
  } else {
    const h = await takeHost(deps.kv, audit.domain, t0);
    if (!h.ok) {
      return done(
        refusal('budget_exhausted', 'upstream_throttled', `requests to ${audit.domain} through this tool are at their ${h.which === 'host_minute' ? 'per-minute' : 'per-day'} limit (${h.limit}), shared by all callers to protect the origin. Retry after ${h.retry_after_s}s.`, { budget: h.which, retry_after_s: h.retry_after_s }, audit),
        `budget_${h.which}`,
      );
    }
    if (h.state === 'not_enforced') budgetState = 'not_enforced';

    const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
    const useRange = format === 'raw' && offset > 0;
    const windowGuess = Math.min(maxReq, TEXT_WINDOW_MAX);

    const attempt = async (target: string, ua: string): Promise<{ res: Response; hops: Hop[]; finalUrl: string }> => {
      const hops: Hop[] = [];
      let finalUrl = target;
      const res = await safeFetch(
        target,
        {
          method: 'GET',
          headers: {
            'User-Agent': ua,
            Accept: '*/*',
            ...(useRange ? { Range: `bytes=${offset}-${offset + windowGuess - 1}` } : {}),
          },
          signal,
        },
        {
          ...ssrfOpts,
          onHop: (hp) => {
            finalUrl = hp.url;
            if (hp.location) hops.push({ status: hp.status, location: hp.location });
          },
        },
      );
      return { res, hops, finalUrl };
    };

    const contactFirst = CONTACT_FIRST.some((s) => hostMatches(parsed.hostname.toLowerCase(), s));
    const uaOrder = contactFirst ? [UA_CONTACT, UA_PLAIN] : [UA_PLAIN, UA_CONTACT];

    // http:// is tried as https:// first, falling back only on a connection-level failure.
    const targets = parsed.protocol === 'http:' ? [normalized.replace(/^http:/, 'https:'), normalized] : [normalized];

    let got: { res: Response; hops: Hop[]; finalUrl: string } | null = null;
    let usedTarget = targets[0];
    try {
      for (let ti = 0; ti < targets.length && !got; ti++) {
        try {
          uaUsed = uaOrder[0];
          usedTarget = targets[ti];
          got = await attempt(usedTarget, uaUsed);
        } catch (e) {
          const connectionLevel = !(e instanceof BlockedUrlError) && !(e instanceof DnsLookupError) && (e as Error)?.name !== 'TimeoutError' && (e as Error)?.name !== 'AbortError';
          if (ti < targets.length - 1 && connectionLevel) continue;
          throw e;
        }
      }
      if (got && got.res.status === 403) {
        // Exactly one retry, with the other honest identification (design §4).
        try { await got.res.body?.cancel(); } catch { /* ignore */ }
        uaUsed = uaOrder[1];
        got = await attempt(usedTarget, uaUsed);
      }
    } catch (e) {
      if (e instanceof BlockedUrlError) return blocked(e);
      if (e instanceof DnsLookupError) {
        return done(
          refusal('upstream_down', null, `${e.host} could not be resolved (${e.kind === 'nxdomain' ? 'the name does not exist' : e.kind === 'no_address' ? 'no address records' : 'the DNS check failed'}). Nothing was fetched.`, { phase: 'dns', ms: now() - t0 }, audit),
          'upstream_down',
        );
      }
      const name = (e as Error)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      return done(
        refusal('upstream_down', null, timedOut ? `${parsed.hostname} did not answer within ${TOTAL_TIMEOUT_MS / 1000}s.` : `connecting to ${parsed.hostname} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, { phase: timedOut ? 'timeout' : 'connect', ms: now() - t0 }, audit),
        'upstream_down',
      );
    }
    const res = got!.res;
    status = res.status;
    audit.http_status = status;
    urlFinal = got!.finalUrl;
    redirects = got!.hops;
    fetchedAt = new Date(now()).toISOString();
    headersOut = pickHeaders(res.headers);
    colo = coloOf(res.headers);
    mime = mimeOf(headersOut['content-type']);

    const refusedStatus = [401, 402, 403, 407, 429, 451].includes(status);
    if (status < 200 || status >= 300) {
      const { bytes: head } = await readCapped(res, 512 * 1024);
      audit.bytes_read = head.length;
      const headText = new TextDecoder(chooseCharset(head, headersOut['content-type']).charset).decode(head);
      const wall = botWallSignal(res.headers, headText);
      const summary = summarizeErrorBody(headText).slice(0, REFUSAL_SUMMARY_CHARS);
      const common = { status, url_final: urlFinal, redirects, user_agent_used: uaUsed, body_summary: summary || null };
      if (refusedStatus || wall) {
        return done(
          refusal(
            'upstream_refused',
            REFUSED_CLASS,
            `${new URL(urlFinal).hostname} refused the request with HTTP ${status}${wall ? ` (${wall})` : ''}. No login, cookie or browser identity is used to get past a refusal.`,
            {
              ...common,
              reason: wall ? 'bot_wall' : `http_${status}`,
              hint: `archive_evidence(url, date=today) may hold a recent capture of this page. It is not run automatically: an archived copy is not the page as it is today.`,
            },
            audit,
          ),
          'upstream_refused',
        );
      }
      if (status >= 500) {
        return done(refusal('upstream_down', null, `${new URL(urlFinal).hostname} returned HTTP ${status}.`, { ...common, phase: 'status', ms: now() - t0 }, audit), 'upstream_down');
      }
      return done(
        refusal('upstream_status', status === 404 || status === 410 ? 'not_found' : 'user_error', `${new URL(urlFinal).hostname} returned HTTP ${status}${status === 404 ? ' (not found)' : status === 410 ? ' (gone)' : ''}.`, common, audit),
        'upstream_status',
      );
    }

    // Declared type, before reading the body.
    const declared = classifyDeclared(mime);
    if ('refuse' in declared) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return done(
        refusal('unsupported_content_type', 'user_error', `${mime} is not relayed by this tool (images, audio, video, fonts and executables are refused).`, { content_type: mime, status, url_final: urlFinal }, audit),
        'unsupported_type',
      );
    }

    if (status === 206) {
      rangeServed = true;
      const cr = res.headers.get('content-range');
      const tot = cr ? /\/(\d+)\s*$/.exec(cr) : null;
      rangeTotal = tot ? Number(tot[1]) : null;
    }
    const read = await readCapped(res, READ_CAP);
    bytes = read.bytes;
    overCap = read.overCap;
    audit.bytes_read = bytes.length;

    const magic = refusedMagic(bytes);
    if (magic && !rangeServed) {
      return done(
        refusal('unsupported_content_type', 'user_error', `the body is a ${magic}, declared as ${mime || 'no content type'}; this tool does not relay it.`, { content_type: mime || null, sniffed: magic, status, url_final: urlFinal }, audit),
        'unsupported_type',
      );
    }

    // A 200 that is really a challenge page is a refusal, not content.
    if (looksHtml(mime, bytes)) {
      const wall = botWallSignal(res.headers, new TextDecoder('windows-1252').decode(bytes.subarray(0, 200_000)));
      if (wall) {
        return done(
          refusal(
            'upstream_refused',
            REFUSED_CLASS,
            `${new URL(urlFinal).hostname} answered HTTP ${status} with a bot-wall page (${wall}), not the content.`,
            {
              status, url_final: urlFinal, redirects, user_agent_used: uaUsed, reason: 'bot_wall',
              hint: `archive_evidence(url, date=today) may hold a recent capture of this page. It is not run automatically: an archived copy is not the page as it is today.`,
            },
            audit,
          ),
          'upstream_refused',
        );
      }
    }

    if (status === 200 && !overCap) {
      await storePut(deps.store, normalized, { status, url_final: urlFinal, redirects, fetched_at: fetchedAt, user_agent_used: uaUsed, headers: headersOut, colo }, bytes);
    }
  }

  // ── shape the answer ──
  const declared = classifyDeclared(mime);
  const family: ContentFamily = 'refuse' in declared ? 'binary' : declared.family === 'sniff' ? sniffFamily(bytes) : declared.family;
  audit.content_family = family;
  if (servedFrom === 'cache') audit.bytes_read = 0;
  const isHtml = family === 'text' && looksHtml(mime, bytes);
  const mode: 'raw' | 'text' = format === 'auto' ? (isHtml || family === 'pdf' ? 'text' : 'raw') : (format as 'raw' | 'text');

  const bodyComplete = !overCap && !rangeServed;
  const bytesTotal = rangeServed ? rangeTotal : bodyComplete ? bytes.length : headersOut['content-length'] ? Number(headersOut['content-length']) : null;
  const sha256 = bodyComplete ? await sha256Hex(bytes) : null;
  const warnings: string[] = [];
  const base = {
    url_requested: rawUrl,
    url_final: urlFinal,
    redirects,
    transport: new URL(urlFinal).protocol === 'http:' ? 'http' : 'https',
    status,
    fetched_at: fetchedAt,
    fetched_via: 'pipeworx-edge',
    colo,
    user_agent_used: uaUsed,
    served_from: servedFrom,
    cache_age_s: cacheAge,
    headers: headersOut,
    content_family: family,
    bytes_total: bytesTotal,
    bytes_read: servedFrom === 'cache' ? bytes.length : audit.bytes_read,
    body_complete: bodyComplete,
    sha256,
    budget: budgetState,
  };
  if (redirects.some((r) => /^http:/i.test(r.location))) warnings.push('a redirect hop downgraded to plain http');
  if (overCap) warnings.push(`the body is larger than the ${READ_CAP} byte read limit; only the first ${READ_CAP} bytes were read, so sha256 covers nothing and is null`);

  // Text mode: extracted or decoded text, windowed in characters.
  if (mode === 'text' && (family === 'pdf' || family === 'text')) {
    let text = '';
    let extraction: 'html' | 'pdf' | 'none' | 'failed' = 'none';
    let charsetInfo: Record<string, unknown> = { charset: null, charset_source: null, decode_replacements: 0 };
    let likelyNeedsJs = false;
    if (family === 'pdf') {
      if (!bodyComplete) {
        extraction = 'failed';
        warnings.push('PDF text needs the whole file and the body was not read completely; pass format:"raw" with offset to page through the bytes');
      } else {
        const ab = bytes.slice().buffer as ArrayBuffer;
        const r = await extractPdfText(ab).catch((e) => ({ text: '', pages: 0, warnings: [`pdf extraction threw: ${(e as Error).message}`] }));
        warnings.push(...r.warnings.map((w) => `pdf: ${w}`));
        if (r.pages === 0 || !r.text.trim()) {
          extraction = 'failed';
          warnings.push('no text could be extracted from this PDF (scanned, encrypted or an unsupported layout); pass format:"raw" for the bytes');
        } else {
          extraction = 'pdf';
          text = r.text;
        }
      }
    } else {
      const ch = decodeBytes(bytes, headersOut['content-type']);
      const decoded = ch.text;
      charsetInfo = { charset: ch.charset, charset_source: ch.charset_source, decode_replacements: ch.decode_replacements };
      if (ch.ignored_labels.length) warnings.push(`unrecognised charset label(s) ignored: ${ch.ignored_labels.join(', ')}`);
      if (isHtml) {
        const h = htmlToText(decoded);
        text = h.text;
        extraction = 'html';
        likelyNeedsJs = h.text.length < 500 && h.scripts > 10;
        if (likelyNeedsJs) warnings.push('very little text and many scripts: the page probably renders its content with JavaScript, which this tool does not run');
      } else {
        text = decoded;
      }
    }
    if (extraction === 'failed') {
      // Never an empty answer: hand back the bytes with the failure stated.
      const win = bytes.subarray(Math.min(offset, bytes.length), Math.min(bytes.length, offset + Math.min(maxReq, BASE64_WINDOW_MAX)));
      return done(
        {
          ...base, offset, bytes_returned: win.length, truncated: offset + win.length < (bytesTotal ?? Infinity),
          sha256_returned: await sha256Hex(win), encoding: 'base64', ...charsetInfo, body: toBase64(win),
          text: null, text_chars_total: 0, text_extraction: 'failed', warnings, likely_needs_js: false, _audit: audit,
        },
        'ok',
      );
    }
    const max = Math.min(maxReq, TEXT_WINDOW_MAX);
    if (maxReq > TEXT_WINDOW_MAX) warnings.push(`max_bytes capped at ${TEXT_WINDOW_MAX} for text`);
    if (offset > text.length) return invalid(`offset ${offset} is past the end of the extracted text (${text.length} characters).`);
    const slice = text.slice(offset, offset + max);
    return done(
      {
        ...base, offset, bytes_returned: null, truncated: offset + slice.length < text.length || overCap,
        next_offset: offset + slice.length < text.length ? offset + slice.length : null,
        sha256_returned: null, encoding: 'text', ...charsetInfo, body: null,
        text: slice, text_chars_total: text.length, text_extraction: extraction, warnings, likely_needs_js: likelyNeedsJs, _audit: audit,
      },
      'ok',
    );
  }

  // Raw mode (or text requested on an archive/binary body).
  if (mode === 'text') warnings.push(`format "text" is not possible for ${family} content; returned the bytes`);
  const textual = family === 'text';
  const cap = textual ? TEXT_WINDOW_MAX : BASE64_WINDOW_MAX;
  const max = Math.min(maxReq, cap);
  if (maxReq > cap) warnings.push(`max_bytes capped at ${cap} for ${textual ? 'text' : 'base64'}`);
  let win: Uint8Array;
  let winOffset = offset;
  if (rangeServed) {
    win = bytes.subarray(0, max);
  } else {
    if (offset > 0 && offset >= bytes.length) {
      if (overCap) {
        return done(
          refusal('too_large', 'user_error', `offset ${offset} is beyond the ${READ_CAP} byte read limit and ${new URL(urlFinal).hostname} does not serve byte ranges.`, { bytes_read: bytes.length, bytes_total: bytesTotal }, audit),
          'too_large',
        );
      }
      return invalid(`offset ${offset} is past the end of the body (${bytes.length} bytes).`);
    }
    win = bytes.subarray(offset, offset + max);
    winOffset = offset;
  }
  if (offset > 0 && !rangeServed && format === 'raw') warnings.push('the origin did not honour a byte range; the window was cut from the full body');
  let charsetInfo: Record<string, unknown> = { charset: null, charset_source: null, decode_replacements: 0 };
  let body: string;
  let encoding: 'text' | 'base64';
  if (textual) {
    const ch = chooseCharset(rangeServed ? win : bytes, headersOut['content-type']);
    const cut = ch.charset === 'utf-8' && winOffset + win.length < (bytesTotal ?? Infinity) ? trimUtf8Tail(win) : win;
    win = cut;
    const d = decodeWithCharset(win, ch.charset);
    body = d.text;
    charsetInfo = { charset: ch.charset, charset_source: ch.charset_source, decode_replacements: d.decode_replacements };
    if (ch.ignored_labels.length) warnings.push(`unrecognised charset label(s) ignored: ${ch.ignored_labels.join(', ')}`);
    encoding = 'text';
  } else {
    body = toBase64(win);
    encoding = 'base64';
  }
  const endOfWindow = winOffset + win.length;
  const truncated = overCap || (bytesTotal === null ? true : endOfWindow < bytesTotal);
  return done(
    {
      ...base, offset: winOffset, bytes_returned: win.length, truncated, next_offset: truncated && (bytesTotal === null || endOfWindow < bytesTotal) ? endOfWindow : null,
      sha256_returned: await sha256Hex(win), encoding, ...charsetInfo, body,
      text: null, text_chars_total: null, text_extraction: 'none', warnings, likely_needs_js: false, _audit: audit,
    },
    'ok',
  );
}
