# ADR-0005 — El LLM solo propone: `ExtractionRun` inmutable + `reconcile()` + confirmación humana

**Estado:** PROPUESTO (pendiente de firma: Pablo) · **Nivel:** 2 · **Fecha:** 2026-09-04

## Contexto
Gaps ALTA G-01…G-04 de TaxHacker: cifras del LLM persistidas sin validar, extracción parcial no marcada, `cachedParseResult` como memoria, tasa de cambio en navegador. SPEC P1, P4, P6, P7.

## Decisión
- Cada análisis crea un `ExtractionRun` inmutable: proveedor, modelo, sha256 del prompt efectivo, versión de schema, páginas enviadas/totales (`partial`), salida cruda, propuesta normalizada (céntimos, ISO), resultado de `reconcile`, tokens, duración, usuario.
- `reconcile()` (puro): Σ líneas = base; base + Σ impuestos = total (tolerancia 0 tras redondeo half-even); moneda y fecha válidas; cuentas/proyecto/CECO existentes; tipo impositivo reconocido en `TaxRate`. Resultado por campo: `calculado` / `interpretación IA` / `no verificado`.
- La propuesta de asiento solo se puede confirmar (rol EDITOR) si `reconcile` no tiene FAIL; el asiento resultante referencia `extractionRunId` y `fileId` (con `sha256`).
- Se elimina `File.cachedParseResult`. El formulario carga desde el `ExtractionRun` elegido y muestra origen por campo.
- Conversión de moneda en servidor con `ExchangeRate` persistido (fuente BCE/Frankfurter por defecto, configurable); `convertedTotal` no editable sin marcar `no verificado` + motivo.
- Prompts base en `ai/prompts/*.md` (git); overrides por organización en `PromptVersion` (append-only).

## Alternativas descartadas
- Auto-contabilizar sin confirmación: viola P1/P6 y la práctica contable; se ofrece "confirmación por lote" con reconcile PASS.
- Mantener caché de extracción: es exactamente el anti-patrón "memoria como fuente de cifras".

## Consecuencias
Un paso más para el usuario (confirmar), compensado por lote. Trazabilidad completa documento → run → asiento → informe.
