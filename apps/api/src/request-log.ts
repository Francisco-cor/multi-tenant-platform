import { looksLikeHighEntropySecret } from '@platform/observability';

/**
 * Query parameters that carry credentials or one-time secrets. Names are
 * normalized (lower-case, `_`/`-` removed) before comparison so `api_key`,
 * `apiKey` and `api-key` are treated the same.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'invitationtoken',
  'code',
  'state',
  'nonce',
  'ticket',
  'signature',
  'sig',
  'secret',
  'key',
  'apikey',
  'password',
  'clientsecret',
  'authorization',
]);

/** One-time secrets carried in the path instead of the query string. */
const SENSITIVE_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/^\/v1\/members\/invitations\/[^/]+\/accept$/u, '/v1/members/invitations/[REDACTED]/accept'],
];

function normalizeParam(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '');
}

function isSensitiveValue(value: string): boolean {
  return looksLikeHighEntropySecret(value);
}

/**
 * Safe representation of a request URL for logs and metrics labels.
 *
 * Invitation tokens, OIDC `code`/`state` and signed query parameters must
 * never reach logs. Path tokens are masked; query values are masked by key
 * name and by shape (anything that looks like a credential), so a secret
 * under an unexpected parameter name is still redacted.
 */
export function redactRequestUrl(rawUrl: string): string {
  const hashIndex = rawUrl.indexOf('#');
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const queryIndex = withoutHash.indexOf('?');
  const rawPath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const rawQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : null;

  const path = SENSITIVE_PATH_PATTERNS.reduce(
    (current, [pattern, replacement]) =>
      pattern.test(current) ? current.replace(pattern, replacement) : current,
    rawPath,
  );

  if (rawQuery === null || rawQuery.length === 0) return path;

  const redacted = rawQuery.split('&').map((pair) => {
    if (pair.length === 0) return pair;
    const separator = pair.indexOf('=');
    if (separator < 0) {
      return isSensitiveValue(pair) ? '[REDACTED]' : pair;
    }
    const rawName = pair.slice(0, separator);
    const rawValue = pair.slice(separator + 1);
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      // keep the raw name for the sensitivity check
    }
    const sensitive =
      SENSITIVE_QUERY_PARAMS.has(normalizeParam(decodedName)) || isSensitiveValue(rawValue);
    return sensitive ? `${rawName}=[REDACTED]` : pair;
  });

  return `${path}?${redacted.join('&')}`;
}
