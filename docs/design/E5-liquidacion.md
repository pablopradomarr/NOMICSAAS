# E5 — Liquidación de CECOs: reglas versionadas, drivers, cascada, Hamilton y PyG analítica imputada

> Rol: `arquitecto`. Nivel **2**. Fuentes: `CLAUDE.md` (§Estándar de calidad) · `docs/ROADMAP.md` (E5) · `docs/MODELO-DATOS.md` §Analítica · **ADR-0004, 0010, 0011, 0012 (APROBADOS)** · **ADR-0013 (nuevo, APROBADO)** · `docs/design/E5-validacion-liquidacion.md` (experto contable: drivers, cascada, periodos, **I5** e **I-E5-1…12**, **E5-D1/D2/D3**, observaciones **O-E5-1…10**, fixture `liquidacion-esperada.json` + generador) · `docs/design/E4-analitica.md` (§2.5 sellos, §3.2 firmas, §7 provenance, §2.6 reclasificación) · skills `contabilidad-analitica`, `fiabilidad` (I5 ya corregido a tolerancia 0), `ui-erp`, `supabase-multitenant` · código real: `lib/analytics/{types,margins,hash,invariants,reclassify}.ts`, `models/{analytics,margins,reports}.ts`, `lib/ledger/report-run.ts`, `app/(app)/analytics/**`, `components/analytics/**`, `prisma/schema.prisma`, migraciones `20260908*` y `20260909*`.
>
> **Decisiones ya tomadas por Pablo (permiso general delegado, 2026-09-06)** y que este diseño da por firmes: (1) **ADR-0013 nuevo**, no enmienda de ADR-0004, para `sourceShareBps` y **E5-D1**; (2) **`MANUAL` entra en E5**; (3) **`HOURS` y `HEADCOUNT` se RECHAZAN en validación hasta E10** — nunca inertes, nunca silenciosos; (4) **I5 con tolerancia 0** y desempate por **menor código**; (5) **simulación obligatoria** (`previewAllocation`, dry-run puro) antes de sellar; (6) **todas las O-E5-1…10 se incorporan**; (7) **`74x` excluido de `REVENUE_SHARE`**; (8) **`CC-FIN`/`CC-EXT`/`CC-NA` nunca son fuente ni destino**.

---

## 1. Objetivo y alcance

Liquidar el saldo de los centros de coste imputables sobre proyectos, líneas de negocio y otros CECOs, **sin tocar el libro diario** (ADR-0004), de forma versionada, simulable, inmutable, sustituible y reversible, de modo que la PyG analítica muestre MC3 y EBITDA **por proyecto** y que todo CECO imputable con regla quede a cero (I5), sin mover un céntimo de ningún total de nivel (I4 sigue en PASS por construcción).

**No incluye**: `TimeEntry`/`EmployeeAssignment` y por tanto los drivers `HOURS` y `HEADCOUNT`, que se **rechazan al guardar la regla** hasta E10 · presupuesto y desviaciones (E10) · imputación de amortización vía CECO (prohibida: nivel EBIT, R-A5) · cuentas de reflejo del grupo 9 (descartadas en ADR-0004) · el check de Auditoría que lista runs caducados, que es superficie de E7 (E5 entrega el invariante y el dato; E7 lo pinta) · export XLSX/PDF de la liquidación (E6 ya tiene el motor de export; E5 sólo añade el bloque de imputaciones al `result` del `ReportRun`).

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

`@@map`/`@map` en **snake_case** en las cuatro tablas y en todos sus campos (O-A5 de E4 es ley desde entonces: el SQL de RLS, triggers e informes usa nombres físicos). `organizationId` en las **cuatro** tablas, incluida `allocation_rule_targets` — sin él no puede llevar RLS y sería la puerta trasera del tenant. Dinero en céntimos `Int`. Fechas de periodo y de vigencia como `@db.Date`; `DateTime` sólo en auditoría técnica (`runAt`, `reversedAt`, `createdAt`). Uniques compuestas `(organizationId, id)` en las tablas que son destino de FK compuesta por tenant (O-A1).

### 2.2 Fragmento Prisma

```prisma
// ─────────────────────────────────────────────────────────────────────────────
// E5 — Liquidación de CECOs (docs/design/E5-liquidacion.md, ADR-0004 + ADR-0013)
// ─────────────────────────────────────────────────────────────────────────────

enum TargetKind {
  PROJECTS
  BUSINESS_LINES
  COST_CENTERS
  MIXED                       // contrato; desaconsejado (§2.4 del experto). Con
                              // `sourceShareBps` toda mezcla se expresa como N
                              // reglas de un solo `targetKind` y un solo driver.
  @@map("target_kind")
}

enum Driver {
  FIXED_PERCENT
  REVENUE_SHARE
  DIRECT_COST_SHARE
  HOURS                       // E10. Hasta entonces: DRIVER_UNAVAILABLE al guardar.
  HEADCOUNT                   // E10. Ídem.
  EQUAL
  MANUAL
  @@map("allocation_driver")
}

enum AllocPeriod {
  MONTH
  QUARTER
  YEAR
  @@map("alloc_period")
}

/// O-E5-4. El tratamiento de la base cero es CONFIGURACIÓN de la regla, visible
/// en su ficha, nunca una decisión enterrada en el código.
enum ZeroBaseFallback {
  SKIP_WARN                   // default: no se reparte y el importe queda visible
  EQUAL
  YTD
  PRIOR_PERIOD
  @@map("zero_base_fallback")
}

/// O-E5-6 + decisión de Pablo. **`STALE` NO es un estado almacenado**: se DERIVA
/// comparando los tres sellos del run con los del periodo (§3.5). Guardarlo
/// obligaría a un `UPDATE` periódico sobre una tabla append-only y a un cron que
/// lo mantuviera; derivarlo es exacto siempre y no escribe nada.
/// `DRAFT` se declara como contrato y **E5 nunca lo persiste**: la simulación es
/// un dry-run en memoria (`previewAllocation`). Sólo `SEALED` llega a la BD.
enum AllocationRunStatus {
  DRAFT
  SEALED
  SUPERSEDED
  REVERSED
  @@map("allocation_run_status")
}

/// Regla de liquidación, VERSIONADA. Nunca se edita una regla con líneas
/// emitidas: se cierra con `validTo` y se crea otra (skill `contabilidad-analitica`).
model AllocationRule {
  id                 String           @id @default(uuid()) @db.Uuid
  organizationId     String           @map("organization_id") @db.Uuid
  organization       Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// O-E5-10: `code` es el DESEMPATE del orden de ejecución (P7) y el
  /// identificador que el usuario ve. Único por organización y NOT NULL.
  code               String           @db.VarChar(24)
  name               String           @db.VarChar(120)

  sourceCostCenterId String           @map("source_cost_center_id") @db.Uuid
  sourceCostCenter   CostCenter       @relation("AllocationRuleSource", fields: [organizationId, sourceCostCenterId], references: [organizationId, id])

  targetKind         TargetKind       @map("target_kind")
  driver             Driver
  period             AllocPeriod
  /// Orden de ejecución. **Debe ser un orden topológico del grafo de cascada**
  /// (I-E5-8), no una preferencia. `(priority, code)` es un orden TOTAL.
  priority           Int

  /// **O-E5-2 / E5-D2** — fracción del saldo del CECO fuente que ESTA regla
  /// liquida. Σ = 10000 por `(sourceCostCenterId, period)` vigente (I-E5-3).
  /// El reparto del saldo entre reglas es a su vez Hamilton, para que Σ sea exacta.
  sourceShareBps     Int              @default(10000) @map("source_share_bps")

  /// O-E5-4. Se PERSISTE también en cada línea el fallback realmente aplicado.
  zeroBaseFallback   ZeroBaseFallback @default(SKIP_WARN) @map("zero_base_fallback")

  /// `{ projectStatus?: ProjectStatus[]; businessLineCodes?: string[];
  ///    costCenterCodes?: string[]; excludeProjectCodes?: string[] }`
  /// Default aplicado por el motor: `{ projectStatus: ["ACTIVE"] }`, con la
  /// matización de actividad-en-el-periodo de §1.3 del experto.
  targetFilter       Json?            @map("target_filter")

  validFrom          DateTime         @map("valid_from") @db.Date
  validTo            DateTime?        @map("valid_to") @db.Date
  isActive           Boolean          @default(true) @map("is_active")

  createdById        String?          @map("created_by_id") @db.Uuid
  closedById         String?          @map("closed_by_id") @db.Uuid
  createdAt          DateTime         @default(now()) @map("created_at")
  updatedAt          DateTime         @updatedAt @map("updated_at")

  targets            AllocationRuleTarget[]
  lines              AllocationLine[]

  // CORRECCIÓN 2026-09-06 (ronda 1, #17): era `@@unique([organizationId, code])`,
  // que habría IMPEDIDO versionar — la sucesora lleva el mismo `code`. La
  // implementación es la correcta y este documento la refleja: unicidad por
  // `(organización, código, inicio de vigencia)` más un `EXCLUDE` de vigencias
  // solapadas del mismo código (migración `20260910100000_e5_allocations`).
  @@unique([organizationId, code, validFrom])
  @@unique([organizationId, id])
  @@index([organizationId, sourceCostCenterId, period, priority])
  @@index([organizationId, isActive, validFrom, validTo])
  @@map("allocation_rules")
}

/// Destino explícito. Sólo lo usan `FIXED_PERCENT` (percentBps, Σ = 10000) y
/// `MANUAL` (amountCents). Los drivers calculados no tienen targets: el conjunto
/// de receptores sale de `targetFilter` y la base, del diario.
model AllocationRuleTarget {
  id             String         @id @default(uuid()) @db.Uuid
  organizationId String         @map("organization_id") @db.Uuid
  organization   Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  ruleId         String         @map("rule_id") @db.Uuid
  rule           AllocationRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  /// Exactamente UNO de los tres, por CHECK. FK compuestas por tenant (O-A1).
  projectId      String?        @map("project_id") @db.Uuid
  businessLineId String?        @map("business_line_id") @db.Uuid
  costCenterId   String?        @map("cost_center_id") @db.Uuid

  /// **O-E5-3** — puntos básicos, NO milésimas. Σ = 10000 (I-E5-2). Un target a
  /// 0 bps es admisible: documenta una exclusión deliberada.
  percentBps     Int?           @map("percent_bps")
  /// **O-E5-5** — importes de `MANUAL`. Excluyente con `percentBps` (CHECK).
  amountCents    Int?           @map("amount_cents")

  sortOrder      Int            @default(0) @map("sort_order")
  createdAt      DateTime       @default(now()) @map("created_at")

  @@unique([ruleId, projectId, businessLineId, costCenterId], map: "allocation_rule_targets_unique_dest")
  @@index([organizationId, ruleId, sortOrder])
  @@map("allocation_rule_targets")
}

/// Liquidación sellada de UN periodo. **Inmutable y append-only**: sin DELETE y
/// con `UPDATE` acotado por GRANT de columna a las cinco de sustitución/reversión.
model AllocationRun {
  id               String              @id @default(uuid()) @db.Uuid
  organizationId   String              @map("organization_id") @db.Uuid
  organization     Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// O-E5-6: un run pertenece a UN ejercicio. Un periodo a caballo está prohibido.
  fiscalYearId     String              @map("fiscal_year_id") @db.Uuid
  fiscalYear       FiscalYear          @relation(fields: [organizationId, fiscalYearId], references: [organizationId, id])
  periodKind       AllocPeriod         @map("period_kind")
  periodStart      DateTime            @map("period_start") @db.Date
  periodEnd        DateTime            @map("period_end") @db.Date

  status           AllocationRunStatus @default(SEALED)

  /// Los TRES sellos + el del código. `analyticsHash` aquí es el de DIMENSIONES
  /// (§3.5): se calcula con `allocationRunSetHash = ∅` para no ser circular.
  ledgerHash       String              @map("ledger_hash") @db.Char(64)
  analyticsHash    String              @map("analytics_hash") @db.Char(64)
  rulesHash        String              @map("rules_hash") @db.Char(64)
  gitSha           String              @map("git_sha") @db.VarChar(64)

  /// Resumen denormalizado, para listar sin agregar (`lineCount = 0` es legítimo:
  /// un run vacío es la PRUEBA de que el periodo se liquidó y no había nada).
  lineCount           Int              @default(0) @map("line_count")
  totalAllocatedCents Int              @default(0) @map("total_allocated_cents")
  /// `[{code, rule, period, targets?, detail}]` — W-E5-ZERO-BASE, W-E5-NEG-BASE,
  /// W-E5-ARCHIVED-TARGET. Es la memoria de por qué el reparto salió así.
  warnings            Json             @default("[]")

  runById          String?             @map("run_by_id") @db.Uuid
  runAt            DateTime            @default(now()) @map("run_at")

  supersededById   String?             @map("superseded_by_id") @db.Uuid
  supersededBy     AllocationRun?      @relation("AllocationRunSupersedes", fields: [supersededById], references: [id])
  supersedes       AllocationRun[]     @relation("AllocationRunSupersedes")
  reversedAt       DateTime?           @map("reversed_at")
  reversedById     String?             @map("reversed_by_id") @db.Uuid
  reversalReason   String?             @map("reversal_reason") @db.VarChar(1000)

  lines            AllocationLine[]

  /// UN solo run vigente por periodo: índice único PARCIAL `WHERE status = 'SEALED'`
  /// (un `@@unique` con `status` dentro no sirve: permitiría dos SEALED distintos
  /// sólo con que difiriera otra columna, y NULL <> NULL, lección O-A6).
  @@unique([organizationId, id])
  @@index([organizationId, periodStart, periodEnd, status])
  @@index([organizationId, fiscalYearId, periodKind, periodStart])
  @@map("allocation_runs")
}

/// Una celda de reparto. Append-only puro: sin UPDATE y sin DELETE.
model AllocationLine {
  id                  String         @id @default(uuid()) @db.Uuid
  organizationId      String         @map("organization_id") @db.Uuid
  organization        Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  runId               String         @map("run_id") @db.Uuid
  run                 AllocationRun  @relation(fields: [organizationId, runId], references: [organizationId, id], onDelete: Cascade)
  ruleId              String         @map("rule_id") @db.Uuid
  rule                AllocationRule @relation(fields: [organizationId, ruleId], references: [organizationId, id])

  sourceCostCenterId  String         @map("source_cost_center_id") @db.Uuid
  sourceCostCenter    CostCenter     @relation("AllocationLineSource", fields: [organizationId, sourceCostCenterId], references: [organizationId, id])

  /// Exactamente UNO de los tres (CHECK). FK compuestas por tenant.
  targetProjectId      String?       @map("target_project_id") @db.Uuid
  targetBusinessLineId String?       @map("target_business_line_id") @db.Uuid
  targetCostCenterId   String?       @map("target_cost_center_id") @db.Uuid

  /// **O-E5-1 / E5-D1 — el nivel VIAJA CON EL IMPORTE.** Es el
  /// `CostCenter.marginLevel` del CECO **donde nació el gasto**, no el del
  /// receptor ni el del emisor inmediato. CHECK ∈ {MC3, EBITDA}. Sin esto, una
  /// cascada EBITDA → CECO MC3 movería importe entre niveles y **I4.a fallaría**.
  marginLevel         MarginLevel    @map("margin_level")

  /// Convención de COSTE: positivo = coste que sale del CECO fuente y se carga
  /// al receptor. El signo se restituye al final cuando el saldo fuente es
  /// acreedor (§3.3): Hamilton siempre trabaja sobre |importe|.
  amountCents         Int            @map("amount_cents")

  /// Peso del receptor y total de pesos: la celda es auditable SIN recomputar el
  /// driver, que es lo que exige el drill-down.
  driverBase          Int            @map("driver_base")
  driverBaseTotal     Int            @map("driver_base_total")
  /// **O-E5-3** — bps, no milésimas. Informativo (el importe manda).
  driverShareBps      Int            @map("driver_share_bps")

  /// O-E5-4: el fallback REALMENTE aplicado a esta línea, no el declarado.
  fallbackApplied     ZeroBaseFallback? @map("fallback_applied")
  /// §1.3: `"ACTIVITY_IN_PERIOD"` cuando el receptor entró pese a estar CLOSED
  /// al `periodEnd` porque tuvo base en el periodo. `null` en el caso normal.
  eligibilityReason   String?        @db.VarChar(40) @map("eligibility_reason")

  createdAt           DateTime       @default(now()) @map("created_at")

  @@index([organizationId, runId])
  @@index([organizationId, sourceCostCenterId, marginLevel])
  @@index([organizationId, targetProjectId])
  @@index([organizationId, targetCostCenterId])
  @@index([organizationId, targetBusinessLineId])
  @@map("allocation_lines")
}
```

**Cambios en modelos existentes**

| Modelo | Cambio | Por qué |
|---|---|---|
| `ReportRun` | `allocationRunId` **se sustituye** por `allocationRunSetHash String? @map("allocation_run_set_hash") @db.Char(64)`; el trigger `report_runs_analytics_key` y `analyticsKeyOf` pasan a componer `analyticsHash \| marginConfigHash \| allocationRunSetHash` | **O-E5-7**: un informe anual con reglas mensuales se apoya en 12 runs, no en uno. Con el singular, la caché serviría el informe de 11 runs cuando hay 12 (§3.5) |
| `CostCenter` | dos relaciones inversas (`allocationRulesAsSource`, `allocationLinesAsSource`) y **ninguna columna nueva**: `allocatable` y `marginLevel` ya existen desde E4 | El nivel del CECO fuente es el que se copia a `AllocationLine.marginLevel` |
| `Budget` | ~~deuda O-A6 cerrada aquí (T17)~~ → **corregido 2026-09-06 (ronda 1, #6): sigue ABIERTA, cierre en E10**. La tabla `budgets` no existe todavía (la crea E10), así que no había nada sobre lo que crear los índices parciales ni el `CHECK ((project_id IS NULL) <> (cost_center_id IS NULL))` | Una deuda sólo se marca cerrada cuando hay SQL que la cierra. Anotada con épica de cierre en `docs/ESTADO.md` §E5 |

### 2.3 Migración `20260910100000_e5_allocations` (bloques)

Sin backfill: las cuatro tablas nacen vacías, así que **no hace falta el patrón `NO FORCE → backfill → FORCE`** salvo en el bloque 8 (`report_runs`, que sí tiene filas en preview).

1. **Enums**: `target_kind`, `allocation_driver`, `alloc_period`, `zero_base_fallback`, `allocation_run_status`.
2. **Tablas** con sus PK, FK simples a `organizations` y **FK compuestas por tenant** `(organization_id, source_cost_center_id) → cost_centers(organization_id, id)`, ídem para `rule_id`, `run_id`, `fiscal_year_id`, `target_project_id`, `target_business_line_id`, `target_cost_center_id`. Índices del fragmento.
3. **CHECK declarativos**:
   ```sql
   ALTER TABLE "allocation_rules"
     ADD CONSTRAINT "allocation_rules_source_share_bps"  CHECK ("source_share_bps" BETWEEN 0 AND 10000),
     ADD CONSTRAINT "allocation_rules_priority_positive"  CHECK ("priority" >= 0),
     ADD CONSTRAINT "allocation_rules_validity"           CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
     -- Pablo, 2026-09-06: HOURS y HEADCOUNT no entran hasta E10. Rechazo en la BD
     -- además de en la acción: una regla inerte reparte 0 € en silencio, que es
     -- exactamente la clase de fallo que la capa de fiabilidad prohíbe.
     ADD CONSTRAINT "allocation_rules_driver_available"   CHECK ("driver" NOT IN ('HOURS','HEADCOUNT'));

   ALTER TABLE "allocation_rule_targets"
     ADD CONSTRAINT "allocation_rule_targets_one_dest" CHECK (
       (("project_id" IS NOT NULL)::int + ("business_line_id" IS NOT NULL)::int
        + ("cost_center_id" IS NOT NULL)::int) = 1),
     ADD CONSTRAINT "allocation_rule_targets_one_value" CHECK (
       ("percent_bps" IS NULL) <> ("amount_cents" IS NULL)),
     ADD CONSTRAINT "allocation_rule_targets_percent_range" CHECK (
       "percent_bps" IS NULL OR "percent_bps" BETWEEN 0 AND 10000);

   ALTER TABLE "allocation_runs"
     ADD CONSTRAINT "allocation_runs_period_order"  CHECK ("period_end" >= "period_start"),
     ADD CONSTRAINT "allocation_runs_reversal"      CHECK (
       ("reversed_at" IS NULL) = ("reversal_reason" IS NULL)
       AND ("reversal_reason" IS NULL OR length("reversal_reason") >= 10)),
     ADD CONSTRAINT "allocation_runs_status_marks"  CHECK (
       ("status" = 'SUPERSEDED') = ("superseded_by_id" IS NOT NULL)
       AND ("status" = 'REVERSED')  = ("reversed_at" IS NOT NULL));

   ALTER TABLE "allocation_lines"
     ADD CONSTRAINT "allocation_lines_one_dest" CHECK (
       (("target_project_id" IS NOT NULL)::int + ("target_business_line_id" IS NOT NULL)::int
        + ("target_cost_center_id" IS NOT NULL)::int) = 1),
     -- E5-D1: el nivel que viaja con el importe sólo puede ser uno de los dos
     -- niveles admisibles para un CECO (mismo CHECK que `cost_centers`).
     ADD CONSTRAINT "allocation_lines_margin_level" CHECK ("margin_level" IN ('MC3','EBITDA')),
     ADD CONSTRAINT "allocation_lines_no_self"      CHECK (
       "target_cost_center_id" IS NULL OR "target_cost_center_id" <> "source_cost_center_id"),
     ADD CONSTRAINT "allocation_lines_driver_base"  CHECK (
       "driver_base" >= 0 AND "driver_base_total" >= 0 AND "driver_share_bps" BETWEEN 0 AND 10000);
   ```
4. **`EXCLUDE` de vigencias** (patrón `TaxRate` de E2), para que dos versiones de la misma regla no se solapen:
   ```sql
   ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_no_overlap"
     EXCLUDE USING gist ("organization_id" WITH =, "code" WITH =,
                         daterange("valid_from", "valid_to", '[]') WITH &&);
   ```
5. **Un solo run vigente por periodo** (índice único PARCIAL, no `@@unique`):
   ```sql
   CREATE UNIQUE INDEX "allocation_runs_one_sealed_per_period"
     ON "allocation_runs" ("organization_id", "period_start", "period_end")
     WHERE "status" = 'SEALED';
   ```
6. **Triggers de integridad** — lo que ningún CHECK puede expresar porque exige mirar otra tabla:

   | Trigger | Qué impide | Invariante |
   |---|---|---|
   | `allocation_lines_allocatable` (BEFORE INSERT) | fuente o destino con `allocatable = false`, o dimensión con `is_active = false`/`archived_at`, o proyecto `PLANNED` | I-E5-5, I-E5-7 |
   | `allocation_rules_allocatable` (BEFORE INSERT/UPDATE) | ídem sobre la regla y sus targets, en el momento de guardarla | I-E5-5 |
   | `allocation_rules_dag` (**constraint trigger DEFERRABLE INITIALLY DEFERRED**, sobre `allocation_rules` y `allocation_rule_targets`) | ciclo en el grafo `fuente → CECO destino` de las reglas vigentes del **mismo `period`**, autoaristas incluidas. Recorrido con `WITH RECURSIVE` y corte por profundidad | **I-E5-1** |
   | `allocation_rules_topological` (mismo constraint trigger) | `priority` que no sea orden topológico: para toda arista `a → b`, toda regla con fuente `b` y el mismo `period` debe tener `priority` estrictamente mayor | **I-E5-8** |
   | `allocation_rules_immutable_when_used` (BEFORE UPDATE) | `UPDATE` de cualquier columna que no sea `valid_to`, `closed_by_id`, `is_active` o `updated_at` **si la regla tiene `AllocationLine`** | Versionado |
   | `allocation_runs_append_only` (BEFORE UPDATE) | `UPDATE` de cualquier columna fuera de las cinco de sustitución/reversión | **I-E5-11** |

   El DAG se valida **dos veces**: en la app al guardar la regla (mensaje con la lista de CECOs del ciclo, que es lo que el usuario necesita) y en la BD al confirmar la transacción (que es lo que impide que un camino que se salte la app lo cuele). Es el mismo patrón «código + trigger» de Σdebe = Σhaber en E3.

7. **RLS estricta y append-only** (ADR-0009):
   ```sql
   DO $$ DECLARE t text; BEGIN
     FOREACH t IN ARRAY ARRAY['allocation_rules','allocation_rule_targets',
                              'allocation_runs','allocation_lines'] LOOP
       PERFORM app.enforce_tenant_rls(t);
     END LOOP;
   END $$;

   -- Reglas y targets: mutables mientras no tengan líneas (lo cierra el trigger).
   GRANT SELECT, INSERT, UPDATE ON "allocation_rules", "allocation_rule_targets" TO app_runtime;
   REVOKE DELETE ON "allocation_rules", "allocation_rule_targets" FROM app_runtime;
   CREATE POLICY "allocation_rules_no_delete"        ON "allocation_rules"        AS RESTRICTIVE FOR DELETE USING (false);
   CREATE POLICY "allocation_rule_targets_no_delete" ON "allocation_rule_targets" AS RESTRICTIVE FOR DELETE USING (false);

   -- Runs: append-only con GRANT DE COLUMNA (patrón ADR-0010 / manual_review_flags).
   GRANT SELECT, INSERT ON "allocation_runs" TO app_runtime;
   REVOKE UPDATE, DELETE ON "allocation_runs" FROM app_runtime;
   GRANT UPDATE ("status","superseded_by_id","reversed_at","reversed_by_id","reversal_reason")
     ON "allocation_runs" TO app_runtime;
   CREATE POLICY "allocation_runs_no_delete" ON "allocation_runs" AS RESTRICTIVE FOR DELETE USING (false);

   -- Líneas: append-only PURO, como `report_runs`.
   GRANT SELECT, INSERT ON "allocation_lines" TO app_runtime;
   REVOKE UPDATE, DELETE ON "allocation_lines" FROM app_runtime;
   CREATE POLICY "allocation_lines_no_update" ON "allocation_lines" AS RESTRICTIVE FOR UPDATE USING (false);
   CREATE POLICY "allocation_lines_no_delete" ON "allocation_lines" AS RESTRICTIVE FOR DELETE USING (false);
   ```
   Las cuatro tablas entran en `TENANT_MODELS` (`lib/db.ts`) y en `BUSINESS_DELEGATES`. **No hay `ON DELETE CASCADE` efectivo**: el `onDelete: Cascade` del fragmento sólo se dispara si se borra la organización entera, que es el único borrado admitido.

8. **`report_runs`**: `ALTER TABLE "report_runs" DROP COLUMN "allocation_run_id", ADD COLUMN "allocation_run_set_hash" char(64);` y `CREATE OR REPLACE FUNCTION app.report_runs_analytics_key()` con el nuevo tercer componente. La tabla tiene filas en preview y es append-only: el `DROP COLUMN` lo ejecuta el **propietario** en el DDL de la migración (no `app_runtime`), y como las políticas RESTRICTIVE sólo afectan a DML, no hace falta `NO FORCE`. El `analytics_key` de las filas existentes se **recalcula en el mismo bloque**, bajo `NO FORCE → UPDATE → FORCE`, porque ese sí es DML.

9. ~~**`budgets`** (deuda O-A6): índices únicos parciales por combinación + `CHECK` de exclusividad proyecto/CECO.~~ **No entra en E5** (corregido 2026-09-06): `budgets` la crea E10 y allí se cierra O-A6.

10. **Guarda final**: ninguna tabla en `NO FORCE` (el mismo `DO $$` de las migraciones de E4/E6, ampliado con las cuatro nuevas y `budgets`).

### 2.4 Estrategia de datos existentes

No hay ninguno: las cuatro tablas nacen vacías y ningún `AllocationLine` existe todavía en preview ni en local. La única fila tocada es la de `report_runs`, cuyo `analytics_key` se recalcula; como `allocation_run_id` estaba a `NULL` en todas, el `analytics_key` recalculado es **idéntico** al anterior (`∅` en el tercer componente) y ningún informe cacheado se invalida por la migración. La siembra por organización **no crea reglas**: una organización empieza sin liquidación, que es lo correcto — inventar reglas por defecto repartiría dinero que nadie ha decidido repartir.

---

## 3. Motor / funciones puras

### 3.1 `lib/analytics/allocate.ts` (nuevo)

Módulo **PURO**: sin IO, sin Prisma, sin LLM, sin `Date.now()` (`.claude/hooks/guard.sh` lo verifica). Toda la aritmética es **entera**: prohibidos `float`, `Decimal`, `round()` y los porcentajes intermedios.

```ts
// ── Tipos ────────────────────────────────────────────────────────────────────

export type AllocationRuleSpec = {
  id: string; code: string; name: string
  sourceCostCenterId: string
  targetKind: TargetKind; driver: Driver; period: AllocPeriod
  priority: number; sourceShareBps: number
  zeroBaseFallback: ZeroBaseFallback
  targetFilter: TargetFilter | null
  validFrom: LocalDate; validTo: LocalDate | null; isActive: boolean
  targets: readonly RuleTargetSpec[]        // sólo FIXED_PERCENT y MANUAL
}

export type AllocationInput = {
  /** Líneas del EJERCICIO, no sólo del periodo: `YTD` y `PRIOR_PERIOD` las necesitan. */
  lines: readonly AnalyticLine[]
  config: AnalyticsConfig
  rules: readonly AllocationRuleSpec[]
  period: { kind: AllocPeriod; start: LocalDate; end: LocalDate
            fiscalYearId: string; fiscalYearStart: LocalDate }
  /** `AllocationLine` YA emitidas por runs vigentes de periodo más fino ⊂ P. */
  priorAllocations: readonly AppliedAllocation[]
}

/** Lo que la matriz consume: una línea de reparto ya resuelta. */
export type AppliedAllocation = {
  runId: string; ruleCode: string
  sourceCostCenterId: string; sourceCostCenterCode: string
  target: { kind: "PROJECT"; code: string } | { kind: "BUSINESS_LINE"; code: string }
        | { kind: "COST_CENTER"; code: string }
  marginLevel: CostCenterMarginLevel
  amountCents: Cents
  driverBase: Cents; driverBaseTotal: Cents; driverShareBps: number
  fallbackApplied: ZeroBaseFallback | null
  eligibilityReason: "ACTIVITY_IN_PERIOD" | null
}

export type AllocationWarning =
  | { code: "W-E5-ZERO-BASE";       ruleCode: string; period: string; fallback: ZeroBaseFallback; unallocatedCents: Cents; detail: string }
  | { code: "W-E5-NEG-BASE";        ruleCode: string; period: string; targets: readonly string[]; detail: string }
  | { code: "W-E5-ARCHIVED-TARGET"; ruleCode: string; period: string; targets: readonly string[]; detail: string }

export type AllocationErrorCode =
  | "ALLOCATION_CYCLE" | "ALLOCATION_PRIORITY_NOT_TOPOLOGICAL"
  | "CASCADE_PERIOD_MISMATCH" | "ALLOCATION_TARGET_NOT_ALLOCATABLE"
  | "SOURCE_SHARE_NOT_100" | "FIXED_PERCENT_NOT_100" | "MANUAL_AMOUNT_MISMATCH"
  | "DRIVER_UNAVAILABLE" | "PERIOD_CROSSES_FISCAL_YEAR" | "SOURCE_NOT_ALLOCATABLE"

export type AllocationResult = {
  lines: readonly AppliedAllocation[]
  /** Por `(sourceCostCenterId, marginLevel)`: base, repartido, residual. Es I5.a. */
  balances: readonly SourceBalance[]
  warnings: readonly AllocationWarning[]
  rulesApplied: readonly string[]           // códigos, en orden de ejecución
  totalAllocatedCents: Cents
}

// ── Núcleo ───────────────────────────────────────────────────────────────────

/**
 * Mayor resto (Hamilton), determinista y ENTERO (§1.4 del experto).
 *   qᵢ = ⌊A·wᵢ / W⌋ · restoᵢ = A·wᵢ − qᵢ·W · r = A − Σqᵢ
 *   +1 céntimo a los `r` de mayor resto; EMPATE → **menor `code`**.
 * Σ resultado = importe, EXACTO (tolerancia 0). Nunca más de 1 céntimo de
 * remanente por receptor (I-E5-4). `A = |importe|` y el signo se restituye al
 * final: truncar con signo sesga el redondeo hacia cero.
 */
export function hamilton(
  amountCents: Cents,
  weights: readonly { code: string; weight: number }[]
): readonly { code: string; amountCents: Cents; remainderApplied: boolean }[]

/** Grafo `fuente → CECO destino` de las reglas vigentes de UN `period`. */
export function buildAllocationGraph(rules: readonly AllocationRuleSpec[]): AllocationGraph

/** DFS con pila explícita. Devuelve el ciclo NOMBRADO, no un booleano (I-E5-1). */
export function findCycle(graph: AllocationGraph): readonly string[] | null

/** I-E5-8: `(priority, code)` es orden topológico. Devuelve las aristas infractoras. */
export function checkTopologicalOrder(
  rules: readonly AllocationRuleSpec[], graph: AllocationGraph
): readonly { from: string; to: string }[]

/** Pesos del driver por receptor elegible, LEÍDOS DEL DIARIO (§1.1). */
export function driverWeights(
  driver: Driver, rule: AllocationRuleSpec, input: AllocationInput, window: DateWindow
): readonly { code: string; weight: number }[]

/** Base liquidable `base(s,R,ℓ) = own − yaRepartido + recibido`, POR NIVEL (§1.0). */
export function liquidableBase(
  sourceCostCenterId: string, level: CostCenterMarginLevel, input: AllocationInput,
  receivedInRun: readonly AppliedAllocation[]
): Cents

/**
 * **Simulación**: mismo cálculo que `allocate`, sin sellos y sin efectos. Es lo
 * que la UI muestra antes de liquidar, y lo que hace que un run sellado nunca
 * sorprenda: el usuario aprueba EXACTAMENTE lo que se va a persistir.
 */
export function previewAllocation(input: AllocationInput): Result<AllocationResult, AllocationError>

/** Idéntica a `previewAllocation`. `allocate` existe por legibilidad del llamante:
 *  `models/allocations.ts` simula con una y sella con la otra, y un test comprueba
 *  que devuelven el MISMO objeto para la misma entrada (P7). */
export function allocate(input: AllocationInput): Result<AllocationResult, AllocationError>

/** Forma canónica de las reglas vigentes, ordenada por `(priority, code)`, CON
 *  `sourceShareBps`, `zeroBaseFallback`, `targetFilter` y los targets dentro. */
export function canonicalRulesForm(rules: readonly AllocationRuleSpec[]): string
export function rulesHash(rules: readonly AllocationRuleSpec[]): string

/** Serialización byte-idéntica a `docs/design/fixtures/liquidacion-esperada.json`. */
export function canonicalAllocationJson(result: AllocationResult, ctx: CanonicalCtx): string
```

**Orden de ejecución de `allocate`** (§2.1 del experto), literal:

1. Filtra reglas **vigentes a `periodEnd`** (`validFrom ≤ periodEnd`, `validTo IS NULL OR validTo ≥ periodEnd`), `isActive`, y del **mismo `period`** que el run.
2. Ordena por `(priority ASC, code ASC)` — orden **total** y reproducible.
3. Construye el grafo. Ciclo ⇒ **el run falla entero** (`ALLOCATION_CYCLE`), no se persiste nada, se nombran los CECOs. Un ciclo no es un aviso.
4. Comprueba orden topológico (`I-E5-8`). No lo reordena en silencio: reordenar cambiaría el resultado que el usuario acaba de aprobar en la simulación.
5. Valida `Σ sourceShareBps = 10000` por `(fuente, period)`, `Σ percentBps = 10000` en cada `FIXED_PERCENT`, y `Σ amountCents = base` en cada `MANUAL` (**I-E5-10**, antes de persistir nada).
6. Ejecuta en ese orden. La base de cada fuente **se recalcula al ejecutar su regla**, incluyendo lo recibido en cascada dentro del propio run: así un CECO que recibe y reparte en la misma liquidación funciona sin pasada extra.
7. Por cada regla: `importe = hamilton(base(s,ℓ), [{code:"·", weight:sourceShareBps}])` para la fracción de la regla, y `hamilton(esa fracción, pesosDelDriver)` para el reparto entre receptores. **Dos Hamilton anidados, ambos exactos.**
8. Emite las `AppliedAllocation` con `marginLevel = ℓ` (**E5-D1**: el nivel es el del CECO donde nació el gasto, no el del receptor ni el del emisor intermedio).

**Bases de driver** (`driverWeights`), todas sobre `L(P)` leído del diario, nunca de memoria ni de una tabla de resultados:

| Driver | Peso `wᵢ` | Nota |
|---|---|---|
| `REVENUE_SHARE` | `max(0, Σ aporte(l))` con `projectId = i`, tipo efectivo `INGRESO_DIRECTO`, **excluyendo todo `74x`** (R-A12) | Una subvención finalista no es capacidad de absorción de estructura. `706`/`708`/`709` sí entran, con su signo |
| `DIRECT_COST_SHARE` | `max(0, Σ −aporte(l))` con `projectId = i`, tipo ∈ {`COSTE_DIRECTO_MC1`, `COSTE_DIRECTO_MC2`} | Nunca `INDIRECTO_CECO` (sería circular) ni `AMORTIZACION_DETERIORO` (nivel EBIT) |
| `EQUAL` | `1` por receptor elegible | Único driver que no lee el diario, y por eso el fallback natural |
| `FIXED_PERCENT` | `percentBps` del target, `Σ = 10000` | La base es la tabla de targets |
| `MANUAL` | no se usan pesos: importes explícitos, `Σ = base` (I-E5-10) | `reason` obligatorio, rol `ADMIN`, y el run queda **STALE** si el saldo cambia: un reparto manual **no se reescala solo** |
| `HOURS`, `HEADCOUNT` | — | **`DRIVER_UNAVAILABLE`**, rechazado al guardar y al lanzar. El contrato de E10 está en §1.1 del documento del experto y en el anexo `annexHoursIllustrative` del fixture |

**Base cero** (`zeroBaseFallback`): `SKIP_WARN` (default, nada se reparte y el importe queda visible con `W-E5-ZERO-BASE`), `EQUAL`, `YTD` (base ampliada al acumulado del ejercicio hasta `periodEnd`), `PRIOR_PERIOD`. El fallback aplicado se persiste **en cada línea**, no sólo en la regla; si el fallback tampoco produce base > 0, se degrada a `SKIP_WARN`.

**Bases negativas y saldo fuente negativo**: receptor con base < 0 ⇒ `wᵢ = 0`, excluido, con `W-E5-NEG-BASE` que lo nombra (un peso negativo daría cuotas > 100 % a los demás y un **ingreso** de estructura al que devolvió). Saldo fuente acreedor ⇒ **se reparte igualmente**, Hamilton sobre `|importe|` y signo restituido al final: si no, la columna del CECO conservaría saldo y I5.b fallaría.

### 3.2 Cambios en `lib/analytics/margins.ts`

```ts
/** O-E5-9 / E5-D3 — columna REAL del total para lo imputado a una LN sin bajar
 *  a proyecto. Distinta de `businessLineMatrixCents`, que es presentación. */
export type ColumnKey =
  | `PROJ:${string}` | `BL:${string}` | `CECO:${CostCenterKind}`
  | "AMORTIZACION_DETERIORO" | "FINANCIERO" | "EXTRAORDINARIO" | "NO_ANALITICO"
export const businessLineColumn = (code: string): ColumnKey => `BL:${code}`

export type BuildOptions = {
  /* …las de E4… */
  /** Imputaciones vigentes del periodo. Ausente = matriz SIN imputar (E4). */
  allocations?: readonly AppliedAllocation[]
  /** Saldo que las reglas del periodo NO liquidan (§3.3). Se muestra, no se reparte. */
  pendingSettlement?: readonly PendingSettlement[]
}

export type AnalyticPnl = {
  /* …lo de E4… */
  /** Δ por nivel y columna. Σ_c Δ[ℓ][c] = 0 en TODO nivel (I-E5-6). */
  allocationDeltaCents: Record<MarginLevel, Record<string, Cents>>
  /** Por CECO: `saldoPropio`, `recibido`, `imputado`, `pendienteDeLiquidar`. */
  costCenterSettlement: readonly CostCenterSettlement[]
}
```

El Δ se aplica **al aporte del nivel `ℓ`**, no a la matriz cumulativa ya construida: `contrib[ℓ][col(fuente)] += +importe` y `contrib[ℓ][col(receptor)] += −importe`, con el **mismo `ℓ`** en las dos. La acumulación posterior lo propaga sola a los niveles inferiores. Es lo que hace que **I4 no se «vuelva a comprobar» tras imputar: se cumple por construcción** (§4.2 del experto), y lo que garantiza que las cuatro filas superiores (INGRESOS…MC2) sean **idénticas** a las de E4.

`cellQuery` gana la rama `BL:` y, en las columnas de proyecto y de CECO, un segundo bloque de provenance: la celda imputada no se puede reproducir con una sola consulta a `journal_lines`, así que su `Provenance` lleva **dos** consultas parametrizadas —la del diario y la de `allocation_lines` del conjunto de runs vigentes— y el importe de cada una. Sin eso, el drill-down de un MC3 imputado mentiría por omisión.

### 3.3 Periodo del informe vs. periodo de la regla (§3.1 del experto)

| Situación | Comportamiento |
|---|---|
| Informe `P`, reglas más finas (trimestral con reglas mensuales) | La matriz suma los `AllocationLine` de **todos los runs vigentes con `[periodStart, periodEnd] ⊆ P`**. No se re-liquida: `Σ runs` es exacto porque cada run ya cuadra a 0 |
| Informe `P`, reglas más gruesas (mensual con regla anual) | **No hay liquidación.** No se prorratea: el CECO conserva su saldo y la matriz muestra **«pendiente de liquidar»** con el importe y `nextSettlementDate`. Prorratear un anual entre meses sería inventar devengo |
| Run que se solapa parcialmente con el informe | **Nunca se trocea un run**: entra entero o no entra, y si no entra su importe aparece como pendiente |
| Periodo que cruza ejercicios | Prohibido (`PERIOD_CROSSES_FISCAL_YEAR`): un run pertenece a **un** `fiscalYear` |

Tres cifras por CECO en toda vista analítica: `saldoPropio`, `imputado`, `pendienteDeLiquidar = saldoPropio + recibido − imputado`. Un CECO con pendiente ≠ 0 se marca en la cabecera de su columna y la nota al pie dice por qué (regla anual no vencida · base cero con `SKIP_WARN` · sin regla).

### 3.4 Cascada entre niveles

`ℓ` lo fija el `CostCenter.marginLevel` del CECO **donde nació el gasto**. `CC-GA` (EBITDA) → `CC-OPS` (MC3) es un movimiento organizativamente normal y **está permitido**; lo que está prohibido es que el importe **cambie de nivel** al pasar por `CC-OPS`: conserva `EBITDA` y aterriza en el EBITDA de los proyectos. Si se convirtiera en MC3, el MC3 de la compañía bajaría 189 954 c sin que la PyG contable cambiara y **I4.a fallaría en la fila MC3**. Un CECO en cascada puede sostener a la vez un bucket MC3 (suyo) y uno EBITDA (recibido): **cada uno se reparte por separado, con su propio Hamilton**. Una arista de cascada sólo une reglas del **mismo `period`** (`CASCADE_PERIOD_MISMATCH`).

`CC-FIN`, `CC-EXT` y `CC-NA` **nunca** son fuente ni destino (`allocatable = false`): un CECO no imputable que recibiera quedaría con saldo inmovilizado y sin regla para sacarlo.

### 3.5 Sellos: `rulesHash`, `allocationRunSetHash` y `analyticsKey` (O-E5-7)

```
rulesHash = sha256( reglas vigentes en forma canónica, ordenadas por (priority, code),
                    con sourceShareBps, zeroBaseFallback, targetFilter y targets dentro )

allocationRunSetHash = sha256( join("\n", sorted( id de TODO AllocationRun con
                                                  status = 'SEALED' y
                                                  [periodStart, periodEnd] ⊆ periodo del informe )) )
                     = sha256("")  cuando el conjunto está vacío

analyticsHash = sha256( dimensiones de las líneas ‖ marginConfigHash ‖ allocationRunSetHash )
analyticsKey  = analyticsHash | marginConfigHash | allocationRunSetHash
```

Consecuencias, todas queridas: la PyG analítica **sin** imputaciones de E4 y la **con** imputaciones de E5 son dos `ReportRun` distintos y la caché no sirve la una por la otra; **liquidar caduca** `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD` del periodo, y **sólo** esos: `ledgerHash` no cambia, así que balance, PyG contable, cashflow y diario siguen vigentes (E4-D2, ADR-0010).

**No circularidad**: el `analyticsHash` que el propio `AllocationRun` sella es el de **dimensiones**, calculado con `allocationRunSetHash = ∅`. Un run no puede sellarse con un hash que lo incluya a sí mismo. `lib/analytics/hash.ts` lo expresa con dos funciones, no con un parámetro opcional que se pueda olvidar:

```ts
export function dimensionsHash(lines, marginConfigHash): string          // lo que sella un run
export function analyticsHash(lines, marginConfigHash, runSetHash): string  // lo que sella un informe
```

**Caducidad de un run** (`STALE`, derivado, nunca almacenado): un run está caducado si (a) el `ledgerHash` del periodo difiere del sellado —asiento nuevo o contra-asiento dentro del periodo—, (b) el `dimensionsHash` difiere —reclasificación analítica del periodo, ADR-0010 salvaguarda 5—, o (c) el `rulesHash` de las reglas vigentes difiere. Un run caducado **no se borra ni se corrige**: se **sustituye** por otro, y el anterior queda con `status = SUPERSEDED` y `supersededById`.

### 3.6 `lib/analytics/invariants.ts`

```ts
export function checkI5(input: AllocationInvariantInput): CheckResult      // a, b, c — tolerancia 0
export function checkAllocationInvariants(input): readonly CheckResult[]   // I-E5-1 … I-E5-12
```

`runInvariants` (`lib/ledger/invariants.ts`) gana un bloque opcional `allocations?`; con él presentes se ejecutan I5 y los doce, y `scripts/run-invariants.ts` los vuelca a `validacion.json`. Sin él, se omiten sin fallar — una organización que no liquida no tiene por qué ver FAIL.

---

## 4. Capa de aplicación

### 4.1 `models/allocations.ts` (nuevo)

Ninguna función calcula: componen el contexto, delegan en `lib/analytics/allocate.ts` (puro) y escriben. Todo acceso por `tenantDb`/`tenantTransaction`; toda escritura con `AuditLog` **en la misma transacción**, siguiendo `runLedgerTransaction` y `abort()` (lección BLOQUEA-1 de E3: un `return` no aborta).

```ts
listAllocationRules(db, filter): Promise<AllocationRuleListItem[]>   // con vigencias y nº de líneas
getAllocationRuleSpecs(db, { periodEnd, period }): Promise<AllocationRuleSpec[]>

createAllocationRule(tx, input, actor): LedgerResult<AllocationRule>
/** Versionado: NUNCA edita una regla con líneas. Cierra con `validTo = d−1` y
 *  crea la sucesora con `validFrom = d`, mismo `code` distinto `id`. */
supersedeAllocationRule(tx, { ruleId, validFrom, changes, reason }, actor): LedgerResult<AllocationRule>
closeAllocationRule(tx, { ruleId, validTo, reason }, actor): LedgerResult<void>

/** Dry-run. No escribe NADA. Es lo que pinta la tabla de simulación. */
previewAllocationRun(tx, { periodKind, periodStart, periodEnd }): Promise<AllocationPreview>

/** Sella. Reutiliza el resultado de la simulación SÓLO si los tres sellos siguen
 *  siendo los mismos; si han cambiado entre simular y sellar, recalcula y **avisa**
 *  con `LIQUIDACION_DESFASADA` en vez de persistir lo que el usuario aprobó. */
sealAllocationRun(tx, { periodKind, periodStart, periodEnd, expectedHashes }, actor)
  : LedgerResult<AllocationRun>

/** Rerun: nuevo run + el anterior a SUPERSEDED, en UNA transacción. */
supersedeAllocationRun(tx, { runId, reason }, actor): LedgerResult<AllocationRun>
/** Apaga un run sin sustituirlo. `reason` ≥ 10 caracteres. No genera asientos. */
reverseAllocationRun(tx, { runId, reason }, actor): LedgerResult<AllocationRun>

listAllocationRuns(db, { fiscalYearId, periodKind }): Promise<AllocationRunListItem[]>
getAllocationRun(db, runId): Promise<AllocationRunDetail>
/** Diff contra el run vigente anterior del mismo periodo, celda a celda. */
diffAllocationRuns(db, { runId, againstRunId }): Promise<AllocationDiff>
/** Las líneas vigentes que la matriz consume, para un periodo de informe. */
getAppliedAllocations(tx, { from, to }): Promise<{ lines: AppliedAllocation[]; runSetHash: string }>
```

`models/margins.getAnalyticPnl` gana un parámetro `{ withAllocations: boolean }`: con `true` llama a `getAppliedAllocations`, pasa las líneas a `buildAnalyticPnl` y compone el `analyticsHash` con el `runSetHash` real; con `false` reproduce **exactamente** el comportamiento de E4 (`runSetHash = sha256("")`). Las dos lecturas van **en serie** dentro de la misma transacción (el adaptador `pg` avisa de «client is already executing a query», hallazgo #6 de E4).

### 4.2 Server actions (`app/(app)/analytics/allocations/actions.ts`)

Validación con zod en `forms/allocations.ts`; toda acción empieza por `withOrg(<rol>)` y devuelve `ActionState`. `refDate` se decide **en el borde**, nunca dentro de `lib/analytics/`.

| Acción | Rol mínimo | Notas |
|---|---|---|
| `listAllocationRulesAction`, `listAllocationRunsAction`, `getAllocationRunAction`, `diffAllocationRunsAction` | **`VIEWER`** | Sólo lectura. Un `VIEWER` ve reglas, simulaciones, runs y diffs |
| `previewAllocationAction` | **`VIEWER`** | Dry-run puro: no escribe, así que no exige permiso de escritura. Es además la vía por la que un controller comprueba una regla antes de pedir que se aplique |
| `createAllocationRuleAction`, `supersedeAllocationRuleAction`, `closeAllocationRuleAction` | **`ADMIN`** | Una regla mueve dinero entre columnas de todos los informes de gestión: es política, no operación |
| `sealAllocationRunAction` | **`EDITOR`** | Decisión de Pablo. Liquidar es aplicar una política que un ADMIN ya aprobó |
| `reverseAllocationRunAction` | **`EDITOR`** + `reason` ≥ 10 caracteres | Decisión de Pablo (el experto proponía ADMIN; se documenta la divergencia). La reversión **no genera asientos**: apaga el run |

Errores traducidos al español contable, anclados al objeto que los provoca: `ALLOCATION_CYCLE` → «las reglas forman un ciclo: CC-GA → CC-OPS → CC-GA. Ninguna liquidación puede resolverlo»; `SOURCE_SHARE_NOT_100` → «las reglas de CC-GA (anual) reparten el 90 % de su saldo: falta declarar qué pasa con el 10 % restante»; `DRIVER_UNAVAILABLE` → «el driver HORAS necesita partes de horas, que llegan en E10. Elige otro driver o deja el CECO sin liquidar».

---

## 5. Invariantes

### 5.1 I5 — formulación exacta (definición única en la skill `fiabilidad`, ya corregida)

```
own(s,P)         = Σ −aporte(l),  l ∈ L(P), l.costCenterId = s, tipoEfectivo = INDIRECTO_CECO
yaRepartido(s,P) = Σ AllocationLine de runs SEALED de periodo más fino ⊂ P, fuente s
recibido(s,R)    = Σ AllocationLine de R con targetCostCenterId = s
base(s,R,ℓ)      = own(s,P)|ℓ − yaRepartido(s,P,ℓ) + recibido(s,R,ℓ)

I5.a  ∀R, ∀s, ∀ℓ:  Σ AllocationLine{runId=R, source=s, marginLevel=ℓ} = base(s,R,ℓ)   -- TOLERANCIA 0
I5.b  ∀s allocatable con regla vigente: own(s, ejercicio) + Σ recibido − Σ imputado = 0
I5.c  ∀s ∈ {CC-FIN, CC-EXT, CC-NA}: Σ líneas con fuente s = 0 ∧ Σ con destino s = 0
```

La tolerancia es **0**, no 1 céntimo: el mayor resto reparte el remanente entero. Un céntimo sin repartir es un **fallo**, no un redondeo aceptable — con tolerancia 1, un motor que dejara un céntimo pasaría el invariante y la columna del CECO nunca llegaría a 0.

### 5.2 Los doce de la épica

| Id | Regla | Test propuesto |
|---|---|---|
| **I-E5-1** | Sin ciclos ni autoaristas en el grafo de reglas vigentes del mismo `period` | `lib/analytics/allocate.test.ts` (`findCycle` sobre 6 grafos) + `tests/integration/e5-allocations.test.ts` (constraint trigger) |
| **I-E5-2** | `Σ percentBps = 10000` en toda regla `FIXED_PERCENT` | unitario + integración (CHECK diferido) |
| **I-E5-3** | `Σ sourceShareBps = 10000` por `(fuente, period)` vigente | unitario + integración |
| **I-E5-4** | Remanente `0 ≤ r ≤ n−1` y ≤ 1 céntimo por receptor | **test de propiedad** sobre `hamilton` (1 000 casos pseudoaleatorios con semilla fija) |
| **I-E5-5** | Ni fuente ni destino con `allocatable = false` | consulta + trigger |
| **I-E5-6** | `Σ_c Δ[ℓ][c] = 0` en cada nivel; el `marginLevel` de una línea de cascada = el de la que la alimentó | `lib/analytics/invariants.test.ts` sobre el fixture |
| **I-E5-7** | Ningún destino archivado ni proyecto `CLOSED`/`PLANNED`, salvo `ACTIVITY_IN_PERIOD` anotado | consulta + trigger |
| **I-E5-8** | `(priority, code)` es orden topológico | unitario + constraint trigger |
| **I-E5-9** | Sólo los runs `SEALED` aportan a la matriz | integración: sustituir un run y comprobar que la matriz no lo suma |
| **I-E5-10** | `MANUAL` cuadrado: `Σ amountCents = base(s,R,ℓ)` antes de persistir | unitario + integración (el run no se persiste) |
| **I-E5-11** | Inmutabilidad: ningún `UPDATE` en `allocation_lines`; en `allocation_runs` sólo las cinco columnas; ningún `DELETE` en ninguna | `tests/integration-rls/e5-tenant.test.ts`: `42501` y fila intacta |
| **I-E5-12** | Reproducibilidad byte a byte con los mismos tres sellos, desempates incluidos (P7) | dos ejecuciones + comparación de `canonicalAllocationJson` |

### 5.3 Invariantes existentes que la épica **puede romper**

| Invariante | Cómo se rompería | Cómo se impide | Test |
|---|---|---|---|
| **I4** (Σ matriz = PyG contable) | mover importe entre niveles en la cascada (violar E5-D1) o perder/duplicar una línea | el nivel viaja con el importe y el Δ es de suma cero **en cada nivel** | `checkI4` sobre la matriz **imputada**; comparación de los ocho `levelTotalsCents` contra `pyg-analitica-esperada.json` |
| **I1, I2, I3, I6** (diario, balance, PyG, cashflow) | si la liquidación generase asientos | **no los genera** (ADR-0004): `allocation_*` no toca `journal_lines` | test: `ledgerHash` del periodo idéntico antes y después de sellar un run |
| **I-E3-7** (`entryHash` estable) | ídem | ídem | mismo test |
| **I7–I10** | — | sin efecto | — |
| **I-E4-1…12** | la columna `BL:` nueva podría dejar líneas sin cubrir | `BL:` sólo recibe **imputaciones**, nunca líneas del diario; I4.c (cobertura y unicidad) se comprueba sobre las líneas, no sobre las columnas | `invariants.test.ts` de E4, sin cambios y en verde |

---

## 6. UI

`ui-erp`: cada pantalla financiera muestra **periodo, sello, cuadre** y drill-down hasta el documento en ≤ 3 clics; acciones destructivas con motivo; estados vacío/carga/error siempre; importes con formato español y `—` en vez de `0` cuando no hay dato.

| Ruta | Contenido | VIEWER | EDITOR | ADMIN |
|---|---|---|---|---|
| `/analytics/allocations` | **Reglas**: tabla por CECO fuente con `code`, nombre, driver, periodo, `priority`, `sourceShareBps`, vigencia (`validFrom`–`validTo`, versiones antiguas colapsadas), `zeroBaseFallback` y targets. Banda de aviso si `Σ sourceShareBps ≠ 10000` en algún `(fuente, period)`, con el hueco en euros. Diagrama de cascada (grafo de aristas fuente → CECO) con el orden de ejecución numerado | ve | ve | **crea, versiona y cierra** |
| `/analytics/allocations/simular` | **Simulación**: selector de periodo → tabla `receptor · base del driver · cuota (bps) · importe`, agrupada por regla y por nivel, con la fila de cuadre `Σ importes − base = 0,00 €`, los warnings (`W-E5-*`) en su propio bloque y el aviso de qué informes caducarán al sellar. Botón **Liquidar** (deshabilitado con cualquier error) | ve | **liquida** | liquida |
| `/analytics/allocations/runs` | **Runs por periodo**: ejercicio × periodicidad, con estado (`SEALED` / `SUPERSEDED` / `REVERSED` / **`caducado`** derivado), `lineCount`, `totalAllocatedCents`, quién y cuándo, y los tres sellos abreviados | ve | ve | ve |
| `/analytics/allocations/runs/[id]` | **Detalle**: las líneas con fuente, destino, nivel, base, cuota, importe y fallback; **diff contra el run anterior** del mismo periodo (verde/rojo por celda, con el Δ en euros); botón **Revertir** con motivo obligatorio ≥ 10 caracteres; enlace al run que lo sustituyó | ve | **revierte** | revierte |
| `/analytics/pyg` | **Toggle «con / sin imputaciones»** (parámetro en la URL, así que es compartible y entra en `paramsHash`). Con imputaciones: columnas `BL:` visibles, CECOs a 0, y **columna «pendiente de liquidar»** con el importe no repartido y el motivo al pie. Cabecera con los **cuatro** sellos (`ledgerHash`, `analyticsHash`, `marginConfigHash`, `allocationRunSetHash`) | ve | ve | ve |

Componentes nuevos en `components/analytics/`: `allocation-rule-form.tsx`, `allocation-rules-table.tsx`, `allocation-cascade-graph.tsx` (SVG, sin librería), `allocation-preview-table.tsx`, `allocation-runs-table.tsx`, `allocation-run-diff.tsx`. Se reutilizan `margin-matrix.tsx` (que gana el toggle y las columnas `BL:`), `dimension-combobox.tsx`, `report-header.tsx` y `report-period-picker.tsx`.

**Dos avisos de método impresos en pantalla**, no en la documentación (§5.5 del experto): (a) un reparto `EQUAL` cobra lo mismo a un proyecto de 2 M€ que a uno de 20 k€ — es una **elección de política**, no un hecho; (b) las filas `EBIT`, `BAI` y `RESULTADO` de las columnas de proyecto **no son márgenes de proyecto**: amortización, financiero e impuesto no se imputan y sólo tienen lectura a nivel de compañía (ya atenuadas desde E4).

---

## 7. Trazabilidad

| Qué | Dónde |
|---|---|
| Regla aplicada, **versionada** | `AllocationLine.ruleId` → `AllocationRule` con `validFrom`/`validTo`; la regla no se puede editar con líneas emitidas (trigger) |
| Base del driver de cada celda | `driverBase`, `driverBaseTotal`, `driverShareBps` en la propia línea: la celda es auditable **sin recomputar** |
| Por qué el receptor entró o salió | `fallbackApplied`, `eligibilityReason` y `AllocationRun.warnings` (`W-E5-ZERO-BASE`, `W-E5-NEG-BASE`, `W-E5-ARCHIVED-TARGET`) |
| Estado del mundo al liquidar | `ledgerHash` + `analyticsHash` (dimensiones) + `rulesHash` + `gitSha` en el run |
| Quién y cuándo | `runById`/`runAt`; `reversedById`/`reversedAt`/`reversalReason`; `supersededById` |
| Cambios de política | `AuditLog` con `entity ∈ {AllocationRule, AllocationRun}` y `action ∈ {create, supersede, close, seal, reverse}`, con `before`/`after` y `reason`, **en la misma transacción** que la mutación |
| Camino al documento | celda imputada → línea de reparto → CECO fuente → `cellQuery` del CECO en `journal_lines` → asiento → `File`/`ExtractionRun`. **Cuatro saltos, tres clics** con la fila de detalle desplegada |
| Caducidad de informes | `ReportRun.allocationRunSetHash` dentro de `analyticsKey`: un informe emitido antes de liquidar sigue siendo reproducible y **se ve** que se calculó sin imputaciones |

---

## 8. Criterios de aceptación y plan de tareas

### 8.1 Criterios (Given / When / Then)

1. **Byte a byte.** *Given* el fixture `ejercicio-completo` cargado con sus 2 LN, 3 proyectos y 8 CECOs y las 6 reglas de §5.1 del experto, *when* se liquidan los 17 periodos de 2026, *then* la serialización canónica es **idéntica byte a byte** a `docs/design/fixtures/liquidacion-esperada.json`: 14 líneas, `totalAllocated = 1 075 524`, y `build_liquidacion_esperada.py --check` pasa en CI.
2. **I4 intacto.** *Then* los ocho `levelTotalsCents` de la matriz **imputada** coinciden al céntimo con los de `pyg-analitica-esperada.json` (`MC3 = 3 084 110`, `EBITDA = 2 390 430`, `RESULTADO = 1 497 322`), y las filas INGRESOS…MC2 son **idénticas**, no equivalentes.
3. **I5 a 0.** *Then* las 5 combinaciones `(run, fuente, nivel)` tienen `diffCents = 0`, y al cierre del ejercicio los cuatro CECOs imputables con regla valen **0** en MC3 y en EBITDA.
4. **El nivel viaja con el importe.** *Given* `CC-GA` (EBITDA) que reparte 189 954 c a `CC-OPS` (MC3), *when* `CC-OPS` los redistribuye a proyectos, *then* las tres líneas resultantes llevan `marginLevel = EBITDA`, el MC3 de la compañía **no cambia** y `Σ_c Δ[MC3][c] = Σ_c Δ[EBITDA][c] = 0`.
5. **Hamilton exacto y determinista.** *Then* `53 577 + 30 589 + 7 724 = 91 890`, `34 571 + 25 929 = 60 500`, `110 753 + 63 233 + 15 968 = 189 954`; los tres céntimos de remanente caen en P-02 y P-03 **por menor código**, y dos ejecuciones dan el mismo reparto.
6. **Base cero con `YTD`.** *Given* `AL-OPS-M` en 2026-11 con `Σ` base del periodo `= 0`, *then* se emite `W-E5-ZERO-BASE`, la base se amplía al acumulado enero-noviembre (1 734 000 / 990 000 / 250 000), las tres líneas llevan `fallbackApplied = YTD` y la columna `CC-OPS` llega a 0. *Given* la misma regla con `SKIP_WARN`, *then* no se emite ninguna línea, el importe queda visible en la columna del CECO y la matriz lo marca como pendiente.
7. **Base negativa.** *Given* P-03 con ingresos netos **−90 000 c** en 2026-Q2, *then* recibe peso 0, queda excluido con `W-E5-NEG-BASE` y los 60 500 c se reparten sólo entre P-01 y P-02 — P-03 **no recibe un ingreso** de marketing.
8. **Ciclo.** *Given* reglas `CC-GA → CC-OPS` y `CC-OPS → CC-GA` del mismo `period`, *when* se guarda la segunda, *then* la acción falla con `ALLOCATION_CYCLE` nombrando los dos CECOs; saltándose la acción, el constraint trigger lanza al confirmar y **nada** se persiste. Autoarista: rechazada igual.
9. **Orden topológico.** *Given* `AL-GA-OPS-Y` con `priority = 30` y `AL-OPS-Y` con `priority = 10`, *then* `ALLOCATION_PRIORITY_NOT_TOPOLOGICAL` con la arista infractora; el motor **no reordena** en silencio.
10. **`sourceShareBps`.** *Given* `CC-GA` con dos reglas anuales de 3000 y 6000 bps, *then* la segunda no se guarda (`SOURCE_SHARE_NOT_100`) y el mensaje dice cuántos euros quedarían sin declarar. Con 3000 + 7000, *then* `CC-GA` reparte 189 954 + 443 226 = 633 180 y su columna queda a 0.
11. **`MANUAL`.** *Given* una regla `MANUAL` con `Σ amountCents ≠ base`, *then* `MANUAL_AMOUNT_MISMATCH` **antes** de persistir el run. *Given* que cuadra y después se postea un asiento tardío del periodo, *then* el run aparece como **caducado** y la UI pide reeditar los importes: **no se reescala solo**.
12. **`HOURS`/`HEADCOUNT`.** *When* se intenta guardar una regla con driver `HORAS`, *then* la acción responde `DRIVER_UNAVAILABLE` con el texto de E10 y, saltándose la acción, el CHECK `allocation_rules_driver_available` rechaza el `INSERT` con `23514`. **En ningún camino queda una regla inerte.**
13. **No imputables.** *Given* una regla con destino `CC-FIN`, *then* `ALLOCATION_TARGET_NOT_ALLOCATABLE`; el trigger la rechaza también. `Σ` líneas con fuente o destino en `{CC-FIN, CC-EXT, CC-NA}` = 0 en el fixture.
14. **Simulación = liquidación.** *When* se simula y acto seguido se sella sin que nada cambie, *then* el run persistido es **idéntico** a la simulación mostrada, línea a línea. *When* entre simular y sellar se postea un asiento del periodo, *then* la acción **no persiste lo aprobado**: responde `LIQUIDACION_DESFASADA` y obliga a resimular.
15. **Rerun y reversión.** *When* se vuelve a liquidar el mismo periodo, *then* nace un run nuevo, el anterior pasa a `SUPERSEDED` con `supersededById`, deja de aportar a la matriz (I-E5-9) y **sigue consultable**. *When* se revierte con motivo de 9 caracteres, *then* se rechaza; con 10 o más, el run pasa a `REVERSED`, deja de aportar y **no se genera ningún asiento** (`ledgerHash` idéntico).
16. **Inmutabilidad.** *When* `app_runtime` intenta `UPDATE`/`DELETE` sobre `allocation_lines`, o `UPDATE` de `amount_cents` en un run, *then* `42501` y la fila intacta. Índice único parcial: dos `SEALED` del mismo periodo ⇒ `23505`.
17. **Caducidad de informes, y sólo de los analíticos.** *When* se sella un run del periodo de un `PYG_ANALITICA` ya emitido, *then* el `analyticsKey` cambia, la caché **no** lo reutiliza y el nuevo informe se emite con imputaciones; el `BALANCE`, la `PYG` contable y el `CASHFLOW` del mismo periodo **conservan su caché** porque `ledgerHash` no ha cambiado.
18. **Periodos.** Informe trimestral con reglas mensuales ⇒ suma los 3 runs. Informe mensual con regla anual ⇒ **0 imputado** y el importe en «pendiente de liquidar» con la fecha en que se liquidará. Regla trimestral e informe de febrero ⇒ el run **no entra**, no se trocea. Periodo que cruza ejercicios ⇒ rechazado.
19. **Aislamiento.** `tests/integration-rls/e5-tenant.test.ts`: sin GUC, las cuatro tablas devuelven 0 filas y rechazan el `INSERT` con `42501`; ninguna queda en `NO FORCE`.
20. **Rendimiento y pureza.** La liquidación anual del fixture completo (326 líneas, 17 runs) tarda **< 400 ms** medidos en el test; la PyG analítica imputada del ejercicio, **< 800 ms**; una sola transacción por petición. El guard no encuentra `Date.now()` ni IO en `lib/analytics/allocate.ts`.
21. **UX.** Con imputaciones activadas, desde una celda MC3 de P-01 se llega al documento origen del gasto de `CC-OPS` en **3 clics** (celda → línea de reparto → asiento → documento), y la pantalla dice en todo momento periodo, sello, cuadre y qué parte de la estructura queda por absorber.

### 8.2 Plan de tareas

| # | Tarea | Depende de | Nivel | h |
|---|---|---|---|---:|
| **T1** | **ADR-0013** redactado y firmado (`sourceShareBps`, E5-D1, `allocationRunSetHash`, `MANUAL` en E5, `HOURS`/`HEADCOUNT` rechazados, I5 a 0). Bloquea T2 | — | 2 | 2 |
| **T2** | Prisma: 4 tablas + 5 enums, relaciones en `CostCenter`/`FiscalYear`/`Organization`, `ReportRun.allocationRunSetHash`, `TENANT_MODELS`, `BUSINESS_DELEGATES` | T1 | 2 | 8 |
| **T3** | Migración `20260910100000_e5_allocations`: 10 bloques de §2.3 (tablas, CHECKs, `EXCLUDE`, índice parcial, 6 triggers con el DAG recursivo, RLS + append-only, `report_runs`, `budgets`), con sus tests de integración sobre el SQL | T2 | 2 | 18 |
| **T4** | `ColumnKey` con `BL:`, `buildAnalyticPnl` con `allocations` y `pendingSettlement`, Δ por nivel, `costCenterSettlement`, `cellQuery` de `BL:` y provenance de dos consultas | T2 | 2 | 16 |
| **T5** | **`lib/analytics/allocate.ts`**: `hamilton`, grafo + `findCycle` + `checkTopologicalOrder`, `driverWeights` (5 drivers vivos + 2 rechazados), `liquidableBase` por nivel, cascada, fallbacks, `previewAllocation`/`allocate`, `canonicalRulesForm`/`rulesHash`, `canonicalAllocationJson` + `allocate.test.ts` (tabla de casos: 7 drivers × 4 fallbacks × 3 periodicidades, cascada de 3 saltos, saldo acreedor) | T2 | 2 | 26 |
| **T6** | Sellos: `dimensionsHash`/`analyticsHash` separados, `allocationRunSetHash`, `analyticsKeyOf`, el trigger SQL espejo de `report_runs_analytics_key` y su test de coincidencia TS↔SQL | T2, T3 | 2 | 10 |
| **T7** | **Test byte a byte** contra `liquidacion-esperada.json` + paso de CI `build_liquidacion_esperada.py --check` | T5, T4 | 2 | 12 |
| **T8** | `checkI5` (a/b/c) e `I-E5-1…12` en `lib/analytics/invariants.ts`, cableados en `runInvariants` y en `scripts/run-invariants.ts`; test de propiedad de Hamilton | T5, T7 | 2 | 14 |
| **T9** | `models/allocations.ts` completo: CRUD versionado, `previewAllocationRun`, `sealAllocationRun` con verificación de sellos, `supersede`, `reverse`, `diffAllocationRuns`, `getAppliedAllocations`, `AuditLog`; `getAnalyticPnl({withAllocations})` | T3, T5, T6 | 1 | 20 |
| **T10** | `forms/allocations.ts` (zod) + `app/(app)/analytics/allocations/actions.ts` con la matriz de roles; `AuditEntity`/`AuditAction` ampliados | T9 | 1 | 10 |
| **T11** | UI de reglas: `/analytics/allocations`, formulario con vigencias y targets, banda de `Σ sourceShareBps`, grafo de cascada | T10 | 1 | 16 |
| **T12** | UI de simulación y runs: `/simular` con la tabla receptor/base/share/importe y el cuadre, `/runs`, `/runs/[id]` con diff y botones liquidar/revertir con motivo | T10 | 1 | 18 |
| **T13** | UI de la matriz: toggle «con/sin imputaciones», columnas `BL:`, columna «pendiente de liquidar» con motivo al pie, cuarto sello en la cabecera | T10, T4 | 1 | 12 |
| **T14** | Integración y RLS: `tests/integration/e5-allocations.test.ts` (criterios 8–18), `tests/integration-rls/e5-tenant.test.ts` (19), test de rendimiento (20) | T11, T12, T13 | 1 | 16 |
| **T15** | e2e Playwright: alta de regla → simulación → liquidar → PyG imputada → revertir → PyG sin imputar | T14 | 1 | 8 |
| **T16** | Correcciones a documentos ajenos: skill `contabilidad-analitica` (`sourceShareBps`, `zeroBaseFallback`, `priority` como orden topológico, qué caduca un rerun), skill `estados-financieros` (columnas `BL:`), `docs/design/E4-analitica.md` §2.5 (`allocationRunSetHash`) | T8 | 1 | 5 |
| **T17** | **Deuda O-A6** de E4: índices únicos parciales de `Budget` + `CHECK` de exclusividad, con test | T3 | 1 | 4 |
| **T18** | Docs de cierre: `MODELO-DATOS.md` §Analítica, `ESTADO.md`, ROADMAP E5 → CERRADA, `runs/registro.jsonl` | T15, T16 | 1 | 6 |

**Total: 221 h** (~28 jornadas). Camino crítico: **T1 → T2 → T3/T5 → T4/T6 → T7 → T9 → T10 → T12 → T14 → T15**. T5 es la tarea de riesgo (26 h): es el motor y toda la épica cuelga de que su salida sea byte-idéntica al fixture. T17 no bloquea a nadie y puede correr en cualquier hueco.

---

## 9. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **La cascada entre niveles rompe I4** si alguien «corrige» el nivel en el receptor: es la clase de cambio que parece una mejora | E5-D1 en ADR-0013 firmado, `marginLevel` **en la línea** con CHECK, I-E5-6 con test sobre el fixture, y el comentario del porqué en el propio modelo Prisma. Un cambio que lo viole tumba el test byte a byte antes de llegar a revisión |
| R2 | **Un céntimo perdido** en un reparto de 15 receptores encadenado con una cascada de 3 saltos | Hamilton entero sobre `\|importe\|`, tolerancia 0, test de propiedad con 1 000 casos y `I5.a` por `(run, fuente, nivel)` sobre las 5 combinaciones reales |
| R3 | **La liquidación caduca informes que no debía** (balance, PyG contable) y la organización reemite media contabilidad | `allocationRunSetHash` vive **sólo** en `analyticsKey`; `ledgerHash` no cambia. Criterio 17 lo comprueba explícitamente en los dos sentidos |
| R4 | **Reglas mal configuradas producen un reparto plausible pero falso** (el `EQUAL` de la G&A cambia el diagnóstico de P-01 de rentable a destructor de valor) | La simulación es obligatoria y muestra base y cuota por receptor; los dos avisos de método van impresos en pantalla; el diff contra el run anterior hace visible cualquier cambio de política |
| R5 | **Rendimiento**: la matriz imputada de un ejercicio con 17 runs y 40 000 líneas | Agregados por SQL (patrón R6 de E4), `AllocationLine` ya agregada por `(fuente, destino, nivel)` en la lectura, índices por `(organization_id, run_id)` y por cada destino, una transacción por petición, y el umbral medido del criterio 20 |
| R6 | **El grafo DAG en un constraint trigger** con recursión puede degradarse con muchas reglas | Corte por profundidad (16) y `Σ` reglas por organización acotada en la práctica a decenas; el recorrido caro vive en la app y el trigger es la segunda barrera, no la primera. Test con 200 reglas sintéticas |
| R7 | **`MANUAL` se convierte en la vía por defecto** y la liquidación deja de ser una política reproducible | `MANUAL` exige `ADMIN` y `reason`; el run queda caducado en cuanto el saldo cambia, y la Auditoría lista las reglas `MANUAL` vigentes como Info permanente |
| R8 | **`HOURS`/`HEADCOUNT` se activan a medias en E10** y reparten 0 € en silencio | El CHECK de BD y la acción los rechazan **hoy**; E10 debe retirar el CHECK **y** cumplir el contrato de §1.1 (minutos enteros, sólo entradas aprobadas, `fteMilli` a fin de periodo), con su propio fixture antes de encenderlos |
| R9 | **Deuda acumulada**: E5 hereda O-A6 y podría dejar la suya | O-A6 se cierra en T17. E5 no abre deuda nueva: `MIXED` queda como contrato desaconsejado y documentado, y `DRAFT` como valor de enum sin persistencia, ambos anotados en `ESTADO.md` con la épica que los resolvería si alguna vez se usan |

**Alternativas descartadas**

- **Asientos de traspaso analítico** (cuentas 9x o asientos internos) para materializar la imputación. No es un hecho económico (NRV 14ª), contaminaría el diario, obligaría a excluirlos de I1–I3 con un flag —justo lo que CLAUDE.md prohíbe— y ya lo descartó ADR-0004. La capa paralela es reconstruible y reversible sin tocar nada financiero.
- **Nivel de absorción decidido por el CECO receptor.** Es la lectura intuitiva y es falsa: el alquiler de la oficina no se convierte en coste operativo de un proyecto por pasar por Operaciones, y aritméticamente mueve importe entre niveles y rompe I4.a en la fila MC3 (−189 954 c en el fixture) sin que la PyG contable cambie.
- **Tolerancia de 1 céntimo en I5**, como decía la skill antes de la corrección. Con el mayor resto la suma es exacta, así que la tolerancia sólo serviría para que un motor que pierde un céntimo pase el invariante y la columna del CECO nunca llegue a 0 — un fallo silencioso permanente a cambio de nada.
- **Desempate de Hamilton «al mayor receptor».** No es determinista cuando dos receptores empatan en peso, y depende del orden de lectura de la BD: rompe P7 y la reproducibilidad byte a byte. El menor código es arbitrario pero **estable**, que es lo único que se le pide a un desempate.
- **Prorratear una regla anual entre los meses del informe.** Inventaría un devengo que la regla no declara y produciría doce cifras que no cuadran con ningún run. Se prefiere decir la verdad: «pendiente de liquidar, se liquidará el 31-12».
- **`allocationRunId` en singular dentro de `analyticsKey`** (lo que E4-D2 dejó escrito). Un informe anual con reglas mensuales se apoya en 12 runs y en 17 con tres periodicidades: la caché serviría un informe de 11 runs como si tuviera 12. El hash del **conjunto ordenado** es la corrección mínima.
- **`STALE` como estado almacenado.** Obligaría a un `UPDATE` sobre una tabla append-only y a un proceso que lo mantuviera al día; derivarlo comparando los tres sellos es exacto en todo momento y no escribe nada.
- **Guardar la matriz imputada en una tabla.** Doble verdad, exactamente lo que ADR-0003 y ADR-0004 prohíben. La matriz se deriva; lo único persistido es el reparto, que **sí** es una decisión y no un cálculo.
- **Permitir `UPDATE` de una `AllocationRule` con líneas emitidas.** Reescribiría en silencio liquidaciones ya emitidas y haría irreproducible cualquier informe histórico. Se cierra la versión y se abre otra: el coste es una fila más y el beneficio es que el pasado no cambia.

---

## 10. Validación contable

Este diseño incorpora **las diez observaciones** de `docs/design/E5-validacion-liquidacion.md` (veredicto **CONFORME CON OBSERVACIONES**):

| Obs. | Dónde entra |
|---|---|
| O-E5-1 `marginLevel` en la línea | §2.2 `AllocationLine.marginLevel` + CHECK · §3.4 · I-E5-6 · criterio 4 |
| O-E5-2 `sourceShareBps` | §2.2 + CHECK + I-E5-3 · §3.1 paso 7 · criterio 10 · **ADR-0013** |
| O-E5-3 `percentBps` / `driverShareBps` | §2.2 (bps en las dos tablas, sin milésimas en ningún sitio) |
| O-E5-4 `zeroBaseFallback` + `fallbackApplied` | §2.2 · §3.1 · criterio 6 |
| O-E5-5 `amountCents` en el target | §2.2 + CHECK de exclusividad · I-E5-10 · criterio 11 |
| O-E5-6 `fiscalYearId`, `periodKind`, `status`, `lineCount`, `totalAllocatedCents`, run único por periodo | §2.2 + índice único parcial. `STALE` **derivado**, no almacenado (§3.5) |
| O-E5-7 `allocationRunSetHash` | §3.5 · §2.2 (`ReportRun`) · T6 · criterio 17 |
| O-E5-8 CHECKs y triggers de destino único / no imputables / autoarista, `TENANT_MODELS`, sin `DELETE` | §2.3 bloques 3, 6 y 7 · I-E5-5, I-E5-7, I-E5-11 |
| O-E5-9 columnas `BL:` | §3.2 `ColumnKey` · E5-D3 · criterio 2 |
| O-E5-10 `code` único, `name` NOT NULL, índice de orden | §2.2 |

Las cuatro divergencias con otros documentos que el experto señala se corrigen **donde viven**: la skill `fiabilidad` (I5) **ya está corregida**; la skill `contabilidad-analitica` y `E4-analitica.md` §2.5 se corrigen en **T16**; `MODELO-DATOS.md` §Analítica, en **T18** (y en este mismo entregable).

**Consultas pendientes a `experto-contable`**: ninguna. Las tres decisiones de fondo (E5-D1, E5-D2, E5-D3) vienen ya validadas por él y firmadas por Pablo en ADR-0013.
