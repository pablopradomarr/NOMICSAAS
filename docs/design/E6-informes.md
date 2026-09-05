# E6 — Informes financieros (diseño)

**Épica:** E6 · **Nivel:** 2 (ADR-0003 APROBADO cubre `ReportRun`, provenance y sello; **ADR-0012 PROPUESTO** para las reglas de presentación, el bucket de cashflow y la política de umbrales) · **Depende de:** E3 (diario) y E4 (analítica; E5 completa el cashflow analítico)
**Autor:** arquitecto · **Fecha:** 2026-09-05 · **Ronda 2** (validación contable incorporada) · **Estado:** PROPUESTO (pendiente de firma humana de ADR-0012)

Documentos que este diseño da por leídos: `CLAUDE.md`, `docs/ROADMAP.md` (E6), `docs/MODELO-DATOS.md` (§Plan de cuentas · §Extracción, FX, informes, auditoría · §Integridad), `docs/ARQUITECTURA.md` §5, `docs/adr/0003`, `0006`, `0010`, `0011`, `docs/AUDITORIA-FIABILIDAD.md` (G-05, G-06), `docs/ESTADO.md`, `docs/design/E3-libro-diario.md`, `docs/design/E3-asientos-tipo.md`, `docs/design/E4-analitica.md`, **`docs/design/E6-validacion-estados.md`** (veredicto **CONFORME CON OBSERVACIONES**; reglas **R-B1…R-B6**, **R-P1**, **R-CF-1…R-CF-8**; observaciones **O-1…O-14**; invariantes **I-E6-1…15**; decisiones del coordinador §7; respuestas §8) y **`docs/design/fixtures/estados-esperados.json`** (47 checks en PASS, generador `build_estados_esperados.py --check`), más las skills `estados-financieros`, `fiabilidad`, `pgc-npgc`, `contabilidad-analitica` y `ui-erp`.

**Lo que E6 hereda ya construido** (y no rehace): `lib/ledger/reports/{diario,mayor,sumas-saldos}.ts`, `lib/ledger/provenance.ts`, `lib/ledger/invariants.ts` (I1, I7–I10, I-E3-*, `seal`/`sealFor` con motivos etiquetados), `lib/analytics/margins.ts` (`isPnlLine`, `contribution`, `pnlContableCents` = I3), `models/ledger.ts` (`getLinesForPeriod`, `getAccountBalanceRows`, `computeLedgerHash` en SQL, `runLedgerInvariants`), `components/reports/*`, `Organization.reviewThresholds Json?`, y —entregado por el experto en esta ronda— **`seeds/npgc.csv` con la 14.ª columna `cashflow_bucket`** (834 de 906 filas), `lib/accounts/types.ts` (`CashflowBucket`, `cashflowCategoryOf`) y `lib/accounts/csv.ts` ya parseándola.

## Ronda 2 — qué cambió

| # | Cambio de la ronda 1 a la ronda 2 | Origen |
|---|---|---|
| 1 | **`isContra` NO interviene en el cálculo.** Con la regla de signo (R-B2) la contra-cuenta ya resta sola: restarla «además» la restaría dos veces. Pasa a ser presentación —marca `(−)`— y **check de signo** (I-E6-10) | **R-B3**. Mi R-B2 de la ronda 1 era un error de bulto y habría dado un inmovilizado inflado en 635 000 en el fixture |
| 2 | **Cuatro fotos del balance**, no dos: `PRE_REGULARIZACION` (por defecto), `POST_REGULARIZACION` (balance formulado), `POST_CIERRE` y `APERTURA_2027`; y la foto es un **parámetro** que entra en `paramsHash` | §1.1 y **O-5**. Dos `BALANCE` del mismo periodo con distinto `kind` excluido comparten `ledgerHash`: sin `paramsHash` en la clave, la caché devuelve el informe equivocado |
| 3 | **R-B5 es exclusiva y se decide por el SALDO de 129, no por el estado del ejercicio**: `saldo(129) = 0 → PN VII = I3`; `≠ 0 → PN VII = −saldo(129)`. Nunca las dos. Invariante nuevo **I-E6-13** (`REGULARIZACION_DESFASADA`) | §8.6. Sumar las dos da `I2 = 1 497 322` **sólo el día del cierre**: el fallo más caro de detectar |
| 4 | **`cashflow_bucket` en el seed** (7 buckets) y `CashflowCategory` de tres valores **derivada**, no almacenada. Mi «inversión de R-18» se retira: la regla correcta es **R-18′ «bucket obligatorio en toda cuenta postable salvo 57x»**, y la exhaustividad la comprueba `validate_cashflow()` en el generador del seed | **O-9/O-10/O-12** (cerradas). La columna `cashflow_category` del schema, `NULL` en las 906 filas, **se sustituye** |
| 5 | **Cashflow directo por LÍNEA, exacto** (R-CF-3): cada línea no-57x aporta `−(debe−haber)` a su bucket. **Se descarta el reparto proporcional por mayor resto** que proponía la ronda 1: es innecesario (I1 garantiza que la suma es el Δ57x del asiento) y destruye el drill-down | §3.1. En `CO-003` el proporcional daría 299 001 y 499, cifras que no corresponden a ningún hecho |
| 6 | **R-CF-7**: el IVA devengado en el **mismo asiento** que un cobro/pago sigue al bloque comercial, no a impuestos (el EFE mide flujos **brutos**). **R-CF-4**: los traspasos 57x↔57x se excluyen **por ser 57x las dos cuentas**, no por importe neto 0 | §3.1 y §8.3 |
| 7 | **Indirecto por partición mecánica y exhaustiva** (R-CF-5): toda cuenta no-57x cae en exactamente un bloque y `Σ bloques = Δ57x` por álgebra. **Desaparece mi partida «variaciones no clasificadas»**, que sólo tenía sentido con una partición con huecos | §3.4. El bloque `indirectBlock` es **función pura** sobre prefijo, no columna (O-11) |
| 8 | **El EFE no es obligatorio en PYMES ni en abreviado**: el cashflow es **informe de gestión** y lo dice en la cabecera. Vista por defecto: **directo mensual**; segunda vista: **estructura oficial A–E** para el modelo normal | §8.4 |
| 9 | **EBITDA = A.1 revirtiendo los epígrafes 8 y 11**, y nada más: «Otros resultados» (13/12) **entra** y los deterioros de circulante (694/794) **entran**. En el fixture: 2 390 430, la misma cifra que la matriz de E4 | §8.5. Mi propuesta de la ronda 1 («A.1 + 68x + deterioros») excluía de más |
| 10 | **Aging desde el VENCIMIENTO**, cinco tramos + `SIN_VENCIMIENTO` + `A_APLICAR`, `refDate` en `params`; invariantes **I-E6-14/15** | §8.8 |
| 11 | **Comparativo `SAME_PERIOD_PREVIOUS_YEAR`** por defecto, y el balance lleva **siempre** la columna del cierre anterior. Sin ejercicio anterior: columna **vacía con leyenda**, jamás cero | §8.7 |
| 12 | **Umbrales con la tabla del experto** (7 KPI con `pctBps` **y** `minAbsCents`), más **EV-1…EV-6** (variaciones explicables que no disparan) y **EV-7…EV-10** (que disparan siempre) | §5 del experto |
| 13 | `ReportRun` gana **`comparativeRunId`/`comparativeBasis`** (O-6) y `params.currency` explícito (O-8) | §6.1 |
| 14 | **O-4/O-13**: el fixture compra inmovilizado contra `4100` porque falta `AccountKey.PROVEEDORES_INMOVILIZADO → 523`. E6 **no lo corrige**: lo detecta como **WARN de Auditoría**; la corrección es de **E8** | §3.6 del experto |

**Las cinco decisiones de la ronda 1 que sobreviven** (con matiz): D-E6-1 (el balance excluye `CLOSING`) queda subsumida en las cuatro fotos; D-E6-4 (`resultKind = SUMMARY` en diario/mayor) y D-E6-5 (XLSX con `jszip`, sin dependencia nueva) siguen intactas; `gitSha` dentro de la clave de caché, también; `analyticsKey`/`paramsHash` `NOT NULL` con centinela, también (y ahora `paramsHash` es además exigencia contable, O-5).

---

## 1. Objetivo y alcance

E6 convierte el libro diario en las tres cuentas anuales que el producto promete —**balance de situación** (cuatro fotos, dos modelos), **pérdidas y ganancias contable** (subtotales oficiales A.1–A.4, dos modelos) y **cashflow** (directo mensual y anual, indirecto, más la vista oficial A–E)—, todas como funciones puras con provenance por celda y comparativo, y les da la infraestructura que ADR-0003 exige: **`ReportRun` persistente e inmutable** con caché por `(organización, tipo, periodo, paramsHash, ledgerHash[, analyticsKey], gitSha)`, histórico consultable, sello con motivos etiquetados, **umbrales de variación** (`Organization.reviewThresholds`) y **revisión manual forzada** (`ManualReviewFlag`, ADMIN). Añade **I2, I3, I6** y los diecinueve **I-E6-1…19**, el **export CSV/XLSX/PDF** con provenance y validación como anexo, y **reescribe el dashboard sobre el diario** (ingresos, EBITDA, resultado, tesorería, aging de 430/400, series mensuales), cerrando **G-05** y **G-06**. El diario, el mayor, sumas y saldos y la PyG analítica pasan también por `ReportRun`.

Todas las cifras esperadas están selladas en `docs/design/fixtures/estados-esperados.json`: **total activo 13 673 820 · PN 8 307 322 · pasivo corriente 5 366 498 · I3 1 497 322 · BAI 1 996 430 · EBITDA 2 390 430 · tesorería 4 000 000 → 2 943 920 (Δ −1 056 080) · I2 = 0 · I6 = 0**. El motor debe reproducirlas **byte a byte**.

**No incluye:** `Budget` y presupuesto vs real → **E10** (`ReportType.PRESUPUESTO_REAL` se declara y se rechaza en runtime); imputación de CECOs y cashflow con `AllocationRun` → **E5**; pestaña Auditoría como pantalla, `scripts/report.ts` y conciliación bancaria → **E7** (E6 aporta sus checks y sus WARN al motor); ECPN, memoria y depósito de cuentas → fuera de v1; regularización, cierre y el **bloqueo de posteo en 6/7 tras la regularización** (prevención de I-E6-13, §8.6 del experto) → **E9**; `AccountKey.PROVEEDORES_INMOVILIZADO`, plantilla de factura de inmovilizado contra `523` y `Counterparty` → **E8**; override de buckets por organización y de `476` → **E9**.

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

`@@map`/`@map` en snake_case en todo, ids uuid, `organizationId` en las dos tablas nuevas, dinero `Int` céntimos y agregados `BIGINT`, fechas de periodo `@db.Date`, `DateTime` sólo para auditoría técnica. Nada se borra. Las dos tablas entran en `TENANT_MODELS` (`lib/db.ts`) y se protegen con `SELECT app.enforce_tenant_rls('<tabla>')`.

### 2.2 Fragmento Prisma

```prisma
model ReportRun {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  type        ReportType
  periodStart DateTime @map("period_start") @db.Date
  periodEnd   DateTime @map("period_end")   @db.Date
  fiscalYearId String? @map("fiscal_year_id") @db.Uuid

  /// Parámetros del informe. OBLIGATORIOS por tipo (O-5, O-8):
  ///   BALANCE  → { snapshot, variant, currency, comparative }
  ///   PYG      → { variant, currency, comparative }
  ///   CASHFLOW → { method, granularity, view, currency }
  ///   DASHBOARD→ { refDate, agingBuckets, currency }
  params     Json
  /// sha256 de la forma canónica de `params` (§3.6). NOT NULL: es clave de caché.
  paramsHash String @map("params_hash") @db.Char(64)

  ledgerHash       String  @map("ledger_hash") @db.Char(64)
  analyticsHash    String? @map("analytics_hash")     @db.Char(64)
  marginConfigHash String? @map("margin_config_hash") @db.Char(64)
  allocationRunId  String? @map("allocation_run_id")  @db.Uuid
  /// Los tres anteriores en forma canónica, o "∅". Existe SÓLO para indexar la
  /// clave: en PostgreSQL NULL <> NULL y un `@@unique` con columnas nullables no
  /// impide duplicados (lección O-A6 de E4). Lo escribe un trigger.
  analyticsKey String @default("∅") @map("analytics_key") @db.VarChar(210)

  gitSha String @map("git_sha") @db.VarChar(64)

  /// El informe. `resultKind = SUMMARY` en DIARIO/MAYOR/SUMAS_SALDOS (D-E6-4).
  result     Json
  resultKind ResultKind @default(FULL) @map("result_kind")
  provenance Json
  validation Json

  seal        Seal
  /// O-7: array de `{code, kind, message, invariantId?, kpi?, deltaBps?, limitBps?}`.
  /// La Auditoría filtra por `code`, no hace LIKE sobre un texto libre.
  sealReasons Json @default("[]") @map("seal_reasons")
  durationMs  Int  @map("duration_ms")

  /// O-6: contra qué se midió la variación. Sin esto, EV-1…EV-10 no son auditables.
  comparativeRunId String?           @map("comparative_run_id") @db.Uuid
  comparativeBasis ComparativeBasis? @map("comparative_basis")

  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([organizationId, type, periodStart, periodEnd, paramsHash, ledgerHash, analyticsKey, gitSha], map: "report_runs_cache_key")
  @@index([organizationId, type, periodStart, periodEnd, createdAt(sort: Desc)])
  @@index([organizationId, type, ledgerHash])
  @@map("report_runs")
}

enum ReportType       { DIARIO MAYOR SUMAS_SALDOS BALANCE PYG PYG_ANALITICA CASHFLOW_DIRECTO CASHFLOW_INDIRECTO PRESUPUESTO_REAL DASHBOARD }
enum Seal             { VALIDADO_AUTOMATICAMENTE REQUIERE_REVISION }
enum ResultKind       { FULL SUMMARY }
enum ComparativeBasis { SAME_PERIOD_PREVIOUS_YEAR PREVIOUS_FISCAL_YEAR_CLOSE PREVIOUS_PERIOD NONE }

model ManualReviewFlag {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  periodStart DateTime    @map("period_start") @db.Date
  periodEnd   DateTime    @map("period_end")   @db.Date
  /// `null` = afecta a TODOS los informes del periodo.
  scope       ReportType?
  reason      String      @db.VarChar(1000)

  createdById String    @map("created_by_id") @db.Uuid
  createdAt   DateTime  @default(now()) @map("created_at")
  clearedAt   DateTime? @map("cleared_at")
  clearedById String?   @map("cleared_by_id") @db.Uuid
  clearReason String?   @map("clear_reason") @db.VarChar(1000)

  @@index([organizationId, periodStart, periodEnd])
  @@map("manual_review_flags")
}
```

**`LedgerAccount`: `cashflowCategory` → `cashflowBucket`** (O-9/O-10/O-12):

```prisma
model LedgerAccount {
  // …
  /// Bucket del cashflow de la CONTRAPARTIDA (columna `cashflow_bucket` del
  /// seed, 834 de 906 filas). `null` sólo en 57x —la propia tesorería—, en los
  /// contenedores mixtos de nivel 1 (`4`, `5`) y en los grupos 8/9.
  /// La categoría OPERATING/INVESTING/FINANCING NO se almacena: se deriva con
  /// `cashflowCategoryOf(bucket)` (`lib/accounts/types.ts`).
  cashflowBucket CashflowBucket? @map("cashflow_bucket")
  // − cashflowCategory  (columna eliminada: NULL en las 906 filas, sin lectores)
}
enum CashflowBucket { COBROS_CLIENTES PAGOS_PROVEEDORES PAGOS_PERSONAL PAGOS_IMPUESTOS OTROS_EXPLOTACION INVERSION FINANCIACION }
// enum CashflowCategory: se elimina de Prisma. Vive como tipo TS derivado.
```

`Organization` gana dos relaciones (`reportRuns`, `manualReviewFlags`) y **ninguna columna nueva**: `reviewThresholds Json?` ya existe desde E1 y E6 le da por fin schema (§2.4).

### 2.3 Migración `20260909100000_e6_reports`

1. `CREATE TABLE report_runs` + `manual_review_flags`; enums `ResultKind`, `ComparativeBasis`, `CashflowBucket`.
2. `SELECT app.enforce_tenant_rls('report_runs'); SELECT app.enforce_tenant_rls('manual_review_flags');`
3. **`report_runs` append-only como `audit_logs`** (patrón `20260905110000_e2_rls` + ADR-0009):
   ```sql
   CREATE POLICY report_runs_no_update ON "report_runs" AS RESTRICTIVE FOR UPDATE USING (false);
   CREATE POLICY report_runs_no_delete ON "report_runs" AS RESTRICTIVE FOR DELETE USING (false);
   REVOKE UPDATE, DELETE ON "report_runs" FROM app_runtime;
   ```
4. **`manual_review_flags` semi-append-only** (patrón `GRANT` de columna de ADR-0010): sin `DELETE`; `UPDATE` sólo de `cleared_at`, `cleared_by_id`, `clear_reason`, con trigger `manual_review_flags_only_clear_update` que lanza si cambia cualquier otra columna.
5. **Único flag activo** por periodo y ámbito: dos índices únicos parciales (`WHERE cleared_at IS NULL`, uno con `scope` y otro `WHERE scope IS NULL`), porque `NULL <> NULL`.
6. Trigger `report_runs_analytics_key` (BEFORE INSERT) que compone `analytics_key`; se calcula en la base para que dos caminos no diverjan.
7. `CHECK` de coherencia analítica: `type NOT IN ('PYG_ANALITICA','PRESUPUESTO_REAL','DASHBOARD') OR analytics_hash IS NOT NULL`; `CHECK (period_end >= period_start)`; `CHECK (duration_ms >= 0)`.
8. **`accounts`: `ADD COLUMN cashflow_bucket` + backfill desde el seed + `DROP COLUMN cashflow_category` + `DROP TYPE "CashflowCategory"`.** El backfill va con el patrón obligatorio y la **marca de conversión escrita ANTES** (runbook de E3): `ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;` → marca → `UPDATE … FROM (VALUES …) AS seed(code, bucket) WHERE accounts.code = seed.code AND accounts.origin = 'SEED'` → `ALTER TABLE accounts FORCE ROW LEVEL SECURITY;`. Se aplica a **todas** las organizaciones existentes; nunca pisa una cuenta `MANUAL`/`CSV_IMPORT`. El listado de pares `(code, bucket)` se genera desde `seeds/npgc.csv` y va **literal** en el SQL de la migración (una migración no lee ficheros).
9. **R-18 → R-18′** en `lib/accounts/validate.ts`: el aviso deja de ser «categoría fuera de 57x» y pasa a ser **«`cashflowBucket` obligatorio en toda cuenta postable salvo 57x»** (WARN al crear una subcuenta sin bucket; el hijo hereda el del padre salvo declaración explícita, igual que en el generador del seed).
10. `TENANT_MODELS` += `"ReportRun"`, `"ManualReviewFlag"`; test de que ninguna tabla queda en `NO FORCE`.

**Datos existentes:** ningún informe persistido. La única columna de negocio que cambia es `accounts.cashflow_category`, `NULL` en el 100 % de las filas y sin un solo lector en el código.

### 2.4 `Organization.reviewThresholds` — schema y valores por defecto (§5 del experto)

```ts
export const reviewThresholdsSchema = z.object({
  version: z.literal(1),
  comparativeBasis: z.nativeEnum(ComparativeBasis).default("SAME_PERIOD_PREVIOUS_YEAR"),
  kpis: z.record(z.string(), z.object({
    pctBps: z.number().int().min(0).max(1_000_000).nullable(),
    minAbsCents: z.number().int().min(0).nullable(),
    /** Umbral en puntos de margen, para KPI que YA son un porcentaje. */
    minPointsBps: z.number().int().min(0).nullable().default(null),
  })).default(DEFAULT_KPI_THRESHOLDS),
})
```
Un KPI dispara revisión si **`|Δ%| > pctBps` Y `|Δ absoluta| > minAbsCents`** — la conjunción es lo que impide que pasar de 100 € a 300 € de gastos financieros ahogue el sello en ruido.

| KPI | Definición | `pctBps` | `minAbsCents` |
|---|---|---:|---:|
| `ingresos` | Epígrafe 1 (INCN) | 1500 | 500 000 |
| `ebitda` | A.1 revirtiendo epígrafes 8 y 11 | 2500 | 300 000 |
| `resultado` | A.4 | 3000 | 300 000 |
| `tesoreria` | Saldo final 57x | 2000 | 1 000 000 |
| `deuda` | `17x + 52x + 40x + 41x` | 1000 | 500 000 |
| `dso` | `430 / INCN × 365` | 2000 | suelo **10 días** |
| `margenBruto` | MC1 % | — | suelo **300 bps** (puntos de margen) |

**Variaciones explicables que NO disparan** (`lib/ledger/reports/report-run.ts`, funciones puras con test): **EV-1** periodo con `OPENING`/`CLOSING`/`REGULARIZATION` (excluidos de todo KPI de flujo) · **EV-2** nunca se compara contra el mes anterior de otro ejercicio · **EV-3** se descuenta la parte de la variación atribuible al epígrafe 20/19 y a `kind = REGULARIZATION` · **EV-4** los meses de liquidación (1, 4, 7, 10) comparan contra la **media de los cuatro trimestres** · **EV-5** un `REVERSAL` y su original en el mismo periodo se netean · **EV-6** los KPI por dimensión sólo se comparan sobre dimensiones vivas en ambos periodos.
**Variaciones que SÍ disparan siempre**: **EV-7** `analyticsHash` distinto (redefinición de la métrica, no variación) · **EV-8** `gitSha` distinto · **EV-9** cualquier invariante en FAIL · **EV-10** cambio de `epigraph` de una cuenta con líneas en el periodo comparado (`AuditLog`).

### 2.5 Reglas de presentación (R-B1…R-B6, R-P1) — las fija ADR-0012

- **R-B1** `saldo(cuenta) = Σdebe − Σhaber`; positivo = deudor. El signo lo pone la agregación, nunca la línea.
- **R-B2** Presentación: `BALANCE_ACTIVO → +saldo`; `BALANCE_PASIVO` y `BALANCE_PN → −saldo`. **Un solo `CASE`**, no dos ramas de código.
- **R-B3** **`isContra` no interviene en el cálculo.** `2816` tiene saldo acreedor y con R-B2 sale ya como −300 000 dentro de su epígrafe de activo. `isContra` es (a) presentación —marca `(−)` en la UI— y (b) **check de signo**: una contra-cuenta con importe presentado positivo es anómala (**I-E6-10**).
- **R-B4** **`bidirectional`** (7 cuentas): el seed guarda la ruta deudora. `saldo ≥ 0` → epígrafe de activo del seed; `saldo < 0` → **epígrafe espejo de pasivo** por `−saldo`, según la tabla cerrada de §3.3. Nunca en los dos lados. La reclasificación es **por cuenta postable y por su saldo neto a la fecha del balance**, jamás por línea ni por movimiento, y con subcuentas se aplica **a cada una por separado** (compensar `5510` deudor con `5511` acreedor sería compensar un crédito y una deuda frente a personas distintas: art. 37 CdC).
- **R-B5** `saldo(129) = 0` → PN `A-1) VII` = **I3 inyectado**; `saldo(129) ≠ 0` → **leído de 129**. **Nunca las dos cosas**, y decide el **saldo**, no `FiscalYear.status`.
- **R-B6** `472`/`477` **no son bidireccionales**: la separación deudor/acreedor la hace el plan (`4700` activo / `4750` pasivo) al liquidar (T-24). Saldo de signo contrario al natural → **WARN** (**I-E6-12**), nunca reclasificación.
- **R-P1** PyG: `aporte = haber − debe`. Ingresos +, gastos −. `708`/`709`/`706` aportan −; `606`/`608`/`609` aportan +. Idéntica a la convención de la matriz analítica de E4, para que I3 e I4 se comparen sin conversión.

---

## 3. Motor / funciones puras (`lib/ledger/reports/`)

Todas son **puras**: reciben las líneas ya leídas, sin IO, sin LLM, sin `Date.now()` (el hook `.claude/hooks/guard.sh` lo impide; `refDate` viaja en `params`). Todas devuelven provenance por celda con `cellProvenance`.

### 3.1 Tipos comunes nuevos (`lib/ledger/reports/types.ts`)

```ts
export type StatementAccount = ReportAccount & {
  statement: Statement | null
  epigraph: string | null
  epigraphPymes: string | null
  bidirectional: boolean
  isContra: boolean
  nature: Nature
  cashflowBucket: CashflowBucket | null
}

export type BalanceSnapshot = "PRE_REGULARIZACION" | "POST_REGULARIZACION" | "POST_CIERRE"

/** `kind` excluidos por foto (§1.1 del experto). Tabla, no `if` repartidos. */
export const SNAPSHOT_EXCLUDED: Record<BalanceSnapshot, readonly EntryKind[]> = {
  PRE_REGULARIZACION:  ["REGULARIZATION", "CLOSING"],
  POST_REGULARIZACION: ["CLOSING"],
  POST_CIERRE:         [],
}

export type StatementRow = {
  path: string            // "A) Activo no corriente / II. Inmovilizado material"
  label: string           // último segmento
  depth: number
  order: readonly number[]// ordinal por segmento — nunca orden lexicográfico
  cents: Cents            // con el signo de presentación (R-B2)
  isLeaf: boolean
  previousCents?: Cents   // comparativo; `undefined` ≠ 0 (§8.7)
  deltaCents?: Cents
  deltaBps?: number | null// `null` si el comparativo es 0 — nunca NaN (G-05)
  accountCodes: readonly string[]
  isComputed: boolean     // «VII. Resultado del ejercicio» inyectado (R-B5)
  isContraCell: boolean   // marca `(−)` en la UI (R-B3)
  provenance?: Provenance
  children?: StatementRow[]
}
```
El esquema de `StatementRow` es **el mismo** (`path`, `depth`, `cents`, `isLeaf`) que el de `estados-esperados.json`: el test byte a byte compara sin adaptador.

### 3.2 Epígrafes: árbol y orden (`lib/ledger/reports/epigraph-tree.ts`)

El seed guarda el epígrafe como **ruta separada por ` / `**. El orden **no es lexicográfico**: `X.` va después de `IX.` y `10.` después de `9.`.

```ts
export function splitEpigraph(path: string): string[]
/** Ordinal del segmento: "A)"→1 · "A-1)"→1 · "IV."→4 · "10."→10 · "b)"→2 · sin prefijo → 9_999. */
export function segmentOrder(segment: string): number
export function buildEpigraphTree(rows, opts): StatementRow[]   // el padre es la SUMA de sus hijos
```
`epigraphFor(account, variant)` (`lib/accounts/epigraphs.ts`) sigue siendo **el único** punto que elige entre las dos columnas: la correspondencia NORMAL↔PYMES **no es una regla, es una tabla** (§1.3 del experto), así que nada de derivar romanos por regex. **Los epígrafes vacíos no se imprimen.**

### 3.3 Balance (`balance.ts`) y PyG (`pyg.ts`)

```ts
export type BalanceParams = ReportPeriod & {
  variant: PgcVariant
  snapshot: BalanceSnapshot
  /** Cuenta mapeada a RESULTADO_EJERCICIO (129), para R-B5. */
  resultAccountCode: string
  comparative?: { lines: readonly ReportLine[]; from: LocalDate; to: LocalDate; label: string; basis: ComparativeBasis }
}

export function buildBalance(lines, accounts, params: BalanceParams, ctx?): BalanceReport
export function buildPyg(lines, accounts, params: PygParams, ctx?): PygReport
```

**Balance — algoritmo.** (1) Excluye los `kind` de `SNAPSHOT_EXCLUDED[snapshot]`; toma **todas** las líneas hasta `to`, apertura incluida (es un saldo de stock). (2) Saldo por cuenta (R-B1). (3) Presentación por masa (R-B2) — **sin tocar `isContra`** (R-B3). (4) Bidireccionales: reclasificación por signo al epígrafe espejo (R-B4), **antes** de agregar:

| Cuenta | Saldo deudor → activo | Saldo acreedor → pasivo (NORMAL) |
|---|---|---|
| `551`, `5525` | B) V. Inversiones financieras a c/p / 5. Otros activos financieros | C) III. Deudas a c/p / **5. Otros pasivos financieros** |
| `552`, `5523`, `5524` | B) IV. Inversiones en empresas del grupo y asociadas a c/p / 5. Otros activos financieros | C) **IV. Deudas con empresas del grupo y asociadas a c/p** |
| `554`, `555` | B) III. Deudores comerciales… / 3. Deudores varios | C) V. Acreedores comerciales… / **3. Acreedores varios** |

(cadenas verbatim y variante PYMES en `bidirectionalMirror` del JSON; casos +/−/0 en `bidirectionalScenarios`, que es la entrada de I-E6-5b). `555` con saldo ≠ 0 al cierre → **WARN de Auditoría** (cuenta puente).
(5) Resultado del ejercicio por **R-B5**. (6) Árbol de epígrafes, sin imprimir vacíos. (7) `check` = **I2** = 0 y **nota al pie obligatoria** de no compensación (§7.4 del experto): «Sin compensación de saldos: los créditos frente a la Hacienda Pública (retenciones y pagos a cuenta soportados, `473`) se presentan en el activo y la deuda por impuesto corriente (`4752`) en el pasivo, sin netear (art. 37 CdC y NRV 9ª)». La nota viaja en el `result` y se imprime en pantalla, en PDF y en la hoja del XLSX.

**PyG — algoritmo.** (1) `isPnlLine` (cuentas 6/7 con `kind ∉ {REGULARIZATION, CLOSING, OPENING}`) — **definición única de I3**. (2) Aporte `haber − debe` (R-P1): los signos salen solos, sin tratamiento de contra-cuentas y **sin ningún filtro de anulados** (el contra-asiento se neutraliza con su original). (3) Árbol de epígrafes. (4) Subtotales **por número de epígrafe, no por rango de cuentas**, con `pygBlockOf` (que ya conoce el desplazamiento PYMES):

| Subtotal | NORMAL | PYMES |
|---|---|---|
| A.1 Resultado de explotación | Σ 1…13 | Σ 1…12 |
| A.2 Resultado financiero | Σ 14…19 | Σ 13…18 |
| A.3 Antes de impuestos | A.1 + A.2 | A.1 + A.2 |
| A.4 Del ejercicio | A.3 + 20 | A.3 + 19 |

(5) Checks: **I3** (`A.4 = pnlContableCents`), **I-E6-3** (`A.3 = BAI` de E4 = 1 996 430) y **I-E6-4** (`A.1 + A.2 = A.3`). Que I-E6-3 exista por separado es deliberado: un motor que metiera `630` en «otros gastos de explotación» acertaría A.4 y fallaría A.1/A.3.
**O-1/O-3 (desglose a/b de `706`/`708`/`709` y `606`/`608`/`609`):** el motor imputa la rectificación al **mismo subepígrafe que la cuenta de ingreso o gasto rectificada**, resuelta por `reversesEntryId`/`sourceId` del asiento origen; si no la puede resolver, al subepígrafe con **mayor importe del periodo**, y lo hace constar en la `provenance` de la celda.

### 3.4 Cashflow (`cashflow.ts`)

**Directo (R-CF-1…R-CF-4, R-CF-7, R-CF-8).**

```ts
export function buildCashflowDirect(lines, accounts, params, ctx?): CashflowDirectReport
// { months[12], rows por bucket × mes, openingCents, closingCents, deltaCents,
//   internalTransfers[], impuestoBeneficiosCents, otrosImpuestosCents, check: I6 }
```
- Tesorería = prefijo **`57`**; saldo inicial **del asiento `OPENING`**, no de configuración (R-CF-1). Universo: `kind ∉ {OPENING, CLOSING, REGULARIZATION}` (R-CF-2).
- **R-CF-3, por línea y exacto**: en cada asiento con ≥ 1 línea 57x, cada línea **no-57x** aporta `−(debe − haber)` a su bucket. Como el asiento cuadra (I1), la suma **es** el Δ57x del asiento. Nada de reparto proporcional.
- **R-CF-4**: asiento cuyas únicas líneas son 57x → **excluido** y listado en `internalTransfers`; la exclusión es porque las dos cuentas son 57x, **no** porque el neto sea 0.
- **R-CF-7**: si el asiento mezcla tesorería, **un solo** bloque comercial (`43x`/`40x`/`41x`/`438`/`407`) y el IVA de esa misma operación (`472`/`477`), el IVA sigue al bloque comercial. Con varios bloques comerciales, el IVA queda en `PAGOS_IMPUESTOS` y la Auditoría lo lista como WARN.
- **R-CF-8**: el impuesto sobre beneficios **no es un bucket**; la línea 8.d del EFE se deriva dentro de `PAGOS_IMPUESTOS` por las claves **`HP_ACREEDORA_IS`/`HP_DEUDORA_IS`** del `OrganizationAccountMap`, nunca por los códigos escritos a mano.
- Bucket = `cashflowBucket` de la cuenta contrapartida (seed, prefijo más largo que case); categoría **derivada** con `cashflowCategoryOf`. Los meses sin flujo se imprimen **con ceros explícitos**, y `INVERSION`/`FINANCIACION` se imprimen aunque valgan 0.

**Indirecto (R-CF-5, R-CF-6).** Partición **mecánica y exhaustiva**: toda cuenta no-57x pertenece a **exactamente un** bloque, el aporte de cada línea es `−(debe − haber)` y, por la identidad `Σ(debe−haber) = 0` de todo asiento, `Σ bloques = Δ57x` **por álgebra, con tolerancia 0 y sin partida de ajuste**.

```ts
/** O-11: función pura sobre prefijo, NUNCA columna nullable (un hueco rompería I6 en silencio). */
export function indirectBlockOf(accountCode: string): IndirectBlock
export const INDIRECT_BLOCKS: readonly { prefix: string; block: IndirectBlock }[]  // = indirectBlocks del JSON
```
Bloques: `RESULTADO` (6, 7, 129) · `AJUSTES_NO_MONETARIOS` (14, 28, 29, 39, 49, 529, 59) · `VAR_CIRCULANTE_{EXISTENCIAS, DEUDORES, ACREEDORES, ADMIN_PUBLICAS, PERIODIFICACIONES, OTROS}` · `INVERSION` (20–27, 53, 54) · `FINANCIACION` (10–13, 15–19, 50, 51, 52, 56). **Test de exhaustividad sobre las 906 cuentas del seed**: ninguna sin bloque, ninguna en dos. En el fixture, `RESULTADO` **es** I3 sin ajuste (**I-E6-7**).
**R-CF-6**: los asientos sin ninguna línea 57x que tocan inversión o financiación se listan en `nonCashEntries` (`AJ-002`, `R-009`) y se muestran en un desplegable «operaciones sin flujo de efectivo» bajo el cuadro. Sin esa nota, el lector ve una inversión de 1 500 000 que no cuadra con nada de lo que ha visto en el banco.

**Dos vistas.** Por defecto, **directo mensual** (lo que un gerente entiende y lo que ningún programa le da). Segunda pestaña, **estructura oficial A–E** (`buildEfeView(direct, indirect) → EfeReport`): A) explotación 1–5 · B) inversión 6–8 · C) financiación 9–12 · D) efecto de tipos de cambio (**0** hoy, y documentado: el ERP trabaja en moneda base y las diferencias `668`/`768` van a explotación) · E) aumento neto = `deltaCashCents`, `openingCashCents`, `closingCashCents`, que **es I6**. Cabecera obligatoria en las dos vistas: **«Informe de gestión. No forma parte de las cuentas anuales abreviadas»** (el EFE no es exigible en PYMES ni en abreviado, art. 257.3 LSC y RD 1515/2007).

### 3.5 Dashboard (`dashboard.ts`)

```ts
export function buildDashboard(lines, accounts, params: DashboardParams, ctx?): DashboardReport
// DashboardParams: ReportPeriod + refDate + agingBuckets + treasuryPrefix "57" + currency
```
KPIs con provenance y confianza `calculado`: **ingresos** (epígrafe 1), **EBITDA = A.1 revirtiendo los epígrafes 8 y 11** —«Otros resultados» (13/12) **entra**, los deterioros de circulante `694`/`794` **entran**; en el fixture 1 995 430 + 395 000 = **2 390 430**, la misma cifra que la matriz de E4—, **resultado** (A.4 = I3), **tesorería** (saldo 57x), **cobros/pagos pendientes** y **series mensuales**.

**Aging (§8.8):** desde el **vencimiento** (`dueDate` de la línea 43x/40x), tramos **`SIN_VENCIMIENTO` · `A_APLICAR` · `NO_VENCIDO` · `1–30` · `31–60` · `61–90` · `>90`**, con `refDate` **por parámetro** (dentro de `paramsHash`: dos ejecuciones con el mismo `ledgerHash` dan el mismo aging). Las líneas sin `dueDate` van a tramo propio **visible y primero**, y a un check de calidad de datos; las de signo contrario (cobro sin aplicar, abono) van a `A_APLICAR` y **no se compensan** con las vencidas. Invariantes **I-E6-14** (`Σ tramos = saldo de la cuenta a refDate`, tolerancia 0) y **I-E6-15** (ninguna línea en dos tramos). Agrupación por **cuenta** hasta E8, declarado en pantalla.

### 3.6 `ReportRun`: clave, forma canónica y umbrales (`report-run.ts`)

```ts
export function canonicalParams(params: Record<string, unknown>): string   // claves ordenadas, sin undefined
export function paramsHash(params: Record<string, unknown>): string        // sha256 hex
export function reportRunKey(input: ReportRunKeyInput): string             // el MISMO string del @@unique
export function canonicalResultJson(result: unknown): string               // I-E6-17

export function checkThresholds(current, previous, thresholds, ctx): ThresholdBreach[]  // EV-1…EV-6 dentro
export function alwaysReviewReasons(ctx): SealReason[]                                   // EV-7…EV-10
export function reportSealReasons(input): SealReason[]
```
`deltaBps` en **entero**: si el valor anterior es 0, `deltaBps = null` y decide `minAbsCents`. Ni `Float`, ni `NaN`, ni `Infinity`. `SealReasonKind` de `lib/ledger/invariants.ts` gana **`"VARIACION"`** (Nivel 2, ADR-0012), y los códigos de motivo son cerrados: `VARIACION_KPI`, `REGULARIZACION_DESFASADA`, `MOTOR_CAMBIADO`, `ANALITICA_REDEFINIDA`, `EPIGRAFE_CAMBIADO`, `REVISION_FORZADA`, `INVARIANTE_FAIL`, `GIT_SHA_DESCONOCIDO`.

### 3.7 Export (`lib/export/{csv,xlsx,pdf}.ts`)

`reportToCsv` (`@fast-csv/format`), `reportToXlsx` (OOXML mínimo con **`jszip`**, ya en el proyecto — D-E6-5), `reportToPdf` (`@react-pdf/renderer`, ya en el proyecto). Tres bloques en los tres formatos: el informe, la hoja/anexo **«Procedencia»** (métrica, valor, `run_id`, `ledgerHash`, módulo@sha, consulta y parámetros por celda) y la hoja/anexo **«Validación»** (checks y sello con sus motivos), más las **notas al pie** del informe (no compensación, «informe de gestión», operaciones sin flujo). CSV: tres ficheros en un `.zip`. XLSX: importes **como número** con formato `#.##0,00 €`, componiendo la cadena decimal por aritmética entera desde los céntimos (`lib/money.ts`), sin pasar por `Float`.

---

## 4. Capa de aplicación

`models/reports.ts` (IO, tenant) — **no calcula nada**:

```ts
getOrCreateReportRun(tx, request): Promise<ReportRunView>
  // 1. líneas (getLinesForPeriod) + plan (getPlan) + ejercicio + comparativo según `basis`
  // 2. computeLedgerHash (SQL) [+ analyticsHash si el tipo lo exige]
  // 3. clave de §2.2 → si existe, devuelve la caché (`origen: "cache"`)
  // 4. si no: función pura → runLedgerInvariants + checks de E6 → diff contra el run
  //    anterior (EV-1…EV-10) → seal() + reportSealReasons() → INSERT ON CONFLICT DO NOTHING
getReportRun(db, id) / listReportRuns(db, filter) / diffAgainstPrevious(db, run)
setManualReviewFlag(tx, input, actor) / clearManualReviewFlag(tx, input, actor)
getDashboard(tx, request)
```

| Acción (`app/(app)/reports/actions.ts`) | Rol mínimo | Notas |
|---|---|---|
| `balanceAction`, `pygAction`, `cashflowAction`, `dashboardAction` | `VIEWER` | Sólo lectura; escriben un `ReportRun`, que es un hecho, no una mutación de negocio |
| `listReportRunsAction`, `reportRunDetailAction`, `reportDiffAction` | `VIEWER` | Histórico y diff |
| `cellDetailAction` (drill-down) | `VIEWER` | Ejecuta `registros_origen` **parametrizada** dentro de `tenantTransaction` |
| `GET /reports/[type]/export?format=csv\|xlsx\|pdf&runId=…` (route handler) | `VIEWER` | Binario: route handler, no server action |
| `forceManualReviewAction` | **`ADMIN`** | Motivo ≥ 10 caracteres, periodo obligatorio, `AuditLog` |
| `clearManualReviewAction` | **`ADMIN`** | Motivo obligatorio, `AuditLog`; marca `cleared`, no borra |
| `setReviewThresholdsAction` | **`ADMIN`** | `reviewThresholdsSchema`, `AuditLog` con `before`/`after` |

`AuditEntity` += `"ReportRun"`, `"ManualReviewFlag"`; `AuditAction` += `"FORCE_REVIEW"`, `"CLEAR_REVIEW"`, `"SET_THRESHOLDS"`.

**Concurrencia:** `INSERT … ON CONFLICT DO NOTHING` y relectura de la fila ganadora. Un solo run por clave, sin error al usuario.

**Retirada de lo heredado (G-05/G-06).** `models/stats.ts` y los agregados de `lib/stats.ts` (`calcTotalPerCurrency`, `calcNetTotalPerCurrency`) **se eliminan**; `lib/stats.ts` conserva sólo `isTransactionIncomplete`/`incompleteTransactionFields`. El recuento de **documentos no contabilizados** sobrevive en `models/transactions.ts` como recuento, con badge `no verificado` y la leyenda «N documentos sin asiento: no entran en ninguna cifra de este panel» — lo contrario de sumar 0 en silencio.

---

## 5. Invariantes

### 5.1 Los tres de la skill `fiabilidad`

| ID | Formulación operativa (§4 del experto) | Tol. |
|---|---|---|
| **I2** | `ACT(K) − PAS(K) − RES(K) = 0`, con `RES = I3` si `saldo(129, K) = 0` y `0` si no (**exclusivo**, R-B5), y con la reclasificación de bidireccionales aplicada **antes** de sumar. `K` = `SNAPSHOT_EXCLUDED[snapshot]` | 0 |
| **I3** | `Σ(haber − debe)` de líneas 6/7 con `kind ∉ {REGULARIZATION, CLOSING, OPENING}`; y, **si `saldo(129, {CLOSING}) ≠ 0`**, `I3 = −saldo(129)`. Con 129 a 0 la segunda igualdad **no se evalúa** (no es un FAIL) | 0 |
| **I6** | `inicial + Σ bloques(directo) = final` · `Σ bloques(indirecto) = Δ57x` · `directo = indirecto` · mensual: `inicial + Σ 12 meses = final` y el acumulado de cada mes = saldo 57x a fin de mes | 0 |

Casos límite obligatorios en los tests (§4.1–4.3 del experto): las cuatro fotos, apertura del ejercicio siguiente, **129 con pérdidas** (PN negativo con I2 = 0), diario vacío (PASS, no error), contra-asiento en el periodo (se neutraliza solo, **prohibido** cualquier filtro de `voidedAt`/`reversesEntryId`), modelo PYMES (I3 idéntico), y traspaso interno 570↔572.

### 5.2 Invariantes propios (I-E6-1…15 del experto; 16–19 de infraestructura)

| ID | Enunciado | Estado |
|---|---|---|
| **I-E6-1** | Balance NORMAL y PYMES cuadran al mismo total de activo y de PN+pasivo, en las cuatro fotos | FAIL |
| **I-E6-2** | Σ epígrafes = Σ saldos: ninguna cuenta con saldo ≠ 0 y `statement ∈ BALANCE_*` queda fuera; ningún epígrafe recibe una cuenta inexistente | FAIL |
| **I-E6-3** | `A.3 = BAI` declarado por E4 (1 996 430) en los dos modelos | FAIL |
| **I-E6-4** | `A.4 = I3` y `A.1 + A.2 = A.3` en los dos modelos | FAIL |
| **I-E6-5** | Una cuenta bidireccional nunca aparece en los dos lados en la misma foto | FAIL |
| **I-E6-5b** | `bidirectionalScenarios` (+/−/0) reproduce `bidirectionalMirror`; saldo 0 no se presenta | contrato |
| **I-E6-6** | Cashflow mensual: `inicial + Σ 12 meses = final` y acumulado mensual = saldo 57x | FAIL |
| **I-E6-7** | El bloque `RESULTADO` del indirecto **es** I3, sin ajuste | FAIL |
| **I-E6-8** | Tras el `CLOSING`, ninguna cuenta de balance conserva saldo | FAIL |
| **I-E6-9** | La apertura del ejercicio siguiente reproduce el balance formulado cuenta a cuenta, **129 incluida** | FAIL |
| **I-E6-10** | Toda cuenta `isContra` presenta importe negativo en su epígrafe (en PyG, `7080`/`6080` son la excepción intencionada) | WARN |
| **I-E6-11** | Balance pre y post regularización dan el mismo total y el mismo PN (R-B5 es neutra) | FAIL |
| **I-E6-12** | `472`/`477` con saldo de signo contrario al natural → WARN, nunca reclasificación (R-B6) | WARN |
| **I-E6-13** | **`saldo(129) ≠ 0 ⇒ I3 = −saldo(129)`**. FAIL = líneas 6/7 posteriores a la regularización → sello `REQUIERE REVISIÓN` con motivo `REGULARIZACION_DESFASADA`, mostrando **las dos cifras** y su diferencia. Nunca se elige una en silencio | FAIL |
| **I-E6-14** | Aging: `Σ tramos = saldo de la cuenta` a `refDate`, incluido `SIN_VENCIMIENTO` | FAIL |
| **I-E6-15** | Aging: ninguna línea en dos tramos | contrato |
| **I-E6-16** | `report_runs` es inmutable: `UPDATE`/`DELETE` imposibles como `app_runtime` (barrido SQL, como I10) | FAIL |
| **I-E6-17** | Reproducibilidad: recalcular con el mismo `(ledgerHash, paramsHash, gitSha)` da `canonicalResultJson` **byte a byte** idéntico | FAIL |
| **I-E6-18** | Ningún run se sirve de caché con `ledgerHash` distinto del del diario actual del periodo | FAIL |
| **I-E6-19** | Dashboard = informes: ingresos y resultado = los de la PyG del mismo periodo; tesorería = saldo 57x del balance; EBITDA = el de la matriz de E4 | FAIL |

Además, **WARN de calidad de datos** que E6 aporta y E7 pinta: `555` con saldo ≠ 0 al cierre · asiento con línea de grupo 2 y contrapartida `40x`/`41x` (**O-4/O-13**, hasta que E8 traiga `PROVEEDORES_INMOVILIZADO → 523`) · IVA con varios bloques comerciales en el mismo asiento (R-CF-7) · líneas 43x/40x sin `dueDate`.

Tests: `lib/ledger/reports/reports.test.ts` y `lib/ledger/invariants.test.ts` contra `estados-esperados.json` (byte a byte, 47 checks), más `tests/integration/e6-reports.test.ts` (I-E6-16 y 18) y el paso de CI `build_estados_esperados.py --check`.

---

## 6. UI

| Ruta | Contenido |
|---|---|
| `/reports/balance` | Árbol de epígrafes colapsable, **selector de foto** (por defecto `PRE_REGULARIZACION`) y de variante, comparativo **misma fecha del ejercicio anterior + cierre anterior** (siempre), fila de cuadre `Activo − Pasivo − PN = 0,00 €`, marca `(−)` en contra-cuentas, **nota al pie de no compensación** |
| `/reports/pyg` | Árbol de epígrafes con A.1–A.4 destacados, comparativo YoY, fila de cuadre `A.4 − I3 = 0,00 €` |
| `/reports/cashflow` | Pestañas **Directo mensual** (bucket × mes, saldo inicial/final, traspasos internos), **Indirecto** (bloques) y **EFE oficial A–E**; desplegable «operaciones sin flujo de efectivo»; cabecera **«Informe de gestión…»**; fila de conciliación I6 |
| `/reports/runs` y `/reports/runs/[id]` | Histórico con sello y motivos; detalle con cifras congeladas, checks, **diff vs el run comparado** (`comparativeRunId` visible), botón Exportar |
| `/dashboard` (reescrito) | KPIs (ingresos, EBITDA, resultado, tesorería), **aging con sus siete tramos**, series mensuales, todo `calculado` con drill-down, aviso de documentos sin contabilizar |
| `/settings/reports` | Umbrales por KPI (ADMIN), base comparativa, y lista de `ManualReviewFlag` con alta y limpieza |

Importes, colores y tipografías de la skill `ui-erp` (sin rojo/verde semáforo; los umbrales superados se marcan con el chip de aviso `#F5A623`). Comparativo ausente → celda **vacía con la leyenda «sin comparativo»**, nunca 0. Si el run viene de caché, la cabecera muestra la fecha del run original.

---

## 7. Trazabilidad

Cada celda: `{valor, moneda, metrica, run_id, ledgerHash, calculado_por: "lib/ledger/reports/<fichero>.ts@<gitSha>", registros_origen, parametros, confianza: "calculado"}`, con `fiscal_year_id` y los `entry_kind` excluidos de la foto **dentro** de la consulta (corrección #10 de E3). Cada run: `params` (con `snapshot`, `variant`, `currency`, `refDate`), `paramsHash`, los tres sellos, `gitSha`, `validation`, `sealReasons` con código, `comparativeRunId`/`comparativeBasis`, `durationMs`, `createdById`. `ManualReviewFlag` y `reviewThresholds`: `AuditLog` con `before`/`after` en la misma transacción. El export arrastra la provenance: un XLSX que sale del ERP se audita sin volver al ERP.

---

## 8. Criterios de aceptación y plan de tareas

### 8.1 Criterios (Given / When / Then)

1. **Fixture byte a byte.** *Given* `ejercicio-completo` cargado, *when* se generan balance (4 fotos × 2 modelos), PyG (2 modelos) y cashflow (directo mensual/anual e indirecto), *then* coinciden **al céntimo** con `estados-esperados.json` y los **47 checks** salen en PASS.
2. **Las cuatro fotos.** *Then* `PRE_REGULARIZACION` y `POST_REGULARIZACION` dan **el mismo** total y el mismo PN (I-E6-11); `POST_CIERRE` deja **todas** las cuentas de balance a 0 (I-E6-8); la apertura de 2027 reproduce el balance formulado **con 129 incluida** (I-E6-9).
3. **R-B5 exclusiva.** *Given* 129 a 0, *then* PN VII = I3 inyectado; *given* 129 con saldo, *then* PN VII se lee de 129 y **no** se inyecta nada. En los dos casos I2 = 0. Un motor que sume las dos falla el test del día del cierre.
4. **I-E6-13.** *Given* un asiento en 6/7 posterior a la `REGULARIZATION`, *then* I3 ≠ −saldo(129), el check sale **FAIL**, el sello es `REQUIERE REVISIÓN` con motivo `REGULARIZACION_DESFASADA` y la pantalla muestra **las dos cifras** y su diferencia.
5. **Contra-cuentas sin doble resta.** *Given* `216`+`217` = 3 300 000 y `2816`+`2817` = −635 000, *then* «II. Inmovilizado material» = **2 665 000** (y no 3 935 000, que es lo que da restar `isContra` además del signo).
6. **Bidireccionales.** *Given* la tabla `bidirectionalScenarios`, *then* cada cuenta con saldo acreedor aparece en su epígrafe espejo de pasivo por `−saldo`, con saldo 0 no aparece en ningún lado, y nunca en los dos (I-E6-5/5b). *And given* `5510` deudor y `5511` acreedor, *then* **no se compensan**: cada subcuenta se reclasifica por separado.
7. **PyG y subtotales.** *Then* A.1 = 1 995 430 · A.2 = +1 000 · A.3 = 1 996 430 (= BAI de E4) · A.4 = 1 497 322 = I3, en los dos modelos; `7080` aporta −100 000 en el epígrafe 1 y `6080` +50 000 en el 4.
8. **Cashflow exacto por línea.** *Given* `CO-003` (cobro de 300 000 con 500 de comisión), *then* el informe muestra **+300 000** en cobros de clientes y **−500** en otros gastos de explotación, no 299 001/499. *And given* `TR-001` (570↔572), *then* está **excluido** y listado en `internalTransfers`. *And given* `ANT-C-01`, *then* los 42 000 de IVA van al bloque **comercial** (R-CF-7), no a impuestos.
9. **Cashflow conciliado.** *Then* 4 000 000 − 1 056 080 = 2 943 920 en el directo, en el indirecto y mes a mes (I6, I-E6-6), `directo == indirecto`, `RESULTADO` del indirecto **= I3 sin ajuste** (I-E6-7), y los meses sin flujo aparecen con ceros.
10. **Exhaustividad de la partición.** *Then* el test sobre las **906 cuentas del seed** demuestra que ninguna queda sin bloque indirecto y ninguna cae en dos; y que toda cuenta postable salvo 57x tiene `cashflowBucket`.
11. **Caché por clave completa.** *Given* un `BALANCE` `PRE_REGULARIZACION` ya emitido, *when* se pide el **mismo periodo y `ledgerHash`** con `snapshot = POST_REGULARIZACION`, *then* **no** se sirve el cacheado (distinto `paramsHash`) y se emite un run nuevo. *And when* se repite la misma petición sin tocar el diario, *then* se devuelve el mismo `run_id` (`origen: "cache"`).
12. **Primer run tras cambio de motor.** *Given* un run con `gitSha = A`, *when* se pide con `GIT_SHA = B`, *then* se recalcula y el sello es `REQUIERE REVISIÓN` con motivo `MOTOR_CAMBIADO` (EV-8).
13. **Revisión manual.** *Given* un `ManualReviewFlag` activo de un ADMIN con motivo, *then* todos los informes que solapen el periodo se sellan `REQUIERE REVISIÓN` con motivo `REVISION_FORZADA`; *when* un ADMIN lo limpia con motivo, *then* el siguiente run vuelve a `VALIDADO AUTOMÁTICAMENTE`. Un `EDITOR` recibe `FORBIDDEN` y no se escribe nada.
14. **Umbral de variación.** *Given* `ingresos` con `pctBps = 1500` y `minAbsCents = 500 000` y un run anterior de 1 000 000,00 €, *when* pasa a 1 200 000,00 € (+20 %, +200 000,00 €), *then* sello `REQUIERE REVISIÓN` con motivo `VARIACION_KPI` y `deltaBps = 2000`. *And given* +50 % sobre 40,00 €, *then* **no** dispara (falla `minAbsCents`). *And given* que el periodo contiene la `REGULARIZATION`, *then* esa parte se descuenta antes de aplicar el umbral (EV-3).
15. **Error inyectado.** *Given* el fixture correcto, *when* se altera **una** línea por SQL directo como `app_maintenance` (un céntimo en una 430), *then* I2 sale en FAIL, el sello es `REQUIERE REVISIÓN` con motivo `INVARIANTE_FAIL` y la pantalla muestra la evidencia con la consulta que la reproduce. El test **falla si el informe se sirve como validado**.
16. **Inmutabilidad y reproducibilidad.** `UPDATE`/`DELETE` sobre `report_runs` como `app_runtime` → 42501 y fila intacta (I-E6-16); recálculo con la misma clave → `canonicalResultJson` idéntico byte a byte (I-E6-17).
17. **Aging.** *Given* `refDate = 2026-12-31`, *then* `Σ tramos = saldo de 4300` (I-E6-14), ninguna línea en dos tramos (I-E6-15), las líneas sin `dueDate` aparecen en `SIN_VENCIMIENTO` **visible** y el mismo informe con el mismo `ledgerHash` y `refDate` da **el mismo** aging.
18. **Export.** *Given* un balance con sello `REQUIERE REVISIÓN`, *when* se exporta a XLSX, *then* abre en Excel y LibreOffice, los importes son **números**, y trae «Procedencia», «Validación» y las notas al pie. Igual en CSV (zip de tres) y PDF.
19. **Dashboard.** *Then* EBITDA = 2 390 430 (= matriz de E4, I-E6-19); sin ingresos, los porcentajes se pintan `—` y nunca `NaN` ni `0 %` (G-05); 3 documentos sin asiento se declaran y no se suman como 0 (G-06).
20. **Comparativo.** *Given* un informe de un trimestre, *then* la columna comparativa es el **mismo trimestre del ejercicio anterior**; *given* que no existe ejercicio anterior, *then* la columna sale **vacía con la leyenda «sin comparativo»**, nunca a 0; *and* el balance lleva **siempre** la columna del cierre anterior.
21. **Tenant y roles.** Dos organizaciones con el mismo diario comparten `ledgerHash` (ADR-0011) y ningún `ReportRun` es legible desde la otra (`test:integration:rls`); `VIEWER` ve y exporta los cinco informes y no ve un solo botón de mutación.

### 8.2 Plan de tareas

| # | Tarea | Depende de | Nivel | h |
|---|---|---|---|---|
| **T1** | **ADR-0012 ronda 2** (R-B3 sin doble resta · R-B4 espejo · R-B5 exclusiva · `cashflowBucket` y R-18′ · umbrales, EV-* y motivo `VARIACION`) a firma humana. **Bloquea T4, T6 y T10** | — | 2 | 4 |
| **T2** | Prisma: `ReportRun`, `ManualReviewFlag`, `ResultKind`, `ComparativeBasis`, `CashflowBucket`; `LedgerAccount.cashflowBucket` y retirada de `cashflowCategory`; `TENANT_MODELS`; relaciones | — | 2 | 7 |
| **T3** | Migración `20260909100000_e6_reports`: tablas, `enforce_tenant_rls`, append-only, `GRANT` de columna + trigger, únicos parciales, trigger de `analytics_key`, CHECKs, **backfill de `cashflow_bucket` bajo `NO FORCE`** y `DROP` de la columna vieja; tests de integración del SQL | T2, T1 | 2 | 16 |
| **T4** | `models/accounts.ts`, `forms/accounts.ts`, `models/npgc-seed.ts` y **R-18 → R-18′** en `lib/accounts/validate.ts`; herencia de bucket padre→hijo al crear subcuenta; UI del plan con la columna nueva | T2, T1 | 1 | 8 |
| **T5** | `lib/ledger/reports/{types,epigraph-tree}.ts`: `StatementAccount`, `StatementRow` con el **esquema del JSON**, `SNAPSHOT_EXCLUDED`, `segmentOrder`, `buildEpigraphTree` + tests (romanos, `10.` vs `9.`, `A-1)`, epígrafe vacío no impreso) | T2 | 2 | 10 |
| **T6** | `balance.ts`: cuatro fotos, R-B1…R-B6, espejo de bidireccionales, nota de no compensación, comparativo doble; `checkI2` + **test byte a byte** contra las 4 fotos × 2 modelos | T5, T1 | 2 | 22 |
| **T7** | `pyg.ts`: epígrafes, subtotales por número, R-P1, O-1/O-3 (subepígrafe de la rectificación), comparativo; `checkI3`, I-E6-3, I-E6-4 + test byte a byte | T5 | 2 | 16 |
| **T8** | `cashflow.ts` **directo**: R-CF-1…R-CF-4, R-CF-7, R-CF-8, buckets del seed, mensual + anual, `internalTransfers`; `checkI6` + test byte a byte de la tabla mensual | T5, T4 | 2 | 18 |
| **T9** | `cashflow.ts` **indirecto** + `buildEfeView` (A–E): `indirectBlockOf` puro, **test de exhaustividad sobre las 906 cuentas**, `nonCashEntries`, I-E6-7; cabecera «informe de gestión» | T8 | 2 | 14 |
| **T10** | `report-run.ts`: `canonicalParams`/`paramsHash`/`reportRunKey`/`canonicalResultJson`, `checkThresholds` con **EV-1…EV-6**, `alwaysReviewReasons` con **EV-7…EV-10**, códigos de motivo; `SealReasonKind += "VARIACION"` + tests | T1 | 2 | 14 |
| **T11** | `dashboard.ts`: KPIs, **EBITDA = A.1 revirtiendo 8 y 11**, aging de siete tramos con `refDate` inyectada, series mensuales; I-E6-14/15/19 | T6, T7, T8 | 2 | 16 |
| **T12** | `lib/ledger/invariants.ts`: I-E6-1…15 (los del experto) + 16–19, cableados en `runInvariants` y `scripts/run-invariants.ts`; WARN de calidad (555, O-4, IVA ambiguo, sin `dueDate`); paso de CI `build_estados_esperados.py --check` | T6, T7, T9, T10 | 2 | 14 |
| **T13** | `models/reports.ts`: `getOrCreateReportRun` (hashes, caché, `ON CONFLICT`, invariantes, comparativo, sello, INSERT), `listReportRuns`, `diffAgainstPrevious`, flags, `getDashboard`; **SQL de agregación por epígrafe y por bucket** | T3, T12 | 2 | 20 |
| **T14** | `forms/reports.ts` (zod, `reviewThresholdsSchema` con los 7 KPI por defecto) + `actions.ts` con la matriz de roles + `AuditEntity`/`AuditAction` | T13 | 1 | 10 |
| **T15** | `lib/export/{csv,xlsx,pdf}.ts` + route handler + tests (XLSX con números y notas al pie) | T13 | 1 | 18 |
| **T16** | UI `/reports/{balance,pyg,cashflow}`: selector de foto y variante, columnas de comparativo en `report-table`, marca `(−)`, notas al pie, tres pestañas de cashflow, botón Exportar | T14 | 1 | 20 |
| **T17** | UI `/reports/runs`, `/reports/runs/[id]` con diff y `comparativeRunId`; diálogos ADMIN de forzar/limpiar revisión; `/settings/reports` (umbrales y base comparativa) | T14 | 1 | 14 |
| **T18** | **Dashboard reescrito** + retirada de `models/stats.ts` y de los agregados de `lib/stats.ts`; recuento de documentos sin contabilizar; cierra **G-05/G-06** | T11, T14 | 1 | 14 |
| **T19** | **Migrar DIARIO/MAYOR/SUMAS_SALDOS/PYG_ANALITICA a `ReportRun`** (`resultKind = SUMMARY` en los tres primeros) | T13 | 1 | 12 |
| **T20** | **Pendientes de E4 aceptados**: matriz analítica por agregado SQL en `getAnalyticPnl`, índices O(1) en `resolveDestination`, `seedAnalyticsDefaults` con la `tx` del llamante | — | 1 | 10 |
| **T21** | Integración + RLS + e2e: `tests/integration/e6-reports.test.ts` (criterios 11–16, 21), `tests/integration-rls/e6-tenant.test.ts`, e2e Playwright (balance → foto → drill-down → export → histórico) | T16, T17, T18 | 1 | 16 |
| **T22** | Docs de cierre: `MODELO-DATOS.md` (ya actualizada en esta ronda; revisar tras implementar), skill `estados-financieros` (R-B1…R-B6, R-CF-*, buckets, cuatro fotos), skill `fiabilidad` (motivo `VARIACION`, I-E6-13), `ESTADO.md`, ROADMAP E6 → CERRADA, `runs/registro.jsonl`, ADR-0012 → APROBADO | T21 | 1 | 8 |

**Total: 301 h** (~38 jornadas; +13 h sobre la ronda 1: las cuatro fotos, la vista EFE oficial, el aging de siete tramos y las EV-* añaden trabajo, y el fixture entregado y el bucket ya sembrado quitan bastante). Camino crítico: T1/T2 → T3 → T5 → T6/T7/T8 → T9 → T12 → T13 → T14 → T16/T17/T18 → T21. T20 corre en paralelo desde el día 1. **El fixture ya no bloquea nada**: está entregado.

---

## 9. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | ~~El seed no trae `cashflowCategory`~~ → **cerrado**: `cashflow_bucket` sembrado (834/906) con `validate_cashflow()` en el generador | — |
| **R2** | ~~Epígrafes espejo sin fuente~~ → **cerrado**: tabla completa en §1.4 del experto y en `bidirectionalMirror`, con casos +/−/0 | — |
| **R3** | **Doble resta de contra-cuentas**: es el error que la ronda 1 tenía escrito y que cualquiera puede «re-arreglar» al leer `isContra` | Comentario explícito en `balance.ts` («no restar: R-B3»), I-E6-10 como check de signo y el criterio 5, que da 3 935 000 si alguien lo reintroduce |
| **R4** | **Doble conteo del resultado** (129 + I3) el día del cierre | R-B5 exclusiva, I-E6-11 (pre = post) y el criterio 3, que compara las dos fotos |
| **R5** | **`result` Json muy grande** en diario/mayor | D-E6-4 (`resultKind = SUMMARY`) + cota dura de 1 MB por run comprobada en el INSERT |
| **R6** | **Deriva entre el SQL de agregación y el motor puro** (la trampa que ADR-0011 corrigió en `ledgerHash`) | Test de integración que compara los dos caminos sobre `ejercicio-completo`, como el de `computeLedgerHash` vs `computeLedgerHashInMemory` |
| **R7** | **Distorsión O-4** (inmovilizado contra `4100`): el indirecto mete 1 815 000 en circulante en vez de en inversión | No se corrige en E6 (el fixture es inmutable y el asiento es el que es): **WARN de Auditoría** y `AccountKey.PROVEEDORES_INMOVILIZADO → 523` en **E8** |
| **R8** | **Aging sin `Counterparty`** | Declarado en pantalla; el drill-down a líneas es el sustituto honesto hasta E8 |
| **R9** | **Umbrales mal calibrados** → todo `REQUIERE REVISIÓN` y el sello deja de significar nada | Conjunción `pctBps` **y** `minAbsCents`, tabla del experto por KPI y EV-1…EV-6, que quitan de en medio las variaciones estructurales |

**Alternativas descartadas:**

- **Tablas de saldos mantenidas por la aplicación.** Doble verdad que ADR-0003 prohíbe: en cuanto un backfill o un contra-asiento no pasa por el camino previsto, el saldo diverge del diario y nadie lo nota.
- **Recalcular en cada render sin persistir `ReportRun`** (lo que hace E3 hoy, ya declarado provisional). Sin foto no hay P3/P7, ni histórico, ni «primer run tras cambio de motor», ni diff.
- **Desdoblar `ReportType` por foto y por variante** (`BALANCE_NORMAL_PRE`, …). La foto y la variante son **parámetros**: van en `params` y entran en `paramsHash`, que es exactamente para lo que existe (decisión §7.1 del experto).
- **Reparto proporcional del flujo de tesorería entre contrapartidas.** Innecesario (I1 ya garantiza la exactitud por línea) y produce cifras que no corresponden a ningún hecho y que no se pueden explicar al usuario ni pinchar en el drill-down.
- **Cashflow indirecto con partida de ajuste** («variaciones no clasificadas», que proponía la ronda 1). Con una partición exhaustiva la identidad `Σ bloques = Δ57x` es álgebra: la partida de cuadre sólo serviría para tapar un hueco de la partición.
- **`cashflowCategory` de tres valores como columna.** Demasiado grueso para el EFE (no distingue cobros de clientes de pagos a proveedores) y redundante: la categoría es función pura del bucket.
- **`indirectBlock` como columna del plan.** Una columna nullable admite huecos, y un hueco rompe I6 **en silencio**. Como función pura con test de exhaustividad, no puede haberlos (O-11).
- **Compensar `473` con `4752`** en el balance, como hacen muchos programas. Exigiría misma deuda, mismo impuesto e intención de liquidar por el neto (art. 37 CdC). El neto se presenta en la liquidación del IS, no en el balance.
- **`exceljs`.** ~1 MB y una superficie de parseo que no usamos: sólo escribimos celdas `inlineStr` y `n`. `jszip` ya está.

---

## 10. Validación contable: **CONFORME tras ronda 2**

`docs/design/E6-validacion-estados.md` (experto contable) → **CONFORME CON OBSERVACIONES**, con los **dos bloqueantes cerrados** (O-9 y O-10, mediante `cashflow_bucket` en el seed y el enum de 7 valores) y **47 checks en PASS** sobre `estados-esperados.json`. Estado de las catorce observaciones en este diseño:

| Obs. | Severidad | Dónde se resuelve |
|---|---|---|
| **O-1**, **O-3** desglose a/b de rectificativas | BAJA | §3.3: imputación al subepígrafe de la cuenta rectificada, con constancia en `provenance` |
| **O-2** epígrafe 19/18 sin cuentas mapeadas | BAJA | Se corrige en el **seed**, no en el renderizador. No bloquea E6 |
| **O-4 / O-13** inmovilizado contra `4100`, falta `PROVEEDORES_INMOVILIZADO` | MEDIA | **WARN de Auditoría en E6**; corrección en **E8** (§9 R7) |
| **O-5** `paramsHash` en la clave de caché | ALTA | §2.2: ya estaba en el `@@unique` de la ronda 1 y ahora es además exigencia contable; `params` obligatorios por tipo |
| **O-6** comparativo no auditable | MEDIA | §2.2: `comparativeRunId` + `comparativeBasis` |
| **O-7** `sealReason` texto libre | BAJA | §2.2 y §3.6: array de objetos con **código cerrado** |
| **O-8** sin moneda ni unidad | BAJA | §2.2: `params.currency` explícito |
| **O-9 / O-10** `cashflow_bucket` y enum de 7 | ALTA → cerradas | §2.2 y §2.3: columna en `LedgerAccount`, backfill, categoría derivada |
| **O-11** bloque del indirecto | MEDIA | §3.4: **función pura** con test de exhaustividad, nunca columna |
| **O-12** R-18 invertida | MEDIA | §2.3 punto 9: **R-18′**, «bucket obligatorio salvo 57x» |
| **O-14** `epigraphSortKey` | BAJA | No se añade: el orden se calcula en el renderizador (`segmentOrder`). Se anota para el día en que haga falta ordenar en SQL |

**Descartes razonados de propuestas del experto** (ninguno de fondo, dos de encaje):

1. **No se añade `epigraphSortKey` al plan de cuentas** (O-14). Sería una columna derivada de otra columna, con el riesgo de quedar desincronizada al editar un epígrafe, y hoy nada ordena en SQL: el árbol se construye en el motor puro, donde el orden ya tiene test. Se anota como deuda condicionada.
2. **La prevención de I-E6-13 (bloquear el posteo en 6/7 tras la regularización) no se implementa en E6, sino en E9.** El experto la sitúa en «E3/E8»; es una regla de **cierre**, toca el motor de posteo y el bloqueo de periodos, y meterla en E6 mezclaría el motor de informes con el de asientos. E6 aporta la **detección** (I-E6-13) y la **presentación** (las dos cifras y su diferencia), que es lo que le corresponde.
3. **El override de `476` y de los buckets por organización queda en E9**, como el propio experto propone (§7.2/§7.3): en v1 el mapa de buckets es de sistema.

Lo demás se incorpora **tal cual**, incluidos los cuatro puntos donde la ronda 1 estaba equivocada: la doble resta de `isContra`, el reparto proporcional del cashflow, la partida de cuadre del indirecto y la definición de EBITDA.

---

## 11. Revisión (ronda 1) — resoluciones

Revisión en contexto limpio: **CAMBIOS REQUERIDOS** · auditor **CONFORME en cifras** con cuatro hallazgos de fiabilidad · QA **PASS**. Todo resuelto sobre `HEAD` sin tocar el fixture ni las cifras selladas: los **47 checks** de `estados-esperados.json` siguen reproduciéndose byte a byte.

### Bloqueantes y obligatorios

| # | Hallazgo | Resolución |
|---|---|---|
| **1** | `test:integration` en rojo en paralelo: E6 agotaba el pool con transacciones largas | `getOrCreateReportRun` se parte en **tres transacciones cortas**: (1) clave y caché por agregados, (2) lectura con presupuesto explícito, (3) `INSERT`. **El cálculo ocurre fuera de la transacción** —el motor es puro y no necesita conexión—. Los tests que mutan pasan a una organización propia (`ORG_MUT`) y `maxConcurrency: 1` en la config. Verde **3 de 3** |
| **2** | EV-1/3/5/6 declarados y nunca alimentados | `lib/ledger/reports/threshold-context.ts` los **calcula sobre el diario**: `periodHasSystemEntries`, `structuralDeltaByKpi` (epígrafe del impuesto, **derivado** de la tabla de subtotales, no «20» a mano), `reversalNetByKpi` (sólo pares con original en el periodo) y `dimensionsAliveInBoth`. Test: el cierre con apertura, regularización e IS **no dispara** `VARIACION_KPI` |
| **3** | EV-10 sin fuente | `reclassifiedAccountsSince()` lee el `AuditLog` (`entity_id` es el **id**, se resuelve contra el plan) y exige que la cuenta tenga líneas en el periodo comparado. `regularizacionDesfasada` se alimenta cuando I-E6-13 sale FAIL. Tests de los dos |
| **4** | `params` mezclaba definición y contexto | `splitParams()`: `unpostedDocumentCount`, `method`, `granularity` y `view` **fuera** del hash. **`refDate` se queda dentro**, en contra de la lectura literal: no es contexto, define el aging, y sacarlo serviría de caché un aging calculado a otra fecha. El comparativo se busca por **tipo + periodo** filtrando foto y modelo, no por `paramsHash` — con el `refDate` dentro, el panel no encontraba nunca su comparativo |
| **5** | El plan y el mapa no estaban en la clave | `computePlanHash()` (código, epígrafes, `statement`, bucket, bidireccional, contra) y `computeAccountMapHash()`, por agregado SQL, dentro de `params` → dentro de `paramsHash`. **Sin migración**. Cambiar un epígrafe o el mapa emite run nuevo y sella `PLAN_CAMBIADO`; dos tests |
| **6** | El `result` del cashflow crecía con el diario | `resultKind = SUMMARY`: fuera `lineDetail` y los pares de provenance. Drill-down bajo demanda con `getCashflowBucketDetail(runId, bucket)`, que **comprueba el `ledgerHash`** antes de responder. Test con 6 200 líneas: `pg_column_size(result) < 1 MB` y las cifras cuadran |
| **7** | Se leía todo antes de mirar la caché | La fase 1 sólo calcula hashes por agregado y hace `findFirst`; un acierto de caché no materializa **ni una línea** |
| **8** | El diario podía servirse truncado en silencio | `readJournalHeaders()` cuenta en la base y pagina hasta `MAX_JOURNAL_ENTRIES_IN_RUN`; por encima, `result.truncado = true` y un WARN que sella `REQUIERE REVISIÓN` |
| **9** | `kpisOf(BALANCE)` devolvía `{tesoreria: 0}` | Devuelve la tesorería **real** de la foto (suma de 57x presentadas): un cero comparaba 0 contra 0 y no disparaba nunca |
| **10** | `thresholdsOf` casteaba | `parseReviewThresholds()` con zod y caída a los valores por defecto. El schema es **uno** y vive en el módulo puro; `forms/reports.ts` lo reexporta |

### Opcionales atendidos

**#11** PDF con fecha de creación fija → sha256 estable · **#12** los derivados del servidor se aplican **después** del spread del cliente, para que un `planHash` en la petición no pise el real · **#13** `canonicalJson` lanza ante `undefined` dentro de un array (en un objeto es «no está»; en un array es un hueco) · **#15** R-18′ también en el alta y en la importación (`checkCashflowBucketCoverage`) · **#16** `NON_TENANT_SCOPED_BY_ID`: el facade fuerza `where.id = organizationId` en `Organization` y lanza ante un id ajeno.

**#14 no se hace**: unificar los dos `ReportType` de cashflow exige recrear el tipo enum y reescribir las filas existentes, y la ganancia es cosmética. Lo que sí se ha hecho es sacar `method`/`granularity`/`view` del hash, que era el problema real: el run trae **siempre** las tres vistas, así que ya no se fragmenta la caché en tres runs idénticos. Queda anotado.

### Hallazgos del auditor

| ID | Hallazgo | Resolución |
|---|---|---|
| **A1** | Una manipulación «coherente» —cambiar `account_code` y recalcular el `entry_hash`— pasaba **todos** los invariantes | **I-E6-20**: si el `ledgerHash` del periodo cambia y no hay asiento posteado, anulado ni reclasificado que lo explique (`journal_entries.posted_at` + `AuditLog`), el check sale FAIL y el sello lleva `LEDGER_DRIFT`. Test de error inyectado con los triggers desactivados |
| **A3** | `params.variant` sin validar | `parseVariant()` lanza ante cualquier cosa que no sea `GENERAL`/`PYMES`. Antes, un `"NORMAL"` elegía la columna de epígrafe equivocada en silencio |
| **A4** | `run-invariants.ts` usaba el reloj | Sin `--ref-date`, la fecha se **deriva del ejercicio** (cierre del último, acotado a hoy): auditar 2026 desde 2028 hacía pasar I8 por suerte |
| **A-spec** | R-CF-7 no estaba en la skill | Añadida a `.claude/skills/estados-financieros/SKILL.md`, con R-CF-1/2/4/5/6/8 y el porqué: el EFE mide flujos **brutos** |

### Dos defectos que aparecieron al escribir los tests

1. **`registros_origen` del cashflow no reproducía su celda**: filtraba por código de cuenta y arrastraba el devengo de la nómina —que no toca el banco— al bucket de personal. Ahora va por pares `(entry_id, account_code)` cruzados con `unnest`, exacto también donde R-CF-7 mueve el IVA de bucket.
2. **`lastSameKey` se buscaba por `paramsHash`**: con el `planHash` dentro del hash, reclasificar una cuenta —el caso que EV-10 existe para cazar— dejaba el informe sin anterior con el que compararse. Se busca por tipo y periodo, filtrando foto y modelo.
