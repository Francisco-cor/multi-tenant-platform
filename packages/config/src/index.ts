import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const WEBHOOK_SECRET_KEY_BYTES = 32;
const WEBHOOK_SECRET_IV_BYTES = 12;
const WEBHOOK_SECRET_ALGORITHM = 'aes-256-gcm';
const WEBHOOK_SECRET_FORMAT_VERSION = 'v1';

const environmentSchemaBase = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  TENANT_BASE_DOMAIN: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/i, 'tenant_base_domain_invalid')
    .default('app.localhost'),
  WEB_PUBLIC_URL: z.string().url().default('http://app.localhost:3000'),
  API_PUBLIC_URL: z.string().url().default('http://api.localhost:4000'),
  WEB_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
        : [],
    ),
  SESSION_COOKIE_DOMAIN: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/i, 'session_cookie_domain_invalid')
    .optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/i)
    .optional(),
  REDIS_URL: z.string().url().optional(),
  S3_PROVIDER: z.enum(['fake', 's3']).default('fake'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('platform-local'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  WEBHOOK_SECRET_ENCRYPTION_KEY: z
    .string()
    .min(43)
    .refine((value) => Buffer.from(value, 'base64url').length === WEBHOOK_SECRET_KEY_BYTES, {
      message: 'webhook_secret_encryption_key_invalid',
    })
    .optional(),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_AUTHORIZATION_ENDPOINT: z.string().url().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).optional(),
  PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
  PAYMENT_PROVIDER_WEBHOOK_SECRET: z.string().min(16).optional(),
  WEBHOOK_INBOUND_SECRET: z.string().min(16).optional(),
  OTEL_SERVICE_NAME: z.string().default('platform-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ALLOW_DEV_LOGIN: z.enum(['0', '1']).default('0'),
  CSRF_STRICT: z.enum(['0', '1']).default('0'),
  RATE_LIMIT_ENABLED: z.enum(['0', '1']).default('1'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).optional(),
  TRUST_PROXY_CIDRS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((cidr) => cidr.trim())
            .filter(Boolean)
        : [],
    ),
  ALLOW_IN_MEMORY: z.enum(['0', '1']).optional(),
  OIDC_EMAIL_VERIFIED: z.enum(['ignore', 'require']).default('ignore'),
});

/**
 * The API parses runtime configuration at its process boundary, not only as a
 * helper for tests. Production must never start with the in-memory adapters or
 * with developer authentication enabled. The worker still needs a
 * process-specific configuration schema before its bootstrap is promoted to
 * production.
 */
/**
 * Environments that serve real users. "staging" is production-like: it must
 * not enable developer login, in-memory adapters, insecure cookies or literal
 * placeholder secrets even though it is not customer-facing.
 */
export const PRODUCTION_LIKE_ENVIRONMENTS = ['staging', 'production'] as const;

export function isProductionLike(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'staging' || nodeEnv === 'production';
}

const PLACEHOLDER_SECRETS = new Set([
  'test_webhook_secret',
  'change-me',
  'changeme',
  'change-me-local-payment-secret',
  'change-me-local-stripe-webhook-secret',
  'change-me-local-inbound-secret',
  'local-only-placeholder',
]);

function isLocalhostUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return true;
  }
}

function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return PLACEHOLDER_SECRETS.has(normalized) || normalized.includes('change-me');
}

export const environmentSchema = environmentSchemaBase.superRefine((value, ctx) => {
  if (!isProductionLike(value.NODE_ENV)) return;

  const required: Array<keyof typeof value> = [
    'DATABASE_URL',
    'REDIS_URL',
    'S3_ENDPOINT',
    'S3_PROVIDER',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'WEBHOOK_SECRET_ENCRYPTION_KEY',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_REDIRECT_URI',
    'WEBHOOK_INBOUND_SECRET',
    'METRICS_TOKEN',
  ];
  for (const name of required) {
    const current = value[name];
    if (typeof current !== 'string' || current.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: 'required_in_production',
      });
    }
  }
  if (value.S3_PROVIDER !== 's3') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['S3_PROVIDER'],
      message: 'real_s3_provider_required_in_production',
    });
  }
  if (value.ALLOW_DEV_LOGIN === '1') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALLOW_DEV_LOGIN'],
      message: 'dev_login_forbidden_in_production',
    });
  }
  if (value.ALLOW_IN_MEMORY === '1') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALLOW_IN_MEMORY'],
      message: 'in_memory_adapters_forbidden_in_production',
    });
  }
  if (isLocalhostUrl(value.WEB_PUBLIC_URL) || isLocalhostUrl(value.API_PUBLIC_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_PUBLIC_URL'],
      message: 'localhost_url_forbidden_in_production',
    });
  }
  const origins = value.WEB_ALLOWED_ORIGINS.length > 0 ? value.WEB_ALLOWED_ORIGINS : [value.WEB_PUBLIC_URL];
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_ALLOWED_ORIGINS'],
          message: 'https_origin_required_in_production',
        });
      }
      if (isLocalhostUrl(origin)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_ALLOWED_ORIGINS'],
          message: 'localhost_origin_forbidden_in_production',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_ALLOWED_ORIGINS'],
        message: 'web_allowed_origins_invalid',
      });
    }
  }
  for (const [name, secret] of [
    ['PAYMENT_WEBHOOK_SECRET', value.PAYMENT_WEBHOOK_SECRET],
    ['PAYMENT_PROVIDER_WEBHOOK_SECRET', value.PAYMENT_PROVIDER_WEBHOOK_SECRET],
    ['WEBHOOK_INBOUND_SECRET', value.WEBHOOK_INBOUND_SECRET],
  ] as const) {
    if (isPlaceholderSecret(secret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: 'placeholder_webhook_secret_forbidden_in_production',
      });
    }
  }
  if (value.TRUST_PROXY === '1' && !value.TRUST_PROXY_HOPS && value.TRUST_PROXY_CIDRS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TRUST_PROXY'],
      message: 'trust_proxy_requires_hops_or_cidrs_in_production',
    });
  }
  if (value.PAYMENT_PROVIDER === 'stripe' && !value.PAYMENT_PROVIDER_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PAYMENT_PROVIDER_WEBHOOK_SECRET'],
      message: 'stripe_webhook_secret_required_in_production',
    });
  }
  if (value.PAYMENT_PROVIDER !== 'stripe' && !value.PAYMENT_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PAYMENT_WEBHOOK_SECRET'],
      message: 'payment_webhook_secret_required_in_production',
    });
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export const workerEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_ROLE: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/i)
      .optional(),
    WORKER_DATABASE_ROLE: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/i)
      .default('platform_worker'),
    REDIS_URL: z.string().url().optional(),
    S3_PROVIDER: z.enum(['fake', 's3']).default('fake'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3).default('platform-local'),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    WEBHOOK_SECRET_ENCRYPTION_KEY: environmentSchemaBase.shape.WEBHOOK_SECRET_ENCRYPTION_KEY,
    PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
    PAYMENT_PROVIDER_API_KEY: z.string().min(1).optional(),
    PAYMENT_PROVIDER_BASE_URL: z.string().url().default('https://api.stripe.com'),
    PAYMENT_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(5000),
    WORKER_HEALTH_HOST: z.string().default('0.0.0.0'),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(4010),
    WORKER_READY_FILE: z.string().min(1).default('/tmp/platform-worker-ready'),
    OTEL_SERVICE_NAME: z.string().default('platform-worker'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    const required: Array<keyof typeof value> = [
      'DATABASE_URL',
      'REDIS_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'WEBHOOK_SECRET_ENCRYPTION_KEY',
      'PAYMENT_PROVIDER_API_KEY',
    ];
    for (const name of required) {
      const current = value[name];
      if (typeof current !== 'string' || current.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'required_in_production',
        });
      }
    }
    if (value.S3_PROVIDER !== 's3') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_PROVIDER'],
        message: 'real_s3_provider_required_in_production',
      });
    }
    if (value.PAYMENT_PROVIDER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'real_payment_provider_required_in_production',
      });
    }
    if (
      value.PAYMENT_PROVIDER === 'stripe' &&
      !value.PAYMENT_PROVIDER_BASE_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER_BASE_URL'],
        message: 'payment_provider_https_required',
      });
    }
  });

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}

export function loadWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  return workerEnvironmentSchema.parse(source);
}

function decodeWebhookSecretKey(keyMaterial: string): Buffer {
  const key = Buffer.from(keyMaterial, 'base64url');
  if (key.length !== WEBHOOK_SECRET_KEY_BYTES) {
    throw new Error('webhook_secret_encryption_key_invalid');
  }
  return key;
}

/** Encrypt a webhook signing secret for storage; the key must come from KMS/Vault-backed config. */
export function encryptWebhookSecret(secret: string, keyMaterial: string): string {
  const key = decodeWebhookSecretKey(keyMaterial);
  const iv = randomBytes(WEBHOOK_SECRET_IV_BYTES);
  const cipher = createCipheriv(WEBHOOK_SECRET_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    WEBHOOK_SECRET_FORMAT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypt a webhook signing secret in the worker; never log the returned value. */
export function decryptWebhookSecret(ciphertext: string, keyMaterial: string): string {
  const [version, ivEncoded, tagEncoded, dataEncoded] = ciphertext.split('.');
  if (version !== WEBHOOK_SECRET_FORMAT_VERSION || !ivEncoded || !tagEncoded || !dataEncoded) {
    throw new Error('webhook_secret_ciphertext_invalid');
  }
  const key = decodeWebhookSecretKey(keyMaterial);
  const iv = Buffer.from(ivEncoded, 'base64url');
  const tag = Buffer.from(tagEncoded, 'base64url');
  const data = Buffer.from(dataEncoded, 'base64url');
  if (iv.length !== WEBHOOK_SECRET_IV_BYTES || tag.length !== 16 || data.length === 0) {
    throw new Error('webhook_secret_ciphertext_invalid');
  }
  const decipher = createDecipheriv(WEBHOOK_SECRET_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
