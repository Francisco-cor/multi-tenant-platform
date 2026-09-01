import { z } from 'zod';

export const environmentSchema = z.object({
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
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}
