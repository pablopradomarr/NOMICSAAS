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
Capas: **UI** (no calcula) → **Acción** (valida, autoriza, orquesta) → **Dominio** (`models/`, acceso a datos por tenant vía `tenantDb`) → **Motor** (`lib/ledger`, `lib/analytics`: funciones puras, testeadas, sin IO) → **BD** (constraints + triggers + RLS como última barrera).

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
| `lib/extraction/reconcile.ts` | **RC-01…RC-25** (E8): validación determinista de la propuesta OCR contra el plan, los tipos vigentes, la ficha del tercero, el ejercicio y la tasa. Devuelve veredicto + propuesta normalizada + `fieldOrigins` + sellos | Puro |
| `lib/extraction/{hash,seal,split,types}.ts` | Sellos del run (`promptHash`, `schemaHash`, `proposalHash`, `canonicalJson`), sellado del veredicto, forzado de campo y split N-a-1 | Puro |
| `lib/ledger/postFromProposal.ts` | Propuesta reconciliada → `EntryDraft`: elección de plantilla, bloques de pasivo por naturaleza de línea, cuota del documento como `taxOverride`, retención por régimen, divisa en la línea | Puro |
| `lib/ledger/invariants-e8.ts` | I-E8-1…20: cadena documento→asiento, libro registro de IVA y los tres puentes al 303 | Puro |
| `lib/fx/convert.ts` | Conversión del documento a moneda base con **residuo cero por construcción** (Hamilton sobre las cuotas, ADR-0014 D2) | Puro |
| `lib/files-integrity.ts` | sha256 en streaming de los bytes del almacén, para I-E8-2 | IO |
| `lib/ledger/invariants.ts` | I1–I10 → `validacion.json` | Puro (recibe líneas) |
| `lib/ledger/reports/*.ts` | balance, pyg, sumas-saldos, mayor, cashflow: `f(lines, accounts, config, period) → Report` con provenance por celda | Puro |
| `lib/analytics/margins.ts` | PyG analítica por nivel/proyecto/LN/CECO | Puro |
| `lib/analytics/allocate.ts` | Liquidación de CECOs (drivers, cascada, Hamilton) | Puro |
| `lib/ledger/hash.ts` | `ledgerHash(lines)` sha256 canónico | Puro |
| `lib/money.ts` | parse/format céntimos, redondeo half-even, reparto mayor resto (creado en E0) | Puro |
| `lib/fx/rates.ts` | Tasa del `documentDate` desde el BCE (Frankfurter), persistida con su fecha REAL; sin tasa **lanza** (RC-14), nunca aproxima | IO |
| `models/ledger.ts` | lectura de líneas por periodo (SQL agregado), persistencia transaccional de asientos con numeración | IO, tenant |
| `models/reports.ts` | `ReportRun` (caché por `ledgerHash`), provenance, validación | IO |
| `models/accounts.ts`, `models/analytics.ts`, `models/fiscal-years.ts`, `models/taxes.ts`, `models/organizations.ts`, `models/memberships.ts`, `models/audit-log.ts` | CRUD por tenant | IO |
| `ai/*` | Extracción LLM → `ExtractionRun` (modelo, proveedor, prompt sha256, schema version, tokens, raw, partial) | IO; nunca cifras finales |
| `ai/prompts/*.md` | Prompts base versionados en git; overrides por organización con `version` | — |
| `app/(app)/{unsorted,transactions,apps,dashboard,settings}` (heredadas) + `app/(app)/{ledger,reports,analytics,audit}` (nuevas); configuración contable bajo `settings/` | Rutas y server actions | `requireOrg(role)` |
| `components/reports/*`, `components/ledger/*`, `components/ui/{money-cell,confidence-badge,check-status}.tsx` | UI financiera | Sin cálculo contable |
| `scripts/run-invariants.ts`, `scripts/report.ts` | CLI para CI/auditor | — |
| `tests/fixtures/*.json`, `tests/e2e/*` | Fixtures inmutables, e2e Playwright | — |

## 4. Flujo de posteo (transacción serializable)
1. Action valida zod + rol EDITOR. 2. `buildEntry()` puro → `EntryDraft` o errores. 3. `models/ledger.postEntry(draft)`: `$transaction` con `SET LOCAL app.current_org`, `SELECT ... FOR UPDATE fiscal_years` → `entryNumber = last + 1`, insert entry + lines, trigger diferido verifica Σ, `AuditLog`. 4. Invalida caché de `ReportRun` (hash cambia solo). 5. `revalidatePath`.

## 4b. Flujo documental: documento → run → reconcile → asiento (E8, ADR-0014)

```
subida ─ sha256(bytes) ─→ File (sha256 NOT NULL, sniff de contenido, 25 MB)
   │
   ├─ analyzeFileAction ─→ cola ─→ LLM (cadena de fallback, attempts[])
   │      └─ prompt EFECTIVO + JSON-Schema `additionalProperties:false`
   │         (SIN accountCode, deductibility, withholding, receptionDate,
   │          paymentKey ni simplifiedQualified: eso NO lo decide un modelo)
   │
   └─→ ExtractionRun  ← nace YA JUZGADO y es APPEND-ONLY
          proposal · proposalSha · fieldOrigins (4 badges) · reconcile · gitSha
                    │
   buildReconcileContext(db, org)  ← plan, tipos vigentes, ficha del tercero,
                    │                 ejercicios, duplicados, TASA del documentDate
                    ▼
            reconcile()  RC-01…RC-25  → PASS | WARN | FAIL (+ blocksBatch)
                    │                    · FAIL ⇒ no hay asiento, y no se puede forzar
                    │                    · sellos del periodo (D7) y periodo de IVA (D8)
                    ▼
        postFromProposal()  → plantilla de las 28 de E3 → buildFromTemplate → checkDraft
                    │          cuota DEL DOCUMENTO (D3) · bloques de pasivo por línea (D6)
                    │          rectificativa por SUSTITUCIÓN = la DIFERENCIA (D12)
                    ▼
   UNA transacción:  run de revisión (si hubo ediciones, D5) → postEntryTx →
                     Transaction POSTED + journalEntryId (D1) → AuditLog
```

**Divisa (D2).** `payable_EUR = convert(total)`, `base_i_EUR = convert(base_i)` y las **cuotas absorben la
diferencia** por mayor resto: residuo cero, cero líneas de ajuste. Cada línea monetaria guarda
`(originalCurrency, originalAmountCents, exchangeRateId)` —el importe original sale del **documento**, no de
deshacer la conversión— porque es lo que la NRV 11ª.2.1 revalorizará al cierre en E9. Si alguna vez procediera
reconocer un residuo de conversión su cuenta sería 668/768, jamás 669/769.

**Invariantes (I-E8-1…20).** El bloque documental corre con I1–I10 en la misma `validacion.json`. Los que
sostienen el resto: **I-E8-2** (los bytes de hoy son los que vio la extracción), **I-E8-7a** (la anotación del
libro registro derivada del ASIENTO y la derivada del DOCUMENTO coinciden al céntimo), **I-E8-11** (los tres
sellos del run recomputados) y **I-E8-15a/b/c** (los tres puentes al 303). Un FAIL sella el periodo como
`REQUIERE REVISIÓN` con su motivo.

## 5. Flujo de informe
`getReport(orgId, type, period, params)` → lee líneas del periodo (SQL) → `ledgerHash` → si existe `ReportRun(type, period, params, ledgerHash)` devuelve caché; si no, ejecuta función pura → invariantes → guarda `ReportRun {result, provenance, validation, gitSha, durationMs, seal}` → UI. Sello: `VALIDADO AUTOMÁTICAMENTE` si todos PASS y no hay revisión forzada ni primer run tras cambio de motor (`gitSha` distinto del último run del tipo → `REQUIERE REVISIÓN: primer run tras cambio`).

## 6. Capa de fiabilidad (mapa SPEC → ERP)
| Spec | Implementación |
|---|---|
| C1 snapshot | `ledgerHash` + `ReportRun` inmutable; `files.sha256` NOT NULL y **comparado con los bytes del almacén** (I-E8-2); `ExtractionRun` append-only con sus sellos recomputados (I-E8-11) |
| C2 motor | `lib/ledger`, `lib/analytics` puros; hook PreToolUse `.claude/hooks/guard.sh` bloquea impurezas antes de escribir; mismo check en CI; tests con casos fijos |
| C3 provenance | Cada celda de informe: `{valor, metrica, run_id, ledgerHash, calculado_por, registros_origen(query), confianza}` |
| C4 validación | Capa 1 `invariants.ts`; Capa 2 agente `auditor-fiabilidad` + pestaña Auditoría; Capa 3 revisión por excepción (sello) |
| C5 confianza | `ConfidenceBadge` en toda cifra no derivada del diario; en el camino documental, **cuatro niveles por CAMPO** (`calculado`/`verificado`/`interpretacion_ia`/`no_verificado`) sellados en `fieldOrigins`, y motivo obligatorio **en servidor** para confirmar con algún `no_verificado` |
| C6 memoria | Ninguna cifra en memoria de agentes ni `cachedParseResult`; `AuditLog` y `runs/registro.jsonl` estructurados |
| C7 versionado | prompts en git + `PromptVersion` append-only por organización, `ReportRun.gitSha`, `ExtractionRun.{model, promptSha, schemaSha, proposalSha, gitSha}`, `runs/registro.jsonl` |

## 7. Seguridad
better-auth (sesión con `activeOrganizationId`), `requireOrg(minRole)` en toda acción, `tenantDb(orgId)` en `lib/db.ts`, RLS, `AuditLog`, secretos LLM cifrados (`lib/encryption.ts` heredado), rate limit en análisis IA por organización, validación de uploads (mimetype, tamaño, sha256), sin SQL interpolado.

## 8. Rendimiento
Índices `(organization_id, entry_date)`, `(organization_id, account_code, entry_date)`, `(organization_id, project_id)`, `(organization_id, cost_center_id)`. Agregados en SQL con `BIGINT`. `ReportRun` cachea por hash. Vistas materializadas opcionales para saldos mensuales (refresco al postear) — v1.1.

## 9. Despliegue
Local: `docker compose` (app + Postgres 17). Cloud: Vercel/Docker + Supabase (pooler para runtime, `DIRECT_URL` para migraciones); branch de Supabase por PR. CI: lint + test + invariantes sobre fixtures + `get_advisors(security)`.
