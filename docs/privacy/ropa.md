# ROPA — registro de actividades de tratamiento

- Owner: `platform-security` / DPO (futuro)
- Última revisión: 2026-11-13
- Estado: borrador operativo; no sustituye asesoría legal

| Actividad           | Datos                                             | Titular            | Base jurídica                       | Retención                                             | Destinatarios                  |
| ------------------- | ------------------------------------------------- | ------------------ | ----------------------------------- | ----------------------------------------------------- | ------------------------------ |
| Identidad y acceso  | `email`, `display_name`, `oidc_subject`, sesión   | Usuario del tenant | Contrato                            | Mientras haya cuenta; sesión 8 h                      | Proveedor OIDC, plataforma     |
| Gestión de miembros | `email`, rol, estado                              | Usuario del tenant | Contrato                            | Mientras dure la membresía                            | Plataforma                     |
| Auditoría           | actor, tenant, acción, recurso, request/trace, IP | Usuario/tenant     | Interés legítimo (seguridad/fraude) | 365 días                                              | Plataforma; acceso restringido |
| Órdenes y pagos     | `amount`, moneda, referencia de pago, estado      | Cliente del tenant | Contrato / obligación legal         | 7 años (propuesto)                                    | Proveedor de pagos             |
| Archivos            | `filename`, content type, tamaño, key             | Usuario del tenant | Contrato                            | `pending` 24 h; `ready` según tenant                  | S3                             |
| Webhooks            | URL, eventos, entregas, secreto cifrado           | Tenant             | Contrato                            | Entregas 30 días; endpoints hasta baja                | Receptor del tenant            |
| Logs técnicos       | `tenantHash`, `requestId`, `traceId`, estado HTTP | Usuario/tenant     | Interés legítimo                    | Según retención de observabilidad (propuesta 30 días) | Plataforma                     |

## Subencargados

- PostgreSQL/Redis/S3 gestionados (producción; proveedor a definir).
- Proveedor OIDC (Dex local; Auth0 u otro en producción).
- Proveedor de pagos (Stripe en modo adapter; no live-tested).
- Observabilidad (OTel/Prometheus/Grafana; logs con tenant hasheado).

## Derechos

Ver `docs/privacy/gdpr.md` y `docs/runbooks/gdpr-erasure.md`. El endpoint formal de erasure y la exportación siguen pendientes; el procedimiento actual es manual y requiere ticket.

## Gaps

- DPO y base legal definitiva sin designar.
- ROPA no validado legalmente.
- Retención de logs/backups no automatizada.
- KMS/Vault y egress proxy pendientes.
