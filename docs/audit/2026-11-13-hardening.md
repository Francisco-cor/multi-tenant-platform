# Auditoría técnica y endurecimiento — 2026-11-13

- Alcance: API, worker, web, paquetes, migraciones/RLS, CI, Docker, infraestructura local, documentación y contrato OpenAPI.
- Punto de partida: `e28bf97`.
- Resultado: 71 commits, 311 archivos modificados, +29 927 / −5 391 líneas.
- Método: sondeo paralelo por área, reproducción de fallos, corrección con pruebas y verificación contra PostgreSQL, Redis, MinIO y navegador reales cuando el entorno lo permitió.

## Resultado ejecutivo

El proyecto pasó de “scaffold avanzado con controles parciales” a una base defendible para entrevista y revisión técnica:

- El aislamiento tenant está aplicado por la base de datos (RLS `FORCE`, roles separados) y no solo por filtros de aplicación.
- Los flujos de dinero son idempotentes, reconcilian importe/moneda y no aceptan un webhook de un intento arbitrario.
- El worker tiene leases con fencing, reintentos por edad, DLQ replay observable, timeouts que abortan trabajo y apagado con deadline.
- La web es una rebanada vertical real (host → tenant → BFF → API → páginas) con sesión HttpOnly, CSRF, capability gating y E2E de navegador.
- El contrato OpenAPI se compara con la tabla real de rutas de Fastify; ya no es un hash que se valida contra sí mismo.
- El pipeline bloquea pruebas vacías, drift de contrato, migraciones peligrosas, imágenes que no arrancan y vulnerabilidades altas/críticas.
- `pnpm audit --prod` no reporta vulnerabilidades conocidas en ninguna severidad.

## Correcciones principales por área

### Identidad, sesiones y autorización

- Matriz de rangos: un `admin` ya no puede autopromoverse a `owner`, invitar owners ni degradar/eliminar owners.
- API keys: verifican creador activo y membresía vigente; se revocan al retirar la membresía; `last_used_at`.
- OIDC: no reactiva usuarios suspendidos, exige `email_verified` en entornos desplegados, PKCE S256, JWKS cacheado, `nbf`/clock skew/`azp`, estado OIDC compartido en Redis.
- Sesiones: expiración absoluta, rotación de token en refresh, `logout-all`, purga periódica, cookie con dominio configurable.
- CSRF: allowlist exacta de orígenes, doble submit (`platform_csrf` + `x-csrf-token`), `Sec-Fetch-Site`; Bearer/API key exentos.
- Límite de cuerpo: el buffer de bytes crudos aborta al superar el límite por ruta (sin OOM previo al `bodyLimit`).

### Aislamiento y base de datos

- `platform_worker` perdió `BYPASSRLS`; solo conserva políticas globales explícitas para outbox, DLQ, entregas y leases.
- `platform_app` perdió DML global sobre `users`; `sessions` tiene RLS ligada al usuario; `audit_log` tenant y `platform_audit_log` global están separados.
- Funciones `SECURITY DEFINER` con tenant como argumento eliminadas o ligadas a `app.user_id`.
- Claves foráneas compuestas `(tenant_id, id)` para stock, reservas, movimientos, órdenes, intentos de pago y entregas.
- Leases de `processed_jobs` con `lease_fence`; outbox con dedupe de productor y job id que incluye `event_id`.
- Retención de sesiones/outbox/DLQ/entregas/jobs disponible; checksum y orden de migraciones verificados.
- Migraciones 0001–0030 aplicadas desde cero en PostgreSQL real, con análisis estático sin warnings.

### Pagos, webhooks y archivos

- El webhook de pagos resuelve el intento solo por `provider_ref`/`provider_key`, bloquea el intento y compara importe/moneda; referencia desconocida no crea dedupe.
- Idempotencia real de órdenes con `Idempotency-Key`, hash de petición, respuesta persistida y 409 ante reutilización con otro cuerpo.
- Secretos de webhook por tenant/proveedor, cifrados y versionados con ventana de solape; el tenant del selector debe coincidir con el firmado.
- `created→paid` y `failed→paid` (captura tardía) generan eventos compensatorios; un evento no aplicado devuelve 202 y se reconcilia, nunca 200 sin efecto.
- SSRF: bloqueo de loopback/privadas/link-local/metadata/CGNAT/NAT64/IPv4 mapeada, HTTPS y puerto 443, resolución DNS y fijación de IP; política compartida entre API y worker.
- Archivos: finalize verifica `HEAD` real, tamaño y content-type; el GC borra el objeto antes de marcar expirado; presign limitado a la firma.
- DLQ: operaciones tenant-scoped, replay/discard transaccionales con guarda de estado y outbox con dedupe.

### Worker y operación

- Imagen de worker con dependencias de runtime resueltas; arranque con `node dist/main.js` (sin `tsx`), usuario no root, `tini`, healthcheck de readiness.
- Timeout de job con `AbortSignal`; reintentos no corren en paralelo con trabajo aún en vuelo.
- Apagado con deadline y cierre forzado de workers; readiness deja de anunciar antes de cerrar.
- Readiness real: DB, Redis, consumers, relay, scheduler, lag de outbox y edad de DLQ.
- Entrega HTTP con timeout, tamaño máximo de respuesta y deadline propio; reintentos/backoff y dead-letter por edad.
- Recuperación de pagos `unknown` por idempotency key; reconciliación con lock y un solo evento por pasada.
- Reservas vencidas de órdenes pagadas no devuelven stock (consumo y fallback por correlación).

### Web

- Middleware de host: slug validado, `x-forwarded-host` solo con proxy confiable, 404 real para host desconocido.
- BFF con sesión HttpOnly en el origen web, proxy server-side con Bearer, sin token en JS/localStorage.
- Páginas de login, contexto, sucursales, órdenes, inventario, archivos y miembros; estados 401/403/409/410, loading/error/404.
- CSP con nonce, HSTS en producción, frame deny, referrer/permissions/nosniff/COOP, `poweredByHeader: false`.
- HTML de tenant con `Cache-Control: private, no-store`; assets inmutables con cache largo.
- Accesibilidad y responsive: `lang`, skip link, landmarks, labels, foco visible, contraste, tablas y grids.
- E2E de navegador: dos hosts, host desconocido, login/logout, orden idempotente, reserva, archivo, miembros y headers.

### CI, contrato y dependencias

- Acciones fijadas por SHA, permisos mínimos, Semgrep vigente, CodeQL seguro en forks/privados, Trivy, gitleaks y audit bloqueantes.
- `assert-tests` falla si no se ejecuta ninguna prueba o todas se omiten; cobertura con umbrales.
- Job de integración con PostgreSQL/Redis/MinIO, job E2E con Chromium y artefactos, matriz Docker con smoke de dependencias.
- OpenAPI: 65 operaciones comparadas contra la tabla real de Fastify, security schemes correctos, `Idempotency-Key`, envelopes y 202/401/403/409.
- Dependencias: Next 15.5.29, Drizzle 0.45.4, Zod 4.6.7 y overrides de `fast-uri`, `postcss`, `sharp`; audit limpio.
- Docker Compose con imágenes fijadas por digest, puertos en loopback, secretos obligatorios, límites y healthchecks.

## Evidencia ejecutada

| Comando                                                           | Resultado                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm typecheck`                                                  | 10/10 tareas OK                                                             |
| `pnpm lint`                                                       | 10/10 tareas OK                                                             |
| `pnpm build`                                                      | 10/10 tareas OK                                                             |
| `pnpm test:unit`                                                  | 443 pruebas, 382 pasadas, 0 fallidas, 61 integraciones omitidas             |
| `pnpm test:coverage`                                              | líneas 61,75 %, ramas 71,52 %, umbrales OK                                  |
| `pnpm test:scripts`                                               | 18/18                                                                       |
| `pnpm test:e2e`                                                   | 14/14 en Chromium                                                           |
| `RUN_DB_INTEGRATION=1` (PostgreSQL real)                          | 45/45                                                                       |
| `RUN_DB_INTEGRATION=1 RUN_API_INTEGRATION=1` (PostgreSQL + Redis) | 156/157, 1 omitida (S3)                                                     |
| `RUN_WORKER_INTEGRATION=1` (PostgreSQL + Redis)                   | 95/95, incluida entrega HTTP real con lease                                 |
| Migraciones desde cero                                            | 39/39 aplicadas; análisis estático 0 warnings                               |
| `node scripts/check-openapi.mjs`                                  | 65/65 operaciones; rutas y contrato coinciden                               |
| `node scripts/check-docs-links.mjs`                               | 63 documentos, sin enlaces/citas rota                                       |
| `prettier --check .`                                              | OK                                                                          |
| `pnpm audit --prod`                                               | 0 vulnerabilidades                                                          |
| Docker API/worker/web                                             | 3 imágenes construidas; usuario `appuser`; imports y dependencias resueltos |

## Gaps que permanecen (explícitos)

1. **KMS/Vault**: los secretos de webhook se cifran con una key estática de proceso (`WEBHOOK_SECRET_ENCRYPTION_KEY`). Falta key-ring gestionado, auditoría de acceso y rotación automática.
2. **Stripe real**: el adapter, la firma y la reconciliación están cubiertos con `fetch` simulado; faltan credenciales sandbox, 3DS, webhook firmado real y recuperación tras timeout del proveedor.
3. **Perímetro egress**: SSRF está mitigado con validación, DNS pinning y bloqueo de rangos; no sustituye un proxy de salida con allowlist y observabilidad de denegaciones.
4. **IaC**: no hay Terraform/Kubernetes; bucket, roles PostgreSQL, Redis, secretos y backups se provisionan a mano. La aplicación no crea infraestructura en el request path.
5. **`inventory_reservations.order_id`**: la API aún no vincula la reserva al crear la orden; el worker la consume mediante un fallback por correlación. Es una mejora de modelo pendiente, no un fallo de stock.
6. **`app.ts`**: sigue siendo un archivo grande (~3 800 líneas). Hay un plan de extracción mecánica por dominio; no se ejecutó para no mezclar refactor con correcciones.
7. **Auditoría transaccional**: varias escrituras de auditoría son “best-effort” después del commit cuando el store no comparte transacción. Las rutas críticas de pagos sí son atómicas.
8. **OIDC real**: el flujo está probado con IdP inyectado/simulado; falta una prueba E2E contra un proveedor real.
9. **Proceso muerto/SIGKILL**: hay recuperación de leases y entrega lenta con renovación; falta un test que mate el proceso a mitad de job.
10. **Retención programada**: los helpers de retención existen; solo la purga de sesiones está cableada. Outbox/DLQ/entregas/jobs requieren scheduler dedicado.
11. **Carga y caos**: k6 y escenarios de fallo están documentados y validados sintácticamente, pero no se ejecutan en CI ni demuestran SLOs.
12. **Entrega de invitaciones**: no hay envío de email; el token de invitación no tiene canal de entrega en producción.
13. **Vary: Host en HTML**: Next 15 sobrescribe `Vary` en HTML dinámico; se mitiga con `private, no-store`, no con `Vary`.
14. **Multi-réplica web**: el cambio de organización entre subdominios requiere `SESSION_COOKIE_DOMAIN` y una decisión de seguridad documentada.

## Cómo reproducir

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm test:e2e
pnpm openapi:check
pnpm migrate:check
pnpm audit --prod --audit-level=high
```

Para integración real:

```bash
cp .env.example .env
docker compose up -d postgres redis minio
pnpm --filter @platform/db migrate
RUN_DB_INTEGRATION=1 RUN_API_INTEGRATION=1 RUN_WORKER_INTEGRATION=1 \
  DATABASE_URL=postgresql://platform:platform@127.0.0.1:5432/platform \
  REDIS_URL=redis://:platform@127.0.0.1:6379 \
  pnpm test:integration
```

Las credenciales y puertos deben coincidir con `.env`; no uses los valores de ejemplo fuera de local.
