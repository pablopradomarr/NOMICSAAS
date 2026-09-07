# E9 — Cierre y recurrentes (diseño)

> Entregable del agente `arquitecto`. **Ronda 1, cerrada.** La validación contable
> `docs/design/E9-validacion-cierre.md` dio **NO CONFORME** (D4, D5, D6, D7, D8 y
> el alcance de la épica), con **22 observaciones bloqueantes** (O-1…O-22) y
> **ocho no bloqueantes** (O-23…O-30), respuestas a Q-1…Q-14, cinco invariantes
> nuevos (**I-E9-10b**, **I-E9-23…26**) y el checklist de cierre completo de un
> CFO. **Las treinta están incorporadas**, más los tres retoques de la
> re-validación —**R2-1** (23 pares de reclasificación), **R2-2** (el capital
> social se deriva del saldo de `100`) y **R2-3** (`LedgerAccount.isMonetary`)—,
> con lo que la validación queda en **CONFORME CON OBSERVACIONES**.
> `docs/adr/0016-cierre-recurrentes-y-fiscalidad-periodica.md` (D1–D12) está
> **APROBADO** por Pablo el 2026-09-07 (permiso delegado de 2026-09-04): la épica
> puede pasar a `/sprint E9`.
>
> Documentos que mandan sobre éste: `docs/spec/SPEC-FIABILIDAD.md` (P1–P7, C4–C7),
> `CLAUDE.md` §«Estándar de calidad», `.claude/skills/fiabilidad/SKILL.md`
> (I1–I10, I-E7-* e I-E8-*, **definidos una sola vez y aquí sólo agregados**),
> `.claude/skills/pgc-npgc/SKILL.md`, `.claude/skills/estados-financieros/SKILL.md`
> y ADR-0003 / 0005 / 0006 / 0009 / 0011 / 0012 / 0014 / 0015.
>
> Formato de referencia: `docs/design/E7-auditoria.md`.

---

## 0. Ronda 1 — qué cambió y dónde

### Bloqueantes

| Obs. | Qué cambia | Sección |
|---|---|---|
| **O-1** | **El valor actual del aplazamiento es valoración inicial (NRV 2ª.1 / 9ª.3.1), no un ajuste de cierre.** Tres vías: corrección dentro del ejercicio (recalculando el cuadro y revirtiendo la amortización en exceso), error de ejercicio cerrado por T-22 contra `113`, y origen no inmovilizado. `AssetRevision` **no** sirve: no es cambio de estimación | §3.2, §4.7, **D7**, I-E9-19 |
| **O-2** | El tipo de descuento se declara **mensual** (`discountRateMonthlyMicroBps`): `i/12` sólo vale para un TIN y la diferencia contra el efectivo anual es de 28 051 c en el ejemplo | §3.2, §4.7, **D7** |
| **O-3** | Interés implícito del **lado activo**: `762`, simétrico a `662` | §4.7, **D7** |
| **O-4** | El barrido de diferencias de cambio se acota a **partidas monetarias**: `LedgerAccount.isMonetary`, sembrado desde `seeds/npgc.csv`. Fuera `407`, `438`, `480`/`485`, 2xx, 3xx | §3.2, §4.6, **D6**, **I-E9-24** |
| **O-5** | **Tasa de cierre = la de mayor `rateDate ≤ corte`** dentro de una ventana declarada, sellada y visible. Con el 31-12 en sábado no había tasa y el cierre no avanzaba | §4.6, **D6**, I-E9-17 |
| **O-6** | **Préstamos con desglose de vencimientos obligatorio**: alta por **T-37** con una línea de `170`/`520` por vencimiento de principal; una posición de `17x`/`52x` sin desglose deja `RECLASIFICACION_VENCIMIENTOS` en **FAIL bloqueante**, no en una lista informativa | §3.2, §4.5, **D5**, **I-E9-25** |
| **O-7** *(+ R2-1)* | `ReclassificationPair` pasa de 6 a **23 pares** sembrados: los seis del PGC, **cuatro** de partes vinculadas (160↔510, 161↔511, 162↔512, 163↔513, **sin 514**), 172↔522, 175↔525, **176↔5595**, **177↔500**, 180↔560, 185↔561, 250↔540, 251↔541, 254↔544, 258↔548, 260↔565 y 265↔566. **`527`/`528` no se reclasifican**: son intereses a corto de deudas ya reclasificadas | §3.2, §4.5, **D5** |
| **O-8** | El contra-asiento de la reclasificación es el asiento **nº 2 de N+1**, después de T-28: T-27 y T-28 llevan los saldos **ya reclasificados** | §4.5, §4.10, **D5**, I-E9-14 |
| **O-9** | **Base del ajuste de prorrata corregida**: `trunc(cuotaProrrateable × definitiva) − trunc(cuotaProrrateable × provisional)`, sobre la **cuota sometida a prorrata**, no sobre lo ya deducido | §4.4, **D4**, I-E9-10 |
| **O-10** | **Regla de derivación del numerador y el denominador** (art. 104.Dos.1ª y Tres LIVA), con exclusiones **marcadas en el documento**, nunca deducidas. Sin marcar ⇒ `INFO`, jamás un porcentaje | §4.4, **D4** |
| **O-11** | La regularización se postea **antes de T-23 del último periodo** y con su `ivaPeriod`; la provisional de N+1 = definitiva de N (art. 105.Dos) | §4.4, **D4**, **I-E9-10b** |
| **O-12** | **Guardia bloqueante de bienes de inversión**: con prorrata ≠ 100 %, alta de grupo 2 ≥ 3 005,06 € en la ventana y desviación > 10 puntos ⇒ `PRORRATA_DEFINITIVA` **FAIL** y la liquidación no se postea | §4.4, §4.8, **D4** |
| **O-13** | **Mapa del 303 completo**: la cadena 46 → 71 estaba rota. Se añaden 30-31, 34-35, 38-39, 45, 46, 59-61, 62-63/74-75 (RECC), 64, 65, 66, 67, 69, 70, 71 y 77; y se declara qué **no** se ofrece (16-26, 42, 47-58, 68) | §4.4, **D4** |
| **O-14** | **RECC rompía I-E8-15a/c e I-E9-8a.** Puentes reformulados: `Σ477 + Σ4778` y `Σ472 + Σ4728` contra el libro | §4.4, §6.2, **D8**, I-E9-8a′ |
| **O-15** | **Cobro/pago parcial en RECC**: devengo proporcional `trunc(cobro × cuota / total)` con residuo al último cobro | §4.4, **D8** |
| **O-16** | **Diferimiento del IVA a la importación** (art. 167.Dos LIVA): `VatRegimePeriod.importDeferral`, T-29 bifurcada, casilla 77 | §3.2, §4.4, **D8**, I-E9-22 |
| **O-17** | **Orden de los asientos de cierre corregido**: la reclasificación es la **última** de las de balance, después del valor actual y de las diferencias de cambio; el impuesto, después de todo movimiento de 6/7 | §4.8, **D9** |
| **O-18** | **Distribución del resultado**: `129 → 112 / 113 / 120 / 526` (y `121` en pérdidas), con reserva legal **calculada** (art. 274 LSC) y dividendos a cuenta en `557`. Sin ella el PN es incorrecto desde el segundo ejercicio | §3.2, §4.9, **D10**, **I-E9-23** |
| **O-19** | **I-E9-5 no era computable**: `28x` es compartida. `JournalLine.fixedAssetId` (FK compuesta por tenant) atribuye la dotación al activo y habilita el drill-down | §3.2, §6.1, **D11** |
| **O-20** | **Numeración**: `OPENING` nº 1 y `CLOSING` último dejan de ser posiciones absolutas y pasan a **asiento vivo** (N-1′, N-5′). Reabrir N con N+1 ya cerrado exige reabrir antes N+1 | §4.8, **D1** |
| **O-21** | **La reapertura revierte también T-25**: sin eso, recerrar duplicaba el impuesto. Los pasos 5-7 no se revierten y quedan `PENDIENTE_RECOMPUTO`. I-E9-21 abarca grupos 1–7 y exige `129 = 0` y `6300 = 0` | §4.8, **D1**, I-E9-21 |
| **O-22** | **Cuota cero**: una fila del cuadro con importe 0 **no genera asiento**; la ocurrencia queda `OMITIDA` con motivo `CUOTA_CERO` y el importe se acumula a la siguiente fila > 0 | §4.2, §4.3, **D2**, **D3** |

### No bloqueantes

| Obs. | Qué cambia | Sección |
|---|---|---|
| **O-23** | La amortización del diario es la **contable**: coeficientes del art. 12.1 LIS como **sugerencia** en la UI; libertad de amortización, extracontable (E10) | §4.2, §7, **D2** |
| **O-24** | **Baja y venta automatizadas** (T-33 / T-34) con `543`/`253`, **nunca `430`**, dotación previa hasta el mes de baja y aviso del art. 110 LIVA | §4.2, **D2** |
| **O-25** | `567`/`568` con principal decreciente ⇒ el devengo lo aporta el cuadro del préstamo; `basis = DIAS` emite **WARN** con la desviación | §4.3, **D3** |
| **O-26** | **T-25**: cuenta `6300` (no `630`), cancelación obligatoria de `473`, y pregunta explícita por diferencias temporarias, BIN y deducciones | §4.8, **D9** |
| **O-27** | **Subcuentas de `4751` por modelo** (111 / 115 / 123), mapeadas por `AccountKey` | §3.2, §4.4, **D12** |
| **O-28** | **I-E9-4** reformulado: `Σ cuotas = coste + Σ mejoras − residual vigente` | §6.1 |
| **O-29** | **Checklist de cierre completo**: de 16 a **41 pasos en nueve bloques** | §4.8, §7 |
| **O-30** | **Mes entero**: alta y baja el mismo mes cuentan dos meses; criterio uniforme y escrito en la memoria | §4.2, **D2** |

### Re-validación (R2) — los tres retoques de cierre

| # | Qué cambia | Sección |
|---|---|---|
| **R2-1** | `ReclassificationPair` pasa de 18 a **23 pares**: **176↔5595** (no `526`, que es dividendo activo a pagar), **177↔500** (faltaba), y partes vinculadas en **cuatro** pares (160↔510, 161↔511, 162↔512, 163↔513) **sin `514`**, que no tiene largo plazo simétrico. **`527` y `528` no se reclasifican**: son intereses a corto de deudas ya reclasificadas y moverlos duplicaría el pasivo corriente | §3.2, §4.5, **D5** |
| **R2-2** | El **capital social se deriva del saldo acreedor de `100`** a la fecha de la junta, no se teclea: un capital almacenado diverge del diario en la primera ampliación y sería una **cifra de balance almacenada** (ADR-0003). `capitalStockOverrideCents` queda **sólo como contingencia** (plan sin `100` postable, capital en subcuentas no derivables) y su uso deja `DISTRIBUCION_RESULTADO` en **WARN** con motivo `CAPITAL_SOCIAL_DECLARADO` | §3.2, §4.9, **D10** |
| **R2-3** | El atributo es **`LedgerAccount.isMonetary`** (modelo Prisma; columna física `accounts.is_monetary`) en todo el texto: `Account` es el modelo de better-auth y nombrarlo así inducía al error | §0, §3.2, §3.5, §4.6, §5.1, §8, §10, **D6** |

**Lo que el experto declaró correcto y no se toca** (§0 de la validación): el
cierre como acto sellado con lista bloqueante evaluada **también en servidor**;
el cuadro de amortización como función pura **no almacenada**; la idempotencia
por índice único y no por `if`; **`Δ = D×r − S`** sin restar lo ya reconocido
(lección N-1 de E7, y es contablemente correcta, no sólo operativamente); el
rechazo explícito de los métodos degresivos; la prorrata como porcentaje entero
**redondeado al alza** con CHECK de múltiplo de 100; el **régimen de IVA
fechado** en vez de columna; la reversión periodo a periodo de la
periodificación; la negativa a adivinar un vencimiento ausente; y la aritmética
entera en `pct`/`bps`. **Tolerancia 0 en todo lo que compara importes**, y el
experto confirma que es alcanzable porque **ninguna regla de reparto de E9 usa
mayor resto**: las tres (R-AM-2, R-PE-2, O-15) llevan el residuo a una fila
determinada.

---

## 1. Deuda heredada que E9 cierra

| Viene de | Deuda | Dónde se cierra |
|---|---|---|
| **E8** | **523 → 173** sin reclasificar | §4.5, T-32, **D5** |
| **E8** | **Valor actual del aplazamiento** no reconocido | §4.7, T-31, **D7** (reescrita: valoración inicial) |
| **E8** | **RECC / REDEME** bloquean la contabilización (RC-24) | §3.2, §4.4, T-36, **D8** |
| **E8** | **`DUA_IMPORTACION` con plantilla `null`** | §4.4, **T-29** (dos modalidades), I-E9-22 |
| **E7 / E8** | **668 / 768**: E7 mide (I-E7-12), nadie reconoce | §4.6, **T-30**, **D6** |
| **E7** (ADR-0015 D3, R12) | Retención y **archivado en frío** de runs | §5.4, T21 |
| **E8** | **Rate limit** de la cola de extracción | §5.4, T22 |
| **E8** (H-8) | `exchange_rates` global | §3.6: **no se cambia**; ADR-0014 D7 confirmado |
| **E8** (H-9) | `resolveRectifiedEntry` sin validar uuid | T22 |
| **E3** (§9.2-4) | «No existe reapertura» | §4.8, **D1**: se matiza (Q-1 **SÍ, con condiciones**) |

---

## 2. Objetivo y alcance

E9 es **el ejercicio contable como ciclo**: lo que se repite, lo que se liquida
por periodo, lo que se ajusta al cierre y **lo que se distribuye después**.
Cierra el requisito de `SPEC-FUNCIONAL.md` §«asientos recurrentes (amortización,
periodificación), regularización de IVA, cierre y apertura» y §«periodos
bloqueables por mes».

Nueve entregas:

1. **`RecurringEntry` + `RecurringOccurrence`** con **idempotencia por índice
   único** `(regla, periodo)`.
2. **`FixedAsset` + cuadro derivado** (lineal, mes entero, residuo a la última
   cuota, revisión prospectiva), con **atribución por activo en la línea**
   (`JournalLine.fixedAssetId`, O-19) y **baja y venta automatizadas** (O-24).
3. **`Accrual`** 480 / 485 / 567 / 568 con devengo lineal y reversión periodo a
   periodo.
4. **Liquidación de IVA** derivada del libro registro de E8, con **prorrata
   definitiva** y su regularización, **guardia de bienes de inversión**,
   **RECC/REDEME** con sus puentes corregidos, **DUA** en sus dos modalidades y
   el **mapa completo del 303**.
5. **Ajustes de cierre**: valor actual del aplazamiento **como valoración
   inicial**, diferencias de cambio sobre **partidas monetarias** a tasa de
   cierre efectiva, y **reclasificación corriente/no corriente** con desglose de
   vencimientos obligatorio.
6. **Cierre completo** en el orden corregido de O-17, con **T-26 → T-27 → T-28** y
   **reapertura controlada** que revierte también T-25.
7. **Distribución del resultado** (O-18) como paso del ejercicio siguiente, tras
   la aprobación de la junta.
8. **Bloqueo de periodos completo**: B-6 (periodo de IVA liquidado), B-7, B-8.
9. **`ClosingRun` sellado** con los **41 pasos** del checklist de un CFO, y los
   motores puros **`lib/closing/`** y **`lib/recurring/`**.

### Qué NO incluye

- **No inventa invariantes ya existentes**: I1–I10 e I-E3/E4/E5/E6/E7/E8-* siguen
  definidos donde están; E9 los **exige en PASS** como paso del checklist.
- **No almacena ni una cifra de informe** (ADR-0003): las casillas del 303 y el
  cuadro de amortización son vistas derivadas.
- **No usa el LLM para nada** (P1, ADR-0005).
- **No presenta ante la AEAT** ni genera ficheros: muestra las casillas y su
  origen. 390, 349, 347, 190 y 200 quedan fuera; el paso del checklist existe.
- **No calcula la base imponible del IS**: T-25 se orquesta con una base
  **introducida y justificada por una persona** (Q-12 **SÍ, condicionado**);
  ajustes extracontables, BIN, deducciones y **diferencias temporarias**
  (`4740`/`4745`/`479` contra `6301`, NRV 13ª) son **E10** — y el checklist
  **pregunta explícitamente** por ellas, con motivo de sello
  `IMPUESTO_DIFERIDO_NO_RECONOCIDO` si la respuesta es afirmativa (O-26).
- **No regulariza bienes de inversión** (art. 107 LIVA, casilla 43) — pero
  **tampoco cierra en silencio**: la guardia de O-12 lo impide.
- **No implementa prorrata especial** (art. 103.Dos) **ni sectores diferenciados**
  (art. 101): se **bloquean**, no se aproximan (Q-7).
- **No amortiza por métodos degresivos**: el enum los declara y el motor los
  **rechaza**. La amortización fiscal (arts. 12.1, 12.3 y 102 LIS) es
  **extracontable** y no entra jamás en el diario (O-23).
- **No hace previsión de tesorería** ni auto-punteo por reglas (E12).
- **No toca `ExchangeRate`**: sigue global y append-only (ADR-0014 D7).

---

## 3. Modelo de datos

### 3.1 Convenciones aplicadas

`@@map`/`@map` en snake_case en **todo** modelo y columna nuevos;
`organizationId` en toda tabla de negocio, con **FK compuesta por tenant**
`(organization_id, <id>)`; dinero en céntimos enteros y **`bigint` desde el día 1**
(ADR-0015 D1); fechas de negocio `@db.Date` y `DateTime` sólo para auditoría
técnica; **toda tabla nueva entra a la vez** en `TENANT_MODELS` (`lib/db.ts`) y en
`SELECT app.enforce_tenant_rls('<tabla>')`.

**Ninguna migración exige SUPERUSER.** Los backfills van envueltos en
`NO FORCE` → backfill → `FORCE` **en la misma migración**, con la marca de
conversión escrita **antes** (lección de `20260907120000`). Los valores nuevos de
enum van en **una migración propia y anterior** a la que los usa (lección de
`20260913090000_e8_enums` y `20260916090000_e7_enums`).

### 3.2 Fragmento Prisma

```prisma
// ═══════════════════════════════════════════════════════════════════════════
// E9 · A — Recurrentes
// ═══════════════════════════════════════════════════════════════════════════

enum RecurrenceFreq   { MENSUAL TRIMESTRAL SEMESTRAL ANUAL        @@map("recurrence_freq") }
enum RecurrenceAnchor { PRIMER_DIA ULTIMO_DIA DIA_DEL_MES         @@map("recurrence_anchor") }
enum RecurringKind    { AMORTIZACION PERIODIFICACION IMPORTE_FIJO @@map("recurring_kind") }
enum RecurringStatus  { ACTIVA PAUSADA FINALIZADA                 @@map("recurring_status") }
enum OccurrenceStatus { GENERADA OMITIDA FALLIDA                  @@map("occurrence_status") }

/// Plantilla recurrente. **Ninguna cifra sale de un modelo** (P1, ADR-0005): o es
/// un importe fijo que una persona escribió, o lo aporta un cuadro determinista.
model RecurringEntry {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code String        @db.VarChar(32)
  name String        @db.VarChar(160)
  kind RecurringKind

  templateCode  String @map("template_code") @db.VarChar(32)
  /// Validado por el schema zod de su plantilla al crear la regla y **revalidado
  /// en cada generación**: si la cuenta desapareció del plan, la ocurrencia sale
  /// `FALLIDA` con motivo, no un asiento roto.
  templateInput Json   @map("template_input")

  amountCents BigInt? @map("amount_cents")   // sólo IMPORTE_FIJO (CHECK G-2)

  frequency  RecurrenceFreq
  anchor     RecurrenceAnchor @default(ULTIMO_DIA)
  dayOfMonth Int?             @map("day_of_month")

  /// Vigencia en PERIODOS, no en fechas: el generador nunca compara `Date.now()`.
  startPeriod String  @map("start_period") @db.VarChar(8)
  endPeriod   String? @map("end_period") @db.VarChar(8)

  status RecurringStatus @default(ACTIVA)

  fixedAssetId String?     @map("fixed_asset_id") @db.Uuid
  fixedAsset   FixedAsset? @relation(fields: [organizationId, fixedAssetId], references: [organizationId, id], onDelete: Restrict)
  accrualId    String?     @map("accrual_id") @db.Uuid
  accrual      Accrual?    @relation(fields: [organizationId, accrualId], references: [organizationId, id], onDelete: Restrict)

  createdAt   DateTime @default(now()) @map("created_at")
  createdById String?  @map("created_by_id") @db.Uuid
  updatedAt   DateTime @updatedAt @map("updated_at")

  occurrences RecurringOccurrence[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@index([organizationId, status, frequency])
  @@map("recurring_entries")
}

/// **APPEND-ONLY.** El `@@unique (organizationId, recurringEntryId, period)` **ES**
/// la idempotencia: dos generaciones simultáneas no producen dos asientos porque
/// la segunda choca contra el índice, no porque el código mire antes.
model RecurringOccurrence {
  id               String         @id @default(uuid()) @db.Uuid
  organizationId   String         @map("organization_id") @db.Uuid
  organization     Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  recurringEntryId String         @map("recurring_entry_id") @db.Uuid
  recurringEntry   RecurringEntry @relation(fields: [organizationId, recurringEntryId], references: [organizationId, id], onDelete: Restrict)

  period      String   @db.VarChar(8)
  postingDate DateTime @map("posting_date") @db.Date

  status OccurrenceStatus
  /// Obligatorio si `status ≠ GENERADA` (CHECK G-4). **O-22**: vocabulario
  /// reservado `CUOTA_CERO` para la fila de importe 0 que no genera asiento.
  reason String? @db.VarChar(512)

  entryId String?       @map("entry_id") @db.Uuid
  entry   JournalEntry? @relation(fields: [organizationId, entryId], references: [organizationId, id], onDelete: Restrict)

  /// sha256 canónico del input EFECTIVO. **I-E9-1b**: el asiento de marzo no se
  /// explica con la regla de septiembre.
  inputHash String @map("input_hash") @db.Char(64)

  generatedAt   DateTime @default(now()) @map("generated_at")
  generatedById String?  @map("generated_by_id") @db.Uuid

  @@unique([organizationId, recurringEntryId, period])
  @@unique([organizationId, id])
  @@index([organizationId, period])
  @@map("recurring_occurrences")
}

// ═══════════════════════════════════════════════════════════════════════════
// E9 · B — Inmovilizado
// ═══════════════════════════════════════════════════════════════════════════

/// **Sólo `LINEAL` se resuelve**; los otros tres se declaran y el motor los
/// **RECHAZA** (D2, mismo criterio que ADR-0013 D4 con `HOURS`). La amortización
/// del diario es la CONTABLE (NRV 2ª.2.1); la fiscal es extracontable (O-23).
enum DepreciationMethod { LINEAL SUMA_DIGITOS PORCENTAJE_CONSTANTE UNIDADES_PRODUCCION @@map("depreciation_method") }
enum AssetStatus        { EN_USO TOTALMENTE_AMORTIZADO BAJA VENDIDO                    @@map("asset_status") }

model FixedAsset {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code String @db.VarChar(32)
  name String @db.VarChar(160)

  /// Las tres cuentas, del plan de la organización y validadas (postables y
  /// activas). NUNCA hardcodeadas.
  assetAccountCode       String @map("asset_account_code") @db.VarChar(12)
  accumulatedAccountCode String @map("accumulated_account_code") @db.VarChar(12)
  expenseAccountCode     String @map("expense_account_code") @db.VarChar(12)

  acquisitionDate DateTime @map("acquisition_date") @db.Date
  /// **Puesta en condiciones de funcionamiento** (NRV 2ª.1 y 3ª), no la factura.
  inServiceDate   DateTime @map("in_service_date") @db.Date

  acquisitionCostCents BigInt             @map("acquisition_cost_cents")
  residualValueCents   BigInt             @default(0) @map("residual_value_cents")
  method               DepreciationMethod @default(LINEAL)
  usefulLifeMonths     Int                @map("useful_life_months")

  /// **O-12**: bien de inversión del art. 108 LIVA (> 3 005,06 €, vida > 1 año).
  /// Derivado del coste al alta y **editable con motivo**: gobierna la guardia de
  /// regularización del art. 107.
  isCapitalGood Boolean @default(false) @map("is_capital_good")
  /// Prorrata definitiva del año de adquisición, sellada. Sin ella la guardia de
  /// O-12 no puede comparar los diez puntos.
  acquisitionProrrataBps Int? @map("acquisition_prorrata_bps")

  projectId    String?     @map("project_id") @db.Uuid
  project      Project?    @relation(fields: [organizationId, projectId], references: [organizationId, id], onDelete: Restrict)
  costCenterId String?     @map("cost_center_id") @db.Uuid
  costCenter   CostCenter? @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)

  status          AssetStatus @default(EN_USO)
  disposalDate    DateTime?   @map("disposal_date") @db.Date
  disposalEntryId String?     @map("disposal_entry_id") @db.Uuid

  entryId       String? @map("entry_id") @db.Uuid
  transactionId String? @map("transaction_id") @db.Uuid
  fileId        String? @map("file_id") @db.Uuid

  /// sha256 del cuadro VIGENTE. El cuadro **no se almacena** (§3.6): se deriva.
  scheduleHash String @map("schedule_hash") @db.Char(64)

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  revisions  AssetRevision[]
  recurrings RecurringEntry[]
  lines      JournalLine[]     // O-19

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@index([organizationId, status])
  @@map("fixed_assets")
}

/// **APPEND-ONLY.** Cambio de ESTIMACIÓN (NRV 22ª): prospectivo, no toca el
/// pasado. **O-1**: reconocer tarde el valor actual **no** es un cambio de
/// estimación sino la corrección de un error, y NO usa esta tabla.
model AssetRevision {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  fixedAssetId   String       @map("fixed_asset_id") @db.Uuid
  fixedAsset     FixedAsset   @relation(fields: [organizationId, fixedAssetId], references: [organizationId, id], onDelete: Cascade)

  effectiveFrom DateTime @map("effective_from") @db.Date   // día 1 de mes (CHECK)

  newUsefulLifeMonths   Int?    @map("new_useful_life_months")
  newResidualValueCents BigInt? @map("new_residual_value_cents")
  addedCostCents        BigInt? @map("added_cost_cents")   // mejora capitalizada

  reason      String   @db.VarChar(512)
  createdAt   DateTime @default(now()) @map("created_at")
  createdById String?  @map("created_by_id") @db.Uuid

  @@unique([organizationId, fixedAssetId, effectiveFrom])
  @@map("asset_revisions")
}

// ═══════════════════════════════════════════════════════════════════════════
// E9 · C — Periodificaciones y deuda con cuadro
// ═══════════════════════════════════════════════════════════════════════════

enum AccrualKind {
  GASTO_ANTICIPADO              // 480 · contra 6xx
  INGRESO_ANTICIPADO            // 485 · contra 7xx
  INTERESES_PAGADOS_ANTICIPADO  // 567 · contra 662
  INTERESES_COBRADOS_ANTICIPADO // 568 · contra 762
  @@map("accrual_kind")
}
enum AccrualBasis  { DIAS MESES TIPO_EFECTIVO           @@map("accrual_basis") }
enum AccrualStatus { VIVA AGOTADA CANCELADA             @@map("accrual_status") }

model Accrual {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code String      @db.VarChar(32)
  name String      @db.VarChar(160)
  kind AccrualKind

  accrualAccountCode String @map("accrual_account_code") @db.VarChar(12)
  pnlAccountCode     String @map("pnl_account_code") @db.VarChar(12)

  totalCents  BigInt       @map("total_cents")
  periodStart DateTime     @map("period_start") @db.Date
  periodEnd   DateTime     @map("period_end") @db.Date
  /// **O-25**: `TIPO_EFECTIVO` sólo con `debtScheduleId`; `DIAS` sobre 567/568
  /// con horizonte > 12 meses o principal decreciente emite **WARN**.
  basis       AccrualBasis @default(MESES)

  /// **O-25 / O-6**: el devengo de intereses de un préstamo lo aporta su cuadro,
  /// no un reparto lineal.
  debtScheduleId String?       @map("debt_schedule_id") @db.Uuid
  debtSchedule   DebtSchedule? @relation(fields: [organizationId, debtScheduleId], references: [organizationId, id], onDelete: Restrict)

  projectId    String?     @map("project_id") @db.Uuid
  project      Project?    @relation(fields: [organizationId, projectId], references: [organizationId, id], onDelete: Restrict)
  costCenterId String?     @map("cost_center_id") @db.Uuid
  costCenter   CostCenter? @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)

  sourceEntryId String?       @map("source_entry_id") @db.Uuid
  status        AccrualStatus @default(VIVA)
  scheduleHash  String        @map("schedule_hash") @db.Char(64)

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  recurrings RecurringEntry[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@index([organizationId, status, periodEnd])
  @@map("accruals")
}

/// **O-6 · la pieza que faltaba.** Cuadro de amortización de una deuda (préstamo,
/// arrendamiento financiero, aplazamiento largo). Sin él, un préstamo entra como
/// una línea de `170` sin `dueDate` y el balance presenta **cero** en «Deudas con
/// entidades de crédito a corto plazo» teniendo préstamos vivos: la
/// reclasificación que un auditor comprueba primero, y la que más veces está mal.
model DebtSchedule {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code String @db.VarChar(32)
  name String @db.VarChar(160)

  /// Par de cuentas largo/corto de la deuda; se valida contra `ReclassificationPair`.
  longAccountCode  String @map("long_account_code") @db.VarChar(12)
  shortAccountCode String @map("short_account_code") @db.VarChar(12)

  counterpartyId String? @map("counterparty_id") @db.Uuid
  principalCents BigInt  @map("principal_cents")
  currency       String  @default("EUR") @db.VarChar(3)
  /// Tipo MENSUAL en punto fijo (O-2), misma convención que el descuento.
  monthlyRateMicroBps Int? @map("monthly_rate_micro_bps")

  startDate DateTime @map("start_date") @db.Date
  entryId   String?  @map("entry_id") @db.Uuid   // T-37

  /// sha256 del cuadro sellado. El cuadro de la deuda **sí** se persiste (a
  /// diferencia del de amortización): no es derivable de la deuda, es un dato
  /// del contrato que el banco entrega.
  scheduleHash String @map("schedule_hash") @db.Char(64)

  installments DebtInstallment[]
  accruals     Accrual[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@map("debt_schedules")
}

model DebtInstallment {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  debtScheduleId String       @map("debt_schedule_id") @db.Uuid
  debtSchedule   DebtSchedule @relation(fields: [organizationId, debtScheduleId], references: [organizationId, id], onDelete: Cascade)

  seq            Int
  dueDate        DateTime @map("due_date") @db.Date
  principalCents BigInt   @map("principal_cents")
  interestCents  BigInt   @map("interest_cents")

  @@unique([organizationId, debtScheduleId, seq])
  @@index([organizationId, dueDate])
  @@map("debt_installments")
}
```

```prisma
// ═══════════════════════════════════════════════════════════════════════════
// E9 · D — IVA: régimen fechado, liquidación y prorrata
// ═══════════════════════════════════════════════════════════════════════════

enum VatPeriodKind       { MENSUAL TRIMESTRAL          @@map("vat_period_kind") }
enum VatSettlementStatus { LIQUIDADA REVERTIDA         @@map("vat_settlement_status") }

/// **El régimen de IVA es un dato FECHADO, no una columna** (D8). Entrar en
/// REDEME en 2027 con una columna habría reagrupado los periodos de 2026 **ya
/// presentados**, y eso sólo se descubre en una inspección. Vigencias sin solape
/// por `EXCLUDE USING gist`, como `TaxRate` en E2.
model VatRegimePeriod {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  regime     IvaRegime
  periodKind VatPeriodKind @map("period_kind")
  /// **O-16.** Diferimiento del ingreso del IVA a la importación (art. 167.Dos
  /// LIVA, art. 74.1 RIVA): opción con vigencia anual, sólo con periodo MENSUAL
  /// (CHECK). Con ella, el DUA **sí** devenga 477 y aparece en la casilla 77.
  importDeferral Boolean @default(false) @map("import_deferral")

  validFrom DateTime  @map("valid_from") @db.Date
  validTo   DateTime? @map("valid_to") @db.Date

  reason      String?  @db.VarChar(512)
  createdAt   DateTime @default(now()) @map("created_at")
  createdById String?  @map("created_by_id") @db.Uuid

  @@index([organizationId, validFrom])
  @@map("vat_regime_periods")
}

/// El **acto** de liquidar, no sus cifras: las casillas del 303 se derivan
/// siempre (ADR-0003, §3.6). `outputCents`, `inputCents`, `carryForwardCents` y
/// `resultCents` son **evidencia recomputable** —patrón de
/// `recognizedDifferenceCents` en E7 ronda 2— e **I-E9-9** los recalcula.
model VatSettlement {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  periodKind  VatPeriodKind @map("period_kind")
  period      String        @db.VarChar(8)
  periodStart DateTime      @map("period_start") @db.Date
  periodEnd   DateTime      @map("period_end") @db.Date

  regime      IvaRegime
  prorrataBps Int?    @map("prorrata_bps")
  /// **O-16**: sellado, porque cambia la composición de la cuota devengada.
  importDeferral Boolean @default(false) @map("import_deferral")

  entryId String       @map("entry_id") @db.Uuid
  entry   JournalEntry @relation(fields: [organizationId, entryId], references: [organizationId, id], onDelete: Restrict)

  outputCents       BigInt @map("output_cents")
  inputCents        BigInt @map("input_cents")
  carryForwardCents BigInt @default(0) @map("carry_forward_cents")
  resultCents       BigInt @map("result_cents")

  ledgerHash String @map("ledger_hash") @db.Char(64)
  bookHash   String @map("book_hash") @db.Char(64)
  gitSha     String @map("git_sha")

  status            VatSettlementStatus @default(LIQUIDADA)
  reversedByEntryId String?             @map("reversed_by_entry_id") @db.Uuid
  reverseReason     String?             @map("reverse_reason") @db.VarChar(512)

  settledAt   DateTime @default(now()) @map("settled_at")
  settledById String?  @map("settled_by_id") @db.Uuid

  /// Una liquidación **viva** por periodo: índice único PARCIAL
  /// `WHERE status = 'LIQUIDADA'` (G-8). Con `@@unique` a secas, revertir y
  /// re-liquidar sería imposible.
  @@unique([organizationId, id])
  @@index([organizationId, periodKind, period])
  @@map("vat_settlements")
}

/// Prorrata del año natural (arts. 104 y 105 LIVA). **O-9/O-10/O-11**:
/// `prorrateableQuotaCents` es la BASE del ajuste —la cuota soportada sometida a
/// prorrata—, no lo ya deducido; numerador y denominador se **derivan** del libro
/// de emitidas con las exclusiones del art. 104.Tres **marcadas en el documento**.
model ProrrataYear {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  year           Int
  provisionalBps Int  @map("provisional_bps")
  definitiveBps  Int? @map("definitive_bps")

  numeratorCents        BigInt? @map("numerator_cents")
  denominatorCents      BigInt? @map("denominator_cents")
  prorrateableQuotaCents BigInt? @map("prorrateable_quota_cents")
  /// Documentos del año sin clave de operación: con alguno, el resultado es
  /// `INFO` y **nunca** un porcentaje (O-10).
  unclassifiedCount Int @default(0) @map("unclassified_count")

  adjustmentCents       BigInt? @map("adjustment_cents")
  regularizationEntryId String? @map("regularization_entry_id") @db.Uuid
  /// El periodo de IVA en el que se practicó (art. 105.Uno: la ÚLTIMA
  /// declaración-liquidación del año). **I-E9-10b**.
  regularizationPeriod  String? @map("regularization_period") @db.VarChar(8)

  closedAt   DateTime? @map("closed_at")
  closedById String?   @map("closed_by_id") @db.Uuid

  @@unique([organizationId, year])
  @@map("prorrata_years")
}

// ═══════════════════════════════════════════════════════════════════════════
// E9 · E — Presentación y distribución
// ═══════════════════════════════════════════════════════════════════════════

/// **O-7.** Pares largo ↔ corto, configuración versionada por organización, jamás
/// códigos en el motor. Se siembran **veintitrés** (§4.5), sólo donde ambas
/// cuentas existan y sean postables; en el resto, WARN de Auditoría.
model ReclassificationPair {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  longAccountCode  String  @map("long_account_code") @db.VarChar(12)
  shortAccountCode String  @map("short_account_code") @db.VarChar(12)
  /// Norma 6ª de elaboración de las cuentas anuales (RD 1514/2007).
  thresholdMonths  Int     @default(12) @map("threshold_months")
  isActive         Boolean @default(true) @map("is_active")

  @@unique([organizationId, longAccountCode, shortAccountCode])
  @@map("reclassification_pairs")
}

/// **O-18.** La distribución del resultado, acordada por la junta (art. 164 LSC).
/// Sin ella, `129` se arrastra indefinidamente, la reserva legal no se dota
/// (art. 274 LSC) y el patrimonio neto es incorrecto desde el segundo ejercicio.
model ProfitDistribution {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  /// El ejercicio CUYO resultado se distribuye.
  fiscalYearId   String       @map("fiscal_year_id") @db.Uuid
  fiscalYear     FiscalYear   @relation(fields: [organizationId, fiscalYearId], references: [organizationId, id], onDelete: Restrict)

  /// Fecha de la junta general. El asiento se postea con ella, en el ejercicio
  /// ABIERTO (art. 164 LSC: dentro de los seis meses siguientes al cierre).
  meetingDate DateTime @map("meeting_date") @db.Date

  resultCents BigInt @map("result_cents")   // saldo de 129 regularizado
  /// Destinos, todos en céntimos. `legalReserveCents` lo **calcula** el motor
  /// (art. 274 LSC) y no es editable a la baja; el resto lo acuerda la junta.
  legalReserveCents      BigInt @default(0) @map("legal_reserve_cents")
  voluntaryReserveCents  BigInt @default(0) @map("voluntary_reserve_cents")
  carryForwardCents      BigInt @default(0) @map("carry_forward_cents")      // 120
  dividendCents          BigInt @default(0) @map("dividend_cents")           // 526
  /// Dividendo a cuenta ya satisfecho durante el ejercicio (557, deudora, minora
  /// el PN). Se cancela contra el resultado en esta misma distribución.
  interimDividendCents   BigInt @default(0) @map("interim_dividend_cents")   // 557
  lossCarryForwardCents  BigInt @default(0) @map("loss_carry_forward_cents") // 121

  entryId String       @map("entry_id") @db.Uuid   // T-35
  entry   JournalEntry @relation(fields: [organizationId, entryId], references: [organizationId, id], onDelete: Restrict)

  approvedAt   DateTime @default(now()) @map("approved_at")
  approvedById String?  @map("approved_by_id") @db.Uuid

  @@unique([organizationId, fiscalYearId])
  @@unique([organizationId, id])
  @@map("profit_distributions")
}

// ═══════════════════════════════════════════════════════════════════════════
// E9 · F — El cierre como acto sellado
// ═══════════════════════════════════════════════════════════════════════════

enum ClosingRunStatus { BORRADOR COMPROBADO CERRADO REABIERTO ABORTADO @@map("closing_run_status") }

/// **D1.** Estado societario: separa una reapertura legítima (antes de formular,
/// art. 253 LSC) de una **reformulación** de cuentas aprobadas o depositadas
/// (arts. 272 y 279 LSC), que no es una operación de usuario.
enum AccountsApprovalStatus { BORRADOR FORMULADAS APROBADAS DEPOSITADAS @@map("accounts_approval_status") }

/// **Q-1, precisión 2 del experto.** Si el modelo 200 ya se presentó, reabrir
/// obliga a autoliquidación complementaria o rectificativa (art. 122 LGT). El
/// asistente lo advierte y `AuditLog` lo recoge.
enum TaxFilingStatus { NO_PRESENTADO PRESENTADO RECTIFICADO @@map("tax_filing_status") }

/// El cierre con su checklist y su sello. **APPEND-ONLY salvo** `status`, `steps`,
/// `seal`, `sealReasons` y las columnas de reapertura, por `GRANT UPDATE` de
/// columna (patrón de `journal_entries.voided_*`).
model ClosingRun {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  fiscalYearId   String       @map("fiscal_year_id") @db.Uuid
  fiscalYear     FiscalYear   @relation(fields: [organizationId, fiscalYearId], references: [organizationId, id], onDelete: Restrict)

  status  ClosingRunStatus @default(BORRADOR)
  refDate DateTime         @map("ref_date") @db.Date

  /// **O-29**: los 41 pasos en nueve bloques.
  /// [{ step, block, status: PASS|WARN|FAIL|NA|PENDIENTE_RECOMPUTO, blocking,
  ///    evidencia, query?, entryId? }]
  steps Json

  ledgerHash     String  @map("ledger_hash") @db.Char(64)
  planHash       String  @map("plan_hash") @db.Char(64)
  accountMapHash String  @map("account_map_hash") @db.Char(64)
  configHash     String  @map("config_hash") @db.Char(64)
  gitSha         String  @map("git_sha")
  invariantRunId String? @map("invariant_run_id") @db.Uuid

  /// Los doce asientos del cierre, en el orden de O-17.
  recurringEntryIds     Json    @default("[]") @map("recurring_entry_ids")
  reccAccrualEntryId    String? @map("recc_accrual_entry_id") @db.Uuid      // 2
  prorrataEntryId       String? @map("prorrata_entry_id") @db.Uuid          // 3
  vatSettlementEntryId  String? @map("vat_settlement_entry_id") @db.Uuid    // 4
  presentValueEntryId   String? @map("present_value_entry_id") @db.Uuid     // 5
  fxEntryId             String? @map("fx_entry_id") @db.Uuid                // 6
  reclassEntryId        String? @map("reclass_entry_id") @db.Uuid           // 7
  incomeTaxEntryId      String? @map("income_tax_entry_id") @db.Uuid        // 8
  regularizacionEntryId String? @map("regularizacion_entry_id") @db.Uuid    // 9
  cierreEntryId         String? @map("cierre_entry_id") @db.Uuid            // 10
  aperturaEntryId       String? @map("apertura_entry_id") @db.Uuid          // 11
  reclassReversalEntryId String? @map("reclass_reversal_entry_id") @db.Uuid // 12

  seal        Seal
  sealReasons Json @default("[]") @map("seal_reasons")

  durationMs Int       @map("duration_ms")
  closedAt   DateTime? @map("closed_at")
  closedById String?   @map("closed_by_id") @db.Uuid

  /// **O-21.** La reapertura revierte T-28 → T-27 → T-26 → **T-25**.
  reopenedAt     DateTime? @map("reopened_at")
  reopenedById   String?   @map("reopened_by_id") @db.Uuid
  reopenReason   String?   @map("reopen_reason") @db.VarChar(512)
  reopenEntryIds Json      @default("[]") @map("reopen_entry_ids")

  createdAt DateTime @default(now()) @map("created_at")

  @@unique([organizationId, id])
  @@index([organizationId, fiscalYearId, createdAt(desc)])
  @@map("closing_runs")
}
```

**Columnas nuevas en tablas existentes** (aditivas, con default):

| Tabla | Columna | Por qué |
|---|---|---|
| `JournalLine` | **`fixedAssetId String?` + FK compuesta por tenant** (`NULL` salvo en líneas de `68x`/`28x`/`671`/`771`), índice `(organization_id, fixed_asset_id)` | **O-19.** `2811` es una cuenta **compartida**: sin esto, I-E9-5 se evalúa por agregado y deja pasar justo lo que busca —un activo sobreamortizado compensado por otro infraamortizado— y el drill-down «cuota → asiento» de `/settings/assets` no existe. Es la alternativa preferida del experto frente a una subcuenta de `28x` por activo, que inflaría el plan y complicaría el balance por epígrafe |
| `LedgerAccount` | **`isMonetary Boolean @default(false)`**, sembrado desde `seeds/npgc.csv` | **O-4.** NRV 11ª.2.2: sólo las **partidas monetarias** se convierten a tipo de cierre. Sin el atributo, `original_currency IS NOT NULL` arrastraba `407` y `438` —anticipos, **no** monetarios— e inventaba resultado. Editable por organización con `AuditLog`, **nunca** una lista en el motor |
| `FiscalYear` | `accountsApprovalStatus`, `formulatedAt`, `approvedAt`, `depositedAt`, **`taxFilingStatus`** | D1 y Q-1.2 |
| `Organization` | **`discountRateMonthlyMicroBps Int?`** (sustituye a `discountRateBps`), `pvMaterialityCents BigInt @default(0)`, **`capitalStockOverrideCents BigInt?`** | **O-2** (el tipo se declara mensual: `i/12` sólo vale para un TIN) · O-1 (umbral) · **R2-2**: el capital social **se deriva del saldo acreedor de la cuenta `100`** en la fecha de la junta, **no se teclea**. Un capital almacenado en `Organization` diverge del diario en la primera ampliación —y sería una **cifra de balance almacenada**, contra ADR-0003—. El campo queda **sólo como contingencia** para el plan que no tenga `100` postable o la sociedad con capital en varias subcuentas no derivables: al usarlo, la reserva legal se calcula igual pero el paso `DISTRIBUCION_RESULTADO` sale **WARN** con motivo `CAPITAL_SOCIAL_DECLARADO` y la evidencia enseña las dos cifras |
| `Counterparty` | `ivaRegime IvaRegime @default(GENERAL)` | **D8.** Un proveedor en RECC difiere **mi** deducción (art. 163 *terdecies*): la dirección que se olvida y la que la Inspección comprueba |
| `Transaction` / `ExtractionRun` | `vatOperationKey` (clave de operación del libro registro) y las **columnas de cobro/pago del art. 61 *decies* / *undecies* RIVA** | O-10 (exclusiones del art. 104.Tres marcadas, no deducidas) y O-14 (el libro de RECC sin fechas e importes de cobro **no cumple**) |
| `AccountKey` (enum) | `AJUSTE_PRORRATA_NEGATIVO` (634) · `AJUSTE_PRORRATA_POSITIVO` (639) · `IVA_SOPORTADO_PENDIENTE_RECC` (4728) · `IVA_REPERCUTIDO_PENDIENTE_RECC` (4778) · `ARANCELES` · `DEUDA_LARGO_INMOVILIZADO` (173) · `BENEFICIO_BAJA_INMOVILIZADO` (771) · `PERDIDA_BAJA_INMOVILIZADO` (671) · `CREDITO_ENAJENACION_CP` (543) · `CREDITO_ENAJENACION_LP` (253) · `INGRESOS_CREDITOS` (762) · `IMPUESTO_CORRIENTE` (**6300**, no `630`) · `RESERVA_LEGAL` (112) · `RESERVAS_VOLUNTARIAS` (113) · `DIVIDENDO_ACTIVO_A_PAGAR` (526) · `DIVIDENDO_ACTIVO_A_CUENTA` (557) · `IRPF_A_PAGAR_111` · `IRPF_A_PAGAR_115` · `IRPF_A_PAGAR_123` | Diecinueve claves. `INTERESES_DEUDAS` (662), `DIFERENCIA_CAMBIO_*` (668/768), `PERIODIFICACION_*`, `PROVEEDORES_INMOVILIZADO` (523), `REMANENTE` (120) y `RESULTADOS_NEGATIVOS_ANTERIORES` (121) **ya existen**. **4728/4778 no son oficiales**: se crean como **hijas de 472 y 477** (prefijo, `parentCode` derivado) y heredan `statement` y `epigraph` del padre, para que el balance no haya que remapear (O-14). **O-27**: `4751` se parte por modelo, o el puente I-E8-17 no puede repartir el saldo y `RETENCIONES_LIQUIDADAS` no es verificable |
| `TemplateCode` | **T-29** `DUA_IMPORTACION` (dos modalidades) · **T-30** `DIFERENCIAS_CAMBIO_CIERRE` · **T-31** `AJUSTE_VALOR_ACTUAL` · **T-32** `RECLASIFICACION_VENCIMIENTOS` · **T-33** `BAJA_INMOVILIZADO` · **T-34** `VENTA_INMOVILIZADO` · **T-35** `DISTRIBUCION_RESULTADO` · **T-36** `DEVENGO_RECC` · **T-37** `ALTA_PRESTAMO` | El catálogo pasa de 28 a **37**, e **I-E3-5** exige **37/37**. Además se **modifican** T-08/T-09 (bloque RECC de cobro/pago parcial, O-15) y **T-25** (cuenta `6300` y cancelación obligatoria de `473`, O-26) |
| `EntryKind` / `SourceType` | `RECURRING` **ya existe** en los dos | Nada que añadir |

### 3.3 Migraciones

| # | Migración | Contenido |
|---|---|---|
| **M1** | `..._e9_enums` | Los catorce enums nuevos, las diecinueve `AccountKey` y los nueve `template_code`. **Sola y sin uso**: `ALTER TYPE … ADD VALUE` no permite usar el valor en la misma transacción |
| **M2** | `..._e9_recurrentes` | `recurring_entries`, `recurring_occurrences`, `fixed_assets`, `asset_revisions`, `accruals`, `debt_schedules`, `debt_installments`; FK compuestas por tenant; `enforce_tenant_rls` en las siete; append-only de `recurring_occurrences` y `asset_revisions`; **`journal_lines.fixed_asset_id`** con su FK e índice (O-19) |
| **M3** | `..._e9_iva` | `vat_regime_periods` (`EXCLUDE USING gist`, CHECK `importDeferral ⇒ MENSUAL`), `vat_settlements` (índice único **parcial**), `prorrata_years`, `reclassification_pairs`; función `app.iva_period(date, date, vat_period_kind) → text` **IMMUTABLE** escrita con `extract` + `lpad` (nada de `to_char`, que es `STABLE`); columna `journal_entries.iva_period` + trigger + CHECK; índice `journal_entries (organization_id, iva_period)`. **Backfill** con el baile `NO FORCE` → backfill → `FORCE` y la marca **antes** |
| **M4** | `..._e9_cierre` | `closing_runs`, `profit_distributions`; columnas de `fiscal_years`, `organizations`, `counterparties`, `transactions`/`extraction_runs`; **`LedgerAccount.isMonetary`** (`accounts.is_monetary`) con su siembra desde `seeds/npgc.csv` (O-4); siembra de los **veintitrés** `reclassification_pairs` y de las claves nuevas **sólo donde la cuenta exista y sea postable**, WARN de Auditoría en el resto (patrón de E8 §299) |
| **M5** | `..._e9_bloqueo_iva` | Trigger `journal_entries_vat_period_settled` (**B-6**): rechaza un asiento con líneas de 472/477/4728/4778 cuyo `iva_period` tenga una `vat_settlements` `LIQUIDADA`. Barrera 2; la 1 la da la server action con el mensaje legible |
| **M6** | `..._e9_numeracion_viva` | **O-20.** Reformula en la base las comprobaciones N-1/N-5 en términos de **asiento vivo** (no anulado), para que una reapertura no deje el ejercicio incapaz de volver a cerrarse |

### 3.4 Reglas de integridad propias de E9

| # | Regla | Dónde |
|---|---|---|
| **G-1** | `(organizationId, recurringEntryId, period)` único — **es** la idempotencia | Índice único |
| **G-2** | `amount_cents IS NOT NULL` ⟺ `kind = IMPORTE_FIJO`; `fixed_asset_id` ⟺ `AMORTIZACION`; `accrual_id` ⟺ `PERIODIFICACION` | CHECK |
| **G-3** | `day_of_month` 1–31 y sólo con `anchor = DIA_DEL_MES`; el motor **satura** al último día del mes | CHECK + `lib/recurring` |
| **G-4** | `entry_id IS NOT NULL` ⟺ `status = GENERADA`; `reason IS NOT NULL` si `status ≠ GENERADA` (**incluye `CUOTA_CERO`**, O-22) | CHECK |
| **G-5** | `acquisition_cost_cents > 0`, `0 ≤ residual < coste`, `useful_life_months` 1–1200, `in_service_date ≥ acquisition_date` | CHECK |
| **G-6** | `asset_revisions.effective_from` es día 1 de mes y **no anterior** al último periodo contabilizado | CHECK + servidor |
| **G-7** | `accruals`: `period_end ≥ period_start`, `total_cents > 0`; `basis = TIPO_EFECTIVO ⟹ debt_schedule_id IS NOT NULL` | CHECK |
| **G-8** | Una `vat_settlements` **viva** por periodo | `UNIQUE … WHERE status = 'LIQUIDADA'` |
| **G-9** | `*_bps` entre 0 y 10000 y **múltiplo de 100** (art. 104.Dos.2ª) | CHECK |
| **G-10** | `vat_regime_periods` sin solape | `EXCLUDE USING gist (organization_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)` |
| **G-11** | `reclassification_pairs`: cuentas distintas, `threshold_months > 0` | CHECK |
| **G-12** | Un `closing_runs` `CERRADO` vivo por ejercicio | `UNIQUE … WHERE status = 'CERRADO'` |
| **G-13** | **B-6**: ningún asiento nuevo con línea de 472/477/4728/4778 en un `iva_period` liquidado | Trigger M5 |
| **G-14** | `status = CLOSED` ⟹ existe `closing_runs` `CERRADO`; reabrir exige `accounts_approval_status = BORRADOR` | Trigger + server action |
| **G-15** | **O-19**: `fixed_asset_id` sólo en líneas cuyo `account_code` empiece por `68`, `28`, `671` o `771` | CHECK |
| **G-16** | **O-18**: una `profit_distributions` por ejercicio; `Σ destinos = result_cents` (con signo) | `@@unique` + CHECK + I-E9-23 |
| **G-17** | `debt_installments`: `Σ principal = debt_schedules.principal_cents`, `seq` correlativo sin huecos | CHECK diferido |

### 3.5 Estrategia de datos existentes

Ninguna tabla nueva tiene datos previos. Lo que se toca de lo existente es
aditivo y con default:

- **`journal_entries.iva_period`** se rellena por backfill desde
  `max(reception_date, document_date)` con el `VatRegimePeriod` que M4 siembra
  (`GENERAL` / `TRIMESTRAL` / `importDeferral = false` desde el primer ejercicio
  de cada organización), de modo que el histórico conserva **exactamente** el
  trimestre que `quarterOf` calculaba. **I-E9-8b** compara los dos caminos sobre
  el fixture completo antes de retirar el cálculo en memoria.
- **`LedgerAccount.isMonetary`** (columna física `accounts.is_monetary`) se siembra desde `seeds/npgc.csv`: monetarias 17x,
  40x, 41x, 43x, 44x, 46x, 52x, 53x, 54x, 55x, 57x y las fianzas de 18x/26x; **no**
  monetarias 20x, 21x, 3xx, `407`, `438`, `480`, `485`. Es un dato del plan, no
  una lista en el motor, y se edita con `AuditLog` (O-4).
- **`journal_lines.fixed_asset_id`** queda `NULL` en todo el histórico: I-E9-5
  sale `INFO` para los activos anteriores a E9 —diciendo que no hay atribución—,
  nunca `PASS` por vacuidad, y la pantalla ofrece asociarlos con motivo.
- **`4751`** no se parte por migración: se crean las tres subcuentas y se mapean
  (O-27); el saldo histórico se queda donde está y `RETENCIONES_LIQUIDADAS` sale
  `INFO` para los periodos anteriores.

### 3.6 Lo que **no** existe como tabla, y por qué

- **El cuadro de amortización.** Función pura de `(FixedAsset, AssetRevision[])`.
  Almacenarlo crea una segunda verdad que se desincroniza a la primera revisión
  de vida útil y obliga a reescribir filas que ya respaldan asientos. Se sella
  `scheduleHash` e **I-E9-3** demuestra que el cuadro de hoy explica los asientos
  de ayer. El experto lo confirma expresamente.
- **Las casillas del 303.** Vista derivada con provenance por casilla. Si se
  almacenaran, una rectificativa posterior las dejaría mintiendo, y el modelo
  cambia cada año por orden ministerial.
- **El libro registro de IVA.** Ya se deriva en E8; E9 lo **agrupa por periodo**.
- **`exchange_rates` por organización.** Se **confirma ADR-0014 D7**: la
  referencia del BCE es pública y partir la tabla multiplicaría las llamadas para
  obtener el mismo número. La deuda de E8 (H-8) se cierra **decidiendo que no se
  cambia**, con la razón escrita.
- **Excepción declarada: `debt_schedules` / `debt_installments` SÍ se
  persisten.** No son derivables de la deuda: son un dato del contrato que el
  banco entrega, y es precisamente su ausencia lo que O-6 identifica como el
  defecto que deja el balance mal clasificado.

---

## 4. Motor / funciones puras

Dos módulos nuevos, **`lib/closing/`** y **`lib/recurring/`**, que entran el
primer día en el hook de pureza, en ESLint y en CI: **sin `Date.now()`, sin IO,
sin LLM, sin `Float`**. Toda función tiene la forma `f(input, config, refDate) →
output` y toda fecha entra por parámetro.

### 4.1 `lib/recurring/schedule.ts`

```ts
export type PeriodKey = string   // "2026-03" | "2026-Q2" | "2026-S1" | "2026"
export type RecurrencePeriod = { key: PeriodKey; start: LocalDate; end: LocalDate; postingDate: LocalDate }

export function periodKeyOf(date: LocalDate, freq: RecurrenceFreq): PeriodKey
export function periodsBetween(rule: RecurringRuleRef, from: PeriodKey, to: PeriodKey): RecurrencePeriod[]
export function duePeriods(rule: RecurringRuleRef, generated: readonly PeriodKey[], refDate: LocalDate): RecurrencePeriod[]
export function occurrenceInputHash(rule: RecurringRuleRef, period: RecurrencePeriod, input: unknown): string
export function buildOccurrenceDraft(
  rule: RecurringRuleRef, period: RecurrencePeriod, source: OccurrenceSource, ctx: LedgerContext
): Result<EntryDraft> | { skip: "CUOTA_CERO" | "SIN_FILA_EN_CUADRO" }
```

**R-REC-1…8**:

- **R-REC-1** Un periodo está vencido cuando `period.end ≤ refDate`. Nunca un
  asiento con fecha futura (I8).
- **R-REC-2** `postingDate` = último día del periodo (por defecto), primero, o el
  día declarado **saturado** al último del mes.
- **R-REC-3** **Idempotencia por construcción**: se intenta el `INSERT` de la
  ocurrencia **antes** de postear, en la misma transacción. Si choca con G-1, la
  transacción muere y no hay asiento. Nunca «mirar y luego insertar».
- **R-REC-4** El importe lo aporta el cuadro (`AMORTIZACION`, `PERIODIFICACION`) o
  la regla (`IMPORTE_FIJO`). El motor **no interpola**: sin fila en el cuadro, la
  ocurrencia sale `OMITIDA` con motivo.
- **R-REC-5** Una regla `PAUSADA` no genera **y no rellena hacia atrás** al
  reactivarse: los periodos pasados quedan `OMITIDA` con motivo a la vista,
  porque un devengo que falta tiene que verse.
- **R-REC-6** El asiento lleva `kind = RECURRING`, `sourceType = RECURRING` y
  `sourceId = "<code>/<period>"`.
- **R-REC-7** Anular es contra-asiento (T-21). La ocurrencia **no se borra**:
  queda `GENERADA` apuntando al asiento anulado, y el par se neutraliza solo en
  los informes. Re-generar exige revertir la ocurrencia con motivo.
- **R-REC-8** **(O-22)** Una fila de cuadro con **cuota 0 no genera asiento** —un
  asiento de importe cero viola C-1 y el refuerzo de I1 de E3 §6.5—: la
  ocurrencia queda `OMITIDA` con motivo **`CUOTA_CERO`** y el importe se acumula a
  la siguiente fila con cuota > 0, de modo que el cuadro sigue sumando la base y
  la omisión es visible.

### 4.2 `lib/closing/depreciation.ts`

```ts
export type DepreciationRow = {
  period: PeriodKey; from: LocalDate; to: LocalDate
  quotaCents: Cents; accumulatedCents: Cents; netBookValueCents: Cents
}
export function depreciationSchedule(asset: FixedAssetRef, revisions: readonly AssetRevisionRef[]): DepreciationRow[]
export function scheduleHashOf(rows: readonly DepreciationRow[]): string
export function depreciationForPeriod(rows: readonly DepreciationRow[], period: PeriodKey): DepreciationRow | null
export function disposalLines(asset, rows, disposal: DisposalInput, ctx: LedgerContext): Result<DraftLine[]>
```

**R-AM-1…10**:

- **R-AM-1** Base amortizable = `coste + Σ mejoras capitalizadas − valor residual
  vigente` (**O-28**: el enunciado anterior dejaba de ser cierto tras una
  revisión).
- **R-AM-2** Lineal en céntimos: `q = trunc(base / n)`, y el residuo
  `base − n·q ∈ [0, n−1]` **a la ÚLTIMA cuota**. **No se usa `hamilton()`**: con
  pesos iguales reparte por menor código —a los primeros meses— y el activo
  alcanzaría su valor residual **antes** de agotar su vida útil, que es una
  amortización acelerada no justificada (NRV 2ª.2.1). Confirmado por el experto
  como «la única opción defendible». Con `base < n`, se aplica **R-REC-8**.
- **R-AM-3** Comienza el **mes de `inServiceDate`** (puesta en condiciones de
  funcionamiento, NRV 2ª.1 y 3ª), mes entero.
- **R-AM-4** `accumulatedCents` nunca supera la base; ninguna cuota negativa.
- **R-AM-5** **Revisión prospectiva** (NRV 22ª): desde `effectiveFrom`, se
  reparte el **valor neto contable** entre la vida residual nueva. El pasado no
  se toca y **no hay asiento de ajuste**.
- **R-AM-6** **(O-24) Baja automatizada (T-33)**: se dota la amortización **hasta
  el mes de la baja inclusive** y se da de baja `28x (D) / 2xx (H)` con el VNC a
  `671`. Ejemplo del experto: coste 1 000 000, acumulada 640 000 ⇒ `2811 (D)
  640 000` · `671 (D) 360 000` · `2131 (H) 1 000 000`.
- **R-AM-7** **(O-24) Venta automatizada (T-34)**: la contrapartida es **`543`**
  (o `253` si el aplazamiento supera el año), **nunca `430`** — `430` recoge
  créditos de la actividad ordinaria y meter ahí la venta de una furgoneta
  contamina el *aging*, el DSO y el PMC. El resultado va a `771`/`671` y el IVA a
  `477`. **Aviso obligatorio** en pantalla si el elemento es bien de inversión
  dentro del periodo de regularización (art. 110 LIVA) o es edificación
  (art. 20.Uno.22º y la renuncia con ISP del art. 84.Uno.2º.e). No se automatiza
  esa parte; se dice.
- **R-AM-8** **(O-30)** Con «mes entero desde la puesta en servicio» y «hasta el
  mes de baja inclusive», un activo en servicio el 31/01 y dado de baja el 01/02
  amortiza **dos meses**. Es inmaterial y aceptable, pero **queda escrito** en la
  norma de valoración de la memoria y es el criterio uniforme (art. 38.d CCom);
  **no se cambia a mitad de vida de un activo**.
- **R-AM-9** **(O-23)** El cuadro es **contable**. Los coeficientes del art. 12.1
  LIS son una **sugerencia** de la UI (tabla estática, jamás LLM); la libertad de
  amortización y la acelerada (arts. 12.3 y 102 LIS) **no se contabilizan** y
  generan diferencias temporarias imponibles (`479` contra `6301`), que son E10.
  Si el motor las admitiera en el diario, el resultado contable dejaría de ser el
  punto de partida del art. 10.3 LIS.
- **R-AM-10** El cuadro **no se almacena** (§3.6); el destino analítico del gasto
  es el del activo, e **I4 no se toca**.

**Fixture obligatorio.** `docs/design/fixtures/build_cuadros_esperados.py` genera
`cuadros-esperados.json` con **ocho** casos: base indivisible; residual > 0; alta
a mitad de mes; revisión de vida útil en el mes 20; mejora capitalizada; baja en
el mes 14; **venta con `543` e IVA**; y **`base < n` (cuota cero, O-22)**.
Comparación **byte a byte** (`canonicalJson`), como en E4 y E6.

### 4.3 `lib/closing/accrual.ts`

```ts
export type AccrualRow = { period: PeriodKey; from: LocalDate; to: LocalDate; days: number; quotaCents: Cents; pendingCents: Cents }
export function accrualSchedule(accrual: AccrualRef, freq: RecurrenceFreq): { rows: AccrualRow[]; warnings: AccrualWarning[] }
export function accrualScheduleHashOf(rows: readonly AccrualRow[]): string
```

**R-PE-1…6**:

- **R-PE-1** `MESES`: pesos iguales. `DIAS`: días naturales del periodo dentro de
  `[periodStart, periodEnd]`, **ambos extremos incluidos**, **ACT/ACT** — no hay
  norma contable que imponga 30/360, que es un convenio financiero, y el devengo
  se mide por el tiempo real de prestación. *(Ejemplo del experto: prima 100 000,
  365 días, 47 en 2026 ⇒ 12 876 / 87 124.)*
- **R-PE-2** Reparto entero con **residuo a la última fila** y **R-REC-8** para la
  cuota cero: la cuenta de periodificación queda en **0 exacto**.
- **R-PE-3** **Reversión periodo a periodo** por la regla recurrente asociada. No
  hay asiento único de reversión: partiría el gasto en el ejercicio equivocado
  justo cuando la periodificación cruza el cierre, que es su caso de uso.
- **R-PE-4** Cancelar antes de tiempo devenga el pendiente **en el periodo de la
  cancelación**, con motivo. Nunca se borra.
- **R-PE-5** 480/485 son comerciales; **567/568 son financieras** contra 662/762,
  `analyticType = FINANCIERO`, nivel BAI (R-A5/R-A6 de E4). Confundirlas mueve el
  EBITDA.
- **R-PE-6** **(O-25)** Los intereses se devengan por **tipo de interés efectivo**
  sobre el coste amortizado (NRV 9ª.2.2 y 9ª.3.1). Con principal **constante** y
  horizonte ≤ 12 meses, el lineal por días es una aproximación admisible por
  inmaterialidad. Con principal **decreciente**, el devengo lo aporta el **cuadro
  del préstamo** (`DebtSchedule`, `basis = TIPO_EFECTIVO`); mientras no exista,
  `basis = DIAS` sobre 567/568 emite **WARN** con el motivo y la desviación
  estimada.

### 4.4 `lib/closing/vat.ts` — liquidación, prorrata, RECC y el 303

```ts
export function vatPeriodOf(date: LocalDate, kind: VatPeriodKind): PeriodKey
export function vatPeriodBounds(period: PeriodKey): { start: LocalDate; end: LocalDate }
export function vatSettlement(input: VatSettlementInput): Result<RegularizacionIvaInput>

export function prorrataDefinitivaBps(numeratorCents: Cents, denominatorCents: Cents): number
export function prorrataTerms(book: readonly VatBookRow[], year: number): ProrrataTerms   // O-10
export function prorrataRegularization(input: {
  prorrateableQuotaCents: Cents; provisionalBps: number; definitiveBps: number
}): { adjustmentCents: Cents; accountKey: "AJUSTE_PRORRATA_NEGATIVO" | "AJUSTE_PRORRATA_POSITIVO" }
export function capitalGoodsGuard(input: CapitalGoodsInput): ClosingStepResult             // O-12

export function reccAccrualOnCollection(input: {
  collectedCents: Cents; totalInvoiceCents: Cents; totalQuotaCents: Cents; alreadyAccruedCents: Cents; isFinal: boolean
}): Cents                                                                                  // O-15
export function reccYearEndSweep(pending: readonly ReccPendingRef[], cutoff: LocalDate): DraftLine[]

export function casillas303(input: Model303Input): Model303View                            // vista derivada
```

**R-IVA-8…20** (continúan la numeración de E3 §0.1):

- **R-IVA-8** El periodo es `vatPeriodOf(max(receptionDate, documentDate), kind)`
  con el `kind` **vigente a esa fecha** (`VatRegimePeriod`). `quarterOf` de E8
  **no se borra**: es el caso `TRIMESTRAL`, y el `ivaPeriod` de una organización
  trimestral no cambia ni un valor.
- **R-IVA-9** La liquidación **sale del libro registro**, no de los saldos: los
  saldos son la otra orilla del puente (I-E8-15a/b/c) y sirven para **verificar**.
  Si difieren, **no se postea** y se enseña la diferencia documento a documento.
- **R-IVA-10** El asiento es **T-23**, que no se toca.
- **R-IVA-11** **Prorrata definitiva**: `pct = ceil(num × 100 / den)` en
  aritmética **entera**, `bps = pct × 100`. Es un porcentaje **entero redondeado
  al alza** (art. 104.Dos.2ª); de ahí G-9. Denominador 0 ⇒ `INFO`, nunca 0 %.
- **R-IVA-12** **(O-10) Derivación del numerador y el denominador**, desde el
  libro de **emitidas** del año natural (art. 104.Dos.1ª), en importes **sin
  IVA**:

  | Término | Contenido |
  |---|---|
  | **Numerador** | Operaciones **con derecho a deducción**: sujetas y no exentas, exportaciones y asimiladas, entregas intracomunitarias exentas (art. 25) y las exenciones plenas del art. 94.Uno |
  | **Denominador** | Numerador **+** operaciones **sin** derecho a deducción (exenciones limitadas del art. 20) |
  | **Excluido de ambos** (art. 104.Tres) | Entregas de **bienes de inversión** utilizados; operaciones inmobiliarias o financieras **no habituales**; autoconsumos del art. 9.1º.c) y d); operaciones realizadas fuera del TAI desde establecimientos no situados en él; el propio IVA |

  Toda exclusión es una **clave de operación marcada en el documento**, jamás
  deducida por el motor. Con documentos sin clasificar, el resultado es **`INFO`
  con su lista**, nunca un porcentaje.
- **R-IVA-13** **(O-9) Base del ajuste — corregida**:
  `ajuste = trunc(cuotaProrrateable × definitivaBps / 10000) − trunc(cuotaProrrateable × provisionalBps / 10000)`,
  donde `cuotaProrrateable` es la **cuota soportada del año sometida a prorrata**
  —excluye las 100 % deducibles por afectación exclusiva, las no deducibles por
  naturaleza (art. 96) y las de bienes de inversión (art. 107)—. **No** es «lo ya
  deducido»: con esa lectura, sobre 100 000 con provisional 80 % y definitiva
  87 %, el ajuste salía **5 600** en vez de **7 000** (error de 1 400).
- **R-IVA-14** **Asiento y signo** (art. 634/639 de la 3ª parte del PGC, que
  **dicta** la contrapartida `472`, no es una elección):

  | Situación | Ajuste | Asiento | Casilla 44 |
  |---|---|---|---|
  | Definitiva > provisional | `> 0` | `472 (D) / 639 (H)` | positiva |
  | Definitiva < provisional | `< 0` | `634 (D) / 472 (H)` | negativa |

- **R-IVA-15** **(O-11) Momento y periodo**: `closeProrrataYearAction` sólo se
  admite **antes** de `settleVatAction` del último periodo del año, y liquidar el
  último periodo **exige** la prorrata cerrada (paso bloqueante). La línea de
  `472` lleva `ivaPeriod` = último periodo del año (art. 105.Uno). Y la
  **provisional de N+1 = definitiva de N** (art. 105.Dos), fijada por la misma
  acción; un porcentaje distinto autorizado por la Administración se **declara
  como dato**, no se deduce. Lo verifica **I-E9-10b**.
- **R-IVA-16** **(O-12) Guardia de bienes de inversión**, determinista, en
  `closingChecklist`:

  ```
  si  ∃ año Y ∈ [N−8, N] con prorrataBps(Y) ≠ 10000
  y   ∃ alta de grupo 2 con coste ≥ 300 506 c en [N−8, N]        // art. 108 LIVA
  y   |prorrataBps(N) − prorrataBps(año de alta)| > 1000          // 10 puntos, art. 107.Uno
  ⇒   PRORRATA_DEFINITIVA = FAIL, blocking = true
      sello REGULARIZACION_BIENES_INVERSION_PENDIENTE
      la liquidación del último periodo NO se postea
  ```

  Ventana de **cuatro** años, **nueve** para terrenos y edificaciones
  (art. 107.Tres). Con la guardia, dejar el art. 107 para E10 es defendible; sin
  ella, no: una casilla vacía es honesta frente al usuario, no frente a la AEAT.
- **R-IVA-17** **Prorrata especial** (art. 103.Dos) y **sectores diferenciados**
  (art. 101) **se bloquean**, no se aproximan.
- **R-IVA-18** **(O-16) DUA (T-29), dos modalidades.** La base es la del DUA
  —valor en aduana + aranceles + gravámenes y gastos hasta el primer lugar de
  destino, art. 83.Uno—, **no** la de la factura del proveedor (ya contabilizada
  sin IVA como `FACTURA_RECIBIDA_EXTRACOM`); los aranceles son **mayor coste**
  (NRV 10ª.1 y 2ª.1):

  | Modalidad | Asiento *(ejemplo: base 12 000 000, aranceles 500 000, cuota 2 520 000)* |
  |---|---|
  | **Ordinaria** | `600/2xx (D) 500 000` · `472 (D) 2 520 000` · `410`/`572 (H) 3 020 000`. **Sin 477** |
  | **Con diferimiento** (art. 167.Dos LIVA, art. 74.1 RIVA; exige `MENSUAL`) | `600/2xx (D) 500 000` · `472 (D) 2 520 000` · **`477 (H) 2 520 000`** · `410`/`572 (H) 500 000`. Casillas **77** y **32-33** |

- **R-IVA-19** **(O-14/O-15) RECC.** Devengo del repercutido al **cobro** y
  deducción del soportado al **pago**, con límite el **31 de diciembre del año
  inmediato posterior** (art. 163 *terdecies*). Al facturar, `4778` en vez de
  `477`; al cobrar, `4778 → 477`. Al recibir, `4728`; al pagar, `4728 → 472`.
  **El destinatario en régimen general de un proveedor RECC también difiere**
  (`Counterparty.ivaRegime`). **Cobro parcial** (O-15):
  `cuotaDevengada = trunc(cobro × cuotaTotal / totalFactura)` con **residuo al
  último cobro**, y CHECK de que `Σ devengadas = cuota total` al saldar o al
  31/12 del año siguiente. *(Ejemplo del experto: base 1 000 000, IVA 210 000,
  cobro 500 000 ⇒ `4778 (D) 86 776 / 477 (H) 86 776`.)* El **barrido del 31/12**
  es **T-36**, no un aviso: es una regla determinista del art. 163 *terdecies*.
  El libro registro incorpora las columnas de **fechas e importes de cobro/pago y
  medio empleado** (arts. 61 *decies* y *undecies* RIVA), o el libro no cumple.
- **R-IVA-20** **REDEME**: `periodKind = MENSUAL`. El SII queda fuera del producto
  v1 y **se declara en pantalla** al activar el régimen.

**Los puentes al 303, reformulados (O-14).** El libro de emitidas anota la
factura **en su expedición** por la cuota íntegra, mientras que bajo RECC `477`
sólo recoge lo cobrado: I-E8-15c e I-E9-8a **fallaban por diseño** en toda
organización acogida y en la de su cliente. Un invariante que falla por hacer lo
correcto es peor que no tenerlo (lección N-1 de E7, otra vez):

| Invariante | Enunciado corregido |
|---|---|
| **I-E8-15a′** | `Σ 472 + Σ 4728 = Σ` cuota **deducible** del libro de recibidas del periodo |
| **I-E8-15c′** | `Σ 477 + Σ 4778 = Σ` cuota **repercutida** del libro de emitidas **+** devengada por ISP/AIB de recibidas |
| **I-E9-8a′** | Resultado del periodo = `Σ 477` **efectivamente devengado** − `Σ 472` **efectivamente deducible**; tras T-23, `472` y `477` del periodo quedan en **0**, pero **`4728` y `4778` conservan saldo y no se barren** |

**El mapa del 303 (O-13).** Tabla de configuración **versionada con vigencia**
(`lib/closing/model303.map.ts`), nunca un `switch`. La cadena 46 → 71 estaba
rota y sin ella el usuario no puede trasladar nada:

| Bloque | Casillas | Origen |
|---|---|---|
| Devengado, régimen general | `01-02-03` · `04-05-06` · `07-08-09` | Emitidas, base y cuota por tipo de `TaxRate` |
| Adquisiciones intracomunitarias | `10` · `11` | Recibidas, `operationKey = AIB` |
| Inversión del sujeto pasivo | `12` · `13` | Recibidas, `operationKey = ISP` |
| Modificación de bases y cuotas | `14` · `15` | Rectificativas de venta (`rectificationDelta` de E8) |
| **Total cuota devengada** | **`27`** | `03+06+09+11+13+15` |
| Interiores corrientes | `28` · `29` | Recibidas corrientes, cuota deducible (incluye la soportada por ISP) |
| Interiores **bienes de inversión** | `30` · `31` | Recibidas de grupo 2 — **se ofrecen**: separarlas no depende del art. 107 |
| Importaciones corrientes | `32` · `33` | `docKind = DUA_IMPORTACION`, base del DUA |
| Importaciones de bienes de inversión | `34` · `35` | DUA sobre grupo 2 |
| AIB corrientes / de inversión | `36-37` · `38-39` | AIB deducible |
| Rectificación de deducciones | `40` · `41` | Rectificativas de compra |
| Regularización bienes de inversión | `43` | **Vacía con motivo**, bajo la guardia de R-IVA-16 |
| Regularización prorrata definitiva | `44` | `prorrataRegularization`, **con signo** |
| **Total a deducir** | **`45`** | `29+31+33+35+37+39+41+43+44` |
| **Resultado régimen general** | **`46`** | `27 − 45` |
| Informativas obligatorias | `59` · `60` · `61` | Emitidas por clave de operación |
| **RECC** (sólo con el régimen activo) | `62`/`63` (art. 75) · `74`/`75` (art. 163 *terdecies*) | Libro con las columnas del art. 61 *decies* |
| **Cadena hasta el resultado** | `64` · `65` · `66` · `67` · `69` · `70` · **`71`** | `71` = importe del asiento T-23 |
| **Diferimiento de importación** | `77` | Sólo con `importDeferral = true` (O-16) |

**No se ofrecen en v1, y la pantalla lo dice**: `16`–`26` (recargo de
equivalencia), `42` (REAGP), `47`–`58` (simplificado), `68` (art. 80.Cinco.5ª).
El **390** queda fuera (§2).

### 4.5 `lib/closing/reclass.ts` — corriente / no corriente

```ts
export type MaturityPosition = {
  accountCode: string; counterpartyId: string | null; currency: string
  dueDate: LocalDate | null; openCents: Cents        // con signo (debe − haber)
  entryNumber: number                                // desempate determinista
}
export function reclassifyMaturities(
  positions: readonly MaturityPosition[], pairs: readonly ReclassPairRef[], cutoff: LocalDate
): { lines: DraftLine[]; moved: ReclassMove[]; unknownMaturity: MaturityPosition[]; blocking: BlockingPosition[] }
```

**R-RC-1…7**:

- **R-RC-1** La frontera se mide **desde el cierre**: «largo» si
  `dueDate > cutoff + thresholdMonths`, «corto» en caso contrario (norma 6ª de
  elaboración de las cuentas anuales). Por eso el mismo saldo viaja 523 → 173 un
  año y 173 → 523 al siguiente.
- **R-RC-2** El asiento es **T-32**, suma cero por par y por contraparte
  (**I-E9-16**).
- **R-RC-3** **FIFO declarado**, con los matices del experto: se aplica **por
  `(cuenta, contraparte, divisa)`** y jamás entre contrapartes; orden por
  `dueDate` ascendente con **desempate por `entryNumber`** (determinismo P7);
  **no se compensan** saldos deudores y acreedores de la misma contraparte en
  cuentas distintas (art. 35.6 CCom) —un proveedor con anticipo en `407` y deuda
  en `400` presenta **las dos** partidas—; y cuando la contraparte tiene
  vencimientos de **onerosidad distinta** (uno con interés implícito reconocido
  por T-31 y otro sin él), FIFO deja de ser neutral y se emite **WARN** listando
  el caso. El Código Civil (arts. 1172–1174) da la regla civil —elige el deudor;
  en su defecto, la deuda **más onerosa**—, que sólo coincide con FIFO cuando
  todos los vencimientos son igualmente onerosos, que es el caso de una cartera
  comercial sin intereses. `SettlementAllocation` explícito es **E10**.
- **R-RC-4** **(O-6) Préstamos: el desglose de vencimientos es obligatorio.** Un
  préstamo entra por **T-37 `ALTA_PRESTAMO`**, que emite **una línea de
  `170`/`520` por vencimiento de principal** tomada de su `DebtSchedule` —el
  mismo patrón que la decisión 6 de E3 §6.6 para facturas a plazos—, con lo que
  la reclasificación funciona sin cambios. Para las deudas ya registradas sin
  desglose, una posición viva de `17x` o `52x` sin vencimientos deja el paso
  `RECLASIFICACION_VENCIMIENTOS` en **FAIL bloqueante** —no WARN, no lista
  informativa— con el mensaje «declare el cuadro de vencimientos de la deuda X»:
  presentar **cero** en «Deudas con entidades de crédito a corto plazo» teniendo
  préstamos vivos es la reclasificación que un auditor comprueba primero y la que
  más veces está mal en una PYME. **I-E9-25.**
- **R-RC-5** Una posición **sin `dueDate`** en cuentas comerciales no se
  reclasifica: sale en `unknownMaturity`, la pantalla la lista y una persona
  decide. Adivinar el vencimiento es inventar fondo de maniobra.
- **R-RC-6** **(O-8) Orden y numeración.** La reclasificación se postea con fecha
  de cierre y **T-27 y T-28 llevan ya los saldos reclasificados** (el balance a
  31/12 es el que se formula). El contra-asiento de T-32 es el asiento **nº 2 de
  N+1**:

  | Orden | Fecha | Asiento | `entryNumber` |
  |---|---|---|---|
  | último de N | 31/12/N | **T-27** con los saldos ya reclasificados | último de N |
  | 1.º de N+1 | 01/01/N+1 | **T-28**, espejo exacto de T-27 | **1** |
  | 2.º de N+1 | 01/01/N+1 | **contra-asiento de T-32** (`reversesEntryId` → T-32) | **2** |

  Posteado **antes** de T-28, el `OPENING` dejaba de ser el nº 1 (N-1 de E3) e
  **I-E9-14** fallaba, porque la apertura reproducía el cierre *desreclasificado*.
- **R-RC-7** **(O-7, R2-1) Veintitrés pares sembrados**, sólo donde ambas cuentas
  existan y sean postables:

  | Bloque | Pares |
  |---|---|
  | Los seis del PGC ya previstos | 170↔520 · 171↔521 · **173↔523** · 174↔524 · 252↔542 · 253↔543 |
  | **Partes vinculadas, cuatro pares** | 160↔510 · 161↔511 · 162↔512 · 163↔513 |
  | Resto de deuda | 172↔522 · 175↔525 · **176↔5595** · **177↔500** · 180↔560 · 185↔561 |
  | Inversiones financieras | 250↔540 · 251↔541 · 254↔544 · 258↔548 · 260↔565 · 265↔566 |

  **Tres precisiones de la re-validación (R2-1)**, que la ronda 1 tenía mal:
  **`176` (otras deudas a largo plazo) va a `5595`** «Otras partidas pendientes de
  aplicación», no a `526` —que es **dividendo activo a pagar** y no tiene nada que
  ver— ni a un genérico `52x`; **`177` (obligaciones y bonos) va a `500`**, que es
  su corto plazo, y faltaba; y **`514` no forma par** —es «Otras deudas a corto
  plazo con partes vinculadas», sin largo plazo simétrico en 16x—, igual que
  **`527` y `528`**, que son intereses a corto plazo de deudas ya reclasificadas y
  **no se reclasifican por sí mismos**: reclasificarlos duplicaría el pasivo
  corriente por el importe de los intereses.

  Sin estos pares no hay error visible: hay un **balance mal clasificado en
  silencio**.

### 4.6 `lib/closing/fx.ts` — diferencias de cambio al cierre

E7 mide (I-E7-12) y **E9 reconoce** (NRV 11ª.2.2). `readFxCloses` de E7 pasa a ser
el caso particular «cuentas 57x» de `readFxPositions`.

```ts
export type FxPosition = {
  accountCode: string; counterpartyId: string | null; currency: string
  baseBalanceCents: Cents        // S = Σ(debe − haber) en moneda base
  currencyBalanceCents: Cents    // D = Σ(debe − haber) en divisa
}
export type ClosingRate = { currency: string; rateMicro: bigint; rateDate: LocalDate }
export function fxClosingAdjustments(
  positions: readonly FxPosition[], rates: readonly ClosingRate[], cutoff: LocalDate, window: number
): { lines: DraftLine[]; byPosition: FxAdjustment[]; missingRates: string[] }
```

**R-FX-1…6**:

- **R-FX-1** **`Δ = convertWithRateMicro(D, r) − S`, y nada más.** Lo ya
  reconocido en 668/768 **está dentro de `S`**, porque el asiento que lo reconoció
  mueve la propia cuenta. Es **N-1** de E7, y el experto confirma que además de
  operativamente correcta es **contablemente** correcta.
- **R-FX-2** **(O-4) Sólo partidas monetarias.** El universo es
  `LedgerAccount.isMonetary = true`, un atributo del plan sembrado desde
  `seeds/npgc.csv`, **no una lista en el motor**. `original_currency IS NOT NULL`
  a secas arrastraba `407` y `438` —anticipos: no dan derecho a recibir ni obligan
  a entregar un importe fijo de efectivo, sino un bien o un servicio— y habría
  inflado o desinflado la PyG por un importe inventado. **I-E9-24.**
- **R-FX-3** El signo se resuelve solo, sin distinguir activo de pasivo: `Δ > 0`
  ⇒ `cuenta (D) / 768 (H)`; `Δ < 0` ⇒ `668 (D) / cuenta (H)`. *(Ejemplo del
  experto: `400` en USD con `D = −500 000`, `S = −460 000`, `r = 0,90` ⇒
  `Δ = +10 000` ⇒ `400 (D) 10 000 / 768 (H) 10 000`: la deuda en euros baja, y
  eso es un beneficio.)*
- **R-FX-4** La línea que mueve la partida lleva `originalCurrency = <divisa>` y
  **`originalAmountCents = 0`**: en la moneda de la cuenta no se mueve nada, y E7
  (ronda 2) ya decidió que un apunte así **no es una partida en tránsito**.
  **I-E9-18.**
- **R-FX-5** **(O-5) Tasa de cierre = la de mayor `rateDate ≤ cutoff`** para el
  par, con la `rateDate` **efectiva sellada en el asiento y visible en pantalla**,
  y **FAIL sólo si no existe ninguna** dentro de una ventana declarada (7 días
  naturales por defecto). «Tipo de cambio de cierre» significa el **vigente** a la
  fecha, y el vigente un domingo es el último publicado: el BCE publica los días
  hábiles TARGET, y exigir `rateDate = corte` dejaba el producto **sin poder
  cerrar los años en que el 31 de diciembre cae en fin de semana** (2028, 2033…),
  que es el único día en que se usa. Es el mismo criterio que ADR-0014 D2 ya
  aplica a la tasa del documento: no se inventa, se usa la publicada y **se dice
  cuál**.
- **R-FX-6** 668/768 son `FINANCIERO`, nivel BAI, CECO `CC-FIN`. **Nunca
  669/769**, que es residuo de tesorería (`lib/fx/convert.ts` ya lo dice).

Tras T-30, **I-E7-12 sale PASS para todas las cuentas** y el motivo
`DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` desaparece: cierra el círculo que E7 dejó
abierto a propósito.

### 4.7 `lib/closing/present-value.ts` — valor actual **como valoración inicial**

**El defecto más caro de la ronda 0 (O-1).** El descuento del aplazamiento **no
es un ajuste de cierre**: la NRV 2ª.1 dice que el precio de adquisición del
inmovilizado, *si el aplazamiento supera el año*, **es el valor actual**, y la
NRV 9ª.3.1 lo replica para el débito. El valor actual **es** el precio de
adquisición desde el primer día; reconocerlo meses después contra resultados
convierte un criterio de valoración en un ajuste de periodo — y, si el activo
lleva diez meses amortizándose sobre el coste bruto, deja `28x` por encima de la
base amortizable y **I-E9-5 en FAIL**.

```ts
export function presentValueCents(nominalCents: Cents, monthlyRateMicroBps: number, months: number): Cents
export function implicitInterestSchedule(
  input: { nominalCents: Cents; presentValueCents: Cents; months: number; monthlyRateMicroBps: number }
): { period: PeriodKey; interestCents: Cents; carryingCents: Cents }[]
export function lateRecognitionPlan(input: LateRecognitionInput): LateRecognitionPlan   // los tres casos
```

**R-VA-1…6**:

- **R-VA-1** El descuento se reconoce **en el alta** (T-03 de E8, con el
  aplazamiento ya conocido). E9 aporta el **plan de corrección** para lo que no se
  hizo:

  | Caso | Tratamiento | Asiento |
  |---|---|---|
  | **A.** Alta del **ejercicio en curso**, cuentas no formuladas | Corrección dentro del ejercicio: reducir el coste, **recalcular el cuadro desde `inServiceDate`** (**no** `AssetRevision`: no es cambio de estimación) y revertir la amortización dotada en exceso | `523/173 (D) descuento / 21x (H) descuento` **y** `281x (D) exceso / 681x (H) exceso` |
  | **B.** Alta de un **ejercicio cerrado** | **Error** de ejercicios anteriores (NRV 22ª): contra reservas en el ejercicio abierto, por **T-22**, y se reexpresa el comparativo | `523/173 (D) / 113 (H)` por el efecto neto acumulado, con desglose en la memoria |
  | **C.** Origen **no inmovilizado** | Al gasto o ingreso original si es del mismo ejercicio; a `113` si es de un ejercicio cerrado | — |

  *(Ejemplo del experto, caso A: nominal 10 000 000 a 24 meses al 6 % efectivo ⇒
  valor actual 8 899 964, descuento 1 100 036; con 10 meses amortizados sobre el
  bruto y vida 60, exceso 183 340; e interés implícito de 10 meses 454 133 a
  `662`.)*
- **R-VA-2** **Sólo** para aplazamientos **> 12 meses** y con
  `|nominal − valor actual| ≥ pvMaterialityCents`. **(O-1)** El umbral **no es un
  número libre**: se deriva de la materialidad de las cuentas (marco conceptual,
  relevancia) y por defecto es el menor entre el **0,5 % del total del activo** del
  ejercicio anterior y un tope declarado; versionado en `AuditLog` y **no
  editable sin motivo**. Un umbral arbitrario es una puerta para no descontar
  nada.
- **R-VA-3** **(O-2) El tipo se declara MENSUAL**
  (`discountRateMonthlyMicroBps`), derivado una sola vez por una persona a partir
  del que le da su entidad y mostrado en pantalla con su equivalente anual.
  `i_m = i_a / 12` sólo vale si `i_a` es un **nominal** (TIN); con el efectivo/TAE
  —que es lo que el usuario tiene a mano— el motor descontaba de más: sobre
  10 000 000 a 24 meses al 6 %, **28 051 céntimos** de diferencia, que con
  tolerancia 0 no son un redondeo. Declararlo mensual elimina la ambigüedad **y**
  la raíz duodécima, y deja el cálculo como una cadena de multiplicaciones
  enteras.
- **R-VA-4** **Aritmética entera en punto fijo base 10⁹**, truncando en cada
  multiplicación y en un orden fijo. Nada de `Math.pow`. Fixture Python con
  `decimal`, comparado byte a byte.
- **R-VA-5** El interés implícito se devenga **periodo a periodo** (misma lógica
  de reversión de R-PE-3), a **`662`** del lado pasivo y **(O-3)** a **`762`
  Ingresos de créditos** del lado activo —un crédito por enajenación de
  inmovilizado a más de doce meses (`253`) también se descuenta y su interés es
  **ingreso**—, los dos `FINANCIERO`, nivel BAI, CECO `CC-FIN`.
- **R-VA-6** **I-E9-19 reformulado**: `descuento inicial = Σ intereses implícitos
  de toda la vida del pasivo`, y a vencimiento el pasivo vale su **nominal**.

### 4.8 `lib/closing/checklist.ts` — los 41 pasos, el orden y la reapertura

**El orden de los asientos (O-17).** El orden de la ronda 0 reclasificaba
**antes** de reconocer el valor actual y las diferencias de cambio: `Σ largo +
Σ corto` seguía cuadrando (I-E9-16 pasaba), pero **el importe clasificado como
corriente o no corriente era erróneo por el importe del ajuste**, que es
justamente lo que la reclasificación existe para evitar. Orden correcto:

| # | Paso | Asiento | Por qué ahí |
|---|---|---|---|
| 1 | Recurrentes al día | T-14, T-16, T-18, `IMPORTE_FIJO` | Son devengo del ejercicio, no ajuste |
| 2 | Devengo RECC del 31-12 del año N−1 | **T-36** (`4778→477`, `4728→472`) | Antes de liquidar el periodo (O-14) |
| 3 | Regularización de prorrata definitiva | `472/639` o `634/472` | **Antes** de T-23 del último periodo (O-11) |
| 4 | Liquidación del último periodo de IVA | **T-23** | Deja 472/477 a cero |
| 5 | Valor actual del aplazamiento | **T-31** | En la divisa del pasivo, **antes** de convertir |
| 6 | Diferencias de cambio | **T-30** | Sobre posiciones ya ajustadas por valor actual |
| 7 | Reclasificación por vencimiento | **T-32** | **Última** de las de balance: importes definitivos |
| 8 | Impuesto sobre beneficios | **T-25** | Después de **todo** movimiento de 6/7 (art. 10.3 LIS) |
| 9 | Regularización del resultado | **T-26** | Barre 6/7, **incluida `6300`**, contra `129` |
| 10 | Cierre | **T-27** (último de N) | Saldos ya reclasificados |
| 11 | Apertura | **T-28** (nº 1 de N+1) | Espejo exacto (I-E9-14) |
| 12 | Contra-asiento de la reclasificación | T-21 de T-32 (nº 2 de N+1) | O-8 |

**El checklist (O-29): 41 pasos en nueve bloques.** `ClosingStep` pasa de
dieciséis a cuarenta y uno; **(✓)** ya estaba, **(+)** lo añade la ronda 1.

| Bloque | Pasos |
|---|---|
| **Integridad del diario** | ✓ `INVARIANTES_PASS` · ✓ `SIN_RUNS_FAIL` · ✓ `SIN_DOCUMENTOS_PROPOSED` · ✓ `ALMACEN_BARRIDO` · ✓ `EJERCICIO_COMPLETO` · **+** `SUMAS_SALDOS_MENSUALES` (I-E7-17, art. 28.1 CCom) · **+** `CUENTAS_PUENTE_A_CERO` (I-E7-16: `555`, `551`, `4749`) · **+** `SALDOS_CONTRA_NATURALEZA` (I-E7-15) |
| **Tesorería** | ✓ `CONCILIACION_BANCARIA` · **+** `ARQUEO_DE_CAJA` · **+** `CONFIRMACIONES_BANCARIAS` |
| **Devengo** | ✓ `RECURRENTES_AL_DIA` · ✓ `AMORTIZACION_AL_DIA` · ✓ `PERIODIFICACIONES_AL_DIA` · **+** `FACTURAS_PENDIENTES_DE_RECIBIR` (`4009`/`410`) · **+** `INGRESOS_NO_FACTURADOS` (`4309`) · **+** `EXISTENCIAS_OBRA_EN_CURSO` (`33x`, `61x`/`71x`) · **+** `SUBVENCIONES_IMPUTADAS` (`746`/`130`) |
| **Valoración** | ✓ `DIFERENCIAS_DE_CAMBIO` · ✓ `VALOR_ACTUAL_APLAZAMIENTO` · **+** `DETERIORO_CREDITOS` (`694`/`490`, con el art. 13.1 LIS de seis meses como referencia fiscal) · **+** `DETERIORO_INMOVILIZADO` (`691`/`291`) · **+** `PROVISIONES` (`14x`) |
| **Presentación** | ✓ `RECLASIFICACION_VENCIMIENTOS` · **+** `NO_COMPENSACION` (art. 35.6 CCom) · **+** `PERIODO_MEDIO_DE_PAGO` (art. 262 LSC, Ley 15/2010) |
| **Fiscal** | ✓ `IVA_LIQUIDADO` · ✓ `RETENCIONES_LIQUIDADAS` (111/115/123 por subcuenta, O-27) · **+** `PRORRATA_DEFINITIVA` · **+** `BIENES_DE_INVERSION` (guardia de R-IVA-16) · **+** `RECC_DEVENGADO_31_12` · **+** `PAGOS_FRACCIONADOS_CONCILIADOS` (`473`) · **+** `DECLARACIONES_INFORMATIVAS` (347, 349, 190, 390 — fuera del producto, el paso existe) |
| **Impuesto** | ✓ `IMPUESTO_BENEFICIOS` · **+** `IMPUESTO_DIFERIDO_RESPONDIDO` |
| **Societario** | ✓ `CIERRE_APERTURA` · **+** `LEGALIZACION_LIBROS` (art. 27 CCom, cuatro meses) · **+** `FORMULACION` (art. 253 LSC, tres meses) · **+** `JUNTA_GENERAL` (art. 164 LSC, seis meses) · **+** `DISTRIBUCION_RESULTADO` (O-18) · **+** `DEPOSITO_CUENTAS` (art. 279 LSC) |
| **Analítica** | ✓ `LIQUIDACION_CECOS` · ✓ `I4_I5_PASS` |

**Bloqueantes (nueve)**: `INVARIANTES_PASS`, `SIN_RUNS_FAIL`,
`SIN_DOCUMENTOS_PROPOSED`, `IVA_LIQUIDADO`, **`PRORRATA_DEFINITIVA`**,
**`BIENES_DE_INVERSION`**, **`RECC_DEVENGADO_31_12`**, `DIFERENCIAS_DE_CAMBIO` y
**`RECLASIFICACION_VENCIMIENTOS`** (O-6). Los societarios posteriores al cierre
nacen `NA` y se completan después. El resto es `WARN` que **mueve el sello**.

```ts
export function closingChecklist(input: ClosingInput, refDate: LocalDate): ClosingStepResult[]
export function closingSeal(steps: readonly ClosingStepResult[]): { seal: Seal; reasons: ClosingSealReason[] }
```

La lección **H-4** de E7 se aplica literalmente: `closingSeal` se calcula
**después** de componer los motivos, y `seal` y `sealReasons` dicen lo mismo.
Motivos nuevos: `IVA_NO_LIQUIDADO`, `RECURRENTES_PENDIENTES`,
`PERIODIFICACION_SIN_AGOTAR`, `VENCIMIENTOS_SIN_FECHA`, `CIERRE_REABIERTO`,
**`REGULARIZACION_BIENES_INVERSION_PENDIENTE`** (O-12),
**`IMPUESTO_DIFERIDO_NO_RECONOCIDO`** (O-26), **`DEUDA_SIN_DESGLOSE`** (O-6),
**`RESULTADO_SIN_DISTRIBUIR`** (O-18) y **`MODELO_200_PRESENTADO`** (Q-1.2).

**Reapertura (D1), corregida por O-20 y O-21.**

1. Exige `status = CLOSED`, `accountsApprovalStatus = BORRADOR`, rol **ADMIN**,
   motivo ≥ 30 caracteres y confirmación escribiendo el código del ejercicio.
2. Con las cuentas **FORMULADAS** o posteriores, se rechaza — pero **el mensaje
   no dice «imposible»**, sino *«requiere acuerdo de reformulación (NRV 23ª);
   regístrelo y vuelva a marcar el ejercicio como BORRADOR»*: **si el producto no
   ofrece salida, el usuario la fabricará por SQL**.
3. **(Q-1.2)** Si `taxFilingStatus ≠ NO_PRESENTADO`, aviso obligatorio de que
   reabrir obliga a autoliquidación complementaria o rectificativa (art. 122
   LGT), recogido en `AuditLog`.
4. **(O-21)** Revierte por contra-asiento, en orden inverso, **T-28 → T-27 →
   T-26 → T-25**. Sin T-25, al recerrar el impuesto se posteaba otra vez y `6300`
   quedaba al doble con `4752` duplicado. Los pasos 5, 6 y 7 **no se revierten**
   —son idempotentes: T-30 recalcula `Δ` sobre una posición ya ajustada y da
   cero, T-32 encuentra los saldos ya reclasificados, los recurrentes chocan
   contra el índice único— y quedan marcados **`PENDIENTE_RECOMPUTO`** para que el
   asistente los reevalúe y **sólo postee delta si lo hay**.
5. **(O-20)** Numeración en términos de **asiento vivo**: `OPENING` no anulado es
   el de menor `entryDate` del ejercicio y `CLOSING` no anulado el de mayor; deja
   de exigirse `entryNumber = 1`. La numeración sigue siendo correlativa y sin
   huecos (art. 29.1 CCom) y un contra-asiento **consume su número** (N-4). Sin
   esto, el nuevo T-28 recibía `entryNumber = 4` y **el cierre nuevo se bloqueaba
   a sí mismo**.
6. Reabrir N con **N+1 ya cerrado** es **bloqueante**: hay que reabrir antes N+1.
   El asistente lista además los asientos de N+1 posteriores a la apertura y exige
   una segunda confirmación.
7. `ClosingRun.status = REABIERTO`, sello `REQUIERE_REVISION` con
   `CIERRE_REABIERTO` hasta el cierre nuevo. **I-E9-21** verifica que el saldo de
   **cada cuenta de los grupos 1 a 7** vuelve al previo al cierre y que
   **`129 = 0` y `6300 = 0`**.

### 4.9 `lib/closing/distribution.ts` — distribución del resultado (O-18)

Sin ella, `129` se arrastra indefinidamente, el balance muestra «Resultado del
ejercicio» de un año que ya pasó, la **reserva legal nunca se dota** y el
dividendo nunca se registra: el patrimonio neto es incorrecto **desde el segundo
ejercicio**. Es una omisión de ciclo.

```ts
/** **R2-2.** El capital sale del DIARIO: saldo acreedor de `100` a la fecha de la
 *  junta. `source: "DIARIO" | "DECLARADO"` viaja con él y `DECLARADO` deja el
 *  paso en WARN — nunca se teclea una cifra de balance (ADR-0003). */
export type CapitalStock = { cents: Cents; source: "DIARIO" | "DECLARADO"; accountCode: string | null }
export function capitalStockOf(balances: ReadonlyMap<string, Cents>, override: Cents | null): CapitalStock
export function legalReserveCents(input: { profitCents: Cents; capital: CapitalStock; currentReserveCents: Cents }): Cents
export function distributionLines(input: ProfitDistributionInput, ctx: LedgerContext): Result<DraftLine[]>
```

| Destino | Cuenta | Regla |
|---|---|---|
| Reserva legal | `112` | `min(trunc(0,10 × beneficio), 0,20 × capital − saldo actual)` — **art. 274 LSC. Obligatoria y calculada**, no propuesta ni editable a la baja. **(R2-2)** El capital es el **saldo acreedor de `100`** a la fecha de la junta; con `capitalStockOverrideCents`, el paso sale **WARN** (`CAPITAL_SOCIAL_DECLARADO`) enseñando las dos cifras |
| Reservas voluntarias | `113` | Lo que la junta acuerde |
| Remanente | `120` | Lo no aplicado |
| Dividendo | `526` | Sólo con beneficio distribuible (art. 273 LSC: reservas indisponibles y gastos de I+D cubiertos) |
| **Dividendo a cuenta ya satisfecho** | `557` | Cuenta **deudora** que minoró el PN durante el ejercicio; se **cancela** en esta distribución contra el resultado |
| Pérdida | `121` | `121 (D) / 129 (H)` |

*(Ejemplo del experto: beneficio 1 497 322, capital 3 000 000, `112` previa
400 000 ⇒ dotación `min(149 732; 200 000) = 149 732`; dividendo 500 000 ⇒ `129 (D)
1 497 322 / 112 (H) 149 732 / 113 (H) 847 590 / 526 (H) 500 000`.)* Al pagarlo:
`526 (D) / 4751-123 (H) retención 19 % (art. 101 LIRPF) / 572 (H)`.

Es **T-35**, disparado por `setAccountsApprovalAction` al marcar **`APROBADAS`**,
con la **fecha de la junta** (art. 164 LSC), rol ADMIN, propuesta editable salvo
la reserva legal, y `AuditLog`. Se postea en el **ejercicio abierto**, no en el
cerrado. **I-E9-23.**

### 4.10 Qué se toca del motor existente (y qué no)

| Pieza | Cambio | Nivel |
|---|---|---|
| `models/fiscal-years.ts` · `closeFiscalYear` | Se **envuelve**: los seis pasos actuales quedan al final y E9 antepone los pasos 1–8 de O-17 y el checklist. Sigue siendo **una transacción** | 2 |
| `lib/ledger/templates/` | **Nueve plantillas nuevas** (T-29…T-37); `TEMPLATE_CODES` a **37** e I-E3-5 a **37/37** | 2 |
| **T-08 / T-09** | Bloque RECC de devengo/deducción proporcional al cobro o pago (O-15) | 2 |
| **T-25** | Cuenta **`6300`** (no `630`) y **cancelación obligatoria de `473`** por retenciones soportadas y pagos fraccionados (O-26): sin ella, activo y pasivo quedaban simultáneamente sobrevalorados por el mismo importe | 2 |
| `lib/ledger/invariants-e8.ts` · `quarterOf` | **No se toca**; `vatPeriodOf` lo llama para `TRIMESTRAL`. **I-E8-15a/c pasan a 15a′/15c′** (O-14) | 2 |
| `models/bank.ts` · `readFxCloses` | Se generaliza a `readFxPositions` en `models/closing.ts`, acotado por `isMonetary`; `readFxCloses` sigue alimentando I-E7-12 | 2 |
| `lib/ledger/tax.ts` · `deducible()` | **No se toca**: la prorrata del periodo sigue siendo la provisional | — |
| `lib/analytics/allocate.ts` · `hamilton()` | **No se usa** en E9 (R-AM-2), y el docblock del reparto nuevo explica por qué | 1 |
| `lib/ledger/post.ts`, `void.ts`, `hash.ts` | **Nada.** El cierre no necesita un camino de escritura propio | — |

---

## 5. Capa de aplicación

### 5.1 Modelos (IO y tenant; no calculan nada)

`models/{recurring,assets,accruals,debt,vat,closing,distribution}.ts`. Todos por
`tenantDb`/`tenantTransaction`, **lecturas en serie** dentro de la transacción de
la petición (regla de E6-perf), agregados en SQL y sin N+1.

| Función | Qué lee |
|---|---|
| `readRecurringDue(tx, refDate)` | Reglas activas + claves de ocurrencia ya generadas, en **una** consulta con `LEFT JOIN LATERAL` |
| `readAssetsWithRevisions(tx, opts)` | Activos, revisiones y **las líneas de `68x`/`28x` por `fixed_asset_id`** (O-19), para I-E9-5 y el drill-down |
| `readVatBook(tx, { period })` | El libro registro de E8 agrupado por `iva_period` (**index scan** por la columna nueva) + saldos de 472/477/**4728/4778** |
| `readProrrataTerms(tx, { year })` | Libro de emitidas del año con su **clave de operación**, para O-10 |
| `readCapitalGoods(tx, { window })` | Altas de grupo 2 con `isCapitalGood` y su prorrata de adquisición, para la guardia de O-12 |
| `readFxPositions(tx, { cutoff, baseCurrency })` | Posiciones por `(cuenta, contraparte, divisa)` **filtradas por `LedgerAccount.isMonetary`** (O-4) |
| `readMaturityPositions(tx, { cutoff, pairs })` | Saldo vivo por `(cuenta, contraparte, divisa)` y sus `dueDate`, más las **posiciones de `17x`/`52x` sin desglose** (O-6) |
| `readClosingInput(tx, { fiscalYearId, refDate })` | **Todo** lo que los 41 pasos necesitan, en una sola transacción |

### 5.2 Server actions

`app/(app)/ledger/{recurring,closing}/actions.ts`, `app/(app)/reports/vat/actions.ts`,
`app/(app)/settings/{assets,periods}/actions.ts`. Toda acción empieza por
`requireOrg(minRole)` y valida con zod de
`forms/{recurring,assets,vat,closing,debt}.ts`.

| Acción | Rol | Notas |
|---|---|---|
| `createRecurringAction` / `updateRecurringAction` / `pauseRecurringAction` | EDITOR | `templateInput` validado con el schema de su plantilla |
| `generateOccurrencesAction({ upToPeriod, dryRun })` | EDITOR | `dryRun` previsualiza **con el mismo código** que postea. Lote grande por `ai/queue.ts` + `Progress`/SSE |
| `revertOccurrenceAction` | ADMIN | Contra-asiento + motivo; nunca borra la ocurrencia |
| `createAssetAction` / `reviseAssetAction` | EDITOR | La revisión exige motivo y `effectiveFrom` no anterior al último periodo contabilizado |
| `disposeAssetAction` / `sellAssetAction` | ADMIN | **T-33 / T-34** (O-24): dotación previa hasta el mes de baja, `543`/`253` **nunca `430`**, y el aviso del art. 110 LIVA |
| `createDebtScheduleAction` / `postLoanAction` | EDITOR / ADMIN | **T-37** (O-6): una línea de `170`/`520` por vencimiento de principal |
| `settleVatAction({ period })` | **ADMIN** | Recalcula en servidor sobre el `ledgerHash` del momento; si cambió desde la vista previa, **rechaza y lo dice** (§9.3 de E7). **Exige la prorrata del año cerrada** si es el último periodo (O-11) |
| `reverseVatSettlementAction({ period, reason })` | **ADMIN** | Contra-asiento de T-23, `status = REVERTIDA`, libera B-6 |
| `closeProrrataYearAction({ year })` | **ADMIN** | Deriva numerador/denominador (O-10), calcula la definitiva, postea la regularización **antes** de T-23 del último periodo y **fija la provisional de N+1** (O-11) |
| `reccYearEndAction({ year })` | **ADMIN** | **T-36**: barrido del 31/12 del art. 163 *terdecies* |
| `runClosingChecklistAction({ fiscalYearId })` | VIEWER (lectura) | Crea/actualiza el `ClosingRun`. No postea nada |
| `postClosingStepAction({ step })` | **ADMIN** | Postea **un** asiento del cierre, con vista previa obligatoria |
| `closeFiscalYearAction` | **ADMIN** | Exige `ClosingRun` `COMPROBADO` con el **mismo `ledgerHash`** y los nueve bloqueantes en PASS |
| `reopenFiscalYearAction` | **ADMIN** | §4.8, con O-20 y O-21 |
| `setAccountsApprovalAction` | **ADMIN** | FORMULADAS / APROBADAS / DEPOSITADAS con fecha. Al marcar **APROBADAS**, abre el diálogo de **distribución del resultado** (O-18) |
| `distributeProfitAction` | **ADMIN** | **T-35**; la reserva legal la calcula el motor y no es editable a la baja |
| `setTaxFilingStatusAction` | **ADMIN** | Q-1.2 |
| `lockPeriodAction` / `unlockPeriodAction` | ADMIN | `unlock` gana la comprobación **B-8** |

### 5.3 Bloqueo de periodos: B-6, B-7 y B-8

- **B-6** Un `iva_period` con `VatSettlement` `LIQUIDADA` **no admite asientos
  nuevos con líneas de 472/477/4728/4778**. Barrera 1: la server action, con el
  mensaje «el periodo 2026-Q2 está liquidado; registre la factura en el periodo
  corriente o revierta la liquidación». Barrera 2: el trigger de M5. **Doble a
  propósito**, porque el `iva_period` no coincide con `entryDate`: un documento de
  junio recibido en octubre entra en el periodo de octubre y `PeriodLock` no lo ve.
- **B-7** Ejercicio `CLOSED` ⇒ ningún asiento (`journal_entries_period_open`, ya
  existe). T-22 registra en el **abierto**.
- **B-8** Desbloquear un mes de un periodo de IVA liquidado exige **revertir antes
  la liquidación**, con motivo. Desbloquear arrastra los posteriores (B-3).

### 5.4 Las tres deudas de operación que E9 cierra

- **Retención y archivado** (ADR-0015 D3, R12 de E7): `scripts/prune-runs.ts`
  gana `--archive <dir>` (JSON en frío con su `checksHash`) y un `cron` diario en
  `docker-cron-entrypoint.sh`. **Los `File` de extracto no se purgan nunca**
  (art. 30 CCom, art. 26.5 LIS).
- **Rate limit de la cola de extracción** (deuda de E8): techo por organización y
  por minuto en `ai/queue.ts`, configurable por plan, con el rechazo visible en la
  bandeja.
- **`resolveRectifiedEntry`** valida `rectifies.entryId` como uuid en el borde
  (auditor H-9 de E8).

---

## 6. Invariantes

### 6.1 Los que E9 introduce — `lib/closing/invariants-e9.ts`

Mismo contrato que I-E7-* e I-E8-*: **nunca un PASS que no se haya comprobado**;
lo no evaluable sale `INFO` diciendo qué falta. **Tolerancia 0 en todo lo que
compara importes** — y el experto confirma que es **alcanzable**, porque las tres
reglas de reparto de E9 (R-AM-2, R-PE-2, O-15) llevan el residuo a una fila
determinada y **no hay reparto por mayor resto en ningún punto**. No se relaja.

| ID | Invariante | Tol. |
|---|---|---|
| **I-E9-1a** | **Idempotencia**: `(regla, periodo)` único; toda ocurrencia `GENERADA` tiene asiento; ninguna `OMITIDA`/`FALLIDA` sin motivo | — |
| **I-E9-1b** | `inputHash` recomputado sobre la regla vigente coincide, o la evidencia dice qué ocurrencia se generó con otra versión | — |
| **I-E9-2** | Σ asientos recurrentes de amortización de una regla = Σ cuotas del cuadro para esos periodos | 0 |
| **I-E9-3** | `scheduleHashOf(depreciationSchedule(activo, revisiones)) = FixedAsset.scheduleHash` | — |
| **I-E9-4** ⟳ | **(O-28)** `Σ cuotas del cuadro vigente = coste + Σ mejoras capitalizadas − valor residual vigente`; ninguna cuota negativa; **la última es la que cuadra** | 0 |
| **I-E9-5** ⟳ | **(O-19) Amortización acumulada = Σ 68x histórica, POR ACTIVO**, vía `journal_lines.fixed_asset_id`; y `28x` del activo ≤ base amortizable. Sin atribución, **`INFO` nombrando los activos sin ella**, jamás PASS por agregado | 0 |
| **I-E9-6** | Todo `Accrual` con `periodEnd ≤ corte` tiene Σ devengado = total y saldo imputable **0** | 0 |
| **I-E9-7** | Σ saldos de 480/485/567/568 = Σ pendiente de devengo de los `Accrual` vivos | 0 |
| **I-E9-8a′** | **(O-14)** Resultado del periodo = `Σ 477` efectivamente devengado − `Σ 472` efectivamente deducible; tras T-23, `472` y `477` del periodo en **0**, y **`4728`/`4778` conservan saldo** | 0 |
| **I-E9-8b** | El `iva_period` persistido = `app.iva_period(...)` recomputado, para toda línea de 472/477/4728/4778 | — |
| **I-E9-9** | La liquidación es reproducible: recomputar `vatSettlement` da el mismo asiento **línea a línea**; `resultCents` y `carryForwardCents` coinciden con él | 0 |
| **I-E9-10** ⟳ | **(O-9/O-10) Prorrata**: `definitiveBps` recomputada = la sellada, múltiplo de 100; numerador y denominador derivados del libro con las exclusiones **marcadas**; ajuste = `trunc(prorrateable × definitiva) − trunc(prorrateable × provisional)` | 0 |
| **I-E9-10b** ✚ | **(O-11)** El asiento de regularización tiene `ivaPeriod` = **último periodo del año** y se postea **antes** de su T-23; `adjustmentCents` = movimiento neto de 634/639 = componente de `472` de ese asiento; y `provisionalBps(N+1) = definitiveBps(N)` | 0 |
| **I-E9-11** | Ningún asiento con línea de 472/477/4728/4778 en un `iva_period` liquidado | — |
| **I-E9-12** | Tras T-26, **todas** las cuentas de grupo 6 y 7 —**`6300` incluida**— quedan a **0** | 0 |
| **I-E9-13** | `129` tras T-26 = I3 del ejercicio | 0 |
| **I-E9-14** | **Apertura = cierre línea a línea**, cuenta a cuenta, con los saldos **ya reclasificados** (O-8) | 0 |
| **I-E9-15** | Ningún asiento en un ejercicio `CLOSED` posterior a su `closedAt`, salvo los contra-asientos de una reapertura registrada | — |
| **I-E9-16** ⟳ | **Reclasificación**: `Σ largo + Σ corto` por contraparte no cambia; **y además** —lo que faltaba— toda posición reclasificada **tiene `dueDate`**, y **ninguna posición con `dueDate ≤ corte + threshold` quedó en la cuenta de largo** | 0 |
| **I-E9-17** ⟳ | **(O-4/O-5) Diferencias de cambio**: para toda posición **monetaria** en divisa, `D × r − S = 0` tras T-30, con `r` = la tasa de mayor `rateDate ≤ corte` **sellada en el asiento** | 0 |
| **I-E9-18** | El asiento de diferencias de cambio no mueve ninguna posición **en divisa**: `Σ originalAmountCents` de sus líneas = 0 por divisa | 0 |
| **I-E9-19** ⟳ | **(O-1) Valor actual**: `descuento inicial = Σ intereses implícitos de toda la vida del pasivo`, y a vencimiento el pasivo vale su **nominal** | 0 |
| **I-E9-20** | `ClosingRun` reproducible: `steps` recomputados sobre el mismo `ledgerHash`+`configHash` dan el mismo veredicto; un ejercicio `CLOSED` tiene exactamente un `ClosingRun` `CERRADO` | — |
| **I-E9-21** ⟳ | **(O-21) Reapertura**: existen los **cuatro** contra-asientos (T-28, T-27, T-26, **T-25**) y el saldo de **cada cuenta de los grupos 1 a 7** vuelve al previo al cierre, con **`129 = 0` y `6300 = 0`** | 0 |
| **I-E9-22** ⟳ | **(O-16) DUA**: la base anotada es la del DUA, no la de la factura; **sin diferimiento no genera 477; con diferimiento sí**, y aparece en la casilla 77 | 0 |
| **I-E9-23** ✚ | **(O-18) Distribución**: ningún ejercicio `APROBADAS` conserva saldo en `129` del anterior; `Σ destinos = resultado regularizado`; `112 ≥ min(10 % acumulado, 20 % del capital)`, con el capital **derivado del saldo de `100`** (R2-2) | 0 |
| **I-E9-24** ✚ | **(O-4)** Ninguna línea con `original_currency` de una cuenta **no monetaria** entra en el barrido de diferencias de cambio | — |
| **I-E9-25** ✚ | **(O-6)** Toda posición de `17x`/`52x` viva al cierre tiene desglose de vencimientos, o está declarada por una persona con motivo | — |
| **I-E9-26** ✚ | **(O-14/O-15) RECC**: ninguna factura del año N−1 conserva saldo en `4778`/`4728` después del 31/12 de N; y `Σ` cuotas devengadas por cobros parciales = cuota total al saldar | 0 |

⟳ corregido en la ronda 1 · ✚ nuevo en la ronda 1.

### 6.2 Los que E9 puede romper

| Invariante | Riesgo | Prueba |
|---|---|---|
| **I1** | Un cuadro que no cuadra, o un asiento de importe cero (O-22) | El trigger diferido y C-1 lo impiden; **R-REC-8** lo evita y I-E9-4 lo caza antes |
| **I3** | 668/768, 634/639, 671/771, **6300** y 662/762 son líneas 6/7 | Criterio 12: I3 varía **exactamente** en esos importes |
| **I4** | Líneas 6/7 nuevas sin destino analítico | R-AM-10, R-PE-5, R-FX-6, R-VA-5. Criterio 13 |
| **I6** | T-30 mueve 57x **sin flujo de caja** | Bucket `null`: una diferencia de cambio no es un cobro. Criterio 14: Δ57x idéntico |
| **I8** | Ocurrencia con fecha futura | R-REC-1 |
| **I-E3-5** | El catálogo pasa de 28 a **37** plantillas | El fixture las cubre 37/37 |
| **N-1 / N-5** de E3 | La reapertura rompía la posición absoluta de `OPENING`/`CLOSING` | **O-20**: N-1′/N-5′ en términos de asiento vivo, M6 |
| **I-E7-1** | La línea de 768 en una 57x en divisa | Ya resuelto en E7 ronda 2; I-E9-18 lo mantiene |
| **I-E7-12** | Debe pasar de WARN a **PASS** tras T-30 | Criterio 15 |
| **I-E8-15a/c** | **RECC los rompía por diseño** | **O-14**: pasan a **15a′/15c′** con `4728`/`4778`. Criterio 8b |
| **I-E8-17** | `4751` agregada impide repartir por modelo | **O-27**: subcuentas 111/115/123 |

### 6.3 Lugar en el sello

Los I-E9-* entran en `runLedgerInvariants` y por tanto en `InvariantRun`, en
`ReportRun.validation` y en `/audit`, en una familia nueva de `CheckFamily`:
**`CIERRE`**. Los diez motivos de §4.8 entran en `seal()` por `closingReasons`,
**igual que los cuatro de E7 y los seis de E8** (lección H-4).

---

## 7. UI

| Ruta | Contenido | VIEWER |
|---|---|---|
| **`/ledger/closing`** | **Asistente paso a paso.** Cabecera con ejercicio, `refDate`, los cuatro sellos y el estado del `ClosingRun`. Los **41 pasos agrupados en nueve bloques** con semáforo, evidencia y **drill-down ≤ 3 clics**; los nueve bloqueantes marcados. Cada paso con asiento ofrece **vista previa** antes de postear, en el orden de O-17. Al cerrar, resumen de los doce asientos y sello. **«Reabrir»** aparte, en rojo, con motivo, confirmación escribiendo el código, aviso del modelo 200 si procede y, con las cuentas formuladas, el mensaje que **ofrece salida** («requiere acuerdo de reformulación…») en vez de decir «imposible» | Todo, sin botones |
| **`/ledger/recurring`** | Reglas y **calendario** de 12 columnas × N reglas, con el estado por celda (generada · pendiente · **omitida con motivo, `CUOTA_CERO` incluido** · fallida). «Generar pendientes hasta [periodo]» con vista previa del lote y progreso. Pestaña **Periodificaciones** con los `Accrual` vivos, su cuadro, su pendiente y el **WARN de 567/568** con principal decreciente (O-25) | Sin botones |
| **`/settings/assets`** | Activos con coste, acumulada, VNC y estado. Ficha: cuadro mes a mes **con enlace al asiento de cada periodo** (posible gracias a `fixed_asset_id`, O-19), revisiones con motivo, alta desde un documento de E8, **baja y venta** con su vista previa y el **aviso del art. 110 LIVA**. Al dar de alta, **sugerencia** de coeficiente del art. 12.1 LIS con la nota de que la amortización fiscal **no se contabiliza** (O-23). Aviso si el cuadro sellado no explica los asientos (I-E9-3 FAIL) | Sin botones |
| **`/settings/debt`** | **(O-6)** Préstamos y aplazamientos con su cuadro de vencimientos; alta por T-37; lista de deudas **sin desglose** que están bloqueando el cierre | Sin botones |
| **`/reports/vat`** | Selector de periodo según el régimen **vigente en esa fecha**. Cuatro pestañas: **Libro registro** (con las columnas de cobro/pago del art. 61 *decies*/*undecies* si hay RECC), **Casillas del 303** (cada casilla con fórmula, importe y origen; las no soportadas, **vacías con el motivo**), **Prorrata** (provisional, definitiva, numerador y denominador con los documentos **sin clasificar** listados, y el ajuste que produciría) y **Liquidaciones** (historial, estado, asiento, reversión). «Liquidar periodo» con vista previa de T-23, el aviso del puente si libro y saldos difieren, y el **bloqueo de la guardia de bienes de inversión** (O-12) | Sin botones |
| **`/settings/periods`** | Rejilla ejercicio × mes con el bloqueo, **el periodo de IVA de cada mes y si está liquidado**, quién y cuándo. B-2 al bloquear, B-3 y **B-8** al desbloquear. Sustituye a la rejilla de `/settings/fiscal-years`, que queda con los ejercicios, su **estado societario** y su **estado fiscal** | Sin botones |
| `/audit` §Cuadres de cierre | Familia **`CIERRE`** con los I-E9-* en lenguaje contable | VIEWER |

Estados vacío / carga / error en las seis pantallas; acciones destructivas con
motivo; español contable; toda cifra con su badge de confianza (P6).

---

## 8. Trazabilidad y provenance

- **Cada asiento de E9 dice de dónde viene**: `sourceType = RECURRING|SYSTEM`,
  `sourceId = "<code>/<period>"`, `templateCode`, `templateVersion`, y la
  ocurrencia / `ClosingRun` / `VatSettlement` / `ProfitDistribution` que lo
  produjo. **Y la línea de amortización dice a qué activo pertenece**
  (`fixed_asset_id`, O-19), que es lo que hace posible la prueba de detalle sobre
  el inmovilizado —el área con más horas de auditoría en este segmento— y el
  drill-down «cuota del cuadro → asiento → documento» en tres clics.
- **Cada cifra derivada lleva su provenance** con la forma canónica de la skill
  `fiabilidad`: `{valor, moneda, metrica, run_id, ledgerHash, calculado_por:
  "lib/closing/vat.ts@<gitSha>", registros_origen, parametros, confianza}`. Vale
  para una casilla del 303 —**con su fórmula**—, una cuota del cuadro y un paso
  del checklist.
- **La tasa de cierre efectiva** (`rateDate` real) se sella en el asiento T-30 y
  se enseña: «valorado al 0,900000 EUR/USD de 29-12-2028» (O-5).
- **Nada se borra.** Anular es contra-asiento; revertir una liquidación es
  contra-asiento; reabrir un ejercicio son **cuatro** contra-asientos.
- **`AuditLog`** en: alta/edición/pausa de regla, generación de lote, alta /
  revisión / **baja y venta** de activo, alta de deuda, liquidación y reversión de
  IVA, cierre de prorrata, **barrido RECC del 31/12**, cada paso posteado, cierre,
  **reapertura con motivo**, cambio de estado societario y **fiscal**,
  **distribución del resultado**, bloqueo/desbloqueo, y cambio de
  `discountRateMonthlyMicroBps`, `pvMaterialityCents`, `capitalStockOverrideCents`,
  `LedgerAccount.isMonetary` (`accounts.is_monetary`) y pares de reclasificación.
- **Prueba de error inyectado** (C4, patrón de E7 §7): alterar por SQL una cuota
  del cuadro ya contabilizada ⇒ **I-E9-5 FAIL nombrando el activo** (posible sólo
  con O-19); alterar `resultCents` de una liquidación sellada ⇒ **I-E9-9 FAIL
  nombrando el periodo**. **No escribe en datos reales**.

---

## 9. Rendimiento

Ocho techos, medidos en `tests/integration/perf-closing.test.ts` sobre el fixture
`ejercicio-completo` **ampliado** (5 000 asientos, 300 activos, 60 reglas, 2 000
documentos, 4 préstamos con cuadro, dos divisas), con las dos métricas de
E6-perf: **ms** y **conexiones simultáneas por petición**.

| Cargador / operación | Techo |
|---|---|
| `/ledger/recurring` (60 reglas × 12 meses) | **< 600 ms** · 1 transacción · ≤ 2 conexiones |
| Lote de **200 ocurrencias** | **< 8 s** por cola con progreso; ninguna transacción > 15 s |
| `depreciationSchedule` de 120 meses | **< 5 ms**; 300 activos **< 400 ms** |
| `/settings/assets` con el cuadro y sus asientos (300 activos) | **< 700 ms** — **exige** el índice `(organization_id, fixed_asset_id)` |
| `/reports/vat` de un trimestre con 2 000 documentos | **< 800 ms** — **exige** `journal_entries.iva_period` indexada; sin ella el puente agrupa en memoria, O(n) sobre el ejercicio |
| `prorrataTerms` sobre el año completo | **< 500 ms**, agregado SQL por clave de operación |
| `runClosingChecklistAction` (los 41 pasos) | **< 2 000 ms** · **una** transacción (`readClosingInput`) |
| `closeFiscalYearAction` completo (doce asientos) | **< 45 s** (el `timeout: 120_000` actual se conserva) |

Agregados en SQL, **nunca** materializar el diario para una cifra; lecturas **en
serie** dentro de la transacción; `readClosingInput` en una consulta por bloque,
sin N+1; el cuadro se calcula **una vez por activo y petición**, memoizado por
transacción.

---

## 10. Seguridad y roles

| Operación | VIEWER | EDITOR | ADMIN |
|---|---|---|---|
| Ver reglas, activos, cuadros, deudas, libro registro, casillas, checklist | ✅ | ✅ | ✅ |
| Crear/editar/pausar reglas, activos, periodificaciones y cuadros de deuda | ❌ | ✅ | ✅ |
| Generar ocurrencias pendientes | ❌ | ✅ | ✅ |
| Revertir ocurrencia · dar de baja o vender un activo | ❌ | ❌ | ✅ |
| Liquidar IVA · revertir liquidación · cerrar prorrata · barrido RECC | ❌ | ❌ | ✅ |
| Postear un paso del cierre · cerrar ejercicio | ❌ | ❌ | ✅ |
| **Reabrir ejercicio** | ❌ | ❌ | ✅ + motivo + confirmación |
| Marcar FORMULADAS/APROBADAS/DEPOSITADAS y el estado fiscal | ❌ | ❌ | ✅ |
| **Distribuir el resultado** | ❌ | ❌ | ✅ |
| Bloquear / desbloquear periodo | ❌ | ❌ | ✅ + motivo |
| Editar tipo de descuento, materialidad, capital declarado, `isMonetary`, pares | ❌ | ❌ | ✅ |

- **RLS**: las **doce** tablas nuevas en `TENANT_MODELS` y con
  `app.enforce_tenant_rls`. `recurring_occurrences` y `asset_revisions`
  **append-only**; `vat_settlements`, `closing_runs` y `profit_distributions`
  **semi-append-only** con `GRANT UPDATE` de columna. `test:integration:rls` tabla
  por tabla: sin GUC, **0 filas** y **42501** al escribir.
- **Sin escapes**: ninguna consulta de negocio fuera de `tenantDb` /
  `tenantTransaction` (ESLint + RLS).
- El `cron` de purga corre como **`app_maintenance`** desde `scripts/`.

---

## 11. Decisiones de Nivel 2 → ADR-0016 (**APROBADO** 2026-09-07, D1–D12)

`docs/adr/0016-cierre-recurrentes-y-fiscalidad-periodica.md` pasa de ocho a
**doce** decisiones y está **APROBADO por Pablo el 2026-09-07** (permiso delegado
de 2026-09-04): las tareas de Nivel 2 quedan desbloqueadas. Resumen; el detalle y
las alternativas descartadas están allí.

| # | Decisión | Estado tras la ronda 1 |
|---|---|---|
| **D1** | Cierre como acto sellado y **reapertura controlada** sólo con las cuentas en `BORRADOR`; numeración por **asiento vivo** (O-20); reversión de **T-25** incluida y pasos 5-7 en `PENDIENTE_RECOMPUTO` (O-21); aviso de modelo 200 presentado; mensaje de rechazo **con salida** | Precisada (O-20, O-21, Q-1) |
| **D2** | Amortización **lineal**, mes entero, residuo a la última cuota, revisión prospectiva, cuadro no almacenado; **cuota cero sin asiento** (O-22); **baja y venta automatizadas** con `543`/`253` (O-24); amortización fiscal fuera del diario (O-23); criterio uniforme escrito (O-30); **`JournalLine.fixedAssetId`** para que I-E9-5 sea computable | Precisada |
| **D3** | Periodificación 480/485/567/568, ACT/ACT con extremos incluidos, residuo a la última fila, reversión periodo a periodo; **567/568 por tipo efectivo** cuando el principal varía (O-25) | Precisada |
| **D4** | **Reescrita**: base del ajuste corregida (O-9), derivación de numerador y denominador (O-10), momento y periodo con **I-E9-10b** (O-11), **guardia bloqueante de bienes de inversión** (O-12), **mapa completo del 303** (O-13), prorrata especial y sectores diferenciados **bloqueados** | **Reescrita** |
| **D5** | **Reescrita**: **desglose de vencimientos obligatorio** con T-37 y FAIL bloqueante (O-6), **23 pares** (O-7, **R2-1**: 176↔5595, 177↔500, cuatro de partes vinculadas sin 514, y 527/528 fuera), contra-asiento como nº 2 de N+1 (O-8), FIFO con los matices del art. 1174 CC y la **no compensación** del art. 35.6 CCom | **Reescrita** |
| **D6** | **Reescrita**: universo **monetario** por **`LedgerAccount.isMonetary`** (O-4, **R2-3**) y **tasa de cierre = último día publicado** dentro de una ventana, sellada y visible (O-5). `Δ = D×r − S` se mantiene | **Reescrita** |
| **D7** | **Reescrita**: el valor actual es **valoración inicial**, con los tres casos de corrección (O-1); tipo **mensual declarado** (O-2); `762` del lado activo (O-3); umbral derivado de la materialidad | **Reescrita** |
| **D8** | **Reescrita**: puentes al 303 con `4728`/`4778` (O-14), **cobro/pago parcial proporcional** (O-15), **diferimiento del IVA a la importación** (O-16), 4728/4778 como **hijas** de 472/477, columnas del art. 61 *decies*/*undecies* | **Reescrita** |
| **D9** ✚ | **Orden de los asientos de cierre** (O-17) y los pasos que faltaban (O-29), más **T-25 con `6300` y cancelación de `473`** (O-26) | **Nueva** |
| **D10** ✚ | **Distribución del resultado** (O-18): `129 → 112/113/120/526`, `121` en pérdidas, `557` cancelado, reserva legal **calculada** con el **capital derivado del saldo de `100`** (**R2-2**; el campo declarado sólo como contingencia, con WARN) | **Nueva** |
| **D11** ✚ | **Atribución de la amortización por activo** (O-19): `JournalLine.fixedAssetId` frente a subcuenta de `28x` por activo | **Nueva** |
| **D12** ✚ | **Subcuentas de retenciones por modelo** (O-27): `4751` → 111 / 115 / 123 por `AccountKey` | **Nueva** |

---

## 12. Criterios de aceptación (Given / When / Then)

1. **Idempotencia.** *Given* una regla mensual activa desde 2026-01, *when* se
   lanzan **dos** generaciones simultáneas hasta 2026-06, *then* hay exactamente
   6 ocurrencias y 6 asientos; la segunda transacción muere contra el índice y no
   deja asiento huérfano.
2. **Regla pausada.** *Then* los periodos pausados quedan `OMITIDA` **con motivo
   visible** y no se rellenan hacia atrás.
3. **Cuota cero (O-22).** *Given* un activo de `20` céntimos y 36 meses, *then*
   **no se genera ningún asiento de importe cero**; 35 ocurrencias quedan
   `OMITIDA` con motivo `CUOTA_CERO`, la última vale `20`, y **Σ cuadro = 20**.
4. **Cuadro byte a byte.** *Then* `depreciationSchedule` reproduce los **ocho**
   casos de `cuadros-esperados.json` byte a byte.
5. **Σ cuadro = base.** *Given* coste 1 000 000, residual 100 000, 7 meses,
   *then* las cuotas suman **900 000** y la última es `128 574` (6 × 128 571 + 3).
6. **Revisión prospectiva.** *Then* los periodos ya contabilizados **no cambian**,
   el nuevo cuadro reparte el VNC entre la vida residual, `scheduleHash` cambia e
   I-E9-3 sigue en PASS. *And* `Σ cuotas = coste + mejoras − residual vigente`
   (I-E9-4 con O-28).
7. **Baja y venta (O-24).** *Given* un activo con acumulada 640 000 sobre coste
   1 000 000, *when* se da de baja, *then* `2811 (D) 640 000 · 671 (D) 360 000 ·
   2131 (H) 1 000 000`; *and when* se vende por 500 000 + IVA, *then* la
   contrapartida es **`543`, no `430`**, el beneficio son 140 000 en `771`, y la
   pantalla muestra el aviso del art. 110 LIVA si es bien de inversión.
8. **Atribución por activo (O-19).** *Then* toda línea de `68x`/`28x` lleva
   `fixed_asset_id`, I-E9-5 se evalúa **por activo**, y un activo sobreamortizado
   compensado por otro infraamortizado **sale FAIL** (con la evaluación por
   agregado salía PASS).
9. **Periodificación por días.** *Given* una prima de 100 000 del 15-11-2026 al
   14-11-2027, *then* 2026 = **12 876** y 2027 = **87 124**, `480` a **0** exacto.
10. **567/568 (O-25).** *Given* un `Accrual` de intereses con principal
    decreciente y `basis = DIAS`, *then* se emite **WARN** con la desviación
    estimada; con `basis = TIPO_EFECTIVO` y su `DebtSchedule`, el devengo sale del
    cuadro.
11. **Liquidación desde el libro.** *Then* T-23 deja 472 y 477 del periodo a
    **0**, e I-E8-15a′/b/c′ e I-E9-8a′ siguen en PASS.
12. **El libro manda.** *Given* una alteración por SQL de la cuota de un asiento,
    *then* la liquidación **no se postea**, se muestra la diferencia documento a
    documento e I-E9-9 lo delata.
13. **Prorrata: base correcta (O-9).** *Given* `cuotaProrrateable = 100 000`,
    provisional 8 000 bps, numerador 8 700 000 y denominador 10 000 000, *then*
    `definitivaBps = 8 700` y el ajuste es **+7 000** (no 5 600); asiento
    `472 (D) 7 000 / 639 (H) 7 000`. *And given* definitiva 7 500 bps, *then*
    `634 (D) 5 000 / 472 (H) 5 000`. *And given* numerador 8 700 001, *then*
    `8 800` bps (redondeo al alza, art. 104.Dos.2ª).
14. **Prorrata: derivación y momento (O-10, O-11).** *Given* documentos del año
    sin clave de operación, *then* el resultado es **`INFO` con su lista** y
    **nunca un porcentaje**. *And then* el asiento de regularización tiene
    `ivaPeriod` = último periodo, se postea **antes** de su T-23, y la provisional
    de N+1 queda fijada = definitiva de N (**I-E9-10b**).
15. **Bienes de inversión (O-12).** *Given* prorrata 85 % en N, un alta de grupo 2
    de 400 000 c en N−2 con prorrata 97 %, *then* `PRORRATA_DEFINITIVA` sale
    **FAIL bloqueante**, la liquidación del último periodo **no se postea** y el
    sello lleva `REGULARIZACION_BIENES_INVERSION_PENDIENTE`.
16. **Mapa del 303 (O-13).** *Then* la cadena **27 → 45 → 46 → 64 → 66 → 67 → 69
    → 70 → 71** está completa y `casilla 71 = importe del asiento T-23`; las
    casillas 16-26, 42, 47-58 y 68 **no se ofrecen** y la pantalla dice por qué.
17. **RECC (O-14, O-15).** *Given* una organización en RECC con una factura de
    base 1 000 000 e IVA 210 000, *when* cobra 500 000, *then*
    `4778 (D) 86 776 / 477 (H) 86 776`; *and then* **I-E8-15c′** (`Σ477 + Σ4778`)
    sigue en **PASS** —con el enunciado anterior daba FAIL por hacer lo
    correcto—; *and when* llega el 31/12 de N, *then* **T-36** devenga lo
    pendiente de N−1 e **I-E9-26** queda en PASS. *And* un destinatario en régimen
    general de un proveedor RECC difiere su deducción.
18. **DUA (O-16).** *Given* base DUA 12 000 000, aranceles 500 000 y cuota
    2 520 000, *then* sin diferimiento el asiento **no lleva 477**; *and given*
    `importDeferral = true` con periodo mensual, *then* **sí** lleva `477` por
    2 520 000 y aparecen las casillas **77** y 32-33 (I-E9-22).
19. **Periodo liquidado, cerrado (B-6).** *Then* la acción y el trigger rechazan
    un asiento con `ivaPeriod` liquidado; tras revertir, se admite.
20. **Diferencias de cambio: universo (O-4).** *Given* un anticipo en `407` en
    USD, *then* **no** genera diferencia de cambio (I-E9-24), y una posición de
    `400` en USD **sí**: `D = −500 000`, `S = −460 000`, `r = 0,90` ⇒
    `400 (D) 10 000 / 768 (H) 10 000`.
21. **Tasa de cierre efectiva (O-5).** *Given* un cierre a 31-12-2028 (domingo)
    sin tasa publicada ese día, *then* se usa la del **29-12-2028**, la
    `rateDate` efectiva se **sella y se enseña**, y el cierre **avanza**; *and
    given* ninguna tasa en los 7 días previos, *then* FAIL.
22. **Valor actual como valoración inicial (O-1, O-2).** *Given* el caso A del
    experto (nominal 10 000 000, 24 meses, valor actual 8 899 964, 10 meses
    amortizados sobre el bruto), *then* el plan de corrección reduce el coste
    (`173 (D) 1 100 036 / 2131 (H)`), **recalcula el cuadro desde `inServiceDate`**
    —no crea una `AssetRevision`—, revierte el exceso (`2813 (D) 183 340 / 6813
    (H)`) y devenga `662` 454 133; *and then* I-E9-5 **no** queda en FAIL. *And
    given* el caso B (ejercicio cerrado), *then* va por **T-22 contra `113`**.
    *And* el tipo se declara **mensual**: con el efectivo anual la diferencia
    serían 28 051 c.
23. **Interés del lado activo (O-3).** *Given* un `253` descontado, *then* su
    interés implícito es **ingreso** en `762`.
24. **Reclasificación suma cero y correcta (O-6, R2-1, I-E9-16).** *Then* se
    siembran **23 pares**, `176` va a **`5595`** y no a `526`, `177` a **`500`**,
    y una posición viva en **`527`/`528` no se mueve**: reclasificarla duplicaría
    el pasivo corriente. *And given* un `523` con
    250 000 a 30-09-2027 y 500 000 a 30-06-2028 y cierre a 31-12-2026, *then* los
    500 000 pasan a `173`, `Σ 523 + Σ 173 = 750 000` antes y después, y **ninguna
    posición con vencimiento ≤ 12 meses queda en la cuenta de largo**.
25. **Préstamo sin desglose (O-6).** *Given* un `170` vivo sin vencimientos,
    *then* `RECLASIFICACION_VENCIMIENTOS` sale **FAIL bloqueante** con el mensaje
    que nombra la deuda, el cierre **no avanza** e **I-E9-25** lo recoge; *and
    when* se declara su `DebtSchedule` y se postea por T-37, *then* pasa a PASS.
26. **Orden y numeración de la apertura (O-8).** *Then* T-27 lleva los saldos
    **ya reclasificados**, T-28 es el `entryNumber = 1` de N+1, el contra-asiento
    de T-32 es el **nº 2**, e I-E9-14 compara cierre y apertura **línea a línea**.
27. **Orden de los ajustes (O-17).** *Given* una posición en divisa que además se
    reclasifica, *then* la reclasificación opera sobre el importe **ya ajustado**
    por valor actual y diferencias de cambio; con el orden de la ronda 0, el
    importe clasificado como corriente difería en el importe del ajuste.
28. **T-25 correcto (O-26).** *Given* base 2 000 000 al 25 %, retenciones 120 000
    y pagos fraccionados 180 000, *then* `6300 (D) 500 000 / 473 (H) 300 000 /
    4752 (H) 200 000`; **`473` queda a cero** y el checklist **pregunta** por
    diferencias temporarias, BIN y deducciones, dejando el sello en
    `REQUIERE_REVISION` con `IMPUESTO_DIFERIDO_NO_RECONOCIDO` si la respuesta es
    afirmativa.
29. **La PyG se mueve exactamente lo que debe.** *Then* I3 varía exactamente en
    `668 − 768 + 634 − 639 + 68x + 662 − 762 + 671 − 771 + 6300`, ni un céntimo
    más; **I4** sigue cuadrando (tolerancia 0) y **Δ57x no cambia** con T-30 (I6).
30. **De WARN a PASS.** *Given* una cuenta en USD con I-E7-12 en WARN, *when* se
    postea T-30, *then* I-E7-12 sale **PASS**, el motivo desaparece y el badge
    `✓ validado contra fuente` **vuelve solo**.
31. **Checklist bloqueante.** *Given* un documento en `PROPOSED`, *then* el paso
    sale FAIL, el botón está deshabilitado **y** `closeFiscalYearAction` lo
    rechaza también en servidor. *And* los **nueve** bloqueantes se comprueban en
    servidor.
32. **El cierre es atómico.** *Given* un fallo inyectado en T-27, *then* la
    transacción entera revierte: no quedan asientos posteados, ni bloqueos, ni el
    ejercicio en `CLOSED` (regresión de BLOQUEA #1 de E3).
33. **Reapertura completa (O-20, O-21).** *Given* un ejercicio cerrado en
    `BORRADOR`, *when* un ADMIN lo reabre, *then* existen los **cuatro**
    contra-asientos (T-28, T-27, T-26, **T-25**), el saldo de cada cuenta de los
    grupos **1 a 7** vuelve al previo, **`129 = 0` y `6300 = 0`**, los pasos 5-7
    quedan `PENDIENTE_RECOMPUTO`, y **al volver a cerrar el impuesto no se
    duplica**. *And then* el nuevo T-28 se acepta aunque su `entryNumber` no sea 1
    (N-1′). *And given* N+1 ya cerrado, *then* la reapertura de N se **bloquea**.
34. **Reapertura prohibida, con salida.** *Given* `accountsApprovalStatus =
    FORMULADAS`, *then* se rechaza citando la LSC, **ofreciendo la vía del acuerdo
    de reformulación**, y el `ledgerHash` no cambia. *And given*
    `taxFilingStatus = PRESENTADO`, *then* el aviso del art. 122 LGT queda en
    `AuditLog`.
35. **Distribución del resultado (O-18, R2-2).** *Given* beneficio 1 497 322,
    **saldo acreedor de `100` = 3 000 000** —derivado del diario, no tecleado— y
    `112` previa 400 000, *when* se marca `APROBADAS` con la fecha de
    la junta, *then* T-35 dota **149 732** de reserva legal (calculada, no
    editable a la baja), 847 590 a `113` y 500 000 a `526`; `129` queda a **0**
    (**I-E9-23**), y al pagar el dividendo se retiene el 19 % contra `4751-123`.
    *And given* un plan **sin `100` postable** y `capitalStockOverrideCents`
    declarado, *then* la reserva legal se calcula igual pero el paso sale **WARN**
    con `CAPITAL_SOCIAL_DECLARADO` y las dos cifras a la vista.
    *And given* pérdida, *then* `121 (D) / 129 (H)`.
36. **Ejercicio cerrado, mudo.** *Then* ningún asiento en un ejercicio `CLOSED`
    posterior a su `closedAt` (I-E9-15); lo tardío entra por T-22.
37. **Error inyectado.** *Then* alterar una cuota del cuadro ya contabilizada da
    **I-E9-5 FAIL nombrando el activo**, y alterar `resultCents` de una
    liquidación sellada da **I-E9-9 FAIL nombrando el periodo**. La prueba desde
    la UI **no escribe**.
38. **Multi-tenant.** *Then* ninguna de las **doce** tablas nuevas devuelve fila
    sin GUC, y escribir da **42501**.
39. **Rendimiento.** *Then* los ocho techos de §9 se cumplen; `/reports/vat` y
    `/settings/assets` abren **una** transacción.
40. **VIEWER.** *Then* ve las seis pantallas completas y **ningún** botón; las
    acciones rechazan sus intentos con 403.

---

## 13. Plan de tareas

Con **ADR-0016 APROBADO** (2026-09-07), **todas** las tareas están desbloqueadas.
Se conserva la marca **▶** de §6 de la validación: son las que el experto ya
autorizaba antes de la firma y las que arrancan la ola A.

| # | Tarea | Depende de | Agente | Nivel | h |
|---|---|---|---|---|---:|
| **T1** | ~~Validación contable~~ · **HECHA**: `E9-validacion-cierre.md`, **NO CONFORME** con O-1…O-30 y respuestas a Q-1…Q-14 | — | experto-contable | 2 | 16 |
| **T2** | ~~**ADR-0016 (D1–D12) a firma humana**~~ · **HECHA**: **APROBADO** el 2026-09-07 (permiso delegado de 2026-09-04), con D4–D8 reescritas, D9–D12 nuevas y R2-1/R2-2/R2-3 incorporadas. Desbloquea T4, T8, T9, T10, T13 y T14 | T1 | arquitecto | 2 | 12 |
| **T3** ▶ | Prisma: los doce modelos, catorce enums, diecinueve `AccountKey`, nueve `TemplateCode`; **`JournalLine.fixedAssetId`** (O-19), **`LedgerAccount.isMonetary`** (O-4), `VatRegimePeriod.importDeferral` (O-16), columnas de `FiscalYear`/`Organization`/`Counterparty`/`Transaction`; `TENANT_MODELS`; **`lib/closing/**` y `lib/recurring/**` en el guard de pureza, ESLint y CI** | — | dev-backend | 2 | 16 |
| **T4** | Migraciones **M1…M6**: enums solos; tablas con FK compuesta y `enforce_tenant_rls`; append-only; `app.iva_period` **IMMUTABLE**, columna, trigger, CHECK y backfill con el baile `NO FORCE`/`FORCE`; `EXCLUDE` de vigencias; índices únicos parciales; siembra de `is_monetary`, de los **23 pares** y de las claves (sólo donde la cuenta exista y sea postable); trigger **B-6**; **M6 numeración viva** (O-20). Tests de integración del SQL | T2, T3 | dev-backend | 2 | 36 |
| **T5** ▶ | `lib/recurring/schedule.ts` (R-REC-1…8, con **R-REC-8/cuota cero**) + tests de determinismo | T3 | dev-backend | 2 | 16 |
| **T6** ▶ | `lib/closing/depreciation.ts` (R-AM-1…10) + `build_cuadros_esperados.py` con los **ocho** casos + test byte a byte | T3 | dev-backend | 2 | 24 |
| **T7** ▶ | `lib/closing/accrual.ts` (R-PE-1…6, con el WARN de 567/568) + fixture Python + test byte a byte | T3 | dev-backend | 2 | 14 |
| **T8** | `lib/closing/vat.ts`: `vatPeriodOf`, `vatSettlement`, **`prorrataTerms`** (O-10), ajuste con la base corregida (O-9), **`capitalGoodsGuard`** (O-12), **RECC con cobro parcial y barrido 31/12** (O-14, O-15), **DUA bifurcado** (O-16) y `model303.map.ts` **completo y versionado** (O-13); puentes **15a′/15c′**; tests con los quince documentos del fixture de E8 | T2, T3 | dev-backend | 2 | 44 |
| **T9** | `lib/closing/{reclass,fx,present-value}.ts`: FIFO con los matices del art. 1174 y la no compensación (R-RC-3), **desglose obligatorio** (O-6), **23 pares** (O-7), orden de reversión (O-8); universo **monetario** (O-4) y **tasa efectiva con ventana** (O-5); **valor actual como valoración inicial con los tres casos** (O-1), tipo mensual (O-2) y `762` (O-3) + fixture Python | T2, T3 | dev-backend | 2 | 38 |
| **T10** | Plantillas **T-29…T-37** + schemas zod + **modificación de T-08/T-09** (bloque RECC) y **T-25** (`6300` y cancelación de `473`, O-26); `TEMPLATE_CODES` a **37** e I-E3-5 a 37/37 | T2, T3 | dev-backend | 2 | 30 |
| **T11** | `lib/closing/invariants-e9.ts` (**I-E9-1…26**, con 10b y los cuatro nuevos, y las seis correcciones ⟳) + `CheckFamily.CIERRE` + los **diez** motivos de sello + cableado en `runLedgerInvariants` y `scripts/run-invariants.ts`; fixtures adversariales | T5–T10 | dev-backend | 2 | 34 |
| **T12** | `models/{recurring,assets,accruals,debt,vat,closing,distribution}.ts`: agregados SQL, `readClosingInput` en una transacción, `readFxPositions` acotado por `is_monetary`, `readMaturityPositions` con las deudas sin desglose, sin N+1, lecturas en serie | T4, T11 | dev-backend | 2 | 30 |
| **T13** | `lib/closing/checklist.ts` con los **41 pasos y nueve bloqueantes** (O-29) + `closeFiscalYear` envuelto con **el orden de O-17** (doce asientos) + `reopenFiscalYear` con **T-25 y `PENDIENTE_RECOMPUTO`** (O-21) y numeración viva (O-20) + `ClosingRun` sellado | T2, T12 | dev-backend | 2 | 30 |
| **T14** | `lib/closing/distribution.ts` + **T-35** + `ProfitDistribution` + `setAccountsApprovalAction` → diálogo de distribución (O-18) | T2, T12 | dev-backend | 2 | 16 |
| **T15** | `forms/*` + las seis `actions.ts`: matriz de roles, recomputo en servidor antes de liquidar y de cerrar, `dryRun` con el mismo código, cola con progreso | T13, T14 | dev-backend | 2 | 26 |
| **T16** | UI **`/ledger/closing`**: asistente con los 41 pasos en nueve bloques, evidencia y drill-down, vista previa por asiento, sello, reapertura con doble confirmación y **mensaje con salida** | T15 | dev-frontend | 1 | 30 |
| **T17** | UI **`/ledger/recurring`** + **`/settings/assets`** (cuadro con enlace al asiento, revisión, **baja y venta** con el aviso del art. 110, sugerencia del art. 12.1 LIS) | T15 | dev-frontend | 1 | 30 |
| **T18** | UI **`/reports/vat`** (libro con columnas RECC, casillas con fórmula y origen, **pestaña Prorrata** con los documentos sin clasificar, liquidaciones) + **`/settings/debt`** (O-6) + **`/settings/periods`** | T15 | dev-frontend | 1 | 34 |
| **T19** | `/audit` gana la familia **CIERRE** | T16 | dev-frontend | 1 | 8 |
| **T20** ▶ | Fixture `ejercicio-completo` **ampliado**: 300 activos (uno con `base < n`, uno revisado, uno vendido), 60 reglas, dos ejercicios encadenados, **4 préstamos con cuadro**, posiciones en divisa **monetarias y no monetarias**, vencimientos a corto y largo, una organización **en RECC** y otra con **prorrata** e inmovilizado | T10 | qa | 1 | 22 |
| **T21** ▶ | Deuda de operación: `prune-runs.ts --archive` + cron + política escrita | T4 | dev-backend | 1 | 10 |
| **T22** ▶ | Deuda de E8: rate limit por organización y minuto en `ai/queue.ts`; `resolveRectifiedEntry` valida uuid; decisión escrita de **no** partir `exchange_rates` | T3 | dev-backend | 1 | 8 |
| **T23** | Integración + RLS: `e9-cierre.test.ts` (criterios 1–37, 39), `e9-tenant.test.ts` (38), `perf-closing.test.ts` (los ocho techos de §9) | T16–T19, T20 | qa | 1 | 38 |
| **T24** | e2e Playwright: regla → generar → asiento · activo → cuadro → asiento del mes · **venta con `543`** · liquidar IVA → casillas → documento · **prorrata definitiva con la guardia de bienes de inversión** · asistente de cierre completo → sello · **reapertura → recierre sin duplicar el IS** · **distribución del resultado** · VIEWER sin botones | T23 | qa | 1 | 28 |
| **T25** | **Auditoría de fiabilidad en contexto limpio**: reconstruir por SQL/Python el cuadro de tres activos (uno revisado), dos liquidaciones, la **prorrata definitiva con la base de O-9**, las diferencias de cambio de dos divisas **excluyendo un anticipo**, la distribución del resultado y el balance de apertura línea a línea; error inyectado (criterio 37) | T23 | qa | 2 | 22 |
| **T26** | Cierre documental: `MODELO-DATOS.md` (bloque E9), `ARQUITECTURA.md`, skills `fiabilidad` (I-E9-*, familia `CIERRE`, los diez motivos, **15a′/15c′**), `pgc-npgc` (T-29…T-37, RECC, prorrata, distribución) y `estados-financieros`; `ESTADO.md` con la deuda heredada **cerrada** y la nueva fechada (**art. 107 bienes de inversión, ajustes extracontables/BIN/diferencias temporarias, `SettlementAllocation`, prorrata especial y sectores diferenciados → E10**); ROADMAP E9 → CERRADA; `runs/registro.jsonl`; ADR-0016 → APROBADO | T24, T25 | arquitecto | 1 | 16 |

**Total: 628 h** (~79 jornadas, 26 tareas; **+136 h sobre la ronda 0**: el valor
actual como valoración inicial con sus tres casos, el mapa completo del 303, RECC
con cobro parcial y barrido, la guardia de bienes de inversión, el desglose de
deuda con T-37, la distribución del resultado, la atribución por activo, la baja
y la venta, y un checklist que pasa de 16 a 41 pasos).

**Camino crítico:** T1 → T2 → T4 → T8/T9 → T10 → T11 → T12 → T13/T14 → T15 →
T16/T18 → T23 → T24/T25 → T26. **En paralelo desde ya** (▶): T3, T5, T6, T7,
T20, T21 y T22. T20 debe estar **antes** de T23.

---

## 14. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | **El cierre queda a medias** y el ejercicio en un estado imposible | Una sola transacción, `abort` y no `return` ante cualquier FAIL (regresión de BLOQUEA #1 de E3, criterio 32) y `ClosingRun` que sólo pasa a `CERRADO` al final |
| **R2** | **La reapertura se convierte en la puerta trasera** que E3 quiso cerrar | Sólo con cuentas en `BORRADOR`, sólo ADMIN, motivo + confirmación, **cuatro** contra-asientos visibles, sello `REQUIERE_REVISION` permanente, e I-E9-21 sobre los grupos 1–7 con `129 = 0` y `6300 = 0` |
| **R3** | **Reabrir y recerrar duplica el impuesto** (O-21) o **bloquea la numeración** (O-20) | T-25 se revierte; los pasos 5-7 quedan `PENDIENTE_RECOMPUTO`; N-1′/N-5′ por asiento vivo, con M6 y el criterio 33 |
| **R4** | **Doble asiento recurrente** por doble clic o dos pestañas | La idempotencia es un **índice único** y el `INSERT` va **antes** del asiento |
| **R5** | **Una cuota de cero céntimos** produce un asiento vacío o un hueco invisible | **R-REC-8**: sin asiento, ocurrencia `OMITIDA` con `CUOTA_CERO` y acumulación a la siguiente fila (criterio 3) |
| **R6** | **La liquidación se declara sobre saldos** que no coinciden con el libro | R-IVA-9: se declara desde el **libro**; una diferencia **impide postear** |
| **R7** | **RECC hace fallar los puentes por hacer lo correcto** | **15a′/15c′** con `4728`/`4778`; criterio 17. Es la lección N-1 de E7 aplicada por segunda vez |
| **R8** | **Un 303 incorrecto** por la base de la prorrata o por la casilla 43 | O-9 con su ejemplo numérico en el criterio 13, y la **guardia bloqueante** de O-12 (criterio 15) |
| **R9** | **Cambiar `quarterOf` reagrupa periodos ya presentados** | `VatRegimePeriod` sembrado `TRIMESTRAL` desde el origen; `quarterOf` intacto; **I-E9-8b** compara los dos caminos antes de retirar nada |
| **R10** | **La diferencia de cambio se cuenta dos veces** (N-1 de E7) o se calcula sobre un anticipo | `Δ = D×r − S` con el enlace al hallazgo; `is_monetary` e **I-E9-24**; criterio 20 |
| **R11** | **El cierre no avanza el 31-12-2028** porque el BCE no publicó en domingo | O-5: tasa de mayor `rateDate ≤ corte` dentro de una ventana, sellada y visible (criterio 21). No es un defecto contable: es un producto que no cierra el ejercicio |
| **R12** | **Un balance con «Deudas a corto plazo» en cero** teniendo préstamos vivos | O-6: T-37 con desglose y **FAIL bloqueante** para las deudas sin él (criterio 25). Es lo primero que mira un auditor |
| **R13** | **`129` vivo para siempre** y reserva legal sin dotar | O-18: T-35 disparado al aprobar, reserva legal **calculada**, I-E9-23 (criterio 35) |
| **R14** | **I-E9-5 evaluada por agregado** deja pasar un activo sobreamortizado compensado por otro | O-19: `fixed_asset_id` en la línea; sin atribución, **`INFO`, nunca PASS** (criterio 8) |
| **R15** | **El valor actual se reconoce tarde** y deja `28x` por encima de la base | O-1: es valoración inicial; los tres casos, con recálculo del cuadro y reversión del exceso (criterio 22) |
| **R16** | **El tipo de descuento se interpreta mal** y descuenta 28 051 c de más | O-2: se declara **mensual**, con su equivalente anual a la vista |
| **R17** | **El checklist se vuelve decorativo** | Nueve bloqueantes comprobados **también en servidor** (criterio 31) y el sello compuesto **después** de los motivos (H-4 de E7) |
| **R18** | **`/reports/vat` y `/settings/assets` se arrastran** | `iva_period` y `fixed_asset_id` indexados; techos medidos en §9 |
| **R19** | **Las casillas del 303 envejecen** con la orden ministerial anual | Mapa en tabla versionada con vigencia; las no soportadas, **vacías con motivo** |

**Alternativas descartadas:**

- **Reconocer el valor actual como ajuste de cierre** (la ronda 0). Convierte un
  criterio de valoración obligatorio en un ajuste de periodo y rompe I-E9-5.
- **Usar `AssetRevision` para el reconocimiento tardío del descuento.** Una
  revisión es un **cambio de estimación** (prospectivo); reconocer tarde un
  criterio obligatorio es la **corrección de un error** (retroactiva).
- **`i_m = i_a / 12` con el tipo que el usuario tenga a mano.** Sólo vale para un
  TIN; con el efectivo/TAE descuenta de más.
- **Barrer todas las líneas con `original_currency`.** Arrastra `407` y `438`:
  resultado inventado sobre partidas **no monetarias**.
- **Exigir `rateDate = corte` para la tasa de cierre.** Deja el producto sin poder
  cerrar uno de cada siete ejercicios.
- **Dejar en una lista informativa los préstamos sin desglose.** Es firmar un
  balance mal clasificado.
- **Reclasificar antes de los ajustes de valoración.** Cuadra la suma y clasifica
  mal el importe.
- **Postear el contra-asiento de la reclasificación antes de T-28.** Rompe la
  numeración y hace que la apertura reproduzca un cierre desreclasificado.
- **Calcular el ajuste de prorrata sobre lo ya deducido.** Error de 1 400 c en el
  ejemplo del experto, sobre una cifra que se declara.
- **Casilla 43 vacía con el cierre en verde.** Honesto frente al usuario, no
  frente a la AEAT.
- **`4751` como cuenta única.** El puente al 111/115/123 no puede repartir el
  saldo y el paso no es verificable.
- **T-25 sin cancelar `473`.** Sobrevalora activo y pasivo por el mismo importe,
  con compensación aparente en el resultado.
- **Almacenar el cuadro de amortización o las casillas del 303.** ADR-0003.
- **`hamilton()` para la amortización.** Dejaría el activo en su valor residual
  antes de agotar su vida útil.
- **Un asiento único de reversión de la periodificación.** Parte el devengo en el
  ejercicio equivocado justo en su caso de uso.
- **Un `ClosingRun` que además recalcule los informes.** Cerrar cambiaría el
  estado que se cierra.
- **Partir `exchange_rates` por organización.** ADR-0014 D7 confirmado.
- **Contabilizar RECC como régimen general** «hasta tener soporte». Declarar mal,
  en silencio.
- **Usar el LLM para proponer una vida útil, un ajuste extracontable, una
  clasificación de vencimiento o una exclusión del art. 104.Tres.** P1 y
  ADR-0005, sin excepciones.

---

## 15. Plan de ejecución en tres olas (tres agentes en paralelo)

Con ADR-0016 aprobado, las 24 tareas ejecutables (**600 h**; T1 y T2 ya están
hechas) se reparten en **tres olas de tres agentes** más una cola de verificación.
La regla es una sola: **dentro de una ola, dos agentes no tocan el mismo
fichero**. Las dependencias entre olas son las de §13.

### Ola A — cimientos y motores puros

| Agente | Tareas | h | Ficheros que toca (exclusivos en la ola) |
|---|---|---:|---|
| **A1** dev-backend | **T3 → T4** | 52 | `prisma/schema.prisma`, `prisma/migrations/**` (M1…M6), `lib/db.ts`, `eslint.config.mjs`, `.claude/hooks/guard.sh`, `tests/integration/e9-esquema.test.ts` |
| **A2** dev-backend | **T5, T6, T7** | 54 | `lib/recurring/**`, `lib/closing/depreciation.ts`, `lib/closing/accrual.ts` (+ sus `*.test.ts`), `docs/design/fixtures/build_cuadros_esperados.py`, `…/build_periodificaciones_esperadas.py` |
| **A3** dev-backend | **T8, T22** | 52 | `lib/closing/vat.ts`, `lib/closing/model303.map.ts` (+ tests), `ai/queue.ts`, `lib/extraction/reconcile.ts` |

**Sincronización única de la ola:** A1 entrega **T3 en su primer commit** (el
esquema y `TENANT_MODELS`) y A2/A3 arrancan de ahí; A1 continúa con T4 sin
bloquear a nadie. A2 y A3 trabajan sobre funciones puras y **no tocan `prisma/`**.

### Ola B — plantillas, valoración, invariantes y modelos

| Agente | Tareas | h | Ficheros |
|---|---|---:|---|
| **B1** dev-backend | **T10, T20** | 52 | `lib/ledger/templates/**` (T-29…T-37, y los bloques nuevos de `tesoreria.ts` y `estructurales.ts`), `tests/fixtures/ejercicio-completo.json`, `docs/design/fixtures/build_ejercicio_completo.py` |
| **B2** dev-backend | **T9, T11** | 72 | `lib/closing/{reclass,fx,present-value,invariants-e9}.ts` (+ tests), `lib/ledger/invariants.ts` (cableado), `scripts/run-invariants.ts`, `docs/design/fixtures/build_valor_actual_esperado.py` |
| **B3** dev-backend | **T12, T14, T21** | 56 | `models/{recurring,assets,accruals,debt,vat,closing,distribution}.ts`, `models/bank.ts` (`readFxCloses` → `readFxPositions`), `lib/closing/distribution.ts`, `scripts/prune-runs.ts`, `docker-cron-entrypoint.sh` |

**Reparto que evita la única colisión posible:** `models/distribution.ts` y
`lib/closing/distribution.ts` son de **T14**, y T12 **no los crea**; por eso T12 y
T14 van al mismo agente. B2 es el único que escribe en `lib/ledger/invariants.ts`.
T11 se hace **después** de que B1 haya entregado T10 (la misma ola, distinto
agente): B2 empieza por T9, que no depende de las plantillas.

### Ola C — cierre, acciones e interfaz

| Agente | Tareas | h | Ficheros |
|---|---|---:|---|
| **C1** dev-backend | **T13, T15** | 56 | `lib/closing/checklist.ts`, `models/fiscal-years.ts`, `models/closing.ts`, `forms/{recurring,assets,vat,closing,debt}.ts`, `app/(app)/**/actions.ts` |
| **C2** dev-frontend | **T16, T19** | 38 | `app/(app)/ledger/closing/**`, `components/closing/**`, `app/(app)/audit/**` (familia `CIERRE`) |
| **C3** dev-frontend | **T17, T18** | 64 | `app/(app)/ledger/recurring/**`, `app/(app)/settings/{assets,debt,periods}/**`, `app/(app)/reports/vat/**`, `components/{recurring,assets,vat}/**` |

**Frontera limpia:** C1 es el **único** que escribe `actions.ts` y `forms/`; C2 y
C3 consumen esas acciones y sólo tocan páginas y componentes, en árboles de rutas
**disjuntos**. C2 y C3 arrancan cuando C1 publica las firmas de las acciones
(contrato primero, implementación después), que es el patrón que ya funcionó en
E6 y E7.

### Cola de verificación (no se paraleliza por agente, sí por rol)

| Orden | Tarea | Agente | h |
|---|---|---|---:|
| 1 | **T23** integración + RLS + `perf-closing` | qa | 38 |
| 2a | **T24** e2e Playwright | qa | 28 |
| 2b | **T25** auditoría de fiabilidad **en contexto limpio** (paralela a T24, P5: quien audita ≠ quien implementa) | auditor-fiabilidad | 22 |
| 3 | **T26** cierre documental, ROADMAP, `ESTADO.md`, registro | arquitecto | 16 |

### Calendario

| | Serie | Tres olas |
|---|---:|---:|
| Ola A | 158 h | **54 h** (agente más largo: A2) |
| Ola B | 180 h | **72 h** (B2) |
| Ola C | 158 h | **64 h** (C3) |
| Cola | 104 h | **82 h** (T23 → máx(T24, T25) → T26) |
| **Total** | **600 h** | **≈ 272 h** de calendario (~34 jornadas frente a 75) |

**Reglas de la ejecución en paralelo**, heredadas de E7:

1. **Un fichero, un agente y una ola.** Si dos tareas necesitan el mismo fichero,
   van al mismo agente aunque desbalanceen las horas — es lo que se hizo con
   T12/T14 y con T13/T15.
2. **El esquema es de A1 y de nadie más.** Ninguna otra tarea abre
   `prisma/schema.prisma` ni añade migraciones; lo que falte se pide a A1.
3. **Contrato antes que implementación**: cada agente publica sus firmas
   TypeScript en el primer commit, para que quien dependa de ellas compile.
4. **`npm run lint && npm run test` en verde al cerrar cada tarea**, y una línea
   por ola en `runs/registro.jsonl` (`tipo: "implementacion"`), como en E7.
5. **La cola no empieza hasta que las tres olas están integradas**: T23 mide sobre
   el fixture ampliado que B1 entrega en T20.
