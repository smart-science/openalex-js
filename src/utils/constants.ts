// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

export const PACKAGE_NAME = '@smart-science/openalex';
export const PACKAGE_VERSION = '0.1.0';
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

export const API_BASE_URL = 'https://api.openalex.org';
export const CONTENT_BASE_URL = 'https://content.openalex.org';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTENT_TIMEOUT_MS = 60_000;
export const MS_PER_SECOND = 1_000;
/** Maximum timeout in milliseconds, clamped to 32-bit signed integer for setTimeout. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Maximum position index allowed when reconstructing abstract_inverted_index. */
export const MAX_ABSTRACT_POSITION = 500_000;
/** Maximum character length retained when summarizing error response bodies. */
export const MAX_ERROR_BODY_LENGTH = 500;
