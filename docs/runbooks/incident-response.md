# Runbook — respuesta a incidentes

- Owner: `platform-security` (coordinación) con owners de servicio
- Última revisión: 2026-11-13
- Cadencia: revisión trimestral y después de cada SEV1/SEV2
- Estado: procedimiento manual; no hay guardia 24/7 contratada

## 1. Alcance

Aplica a API, web/BFF, worker, PostgreSQL, Redis, S3, pagos, webhooks, autenticación, aislamiento tenant y cadena de CI/CD. Un incidente es cualquier degradación que afecte a clientes, integridad de datos, aislamiento o cumplimiento.

## 2. Severidades

| Nivel | Definición                                                      | Ejemplos                                                                    | Respuesta objetivo                              | Comunicación                                      |
| ----- | --------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| SEV1  | Pérdida de servicio o datos, fuga cross-tenant, cobro duplicado | API caída para todos, acceso a datos de otro tenant, doble cobro confirmado | 15 min para incident commander; mitigar primero | Estado cada 30 min; aviso a dirección y seguridad |
| SEV2  | Degradación grave o función crítica inutilizable                | Errores 5xx >5 %, pagos en `unknown`, webhooks caídos                       | 30 min                                          | Estado cada 60 min                                |
| SEV3  | Degradación limitada con workaround                             | Un tenant con rate limit, DLQ creciendo, S3 intermitente                    | 4 h laborables                                  | Estado al cierre                                  |
| SEV4  | Bajo impacto o pregunta operativa                               | Alerta informativa, documento desactualizado                                | 1 día laborable                                 | Ticket                                            |

Si hay duda entre dos niveles, se elige el más alto hasta tener datos.

## 3. Roles

| Rol                     | Responsabilidad                                                   | Owner por defecto                                                     |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Incident Commander (IC) | Decide severidad, coordina, aprueba mitigaciones y declara cierre | `platform-security`                                                   |
| Operations Lead         | Ejecuta cambios en infra/app, aplica rollback o kill switch       | `platform-infra`                                                      |
| Service Owner           | Conoce el servicio y valida la corrección                         | `platform-api`, `platform-worker`, `platform-payments`, `platform-db` |
| Communications Lead     | Actualiza estado a stakeholders y clientes                        | `platform-support`                                                    |
| Scribe                  | Cronología, decisiones, enlaces y evidencia                       | Quien no esté ejecutando                                              |

Una persona puede cubrir varios roles en un incidente pequeño, pero el IC no debe ser también el único ejecutor en un SEV1.

## 4. Flujo

1. **Detectar y declarar.** Abrir un canal de incidente, asignar IC y registrar hora, severidad y sistemas afectados.
2. **Estabilizar.** Preferir mitigaciones reversibles: rollback de app, kill switch por tenant (`kill_orders_write`, `kill_webhooks`), deshabilitar un endpoint o pausar un job. No ejecutar `DROP` ni cambios destructivos de esquema.
3. **Diagnosticar.** Seguir `docs/runbooks/observability.md`: alerta → métrica → `traceId`/`requestId` → logs → DB/outbox → worker.
4. **Comunicar.** Usar la plantilla de la sección 6. No especular ni atribuir causas antes de confirmarlas.
5. **Resolver y verificar.** Confirmar con métricas, smoke y una lectura de datos real. Un `200` aislado no es recuperación.
6. **Cerrar.** Declarar cierre, programar postmortem y crear acciones con owner y fecha.

## 5. Escalation

| Situación                       | Escalar a                            | Canal                                     |
| ------------------------------- | ------------------------------------ | ----------------------------------------- |
| Posible fuga cross-tenant       | `platform-security` + dirección      | Incidente SEV1 privado                    |
| Doble cobro o pérdida de pago   | `platform-payments` + proveedor      | Incidente SEV1                            |
| DB corrupta o restore necesario | `platform-db` + `platform-infra`     | Incidente SEV1                            |
| Secreto comprometido            | `platform-security`                  | Rotación inmediata; ver `key-rotation.md` |
| CI/CD comprometido              | `platform-security` + mantenedores   | Revocar tokens, revisar artefactos        |
| Sin respuesta del owner         | IC escala a `@platform-architecture` | `CODEOWNERS`                              |

## 6. Comunicación

Plantilla de actualización:

```text
[SEVn] <título>
Impacto: <quién/qué>
Inicio: <UTC>
Estado: investigando | mitigado | monitorizando | resuelto
Última acción: <cambio aplicado>
Próxima actualización: <UTC>
Riesgo residual: <ninguno | ...>
```

- No incluir secretos, tokens, PII ni IDs de otro tenant.
- No prometer tiempos de resolución sin evidencia.
- Las decisiones de mitigación se registran en la cronología con hora y responsable.

## 7. Postmortem

Plantilla obligatoria para SEV1/SEV2, opcional para SEV3:

```markdown
# Postmortem — <título>

- Fecha / duración / severidad:
- IC / owners:
- Sistemas afectados:
- Impacto en clientes y tenants:
- Detección (alerta, cliente, revisión):
- Cronología UTC (hechos, no interpretaciones):
- Causa raíz:
- Factores contribuyentes:
- Qué funcionó:
- Qué no funcionó:
- Acciones: [ID, owner, fecha, tipo: preventiva/detectiva/mitigante]
- Evidencia: dashboards, trazas, queries, commits
- ¿Se ejerció el runbook? ¿Qué falta?
```

Regla: sin culpabilización individual; se corrigen sistemas y decisiones. Las acciones se siguen en el backlog con owner y fecha, no solo en el documento.

## 8. Owners y alertas

Los owners de alerta están en `infra/prometheus/alerts.yml`: `platform-api`, `platform-worker`, `platform-payments`, `platform-db`, `platform-cache`, `platform-rate-limit`, `platform-infra`, `platform-resilience`, `platform-security`.

Alertas sin runbook específico deben apuntar a este documento. La alerta `MetricsScrapeDenied` y `TenantIsolationViolation` son SEV1/SEV2 y requieren revisión de seguridad.

## 9. Evidencia mínima al cerrar

- [ ] Hora de inicio, detección, mitigación y cierre.
- [ ] Impacto cuantificado (tenants, requests, pagos, jobs).
- [ ] Cambio aplicado y commit/imagen.
- [ ] Métricas antes/después.
- [ ] Acciones con owner y fecha.
- [ ] Enlace al postmortem.
