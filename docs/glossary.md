# Glosario inicial

| Término         | Definición                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tenant          | Organización cliente cuyo espacio lógico y datos deben estar aislados. En el dominio se representa por `organization`. |
| Organization    | Entidad raíz del espacio de una compañía; tiene slug, estado, sucursales y miembros.                                   |
| Branch          | Sucursal operativa dentro de una organización.                                                                         |
| User            | Identidad global proveniente de OIDC; no autoriza por sí sola el acceso a un tenant.                                   |
| Membership      | Relación entre user y organization; contiene estado y rol.                                                             |
| Request context | Contexto autenticado con tenant, usuario, membresía, roles y correlation IDs.                                          |
| Repository      | Frontera de acceso a datos. Los repositories tenant-scoped reciben `tenantId` explícito.                               |
| Idempotency key | Clave del cliente que permite repetir una operación sin repetir su efecto.                                             |
| Outbox event    | Evento persistido en la misma transacción que el cambio de negocio y publicado después.                                |
| DLQ             | Dead-letter queue: trabajos que agotaron retries o requieren intervención.                                             |
| Audit log       | Registro append-only de acciones sensibles, separado de logs técnicos.                                                 |
| Correlation ID  | Identificador que conecta request, logs, eventos, jobs y webhooks.                                                     |
