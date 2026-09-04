# ARQUITECTURA v1.0 — MICRO ERP SAAS

## 1. Vista general

```
┌──────────────── Next.js 16 (App Router) ────────────────┐
│ UI (RSC + client)  →  Server Actions (zod, requireOrg)  │
│        │                       │                        │
│        │              models/* (tenantDb, sin cálculo)  │
│        │                       │                        │
│  lib/ledger/*  ◄── motor contable puro (post, void,     │
│  lib/analytics/*    invariants, reports, allocate)      │
│        │                       │                        │
│  ai/* (LLM extract → ExtractionRun)  lib/fx (ExchangeRate)│
└────────────────────────┬────────────────────────────────┘
                         │ Prisma 7 (+ RLS, triggers)
                 Supabase Postgres 17
```
Capas: **UI** (no calcula) → **Acción** (valida, autoriza, orquesta) → **Dominio** (`models/`, acceso a datos por tenant) → **Motor** (`lib/ledger`, `lib/analytics`: funciones puras, testeadas, sin IO) → **BD** (constraints + triggers + RLS como última barrera).

## 2. Decisiones clave (ADRs)
| ADR | Decisión | Nivel |
|---|---|---|
| 0001 | Fork de TaxHacker; conservar stack; `Transaction` = operación/documento, no fuente contable | 2 |
| 0002 | Multi-tenant por `organizationId` + `tenantDb` + RLS Supabase | 2 |
| 0003 | Libro diario como única fuente de cifras; informes derivados; nada se borra | 2 |
| 0004 | Capa analítica paralela (proyecto/CECO/LN en líneas + `AllocationRun`), nunca modifica el diario financiero | 2 |
| 0005 | LLM solo propone: `ExtractionRun` inmutable + `reconcile()` determinista + confirmación humana | 2 |
| 0006 | Dinero en céntimos `Int`; `BIGINT` en agregados SQL; moneda base por organización; `ExchangeRate` persistido | 2 |

## 3. Módulos de código

| Carpeta | Responsabilidad | Reglas |
|---|---|---|
| `lib/ledger/post.ts` | `buildEntry(input, plan, fiscalYear, refDate) → EntryDraft` y validaciones (cuadre, cuentas, fecha, analítica) | Puro |
| `lib/ledger/void.ts` | Contra-asiento exacto | Puro |
| `lib/ledger/templates/*.ts` | Asientos tipo (factura emitida/recibida, cobro, pago, nómina, amortización, IVA, cierre) parametrizados por `OrganizationAccountMap` y `TaxRate` | Puro |
| `lib/ledger/reconcile.ts` | Validación determinista de propuestas OCR (Σitems, base+impuestos, moneda, fecha, cuentas) | Puro |
| `lib/ledger/invariants.ts` | I1–I10 → `validacion.json` | Puro (recibe líneas) |
| `lib/ledger/reports/*.ts` | balance, pyg, sumas-saldos, mayor, cashflow: `f(lines, accounts, config, period) → Report` con provenance por celda | Puro |
| `lib/analytics/margins.ts` | PyG analítica por nivel/proyecto/LN/CECO | Puro |
| `lib/analytics/allocate.ts` | Liquidación de CECOs (drivers, cascada, Hamilton) | Puro |
| `lib/ledger/hash.ts` | `ledgerHash(lines)` sha256 canónico | Puro |
| `lib/money.ts` | parse/format céntimos, redondeo half-even, reparto mayor resto | Puro |
| `lib/fx/*` | obtención y persistencia de tasas (`ExchangeRate`), conversión servidor | IO |
| `models/ledger.ts` | lectura de líneas por periodo (SQL agregado), persistencia transaccional de asientos con numeración | IO, tenant |
| `models/reports.ts` | `ReportRun` (caché por `ledgerHash`), provenance, validación | IO |
| `models/accounts.ts`, `models/analytics.ts`, `models/fiscal-years.ts`, `models/taxes.ts`, `models/organizations.ts`, `models/memberships.ts`, `models/audit-log.ts` | CRUD por tenant | IO |
| `ai/*` | Extracción LLM → `ExtractionRun` (modelo, proveedor, prompt sha256, schema version, tokens, raw, partial) | IO; nunca cifras finales |
| `ai/prompts/*.md` | Prompts base versionados en git; overrides por organización con `version` | — |
| `app/(app)/{documentos,operaciones,contabilidad,informes,analitica,auditoria,configuracion}` | Rutas y server actions | `requireOrg(role)` |
| `components/reports/*`, `components/ledger/*`, `components/ui/{money-cell,confidence-badge,check-status}.tsx` | UI financiera | Sin cálculo contable |
| `scripts/run-invariants.ts`, `scripts/report.ts` | CLI para CI/auditor | — |
| `tests/fixtures/*.json`, `tests/e2e/*` | Fixtures inmutables, e2e Playwright | — |

## 4. Flujo de posteo (transacción serializable)
1. Action valida zod + rol EDITOR. 2. `buildEntry()` puro → `EntryDraft` o errores. 3. `models/ledger.postEntry(draft)`: `$transaction` con `SET LOCAL app.current_org`, `SELECT ... FOR UPDATE fiscal_years` → `entryNumber = last + 1`, insert entry + lines, trigger diferido verifica Σ, `AuditLog`. 4. Invalida caché de `ReportRun` (hash cambia solo). 5. `revalidatePath`.

## 5. Flujo de informe
`getReport(orgId, type, period, params)` → lee líneas del periodo (SQL) → `ledgerHash` → si existe `ReportRun(type, period, params, ledgerHash)` devuelve caché; si no, ejecuta función pura → invariantes → guarda `ReportRun {result, provenance, validation, gitSha, durationMs, seal}` → UI. Sello: `VALIDADO AUTOMÁTICAMENTE` si todos PASS y no hay revisión forzada ni primer run tras cambio de motor (`gitSha` distinto del último run del tipo → `REQUIERE REVISIÓN: primer run tras cambio`).

## 6. Capa de fiabilidad (mapa SPEC → ERP)
| Spec | Implementación |
|---|---|
| C1 snapshot | `ledgerHash` + `ReportRun` inmutable; `File.sha256`; `ExtractionRun` inmutable |
| C2 motor | `lib/ledger`, `lib/analytics` puros; hook de `.claude/settings.json` bloquea impurezas; tests con casos fijos |
| C3 provenance | Cada celda de informe: `{valor, metrica, run_id, ledgerHash, calculado_por, registros_origen(query), confianza}` |
| C4 validación | Capa 1 `invariants.ts`; Capa 2 agente `auditor-fiabilidad` + pestaña Auditoría; Capa 3 revisión por excepción (sello) |
| C5 confianza | `ConfidenceBadge` en toda cifra no derivada del diario |
| C6 memoria | Ninguna cifra en memoria de agentes ni `cachedParseResult`; `AuditLog` y `runs/registro.jsonl` estructurados |
| C7 versionado | prompts en git, `ReportRun.gitSha`, `ExtractionRun.model/promptSha`, `runs/registro.jsonl` |

## 7. Seguridad
better-auth (sesión con `activeOrganizationId`), `requireOrg(minRole)` en toda acción, `tenantDb`, RLS, `AuditLog`, secretos LLM cifrados (`lib/encryption.ts` heredado), rate limit en análisis IA por organización, validación de uploads (mimetype, tamaño, sha256), sin SQL interpolado.

## 8. Rendimiento
Índices `(organization_id, entry_date)`, `(organization_id, account_code, entry_date)`, `(organization_id, project_id)`, `(organization_id, cost_center_id)`. Agregados en SQL con `BIGINT`. `ReportRun` cachea por hash. Vistas materializadas opcionales para saldos mensuales (refresco al postear) — v1.1.

## 9. Despliegue
Local: `docker compose` (app + Postgres 17). Cloud: Vercel/Docker + Supabase (pooler para runtime, `DIRECT_URL` para migraciones); branch de Supabase por PR. CI: lint + test + invariantes sobre fixtures + `get_advisors(security)`.
