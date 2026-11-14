# Identidad, sesión y contexto tenant

- Estado: implementado y verificado el 2026-11-13
- Alcance: `apps/api`, `apps/web`, `packages/auth`, `packages/db`
- Autoridad: el host resuelve el tenant; la sesión y la membresía resuelven la autorización

## 1. Secuencia de una request tenant-scoped

1. La API obtiene el token de la cookie `platform_session` o de `Authorization: Bearer`.
2. La sesión se busca por hash de token y se valida que no haya expirado; el usuario debe estar `active`.
3. El host se toma de `Host`. La API no consulta `x-forwarded-host`; el BFF web solo lo hace con `TRUST_PROXY=1`.
4. Se acepta exactamente un subdominio bajo `TENANT_BASE_DOMAIN`.
5. Se busca la organización por slug y se exige estado `active`.
6. Se exige una membresía activa del usuario en esa organización. Sin ella, la respuesta es `403`.
7. Si el usuario tiene más de una membresía, la sesión debe haber seleccionado una organización explícitamente; si no, `409 ORGANIZATION_SELECTION_REQUIRED`.
8. Las policies RBAC se aplican en la API antes de cada acción. La UI puede ocultar acciones, pero no es autoridad.
9. La transacción de base de datos fija `app.tenant_id` y `app.user_id`; RLS vuelve a filtrar.

`x-api-key` es un camino M2M separado: resuelve el tenant por host, verifica `prefix + hash` y aplica scopes. No crea una sesión humana.

## 2. Cookies y topología de sesión

| Cookie             | Dónde vive    | Atributos                                                         | Propósito                                                     |
| ------------------ | ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `platform_session` | API y BFF web | `HttpOnly`, `SameSite=Lax`, `Path=/`, 8 h, `Secure` en producción | Token de sesión de la API; el BFF lo guarda para el navegador |
| `oidc_state`       | API           | `HttpOnly`, `SameSite=Lax`, `Path=/v1/auth`, 10 min               | State/nonce del login OIDC directo                            |
| `oidc_state`       | BFF web       | `HttpOnly`, `SameSite=Lax`, 10 min                                | State del callback OIDC que termina en el BFF                 |

- La cookie del BFF es **host-only** por defecto (`SESSION_COOKIE_DOMAIN` vacío). No hay SSO entre subdominios de tenant; cada tenant tiene su propia sesión de navegador.
- El token de la API nunca se expone a JavaScript del cliente ni en HTML. Las rutas `/api/v1/*` del BFF leen la cookie server-side y reenvían `Authorization: Bearer`.
- El callback OIDC del web (`/api/auth/callback`) canjea `code + state` contra la API y aplica la cookie de sesión en el origen del tenant. La API directa usa `/v1/auth/callback`.
- `POST /v1/auth/refresh` extiende la sesión deslizante; existe un límite absoluto (`absolute_expires_at`) además de la expiración deslizante.

## 3. Rutas de identidad

| Ruta                                         | Control                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/auth/login`                         | Inicia OIDC con `state`, `nonce` y cookie de state                           |
| `GET /v1/auth/callback`                      | State de un solo uso, canje de code, validación de ID token y sesión         |
| `POST /v1/auth/dev-login`                    | Solo fuera de producción; usuario demo                                       |
| `GET /v1/auth/me`                            | Sesión activa; devuelve identidad y organizaciones disponibles               |
| `POST /v1/auth/logout`                       | Revoca la sesión actual                                                      |
| `POST /v1/auth/refresh`                      | Extiende la sesión si sigue vigente                                          |
| `POST /v1/auth/switch-organization`          | Membresía activa y selección explícita                                       |
| `POST /v1/organizations`                     | Sesión; crea organización y owner; audita                                    |
| `GET /v1/context`                            | Host, organización activa, membresía y permisos efectivos                    |
| `GET /v1/members`                            | `members:read`                                                               |
| `POST /v1/members/invitations`               | `members:invite`; token hasheado, TTL y uso único                            |
| `POST /v1/members/invitations/:token/accept` | Sesión, host objetivo, email coincidente y tenant validado antes del consumo |
| `PATCH /v1/members/:membershipId`            | `members:update_role`; mantiene un owner                                     |
| `DELETE /v1/members/:membershipId`           | `members:remove`; mantiene un owner                                          |
| `GET /v1/audit`                              | `audit:read`; eventos tenant-scoped append-only                              |

## 4. Persistencia y RLS

El adaptador persistente es el camino normal cuando existe `DATABASE_URL`:

- `platform_app` sirve requests tenant-scoped y solo ve filas con `app.tenant_id`.
- `platform_auth` es el camino estrecho de credenciales (`users`, `sessions`, `invitations`, organizaciones).
- `platform_worker` es el relay global y no sirve requests de usuario.
- `platform_app` no puede borrar organizaciones ni membresías; eso queda en `platform_auth`.
- Las sesiones ya no son legibles por tenant sin `app.user_id`: la policy `sessions_user_bound` las ata al usuario.
- Los eventos globales de auditoría se guardan en `platform_audit_log`; `audit_log` exige `tenant_id NOT NULL`.

En tests unitarios existe un store en memoria; no es el camino de producción y no debe citarse como evidencia de aislamiento real.

## 5. Demostración local

1. Arrancar la infraestructura: `docker compose up -d postgres redis`.
2. Arrancar desde la raíz para cargar `.env`: `pnpm dev`.
3. Crear sesión demo para `user-acme-only` con `POST /v1/auth/dev-login`.
4. Consultar `GET /v1/context` con `Host: acme.app.localhost:4000`: responde `200`.
5. Repetir con `Host: contoso.app.localhost:4000`: responde `403`.
6. Crear sesión demo para `user-alice`: el primer contexto responde `409` y enumera organizaciones seguras.
7. Cambiar a `contoso` y usar `Host: contoso.app.localhost:4000`.

No se deben usar datos seed ni `dev-login` fuera de desarrollo/test. Para el flujo de navegador, usar `acme.app.localhost:3000` y el BFF.
