# Matriz de permisos inicial

La UI puede ocultar acciones por ergonomía, pero esta matriz se aplica en la API y en la capa de dominio. Un rol no puede inferirse del subdominio ni del `user_id` enviado por el cliente.

| Recurso          | Owner                             | Admin                             | Manager                           | Operator           | Auditor |
| ---------------- | --------------------------------- | --------------------------------- | --------------------------------- | ------------------ | ------- |
| Organización     | read/update                       | read                              | read                              | read               | read    |
| Miembros         | read/invite/update_role/remove    | read/invite/update_role/remove    | read                              | —                  | read    |
| Sucursales       | read/create/update/archive        | read/create/update/archive        | read/update                       | read               | read    |
| Órdenes          | read/create/approve/update/cancel | read/create/approve/update/cancel | read/create/approve/update/cancel | read/create/update | read    |
| Inventario       | read/adjust/reserve               | read/adjust/reserve               | read/adjust/reserve               | read/reserve       | read    |
| Archivos         | read/upload/delete                | read/upload/delete                | read/upload                       | read/upload        | read    |
| Automatizaciones | read/manage                       | read/manage                       | read                              | —                  | —       |
| Webhooks         | read/manage/replay                | read/manage/replay                | read                              | —                  | —       |
| Auditoría        | read                              | read                              | read                              | —                  | read    |
| Billing          | manage                            | —                                 | —                                 | —                  | —       |

Notas:

- `admin` no tiene `billing:manage` en el contrato inicial.
- `owner` es el único rol con permiso de billing.
- Las operaciones administrativas cross-tenant, si se agregan, tendrán una superficie separada y no reutilizarán estos permisos.
- La matriz es una línea base: una feature nueva debe añadir permiso explícito y sus pruebas negativas.
