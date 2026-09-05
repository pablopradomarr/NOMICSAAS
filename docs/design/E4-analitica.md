# E4 — Analítica base (diseño)

**Épica:** E4 · **Nivel:** 2 (ADR-0004 APROBADO; **ADR-0010 PROPUESTO** para la reclasificación analítica y la separación de hashes) · **Depende de:** E3
**Autor:** arquitecto · **Fecha:** 2026-09-05 · **Ronda 2** (validación contable incorporada) · **Estado:** PROPUESTO (pendiente de firma humana de ADR-0010)

Documentos que este diseño da por leídos: `CLAUDE.md`, `docs/ROADMAP.md` (E4), `docs/MODELO-DATOS.md` §Analítica + §Integridad, `docs/adr/0003`, `docs/adr/0004`, `docs/adr/0009`, `docs/ESTADO.md`, `docs/design/E3-libro-diario.md` (§2.2, §2.3 con **D-E3-1**, §2.4, §3.1, §11), `docs/design/E3-asientos-tipo.md` (columna «Destino analítico obligatorio?» de T-01…T-28 y **C-9**), **`docs/design/E4-validacion-analitica.md`** (veredicto **CONFORME CON OBSERVACIONES**, reglas **R-A1…R-A12**, observaciones **O-A1…O-A9**, decisiones **E4-D1/E4-D2**, respuestas §8) y las skills `contabilidad-analitica`, `fiabilidad` (definición única de **I4**), `estados-financieros`, `pgc-npgc` y `ui-erp`.

**Ronda 2 — qué cambió.** El experto contable entregó `docs/design/E4-validacion-analitica.md` con la **matriz esperada sellada** (`docs/design/fixtures/pyg-analitica-esperada.json` + su generador Python), las doce reglas de destino R-A1…R-A12, doce invariantes propios I-E4-1…12 y respuesta a las siete dudas de la ronda 1. Este documento se reescribe sobre eso. Lo que cambia de fondo:

| # | Cambio de la ronda 1 a la ronda 2 | Origen |
|---|---|---|
| 1 | **`ledgerHash` financiero deja de incluir las cuatro columnas analíticas**; `entryHash` sí las incluye y se recalcula al reclasificar; nace **`analyticsHash`** (con `marginConfigHash` dentro). Migración que **recalcula los hashes existentes** con `hashVersion = 2` | **E4-D2** (§8.5, O-A3). Sin esto, reclasificar invalidaría balance, PyG contable, cashflow y diario ya sellados, que no cambian en un céntimo |
| 2 | **Override implícito de `analyticType` por dimensión** (R-A3: `INDIRECTO_CECO` + `projectId` ⇒ `COSTE_DIRECTO_MC2`, **MC2** y no MC3; R-A4: tipo directo + `costCenterId` ⇒ `INDIRECTO_CECO`) | §8.2. La ronda 1 proponía MC3 o rechazo: las dos eran erróneas y el fixture sellado ya contiene el caso (`623` en P-02) |
| 3 | **La columna la fija el tipo efectivo, no la dimensión** (R-A5), y **`CostCenter.marginLevel` solo aplica a `INDIRECTO_CECO`** (R-A6) | §2.1 del experto. Un `668` en `CC-FIN` va a BAI, no a EBITDA |
| 4 | **Las columnas de CECO se agrupan por `kind`**, no una por CECO; las de línea de negocio son agregados de presentación y **no entran en el total** | Esquema sellado de `pyg-analitica-esperada.json` |
| 5 | **`MarginLevelConfig`: `MC3` y `EBITDA` NO listan `INDIRECTO_CECO`** (MLC-2, lo rutea `CostCenter.marginLevel`), gana `validFrom`/`validTo` + `nonAnalyticLevel`, y su hash entra en `analyticsHash` | MLC-1…MLC-5, §8.4 |
| 6 | **`630`/`633`/`638` → `RESULTADO` fijo, no configurable**; el resto de `NO_ANALITICO` → `nonAnalyticLevel`, default **`EBITDA`**, admisibles solo `{EBITDA, EBIT, BAI}` | R-A11, §8.1 |
| 7 | **La columna «Sin destino (anterior a E4)» desaparece**: la migración rutea a `CC-NA` las líneas 6/7 sin dimensión aprovechando que ya recalcula todos los hashes | Consecuencia de 1 + I-E4-1 + esquema sellado de columnas |
| 8 | **El `REVERSAL` hereda el destino y NO pasa `validateAnalytics`**, ni siquiera con proyecto cerrado o CECO archivado | §8.7, I-E4-11 |
| 9 | Nuevos invariantes **I-E4-4** (`NO_ANALITICO` sin dimensión), **I-E4-5** (sin dimensión fuera de 6/7), **I-E4-11** (contra-asiento con dimensión espejo), **I-E4-12** (rectificativa con la dimensión del rectificado) | §5.2 del experto |
| 10 | **T-test byte a byte** contra `pyg-analitica-esperada.json`, con `--check` del generador en CI | §7 del experto |

Se cierran así las siete dudas de la ronda 1 (§9.3 anterior). El veredicto y los descartes razonados están en §10.

---

## 1. Objetivo y alcance

E4 da cuerpo a las tres dimensiones analíticas (`BusinessLine`, `Project`, `CostCenter`), activa el destino analítico que E3 dejó implementado e inerte (**C-9**, `ANALYTIC_DIM_UNAVAILABLE`), separa el sello financiero del analítico (`ledgerHash` / `entryHash` / `analyticsHash`, **E4-D2**) y produce la **PyG analítica sin imputaciones**: la matriz `nivel de margen × columna` que el experto ha sellado en `docs/design/fixtures/pyg-analitica-esperada.json`, calculada por función pura, con provenance por celda y el invariante **I4** cuadrando con la PyG contable a tolerancia 0. Retira el `CHECK` `journal_lines_analytics_e4`, añade las FK compuestas por tenant y los CHECK de O-A2, siembra los ocho CECOs por defecto y la `MarginLevelConfig` versionada de cada organización, y sustituye el `Project` heredado de TaxHacker **extendiéndolo en su sitio**.

**No incluye:** imputación/liquidación de CECOs (`AllocationRule/Run/Line`, drivers, cascada, Hamilton, I5) → **E5** (que además hereda la regla R-A12: `74x` con override a `INGRESO_DIRECTO` **se excluye del driver `REVENUE_SHARE`**, y `AllocationRun` gana `analyticsHash`); balance, PyG contable por epígrafes, cashflow y `ReportRun` persistido → **E6** (E4 calcula la cifra de I3 con una función pura que E6 hereda, y deja definida la columna `ReportRun.analyticsHash`, que E6 crea con la tabla); `Budget` y `TimeEntry` → **E10** (con la deuda **O-A6** anotada: el `@@unique` de `Budget` con tres columnas nullables no impide duplicados en PostgreSQL); `Counterparty` como tabla propia → **E8**; pestaña Auditoría → **E7** (E4 aporta sus checks al motor, no la pantalla); propuesta analítica desde OCR → **E8**.

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

Todo en snake_case físico (`@@map`/`@map`) — **O-A5**: el bloque §Analítica de `MODELO-DATOS.md` no lo declaraba en ninguno de sus 14 modelos y sin él las políticas RLS, los triggers y el SQL de los invariantes no encuentran las tablas; este diseño lo corrige y la ronda 2 lo escribe también en `MODELO-DATOS.md`. Ids uuid, dinero `Int` céntimos, agregados en `BigInt`, fechas contables `@db.Date`, `DateTime` solo para auditoría técnica. `organizationId` en las cuatro tablas nuevas y `@@unique([organizationId, id])` en las tres de dimensiones, **destino de las FK compuestas** desde `journal_lines` (mismo patrón que la FK de `accounts` de E2). Nada se borra: se archiva.

### 2.2 Fragmento Prisma

```prisma
enum ProjectStatus {
  PLANNED
  ACTIVE
  CLOSED

  @@map("project_status")
}

enum CostCenterKind {
  MARKETING_VENTAS
  OPERACIONES_INDIRECTAS
  G_A
  DESARROLLO_PRODUCTO
  FINANCIERO
  EXTRAORDINARIO
  OTROS
  SIN_ASIGNAR

  @@map("cost_center_kind")
}

enum MarginLevel {
  INGRESOS
  MC1
  MC2
  MC3
  EBITDA
  EBIT
  BAI
  RESULTADO

  @@map("margin_level")
}

model BusinessLine {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String       @db.VarChar(24)
  name           String       @db.VarChar(120)
  color          String       @default("#0A0A0A") @db.VarChar(9)
  sortOrder      Int          @default(0) @map("sort_order")
  isActive       Boolean      @default(true) @map("is_active")
  archivedAt     DateTime?    @map("archived_at")
  /// Sembrada por la organización y no borrable: destino del backfill de E4.
  isSystem       Boolean      @default(false) @map("is_system")
  createdAt      DateTime     @default(now()) @map("created_at")
  updatedAt      DateTime     @updatedAt @map("updated_at")

  projects Project[]
  lines    JournalLine[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])   // destino de la FK compuesta desde journal_lines
  @@index([organizationId, isActive, sortOrder])
  @@map("business_lines")
}

/// **D-E4-1.** NO es una tabla nueva: es el `Project` heredado de TaxHacker
/// (`@@map("projects")`, ya en `TENANT_MODELS` y bajo RLS desde E1) al que E4
/// añade columnas. `Transaction.projectCode` y toda la UI heredada siguen
/// funcionando sin tocar una línea.
model Project {
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String        @map("organization_id") @db.Uuid
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String
  color          String        @default("#000000")
  llm_prompt     String?
  transactions   Transaction[]
  createdAt      DateTime      @default(now()) @map("created_at")

  // ── E4 ────────────────────────────────────────────────────────────────────
  businessLineId     String        @map("business_line_id") @db.Uuid
  businessLine       BusinessLine  @relation(fields: [organizationId, businessLineId], references: [organizationId, id], onDelete: Restrict)
  /// E8 crea `Counterparty`; hasta entonces, columna sin FK (patrón §2.3 de E3).
  counterpartyId     String?       @map("counterparty_id") @db.Uuid
  status             ProjectStatus @default(ACTIVE)
  startDate          DateTime?     @map("start_date") @db.Date
  endDate            DateTime?     @map("end_date") @db.Date
  /// O-A8: sin fecha de cierre, I-E4-10 no es comprobable.
  closedAt           DateTime?     @map("closed_at") @db.Date
  closedById         String?       @map("closed_by_id") @db.Uuid
  budgetRevenueCents Int?          @map("budget_revenue_cents")
  budgetCostCents    Int?          @map("budget_cost_cents")
  sortOrder          Int           @default(0) @map("sort_order")
  isActive           Boolean       @default(true) @map("is_active")
  archivedAt         DateTime?     @map("archived_at")
  updatedAt          DateTime      @updatedAt @map("updated_at")

  lines JournalLine[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@index([organizationId, businessLineId])
  @@index([organizationId, status, isActive])
  @@map("projects")
}

model CostCenter {
  id             String         @id @default(uuid()) @db.Uuid
  organizationId String         @map("organization_id") @db.Uuid
  organization   Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String         @db.VarChar(24)
  name           String         @db.VarChar(120)
  kind           CostCenterKind
  /// Nivel en el que se descuenta. Solo MC3 | EBITDA (CHECK en BD, §2.7).
  /// R-A6: **solo aplica a líneas con tipo efectivo `INDIRECTO_CECO`**.
  marginLevel    MarginLevel    @map("margin_level")
  /// Si E5 puede repartirlo. CC-FIN, CC-EXT y CC-NA: false (§8.6 del experto).
  allocatable    Boolean        @default(true)
  sortOrder      Int            @default(0) @map("sort_order")
  isActive       Boolean        @default(true) @map("is_active")
  archivedAt     DateTime?      @map("archived_at")
  /// O-A8, simétrico a `LedgerAccount`: distingue lo sembrado de lo del usuario.
  origin         AccountOrigin  @default(MANUAL)
  /// `SIN_ASIGNAR` es de sistema: ni se borra, ni se archiva, ni cambia de kind.
  isSystem       Boolean        @default(false) @map("is_system")
  createdAt      DateTime       @default(now()) @map("created_at")
  updatedAt      DateTime       @updatedAt @map("updated_at")

  lines JournalLine[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@index([organizationId, isActive, sortOrder])
  @@index([organizationId, kind])
  @@map("cost_centers")
}

/// O-A7 + §8.4: versionada **y** hasheada. `validFrom`/`validTo` conservan el
/// histórico (un ejercicio cerrado reimprime su PyG analítica con la
/// configuración que tenía); el hash, dentro de `analyticsHash`, impide servir
/// un informe cacheado con la configuración equivocada. Resuelven problemas
/// distintos y por eso están las dos.
model MarginLevelConfig {
  id             String         @id @default(uuid()) @db.Uuid
  organizationId String         @map("organization_id") @db.Uuid
  organization   Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  level          MarginLevel
  label          String         @db.VarChar(60)
  /// MLC-2: `MC3` y `EBITDA` van SIEMPRE vacíos — `INDIRECTO_CECO` se rutea por
  /// `CostCenter.marginLevel` (R-A7). Listarlo aquí lo contaría dos veces.
  analyticTypes  AnalyticType[] @map("analytic_types")
  sortOrder      Int            @map("sort_order")
  isVisible      Boolean        @default(true) @map("is_visible")
  /// La configuración vigente se elige por la **fecha del periodo del informe**,
  /// no por la de ejecución (§8.4).
  validFrom      DateTime       @map("valid_from") @db.Date
  validTo        DateTime?      @map("valid_to") @db.Date
  updatedAt      DateTime       @updatedAt @map("updated_at")

  @@unique([organizationId, level, validFrom])
  @@index([organizationId, validFrom, validTo])
  @@map("margin_level_configs")
}

/// MLC-5 / R-A11: el desdoblamiento de `NO_ANALITICO` es política de
/// organización, no de fila, así que vive en `Organization` y no en la tabla
/// anterior. Admisibles: EBITDA (default) | EBIT | BAI. Nunca INGRESOS/MC1/MC2/MC3.
model Organization {
  // `analyticsRequired Boolean @default(true)` ya existe desde E1; E3 la ignoraba
  // (D-E3-1) y E4 la lee: es la regla de destino (R-A8).
  nonAnalyticLevel   MarginLevel @default(EBITDA) @map("non_analytic_level")
  businessLines      BusinessLine[]
  costCenters        CostCenter[]
  marginLevelConfigs MarginLevelConfig[]
}

model JournalLine {
  // … campos de E3 …
  /// E4: las tres columnas ganan FK COMPUESTA por tenant (O-A1) y pierden el
  /// CHECK `journal_lines_analytics_e4`.
  projectId      String?       @map("project_id") @db.Uuid
  project        Project?      @relation(fields: [organizationId, projectId], references: [organizationId, id], onDelete: Restrict)
  costCenterId   String?       @map("cost_center_id") @db.Uuid
  costCenter     CostCenter?   @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)
  businessLineId String?       @map("business_line_id") @db.Uuid
  businessLine   BusinessLine? @relation(fields: [organizationId, businessLineId], references: [organizationId, id], onDelete: Restrict)
  /// R-A2: tipo **efectivo** ya resuelto y persistido (override del usuario,
  /// override implícito R-A3/R-A4, o default de la cuenta). Lo que se guarda es
  /// lo que la matriz usa: la matriz nunca vuelve a decidir.
  analyticType   AnalyticType? @map("analytic_type")

  @@index([organizationId, projectId, entryDate])
  @@index([organizationId, costCenterId, entryDate])
  @@index([organizationId, businessLineId, entryDate])
}

model JournalEntry {
  // … campos de E3 …
  /// E4-D2: `entryHash` sigue cubriendo TODAS las columnas de la línea,
  /// dimensiones incluidas, y se recalcula al reclasificar. `hashVersion`
  /// documenta con qué forma canónica se generó: 1 = E3, 2 = E4.
  entryHash   String @map("entry_hash")
  hashVersion Int    @default(2) @map("hash_version")
}
```

`lib/db.ts` → `TENANT_MODELS` += `"BusinessLine"`, `"CostCenter"`, `"MarginLevelConfig"` (`"Project"` ya está desde E1). ESLint `BUSINESS_DELEGATES` += `businessLine`, `costCenter`, `marginLevelConfig`.

### 2.3 D-E4-1 — El `Project` heredado se extiende, no se sustituye

`MODELO-DATOS.md` dice «`Project` heredado se sustituye por el `Project` analítico». **Se cumple el resultado sin recrear la tabla**: el modelo heredado ya tiene exactamente la identidad que el analítico necesita (`id` uuid, `organizationId`, `code`, `@@unique([organizationId, code])`, RLS activa, `TENANT_MODELS`), y E4 solo le añade columnas. Motivos:

- `Transaction.projectCode` es una **FK real** `(project_code, organization_id) → projects(code, organization_id)`. Recrear la tabla obliga a soltarla, migrar y volver a atarla, con `transactions` de por medio.
- Ocho ficheros de UI heredada (`components/transactions/{filters,edit,new,list,create}.tsx`, `components/export/transactions.tsx`, `components/unsorted/analyze-form.tsx`, `components/dashboard/projects-widget.tsx`) y cinco de datos (`models/{projects,transactions,stats,backups,export_and_import}.ts`) filtran por `projectCode`. Extendiendo la tabla **ninguno cambia**: el proyecto analítico ES el proyecto de la operación, que es justo lo que E8 necesita.
- `color` y `llm_prompt` no sobran: `ui-erp` pide color por dimensión y `llm_prompt` es la pista que E8 dará al extractor para proponer destino.

**Migración de datos**, en el orden de ADR-0009 §7 (marca → `NO FORCE` → backfill → `FORCE`): crear las tres tablas con RLS estricta; sembrar la LN `GENERAL` (`isSystem`) en cada organización con proyectos; añadir `business_line_id` nullable, backfillear, `SET NOT NULL` y atar la FK compuesta; `status = ACTIVE`; sembrar los ocho CECOs y la `MarginLevelConfig` (`validFrom` = inicio del ejercicio más antiguo de la organización, o `1970-01-01` si no tiene) en toda organización con plan sembrado, y cablear la siembra en `createOrganizationWithOwner` (misma transacción que el plan, como hizo E3).

**Qué se mueve de sitio en la UI.** `/settings/projects` (CRUD heredado, en inglés, sin línea de negocio) queda sustituido por `/analytics/projects`; la ruta antigua pasa a `redirect()` permanente y sale del `side-nav` de configuración. `deleteProjectAction` deja de borrar en cuanto el proyecto tenga líneas de diario.

### 2.4 D-E4-2 — Regla de destino, tipo efectivo y denormalización

**Tipo analítico efectivo (R-A2), por precedencia**, resuelto **al postear** y persistido en la línea:

1. `JournalLine.analyticType` informado por el usuario o la plantilla.
2. **Override implícito por dimensión**: `INDIRECTO_CECO` + `projectId` ⇒ **`COSTE_DIRECTO_MC2`** (**R-A3**); tipo directo (`INGRESO_DIRECTO`, `COSTE_DIRECTO_MC1`, `COSTE_DIRECTO_MC2`) + `costCenterId` ⇒ **`INDIRECTO_CECO`** (**R-A4**). Automático y **sin WARN**: informar la dimensión ya es la declaración de intención. Lo que queda trazado es el tipo efectivo, que se persiste y entra en `analyticsHash`.
3. `LedgerAccount.analyticType` de la organización (default de `seeds/npgc.csv`, con **herencia de hoja**: `6080 → 608 → COSTE_DIRECTO_MC1`, `6300 → 630 → NO_ANALITICO`).

R-A3 es la corrección de fondo de la ronda 2: un alquiler de obra o un subcontratista técnico de un proyecto **no es estructura**, es coste directo de ejecución, y va a **MC2**, no a MC3. Rechazar la combinación era además inviable: el fixture sellado de E3 la contiene (`623` con `projectCode = P-02`, 150 000 c).

**Regla de destino (C-9, activada).** Línea de grupo 6/7 con tipo efectivo ≠ `NO_ANALITICO` ⇒ **exactamente uno** de `projectId` / `costCenterId`. Con `analyticsRequired = true` (default) faltar el destino **bloquea el asiento** (`ANALYTIC_DEST_MISSING`); con `false`, el motor **rutea a `CC-NA`** (`SIN_ASIGNAR`) y la Auditoría lo lista como WARN con importe y nº de líneas (**R-A8**). Una línea a NULL sería invisible en todas las columnas; `CC-NA` es explícito, se ve y se puede reclasificar.

**Prohibiciones simétricas.** Grupos 1–5 **nunca** llevan dimensión ni `analyticType` (**R-A1**, **I-E4-5**, CHECK en BD). Tipo efectivo `NO_ANALITICO` **nunca** lleva dimensión, en particular `630` (**I-E4-4**): se rechaza al postear, no se «arregla» en silencio al calcular la matriz.

**`businessLineId`: lo escribe el código, lo verifica la base, y no se recalcula nunca (R-A9).** El motor lo copia del proyecto **en el alta de la línea**; un trigger `journal_lines_business_line_denorm` comprueba y **lanza** si no coincide, y exige NULL cuando no hay proyecto. No se usa un trigger que *rellene*: `entryHash` se calcula en el motor **antes** del INSERT y esa columna entra en su forma canónica, así que un trigger que la cambiase en silencio produciría un asiento cuyo sello no coincide con su contenido (I-E3-7 en FAIL). Corolario de R-A9: si un proyecto cambia de línea de negocio, **los informes de periodos anteriores no cambian**; mover las líneas ya escritas es una reclasificación en masa (§2.6), no un `UPDATE` de la ficha.

**Las líneas de E3 sin dimensión se rutean a `CC-NA` en la migración.** La ronda 1 proponía dejarlas a NULL con una columna «Sin destino (anterior a E4)». Ya no hace falta y además sobra: (a) la migración de E4 **recalcula todos los hashes** de todos modos por E4-D2 (§2.5), así que el backfill es gratis; (b) el esquema de columnas de la matriz está **sellado** en `pyg-analitica-esperada.json` y no contiene esa columna — mantenerla rompería el test byte a byte; (c) I-E4-1 exige cobertura total. No hay ningún despliegue con diario posteado, así que en la práctica el backfill afecta a cero filas y la migración lo registra.

### 2.5 E4-D2 — `ledgerHash` financiero, `entryHash` de fila y `analyticsHash` *(decisión cerrada)*

**Problema.** E3 metió las cuatro columnas analíticas en la forma canónica de `ledgerHash` (`lib/ledger/hash.ts`). Con la reclasificación admitida (§2.6), reimputar un gasto de un proyecto a otro **cambiaría el `ledgerHash` del periodo** e invalidaría el balance, la PyG contable, el cashflow y el libro diario ya sellados — que no han cambiado en un solo céntimo. Eso es exactamente lo que P3 y P7 de SPEC-FIABILIDAD prohíben, y es lo que la ronda 1 tenía mal (la enmienda del experto a la salvaguarda 5 de ADR-0010, §8.5).

**Decisión.** Tres sellos con tres oficios distintos:

| Sello | Contenido (líneas del periodo, orden canónico `(entryDate, entryNumber, lineNo)`) | Cambia con |
|---|---|---|
| **`ledgerHash`** *(financiero)* | `(entryId, lineNo, accountCode, debitCents, creditCents, entryDate, fiscalYearId, entryKind, taxRateId)` — **sin** las cuatro columnas analíticas | Cualquier asiento nuevo, contra-asiento o cambio contable. **No** cambia al reclasificar |
| **`entryHash`** *(de fila)* | **Todas** las columnas de las líneas del asiento, dimensiones incluidas | Cualquier cosa del asiento, reclasificación incluida: **se recalcula** en la misma transacción y I-E3-7 sigue en PASS |
| **`analyticsHash`** *(nuevo)* | `(entryId, lineNo, projectId, costCenterId, businessLineId, analyticType)` **+** `marginConfigHash` **+** `allocationRunId` vigente (E5) | Reclasificación, cambio de `MarginLevelConfig`, cambio de `analyticType` de una cuenta, nueva liquidación |

Efecto colateral valioso: el `ledgerHash` deja de depender de datos de gestión, así que dos organizaciones con el mismo diario y distinta analítica producen el mismo sello financiero y las verificaciones de I1–I3 son comparables.

**`hashVersion = 2` y recálculo del histórico.** `ledgerHash` cambia de forma canónica, lo que en circunstancias normales sería inaceptable (E3 §2.3 compró precisamente eso). Se puede hacer ahora y solo ahora porque **no hay datos en producción**: el único diario existente es el fixture, que se carga entero de nuevo. La migración recalcula `journal_entries.entry_hash` con la forma v2 bajo el patrón `NO FORCE` → recálculo → `FORCE` (marca **antes** del backfill, runbook de `ESTADO.md`), escribe `hash_version = 2` en todas las filas y deja la columna con `DEFAULT 2`. Queda documentado en `ESTADO.md` y en `lib/ledger/hash.ts`: **v1 no vuelve a emitirse y v2 no se toca nunca más**; cualquier cambio futuro de forma exige versión nueva y convivencia, no reescritura.

**Consecuencias que E4 deja preparadas y E6/E5 consumen:** `ReportRun.analyticsHash String?` (obligatorio por CHECK condicional para `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD`; `NULL` para los financieros) y clave de reutilización `(organizationId, type, ledgerHash, analyticsHash)`; `AllocationRun.analyticsHash String` en E5.

### 2.6 D-E4-3 — Reclasificación analítica de una línea posteada: **permitida** (ADR-0010, Nivel 2)

**Decisión E4-D1, confirmada por el experto (§3.3 de su documento): sí, con ceremonia.** Cambia `project_id` / `cost_center_id` / `business_line_id` / `analytic_type` de una o varias líneas **sin tocar el diario financiero** (cuenta, importe, fecha, número, contrapartida, impuesto y vencimiento son inmutables) y queda en `AuditLog` con motivo obligatorio.

**Justificación.** La dimensión analítica **no es partida doble** y **no es libro obligatorio**: los libros que el art. 25.1 CdC impone son el de inventarios y cuentas anuales y el diario; la contabilidad de costes no se legaliza (art. 27 CdC) ni se deposita, y el art. 29.1 CdC protege el registro del hecho económico — importe, cuenta, fecha, contrapartida —, ninguno de los cuales se mueve. Las alternativas son peores y verificablemente peores: *anular y volver a postear* mete pares que netean cero, consume dos números por corrección, choca con I-E3-2 a la segunda y ensucia el mayor con lo que no son hechos económicos (ADR-0004 ya descartó los asientos de grupo 9 por esto); *no permitirlo* deja la analítica mal para siempre en cuanto alguien se equivoca de proyecto — el error más frecuente, porque la información de a qué proyecto pertenece un gasto **llega sistemáticamente tarde**.

**Salvaguardas (las cinco obligatorias, cada una con test):**

| # | Salvaguarda | Dónde |
|---|---|---|
| 1 | **Solo las cuatro columnas analíticas.** `GRANT UPDATE ("project_id","cost_center_id","business_line_id","analytic_type") ON journal_lines TO app_runtime` — nada más — y trigger `journal_lines_only_analytics_update` que lanza si cualquier otra columna cambia (el propietario esquiva los GRANT; el trigger no) | migración §2.7 |
| 2 | **El sello de fila se rehace, no se rompe.** `entry_hash` se recalcula en la misma transacción (`GRANT UPDATE ("entry_hash") ON journal_entries`), de modo que I-E3-7 sigue en PASS; ambos hashes van al `AuditLog` | `models/analytics.reclassifyLines` |
| 3 | **Traza obligatoria.** `AuditLog(entity="JournalLine", action="RECLASSIFY_ANALYTICS", before, after, reason, userId)` en la misma transacción, `reason` ≥ 10 caracteres (C-R3) | `forms/analytics.ts` + acción |
| 4 | **Ventana.** Ejercicio `OPEN` y mes abierto: `EDITOR`. Mes bloqueado del ejercicio abierto: **`ADMIN` con motivo** — el `PeriodLock` congela la cifra rendida, y ninguna de las cuatro (diario, saldos, 303, balance) se mueve. Ejercicio `CLOSED`: **nunca, sin excepción de rol** (arts. 253, 272 y 279 LSC). Proyecto destino no `CLOSED` y CECO destino activo (C-R4) | `checkReclassify` (puro) + trigger de ventana |
| 5 | **Caduca solo lo analítico** *(corregido en ronda 2 por §8.5 del experto)*. `ledgerHash` **no cambia** (E4-D2), así que los `ReportRun` financieros siguen vigentes; cambia `analyticsHash`, que caduca únicamente `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD` (quedan históricos, nunca se sobrescriben) e invalida los `AllocationRun` del periodo (`supersededById`, E5). La Auditoría lista nº de reclasificaciones, importe reclasificado y runs invalidados | E5/E6 lo persisten; E4 deja el check y `ManualReviewFlag` |

Como esto **sí se aparta de la postura de inmutabilidad total de ADR-0003 y de la migración de E3** (que revocó todo `UPDATE` sobre `journal_lines`), y como E4-D2 cambia la forma canónica de `ledgerHash`, se escribe **`docs/adr/0010-reclasificacion-analitica.md`**, estado `PROPUESTO`. **No se codifica hasta que esté firmado.** ADR-0004 no se toca.

### 2.7 SQL de integridad (migración `20260908100000_e4_analytics`)

```sql
-- 0. Marca de conversión ANTES de cualquier backfill (runbook de ESTADO.md, #7b de E3).
INSERT INTO app.migration_markers(key) VALUES ('e4_analytics_backfill') ON CONFLICT DO NOTHING;

-- 1. Tablas nuevas + RLS estricta (ADR-0009).
--    CREATE TABLE business_lines / cost_centers / margin_level_configs …
SELECT app.enforce_tenant_rls('business_lines');
SELECT app.enforce_tenant_rls('cost_centers');
SELECT app.enforce_tenant_rls('margin_level_configs');
GRANT SELECT, INSERT, UPDATE ON "business_lines","cost_centers","margin_level_configs" TO app_runtime;
-- Sin DELETE: nada se borra, se archiva. El borrado real de una dimensión sin
-- líneas ni transacciones lo hace `app_maintenance` desde scripts/.

ALTER TABLE cost_centers
  ADD CONSTRAINT cost_centers_margin_level CHECK (margin_level IN ('MC3','EBITDA')),
  ADD CONSTRAINT cost_centers_unassigned_is_system
    CHECK (kind <> 'SIN_ASIGNAR' OR (is_system AND NOT allocatable AND is_active));

ALTER TABLE margin_level_configs
  ADD CONSTRAINT margin_level_configs_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- MLC-2: MC3 y EBITDA reciben INDIRECTO_CECO por `CostCenter.marginLevel`,
  -- jamás por lista: listarlo contaría el importe dos veces.
  ADD CONSTRAINT margin_level_configs_no_indirect_list
    CHECK (level NOT IN ('MC3','EBITDA') OR NOT ('INDIRECTO_CECO' = ANY(analytic_types))),
  ADD CONSTRAINT margin_level_configs_indirect_only_ceco
    CHECK (level IN ('MC3','EBITDA') OR NOT ('INDIRECTO_CECO' = ANY(analytic_types)));
-- Sin solape de vigencias por (organización, nivel): btree_gist ya está desde E2.
ALTER TABLE margin_level_configs
  ADD CONSTRAINT margin_level_configs_no_overlap
  EXCLUDE USING gist (organization_id WITH =, level WITH =,
                      daterange(valid_from, valid_to, '[]') WITH &&);

-- MLC-5: el desdoblamiento de NO_ANALITICO nunca contamina los márgenes de proyecto.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_non_analytic_level
  CHECK (non_analytic_level IN ('EBITDA','EBIT','BAI'));

ALTER TABLE projects
  ADD CONSTRAINT projects_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT projects_closed_has_date CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL),
  ADD CONSTRAINT projects_budget_nonneg
    CHECK ((budget_revenue_cents IS NULL OR budget_revenue_cents >= 0)
       AND (budget_cost_cents    IS NULL OR budget_cost_cents    >= 0));

-- 2. Backfill bajo FORCE (patrón obligatorio de CLAUDE.md / ADR-0009 §7).
ALTER TABLE business_lines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_centers   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE margin_level_configs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE projects       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_lines  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries NO FORCE ROW LEVEL SECURITY;
--   2a. LN GENERAL por organización con proyectos
--   2b. projects.business_line_id + status ACTIVE
--   2c. los 8 CECOs por defecto (§2.8)
--   2d. las 8 filas de MarginLevelConfig con valid_from = inicio del ejercicio
--       más antiguo de la organización (o 1970-01-01)
--   2e. §2.4: líneas 6/7 con analytic_type <> 'NO_ANALITICO' y sin dimensión
--       → cost_center_id = CC-NA de su organización (0 filas hoy; se registra)
--   2f. E4-D2: recálculo de journal_entries.entry_hash con la forma v2 y
--       hash_version = 2 en todas las filas
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_lines  FORCE ROW LEVEL SECURITY;
ALTER TABLE projects       FORCE ROW LEVEL SECURITY;
ALTER TABLE margin_level_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_centers   FORCE ROW LEVEL SECURITY;
ALTER TABLE business_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE projects ALTER COLUMN business_line_id SET NOT NULL;
ALTER TABLE projects
  ADD CONSTRAINT projects_business_line_fk
  FOREIGN KEY (organization_id, business_line_id)
  REFERENCES business_lines(organization_id, id) ON DELETE RESTRICT;

-- 3. journal_lines: fuera el CHECK de E3, dentro las FK compuestas (O-A1).
ALTER TABLE journal_lines DROP CONSTRAINT journal_lines_analytics_e4;

ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT journal_lines_cost_center_fk FOREIGN KEY (organization_id, cost_center_id)
    REFERENCES cost_centers(organization_id, id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT journal_lines_business_line_fk FOREIGN KEY (organization_id, business_line_id)
    REFERENCES business_lines(organization_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_project_fk;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_cost_center_fk;
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_business_line_fk;

-- O-A2 · I-E4-2 e I-E4-5, las dos barreras que faltaban.
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_analytic_dest_xor
    CHECK (project_id IS NULL OR cost_center_id IS NULL),
  ADD CONSTRAINT journal_lines_business_line_needs_project
    CHECK (business_line_id IS NULL OR project_id IS NOT NULL),
  ADD CONSTRAINT journal_lines_analytics_only_pnl
    CHECK (left(account_code, 1) IN ('6','7')
           OR (project_id IS NULL AND cost_center_id IS NULL
               AND business_line_id IS NULL AND analytic_type IS NULL));

-- 4. Coherencia de la denormalización (R-A9): el código la escribe, la base la
--    VERIFICA. Nunca la rellena: rompería `entry_hash`.
CREATE OR REPLACE FUNCTION app.journal_lines_business_line_denorm() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_bl uuid;
BEGIN
  IF NEW.project_id IS NULL THEN
    IF NEW.business_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'línea % con línea de negocio pero sin proyecto', NEW.line_no
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT business_line_id INTO v_bl FROM projects
   WHERE organization_id = NEW.organization_id AND id = NEW.project_id;
  IF v_bl IS DISTINCT FROM NEW.business_line_id THEN
    RAISE EXCEPTION 'línea %: línea de negocio % no coincide con la del proyecto (%)',
      NEW.line_no, NEW.business_line_id, v_bl USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_business_line_denorm
  BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_business_line_denorm();
-- Nota R-A9: en un UPDATE de reclasificación el trigger compara contra la LN
-- ACTUAL del proyecto destino, que es lo correcto — la línea se está reasignando
-- ahora. Lo que nunca ocurre es un recálculo masivo al mover un proyecto de LN.

-- 5. Reclasificación analítica (SOLO si ADR-0010 se firma; si no, este bloque no
--    entra y `journal_lines` se queda sin ningún GRANT UPDATE).
GRANT UPDATE ("project_id","cost_center_id","business_line_id","analytic_type")
  ON journal_lines TO app_runtime;
GRANT UPDATE ("entry_hash") ON journal_entries TO app_runtime;

CREATE OR REPLACE FUNCTION app.journal_lines_only_analytics_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.entry_id, NEW.line_no, NEW.account_code,
      NEW.debit_cents, NEW.credit_cents, NEW.description, NEW.tax_rate_id,
      NEW.tax_base_cents, NEW.counterparty_id, NEW.due_date, NEW.entry_date,
      NEW.fiscal_year_id, NEW.entry_kind)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.entry_id, OLD.line_no, OLD.account_code,
      OLD.debit_cents, OLD.credit_cents, OLD.description, OLD.tax_rate_id,
      OLD.tax_base_cents, OLD.counterparty_id, OLD.due_date, OLD.entry_date,
      OLD.fiscal_year_id, OLD.entry_kind)
  THEN
    RAISE EXCEPTION 'una línea posteada solo admite reclasificación analítica (ADR-0010)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_only_analytics_update
  BEFORE UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_only_analytics_update();

-- Ventana (C-R2): nunca con el ejercicio cerrado. El mes bloqueado lo autoriza
-- la acción con rol ADMIN; aquí se corta lo que ningún rol puede hacer.
CREATE OR REPLACE FUNCTION app.journal_lines_reclassify_window() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status::text INTO v_status FROM fiscal_years WHERE id = NEW.fiscal_year_id;
  IF v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'el ejercicio está cerrado: su analítica no se reclasifica'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_reclassify_window
  BEFORE UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_reclassify_window();

-- 6. Índices de apoyo a los checks de Auditoría.
CREATE INDEX journal_lines_no_analytic_dest
  ON journal_lines (organization_id, entry_date)
  WHERE project_id IS NULL AND cost_center_id IS NULL;
```

### 2.8 Semillas por organización (funciones puras + siembra transaccional)

**Ocho CECOs por defecto** (`lib/analytics/seed.ts` → `defaultCostCenters()`, pura; `createMany` en la misma transacción que el plan de cuentas; `origin = SEED`):

| `code` | Nombre | `kind` | `marginLevel` | `allocatable` | `isSystem` |
|---|---|---|---|---|---|
| `CC-OPS` | Operaciones indirectas | `OPERACIONES_INDIRECTAS` | `MC3` | sí | no |
| `CC-DEV` | Desarrollo de producto | `DESARROLLO_PRODUCTO` | `MC3` | sí | no |
| `CC-MKT` | Marketing y ventas | `MARKETING_VENTAS` | `EBITDA` | sí | no |
| `CC-GA` | General y administración | `G_A` | `EBITDA` | sí | no |
| `CC-FIN` | Financiero | `FINANCIERO` | `EBITDA` *(irrelevante: R-A6)* | **no** | no |
| `CC-EXT` | Otros extraordinarios | `EXTRAORDINARIO` | `EBITDA` *(irrelevante)* | **no** | no |
| `CC-OTR` | Otros | `OTROS` | `EBITDA` | sí | no |
| `CC-NA` | Sin asignar | `SIN_ASIGNAR` | `EBITDA` | **no** | **sí** |

Tres no imputables por razones distintas y las tres firmes (§8.6): `CC-FIN` y `CC-EXT` porque su importe se descuenta **por debajo de EBIT** y repartirlo lo metería en MC3, con lo que el EBITDA de la compañía dependería de la estructura de financiación — que es justo lo que el EBITDA existe para aislar; `CC-NA` porque repartir lo que no se sabe imputar convierte un error visible en uno invisible. `CC-EXT` **se siembra siempre** aunque quede a cero con el seed de fábrica (R-A10). El caso de la comisión bancaria de un proyecto concreto **no necesita reparto**: se postea `626`/`669` con `projectId` y R-A3 la deja en MC2 del proyecto.

**`MarginLevelConfig` por defecto** (`defaultMarginLevels()`, pura), idéntica a `marginLevelConfig` del JSON sellado:

| `level` | `label` | `analyticTypes` | `sortOrder` |
|---|---|---|---|
| `INGRESOS` | Ingresos de proyecto | `[INGRESO_DIRECTO]` | 1 |
| `MC1` | Margen de contribución 1 (tras aprovisionamiento) | `[COSTE_DIRECTO_MC1]` | 2 |
| `MC2` | Margen de contribución 2 (tras costes directos) | `[COSTE_DIRECTO_MC2]` | 3 |
| `MC3` | Margen de contribución 3 (tras estructura operativa) | **`[]`** — CECOs con `marginLevel = MC3` | 4 |
| `EBITDA` | EBITDA | **`[]`** — CECOs con `marginLevel = EBITDA` | 5 |
| `EBIT` | EBIT (tras amortizaciones y deterioros) | `[AMORTIZACION_DETERIORO]` | 6 |
| `BAI` | Resultado antes de impuestos | `[FINANCIERO, EXTRAORDINARIO]` | 7 |
| `RESULTADO` | Resultado del ejercicio | `[NO_ANALITICO]`, del que `630`/`633`/`638` es **fijo** | 8 |

Reglas del propio `MarginLevelConfig`: **MLC-1** cada `AnalyticType` aparece exactamente una vez; **MLC-2** `MC3`/`EBITDA` nunca listan `INDIRECTO_CECO`; **MLC-3** los 8 niveles existen siempre (se edita `label`, `isVisible` y el reparto de tipos; no se borra ni se añade un nivel); **MLC-4** cambiarla abre una versión nueva (`validTo` de la anterior) y cambia `analyticsHash`; **MLC-5** `NO_ANALITICO` se parte por R-A11 y `Organization.nonAnalyticLevel` solo admite `{EBITDA, EBIT, BAI}`.

**`analyticType` por cuenta (O-A9).** Cambiar `LedgerAccount.analyticType` mueve importe entre niveles en todos los periodos abiertos, así que se le aplica la misma regla que E2 dio a `epigraph` (R-10b): **ADMIN + motivo + `AuditLog`**, prohibido si la cuenta tiene líneas en un ejercicio `CLOSED`, y siempre dentro de `analyticsHash`.

---

## 3. Motor / funciones puras (`lib/analytics/`)

Módulos **puros**: sin IO, sin Prisma, sin LLM, sin `Date.now()` (el hook `.claude/hooks/guard.sh` lo verifica). Reciben las líneas ya leídas por `models/`. Agregados en `BigInt`, líneas en `Int`.

### 3.1 Tipos (`lib/analytics/types.ts`)

```ts
/** Línea del diario tal y como la ve la analítica. Superconjunto de ReportLine. */
export type AnalyticLine = {
  id?: string
  entryId: string; entryNumber: number; entryDate: LocalDate
  entryKind: EntryKind; fiscalYearId: string; lineNo: number
  accountCode: string; debitCents: Cents; creditCents: Cents
  /** Tipo EFECTIVO ya resuelto y persistido al postear (R-A2). */
  analyticType: AnalyticType | null
  projectId: string | null; costCenterId: string | null; businessLineId: string | null
}

export type BusinessLineRef = { id; code; name; sortOrder; isActive }
export type ProjectRef = { id; code; name; businessLineId; status; sortOrder; isActive }
export type CostCenterRef = {
  id; code; name; kind: CostCenterKind
  marginLevel: Extract<MarginLevel, "MC3" | "EBITDA">
  allocatable: boolean; sortOrder: number; isActive: boolean
}
export type MarginLevelRow = {
  level: MarginLevel; label: string; analyticTypes: readonly AnalyticType[]
  sortOrder: number; isVisible: boolean; validFrom: LocalDate; validTo: LocalDate | null
}

export type AnalyticsConfig = {
  organizationId: string
  /** La vigente para el periodo del informe, elegida por `entryDate` (§8.4). */
  levels: readonly MarginLevelRow[]
  businessLines: readonly BusinessLineRef[]
  projects: readonly ProjectRef[]
  costCenters: readonly CostCenterRef[]
  unassignedCostCenterId: string | null
  analyticTypeByAccount: ReadonlyMap<string, AnalyticType | null>   // con herencia de hoja
  /** R-A11: prefijos del impuesto sobre beneficios. Default ["630","633","638"]. */
  incomeTaxPrefixes: readonly string[]
  /** MLC-5: EBITDA (default) | EBIT | BAI. */
  nonAnalyticLevel: Extract<MarginLevel, "EBITDA" | "EBIT" | "BAI">
}

/**
 * Clave de columna, EXACTAMENTE la del JSON sellado: los CECOs se agrupan por
 * `kind` (una columna por kind, no una por CECO) y los cuatro tipos con columna
 * propia van sueltos. Las columnas de línea de negocio son agregados de
 * presentación y NO pertenecen a este conjunto: sumarlas duplicaría proyectos.
 */
export type ColumnKey =
  | `PROJ:${string}`                       // PROJ:P-01
  | `CECO:${CostCenterKind}`               // CECO:G_A
  | "AMORTIZACION_DETERIORO" | "FINANCIERO" | "EXTRAORDINARIO" | "NO_ANALITICO"
```

### 3.2 Firmas (`lib/analytics/margins.ts`)

```ts
/**
 * R-A2/R-A3/R-A4 — tipo analítico EFECTIVO. Lo usa `post.ts` al construir la
 * línea; la matriz nunca lo recalcula, lee el persistido.
 *   1. override explícito del input
 *   2. INDIRECTO_CECO + projectId ⇒ COSTE_DIRECTO_MC2   (R-A3, sin WARN)
 *      tipo directo + costCenterId ⇒ INDIRECTO_CECO      (R-A4, sin WARN)
 *   3. default de la cuenta, con herencia de hoja
 */
export function resolveEffectiveAnalyticType(
  input: { accountCode: string; analyticType?: AnalyticType | null
           projectId?: string | null; costCenterId?: string | null },
  config: Pick<AnalyticsConfig, "analyticTypeByAccount">
): AnalyticType | null

/**
 * Nivel de margen. Determinista y total.
 *   INDIRECTO_CECO  → CostCenter.marginLevel (MC3 | EBITDA)          (R-A6/R-A7)
 *   NO_ANALITICO    → RESULTADO si la cuenta ∈ incomeTaxPrefixes,
 *                     si no `config.nonAnalyticLevel`                (R-A11)
 *   resto           → por MarginLevelConfig.analyticTypes
 * `CostCenter.marginLevel` NO se aplica a ningún otro tipo: un 668 en CC-FIN
 * cae en BAI, no en EBITDA (R-A6).
 */
export function resolveLevel(line: AnalyticLine, config: AnalyticsConfig): MarginLevel

/**
 * Columna. **La fija el tipo efectivo, no la dimensión** (R-A5). Excepción
 * única: AMORTIZACION_DETERIORO con `projectId` va a la columna del proyecto.
 */
export function resolveColumn(line: AnalyticLine, config: AnalyticsConfig): ColumnKey

/** Aporte: `creditCents − debitCents`. Ingreso +, gasto −, contra-cuentas solas. */
export function contribution(line: AnalyticLine): Cents

/** ¿Entra en la PyG? Grupo 6/7 y `entryKind ∉ {REGULARIZATION, CLOSING, OPENING}` (I3). */
export function isPnlLine(line: AnalyticLine): boolean

/** Cifra de la PyG contable (definición única de I3). **E6 la hereda**. */
export function pnlContableCents(lines: readonly AnalyticLine[]): Cents

/** Núcleo testeable: a qué celda va una línea, sin sumar nada. */
export function classifyLine(line: AnalyticLine, config: AnalyticsConfig):
  { level: MarginLevel; column: ColumnKey; amountCents: Cents }

/**
 * PyG analítica **cumulativa** del periodo: `M[nivel][col] = Σ aportes de los
 * niveles ≤ nivel`. Sin imputaciones (E5). Devuelve además
 * `contributionByLevel` (no cumulativo), los agregados por línea de negocio,
 * `levelTotals`, la provenance por celda y el bloque `checks`.
 * Su serialización canónica debe ser **byte a byte** igual a
 * `docs/design/fixtures/pyg-analitica-esperada.json`.
 */
export function buildAnalyticPnl(
  lines: readonly AnalyticLine[], config: AnalyticsConfig,
  period: AnalyticPeriod, provCtx: ProvenanceContext
): AnalyticPnl

/**
 * % de margen con 1 decimal, en puntos básicos ENTEROS (nada de Float).
 * `null` si los ingresos de la columna son 0: se pinta `—`, nunca `0 %` ni NaN
 * (gap G-05, I-E4-6). Ningún porcentaje se persiste.
 */
export function marginBps(marginCents: Cents, revenueCents: Cents): number | null
```

**Hashes** (`lib/analytics/hash.ts` + cambio en `lib/ledger/hash.ts`, E4-D2 §2.5):

```ts
/** v2: SIN las cuatro columnas analíticas. `hashVersion` = 2. */
export function ledgerHash(lines: readonly HashableLine[]): string
/** Todas las columnas de la línea, dimensiones incluidas. Se recalcula al reclasificar. */
export function entryHash(lines: readonly HashableLine[]): string
/** (entryId, lineNo, projectId, costCenterId, businessLineId, analyticType) + marginConfigHash + allocationRunId. */
export function analyticsHash(lines: readonly AnalyticLine[], marginConfigHash: string, allocationRunId?: string | null): string
export function marginConfigHash(config: AnalyticsConfig): string
```

**Semillas** (`lib/analytics/seed.ts`): `defaultCostCenters()`, `defaultMarginLevels()`, `defaultBusinessLine()`.
**Ventana de reclasificación** (`lib/analytics/reclassify.ts`): `checkReclassify(request, current, ctx) → Result<ResolvedReclassification[]>`, que valida destino (C-9), C-R2 (ventana y rol) y C-R4 (proyecto no `CLOSED`, CECO activo). No toca la BD.

### 3.3 Cambios en `lib/ledger/`

| Fichero | Cambio |
|---|---|
| `types.ts` | `LedgerContext.dimensions` pasa a `{ available: boolean; projects; costCenters; unassignedCostCenterId }`. Errores nuevos: `ANALYTIC_DEST_UNKNOWN`, `ANALYTIC_DEST_BOTH`, `ANALYTIC_DEST_INACTIVE`, `ANALYTIC_PROJECT_CLOSED`, `ANALYTIC_DIM_ON_NON_PNL` (R-A1), `ANALYTIC_DIM_ON_NON_ANALYTIC` (I-E4-4) |
| `post.ts` | **C-9 deja de ser inerte**: se retira la guarda `ANALYTIC_DIM_UNAVAILABLE`; se resuelve el **tipo efectivo** (R-A2/R-A3/R-A4) y se persiste; se valida destino existente, activo, del tenant y excluyente; con `analyticsRequired = false` se rutea a `CC-NA`; se deniega dimensión fuera de 6/7 y en `NO_ANALITICO`; se denormaliza `businessLineId`; proyecto `CLOSED` rechaza líneas nuevas salvo excepción ADMIN con motivo (I-E4-10). **`validateAnalytics` NO se ejecuta sobre un `REVERSAL`** (§8.7): la anulación debe poder postearse aunque el proyecto se haya cerrado o el CECO archivado entretanto — bloquearla dejaría vivo un asiento erróneo para siempre |
| `void.ts` | `buildReversal` **copia literalmente** las cuatro columnas analíticas y nunca reasigna (R-A9 / §8.7). Es lo que hace comprobable I-E4-11 |
| `hash.ts` | **`ledgerHash` v2 sin las cuatro columnas analíticas**; `entryHash` las conserva; `hashVersion` documentado en el módulo (§2.5) |
| `templates/*` | Ya propagan `projectId`/`costCenterId`/`analyticType` en las líneas 6/7 de T-01…T-05, T-10, T-14, T-15…T-18. **Faltan cuatro sitios** (tarea T6): comisión bancaria `626` de T-08/T-09/T-19 (default CECO `G_A`), recargo e intereses `631`/`669` de T-11…T-13/T-24, diferencia de cambio `668`/`768` y redondeo `669`/`769` de T-08/T-09 (CECO `FINANCIERO`), y `678`/`778` de T-22 (CECO `G_A`). T-02/T-05 ganan **C-12 analítico**: la rectificativa hereda la dimensión de la línea rectificada (I-E4-12) |
| `invariants.ts` | `InvariantInput.analytics?` opcional; `runInvariants` añade `checkI4` y los doce `I-E4-*` cuando viene. Definidos en `lib/analytics/invariants.ts` y re-exportados |
| `provenance.ts` | `ProvenanceParams` += `projectId?`, `costCenterId?`, `businessLineId?`, `analyticType?`, `accountPrefixes?`, y el bloque gana `analyticsHash` y `marginConfigHash`. Todo parametrizado, nunca interpolado |

---

## 4. Capa de aplicación

`models/analytics.ts` + `app/(app)/analytics/actions.ts`. Toda acción empieza por `withOrg(<rol>)`, valida con zod (`forms/analytics.ts`) y usa `tenantTransaction` cuando escribe más de una fila. Ninguna calcula.

```ts
getAnalyticsConfig(db, { periodEnd }): Promise<AnalyticsConfig>   // versión vigente para el periodo
listBusinessLines / listProjects / listCostCenters(db, filter)    // con recuento de líneas
create* / update* / archive*(tx, input, actor)                    // las tres dimensiones
updateMarginLevelConfig(tx, input, actor)                         // cierra versión y abre otra (MLC-4)
seedAnalyticsDefaults(tx, organizationId)                         // CECOs + niveles + LN GENERAL
getAnalyticLines(tx, filter)                                      // paginado (2.000), patrón de E3
getAnalyticPnl(tx, period, provCtx)                               // agregado SQL → motor puro → I4
reclassifyLines(tx, request, actor)                               // ADR-0010, §2.6
```

`reclassifyLines` es la única que escribe sobre `journal_lines`: valida con `checkReclassify`, aplica el `UPDATE` de las cuatro columnas, **recalcula `entry_hash`** de cada asiento afectado, marca `ManualReviewFlag` del periodo y escribe el `AuditLog` — todo dentro de `runLedgerTransaction`, con `abort()` en cualquier fallo (lección BLOQUEA-1 de E3: un `return` no aborta).

| Acción | Rol mínimo | Notas |
|---|---|---|
| `listAnalyticsAction`, `analyticPnlAction` | `VIEWER` | Solo lectura |
| `createProjectAction`, `updateProjectAction` | `EDITOR` | `businessLineId` editable solo si el proyecto no tiene líneas (R-A9) |
| `createBusinessLineAction`, `createCostCenterAction` | `EDITOR` | `kind = SIN_ASIGNAR` prohibido: solo la semilla |
| `updateCostCenterAction` | `EDITOR` nombre/color/orden · **`ADMIN`** `kind`, `marginLevel`, `allocatable` | Mueve importe entre niveles: `AuditLog` |
| `archive*Action` | `ADMIN` | Motivo obligatorio. `CC-NA` no se archiva |
| `deleteProjectAction` (heredada) | `ADMIN` | Rechaza con `DIMENSION_IN_USE` si hay `journal_lines`; con solo `transactions`, comportamiento heredado |
| `closeProjectAction` | `EDITOR` | Fija `closedAt`/`closedById`; reabrir es ADMIN |
| `updateMarginLevelConfigAction` | `ADMIN` | Valida MLC-1…MLC-5; abre versión nueva |
| `setNonAnalyticLevelAction`, `setAnalyticsRequiredAction` | `ADMIN` | A `AuditLog` |
| `updateAccountAnalyticTypeAction` | `ADMIN` | O-A9: motivo, `AuditLog`, prohibido con líneas en ejercicio `CLOSED` |
| `reclassifyLinesAction` | `EDITOR` mes abierto · **`ADMIN`** mes bloqueado · **nadie** con ejercicio cerrado | Motivo ≥ 10 caracteres. ADR-0010 |

`AuditEntity` += `"BusinessLine"`, `"Project"`, `"CostCenter"`, `"MarginLevelConfig"`, `"JournalLine"`. `AuditAction` += `"archive"`, `"RECLASSIFY_ANALYTICS"`.

---

## 5. Invariantes

### 5.1 I4 — formulación operativa (definición única en la skill `fiabilidad`)

Con `L` = líneas de grupo 6/7 del periodo con `entry_kind ∉ {REGULARIZATION, CLOSING, OPENING}`, `aporte(l) = credit − debit`, `M` la matriz **cumulativa** y `C` el conjunto de columnas (proyectos ∪ CECOs por `kind` ∪ {AMORT, FIN, EXTRA, NO_ANALITICO}; **las columnas de línea de negocio no pertenecen a `C`**):

```
I4.a  ∀ nivel:  Σ_{c∈C} M[nivel][c]  =  Σ_{l∈L : nivel(l) ≤ nivel} aporte(l)      -- tolerancia 0
I4.b  Σ_{c∈C} M[RESULTADO][c]  =  Σ_{l∈L} aporte(l)  =  I3(org, from, to)          -- tolerancia 0
I4.c  ∀ l∈L:  ∃! (nivel, columna) al que l contribuye                              -- cobertura y unicidad
```

Sobre `ejercicio-completo.json`: `RESULTADO = 1 497 322 c` (= `expected.resultadoAntesRegularizacionCents` y `−saldo129Cents`), `BAI = 1 996 430 c` (= `resultadoAntesImpuestoCents`), **85/85 líneas cubiertas**. Nota que la ronda 1 tenía mal: **1 497 322 es después de impuesto**, no antes — `T-25` tiene `kind = NORMAL` y su `6300` entra en I3.

`checkI4` devuelve `FAIL` con la diferencia exacta y las 10 primeras líneas no clasificadas. Nunca `WARN`: o cuadra o no.

**Casos límite exigidos por el test:** periodo sin líneas 6/7 (matriz de ceros, PASS); contra-asiento del mismo periodo (se compensa solo); contra-asiento en periodo posterior (cambia de periodo, PASS en ambos, la Auditoría lo explica); `NO_ANALITICO` con dimensión (FAIL de I-E4-4 **antes** de calcular); `AMORTIZACION_DETERIORO` con `projectId` (columna del proyecto, nivel EBIT, MC3 intacto); CECO con `marginLevel` fuera de `{MC3, EBITDA}` (error de configuración, bloquea el informe); reclasificación entre ejecuciones (`analyticsHash` distinto ⇒ `ReportRun` nuevo); agregado > 2³¹ (`BigInt`).

### 5.2 Invariantes de la épica

| ID | Invariante | Severidad | Test |
|---|---|---|---|
| **I4** | §5.1, tolerancia 0 | FAIL | `I4 · nivel %s` parametrizado por los 8 niveles contra `levelTotalsCents`; `I4.b = pnlContableCents`; `I4.c` cobertura 85/85; **byte a byte** contra `pyg-analitica-esperada.json` |
| **I-E4-1** | Cobertura: toda línea 6/7 tiene destino, o `NO_ANALITICO` | FAIL (WARN con `analyticsRequired = false`, con importe y recuento en `CC-NA`) | motor + check |
| **I-E4-2** | `(projectId IS NULL) <> (costCenterId IS NULL)` en 6/7 no `NO_ANALITICO` | FAIL | motor + CHECK `journal_lines_analytic_dest_xor` |
| **I-E4-3** | `businessLineId` = el del proyecto en el alta; NULL con CECO | FAIL | trigger + test sobre el fixture |
| **I-E4-4** | `NO_ANALITICO` (en particular `630`) sin ninguna dimensión | FAIL | motor + check |
| **I-E4-5** | Ninguna línea de grupos 1–5 lleva dimensión ni `analyticType` | FAIL | CHECK `journal_lines_analytics_only_pnl` |
| **I-E4-6** | Ningún % de margen se persiste; con ingresos 0 se pinta `—` | FAIL de revisión | grep en CI + test de `marginBps` |
| **I-E4-7** | Tenant de las tres dimensiones (extensión de I10, ya con FK real) | FAIL | FK compuesta + check sin filtro de tenant (`app_maintenance`) |
| **I-E4-8** | Mismo `(ledgerHash, analyticsHash, marginConfigHash, allocationRunId)` ⇒ matriz idéntica byte a byte (P7) | FAIL | test de reproducibilidad, dos cargas del fixture |
| **I-E4-9** | MLC-1 y MLC-2 en `MarginLevelConfig` | FAIL | validación al guardar + CHECKs |
| **I-E4-10** | Proyecto `CLOSED` sin líneas nuevas posteriores a `closedAt`, salvo excepción ADMIN **y salvo `REVERSAL`** (§8.7) | WARN | check + lista en Auditoría |
| **I-E4-11** | Contra-asiento con dimensión espejo: `Σ aporte = 0` **por cuenta y por (proyecto, CECO, analyticType)** | FAIL | test sobre el fixture (`REV-R-ERR` devuelve +100 000 a `P-01`, por eso MC1 de P-01 es −150 000 y no −250 000) |
| **I-E4-12** | Rectificativa (`606`/`608`/`609`/`706`/`708`/`709`) con la dimensión de la línea rectificada | FAIL | check al postear T-02/T-05 |
| **I-E3-7** | *(en riesgo)* `entryHash` = hash de sus líneas | — | Se protege: la reclasificación lo recalcula. Test: reclasificar ⇒ PASS y hash distinto; `UPDATE` directo sin recalcular ⇒ FAIL (se ejerce a propósito) |
| **I3** | *(en riesgo)* la PyG contable no puede cambiar por una operación analítica | — | `pnlContableCents` y `ledgerHash` idénticos antes y después de reclasificar 40 líneas |
| **I7 / I10** | Unicidad `(organizationId, code)` y tenant de las dimensiones | FAIL | motor + índices + `tests/integration-rls/e4-tenant.test.ts` |

---

## 6. UI

Grupo **Analítica** en `components/sidebar/sidebar.tsx`, entre Contabilidad e Informes.

| Ruta | Qué es | `VIEWER` | `EDITOR` / `ADMIN` |
|---|---|---|---|
| `/analytics/pyg` | **PyG analítica**. `ReportTable` con filas = niveles y columnas = proyectos (agrupados bajo su LN, con la fila de agregado marcada «agregado, no suma al total») + CECOs por `kind` + amortización, financiero, extraordinario y no analítico. Cabecera con periodo, sello, `run_id`, `ledgerHash`, `analyticsHash` y `marginConfigHash` abreviados en JetBrains Mono; fila de cuadre `Matriz − PyG contable = 0,00 €` con ✓/⚠; click en celda = provenance + drill-down. **`EBIT`, `BAI` y `RESULTADO` en las columnas de proyecto se pintan en texto secundario con nota** «lectura de compañía, no margen de proyecto» (corolario de §1.4 del experto) | Todo salvo exportar (E6) | Igual |
| `/analytics/projects` | Ficha y CRUD: código, nombre, LN, estado, fechas, cierre, presupuesto, nº de líneas e importe imputado. Sustituye a `/settings/projects` | Lista y ficha | Alta/edición; archivar y reabrir solo ADMIN |
| `/analytics/cost-centers` | CRUD con `kind`, `marginLevel`, `allocatable` e indicador «imputable en E5» | Lectura | `kind`/`marginLevel`/`allocatable` solo ADMIN |
| `/analytics/business-lines` | CRUD con color, orden y proyectos colgando | Lectura | Alta/edición |
| `/settings/analytics` | `analyticsRequired`, `nonAnalyticLevel` y la tabla de `MarginLevelConfig` vigente con su historial de versiones | Lectura | ADMIN |
| `/ledger` | Filtros por proyecto y CECO en `ledger-filters.tsx`; columna «Destino» en `journal-table.tsx` | Sí | Sí |
| `/ledger/new` y `/ledger/new/[templateCode]` | **Selector de destino por línea**: combobox proyecto/CECO, obligatorio y marcado con el aviso `#F5A623` cuando la cuenta es 6/7 y su tipo efectivo ≠ `NO_ANALITICO`; deshabilitado y en gris fuera de 6/7 (R-A1). Muestra el **tipo efectivo resuelto** cuando R-A3/R-A4 lo cambian, para que el usuario vea que su gasto indirecto ha pasado a MC2 | — | Sí |
| `/ledger/[entryId]` | Destino por línea en `entry-detail.tsx` + botón **«Reclasificar analítica»** (diálogo con motivo obligatorio ≥ 10 caracteres, diff antes/después, y aviso explícito de que el asiento contable y sus informes financieros no cambian) | Ve el destino, no el botón | Según ventana |

**Componentes nuevos:** `components/analytics/dimension-combobox.tsx`, `margin-matrix.tsx` (envuelve `ReportTable` con columnas dinámicas y sub-cabecera de LN), `reclassify-dialog.tsx`, `dimension-form.tsx`, `margin-config-table.tsx`.

**Estados.** Carga: esqueleto de tabla (`loading.tsx` por ruta). Vacío: «Aún no hay proyectos: crea el primero para ver la PyG analítica». Error: la matriz **no se pinta a medias**; con I4 en FAIL se muestra con sello `REQUIERE REVISIÓN`, motivo y diferencia exacta — nunca se oculta la discrepancia. Formato `ui-erp`: `1.234.567,89 €` `es-ES`, `tabular-nums`, negativos con `−` en texto secundario, ceros `—`, márgenes con 1 decimal (`—` si ingresos 0), filas de 32 px, sin rojo/verde semáforo.

---

## 7. Trazabilidad

- **Por celda**: `Provenance` con `metrica` (`mc3.proyecto.P-01`, `ebitda.ceco.G_A`, `resultado.total`), `run_id`, `ledgerHash`, **`analyticsHash`**, **`marginConfigHash`** y `(configId)`, `calculado_por = "lib/analytics/margins.ts@<git-sha>"`, `registros_origen` parametrizada (`… AND project_id = $n` / `cost_center_id = $n` / `left(account_code,1) IN ('6','7')`) y `confianza = "calculado"` (`"comprobado"` con I4 en PASS). El drill-down ejecuta esa consulta dentro de `tenantTransaction`.
- **Por línea**: la dimensión viaja en la propia `journal_line`, así que hereda documento (`fileId`), operación (`transactionId`), plantilla (`templateCode`), autor, `postedAt` y `entryHash`. El **tipo efectivo** se persiste: R-A3/R-A4 quedan registrados, no se recalculan al leer.
- **Reclasificación**: `AuditLog` con `before`/`after` de las cuatro columnas **y del `entry_hash`**, motivo y usuario, en la misma transacción. Único camino por el que una cifra analítica histórica cambia.
- **Configuración**: `MarginLevelConfig` versionada (`validFrom`/`validTo`) + `marginConfigHash` en cada celda; cambios de `LedgerAccount.analyticType` con ADMIN, motivo y `AuditLog` (O-A9); semillas con `AuditLog(action="seed")`.
- **Sello**: I4 en PASS + `gitSha` conocido ⇒ `VALIDADO AUTOMÁTICAMENTE`; cualquier FAIL, `gitSha` desconocido o saldo en `CC-NA` por encima del umbral ⇒ `REQUIERE REVISIÓN` con motivo (reutiliza `seal()` de E3).

---

## 8. Criterios de aceptación y plan de tareas

### 8.1 Criterios (Given / When / Then)

1. **C-9 muerde.** *Given* `analyticsRequired = true`, *when* se postea una factura recibida con una línea a `621` sin destino, *then* falla con `ANALYTIC_DEST_MISSING` anclado a esa línea, no se crea asiento y `lastEntryNumber` no avanza.
2. **`CC-NA` con la regla relajada.** *Given* `analyticsRequired = false`, *when* se postea lo mismo, *then* la línea queda en `CC-NA` y el check de Auditoría la lista como WARN con importe y recuento.
3. **R-A3.** *Given* `623` (default `INDIRECTO_CECO`) con `projectId = P-02`, *when* se postea, *then* la línea se persiste con `analyticType = COSTE_DIRECTO_MC2` y aparece en **MC2** de la columna `PROJ:P-02` — nunca en MC3.
4. **R-A4 y R-A6.** *Given* `640` (default `COSTE_DIRECTO_MC2`) con `costCenterId = CC-GA`, *then* se persiste `INDIRECTO_CECO` y cae en EBITDA. *Given* `668` con `costCenterId = CC-FIN` (`marginLevel = EBITDA`), *then* cae en **BAI**, columna `FINANCIERO`: manda el tipo, no el CECO.
5. **R-A1 e I-E4-4.** *Given* una línea de `572` o de `477` con `projectId`, *then* el motor la rechaza y, saltándose el motor, el CHECK `journal_lines_analytics_only_pnl`. *Given* `6300` con `costCenterId`, *then* `ANALYTIC_DIM_ON_NON_ANALYTIC`.
6. **Destino excluyente y del tenant.** Proyecto de otra organización ⇒ `ANALYTIC_DEST_UNKNOWN` y, sin motor, `23503` por la FK compuesta. Proyecto **y** CECO a la vez ⇒ `ANALYTIC_DEST_BOTH` y CHECK.
7. **Denormalización.** `projectId = P-01` (LN `BL-CONS`) ⇒ `business_line_id` de `BL-CONS`; un `UPDATE` que lo desalinee es rechazado con `23514`. Mover `P-01` a `BL-DEV` **no cambia** las líneas ya escritas (R-A9).
8. **Matriz byte a byte.** *Given* el fixture completo cargado con 2 LN, 3 proyectos, 6 CECOs y los `projectCode`/`costCenterCode` de las 326 líneas, *when* se calcula la PyG analítica de 2026, *then* la serialización canónica es **idéntica byte a byte** a `docs/design/fixtures/pyg-analitica-esperada.json`, con `levelTotalsCents.RESULTADO = 1 497 322`, `BAI = 1 996 430`, `MC3 = 3 084 110` y 85/85 líneas cubiertas; y `build_pyg_analitica_esperada.py --check` pasa en CI.
9. **Sin imputaciones.** MC3 de un proyecto no incluye ningún importe de CECO (eso es E5); las columnas de LN son agregados y **no** entran en el total; `%MC1` sale con 1 decimal o `—`.
10. **Amortización.** Con `projectId` ⇒ fila EBIT de la columna del proyecto; con `costCenterId` ⇒ fila EBIT de la columna `AMORTIZACION_DETERIORO`. Nunca en MC1/MC2/MC3.
11. **E4-D2.** *When* se reclasifica una línea, *then* `ledgerHash` del periodo **no cambia**, `entry_hash` del asiento **sí**, `analyticsHash` **sí**, I-E3-7 sigue PASS, `pnlContableCents` idéntico al céntimo y la matriz mueve el importe de columna sin cambiar el total. Tras la migración, todas las filas tienen `hash_version = 2`.
12. **Ventana.** Mes abierto: EDITOR puede. Mes bloqueado: EDITOR `PERMISSION_DENIED`, ADMIN con motivo puede. Ejercicio `CLOSED`: ambos rechazados por la acción y, saltándose la acción, por el trigger.
13. **`REVERSAL`.** *Given* un asiento con `projectId` de un proyecto que después se cierra, *when* se anula, *then* el contra-asiento se postea con la **misma** dimensión, sin pasar `validateAnalytics`, sin WARN de I-E4-10, y I-E4-11 da Σ = 0 por cuenta **y por destino**.
14. **Migración del `Project` heredado.** Cada proyecto queda con la LN `GENERAL` y `status = ACTIVE`; `Transaction.projectCode` sigue resolviendo; `/transactions?projectCode=X` sigue filtrando; `/settings/projects` redirige.
15. **Nada se borra.** CECO con líneas: borrar ⇒ `DIMENSION_IN_USE`; archivado ⇒ desaparece de los combobox pero **sigue en la matriz** de los periodos con movimiento. `CC-NA` no se archiva.
16. **`MarginLevelConfig`.** Guardar `INDIRECTO_CECO` en MC3 ⇒ rechazado (MLC-2, y CHECK). Cambiar el reparto ⇒ versión nueva con `validFrom`, la anterior con `validTo`, `analyticsHash` distinto y los `ReportRun` analíticos del periodo a `REQUIERE_REVISION`; un informe de un ejercicio cerrado se reimprime con **su** configuración.
17. **Aislamiento.** `tests/integration-rls/e4-tenant.test.ts`: sin GUC, las tres tablas nuevas devuelven 0 filas y rechazan el INSERT con `42501`; ninguna queda en `NO FORCE`.
18. **Determinismo.** Dos cargas del fixture ⇒ mismos `entryHash`, `ledgerHash`, `analyticsHash`, `marginConfigHash` y matriz al céntimo. El guard de pureza no encuentra `Date.now()` ni IO en `lib/analytics/`.

### 8.2 Plan de tareas

| # | Tarea | Depende de | Nivel | h |
|---|---|---|---|---|
| **T1** | **ADR-0010** (reclasificación **+ E4-D2**, PROPUESTO) a firma humana. **Bloquea T11, T12 y media T15** | — | 2 | 4 |
| **T2** | Prisma: 3 tablas nuevas, extensión de `Project`, `Organization.nonAnalyticLevel`, `JournalEntry.hashVersion`, relaciones en `JournalLine`; `TENANT_MODELS`, `BUSINESS_DELEGATES` | — | 2 | 7 |
| **T3** | Migración `20260908100000_e4_analytics`: tablas + RLS, marca, backfills 2a–2e bajo `NO FORCE`, retirada del CHECK de E3, FK compuestas + `VALIDATE`, los CHECK de O-A2, `EXCLUDE` de vigencias, triggers de denormalización, índices. Tests de integración sobre el SQL | T2 | 2 | 16 |
| **T4** | **E4-D2 · hashes**: `ledgerHash` v2 sin columnas analíticas, `entryHash` intacto, `analyticsHash` + `marginConfigHash` en `lib/analytics/hash.ts`, `hashVersion`; migración 2f de recálculo del histórico; documentación en `hash.ts` y `ESTADO.md` | T2, T3 | 2 | 12 |
| **T5** | `lib/analytics/{types,seed,margins}.ts`: `resolveEffectiveAnalyticType` (R-A2/3/4), `resolveLevel` (R-A5/6/7/11), `resolveColumn`, `contribution`, `isPnlLine`, `pnlContableCents`, `classifyLine`, `marginBps`, semillas + `margins.test.ts` con la tabla de casos (8 tipos × 4 destinos × 2 grupos de cuenta) | T2 | 2 | 22 |
| **T6** | `lib/ledger/post.ts` y `void.ts`: activar C-9 con tipo efectivo, R-A1, I-E4-4, ruteo a `CC-NA`, denormalización, proyecto `CLOSED`, **`REVERSAL` exento**; `LedgerContext.dimensions`; **cinco huecos de plantilla** (comisión `626`, recargo/intereses `631`/`669`, diferencia de cambio y redondeo, `678`/`778` de T-22, C-12 analítico en T-02/T-05) + schemas zod | T2, T5 | 2 | 20 |
| **T7** | `buildAnalyticPnl` completa: matriz cumulativa, `contributionByLevel`, agregados de LN, `levelTotals`, `checks`, provenance por celda, serialización canónica | T5 | 2 | 18 |
| **T8** | **Test byte a byte** contra `pyg-analitica-esperada.json` + paso de CI `build_pyg_analitica_esperada.py --check`; `lib/analytics/invariants.ts` con `checkI4` (I4.a/b/c) y los doce `I-E4-*`, cableados en `runInvariants` y `scripts/run-invariants.ts` | T7 | 2 | 16 |
| **T9** | **Cargador de fixtures**: crea LN/proyectos/CECOs del fichero, **deja de descartar** los códigos, `dimensions.available = true`; invertir el test de D-E3-1; tests de I4 y de I-E4-11 sobre `ejercicio-completo` | T5, T6 | 1 | 10 |
| **T10** | `models/analytics.ts`: `getAnalyticsConfig` con versión vigente por periodo, listados con recuento, CRUD con `AuditLog`, `seedAnalyticsDefaults` en `createOrganizationWithOwner`, `getAnalyticLines` paginado, `getAnalyticPnl` con agregado SQL (R6) | T3, T7 | 1 | 18 |
| **T11** | `reclassifyLines` + `lib/analytics/reclassify.ts` + GRANTs y los dos triggers (bloque 5 de §2.7) + `ManualReviewFlag`. **Solo con ADR-0010 firmado** | T1, T10 | 2 | 14 |
| **T12** | `forms/analytics.ts` + `app/(app)/analytics/actions.ts` con la matriz de roles; `updateAccountAnalyticTypeAction` (O-A9); `AuditEntity`/`AuditAction` ampliados | T10 | 1 | 11 |
| **T13** | UI de fichas: `/analytics/{projects,cost-centers,business-lines}`, `/settings/analytics` con `MarginLevelConfig` y su historial, redirect de `/settings/projects`, sidebar | T12 | 1 | 18 |
| **T14** | UI de la matriz: `/analytics/pyg`, `margin-matrix.tsx`, cabecera con los tres hashes, fila de cuadre, drill-down, filas EBIT/BAI/RESULTADO atenuadas en columnas de proyecto | T12, T7 | 1 | 16 |
| **T15** | UI de destino en el asiento: `dimension-combobox.tsx`, selector por línea con tipo efectivo visible, columna «Destino», filtros, `reclassify-dialog.tsx` (con T11) | T12, T6 | 1 | 18 |
| **T16** | Integración y RLS: `tests/integration/e4-analytics.test.ts` (criterios 1–7, 11–16), `tests/integration-rls/e4-tenant.test.ts` (17), e2e Playwright alta de proyecto → asiento con destino → matriz | T13, T14, T15 | 1 | 15 |
| **T17** | **Pendientes menores de E3**: `translateDbError` conserva el detalle del `RAISE` también en ejercicio/mes/fecha/cuenta, con test parametrizado por trigger | — | 1 | 3 |
| **T18** | **Correcciones a documentos ajenos** que el experto señala: `.claude/skills/contabilidad-analitica` (añadir `SIN_ASIGNAR` a los tipos de CECO, referenciar R-A3 en la fila MC2, `nonAnalyticLevel`), `.claude/skills/fiabilidad` (I4 operativo a/b/c), `.claude/skills/estados-financieros` (columnas por `kind`, LN como agregado) | T8 | 1 | 4 |
| **T19** | Docs de cierre: `docs/MODELO-DATOS.md` §Analítica reescrita (`@@map`, FK compuestas, CHECKs, `GRANT` acotado, `analyticsHash`, deuda O-A6 anotada para E5/E7), `docs/ESTADO.md` (runbook de `hashVersion` 2 y de la reclasificación), ROADMAP E4 → CERRADA, `runs/registro.jsonl`, ADR-0010 → APROBADO/RECHAZADO | T16 | 1 | 7 |

**Total: 249 h** (~31 jornadas; +37 h sobre la ronda 1, casi todas en E4-D2 —hashes y migración de recálculo, T4—, en el test byte a byte y en el versionado de `MarginLevelConfig`). Camino crítico: T2 → T3/T4 → T5 → T6 → T7 → T8/T10 → T12 → T14/T15 → T16. T1 corre en paralelo desde el día 1 y solo bloquea T11, T12 y media T15.

---

## 9. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **Activar C-9 bloquea el posteo** de plantillas que hoy no aportan destino: la épica «rompe» el diario el día del despliegue | T6 las cubre antes que la UI, y el fixture completo (28/28 plantillas, 326 líneas) es la prueba: si una plantilla no puede aportar destino, el fixture no carga |
| R2 | **Cambio de forma canónica de `ledgerHash`** (v1 → v2): en circunstancias normales es inaceptable | Solo es posible **ahora**: no hay datos en producción y el fixture se recarga entero. La migración recalcula, marca `hashVersion = 2` y lo documenta. Cualquier cambio futuro exige versión nueva y convivencia, nunca reescritura |
| R3 | **Reclasificación mal usada** = reescritura silenciosa del histórico analítico | Las cinco salvaguardas de §2.6, ADR-0010 firmado, motivo ≥ 10 caracteres, `AuditLog` con ambos hashes, `ManualReviewFlag` y el check de Auditoría de informes con `analyticsHash` caducado |
| R4 | **Override implícito R-A3/R-A4 sorprende al usuario**: informa CECO y su tipo cambia sin avisar | El tipo efectivo se **persiste** y se **muestra** en el formulario de asiento y en la ficha (T15), y entra en `analyticsHash`. Sin WARN por decisión del experto: informar la dimensión ya es la declaración de intención |
| R5 | **`Project` con dos vidas** (dimensión analítica y etiqueta de operación heredada) | La UI heredada desaparece (T13); `businessLineId NOT NULL` impide crear un proyecto sin dimensión |
| R6 | **Rendimiento de la matriz** con cientos de miles de líneas | Agregación por SQL (`GROUP BY project_id, cost_center_id, analytic_type, account_code`) como fuente; el motor puro agrega esos agregados, no las líneas, y hay un test que compara ambos caminos sobre el fixture. Lectura paginada de 2.000 (patrón #9 de E3) |
| R7 | **`CC-NA` se convierte en el cajón por defecto** y la matriz pierde valor | WARN permanente en Auditoría con importe y recuento, sello `REQUIERE REVISIÓN` por encima del umbral, y reclasificación en masa desde `/analytics/pyg` filtrando por `CC-NA` |
| R8 | **Deuda O-A6 heredada por E5/E7**: el `@@unique` de `Budget` con tres nullables no impide duplicados en PostgreSQL | Anotada en `MODELO-DATOS.md` con la solución (índices únicos parciales o `NULLS NOT DISTINCT`, PG 15+) y con el `CHECK` de exclusividad proyecto/CECO |

**Alternativas descartadas** (tres líneas cada una, con la razón que las descarta):

- **`ledgerHash` que siga incluyendo las dimensiones.** Reimputar un gasto invalidaría balance, PyG contable, cashflow y diario ya sellados, que no cambian en un céntimo, y obligaría a reemitir informes financieros idénticos. Viola P3/P7. Sustituida por E4-D2.
- **Tabla `AnalyticAllocation` aparte** en vez de columnas en la línea. Permitiría mutar sin tocar `journal_lines`, pero contradice ADR-0004, obliga a un `JOIN` en cada agregación y admite líneas con cero o dos destinos, que es justo lo que C-9 impide por construcción.
- **Recrear `projects` como tabla nueva.** Rompe una FK viva y trece ficheros heredados a cambio de nada: el modelo heredado ya tiene la identidad que la dimensión necesita (D-E4-1).
- **Columna «Sin destino (anterior a E4)» y no backfillear.** Innecesaria desde que la migración recalcula todos los hashes (el backfill sale gratis), y rompería el test byte a byte contra el esquema de columnas sellado.
- **Asiento analítico de traspaso para corregir imputaciones.** No es un hecho económico (NRV 14ª), rompe el drill-down —la línea original seguiría apuntando al proyecto equivocado—, falsea los drivers de E5 y contradice el descarte de las cuentas 9x de ADR-0004.
- **`INDIRECTO_CECO` + `projectId` cayendo en MC3, o rechazado.** MC3 es «margen tras absorber estructura» y un alquiler de obra no es estructura: dos proyectos idénticos, uno que alquila la grúa y otro que la tiene, mostrarían MC2 distinto y MC3 igual — el diagnóstico invertido. Rechazarlo obligaría a duplicar medio grupo 62 en el plan.
- **`678`/`778` como `EXTRAORDINARIO`.** Los sacaría del margen operativo, produciría un EBITDA distinto del de las cuentas depositadas y reintroduciría una categoría que el RD 1514/2007 suprimió — que es además la vía clásica de maquillaje.
- **Solo `validFrom`/`validTo`, o solo `configHash`, en `MarginLevelConfig`.** Con solo el hash el histórico es irrecuperable tras editar; con solo la versión, nada impide servir un informe cacheado con la configuración equivocada. Resuelven problemas distintos y van los dos.

---

## 10. Validación contable: **CONFORME tras ronda 2**

Veredicto del experto sobre `MODELO-DATOS.md` §Analítica: **CONFORME CON OBSERVACIONES** — el modelo soporta la matriz, I4 y las reglas de destino sin cambio de ruptura. Estado de las nueve observaciones en este diseño:

| Obs. | Qué pedía | Dónde entra |
|---|---|---|
| **O-A1** | FK compuestas de las tres dimensiones | §2.2, §2.7 bloque 3 · T3 |
| **O-A2** | CHECK proyecto xor CECO y «sin dimensión fuera de 6/7» | §2.7 bloque 3 (`journal_lines_analytic_dest_xor`, `journal_lines_analytics_only_pnl`) · T3 |
| **O-A3** | `analyticsHash` y separación del `ledgerHash` financiero | §2.5 (E4-D2) · T4. Confirmado: entra en E4, no se difiere |
| **O-A4** | `GRANT UPDATE` acotado a cuatro columnas + trigger de ventana | §2.6 salvaguardas 1 y 4, §2.7 bloque 5 · T11 |
| **O-A5** | `@@map`/`@map` snake_case en todo el bloque §Analítica | §2.1, §2.2 y reescritura de `MODELO-DATOS.md` · T19 |
| **O-A6** | Índices únicos parciales en `Budget` | **Diferida a E5/E7** con la deuda anotada (R8): `Budget` no se crea en E4 y adelantarla no ahorra trabajo |
| **O-A7** | `MarginLevelConfig` versionada, `sortOrder` no nulo, MLC-1/MLC-2 | §2.2, §2.8, CHECKs y `EXCLUDE` de §2.7 · T10/T12 |
| **O-A8** | `Project.closedAt/closedById`, `CostCenter.origin/isSystem` | §2.2 · T2 |
| **O-A9** | `analyticType` por cuenta con ADMIN + motivo + `AuditLog` | §2.8, §4 (`updateAccountAnalyticTypeAction`) · T12 |

Las siete dudas de la ronda 1 quedan cerradas por §8 del experto y aplicadas: R-A11 (§8.1), R-A3 (§8.2), `678`/`778` en EBITDA con `EXTRAORDINARIO` vacío por diseño (§8.3), versionado **y** hash de `MarginLevelConfig` (§8.4), reclasificación en mes bloqueado con ADMIN y frontera absoluta en el ejercicio cerrado (§8.5), `CC-FIN`/`CC-EXT`/`CC-NA` no imputables (§8.6), y herencia literal del destino en el `REVERSAL` con exención de `validateAnalytics` (§8.7). Las tres divergencias que el experto detecta en documentos ajenos (la skill `contabilidad-analitica` omite `SIN_ASIGNAR` y no referencia R-A3; el enunciado de la épica confundía BAI con RESULTADO) se corrigen en T18 y en este documento, no en el suyo.

**Queda por firmar:** ADR-0010 (reclasificación analítica **y** separación de hashes E4-D2). Sin esa firma, E4 se implementa completa salvo T11, T12 parcial y media T15, y `journal_lines` se queda sin ningún `GRANT UPDATE`.

---

## 11. Revisión (ronda 1) — resoluciones

Revisión de código (**CAMBIOS REQUERIDOS**), QA (**PASS con 1 gap**) y auditoría de fiabilidad (**CONFORME con 5 hallazgos menores**), resueltos sin commits. Tabla completa:

| # | Hallazgo | Resolución |
|---|---|---|
| **BLOQUEA 1** | La forma canónica real de `ledgerHash` v2 no es la tupla de ADR-0010 | **`docs/adr/0011-forma-canonica-hashes.md`** (APROBADO), que fija las tres tuplas reales y **sustituye** la tabla de ADR-0010 §E4-D2. ADR-0010 no se toca. El criterio: `ledgerHash` es sello **de informe** y debe ser comparable entre organizaciones y cargas (criterio 15 de E3 y 18 de E4, con test en verde), así que no lleva uuid —`entryId`, `fiscalYearId` y `taxRateId` son claves técnicas, no cifras—; `entryHash` es sello **de fila** y sí las lleva todas. Enlazado desde la cabecera de `lib/ledger/hash.ts` |
| **BLOQUEA 2** | Reclasificar un `REVERSAL` o un asiento anulado rompería I-E4-11 sin que I4 lo viera | Rechazo en **`checkReclassify`** (por `entryKind` y por `isVoided`, que `models/analytics` deriva de `voidedAt` + `reversedBy`) **y** en el trigger `journal_lines_reclassify_window`, reescrito en la migración **`20260908110000_e4_reclassify_guards`**. Test: original + contra-asiento, rechazo por los dos caminos y **I-E4-11 sigue en PASS** |
| **3** (= auditor 1) | La provenance de una celda no reproducía su valor | `cellQuery(level, column, config, period)` acota **los niveles ≤ el de la celda** (la celda es **cumulativa**, y así se documenta; `{ incremental: true }` da el aporte del nivel), con los conjuntos de `analytic_type` y de `cost_center_id` como **arrays parametrizados** (`= ANY($n)`), nunca concatenados. Test de integración que ejecuta la consulta de `MC2\|P-01`, `EBITDA\|CECO:G_A` y `RESULTADO\|NO_ANALITICO` y reproduce 316 000, −633 180 y −499 108 |
| **4** | Nadie comparaba el recálculo SQL del backfill con el `entryHash` de TypeScript | La forma v2 se extrae a **`app.journal_entry_hash(uuid)`** y un test recorre **todos** los `journal_entries` de tres organizaciones comparando los tres caminos: TypeScript, SQL y lo almacenado (I-E3-7), más `hash_version = 2` |
| **5** | Se serializaban todas las líneas al cliente y el detalle se precomputaba por celda | `buildMatrixView` indexa por `${nivel}|${columna}` (**O(1)**) y no contiene líneas; `analyticPnlAction` envía `lineDetail: []`; el drill-down las pide con **`analyticCellDetailAction`** → `models/margins.getCellDetail`, que ejecuta **la misma consulta de la provenance** de esa celda |
| **6** | La matriz leía el diario más de una vez | Una **sola lectura** de líneas alimenta al motor y al `analyticsHash`; el `ledgerHash` sale de un agregado en la base. Documentado en `models/margins.getAnalyticPnl` |
| **7** | Faltaba el CHECK de `NO_ANALITICO` sin dimensiones | `journal_lines_non_analytic_has_no_dimension` en la migración nueva (I-E4-4 en la BD, el caso del `630`) |
| **8** | El `GRANT UPDATE (entry_hash)` admitía cualquier valor | Trigger `journal_entries_entry_hash_guard` (BEFORE UPDATE OF `entry_hash`): sólo admite el valor que devuelve `app.journal_entry_hash(id)`. Un `entry_hash` inventado ya no puede dejar I-E3-7 en PASS mintiendo |
| **9** (= auditor 2) | `marginBps` redondeaba hacia +∞ | Redondeo **simétrico**: `marginBps(−x, r) === −marginBps(x, r)`. Antes, −0,05 % se veía como −0,0 % y +0,05 % como +0,1 % |
| **10** | `CECO_MARGIN_LEVEL` podría degradar a fallback | **Se mantiene el bloqueo** (§5.1, casos límite): un fallback silencioso movería importe de nivel sin que nadie lo supiera. Se mejora el mensaje (nombra el CECO y dónde corregirlo) y se documenta que el CHECK `cost_centers_margin_level` lo hace inalcanzable desde E4 |
| **11** | `getAnalyticPnlCached` muerto | Eliminado |
| **12** | `validateAnalytics` mutaba el borrador | Separadas: `resolveLineAnalytics` (pura, devuelve las cuatro columnas) y `resolveAnalytics(draft, ctx)` (devuelve un borrador **nuevo**), que `buildEntry` aplica una sola vez. `checkDraft` ya no escribe nada |
| **13** | `MIN_RECLASSIFY_REASON` = 10 ≠ ADR-0010 | Alineado a **8**, que es lo que dice la salvaguarda 3 del ADR |
| **14** | La `MarginLevelConfig` se elige por `periodEnd`, no por línea | **Documentado como decisión**, no como omisión: la matriz es una sola tabla y mezclar dos repartos daría una columna cuyo total no explica ninguna configuración; `marginConfigHash` sella UNA versión, que es lo que P7 exige. Corte intra-periodo = dos informes |
| **15** | `imputedCents` sumaba todo el histórico | Acotado por periodo (`from`/`to`) y con `REGULARIZATION`/`CLOSING`/`OPENING` fuera, igual que I3/I4 |
| **16** | `seedAnalyticsDefaults` debía recibir `tx` | Ya lo recibe: `seedAnalyticsDefaults(tx, opts)`, siempre dentro de la transacción del llamante |
| **17** | Búsquedas O(N·M) de dimensiones | Índices `id → dimensión` memoizados por objeto de configuración en un `WeakMap` |
| **QA gap** | Postear a un proyecto `CLOSED` era imposible, sin excepción | `CheckDraftOptions.closedProjectOverride = { role, reason }`: sólo `ADMIN`, motivo ≥ 10 caracteres, y el motivo va al `AuditLog` del asiento. I-E4-10 lo sigue listando como WARN, que es su oficio. `Actor` gana `role?`. Test con los cuatro casos |
| **Auditor 4** | `scripts/load-fixture.ts` sin `--help` ni idempotencia | `--help` y `--org`/`--user` **obligatorios** (un script que escribe en el diario no adivina en cuál ni de parte de quién); `--reset-org` vacía diario, ejercicios y dimensiones en **una transacción**, con el rol `app_maintenance` —borrar asientos es operación de operador (ADR-0009 §6), no de la aplicación |
| **Auditor 5** | El sello mezclaba «git-sha desconocido» con los descuadres | `Seal.razones: { kind, message }[]` con `ENTORNO \| INVARIANTE \| AVISO \| CONFIGURACION`. El git-sha desconocido sigue dando `REQUIERE REVISIÓN`, pero etiquetado **ENTORNO**: es una carencia de trazabilidad del despliegue, no un problema contable. `motivos` se conserva para compatibilidad |
