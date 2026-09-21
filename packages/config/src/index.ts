import { z } from 'zod';

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
  DATABASE_URL: z.string().url().optional(),
  DATABASE_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/i)
    .optional(),
  REDIS_URL: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('platform-local'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_AUTHORIZATION_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('platform-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ALLOW_DEV_LOGIN: z.enum(['0', '1']).default('0'),
  CSRF_STRICT: z.enum(['0', '1']).default('0'),
  RATE_LIMIT_ENABLED: z.enum(['0', '1']).default('1'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
});

/**
 * The API parses runtime configuration at its process boundary, not only as a
 * helper for tests. Production must never start with the in-memory adapters or
 * with developer authentication enabled. The worker still needs a
 * process-specific configuration schema before its bootstrap is promoted to
 * production.
 */
export const environmentSchema = environmentSchemaBase.superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return;

  const required: Array<keyof typeof value> = [
    'DATABASE_URL',
    'REDIS_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_REDIRECT_URI',
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
  if (value.ALLOW_DEV_LOGIN === '1') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALLOW_DEV_LOGIN'],
      message: 'dev_login_forbidden_in_production',
    });
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}
