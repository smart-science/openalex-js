// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Supported full-text download formats. */
export type ContentFormat = 'pdf' | 'xml';

/** Rate limit budget status extracted from response headers. */
export type Budget = {
    /** Request cost in USD (X-RateLimit-Cost-USD). */
    readonly cost_usd: number | null;
    /** Remaining budget in USD after request (X-RateLimit-Remaining-USD). */
    readonly daily_remaining_usd: number | null;
    /** Total daily limit in USD (X-RateLimit-Limit-USD). */
    readonly daily_budget_usd: number | null;
    /** Remaining prepaid balance in USD (X-RateLimit-Prepaid-Remaining-USD). */
    readonly prepaid_remaining_usd: number | null;
    /** Seconds remaining until midnight UTC reset (X-RateLimit-Reset). */
    readonly resets_in_seconds: number | null;
};

type ContentBase = {
    /** Normalized OpenAlex work ID. */
    readonly workId: string;
    /** Budget metadata from response headers or null. */
    readonly budget: Budget | null;
};

/** Downloaded PDF binary content payload. */
export type PdfContent = ContentBase & {
    readonly format: 'pdf';
    /** PDF file bytes in memory. */
    readonly pdf: Uint8Array;
    readonly xml: null;
};

/** Downloaded TEI XML text content payload. */
export type XmlContent = ContentBase & {
    readonly format: 'xml';
    readonly pdf: null;
    /** Decoded TEI XML string. */
    readonly xml: string;
};

/** Discriminated union of downloaded full-text payloads. */
export type ContentData = PdfContent | XmlContent;

/** Daily rate limit and budget status from GET /rate-limit. */
export type BudgetStatus = {
    /** Daily budget cap in USD. */
    readonly daily_budget_usd: number | null;
    /** Consumed budget today in USD. */
    readonly daily_used_usd: number | null;
    /** Remaining daily budget in USD. */
    readonly daily_remaining_usd: number | null;
    /** Remaining prepaid account balance in USD. */
    readonly prepaid_remaining_usd: number | null;
    /** ISO timestamp when daily budget resets. */
    readonly resets_at: string | null;
    /** Seconds until next budget reset. */
    readonly resets_in_seconds: number | null;
};
