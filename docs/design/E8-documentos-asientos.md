# E8 — Documentos → asientos (diseño)

**Épica:** E8 · **Nivel:** 2 (**ADR-0005 APROBADO** es la decisión rectora; **ADR-0014 PROPUESTO, ronda 2**, cubre el mapeo contable que aquel no decidía) · **Depende de:** E2 (plan, mapa de cuentas, `TaxRate`), E3 (motor, 28 plantillas, numeración, tres fechas, `Transaction.status`), y cierra lo que E4 y E6 dejaron pendiente
**Autor:** arquitecto · **Fecha:** 2026-09-06 · **Ronda 2** (validación contable incorporada, más los tres residuos O-23…O-25 de la re-validación) · **Estado:** **DISEÑADO** — validación contable **CONFORME CON OBSERVACIONES** (`docs/design/E8-validacion-documentos.md` §R2.3) y **ADR-0014 APROBADO**. T9 desbloqueado

Documentos que este diseño da por leídos: `CLAUDE.md` (§Estándar de calidad, §RLS y migraciones), `docs/ROADMAP.md` (E8), `docs/spec/SPEC-FIABILIDAD.md`, `docs/AUDITORIA-FIABILIDAD.md` (G-01…G-04, G-07…G-13, G-16…G-19, G-21, G-22), `docs/SPEC-FUNCIONAL.md`, `docs/ARQUITECTURA.md`, `docs/MODELO-DATOS.md`, `docs/adr/0003`, `0005`, `0006`, `0010`, `0011`, `0012`, **`docs/adr/0014`**, `docs/ESTADO.md`, `docs/design/E3-libro-diario.md`, `docs/design/E3-asientos-tipo.md`, `docs/design/E5-liquidacion.md`, `docs/design/E6-informes.md`, y —origen de esta ronda— **`docs/design/E8-validacion-documentos.md`** (experto contable, veredicto **NO CONFORME**; observaciones **O-1…O-22**, seis bloqueantes; tabla corregida de `docKind → plantilla` §1.1, regla de `payableKey` §1.2 y tabla 607/600/621/623/628 §1.3). Skills: `fiabilidad`, `codebase-taxhacker`, `ui-erp`, `pgc-npgc`, `contabilidad-analitica`, `supabase-multitenant`.

**Código heredado que E8 transforma:** `ai/{analyze,prompt,schema,attachments}.ts`, `ai/providers/llmProvider.ts`, `app/api/unsorted/analyze/route.ts`, `app/(app)/unsorted/actions.ts`, `components/unsorted/analyze-form.tsx`, `components/agents/{currency-converter,items-detect}.tsx`, `app/api/currency/route.ts`, `models/{transactions,files,settings,export_and_import}.ts`, `forms/transactions.ts`, `lib/{analyze-queue,uploads,encryption,rate-limit,money}.ts`, `app/(app)/apps/{invoices,email}/*`.
**Código propio sobre el que se apoya:** `lib/ledger/{post,tax,hash,types,void}.ts`, `lib/ledger/templates/*`, `models/ledger.ts`, `lib/db.ts`.

---

## 0. Ronda 2 — qué cambió y por qué

| # | Cambio de la ronda 1 a la ronda 2 | Origen |
|---|---|---|
| 1 | **La cuota contabilizada es la del documento**, no la recalculada. `cuota()` pasa a ser control de verosimilitud y fija la confianza. **Desaparece la línea de 669/769 por residuo de IVA**; 669/769 queda para el redondeo de **tesorería** y 634/639 para un eventual ajuste de imposición indirecta | **O-2** (bloqueante). Con la ronda 1, el libro registro de facturas recibidas no coincidía con las facturas y el 303 se declaraba con una cuota inexistente |
| 2 | **`TICKET`: contrapartida de tesorería y deducibilidad `NONE`**, con **RC-17** para derivar la base de un total con IVA incluido (cuota residual, tolerancia 0) | **O-1** (bloqueante). Era el camino más transitado del producto y deducía sistemáticamente cuotas no deducibles, creando además deudas en 410 que nunca se pagan |
| 3 | **Siempre 523 en el alta**; la separación 523/173 se mide **desde el cierre** y es un asiento de reclasificación de **E9**. En documentos mixtos, **el pasivo se reparte por bloques**, cada uno con su cuota | **O-3** (bloqueante). La ronda 1 medía desde la fecha de factura e inflaba el pasivo no corriente y el fondo de maniobra |
| 4 | **ISP sólo con cuatro precondiciones verificables**; **importación ≠ ISP** (`FACTURA_RECIBIDA_EXTRACOM` y `DUA_IMPORTACION` como `docKind` propios); tipo de autorrepercusión **español**, elegido por el usuario | **O-4** (bloqueante). La ronda 1 autorrepercutía sobre importaciones, inventando una cuota devengada y una deducible sin soporte |
| 5 | **Rectificativas representables**: `rectifies{documentNumber, entryId?, reason, mode}`, con **`mode = SUSTITUCION` contabilizando la diferencia**; abonos con total negativo normalizados; rectificativa de ejercicio cerrado → T-22 | **O-5** (bloqueante). T-02 y T-05 eran inconstruibles, y una rectificativa por sustitución duplicaba la operación |
| 6 | **Cuarta fecha: `receptionDate`**, y el **periodo de IVA = `max(receptionDate, documentDate)`**, no el `entryDate`. Más `operationDate` y **RC-18** (caducidad a cuatro años) | **O-6** (bloqueante). Se deducía en el trimestre del asiento y no en el de recepción de la factura |
| 7 | Los `docKind` de anticipo **desaparecen**: la factura de anticipo es una factura normal contra **438/407** y el dinero llega por T-08/T-09. Se añaden `appliedAdvanceTaxCents` y `advanceEntryId` | **O-7** |
| 8 | **`JournalLine` gana `originalCurrency`, `originalAmountCents`, `exchangeRateId`** (opción (a) de O-8) y `entryHash` estrena **`hashVersion = 3`** con convivencia. El residuo de conversión **se elimina por construcción** (Hamilton sobre las cuotas), no se contabiliza | **O-8**. Sin las columnas, la valoración al tipo de cierre (NRV 11ª.2.1) no era computable desde el diario, que es la fuente única |
| 9 | **`VOID → PROPOSED → POSTED`** permitido (anular y rehacer), con `voidedEntryId`; **`CHECK` de D1 reescrito** (el del ADR dejaba pasar `VOID` sin asiento); el **split crea N `Transaction`** | **O-9** |
| 10 | **`accountCode`, `projectId` y `costCenterId` salen del esquema del modelo.** Su origen es `catalogo` o `usuario`; jamás `calculado` | **O-10**. Que un modelo elija entre 607 y 623 es que un modelo decide MC1 y MC2 |
| 11 | **La retención la fija `Counterparty`**, no el PDF; lo leído sólo contrasta (**RC-19**, WARN bloqueante para el lote) | **O-11**. La retención es obligación del pagador (arts. 99, 101, 107 LIRPF) |
| 12 | **`ProposalLine.kind ∈ {OPERACION, SUPLIDO, NO_SUJETO}`** y `discountCents` | **O-12**, **O-15**. Una factura de abogado con tasa judicial fallaba RC-03 siendo correcta |
| 13 | Nóminas, RLC/RNT y extractos → **`null` explícito**; nota de gasto contra **465/tesorería**, nunca 400/410 | **O-13** |
| 14 | **`selectRate` por devengo**, no por expedición (art. 90.Dos LIVA), aplicado **a la vez** en C-10 de E3 y en RC-06 | **O-14** |
| 15 | **Dos tolerancias separadas**: `TOLERANCIA_CUOTA_IVA_CENTS = 1` constante del motor (no configurable) y `redondeoToleranciaCents` con **techo duro de 5 c** | **O-16** |
| 16 | **`deducibilidadPorDefecto ∈ {FULL, NONE, REQUIERE_DECISION}`** por cuenta/categoría, sembrado en las del art. 96 LIVA y art. 95.Tres.2ª | **O-17** |
| 17 | **`InvoiceSeries.kind`** (ordinaria / rectificativa / simplificada), numeración sin huecos con invariante, y «una factura emitida no se borra» escrito junto a la serie | **O-18** |
| 18 | **I-E8-7 partido en 7a (tolerancia 0) y 7b (métrica de calidad)**; I-E8-13 extendido a `(taxId, nº documento, ejercicio)`; I-E8-4 reformulado; **I-E8-15…19 nuevos** (puentes al 303 y al 111/115, caducidad, ISP, divisa) | **O-19** |
| 19 | **Cuarto nivel de confianza `verificado`** («leído del documento y coincidente con el recálculo»); **NIF con dígito de control inválido = FAIL**, no WARN; **ningún asiento puede referenciar un run `partial` de `kind = LLM`** | **O-20** |
| 20 | **`Organization.ivaRegime`**: con RECC/REDEME/otro, la contabilización automática se **bloquea** y se declara en pantalla (**RC-24**) | **O-21** |
| 21 | Referencias al entregable de validación unificadas en **`docs/design/E8-validacion-documentos.md`** | **O-22** |
| 22 | **El IVA del anticipo de cliente devenga al cobro** (art. 75.Dos LIVA), no al expedir la factura: **RC-25**. Sin cobro registrado, `430` contra `438` **sin línea de 477**, y el devengo llega con T-08 | **O-23** (residuo de O-7) |
| 23 | **I-E8-15 partido en 15a / 15b / 15c**: deducible contra 472, total del libro registro = 472 + IVA no deducible incorporado al coste, y repercutido contra 477. El invariante único fallaba sobre datos correctos en cuanto había un ticket no cualificado —que tras D9 es el caso por defecto— | **O-24** (residuo de O-19) |
| 24 | **RC-11 con tres ramas por país**: ES (módulo 23 / letra de CIF, FAIL) · UE (formato de NIF-IVA + VIES) · **tercer país (identificador libre, nunca FAIL)**. La regla única habría bloqueado precisamente las importaciones que la ronda 2 acaba de introducir | **O-25** (residuo de O-20) |

**Lo que el experto declaró correcto y no se toca:** la puerta `FAIL ⇒ no hay asiento`; `IMPORTED` que carga el formulario y nunca contabiliza; la tasa del `documentDate` con `rateDate` efectiva visible; `exchange_rates` global y append-only; el forzado limitado a duplicado y `convertedTotal`, nunca a una cifra aritmética; el `sha256` como eslabón de la cadena; la revisión humana como run nuevo (D5); la decisión de **no** detectar automáticamente los gastos no deducibles por naturaleza; e I-E8-1, 2, 3, 6, 8, 9, 12 y 14, con I-E8-8 señalado como el mejor invariante de la épica.

---

## 1. Objetivo y alcance

E8 convierte un documento en un asiento **sin que ninguna cifra contable salga de un modelo de lenguaje y sin que ninguna calificación fiscal la decida el documento**. El LLM produce una propuesta tipada y trazable (`ExtractionRun` inmutable: proveedor, modelo, sha del prompt efectivo, versión de schema, páginas vistas de las totales, salida cruda, tokens, duración, git-sha); `reconcile()` la recalcula, la contrasta y la clasifica campo a campo en `calculado` / `verificado` / `interpretación IA` / `no verificado`; `postFromProposal()` construye el borrador con la plantilla que corresponda de las 28 de E3, con la **cuota del documento**, la **contrapartida por naturaleza de cada línea** y la **retención del régimen de la contraparte**; y un EDITOR confirma. El asiento referencia `fileId`, `extractionRunId` y el `sha256`, de modo que cualquier celda de cualquier informe llega al PDF original en tres clics.

Además: **elimina `File.cachedParseResult`** migrando lo histórico a runs `importado sin origen` con confianza `no verificado`; **añade `File.sha256`**; **saca la conversión de moneda del navegador** a `ExchangeRate` persistido con una sola fuente (BCE/Frankfurter), tasa del `documentDate` y **divisa original en la línea del diario**; **añade la cuarta fecha** (`receptionDate`) y con ella el periodo correcto de IVA soportado; **da semántica dura a `Transaction.status`** con salida de `VOID`; **versiona los prompts**; **contabiliza las facturas emitidas** con series ordinaria y rectificativa; y cierra **G-01…G-04**, **G-07…G-13**, **G-16…G-19**, **G-21**, **G-22** y las observaciones **O-3/O-9** de E3 y **O-4/O-13** de E6.

**No incluye:** conciliación bancaria y la pestaña Auditoría como pantalla → **E7**; reclasificación 523→173 al cierre, valor actual del aplazamiento largo, diferencias de cambio 668/768, regularización de IVA (T-23 consumiendo el periodo de D8), cierre, recurrentes y **regímenes RECC/REDEME** → **E9**; presupuesto y horas → **E10**; backups de las tablas nuevas y límites por plan → **E11**; segundo LLM en modo verificación (G-14 completo) → **E12**; SII y Verifactu → v1.1 (`InvoiceSeries.lastHash` se declara y se deja a `NULL`); OCR propio; detección automática de gastos no deducibles por naturaleza, que es criterio humano y así se declara en pantalla.

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

`@@map`/`@map` en snake_case en todo lo nuevo, ids `uuid`, dinero `Int` céntimos (`BigInt` sólo en `rateMicro` y agregados), fechas de operación `@db.Date`, `DateTime` sólo para auditoría técnica, `organizationId` en toda tabla de negocio. Nada se borra. Las tablas de tenant entran en `TENANT_MODELS` y se protegen con `SELECT app.enforce_tenant_rls('<tabla>')`; `exchange_rates` es referencia global (ADR-0014 D7) y entra en `GLOBAL_REFERENCE_MODELS`.

### 2.2 Fragmento Prisma

```prisma
/// Evidencia de una extracción. INMUTABLE (append-only en RLS). Nunca es
/// fuente de cifras: es la prueba de de dónde salió una propuesta.
model ExtractionRun {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  fileId     String @map("file_id") @db.Uuid
  file       File   @relation(fields: [organizationId, fileId], references: [organizationId, id], onDelete: Restrict)
  fileSha256 String @map("file_sha256") @db.Char(64)

  kind        ExtractionKind
  parentRunId String?         @map("parent_run_id") @db.Uuid    // ADR-0014 D5
  parent      ExtractionRun?  @relation("RunRevision", fields: [parentRunId], references: [id], onDelete: Restrict)
  revisions   ExtractionRun[] @relation("RunRevision")

  provider       String @db.VarChar(64)
  model          String @db.VarChar(128)
  temperatureBps Int    @default(0) @map("temperature_bps")
  /// G-09: cadena de intentos, `[{provider, model, ok, errorCode?, ms}]`.
  attempts Json @default("[]")

  promptCode      String       @map("prompt_code") @db.VarChar(64)
  promptSource    PromptSource @map("prompt_source")
  promptVersionId String?      @map("prompt_version_id") @db.Uuid
  promptSha       String       @map("prompt_sha") @db.Char(64)
  schemaVersion   String       @map("schema_version") @db.VarChar(16)
  schemaSha       String       @map("schema_sha") @db.Char(64)

  pagesSent  Int     @map("pages_sent")
  pagesTotal Int     @map("pages_total")
  partial    Boolean @default(false)   // lo escribe un trigger, no quien inserta

  rawOutput    Json    @map("raw_output")
  proposal     Json?
  proposalSha  String? @map("proposal_sha") @db.Char(64)
  fieldOrigins Json    @default("{}") @map("field_origins")

  reconcile       Json?
  reconcileStatus ReconcileStatus? @map("reconcile_status")

  tokensIn   Int?    @map("tokens_in")
  tokensOut  Int?    @map("tokens_out")
  costMicros BigInt? @map("cost_micros")
  durationMs Int     @map("duration_ms")
  gitSha     String  @map("git_sha") @db.VarChar(64)

  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  entries JournalEntry[] @relation("EntryExtractionRun")

  @@unique([organizationId, id])
  @@index([organizationId, fileId, createdAt(sort: Desc)])
  @@index([organizationId, reconcileStatus])
  @@map("extraction_runs")
}

enum ExtractionKind  { LLM MANUAL IMPORTED }   @@map("extraction_kind")
enum PromptSource    { GIT ORG }               @@map("prompt_source")
enum ReconcileStatus { PASS WARN FAIL }        @@map("reconcile_status")

/// Override de prompt por organización. APPEND-ONLY: «editar» es insertar
/// version+1. La versión VIGENTE vive en `Setting("prompt_active_version:<code>")`,
/// que sí es mutable y auditado (patrón de G-10).
model PromptVersion {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code    String  @db.VarChar(64)
  version Int
  content String  @db.Text
  sha256  String  @db.Char(64)
  notes   String? @db.VarChar(512)
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  @@unique([organizationId, code, version])
  @@map("prompt_versions")
}

/// Referencia diaria del BCE. GLOBAL, sin `organization_id` (ADR-0014 D7).
model ExchangeRate {
  id        String   @id @default(uuid()) @db.Uuid
  date      DateTime @db.Date
  from      String   @db.VarChar(3)
  to        String   @db.VarChar(3)
  rateMicro BigInt   @map("rate_micro")
  source    String   @db.VarChar(32)
  fetchedAt DateTime @default(now()) @map("fetched_at")
  lines     JournalLine[]
  @@unique([date, from, to, source])
  @@index([from, to, date(sort: Desc)])
  @@map("exchange_rates")
}

/// O-18: serie por TIPO. El art. 15.4 RD 1619/2012 obliga a serie especial
/// para las rectificativas.
model InvoiceSeries {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code       String            @db.VarChar(24)
  kind       InvoiceSeriesKind @default(ORDINARIA)
  prefix     String            @db.VarChar(16)
  nextNumber Int               @default(1) @map("next_number")
  year       Int?
  lastHash   String?           @map("last_hash") @db.Char(64)   // v1.1 Verifactu
  isActive   Boolean           @default(true) @map("is_active")
  @@unique([organizationId, code, year])
  @@map("invoice_series")
}
enum InvoiceSeriesKind { ORDINARIA RECTIFICATIVA SIMPLIFICADA }   @@map("invoice_series_kind")
```

**Cambios en modelos existentes:**

```prisma
model File {
  sha256    String? @db.Char(64)          // G-11; NOT NULL tras el backfill
  sizeBytes Int?    @map("size_bytes")
  // − cachedParseResult  (columna ELIMINADA, G-03)
  extractionRuns ExtractionRun[]
  @@unique([organizationId, id])
  @@index([organizationId, sha256])
}

model Transaction {
  exchangeRateMicro BigInt?   @map("exchange_rate_micro")
  rateDate          DateTime? @map("rate_date") @db.Date
  rateSource        String?   @map("rate_source") @db.VarChar(32)
  convertedTotalOverrideReason String? @map("converted_total_override_reason") @db.VarChar(512)
  extractionRunId   String?   @map("extraction_run_id") @db.Uuid
  /// ADR-0014 D1 (O-9): al anular, `journalEntryId` se TRASLADA aquí y el
  /// estado pasa a VOID. Permite `VOID → PROPOSED → POSTED` (anular y rehacer)
  /// sin perder el histórico ni volver a subir el fichero.
  voidedEntryId  String?  @map("voided_entry_id") @db.Uuid
  voidedEntryIds String[] @map("voided_entry_ids") @db.Uuid   // append-only por trigger
  /// O-9.iii: el split crea N Transaction, una por asiento, sobre el mismo File.
  splitParentTransactionId String? @map("split_parent_transaction_id") @db.Uuid
}

model JournalEntry {
  file          File?          @relation(fields: [organizationId, fileId], references: [organizationId, id], onDelete: Restrict)
  extractionRun ExtractionRun? @relation("EntryExtractionRun", fields: [organizationId, extractionRunId], references: [organizationId, id], onDelete: Restrict)
  templateVersion Int @default(1) @map("template_version")   // O-3 de E3
  /// ADR-0014 D8 (O-6). La CUARTA fecha. Gobierna el periodo de IVA soportado
  /// junto con `documentDate`; NO interviene en ejercicio, mes ni `ledgerHash`.
  receptionDate DateTime? @map("reception_date") @db.Date
  /// Devengo del IVA (art. 75 LIVA) cuando difiere de la expedición. Es la que
  /// selecciona el TaxRate (O-14, art. 90.Dos).
  operationDate DateTime? @map("operation_date") @db.Date
}

model JournalLine {
  /// ADR-0014 D2 (O-8). Divisa ORIGINAL de la partida monetaria (43x, 40x,
  /// 41x, 523, 57x). Sin ellas, la valoración al tipo de cierre de la NRV
  /// 11ª.2.1 no es computable desde el diario. El motor que las consume es de
  /// E9; las columnas entran en E8, que es quien crea la deuda en divisa.
  /// INMUTABLES: no entran en el GRANT UPDATE de ADR-0010.
  originalCurrency   String?       @map("original_currency") @db.VarChar(3)
  originalAmountCents Int?         @map("original_amount_cents")
  exchangeRateId     String?       @map("exchange_rate_id") @db.Uuid
  exchangeRate       ExchangeRate? @relation(fields: [exchangeRateId], references: [id], onDelete: Restrict)
}

model Counterparty {
  /// ADR-0014 D11 (O-4, O-11, O-21). La calificación fiscal vive aquí, no en
  /// el documento.
  countryCode       String?  @map("country_code") @db.VarChar(2)
  vatNumber         String?  @map("vat_number") @db.VarChar(20)      // NIF-IVA
  viesValid         Boolean? @map("vies_valid")
  viesCheckedAt     DateTime? @map("vies_checked_at")
  withholdingRegime WithholdingRegime @default(NINGUNO) @map("withholding_regime")
  withholdingRateCode String? @map("withholding_rate_code") @db.VarChar(24)
  surchargeRegime   Boolean  @default(false) @map("surcharge_regime")  // recargo de equivalencia
  isEmployee        Boolean  @default(false) @map("is_employee")       // notas de gasto (O-13)
}
enum WithholdingRegime { NINGUNO PROFESIONAL PROFESIONAL_INICIO ARRENDADOR AGRICOLA MODULOS }

model Category {
  /// O-10: origen legítimo de la cuenta. `catalogo`, nunca `llm`.
  /// CHECK: no puede apuntar al subgrupo 64 (O-13: las nóminas entran por T-10).
  defaultAccountCode String? @map("default_account_code") @db.VarChar(12)
  /// O-17: tercer valor para los gastos del art. 96 LIVA y del art. 95.Tres.2ª.
  defaultDeductibility DefaultDeductibility @default(FULL) @map("default_deductibility")
}
enum DefaultDeductibility { FULL NONE REQUIERE_DECISION }

model Organization {
  /// D11 (O-4, O-21).
  roiRegistered Boolean   @default(false) @map("roi_registered")
  ivaRegime     IvaRegime @default(GENERAL) @map("iva_regime")
  // `redondeoToleranciaCents` ya existe desde E3; gana CHECK BETWEEN 0 AND 5 (O-16)
}
enum IvaRegime { GENERAL RECC REDEME OTRO }

enum SourceType { MANUAL DOCUMENT INVOICE_OUT INVOICE_IN BANK_IMPORT CSV_IMPORT RECURRING SYSTEM }
enum AccountKey { /* … 57 claves … */ PROVEEDORES_INMOVILIZADO }
```

**`hashVersion = 3`** (ADR-0014 D2). `canonicalEntryFormV3 = v2 + originalCurrency + originalAmountCents + exchangeRateId`. Convivencia estricta, que es lo que `lib/ledger/hash.ts` prescribe: las filas existentes conservan `hashVersion = 2` y se verifican con v2, y **los fixtures de E3–E6 no se tocan**. El `ledgerHash` **financiero** no cambia —el hecho económico en moneda base es el mismo—, así que las cachés de `ReportRun` de E6 no se invalidan.

### 2.3 Migraciones

Tres, en este orden. Las dos primeras separadas porque `ALTER TYPE … ADD VALUE` no permite usar el valor nuevo en la misma transacción.

**`20260913090000_e8_enums`** — sólo enums, sin uso: `ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'INVOICE_IN'; ALTER TYPE "AccountKey" ADD VALUE IF NOT EXISTS 'PROVEEDORES_INMOVILIZADO';`

**`20260913100000_e8_documentos`** — todo lo demás. Ejecutable por un rol **no** superusuario (nada de `ALTER ROLE`, `OWNER TO` ni extensiones nuevas):

1. `CREATE TYPE` de `extraction_kind`, `prompt_source`, `reconcile_status`, `invoice_series_kind`, `withholding_regime`, `default_deductibility`, `iva_regime`. `CREATE TABLE extraction_runs`, `prompt_versions`, `exchange_rates`, `invoice_series`.
2. Columnas nuevas en `files`, `transactions`, `journal_entries`, `journal_lines`, `counterparties`, `categories`, `organizations`, según §2.2.
3. **RLS.** `enforce_tenant_rls` en `extraction_runs`, `prompt_versions`, `invoice_series`; append-only (RESTRICTIVE `USING (false)` en UPDATE/DELETE + `REVOKE`) en las dos primeras. `exchange_rates`: `ENABLE` + `FORCE`, `SELECT USING (true)`, `INSERT WITH CHECK (true)`, RESTRICTIVE en UPDATE/DELETE. No pasa por `enforce_tenant_rls` porque no tiene `organization_id`, pero **sí lleva `FORCE`**, de modo que el test de «ninguna tabla en `NO FORCE`» sigue siendo válido.
4. **CHECK y triggers:**
   - `CHECK (pages_sent BETWEEN 0 AND pages_total)`; trigger BEFORE INSERT que escribe `partial = (pages_sent < pages_total)` — no se confía en quien inserta.
   - `exchange_rates`: `CHECK (rate_micro > 0)`, `CHECK ("from" <> "to")`, longitud 3.
   - **`transactions`, `CHECK` de ADR-0014 D1 reescrito** (O-9.ii), con las cuatro ramas explícitas de §D1 del ADR; trigger `transactions_status_transition` que permite `DRAFT→PROPOSED→POSTED→VOID`, el atajo `DRAFT→POSTED` y **`VOID→PROPOSED`**, y prohíbe `POSTED→DRAFT|PROPOSED`; trigger que traslada `journal_entry_id` a `voided_entry_id` y lo apila en `voided_entry_ids` al pasar a `VOID`.
   - `CHECK (converted_total_override_reason IS NULL OR char_length(...) >= 10)`.
   - `organizations`: `CHECK (redondeo_tolerancia_cents BETWEEN 0 AND 5)` (**techo duro**, O-16).
   - `categories`: `CHECK (default_account_code IS NULL OR left(default_account_code,2) <> '64')` (O-13).
   - `journal_lines`: `CHECK ((original_currency IS NULL) = (original_amount_cents IS NULL))` y `CHECK (original_currency IS NULL OR exchange_rate_id IS NOT NULL)`.
   - `extraction_runs`: `CHECK (kind <> 'MANUAL' OR parent_run_id IS NOT NULL OR provider = 'formulario')`; cota de tamaño `pg_column_size(raw_output) + pg_column_size(proposal) < 262144`.
   - **`invoice_series`** (O-18): trigger de numeración sin huecos y fecha no decreciente dentro de la serie; sin `DELETE`.
5. **FK compuestas por tenant** (patrón de E4): `journal_entries (organization_id, file_id) → files`, `(organization_id, extraction_run_id) → extraction_runs`, ambas `ON DELETE RESTRICT`; `journal_lines.exchange_rate_id → exchange_rates` (global, FK simple).
6. **`GRANT` de columna:** las tres columnas de divisa de `journal_lines` **no** se añaden al `GRANT UPDATE` acotado de ADR-0010. Son inmutables.
7. **Backfill de `cachedParseResult` → `ExtractionRun`** (§2.4) con el patrón obligatorio en **las dos** tablas implicadas y la marca de conversión escrita antes:
   ```sql
   ALTER TABLE files           NO FORCE ROW LEVEL SECURITY;
   ALTER TABLE extraction_runs NO FORCE ROW LEVEL SECURITY;
   INSERT INTO extraction_runs (…) SELECT … FROM files WHERE cached_parse_result IS NOT NULL;
   ALTER TABLE extraction_runs FORCE ROW LEVEL SECURITY;
   ALTER TABLE files           FORCE ROW LEVEL SECURITY;
   ```
8. `ALTER TABLE files DROP COLUMN cached_parse_result;`
9. **Mapa de cuentas y seeds:** `PROVEEDORES_INMOVILIZADO → '523'` en toda organización que no lo tenga; `default_deductibility = 'REQUIERE_DECISION'` en las categorías de hostelería, restauración, atenciones a clientes, espectáculos y combustible de turismos (O-17); serie `RECTIFICATIVA` por organización (O-18). Todo bajo el patrón `NO FORCE`/`FORCE`; una organización cuyo plan no tenga `523` postable **no falla la migración**: queda como WARN de Auditoría.
10. `TENANT_MODELS += "ExtractionRun", "PromptVersion", "InvoiceSeries"`; `GLOBAL_REFERENCE_MODELS = new Set(["ExchangeRate"])` en `lib/db.ts`, con su regla ESLint.
11. Tests de integración del SQL: RLS por tenant, append-only (42501), CHECKs, los tres triggers de estado, el de `partial`, el de series, y el test existente de «ninguna tabla en `NO FORCE`».

**`20260914090000_e8_file_sha256_not_null`** — endurece `files.sha256` a `NOT NULL` cuando `scripts/backfill-file-sha256.ts` reporta 0 pendientes. Una migración no lee el sistema de ficheros.

### 2.4 Estrategia de datos existentes

| Dato | Qué se hace |
|---|---|
| `files.cached_parse_result` | Un `ExtractionRun` con `kind = 'IMPORTED'`, `provider = 'importado'`, `model = 'desconocido'`, `prompt_sha = sha256('')`, `schema_version = '0'`, `raw_output = cached_parse_result`, `proposal = NULL`, `reconcile = {"status":"NO_VERIFICADO","reason":"importado sin origen","checks":[]}`, `reconcile_status = NULL`, `created_at = files.created_at`. La columna se elimina en el paso 8 |
| Consecuencia funcional | El run `IMPORTED` **carga el formulario** —para que nadie pierda su trabajo— pero cada campo se pinta **`no verificado`**, `postFromProposal()` lo rechaza con `PROPOSAL_NOT_RECONCILED` y no entra jamás en el lote. Para contabilizarlo hay que reanalizar o teclear: una memoria no es fuente de cifras (P4) |
| `files.sha256` | `NULL` tras la migración; lo puebla `scripts/backfill-file-sha256.ts` como `app_maintenance`, por organización, en lotes reanudables, marcando `metadata.integrity = "MISSING"` los ficheros cuyos bytes ya no están. Sin `sha256` no se analiza ni se contabiliza (I-E8-9) |
| `transactions` existentes | Todas en `DRAFT` sin asiento: el `CHECK` de D1 se cumple sin backfill |
| `journal_entries/lines` existentes | `extraction_run_id`, `file_id` y las tres columnas de divisa son `NULL`; `hash_version` se queda en **2** y se verifica con v2. **Sin recálculo de hashes** |
| `app/api/currency` | Endpoint eliminado. La caché era de proceso: no hay tasas históricas que migrar. `exchange_rates` nace vacía |
| Fixtures `ejercicio-{minimo,completo}.json` | **No se tocan.** Ni una cifra, ni un `sourceType`, ni un byte. Los fixtures propios de E8 van en `docs/design/fixtures/extraccion-esperada.json` |

---

## 3. Motor / funciones puras

Todo lo de `lib/extraction/` y `lib/ledger/postFromProposal.ts` es **puro**: sin IO, sin LLM, sin `Date.now()`; `refDate` viaja en el contexto.

### 3.1 `lib/extraction/types.ts` — la propuesta y su confianza

```ts
export type FieldOrigin = "llm" | "usuario" | "calculado" | "catalogo" | "importado"
/** O-20.1: CUATRO niveles. `verificado` = leído del documento y coincidente
 *  con el recálculo determinista — la distinción que un auditor busca primero. */
export type Confidence = "calculado" | "verificado" | "interpretacion_ia" | "no_verificado"

export type Provenanced<T> = {
  value: T | null
  origin: FieldOrigin
  confidence: Confidence
  rawText?: string
  page?: number
  bbox?: readonly [number, number, number, number]
  check?: string
}

/** O-12 / O-15. */
export type LineKind = "OPERACION" | "SUPLIDO" | "NO_SUJETO"

export type ProposalLine = {
  kind: LineKind                    // default OPERACION
  baseCents: Cents                  // ≥ 1 tras aplicar el descuento
  discountCents?: Cents             // O-15: minora la base, no genera abono
  taxRateCode: string | null        // null en SUPLIDO / NO_SUJETO
  surchargeRateCode?: string        // se aplica por régimen del cliente, no por el PDF
  description?: string
  qty?: number                      // informativo; NUNCA se multiplica para obtener la base
  unitPriceCents?: Cents
  // ── O-10: NO están en el esquema que se pide al modelo ──
  accountCode?: string              // origen `catalogo` (Category.defaultAccountCode) o `usuario`
  projectId?: string                // origen `usuario`
  costCenterId?: string             // origen `usuario`
  deductibility?: "FULL" | "NONE" | "PRORRATA"   // ADR-0014 D4
}

export type ProposalTax = {
  taxRateCode: string
  baseCents: Cents
  /** ADR-0014 D3: ESTA es la cuota que se contabiliza. */
  quotaCents: Cents
  /** O-4: clave de operación para el libro registro y el 303/349. */
  operationKey?: "GENERAL" | "ISP" | "AIB" | "EXENTA_25" | "EXPORTACION" | "NO_SUJETA"
}

export type DocKind =
  | "FACTURA_RECIBIDA" | "FACTURA_RECIBIDA_ISP" | "FACTURA_RECIBIDA_EXTRACOM"
  | "DUA_IMPORTACION"  | "ABONO_RECIBIDO"       | "TICKET"
  | "FACTURA_ANTICIPO_PROVEEDOR" | "NOTA_GASTO_EMPLEADO"
  | "FACTURA_EMITIDA"  | "ABONO_EMITIDO"        | "FACTURA_ANTICIPO_CLIENTE"
  | "NOMINA" | "RECIBO_SS" | "EXTRACTO_BANCARIO"
  | "DESCONOCIDO"

export type ExtractionProposal = {
  version: 1
  docKind: DocKind
  documentNumber: string | null
  counterparty: { name: string | null; taxId: string | null; id?: string | null }
  /** LAS CUATRO FECHAS (+ una opcional). ADR-0014 D8. */
  documentDate: LocalDate | null
  accrualDate?: LocalDate | null
  /** O-6: gobierna el periodo de IVA soportado. Origen `usuario`, NUNCA `llm`. */
  receptionDate: LocalDate | null
  /** O-6/O-14: devengo del IVA; selecciona el TaxRate. */
  operationDate?: LocalDate | null
  dueSchedule?: readonly { dueDate: LocalDate; amountCents: Cents }[]
  currency: string
  lines: readonly ProposalLine[]
  taxes: readonly ProposalTax[]
  /** O-11: se RELLENA desde `Counterparty`; lo leído del PDF va en `readWithholding`. */
  withholding?: { rateCode: string; quotaCents: Cents } | null
  readWithholding?: { rateBps: number; quotaCents: Cents } | null
  /** O-7: los dos, más la referencia al asiento del anticipo. */
  appliedAdvanceCents?: Cents
  appliedAdvanceTaxCents?: Cents
  advanceEntryId?: string
  /** O-5 / ADR-0014 D12. */
  rectifies?: {
    documentNumber: string
    entryId?: string
    reason: "DEVOLUCION" | "DESCUENTO_POSTERIOR" | "RAPPEL" | "ERROR"
    mode: "DIFERENCIAS" | "SUSTITUCION"
  }
  /** O-1: medio de pago del ticket → clave de tesorería. Origen `usuario`. */
  paymentKey?: "BANCO_DEFAULT" | "CAJA"
  simplifiedQualified?: boolean      // art. 7.2 RD 1619/2012, acto explícito del usuario
  totalCents: Cents
  description?: string | null
}

export type FieldOrigins = Record<string, Provenanced<unknown>>
```

**Lo que el modelo rellena** (`ai/schemas/extraction.v1.json`, versionado en git): `docKind` sugerido, `documentNumber`, nombre y NIF de la contraparte, `documentDate`, `dueSchedule`, `currency`, líneas con `baseCents`/`discountCents`/`taxRateCode`/`description`/`qty`/`unitPriceCents`, `taxes` con base y cuota, `readWithholding`, `rectifies.documentNumber`, `totalCents` y el texto de las menciones legales. **Lo que no rellena nunca** (O-4, O-10, O-11, ADR-0014 D4/D11): `accountCode`, `projectId`, `costCenterId`, `deductibility`, `withholding`, `receptionDate`, `paymentKey`, `simplifiedQualified`, `rectifies.reason`, `rectifies.mode`, y la calificación firme de ISP. Los `Field` personalizados de TaxHacker siguen existiendo pero sólo aportan campos **no económicos** a `Transaction.extra`.

### 3.2 `lib/extraction/hash.ts`

```ts
export function canonicalJson(value: unknown): string       // ADR-0011: claves ordenadas, sin undefined, NFC, LF
export function promptHash(renderedPrompt: string): string  // el prompt EFECTIVO, ya sustituido
export function schemaHash(schema: unknown): string
export function proposalHash(p: ExtractionProposal): string
export function promptContentHash(content: string): string
```
Normalización antes de hashear (misma disciplina que `lib/ledger/hash.ts`): `LF`, sin espacios finales, `NFC`. El sha256 del **fichero** es IO y vive en `lib/uploads.ts`.

### 3.3 `lib/extraction/reconcile.ts`

```ts
export type ReconcileContext = {
  baseCurrency: string
  /** Vigentes a la fecha de DEVENGO (O-14), no a la de expedición. */
  taxRates: readonly TaxRateRef[]
  accounts: readonly { code: string; isPostable: boolean; isActive: boolean; group: number }[]
  accountMap: Readonly<Record<AccountKey, string>>
  projects: readonly ProjectRef[]
  costCenters: readonly CostCenterRef[]
  currencies: readonly { code: string; exponent: number }[]
  fiscalYears: readonly FiscalYearRef[]
  periodLocks: readonly PeriodLockRef[]
  /** O-11 / O-4 / O-21: la calificación fiscal viene de aquí, no del PDF. */
  counterparty: CounterpartyRef | null
  organization: { roiRegistered: boolean; ivaRegime: IvaRegime; prorrataBps: number | null
                  taxRoundingMode: TaxRoundingMode; redondeoToleranciaCents: number; analyticsRequired: boolean }
  /** O-5: líneas del documento rectificado, para `mode = SUSTITUCION` y C-12. */
  rectifiedEntry: { id: string; lines: readonly ReportLine[] } | null
  /** O-7: asiento del anticipo, para comprobar `appliedAdvanceTaxCents`. */
  advanceEntry: { id: string; taxCents: Cents } | null
  rate: { rateMicro: bigint; rateDate: LocalDate; source: string; id: string } | null
  file: { sha256: string | null; runSha256: string }
  partial: boolean
  runKind: ExtractionKind
  refDate: LocalDate
}

export type ReconcileCheck = {
  id: `RC-${string}`
  status: "PASS" | "WARN" | "FAIL"
  /** O-19: un WARN puede bloquear el lote sin ser FAIL. */
  blocksBatch: boolean
  message: string                   // español contable, apto para pantalla
  evidence?: Record<string, unknown>
  fields: readonly string[]
}

export type ReconcileResult = {
  status: ReconcileStatus
  checks: readonly ReconcileCheck[]
  normalized: ExtractionProposal    // la que se contabiliza
  fieldOrigins: FieldOrigins
  /** O-19: métrica de calidad (I-E8-7b), NO importe a contabilizar. */
  quotaDeviationsCents: Readonly<Record<string, Cents>>
}

export const TOLERANCIA_CUOTA_IVA_CENTS = 1   // O-16: constante del motor, NO configurable

export function reconcile(proposal: ExtractionProposal, ctx: ReconcileContext): ReconcileResult
```

**Reglas RC-01…RC-24.** Cada una con su check, su mensaje y los campos que degrada.

| ID | Regla | Efecto |
|---|---|---|
| **RC-01** | `Σ lines[].(baseCents − discountCents)` de líneas `OPERACION` = base declarada. Suplidos y no sujetos **excluidos** (O-12) | **FAIL**, tolerancia **0** |
| **RC-02** | Por **cada tipo**: `cuota(bases_t, rateBps, mode)` vs `taxes[t].quotaCents` del documento. Coincide → campo `verificado`; difiere ≤ `TOLERANCIA_CUOTA_IVA_CENTS` → **WARN** y campo `interpretacion_ia`; por encima → **FAIL**. **Se contabiliza siempre la del documento** (ADR-0014 D3) | FAIL / WARN |
| **RC-03** | **Identidad interna**: `Σ bases + Σ cuotas + Σ recargos + Σ suplidos y no sujetos − retención − anticipo = totalCents` | **FAIL**, tolerancia **0**. Un documento que no cuadra consigo mismo incumple el art. 6 RD 1619/2012 |
| **RC-04** | `currency` ISO-4217 existente, exponente correcto, **una sola** moneda en el documento | FAIL |
| **RC-05** | Las cuatro fechas existen en el calendario; `documentDate ≤ refDate`; `receptionDate ≥ documentDate` (WARN si no); `resolveEntryDate` cae en ejercicio `OPEN` con mes no bloqueado | FAIL / WARN |
| **RC-06** | Todo `taxRateCode` existe y está vigente a **`operationDate ?? accrualDate ?? documentDate`** (O-14, art. 90.Dos), con `appliesTo` compatible | FAIL |
| **RC-07** | Toda `accountCode` existe, es postable, activa y de la organización; **ninguna del subgrupo 64** (O-13) | FAIL |
| **RC-08** | `projectId`/`costCenterId` existen y activos; exclusividad proyecto **xor** CECO; con `analyticsRequired`, línea 6/7 sin destino → `CC-NA` + WARN (R-A8) | FAIL / WARN |
| **RC-09** | **G-02 + O-20.3.** `partial` ⇒ ningún campo `calculado` ni `verificado`; **y un run `partial` de `kind = LLM` no puede respaldar un asiento**: para contabilizar hay que teclear y crear el run `MANUAL` | **FAIL** para el posteo desde un run LLM parcial |
| **RC-10** | `ctx.file.sha256 === ctx.file.runSha256`, ninguno `null` | FAIL |
| **RC-11** | **O-20.2 + O-25: tres ramas por país**, porque la regla única habría rechazado toda factura de tercer país. **ES o sin país**: módulo 23 / letra de CIF; inválido → **FAIL** (art. 6.1.c RD 1619/2012, sin NIF válido no es deducible). **UE**: formato de NIF-IVA del país → FAIL si es inválido; **VIES** negativo → WARN bloqueante (y bloquea RC-22, que ya lo exige). **Tercer país**: identificador **libre, sin checksum**, **nunca FAIL**; confianza `interpretacion_ia`; WARN sólo si está vacío. Con dígito válido *y* coincidencia en `Counterparty` → **`verificado`**; válido sin coincidencia → `interpretacion_ia` + WARN | FAIL / WARN según rama |
| **RC-12** | Duplicado por `file.sha256` **o** por `(counterparty.taxId, documentNumber, ejercicio)` en compras (O-19). Las N `Transaction` de un mismo split **no** se cuentan entre sí | WARN bloqueante: exige `forceReason` + `AuditLog` |
| **RC-13** | Signos: `totalCents > 0`. **Total negativo + `docKind = FACTURA_*` ⇒ se reclasifica a `ABONO_*` con valores absolutos** y `docKind` queda `interpretacion_ia` (O-5) | FAIL sólo si no es normalizable |
| **RC-14** | `currency ≠ baseCurrency` ⇒ `ctx.rate` presente. Sin tasa **no se inventa nada** | FAIL |
| **RC-15** | Deducibilidad: con prorrata configurada, o con `defaultDeductibility = REQUIERE_DECISION` en la categoría (O-17), el campo nace `no_verificado` | WARN **bloqueante para el lote** |
| **RC-16** | Reproducibilidad interna: `proposalHash(normalized)` estable; ningún importe de `normalized` procede de `rawOutput` sin haber pasado por un check | FAIL (contrato, con test) |
| **RC-17** | **O-1.** `docKind = TICKET` sin bases declaradas: `base = round_half_up(total × 10000 / (10000 + rateBps))`, `cuota = total − base`. Cuota **residual por construcción** ⇒ `base + cuota = total` con tolerancia **0**, sin línea de redondeo. `base` y `cuota` = `calculado`; `total` = `interpretacion_ia` | — |
| **RC-18** | **O-6.** `documentDate` a más de cuatro años de la fecha de deducción ⇒ IVA **caducado** (art. 99.Cinco): deducibilidad forzada a `NONE`, cuota como mayor coste; ejercicio cerrado ⇒ desvío a T-22 | WARN bloqueante |
| **RC-19** | **O-11.** Retención leída ≠ la configurada en `Counterparty`, o configurada y ausente del documento ⇒ WARN **bloqueante para el lote**; el asiento usa **la configurada**. Mensaje: «esta factura debería llevar retención del 15 %; solicite factura rectificada» | WARN bloqueante |
| **RC-20** | **O-12.** Suplidos y no sujetos excluidos de `Σ bases`, de la base de la cuota y de la base de la **retención**, e incluidos en el total | FAIL si se incumple |
| **RC-21** | **O-5.** `docKind = ABONO_*` exige `rectifies.documentNumber`, `reason` y `mode`; con `mode = SUSTITUCION`, `ctx.rectifiedEntry` presente y el importe contabilizado es **la diferencia**; sin resolver el documento rectificado → WARN bloqueante | FAIL / WARN |
| **RC-22** | **O-4.** `docKind = FACTURA_RECIBIDA_ISP` exige las **cuatro** precondiciones (país/VIES con fecha, ausencia de cuota, mención legal del art. 6.1.m leída, `roiRegistered`). Falta alguna ⇒ `docKind = DESCONOCIDO` + WARN, decide el usuario | WARN bloqueante |
| **RC-23** | **O-7.** `appliedAdvanceTaxCents` = exactamente el IVA repercutido en `ctx.advanceEntry`; sin el asiento del anticipo no se aplica | FAIL |
| **RC-24** | **O-21.** `organization.ivaRegime ≠ GENERAL` ⇒ la contabilización automática se **bloquea** con mensaje explícito y remisión a E9 | FAIL |
| **RC-25** | **O-23.** `docKind = FACTURA_ANTICIPO_CLIENTE` exige `advanceEntryId` —el cobro ya registrado— o un `dueSchedule` con cobro efectivo. **Sin cobro ⇒ WARN bloqueante** y el asiento se construye `430` contra `438` **sin línea de 477**: el art. 75.Dos LIVA devenga el impuesto «en el momento del cobro… por los importes efectivamente percibidos», y repercutir al expedir anticipa el ingreso a Hacienda y descuadra las casillas 01-03 del 303. El devengo llega con **T-08** al cobrar. Con cobro registrado, el asiento no cambia | WARN bloqueante |

**Asignación de confianza** (P6, cuatro niveles, O-20.1):

| Confianza | Cuándo |
|---|---|
| `calculado` | Lo produjo el código: base y cuota derivadas de RC-17, `convertedTotal`, el reparto Hamilton de cuotas en divisa, la diferencia de una rectificativa por sustitución |
| `verificado` | **Leído del documento y coincidente con el recálculo determinista**: la cuota que pasa RC-02 al céntimo, el NIF con dígito de control válido y coincidencia en el maestro |
| `interpretacion_ia` | Valor del modelo que pasó su comprobación de forma pero no es derivable: número de documento, contraparte, descripción, fecha, moneda, cuota que difiere dentro de tolerancia, `docKind` sugerido, y **toda cuenta o dimensión que venga del catálogo por coincidencia** |
| `no_verificado` | Su check falló; el usuario lo sobrescribió forzando; el run es `partial` o `IMPORTED`; `convertedTotal` forzado; deducibilidad pendiente de decisión (RC-15) |

**Determinismo.** Sin `Date.now()`, sin `Math.random()`, checks en el orden fijo de la tabla, tipos recorridos por `code`. `canonicalJson(reconcile(p, ctx))` estable byte a byte (I-E8-6).

### 3.4 `lib/ledger/postFromProposal.ts`

**Tabla `TEMPLATE_FOR_DOC` corregida** (§1.1 del experto):

| `docKind` | Plantilla | Contrapartida / matices |
|---|---|---|
| `FACTURA_RECIBIDA` | `FACTURA_RECIBIDA` (T-03) | `payableKey` **por naturaleza de la línea**; reparto en documentos mixtos |
| `FACTURA_RECIBIDA_ISP` | `FACTURA_RECIBIDA_ISP` (T-04) | Sólo con las cuatro precondiciones (RC-22). Tipo **español**, elegido por el usuario |
| `FACTURA_RECIBIDA_EXTRACOM` | `FACTURA_RECIBIDA` (T-03) con tipo no sujeto | Bien de tercer país: base sin IVA contra 400/523. **El IVA lo liquida el DUA** |
| `DUA_IMPORTACION` | **`null`** | Asiento manual T-20 documentado, o plantilla propia en **E9**. Aranceles = mayor coste (NRV 10ª/2ª) |
| `ABONO_RECIBIDO` | `ABONO_RECIBIDO` (T-05) | Exige `rectifies` completo (RC-21) |
| `TICKET` | `FACTURA_RECIBIDA` (T-03) | **Contrapartida de tesorería** (`paymentKey`), **`deductibility = NONE`** salvo ticket cualificado, base por RC-17 |
| `FACTURA_ANTICIPO_PROVEEDOR` | `FACTURA_RECIBIDA` (T-03) | Contrapartida del gasto = **407**. **No T-07**: T-07 mueve dinero |
| `NOTA_GASTO_EMPLEADO` | `FACTURA_RECIBIDA` (T-03) | `payableKey` = `REMUNERACIONES_PENDIENTES` (465) o tesorería. **Nunca 400/410** |
| `FACTURA_EMITIDA` | `FACTURA_EMITIDA_SERVICIOS` (T-01) | `VENTAS_DEFAULT` → 705; 700 disponible por línea |
| `ABONO_EMITIDO` | `ABONO_EMITIDO` (T-02) | **Serie rectificativa propia** (O-18) |
| `FACTURA_ANTICIPO_CLIENTE` | `FACTURA_EMITIDA_SERVICIOS` (T-01) | Contrapartida del ingreso = **438**. **No T-06**. **Sin cobro registrado, sin línea de 477** (RC-25, O-23): el IVA devenga al cobro y llega con T-08 |
| `NOMINA`, `RECIBO_SS`, `EXTRACTO_BANCARIO` | **`null` explícito** | Cifras `computed` de terceros (P1). Entran por T-10 o por E7, jamás por una plantilla de compra |
| `DESCONOCIDO` | `null` | El usuario elige plantilla; eso es un asiento manual con documento adjunto |
| *cualquiera, con el ejercicio del documento cerrado* | **T-22** | 113 si es material, 678/778 si no. Desvío **por fecha**, explícito en la tabla |

**`payableKey` por naturaleza de la LÍNEA** (§1.2 del experto), no del documento:

| Grupo de la cuenta | Clave | Cuenta |
|---|---|---|
| 60x (600, 601/602, **607**) | `PROVEEDORES` | 400 |
| 62x, 63x, 64x, 66x, 69x | `ACREEDORES` | 410 |
| **Grupo 2** | `PROVEEDORES_INMOVILIZADO` | **523 siempre en el alta** (523→173 al cierre, E9) |
| Empleado (nota de gasto) | `REMUNERACIONES_PENDIENTES` / tesorería | 465 / 57x |
| Ticket | tesorería (`paymentKey`) | 570 / 572 |

```ts
export function postFromProposal(
  reconciled: ReconcileResult,
  ctx: LedgerContext,
  opts: { templateCode?: TemplateCode; extractionRunId: string; fileId: string
          transactionId?: string; forceReason?: string }
): Result<EntryDraft>
```

Algoritmo, en este orden:

1. **Puerta.** `status === "FAIL"` → `err("PROPOSAL_NOT_RECONCILED")`. Run `IMPORTED` → el mismo error. Run **`partial` de `kind = LLM`** → `err("PARTIAL_RUN_CANNOT_POST")` (O-20.3).
2. **Plantilla.** Ejercicio del documento cerrado → **T-22**. Si no, `opts.templateCode` compatible, o `TEMPLATE_FOR_DOC[docKind]`; `null` → `err("TEMPLATE_UNRESOLVED")`.
3. **Bloques de pasivo** (O-3). Se agrupan las líneas por clave de pasivo y se emite **una línea de pasivo por bloque**, con **su base más su cuota**. El céntimo huérfano del reparto va al bloque de mayor importe (criterio Hamilton de I5). El input de la plantilla lo recibe como `payableBlocks[]`.
4. **Cuotas** (ADR-0014 D3). Se pasan como `taxOverrides[]` con la **cuota del documento**; la plantilla las usa tal cual y `checkDraft` comprueba `|override − recalculada| ≤ 1 c` por tipo. **Sin línea de redondeo de IVA.**
5. **Retención** (O-11). Del `Counterparty`: `withholdingRateCode` y la clave de cuenta derivada del `TaxKind`/subtipo (`IRPF_PROFESIONALES_A_PAGAR` → modelo 111, `IRPF_ALQUILERES_A_PAGAR` → modelo 115). **Base de la retención sin suplidos ni no sujetos** (O-12).
6. **Rectificativas** (O-5). `mode = DIFERENCIAS` → se contabiliza lo leído. `mode = SUSTITUCION` → se contabiliza **la diferencia** contra `ctx.rectifiedEntry`, línea a línea y tipo a tipo. `reason` decide la cuenta (708 / 706 / 709 / la de ingreso).
7. **Divisa** (O-8). Conversión con el reparto de D2 (residuo cero por Hamilton); cada línea monetaria sale con `originalCurrency`, `originalAmountCents` y `exchangeRateId`, y el asiento con `hashVersion = 3`.
8. **Construcción.** `buildFromTemplate(code, input, ctx)`, que aplica C-1…C-13 y `checkDraft`. E8 **no reimplementa nada** del motor de E3.
9. **Sellado.** `fileId`, `extractionRunId`, `templateCode`, `templateVersion`, `receptionDate`, `operationDate`, `sourceType = INVOICE_IN` (compras del flujo documental) o `INVOICE_OUT` (ventas).

`selectTemplate()`, `resolvePayableBlocks()` y el mapeo se exponen por separado para testearlos sin `LedgerContext`; `previewFromProposal()` es el mismo camino sin persistir (I-E8-8).

**Cambios acotados en el motor de E3** (Nivel 2, ADR-0014 D3/D6/D9; los tres retrocompatibles, con los fixtures intactos porque sin los campos nuevos el comportamiento es idéntico):

| Cambio | Dónde | Por qué |
|---|---|---|
| `taxOverrides?: {taxRateCode, quotaCents}[]` | `facturaEmitidaSchema`, `facturaRecibidaSchema`, ISP y abonos | Contabilizar la cuota del documento (O-2) |
| `payableBlocks?: {payableKey, amountCents}[]`, y `payableKey` amplía a `PROVEEDORES_INMOVILIZADO`, `BANCO_DEFAULT`, `CAJA`, `REMUNERACIONES_PENDIENTES` | `facturaRecibidaSchema` | Documentos mixtos (O-3), tickets (O-1), notas de gasto (O-13) |
| `selectRate(..., operationDate ?? accrualDate ?? documentDate, side)` | `lib/ledger/tax.ts` y **C-10 de E3** | Tipo por devengo (O-14). **Se aplica a E3 y E8 en la misma tarea**; los fixtures no cambian porque en ellos las tres fechas coinciden |

### 3.5 `lib/fx/`

```ts
// lib/fx/convert.ts — PURO
export function convertProposal(p: ExtractionProposal, rate: RateRef, baseCurrency: string): ExtractionProposal
export function convertCents(cents: Cents, rateMicro: bigint): Cents
```
Reparto de ADR-0014 D2: `payable_EUR = convert(total)`, `base_i_EUR = convert(base_i)`, y las cuotas absorben la diferencia repartida **por mayor resto (Hamilton)**. **Residuo cero por construcción**, sin línea de ajuste, y las bases siguen correspondiendo a líneas del documento. Si alguna vez procediera reconocer un residuo de conversión, su cuenta sería 668/768, jamás 669/769.

```ts
// lib/fx/rates.ts — IO
export async function getOrFetchRate(date: LocalDate, from: string, to: string): Promise<RateHit>
// 1. `exchange_rates` por (date, from, to, 'ECB_FRANKFURTER') → si existe, devuelve
// 2. si no, serie de Frankfurter hasta `date` y última publicada ≤ date
// 3. persiste con su `date` REAL (puede ser anterior) y devuelve {id, rateMicro, rateDate, source}
// 4. si la fuente no responde, LANZA. Sin fallback a otra fuente (ADR-0014 D2)
```
Se eliminan `app/api/currency/route.ts` y `components/agents/currency-converter.tsx`. La UI muestra lo que devolvió el servidor con su `rateDate`, su fuente y su badge. **Matiz declarado y no unificado:** la base imponible en euros de una AIB o de una importación se determina con el tipo del **art. 79.Once LIVA**, que puede diferir en céntimos del contable; WARN informativo.

---

## 4. Capa de aplicación

### 4.1 `ai/` reescrito

| Fichero | Después |
|---|---|
| `ai/analyze.ts` | `runExtraction(db, org, file, actor, opts) → ExtractionRun`. Verifica `sha256` en disco, construye adjuntos, resuelve prompt y schema, llama al proveedor, valida la salida con zod **estricto** (G-17), normaliza, corre `reconcile`, inserta el run |
| `ai/prompt.ts` | `resolvePrompt(db, org, code) → {content, sha, source, versionId}` |
| `ai/schema.ts` | `ai/schemas/extraction.v1.json` en git **sin** `accountCode`/`projectId`/`costCenterId`/`deductibility`/`withholding`/`receptionDate` (O-10, O-11, D4, D8) + `Field` personalizados no económicos |
| `ai/attachments.ts` | Devuelve `{attachments, pagesSent, pagesTotal}`; el límite en `Setting("llm_max_pages")`, default 4, **registrado** |
| `ai/providers/llmProvider.ts` | `attempts[]` con proveedor, modelo, resultado y ms de cada intento (G-09); `usage_metadata` para tokens (G-12); validación zod de **toda** salida, `openai_compatible` incluida (G-17) |

### 4.2 Modelos (IO, tenant) — no calculan nada

`models/extraction.ts`: `createExtractionRun`, `createRevisionRun`, `getExtractionRun`, `listRunsForFile`, **`listInboxWithLatestRun`** (`DISTINCT ON (file_id) … ORDER BY file_id, created_at DESC`, sin N+1), `countPendingByStatus`.
`models/fx.ts`: `getOrFetchRate`, `listRatesForPeriod`. `models/prompts.ts`: `listPromptVersions`, `createPromptVersion` (append-only), `setActivePromptVersion` (`Setting` + `AuditLog`). `models/invoice-series.ts`: `nextInvoiceNumber` con `FOR UPDATE`, **por `kind`** (O-18). `models/counterparties.ts`: alta y edición del régimen, `checkVies` (IO, persiste fecha y resultado).

### 4.3 Server actions (`app/(app)/unsorted/actions.ts`, reescrito)

| Acción | Rol | Notas |
|---|---|---|
| `analyzeFileAction(fileId)` / `analyzeBatchAction` | **EDITOR** | Consume saldo, escribe un run, rate limit por organización; devuelve `runId` y el progreso va por SSE |
| `previewProposalAction(runId, overrides)` | **VIEWER** | `reconcile` + `previewFromProposal`. No persiste |
| `confirmProposalAction(runId, proposal, opts)` | **EDITOR** | Run de revisión si hubo ediciones (D5), tasa, conversión, segundo `reconcile`, `postFromProposal`, `postEntryTx`, `Transaction → POSTED`. Una transacción corta, con `idempotencyKey` |
| `confirmBatchAction(runIds)` | **EDITOR** | Sólo `PASS`, no `partial`, sin ningún check con `blocksBatch` activo. **Una transacción por documento** |
| `splitProposalAction(runId, groups)` | **EDITOR** | N propuestas y **N `Transaction`** sobre el mismo `fileId`, enlazadas por `splitParentTransactionId` (O-9.iii) |
| `revoidAndRedoAction(transactionId)` | **EDITOR** | `VOID → PROPOSED` (O-9): traslada el asiento a `voidedEntryIds` y reabre la propuesta sin volver a subir el fichero |
| `forceOverrideAction(runId, field, value, reason)` | **EDITOR** | Motivo ≥ 10 caracteres, campo a `no_verificado`, `AuditLog` |
| `markSimplifiedQualifiedAction(runId, reason)` | **EDITOR** | O-1: pasar un ticket a `FULL` es un acto explícito y auditado |
| `setActivePromptAction`, `createPromptVersionAction`, `setInvoiceSeriesAction`, `setCounterpartyRegimeAction` | **ADMIN** | `AuditLog` con `before`/`after` |
| `emitInvoiceAction(input)` (`apps/invoices`) | **EDITOR** | Recalcula `qty × unitPrice` y cuotas **en servidor** (G-21), número de la serie **por tipo**, PDF como `File` con `sha256`, run `MANUAL/formulario`, postea T-01 o T-02 |

`AuditEntity += "ExtractionRun", "PromptVersion", "InvoiceSeries", "Counterparty"`; `AuditAction += "EXTRACT", "CONFIRM_PROPOSAL", "FORCE_FIELD", "FORCE_DUPLICATE", "MARK_SIMPLIFIED_QUALIFIED", "REVOID_AND_REDO", "SET_PROMPT_VERSION", "SET_REGIME", "EMIT_INVOICE"`.

Todas empiezan por `requireOrg(minRole)` y usan `tenantDb`/`tenantTransaction`. Validación en `forms/extraction.ts` (zod **estricto**, sin `.catchall`). `forms/transactions.ts` sustituye `parseFloat(val) * 100` por `parseCents()` (G-07).

---

## 5. Invariantes

### 5.1 Los de la épica (I-E8-1…20, con I-E8-15 en tres ramas)

| ID | Enunciado | Tol. | Dónde |
|---|---|---|---|
| **I-E8-1** | Todo `JournalEntry` con `extraction_run_id` referencia un run con `reconcile_status ∈ {PASS, WARN}`; nunca `FAIL`, `NULL`, `IMPORTED`, **ni `partial` de `kind = LLM`** (O-20.3) | 0 | SQL |
| **I-E8-2** | `sha256` en disco = `files.sha256` = `extraction_runs.file_sha256` para todo run con asiento | 0 | script + SQL |
| **I-E8-3** | `extraction_runs` y `prompt_versions` inmutables: `UPDATE`/`DELETE` como `app_runtime` → 42501 | 0 | SQL |
| **I-E8-4** | *(reformulado, O-19)* `POSTED ⟺ journal_entry_id IS NOT NULL`; `VOID ⟺ journal_entry_id IS NULL AND voided_entry_id IS NOT NULL`; cada `Transaction` tiene **como máximo un** asiento vivo; las N de un split apuntan al mismo `File` y a asientos distintos | 0 | SQL |
| **I-E8-5** | `convertedTotal = convertWithRateMicro(total, exchange_rate_micro)` con la tasa persistida y existente en `exchange_rates`. Desviación ⇒ motivo obligatorio y `no_verificado` | 0 | SQL + puro |
| **I-E8-6** | `canonicalJson(reconcile(p, ctx))` idéntico byte a byte entre ejecuciones y procesos | 0 | puro |
| **I-E8-7a** | *(reformulado, O-19)* Identidad de lo **contabilizado**: `Σ bases + Σ cuotas + Σ recargos + Σ suplidos y no sujetos − retención − anticipo = total`, y `Σ debe = Σ haber`. **Se cumple por construcción** con la cuota del documento | **0** | puro + SQL |
| **I-E8-7b** | *(métrica, no invariante)* Número y magnitud de discrepancias entre cuota del documento y recálculo, por tipo y por proveedor | — | WARN de Auditoría |
| **I-E8-8** | `postFromProposal(run.reconcile, ctx, …)` reproduce el `EntryDraft` del asiento **línea a línea y céntimo a céntimo** | 0 | puro + integración |
| **I-E8-9** | Ningún `File` con `sha256 IS NULL` tiene run `LLM` ni asiento | 0 | SQL |
| **I-E8-10** | `partial = true` ⇒ ningún campo `calculado` ni `verificado`, no aparece en el lote y no respalda ningún asiento | 0 | puro + SQL |
| **I-E8-11** | `prompt_sha` del run = sha del contenido efectivo (git o `PromptVersion`); la versión seleccionada existe | 0 | integración |
| **I-E8-12** | Tenant: ningún run, prompt, serie o contraparte visible desde otra organización; ningún asiento referencia un run de otra | 0 | `test:integration:rls` |
| **I-E8-13** | *(extendido, O-19)* Duplicado por `sha256` **o** por `(counterparty.taxId, documentNumber, ejercicio)` en compras ⇒ exige `AuditLog` con `FORCE_DUPLICATE` y motivo. Es el vector clásico de doble pago y doble deducción | 0 | SQL |
| **I-E8-14** | `exchange_rates` append-only, una fila por `(date, from, to, source)`, `rate_micro > 0`; toda transacción en moneda ≠ base con sus tres columnas de tasa | 0 | SQL |
| **I-E8-15a** | **Puente al 303, soportado deducible** (O-24): `Σ 472` del **periodo de IVA** (`max(receptionDate, documentDate)`) = Σ cuota **deducible** del libro registro de recibidas | **0** | SQL |
| **I-E8-15b** | **Puente al 303, soportado total** (O-24): Σ cuota **total** del libro registro = `Σ 472` **+** Σ IVA **no deducible incorporado al coste**. Es el único control que detecta que una cuota no deducible se «perdió» en vez de engordar el gasto o el inmovilizado | **0** | SQL |
| **I-E8-15c** | **Puente al 303, repercutido** (O-24): `Σ 477` del periodo de IVA = Σ cuota repercutida del libro registro de emitidas | **0** | SQL |
| **I-E8-16** | Ningún asiento con línea de 472 cuya fecha de deducción diste más de cuatro años de `documentDate` (art. 99.Cinco) | 0 | SQL |
| **I-E8-17** | **Puente al 111/115** (nuevo): Σ retenciones practicadas del trimestre = Σ abonos a 4751 por `taxRateId`, agrupado por modelo | **0** | SQL |
| **I-E8-18** | Toda factura con `docKind` ISP tiene **exactamente dos** líneas de IVA del mismo `taxRateId` y el **devengado es íntegro** (la prorrata sólo minora el deducible) | 0 | puro + SQL |
| **I-E8-19** | Toda `Transaction` en moneda ≠ base tiene sus tres columnas de tasa **y** sus líneas monetarias llevan `originalCurrency`/`originalAmountCents`/`exchangeRateId` | 0 | SQL |
| **I-E8-20** | **Series** (O-18): numeración sin huecos y fecha no decreciente dentro de cada serie; ninguna factura emitida borrada o renumerada | 0 | SQL |

### 5.2 Invariantes existentes que E8 puede romper

- **I1 (Σdebe = Σhaber).** Con la cuota del documento y el reparto Hamilton de la conversión, el asiento cuadra **por construcción**; el trigger diferido de E3 sigue siendo la última barrera y no se relaja.
- **I-E3-7 (`entryHash`).** `hashVersion = 3` obliga a **despachar por versión** al verificar. Las filas v2 se verifican con v2 y los fixtures no cambian.
- **I8 (fechas).** Cuatro fechas y un desvío a T-22 por ejercicio cerrado: RC-05 y el paso 2 de `postFromProposal` lo resuelven **antes** de confirmar, para que el error se vea en el formulario y no en el `INSERT`.
- **I9 (cuenta activa y postable).** RC-07 y la FK compuesta de E2.
- **I4 (Σ matriz = PyG).** Una línea 6/7 sin destino se rutea a `CC-NA` con WARN: no rompe I4 pero degrada la analítica.
- **I-E6-18 (caché de informes).** Contabilizar cambia el `ledgerHash` del periodo; el informe cacheado deja de servirse solo. El `ledgerHash` **no** cambia por `hashVersion = 3`.

### 5.3 Lugar en el sello

Los invariantes SQL (**I-E8-1, 3, 4, 9, 12, 13, 14, 15, 16, 17, 19, 20**) se cablean en `runLedgerInvariants` y en `scripts/run-invariants.ts`, y viajan en `validacion.json`; un FAIL sella `REQUIERE REVISIÓN` con `INVARIANTE_FAIL`. **Motivos de sello nuevos**, códigos cerrados (ADR-0014 D7): `PROPUESTA_NO_RECONCILIADA`, `DOCUMENTO_ALTERADO`, `TASA_FORZADA`, `RETENCION_NO_PRACTICADA`, `IVA_PERIODO_DESPLAZADO`, `REGIMEN_NO_SOPORTADO`.

**WARN de calidad de datos** que E8 aporta y E7 pinta: documentos sin asiento · runs FAIL sin resolver · extracciones parciales · ficheros sin `sha256` · duplicados forzados · deducibilidad pendiente de decisión · **I-E8-7b** (discrepancias de cuota por proveedor) · tickets marcados como cualificados · retenciones no practicadas · contrapartes sin régimen configurado.

Tests: `lib/extraction/reconcile.test.ts` y `lib/ledger/postFromProposal.test.ts` byte a byte contra **`docs/design/fixtures/extraccion-esperada.json`**, que sella **quince** casos —los trece de §5 del experto más los **dos** que la re-validación exige para probar O-23 y O-25 (§R2.3)—: factura simple · dos tipos con desviación de 1 c en cada uno · ticket no cualificado con IVA incluido · ticket cualificado · mixta inmovilizado + servicio · rectificativa por diferencias · **rectificativa por sustitución** · profesional sin mención de retención · **factura con suplido** · importación de tercer país · AIB con ISP · factura en USD · extracción parcial · **factura de anticipo de cliente sin cobro registrado (asiento sin 477)** · **factura de proveedor de tercer país con identificador fiscal sin checksum**. Más `tests/integration/e8-extraction.test.ts` y `tests/integration-rls/e8-tenant.test.ts`.

---

## 6. UI

| Ruta | Contenido |
|---|---|
| `/unsorted` | Bandeja: por fichero, miniatura, estado del último run (sin analizar · PASS · WARN · FAIL · parcial · importado sin origen) y contador de runs. Filtros por estado. «Analizar» y «Analizar todo» con la cola heredada. Selección múltiple → «Confirmar por lote», habilitado sólo con todos en PASS y sin ningún check `blocksBatch` |
| `/unsorted/[fileId]` | **Izquierda**: visor con la página y el recuadro del campo activo. **Derecha**: selector de `ExtractionRun` (fecha, modelo, proveedor, `promptSha` corto, «4 de 9 páginas», estado) y formulario con **chip de origen y badge de confianza por campo**, ahora con **cuatro niveles**: `calculado` gris · **`✓ verificado` negro** · `interpretación IA` hielo cursiva · `no verificado` borde discontinuo |
| | **Bloque de fechas** con las cuatro explicadas en una línea cada una: expedición (selecciona el tipo si no hay devengo) · devengo · **recepción (decide el trimestre de IVA)** · contable. Sin la explicación, cuatro fechas son tres de más |
| | **Panel «Comprobaciones»** con los RC-* en PASS/WARN/FAIL, su mensaje en español contable, su evidencia y una marca clara de cuáles **bloquean el lote** sin ser FAIL |
| | **Panel «Asiento propuesto»**: tabla Debe/Haber, fila de cuadre, plantilla elegida entre las compatibles, y **los bloques de pasivo desglosados** cuando el documento es mixto (523 y 410 en líneas separadas, con su base y su cuota) |
| | Avisos específicos: **ticket** («IVA no deducible: factura simplificada. Si lleva su NIF y la cuota desglosada, márquela como cualificada» con el enlace al acto auditado) · **retención** («esta factura debería llevar retención del 15 %; solicite factura rectificada») · **rectificativa por sustitución** («se contabiliza la diferencia contra la factura X: 20 000,00 €») · **ISP** con las cuatro precondiciones y cuáles faltan · **importación** («el IVA lo liquida el DUA; esta factura va sin cuota») · **régimen no soportado** (RECC) con remisión a E9 |
| | Botón **«Confirmar asiento»** (EDITOR), deshabilitado con FAIL **y el motivo escrito debajo**. Con algún campo `no verificado`, exige motivo |
| | **Banner de extracción parcial**: «El modelo vio 4 de 9 páginas. Este documento no puede contabilizarse desde la extracción automática: revise y teclee las cifras, y se registrará como revisión humana» |
| `/unsorted/batch` | Candidatos con propuesta resumida, cuadre y plantilla; progreso incremental por documento; no elegibles listados aparte **con el porqué** |
| `/transactions` | Columnas **Estado** (con la leyenda de que `PROPOSED` no es contable) y **Asiento**; acción «Anular y rehacer» en las `VOID` |
| `/settings/prompts` | Prompt base de git (sólo lectura, con su sha), versiones de la organización, alta, selección y diff. ADMIN |
| `/settings/counterparties` | Régimen de retención, país, NIF-IVA con su **fecha de comprobación en VIES**, recargo de equivalencia, marca de empleado. ADMIN |
| `/settings/invoicing` | Series por tipo (ordinaria / rectificativa / simplificada), con el aviso de que una factura emitida no se borra ni se renumera |
| `/settings/currencies` | Moneda base y tasas usadas por periodo con fecha efectiva y fuente (sólo lectura) |
| `/settings/organization` | `ivaRegime`, `roiRegistered`, tolerancia de redondeo de tesorería (con su techo de 5 c visible). ADMIN |

**Drill-down en ≤ 3 clics:** celda → *(1)* detalle de líneas → *(2)* asiento → *(3)* pestaña **Documento** con visor, `ExtractionRun` y `sha256`.

**`VIEWER`** ve bandeja, runs, checks y previsualización —es información de auditoría— y ni un botón de mutación. **`EDITOR`** hace todo salvo prompts, series, contrapartes y régimen. **`ADMIN`**, todo. Estados vacío / carga / error en las tres pantallas.

---

## 7. Trazabilidad

**Provenance por celda:**

```json
{"campo": "taxes[0].quotaCents", "valor": 21001, "moneda": "EUR",
 "origen": "llm", "confianza": "interpretación IA", "reconcile_check": "RC-02",
 "recalculado": 21000, "desviacion_cents": 1, "tolerancia_cents": 1,
 "extraction_run_id": "…", "parent_run_id": "…", "file_id": "…", "file_sha256": "…",
 "prompt_sha": "…", "schema_version": "v1", "proveedor": "openai", "modelo": "gpt-4o-mini",
 "paginas": "4/9", "pagina": 2, "bbox": [0.12, 0.44, 0.31, 0.47], "raw_text": "210,01 €",
 "calculado_por": "lib/extraction/reconcile.ts@<gitSha>",
 "registros_origen": "SELECT * FROM extraction_runs WHERE id = $1"}
```

Vive en `ExtractionRun.fieldOrigins` del run que produjo el asiento —el de revisión, si lo hubo—, **nunca en `journal_lines`**. La cadena es `journal_lines → journal_entries.extraction_run_id → extraction_runs.parent_run_id → extraction_runs (LLM) → files.sha256 → bytes`, con FK real en cada eslabón.

**Del asiento:** `fileId`, `extractionRunId`, `templateCode`, `templateVersion`, las **cuatro fechas** más `operationDate`, `taxRoundingMode`, y en la línea la divisa original con su `exchangeRateId`. **De la conversión:** `rateMicro`, `rateDate` efectiva, `rateSource` y el motivo si se forzó. **De la calificación fiscal:** el régimen de `Counterparty` vigente al confirmar y la fecha de la consulta a VIES, copiados a `fieldOrigins` para que la decisión sea reconstruible aunque la ficha cambie después.

`AuditLog` con `before`/`after` en la misma transacción para: prompts y versión vigente, tolerancia, régimen de contraparte y de organización, forzados de campo y de duplicado, marca de ticket cualificado, anular-y-rehacer y series.

---

## 8. Herencia de TaxHacker: qué se conserva y cómo se adapta

| Funcionalidad | Veredicto | Detalle |
|---|---|---|
| **Split de items** | **Se adapta** (G-03, O-9.iii) | Deja de clonar el binario y de sembrar cifras. Los items son `proposal.lines[]`; dividir crea **N propuestas y N `Transaction`** sobre el mismo `fileId`. `items-detect.tsx` se conserva como visor y deja de multiplicar por 100 en el cliente |
| **Categorías** | **Intactas, ampliadas** | Etiquetas de gestión que conviven con el plan. Ganan `defaultAccountCode` (origen `catalogo`, prohibido el subgrupo 64) y `defaultDeductibility` (O-17) |
| **Campos personalizados** | **Intactos, con límite** | Siguen alimentando `Transaction.extra`; **no pueden aportar campos económicos ni fiscales** (O-10) |
| **Prompts personalizados** | **Conservados, versionados** | `PromptVersion` append-only + selección en `Setting`, con diff y `promptSha` en cada run |
| **Cola de análisis** | **Intacta** | `lib/analyze-queue.ts` con su concurrencia y su reintento 429; E8 añade la cola de servidor y el SSE |
| **Multi-moneda** | **Se adapta** (G-04, G-18, O-8) | Fuente única, tasa del `documentDate`, cálculo en servidor, `rateDate` visible, y **divisa original en la línea** |
| **Import/export CSV** | **Conservado, corregido** | `parseCents()` único (G-07); tenant obligatorio en catálogos (G-08) |
| **Email-sync IMAP** | **Conservado, corregido** | Watermark y `FOR UPDATE` como están; dedupe por `sha256` + `messageId` (G-22) |
| **Facturas (`apps/invoices`)** | **Conservado, ampliado** | Recálculo en servidor (G-21), **series por tipo** con numeración sin huecos (O-18), emisión → T-01/T-02 |
| **Duplicados** | **Conservado, mejor clave** | El modal se queda; clave primaria `sha256` (G-11) **más** `(taxId, nº documento, ejercicio)` (O-19); moneda por defecto de la organización, no `"USD"` (G-19) |
| **Backups / restore** | **Declarado** | Los modelos nuevos entran en el inventario; el dump transaccional con manifest (G-15) es **E11** |
| **Previews** | **Intactos** | Se les pide además `pagesTotal` para registrar la parcialidad |

**Gaps cerrados:** G-01, G-02, G-03, G-04, G-07, G-08, G-09, G-10, G-11, G-12, G-13, G-16, G-17, G-18, G-19, G-21, G-22. **Parcial:** G-14 (extractor / calculador / auditor separados; segundo LLM en E12). **Fuera:** G-15 → E11.

---

## 9. Rendimiento

- **La UI nunca espera al LLM**: encolar y devolver `runId`; estado por `Progress` + SSE. Concurrencia por `Setting("llm_max_concurrency")` y rate limit de `lib/rate-limit.ts`.
- **Bandeja sin N+1**: una consulta `DISTINCT ON (file_id) … ORDER BY file_id, created_at DESC` con `LIMIT/OFFSET` más un `COUNT` agregado. **< 150 ms** con 2 000 ficheros y 6 000 runs, medido en el test de rendimiento.
- **Cota de 256 KB por run** entre `raw_output` y `proposal` (CHECK en la base).
- **Transacciones cortas**: una por documento. La numeración toma `FOR UPDATE` sobre `fiscal_years`, así que una transacción larga serializaría toda la organización. El cálculo puro ocurre **fuera** de la transacción.
- **FX y VIES sin ráfagas**: `getOrFetchRate` mira la tabla por su índice único y memoiza por petición (50 facturas del mismo día = **una** llamada); la consulta a VIES se cachea en `Counterparty` con su fecha y sólo se repite cuando caduca.
- **Índices nuevos**: `extraction_runs (organization_id, file_id, created_at DESC)` y `(organization_id, reconcile_status)`; `files (organization_id, sha256)`; `exchange_rates (from, to, date DESC)`; `journal_entries (organization_id, reception_date)` para los puentes al 303 (I-E8-15a/b/c).
- **El `sha256` se calcula una vez**, al ingerir, sobre el buffer en memoria; la verificación relee el fichero **una vez por run**.

---

## 10. Seguridad

- **Uploads:** `assertAcceptableUpload` heredado (lista blanca, sniff del contenido, mimetype del contenido, 25 MB) + `sha256` al ingerir y verificación antes de cada análisis y confirmación.
- **La salida del LLM es dato hostil:** zod **estricto** antes de tocar nada, `openai_compatible` incluido (G-17); nunca interpolada en SQL —todo por `Prisma.sql`— ni renderizada como HTML.
- **Inyección de prompt:** el documento es dato, no instrucción, y así lo dice el prompt base. La defensa real es que el modelo **no puede escribir un céntimo ni una calificación fiscal**: cifras por `reconcile`, cuenta y dimensiones por catálogo o usuario, retención e ISP por `Counterparty` y `Organization`. Un PDF que diga «contabiliza 1 €» produce, como mucho, una propuesta que falla.
- **Secretos de proveedor:** cifrado AES-GCM de `lib/encryption.ts` sobre `Setting`, sin cambios. El run guarda proveedor y modelo, jamás la clave; `attempts[]` guarda códigos de error, no cuerpos de respuesta.
- **Saldo de IA:** se decrementa **por run creado**, no `si tokensUsed > 0`, y sólo tras un `INSERT` con éxito (G-12).
- **RLS:** `extraction_runs`, `prompt_versions`, `invoice_series` con `enforce_tenant_rls` + `FORCE`; las dos primeras append-only. `exchange_rates` con RLS de referencia global. Todos en la suite `test:integration:rls`.
- **Roles:** `VIEWER` no analiza ni confirma; `EDITOR` no toca prompts, series, contrapartes ni régimen; sólo `ADMIN` cambia tolerancia, prompts, series, régimen y proveedores. Todo con `AuditLog`.
- **Sin SQL interpolado** en ninguna consulta nueva, invariantes y bandeja incluidos.

---

## 11. Decisiones de Nivel 2 y ADR

**ADR-0005 (APROBADO) cubre** —y este diseño no se aparta de él en ningún punto— `ExtractionRun` inmutable, `reconcile()`, confirmación EDITOR, eliminación de `cachedParseResult`, conversión en servidor con `ExchangeRate` de fuente BCE, `convertedTotal` no editable sin motivo, prompts versionados y el descarte del auto-contabilizado.

**ADR-0014 (APROBADO el 2026-09-06, ronda 2)** decide lo que aquel no: `Transaction.status` con `CHECK` correcto y salida de `VOID` (**D1**), tasa del `documentDate` **y divisa en la línea** con `hashVersion = 3` (**D2**), **la cuota del documento** con tolerancias separadas y 669/769 reservado a tesorería (**D3**), quién fija la deducibilidad con el tercer valor `REQUIERE_DECISION` (**D4**), la revisión como run nuevo y el veto al run parcial (**D5**), **523 siempre en el alta** con reparto en mixtos (**D6**), `exchange_rates` global y los motivos de sello (**D7**), la **fecha de recepción** y el periodo de IVA (**D8**), tickets (**D9**), suplidos y descuentos (**D10**), la calificación fiscal decidida por la organización —ISP, retención, régimen— (**D11**) las rectificativas con causa y modo (**D12**), el devengo del IVA del anticipo de cliente **al cobro** (**D13**, RC-25) y el puente al 303 partido en tres (**D14**, I-E8-15a/b/c).

**Cuestiones cerradas por el experto** en `docs/design/E8-validacion-documentos.md`: (a) mapeo `docKind → plantilla`, `payableKey` por línea y la tabla 607/600/621/623/628; (b) residuo con varios tipos; (c) 523 vs 173; (d) terceros países e intracomunitario. La re-validación (§R2.3) cierra la revisión con **CONFORME CON OBSERVACIONES** y **desbloquea T9**, dejando **tres residuos menores ya incorporados a este diseño** —**O-23** (RC-25: el IVA del anticipo de cliente devenga al cobro), **O-24** (I-E8-15 en 15a/15b/15c) y **O-25** (RC-11 con tres ramas por país)—, que se implementan dentro de **T7** y **T14** y verifica el `qa-tester` contra el fixture, **sin tercera ronda de validación**. Quedan anotadas como afinado de la siembra, no como decisión pendiente: la tabla exacta de categorías con `defaultDeductibility = REQUIERE_DECISION`, el enum `ProposalTax.operationKey` frente a las claves del libro registro y del 349, y el recargo de equivalencia **como destinatario**.

---

## 12. Criterios de aceptación y plan de tareas

### 12.1 Criterios (Given / When / Then)

1. **Ninguna cifra del LLM llega al diario.** Líneas de 1 000,00 € al 21 % y `total` del modelo de 999,00 € ⇒ RC-03 **FAIL**, botón deshabilitado con motivo, **cero asientos**.
2. **Σ bases con tolerancia 0.** Tres líneas de 333,33 € y base declarada de 1 000,00 € ⇒ RC-01 **FAIL** nombrando el céntimo exacto.
3. **La cuota contabilizada es la del documento (O-2).** Base 100 000, cuota declarada **21 001** ⇒ el asiento lleva `472` = **21 001**, RC-02 **WARN**, el campo queda `interpretacion_ia`, **no existe línea en 669**, y `Σ debe = Σ haber`. Con cuota declarada 21 005 ⇒ **FAIL** y sin asiento.
4. **Varios tipos, emisor que redondeó sobre el total.** Bases 100 000 @ 21 % y 50 000 @ 10 %, cuotas declaradas 21 001 y 4 999, total 176 000 ⇒ identidad interna PASS con tolerancia 0; asiento con **dos líneas de 472** (21 001 y 4 999, cada una con su `taxRateId`); **dos WARN**; ninguna línea de ajuste. El test **falla si el motor compensa 21 000 + 5 000 y no emite los WARN**.
5. **Ticket no cualificado (O-1).** Ticket de 12,34 € al 10 % pagado con tarjeta ⇒ `629` **1 234** D contra `572` **1 234** H; **sin línea de 472**, **sin 410**; `base` y `cuota` de RC-17 marcadas `calculado` y `base + cuota = total` exacto. Marcado como cualificado por un EDITOR ⇒ `629` 1 122 · `472` 112 · `572` 1 234, con `AuditLog`.
6. **Documento mixto (O-3).** Equipo 1 000 000 + mantenimiento 200 000, IVA 252 000 ⇒ `217` 1 000 000 D · `629` 200 000 D · `472` 252 000 D · **`523` 1 210 000 H** · **`410` 242 000 H**. El test falla si los 1 452 000 van enteros a 523.
7. **523 siempre en el alta.** Factura de 2026-11-15 con vencimiento 2027-11-30 ⇒ **523**, no 173; y la Auditoría la lista como candidata a reclasificación en el cierre.
8. **Importación ≠ ISP (O-4).** Factura de proveedor de tercer país sin cuota y sin mención legal ⇒ `docKind = FACTURA_RECIBIDA_EXTRACOM`, base contra 400/523, **sin 472 ni 477**. Con las cuatro precondiciones de AIB ⇒ T-04 con **dos líneas del mismo `taxRateId`** y devengado íntegro (I-E8-18). Sin alguna precondición ⇒ `DESCONOCIDO` + WARN.
9. **Rectificativa por sustitución (O-5).** Original 100 000 + 21 000, rectificativa que fija 80 000 + 16 800 ⇒ `708` **20 000** D · `477` **4 200** D · `430` **24 200** H. El test falla si contabiliza 80 000. Abono con total negativo ⇒ normalizado a `ABONO_*` con absolutos.
10. **Fecha de recepción (O-6).** Factura de 2026-03-28 recibida el 2026-05-04 ⇒ el gasto se devenga en marzo y el **periodo de IVA es el 2T**; I-E8-15a cuadra el 472 del 2T con la cuota deducible del libro registro. Documento de hace cinco años ⇒ RC-18, deducibilidad `NONE` y cuota como mayor coste.
11. **Retención por régimen (O-11).** Factura de abogado de 100 000 + 21 000 sin mención de retención, contraparte profesional al 15 % ⇒ `623` 100 000 D · `472` 21 000 D · `410` **106 000** H · `4751` **15 000** H, con WARN, sello `RETENCION_NO_PRACTICADA` y bloqueo del lote.
12. **Suplidos (O-12).** Honorarios 100 000 + IVA 21 000 + suplido 30 000, retención 15 % **sobre 100 000** ⇒ `623` 100 000 · `631` 30 000 · `472` 21 000 · `410` 136 000 H · `4751` 15 000 H. El test falla si la retención sale 19 500 o si RC-03 da FAIL.
13. **La cuenta no la elige el modelo (O-10).** El schema enviado al proveedor **no contiene** `accountCode`, `projectId`, `costCenterId`, `deductibility`, `withholding` ni `receptionDate` (test sobre el JSON de git); una cuenta que viene del catálogo tiene confianza `interpretacion_ia`, **nunca `calculado`**.
14. **Nóminas y notas de gasto (O-13).** `docKind ∈ {NOMINA, RECIBO_SS, EXTRACTO_BANCARIO}` ⇒ plantilla `null` y mensaje explícito; nota de gasto ⇒ contrapartida 465 o tesorería, **nunca 400/410**; `Category.defaultAccountCode` del subgrupo 64 rechazado por CHECK.
15. **Tipo por devengo (O-14).** Documento expedido el 2026-01-10 con devengo el 2025-12-28 y cambio de tipo el 2026-01-01 ⇒ se aplica el tipo **de 2025**; los fixtures de E3 siguen byte a byte idénticos.
16. **Tolerancias separadas (O-16).** `TOLERANCIA_CUOTA_IVA_CENTS` no es configurable (test que falla si aparece en `Setting`); `redondeoToleranciaCents = 7` es rechazado por el CHECK; el ajuste de tesorería de T-08/T-09 a 669/769 sigue funcionando igual.
17. **Deducibilidad `REQUIERE_DECISION` (O-17).** Factura de restaurante ⇒ el campo nace `no verificado`, RC-15 **bloquea el lote**, y confirmar individualmente exige decisión y motivo.
18. **Series (O-18).** Un abono emitido toma número de la serie **RECTIFICATIVA**; un hueco en la numeración se detecta por I-E8-20 y se lista en Auditoría; borrar una factura emitida es imposible.
19. **Divisa en la línea (O-8).** Factura de 10 000,00 USD a 2026-11-20 con tasa 1,08 ⇒ `400` por 925 926 c con `originalCurrency = "USD"`, `originalAmountCents = 1 000 000` y `exchangeRateId`; el asiento lleva `hashVersion = 3`; **el `ledgerHash` del periodo no cambia respecto de un asiento equivalente en EUR**; confirmar un mes después da el mismo `convertedTotal`; el reparto Hamilton deja **residuo cero** y **ninguna línea de ajuste**.
20. **Sin tasa no se inventa nada.** Frankfurter caído ⇒ la confirmación falla con mensaje legible; no se usa otra fuente ni otro día que no sea la última publicada; no se guarda nada a medias.
21. **`VOID → PROPOSED → POSTED` (O-9).** Anular deja la operación en `VOID` con `journalEntryId` trasladado a `voidedEntryIds`; «Anular y rehacer» la devuelve a `PROPOSED` **sin volver a subir el fichero** y sin disparar RC-12; el `CHECK` rechaza una fila `VOID` sin `voided_entry_id`; `POSTED → DRAFT` lanza.
22. **Split N-a-1.** Dividir en tres crea **tres `Transaction`** sobre el mismo `fileId` y el mismo `sha256`, con tres asientos distintos; RC-12 no las cuenta entre sí; I-E8-4 pasa.
23. **Run parcial no contabiliza (O-20.3).** PDF de 9 páginas con 4 analizadas ⇒ confirmar desde el run LLM devuelve `PARTIAL_RUN_CANNOT_POST`; tras teclear las cifras, el run `MANUAL` sí postea y sus campos son de origen `usuario`.
24. **NIF inválido (O-20.2).** NIF con letra incorrecta ⇒ **FAIL**, no WARN. NIF válido sin ficha ⇒ WARN y confianza `interpretacion_ia`. NIF válido con ficha ⇒ **`verificado`**.
25. **Régimen no soportado (O-21).** Organización en RECC ⇒ la contabilización automática se bloquea con mensaje explícito y remisión a E9; el sello del periodo lleva `REGIMEN_NO_SOPORTADO`.
26. **Puentes fiscales (O-19, O-24).** I-E8-15a (Σ 472 = cuota deducible del libro registro), **I-E8-15b** (cuota total = 472 + IVA no deducible incorporado al coste, con el ticket no cualificado del caso 3 dentro), I-E8-15c (Σ 477 = repercutido), I-E8-16 (nada más allá de cuatro años) e I-E8-17 (Σ retenciones = abonos a 4751 por modelo) salen **PASS con tolerancia 0** sobre el fixture, y **FAIL** en el escenario de error inyectado.
27. **`cachedParseResult` erradicado (G-03).** La columna no existe; `grep` no la encuentra en producto; cada fila histórica tiene su run `IMPORTED` con todos los campos `no verificado` y confirmación rechazada.
28. **Reconstrucción e inmutabilidad.** `postFromProposal(run.reconcile, …)` reproduce el borrador línea a línea (I-E8-8); `UPDATE`/`DELETE` sobre `extraction_runs` como `app_runtime` → **42501**; editar y confirmar deja **dos** runs con el del LLM intacto byte a byte.
29. **Roles y tenant.** `VIEWER` ve todo y recibe `FORBIDDEN` en analizar, confirmar, forzar y editar; la suite RLS da **0 filas cruzadas** en las cuatro tablas nuevas.
30. **Error inyectado.** Alterar por SQL como `app_maintenance` los bytes de un fichero, una tasa o un `reconcile_status` ⇒ I-E8-2, I-E8-5 o I-E8-1 en **FAIL**, sello `REQUIERE REVISIÓN` con su motivo y evidencia reproducible. El test **falla si el informe se sirve como validado**.
31. **Rendimiento.** Bandeja de 2 000 ficheros y 6 000 runs en **< 150 ms** con una sola consulta; 50 facturas del mismo día en USD ⇒ **una** llamada de red; ningún run supera 256 KB.
32. **Anticipo de cliente sin cobro (O-23).** *Given* una factura de anticipo de 10 000,00 € + 2 100,00 € **sin `advanceEntryId` ni cobro efectivo**, *then* RC-25 sale **WARN bloqueante**, el asiento es `430` 12 100,00 € D contra `438` 12 100,00 € H **sin línea de 477**, y la pantalla explica que el IVA devengará al cobro (art. 75.Dos LIVA). *And when* después se registra el cobro con T-08, *then* el 477 aparece con la fecha del cobro y I-E8-15c cuadra con el libro registro de emitidas del trimestre **del cobro**, no del de la factura. El test **falla si el asiento de la factura de anticipo lleva 477**.
33. **NIF por ramas (O-25).** *Given* un proveedor **español** con letra incorrecta, *then* RC-11 **FAIL**. *Given* un proveedor **alemán** con NIF-IVA de formato válido y VIES negativo, *then* WARN bloqueante y RC-22 bloqueada. *Given* un proveedor **estadounidense** con un identificador fiscal sin checksum, *then* RC-11 **no falla**: confianza `interpretacion_ia` y, si está vacío, WARN. El test **falla si una factura de tercer país queda bloqueada por el dígito de control**.

### 12.2 Plan de tareas

| # | Tarea | Depende de | Agente | Nivel | h |
|---|---|---|---|---|---:|
| **T1** | ~~**ADR-0014 ronda 2** (D1…D14) a firma humana~~ · **HECHA**: APROBADO el 2026-09-06 (permiso delegado de Pablo de 2026-09-04). Desbloquea T2, T2b, T7, T9, T9b, T10 | — | arquitecto | 2 | 6 |
| **T2** | Prisma: `ExtractionRun`, `PromptVersion`, `ExchangeRate`, `InvoiceSeries` con `kind`; `File.sha256`; FX + `voidedEntryId(s)` + `splitParent` en `Transaction`; `receptionDate`/`operationDate`/`templateVersion` y FK en `JournalEntry`; `Counterparty`, `Category`, `Organization`; enums; `TENANT_MODELS`/`GLOBAL_REFERENCE_MODELS` | T1 | dev-backend | 2 | 10 |
| **T2b** | **Divisa en `JournalLine`** (`originalCurrency`, `originalAmountCents`, `exchangeRateId`, inmutables) + **`hashVersion = 3`** con `canonicalEntryFormV3` y **convivencia** en `entryHash`/I-E3-7; test de que `ledgerHash` **no** cambia y de que los fixtures v2 siguen byte a byte | T2 | dev-backend | 2 | 12 |
| **T3** | Las tres migraciones: tablas, RLS y append-only, RLS de referencia, CHECKs (D1 reescrito, techo de tolerancia, 64x, divisa), triggers (estado, `partial`, series, traslado a `voided_entry_id`), FK compuestas, **backfill bajo `NO FORCE`**, `DROP COLUMN`, seeds de mapa/deducibilidad/serie rectificativa; tests de integración del SQL | T2, T2b | dev-backend | 2 | 20 |
| **T4** | `scripts/backfill-file-sha256.ts` + migración a `NOT NULL` + sha al ingerir en `lib/uploads.ts` | T3 | dev-backend | 1 | 6 |
| **T5** | `lib/extraction/{types,hash}.ts`: cuatro niveles de confianza, `ProposalLine.kind`, `rectifies`, cuatro fechas, `canonicalJson` y los cuatro hashes + tests de canonicidad | T1 | dev-backend | 2 | 8 |
| **T6** | `ai/prompts/*.md` + `ai/schemas/extraction.v1.json` **sin los campos vetados** (O-10, O-11, D4, D8); `resolvePrompt`; `models/prompts.ts` append-only + `Setting` de versión vigente; test que falla si el prompt cambia sin bump y **test de que el schema no contiene `accountCode`** | T5 | dev-backend | 2 | 10 |
| **T23** | **Calificación fiscal de la organización y de la contraparte**: `Counterparty` (país, NIF-IVA, VIES con fecha, régimen de retención, recargo, empleado), `Organization.{roiRegistered, ivaRegime}`, `Category.{defaultAccountCode, defaultDeductibility}`, seed de categorías `REQUIERE_DECISION`, UI de `/settings/counterparties` | T2 | dev-backend | 2 | 10 |
| **T7** | **`lib/extraction/reconcile.ts`**: RC-01…RC-25, cuatro niveles de confianza, `quotaDeviationsCents`, `blocksBatch`; golden tests contra los **15** casos de `extraccion-esperada.json` | T5, T23, T1 | dev-backend | 2 | 34 |
| **T8** | **Validación contable ronda 2** + `docs/design/fixtures/extraccion-esperada.json` sellado con los **15 casos** (§5 + los dos de §R2.3); **cerrada: CONFORME CON OBSERVACIONES**, residuos O-23…O-25 ya incorporados al diseño y verificables por `qa-tester` sin tercera ronda | T7 (en paralelo) | experto-contable | 2 | 10 |
| **T9b** | **Cambios acotados en el motor de E3**: `taxOverrides`, `payableBlocks`, `payableKey` ampliado, `selectRate` por devengo **aplicado a la vez a C-10**; test de que los fixtures de E3–E6 no cambian ni un byte | T1 | dev-backend | 2 | 16 |
| **T9** | **`lib/ledger/postFromProposal.ts`**: `TEMPLATE_FOR_DOC` corregida, desvío a T-22, bloques de pasivo con Hamilton, cuota del documento, retención por régimen, rectificativas por sustitución, divisa; `previewFromProposal`; tests byte a byte | T7, T9b | dev-backend | 2 | 22 |
| **T10** | `lib/fx/{convert,rates}.ts` con el reparto Hamilton (residuo cero) + `models/fx.ts`; retirada de `app/api/currency` y de `currency-converter.tsx` | T2b, T1 | dev-backend | 2 | 14 |
| **T11** | `ai/` reescrito: `runExtraction`, `attachments` con `pagesTotal`, `llmProvider` con `attempts[]`, `usage_metadata` y zod estricto | T6 | dev-backend | 2 | 16 |
| **T12** | `models/extraction.ts` (alta, run de revisión, bandeja sin N+1), cola de servidor, `Progress`/SSE, rate limit, saldo por run | T11 | dev-backend | 1 | 14 |
| **T13** | `forms/extraction.ts` + `app/(app)/unsorted/actions.ts` (analizar, previsualizar, confirmar, lote, split N-a-1, **anular y rehacer**, forzados, ticket cualificado) con matriz de roles y `AuditLog`; `parseCents` en `forms/transactions.ts` | T9, T10, T12 | dev-backend | 2 | 20 |
| **T14** | **I-E8-1…20** (con **15a/b/c**) en `lib/ledger/invariants.ts`, incluidos los **puentes al 303 y al 111/115** y la métrica I-E8-7b; seis motivos de sello; cableado en `runLedgerInvariants` y `scripts/run-invariants.ts`; WARN de calidad para E7 | T13 | dev-backend | 2 | 22 |
| **T15** | UI `/unsorted` y `/unsorted/[fileId]`: visor, selector de run, **cuatro badges de confianza**, bloque de las cuatro fechas explicadas, panel de comprobaciones con marca de bloqueo de lote | T13 | dev-frontend | 1 | 24 |
| **T16** | UI del asiento propuesto con **bloques de pasivo desglosados**, avisos específicos (ticket, retención, sustitución, ISP, importación, RECC), confirmación con motivo, banner de parcial, pestaña **Documento** (drill-down ≤ 3 clics) | T15 | dev-frontend | 1 | 18 |
| **T17** | UI `/unsorted/batch` con no elegibles y su motivo; `/settings/{prompts,invoicing,currencies,organization}` | T16 | dev-frontend | 1 | 10 |
| **T18** | Facturas emitidas: `nextInvoiceNumber` **por tipo** con `FOR UPDATE`, invariante de no huecos (I-E8-20), recálculo en servidor (G-21), PDF como `File` con sha, emisión → T-01/T-02 | T9 | dev-backend | 2 | 18 |
| **T19** | Deuda del camino de entrada: `parseCents` único (G-07), tenant en import CSV (G-08), dedupe por sha256 y por `(taxId, nº, ejercicio)` (G-11, O-19), moneda por defecto (G-19), dedupe de adjuntos de email (G-22) | T4 | dev-backend | 1 | 12 |
| **T20** | Integración + RLS + e2e Playwright: criterios 1–29 y **32–33** (anticipo sin cobro, NIF por ramas), test de rendimiento de la bandeja | T16, T17, T18 | qa | 1 | 24 |
| **T21** | Auditoría de fiabilidad en contexto limpio: criterio 30 (bytes del fichero, tasa, `reconcile_status`, run editado por SQL) y los tres puentes fiscales con error inyectado | T14, T20 | qa | 2 | 12 |
| **T22** | Cierre documental: `MODELO-DATOS.md`, `ARQUITECTURA.md`, skills `fiabilidad` (cuarto badge, motivos, I-E8-*), `codebase-taxhacker`, `ui-erp`; **`ESTADO.md` con la deuda fechada** (523→173, valor actual del aplazamiento, RECC/REDEME, 668/768, DUA en E9); ROADMAP E8 → CERRADA; `runs/registro.jsonl`; ADR-0014 → APROBADO | T21 | arquitecto | 1 | 10 |

**Total: 378 h** (~47 jornadas, **24 tareas**; +86 h sobre la ronda 1: los seis bloqueantes, la divisa en la línea con su versión de hash, los cambios en el motor de E3, la calificación fiscal de la contraparte, siete invariantes más y los tres residuos O-23…O-25). **Camino crítico:** T1 → T2 → T2b → T3 → T7 → T9 → T13 → T15 → T16 → T20 → T21 → T22. **T8 ya no bloquea T9**: la validación está en **CONFORME CON OBSERVACIONES** y lo que resta de T8 es sellar el fixture de 15 casos, que corre en paralelo y es condición de cierre de la épica, no de arranque. T9b y T23 corren en paralelo desde T1/T2; T19 es independiente desde T4.

---

## 13. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | ~~La tolerancia se convierte en la puerta de atrás~~ | **Cerrado**: `TOLERANCIA_CUOTA_IVA_CENTS` es constante del motor y `redondeoToleranciaCents` tiene techo duro de 5 c en el CHECK |
| **R2** | **Alguien «re-arregla» el residuo de IVA llevándolo a 669** al leer el código de T-08/T-09 | Comentario explícito en `postFromProposal.ts` («la cuota es la del documento: ADR-0014 D3»), el criterio 3 que da 21 000 + 1 en 669 si se reintroduce, y I-E8-7a con tolerancia 0 |
| **R3** | **El default `NONE` en tickets se percibe como un error del producto** | Mensaje en pantalla con el fundamento (art. 97.Uno LIVA) y el camino a «factura simplificada cualificada»; el acto queda en `AuditLog` y en la métrica de Auditoría |
| **R4** | **Cuatro fechas confunden** | Cada una con su línea de explicación en el formulario; sólo `receptionDate` es obligatoria de las nuevas, con default la fecha de subida |
| **R5** | **`hashVersion = 3` y la convivencia** se implementan a medias y un asiento v3 se verifica con v2 | Despacho por versión con test de los dos caminos, y test de que los fixtures v2 siguen byte a byte |
| **R6** | **El usuario aprende a forzar** | El forzado no existe para las cifras: sólo duplicado, `convertedTotal` y ticket cualificado, los tres auditados. Un FAIL aritmético **no se puede forzar** |
| **R7** | **Calidad de extracción dependiente del proveedor** | El panel de E7 muestra PASS/WARN/FAIL **por modelo y versión de prompt** e I-E8-7b la desviación de cuota por proveedor; 15 golden tests |
| **R8** | **Frankfurter caído el día del cierre** | La confirmación falla con mensaje claro; lo ya contabilizado no depende de la red; un ADMIN precarga tasas de un periodo |
| **R9** | **Backfill de `sha256` sobre miles de ficheros** | Script de operador por organización, en lotes reanudables; columna nullable hasta terminar |
| **R10** | **Los cambios en el motor de E3 rompen los fixtures** | Los tres son opcionales y retrocompatibles; el CI compara los fixtures byte a byte y T9b lleva ese test explícito |
| **R11** | **`PROPOSED` se lee como «medio contabilizado»** | El CHECK impide que tenga asiento, ningún informe lo mira, y la pantalla lo dice con todas las letras |
| **R12** | **RECC bloquea a un cliente real** sin alternativa | El bloqueo es explícito y remite a E9, con fecha en `ESTADO.md`. Un producto que no dice qué no soporta es peor que uno que no lo soporta |

**Alternativas descartadas** (además de las de ADR-0014 §Alternativas): auto-contabilizar sin confirmación (ADR-0005); guardar la propuesta editada encima del run; un `confidence` numérico devuelto por el modelo; `items` como JSON libre en `Transaction`; split clonando el binario; conservar las tres fuentes de tasa; convertir sólo el total y prorratear las bases; **diferir la divisa de la línea a E9** (O-8: E8 es quien crea la deuda en divisa) y su contrario, **prohibir la moneda extranjera en E8** (rompe la paridad con TaxHacker); `exchange_rates` por organización; y situar `reconcile` dentro de `lib/ledger`, que no debe conocer el concepto «propuesta de un modelo» —el puente es `postFromProposal`, cuya salida sí es un `EntryDraft`.
