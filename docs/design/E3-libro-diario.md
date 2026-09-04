# E3 — Libro diario (diseño)

**Épica:** E3 · **Nivel:** 2 (ADR-0003 APROBADO; ADR-0009 PROPUESTO para la retirada de escapes RLS) · **Depende de:** E1, E2
**Autor:** arquitecto · **Fecha:** 2026-09-04 · **Ronda 2** (validación contable incorporada) · **Estado:** PROPUESTO (pendiente de firma humana del ADR-0009)

Documentos que este diseño da por leídos: `CLAUDE.md`, `docs/ARQUITECTURA.md` §4–§6, `docs/MODELO-DATOS.md` §Ejercicios y diario + §Integridad, `docs/adr/0003`, `docs/adr/0007`, `docs/adr/0008`, `docs/ESTADO.md` §Deuda RLS, `docs/design/E2-plan-cuentas.md` §11, y las skills `fiabilidad`, `pgc-npgc`, `estados-financieros`, `contabilidad-analitica`, `ui-erp`.

**Ronda 2 — qué cambió.** El experto contable entregó `docs/design/E3-asientos-tipo.md`: 28 plantillas (T-01…T-28) con su aritmética y sus comprobaciones, 13 checks comunes C-1…C-13, reglas de numeración N-1…N-7, tres fechas (§2.2 de aquel documento), reglas de bloqueo B-1…B-5, formulación operativa de I1/I7–I10 con casos límite, seis invariantes propios I-E3-1…6, nueve observaciones O-1…O-9 al `MODELO-DATOS`, respuesta a las seis dudas de §9.2 y los fixtures ya generados (`tests/fixtures/*.json` + `docs/design/fixtures/build_ejercicio_completo.py`). Este documento se reescribe sobre eso: §2.2 gana cuatro campos, §2.4 tres restricciones, §3.3 pasa de 7 plantillas a 28 agrupadas en tres bloques, §5 adopta la numeración de invariantes del experto, §8 reajusta el plan (T5 → T5a/T5b/T5c; T13 pasa de generar fixtures a cargarlos) y §9.2 se sustituye por las decisiones cerradas. Veredicto en §10.

---

## 1. Objetivo y alcance

E3 convierte el ERP en un sistema contable: crea el **libro diario** como única fuente de cifras (ADR-0003), con ejercicios, bloqueo de periodos, asientos inmutables de partida doble garantizada **en la base de datos**, motor puro de construcción y anulación, las **28 plantillas de asiento tipo** parametrizadas por el plan y los impuestos de E2, los dos informes que se derivan directamente del diario (mayor y sumas y saldos), y los invariantes I1, I7–I10 con su sello. Retira además la deuda RLS de E1/E2 (ADR-0007) y cierra los tres pendientes menores de E2.

**Alcance de las 28 plantillas.** Las 28 se implementan como **funciones puras** en `lib/ledger/templates/` en E3 —son baratas, y solo así el invariante I-E3-5 puede comprobarse contra los 84 asientos del fixture, que las cubren 28/28—. Lo que E3 **expone al usuario** (acción + UI) son las **24 de operativa corriente**, T-01…T-24. Las cuatro de cierre —T-25 `IMPUESTO_BENEFICIOS`, T-26 `REGULARIZACION_RESULTADO`, T-27 `CIERRE_EJERCICIO`, T-28 `APERTURA_EJERCICIO`— quedan sin acción de usuario hasta **E9**, que es quien aporta lo que les falta y no es la plantilla: el cálculo de la base imponible con ajustes extracontables (T-25) y la orquestación del cierre (derivar saldos del mayor, exigir los 12 meses bloqueados, encadenar T-26 → T-27 → T-28 y pasar el ejercicio a `CLOSED`). En E3 son invocables solo desde los tests y desde `scripts/`.

**No incluye:** balance de situación, PyG contable, cashflow ni `ReportRun` (E6 — I2, I3, I6); dimensiones analíticas `Project`/`CostCenter`/`BusinessLine`, la validación efectiva del destino analítico (C-9) e I4 (E4 — ver §2.3); liquidación de CECOs (E5); propuesta de asiento desde OCR y `ExtractionRun` (E8 — E3 solo deja el enganche `Transaction.status`/`journalEntryId` y el "contabilizar" manual); regularización **anual** de prorrata y de bienes de inversión, IVA de caja, asientos recurrentes y la orquestación del cierre (E9); previsión de tesorería (E10); pestaña Auditoría completa y conciliación bancaria (E7).

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

Todo en snake_case físico (`@@map`/`@map`), ids uuid, dinero `Int` céntimos, fechas contables `@db.Date` (sin hora, sin zona: la fecha contable de un asiento es un día natural en la zona de la organización y se decide en el borde, nunca en `lib/ledger/`), `DateTime` solo para auditoría técnica (`postedAt`, `createdAt`). `organizationId` en las cuatro tablas nuevas, con FK compuestas a `accounts(organization_id, code)` (creada en E2, ADR-0008 §4).

### 2.2 Fragmento Prisma

```prisma
enum FyStatus {
  OPEN
  CLOSED

  @@map("fy_status")
}

enum EntryKind {
  NORMAL
  OPENING
  CLOSING
  REGULARIZATION
  REVERSAL
  RECURRING

  @@map("entry_kind")
}

enum SourceType {
  MANUAL
  DOCUMENT
  INVOICE_OUT
  BANK_IMPORT
  CSV_IMPORT
  RECURRING
  SYSTEM

  @@map("source_type")
}

enum TransactionStatus {
  DRAFT
  PROPOSED
  POSTED
  VOID

  @@map("transaction_status")
}

/// Ejercicio contable. `lastEntryNumber` es el contador de numeración sin
/// huecos: se incrementa bajo `SELECT … FOR UPDATE` en la misma transacción que
/// inserta el asiento (§4.3).
model FiscalYear {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// Etiqueta del ejercicio: "2026", "2026-27". Único por organización.
  code      String   @db.VarChar(16)
  startDate DateTime @map("start_date") @db.Date
  endDate   DateTime @map("end_date") @db.Date
  status    FyStatus @default(OPEN)

  /// Último número de asiento asignado. 0 = ejercicio sin asientos.
  lastEntryNumber Int @default(0) @map("last_entry_number")

  closedAt   DateTime? @map("closed_at")
  closedById String?   @map("closed_by_id") @db.Uuid
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")

  periodLocks PeriodLock[]
  entries     JournalEntry[]

  @@unique([organizationId, code])
  @@index([organizationId, startDate, endDate])
  @@map("fiscal_years")
}

/// Bloqueo mensual. La existencia de la fila ES el bloqueo (no hay columna
/// booleana): desbloquear = borrar la fila, y el AuditLog guarda ambas cosas.
model PeriodLock {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  fiscalYearId   String       @map("fiscal_year_id") @db.Uuid
  fiscalYear     FiscalYear   @relation(fields: [fiscalYearId], references: [id], onDelete: Restrict)

  /// 1–12 (CHECK). El mes natural, no el periodo de liquidación.
  month      Int
  lockedAt   DateTime @default(now()) @map("locked_at")
  lockedById String?  @map("locked_by_id") @db.Uuid
  reason     String?  @db.VarChar(512)

  @@unique([organizationId, fiscalYearId, month])
  @@map("period_locks")
}

/// Asiento. INMUTABLE salvo las tres columnas informativas de anulación
/// (`voided_at`, `voided_by_id`, `void_reason`), que la BD permite actualizar
/// por GRANT de columna y nada más (§2.4). Anular = contra-asiento con
/// `reversesEntryId`; NINGÚN informe filtra por `voidedAt` (ADR-0003).
model JournalEntry {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  fiscalYearId   String       @map("fiscal_year_id") @db.Uuid
  fiscalYear     FiscalYear   @relation(fields: [fiscalYearId], references: [id], onDelete: Restrict)

  /// Correlativo por ejercicio, sin huecos, asignado bajo bloqueo pesimista (N-1…N-7).
  entryNumber Int      @map("entry_number")

  /// Las TRES fechas (O-1). Solo `entryDate` manda en ejercicio, mes, informes y
  /// hash; las otras dos explican el desfase y hacen reproducible el asiento (P7).
  /// `documentDate` es además la que selecciona el TaxRate vigente (C-10).
  documentDate DateTime? @map("document_date") @db.Date
  accrualDate  DateTime? @map("accrual_date") @db.Date
  entryDate    DateTime  @map("entry_date") @db.Date

  description String   @db.VarChar(512)
  kind        EntryKind @default(NORMAL)

  /// Método de redondeo de impuestos SELLADO en el asiento (O-2, R-IVA-4):
  /// `Organization.taxRoundingMode` es mutable y el asiento debe poder
  /// recalcularse igual dentro de diez años.
  taxRoundingMode TaxRoundingMode @default(PER_TIPO) @map("tax_rounding_mode")

  sourceType SourceType @default(MANUAL) @map("source_type")
  /// Id opaco en el sistema de origen (nº de extracto, id de recurrente…).
  sourceId   String?    @map("source_id") @db.VarChar(128)

  /// Enganches de trazabilidad. `extractionRunId` es texto hasta que E8 cree la
  /// tabla; entonces pasa a FK sin migración de datos (hoy siempre NULL).
  transactionId   String? @map("transaction_id") @db.Uuid
  transaction     Transaction? @relation("TransactionEntry", fields: [organizationId, transactionId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  fileId          String? @map("file_id") @db.Uuid
  extractionRunId String? @map("extraction_run_id") @db.Uuid
  templateCode    String? @map("template_code") @db.VarChar(32)

  /// Asiento que ESTE anula. El anulado guarda además `voided_*`.
  reversesEntryId String?       @map("reverses_entry_id") @db.Uuid
  reverses        JournalEntry? @relation("EntryReversal", fields: [reversesEntryId], references: [id], onDelete: Restrict)
  reversedBy      JournalEntry[] @relation("EntryReversal")

  voidedAt    DateTime? @map("voided_at")
  voidedById  String?   @map("voided_by_id") @db.Uuid
  voidReason  String?   @map("void_reason") @db.VarChar(512)

  postedById String   @map("posted_by_id") @db.Uuid
  postedAt   DateTime @default(now()) @map("posted_at")

  /// sha256 canónico de las líneas del asiento (lib/ledger/hash.ts). Sella el
  /// contenido: si alguien edita una línea por SQL, deja de cuadrar (§5, I-E3-3).
  entryHash String @map("entry_hash") @db.VarChar(64)

  lines JournalLine[]

  @@unique([organizationId, fiscalYearId, entryNumber])
  @@unique([organizationId, id, entryDate, fiscalYearId, kind], name: "journal_entries_denorm_key")
  /// O-4 / I-E3-2: como máximo UN contra-asiento por asiento anulado. Índice
  /// único parcial en SQL (Prisma no expresa el `WHERE`), ver §2.4.
  @@index([organizationId, entryDate])
  @@index([organizationId, transactionId])
  @@index([organizationId, templateCode])
  @@map("journal_entries")
}

/// Línea. Sin columna de anulación, por diseño (ADR-0003). `entryDate`,
/// `fiscalYearId` y `entryKind` están DENORMALIZADOS para que los informes no
/// hagan JOIN; la coherencia no depende del código: la impone la FK compuesta
/// contra `journal_entries_denorm_key` (§2.4).
model JournalLine {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  entryId        String       @map("entry_id") @db.Uuid
  entry          JournalEntry @relation(fields: [entryId], references: [id], onDelete: Restrict)

  /// Orden dentro del asiento, 1..n. Único por asiento.
  lineNo      Int    @map("line_no")
  accountCode String @map("account_code") @db.VarChar(12)
  account     LedgerAccount @relation(fields: [organizationId, accountCode], references: [organizationId, code], onDelete: Restrict, onUpdate: Cascade)

  /// Exactamente uno > 0 (CHECK). Nunca negativos: el signo lo da el lado.
  debitCents  Int     @default(0) @map("debit_cents")
  creditCents Int     @default(0) @map("credit_cents")
  description String? @db.VarChar(512)

  /// Destino analítico. Columnas creadas ya, SIN FK: las tablas destino llegan
  /// en E4 (§2.3). Hoy `buildEntry` obliga a que sean NULL.
  projectId      String?       @map("project_id") @db.Uuid
  costCenterId   String?       @map("cost_center_id") @db.Uuid
  businessLineId String?       @map("business_line_id") @db.Uuid
  analyticType   AnalyticType? @map("analytic_type")

  taxRateId      String?   @map("tax_rate_id") @db.Uuid
  taxRate        TaxRate?  @relation(fields: [taxRateId], references: [id], onDelete: Restrict)
  /// Base sobre la que se calculó la cuota de esta línea de impuesto, en
  /// céntimos. Null en líneas que no son de impuesto. Hace reproducible R-IVA-5.
  taxBaseCents   Int?      @map("tax_base_cents")
  counterpartyId String?   @map("counterparty_id") @db.Uuid
  dueDate        DateTime? @map("due_date") @db.Date

  // Denormalizado desde el asiento (ver FK compuesta en §2.4).
  entryDate    DateTime  @map("entry_date") @db.Date
  fiscalYearId String    @map("fiscal_year_id") @db.Uuid
  entryKind    EntryKind @map("entry_kind")

  createdAt DateTime @default(now()) @map("created_at")

  @@unique([entryId, lineNo])
  @@index([organizationId, entryDate])
  @@index([organizationId, accountCode, entryDate])
  @@index([organizationId, entryId])
  @@index([organizationId, projectId])
  @@index([organizationId, costCenterId])
  @@map("journal_lines")
}
```

Y en los modelos existentes:

```prisma
model Transaction {
  // … campos heredados …
  status         TransactionStatus @default(DRAFT)
  journalEntryId String?           @map("journal_entry_id") @db.Uuid
  journalEntry   JournalEntry?     @relation("TransactionPosted", fields: [journalEntryId], references: [id], onDelete: SetNull)
  entries        JournalEntry[]    @relation("TransactionEntry")

  @@unique([organizationId, id])   // destino de la FK compuesta desde journal_entries
  @@index([organizationId, status])
}

model Organization {
  // O-7: `prorrataPermille` (por mil) se RENOMBRA a `prorrataBps` (puntos
  // básicos). `TaxRate.rateBps` ya está en bps y el cálculo del IVA deducible
  // es `applyBps(cuota, prorrataBps)`: dos escalas en la misma fórmula son un
  // error latente. E2 no lo usó nunca, así que la migración es un `RENAME` +
  // `valor × 10` sobre las filas existentes (hoy todas NULL en la práctica).
  prorrataBps    Int?           @map("prorrata_bps")
  fiscalYears    FiscalYear[]
  periodLocks    PeriodLock[]
  journalEntries JournalEntry[]
  journalLines   JournalLine[]
}
```

**Observaciones del experto que E3 aplaza** (ninguna bloquea una plantilla; el motivo de aplazar es que la épica que las necesita es la que sabe qué valores poner):

| Obs. | Qué falta | Épica | Por qué es seguro aplazarla |
|---|---|---|---|
| O-3 | `templateVersion Int` junto a `templateCode` | **E8** | En E3 **todas** las plantillas son versión 1, así que I-E3-5 es exacto sin la columna. La migración que la añada pondrá `1` en todo el histórico y ese valor será correcto por construcción, porque hasta entonces no habrá existido otra versión. El día que una plantilla cambie, la columna debe existir **antes** del cambio: queda como condición de entrada de E8 |
| O-5 | `OPENING` = nº 1, `CLOSING` = último, fechas en los extremos del ejercicio | **E9** | Solo aplica a T-27/T-28, que en E3 no tienen acción de usuario. E9 la añade como trigger junto con la orquestación del cierre |
| O-6 | `originalCurrency`, `originalAmountCents`, `exchangeRateId` en la línea | **E8** | T-08/T-09 registran la diferencia de cambio a partir de un importe del input; guardar el original exige `ExchangeRate` servidor, que es justo lo que E8 crea (gap G-04) |
| O-8 | `isForecast Boolean` | **E10** | E3 **no genera previsiones**, así que la rama "salvo previsión marcada" de I8 se retira del alcance: en E3, toda fecha futura bloquea sin excepción. E10 (previsión de tesorería) reintroduce ambas cosas a la vez |
| O-9 | `INVOICE_IN` en `SourceType` | **E8** | El libro registro de facturas recibidas (SII/303) es trabajo de E8/E9. `ALTER TYPE … ADD VALUE` es barato y no reescribe filas; hasta entonces T-03…T-05 usan `DOCUMENT` |

`lib/db.ts` → `TENANT_MODELS` += `"FiscalYear"`, `"PeriodLock"`, `"JournalEntry"`, `"JournalLine"`.

### 2.3 Decisión: destino analítico en las líneas (E3 vs E4)

Las cuatro columnas analíticas se crean **ahora**, nullable y **sin FK**, porque `journal_lines` es la tabla que más crece y porque la forma canónica de `ledgerHash` y el SQL de los informes deben quedar fijados en E3 y no cambiar en E4 (un cambio de forma invalidaría todos los hashes ya emitidos). El riesgo obvio —uuids huérfanos apuntando a tablas que no existen— se cierra por construcción, no por confianza:

- `validateEntry` (E3) **rechaza** cualquier línea con `projectId`, `costCenterId` o `businessLineId` no nulo, con error `ANALYTIC_DIM_UNAVAILABLE`. No hay ningún camino en E3 (ni motor, ni plantillas, ni UI, ni acciones) capaz de escribir un valor ahí. `analyticType` **sí** se admite (es un enum, no una FK: su catálogo existe desde E2 en `LedgerAccount.analyticType`), y las plantillas lo propagan desde la cuenta o desde el override de la línea; así la clasificación queda registrada desde el primer asiento y E4 no tiene que reconstruirla.
- La migración de E3 añade `CHECK (project_id IS NULL AND cost_center_id IS NULL AND business_line_id IS NULL)` con nombre `journal_lines_analytics_e4` y comentario `COMMENT ON CONSTRAINT … 'Se elimina en E4 al crear las FK compuestas'`. La barrera 2 dice lo mismo que la barrera 1.
- E4 elimina ese CHECK, retira la guarda de `validateEntry`, añade las FK compuestas `(organization_id, project_id) → projects(organization_id, id)` etc. y las valida con `NOT VALID` + `VALIDATE CONSTRAINT` (barato: todas las filas existentes son NULL).

**D-E3-1 — Qué pasa con C-9 (destino analítico obligatorio) y con los fixtures.** Las 28 plantillas del experto marcan qué líneas exigen `projectId`/`costCenterId`, y los fixtures traen `projectCode`/`costCenterCode` en 326 líneas. En E3 eso **no se persiste**: `checkDraft` implementa C-9 completo, pero la comprobación queda inerte mientras `ctx.dimensions.available === false`, que es el estado de E3, y el cargador de fixtures **descarta** `projectCode`/`costCenterCode`/`businessLineCode` al insertar, dejando las columnas a NULL (con un test que fija ese comportamiento, para que se rompa a propósito cuando E4 lo cambie). `Organization.analyticsRequired` no se toca: se ignora en E3.

Así, los fixtures son **los mismos ficheros** en E3 y en E4: E4 elimina el CHECK, retira la guarda, crea las tres tablas de dimensiones a partir de las secciones `businessLines`/`projects`/`costCenters` que el fixture ya trae, y el cargador deja de descartar los códigos. Ninguna cifra del fixture cambia, y las 326 líneas ganan destino sin regenerar nada.

Alternativa descartada: no crear las columnas hasta E4. `ALTER TABLE ADD COLUMN` nullable es instantáneo en PG 17, así que el ahorro sería nulo, pero obligaría a cambiar la forma canónica del hash y a versionarlo (`ledgerHashV1`/`V2`) en medio de la vida del producto.
Alternativa descartada: adelantar `BusinessLine`/`Project`/`CostCenter` a E3 para que C-9 funcione ya. Son el núcleo de E4 (con `MarginLevelConfig`, `AnalyticType` por cuenta y la PyG analítica): traerlas media épica antes no ahorra trabajo, solo lo mueve, y engorda una épica que ya es la más larga del roadmap.

### 2.4 SQL de integridad (migración `20260906100000_e3_ledger`)

```sql
-- 1. CHECKs de línea ────────────────────────────────────────────────────────
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_amounts_nonneg CHECK (debit_cents >= 0 AND credit_cents >= 0),
  ADD CONSTRAINT journal_lines_debit_xor_credit CHECK ((debit_cents = 0) <> (credit_cents = 0)),
  ADD CONSTRAINT journal_lines_line_no_positive CHECK (line_no >= 1),
  ADD CONSTRAINT journal_lines_tax_base_sign CHECK (tax_base_cents IS NULL OR tax_base_cents >= 0),
  ADD CONSTRAINT journal_lines_analytics_e4 CHECK (project_id IS NULL AND cost_center_id IS NULL AND business_line_id IS NULL);
COMMENT ON CONSTRAINT journal_lines_analytics_e4 ON journal_lines IS
  'E3: las dimensiones analíticas no existen hasta E4. Se elimina en la migración de E4 al crear sus FK compuestas.';

-- Coherencia de las tres fechas (O-1): `resolveEntryDate` solo desplaza HACIA
-- ADELANTE, así que la fecha contable nunca es anterior al devengo.
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_dates_order
  CHECK (accrual_date IS NULL OR entry_date >= accrual_date);

ALTER TABLE period_locks ADD CONSTRAINT period_locks_month_range CHECK (month BETWEEN 1 AND 12);
ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_dates CHECK (end_date >= start_date);
ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_counter CHECK (last_entry_number >= 0);

-- Ejercicios de una misma organización que no se solapan (btree_gist ya está
-- instalada desde E2). Un asiento no puede caer en dos ejercicios a la vez.
ALTER TABLE fiscal_years
  ADD CONSTRAINT fiscal_years_no_overlap
  EXCLUDE USING gist (organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&);

-- 2. La denormalización la impone la BD, no el código ───────────────────────
-- journal_entries lleva UNIQUE (organization_id, id, entry_date, fiscal_year_id, kind).
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_entry_denorm_fkey
  FOREIGN KEY (organization_id, entry_id, entry_date, fiscal_year_id, entry_kind)
  REFERENCES journal_entries (organization_id, id, entry_date, fiscal_year_id, kind)
  ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- 3. Partida doble: constraint trigger DIFERIDO ─────────────────────────────
-- Diferido porque las líneas se insertan una a una (o con createMany) DESPUÉS
-- del asiento: durante la transacción el asiento está descuadrado por
-- construcción. Al COMMIT no puede estarlo.
CREATE OR REPLACE FUNCTION app.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_entry uuid := COALESCE(NEW.entry_id, OLD.entry_id);
  v_debit  bigint;
  v_credit bigint;
  v_lines  int;
  v_with_debit  int;
  v_with_credit int;
BEGIN
  -- El asiento pudo borrarse en la misma transacción (no debería: no hay DELETE).
  IF NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = v_entry) THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0), COUNT(*),
         COUNT(*) FILTER (WHERE debit_cents > 0), COUNT(*) FILTER (WHERE credit_cents > 0)
    INTO v_debit, v_credit, v_lines, v_with_debit, v_with_credit
    FROM journal_lines WHERE entry_id = v_entry;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'asiento % con % línea(s): un asiento tiene al menos dos', v_entry, v_lines
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_min_lines';
  END IF;
  -- C-4 del experto: además de ≥ 2 líneas, ≥ 1 al debe y ≥ 1 al haber. Con
  -- importes > 0 el descuadre ya lo cazaría, pero este mensaje es el útil.
  IF v_with_debit = 0 OR v_with_credit = 0 THEN
    RAISE EXCEPTION 'asiento % sin contrapartida: % línea(s) al debe, % al haber',
      v_entry, v_with_debit, v_with_credit
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_both_sides';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'asiento % descuadrado: debe % <> haber % (diferencia %)',
      v_entry, v_debit, v_credit, v_debit - v_credit
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_balanced';
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();

-- Un asiento SIN líneas también es un descuadre: se comprueba desde el asiento.
CREATE OR REPLACE FUNCTION app.assert_entry_has_lines() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_lines int;
BEGIN
  SELECT COUNT(*) INTO v_lines FROM journal_lines WHERE entry_id = NEW.id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'asiento % sin líneas', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_min_lines';
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER journal_entries_has_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_has_lines();

-- 4. Fecha: ejercicio ABIERTO y mes NO bloqueado ────────────────────────────
-- No diferido: falla en el INSERT, con el mensaje que la UI enseña.
CREATE OR REPLACE FUNCTION app.assert_entry_period_open() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE fy record;
BEGIN
  SELECT * INTO fy FROM fiscal_years
   WHERE id = NEW.fiscal_year_id AND organization_id = NEW.organization_id;
  IF fy IS NULL THEN
    RAISE EXCEPTION 'ejercicio inexistente en la organización' USING ERRCODE = '23503';
  END IF;
  IF fy.status = 'CLOSED' THEN
    RAISE EXCEPTION 'el ejercicio % está cerrado', fy.code USING ERRCODE = '23514';
  END IF;
  IF NEW.entry_date < fy.start_date OR NEW.entry_date > fy.end_date THEN
    RAISE EXCEPTION 'la fecha % cae fuera del ejercicio % (% .. %)',
      NEW.entry_date, fy.code, fy.start_date, fy.end_date USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM period_locks pl
              WHERE pl.organization_id = NEW.organization_id
                AND pl.fiscal_year_id = NEW.fiscal_year_id
                AND pl.month = EXTRACT(MONTH FROM NEW.entry_date)::int) THEN
    RAISE EXCEPTION 'el mes % del ejercicio % está bloqueado',
      EXTRACT(MONTH FROM NEW.entry_date)::int, fy.code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_period_open();

-- 5. La cuenta debe ser POSTABLE y ACTIVA (I9). La FK compuesta ya garantiza
--    que es del mismo tenant (I10); esto añade las dos condiciones de estado.
CREATE OR REPLACE FUNCTION app.assert_line_account_postable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE a record;
BEGIN
  SELECT is_postable, is_active INTO a FROM accounts
   WHERE organization_id = NEW.organization_id AND code = NEW.account_code;
  IF a IS NULL THEN
    RAISE EXCEPTION 'cuenta % inexistente en la organización', NEW.account_code USING ERRCODE = '23503';
  END IF;
  IF NOT a.is_postable OR NOT a.is_active THEN
    RAISE EXCEPTION 'la cuenta % no admite apuntes (postable=%, activa=%)',
      NEW.account_code, a.is_postable, a.is_active USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER journal_lines_account_postable
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.assert_line_account_postable();

-- 6. Anulación: una sola, y nunca de un contra-asiento (O-4) ───────────────
-- I-E3-2: como máximo UN contra-asiento por asiento anulado.
CREATE UNIQUE INDEX journal_entries_one_reversal
  ON journal_entries (organization_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

-- I-E3-4 (CA-1 y CA-2): no se anula un REVERSAL con otro REVERSAL —para
-- deshacer una anulación se vuelve a registrar el hecho económico— ni se anulan
-- los asientos de sistema, que se deshacen reabriendo el ejercicio.
CREATE OR REPLACE FUNCTION app.assert_reversal_target() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_kind entry_kind;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.kind <> 'REVERSAL' THEN
    RAISE EXCEPTION 'solo un asiento REVERSAL puede referenciar reverses_entry_id'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_kind';
  END IF;
  SELECT kind INTO v_kind FROM journal_entries
   WHERE id = NEW.reverses_entry_id AND organization_id = NEW.organization_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'el asiento anulado no existe en la organización' USING ERRCODE = '23503';
  END IF;
  IF v_kind = 'REVERSAL' THEN
    RAISE EXCEPTION 'un contra-asiento no puede anular otro contra-asiento (I-E3-4)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_no_double_reversal';
  END IF;
  IF v_kind IN ('OPENING', 'CLOSING', 'REGULARIZATION') THEN
    RAISE EXCEPTION 'los asientos de kind % no se anulan con contra-asiento (CA-1)', v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_target_kind';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER journal_entries_reversal_target
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.assert_reversal_target();

-- 7. Nada se borra, nada se edita: privilegios ──────────────────────────────
REVOKE ALL ON journal_entries, journal_lines FROM app_runtime;
GRANT SELECT, INSERT ON journal_entries, journal_lines TO app_runtime;
-- Única mutación admitida en todo el diario: marcar un asiento como anulado.
GRANT UPDATE (voided_at, voided_by_id, void_reason) ON journal_entries TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_years, period_locks TO app_runtime;
```

Nota sobre la desactivación de cuentas: E2 dejó `getAccountUsage(db, code).movementCount` en `0` con un `TODO(E3)` y su test. E3 lo implementa contando `journal_lines`; `canDeactivateAccount` y `canDeleteAccount` empiezan entonces a bloquear de verdad, y `deleteAccount` queda además protegido por `ON DELETE RESTRICT` de la FK de línea.

### 2.5 RLS estricta y retirada de la deuda (migración `20260906110000_e3_rls_strict`) — ADR-0009

Las cuatro tablas nuevas nacen con política estricta y `FORCE`, y las dieciséis anteriores se convierten:

```sql
-- Tablas de E3
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_years','period_locks','journal_entries','journal_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
                        USING (organization_id = app.current_org())
                        WITH CHECK (organization_id = app.current_org())$f$, t);
    -- Nada se borra (MODELO-DATOS §Integridad).
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (false)', t || '_no_delete', t);
  END LOOP;
END $$;
-- journal_lines es además inmutable: ni siquiera las columnas de anulación.
CREATE POLICY journal_lines_no_update ON journal_lines AS RESTRICTIVE FOR UPDATE USING (false);
-- period_locks y fiscal_years SÍ se actualizan/borran (desbloquear un mes).
DROP POLICY fiscal_years_no_delete ON fiscal_years;
DROP POLICY period_locks_no_delete ON period_locks;

-- Retirada del escape en las DIECISÉIS tablas de E1 + E2 (ADR-0007 §4, ADR-0008 §2)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions',
    'app_data','progress','invitations',
    'accounts','organization_account_maps','tax_rates','audit_logs'
  ] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
                        USING (organization_id = app.current_org())
                        WITH CHECK (organization_id = app.current_org())$f$, t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- currencies: híbrida, conserva el catálogo global; pierde el escape.
DROP POLICY tenant_isolation ON currencies;
CREATE POLICY tenant_isolation ON currencies
  USING (organization_id IS NULL OR organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
ALTER TABLE currencies FORCE ROW LEVEL SECURITY;

-- organizations: se retira `OR app.current_user() IS NOT NULL` del WITH CHECK
-- (deuda 1 de ESTADO.md) y el escape doble-NULL del USING.
DROP POLICY tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (
    id = app.current_org()
    OR (app.current_user() IS NOT NULL
        AND id IN (SELECT m.organization_id FROM memberships m WHERE m.user_id = app.current_user()))
  )
  WITH CHECK (id = app.current_org());

DROP POLICY tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships
  USING (user_id = app.current_user() OR organization_id = app.current_org())
  WITH CHECK (
    organization_id = app.current_org()
    OR (app.current_user() IS NOT NULL AND user_id = app.current_user())
  );

-- Acceso a una invitación POR TOKEN: no hay organización activa ni membresía
-- todavía, así que ninguna política puede autorizarlo. Se abre una puerta
-- estrecha y auditable en vez de un escape general.
CREATE OR REPLACE FUNCTION app.invitation_by_token_hash(p_hash text)
RETURNS TABLE (id uuid, organization_id uuid, email text, role role, status invitation_status, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $fn$
  SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at
  FROM invitations i WHERE i.token_hash = p_hash
$fn$;
REVOKE ALL ON FUNCTION app.invitation_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_by_token_hash(text) TO app_runtime;

-- Rol de mantenimiento: los scripts de operador que recorren TODAS las
-- organizaciones (migración de uploads, backfills) dejan de depender de un
-- agujero en la política y pasan a depender de una credencial que el operador
-- entrega a propósito. NOLOGIN por defecto.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;
  END IF;
  EXECUTE 'ALTER ROLE app_maintenance WITH BYPASSRLS NOSUPERUSER';
END $$;
GRANT USAGE ON SCHEMA public, app TO app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_maintenance;
```

**Consecuencia de `FORCE` sobre las migraciones futuras.** El propietario deja de esquivar las políticas, así que una migración que haga *backfill* de datos en una tabla de negocio ya no verá nada. Patrón obligatorio a partir de aquí, documentado en `CLAUDE.md`: envolver el backfill en `ALTER TABLE x NO FORCE ROW LEVEL SECURITY; … ; ALTER TABLE x FORCE ROW LEVEL SECURITY;` dentro de la misma migración (DDL, es transaccional en Postgres), o hacerlo desde `app_maintenance`. Un test de la suite RLS comprueba que ninguna tabla queda en `NO FORCE` al final de la cadena de migraciones.

**Ganancia colateral:** `audit_logs` pasa a ser append-only también para el propietario (deuda 5 de `ESTADO.md`), y `journal_lines` nace inmutable para todos salvo `app_maintenance`.

### 2.6 Qué código de negocio sigue fuera de `tenantTransaction` (auditoría previa, obligatoria antes de T2)

`tenantDb(orgId)` **ya** fija los GUC en cada operación (E1-fix), así que la mayoría del código heredado sobrevive a la retirada del escape sin tocarlo. Los casos que **no** sobreviven se han localizado por `grep prisma\.<modelo>` y `grep tenantDb(`:

| Fichero | Qué hace | Qué pasa al retirar el escape | Arreglo en E3 |
|---|---|---|---|
| `models/organizations.ts:37,41,50,55,112` | `prisma.organization.findUnique` sin GUC (`getOrganizationById`, por slug, por `stripeCustomerId`) | Devuelve `null` **siempre** → `getOrgContext` deja de resolver la organización activa: **la app entera deja de funcionar** | Envolver en `withTenantGucs(null, userId, …)` (búsqueda por pertenencia) o en `withTenantGucs(orgId, undefined, …)` cuando el id ya se conoce. El webhook de Stripe no tiene usuario: pasa a `app_maintenance` o a una función `SECURITY DEFINER` análoga a la de invitaciones |
| `models/memberships.ts:9,16,29,37,69,102` | `prisma.membership.*` sin GUC (`getMembership`, `getUserMemberships`, recuento de ADMIN) | Devuelve vacío → nadie tiene rol; `requireOrg` lanza `NO_ORGANIZATION` a todo el mundo | `withTenantGucs(null, userId, …)`: la política de `memberships` ya autoriza `user_id = app.current_user()` |
| `models/invitations.ts:148` | `findInvitationByToken` sin organización | Devuelve `null` → ninguna invitación se puede aceptar | `app.invitation_by_token_hash()` (§2.5) |
| `lib/email-sync/ingest.ts:141` | `prisma.appData.findMany` **cross-org** a propósito (el cron recorre todas las organizaciones) | Devuelve 0 filas → **el sync de email deja de sincronizar en silencio**, sin error | Función `app.list_email_sync_targets()` `SECURITY DEFINER` que devuelve solo `(organization_id, user_id)`; el bucle sigue acotando cada iteración con `tenantDb` / `withTenantGucs` como ya hace |
| `scripts/migrate-uploads-to-org.ts:88,91,125,143,148` | Script de operador, recorre organizaciones y ficheros | Ve 0 filas | Conectar como `app_maintenance` (`MAINTENANCE_DATABASE_URL`); el script aborta con mensaje claro si el rol no tiene `BYPASSRLS` |
| `models/users.ts:60` | `tenantDb(organization.id)` a partir de la organización personal | Correcto ya (GUC por operación) | Sin cambios |
| `app/(auth)/**`, `app/(app)/organizations/actions.ts`, `lib/authz.ts` | Usan `tenantDb` / `tenantTransaction` | Correctos | Sin cambios |

**Refactor a `tenantTransaction` agrupado (deuda 3 de `ESTADO.md`).** Es una optimización, no una condición de seguridad, así que se acota para que no devore la épica: se agrupan **solo** los caminos que hoy hacen ≥ 3 operaciones seguidas sobre el mismo tenant — `createOrganizationDefaults` (ya lo hace), `runEmailSync` por iteración, `getOrgContext` (organización + membresía + plan en una sola transacción por request) y todas las acciones nuevas de E3, que nacen dentro de `tenantTransaction` por diseño. El resto del código heredado se queda como está, con la envoltura por operación, y la deuda se cierra formalmente: dejó de ser deuda de seguridad y pasó a ser coste conocido.

Salvaguarda para que no reaparezca: regla ESLint `no-restricted-syntax` que prohíbe `prisma.<modelo de negocio>` fuera de `lib/db.ts`, `models/{organizations,memberships,invitations,users}.ts` y `scripts/`, más la suite `test:integration:rls`, que a partir de E3 ejecuta **todos** los `models/` como `app_runtime` y falla si alguno devuelve vacío por RLS.

---

## 3. Motor puro — `lib/ledger/`

Funciones puras: sin IO, sin LLM, sin `Date.now()` (el hook `.claude/hooks/guard.sh` y el CI lo bloquean; hay que ampliar ambos a `lib/ledger/`). Toda función que necesite "hoy" recibe `refDate: Date` como último argumento. `Result<T>` es el mismo tipo de `lib/accounts/types.ts` (`{ok:true,value} | {ok:false,errors}`), reutilizado con un `LedgerErrorCode` propio.

### 3.1 Tipos (`lib/ledger/types.ts`)

Alineados con el contrato de `docs/design/E3-asientos-tipo.md` §0. Dos cambios respecto a la ronda 1: la línea se identifica por **`accountKey` preferente** (`accountCode` solo para las cuentas que elige el usuario o el documento), y el borrador lleva las **tres fechas** y el **modo de redondeo sellado**.

```ts
export type Cents = number                  // entero; en una línea siempre ≥ 0
export type LocalDate = string              // "YYYY-MM-DD", sin zona: columna @db.Date

export type DraftLine = {
  lineNo: number
  /** Preferente: toda contrapartida que decide el MOTOR es una AccountKey. */
  accountKey?: AccountKey
  /** Solo cuentas que decide el usuario o el documento: 621, 628, 681, 216, 113… */
  accountCode?: string
  debitCents: Cents
  creditCents: Cents
  description?: string | null
  taxRateId?: string | null
  /** Base sobre la que se calculó esta cuota. Null si la línea no es de impuesto. */
  taxBaseCents?: Cents | null
  counterpartyId?: string | null
  /** Una línea de 43x/40x POR VENCIMIENTO (decisión 6 de §9.2). */
  dueDate?: LocalDate | null
  /** Se persiste ya: es un enum, no una FK (§2.3, D-E3-1). */
  analyticType?: AnalyticType | null
  /** E4: el motor los acepta en el tipo y los RECHAZA al validar (§2.3). */
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
}

export type EntryDraft = {
  organizationId: string
  fiscalYearId: string
  /** Las tres fechas (O-1). `entryDate` la fija resolveEntryDate, no el usuario. */
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
  entryDate: LocalDate
  description: string
  kind: EntryKind
  sourceType: SourceType
  sourceId?: string | null
  transactionId?: string | null
  fileId?: string | null
  templateCode?: TemplateCode | null
  /** Sellado en el asiento (O-2, R-IVA-4). */
  taxRoundingMode: TaxRoundingMode
  reversesEntryId?: string | null
  lines: DraftLine[]
}

/** Todo lo que el motor necesita saber de la organización. Se compone en `models/`. */
export type LedgerContext = {
  organizationId: string
  refDate: LocalDate                           // "hoy" SIEMPRE por parámetro
  plan: Plan                                   // lib/accounts/types.ts
  map: (key: AccountKey) => string              // I-plan-1 ya validado al construir el ctx
  rates: readonly TaxRateRow[]
  fiscalYears: readonly FiscalYearRef[]        // {id, code, startDate, endDate, status}
  periodLocks: readonly { fiscalYearId: string; month: number }[]
  policy: {
    taxRoundingMode: TaxRoundingMode
    prorrataBps: number | null                 // O-7: bps, NO por mil
    redondeoToleranciaCents: number
    analyticsRequired: boolean
  }
  /** D-E3-1: false en E3, true desde E4. Activa C-9 y levanta la guarda analítica. */
  dimensions: { available: boolean }
  baseCurrency: string
}

export type LedgerErrorCode =
  | "UNBALANCED" | "LINE_SIDE" | "LINE_NEGATIVE" | "TOO_FEW_LINES" | "ONE_SIDED_ENTRY" | "ZERO_LINE"
  | "ACCOUNT_UNKNOWN" | "ACCOUNT_NOT_POSTABLE" | "ACCOUNT_INACTIVE" | "MAP_KEY_UNMAPPED"
  | "FY_NOT_FOUND" | "FY_CLOSED" | "DATE_OUT_OF_FY" | "MONTH_LOCKED" | "FUTURE_DATE"
  | "TAX_RATE_NOT_IN_FORCE" | "TAX_SIDE_MISMATCH" | "DOCUMENT_TOTAL_MISMATCH"
  | "TAX_BASE_MISMATCH" | "TAX_ROUNDING_EXCEEDED" | "PRORRATA_NOT_CONFIGURED"
  | "RECTIFICATION_SIGN" | "RECTIFICATION_EXCEEDS" | "PAYMENT_EXCEEDS_LIABILITY"
  | "ANALYTIC_DEST_MISSING" | "ANALYTIC_DIM_UNAVAILABLE"
  | "ALREADY_REVERSED" | "REVERSAL_OF_REVERSAL" | "REVERSAL_TARGET_KIND"
  | "TEMPLATE_INPUT" | "TENANT_MISMATCH"
```

### 3.2 Firmas

| Fichero | Firma | Qué hace |
|---|---|---|
| `lib/ledger/dates.ts` | `resolveEntryDate(input: { documentDate; accrualDate? }, ctx: LedgerContext): Result<{ entryDate: LocalDate; shifted: "NONE" \| "MONTH_LOCKED" \| "FY_CLOSED"; note?: string }>` | La regla determinista de `E3-asientos-tipo.md` §2.2: candidato = `accrualDate ?? documentDate`; si su mes está bloqueado → **primer día del primer mes abierto ≥ candidato**; si su ejercicio está `CLOSED` → señal `FY_CLOSED` (el llamante debe usar T-22); si `candidato > refDate` → `FUTURE_DATE`. Cuando desplaza, devuelve la coletilla obligatoria `"[devengo YYYY-MM-DD]"` para la descripción |
| `lib/ledger/post.ts` | `buildEntry(input: EntryInput, ctx: LedgerContext): Result<EntryDraft>` | Normaliza (renumera `lineNo` 1..n, resuelve `accountKey` → código, recorta descripciones, **omite** las líneas que quedarían a cero), resuelve fecha y ejercicio, sella `taxRoundingMode`, y llama a `checkDraft` |
| | `checkDraft(draft: EntryDraft, ctx: LedgerContext): Result<EntryDraft>` | Los **13 checks C-1…C-13** del experto, en ese orden. **Devuelve todos los errores**, no el primero, cada uno anclado a su `lineNo` |
| `lib/ledger/tax.ts` | `cuotaPorTipo(lines, rate)` · `cuotaPorLinea(lines, rate)` · `retencion(baseTotal, rate)` · `deducible(cuota, prorrataBps)` · `ajusteRedondeo(diff, ctx)` | La aritmética común de §0.1 del experto, toda sobre `applyBps` de `lib/taxes/bps.ts`. `deducible` devuelve el par `{ deducibleCents, noDeducibleCents }`; el no deducible **engorda la línea de gasto/inmovilizado**, no la de 472 |
| `lib/ledger/void.ts` | `buildReversal(entry: PostedEntry, opts: { reason: string; requestedDate?: LocalDate }, ctx: LedgerContext): Result<EntryDraft>` | T-21: espejo **exacto** (copia e invierte columnas, conserva `lineNo`, destinos y `taxRateId`; no recalcula nada). Fecha por §2.5 del experto: la del original si su mes sigue abierto, si no el **primer día del primer mes abierto ≥ `entryDate` original**; `requestedDate` solo puede retrasarla. Bloquea CA-1…CA-6 |
| `lib/ledger/hash.ts` | `ledgerHash(lines: readonly HashableLine[]): string` · `entryHash(lines): string` | sha256 de la forma canónica: líneas ordenadas por `(entryDate, entryNumber, lineNo)`, TSV con `entry_date, entry_number, line_no, account_code, debit_cents, credit_cents, entry_kind, project_id, cost_center_id, business_line_id`, `\n` entre filas, `∅` para nulos. **Forma v1, no cambia** (§2.3) |
| `lib/ledger/invariants.ts` | `runInvariants(input: InvariantInput, refDate: LocalDate): Validacion` | I1, I7–I10 e I-E3-1…7 → `validacion.json` (§5) |
| `lib/ledger/reports/diario.ts` | `buildDiario(entries, lines, params): DiarioReport` | Asientos ordenados por `(entryDate, entryNumber)` (N-5), con totales y fila de cuadre |
| `lib/ledger/reports/mayor.ts` | `buildMayor(lines, accounts, params: { from, to, accountCodes? }): MayorReport` | Saldo inicial (Σ hasta `from − 1`) + movimientos + saldo final por cuenta |
| `lib/ledger/reports/sumas-saldos.ts` | `buildSumasSaldos(lines, accounts, params): SumasSaldosReport` | Sumas debe/haber y saldo deudor/acreedor por cuenta, jerarquía por prefijo, fila de cuadre `Σdeudor − Σacreedor = 0` |
| `lib/ledger/provenance.ts` | `cellProvenance(metric, params, ledgerHash, gitSha): Provenance` | El bloque `{valor, metrica, run_id, ledgerHash, calculado_por, registros_origen, confianza}` de la skill `fiabilidad` |

Los tres informes reciben las líneas **ya leídas** (`models/ledger.ts` hace el SQL) y devuelven, además del resultado, la `provenance` por celda con la query que la origina. En E3 no se persiste `ReportRun` (llega en E6): el sello se calcula en cada render.

**Los 13 checks (`checkDraft`)** — definición canónica en `docs/design/E3-asientos-tipo.md` §0.2, aquí solo su estado en E3:

| Check | En E3 |
|---|---|
| C-1 partida doble · C-2 línea bien formada · C-3 sin líneas a cero · C-4 ≥ 2 líneas y ≥ 1 a cada lado | Activos, y **repetidos en la BD** (§2.4): son los cuatro que no pueden depender del código |
| C-5 documento cuadrado · C-6 detalle cuadrado · C-7 coherencia de cuota | Activos en las plantillas de documento (T-01…T-05); el `totalCents` del input es la referencia |
| C-8 cuentas · C-11 periodo · C-13 tenant | Activos, y repetidos en la BD (triggers y FK compuestas) |
| C-10 tipos vigentes | Activo. Se selecciona con **`documentDate`**, no con `entryDate` (un documento de 2025 contabilizado en 2026 lleva el tipo de 2025) |
| C-12 signos en rectificativas | Activo en T-02 y T-05 |
| **C-9 destino analítico** | **Implementado e inerte** hasta E4: se salta si `ctx.dimensions.available === false` (§2.3, D-E3-1). El test que fija ese comportamiento se invierte en E4 |

### 3.3 Las 28 plantillas (`lib/ledger/templates/`)

```ts
export type TemplateCode =
  | "FACTURA_EMITIDA_SERVICIOS" | "ABONO_EMITIDO" | "FACTURA_RECIBIDA" | "FACTURA_RECIBIDA_ISP"
  | "ABONO_RECIBIDO" | "ANTICIPO_CLIENTE" | "ANTICIPO_PROVEEDOR" | "COBRO_CLIENTE" | "PAGO_PROVEEDOR"
  | "NOMINA" | "PAGO_NOMINA" | "PAGO_SEGURIDAD_SOCIAL" | "PAGO_RETENCIONES" | "AMORTIZACION_MENSUAL"
  | "PERIODIFICACION_GASTO" | "DEVENGO_PERIODIFICACION_GASTO"
  | "PERIODIFICACION_INGRESO" | "DEVENGO_PERIODIFICACION_INGRESO"
  | "TRASPASO_TESORERIA" | "ASIENTO_MANUAL" | "CONTRA_ASIENTO" | "AJUSTE_EJERCICIO_CERRADO"
  | "REGULARIZACION_IVA" | "PAGO_IMPUESTO"
  | "IMPUESTO_BENEFICIOS" | "REGULARIZACION_RESULTADO" | "CIERRE_EJERCICIO" | "APERTURA_EJERCICIO"

export function buildFromTemplate<C extends TemplateCode>(
  code: C, input: TemplateInput[C], ctx: LedgerContext
): Result<EntryDraft>
```

Especificación línea a línea, con fórmulas y comprobaciones específicas: **`docs/design/E3-asientos-tipo.md` §1 (T-01…T-28)**. No se duplica aquí; ese documento es la fuente y este describe cómo se construye.

Reglas transversales que valen para las 28:

- **Ningún literal de cuenta.** Toda contrapartida que decide el motor es una `AccountKey` resuelta por `ctx.map`; toda cuenta que decide el usuario o el documento llega como `accountCode` y se valida contra el plan. `MAP_KEY_UNMAPPED` si falta una clave — y `validateAccountMap` (E2, I-plan-1) corre al construir el `LedgerContext`, de modo que un mapa roto bloquea **todas** las plantillas, no solo la afectada.
- **Ningún literal de tipo impositivo.** `selectTaxRate(ctx.rates, code, draft.documentDate)`; sin tipo vigente, `TAX_RATE_NOT_IN_FORCE`. Los tipos exentos (`rateBps = 0`) **no generan línea de cuota** (C-3), no una línea a cero.
- **El motor valida, no inventa.** Los importes que vienen de un tercero —`employeeSSCents`, `withholdingCents` y `netCents` de la nómina (art. 82 RIRPF), la base imponible del IS— se comprueban por identidad y una discrepancia bloquea. Es P1 de SPEC-FIABILIDAD aplicado a la letra.
- **Prorrata (decisión 3 de §9.2): se aplica en E3.** `deductibility: "FULL" | "NONE" | "PRORRATA"` por línea en T-03/T-04. `NDᵢ = cuotaᵢ − applyBps(cuotaᵢ, prorrataBps)` **incrementa el precio de adquisición** (NRV 2ª y 10ª, art. 103 LIVA), no ajusta la 472. `PRORRATA` sin `ctx.policy.prorrataBps` → `PRORRATA_NOT_CONFIGURED`. La regularización **anual** de prorrata y la de bienes de inversión van contra 634/639 y son **E9**.
- **Redondeo.** `PER_TIPO` (default): una cuota por tipo, `applyBps(Σ bases_del_tipo, rateBps)` — R-IVA-1/2. `PER_LINEA`: cuota por línea, sumada, sin mezclar métodos en un documento (R-IVA-3). El modo se **sella en el asiento** (O-2). Diferencia residual ≤ `redondeoToleranciaCents` → línea a `REDONDEO_GASTO`/`REDONDEO_INGRESO`; por encima, `TAX_ROUNDING_EXCEEDED` y nada se persiste (R-IVA-7).
- **Vencimientos (decisión 6 de §9.2).** T-01 y T-03 emiten **una línea de `CLIENTES`/`PROVEEDORES` por vencimiento**, cada una con su `dueDate` y su importe, sumando el total del documento. Con vencimiento único, una sola línea.

**Agrupación en tres bloques por complejidad** (es el reparto de las tareas T5a/T5b/T5c de §8.2):

| Bloque | Plantillas | Qué las agrupa | Coste |
|---|---|---|---|
| **A — Documento con impuestos** (7) | T-01 `FACTURA_EMITIDA_SERVICIOS` · T-02 `ABONO_EMITIDO` · T-03 `FACTURA_RECIBIDA` · T-04 `FACTURA_RECIBIDA_ISP` · T-05 `ABONO_RECIBIDO` · T-06 `ANTICIPO_CLIENTE` · T-07 `ANTICIPO_PROVEEDOR` | Todas comparten `lib/ledger/tax.ts`: cuota por tipo, retención sobre base total, prorrata, recargo de equivalencia, anticipos con IVA devengado, rectificativas con el tipo del documento **original**. Son las que concentran C-5, C-6, C-7, C-10 y C-12 | La mitad del bloque de plantillas |
| **B — Tesorería, personal y periodificación** (11) | T-08 `COBRO_CLIENTE` · T-09 `PAGO_PROVEEDOR` · T-10 `NOMINA` · T-11…T-13 pagos de deuda · T-14 `AMORTIZACION_MENSUAL` · T-15…T-18 periodificaciones | Sin cálculo de impuesto: reparten un importe conocido entre cuentas conocidas. T-08/T-09 añaden comisión, diferencia de cambio y ajuste de redondeo; T-11…T-13 añaden `PAYMENT_EXCEEDS_LIABILITY`; T-10 es reparto multi-destino del bruto y la SS | Moderado |
| **C — Estructurales y de cierre** (10) | T-19 `TRASPASO_TESORERIA` · T-20 `ASIENTO_MANUAL` · T-21 `CONTRA_ASIENTO` · T-22 `AJUSTE_EJERCICIO_CERRADO` · T-23 `REGULARIZACION_IVA` · T-24 `PAGO_IMPUESTO` · **T-25…T-28** (sin acción de usuario en E3, §1) | No construyen desde un documento sino desde **saldos del diario** o desde otro asiento. Necesitan `models/ledger.getAccountBalances` como entrada (que el llamante les pasa: la plantilla sigue siendo pura) y llevan las reglas más delicadas: T-21 el espejo exacto, T-22 la NRV 22ª con 113/121 y 678/778, T-23 el arrastre de la cuota a compensar | Alto por reglas, bajo por aritmética |

**Corrección de norma incorporada:** el PGC 2007 suprimió las cuentas **679/779** junto con el resultado extraordinario; no están en `seeds/npgc.csv`. Los documentos de ejercicios cerrados van a **113/121** (error material o cambio de criterio, NRV 22ª) y **678/778** (importes no significativos, epígrafe 13, dentro del resultado de explotación). T-22 y los fixtures aplican esta regla, y ninguna especificación del proyecto debe citar 679/779.

---

## 4. Capa de aplicación

### 4.1 `models/` (IO, todo dentro de `tenantTransaction`)

| Fichero | Funciones |
|---|---|
| `models/fiscal-years.ts` | `listFiscalYears(db)` · `getFiscalYearForDate(db, date)` · `createFiscalYear(tx, input, actor)` · `closeFiscalYear(tx, id, actor, reason)` (**B-4**: exige los 12 meses bloqueados; en E3 **no** genera T-26/T-27, eso es E9, así que hasta entonces solo cierra ejercicios ya regularizados a mano o vacíos) · `lockPeriod(tx, fiscalYearId, month, actor, reason)` (**B-2**: secuencial, no se bloquea el mes *n* con *n−1* abierto) · `unlockPeriod(tx, …)` (**B-3**: desbloquear *n* desbloquea *n+1…12*; solo si el ejercicio sigue `OPEN`) |
| `models/ledger.ts` | `getLedgerContext(db, refDate)` (compone el `LedgerContext` de §3.1 en **una** transacción, incluida la validación del mapa) · `postEntry(orgId, draft, actor)` (§4.3) · `postEntries(orgId, drafts[], actor)` (lote con reserva de rango, I7) · `voidEntry(orgId, entryId, reason, actor)` · `listEntries(db, filter, page)` · `getEntry(db, id)` · `getLinesForPeriod(db, { from, to, accountCodes? })` (SQL agregado con `BIGINT`) · `getAccountBalances(db, { from, to, kinds? })` (entrada de T-23 y del bloque C) · `getOpenLiability(db, accountCode, upTo)` (`PAYMENT_EXCEEDS_LIABILITY` de T-11…T-13, T-24) · `countLinesByAccount(db, code)` (cierra el `TODO(E3)` de `getAccountUsage`) |
| `models/transactions.ts` | `+ postTransaction(orgId, transactionId, templateCode, input, actor)` → crea el asiento y deja `status = POSTED`, `journalEntryId`; `voidTransactionPosting(…)` → `status = VOID` tras el contra-asiento |
| `models/audit-log.ts` | `AuditEntity` += `"JournalEntry"`, `"FiscalYear"`, `"PeriodLock"`; `AuditAction` += `"post"`, `"void"`, `"lock"`, `"unlock"`, `"open"`, `"close"` |

### 4.2 Server actions

Todas empiezan por `requireOrg(<rol>)` y devuelven `ActionState`. Schemas zod en `forms/ledger.ts` y `forms/fiscal-years.ts`.

| Fichero | Action | Rol | Schema (resumen) |
|---|---|---|---|
| `app/(app)/ledger/actions.ts` | `postManualEntryAction` (T-20) | **EDITOR** | `{ documentDate?, accrualDate?, description, lines: [{ accountCode, debit, credit, description?, dueDate? }] (mín. 2) }`. `kind` **no es parámetro**: el asiento manual es siempre `NORMAL` — `OPENING`/`CLOSING`/`REGULARIZATION`/`REVERSAL` solo los produce el motor, y tocar la 129 fuera de T-26 está prohibido |
| | `postFromTemplateAction` | **EDITOR** | `z.discriminatedUnion("templateCode", …)` sobre las **24** plantillas de operativa (T-01…T-24). Las cuatro de cierre no tienen acción hasta E9 (§1) |
| | `postTransactionAction` | **EDITOR** | `{ transactionId, templateCode, input }` — "contabilizar" una operación heredada |
| | `voidEntryAction` (T-21) | **EDITOR** | `{ entryId, reason: z.string().min(10), requestedDate? }` — motivo **obligatorio** (CA-6). La fecha la calcula el motor por §2.5 del experto; `requestedDate` solo puede **retrasarla**, nunca adelantarla |
| `app/(app)/settings/fiscal-years/actions.ts` | `createFiscalYearAction` | **ADMIN** | `{ code, startDate, endDate }` — ejercicio irregular permitido; sin solapes ni huecos con los existentes |
| | `closeFiscalYearAction` | **ADMIN** | `{ fiscalYearId, reason }` — B-4 |
| | `lockPeriodAction` / `unlockPeriodAction` | **ADMIN** | `{ fiscalYearId, month, reason }` — B-2/B-3 |

**`reopenFiscalYearAction` se elimina** (decisión 4 de §9.2): reabrir un ejercicio cerrado equivale a reformular cuentas anuales ya rendidas (arts. 253, 272 y 279 LSC) y no es una operación de usuario. Un documento cuyo devengo cae en ejercicio cerrado se registra con **T-22** en el ejercicio abierto. `PeriodLock` sí es reversible por ADMIN; `FyStatus = CLOSED` no.

`VIEWER` lee el diario, el mayor y sumas y saldos, y no ve ningún control de mutación. La numeración, el cuadre y el periodo **no** se comprueban solo aquí: los repite la BD (§2.4), que es la barrera que no se puede olvidar.

### 4.3 `postEntry` — flujo de posteo (ARQUITECTURA §4)

```ts
export async function postEntry(organizationId: string, draft: EntryDraft, actor: Actor): Promise<PostedEntry> {
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    // 1. Numeración sin huecos: bloqueo pesimista sobre la fila del ejercicio.
    //    FOR UPDATE serializa a los posteadores concurrentes del MISMO ejercicio
    //    y nada más; dos organizaciones (o dos ejercicios) no se estorban.
    const [fy] = await tx.$queryRaw<FiscalYearRow[]>`
      SELECT id, code, start_date, end_date, status, last_entry_number
      FROM fiscal_years
      WHERE id = ${draft.fiscalYearId}::uuid AND organization_id = ${organizationId}::uuid
      FOR UPDATE`
    if (!fy) throw new LedgerError("FY_NOT_FOUND")
    if (fy.status === "CLOSED") throw new LedgerError("FY_CLOSED")
    const entryNumber = fy.last_entry_number + 1

    // 2. Asiento + líneas + contador, en la misma transacción.
    const entry = await tx.journalEntry.create({ data: { …draft, entryNumber, entryHash: entryHash(draft.lines), postedById: actor.userId } })
    await tx.journalLine.createMany({ data: draft.lines.map((l, i) => ({ …l, entryId: entry.id, lineNo: i + 1,
      entryDate: draft.entryDate, fiscalYearId: draft.fiscalYearId, entryKind: draft.kind })) })
    await tx.fiscalYear.update({ where: { id: fy.id }, data: { lastEntryNumber: entryNumber } })

    // 3. AuditLog en la MISMA transacción (E2, models/audit-log.ts).
    await writeAuditLog(tx, { entity: "JournalEntry", entityId: entry.id, action: "post",
      after: { entryNumber, entryDate, description, lines }, userId: actor.userId })

    // 4. Al COMMIT: constraint triggers diferidos (Σdebe = Σhaber, ≥ 2 líneas,
    //    coherencia de la denormalización). Si fallan, no hay asiento NI número.
    return entry
  })
}
```

Por qué el contador vive en `fiscal_years` y no en una secuencia: una secuencia de Postgres **deja huecos** al hacer rollback, y el art. 28 del Código de Comercio exige un diario correlativo. `FOR UPDATE` sobre una fila por ejercicio es el bloqueo más pequeño que garantiza la correlación. Coste: los posteos concurrentes del mismo ejercicio se serializan (aceptable: una PYME no postea 100 asientos/segundo; medir en QA con 50 posteos paralelos, criterio de aceptación 9).

Después del COMMIT, la action hace `revalidatePath("/ledger")` y las rutas de informes. No hay caché de informes que invalidar en E3 (`ReportRun` es E6): el `ledgerHash` cambia solo.

### 4.4 Pendientes de E2 que E3 cierra

1. **`importCustomPlan` por `createMany`** — mismo patrón que `importNpgc` tras la ronda 1 de revisión (agrupado por nivel, porque la FK compuesta exige el padre antes que el hijo), con `SEED_TRANSACTION_OPTIONS`. Test de rendimiento con 5000 filas (`MAX_IMPORT_ROWS`).
2. **Alta de organización + siembra atómica** — `createOrganizationWithOwner` y `createOrganizationDefaults` pasan a una **sola** `tenantTransaction` con `SEED_TRANSACTION_OPTIONS`; hoy son dos, y un fallo en la siembra deja una organización sin plan de cuentas. Se aprovecha para crear el **ejercicio del año en curso** en la misma unidad, de modo que una organización recién creada puede postear sin configurar nada. Cierra además la deuda 1 de `ESTADO.md` (el `WITH CHECK` de `organizations`): con el alta pasando por un único camino que fija `app.current_org`, la cláusula `OR app.current_user() IS NOT NULL` se retira (§2.5).
3. **Virtualizar el árbol de cuentas** — `@tanstack/react-virtual` sobre `flattenTree`, necesario ahora que el autocompletado de cuenta del editor de asientos abre el mismo árbol de ~900 filas dentro de un popover.

---

## 5. Invariantes

E3 implementa **I1, I7, I8, I9, I10** (I2/I3/I6 en E6, I4/I5 en E4/E5) y los **siete invariantes propios** de la épica: I-E3-1…6 son los del experto (`docs/design/E3-asientos-tipo.md` §3) y I-E3-7 es el sello de contenido del asiento. Salida `validacion.json`: `{ run_id, ledgerHash, gitSha, checks: [{ id, status: "PASS"|"FAIL"|"WARN", evidencia, query }] }`. Tests en `lib/ledger/invariants.test.ts` sobre los dos fixtures de §8.3.

La **formulación operativa y los casos límite** de cada uno están en `docs/design/E3-asientos-tipo.md` §3 y no se duplican; aquí, dónde se garantiza cada uno y con qué test.

| ID | Enunciado en E3 | Dónde se garantiza | Test |
|---|---|---|---|
| **I1** | Por asiento, Σdebe = Σhaber (tolerancia 0), con ≥ 2 líneas y ≥ 1 a cada lado | `checkDraft` C-1…C-4 (barrera 1) + constraint trigger diferido `journal_entry_balanced` / `journal_entry_both_sides` (barrera 2) | `i1-cuadre.test.ts`: los 84 asientos del fixture completo → PASS; fixture con 1 céntimo de más → FAIL con id del asiento y diferencia. **Test de error inyectado por SQL** (§8.1-14) |
| **I7** | `(organizationId, fiscalYearId, entryNumber)` único y **sin huecos**: `{entryNumber} = {1..max}` y `max = fiscal_years.last_entry_number` | `@@unique` + `FOR UPDATE` (N-1…N-4) | `i7-numeracion.test.ts` (contigüidad por ejercicio en ambos fixtures) + concurrencia: 50 `postEntry` en paralelo, 10 fallidos → 40 asientos 1..40, sin huecos ni duplicados. **N-5** (orden no decreciente por fecha) es **Info**, no FAIL: el diario se presenta ordenado por `(entryDate, entryNumber)` |
| **I8** | `entryDate` dentro de un ejercicio `OPEN`, mes no bloqueado, `≤ refDate` **sin excepciones** (O-8: en E3 no hay previsiones), y denormalización coherente en la línea | `checkDraft` C-11 + trigger `journal_entries_period_open` + FK de denormalización | `i8-fechas.test.ts`: fuera del ejercicio → `DATE_OUT_OF_FY`; mes bloqueado → `MONTH_LOCKED`; futura → `FUTURE_DATE`; ejercicio irregular (< 12 meses) → válido; ejercicios solapados → rechazados por el `EXCLUDE` |
| **I9** | Toda línea referencia una cuenta del plan de la organización, **activa y postable en el momento del alta** | FK compuesta + trigger `journal_lines_account_postable` | `i9-cuentas.test.ts`: cuenta padre no postable → rechazo; **cuenta desactivada después de tener líneas → las históricas siguen válidas y el check da PASS** (el histórico no se invalida; lo que se impide son líneas nuevas, R-09) |
| **I10** | Ninguna línea ni asiento apunta a cuenta, ejercicio, tipo impositivo o transacción de otra organización | FK compuestas `(organization_id, …)` + RLS estricta (§2.5) | `i10-tenant.test.ts` + suite `integration-rls`. El check se ejecuta **sin** filtro de tenant (rol `app_maintenance`), que es la única forma de poder detectar un cruce |
| **I-E3-1** | Un `REVERSAL` tiene `reversesEntryId` no nulo y su espejo cuadra a 0 por cuenta (y por destino analítico desde E4) con el original | `buildReversal` (copia e invierte) | `void.test.ts` contra el par anulado del fixture completo |
| **I-E3-2** | Como máximo **un** `REVERSAL` por asiento anulado | Índice único parcial `journal_entries_one_reversal` (§2.4) | Intento de doble anulación → violación de unicidad |
| **I-E3-3** | `voidedAt`/`voidedBy`/`voidReason` son informativos: **ninguna** query de informe los filtra | Revisión + grep en CI | `voided` no aparece en `lib/ledger/reports/**` ni en el SQL de `models/ledger.ts` |
| **I-E3-4** | Un `REVERSAL` no se anula con otro `REVERSAL`; tampoco se anulan `OPENING`/`CLOSING`/`REGULARIZATION` | Trigger `journal_entries_reversal_target` (§2.4) + CA-1/CA-2 en `buildReversal` | `void.test.ts`: anular el contra-asiento → `REVERSAL_OF_REVERSAL` |
| **I-E3-5** | Todo asiento con `templateCode` reproduce **exactamente** lo que devuelve su plantilla para el mismo input | Test de regresión | `templates/*.test.ts`: los 84 asientos del fixture completo se reconstruyen con su plantilla y su input y se comparan línea a línea. **Cobertura exigida: 28/28 plantillas**, que es lo que el fixture garantiza |
| **I-E3-6** | `OPENING` del ejercicio *n* = espejo del `CLOSING` del *n−1*, línea a línea | T-27/T-28 (puras en E3, orquestadas en E9) | Comprobado sobre el par cierre-2026 / apertura-2027 del fixture completo |
| **I-E3-7** | `entryHash` almacenado = `entryHash(líneas leídas)` para todo asiento | `postEntry` | `i-e3-7.test.ts`: detecta cualquier edición por SQL de una línea ya posteada |

**Sello.** `sealFor(validacion, { gitSha, lastGitSha })`: `VALIDADO AUTOMÁTICAMENTE` si todos PASS y no hay revisión forzada; `REQUIERE REVISIÓN` + motivo si hay cualquier FAIL, si es el primer run tras cambio de `gitSha` del motor, o si un WARN supera el umbral de `Organization.reviewThresholds`. Se muestra en la cabecera de sumas y saldos (y del mayor) y se recalcula en cada render mientras no exista `ReportRun`.

**Checks de Auditoría que E3 deja preparados** (la pestaña completa es E7, pero los cálculos nacen aquí porque son del diario): amortización acumulada ≤ valor de adquisición por activo (T-14) · `saldo(480) = Σ periodificaciones − Σ devengos ≥ 0` (T-15…T-18) · anticipos 438/407 sin factura al cierre · líneas de 43x/40x sin `dueDate` (se caen del aging) · asientos fuera de secuencia por fecha (N-5, Info) · tras T-23, `saldo(472) = saldo(477) = 0` en el periodo.

## 6. UI

Rutas nuevas bajo `app/(app)/`, con la navegación de la skill `ui-erp` (grupo **Contabilidad**: Libro diario · Mayor · Sumas y saldos; **Configuración** → Ejercicios).

| Ruta | Componentes | Qué se ve |
|---|---|---|
| `/ledger` | `ledger-filters`, `journal-table`, `entry-drawer` | Diario paginado por `(entryDate, entryNumber)`. Filtros: rango de fechas, ejercicio, cuenta, texto, `kind`, origen, "solo anulados / solo anuladores". Fila = asiento colapsable; expandir muestra las líneas (cuenta con nombre, concepto, debe, haber). Pie fijo con `Σdebe`, `Σhaber` y la diferencia. Drill-down: nº de asiento → panel lateral con la traza completa (§7) y enlace al documento origen (`File`) o a la `Transaction` |
| `/ledger/nuevo` | `entry-form`, `account-combobox`, `entry-totals` | Tabla editable Debe/Haber (T-20). Autocompletado de cuenta por código **y** nombre sobre el árbol virtualizado (§4.4-3), que solo ofrece cuentas activas y postables. `Σdebe − Σhaber` **siempre visible** y marcado como "vista previa" (badge `calculado`, nunca `comprobado`): el cálculo bueno es el del servidor. Botón "Contabilizar" deshabilitado si la diferencia ≠ 0, con el motivo escrito al lado. Errores del servidor se pintan por línea. Campo `dueDate` por línea, visible solo en cuentas 43x/40x/41x/44x/47x |
| `/ledger/nuevo/[templateCode]` | `template-form` (uno por bloque de §3.3), `tax-lines-preview` | Formularios de las 24 plantillas de operativa. Tres fechas explícitas: **documento**, **devengo** (default = documento) y, en solo lectura, la **fecha contable** que devuelve `resolveEntryDate` con su motivo ("mes 03 bloqueado → 01/04/2026"). Vista previa del asiento antes de contabilizar, con las líneas de impuesto ya desglosadas por tipo y, si hay prorrata, el reparto deducible / mayor coste. Si el devengo cae en ejercicio cerrado, el formulario **redirige a T-22** explicando por qué |
| `/ledger/[entryId]` | `entry-detail`, `void-dialog` | Asiento en solo lectura (nada es editable: ADR-0003). "Anular" abre diálogo con **motivo obligatorio** (mín. 10 caracteres) y una **vista previa del contra-asiento** antes de confirmar. Si ya está anulado, banner con enlace al asiento anulador y el motivo |
| `/ledger/mayor` | `account-picker`, `mayor-table` | Por cuenta: saldo inicial, movimientos, saldo final acumulado. Cuadre al pie: Σ saldos finales = sumas y saldos |
| `/ledger/sumas-saldos` | `report-header` (sello), `report-table` | Jerárquico por prefijo (grupo → subgrupo → cuenta), colapsable. Columnas: sumas debe, sumas haber, saldo deudor, saldo acreedor. Fila de cuadre `Σdeudor − Σacreedor = 0,00 €` con ✓/⚠. Cabecera con periodo, moneda, **sello** y `ledgerHash` abreviado en JetBrains Mono. Export CSV |
| `/settings/fiscal-years` | `fiscal-year-list`, `period-lock-grid` | Ejercicios con estado y nº de asientos. Rejilla de 12 meses por ejercicio: bloquear solo habilita el **siguiente mes abierto** (B-2) y desbloquear avisa de que arrastra los posteriores (B-3). Cerrar ejercicio exige los 12 meses bloqueados (B-4) y avisa de que **no hay reapertura** (decisión 4 de §9.2) y de que E9 añadirá T-26/T-27 |

Formato de cifras: `es-ES`, `1.234.567,89 €`, `tabular-nums`, ceros como `—`, negativos con `−` en texto secundario (nunca rojo semáforo). Densidad 32 px. `VIEWER` no ve "Nuevo asiento", "Anular", "Bloquear mes" ni "Cerrar ejercicio"; si invoca la action, `{ success: false, error: "Sin permiso" }` y no hay `AuditLog`.

Estados: carga con `Suspense` + esqueleto de tabla; error de posteo → los errores de `validateEntry` se muestran **todos a la vez**, anclados a su línea; error de la BD (trigger) → mensaje traducido por `ERRCODE` + `CONSTRAINT`, nunca el texto crudo de Postgres.

---

## 7. Trazabilidad

Cada asiento guarda: las **tres fechas** (`documentDate`, `accrualDate`, `entryDate`) —que son lo que explica en el drill-down por qué un documento de marzo aparece contabilizado en abril—, el **modo de redondeo sellado** (`taxRoundingMode`), `sourceType` + `sourceId`, `transactionId` (operación heredada), `fileId` (documento origen), `extractionRunId` (E8, hoy NULL), `templateCode` (qué plantilla lo generó), `postedById` + `postedAt` y `entryHash`. Cada línea guarda `taxRateId` + `taxBaseCents` (qué tipo y qué base produjeron esa cuota, reproducible aunque el tipo se cierre después), `analyticType` y `dueDate` (una línea por vencimiento; aging en E7). Con eso, un asiento de 2026 se puede recalcular byte a byte en 2036 aunque la organización haya cambiado de tipos, de prorrata y de método de redondeo.

Anulación: `reversesEntryId` en el anulador; `voidedAt`/`voidedById`/`voidReason` en el anulado, **informativos** — ninguna consulta filtra por ellos (I-E3-2).

`AuditLog` en la misma transacción que la mutación, con `after` = el asiento completo (cabecera + líneas) para `post`, y `before`/`after` para `lock`/`unlock`/`close`. Es lo que permite reconstruir quién contabilizó qué y con qué configuración vigente.

Provenance de informe (`lib/ledger/provenance.ts`), por celda:

```json
{"valor": 1245032, "moneda": "EUR", "metrica": "sumas_saldos.saldo.430",
 "run_id": "…", "ledgerHash": "sha256:…", "calculado_por": "lib/ledger/reports/sumas-saldos.ts@<git-sha>",
 "registros_origen": "SELECT id FROM journal_lines WHERE organization_id=$1 AND account_code='430' AND entry_date BETWEEN $2 AND $3",
 "confianza": "calculado"}
```

El drill-down de la UI **ejecuta** `registros_origen` (parametrizada, nunca interpolada) dentro de `tenantTransaction`.

---

## 8. Criterios de aceptación y plan de tareas

### 8.1 Criterios de aceptación (Given/When/Then)

1. **Asiento manual cuadrado.** *Given* una organización con plan sembrado y ejercicio 2026 abierto, *when* un EDITOR postea `430 D 121.000 / 705 H 100.000 / 477 H 21.000` con fecha 2026-03-10, *then* se crea el asiento nº 1 con tres líneas, `lastEntryNumber = 1`, `entryHash` no vacío, `taxRoundingMode` sellado, un `AuditLog` `JournalEntry/post`, y `/ledger` lo muestra con `Σdebe = Σhaber = 1.210,00 €`.
2. **Descuadre imposible.** *Given* el mismo contexto, *when* se postea `430 D 121.000 / 705 H 100.000`, *then* `UNBALANCED` con la diferencia 21.000 y **no se inserta nada**; *when* se postea un asiento de dos líneas **ambas al debe**, *then* `ONE_SIDED_ENTRY` (C-4); *when* se fuerza el INSERT por SQL como `app_runtime` saltándose la app, *then* el COMMIT falla con `journal_entry_balanced` o `journal_entry_both_sides` y la transacción se deshace entera.
3. **Numeración sin huecos bajo concurrencia.** *Given* un ejercicio vacío, *when* se lanzan 50 `postEntry` en paralelo y 10 fallan por descuadre, *then* existen 40 asientos numerados 1..40 sin huecos ni duplicados y `lastEntryNumber = 40` (N-2, N-3). *When* se postea después un asiento con fecha anterior a los ya existentes dentro del mismo mes abierto, *then* toma el nº 41, **no se renumera nada** y el diario lo presenta en su sitio por `(entryDate, entryNumber)` (N-5); la Auditoría lo lista como Info.
4. **Periodo cerrado y bloqueo secuencial.** *Given* el mes 3 de 2026 bloqueado, *when* un EDITOR postea con devengo 2026-03-10, *then* el asiento se contabiliza con `entryDate = 2026-04-01`, `accrualDate = 2026-03-10` y la descripción incorpora `[devengo 2026-03-10]` (§2.2 del experto); *when* un ADMIN intenta bloquear el mes 5 con el 4 abierto, *then* rechazo (B-2); *when* desbloquea el 3, *then* se desbloquean también 4..12 (B-3) y ambos hechos están en `AuditLog`. *Given* el ejercicio `CLOSED`, *when* se postea con cualquier fecha suya, *then* `FY_CLOSED`.
5. **Anulación = contra-asiento, con la fecha correcta.** *Given* el asiento nº 1 (fecha 2026-03-10, mes abierto), *when* un EDITOR lo anula con motivo "Factura duplicada del proveedor", *then* nace un `REVERSAL` **con la misma fecha 2026-03-10**, `reversesEntryId` al 1, las mismas tres cuentas con el lado invertido, el mismo importe y el mismo `lineNo`; el nº 1 queda con `voidedAt`/`voidReason`; **ambos siguen apareciendo en el diario y en sumas y saldos** y los saldos vuelven a 0. *Given* que el mes 3 se bloquea después, *when* se anula otro asiento de marzo, *then* la fecha del contra-asiento es **2026-04-01** (primer día del primer mes abierto), no la de hoy. *When* se intenta anular el contra-asiento, *then* `REVERSAL_OF_REVERSAL`; *when* se intenta anular dos veces el mismo asiento, *then* violación de `journal_entries_one_reversal`.
6. **Factura recibida con IRPF y con prorrata.** *Given* `IVA_21` e `IRPF_PROF_15` vigentes desde 2025-01-01 y el mapa de E2, *when* se postea T-03 con base 1.000,00 €, IVA 21 %, retención 15 %, `deductibility: FULL`, *then* `D 62x 100.000 · D 472 21.000 / H 410 106.000 · H 4751 15.000`, con `taxBaseCents = 100.000` en ambas líneas de impuesto. *Given* `prorrataBps = 9000`, *when* se postea con `deductibility: PRORRATA` y base 800,00 € al 21 %, *then* la línea de gasto es **81.680** (base 80.000 + no deducible 1.680) y la de 472 es **15.120** — el IVA no deducible engorda el gasto, no ajusta la 472. *Given* `prorrataBps = null`, *when* se usa `PRORRATA`, *then* `PRORRATA_NOT_CONFIGURED`. *When* la misma factura se fecha en 2024-06-01, *then* `TAX_RATE_NOT_IN_FORCE`.
7. **Redondeo sellado.** *Given* `taxRoundingMode = PER_TIPO` y tres líneas al 21 % de 33,33 €, *when* se postea, *then* hay **una** línea de 477 por 21,00 € (redondeo sobre la base agregada), no tres, y el asiento guarda `taxRoundingMode = PER_TIPO`; *when* después un ADMIN cambia el modo de la organización a `PER_LINEA`, *then* el asiento antiguo **se sigue recalculando con `PER_TIPO`** y I-E3-5 pasa. *Given* un total de factura que difiere en 1 céntimo, *then* línea a `REDONDEO_GASTO`/`REDONDEO_INGRESO`; *given* 5 céntimos con tolerancia 1, *then* `TAX_ROUNDING_EXCEEDED` y nada se persiste.
8. **Ejercicio cerrado → T-22.** *Given* el ejercicio 2025 `CLOSED` y el 2026 abierto, *when* llega una factura con `documentDate` en 2025, *then* `resolveEntryDate` señala `FY_CLOSED` y la UI dirige a T-22; *when* se registra como error **material** de 2.500,00 €, *then* la contrapartida es `113` y la PyG de 2026 **no cambia**; *when* se registra como no significativo de 350,00 €, *then* va a `678` y sí afecta al epígrafe 13. En ambos casos `documentDate` queda en 2025 y `entryDate` en 2026, y en ningún caso se toca el ejercicio cerrado.
9. **Vencimientos múltiples.** *Given* una factura de 3.630,00 € con pago a 30/60/90 días, *when* se postea T-01, *then* hay **tres** líneas de `CLIENTES` de 1.210,00 € con `dueDate` distinta, su suma es el total del documento y C-5 sigue cuadrando.
10. **Contabilizar una operación heredada.** *Given* una `Transaction` en `DRAFT` con un `File` adjunto, *when* un EDITOR la contabiliza con T-03, *then* queda `POSTED` con `journalEntryId`, el asiento lleva `transactionId` y `fileId`, y el drill-down abre el documento; *when* se anula el asiento, *then* la `Transaction` queda `VOID`.
11. **Mayor y sumas y saldos cuadran contra el fixture.** *Given* `ejercicio-completo.json` cargado, *when* se piden mayor y sumas y saldos del ejercicio 2026, *then* `Σdebe = Σhaber = 52.884.809` céntimos, los saldos por cuenta coinciden **uno a uno** con `expected.balancesBeforeClosingCents`, Σ saldos finales del mayor = Σ de sumas y saldos, la fila de cuadre marca ✓ y la cabecera muestra `VALIDADO AUTOMÁTICAMENTE` con el `ledgerHash` del periodo.
12. **Cobertura de plantillas (I-E3-5).** *Given* el fixture completo, *when* cada uno de sus 84 asientos se reconstruye con su plantilla y su input, *then* coincide línea a línea con el fichero, y la cobertura es **28/28 plantillas** (`expected.templateCoverage`). Incluye los casos que el fixture trae a propósito: dos tipos de IVA en un documento, recargo 5,2 %, ISP con efecto neto 0, anticipo con IVA devengado y su aplicación, IVA a compensar en el 3T y su consumo en el 4T, rectificativas emitida y recibida, cobro parcial, comisión bancaria, diferencias de cambio en ambos sentidos y redondeos de 1 céntimo.
13. **Roles.** *Given* un VIEWER, *when* abre `/ledger`, *then* ve el diario y ningún botón de mutación; *when* invoca `postManualEntryAction`, *then* `{ success: false, error: "Sin permiso" }` y sin `AuditLog`. *Given* un EDITOR, *when* invoca `lockPeriodAction` o `closeFiscalYearAction`, *then* rechazo por rol (son ADMIN).
14. **Test de error inyectado por SQL (SPEC-FIABILIDAD C4).** *Given* `ejercicio-minimo.json` cargado y `run-invariants.ts` en verde, *when* un operador con privilegio de propietario ejecuta `ALTER TABLE journal_lines DISABLE TRIGGER ALL; UPDATE journal_lines SET debit_cents = debit_cents + 100 WHERE id = '<línea del asiento 2>'; ALTER TABLE journal_lines ENABLE TRIGGER ALL;`, *then* `npx tsx scripts/run-invariants.ts --org <id>` devuelve **I1 = FAIL** con el asiento y la diferencia de 1,00 €, **I-E3-7 = FAIL** (`entryHash` ya no coincide), sello `REQUIERE REVISIÓN`, código de salida ≠ 0, y la cabecera de sumas y saldos lo muestra. Es la prueba de que la Capa 1 detecta corrupción que no pasó por la aplicación.
15. **Fixtures reproducibles.** *Given* el repositorio limpio, *when* corre `python3 docs/design/fixtures/build_ejercicio_completo.py --check`, *then* reconstruye ambos ficheros y **no difiere en un solo céntimo**; el paso está en CI y falla el build si alguien edita un fixture a mano.
16. **RLS estricta.** *Given* la migración de §2.5 aplicada, *when* se conecta como `app_runtime` **sin** fijar `app.current_org` y se hace `SELECT count(*)` sobre cada una de las veinte tablas de negocio, *then* **0** en todas; *when* se fija `app.current_org = A`, *then* solo datos de A; *when* como propietario se intenta `UPDATE audit_logs` o `UPDATE journal_lines`, *then* falla (`FORCE` activo). Un test recorre `pg_class.relforcerowsecurity` y falla si alguna tabla de negocio está en `false`.
17. **Nada se rompe al retirar el escape.** *Given* la suite completa ejecutada como `app_runtime` (`test:integration:rls` ampliada a **todos** los `models/`), *then* login, switcher de organización, aceptación de invitación, sync de email y siembra de plan siguen funcionando (§2.6). Es el criterio que protege el refactor.
18. **E2E.** *Given* la app con una organización sembrada, *when* Playwright hace login, crea un ejercicio, postea una factura recibida con la plantilla (comprobando la vista previa de las líneas de impuesto), postea un asiento manual de dos líneas verificando que la diferencia llega a 0,00 € antes de habilitar el botón, lo anula con motivo y abre sumas y saldos, *then* sin errores de consola y con el sello visible.

### 8.2 Plan de tareas

Cambios de la ronda 2 marcados **(R2)**.

| ID | Tarea | Depende de | Nivel | Horas |
|---|---|---|---|---|
| **T1** | Esquema Prisma §2.2 (4 modelos, 4 enums, `Transaction.status`/`journalEntryId`, **(R2)** `documentDate`/`accrualDate`/`taxRoundingMode` en el asiento y `prorrataPermille → prorrataBps` con `valor × 10`), `TENANT_MODELS` += 4, migración `20260906100000_e3_ledger` con **todo** el SQL de §2.4 (CHECKs, EXCLUDE, FK de denormalización, 2 constraint triggers diferidos, **(R2)** trigger anti contra-contra-asiento e índice único parcial de anulación, 2 triggers BEFORE, GRANTs de columna) | — | **2** | 14 |
| **T2** | **Auditoría de código fuera de GUC (§2.6) y refactor previo**: `models/organizations.ts`, `models/memberships.ts`, `models/invitations.ts` a `withTenantGucs`; `app.invitation_by_token_hash` y `app.list_email_sync_targets` (`SECURITY DEFINER`); `lib/email-sync/ingest.ts`; `scripts/migrate-uploads-to-org.ts` a `app_maintenance`; regla ESLint `no-restricted-syntax`; ampliar `test:integration:rls` a todos los `models/`. **Se hace ANTES de T3 y se puede desplegar solo: no cambia comportamiento** | — | **2** | 14 |
| **T3** | Migración `20260906110000_e3_rls_strict` (§2.5): retirada del escape en 16 tablas, `FORCE` en las 20, políticas de las 4 nuevas, `app_maintenance`, patrón de backfill documentado en `CLAUDE.md`. **ADR-0009** a APROBADO antes de mezclar | T1, T2 | **2** | 8 |
| **T4** | `lib/ledger/types.ts`, **(R2)** `dates.ts` (`resolveEntryDate`), `tax.ts` (aritmética común §0.1), `post.ts` (`buildEntry` + **los 13 checks** C-1…C-13), `void.ts` (T-21 con CA-1…CA-6), `hash.ts` + tests unitarios. Ampliar `.claude/hooks/guard.sh` y `vitest.config.ts` a `lib/ledger/` | — | **2** | 20 |
| **T5a** | **(R2)** Bloque A de §3.3 — 7 plantillas de documento con impuestos (T-01…T-07): cuota por tipo y por línea, retención sobre base total, prorrata `FULL/NONE/PRORRATA`, recargo de equivalencia, ISP, anticipos con IVA devengado, rectificativas con el tipo del documento original. Tests por plantilla | T4 | **2** | 20 |
| **T5b** | **(R2)** Bloque B — 11 plantillas de tesorería, personal y periodificación (T-08…T-18): comisión, diferencia de cambio, ajuste de redondeo, cobro/pago parcial, nómina multi-destino, `PAYMENT_EXCEEDS_LIABILITY`, pares periodificación/devengo. Tests por plantilla | T4 | **2** | 14 |
| **T5c** | **(R2)** Bloque C — 10 plantillas estructurales y de cierre (T-19…T-28): las que construyen desde **saldos** en lugar de desde un documento. T-22 con NRV 22ª (113/121 · 678/778), T-23 con arrastre de la cuota a compensar, T-25…T-28 puras y sin acción de usuario. Tests por plantilla | T4, T8 | **2** | 16 |
| **T6** | `lib/ledger/invariants.ts` (I1, I7–I10, **(R2)** I-E3-1…7), `sealFor`, `provenance.ts`, `scripts/run-invariants.ts` + `lib/ledger/invariants.test.ts` sobre los dos fixtures | T4, T13 | **2** | 13 |
| **T7** | `lib/ledger/reports/{diario,mayor,sumas-saldos}.ts` puros + provenance por celda + tests contra `expected.balancesBeforeClosingCents` | T4, T13 | 1 | 12 |
| **T8** | `models/fiscal-years.ts` (**(R2)** B-2/B-3/B-4), `models/ledger.ts` (`getLedgerContext`, `postEntry` con `FOR UPDATE`, **(R2)** `postEntries` con reserva de rango, `voidEntry`, `getAccountBalances`, `getOpenLiability`, SQL agregado con `BIGINT`), `countLinesByAccount` → cierra el `TODO(E3)` de `getAccountUsage`; `models/transactions.ts`; `AuditEntity`/`AuditAction` nuevos | T1, T4 | **2** | 15 |
| **T9** | `forms/ledger.ts`, `forms/fiscal-years.ts` + las server actions de §4.2, **(R2)** con la unión discriminada de las 24 plantillas de operativa y sin `reopenFiscalYearAction`. Ajustar `updateTaxPolicyAction` y `forms/tax-rates.ts` de E2 al renombrado `prorrataPermille → prorrataBps` | T8, T5a, T5b | 1 | 11 |
| **T10** | Pendientes E2 (§4.4): `importCustomPlan` por `createMany`; alta de organización + siembra + ejercicio inicial en **una** `tenantTransaction`; virtualizar el árbol de cuentas | T3 | 1 | 10 |
| **T11** | UI diario: `/ledger`, `/ledger/nuevo`, **(R2)** `/ledger/nuevo/[templateCode]` (formularios de las 24 plantillas por bloque, tres fechas, vista previa del asiento con desglose de impuestos y prorrata), `/ledger/[entryId]` + `void-dialog`, `entry-drawer` con drill-down | T9, T10 | 1 | 24 |
| **T12** | UI informes: `/ledger/mayor`, `/ledger/sumas-saldos` con `report-header` (sello + `ledgerHash`), `report-table` jerárquica, export CSV; `/settings/fiscal-years` con rejilla de meses y reglas B-2/B-3; entradas de `side-nav` | T7, T9 | 1 | 14 |
| **T13** | **(R2)** Cargador de fixtures `tests/fixtures/load-ejercicio.ts` (inserta organización, plan sembrado, ejercicios, asientos y numeración; **descarta** `projectCode`/`costCenterCode`/`businessLineCode` con el test que fija D-E3-1) + paso de CI `build_ejercicio_completo.py --check`. **Los fixtures ya están entregados**: esta tarea es cargarlos y blindarlos, no generarlos | T8 | 1 | 6 |
| **T14** | Tests de integración: posteo, concurrencia (50 paralelos), N-5, periodo bloqueado y desplazamiento de fecha, anulación con las dos fechas posibles, prorrata, T-22, plantillas contra BD real; `tests/integration-rls/e3-app-runtime.test.ts` (criterios 16 y 17); **test de error inyectado por SQL** (criterio 14) | T13, T3, T9 | **2** | 16 |
| **T15** | E2E Playwright `ledger.spec.ts` (criterio 18) | T11, T12 | 1 | 7 |
| **T16** | Docs: `docs/MODELO-DATOS.md` §Ejercicios y diario reescrita (**(R2)** ya hecho en esta ronda; queda ajustar a lo realmente construido), `docs/ESTADO.md` (deuda RLS → RETIRADA, con fecha y migración), `.claude/skills/{fiabilidad,pgc-npgc,estados-financieros}/SKILL.md`, ROADMAP E3 → CERRADA, `runs/registro.jsonl`, ADR-0009 → APROBADO | T14, T15 | 1 | 5 |

**Total: 229 h** (~29 jornadas; +41 h sobre la ronda 1, casi todas en las plantillas: de 7 a 28, con prorrata, tres fechas y las reglas de cierre).
**Camino crítico:** T1 → T8 → T9 → T11 → T14 → T16 (**85 h**).
**Rama de motor en paralelo desde el día 1:** T4 → T5a/T5b (→ T5c tras T8) → T6/T7 (**95 h**, paralelizable entre dos personas en los bloques de plantillas).
**Rama de seguridad, desplegable por separado:** T2 → T3 (**22 h**) — se mezcla antes que la UI para que el resto de la épica nazca bajo RLS estricta.
**Reparto:** dev-backend (T1, T2, T3, T8, T9, T10) · motor (T4, T5a, T5b, T5c, T6, T7) · dev-frontend (T11, T12) · qa-tester (T13, T14, T15) · documentador (T16). Auditor de fiabilidad obligatorio en T4, T5a–T5c, T6, T7 y T14.

### 8.3 Fixtures inmutables — **ya entregados**

`tests/fixtures/ejercicio-minimo.json` y `tests/fixtures/ejercicio-completo.json`, generados y verificados por `docs/design/fixtures/build_ejercicio_completo.py`. **No se editan a mano: se regeneran.** `python3 docs/design/fixtures/build_ejercicio_completo.py --check` reconstruye ambos y falla si difieren en un céntimo (paso de CI, criterio 15). Cambiar una cifra exige un commit aparte que modifique el script y justifique el cambio; lo revisa el auditor.

Esquema real (`schemaVersion: "1.0"`):

```jsonc
{
  "schemaVersion": "1.0",
  "generatedBy": "docs/design/fixtures/build_ejercicio_completo.py",
  "note": "Fixture INMUTABLE. Cifras ilustrativas.",
  "organization": { "slug", "name", "baseCurrency", "pgcVariant", "taxRoundingMode",
                    "prorrataBps", "redondeoToleranciaCents", "analyticsRequired",
                    "useSubaccounts": false, "createSoftwareAccounts": false },
  "fiscalYear":       { "code", "startDate", "endDate", "status" },
  "fiscalYearsExtra": [ { "code": "2027", … } ],
  "accountsExtra":    [ { "code", "name", "parentCode" } ],   // vacío: todo sale del seed PYMES
  "businessLines":    [ { "code", "name", "sortOrder" } ],    // E3 los ignora (D-E3-1); E4 los crea
  "projects":         [ { "code", "name", "businessLineCode", "status" } ],
  "costCenters":      [ { "code", "name", "kind", "marginLevel", "allocatable" } ],
  "entries": [ { "ref", "entryNumber", "date", "kind", "fiscalYearCode", "description",
                 "sourceType", "template", "reversesRef?",
                 "lines": [ { "accountKey" | "accountCode", "debitCents", "creditCents",
                              "projectCode?", "costCenterCode?", "taxRateCode?", "lineNo" } ] } ],
  "expected": { "entryCount", "totalDebitCents", "totalCreditCents",
                "resultadoAntesRegularizacionCents", "saldo129Cents",
                "balancesBeforeClosingCents", /* completo: */ "entryCount2026",
                "totalDebitCents2026", "totalCreditCents2026", "resultadoAntesImpuestoCents",
                "impuestoBeneficiosCents", "balancesBeforeRegularizationCents",
                "templateCoverage", "ivaQuarters", "irpfQuarters", "invariants" }
}
```

`accountKey` se usa **siempre que existe clave** (38 claves distintas aparecen en los asientos); `accountCode` queda para las cuentas de negocio sin clave (`100`, `113`, `216`, `217`, `2816`, `2817`, `621`, `623`, `628`, `629`, `678`, `681`) y para los asientos generados **por saldos** (T-26, T-27, T-28), donde la cuenta la elige el mayor y no la plantilla. `useSubaccounts = false` para que la resolución `AccountKey → código` sea la tabla de defaults de `lib/accounts/map.ts` sin overrides.

| Fixture | Contenido | Para qué |
|---|---|---|
| `ejercicio-minimo.json` | 5 asientos: apertura (`572`/`100` por 500.000), factura emitida (100.000 + IVA 21.000), su cobro, regularización (`705 → 129`) y cierre. Resultado 100.000 = saldo de `129` | Tests de arranque del motor, numeración, exclusión de `REGULARIZATION`/`CLOSING`/`OPENING` de la PyG, y el **test de error inyectado** |
| `ejercicio-completo.json` | Ejercicio 2026 completo + apertura de 2027: **84 asientos, 326 líneas, 28/28 plantillas**, 2 líneas de negocio, 3 proyectos, 6 CECOs. `Σdebe = Σhaber = 67.193.629` (52.884.809 en 2026), resultado antes de impuesto 1.996.430, IS 499.108, resultado 1.497.322 = saldo de `129`, I2 = 0 | Informes (§8.1-11), I1/I7–I10, I-E3-1…7, cobertura de plantillas y, en E6, PyG/balance/cashflow |

## 9. Riesgos, dudas y alternativas descartadas

### 9.1 Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **La retirada del escape RLS rompe la app en producción** (login, invitaciones, sync de email dejan de ver filas, §2.6) | T2 va antes que T3, es desplegable sola y no cambia comportamiento; T3 no se mezcla sin el criterio 17 en verde con la suite completa como `app_runtime`; despliegue en un branch de Supabase por PR |
| R2 | **`FORCE` rompe migraciones futuras con backfill**: el propietario deja de ver las filas y el backfill queda mudo, sin error | Patrón obligatorio `NO FORCE … FORCE` dentro de la migración, documentado en `CLAUDE.md`, más el test que comprueba que ninguna tabla acaba en `NO FORCE` |
| R3 | **Contención por `FOR UPDATE`** sobre `fiscal_years` en importaciones masivas (E8 podría postear miles de asientos) | Es una fila por ejercicio y la transacción es corta; se mide en T14 con 50 paralelos. Si E8 lo necesita, `postEntries(draft[])` reserva un rango de números bajo un único bloqueo — cabe sin cambiar el esquema |
| R4 | **Los constraint triggers diferidos disparan una consulta por línea insertada** y en un asiento de 200 líneas eso son 200 agregados al COMMIT | `FOR EACH ROW` es lo que garantiza la corrección; si el perfil lo pide, se pasa a un trigger de sentencia con tabla de transición (`REFERENCING NEW TABLE`), que es un cambio local. Medido en T14 |
| R5 | **Denormalizar `entry_date`/`fiscal_year_id`/`entry_kind` en las líneas** duplica información y puede divergir | No puede: la FK compuesta contra `journal_entries_denorm_key` lo impide en la BD (§2.4). El riesgo se convierte en coste de índice |
| R6 | **Las columnas analíticas nacen sin FK** (§2.3) y alguien podría escribirlas antes de E4 | `CHECK` en BD + guarda en `checkDraft` + el cargador de fixtures que los descarta, los tres con test. Se retiran a la vez en E4 (D-E3-1) |
| R8 | **28 plantillas son mucha superficie para una épica**: es el mayor bloque de horas y el que concentra las reglas fiscales | Se parte en tres tareas por complejidad (T5a/T5b/T5c) paralelizables, cada una con sus tests, y el fixture las cubre 28/28 con I-E3-5, de modo que una regresión en cualquiera falla el build. El bloque C depende de `getAccountBalances` (T8) y por eso va el último |
| R9 | **La prorrata entra en E3 y toca la línea de gasto**, no solo la de impuesto: un error ahí contamina PyG, balance y coste de proyectos desde el primer asiento | Es la razón por la que el experto la adelantó: hacerlo mal después obliga a reexpresar asientos posteados. Dos casos en el fixture (prorrata 90 % y no deducible íntegro) y auditor de fiabilidad obligatorio en T5a |
| R7 | **`entryHash` da falsa sensación de inmutabilidad**: quien puede editar la línea puede recalcular el hash | Es exactamente lo que se afirma en I-E3-7: detecta corrupción *no intencionada* y ediciones por SQL de terceros, no un atacante con acceso de propietario. La barrera contra eso es `FORCE` + `REVOKE UPDATE` (§2.4) |

### 9.2 Decisiones cerradas por el experto contable (ronda 2)

Las seis dudas de la ronda 1 están resueltas en `docs/design/E3-asientos-tipo.md` §6. Resumen y qué cambia en este diseño:

| # | Decisión | Efecto aquí |
|---|---|---|
| 1 | **Serie única correlativa por ejercicio**, sin `EntrySeries`. Arts. 28.2 y 29.1 CdC: el libro diario es uno. Las "series" de los despachos son presentación (filtro por `sourceType`/`templateCode`), y la serie múltiple obligatoria es la de **facturación emitida**, que ya vive en `InvoiceSeries` y numera facturas, no asientos | **Confirmado sin cambios.** `FiscalYear.lastEntryNumber` + `FOR UPDATE` se quedan; N-7 da a apertura y cierre la identidad que se buscaba con una serie propia |
| 2 | **Fecha del contra-asiento:** la del original si su mes sigue abierto; si no, **primer día del primer mes abierto ≥ fecha original** — no "hoy" | **Corrige la ronda 1.** `buildReversal` implementa §2.5 del experto; `requestedDate` solo retrasa. §4.2, §6 y el criterio 5 actualizados |
| 3 | **Prorrata: se aplica en E3**; la regularización **anual** y la de bienes de inversión (arts. 105–110 LIVA, contra 634/639) van a E9. El IVA no deducible es **mayor precio de adquisición** (art. 103 LIVA, NRV 2ª y 10ª), no un ajuste de la 472 | **Corrige la ronda 1**, que la aplazaba entera. Ignorarla habría dejado gasto infravalorado y 472 sobrevalorado **desde el primer asiento**, con reexpresión imposible después. Entra en T-03/T-04 (`deductibility`) y obliga a O-7 (`prorrataBps`) |
| 4 | **Ejercicio cerrado: sin reapertura.** Cuentas formuladas y depositadas (arts. 253, 272, 279 LSC) no se tocan; el documento va al ejercicio abierto con **T-22** (113/121 material · 678/778 no significativo, NRV 22ª) | **Confirma `FY_CLOSED` y elimina `reopenFiscalYearAction`** de §4.2. Criterio de aceptación 8 nuevo |
| 5 | **Sin asientos de una línea.** Los tres casos que suelen invocarse no son excepciones (reclasificaciones tienen dos líneas; las cuentas de orden desaparecieron con el PGC 2007; lo extracontable vive en `TimeEntry`/`Budget`, ADR-0004). Refuerzo: **≥ 1 línea al debe y ≥ 1 al haber** | **Confirmado y reforzado.** C-4 completo en `checkDraft` y en el trigger `journal_entry_both_sides` (§2.4) |
| 6 | **`dueDate` en la línea**, y **una línea de 43x/40x por vencimiento**. El vencimiento es atributo del crédito, no del hecho económico; lo exigen el aging, el periodo medio de pago (Ley 15/2010, art. 262 LSC) y la conciliación de cobros parciales | **Confirmado y ampliado**: T-01/T-03 emiten una línea por plazo. Criterio de aceptación 9 nuevo; WARN de Auditoría para líneas 43x/40x sin `dueDate` |

**Dudas abiertas nuevas (no bloquean E3):** ninguna de contabilidad. Las dos pendientes son de producto y se resuelven al implementar: (a) si `Organization.renumberOnClose` (N-6, renumeración opcional al bloquear el mes) se ofrece ya en E3 o se deja para E9 — este diseño **no lo implementa** y se queda con N-5, que es la regla por defecto; (b) el criterio de amortización del mes de alta (T-14: "desde el mes siguiente") es parametrizable por organización según el experto, y E3 lo fija en el asiento pero **no** ofrece el parámetro en la UI hasta E10.

### 9.3 Alternativas descartadas

- **Secuencia de Postgres para `entryNumber`.** Rápida y sin contención, pero deja huecos al hacer rollback y el diario dejaría de ser correlativo (art. 28 CdC). Se prefiere el `FOR UPDATE`, cuyo coste es una fila por ejercicio.
- **Trigger de sentencia en lugar de `FOR EACH ROW` para el cuadre.** Menos disparos, pero exige `REFERENCING NEW TABLE` y no cubre bien el caso de un asiento cuyas líneas llegan en varios `INSERT`. Se deja como optimización medible (R4), no como diseño inicial.
- **Guardar el saldo por cuenta y mes en una tabla mantenida por la app.** Haría los informes instantáneos y crea una segunda verdad que diverge (ADR-0003 lo prohíbe explícitamente). Las vistas materializadas refrescables siguen sobre la mesa para v1.1.
- **Retirar el escape RLS en una épica aparte, después de E3.** Dejaría el libro diario —la tabla con las cifras— conviviendo dos épicas más con tablas que se leen enteras sin `app.current_org`. ADR-0007 fijó E3 como fecha y no hay motivo técnico para moverla: el trabajo real (T2) es acotado y desplegable solo.
- **Permitir editar un asiento con "motivo".** Rompe la trazabilidad y el art. 29.1 CdC (sin espacios ni tachaduras). Se sustituye por anular + volver a postear, que es lo que hace un contable en papel.

---

## 10. Validación contable: **CONFORME tras ronda 2**

`docs/design/E3-asientos-tipo.md` §5 dictamina **CONFORME CON OBSERVACIONES** sobre `docs/MODELO-DATOS.md` §Ejercicios y diario: la estructura soporta las 28 plantillas sin cambios de ruptura, y faltaban 5 campos y 2 restricciones. Este diseño incorpora todo lo que el experto marcó como necesario en E3:

| Aportación del experto | Dónde está incorporada |
|---|---|
| 28 plantillas T-01…T-28 con su aritmética y sus comprobaciones | §1 (alcance: 28 puras, 24 con acción), §3.3 (reglas transversales + tres bloques), T5a/T5b/T5c |
| 13 checks comunes C-1…C-13 | §3.2 (`checkDraft`, con el estado de cada uno en E3); C-1…C-4, C-8, C-11 y C-13 repetidos en la BD (§2.4) |
| Aritmética común §0.1 (`cuotaPorTipo`, `cuotaPorLinea`, `retencion`, `deducible`, `redondeo`) | §3.2 `lib/ledger/tax.ts` |
| Contrato de plantilla con `accountKey` preferente | §3.1 `DraftLine` |
| Numeración N-1…N-7 | §2.2 (comentario del modelo), §4.3, I7 en §5, criterio 3 |
| Tres fechas y `resolveEntryDate` | O-1 en §2.2, `lib/ledger/dates.ts` en §3.2, UI §6, criterio 4 |
| Bloqueo de meses B-1…B-5 | §4.1 (`lockPeriod`/`unlockPeriod`/`closeFiscalYear`), UI §6, criterio 4 |
| Fecha del contra-asiento §2.5 | `buildReversal` en §3.2, §9.2-2, criterio 5 |
| Documentos de ejercicio cerrado §2.3 + T-22 | §9.2-4, criterio 8; `reopenFiscalYearAction` eliminada |
| I1, I7–I10 con casos límite | §5, con la fuente en `E3-asientos-tipo.md` §3 |
| I-E3-1…6 | §5 (adoptada su numeración; el `entryHash` propio pasa a I-E3-7) |
| O-1, O-2, O-4, O-7 | §2.2 (`documentDate`/`accrualDate`, `taxRoundingMode`, `prorrataBps`) y §2.4 (índice único de anulación + trigger anti contra-contra-asiento) |
| Fixtures y sus totales | §8.3 (esquema real), criterios 11, 12 y 15 |
| Corrección de norma 679/779 → 113/121 y 678/778 | §3.3 (nota final), T-22, §9.2-4 |

**Descartes conscientes, con motivo** — ninguno afecta a una regla contable:

| Qué | Motivo |
|---|---|
| **O-3 `templateVersion` → E8** · **O-5 extremos de `OPENING`/`CLOSING` → E9** · **O-6 divisa en la línea → E8** · **O-8 `isForecast` → E10** · **O-9 `INVOICE_IN` → E8** | Tabla razonada al final de §2.2. Ninguna bloquea una plantilla de E3; cada una la necesita la épica que le da valores. O-3 lleva además una condición de entrada explícita para E8 |
| **T-25…T-28 sin acción de usuario en E3** | Las funciones puras se implementan y se testean (I-E3-5 exige 28/28), pero lo que les falta no es la plantilla: es el cálculo de la base imponible con ajustes extracontables y la orquestación del cierre. §1 |
| **C-9 (destino analítico) implementado pero inerte** | Las tablas `Project`/`CostCenter`/`BusinessLine` son E4. D-E3-1 (§2.3) explica cómo se activa sin regenerar los fixtures ni cambiar una cifra |
| **N-6 (`renumberOnClose`) no se implementa** | Es una alternativa que el propio experto marca como opcional por organización; N-5 es la regla por defecto y basta para cumplir el art. 28 CdC. §9.2 |
| **Rama "salvo previsión marcada" de I8** | Se retira del alcance de E3 porque sin O-8 no hay forma de marcar una previsión, y E3 no genera ninguna. Vuelve entera en E10 |

Con esto, el diseño queda **CONFORME**. Pendiente de firma humana: **ADR-0009** (Nivel 2, retirada de escapes RLS y `FORCE`), que es la única decisión de esta épica que no cubre un ADR ya aprobado.
