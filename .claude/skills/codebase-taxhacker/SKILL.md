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
| `lib/db.ts` | Prisma client (`@prisma/adapter-pg`) | Conservar; añadir `withTenant(orgId)` helper y extensión Prisma que inyecta filtro |
| `lib/uploads.ts`, `lib/files.ts`, `lib/previews/*` | Subida, almacenamiento, previews (pdf2pic/sharp) | Conservar; añadir `sha256` en `File` (gap G-ALTA) |
| `ai/analyze.ts`, `ai/prompt.ts`, `ai/schema.ts`, `ai/attachments.ts`, `ai/providers/llmProvider.ts` | OCR/extracción con LLM, schema dinámico desde `Field` | **Envolver**: resultado → `ExtractionRun` (modelo, proveedor, prompt hash, schema version, tokens, output crudo). Eliminar `File.cachedParseResult`. Añadir `reconcile()` determinista antes de proponer asiento. Prompts base a `ai/prompts/*.md` versionados |
| `app/api/unsorted/analyze/route.ts`, `lib/analyze-queue.ts` | Endpoint + cola de análisis con concurrencia y retry 429 | Conservar |
| `app/(app)/unsorted/*`, `components/unsorted/*` | Bandeja de documentos sin procesar, formulario de revisión, split de items | Conservar UI; el "guardar" pasa a "proponer asiento" → vista de asiento con validación → confirmar |
| `app/(app)/transactions/*`, `components/transactions/*` | Tabla de transacciones, filtros, edición, bulk | Conservar como "Operaciones"; columna "Asiento" y estado contable |
| `models/transactions.ts`, `forms/transactions.ts` | CRUD + zod (total → céntimos `:18`) | Conservar; validar `items` con schema (gap ALTA) |
| `models/stats.ts`, `lib/stats.ts`, `app/(app)/dashboard` | Dashboard sumando en TS | **Reescribir** sobre el diario (SQL agregado); corregir NaN/monedas descartadas |
| `app/api/currency/route.ts`, `components/agents/currency-converter.tsx` | Tasa de cambio (xe.com scraping + APIs) en cliente | **Reescribir**: tabla `ExchangeRate(date, from, to, rate, source)`, conversión en servidor |
| `app/(app)/apps/invoices/*` | Generador de facturas PDF (`@react-pdf`) | Conservar; al emitir → asiento de factura emitida; series de numeración por organización |
| `app/(app)/apps/email/*`, `lib/email-sync/*` | Ingesta IMAP de adjuntos | Conservar (por organización) |
| `app/(app)/import/csv/*`, `models/export_and_import.ts` | Import/export CSV | Conservar; corregir `*100` sin redondeo y `findFirst` sin `userId` (cross-tenant) |
| `models/backups.ts`, `app/(app)/settings/backups` | Backup/restore JSON | Extender a todas las tablas nuevas; por organización |
| `app/(app)/settings/*` | Categorías, proyectos, campos, monedas, LLM, perfil | Añadir: Plan de cuentas, CECOs, Líneas de negocio, Reglas de imputación, Ejercicios, Impuestos, Usuarios y roles, Auditoría |
| `models/defaults-data.ts` | Prompt por defecto, campos, categorías | Prompt en `ai/prompts/`; añadir seed NPGC, CECOs, niveles de margen |
| `lib/stripe.ts`, `app/api/stripe/*` | Planes/membresía | Conservar a nivel organización (cloud) |
| `docker-compose*.yml`, `Dockerfile` | Despliegue | Conservar; `DATABASE_URL` → Supabase en cloud |
| `components/ui/*` | shadcn (table, dialog, select, sheet, sidebar…) | Conservar; añadir `money-cell`, `confidence-badge`, `report-table` (jerárquica con drill-down), `check-status` |

## Patrones a reutilizar
- Server action: `app/(app)/<mod>/actions.ts` → `getCurrentUser()` → zod → `models/*` → `revalidatePath`. Devuelve `ActionState<T>` (`lib/actions.ts`).
- Settings por organización: `Setting(code, value)` upsert — añadir `version`/`updatedAt` (gap MEDIA).
- Progreso largo: `Progress` + SSE `app/api/progress/[id]`.
- Tests: vitest, `forms/transactions.test.ts` como ejemplo.

## Gaps ALTA que el ERP cierra (de `docs/AUDITORIA-FIABILIDAD.md`)
1. Total/IVA/items del LLM guardados sin validar Σitems = total → `reconcile()`.
2. Extracción parcial (≤ 4 páginas) sin marcar → `ExtractionRun.partial = true` y badge.
3. `cachedParseResult` como memoria de cifras → eliminar; `ExtractionRun` inmutable.
4. Tasa de cambio en navegador sin persistir → `ExchangeRate` en servidor.
5. `profitPerCurrency` NaN / monedas no convertidas a 0 → dashboard sobre diario en moneda base.
6. Unidades mezcladas céntimos/decimales en items → schema de items en céntimos.
