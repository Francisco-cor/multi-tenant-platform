# Estados de dominio iniciales

## Organización

```text
active -> suspended -> active
active -> archived
suspended -> archived
```

Una organización `archived` no acepta operaciones de negocio. La reactivación de una organización archivada requiere una decisión explícita de administración y no forma parte de la primera implementación.

## Membresía

```text
invited -> active -> suspended -> active
invited -> removed
active -> removed
suspended -> removed
```

Los tokens de invitación son de un solo uso y tienen expiración. `removed` es terminal para esa membresía.

## Orden

```text
draft -> pending_payment -> paid -> processing -> completed
draft -> cancelled
pending_payment -> failed
pending_payment -> cancelled
paid -> cancelled
processing -> failed
```

Las transiciones se validan en dominio y generan auditoría/evento. El proveedor de pagos puede confirmar de forma asíncrona; `pending_payment` no se interpreta como `failed` solo por un timeout.

## Reserva de inventario

```text
active -> consumed
active -> released
active -> expired
```

Una reserva vencida se libera mediante un job idempotente. El movimiento y la transición deben ser atómicos en PostgreSQL.
