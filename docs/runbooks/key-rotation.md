# Runbook — rotación de claves y secretos

- Owner: `platform-security`
- Ejecutor: `platform-infra` + service owner
- Última revisión: 2026-11-13
- Cadencia: secretos de proveedor cada 90 días o ante sospecha; clave de cifrado de webhooks cada 180 días (objetivo)
- Estado: **sin KMS/Vault**; toda la rotación es manual y requiere ventana de mantenimiento

## 1. Inventario de secretos

| Secreto                                      | Variable                          | Dónde se usa           | Rotación actual                                                   |
| -------------------------------------------- | --------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| Clave maestra de cifrado de secretos webhook | `WEBHOOK_SECRET_ENCRYPTION_KEY`   | API y worker (AES-GCM) | Manual, requiere re-cifrar ciphertexts                            |
| Secreto de endpoint webhook                  | `secret_ciphertext` por endpoint  | Worker al firmar       | Automática vía API, ventana 24 h                                  |
| API keys M2M                                 | hash en `api_keys`                | API                    | Automática vía `POST /v1/api-keys/:id/rotate`, revoca la anterior |
| Stripe/provider key                          | `PAYMENT_PROVIDER_API_KEY`        | Worker                 | Manual en proveedor + entorno                                     |
| Stripe webhook secret                        | `PAYMENT_PROVIDER_WEBHOOK_SECRET` | API                    | Manual; coordinar con Stripe                                      |
| Webhook inbound genérico                     | `WEBHOOK_INBOUND_SECRET`          | API                    | Manual                                                            |
| Webhook payment genérico                     | `PAYMENT_WEBHOOK_SECRET`          | API                    | Manual                                                            |
| OIDC client secret                           | `OIDC_CLIENT_SECRET`              | API                    | Manual; no hay ventana `_OLD` implementada                        |
| S3 credenciales                              | `S3_ACCESS_KEY`, `S3_SECRET_KEY`  | API/worker             | Manual/IAM                                                        |
| Sesiones                                     | token opaco en `sessions`         | API                    | Se invalidan al expirar o revocar; no hay rotación masiva         |

## 2. Clave maestra de webhooks

`WEBHOOK_SECRET_ENCRYPTION_KEY` debe ser base64url de 32 bytes (43+ caracteres). El código valida longitud y decodificación. Se usa para `encryptWebhookSecret`/`decryptWebhookSecret` (AES-256-GCM).

### Gap actual

- No hay KMS/Vault ni envelope encryption.
- La clave vive en el entorno del proceso.
- No existe un script versionado de re-cifrado masivo; el procedimiento es manual y debe probarse en staging antes de producción.

### Procedimiento manual (staging primero)

1. Generar la clave nueva fuera del repo: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Guardar la clave nueva y la anterior en el gestor de secretos de la organización (no en Git, no en tickets).
3. Programar una ventana: durante el re-cifrado, API y worker deben usar la misma clave.
4. Exportar `webhook_endpoints` con `id`, `secret_ciphertext` y `secret_version` (sin `secret_hash` innecesario) a un entorno controlado.
5. Desencriptar cada ciphertext con la clave anterior y re-cifrar con la nueva usando `@platform/config` en un proceso de un solo uso. No imprimir secretos en logs.
6. Actualizar las filas en una transacción por lote; verificar el conteo antes/después y que ningún `secret_ciphertext` quede vacío.
7. Desplegar API y worker con la clave nueva; reiniciar procesos para que no quede la anterior en memoria.
8. Enviar un webhook de prueba a un endpoint controlado y verificar firma; revisar `webhook_deliveries` y logs.
9. Destruir la clave anterior del gestor después de 24 h sin errores.
10. Registrar fecha, commit, endpoints afectados y evidencia.

Si algo falla, restaurar la clave anterior y los ciphertexts desde el backup de la tabla; no rotar la clave de sesión ni la de pagos en el mismo cambio.

### Rotación de secreto de un endpoint (sí automatizada)

`POST /v1/webhooks/endpoints/:id/rotate-secret`:

- genera 32 bytes base64url y `secret_hash` sha256;
- cifra el nuevo secreto con AES-GCM;
- incrementa `secret_version`;
- conserva `previous_secret_ciphertext` y `previous_secret_version` durante 24 h;
- audita `webhook.secret_rotated`.

El worker firma con la versión que corresponde a la entrega y acepta la anterior mientras no expire. No hay KMS: la protección depende de la clave maestra.

## 3. API keys

`POST /v1/api-keys/:id/rotate` crea una clave nueva y revoca la anterior en la misma operación. No hay ventana dual: el cliente debe actualizar el secreto inmediatamente. Para cambios sin corte, crear primero una clave nueva, desplegar el cliente y luego revocar la vieja.

Verificar:

```bash
curl -s http://localhost:4000/v1/api-keys -H 'host: acme.app.localhost' -H "authorization: Bearer $TOKEN" | jq
```

## 4. Stripe y pagos

- Rotar la clave en el dashboard de Stripe y actualizar `PAYMENT_PROVIDER_API_KEY`; reiniciar worker.
- Rotar el webhook secret en Stripe y actualizar `PAYMENT_PROVIDER_WEBHOOK_SECRET`; el modo Stripe valida `Stripe-Signature` sobre el body crudo.
- Probar con un evento de test y confirmar `inbound_payment_events` + `payment_attempts`.
- **No** rotar la clave de pagos durante un incidente de doble cobro; primero estabilizar.

## 5. OIDC y S3

- OIDC: actualizar `OIDC_CLIENT_SECRET` en el proveedor y en el entorno; no hay `_OLD` implementado, por lo que la ventana debe ser corta y coordinada. Verificar login y callback.
- S3: usar credenciales IAM de mínimos privilegios; rotar en el proveedor y actualizar `S3_ACCESS_KEY`/`S3_SECRET_KEY`. Probar presign y descarga.
- Nunca commitear `.env`; `.env.example` solo contiene placeholders locales.

## 6. Checklist de cierre

- [ ] Clave nueva generada y custodiada fuera del repo.
- [ ] Re-cifrado verificado (conteo y prueba de firma).
- [ ] API y worker reiniciados con la misma versión.
- [ ] Webhook de prueba entregado y firmado.
- [ ] Clave anterior destruida tras la ventana.
- [ ] Evidencia y fecha registradas.
- [ ] Gap de KMS/Vault actualizado en `IMPLEMENTATION_PLAN.md` y `docs/threat-model.md`.

## 7. Referencias

- `packages/config/src/index.ts` — validación y AES-GCM.
- `apps/api/src/webhook-store.ts` — creación/rotación de secretos.
- `apps/worker/src/jobs/deliverWebhook.ts` — selección de versión y firma.
- `docs/runbooks/webhooks.md`, `docs/runbooks/incident-response.md`.
