import { createHmac } from 'node:crypto';

export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  const payload = `${timestamp}.${rawBody}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function parseWebhookSignature(header: string | undefined): { version: string; signature: string } | null {
  if (!header) return null;
  // Expected: v1,<hex> or v1=<hex>
  const m = header.match(/v1[=,]([a-f0-9]{32,128})/i);
  if (!m || !m[1]) return null;
  return { version: 'v1', signature: m[1].toLowerCase() };
}

export function isTimestampFresh(timestamp: string, nowMs = Date.now(), toleranceMs = WEBHOOK_TOLERANCE_MS): boolean {
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;
  // timestamp is seconds since epoch (common) or ms? Support both: if < 1e12 treat as seconds
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  const delta = Math.abs(nowMs - tsMs);
  return delta <= toleranceMs;
}

export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signatureHeader: string | undefined;
  nowMs?: number;
}): { valid: boolean; reason?: string } {
  if (!isTimestampFresh(input.timestamp, input.nowMs)) {
    return { valid: false, reason: 'timestamp_tolerance' };
  }
  const parsed = parseWebhookSignature(input.signatureHeader);
  if (!parsed) return { valid: false, reason: 'signature_missing' };
  const expected = computeWebhookSignature(input.secret, input.timestamp, input.rawBody);
  // constant-time compare
  if (expected.length !== parsed.signature.length) return { valid: false, reason: 'signature_mismatch' };
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ parsed.signature.charCodeAt(i);
  if (mismatch !== 0) return { valid: false, reason: 'signature_mismatch' };
  return { valid: true };
}
