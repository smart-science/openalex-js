# `@smart-science/openalex`

[![Test](https://github.com/smart-science/openalex-js/actions/workflows/test.yml/badge.svg)](https://github.com/smart-science/openalex-js/actions/workflows/test.yml)
[![Package](https://github.com/smart-science/openalex-js/actions/workflows/package.yml/badge.svg)](https://github.com/smart-science/openalex-js/actions/workflows/package.yml)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsmart-science%2Fopenalex-js%2Fmain%2Fpackage.json&query=%24.engines.bun&label=Bun&logo=bun&color=blue)](https://bun.sh)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsmart-science%2Fopenalex-js%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&logo=nodedotjs&color=blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Resolve a DOI or OpenAlex work ID to its full OpenAlex work record, download hosted full-text PDFs and TEI XML, and query daily API budget status. Requests never throw; `createOpenAlex` throws once on invalid configuration.

- **Single runtime dependency**: `smart-limit` for rate-limited request queues; everything else uses standard `fetch`, `AbortController`, and `setTimeout`.
- **Result envelope**: Every request returns `{ ok: true, data } | { ok: false, error }`. Every error shares the same seven keys (`code`, `message`, `status`, `retryable`, `retryAfterSeconds`, `budget`, `cause`).
- **Flattened + raw**: Returns a flattened `WorkRecord` (with reconstructed plaintext `abstract`, normalized bare IDs, and all open-access locations) alongside the untouched `raw` `OpenAlexWork` payload.

## Installation

```sh
bun add @smart-science/openalex     # or npm / pnpm / yarn
```

Requirements: Node.js ≥ 22.12 or Bun ≥ 1.3. Distributed as native ESM with bundled TypeScript declaration files.

## Quickstart

```ts
import { createOpenAlex } from '@smart-science/openalex';

// Instantiate once per process to share rate limiter queues
const openalex = createOpenAlex({ apiKey: process.env.OPENALEX_API_KEY });

const res = await openalex.fetchDoi('10.1038/nature12373');

if (!res.ok) {
  // Uniform error structure — no type narrowing required
  console.error(res.error.code, res.error.message, res.error.status, res.error.retryable);
} else {
  const { requestedDoi, record, raw, budget } = res.data;

  console.log(requestedDoi);           // '10.1038/nature12373' (normalized input)
  console.log(record.id);              // 'W2159974629' (canonical bare work ID)
  console.log(record.doi);             // '10.1038/nature12373' (work's canonical DOI)
  console.log(record.title);           // string | null
  console.log(record.abstract);        // string | null (reconstructed plaintext)
  console.log(record.first_author);    // string | null
  console.log(record.authors);         // readonly string[]
  console.log(record.oa_locations);    // readonly OaLocationRecord[]
  console.log(record.has_content_pdf); // boolean (OpenAlex hosts full-text PDF)
  console.log(raw);                    // untouched OpenAlexWork payload
  console.log(budget);                 // rate limit headers | null
}
```

## Single Lookups

The client provides two single-lookup methods:

- `fetchDoi(doi, options?)`: resolves a DOI to work data.
- `fetchWorkById(workId, options?)`: resolves an OpenAlex work ID to work data.

```ts
// All DOI representations resolve identically
await openalex.fetchDoi('10.1038/nature12373');
await openalex.fetchDoi('doi:10.1038/nature12373');
await openalex.fetchDoi('https://doi.org/10.1038/nature12373');
await openalex.fetchDoi('  10.1038/NATURE12373  ');

// Work IDs accept bare IDs or OpenAlex URLs
await openalex.fetchWorkById('W2159974629');
await openalex.fetchWorkById('https://openalex.org/W2159974629');
```

### Identifier Normalization

- **DOIs**: Trims surrounding whitespace, strips `doi:` labels and resolver URLs (`doi.org`, `dx.doi.org`), and converts to lowercase. Suffixes are preserved intact without stripping punctuation or percent-decoding. Invalid DOIs fail immediately with `INVALID_DOI` without issuing a network request.
- **Work IDs**: Strips URLs, query parameters, hashes, and trailing slashes, returning an uppercase canonical ID (`W...`). Invalid IDs fail immediately with `INVALID_ID`.

Methods are safe to destructure because they do not rely on `this`:

```ts
const { fetchDoi, fetchWorkById, fetchContent, fetchBudget } = openalex;
```

## Batch Lookups

Passing an array of strings to `fetchDoi` or `fetchWorkById` returns a `BatchResult`. The return type matches the input type, enabling TypeScript to differentiate single and batch calls automatically.

```ts
const res = await openalex.fetchDoi([
  '10.1038/nature12373',
  '10.1103/physrev.109.1492',
  'invalid-doi',
  '10.9999/does-not-exist'
]);

if (!res.ok) {
  // Whole-batch failure: all inputs failed, or options/rename map are invalid
  console.error('Batch failed:', res.error.code, res.error.message);
} else {
  const { works, errors, requests, budget } = res.data;

  // Resolved works (keyed by original input string)
  for (const [doi, work] of Object.entries(works)) {
    if (work === null) {
      console.log(`${doi} not found in OpenAlex (HTTP 404)`);
    } else {
      console.log(`${doi} -> ${work.record.id}: ${work.record.title}`);
    }
  }

  // Failed inputs (keyed by original input string)
  for (const [doi, error] of Object.entries(errors)) {
    console.error(`${doi} failed: ${error.code} (${error.message})`);
  }

  console.log(requests); // { list: 1, single: 1 }
  console.log(budget);   // summed cost and remaining budget headers
}
```

### Batch Behavior

- **Clean partition**: Every input string appears in either `works` or `errors`, never both.
- **404 is an answer, not an error**: Works not found in OpenAlex yield `works[input] === null`.
- **Validation failures**: Inputs that fail validation (`INVALID_DOI`, `INVALID_ID`) are placed directly into `errors[input]` without making a network call.
- **No partial records**: If OpenAlex truncates an author list or location array at 100 entries in a list response, the client automatically refetches the complete record individually. If that refetch fails, the input is placed into `errors`, never returning truncated data.
- **List queries & pagination**: Up to 100 values per filter request (1 credit per page). When queries match multiple works or versions (e.g. preprints and published works), pages are automatically traversed and counted in `requests.list` and `budget`.
- **Local matching**: Results are matched back to inputs by canonical work ID or DOI (including secondary DOIs in `locations`).
- **Disambiguation**: If a DOI matches multiple records, the work whose primary DOI matches is preferred, followed by citation count and lowest work ID.
- **Deduplication**: Inputs normalizing to the same identifier share a single request. Keys in `works` and `errors` preserve original input strings.
- **Fallbacks**: DOIs with characters unsupported by filter syntax (commas, pipes, spaces) and keys missed by list queries automatically fall back to individual single lookups.
- **Batch options**:
  - `strategy: 'batch' | 'single'` (default `'batch'`): `'single'` bypasses list queries entirely, resolving each item via free individual lookups.
  - `fallbackOnRateLimit: boolean` (default `false`): When `true`, if a list query fails with `RATE_LIMITED` (e.g. daily budget exhausted), remaining keys automatically fall back to free single lookups.
  - `singleBelow: number` (default `0`): Sends any batch chunk with fewer than `n` keys as free single lookups instead of a paid list request (e.g. `singleBelow: 30` with 110 DOIs runs 1 list query of 100 and 10 single lookups).
- **Batch-level failures (`res.ok === false`)**: Occurs when options or rename maps are invalid (`INVALID_OPTIONS`, `INVALID_RENAME`, `RENAME_COLLISION`), or when all inputs fail (none in `works`). Returns the error shared by most inputs with aggregated `budget` data.

## Full-Text Downloads and Budget

OpenAlex hosts full-text PDFs and TEI XML for approximately 60 million open-access works. Downloads require an API key (a free key provides $1/day ≈ 100 downloads).

```ts
import { writeFile } from 'node:fs/promises';
import { createOpenAlex } from '@smart-science/openalex';

const oa = createOpenAlex({ apiKey: process.env.OPENALEX_API_KEY });

// The content endpoint requires an OpenAlex work ID (W...)
const work = await oa.fetchDoi('10.1585/pfr.15.2402039');

if (work.ok && work.data.record.has_content_pdf) {
  const content = await oa.fetchContent(work.data.record.id);

  if (content.ok) {
    await writeFile('paper.pdf', content.data.pdf); // content.data.pdf is Uint8Array
    console.log('Download cost:', content.data.budget?.cost_usd); // $0.01
  }
}

// Download TEI XML
const tei = await oa.fetchContent('W3038568908', { format: 'xml' });
if (tei.ok) {
  console.log(tei.data.xml); // tei.data.xml is string
}

// Check remaining daily credit (free API call)
const budget = await oa.fetchBudget();
if (budget.ok) {
  console.log(`Remaining budget: $${budget.data.daily_remaining_usd}`);
  console.log(`Resets at: ${budget.data.resets_at}`);
}
```

- `fetchContent(workId, options?)`:
  - `workId`: Must be a valid OpenAlex work ID. Passing a DOI fails immediately with `INVALID_ID`.
  - `options.format`: `'pdf'` (default) or `'xml'`.
  - When `format: 'pdf'`, `data.pdf` is `Uint8Array` and `data.xml` is `null`.
  - When `format: 'xml'`, `data.xml` is `string` and `data.pdf` is `null`.
  - Successful downloads cost $0.01 from your daily budget. Missing full text returns HTTP 404 (`NO_CONTENT`) and is unbilled.
- `fetchBudget(options?)`:
  - Queries `GET /rate-limit` free of charge. Requires an API key.
  - Returns `BudgetStatus`: `{ daily_budget_usd, daily_used_usd, daily_remaining_usd, prepaid_remaining_usd, resets_at, resets_in_seconds }`.

## Flattened Work Record

The `record` object flattens the nested OpenAlex data structure into a consistent, predictable schema:

- **Underscore joining**: Nested objects are joined with underscores to any depth (e.g. `primary_location_source_display_name`, `biblio_first_page`, `open_access_oa_status`).
- **Bare identifiers**: URLs are stripped from identifiers (`id: 'W2741809807'`, `doi: '10.1038/...'`, `ids_pmid`, `authorships[i].author_id`, `topics[i].id`).
- **Automatic abstract reconstruction**: The inverted index is decoded into a clean string on `record.abstract`.
- **Convenience fields**:
  - `abstract`: plaintext abstract (`string | null`).
  - `authors`: list of author display names (`readonly string[]`).
  - `authors_detailed`: array of `AuthorRecord` objects (`name`, `orcid`, `position`, `is_corresponding`, `affiliations`, `countries`).
  - `first_author`: first author display name (`string | null`).
  - `journal`: primary venue name (`string | null`).
  - `source_type`: publication source type (`string | null`, e.g. `'journal'`, `'repository'`).
  - `pages`: formatted page range or single page (`string | null`).
  - `oa_locations`: complete array of open-access locations (`readonly OaLocationRecord[]`), including landing pages, PDF URLs, licenses, and versions.
  - `keyword_names`, `topic_names`, `mesh_terms`, `funder_names`: deduplicated string arrays.
- **Author alignment**: `authors` and `authors_detailed` exclude unnamed entries, ensuring index alignment (`authors[i] === authors_detailed[i].name`). The complete raw list is preserved in `authorships`. `first_author` provides the primary author's display name or `null`.
- **Raw payload**: The complete, untouched upstream API response is provided in `raw`.

## Field Renaming

Rename canonical fields to match your internal naming conventions:

```ts
const res = await openalex.fetchDoi('10.1038/nature12373', {
  rename: {
    paper_title: 'title',
    published_year: 'publication_year',
  },
});

if (res.ok) {
  res.data.record.paper_title;    // string | null (typed)
  res.data.record.published_year; // number | null (typed)
  res.data.record.journal;        // string | null (unmapped fields retained)
  // @ts-expect-error — remapped fields are removed from the type
  res.data.record.title;
}
```

- Renaming can be configured client-wide via `createOpenAlex` or per-call in `fetchDoi` and `fetchWorkById`.
- Maps are validated at compile time and runtime: unknown source fields produce `INVALID_RENAME`, and targets that collide with existing unmapped fields produce `RENAME_COLLISION`.
- Multiple new names can map to the same source field.
- Renaming applies to top-level `WorkRecord` properties.
- **Shared semantic map**: `SEMANTIC_MAP` renames a record to the field names shared with smart-ris records (`year`, `container_title`, `openalex_id`, …). Pass it as `rename`, or spread it into your own map for special cases: `rename: { ...SEMANTIC_MAP, ref_title: "title" }`.

## Rate Limiting and Queues

All requests pass through two internal queues managed by `smart-limit`:

- **`free` lane**: Single lookups, batch fallbacks, refetches, and `fetchBudget`.
- **`paid` lane**: Batch list requests and `fetchContent` downloads.

Both lanes share global concurrency and rate limits while maintaining independent lockout states: when your daily budget is exhausted, paid requests pause while free lookups continue uninterrupted.

### Limiter Configuration

Configure limits on `createOpenAlex` (limits are set per client, not per call):

| Option | Default | Description |
|---|---|---|
| `limits.rps` | 25 (with key) / 8 (without key) | Requests per second |
| `limits.concurrency` | 10 | Maximum requests in flight |
| `limits.rpm` | unset | Requests per minute |
| `limits.rpd` | unset | Requests per day |
| `limits.buckets` | unset | Custom `smart-limit` rate-limiting buckets |
| `limiterOptions.maxRetries` | 4 | Retries for HTTP 408, 425, 500 and other 5xx (502/503/504 pause the lane instead) |
| `limiterOptions.retryDelayMs` | 2000 ms (2 s) | Base exponential backoff delay |
| `limiterOptions.maxRetryDelayMs` | 300000 ms (5 min) | Maximum exponential backoff delay |
| `limiterOptions.maxWaitMs` | 300000 ms (5 min) | Maximum single 429 or local-limit wait, lane pause without a successful request, or total retry backoff of one request before failing (not the time spent queued behind earlier calls) |

### Resiliency and Retry Logic

- **HTTP 429 (`RATE_LIMITED`)**: Pauses the affected lane for `retryAfterSeconds` before retrying. Pauses do not count against `maxRetries` and are capped by `maxWaitMs`. Requests rejected while a queue is paused fail immediately without issuing network calls, reporting the remaining pause time in `retryAfterSeconds`.
- **Outages (Network errors, timeouts, HTTP 502/503/504)**: Pauses the lane and sends single probe requests with exponential backoff until the service recovers.
- **Transient server errors (HTTP 408, 425, 500, 5xx)**: Retried individually with exponential backoff up to `maxRetries` times without pausing the entire lane.
- **Client errors (400, 401, 404, etc.)**: Return immediately without retrying.

## Timeouts and Cancellation

- **Timeouts**: Default to **10 seconds** for metadata requests (`fetchDoi`, `fetchWorkById`, `fetchBudget`) and **60 seconds** for content downloads (`fetchContent`). Overridable via `timeoutMs` at client creation or per call.
- **Cancellation**: Supports `AbortSignal` at both client and per-call levels:

```ts
const controller = new AbortController();
const res = await openalex.fetchDoi('10.1038/nature12373', {
  signal: controller.signal
});

// controller.abort() -> { ok: false, error: { code: 'ABORTED', ... } }
```

Client-level and call-level signals are combined automatically without memory leaks. Cancelled requests exit the queue immediately with `ABORTED`.

## Options Reference

### Client Factory Options (`createOpenAlex`)

```ts
const openalex = createOpenAlex({
  apiKey: 'YOUR_KEY',
  timeoutMs: 15_000,
  limits: { rps: 20, concurrency: 8 },
  limiterOptions: { maxRetries: 3 },
  strategy: 'batch',
  fallbackOnRateLimit: false,
});
```

- `apiKey?: string`: OpenAlex API key.
- `timeoutMs?: number`: Default request timeout in milliseconds.
- `signal?: AbortSignal`: Cancellation signal for all client operations; a per-call `signal` applies in addition to it.
- `fetchFn?: typeof fetch`: Custom fetch implementation (e.g. for mocking or proxies).
- `rename?: RenameMap`: Client-wide default field rename map.
- `strategy?: 'batch' | 'single'`: Default lookup strategy for array queries.
- `fallbackOnRateLimit?: boolean`: Default batch fallback behavior when encountering a 429.
- `singleBelow?: number`: Default threshold below which a list chunk is sent as single lookups (non-negative integer, default `0`).
- `limits?: OpenAlexLimits`: Rate and concurrency limits.
- `limiterOptions?: OpenAlexLimiterOptions`: Retry and backoff parameters.

`createOpenAlex` throws `TypeError` (with the underlying `OpenAlexError` attached to `.cause`) if configuration is invalid.

### Per-Call Options

Methods accept per-call overrides:

- **`fetchDoi` / `fetchWorkById`**: `timeoutMs`, `signal`, `fetchFn`, `rename`, `strategy`, `fallbackOnRateLimit`, `singleBelow`.
- **`fetchContent`**: `timeoutMs`, `signal`, `fetchFn`, `format`.
- **`fetchBudget`**: `timeoutMs`, `signal`, `fetchFn`.

## Error Handling

All failures return `{ ok: false, error: OpenAlexError }`. Every error contains seven properties:

```ts
type OpenAlexError<C extends OpenAlexErrorCode> = {
  readonly code: C;
  readonly message: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly budget: Budget | null;
  readonly cause: unknown;
};
```

`budget` reflects the upstream `X-RateLimit-*` headers when returned (failed requests such as HTTP 404 are still billed by OpenAlex). Requests rejected locally while a queue is paused inherit the last received budget with `cost_usd: null`.

- `retryable`: `true` for `NETWORK`, `TIMEOUT`, `RATE_LIMITED`, and HTTP 408, 425, and 5xx errors.
- `cause`: The underlying error or exception, if any.

### Error Codes

| Code | Cause |
|---|---|
| `INVALID_DOI` | Input string cannot be normalized to a valid DOI. No request sent. |
| `INVALID_ID` | Input is not a valid OpenAlex work ID (e.g. `W2741809807`). No request sent. |
| `INVALID_OPTIONS` | An invalid option was provided, or `apiKey` was missing for content/budget calls. |
| `INVALID_RENAME` | Rename map specifies an unknown canonical field name. |
| `RENAME_COLLISION` | Rename target collides with an existing unmapped field. |
| `NOT_FOUND` | HTTP 404 — OpenAlex has no record for that identifier (single lookup only; in array lookups not-found items yield `works[input] === null`). |
| `NO_CONTENT` | HTTP 404 from `fetchContent` — full-text PDF or XML is unavailable for this work. Unbilled. |
| `RATE_LIMITED` | HTTP 429 or local limit wait exceeding `maxWaitMs`. `retryAfterSeconds` provides the required delay before retrying. |
| `AUTH` | HTTP 401 or 403 — invalid or missing API key. |
| `HTTP` | Non-2xx response not covered by specific codes; `message` includes response body snippet. |
| `NETWORK` | Network connection failure, DNS resolution error, or queue lane paused during an upstream outage. |
| `TIMEOUT` | Request exceeded `timeoutMs`. |
| `ABORTED` | Request was aborted by an `AbortSignal`. |
| `PARSE` | 2xx response body could not be parsed into expected data. |

```ts
if (!res.ok) {
  if (res.error.code === 'NOT_FOUND') {
    // Identifier is not in OpenAlex
  } else if (res.error.retryable) {
    // Retry later after res.error.retryAfterSeconds
  } else {
    // Fatal error (AUTH, INVALID_DOI, PARSE, etc.)
  }
}
```

## Utility Functions

The package also exports standalone utilities and constants:

```ts
import {
  normalizeDoi,
  normalizeWorkId,
  reconstructAbstract,
  toWorkRecord,
  applyRename,
  isFieldName,
  FIELD_NAMES,
  PACKAGE_VERSION
} from '@smart-science/openalex';

// Normalize identifiers
normalizeDoi('https://doi.org/10.1038/nature12373'); // '10.1038/nature12373'
normalizeWorkId('https://openalex.org/W2159974629');  // 'W2159974629'

// Reconstruct abstract from inverted index
reconstructAbstract({ Hello: [0], world: [1] });      // 'Hello world'

// Convert raw API response to WorkRecord (null when the input is not a work object)
const record = toWorkRecord(rawApiWork);

// Runtime check for canonical field names
isFieldName('primary_location_source_display_name');  // true
```

## Scope and Design Boundaries

This package focuses on reliable retrieval, normalization, and flattening of OpenAlex records. It deliberately does not perform:

- RIS parsing or reference file validation
- Internal database persistence or caching
- Search endpoint querying
- Automatic DOI-to-work-ID resolution inside `fetchContent`
- Writing downloaded files directly to disk
- Reading environment variables or `.env` files automatically

## License

[Apache-2.0](LICENSE)
