// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { BatchData, BatchResult } from '../../src/batch/types.js';
import type {
    BudgetCallOptions,
    ContentCallOptions,
    DoiCallOptions,
    FetchContent,
    FetchDoi,
    OpenAlex,
    OpenAlexOptions,
    WorkData,
    WorkIdData,
} from '../../src/client.js';
import { createOpenAlex } from '../../src/client.js';
import type {
    Budget,
    BudgetStatus,
    ContentData,
    ContentFormat,
    PdfContent,
    XmlContent,
} from '../../src/content/types.js';
import type {
    FetchBudgetErrorCode,
    FetchContentErrorCode,
    FetchDoiErrorCode,
    FetchWorkErrorCode,
    OpenAlexError,
    OpenAlexErrorCode,
} from '../../src/utils/errors.js';
import { createError } from '../../src/utils/errors.js';
import type { Err, Ok, Result } from '../../src/utils/result.js';
import type { OpenAlexWork, WorkVersion } from '../../src/work/api-types.js';
import type {
    AuthorRecord,
    DerivedDoNotCollide,
    FieldName,
    FieldNamesAreExhaustive,
    OaLocationRecord,
    SchemaNestedIsExhaustive,
    SchemaTopLevelIsExhaustive,
    WorkRecord,
} from '../../src/work/record-types.js';
import { type FIELD_NAMES, isFieldName } from '../../src/work/record-types.js';
import { applyRename, type Renamed, type RenameMap } from '../../src/work/rename.js';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Not<T extends false> = T;

type _Identifiers = [
    Expect<Equal<WorkRecord['id'], string>>,
    Expect<Equal<WorkRecord['doi'], string | null>>,
    Expect<Equal<WorkRecord['ids_pmid'], string | null>>,
    Expect<Equal<WorkRecord['ids_pmcid'], string | null>>,
    Expect<Equal<WorkRecord['ids_openalex'], string | null>>,
    Expect<Equal<WorkRecord['referenced_works'], readonly string[]>>,
    Expect<Equal<WorkRecord['related_works'], readonly string[]>>,
];

type _Bibliographic = [
    Expect<Equal<WorkRecord['title'], string | null>>,
    Expect<Equal<WorkRecord['abstract'], string | null>>,
    Expect<Equal<WorkRecord['type'], string | null>>,
    Expect<Equal<WorkRecord['language'], string | null>>,
    Expect<Equal<WorkRecord['publication_year'], number | null>>,
    Expect<Equal<WorkRecord['publication_date'], string | null>>,
];

type _Authorship = [
    Expect<Equal<WorkRecord['authors'], readonly string[]>>,
    Expect<Equal<WorkRecord['authors_detailed'], readonly AuthorRecord[]>>,
    Expect<Equal<WorkRecord['first_author'], string | null>>,
    Expect<Equal<AuthorRecord['position'], 'first' | 'middle' | 'last'>>,
    Expect<Equal<AuthorRecord['is_corresponding'], boolean>>,
    Expect<Equal<AuthorRecord['affiliations'], readonly string[]>>,
    Expect<Equal<AuthorRecord['countries'], readonly string[]>>,
    Expect<Equal<AuthorRecord['orcid'], string | null>>,
];

type _OpenAccess = [
    Expect<Equal<WorkRecord['open_access_is_oa'], boolean>>,
    Expect<Equal<WorkRecord['open_access_oa_status'], string | null>>,
    Expect<Equal<WorkRecord['oa_locations'], readonly OaLocationRecord[]>>,
    Expect<Equal<OaLocationRecord['is_published'], boolean | null>>,
    // The record type never narrows to the raw enum.
    Expect<Equal<OaLocationRecord['version'], string | null>>,
    Not<Equal<OaLocationRecord['version'], WorkVersion | null>>,
];

type _Metrics = [
    Expect<Equal<WorkRecord['cited_by_count'], number | null>>,
    Expect<Equal<WorkRecord['referenced_works_count'], number | null>>,
    Expect<Equal<WorkRecord['fwci'], number | null>>,
    Expect<Equal<WorkRecord['is_retracted'], boolean>>,
    Expect<Equal<WorkRecord['is_paratext'], boolean>>,
    Expect<Equal<WorkRecord['is_traditional'], boolean>>,
    Expect<Equal<WorkRecord['is_xpac'], boolean>>,
    Expect<Equal<WorkRecord['keyword_names'], readonly string[]>>,
    Expect<Equal<WorkRecord['mesh_terms'], readonly string[]>>,
    Expect<Equal<WorkRecord['funder_names'], readonly string[]>>,
    Expect<Equal<WorkRecord['primary_location_source_issn'], readonly string[]>>,
];

type _FieldNames = [
    Expect<Equal<FieldName, keyof WorkRecord>>,
    Expect<Equal<FieldName, (typeof FIELD_NAMES)[number]>>,
    FieldNamesAreExhaustive,
    DerivedDoNotCollide,
    SchemaTopLevelIsExhaustive,
    ...SchemaNestedIsExhaustive,
];

declare const record: WorkRecord;

// @ts-expect-error WorkRecord fields are readonly
record.title = 'mutated';

// @ts-expect-error WorkRecord has no such field
record.titel;

// @ts-expect-error openalexId is removed in favor of id
record.openalexId;

// @ts-expect-error doiUrl is removed in favor of doi
record.doiUrl;

declare const someString: string;
if (isFieldName(someString)) {
    type _Narrowed = Expect<Equal<typeof someString, FieldName>>;
}

type _ErrorShape = [
    Expect<
        Equal<
            keyof OpenAlexError,
            'code' | 'message' | 'status' | 'retryable' | 'retryAfterSeconds' | 'cause' | 'budget'
        >
    >,
    Expect<Equal<OpenAlexError['budget'], Budget | null>>,
    Expect<Equal<OpenAlexError['retryable'], boolean>>,
    Expect<Equal<OpenAlexError['status'], number | null>>,
    Expect<Equal<OpenAlexError['retryAfterSeconds'], number | null>>,
    Expect<Equal<OpenAlexError['cause'], unknown>>,
    Expect<Equal<OpenAlexError['code'], OpenAlexErrorCode>>,
];

type _CodeUnion = Expect<
    Equal<
        OpenAlexErrorCode,
        | 'INVALID_DOI'
        | 'INVALID_ID'
        | 'INVALID_RENAME'
        | 'RENAME_COLLISION'
        | 'INVALID_OPTIONS'
        | 'NOT_FOUND'
        | 'NO_CONTENT'
        | 'RATE_LIMITED'
        | 'AUTH'
        | 'HTTP'
        | 'NETWORK'
        | 'TIMEOUT'
        | 'ABORTED'
        | 'PARSE'
    >
>;

function describeCode(code: OpenAlexErrorCode): string {
    switch (code) {
        case 'INVALID_DOI':
            return 'bad doi';
        case 'INVALID_ID':
            return 'bad work id';
        case 'NO_CONTENT':
            return 'no file';
        case 'INVALID_RENAME':
            return 'bad rename';
        case 'RENAME_COLLISION':
            return 'colliding rename';
        case 'INVALID_OPTIONS':
            return 'bad options';
        case 'NOT_FOUND':
            return 'missing';
        case 'RATE_LIMITED':
            return 'slow down';
        case 'AUTH':
            return 'auth';
        case 'HTTP':
            return 'http';
        case 'NETWORK':
            return 'network';
        case 'TIMEOUT':
            return 'timeout';
        case 'ABORTED':
            return 'aborted';
        case 'PARSE':
            return 'parse';
        default: {
            const exhaustive: never = code;
            return exhaustive;
        }
    }
}

const _correctArgs: OpenAlexError = createError('HTTP', { status: 503, body: 'x' });
const _withCause: OpenAlexError = createError('NETWORK', { reason: 'x' }, new Error('boom'));

// @ts-expect-error HTTP requires a body as well as a status
createError('HTTP', { status: 503 });

// @ts-expect-error NOT_FOUND takes a doi, not an input
createError('NOT_FOUND', { input: 'x' });

// @ts-expect-error the args bag is required
createError('TIMEOUT');

// @ts-expect-error there is no such code
createError('NOPE', {});

// @ts-expect-error RATE_LIMITED needs retryAfterSeconds, even when it is null
createError('RATE_LIMITED', { status: 429 });

type _Result = [
    Expect<Equal<Err, { readonly ok: false; readonly error: OpenAlexError }>>,
    Expect<Equal<Ok<number>, { readonly ok: true; readonly data: number }>>,
    Expect<Equal<Result<number>, Ok<number> | Err>>,
    Expect<
        Equal<
            WorkData<WorkRecord>,
            {
                readonly requestedDoi: string;
                readonly record: WorkRecord;
                readonly raw: OpenAlexWork;
                readonly budget: Budget | null;
            }
        >
    >,
];

type _SameErrorBranch = Expect<
    Equal<
        Extract<Result<WorkData<WorkRecord>>, { ok: false }>,
        Extract<Result<WorkData<Renamed<{ ref_title: 'title' }>>>, { ok: false }>
    >
>;

type SampleMap = { ref_title: 'title'; ref_year: 'publication_year' };
type Sample = Renamed<SampleMap>;

type DupMap = { a: 'title'; b: 'title' };
type DupSample = Renamed<DupMap>;

type _Renamed = [
    // types are preserved
    Expect<Equal<Sample['ref_title'], string | null>>,
    Expect<Equal<Sample['ref_year'], number | null>>,
    // unmapped fields survive with canonical names
    Expect<Equal<Sample['journal'], string | null>>,
    Expect<Equal<Sample['oa_locations'], readonly OaLocationRecord[]>>,
    // old names are gone
    Expect<Equal<'title' extends keyof Sample ? true : false, false>>,
    Expect<Equal<'publication_year' extends keyof Sample ? true : false, false>>,
    // duplicate targets compile and work
    Expect<Equal<DupSample['a'], string | null>>,
    Expect<Equal<DupSample['b'], string | null>>,
];

declare const sample: Sample;

// @ts-expect-error `title` was renamed away (a type error, not a throw)
sample.title;

// @ts-expect-error `publicationYear` was renamed away
sample.publicationYear;

type Swapped = Renamed<{ title: 'doi'; doi: 'title' }>;
type _Swapped = [Expect<Equal<Swapped['title'], string | null>>, Expect<Equal<Swapped['doi'], string | null>>];

type ManyToOne = Renamed<{ t1: 'title'; t2: 'title' }>;
type _ManyToOne = [
    Expect<Equal<ManyToOne['t1'], string | null>>,
    Expect<Equal<ManyToOne['t2'], string | null>>,
    Expect<Equal<'title' extends keyof ManyToOne ? true : false, false>>,
];

type _EmptyMap = Expect<Equal<keyof Renamed<Record<never, never>>, keyof WorkRecord>>;

const widened = { db_doi: 'doi' };
// @ts-expect-error values widen to `string` without `satisfies RenameMap` or `as const`
const _m1: RenameMap = widened;

const m2 = { db_doi: 'doi' } satisfies RenameMap;
const m3 = { db_doi: 'doi' } as const satisfies RenameMap;
const _m2: RenameMap = m2;
const _m3: RenameMap = m3;

// @ts-expect-error `titel` is not a FieldName
const _m4: RenameMap = { db_title: 'titel' } satisfies RenameMap;

declare const doi: string;

async function overloads(): Promise<void> {
    const oa = createOpenAlex();
    const plain = await oa.fetchDoi(doi);
    if (plain.ok) {
        type _Plain = [
            Expect<Equal<typeof plain.data.record, WorkRecord>>,
            Expect<Equal<typeof plain.data.raw, OpenAlexWork>>,
            Expect<Equal<typeof plain.data.record.title, string | null>>,
        ];
    } else {
        type _PlainErr = [
            Expect<Equal<typeof plain.error, OpenAlexError<FetchDoiErrorCode>>>,
            // fetchDoi cannot produce a content error, so a switch on it never offers one
            Not<Equal<Extract<typeof plain.error.code, 'NO_CONTENT' | 'INVALID_ID'>, 'NO_CONTENT' | 'INVALID_ID'>>,
            Expect<Equal<Extract<typeof plain.error.code, 'NO_CONTENT' | 'INVALID_ID'>, never>>,
        ];
    }

    const renamed = await oa.fetchDoi(doi, { rename: { ref_title: 'title' } });
    if (renamed.ok) {
        type _Renamed = [
            Expect<Equal<typeof renamed.data.record.ref_title, string | null>>,
            Expect<Equal<typeof renamed.data.raw, OpenAlexWork>>,
        ];
        // @ts-expect-error `title` was renamed away
        renamed.data.record.title;
    }

    const viaVariable = await oa.fetchDoi(doi, { rename: m2 });
    if (viaVariable.ok) {
        type _ViaVariable = Expect<Equal<typeof viaVariable.data.record.db_doi, string | null>>;
    }

    // @ts-expect-error `titel` is not a valid source field name
    await oa.fetchDoi(doi, { rename: { ref_title: 'titel' } });

    // @ts-expect-error timeoutMs must be a number
    await oa.fetchDoi(doi, { timeoutMs: '10' });

    // @ts-expect-error there is no such option
    await oa.fetchDoi(doi, { retries: 3 });

    // @ts-expect-error the DOI is required
    await oa.fetchDoi();

    // @ts-expect-error the DOI must be a string
    await oa.fetchDoi(42);

    // Possibly-undefined values are assignable under exactOptionalPropertyTypes.
    const timeoutMs = 1 as number | undefined;
    const signal = undefined as AbortSignal | undefined;
    const format = undefined as 'pdf' | undefined;
    await oa.fetchDoi(doi, { timeoutMs, signal });
    await createOpenAlex({ timeoutMs }).fetchContent('W1', { format });
}

type _Options = [
    Expect<Equal<OpenAlexOptions['apiKey'], string | undefined>>,
    Expect<Equal<DoiCallOptions['timeoutMs'], number | undefined>>,
    Expect<Equal<DoiCallOptions['fetchFn'], typeof fetch | undefined>>,
    Expect<Equal<DoiCallOptions['signal'], AbortSignal | undefined>>,
    // `rename` is not part of the declared options types — it only travels via RenameOptions<M>.
    Expect<Equal<'rename' extends keyof DoiCallOptions ? true : false, false>>,
    Expect<Equal<'rename' extends keyof OpenAlexOptions ? true : false, false>>,
    // the key is a factory option only
    Expect<Equal<'apiKey' extends keyof DoiCallOptions ? true : false, false>>,
];

type IndexExports = keyof typeof import('../../src/index.js');
type _NoStandaloneExports = [
    Expect<Equal<Extract<IndexExports, 'fetchDoi' | 'fetchWorkById' | 'fetchContent' | 'fetchBudget'>, never>>,
    Expect<Equal<Extract<IndexExports, 'createOpenAlex'>, 'createOpenAlex'>>,
];

type _Factory = [
    Expect<Equal<OpenAlex['fetchDoi'], FetchDoi<WorkRecord, DoiCallOptions>>>,
    Expect<Equal<keyof OpenAlex, 'fetchDoi' | 'fetchWorkById' | 'fetchContent' | 'fetchBudget'>>,
    Expect<Equal<OpenAlex<WorkRecord>, OpenAlex>>,
    Expect<
        Equal<
            keyof DoiCallOptions,
            'timeoutMs' | 'signal' | 'fetchFn' | 'strategy' | 'fallbackOnRateLimit' | 'singleBelow'
        >
    >,
    Expect<Equal<keyof ContentCallOptions, 'timeoutMs' | 'signal' | 'fetchFn' | 'format'>>,
    Expect<Equal<keyof BudgetCallOptions, 'timeoutMs' | 'signal' | 'fetchFn'>>,
];

type _FlatRecordTypes = [
    Expect<Equal<WorkRecord['primary_location_source_display_name'], string | null>>,
    Expect<Equal<WorkRecord['has_content_pdf'], boolean>>,
    Expect<Equal<WorkRecord['best_oa_location_is_oa'], boolean | null>>,
    Expect<Equal<WorkRecord['authorships'][number]['author_display_name'], string | null>>,
];

async function contentTyping(): Promise<void> {
    const oa = createOpenAlex({ apiKey: 'KEY' });

    const byDefault = await oa.fetchContent('W1');
    if (byDefault.ok) {
        type _Pdf = [
            Expect<Equal<typeof byDefault.data, PdfContent>>,
            Expect<Equal<typeof byDefault.data.pdf, Uint8Array>>,
            Expect<Equal<typeof byDefault.data.xml, null>>,
            Expect<Equal<typeof byDefault.data.budget, Budget | null>>,
        ];
    }

    const xml = await oa.fetchContent('W1', { format: 'xml' });
    if (xml.ok) {
        type _Xml = [
            Expect<Equal<typeof xml.data, XmlContent>>,
            Expect<Equal<typeof xml.data.xml, string>>,
            Expect<Equal<typeof xml.data.pdf, null>>,
        ];
    }

    const format = 'pdf' as ContentFormat;
    const either = await oa.fetchContent('W1', { format });
    if (either.ok) {
        type _Either = Expect<Equal<typeof either.data, ContentData>>;
        if (either.data.pdf) {
            type _Narrowed = Expect<Equal<typeof either.data.xml, null>>;
        } else {
            type _Narrowed = Expect<Equal<typeof either.data.xml, string>>;
        }
    }

    const budget = await oa.fetchBudget();
    if (budget.ok) {
        type _Budget = Expect<Equal<typeof budget.data, BudgetStatus>>;
    } else {
        type _BudgetErr = Expect<Equal<typeof budget.error.code, FetchBudgetErrorCode>>;
    }

    if (!byDefault.ok) {
        type _ContentErr = [
            Expect<Equal<typeof byDefault.error.code, FetchContentErrorCode>>,
            Expect<Equal<Extract<typeof byDefault.error.code, 'NOT_FOUND' | 'INVALID_DOI'>, never>>,
        ];
    }

    // @ts-expect-error the key is set once, at createOpenAlex()
    await oa.fetchContent('W1', { apiKey: 'OTHER' });

    // @ts-expect-error the key is set once, at createOpenAlex()
    await oa.fetchDoi(doi, { apiKey: 'OTHER' });

    // @ts-expect-error the OpenAlex endpoints are fixed
    await oa.fetchDoi(doi, { baseUrl: 'https://other.test' });
    // @ts-expect-error the OpenAlex endpoints are fixed
    createOpenAlex({ contentBaseUrl: 'https://other-content.test' });

    // @ts-expect-error the key is set once, at createOpenAlex()
    await oa.fetchBudget({ apiKey: 'OTHER' });

    // @ts-expect-error only pdf and xml exist
    await oa.fetchContent('W1', { format: 'tei' });

    // @ts-expect-error fetchContent has no rename map
    await oa.fetchContent('W1', { rename: { ref_title: 'title' } });

    // The per-call options of the client's fetchDoi still take a rename map.
    const renamed = await oa.fetchDoi(doi, { rename: { ref_title: 'title' } });
    if (renamed.ok) {
        type _Renamed = Expect<Equal<typeof renamed.data.record.ref_title, string | null>>;
    }

    // A key typed `string | undefined` (e.g. from process.env) is accepted; a missing key is a runtime error.
    const envKey: string | undefined = Math.random() > 0.5 ? 'KEY' : undefined;
    const fromEnv = createOpenAlex({ apiKey: envKey });
    type _FromEnv = Expect<Equal<typeof fromEnv.fetchContent, FetchContent>>;
}

async function renameTyping(): Promise<void> {
    const oa = createOpenAlex();

    // A map hidden behind the declared options type is rejected instead of typing `data.record` as WorkRecord.
    // @ts-expect-error `rename` does not exist on DoiCallOptions
    const _stored: DoiCallOptions = { rename: { ref_title: 'title' } };
    // @ts-expect-error `rename` does not exist on OpenAlexOptions
    const _storedFactory: OpenAlexOptions = { rename: { ref_title: 'title' } };

    // Options stored in a variable WITHOUT a declared type keep the literal map and type correctly.
    const storedOptions = { timeoutMs: 5_000, rename: { ref_title: 'title' } } as const;
    const viaStoredOptions = await oa.fetchDoi(doi, storedOptions);
    if (viaStoredOptions.ok) {
        type _Stored = Expect<Equal<typeof viaStoredOptions.data.record.ref_title, string | null>>;
        // @ts-expect-error `title` was renamed away
        viaStoredOptions.data.record.title;
    }

    // A plain options object still types as WorkRecord.
    const plainOptions: DoiCallOptions = { timeoutMs: 5_000 };
    const viaPlainOptions = await oa.fetchDoi(doi, plainOptions);
    if (viaPlainOptions.ok) {
        type _Plain = Expect<Equal<typeof viaPlainOptions.data.record, WorkRecord>>;
    }

    // Non-literal maps: no autocomplete-free guessing — a compile error with a readable message.
    const wide: RenameMap = { ref_title: 'title' };
    // @ts-expect-error keys of a RenameMap-typed variable are not literal
    await oa.fetchDoi(doi, { rename: wide });

    const wideRecord: Record<string, FieldName> = { ref_title: 'title' };
    // @ts-expect-error keys of a Record<string, FieldName> are not literal
    await oa.fetchDoi(doi, { rename: wideRecord });

    const unionValue: { ref_x: FieldName } = { ref_x: 'title' };
    // @ts-expect-error a value that is a union of field names cannot be typed
    await oa.fetchDoi(doi, { rename: unionValue });

    // @ts-expect-error the same guard applies to applyRename
    applyRename(record, wide);

    // Nested keys are not rename sources (arrays stay nested).
    // @ts-expect-error `oaLocations.pdfUrl` is not a FieldName
    await oa.fetchDoi(doi, { rename: { ref_pdf: 'oaLocations.pdfUrl' } });

    // Factory rename maps are tracked.
    const renamingClient = createOpenAlex({ rename: { ref_title: 'title' } });
    type _RenamingClient = Expect<Equal<typeof renamingClient, OpenAlex<Renamed<{ ref_title: 'title' }>>>>;

    const factoryDefault = await renamingClient.fetchDoi(doi);
    if (factoryDefault.ok) {
        type _FactoryDefault = [
            Expect<Equal<typeof factoryDefault.data.record.ref_title, string | null>>,
            Expect<Equal<typeof factoryDefault.data.raw, OpenAlexWork>>,
        ];
        // @ts-expect-error `title` was renamed away by the factory map
        factoryDefault.data.record.title;
    }

    // Destructuring keeps the factory typing.
    const { fetchDoi: bound } = renamingClient;
    const viaBound = await bound(doi, { timeoutMs: 1_000 });
    if (viaBound.ok) {
        type _Bound = Expect<Equal<typeof viaBound.data.record.ref_title, string | null>>;
    }

    // A per-call map replaces the factory map, at runtime and in the type.
    const perCall = await renamingClient.fetchDoi(doi, { rename: { ref_doi: 'doi' } });
    if (perCall.ok) {
        type _PerCall = [
            Expect<Equal<typeof perCall.data.record.ref_doi, string | null>>,
            Expect<Equal<typeof perCall.data.record.title, string | null>>,
            Expect<Equal<'ref_title' extends keyof typeof perCall.data.record ? true : false, false>>,
        ];
    }

    // @ts-expect-error a factory map must be literal too
    createOpenAlex({ rename: wide });

    // A client without a factory map is the plain OpenAlex.
    const plainClient = createOpenAlex({ apiKey: 'KEY' });
    type _PlainClientType = Expect<Equal<typeof plainClient, OpenAlex>>;

    // Array fields stay nested and fully typed, renamed or not.
    const nested = await oa.fetchDoi(doi, { rename: { my_oa_locations: 'oa_locations', people: 'authors_detailed' } });
    if (nested.ok) {
        type _Nested = [
            Expect<Equal<typeof nested.data.record.my_oa_locations, readonly OaLocationRecord[]>>,
            Expect<Equal<typeof nested.data.record.people, readonly AuthorRecord[]>>,
            Expect<Equal<(typeof nested.data.record.my_oa_locations)[number]['pdf_url'], string | null>>,
            Expect<Equal<(typeof nested.data.record.people)[number]['position'], 'first' | 'middle' | 'last'>>,
        ];
    }
}

declare const dois: string[];
declare const frozenDois: readonly string[];
declare const doiOrDois: string | string[];

async function batchTyping(): Promise<void> {
    const oa = createOpenAlex();
    const single = await oa.fetchDoi(doi);
    type _Single = Expect<Equal<typeof single, Result<WorkData<WorkRecord>, FetchDoiErrorCode>>>;

    const many = await oa.fetchDoi(dois);
    type ManyData = Extract<typeof many, { ok: true }>['data'];
    type _Many = [
        Expect<Equal<typeof many, BatchResult<WorkData<WorkRecord>, FetchDoiErrorCode>>>,
        Expect<Equal<ManyData, BatchData<WorkData<WorkRecord>, FetchDoiErrorCode>>>,
        Expect<Equal<ManyData['works'][string], WorkData<WorkRecord> | null>>,
        Expect<Equal<ManyData['errors'][string]['code'], Exclude<FetchDoiErrorCode, 'NOT_FOUND'>>>,
        Expect<Equal<ManyData['requests']['list'], number>>,
    ];
    if (!many.ok) {
        // a 404 is a null work, never the error of an array lookup
        type _ManyError = Expect<Equal<typeof many.error.code, Exclude<FetchDoiErrorCode, 'NOT_FOUND'>>>;
    }

    const frozen = await oa.fetchDoi(frozenDois, { strategy: 'single' });
    type _Frozen = Expect<Equal<typeof frozen, BatchResult<WorkData<WorkRecord>, FetchDoiErrorCode>>>;

    const literal = await oa.fetchDoi(['10.1000/a', '10.1000/b']);
    type _Literal = Expect<Equal<typeof literal, BatchResult<WorkData<WorkRecord>, FetchDoiErrorCode>>>;

    const either = await oa.fetchDoi(doiOrDois);
    type _Either = Expect<
        Equal<
            typeof either,
            Result<WorkData<WorkRecord>, FetchDoiErrorCode> | BatchResult<WorkData<WorkRecord>, FetchDoiErrorCode>
        >
    >;

    const renamedMany = await oa.fetchDoi(dois, { rename: { ref_title: 'title' } });
    const firstRenamed = renamedMany.ok ? renamedMany.data.works['10.1000/a'] : undefined;
    if (firstRenamed) {
        type _RenamedMany = Expect<Equal<typeof firstRenamed.record.ref_title, string | null>>;
        // @ts-expect-error `title` was renamed away
        firstRenamed.record.title;
    }

    const byId = await oa.fetchWorkById('W1');
    type _ById = Expect<Equal<typeof byId, Result<WorkIdData<WorkRecord>, FetchWorkErrorCode>>>;
    if (byId.ok) {
        type _RequestedId = Expect<Equal<typeof byId.data.requestedId, string>>;
        // @ts-expect-error id lookups carry requestedId, not requestedDoi
        byId.data.requestedDoi;
    }

    const byIds = await oa.fetchWorkById(['W1', 'W2']);
    type _ByIds = Expect<Equal<typeof byIds, BatchResult<WorkIdData<WorkRecord>, FetchWorkErrorCode>>>;

    // @ts-expect-error the work id must be a string or an array of strings
    await oa.fetchWorkById(42);

    // @ts-expect-error array items must be strings
    await oa.fetchDoi([42]);

    // @ts-expect-error only batch and single exist
    await oa.fetchDoi(dois, { strategy: 'parallel' });

    const limited = createOpenAlex({ limits: { rps: 5, concurrency: 2 } });
    const clientMany = await limited.fetchWorkById(dois);
    type _ClientMany = Expect<Equal<typeof clientMany, BatchResult<WorkIdData<WorkRecord>, FetchWorkErrorCode>>>;
    const clientOne = await limited.fetchWorkById('W1');
    type _ClientOne = Expect<Equal<typeof clientOne, Result<WorkIdData<WorkRecord>, FetchWorkErrorCode>>>;

    const renamingClient = createOpenAlex({ rename: { ref_id: 'id' } });
    const factoryMany = await renamingClient.fetchDoi(dois);
    type _FactoryMany = Expect<
        Equal<typeof factoryMany, BatchResult<WorkData<Renamed<{ ref_id: 'id' }>>, FetchDoiErrorCode>>
    >;
}

declare const client: OpenAlex;
// @ts-expect-error the client object exposes only fetchDoi, fetchWorkById, fetchContent and fetchBudget
client.fetchDois;

export type { Equal, Expect };
export { batchTyping, contentTyping, describeCode, overloads, renameTyping };
