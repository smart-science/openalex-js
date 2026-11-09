// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { asNumber, asObject, asText } from '../utils/values.js';
import type { BudgetStatus } from './types.js';

// -------------------------------------------------------------------
// --- 1. Exported Functions
// -------------------------------------------------------------------

/** Transforms raw rate-limit response body into canonical BudgetStatus. */
export function toBudgetStatus(body: unknown): BudgetStatus | null {
    const rateLimit = asObject(asObject(body)?.rate_limit);
    if (rateLimit === null) {
        return null;
    }
    return {
        daily_budget_usd: asNumber(rateLimit.daily_budget_usd),
        daily_used_usd: asNumber(rateLimit.daily_used_usd),
        daily_remaining_usd: asNumber(rateLimit.daily_remaining_usd),
        prepaid_remaining_usd: asNumber(rateLimit.prepaid_remaining_usd),
        resets_at: asText(rateLimit.resets_at),
        resets_in_seconds: asNumber(rateLimit.resets_in_seconds),
    };
}
