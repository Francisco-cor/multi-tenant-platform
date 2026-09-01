# Multi-Tenant SaaS Platform — Plan de implementación

> Documento maestro del proyecto. Se actualiza junto con el código y sirve como contrato de alcance, checklist de producción y registro de decisiones. El objetivo no es terminar un CRUD, sino construir una plataforma B2B operable, observable y defendible en una entrevista técnica.

## 1. Resultado que se quiere construir

Una plataforma B2B multi-tenant para compañías con varias sucursales. Cada organización opera en un espacio lógico aislado y puede gestionar:

- organizaciones, sucursales y miembros;
- roles y permisos (RBAC);
- órdenes y su ciclo de vida;
- productos e inventario por sucursal;
- archivos en almacenamiento S3-compatible;
- automatizaciones y trabajos en segundo plano;
- webhooks entrantes y salientes;
- auditoría, observabilidad y controles operativos.

El producto tendrá subdominios por tenant, por ejemplo `acme.app.com` y `contoso.app.com`, y estará preparado para ejecutarse localmente, en staging y en Kubernetes.

### Objetivos no negociables

1. Una request nunca puede leer, modificar, descargar ni inferir datos de otro tenant.
2. Las operaciones críticas son idempotentes y tienen una historia auditable.
3. Las escrituras de negocio y sus eventos internos no dependen de dual writes frágiles.
4. Los fallos de workers, reintentos, timeouts y despliegues parciales tienen un camino de recuperación documentado.
5. Cada capacidad importante tiene pruebas automatizadas y una demostración reproducible.

### Fuera del primer release

Facturación SaaS completa, app móvil nativa, marketplace, BI avanzado, edición colaborativa en tiempo real y soporte para múltiples regiones activas. Se dejarán puntos de extensión, pero no se incorporarán al MVP operativo.

## 2. Forma de trabajar para un proyecto de varias sesiones

### Fuente de verdad

- Este archivo contiene el roadmap y los criterios de aceptación.
- `docs/adr/` contendrá decisiones técnicas permanentes.
- `docs/runbooks/` contendrá procedimientos operativos.
- `docs/failure-scenarios/` contendrá experimentos de fallos y su evidencia.
- El código debe referenciar el issue o fase correspondiente cuando una decisión no sea obvia.

### Regla de cierre de cada sesión

Antes de terminar una sesión:

1. actualizar los checkboxes de la fase actual;
2. dejar escrito qué se completó, qué quedó bloqueado y cuál es el siguiente paso;
3. ejecutar las verificaciones relevantes;
4. registrar comandos, decisiones o cambios de contrato que otra sesión necesite conocer;
5. no marcar una fase como completa solo porque compila: deben cumplirse sus criterios de salida.

### Registro de continuidad

| Sesión | Fecha      | Fase | Hecho                                                                                                                            | Bloqueos / decisiones                                                                            | Próximo paso                                                        |
| ------ | ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 0      | 2026-08-20 | 0–1  | Documento maestro, bootstrap y contratos iniciales creados                                                                       | Persistencia/auth reales aún pendientes                                                          | Instalar dependencias y validar CI local                            |
| 1      | 2026-08-20 | 2    | OIDC state/nonce y claims, sesiones, host tenant, selección explícita, RBAC API, invitaciones one-shot y auditoría implementados | Store en memoria deliberado; UI/E2E y persistencia/RLS pendientes                                | Completar UI/E2E y comenzar Fase 3 con migración base               |
| 2      | 2026-08-20 | 3    | Migracion base, RLS forzado, contexto Drizzle y repository tenant-scoped preparados                                              | Docker no disponible en esta sesion; faltaba ejecutar PostgreSQL real y conectar el API          | Levantar PostgreSQL y completar el corte persistente                |
| 3      | 2026-08-20 | 3    | Migraciones 0001/0002 aplicadas, prueba RLS real y API persistente tenant-scoped implementadas                                   | Backups/restore drill e indices grandes siguen pendientes                                        | Separar backup/restore y cerrar los pendientes operativos de Fase 3 |
| 4      | 2026-08-20 | 3    | Runner por clases schema/data/indexes, indice concurrente, backup custom y restore drill real con verificacion RLS ejecutados    | Evidencia PASS con PostgreSQL 16; el drill local usa PG_TOOL_CONTAINER y limpio la base temporal | Repetir con datos tenant representativos antes de staging           |

## 3. Arquitectura objetivo

### Componentes iniciales

```text
Browser
  -> CDN / Ingress
  -> Next.js web (UI, server components, tenant routing)
  -> Node.js API (REST versionada, auth, comandos de negocio)
       -> PostgreSQL (fuente de verdad)
       -> Redis (rate limit, cache breve, locks coordinados)
       -> S3-compatible storage (archivos)
       -> Outbox relay -> BullMQ/Redis -> Workers
       -> Webhook delivery service
  -> OpenTelemetry Collector -> traces / metrics / logs
  -> Prometheus + Grafana + log backend
```

### Decisiones base provisionales

| Área            | Decisión inicial                                                | Motivo / condición de revisión                                                                                                 |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Repositorio     | Monorepo `pnpm` + Turborepo                                     | Comparte contratos, tipos, configuración y tooling entre apps; revisar si la frontera entre servicios se vuelve independiente. |
| Web             | Next.js App Router + TypeScript                                 | UI, SSR y resolución del subdominio en un único producto web.                                                                  |
| API             | Servicio Node.js TypeScript con Fastify                         | Contratos HTTP explícitos, buen rendimiento y composición sencilla con OpenTelemetry.                                          |
| ORM / SQL       | Drizzle ORM + migraciones SQL versionadas                       | Permite expresar RLS, locks, índices concurrentes y migraciones backward-compatible sin ocultar PostgreSQL.                    |
| Base de datos   | PostgreSQL                                                      | Transacciones, constraints, RLS, locks y soporte sólido para outbox.                                                           |
| Jobs            | BullMQ sobre Redis                                              | Reintentos, backoff, delayed jobs y DLQ controlada.                                                                            |
| Cache           | Redis, solo para datos reconstruibles                           | Nunca será la única fuente de verdad de permisos, inventario o pagos.                                                          |
| Archivos        | S3-compatible (MinIO local; proveedor gestionado en producción) | URLs presignadas y separación por tenant mediante prefijos y metadata.                                                         |
| Auth            | OAuth 2.0 / OIDC con un proveedor intercambiable                | No almacenar contraseñas propias en la primera versión; identidad separada de autorización.                                    |
| Contratos       | OpenAPI generado/validado en CI                                 | Contratos consumibles por frontend, tests y documentación.                                                                     |
| Observabilidad  | OpenTelemetry + Prometheus/Grafana                              | Correlation IDs, traces distribuidas, métricas de negocio y alertas.                                                           |
| Infraestructura | Docker, Kubernetes y Terraform                                  | Paridad local/staging/producción y despliegues reproducibles.                                                                  |
| CI/CD           | GitHub Actions                                                  | Checks, migraciones, imágenes, despliegue progresivo y rollback documentado.                                                   |

Estas decisiones se convierten en ADR antes de implementar la capacidad correspondiente. Si una decisión cambia, se conserva el ADR anterior y se documenta la migración.

## 4. Modelo de aislamiento multi-tenant

### Identidad del contexto

Cada request autenticada debe resolver un `RequestContext` con:

```text
request_id
trace_id
user_id
tenant_id
membership_id
roles / permissions
subdomain
```

El `tenant_id` se obtiene de una combinación validada de identidad y host. El subdominio no se acepta como autorización por sí solo: se busca el tenant por slug y se verifica que el usuario tenga una membresía activa en él.

### Defensa en profundidad

1. Middleware identifica host, sesión y tenant.
2. Policy layer comprueba membresía, estado de la organización y permiso.
3. Cada repository exige `tenant_id` explícito; no existen métodos genéricos que consulten una entidad tenant-scoped sin contexto.
4. Las tablas tenant-scoped tienen `tenant_id NOT NULL` y constraints/índices compuestos.
5. PostgreSQL RLS funciona como última barrera en producción y en los tests de integración.
6. Las claves de objetos S3 incluyen tenant (`tenants/{tenantId}/...`) y el servidor nunca expone claves arbitrarias.
7. Logs, métricas y exports no deben filtrar contenido de otro tenant.

### Reglas de datos

- Toda tabla de negocio debe clasificarse como `global`, `tenant-scoped` o `cross-tenant-admin`.
- Las relaciones entre entidades tenant-scoped deben validar el mismo `tenant_id` mediante constraints o validación transaccional.
- Un `tenant_id` recibido del body/query nunca sustituye al contexto autenticado.
- No se permite `findById(id)` para datos tenant-scoped; usar `findById(ctx, id)`.
- Los endpoints administrativos cross-tenant estarán separados, protegidos y auditados.
- Los errores de autorización no revelarán si un ID existe en otro tenant.

### Pruebas obligatorias de aislamiento

- Usuario de tenant A no puede leer un ID creado en tenant B.
- Usuario de A no puede actualizar, borrar, descargar ni disparar webhooks de B.
- Una relación con IDs mezclados falla completa y atómicamente.
- Queries directas sin filtro tenant fallan bajo RLS.
- Cache keys, job payloads y object keys incluyen tenant cuando el dato lo requiere.
- Los tests se ejecutan con al menos dos tenants y datos deliberadamente similares.

## 5. Fases del proyecto

Las fases se ejecutan en orden, pero una fase puede tener trabajo paralelo cuando sus contratos ya estén definidos. Cada fase debe terminar con código, pruebas y documentación; las cajas son el backlog ejecutable.

## Fase 0 — Alcance, riesgos y bootstrap

**Objetivo:** preparar un repositorio reproducible y reducir ambigüedad antes de construir features.

### Tareas

- [x] Crear este plan maestro en la raíz.
- [x] Definir nombre, dominio local y convenciones (`app.localhost`, `api.localhost`).
- [x] Crear `README.md` con visión, requisitos, quickstart y estado actual.
- [x] Inicializar monorepo con `apps/web`, `apps/api`, `apps/worker` y paquetes compartidos.
- [x] Crear `packages/config`, `packages/db`, `packages/auth`, `packages/contracts`, `packages/observability`, `packages/testing`.
- [x] Fijar Node, pnpm, TypeScript, linting, formatting y convenciones de commits.
- [x] Añadir `.env.example` sin secretos y esquema de validación de entorno.
- [x] Crear Docker Compose local para PostgreSQL, Redis, MinIO, OTel Collector, Prometheus y Grafana.
- [x] Configurar scripts uniformes: `dev`, `build`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`.
- [x] Añadir CODEOWNERS, plantilla de PR e issue templates.

### Criterios de salida

- Una persona nueva levanta dependencias y aplicaciones con una guía de menos de 15 minutos.
- CI ejecuta instalación reproducible, lint, typecheck y tests mínimos.
- Ningún secreto se necesita para ejecutar el modo local.
- Existe un diagrama C4 inicial en `docs/architecture/`.

## Fase 1 — Contratos, convenciones y diseño de dominio

**Objetivo:** decidir fronteras y estados antes de crear endpoints dispersos.

### Tareas

- [x] Especificar actores: owner, admin, manager, operator, auditor, billing/admin global.
- [x] Definir recursos y permisos por acción, no solo por pantalla.
- [x] Diseñar estados de organización, membresía, orden, inventario y reserva; pagos/webhooks quedan como extensión documentada.
- [x] Definir errores HTTP (`code`, `message`, `requestId`, detalles seguros).
- [x] Crear OpenAPI inicial y esquemas de validación runtime.
- [x] Definir formato de paginación cursor-based, filtros, ordenamiento y límites.
- [x] Definir política de versiones `/v1` y compatibilidad de respuestas.
- [x] Crear ADR-001 sobre arquitectura, ADR-002 sobre tenant isolation y ADR-003 sobre ORM/migraciones.

### Entregables

- Glosario de dominio.
- Matriz recurso/permisos/rol.
- Diagrama de estados de órdenes y pagos.
- Contratos HTTP versionados.

### Criterios de salida

- Toda feature futura puede identificar dueño de datos, actor autorizado y transición válida.
- Los contratos contienen casos de éxito, validación y autorización fallida.

## Fase 2 — Identidad, organizaciones y subdominios

**Objetivo:** que un usuario pueda entrar a un tenant correcto y operar con una membresía autorizada.

### Tareas

- [x] Integrar login OIDC con issuer configurable, `state`, `nonce` y validación de claims.
- [x] Modelar usuarios, organizaciones, sucursales, membresías, invitaciones y sesiones.
- [x] Implementar creación de organización e invitación con token de un solo uso y expiración.
- [x] Resolver `*.app.com` y dominio local sin confiar en headers manipulables.
- [x] Implementar cambio explícito de organización cuando un usuario pertenece a varias.
- [x] Validar tenant activo, usuario suspendido y membresía revocada en cada request.
- [ ] Aplicar RBAC en API y ocultar acciones no permitidas en UI sin usar la UI como control.
- [x] Auditar login, logout, invitación, aceptación, cambio de tenant y cambios de roles.

### Criterios de salida

- `acme.app.com` y `contoso.app.com` muestran contextos separados.
- Un usuario con membresía solo en A recibe autorización segura al intentar entrar a B.
- Revocar una membresía invalida el acceso sin depender de limpiar cache manualmente.
- Hay E2E de login simulado y de aislamiento entre dos organizaciones.

> Progreso sesión 1: el vertical slice API de identidad y tenant context está implementado con store en memoria, tests de aislamiento y documentación. La UI autenticada y el E2E con navegador quedan pendientes; la persistencia real y RLS pertenecen a la Fase 3.

## Fase 3 — PostgreSQL, migraciones y aislamiento real

**Objetivo:** hacer que el aislamiento sea una propiedad del sistema de datos, no una convención frágil.

### Tareas

- [x] Implementar tablas base con IDs UUID, timestamps UTC y `created_by` donde aplique.
- [x] Añadir `tenant_id` a todas las tablas clasificadas como tenant-scoped; `organizations` queda documentada como tenant root cuyo `id` es el limite.
- [x] Crear indices compuestos orientados a los patrones reales: `(tenant_id, slug)` y claves de membresia; se ampliaran con cada agregado operativo.
- [x] Definir constraints de unicidad con tenant (`tenant_id, user_id` y `tenant_id, slug`).
- [x] Implementar RLS con la variable de sesion transaccional `app.tenant_id` y `FORCE ROW LEVEL SECURITY`.
- [x] Asegurar que cada acceso de API usa transacción/contexto de DB correctamente aislado.
- [x] Probar comportamiento con pool de conexiones y evitar contexto tenant pegado a una conexión reutilizada.
- [x] Separar migraciones de aplicación, migraciones de datos y cambios de índices grandes.
- [x] Documentar expand-contract y politica de migraciones hacia atras en el runbook de PostgreSQL.
- [x] Crear backups locales, restore de prueba y verificación de migraciones desde una versión anterior.

### Criterios de salida

- Las pruebas de integración demuestran aislamiento usando repository filters y RLS.
- No hay foreign key o índice crítico que permita mezclar tenants accidentalmente.
- Una migración fallida no deja el esquema en un estado desconocido sin runbook.

> Progreso sesion 2: Fase 3 tiene migracion base versionada para `users`, `organizations`, `memberships` y `branches`, restricciones tenant-scoped, RLS forzado, cliente Drizzle con contexto transaccional y prueba de aislamiento preparada para PostgreSQL real. En ese momento, la API seguia usando el adaptador en memoria hasta completar el corte de repositories.

## Fase 4 — Órdenes y flujo transaccional

**Objetivo:** implementar el primer flujo de negocio completo con estados explícitos y auditoría.

### Tareas

- [ ] Crear orden, líneas, precios capturados, sucursal y actor creador.
- [ ] Definir máquina de estados: `draft`, `pending_payment`, `paid`, `processing`, `completed`, `cancelled`, `failed`.
- [ ] Validar transiciones en una capa de dominio, no mediante cambios directos de status.
- [ ] Añadir idempotency keys por tenant, actor, endpoint y operación.
- [ ] Persistir respuesta reutilizable de operaciones idempotentes y su hash de request.
- [ ] Registrar audit log append-only para acciones sensibles.
- [ ] Publicar eventos internos mediante transactional outbox.
- [ ] Añadir paginación, filtros, búsqueda limitada y export asíncrono.
- [ ] Implementar permisos diferenciados para crear, aprobar, cancelar y consultar.

### Criterios de salida

- Repetir una request con la misma idempotency key no duplica orden ni efecto.
- Dos requests con la misma key y payload diferente son rechazadas.
- Cada transición inválida deja el estado intacto y un error seguro.
- Puede reconstruirse quién hizo qué, cuándo y desde qué request.

## Fase 5 — Inventario concurrente

**Objetivo:** garantizar que no se venda dos veces el último artículo bajo concurrencia.

### Tareas

- [ ] Modelar producto, SKU, stock por sucursal, movimientos y reservas.
- [ ] Elegir reserva temporal vs decremento definitivo y documentar la decisión.
- [ ] Implementar operación atómica: transacción, lock apropiado o `UPDATE ... WHERE available >= quantity`.
- [ ] Crear constraint de cantidades no negativas y registro de movimiento con correlation ID.
- [ ] Definir expiración/reconciliación de reservas mediante job idempotente.
- [ ] Manejar deadlocks con retry limitado y backoff, sin repetir efectos no idempotentes.
- [ ] Escribir prueba de concurrencia con decenas de requests y stock inicial 1.
- [ ] Crear escenario de carga con varios tenants y sucursales para evitar hot spots globales.

### Criterios de salida

- Con stock 1, exactamente una operación gana y las demás reciben conflicto/sin stock.
- El inventario final y los movimientos concuerdan después de reintentos.
- La latencia y tasa de errores bajo carga tienen umbrales documentados.

## Fase 6 — Archivos y almacenamiento

**Objetivo:** subir y descargar archivos sin convertir la API en proxy ni abrir cruces entre tenants.

### Tareas

- [x] Crear metadata de archivo tenant-scoped: owner, tamaño esperado, content type permitido, estado y object key.
- [x] Generar presigned upload URLs de corta duración y con límites.
- [x] Usar object keys no adivinables y prefijadas por tenant.
- [x] Validar que el callback/finalize pertenece al tenant y al upload pendiente.
- [x] Añadir antivirus/validación de contenido como job si el caso lo requiere.
- [x] Generar presigned download URLs solo después de autorizar el recurso.
- [x] Implementar limpieza de uploads incompletos y archivos huérfanos.
- [x] Evitar loggear contenido, URLs completas o tokens.

### Criterios de salida

- [x] Un usuario de A no puede obtener metadata, URL o contenido de B aunque conozca el ID.
- [x] Los archivos incompletos y huérfanos tienen una política de retención.
- [x] Se prueban expiración, content type inválido y tenant incorrecto.

> Progreso sesión 5: Fase 6 cerrada — `migrations/schema/0007_files.sql` + `schema.ts files` con RLS `FORCE` y `CHECK` filename/size, `S3Service` con keys `tenants/{tenantId}/{uuid}` TTL 300s/60s, `POST /v1/files/presigned-upload` + `/v1/files/:id/finalize` + `GET /v1/files/:id` + `GET /v1/files/:id/download|presigned-download` tenant-scoped, `gcFiles` con `SKIP LOCKED`, `files.test.ts` 5 suites cross-tenant 404/409/410 + GC, `ADR-007` + `runbooks/files.md` + `openapi.yaml` actualizado y `.openapi.hash` c9e46e0747eb.

## Fase 7 — Outbox, BullMQ y workers

**Objetivo:** procesar trabajo asíncrono con entrega al menos una vez, deduplicación y recuperación operativa.

### Tareas

- [x] Crear tabla `outbox_events` con aggregate, event type, payload versionado, attempts y timestamps.
- [x] Escribir negocio + outbox en la misma transacción.
- [x] Implementar relay polling/claiming seguro y publicación a BullMQ.
- [x] Definir job IDs deterministas para operaciones naturalmente idempotentes.
- [x] Configurar backoff exponencial con jitter, límites, timeout y concurrencia por cola.
- [x] Implementar dedupe en consumidor mediante `processed_jobs` o clave de efecto equivalente.
- [x] Crear DLQ separada con causa, payload mínimo seguro y procedimiento de replay.
- [x] Añadir graceful shutdown: dejar de aceptar jobs, esperar los activos y liberar locks.
- [x] Añadir health/readiness separados para API, worker, DB, Redis y proveedor externo.
- [x] Añadir métricas de lag de outbox, edad del job, reintentos, DLQ y duración.

### Criterios de salida

- [x] Si el proceso muere antes o después de publicar, el evento termina procesándose sin perderse ni duplicar efectos.
- [x] Un job en DLQ puede inspeccionarse, corregirse y reintentarse de forma controlada.
- [x] Un deploy no corta trabajos activos sin que el sistema los pueda recuperar.

> Progreso sesión 6: Fase 7 cerrada — `migrations/schema/0008_outbox.sql` `outbox_events` + `processed_jobs` + `dlq_jobs` `FORCE RLS` + `schema.ts`, `outbox.ts` `deterministicJobId` sha256 + `writeOutboxEvent` en `files` e `inventory` misma tx, `relay/outboxRelay.ts` `FOR UPDATE SKIP LOCKED LIMIT 100` con `jobId` y backoff 1s→60s jitter 0.2 + dead_letter tras 5, `queues.ts` `InMemoryQueue` dedupe + `createBullMqFactory` `QUEUE_CONFIG` concurrency 10, `processor.ts` `withDedup` + timeout 10s + `metrics`, `main.ts` graceful 30s, `health.ts` `checkOutbox` lag >30s degraded, `GET /metrics` + `GET /v1/dlq|/admin/dlq` + `POST /replay` tenant-scoped `owner/admin` + audit, `ADR-004` + `runbooks/dlq-replay.md` + `failure/outbox-dedupe.md` + `worker.json` dashboard, `outbox.dedupe.test.ts` + `dlq.test.ts` 19 api + 7 worker tests, `openapi.yaml` 21 paths `.openapi.hash 4d1372859ed4`.

## Fase 8 — Pagos y escenario de fallo crítico

**Objetivo:** resolver explícitamente el caso “el worker muere después de cobrar y antes de confirmar la orden”.

### Diseño esperado

No se intentará una transacción atómica entre PostgreSQL y el proveedor de pagos: no existe una transacción local que abarque ambos sistemas. El flujo será una saga durable:

1. Crear la orden y un registro `payment_attempt` en estado `created`/`pending` dentro de una transacción.
2. Persistir un `provider_idempotency_key` determinista y enviar el pago usando esa misma key.
3. Si el proveedor confirma el cobro, guardar el identificador remoto y pasar a `paid` dentro de una operación idempotente.
4. Si el worker muere después del cobro, el retry usa la misma key; el proveedor devuelve el resultado existente o se consulta por el identificador/metadata.
5. Un webhook firmado del proveedor también puede confirmar el pago; su deduplicación y orden no se asumen.
6. Un reconciler periódico busca estados `pending`/`unknown` antiguos y consulta al proveedor.
7. Solo el estado persistido y validado permite liberar inventario, completar la orden o iniciar reembolso.
8. Si el resultado es definitivamente fallido, se libera la reserva; si es incierto, se conserva y se alerta, sin cobrar de nuevo.

### Tareas

- [ ] Definir interfaz `PaymentProvider` y fake determinista para tests.
- [ ] Implementar estados y transiciones de `payment_attempt`.
- [ ] Implementar idempotencia local y del proveedor.
- [ ] Implementar webhook con firma, timestamp tolerance, replay protection y dedupe.
- [ ] Implementar reconciler y alertas de pagos inciertos.
- [ ] Añadir política de compensación/reembolso y permisos de replay.
- [ ] Simular muerte del worker en cada punto del flujo.
- [ ] Documentar el runbook de recuperación y evidencia esperada.

### Criterios de salida

- El escenario de muerte post-cobro no duplica el cobro ni deja la orden en un estado imposible.
- El sistema puede explicar la diferencia entre “falló”, “desconocido” y “pagado”.
- Todos los caminos tienen audit log y métricas.

## Fase 9 — Webhooks y automatizaciones

**Objetivo:** ofrecer integración externa confiable bajo entrega duplicada, tardía o fuera de orden.

### Tareas

- [ ] Modelar endpoints, secretos versionados, eventos suscritos y estado de entrega.
- [ ] Firmar payload con HMAC, timestamp y versión de firma.
- [ ] No incluir secretos en logs, UI ni payloads innecesarios.
- [ ] Usar event ID único y tabla de deliveries por tenant.
- [ ] Reintentar solo errores transitorios con backoff y respetar límites del receptor.
- [ ] Marcar `delivered`, `retrying`, `failed`, `dead_letter` y `disabled`.
- [ ] Permitir replay manual autorizado de un evento específico.
- [ ] Implementar webhook inbound con raw body, verificación antes de parsear y dedupe.
- [ ] Diseñar automatizaciones como comandos/jobs versionados, no como ejecución arbitraria de código.

### Criterios de salida

- La misma entrega recibida dos veces produce un solo efecto.
- La firma cambia si cambia el body y no se acepta una firma expirada.
- Una caída del receptor no bloquea la transacción de negocio.
- El tenant puede consultar estado sin ver entregas de otro tenant.

## Fase 10 — Cache, rate limiting y resiliencia

**Objetivo:** mejorar rendimiento sin convertir Redis en una segunda base inconsistente.

### Tareas

- [ ] Identificar lecturas cacheables y TTL máximo por recurso.
- [ ] Diseñar keys con tenant, versión y parámetros normalizados.
- [ ] Invalidar por evento/outbox después de una escritura confirmada.
- [ ] Usar cache-aside con protección contra stampede en lecturas costosas.
- [ ] Implementar rate limits por IP, identidad, tenant y endpoint sensible.
- [ ] Definir comportamiento si Redis está degradado: fail-open solo donde sea seguro, fail-closed para abuso claro.
- [ ] Añadir timeouts, circuit breakers y límites para proveedores externos.
- [ ] Definir presupuesto de latencia y tamaño de payload por endpoint.

### Criterios de salida

- Un cambio de datos no deja respuestas viejas más allá del TTL/política documentada.
- Los límites no permiten que un tenant monopolice recursos compartidos.
- La API sigue siendo segura cuando Redis no está disponible.

## Fase 11 — Auditoría, seguridad y cumplimiento operativo

**Objetivo:** que una acción sensible sea investigable y que las superficies de ataque estén acotadas.

### Tareas

- [ ] Definir eventos de auditoría: actor, tenant, acción, recurso, resultado, request ID, trace ID e IP si aplica.
- [ ] Hacer audit log append-only, con retención y acceso restringido.
- [ ] Aplicar validación estricta, límites de body, headers seguros y protección CSRF donde corresponda.
- [ ] Revisar SSRF, path traversal, mass assignment, SQL injection, IDOR y exposición de errores.
- [ ] Rotar secretos de OAuth, webhooks y almacenamiento sin downtime.
- [ ] Añadir control de acceso para exportaciones, replays, DLQ y herramientas administrativas.
- [ ] Ejecutar dependency audit, secret scanning, SAST y escaneo de imágenes.
- [ ] Crear threat model y matriz de riesgos.
- [ ] Documentar borrado/retención de datos y solicitudes de privacidad que entren en alcance.

### Criterios de salida

- Existe una revisión de seguridad reproducible en CI y una lista de excepciones explícita.
- Los endpoints privilegiados tienen pruebas negativas de autorización.
- La auditoría no permite editar silenciosamente eventos históricos.

## Fase 12 — Observabilidad y operación

**Objetivo:** diagnosticar una incidencia desde una alerta hasta una request y un cambio de datos concretos.

### Tareas

- [ ] Instrumentar API, DB, Redis, BullMQ, llamadas HTTP y jobs con OpenTelemetry.
- [ ] Propagar `traceparent`, `request_id` y `correlation_id` entre API, outbox, worker y webhook.
- [ ] Usar logs estructurados con tenant redacted/hashed cuando sea posible.
- [ ] Definir RED metrics (rate, errors, duration) y métricas de negocio.
- [ ] Crear dashboards de API, DB, Redis, colas, pagos, webhooks y aislamiento.
- [ ] Crear alertas accionables: error rate, p95, pool saturation, outbox lag, DLQ, payment unknown, disk y expiraciones.
- [ ] Añadir health checks liveness/readiness/startup sin marcar healthy por una dependencia opcional.
- [ ] Documentar qué señales se revisan primero durante un incidente.

### Criterios de salida

- Un test E2E puede correlacionarse con logs, trace y job.
- Cada alerta tiene severidad, owner, umbral y runbook.
- No se envían tokens, secretos ni datos sensibles a observabilidad.

## Fase 13 — Testing, fallos deliberados y carga

**Objetivo:** probar propiedades de consistencia y recuperación, no solo respuestas HTTP felices.

### Pirámide de pruebas

- [ ] Unitarias con Vitest para dominio, policies, firmas, idempotencia y transiciones.
- [ ] Integración con PostgreSQL/Redis/MinIO reales, preferiblemente en contenedores efímeros.
- [ ] Contract tests para OpenAPI y proveedor de pagos/webhooks.
- [ ] E2E con Playwright: login, subdominio, RBAC, órdenes, stock y archivos.
- [ ] Tests de migración desde al menos una versión anterior.
- [ ] Tests de concurrencia para inventario, idempotency keys y reservas.
- [ ] Tests de aislamiento con datos espejo entre A y B.
- [ ] Pruebas de carga y soak con k6 o herramienta equivalente.
- [ ] Smoke tests posteriores a deploy.

### Laboratorio de fallos

Cada escenario debe incluir: hipótesis, preparación, inyección, señal esperada, recuperación, evidencia y aprendizaje.

| Escenario                 | Inyección                                         | Propiedad que debe mantenerse                        | Recuperación                               |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Worker muere post-cobro   | Kill entre respuesta del proveedor y commit local | Un solo cobro; estado eventualmente correcto         | Retry idempotente + webhook/reconciler     |
| Última unidad concurrente | 50 requests con stock 1                           | Exactamente una reserva/decremento                   | Lock/conditional update + retry acotado    |
| Outbox duplicado          | Publicar el mismo evento dos veces                | Un solo efecto de negocio                            | Dedupe por event/job ID                    |
| Worker reiniciado         | SIGTERM durante un job                            | Job recuperable y no corrupto                        | Lock timeout + retry                       |
| Redis caído               | Detener Redis                                     | DB sigue siendo fuente de verdad                     | Degradación segura y alerta                |
| DB lenta                  | Latencia artificial                               | Timeouts, no cascada infinita                        | Circuit breaker/backpressure               |
| Webhook duplicado         | Reenviar mismo event ID                           | Un efecto                                            | Tabla de inbound events/dedupe             |
| Webhook fuera de orden    | Entregar update antes de create                   | Estado válido o reconciliable                        | Versiones/sequence y consulta al proveedor |
| S3 indisponible           | Denegar uploads/downloads                         | Metadata consistente                                 | Retry y estado visible                     |
| Deploy a medias           | Un API viejo y uno nuevo simultáneos              | Ambas versiones sirven                               | Expand-contract                            |
| Migración bloqueante      | Ejecutar cambio con tráfico                       | Requests antiguas no fallan                          | Índices concurrentes/backfill controlado   |
| Cache stale               | Omitir invalidación                               | TTL acotado; permisos no cacheados de forma insegura | Invalidation/rebuild                       |
| Rate-limit hot tenant     | Tráfico abusivo de un tenant                      | Otros tenants continúan operando                     | Bucket por tenant + alertas                |

### Criterios de salida

- Cada escenario crítico tiene un test automatizado o un experimento reproducible.
- Los resultados se guardan en `docs/failure-scenarios/` con fecha y versión.
- Los fallos generan mejoras en código, alerta o runbook; no solo una captura de pantalla.

## Fase 14 — Migraciones backward-compatible y despliegues

**Objetivo:** desplegar cambios sin exigir que todos los pods cambien al mismo instante.

### Patrón expand-contract

1. **Expand:** añadir columnas/tablas/índices nullable o compatibles; no eliminar ni renombrar todavía.
2. Desplegar aplicación que entiende esquema viejo y nuevo.
3. Backfill en batches pequeños, reanudables y observables.
4. Activar dual-read o dual-write temporal solo si es necesario, con reconciliación.
5. Cambiar feature flag al nuevo camino.
6. Verificar métricas y consistencia.
7. **Contract:** eliminar camino viejo en otra release, después de confirmar que no quedan lectores antiguos.

### Tareas

- [ ] Crear pipeline de migración con lock, timeout y logs.
- [ ] Separar migrate/seed y nunca ejecutar seeds destructivos en producción.
- [ ] Probar rolling deploy con dos versiones de API.
- [ ] Crear flags por tenant y kill switches para cambios riesgosos.
- [ ] Definir rollback de aplicación y roll-forward de esquema.
- [ ] Versionar imágenes por commit y mantener artefactos reproducibles.
- [ ] Añadir smoke test y análisis automático de migración antes del despliegue.
- [ ] Documentar criterio de abortar, pausar, rollback o continuar.

### Regla crítica de rollback

El rollback de aplicación no implica automáticamente rollback de base de datos. Si el esquema ya se expandió, la aplicación anterior debe seguir siendo compatible; si no lo es, se hace roll-forward con una corrección compatible. Los cambios destructivos se difieren hasta que ninguna versión anterior pueda recibir tráfico.

## Fase 15 — Docker, Kubernetes, Terraform y entornos

**Objetivo:** llevar la aplicación desde local a un entorno parecido a producción sin esconder dependencias.

### Tareas

- [ ] Crear Dockerfiles multi-stage no root, con healthcheck y pinning de dependencias.
- [ ] Separar imágenes web/API/worker y configurar límites de CPU/memoria.
- [ ] Crear manifests/Helm/Kustomize para namespace, Deployments, Services, Ingress, ConfigMaps y Secrets references.
- [ ] Configurar readiness, liveness, startup probes, PodDisruptionBudget y graceful termination.
- [ ] Añadir autoscaling por CPU y señales de cola donde sea útil.
- [ ] Definir Terraform para red, PostgreSQL gestionado, Redis, bucket, DNS, observabilidad y permisos mínimos.
- [ ] Separar state y variables de local/staging/prod; nunca commitear credenciales.
- [ ] Añadir política de backup, restore drill y retención.
- [ ] Definir DNS/TLS/wildcard para subdominios tenant.
- [ ] Documentar costos aproximados y límites conocidos.

### Criterios de salida

- Staging puede crearse desde código y se puede destruir/recrear sin pasos ocultos.
- Un pod reiniciado no pierde trabajo ni contexto.
- Se verifica restore en un entorno aislado, no solo que el backup exista.

## Fase 16 — CI/CD, release y calidad final

**Objetivo:** que cada cambio tenga una ruta segura hacia producción.

### Pipeline propuesto

1. Validación de formato, lint y typecheck.
2. Tests unitarios e integración.
3. Build de aplicaciones e imágenes.
4. Escaneo de dependencias, secretos e imagen.
5. Contract/E2E en entorno efímero o staging.
6. Validación de migraciones y compatibilidad de contratos.
7. Publicación de artefactos inmutables.
8. Deploy a staging y smoke tests.
9. Aprobación para producción.
10. Rolling/canary deploy, migración expand y verificación automática.
11. Observación, promoción, pausa o abort según métricas.

### Tareas

- [ ] Crear workflows separados para PR, nightly, staging y producción.
- [ ] Añadir ambientes protegidos y permisos OIDC para el proveedor cloud.
- [ ] Definir versionado, changelog y release notes.
- [ ] Añadir rollback de imagen, kill switches y procedimiento de roll-forward.
- [ ] Ejecutar pruebas de recuperación antes del release candidato.
- [ ] Publicar una matriz de compatibilidad de versiones de API/esquema.

### Criterios de salida

- Un PR no puede saltarse checks críticos.
- Un release puede rastrearse a commit, imagen, migración y configuración.
- Existe un procedimiento probado para abortar y para recuperar.

## 6. Backlog de documentación técnica

Crear estos documentos a medida que se implementan las fases:

- [ ] `docs/architecture/system-context.md` — contexto, contenedores y dependencias.
- [ ] `docs/architecture/data-ownership.md` — dueño y clasificación de cada tabla.
- [ ] `docs/architecture/tenant-isolation.md` — invariantes, RLS, cache, jobs y storage.
- [ ] `docs/adr/ADR-001-architecture.md` — monorepo y límites de servicios.
- [ ] `docs/adr/ADR-002-tenant-isolation.md` — repository layer + RLS.
- [ ] `docs/adr/ADR-003-orm-and-migrations.md` — Drizzle y SQL explícito.
- [ ] `docs/adr/ADR-004-transactional-outbox.md` — outbox frente a dual writes.
- [ ] `docs/adr/ADR-005-payment-saga.md` — pagos e incertidumbre.
- [ ] `docs/adr/ADR-006-inventory-concurrency.md` — reservas/locks/conditional update.
- [ ] `docs/adr/ADR-007-webhook-delivery.md` — firma, retries y dedupe.
- [ ] `docs/adr/ADR-008-cache-invalidation.md` — TTL, keys y eventos.
- [ ] `docs/adr/ADR-009-deploy-migrations.md` — expand-contract y rollback.
- [ ] `docs/runbooks/worker-failure.md`.
- [ ] `docs/runbooks/payment-unknown.md`.
- [ ] `docs/runbooks/dlq-replay.md`.
- [x] `docs/runbooks/database-restore.md`.
- [ ] `docs/runbooks/rollback.md`.
- [ ] `docs/failure-scenarios/*.md` con evidencia de los laboratorios.
- [ ] `docs/api/` con OpenAPI y ejemplos seguros.

## 7. Definition of Done global

Una capacidad no se considera terminada hasta que:

- [ ] tiene modelo de datos y migración revisados;
- [ ] aplica tenant isolation en API, repository, DB, cache, jobs y storage;
- [ ] valida identidad, permiso, input y estado;
- [ ] tiene idempotencia donde un retry pueda producir efectos;
- [ ] registra auditoría de acciones sensibles;
- [ ] tiene logs, métricas, traces y correlation IDs suficientes;
- [ ] tiene unit, integration y E2E tests según riesgo;
- [ ] tiene comportamiento documentado ante timeout, duplicado y dependencia caída;
- [ ] tiene documentación de uso y runbook si requiere operación;
- [ ] pasa CI y no introduce una migración incompatible;
- [ ] cuenta con una evidencia reproducible para mostrar en una entrevista.

## 8. Métricas y objetivos iniciales

Son objetivos de diseño para staging y producción pequeña; se calibrarán con carga real.

| Área           | Objetivo inicial                             | Señal                      |
| -------------- | -------------------------------------------- | -------------------------- |
| API lectura    | p95 < 300 ms en endpoints comunes            | HTTP duration              |
| API escritura  | p95 < 500 ms sin contar jobs externos        | HTTP duration              |
| Error rate     | < 1% excluyendo errores de input             | 5xx / requests             |
| Outbox         | p95 de entrega interna < 30 s                | event age                  |
| Jobs           | retries y age dentro de SLA por cola         | BullMQ metrics             |
| Aislamiento    | 0 cross-tenant findings                      | security/integration suite |
| Disponibilidad | objetivo a definir con costo de staging/prod | uptime                     |
| Recuperación   | RTO/RPO documentados antes de producción     | restore drill              |

## 9. Orden recomendado de demostraciones para entrevistas

1. Mostrar dos subdominios y probar aislamiento con datos similares.
2. Enseñar RBAC y una acción denegada tanto en UI como en API.
3. Ejecutar el test concurrente de stock 1.
4. Matar el worker durante un pago y mostrar que el retry no duplica el cobro.
5. Mostrar outbox, job, trace y audit log de una misma operación.
6. Reenviar un webhook y demostrar dedupe/firma.
7. Ejecutar una migración expand-contract con una versión vieja aún activa.
8. Forzar un error, revisar dashboard/runbook y recuperar desde DLQ.

## 10. Riesgos y controles

| Riesgo                              | Control                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Scope creep                         | Priorizar el vertical slice de orden/inventario y diferir features no esenciales. |
| Falsa sensación de aislamiento      | RLS + repositories explícitos + tests A/B + revisión de cache/jobs/storage.       |
| Dual write perdido                  | Transactional outbox y reconciliación.                                            |
| Retries duplican efectos            | Idempotency keys locales y del proveedor; dedupe por job/event ID.                |
| Migraciones peligrosas              | Expand-contract, backfill observable y compatibilidad entre versiones.            |
| Complejidad prematura de Kubernetes | Docker Compose primero; Kubernetes solo después de tener comportamiento probado.  |
| Observabilidad costosa o insegura   | Sampling, redacción, cardinalidad controlada y no enviar secretos.                |
| Tests lentos/frágiles               | Unit rápido; integración con contenedores; E2E pequeño y determinista.            |
| Dependencia de un proveedor         | Interfaces para OIDC, pagos y S3; adaptadores probados con fakes.                 |

## 11. Primeros pasos ejecutables

La siguiente sesión debe comenzar por la Fase 0 en este orden:

1. Inicializar el workspace y las aplicaciones vacías.
2. Añadir configuración, scripts y CI mínimo.
3. Levantar PostgreSQL, Redis y MinIO con Docker Compose.
4. Crear la primera migración de `users`, `organizations` y `memberships`.
5. Implementar el contexto de request y un endpoint protegido de diagnóstico.
6. Escribir el primer test que demuestra que A no puede leer datos de B.
7. Actualizar el registro de continuidad de este documento.

No avanzar a órdenes, pagos o Kubernetes hasta que exista esa prueba base de aislamiento. Es la propiedad que condiciona todo el resto del proyecto.

> Progreso sesion 3: se aplicaron las migraciones 0001/0002 contra PostgreSQL 16, la prueba RLS A/B paso con pool maximo 1 y la API persistente cubre sesiones, organizaciones, membresias, sucursales, invitaciones y auditoria. La integracion valida que el contexto tenant no se pega a conexiones reutilizadas.
