// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Rate bucket of `OpenAlexLimits.buckets`, re-exported from smart-limit. */
export type { Bucket } from 'smart-limit';
export type { BatchData, BatchErrorCode, BatchRequests, BatchResult, BatchStrategy } from './batch/types.js';
export type {
    BudgetCallOptions,
    CallOptions,
    ContentCallOptions,
    ContentOptions,
    DoiCallOptions,
    FetchBudget,
    FetchContent,
    FetchDoi,
    FetchWorkById,
    OpenAlex,
    OpenAlexOptions,
    PlainOptions,
    RenameOptions,
    WorkData,
    WorkIdCallOptions,
    WorkIdData,
} from './client.js';
export type {
    Budget,
    BudgetStatus,
    ContentData,
    ContentFormat,
    PdfContent,
    XmlContent,
} from './content/types.js';
export type { OpenAlexLimiterOptions, OpenAlexLimits } from './transport/limiter.js';
export type {
    FetchBudgetErrorCode,
    FetchContentErrorCode,
    FetchDoiErrorCode,
    FetchWorkErrorCode,
    OpenAlexError,
    OpenAlexErrorCode,
    TransportErrorCode,
} from './utils/errors.js';
export type { Err, Ok, Result } from './utils/result.js';
export type {
    AbstractInvertedIndex,
    Apc,
    Authorship,
    AuthorshipAffiliation,
    Award,
    Biblio,
    CitationNormalizedPercentile,
    CitedByPercentileYear,
    Concept,
    ContentUrls,
    CountsByYear,
    DehydratedAuthor,
    DehydratedInstitution,
    DehydratedSource,
    Funder,
    HasContent,
    Keyword,
    MeshTag,
    OaStatus,
    OpenAccess,
    OpenAlexWork,
    StudyDesign,
    SustainableDevelopmentGoal,
    Topic,
    TopicHierarchyEntry,
    WorkIds,
    WorkLocation,
    WorkType,
    WorkVersion,
    WorkVolume,
} from './work/api-types.js';
export type {
    AuthorRecord,
    FieldName,
    FlatAffiliation,
    FlatAuthorship,
    FlatAward,
    FlatConcept,
    FlatCountsByYear,
    FlatFunder,
    FlatInstitution,
    FlatKeyword,
    FlatLocation,
    FlatMesh,
    FlatSdg,
    FlatTopic,
    OaLocationRecord,
    WorkRecord,
} from './work/record-types.js';
export type { Renamed, RenameMap, StrictRenameMap } from './work/rename.js';

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

export { MAX_FILTER_VALUES } from './transport/request.js';
export {
    API_BASE_URL,
    CONTENT_BASE_URL,
    DEFAULT_CONTENT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    PACKAGE_VERSION,
} from './utils/constants.js';
export { FIELD_NAMES } from './work/record-types.js';
export { SEMANTIC_MAP } from './work/semantic-map.js';

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

export { createOpenAlex } from './client.js';
export { normalizeDoi } from './identifiers/doi.js';
export { normalizeWorkId } from './identifiers/work-id.js';
export { reconstructAbstract } from './work/abstract.js';
export { isFieldName } from './work/record-types.js';
export { applyRename } from './work/rename.js';
export { toWorkRecord } from './work/to-record.js';
