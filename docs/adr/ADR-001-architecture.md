# ADR-001: Monorepo con fronteras de aplicación explícitas

- Estado: aceptado para fases 0–6
- Fecha: 2026-08-20

## Contexto

El producto necesita web, API y workers que comparten contratos, configuración y reglas de dominio, pero tienen ciclos de ejecución y escalado distintos.

## Decisión

Usar un monorepo `pnpm` con Turborepo y estas fronteras:

- `apps/web`: Next.js y experiencia de usuario.
- `apps/api`: HTTP, autenticación, policies y comandos de negocio.
- `apps/worker`: consumidores BullMQ y reconciliadores.
- `packages/*`: contratos y librerías internas sin conocimiento de UI.

Los paquetes compartidos no pueden importar desde una app. La base de datos y los adaptadores externos se mantienen detrás de sus paquetes/fronteras correspondientes.

## Consecuencias

Positivas: cambios coordinados, contratos tipados y CI unificado. Negativas: el pipeline debe detectar dependencias circulares y el despliegue debe construir artefactos independientes por app. Si las fronteras requieren releases desacoplados, se puede extraer un paquete/app sin cambiar contratos públicos.
