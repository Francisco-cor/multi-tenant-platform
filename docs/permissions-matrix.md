# Matriz de permisos

- Fuente de verdad: `packages/domain/src/index.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`)
- Última verificación: 2026-11-13
- Aplicación: la API comprueba permisos en cada ruta; la UI solo oculta acciones por ergonomía

## Matriz por recurso

| Recurso          | Owner                                 | Admin                                 | Manager                               | Operator             | Auditor |
| ---------------- | ------------------------------------- | ------------------------------------- | ------------------------------------- | -------------------- | ------- |
| Organización     | read, update                          | read, update                          | read                                  | read                 | read    |
| Miembros         | read, invite, update_role, remove     | read, invite, update_role, remove     | read                                  | —                    | read    |
| Sucursales       | read, create, update, archive         | read, create, update, archive         | read, update                          | read                 | read    |
| Órdenes          | read, create, approve, update, cancel | read, create, approve, update, cancel | read, create, approve, update, cancel | read, create, update | read    |
| Inventario       | read, adjust, reserve                 | read, adjust, reserve                 | read, adjust, reserve                 | read, reserve        | read    |
| Archivos         | read, upload, delete                  | read, upload, delete                  | read, upload                          | read, upload         | read    |
| Automatizaciones | read, manage                          | read, manage                          | read                                  | —                    | —       |
| Webhooks         | read, manage, replay                  | read, manage, replay                  | read                                  | —                    | —       |
| Auditoría        | read                                  | read                                  | read                                  | —                    | read    |
| Billing          | manage                                | —                                     | —                                     | —                    | —       |

## Notas

- `owner` es el único rol con `billing:manage`.
- `admin` tiene todos los permisos de `owner` salvo `billing:manage`.
- `manager` puede leer auditoría y ajustar inventario, pero no invitar miembros ni gestionar webhooks.
- `operator` puede crear/actualizar órdenes y reservar inventario; no puede invitar, ajustar inventario, gestionar webhooks ni leer auditoría.
- `auditor` es read-only y no puede mutar órdenes, inventario ni archivos.
- La API M2M usa scopes de API key, no esta matriz de roles humanos.
- Las operaciones cross-tenant administrativas, si se agregan, tendrán una superficie separada y no reutilizarán estos permisos.
- La matriz debe cambiar junto con `ROLE_PERMISSIONS`; una feature nueva añade permiso explícito y prueba negativa.
