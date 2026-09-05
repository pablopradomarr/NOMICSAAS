# MODELO DE DATOS v1.0 (objetivo)

Convenciones: ids `uuid`; dinero `Int` céntimos (`BigInt` solo en agregados); fechas contables `@db.Date`; toda tabla de negocio con `organizationId` + uniques/índices compuestos; `createdAt/updatedAt`; nada de negocio se borra físicamente si tiene dependientes. **Nombres físicos en snake_case obligatorios**: `@@map("journal_lines")` y `@map("organization_id")` en toda tabla/campo nuevo (el SQL de RLS, triggers e informes usa snake_case). **Anulación = contra-asiento** (`reversesEntryId`); `voidedAt/voidedBy/voidReason` en `JournalEntry` son informativos y **ninguna query filtra por ellos** (el contra-asiento ya neutraliza el importe).

## Heredado de TaxHacker (se conserva, se añade `organizationId`)
`User`, `Session`, `Account` (auth; **conserva el nombre `Account` — la cuenta contable es `LedgerAccount`**), `Verification` (auth) · `Setting` (+ `version`, `updatedAt`) · `Category`, `Field`, `Currency`, `File` (+ `sha256`, − `cachedParseResult`), `Transaction` (+ `journalEntryId?`, `status: DRAFT|PROPOSED|POSTED|VOID`, `extractionRunId?`), `AppData`, `Progress`. `Project` heredado se sustituye por el `Project` analítico (migración: proyectos existentes → `Project` con LN `GENERAL`).

## Tenancy
```prisma
model Organization { id uuid; slug String @unique; name String; taxId String?; baseCurrency String "EUR"; timezone String "Europe/Madrid"; pgcVariant PgcVariant PYMES; ledgerEnabled Boolean true; analyticsRequired Boolean true; reviewThresholds Json?; plan String?; stripeCustomerId String?; createdAt }
model Membership { id; organizationId; userId; role Role; invitedBy?; acceptedAt?; @@unique([organizationId,userId]) }
enum Role { ADMIN EDITOR VIEWER }   enum PgcVariant { GENERAL PYMES }
```

## Plan de cuentas e impuestos
> Actualizado por **E2** (`docs/design/E2-plan-cuentas.md` ronda 2) tras la validación contable (`docs/design/E2-validacion-contable.md`). El modelo TypeScript se llama **`LedgerAccount`**, no `Account`: ese nombre lo ocupa better-auth y renombrarlo rompería el login (`prismaAdapter` resuelve los modelos por nombre). El nombre físico es `accounts`, que es lo que ven RLS, triggers e informes.

```prisma
model LedgerAccount { id; organizationId; code String @db.VarChar(12); name String; level Int; parentCode String?; nature Nature; statement Statement?; epigraph String?; epigraphPymes String?; bidirectional Boolean false; isContra Boolean false; analyticType AnalyticType?; cashflowBucket CashflowBucket?; isPostable Boolean true; isActive Boolean true; isSystem Boolean false; origin AccountOrigin MANUAL; createdAt; updatedAt
  @@unique([organizationId, code]) @@index([organizationId, parentCode]) @@index([organizationId, isActive, isPostable]) @@map("accounts") }
enum Nature { DEUDORA ACREEDORA }
enum Statement { BALANCE_ACTIVO BALANCE_PASIVO BALANCE_PN PYG ECPN }
enum AnalyticType { INGRESO_DIRECTO COSTE_DIRECTO_MC1 COSTE_DIRECTO_MC2 INDIRECTO_CECO AMORTIZACION_DETERIORO FINANCIERO EXTRAORDINARIO NO_ANALITICO }   // EXTRAORDINARIO sin uso en el seed: el PGC 2007 suprimió el resultado extraordinario
enum CashflowBucket { COBROS_CLIENTES PAGOS_PROVEEDORES PAGOS_PERSONAL PAGOS_IMPUESTOS OTROS_EXPLOTACION INVERSION FINANCIACION }   // E6, O-10
enum AccountOrigin { SEED MANUAL CSV_IMPORT }   // idempotencia del seed sin pisar ediciones del usuario
// `epigraph` = modelo normal · `epigraphPymes` = modelo abreviado/PYMES (numeración propia). Se guardan LAS DOS: cambiar de variante no obliga a reimportar. Selector único: epigraphFor(account, variant). La correspondencia NORMAL↔PYMES es una TABLA, no una regla: no se deriva por regex (E6 §1.3).
// `bidirectional` (7 cuentas: 551, 552, 5523–5525, 554, 555): saldo indistinto; statement/epigraph guardan la ruta DEUDORA y el balance reclasifica POR SIGNO al epígrafe espejo (R-B4, E6 §3.3), por cuenta postable y por su saldo neto a la fecha, nunca por línea y nunca compensando subcuentas (art. 37 CdC).
// `isContra` (165 cuentas: 28x, 29x, 39x, 49x, 59x, 406, 437, 606/608/609, 706/708/709): **NO interviene en el cálculo** (R-B3, E6). Con la regla de signo (activo +saldo / pasivo y PN −saldo) la contra-cuenta ya resta sola; restarla además la restaría dos veces. Es (a) presentación —marca `(−)`— y (b) check de signo (I-E6-10).
// `cashflowBucket`: bucket de la CONTRAPARTIDA de un movimiento de tesorería (columna `cashflow_bucket` del seed, 834 de 906 filas; `null` sólo en 57x, en los contenedores mixtos `4`/`5` y en los grupos 8/9). La categoría OPERATING/INVESTING/FINANCING **se deriva** con `cashflowCategoryOf(bucket)` y NO se almacena. Sustituye a la columna `cashflowCategory` de E2 (E6, O-9/O-10/O-12). Regla de validación **R-18′**: bucket obligatorio en toda cuenta postable salvo 57x.
model OrganizationAccountMap { id; organizationId; key AccountKey; accountCode String; @@unique([organizationId,key]) @@map("organization_account_maps") }
enum AccountKey {  // 57 claves. Las 43 primeras son de mapeo OBLIGATORIO (E3/E8); las 14 últimas se declaran ahora y las mapea su épica.
  CLIENTES PROVEEDORES ACREEDORES BANCO_DEFAULT CAJA IVA_SOPORTADO IVA_REPERCUTIDO IRPF_RETENIDO_CLIENTES IRPF_A_PAGAR
  HP_ACREEDORA_IVA HP_DEUDORA_IVA SS_ACREEDORA REMUNERACIONES_PENDIENTES RESULTADO_EJERCICIO VENTAS_DEFAULT COMPRAS_DEFAULT
  SUBCONTRATACION_DEFAULT ANTICIPOS_PROVEEDORES ANTICIPOS_CLIENTES DESCUENTO_PP_VENTAS DESCUENTO_PP_COMPRAS
  DEVOLUCION_VENTAS DEVOLUCION_COMPRAS RAPPEL_VENTAS RAPPEL_COMPRAS REDONDEO_GASTO REDONDEO_INGRESO
  IRPF_PROFESIONALES_A_PAGAR IRPF_ALQUILERES_A_PAGAR IRPF_TRABAJO_A_PAGAR IVA_SOPORTADO_ISP IVA_REPERCUTIDO_ISP
  AJUSTE_IVA_NEGATIVO AJUSTE_IVA_POSITIVO IMPUESTO_BENEFICIOS_GASTO HP_ACREEDORA_IS HP_DEUDORA_IS
  ACTIVO_IMPUESTO_DIFERIDO PASIVO_IMPUESTO_DIFERIDO PERIODIFICACION_GASTO PERIODIFICACION_INGRESO
  DIFERENCIA_CAMBIO_NEGATIVA DIFERENCIA_CAMBIO_POSITIVA
  RETENCIONES_CAPITAL_SOPORTADAS SS_DEUDORA ANTICIPOS_REMUNERACIONES SUELDOS_DEFAULT SS_EMPRESA_DEFAULT
  CLIENTES_DUDOSO_COBRO DETERIORO_CLIENTES DOTACION_DETERIORO_CREDITOS REVERSION_DETERIORO_CREDITOS
  PERDIDA_CREDITOS_INCOBRABLES CUENTA_PUENTE_TESORERIA COMISIONES_BANCARIAS REMANENTE RESULTADOS_NEGATIVOS_ANTERIORES }
// Defaults del seed: CLIENTES 430 · PROVEEDORES 400 · ACREEDORES 410 · BANCO_DEFAULT 572 · CAJA 570 · IVA_SOPORTADO 472 · IVA_REPERCUTIDO 477 · IRPF_RETENIDO_CLIENTES 473 · IRPF_A_PAGAR 4751 · HP_ACREEDORA_IVA 4750 · HP_DEUDORA_IVA 4700 · SS_ACREEDORA 476 · REMUNERACIONES_PENDIENTES 465 · RESULTADO_EJERCICIO 129 · VENTAS_DEFAULT 705 · COMPRAS_DEFAULT 600 · SUBCONTRATACION_DEFAULT 607 · ANTICIPOS_PROVEEDORES 407 · ANTICIPOS_CLIENTES 438 · 706/606/708/608/709/609 · REDONDEO 669/769 · IRPF 47510/47511/47512 · AJUSTE_IVA 634/639 · IS 630/4752/4709 · impuesto diferido 4740/479 · periodificación 480/485 · diferencias de cambio 668/768.
// `importNpgc(opts.useSubaccounts = true)` (default) crea 5720/4300/4000/4100 y 47510/47511/47512, deja los padres no postables y mapea SIEMPRE a la hoja (I-plan-1).
// `opts.createSoftwareAccounts = false` (default): 4720/4730/4760/4770 solo bajo demanda o al activar ISP/intracomunitarias, y siempre como SUBCUENTAS de 472/473/476/477.
model TaxRate { id; organizationId; code String; name String; kind TaxKind; rateBps Int; appliesTo TaxAppliesTo BOTH; accountCode String; counterAccountCode String?; linkedTaxRateId String?; validFrom Date; validTo Date?; isActive Boolean true; isSystem Boolean false; @@unique([organizationId,code,validFrom]) @@map("tax_rates") }
enum TaxKind { IVA IRPF RECARGO EXENTO }
enum TaxAppliesTo { SALE PURCHASE BOTH }
// `rateBps` (puntos básicos), NO `ratePermille`: el recargo de labores del tabaco es 1,75 % = 175 bps y no es entero en tanto por mil.
// UNA fila por tipo impositivo: `accountCode` = lado venta (477 / 4751), `counterAccountCode` = lado compra (472 / 473). La dirección la fija el asiento tipo. Con inversión del sujeto pasivo se usan LAS DOS en el mismo asiento.
// `linkedTaxRateId`: un RECARGO apunta al IVA que acompaña (5,2↔21 · 1,4↔10 · 0,5↔4 · 1,75↔tabaco). Tributo distinto, versionable por separado.
// `validFrom` SIEMPRE explícita (2025-01-01 en los tipos de IVA sembrados): un asiento de 2024 no puede coger el tipo de 2026. No se siembra ningún tipo derogado; IGIC/IPSI se cargan por organización desde el editor.
// Restricciones SQL: CHECK rate_bps 0..10000 · CHECK kind='EXENTO' ⇒ rate_bps=0 · CHECK valid_to >= valid_from · EXCLUDE USING gist (organization_id, code, daterange(valid_from, valid_to, '[]')) contra solapes de vigencia.
```
Política fiscal por organización (la consume el motor en E3, reglas R-IVA-1…R-IVA-8): `Organization.prorrataBps Int?` (**renombrado desde `prorrataPermille` en E3, O-7**: puntos básicos, la misma escala que `TaxRate.rateBps`), `Organization.taxRoundingMode TaxRoundingMode` (`PER_TIPO` por defecto: una cuota por tipo impositivo) y `Organization.redondeoToleranciaCents Int` (default 1; por encima, el asiento se bloquea). `Organization.pgcVariant` es **inmutable** en cuanto existe un asiento posteado.

Seed `seeds/npgc.csv` (13 columnas: `codigo,nombre,nivel,padre,grupo,naturaleza,estado_financiero,epigrafe,tipo_analitico,bidireccional,is_contra,pymes,epigrafe_pymes`): 906 filas · **794** en PGC PYMES (`pymes = 1`; el criterio contable —reglas P-01…P-13— vive en `build_npgc.py`, no en TypeScript) · 165 contra-cuentas · 7 bidireccionales.

## Ejercicios y diario
> Actualizado por **E3** (`docs/design/E3-libro-diario.md` ronda 2) tras la validación contable (`docs/design/E3-asientos-tipo.md`, veredicto CONFORME CON OBSERVACIONES). Las observaciones O-1, O-2, O-4 y O-7 se incorporan aquí; O-3 (`templateVersion`) → E8, O-5 (extremos de OPENING/CLOSING) → E9, O-6 (divisa en la línea) → E8, O-8 (`isForecast`) → E10, O-9 (`INVOICE_IN`) → E8.

```prisma
model FiscalYear { id; organizationId; code String; startDate Date; endDate Date; status FyStatus OPEN; lastEntryNumber Int 0; closedAt?; closedById?; @@unique([organizationId,code]) @@map("fiscal_years") }
enum FyStatus { OPEN CLOSED }
model PeriodLock { id; organizationId; fiscalYearId; month Int; lockedAt; lockedById?; reason?; @@unique([organizationId,fiscalYearId,month]) @@map("period_locks") }
model JournalEntry { id; organizationId; fiscalYearId; entryNumber Int
  documentDate Date?; accrualDate Date?; entryDate Date   // TRES fechas, ver abajo
  description String; kind EntryKind;  // PyG excluye kind ∈ {REGULARIZATION, CLOSING, OPENING}
  taxRoundingMode TaxRoundingMode      // SELLADO en el asiento (R-IVA-4): la política de la organización es mutable
  sourceType SourceType; sourceId String?; transactionId?; fileId?; extractionRunId?; templateCode String?
  reversesEntryId?; voidedAt?; voidedById?; voidReason?; postedById; postedAt; entryHash String
  lines JournalLine[]
  @@unique([organizationId,fiscalYearId,entryNumber])
  @@unique([organizationId,id,entryDate,fiscalYearId,kind])   // destino de la FK de denormalización
  @@index([organizationId,entryDate]) @@map("journal_entries") }
enum EntryKind { NORMAL OPENING CLOSING REGULARIZATION REVERSAL RECURRING }
enum SourceType { MANUAL DOCUMENT INVOICE_OUT BANK_IMPORT CSV_IMPORT RECURRING SYSTEM }
model JournalLine { id; organizationId; entryId; lineNo Int; accountCode String; debitCents Int; creditCents Int; description String?
  projectId?; costCenterId?; businessLineId?; analyticType AnalyticType?   // los tres ids: nullable y SIN FK hasta E4
  taxRateId?; taxBaseCents Int?; counterpartyId?; dueDate Date?            // dueDate: UNA línea 43x/40x por vencimiento
  entryDate Date; fiscalYearId; entryKind EntryKind                        // denormalizado, impuesto por FK compuesta
  @@unique([entryId,lineNo])
  @@index([organizationId,entryDate]) @@index([organizationId,accountCode,entryDate])
  @@index([organizationId,projectId]) @@index([organizationId,costCenterId]) @@map("journal_lines") }
```
Política fiscal: `Organization.prorrataBps Int?` — **puntos básicos, no por mil** (O-7: `TaxRate.rateBps` ya está en bps y `applyBps(cuota, prorrataBps)` no puede mezclar escalas). La cuota **no deducible incrementa el precio de adquisición** de la línea de gasto/inmovilizado (art. 103 LIVA, NRV 2ª y 10ª); se aplica desde E3. La regularización anual de prorrata y la de bienes de inversión (arts. 105–110 LIVA) van contra 634/639 en E9.

**Las tres fechas.** `documentDate` = expedición del documento; **selecciona el `TaxRate` vigente** (un documento de 2025 contabilizado en 2026 lleva el tipo de 2025). `accrualDate` = devengo (NRV 14ª), default `documentDate`. `entryDate` = fecha contable, la **única** que manda en ejercicio, mes de bloqueo, informes y `ledgerHash`; la fija `resolveEntryDate`, no el usuario: si el mes del devengo está bloqueado → primer día del primer mes abierto ≥ devengo (con la coletilla obligatoria `[devengo YYYY-MM-DD]` en la descripción); si su ejercicio está `CLOSED` → no se postea ahí, se usa T-22 en el ejercicio abierto; futura respecto de `refDate` → error.

**Numeración (N-1…N-7).** `entryNumber` entero ≥ 1, correlativo por `(organizationId, fiscalYearId)`, sin huecos: `SELECT … FOR UPDATE` sobre `fiscal_years` → `+1` → `INSERT`, todo en la misma transacción. Nunca una secuencia de Postgres: deja huecos al hacer rollback. Un asiento que falla validación no consume número; un número no se reutiliza ni se reasigna. Con fecha retroactiva **no se renumera**: el diario se presenta ordenado por `(entryDate, entryNumber)` y la Auditoría lista los fuera de secuencia como Info. `OPENING` es el nº 1 del ejercicio y `CLOSING` el último.

**Bloqueo de periodos (B-1…B-5).** Bloqueo **secuencial** (no se bloquea el mes *n* con *n−1* abierto); desbloquear *n* arrastra *n+1…12*; solo ADMIN, con motivo, a `AuditLog`, y solo con el ejercicio `OPEN`. Cerrar el ejercicio exige los 12 meses bloqueados, regularización y cierre posteados e invariantes en PASS. **`FyStatus = CLOSED` no es reversible**: reabrir equivale a reformular cuentas ya rendidas (arts. 253, 272, 279 LSC).

**Anulación.** Solo contra-asiento (`reversesEntryId`), espejo exacto que copia e invierte columnas sin recalcular nada. Fecha: la del original si su mes sigue abierto; si no, primer día del primer mes abierto ≥ esa fecha. Un `REVERSAL` **no se anula con otro `REVERSAL`** y hay **como máximo uno** por asiento anulado. `voidedAt/voidedBy/voidReason` son informativos y **ninguna query filtra por ellos**.

**Ejercicio cerrado.** Documento cuyo devengo cae en un ejercicio `CLOSED`: asiento en el ejercicio abierto contra **113/121** si el error es material o hay cambio de criterio (NRV 22ª), o **678/778** si no es significativo (epígrafe 13, dentro del resultado de explotación). Las cuentas **679/779 no existen** en el PGC 2007 y no están en `seeds/npgc.csv`.

Constraints SQL: `CHECK(debit>=0 AND credit>=0 AND (debit=0)<>(credit=0))`; FK compuesta `(organization_id, account_code)`; FK compuesta de denormalización `(organization_id, entry_id, entry_date, fiscal_year_id, entry_kind)`; constraint trigger diferido con Σdebe=Σhaber, **≥ 2 líneas y ≥ 1 a cada lado**; trigger de periodo (ejercicio OPEN + mes no bloqueado); trigger de cuenta postable y activa; índice único parcial de anulación; trigger anti contra-contra-asiento; `EXCLUDE` de solape de ejercicios; RLS estricta con `FORCE`; sin DELETE y sin UPDATE salvo las tres columnas de anulación (GRANT de columna).

**Asientos tipo:** las 28 plantillas (T-01…T-28), su aritmética, sus 13 comprobaciones comunes (C-1…C-13) y los invariantes propios I-E3-1…7 están en `docs/design/E3-asientos-tipo.md`. Fixtures inmutables verificados: `tests/fixtures/ejercicio-{minimo,completo}.json`, generados por `docs/design/fixtures/build_ejercicio_completo.py` (84 asientos, 326 líneas, 28/28 plantillas).

## Analítica
> Actualizado por **E4** (`docs/design/E4-analitica.md` ronda 2) tras la validación contable (`docs/design/E4-validacion-analitica.md`, **CONFORME CON OBSERVACIONES**). Se incorporan O-A1 (FK compuestas), O-A2 (CHECK de exclusividad y de «sin dimensión fuera de 6/7»), O-A3 (`analyticsHash`), O-A4 (`GRANT UPDATE` acotado), O-A5 (**`@@map`/`@map` en todo el bloque, que faltaba en los 14 modelos**), O-A7 (`MarginLevelConfig` versionada) y O-A8 (`closedAt`, `origin`, `isSystem`). O-A6 (uniques parciales de `Budget`) queda **anotada como deuda** para E5/E7. Reglas de destino R-A1…R-A12 e invariantes I-E4-1…12: en el documento de validación.

```prisma
model BusinessLine { id; organizationId @map("organization_id"); code; name; color; sortOrder @map("sort_order"); isActive @map("is_active"); archivedAt? @map("archived_at"); isSystem @map("is_system"); createdAt; updatedAt
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@map("business_lines") }
// `Project` NO es una tabla nueva: es el heredado de TaxHacker (`projects`, ya bajo RLS
// desde E1), al que E4 añade columnas. Así sobreviven la FK `Transaction.projectCode` y
// toda la UI heredada (D-E4-1). `color` y `llm_prompt` se conservan: E8 los usa.
model Project { id; organizationId; code; name; color; llm_prompt?; businessLineId @map("business_line_id"); counterpartyId? @map("counterparty_id"); status ProjectStatus ACTIVE; startDate? @db.Date; endDate? @db.Date; closedAt? @db.Date; closedById?; budgetRevenueCents?; budgetCostCents?; sortOrder; isActive; archivedAt?; createdAt; updatedAt
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@map("projects") }
enum ProjectStatus { PLANNED ACTIVE CLOSED }   @@map("project_status")
model CostCenter { id; organizationId; code; name; kind CostCenterKind; marginLevel MarginLevel @map("margin_level"); allocatable Boolean true; sortOrder; isActive; archivedAt?; origin AccountOrigin MANUAL; isSystem Boolean false; createdAt; updatedAt
  @@unique([organizationId,code]) @@unique([organizationId,id]) @@map("cost_centers") }
enum CostCenterKind { MARKETING_VENTAS OPERACIONES_INDIRECTAS G_A DESARROLLO_PRODUCTO FINANCIERO EXTRAORDINARIO OTROS SIN_ASIGNAR }   @@map("cost_center_kind")
enum MarginLevel { INGRESOS MC1 MC2 MC3 EBITDA EBIT BAI RESULTADO }   @@map("margin_level")  // CostCenter.marginLevel ∈ {MC3, EBITDA} (CHECK)
// O-A7: versionada Y hasheada. `validFrom/validTo` conservan el histórico (un ejercicio
// cerrado reimprime con SU configuración, elegida por la fecha del periodo del informe);
// el hash, dentro de `analyticsHash`, impide servir un informe cacheado con otra.
// MLC-2: MC3 y EBITDA van SIEMPRE con `analyticTypes = []` — `INDIRECTO_CECO` se rutea por
// `CostCenter.marginLevel` (R-A7); listarlo contaría el importe dos veces.
model MarginLevelConfig { id; organizationId; level MarginLevel; label; analyticTypes AnalyticType[] @map("analytic_types"); sortOrder @map("sort_order"); isVisible @map("is_visible"); validFrom Date @map("valid_from"); validTo? Date @map("valid_to"); updatedAt
  @@unique([organizationId,level,validFrom]) @@map("margin_level_configs") }
model AllocationRule { id; organizationId; code; name; sourceCostCenterId; targetKind TargetKind; driver Driver; period AllocPeriod; priority Int; targetFilter Json?; validFrom Date; validTo Date?; isActive; targets AllocationRuleTarget[] @@map("allocation_rules") }
model AllocationRuleTarget { id; ruleId; projectId?; businessLineId?; costCenterId?; percentPermille Int? @@map("allocation_rule_targets") }
enum TargetKind { PROJECTS BUSINESS_LINES COST_CENTERS MIXED }  enum Driver { FIXED_PERCENT REVENUE_SHARE DIRECT_COST_SHARE HOURS HEADCOUNT EQUAL MANUAL }  enum AllocPeriod { MONTH QUARTER YEAR }
model AllocationRun { id; organizationId; periodStart Date; periodEnd Date; ledgerHash String; analyticsHash String; rulesHash String; gitSha String; runBy; runAt; supersededById?; reversedAt?; lines AllocationLine[] @@map("allocation_runs") }
model AllocationLine { id; runId; ruleId; sourceCostCenterId; targetProjectId?; targetBusinessLineId?; targetCostCenterId?; amountCents Int; driverBase Int; driverSharePermille Int @@map("allocation_lines") }
model Budget { id; organizationId; year Int; month Int; projectId?; costCenterId?; accountCode?; amountCents Int; @@unique([organizationId,year,month,projectId,costCenterId,accountCode]) @@map("budgets") }
// DEUDA O-A6 (E5/E7): ese `@@unique` con TRES columnas nullables NO impide duplicados —
// en PostgreSQL NULL <> NULL. Sustituir por índices únicos parciales por combinación (o
// `NULLS NOT DISTINCT`, PG 15+) y añadir CHECK `(project_id IS NULL) <> (cost_center_id IS NULL)`.
model TimeEntry { id; organizationId; userId; projectId; date Date; minutes Int; note? @@map("time_entries") }
model EmployeeRate { id; organizationId; userId; hourlyCostCents Int; validFrom; validTo? @@map("employee_rates") }
model Counterparty { id; organizationId; kind CounterpartyKind; name; taxId?; accountCode?; defaultTaxRateId?; email?; @@unique([organizationId,taxId]) @@map("counterparties") }  // clientes/proveedores
// `Organization.nonAnalyticLevel MarginLevel EBITDA` (CHECK ∈ {EBITDA, EBIT, BAI}): R-A11 —
// `630`/`633`/`638` van SIEMPRE a RESULTADO (fijo); el resto de NO_ANALITICO (73x/74x/75x,
// que son resultado de explotación) cae en este nivel. Nunca por encima de MC3.
```

**Dimensiones en la línea (E4).** `JournalLine.projectId/costCenterId/businessLineId` pierden el `CHECK` `journal_lines_analytics_e4` de E3 y ganan **FK compuestas por tenant** `(organization_id, project_id) → projects(organization_id, id)` y equivalentes para CECO y LN (O-A1, I-E4-7). Tres CHECK nuevos (O-A2): `project_id IS NULL OR cost_center_id IS NULL` (exclusividad, I-E4-2), `business_line_id IS NULL OR project_id IS NOT NULL`, y `left(account_code,1) IN ('6','7') OR (las cuatro columnas analíticas IS NULL)` (R-A1, I-E4-5). `analytic_type` almacena el **tipo efectivo** ya resuelto al postear (R-A2, con los override implícitos R-A3 `INDIRECTO_CECO + projectId ⇒ COSTE_DIRECTO_MC2` y R-A4 `directo + costCenterId ⇒ INDIRECTO_CECO`): la matriz lee, no decide. `business_line_id` lo copia el motor del proyecto **en el alta** y un trigger lo verifica (R-A9); nunca se recalcula, así que mover un proyecto de línea de negocio no altera informes ya emitidos.

**Tres sellos (E4-D2, ADR-0010).** `ledgerHash` **financiero v2 EXCLUYE** las cuatro columnas analíticas — si las incluyera, reimputar un gasto invalidaría balance, PyG, cashflow y diario ya sellados, que no cambian en un céntimo (P3/P7). `entryHash` sí las incluye y **se recalcula** al reclasificar, con lo que I-E3-7 sigue en PASS. `analyticsHash` (nuevo) = dimensiones + `marginConfigHash` + `allocationRunId`, y es el único que caduca informes, y solo los analíticos. `JournalEntry.hashVersion Int @default(2)`; la migración de E4 recalcula el histórico (viable solo por la ausencia de datos en producción) y v2 no se vuelve a tocar. `ReportRun.analyticsHash String?`, obligatorio por CHECK para `PYG_ANALITICA`/`PRESUPUESTO_REAL`/`DASHBOARD`, con clave de reutilización `(organizationId, type, ledgerHash, analyticsHash)`.

**Reclasificación analítica (ADR-0010, PROPUESTO).** `journal_lines` deja de ser estrictamente append-only: `GRANT UPDATE ("project_id","cost_center_id","business_line_id","analytic_type") ON journal_lines TO app_runtime` — **y nada más** — más `GRANT UPDATE ("entry_hash") ON journal_entries`, con trigger `journal_lines_only_analytics_update` que lanza si cambia cualquier otra columna (el propietario esquiva los GRANT, el trigger no) y trigger de ventana que prohíbe el `UPDATE` con el ejercicio `CLOSED`. Mes bloqueado: solo ADMIN con motivo. `AuditLog(entity="JournalLine", action="RECLASSIFY_ANALYTICS")` con `before`/`after` de las cuatro columnas y de ambos hashes, en la misma transacción.

**Semilla por organización.** Ocho CECOs (`CC-OPS` MC3 · `CC-DEV` MC3 · `CC-MKT` EBITDA · `CC-GA` EBITDA · `CC-FIN` no imputable · `CC-EXT` no imputable · `CC-OTR` · `CC-NA` `SIN_ASIGNAR`, de sistema y no imputable) y las ocho filas de `MarginLevelConfig`. Con `analyticsRequired = false`, una línea 6/7 sin destino se rutea a `CC-NA` y la Auditoría la marca WARN (R-A8); nunca queda a NULL.

## Extracción, FX, informes, auditoría
> `ReportRun` y `ManualReviewFlag` actualizados por **E6** (`docs/design/E6-informes.md` ronda 2) tras la validación contable (`docs/design/E6-validacion-estados.md`, **CONFORME CON OBSERVACIONES**; cifras selladas en `docs/design/fixtures/estados-esperados.json`, 47 checks). Se incorporan O-5 (`paramsHash` en la clave de reutilización), O-6 (`comparativeRunId`/`comparativeBasis`), O-7 (`sealReasons` con código), O-8 (`params.currency`), O-9/O-10/O-12 (`cashflowBucket` en `LedgerAccount`, categoría derivada, R-18′) y O-11 (el bloque del cashflow indirecto es función pura, **no** columna). O-13 (`AccountKey.PROVEEDORES_INMOVILIZADO → 523`) y O-4 quedan para **E8**; O-14 (`epigraphSortKey`) anotada y descartada por ahora.

```prisma
model ExtractionRun { id; organizationId; fileId; provider String; model String; promptSha String; schemaVersion String; pagesSent Int; pagesTotal Int; partial Boolean; rawOutput Json; proposal Json?; reconcile Json?; tokensIn?; tokensOut?; durationMs; createdBy; createdAt }   // inmutable
model PromptVersion { id; organizationId?; code String; version Int; content String; sha256 String; createdBy; createdAt; @@unique([organizationId,code,version]) }
model ExchangeRate { id; date Date; from String; to String; rateMicro BigInt; source String; fetchedAt; @@unique([date,from,to,source]) }
model ReportRun { id; organizationId; type ReportType; periodStart Date; periodEnd Date; fiscalYearId?
  params Json; paramsHash String @db.Char(64)                    // O-5: la FOTO y la VARIANTE son parámetros, no tipos
  ledgerHash String; analyticsHash?; marginConfigHash?; allocationRunId?; analyticsKey String "∅"   // trigger; NULL<>NULL (O-A6)
  gitSha String; result Json; resultKind ResultKind FULL; provenance Json; validation Json
  seal Seal; sealReasons Json []                                  // O-7: [{code, kind, message, invariantId?, kpi?, deltaBps?}]
  comparativeRunId?; comparativeBasis ComparativeBasis?           // O-6: contra qué se midió la variación
  durationMs Int; createdById?; createdAt
  @@unique([organizationId,type,periodStart,periodEnd,paramsHash,ledgerHash,analyticsKey,gitSha])
  @@index([organizationId,type,periodStart,periodEnd,createdAt(desc)]) @@index([organizationId,type,ledgerHash]) @@map("report_runs") }
enum ReportType { DIARIO MAYOR SUMAS_SALDOS BALANCE PYG PYG_ANALITICA CASHFLOW_DIRECTO CASHFLOW_INDIRECTO PRESUPUESTO_REAL DASHBOARD }
enum Seal { VALIDADO_AUTOMATICAMENTE REQUIERE_REVISION }   enum ResultKind { FULL SUMMARY }   enum ComparativeBasis { SAME_PERIOD_PREVIOUS_YEAR PREVIOUS_FISCAL_YEAR_CLOSE PREVIOUS_PERIOD NONE }
// **Append-only en RLS** como `audit_logs` (RESTRICTIVE … USING(false) en UPDATE y DELETE + REVOKE): un informe emitido no se corrige, se emite otro.
// `params` OBLIGATORIOS por tipo: BALANCE {snapshot: PRE_REGULARIZACION|POST_REGULARIZACION|POST_CIERRE, variant, currency, comparative} · PYG {variant, currency, comparative} · CASHFLOW {method, granularity, view, currency} · DASHBOARD {refDate, agingBuckets, currency}. `gitSha` va DENTRO de la clave: si no, tras un cambio de motor se serviría la caché vieja y el motivo «primer run tras cambio» no se emitiría nunca.
// `resultKind = SUMMARY` en DIARIO/MAYOR/SUMAS_SALDOS (D-E6-4): el resultado guarda el resumen y la consulta, no cientos de miles de filas.
model BankStatementLine { id; organizationId; accountCode; date Date; amountCents Int; description; reference?; sha256; matchedLineId?; importedAt }
model AuditLog { id; organizationId; userId?; entity String; entityId String; action String; before Json?; after Json?; reason String?; ts; @@index([organizationId,ts]) @@index([organizationId,entity,entityId,ts]) @@map("audit_logs") }   // E2: append-only también en RLS (FOR UPDATE/DELETE USING(false)); se escribe en la MISMA transacción que la mutación
model ManualReviewFlag { id; organizationId; periodStart Date; periodEnd Date; scope ReportType?; reason; createdById; createdAt; clearedAt?; clearedById?; clearReason?; @@index([organizationId,periodStart,periodEnd]) @@map("manual_review_flags") }
// E6: ADMIN fuerza `REQUIERE REVISIÓN` sobre todos los informes que solapen el periodo (`scope` null = todos). Semi-append-only: sin DELETE, y `UPDATE` sólo de las tres columnas de limpieza (GRANT de columna + trigger, patrón ADR-0010). Único flag activo por (org, periodo, scope) con dos índices únicos PARCIALES (`WHERE cleared_at IS NULL`), porque NULL<>NULL.
// `Organization.reviewThresholds` (E1, sin uso hasta E6): {version:1, comparativeBasis, kpis:{ingresos, ebitda, resultado, tesoreria, deuda, dso, margenBruto → {pctBps, minAbsCents, minPointsBps}}}. Dispara revisión si |Δ%| > pctBps **Y** |Δ| > minAbsCents. Base por defecto SAME_PERIOD_PREVIOUS_YEAR. Variaciones explicables EV-1…EV-6 (no disparan) y EV-7…EV-10 (disparan siempre): E6 §2.4.
model InvoiceSeries { id; organizationId; code; prefix; nextNumber Int; year Int?; lastHash String?; @@unique([organizationId,code,year]) }
```

## Integridad (resumen)
| Regla | Dónde |
|---|---|
| Σdebe = Σhaber por asiento | código + constraint trigger diferido |
| Cuenta postable, activa, de la misma org | código + FK compuesta `(organization_id, account_code) → accounts(organization_id, code)` (creada en E2) |
| Mapa de sistema resoluble (I-plan-1): toda `AccountKey` obligatoria → cuenta existente, activa y postable | `validateAccountMap` + revalidación al sembrar + check de Auditoría |
| `statement` de cuenta oficial de nivel ≤ 3: inmutable; `epigraph`: ADMIN + motivo + `AuditLog`, prohibido con líneas en ejercicio `CLOSED` | código (R-10a/R-10b) |
| Fecha en ejercicio OPEN y mes no bloqueado | código + trigger |
| Numeración sin huecos | `FOR UPDATE` sobre `fiscal_years` (N-1…N-4); orden por fecha (N-5) es presentación, no restricción |
| Asiento con ≥ 2 líneas y ≥ 1 a cada lado | constraint trigger diferido |
| Denormalización de `entryDate`/`fiscalYearId`/`entryKind` coherente con el asiento | FK compuesta contra `@@unique([organizationId,id,entryDate,fiscalYearId,kind])` |
| Un solo contra-asiento por asiento, y nunca de un `REVERSAL` | índice único parcial + trigger |
| Método de redondeo y fechas del documento reproducibles | `taxRoundingMode`, `documentDate`, `accrualDate` sellados en el asiento |
| 6/7 con destino analítico si `analyticsRequired` (C-9, R-A8); exclusividad proyecto/CECO; sin dimensión fuera de 6/7 ni en `NO_ANALITICO` | código (E4) **+ CHECK + FK compuestas `(organization_id, project_id\|cost_center_id\|business_line_id)`** |
| `business_line_id` de la línea = el del proyecto en el alta (R-A9, I-E4-3) | código + trigger `journal_lines_business_line_denorm` (verifica, nunca rellena: rompería `entry_hash`) |
| Σ matriz analítica = PyG contable (I4) por nivel y en `RESULTADO`, tolerancia 0 | `lib/analytics/margins.ts` + test byte a byte contra `docs/design/fixtures/pyg-analitica-esperada.json` |
| Línea posteada: solo mutan las cuatro columnas analíticas, con motivo y `AuditLog` | `GRANT` de columna + triggers `journal_lines_only_analytics_update` y `..._reclassify_window` (ADR-0010) |
| Nada se borra: asientos, líneas, cuentas con movimientos, runs | RLS `FOR DELETE USING(false)` + código |
| `Activo = Pasivo + PN` con el resultado leído de 129 **o** inyectado (I3), nunca las dos cosas (I2, R-B5) | `lib/ledger/reports/balance.ts` + I-E6-11 y I-E6-13 |
| `cashflowBucket` en toda cuenta postable salvo 57x (R-18′); todo asiento con línea 57x reparte por línea y cuadra con Δ57x (I6) | `validate_cashflow()` en el generador del seed + `lib/ledger/reports/cashflow.ts` + test de exhaustividad sobre las 906 cuentas |
| `report_runs` inmutable; un informe no se corrige, se emite otro | RLS append-only (`USING(false)` en UPDATE/DELETE) + `REVOKE` + I-E6-16 |
| Anulación solo por contra-asiento; sin flag que excluya líneas de informes | código + ausencia de columna `voided` en líneas |
| Tenant | `tenantDb` + RLS |
