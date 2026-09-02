# Runbook — GDPR erasure (derecho al olvido)

## Objetivo

Anonimizar un `user` en su `tenant` sin romper FK audit/orders, preservando `audit_log` 365d y obligación fiscal.

## Precondiciones

- Solicitud escrita verificada (art. 17): identidad `email` + `oidc_subject` + `tenant slug`, motivo.
- Aprobación `owner` del tenant + `dpo` si `platform_app` considera `legal_hold`.
- No hay `payment_attempts` `pending|unknown` que requieran `created_by` para reconciliación (esperar `paid|failed`).

## Pasos (InMemory demo + Persistent)

### 1. Verificar membership y alcance

```bash
COOKIE_OWNER=$(curl -s -c - http://localhost:4000/v1/auth/dev-login -d '{"userId":"user-alice"}' | grep platform_session | awk '{print $7}')
curl -s http://localhost:4000/v1/members -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE_OWNER" | jq '.data[] | select(.userId=="user-acme-only")'
# -> {id: membership-acme-only, role: operator}
```

### 2. Lanzar anonymize (InMemory demo)

```bash
# Simula worker anonymize_user (InMemoryIdentityStore):
# node -e "store.users.set('user-acme-only', {...user, email:'anonymized-'+hash+'@example.invalid', displayName:'Deleted User', active:false}); store.memberships.forEach(m=>{if(m.userId==='user-acme-only') m.status='removed'})"
```

Persistent:

```sql
-- como app user (via API audit), no directo; worker hace:
BEGIN;
SET LOCAL ROLE platform_app;
SET LOCAL "app.tenant_id" = 'tenant-acme';
UPDATE users SET email='anonymized-'||substr(md5(id::text),1,8)||'@example.invalid',
  display_name='Deleted User', oidc_subject='deleted:'||id, active=false, updated_at=now()
  WHERE id='user-acme-only'::uuid;

UPDATE memberships SET active=false, updated_at=now()
  WHERE user_id='user-acme-only'::uuid AND tenant_id='tenant-acme'::uuid;

UPDATE files SET owner_id=null, updated_at=now() WHERE owner_id='user-acme-only'::uuid AND tenant_id='tenant-acme'::uuid;

UPDATE audit_log SET metadata = jsonb_set(metadata, '{actor_hash}', to_jsonb(substr(md5('user-acme-only'),1,8)))
  WHERE actor_user_id='user-acme-only'::uuid AND tenant_id='tenant-acme'::uuid;
-- NOTA: no DELETE audit_log; retention 365d luego archive S3 WORM
COMMIT;
```

### 3. Registrar auditoría

```bash
curl -s http://localhost:4000/v1/audit?limit=5 -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE_OWNER" | jq
# -> {action: "gdpr.erasure.completed", actorUserId: "user-alice", tenantId: "tenant-acme", resourceId: "user-acme-only", traceId, ip}
```

`auditBase` registra `traceId` de `x-trace-id`, `ip` de `request.ip`, `result: success`.

### 4. Verificar

```bash
psql $DATABASE_URL -c "SELECT id, email, display_name, active FROM users WHERE id='user-acme-only'"
# -> anonymized-...@example.invalid | Deleted User | false

curl -s http://localhost:4000/v1/members -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE_OWNER" | jq '.data | map(select(.userId=="user-acme-only"))'
# -> [] (membership removed)

curl -s http://localhost:4000/v1/files -H 'host: acme.app.localhost' -H "cookie: platform_session=$COOKIE_OWNER" | jq
# -> owner_id null
```

### 5. Notificar y archivar

- Notificar interesado (ticket) + registrar `action: gdpr.erasure.notified`.
- Archivar ticket 3 años (fuera de DB).
- Si tenant churn completo: `DELETE FROM organizations WHERE id='tenant-acme'` cascade tras 30d + `audit_log` archivo.

## Rollback

No hay un-erase: `users` anonimizado no es reversible. Si se hizo por error, crear nuevo `user` con nuevo `oidc_subject` (re-invite).

## Checklist

- [ ] Solicitud verificada + aprobación owner/dpo
- [ ] `payment_attempts` no `pending|unknown`
- [ ] `anonymize_user` worker ejecutado + `SELECT` verifica `email` anonimizada
- [ ] `GET /v1/audit` entry `gdpr.erasure.completed` con `traceId/ip`
- [ ] `GET /v1/members` no muestra user
- [ ] Ticket archivado

## Estado

- InMemory demo listo; Persistent `UPDATE users` + `memberships` + `files` probado.
- Endpoint formal `POST /v1/admin/gdpr/erasure` futuro (hoy es worker manual); pendiente `GET /v1/audit/export` presigned S3.
