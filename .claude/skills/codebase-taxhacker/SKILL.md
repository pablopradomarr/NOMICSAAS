---
name: codebase-taxhacker
description: Mapa del código base heredado de TaxHacker (Next.js 16, Prisma, LangChain) - dónde está cada cosa, qué se conserva, qué se envuelve y qué se reescribe en el ERP. Úsala antes de tocar cualquier fichero heredado o para localizar un patrón existente que reutilizar (server actions, modelos, uploads, OCR, colas, email, export, backups, auth, Stripe).
---

# Código base TaxHacker → MICRO ERP

Commit base: `6cb7254` (v0.8.5). Auditoría detallada: `docs/AUDITORIA-FIABILIDAD.md` (22 gaps, 6 ALTA).

## Mapa
| Ruta | Qué hace | Destino en el ERP |
|---|---|---|
| `prisma/schema.prisma` | User, Session, Account, Setting, Category, Project, Field, File, Transaction, Currency, AppData, Progress | **Extender**: `Organization`, `Membership(role)`, todas las tablas de negocio con `organizationId`; nuevas tablas contables (ver `docs/MODELO-DATOS.md`). `Transaction` se conserva como "operación/documento" y se enlaza a `JournalEntry` |
| `lib/auth.ts`, `lib/auth-client.ts`, `app/(auth)` | better-auth (email/password, magic link, Stripe) | Conservar; añadir organización activa en sesión y `Membership` |
| `lib/db.ts` | Prisma client (`@prisma/adapter-pg`) | Conservar; añadir `tenantDb(orgId)` (extensión Prisma que inyecta el filtro de organización) |
| `lib/uploads.ts`, `lib/files.ts`, `lib/previews/*` | Subida, almacenamiento, previews (pdf2pic/sharp) | **HECHO (E8)**: `files.sha256 NOT NULL` calculado al ingerir, lista blanca + sniff de contenido + 25 MB (`assertAcceptableUpload`), `lib/files-integrity.ts` para el sha de los bytes en disco (I-E8-2) y `/files/preview/[fileId]` que devuelve **410 + `X-Document-Status: NO_DISPONIBLE`** cuando la ficha existe y los bytes no. `sharp` y los SDK de LangChain se cargan **perezosos**: estaban en el grafo de media aplicación |
| `ai/analyze.ts`, `ai/prompt.ts`, `ai/schema.ts`, `ai/attachments.ts`, `ai/providers/llmProvider.ts` | OCR/extracción con LLM, schema dinámico desde `Field` | **HECHO (E8)**: resultado → `ExtractionRun` append-only (proveedor, modelo, `attempts[]` de la cadena de fallback, `prompt_sha` del prompt EFECTIVO, `schema_sha`, `proposal_sha`, páginas vistas/totales, tokens reales de `usage_metadata`, `git_sha`). `File.cachedParseResult` **eliminada de la base**. `reconcile()` (RC-01…RC-25) juzga antes de proponer asiento y el run nace ya juzgado. Prompts en `ai/prompts/*.md` + `PromptVersion` por organización, append-only. El esquema es `additionalProperties: false` y **no** expone `accountCode`, `deductibility`, `withholding`, `receptionDate`, `paymentKey` ni `simplifiedQualified`: eso lo decide el código o una persona (P1) |
| `app/api/unsorted/analyze/route.ts`, `lib/analyze-queue.ts` | Endpoint + cola de análisis con concurrencia y retry 429 | Conservar |
| `app/(app)/unsorted/*`, `components/unsorted/*` | Bandeja de documentos sin procesar, formulario de revisión, split de items | **REESCRITO (E8)**: bandeja densa con el estado del último run, contadores agregados, filtro por estado en la URL y paginación `LIMIT/OFFSET`; ficha con visor del papel y su `sha256`, selector de extracciones por `parentRunId`, los **cuatro badges** de confianza por campo, las cuatro fechas explicadas con su periodo de IVA, las 25 comprobaciones con marca de bloqueo de lote y el **asiento propuesto cuadrado a cero** con sus bloques de pasivo y su libro registro. Confirmar = run de revisión + asiento + `Transaction POSTED` + `AuditLog` en UNA transacción. Split N-a-1 en el motor (`splitProposalAction`), pendiente en la UI (E7) |
| `app/(app)/transactions/*`, `components/transactions/*` | Tabla de transacciones, filtros, edición, bulk | Conservar como "Operaciones"; columna "Asiento" y estado contable |
| `models/transactions.ts`, `forms/transactions.ts` | CRUD + zod (total → céntimos `:18`) | Conservar. **E8**: `parseFloat(val)*100` sustituido por `parseCents()` (G-07); `Transaction.status` con CHECK `POSTED ⟺ journal_entry_id` y trigger de transiciones; la anulación TRASLADA el asiento a `voided_entry_id` con histórico append-only |
| `models/stats.ts`, `lib/stats.ts`, `app/(app)/dashboard` | Dashboard sumando en TS | **Reescribir** sobre el diario (SQL agregado); corregir NaN/monedas descartadas |
| `app/api/currency/route.ts`, `components/agents/currency-converter.tsx` | Tasa de cambio (xe.com scraping + APIs) en cliente | **RETIRADOS (E8)**. `ExchangeRate(date, from, to, rate_micro, source)` global y append-only, fuente única BCE (Frankfurter), tasa **de la fecha del documento** y persistida con su fecha REAL de publicación. Si la fuente no publica se LANZA y la acción devuelve **RC-14 «sin tasa»**: nunca se aproxima. Conversión en servidor con residuo cero por construcción (ADR-0014 D2) |
| `app/(app)/apps/invoices/*` | Generador de facturas PDF (`@react-pdf`) | Conservar. **E8** añade `InvoiceSeries` por organización (ORDINARIA / RECTIFICATIVA / SIMPLIFICADA, `kind` inmutable, sin huecos — I-E8-20) y el asiento de la factura emitida; el ciclo comercial completo (PDF, envío, cobro) es **E11** |
| `app/(app)/apps/email/*`, `lib/email-sync/*` | Ingesta IMAP de adjuntos | Conservar (por organización) |
| `app/(app)/import/csv/*`, `models/export_and_import.ts` | Import/export CSV | Conservar; corregir `*100` sin redondeo y `findFirst` sin `userId` (cross-tenant) |
| `models/backups.ts`, `app/(app)/settings/backups` | Backup/restore JSON | Extender a todas las tablas nuevas; por organización |
| `app/(app)/settings/*` | Categorías, proyectos, campos, monedas, LLM, perfil | Añadir bajo `settings/`: Plan de cuentas, CECOs, Líneas de negocio, Reglas de imputación, Ejercicios, Impuestos, Usuarios y roles. Rutas nuevas de primer nivel: `ledger/`, `reports/`, `analytics/`, `audit/` |
| `models/defaults-data.ts` | Prompt por defecto, campos, categorías | Prompt en `ai/prompts/`; añadir seed NPGC, CECOs, niveles de margen |
| `lib/stripe.ts`, `app/api/stripe/*` | Planes/membresía | Conservar a nivel organización (cloud) |
| `docker-compose*.yml`, `Dockerfile` | Despliegue | Conservar; `DATABASE_URL` → Supabase en cloud |
| `components/ui/*` | shadcn (table, dialog, select, sheet, sidebar…) | Conservar; añadir `money-cell`, `confidence-badge`, `report-table` (jerárquica con drill-down), `check-status` |

## Patrones a reutilizar
- Server action: `app/(app)/<mod>/actions.ts` → `getCurrentUser()` → zod → `models/*` → `revalidatePath`. Devuelve `ActionState<T>` (`lib/actions.ts`).
- Settings por organización: `Setting(code, value)` upsert — añadir `version`/`updatedAt` (gap MEDIA).
- Progreso largo: `Progress` + SSE `app/api/progress/[id]`.
- Tests: vitest, `forms/transactions.test.ts` como ejemplo.

## Gaps ALTA que el ERP cierra (IDs de `docs/AUDITORIA-FIABILIDAD.md`, no reenumerar)
- G-01 Total/IVA/items del LLM guardados sin validar Σitems = total, unidades mezcladas → **CERRADO (E8)**: `reconcile()` RC-01/RC-03 con tolerancia 0 y todos los importes en céntimos enteros.
- G-02 Extracción parcial (≤ 4 páginas) sin marcar → **CERRADO (E8)**: `ExtractionRun.partial` lo escribe un trigger `BEFORE INSERT` (no quien inserta), RC-09 impide contabilizar y I-E8-10 lo vigila.
- G-03 `cachedParseResult` como memoria de cifras → **CERRADO (E8)**: columna eliminada; lo histórico migró a runs `IMPORTED` que `postFromProposal` rechaza.
- G-04 Tasa de cambio en navegador sin persistir → **CERRADO (E8)**: `ExchangeRate` en servidor, append-only, con la tasa del `documentDate`.
- G-05 `profitPerCurrency` NaN → dashboard sobre diario en moneda base, SQL con COALESCE (E6).
- G-06 Series temporales a 0 para monedas sin convertir, sin aviso → `excludedCount` visible (E6).
- G-07…G-22 (MEDIA/BAJA del camino de entrada): cerrados en E8 salvo los anotados en `docs/ESTADO.md` §«E8 — deuda y decisiones» con su épica de cierre.
