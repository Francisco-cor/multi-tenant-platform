# Identidad y contexto tenant

## Alcance de la Fase 2

La API resuelve una request tenant-scoped con esta secuencia:

1. La sesión se obtiene de la cookie "platform_session" o de un bearer token.
2. Se valida que la sesión no haya expirado y que el usuario esté activo.
3. El host se toma únicamente de "Host"; "x-forwarded-host" no es una fuente de autorización.
4. Se acepta exactamente un subdominio bajo "TENANT_BASE_DOMAIN".
5. Se busca la organización por slug y se exige estado "active".
6. Se exige una membresía activa del usuario en esa organización.
7. Si hay más de una membresía, la sesión debe haber seleccionado explícitamente una organización.
8. Las políticas RBAC se aplican en la API antes de cada acción.

El store actual es deliberadamente en memoria. Es un adaptador de desarrollo para validar el contrato de la frontera; la Fase 3 lo reemplazará por PostgreSQL, migraciones, transacciones y RLS sin cambiar las rutas ni las políticas.

## OIDC

- "GET /v1/auth/login" crea "state" y "nonce" aleatorios, los guarda con TTL de 10 minutos y devuelve una cookie HttpOnly SameSite=Lax.
- El issuer se descubre mediante ".well-known/openid-configuration".
- "GET /v1/auth/callback" exige que el state de query coincida con la cookie y que el state sea de un solo uso.
- El code se intercambia en el token endpoint.
- El ID token valida firma RS256 mediante JWKS, issuer, audience, expiración, iat, nonce, subject y email.
- La cookie de sesión es HttpOnly; en producción añade "Secure".
- "POST /v1/auth/dev-login" existe solo fuera de producción para demos y pruebas reproducibles.

## Operaciones principales

| Ruta                                         | Control                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| "GET /v1/auth/me"                            | sesión activa; devuelve organizaciones disponibles                           |
| "POST /v1/auth/switch-organization"          | membresía activa y selección explícita                                       |
| "POST /v1/organizations"                     | sesión; crea organización y owner; audita                                    |
| "GET /v1/context"                            | host, organización activa, membresía y permisos efectivos                    |
| "GET /v1/members"                            | "members:read"                                                               |
| "POST /v1/members/invitations"               | "members:invite"; token hasheado, TTL y uso único                            |
| "POST /v1/members/invitations/:token/accept" | sesión, host objetivo, email coincidente y tenant validado antes del consumo |
| "PATCH /v1/members/:membershipId"            | "members:update_role"; mantiene un owner                                     |
| "DELETE /v1/members/:membershipId"           | "members:remove"; mantiene un owner                                          |
| "GET /v1/audit"                              | "audit:read"; eventos append-only del tenant                                 |

## Demostración local

1. Iniciar la API con "pnpm --filter @platform/api dev".
2. Crear sesión demo para "user-acme-only" mediante "POST /v1/auth/dev-login".
3. Consultar "GET /v1/context" con "Host: acme.app.localhost": responde 200.
4. Repetir con "Host: contoso.app.localhost": responde 403.
5. Crear sesión demo para "user-alice": el primer contexto responde 409 y enumera organizaciones seguras.
6. Cambiar a "contoso" y usar "Host: contoso.app.localhost".

No se deben usar datos seed ni "dev-login" fuera de desarrollo/test.
