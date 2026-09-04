# ADR-0003 — El libro diario es la única fuente de cifras; informes derivados; nada se borra

**Estado:** PROPUESTO (pendiente de firma: Pablo) · **Nivel:** 2 · **Fecha:** 2026-09-04

## Contexto
R7 exige PyG, balance, cashflow y diario "todo cuadrado". SPEC-FIABILIDAD P1–P3: código calcula, fuente única, snapshot antes de calcular.

## Decisión
- `JournalEntry` / `JournalLine` en céntimos `Int`, con `debit`/`credit` excluyentes, cuenta por FK compuesta a `Account` de la organización, destino analítico en la línea.
- Integridad en BD: `CHECK`, constraint trigger diferido Σdebe = Σhaber, numeración sin huecos por ejercicio con bloqueo pesimista, sin `DELETE` (anulación por contra-asiento con `reversesEntryId`).
- Motor puro en `lib/ledger/` (`buildEntry`, `void`, `templates`, `reconcile`, `invariants`, `reports`); prohibido `Date.now()`, IO y LLM (hook de pre-commit y revisor).
- Informes = funciones puras sobre líneas del periodo; caché inmutable en `ReportRun` indexada por `ledgerHash` (sha256 canónico de las líneas) + `gitSha`; cada celda con provenance; sello `VALIDADO AUTOMÁTICAMENTE` / `REQUIERE REVISIÓN`.
- Invariantes I1–I10 (skill `fiabilidad`) ejecutados en cada `ReportRun`, en cierre de periodo y desde la pestaña Auditoría.

## Alternativas descartadas
- Tablas de saldos mantenidas por la app: doble verdad, divergen. (Vistas materializadas sí, como caché refrescable — v1.1.)
- Permitir editar asientos: rompe trazabilidad y auditoría; se sustituye por anular + nuevo.

## Consecuencias
Coste: informes recalculan sobre el periodo (aceptable con índices y caché por hash hasta ~10⁶ líneas/org). Beneficio: cuadre demostrable y auditable por construcción.
