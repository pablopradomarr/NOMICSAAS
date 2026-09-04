# ADR-0001 — Fork de TaxHacker como base; `Transaction` deja de ser fuente contable

**Estado:** PROPUESTO (pendiente de firma: Pablo) · **Nivel:** 2 · **Fecha:** 2026-09-04

## Contexto
TaxHacker (v0.8.5, MIT) aporta OCR/LLM de documentos, multi-moneda, campos custom, import/export, email-sync, facturas PDF, backups y self-hosting. No tiene partida doble ni multi-tenant; su auditoría (docs/AUDITORIA-FIABILIDAD.md) muestra 6 gaps ALTA en el flujo LLM → cifras.

## Decisión
1. Fork completo (historial conservado, `upstream` = vas3k/TaxHacker) manteniendo el stack: Next.js 16, Prisma 7, Postgres, better-auth, LangChain, vitest.
2. `Transaction` pasa a ser **operación/documento** con `status` y enlace a `JournalEntry`; nunca fuente de informes.
3. Se conservan intactos: auth, uploads, previews, cola de análisis, email-sync, facturas, import/export, backups, UI base. Se envuelven: `ai/*` (→ `ExtractionRun` + `reconcile`). Se reescriben: stats/dashboard, conversión de moneda.
4. Licencia MIT del upstream respetada (`LICENSE` conservada; atribución en README).

## Alternativas descartadas
- Empezar de cero: pierde ~1 año de funcionalidad de documentos probada.
- Odoo/ERPNext: demasiado grande; analítica MC1–MC3 y capa de fiabilidad requieren forks profundos.
- Solo API sobre Holded: sin control del diario ni de la analítica.

## Consecuencias
Deuda inicial: migrar `userId` → `organizationId` en todas las tablas (E1). Beneficio: producto usable desde el sprint 1 para documentos; contabilidad se activa por organización (`ledgerEnabled`).
