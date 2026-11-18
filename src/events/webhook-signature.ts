// MCP Events webhook signatures, as OpenAI's guide requires: Standard Webhooks with the client's `whsec_` secret.
// The signed content is the message id, the signing time in seconds and the body's exact bytes, joined by dots.
import { createHmac } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The signing key inside a `whsec_` secret, or undefined when it has another form.
export function signingKeyOf(secret: string): Buffer | undefined {
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!secret.startsWith(SECRET_PREFIX) || !BASE64.test(encoded)) return undefined;
  const key = Buffer.from(encoded, 'base64');
  return key.length >= MIN_SECRET_BYTES && key.length <= MAX_SECRET_BYTES ? key : undefined;
}

export function signedHeaders(
  key: Buffer,
  messageId: string,
  nowMs: number,
  body: string,
  subscriptionId: string,
): Record<string, string> {
  const signedAt = String(Math.floor(nowMs / 1000));
  const signature = createHmac('sha256', key).update(`${messageId}.${signedAt}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': messageId,
    'webhook-timestamp': signedAt,
    'webhook-signature': `v1,${signature}`,
    'x-mcp-subscription-id': subscriptionId,
  };
}
