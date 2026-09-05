# E3 — Asientos tipo, numeración, fechas e invariantes del libro diario

> Rol: `experto-contable`. Fuentes: `.claude/skills/pgc-npgc`, `.claude/skills/fiabilidad`, `.claude/skills/estados-financieros`, `.claude/skills/contabilidad-analitica`, `docs/MODELO-DATOS.md` §Ejercicios y diario, `docs/design/E2-validacion-contable.md`, `lib/taxes/rates.ts`, `lib/taxes/bps.ts`, `lib/accounts/map.ts`, `seeds/npgc.csv`.
> Norma: **RD 1514/2007** (PGC) consolidado con RD 1159/2010, RD 602/2016 y RD 1/2021 · **Ley 37/1992** y RD 1624/1992 (IVA) · **Ley 35/2006** y RD 439/2007 (IRPF) · **RD 1619/2012** (facturación) · **Código de Comercio arts. 25–33** (libros, numeración y orden de fechas).
> **Todas las cifras son ilustrativas y están en céntimos enteros.** Ningún importe procede de datos reales. Los ejemplos van marcados `(ejemplo)`.

---

## 0. Contrato de `lib/ledger/templates/`

Una plantilla es una **función pura** `build<X>(input, ctx) → Result<Draft>`. No lee la BD, no hace IO, no llama a `Date.now()` (hook `guard.sh`), no conoce ningún código de cuenta: pide `AccountKey` y `ctx.map` resuelve. `post.ts` es quien persiste, numera y aplica los invariantes de BD.

```ts
type Cents = number                       // entero; en una línea siempre ≥ 0
type LocalDate = string                   // "YYYY-MM-DD", sin zona (columna @db.Date)

type TemplateContext = {
  organizationId: string
  refDate: LocalDate                      // fecha de referencia del motor, SIEMPRE por parámetro
  plan: Plan                              // lib/accounts/types
  map: (key: AccountKey) => string        // I-plan-1 ya validado: existe, activa, postable
  rates: readonly TaxRateRow[]            // selectTaxRate(rates, code, documentDate)
  fiscalYears: readonly FiscalYearRow[]
  periodLocks: readonly PeriodLockRow[]
  policy: {
    taxRoundingMode: "PER_TIPO" | "PER_LINEA"   // R-IVA-4, sellado en el asiento
    prorrataBps: number | null                   // R-IVA (prorrata general), versión por ejercicio
    redondeoToleranciaCents: number              // default 1 (R-IVA-7)
    analyticsRequired: boolean
  }
}

type DraftLine = {
  accountKey?: AccountKey                 // preferente
  accountCode?: string                    // solo cuentas SIN clave (621, 628, 681, 216…)
  debitCents: Cents; creditCents: Cents   // (debit === 0) !== (credit === 0)
  projectId?: string; costCenterId?: string
  analyticType?: AnalyticType             // override de la cuenta
  taxRateId?: string; counterpartyId?: string; dueDate?: LocalDate; description?: string
}

type Draft = {
  templateCode: string; kind: EntryKind; sourceType: SourceType; sourceId?: string
  documentDate: LocalDate                 // fecha del documento (factura, extracto, nómina)
  accrualDate: LocalDate                  // fecha de devengo (§2.2)
  entryDate: LocalDate                    // fecha contable del asiento (§2.2)
  description: string; lines: DraftLine[]
  taxRoundingMode: "PER_TIPO" | "PER_LINEA"   // sellado (R-IVA-4, P7)
}
```

**Cuentas sin `AccountKey`.** Las claves cubren el mapa de sistema (57). Las cuentas *de negocio* de una línea de gasto/ingreso/inmovilizado (`621`, `623`, `628`, `629`, `640` cuando no es la default, `681`, `216`, `217`, `2816`…) **no son claves**: llegan como `accountCode` en el input, elegidas por el usuario o propuestas por OCR, y se validan contra el plan (`isPostable && isActive`). Regla: *toda contrapartida que el motor decide por sí mismo es una `AccountKey`; toda cuenta que decide el usuario o el documento es un `accountCode` validado.* Ninguna plantilla escribe un literal `"430"`.

### 0.1 Aritmética común (obligatoria en todas las plantillas)

| Función | Definición | Regla |
|---|---|---|
| `applyBps(base, bps)` | `lib/taxes/bps.ts`; half-up sobre la **magnitud**, entero puro | R-IVA-2 |
| `cuotaPorTipo(lineas, rate)` | `applyBps(Σ bases_del_tipo, rate.rateBps)` — **un solo redondeo por tipo** | R-IVA-1 (`PER_TIPO`, default) |
| `cuotaPorLinea(lineas, rate)` | `Σ applyBps(base_i, rate.rateBps)` | R-IVA-3 (`PER_LINEA`; nunca se mezcla con la anterior en un documento) |
| `retencion(baseTotal, rate)` | `applyBps(Σ todas las bases del documento, rate.rateBps)` — **una vez, sobre el total** | R-IVA-6 |
| `deducible(cuota, prorrataBps)` | `applyBps(cuota, prorrataBps)`; el resto `cuota − deducible` **engorda la línea de gasto/inmovilizado** | ICAC coste / NRV 2ª·10ª |
| `redondeo(dif)` | `\|dif\| ≤ policy.redondeoToleranciaCents` ⇒ línea a `REDONDEO_GASTO`/`REDONDEO_INGRESO`; si no, **error, no se persiste** | R-IVA-7 |

### 0.2 Comprobaciones deterministas comunes (`checkDraft`, se aplican a TODA plantilla)

| Id | Comprobación | Fórmula | Efecto |
|---|---|---|---|
| **C-1** | Partida doble | `Σ line.debitCents === Σ line.creditCents` | bloquea (I1) |
| **C-2** | Línea bien formada | `(debit === 0) !== (credit === 0)` y ambos `≥ 0` | bloquea |
| **C-3** | Sin líneas a cero | `debit + credit > 0` en toda línea | bloquea |
| **C-4** | Mínimo dos líneas | `lines.length ≥ 2` **y** `≥ 1 con debe` **y** `≥ 1 con haber` | bloquea |
| **C-5** | Documento cuadrado | `base + Σ impuestos_repercutidos − Σ retenciones = total` del documento | bloquea |
| **C-6** | Detalle cuadrado | `Σ bases_de_línea = base_documento` (tolerancia **0**) | bloquea |
| **C-7** | Coherencia de cuota | `\|Σ cuotas − Σ applyBps(base_tipo, bps)\| ≤ 1 × nº de tipos` | bloquea (R-IVA-5) |
| **C-8** | Cuentas | toda línea resuelve a cuenta de la org, activa y `isPostable` | bloquea (I9) |
| **C-9** | Destino analítico | cuenta de grupo 6/7 ⇒ exactamente uno de `projectId`/`costCenterId`, salvo `analyticType = NO_ANALITICO` | bloquea si `analyticsRequired`; si no, CECO `SIN_ASIGNAR` + WARN |
| **C-10** | Tipos vigentes | `selectTaxRate(rates, code, documentDate) !== null` y `taxAppliesToSide(rate, side)` | bloquea |
| **C-11** | Periodo | `entryDate` en ejercicio `OPEN` y mes no bloqueado (§2.4) | bloquea (I8) |
| **C-12** | Signos en rectificativas | toda línea de un abono tiene el signo **contrario** a la línea homóloga del documento rectificado (§1.5) | bloquea |
| **C-13** | Tenant | `organizationId` idéntico en asiento, líneas, cuentas, proyectos y CECOs | bloquea (I10) |

Notación de las tablas: `B` = base imponible del documento, `Bᵢ` = base de la línea *i*, `t` = tipo de IVA (`rateBps`), `r` = tipo de retención, `p` = `prorrataBps`. "Destino analítico" = si esa línea exige `projectId`/`costCenterId`.

---

## 1. Catálogo de plantillas (28)

| # | `templateCode` | `kind` | `sourceType` | Épica |
|---|---|---|---|---|
| T-01 | `FACTURA_EMITIDA_SERVICIOS` | `NORMAL` | `INVOICE_OUT` | E3 |
| T-02 | `ABONO_EMITIDO` | `NORMAL` | `INVOICE_OUT` | E3 |
| T-03 | `FACTURA_RECIBIDA` | `NORMAL` | `DOCUMENT` | E3 |
| T-04 | `FACTURA_RECIBIDA_ISP` | `NORMAL` | `DOCUMENT` | E3 |
| T-05 | `ABONO_RECIBIDO` | `NORMAL` | `DOCUMENT` | E3 |
| T-06 | `ANTICIPO_CLIENTE` | `NORMAL` | `MANUAL`/`BANK_IMPORT` | E3 |
| T-07 | `ANTICIPO_PROVEEDOR` | `NORMAL` | `MANUAL`/`BANK_IMPORT` | E3 |
| T-08 | `COBRO_CLIENTE` | `NORMAL` | `BANK_IMPORT` | E3 |
| T-09 | `PAGO_PROVEEDOR` | `NORMAL` | `BANK_IMPORT` | E3 |
| T-10 | `NOMINA` | `NORMAL` | `MANUAL` | E3 |
| T-11 | `PAGO_NOMINA` | `NORMAL` | `BANK_IMPORT` | E3 |
| T-12 | `PAGO_SEGURIDAD_SOCIAL` | `NORMAL` | `BANK_IMPORT` | E3 |
| T-13 | `PAGO_RETENCIONES` (111/115) | `NORMAL` | `BANK_IMPORT` | E3 |
| T-14 | `AMORTIZACION_MENSUAL` | `NORMAL` | `SYSTEM` | E3 |
| T-15 | `PERIODIFICACION_GASTO` (480) | `NORMAL` | `MANUAL` | E3 |
| T-16 | `DEVENGO_PERIODIFICACION_GASTO` | `NORMAL` | `MANUAL`/`RECURRING` | E3 |
| T-17 | `PERIODIFICACION_INGRESO` (485) | `NORMAL` | `MANUAL` | E3 |
| T-18 | `DEVENGO_PERIODIFICACION_INGRESO` | `NORMAL` | `MANUAL`/`RECURRING` | E3 |
| T-19 | `TRASPASO_TESORERIA` | `NORMAL` | `BANK_IMPORT` | E3 |
| T-20 | `ASIENTO_MANUAL` | `NORMAL` | `MANUAL` | E3 |
| T-21 | `CONTRA_ASIENTO` | `REVERSAL` | `SYSTEM` | E3 |
| T-22 | `AJUSTE_EJERCICIO_CERRADO` | `NORMAL` | `MANUAL` | E3 |
| T-23 | `REGULARIZACION_IVA` (303) | `NORMAL` | `SYSTEM` | E3/E9 |
| T-24 | `PAGO_IMPUESTO` | `NORMAL` | `BANK_IMPORT` | E3 |
| T-25 | `IMPUESTO_BENEFICIOS` | `NORMAL` | `SYSTEM` | E9 |
| T-26 | `REGULARIZACION_RESULTADO` | `REGULARIZATION` | `SYSTEM` | E9 |
| T-27 | `CIERRE_EJERCICIO` | `CLOSING` | `SYSTEM` | E9 |
| T-28 | `APERTURA_EJERCICIO` | `OPENING` | `SYSTEM` | E9 |

---

### T-01 · `FACTURA_EMITIDA_SERVICIOS`

```ts
type FacturaEmitidaInput = {
  counterpartyId: string; documentNumber: string
  documentDate: LocalDate; accrualDate?: LocalDate; entryDate?: LocalDate; dueDate?: LocalDate
  lines: { baseCents: Cents; taxRateCode: string; surchargeRateCode?: string  // REQ_5_2 | REQ_1_4 | REQ_0_5 | REQ_1_75
           projectId?: string; costCenterId?: string; revenueAccountCode?: string  // default map(VENTAS_DEFAULT)
           analyticType?: AnalyticType; description?: string }[]
  withholdingRateCode?: string                    // IRPF_PROF_15 | IRPF_PROF_7 | IRPF_ALQ_19 …
  appliedAdvanceCents?: Cents                     // base del anticipo 438 que se aplica
  appliedAdvanceTaxCents?: Cents                  // IVA devengado en su día por ese anticipo
  totalCents: Cents                               // total del documento, para C-5
}
```

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo (redondeo por línea R-IVA-2) | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1 | `CLIENTES` | `T − IRPF − (A + Aiva)` | — | `T = B + Σ_t cuota_t + Σ_re recargo_re`; `B = Σ Bᵢ`; `cuota_t = applyBps(Σ_{i∈t} Bᵢ, t)`; `IRPF = applyBps(B, r)`; `A`/`Aiva` = anticipo aplicado | No |
| 2 | `IRPF_RETENIDO_CLIENTES` | `applyBps(B, r)` | — | solo si `withholdingRateCode`; **una sola vez sobre B** (R-IVA-6) | No |
| 3 | `ANTICIPOS_CLIENTES` | `A` | — | solo si `appliedAdvanceCents > 0`; cancela el pasivo 438 | No |
| 4 | `IVA_REPERCUTIDO` | `Aiva` | — | reversión del IVA devengado con el anticipo (`taxRateId` del anticipo) | No |
| 5..n | `VENTAS_DEFAULT` *(o `revenueAccountCode`)* | — | `Bᵢ` | una línea por línea de factura; conserva su `projectId`/`costCenterId` | **Sí** (`INGRESO_DIRECTO` ⇒ `projectId`) |
| n+1..m | `IVA_REPERCUTIDO` | — | `cuota_t` | **una línea por tipo impositivo** con su `taxRateId` (`PER_TIPO`) | No |
| m+1 | `IVA_REPERCUTIDO` | — | `recargo_re = applyBps(Σ_{i∈re} Bᵢ, re)` | recargo de equivalencia: línea separada con el `taxRateId` del `RECARGO`, nunca sumado a la cuota de IVA (casilla propia de la 303) | No |

**Comprobaciones:** C-1…C-11. Específicas: `Σ Bᵢ = B` (C-6); `B + Σcuota_t + Σrecargo − IRPF = T` (C-5); si hay anticipo, `A ≤ B` y `Aiva` = exactamente el importe repercutido en el asiento del anticipo (verificable por `sourceId`); tipos exentos (`IVA_0_INTRA`, `IVA_0_EXPORT`, `IVA_EXENTO_20`, `IVA_NO_SUJETO`) **no generan línea de cuota** (`rateBps = 0` ⇒ omitir, no crear línea a 0 — C-3).

> Ejemplo (fixture `F-001`, ejemplo): `B₁ = 500 000 c @ IVA_21`, `B₂ = 120 000 c @ IVA_10` ⇒ cuotas `105 000` y `12 000`; `430` debe `737 000`.
> Ejemplo con retención (`F-002`, ejemplo): `B = 800 000`, IVA `168 000`, IRPF 15 % `120 000` ⇒ `430` debe `848 000`, `473` debe `120 000`.
> Ejemplo con recargo (`F-004`, ejemplo): `B = 300 000` ⇒ IVA `63 000` + RE 5,2 % `15 600` ⇒ `430` debe `378 600`.
> Ejemplo con anticipo (`F-003`, ejemplo): `B = 600 000`, IVA `126 000`, anticipo `A = 200 000` / `Aiva = 42 000` ⇒ `438` debe `200 000`, `477` debe `42 000`, `430` debe `484 000`.

---

### T-02 · `ABONO_EMITIDO` (rectificativa de venta)

Input = `FacturaEmitidaInput` + `rectifiesEntryId`, `reason: DEVOLUCION | DESCUENTO_POSTERIOR | RAPPEL | ERROR`. Importes **siempre positivos**; lo que se invierte es la columna.

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1..n | `DEVOLUCION_VENTAS` (708) · `DESCUENTO_PP_VENTAS` (706) · `RAPPEL_VENTAS` (709) · `VENTAS_DEFAULT` si `ERROR` | `Bᵢ` | — | la cuenta depende de `reason`; con `ERROR` se rectifica la propia cuenta de ingreso | **Sí**, el **mismo** proyecto/CECO de la línea rectificada |
| n+1..m | `IVA_REPERCUTIDO` | `cuota_t` | — | `applyBps(Σ Bᵢ del tipo, t)` con el tipo **vigente a la fecha del documento original** | No |
| m+1 | `IRPF_RETENIDO_CLIENTES` | — | `applyBps(B, r)` | solo si la factura original llevaba retención | No |
| m+2 | `CLIENTES` | — | `B + Σcuota − IRPF` | | No |

**Comprobaciones:** C-1…C-12. Específicas: la rectificativa **no puede exceder** el importe vivo del documento rectificado por concepto (`Σ abonos ≤ factura`); el `taxRateId` es el del documento original (no el vigente hoy); R-IVA-8 — un descuento **en factura** minora la base y **no** genera abono a 706/709; la simetría de `applyBps` garantiza que factura + abono total = 0 exacto, sin céntimo huérfano en 477.

---

### T-03 · `FACTURA_RECIBIDA`

```ts
type FacturaRecibidaInput = {
  counterpartyId: string; supplierDocumentNumber: string
  documentDate: LocalDate; accrualDate?; entryDate?; dueDate?
  payableKey: "PROVEEDORES" | "ACREEDORES"        // 400 bienes/subcontratación · 410 servicios
  lines: { baseCents; taxRateCode; expenseAccountCode?  // default map(SUBCONTRATACION_DEFAULT) para servicios,
                                                       // map(COMPRAS_DEFAULT) para bienes
           deductibility: "FULL" | "NONE" | "PRORRATA"
           projectId?; costCenterId?; analyticType?; description? }[]
  withholdingRateCode?: string                     // IRPF_PROF_15 | IRPF_ALQ_19 …
  appliedAdvanceCents?: Cents                      // 407
  totalCents: Cents
}
```

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1..n | `SUBCONTRATACION_DEFAULT` / `COMPRAS_DEFAULT` *(o `expenseAccountCode`)* | `Bᵢ + NDᵢ` | — | `NDᵢ = 0` si `FULL`; `NDᵢ = cuotaᵢ` si `NONE`; `NDᵢ = cuotaᵢ − applyBps(cuotaᵢ, p)` si `PRORRATA`. El IVA no deducible **incrementa el precio de adquisición**, no va a 472 | **Sí** |
| n+1..m | `IVA_SOPORTADO` | `Σ_{i∈t} applyBps(cuotaᵢ, p ó 10000)` | — | una línea por tipo; con prorrata, el deducible se calcula **por línea** y se agrega por tipo (evita que el redondeo de la prorrata se aplique dos veces) | No |
| m+1 | `ANTICIPOS_PROVEEDORES` | — | `A` | cancela el 407 previamente registrado | No |
| m+2 | `payableKey` (`PROVEEDORES`\|`ACREEDORES`) | — | `B + Σcuota − IRPF − A` | | No |
| m+3 | `IRPF_PROFESIONALES_A_PAGAR` \| `IRPF_ALQUILERES_A_PAGAR` | — | `applyBps(B, r)` | clave según el modelo (111 vs 115). Con `useSubaccounts = false` las dos resuelven a 4751 y el cuadre por modelo se hace agrupando por `taxRateId` | No |

**Comprobaciones:** C-1…C-11 + `deductibility = PRORRATA` exige `policy.prorrataBps !== null` (si no, error `PRORRATA_NOT_CONFIGURED`); la regularización **anual** de prorrata y la de bienes de inversión **no** son esta plantilla: van contra `AJUSTE_IVA_NEGATIVO` (634) / `AJUSTE_IVA_POSITIVO` (639), nunca contra 472 (E9).

> Ejemplos (fixture): `R-002` alquiler `B = 120 000`, IVA `25 200`, IRPF 19 % `22 800` ⇒ `410` haber `122 400`, `4751` haber `22 800`.
> `R-004` prorrata 90 %: `B = 80 000`, cuota `16 800`, deducible `15 120`, no deducible `1 680` ⇒ línea de gasto `81 680`.
> `R-005` IVA íntegramente no deducible: gasto `60 500`, sin línea de 472.

---

### T-04 · `FACTURA_RECIBIDA_ISP` (inversión del sujeto pasivo / adquisición intracomunitaria)

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1..n | *(cuenta de gasto/inmovilizado del input)* | `Bᵢ` | — | el proveedor **no repercute**: la base es el importe íntegro de la factura | **Sí** |
| n+1 | `IVA_SOPORTADO_ISP` | `applyBps(B, t)` | — | autorrepercusión, lado deducible (afectado por prorrata igual que T-03) | No |
| n+2 | `ACREEDORES` / `PROVEEDORES` | — | `B` | la deuda con el proveedor es **solo la base** | No |
| n+3 | `IVA_REPERCUTIDO_ISP` | — | `applyBps(B, t)` | autorrepercusión, lado devengado; efecto neto en tesorería **0** | No |

**Comprobaciones:** además de C-1…C-11: `rate.appliesTo = PURCHASE`; las dos líneas de IVA usan el **mismo `taxRateId`** y el mismo importe (salvo prorrata, en cuyo caso el deducible es menor y la diferencia engorda la línea de gasto — el asiento sigue cuadrando porque el devengado no cambia); si `createSoftwareAccounts = true`, ambas claves resuelven a 4720/4770 y el mayor queda legible.

---

### T-05 · `ABONO_RECIBIDO`

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1 | `PROVEEDORES` / `ACREEDORES` | `B + Σcuota − IRPF` | — | | No |
| 2 | `IRPF_*_A_PAGAR` | `applyBps(B, r)` | — | si la factura original tenía retención | No |
| 3..n | `DEVOLUCION_COMPRAS` (608) · `DESCUENTO_PP_COMPRAS` (606) · `RAPPEL_COMPRAS` (609) · cuenta de gasto si `ERROR` | — | `Bᵢ` | mismo `reason` que T-02 | **Sí**, mismo destino que la línea rectificada |
| n+1..m | `IVA_SOPORTADO` | — | `cuota_t` | tipo vigente en el documento **original**; si era no deducible, no hay línea de 472 y el abono minora la cuenta de gasto por `Bᵢ + NDᵢ` | No |

---

### T-06 · `ANTICIPO_CLIENTE` (438) · T-07 · `ANTICIPO_PROVEEDOR` (407)

| # | Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Analítico |
|---|---|---|---|---|---|---|
| T-06 | 1 | `BANCO_DEFAULT` \| `CAJA` | `A + applyBps(A, t)` | — | el anticipo **devenga IVA** (art. 75.Dos LIVA) | No |
| T-06 | 2 | `ANTICIPOS_CLIENTES` | — | `A` | pasivo, nunca ingreso: no toca 705 ni la PyG | No |
| T-06 | 3 | `IVA_REPERCUTIDO` | — | `applyBps(A, t)` | con su `taxRateId`; se revierte en T-01 al facturar | No |
| T-07 | 1 | `ANTICIPOS_PROVEEDORES` | `A` | — | **activo**, no gasto: no toca la PyG ni la analítica | No |
| T-07 | 2 | `IVA_SOPORTADO` | `applyBps(A, t)` | — | | No |
| T-07 | 3 | `BANCO_DEFAULT` \| `CAJA` | — | `A + applyBps(A, t)` | | No |

**Comprobación específica:** el anticipo **no** admite `projectId` en la línea de 438/407 (son cuentas de balance); la imputación analítica llega con la factura. Un anticipo sin factura al cierre queda en balance y la Auditoría lo lista (aging de 438/407).

---

### T-08 · `COBRO_CLIENTE`

```ts
type CobroInput = {
  bankKey: "BANCO_DEFAULT" | "CAJA"; bankAccountCode?: string   // subcuenta 5720/5721 si la org tiene varias
  documentDate: LocalDate; entryDate?: LocalDate
  settlements: { receivableKey: "CLIENTES" | "CLIENTES_DUDOSO_COBRO"; amountCents: Cents; sourceEntryId?: string }[]
  amountReceivedCents: Cents                     // lo que entra realmente en el banco
  bankFeeCents?: Cents; feeCostCenterId?: string
  fxDifferenceCents?: number                     // + ganancia, − pérdida (signo del input, no de la línea)
  roundingCents?: number                         // ± ≤ policy.redondeoToleranciaCents
}
```

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1 | `BANCO_DEFAULT` \| `CAJA` | `amountReceivedCents` | — | cobro **total o parcial**: la plantilla no exige que salde el crédito | No |
| 2 | `COMISIONES_BANCARIAS` (626) | `bankFeeCents` | — | servicio bancario exento (art. 20.Uno.18º): **sin IVA** | **Sí** (CECO, `INDIRECTO_CECO`) |
| 3 | `DIFERENCIA_CAMBIO_NEGATIVA` (668) | `−fxDifferenceCents` si `< 0` | — | `fx = contravalor cobrado − importe contabilizado del crédito` | **Sí** (CECO `FINANCIERO`) |
| 4 | `DIFERENCIA_CAMBIO_POSITIVA` (768) | — | `fxDifferenceCents` si `> 0` | ídem | **Sí** (CECO `FINANCIERO`) |
| 5 | `REDONDEO_GASTO` (669) / `REDONDEO_INGRESO` (769) | `\|dif\|` si falta / — | — / `\|dif\|` si sobra | solo si `\|dif\| ≤ policy.redondeoToleranciaCents`; por encima → **error** (R-IVA-7) | **Sí** (CECO `FINANCIERO`) |
| 6..n | `receivableKey` | — | `settlements[i].amountCents` | una línea por documento saldado (trazabilidad del cobro parcial) | No |

**Comprobaciones:** C-1…C-4, C-8, C-11 + `Σ settlements = amountReceived + bankFee − fx + rounding` (la igualdad **es** C-1 desarrollada); `amountCents ≤ importe vivo` de cada documento; nunca hay línea de IVA (el IVA se devengó con la factura, salvo criterio de caja, fuera de alcance de E3 → E9).

> Ejemplos (fixture): `CO-003` comisión `500 c`; `CO-004` diferencia negativa `5 000 c`; `CO-005` positiva `6 000 c`; `CO-006` redondeo `1 c`.

### T-09 · `PAGO_PROVEEDOR`

Espejo exacto de T-08: `payableKey` al debe, banco al haber; comisión y diferencia de cambio con el mismo criterio de signo; redondeo simétrico (`769` cuando se paga de menos, `669` cuando de más).

---

### T-10 · `NOMINA`

```ts
type NominaInput = {
  period: { year: number; month: number }
  gross: { amountCents; accountCode?  /* default map(SUELDOS_DEFAULT) */; projectId?; costCenterId? }[]
  employerSS: { amountCents; accountCode? /* map(SS_EMPRESA_DEFAULT) */; projectId?; costCenterId? }[]
  employeeSSCents: Cents; withholdingCents: Cents      // ambos VIENEN del proveedor de nóminas (computed)
  advanceAppliedCents?: Cents                          // 460
  netCents: Cents                                      // declarado, para C-5
}
```

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1..n | `SUELDOS_DEFAULT` (640) | `grossᵢ` | — | **una línea por destino**: una persona en 3 proyectos y G&A son 4 líneas del mismo asiento, nunca 4 cuentas (C-5 de E2) | **Sí** (`COSTE_DIRECTO_MC2` a proyecto o `INDIRECTO_CECO`) |
| n+1..m | `SS_EMPRESA_DEFAULT` (642) | `ssEmpᵢ` | — | mismo reparto que el bruto salvo override explícito | **Sí** |
| m+1 | `REMUNERACIONES_PENDIENTES` (465) | — | `Σgross − employeeSS − withholding − advance` | neto a pagar | No |
| m+2 | `ANTICIPOS_REMUNERACIONES` (460) | — | `advanceAppliedCents` | cancela el anticipo entregado antes; solo si `> 0` | No |
| m+3 | `SS_ACREEDORA` (476) | — | `employeeSS + Σ ssEmp` | cuota obrera + cuota patronal en una sola línea (es una sola deuda con la TGSS) | No |
| m+4 | `IRPF_TRABAJO_A_PAGAR` (4751/47512) | — | `withholdingCents` | **el ERP no calcula el tipo** (art. 82 RIRPF): llega del proveedor de nóminas y el `TaxRate` va marcado `computed` | No |

**Comprobaciones:** C-1…C-4, C-8, C-9, C-11 + `Σgross = bruto declarado`; `neto = Σgross − employeeSS − withholding − advance` (C-5); `advance ≤ neto` antes de aplicarlo; `employeeSS`, `withholding` y `netCents` **nunca se recalculan** por el motor: se validan por identidad, y una discrepancia bloquea (P1: el código valida, no inventa).

> Ejemplo (fixture `NOM-04`, ejemplo): bruto `500 000` (300 000 P-01 · 125 000 P-02 · 75 000 CC-GA), SS empresa `160 000`, SS trabajador `31 750`, IRPF `75 000`, anticipo `50 000` ⇒ neto `343 250`; `476` haber `191 750`.

### T-11 · `PAGO_NOMINA` · T-12 · `PAGO_SEGURIDAD_SOCIAL` · T-13 · `PAGO_RETENCIONES` · T-24 · `PAGO_IMPUESTO`

Todas comparten forma: **una deuda al debe, tesorería al haber**. Se diferencian solo en la clave y en el criterio de importe.

| Plantilla | Debe | Haber | Regla de cálculo | Analítico |
|---|---|---|---|---|
| T-11 | `REMUNERACIONES_PENDIENTES` | `BANCO_DEFAULT` | importe = saldo vivo de 465 del periodo pagado | No |
| T-12 | `SS_ACREEDORA` | `BANCO_DEFAULT` | saldo vivo de 476 del periodo (RLC mensual) | No |
| T-13 | `IRPF_A_PAGAR` \| `IRPF_PROFESIONALES_A_PAGAR` \| `IRPF_ALQUILERES_A_PAGAR` \| `IRPF_TRABAJO_A_PAGAR` | `BANCO_DEFAULT` | **saldo acreedor vivo de la cuenta a fin de trimestre**, agrupado por modelo: 111 (trabajo + profesionales) y 115 (alquileres) en **asientos distintos** aunque compartan cuenta | No |
| T-24 | `HP_ACREEDORA_IVA` (4750) \| `HP_ACREEDORA_IS` (4752) | `BANCO_DEFAULT` | importe exacto de la liquidación (T-23 / T-25); jamás un importe libre | No |

**Comprobación común:** el importe **no puede exceder** el saldo vivo de la cuenta de deuda (`saldo_acreedor ≥ importe`), y un pago que dejaría saldo deudor en 4750/4751/476 bloquea con `PAYMENT_EXCEEDS_LIABILITY`. Si el banco cobra recargo o intereses de demora, van en líneas propias (`631`/`669`) con destino analítico, nunca engordando la deuda tributaria.

---

### T-14 · `AMORTIZACION_MENSUAL`

```ts
type AmortizacionInput = {
  period: { year: number; month: number }
  items: { assetAccountCode: string; expenseAccountCode: string  // 681/680/682
           accumulatedAccountCode: string                        // 281x/280x/282x
           amountCents: Cents; projectId?; costCenterId? }[]
}
```

| Línea | Cuenta | Debe | Haber | Regla de cálculo | Destino analítico obligatorio? |
|---|---|---|---|---|---|
| 1..n | `expenseAccountCode` (681) | `amountCentsᵢ` | — | cuota mensual = `floor(baseAmortizable × tasa / 12)` calculada **fuera** de la plantilla (tabla de amortización), con el resto acumulado en la última cuota del año para que Σ12 cuotas = cuota anual exacta | **Sí** (`AMORTIZACION_DETERIORO`: CECO, o proyecto si el activo está afecto) |
| n+1..m | `accumulatedAccountCode` (2816/2817) | — | `Σ amountCents del mismo activo` | contra-cuenta de activo (`isContra = true`): **resta** en balance | No |

**Comprobaciones:** C-1…C-4, C-8, C-9, C-11 + amortización acumulada `≤` valor de adquisición por activo (`saldo 28x ≤ saldo 2xx`), verificable en la pestaña Auditoría; un activo dado de alta a mitad de mes amortiza **desde el mes siguiente** (criterio parametrizable por organización, sellado en el asiento).

> Ejemplo (fixture): 12 asientos; `216` a 10 años ⇒ `10 000 c/mes`; `217` a 4 años ⇒ `12 500 c/mes`, y `31 250 c/mes` adicionales desde septiembre por el equipo comprado en agosto. Σ ejercicio = `395 000 c`.

---

### T-15…T-18 · Periodificaciones (480 / 485) y su devengo

| # | Plantilla | Debe | Haber | Regla de cálculo | Analítico |
|---|---|---|---|---|---|
| T-15 | `PERIODIFICACION_GASTO` | `PERIODIFICACION_GASTO` (480) | cuenta de gasto 6xx | `importe = gasto_total × días_no_devengados / días_totales`, redondeo half-up; el residuo va **al último periodo** | **Sí** en la línea de 6xx (mismo destino que el gasto original) |
| T-16 | `DEVENGO_PERIODIFICACION_GASTO` | cuenta de gasto 6xx | `PERIODIFICACION_GASTO` (480) | importe del periodo devengado; Σ devengos = importe periodificado (tolerancia 0) | **Sí** |
| T-17 | `PERIODIFICACION_INGRESO` | cuenta de ingreso 7xx | `PERIODIFICACION_INGRESO` (485) | ídem sobre el ingreso | **Sí** (proyecto) |
| T-18 | `DEVENGO_PERIODIFICACION_INGRESO` | `PERIODIFICACION_INGRESO` (485) | cuenta de ingreso 7xx | ídem | **Sí** (proyecto) |

**Comprobaciones:** el par periodificación/devengo comparte `sourceId`; la Auditoría verifica `saldo(480) = Σ periodificaciones − Σ devengos ≥ 0` y lista los saldos de 480/485 sin devengo pendiente al cierre. Diferencia con 438/485: **438 es un anticipo cobrado (con IVA devengado); 485 es un ingreso ya facturado y devengado en el IVA pero no imputable al periodo**. No son intercambiables y la plantilla no permite elegir.

> Ejemplo (fixture): `PER-G-01` 480 debe `60 000` / 628 haber `60 000`; `PER-G-02` invierte el par. Efecto en la PyG del ejercicio: 0.

---

### T-19 · `TRASPASO_TESORERIA` · T-20 · `ASIENTO_MANUAL`

| # | Línea | Clave | Debe | Haber | Regla | Analítico |
|---|---|---|---|---|---|---|
| T-19 | 1 | cuenta 57x destino (`BANCO_DEFAULT`/`CAJA`/subcuenta) | `amountCents` | — | importe idéntico en ambas líneas | No |
| T-19 | 2 | cuenta 57x origen | — | `amountCents` | comisión de transferencia, si la hay, en línea propia a `COMISIONES_BANCARIAS` | 626 sí (CECO) |
| T-20 | 1..n | libre (clave o código) | libre | libre | el usuario introduce líneas; el motor **solo** valida | **Sí** en toda línea 6/7 |

**Comprobaciones T-19:** ambas cuentas deben ser 57x (`cashflowCategory` no nula) y **distintas** (`origen ≠ destino`), para que el cashflow directo (I6) no registre un flujo ficticio. Los traspasos internos se excluyen de las categorías de cashflow: son movimiento **entre** cuentas de tesorería, no flujo.

**Comprobaciones T-20:** las 13 comunes (C-1…C-13) sin excepción. El asiento manual no es una puerta trasera: no puede usar `kind ∈ {OPENING, CLOSING, REGULARIZATION, REVERSAL}` (esos `kind` solo los produce el motor) ni tocar 129 salvo T-26.

---

### T-21 · `CONTRA_ASIENTO`

```ts
type ContraAsientoInput = { entryId: string; reason: string; requestedDate?: LocalDate }
```

Genera el **espejo exacto** del asiento anulado: por cada línea original `(accountCode, debit d, credit c, projectId, costCenterId, analyticType, taxRateId)` una línea `(mismo accountCode, debit c, credit d, mismos destinos y taxRateId)`, en el **mismo orden** (`lineNo` conservado). No recalcula nada: copia e invierte. `kind = REVERSAL`, `reversesEntryId = entryId`, `templateCode = CONTRA_ASIENTO`, `description = "Anulación de [nº] — " + reason`.

| Comprobación | Regla | Efecto |
|---|---|---|
| CA-1 | `entry.kind ∉ {OPENING, CLOSING, REGULARIZATION}` | bloquea (esos se deshacen reabriendo el ejercicio, no con contra-asiento) |
| CA-2 | **`entry.kind ≠ REVERSAL`**: un contra-asiento no puede anular otro contra-asiento | bloquea (§3, I-E3-4) |
| CA-3 | No existe ya un `REVERSAL` con `reversesEntryId = entryId` **sin anular** | bloquea (doble anulación) |
| CA-4 | Fecha: §2.5 | — |
| CA-5 | Σdebe/Σhaber del par original+contra = 0 por cuenta y por destino analítico | verificado en Auditoría |
| CA-6 | `reason` obligatorio, ≥ 10 caracteres, a `AuditLog` | bloquea |

Nunca hay `DELETE`. No existe flag que excluya líneas de los informes: el par se compensa por importe.

---

### T-22 · `AJUSTE_EJERCICIO_CERRADO`

Documento cuyo devengo pertenece a un ejercicio `CLOSED`. **Nunca** se abre el ejercicio cerrado ni se reexpresan cuentas anuales formuladas: el asiento se registra **en el primer ejercicio abierto**, con `documentDate` en el ejercicio antiguo y `entryDate`/`accrualDate` en el abierto.

| Caso (NRV 22ª PGC) | Contrapartida | Efecto en PyG del ejercicio corriente |
|---|---|---|
| Error **material** de ejercicios anteriores, o cambio de criterio contable | `113` Reservas voluntarias (o `121` si no hay reservas suficientes) | **Ninguno** (ajuste directo a reservas, con desglose en la memoria) |
| Error o gasto/ingreso de ejercicio anterior **no significativo** | `678` Gastos excepcionales / `778` Ingresos excepcionales | Sí, epígrafe 13 "Otros resultados", **dentro** del resultado de explotación |
| Cambio de estimación contable (vidas útiles, provisiones) | cuenta de gasto/ingreso del propio ejercicio | Sí, prospectivo, sin ajuste retroactivo |

> **Corrección de norma sobre el encargo.** El PGC 2007 **suprimió las cuentas 679 y 779** ("Gastos/Ingresos y beneficios de ejercicios anteriores" del PGC 1990) junto con todo el resultado extraordinario; no figuran en `seeds/npgc.csv` porque no existen. Sus sustitutas son **678/778** para lo no significativo y **113/121** (reservas) para lo material. Cualquier especificación que cite 679/779 debe corregirse.

| Línea | Cuenta | Debe | Haber | Regla de cálculo | Analítico |
|---|---|---|---|---|---|
| 1 | `113` \| `678` \| `778` | importe del ajuste si es cargo | — | material ⇒ 113; no significativo ⇒ 678 | 678/778 **sí** (CECO); 113 no (balance) |
| 2 | contrapartida real (`ACREEDORES`, `PROVEEDORES`, `CLIENTES`, 47x…) | — | importe | el IVA de un documento de ejercicio cerrado se deduce si está **dentro del plazo de 4 años** (art. 99 LIVA) y entonces sí va a `IVA_SOPORTADO` del periodo corriente | No |

**Comprobaciones:** `documentDate` en ejercicio `CLOSED`; `entryDate` en ejercicio `OPEN`, mes no bloqueado; `reason` obligatorio a `AuditLog`; el ajuste a 113 **no** puede tener destino analítico (rompería I4: es patrimonio, no PyG).

> Ejemplos (fixture): `AJ-001` gasto no significativo `35 000 c` a 678; `AJ-002` error material `250 000 c` a 113.

---

### T-23 · `REGULARIZACION_IVA` (modelo 303, trimestral o mensual)

```ts
type RegularizacionIvaInput = {
  periodStart: LocalDate; periodEnd: LocalDate       // el trimestre natural
  outputCents: Cents                                 // saldo ACREEDOR de 477 del periodo
  inputCents: Cents                                  // saldo DEUDOR de 472 del periodo
  carryForwardCents?: Cents                          // saldo vivo de 4700 de periodos anteriores
}
```

`resultado = outputCents − inputCents − carryForwardCents`.

| Línea | Clave `AccountKey` | Debe | Haber | Regla de cálculo | Analítico |
|---|---|---|---|---|---|
| 1 | `IVA_REPERCUTIDO` (477) | `outputCents` | — | salda el 477 del periodo a **cero exacto**; se omite si es 0 (C-3) | No |
| 2 | `IVA_SOPORTADO` (472) | — | `inputCents` | ídem con 472 | No |
| 3 | `HP_DEUDORA_IVA` (4700) | — | `carryForwardCents` | consume la cuota a compensar de trimestres anteriores | No |
| 4a | `HP_ACREEDORA_IVA` (4750) | — | `resultado` si `> 0` | cuota a ingresar (casilla 71 de la 303) | No |
| 4b | `HP_DEUDORA_IVA` (4700) | `−resultado` si `< 0` | — | cuota a compensar en periodos siguientes; se arrastra hasta agotarse o hasta solicitar devolución (`HP_DEUDORA_IS` no aplica aquí) | No |

**Comprobaciones:** tras el asiento, `saldo(472) = saldo(477) = 0` **en el periodo** (tolerancia 0); `4700` nunca queda con saldo acreedor ni `4750` con saldo deudor; `outputCents` e `inputCents` se **derivan del diario**, jamás de un input libre del usuario (P1); las cuotas de ISP aparecen simultáneamente en 472 y 477 y por tanto se neutralizan solas.

> Ejemplo (fixture, ejemplo): 1T repercutido `411 000` − soportado `113 820` ⇒ **a ingresar `297 180`**; 3T repercutido `304 500` − soportado `405 300` ⇒ **a compensar `100 800`** (4700 al debe); 4T repercutido `363 300` − soportado `17 010` − compensación `100 800` ⇒ **a ingresar `245 490`**.

---

### T-25 · `IMPUESTO_BENEFICIOS` · T-26 · `REGULARIZACION_RESULTADO`

| # | Línea | Clave / cuenta | Debe | Haber | Regla de cálculo | Analítico |
|---|---|---|---|---|---|---|
| T-25 | 1 | `IMPUESTO_BENEFICIOS_GASTO` (630) | `cuota` | — | `cuota = applyBps(base_imponible, tipoIS)` donde la base imponible viene de la liquidación (ajustes extracontables **fuera** del motor; E9) | No (`NO_ANALITICO`) |
| T-25 | 2 | `HP_ACREEDORA_IS` (4752) \| `HP_DEUDORA_IS` (4709) | — / `devolución` | `cuota − pagos a cuenta` / — | pagos fraccionados previos en 473/4709 minoran la cuota | No |
| T-26 | 1..n | toda cuenta de grupo **7** con saldo acreedor | `saldo_acreedor` | — | `saldo = Σhaber − Σdebe` de líneas con `kind ∉ {REGULARIZATION, CLOSING, OPENING}` | No |
| T-26 | n+1..m | toda cuenta de grupo **6** con saldo deudor | — | `saldo_deudor` | ídem | No |
| T-26 | m+1 | `RESULTADO_EJERCICIO` (129) | `−resultado` si pérdida | `resultado` si beneficio | `resultado = Σ(haber − debe)` de las líneas 6/7 = **I3** | No |

**Comprobaciones T-26:** tras el asiento, **toda** cuenta 6/7 queda a saldo 0 (tolerancia 0); `saldo acreedor de 129 = I3` (invariante I3, segunda mitad); el asiento lleva `kind = REGULARIZATION` y por tanto **queda excluido** del cálculo de la PyG — si no, la PyG se duplicaría a cero; una cuenta 6/7 con saldo pero **sin** línea en la regularización es un FAIL de Auditoría. Las líneas de T-26 **no llevan destino analítico**: son un movimiento de patrimonio, y I4 las excluye por `kind`.

> Ejemplo (fixture, ejemplo): resultado antes de impuesto `1 996 430 c`; IS 25 % = `499 108 c`; resultado del ejercicio = **`1 497 322 c`** = saldo acreedor de 129.

---

### T-27 · `CIERRE_EJERCICIO` · T-28 · `APERTURA_EJERCICIO`

| # | Línea | Regla de cálculo | Analítico |
|---|---|---|---|
| T-27 | 1..n | Por **cada cuenta de balance** (grupos 1–5) con saldo ≠ 0 tras T-26: si el saldo es deudor, línea al **haber** por su importe; si acreedor, al **debe**. Resultado: todas las cuentas a 0 | No |
| T-28 | 1..n | Espejo exacto del asiento de cierre, con fecha del **primer día del ejercicio siguiente** y `fiscalYearId` del nuevo ejercicio: saldo deudor al debe, acreedor al haber | No |

**Comprobaciones:** ninguna cuenta de grupo 6/7 puede aparecer en T-27 (deben estar ya a 0 por T-26) — si aparece, FAIL; `Σdebe = Σhaber` del cierre **es** la comprobación de I2 (`Activo = Pasivo + PN`, con el resultado ya en 129); la apertura debe reproducir el cierre **línea a línea** (mismo conjunto de cuentas, importes idénticos, columnas invertidas): un `diff` de un céntimo bloquea; T-27 es el **último** asiento del ejercicio y T-28 el **primero** del siguiente (`entryNumber = 1`); tras el cierre, `FiscalYear.status = CLOSED` y no admite más asientos (§2.3).

---

## 2. Numeración, fechas y periodos

### 2.1 Numeración correlativa sin huecos

| Regla | Especificación |
|---|---|
| N-1 | `entryNumber` es **entero ≥ 1, correlativo por `(organizationId, fiscalYearId)`**, sin huecos ni repeticiones. Unicidad garantizada por `@@unique([organizationId, fiscalYearId, entryNumber])` (I7) |
| N-2 | Se asigna **al postear**, no al redactar el borrador: `SELECT lastEntryNumber FROM fiscal_years WHERE id = $1 FOR UPDATE` → `+1` → `UPDATE` → `INSERT`, todo en la misma transacción. El `FOR UPDATE` serializa; no se usan secuencias de Postgres porque una secuencia **deja huecos** al hacer rollback |
| N-3 | Un asiento que falla cualquier validación **no consume número**: la validación entera (C-1…C-13) es previa al `FOR UPDATE` |
| N-4 | El número **no se reutiliza ni se reasigna**. Un asiento erróneo se anula con contra-asiento (T-21), que consume su propio número |
| N-5 | El orden de numeración debe ser **no decreciente en `entryDate`** (art. 28 CCom, "por orden de fechas"). Al insertar un asiento con fecha anterior al último posteado dentro de un mes abierto, el motor **no renumera**: asigna el siguiente número y el libro diario se **ordena por `(entryDate, entryNumber)`** al presentarse. La Auditoría lista los asientos fuera de secuencia como Info, no como FAIL |
| N-6 | Alternativa admitida por organización (`Organization.renumberOnClose`): renumeración **una sola vez**, al cerrar el mes, dentro del mes que se bloquea, ordenando por `(entryDate, id)`. Al bloquear el mes los números quedan congelados para siempre. Nunca se renumera un mes bloqueado ni un ejercicio cerrado |
| N-7 | Los `kind` de sistema no rompen la regla: en el ejercicio, `OPENING` es siempre el **nº 1** y `CLOSING` el **último**; `REGULARIZATION` va inmediatamente antes del cierre |

### 2.2 Tres fechas, tres significados

| Campo | Qué es | Quién la fija | Uso |
|---|---|---|---|
| `documentDate` | Fecha de expedición del documento (factura, extracto, recibo) | El documento / OCR | Selección del `TaxRate` vigente (`selectTaxRate(rates, code, documentDate)`), numeración de la serie de facturación, casilla de la 303 |
| `accrualDate` | Fecha de **devengo** contable (NRV 14ª: prestación realizada, riesgos transmitidos) | El usuario, default `documentDate` | Determina el **periodo** al que se imputa el gasto/ingreso; es lo que separa T-15…T-18 de un asiento normal |
| `entryDate` | Fecha **contable del asiento**, la única persistida en `JournalEntry.entryDate` y `JournalLine.entryDate` | El motor | Ejercicio, mes de bloqueo, informes, `ledgerHash` |

**Regla de derivación (`resolveEntryDate`)**, determinista:

```
candidate = accrualDate ?? documentDate
si ejercicio(candidate) es OPEN y mes(candidate) no bloqueado   → entryDate = candidate
si ejercicio(candidate) es OPEN pero el mes está bloqueado      → entryDate = primer día del primer mes abierto ≥ candidate
si ejercicio(candidate) es CLOSED                               → T-22 (ajuste de ejercicio cerrado):
                                                                   entryDate = primer día del primer mes abierto del primer ejercicio OPEN
si candidate > refDate                                          → error FUTURE_DATE, salvo entry marcada como previsión
```

En los dos casos de desplazamiento, la `description` incorpora obligatoriamente la referencia (`"[devengo 2025-11-30]"`) y el asiento guarda `documentDate`/`accrualDate` para que el drill-down explique el desfase. `entryDate` **nunca** puede ser anterior a `documentDate` menos el desplazamiento justificado, ni posterior a `refDate`.

### 2.3 Documentos de un ejercicio cerrado

| Situación | Tratamiento |
|---|---|
| Ejercicio `CLOSED` (cuentas formuladas) | **Prohibido** postear, anular o modificar en él (bloqueo en código y RLS). El documento se registra en el ejercicio abierto con T-22 |
| Importe material | Contra `113` (reservas) — sin efecto en la PyG corriente |
| Importe no significativo | Contra `678`/`778` — epígrafe 13, dentro del resultado de explotación |
| IVA soportado de un documento antiguo | Deducible en el periodo corriente si está dentro de los 4 años del art. 99 LIVA; si no, es mayor coste (a la línea de gasto) |
| Reapertura de un ejercicio cerrado | **No existe** como operación de usuario. Solo `ADMIN` + ADR + registro en `AuditLog`, y obliga a re-formular: fuera del alcance de E3 |

### 2.4 Bloqueo de meses (`PeriodLock`)

| Regla | Especificación |
|---|---|
| B-1 | `PeriodLock(organizationId, fiscalYearId, month)`: un mes bloqueado **no admite** nuevos asientos, ni contra-asientos, ni ediciones |
| B-2 | Bloqueo **secuencial**: no se puede bloquear el mes *n* si *n−1* está abierto (evita agujeros de periodo) |
| B-3 | Desbloqueo: solo `ADMIN`, con motivo, a `AuditLog`, y solo si el ejercicio sigue `OPEN`. Desbloquear el mes *n* desbloquea también *n+1…12* (no se puede tener un mes abierto entre dos bloqueados) |
| B-4 | Cerrar el ejercicio (`FyStatus = CLOSED`) exige los **12 meses bloqueados**, T-26 y T-27 posteados y los invariantes I1–I10 en PASS |
| B-5 | El bloqueo se verifica **en el trigger de BD**, no solo en la app: un import masivo no puede saltárselo |

### 2.5 Fecha del contra-asiento

```
si mes(entry.entryDate) está abierto y ejercicio OPEN → reversalDate = entry.entryDate     (misma fecha)
si no                                                 → reversalDate = primer día del primer mes abierto ≥ entry.entryDate
```

Cuando hay desplazamiento, la `description` es obligatoriamente `"Anulación del asiento nº <n> de <entryDate> — <reason>"` y el par queda enlazado por `reversesEntryId`. Consecuencia contable aceptada: si el original cae en un mes cerrado, el efecto en la PyG **cambia de periodo** (no se reexpresa un mes cerrado). Si además el original está en un **ejercicio** cerrado, no procede contra-asiento sino T-22. `requestedDate` del input solo puede **retrasar** la fecha respecto de la calculada, nunca adelantarla.

---

## 3. Invariantes I1, I7, I8, I9, I10 — fórmula y casos límite

Definición canónica en `.claude/skills/fiabilidad/SKILL.md`; aquí, la formulación operativa para `lib/ledger/invariants.ts`.

### I1 — Partida doble por asiento (tolerancia 0)

```
∀ e ∈ journal_entries:  Σ_{l ∈ lines(e)} l.debit_cents − Σ_{l ∈ lines(e)} l.credit_cents = 0
```

| Caso límite | Regla | Efecto |
|---|---|---|
| Asiento de **una sola línea** | **Prohibido**: `count(lines) ≥ 2`. Una línea sola solo cuadraría con debe = haber = 0, que ya viola la siguiente regla | bloquea (C-4) |
| Línea con **debe y haber a 0** | Prohibida: `CHECK ((debit_cents = 0) <> (credit_cents = 0))` | bloquea (C-3) |
| Línea con **ambos > 0** | Prohibida por el mismo `CHECK` (convención: exactamente uno > 0) | bloquea |
| Importes **negativos** | Prohibidos: `CHECK (debit_cents >= 0 AND credit_cents >= 0)`. Un abono no es un importe negativo, es la columna contraria | bloquea |
| Asiento **sin líneas** | Imposible: el `constraint trigger` diferido evalúa `Σ = 0` con `count > 0`; un asiento vacío da `count = 0` y falla explícitamente | bloquea |
| Asiento con solo debe o solo haber | Prohibido: `≥ 1 línea con debe > 0` y `≥ 1 con haber > 0` | bloquea |
| Suma > 2³¹ | Los agregados usan `BIGINT`; la línea individual sigue siendo `Int` (límite práctico 21 474 836,47 € por línea, documentado) | — |
| Momento de la comprobación | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`: se evalúa **al COMMIT**, para poder insertar las líneas una a una | — |

### I7 — Unicidad y numeración

```
UNIQUE(organization_id, fiscal_year_id, entry_number)
∀ (org, fy):  { entry_number } = { 1, 2, …, max }        -- sin huecos
∀ (org, fy):  max(entry_number) = fiscal_years.last_entry_number
```

| Caso límite | Regla |
|---|---|
| Rollback de una transacción | No deja hueco: el número se toma con `FOR UPDATE` dentro de la misma transacción y se revierte con ella |
| Dos usuarios posteando a la vez | El `FOR UPDATE` sobre `fiscal_years` serializa; el segundo espera y toma `n+1` |
| Import masivo | Se numera en un solo `FOR UPDATE` con reserva de rango `[n+1, n+k]`; si falla una fila, falla el lote entero (all-or-nothing) |
| Asiento con fecha retroactiva | Toma el siguiente número (N-5); el orden de presentación es `(entry_date, entry_number)` |
| Ejercicio recién creado | `last_entry_number = 0`; el primer asiento es el **1** y debe ser el `OPENING` si el ejercicio no es el primero de la organización |
| Unicidad de dimensiones | `UNIQUE(organization_id, code)` en cuentas, proyectos, CECOs y líneas de negocio (parte de I7) |

### I8 — Fechas

```
∀ e:  fiscal_years[e.fiscal_year_id].start_date ≤ e.entry_date ≤ fiscal_years[…].end_date
∀ e:  fiscal_years[e.fiscal_year_id].status = 'OPEN'   en el momento del alta
∀ e:  ¬∃ PeriodLock(org, fy, month(e.entry_date))      en el momento del alta
∀ e:  e.entry_date ≤ refDate                            salvo e.isForecast
∀ l:  l.entry_date = entry(l).entry_date ∧ l.fiscal_year_id = entry(l).fiscal_year_id   (denormalización coherente)
```

| Caso límite | Regla |
|---|---|
| `OPENING` | Debe tener `entry_date = fiscal_year.start_date` exactamente |
| `CLOSING` y `REGULARIZATION` | Deben tener `entry_date = fiscal_year.end_date` exactamente |
| Ejercicio irregular (constitución, cambio de fecha de cierre) | Permitido: `endDate − startDate` puede ser < 12 meses; la única regla es que los ejercicios de una organización **no se solapen** y **no dejen huecos** |
| Ejercicio cerrado a posteriori | Los asientos existentes **no** se revalidan (los informes históricos no cambian); la restricción aplica al **alta** |
| Fecha futura | Bloqueada salvo `isForecast = true`, que además excluye el asiento de todos los informes de la Capa 1 |
| 29 de febrero, cambio de año | Las fechas son `@db.Date` sin zona; ninguna conversión a `Date` de JS con hora (ADR de fechas) |

### I9 — Cuenta válida del plan

```
∀ l:  ∃ a ∈ accounts:  a.organization_id = l.organization_id
                     ∧ a.code = l.account_code
                     ∧ a.is_postable = true
                     ∧ a.is_active = true          (en el momento del alta)
```

Reforzado por la **FK compuesta** `(organization_id, account_code) → accounts(organization_id, code)` (E2).

| Caso límite | Regla |
|---|---|
| Cuenta desactivada después de tener líneas | Las líneas históricas siguen siendo válidas y aparecen en informes; la cuenta no admite **líneas nuevas** (R-09) |
| Cuenta convertida en padre (le nacen hijos) | Prohibido si ya tiene líneas (R-05); así `is_postable` nunca pasa a `false` con movimientos detrás |
| Clave del mapa sin resolver | I-plan-1 (E2): `validateAccountMap` corre al arrancar `post.ts`; una clave rota bloquea **todas** las plantillas, no solo la afectada |
| Cuenta de otra variante PGC | Imposible: el plan es por organización y `pgcVariant` es inmutable con asientos posteados (R-14) |

### I10 — Aislamiento multi-tenant

```
∀ l:  l.organization_id = entry(l).organization_id
    ∧ l.organization_id = account(l).organization_id
    ∧ (l.project_id IS NULL      ∨ project(l).organization_id      = l.organization_id)
    ∧ (l.cost_center_id IS NULL  ∨ cost_center(l).organization_id  = l.organization_id)
    ∧ (l.business_line_id IS NULL∨ business_line(l).organization_id= l.organization_id)
    ∧ (l.tax_rate_id IS NULL     ∨ tax_rate(l).organization_id     = l.organization_id)
    ∧ (l.counterparty_id IS NULL ∨ counterparty(l).organization_id = l.organization_id)
∀ e:  fiscal_year(e).organization_id = e.organization_id
```

| Caso límite | Regla |
|---|---|
| FKs compuestas | Toda FK a una entidad de negocio incluye `organization_id` en la clave: la BD hace imposible el cruce, no solo la app |
| Acceso | Todo pasa por `tenantDb(orgId)` / `tenantTransaction`; RLS como segunda barrera (E3 retira los escapes de E1, ADR-0007) |
| Denormalización de `business_line_id` | Se copia del proyecto **en el momento del alta**; si el proyecto cambia de línea de negocio, las líneas históricas conservan la suya (los informes de periodos cerrados no pueden cambiar) |
| Consulta de invariante | El check I10 se ejecuta **sin** filtro de tenant (rol de servicio) precisamente para poder detectar el cruce |

### Invariantes propios de E3 (nuevos, se añaden a la pestaña Auditoría)

| Id | Regla | Severidad |
|---|---|---|
| I-E3-1 | Un asiento `REVERSAL` tiene `reversesEntryId` no nulo, y su espejo cuadra a 0 por cuenta y por destino analítico con el original | FAIL |
| I-E3-2 | Como máximo **un** `REVERSAL` vivo por asiento anulado | FAIL |
| I-E3-3 | `voidedAt/voidedBy/voidReason` son informativos: **ninguna** query de informe los filtra | revisión de código |
| I-E3-4 | **Un `REVERSAL` no puede anularse con otro `REVERSAL`**: para deshacer una anulación se vuelve a registrar el hecho económico con un asiento nuevo (T-20 o la plantilla original), nunca con un contra-contra-asiento | FAIL |
| I-E3-5 | Todo asiento con `templateCode` reproduce exactamente lo que devuelve su plantilla para el mismo input (test de regresión sobre los fixtures) | FAIL |
| I-E3-6 | `OPENING` del ejercicio *n* = espejo del `CLOSING` del ejercicio *n−1*, línea a línea | FAIL |

---

## 4. Fixtures `ejercicio-completo.json` y `ejercicio-minimo.json`

Generados y verificados por **`docs/design/fixtures/build_ejercicio_completo.py`**. Los ficheros son **inmutables**: no se editan a mano, se regeneran; `python3 docs/design/fixtures/build_ejercicio_completo.py --check` reconstruye y falla si difiere en un solo céntimo (candidato a paso de CI).

### 4.1 Esquema

```jsonc
{
  "schemaVersion": "1.0",
  "organization": { "slug", "name", "baseCurrency", "pgcVariant", "taxRoundingMode",
                    "prorrataBps", "redondeoToleranciaCents", "analyticsRequired",
                    "useSubaccounts": false, "createSoftwareAccounts": false },
  "fiscalYear":       { "code", "startDate", "endDate", "status" },
  "fiscalYearsExtra": [ { "code": "2027", … } ],
  "accountsExtra":    [ { "code", "name", "parentCode" } ],     // vacío: todo sale del seed
  "businessLines":    [ { "code", "name", "sortOrder" } ],
  "projects":         [ { "code", "name", "businessLineCode", "status" } ],
  "costCenters":      [ { "code", "name", "kind", "marginLevel", "allocatable" } ],
  "entries": [ { "ref", "entryNumber", "date", "kind", "fiscalYearCode", "description",
                 "sourceType", "template", "reversesRef?",
                 "lines": [ { "accountKey" | "accountCode", "debitCents", "creditCents",
                              "projectCode?", "costCenterCode?", "taxRateCode?", "lineNo" } ] } ],
  "expected": { … }
}
```

`accountKey` se usa **siempre que existe clave**: 38 claves distintas aparecen en los asientos de plantilla. `accountCode` se reserva a (a) cuentas de negocio sin clave — `100`, `113`, `216`, `217`, `2816`, `2817`, `621`, `623`, `628`, `629`, `678`, `681` — y (b) los asientos generados **por saldos** (T-26 regularización, T-27 cierre, T-28 apertura), donde la cuenta no la elige la plantilla sino el propio saldo del mayor y por eso llega ya como código. `useSubaccounts = false` en el fixture, pero **la resolución sigue la regla real de `lib/accounts/map.ts::resolvePostable`**: si el código default no es postable (tiene hijos en el plan), se desciende a la hoja de menor código, que en el PGC es siempre la subcuenta "general". Por eso el fixture postea en `4300`, `4000`, `4100`, `6080`, `7080` y `6300`, no en `430`, `400`, `410`, `608`, `708` y `630`, que son cuentas padre y violarían I9 (corregido en v1.1 del script, antes del sellado). El script valida esto con una aserción: **toda línea, incluidas las de T-26/T-27/T-28 generadas por saldos, resuelve a una hoja postable**.

**Orden de líneas canónico (I-E3-5).** El orden de las líneas de cada asiento es el de la tabla de su plantilla en §1 y lo impone `canonical_rank()` del script, no el orden en que se escriba el input: sin esto, dos facturas de la misma plantilla (una con retención, otra con anticipo) producían secuencias distintas y la comparación byte a byte contra la plantilla era imposible. La plantilla `CONTRA_ASIENTO` es la excepción documentada: conserva el orden del asiento original, porque es su espejo.

### 4.2 Contenido

| Dimensión | Valor |
|---|---|
| Ejercicio | 2026 completo (12 meses) + apertura de 2027 |
| Líneas de negocio | 2 (`BL-CONS`, `BL-DEV`) |
| Proyectos | 3 (`P-01`, `P-02` en `BL-CONS`; `P-03` en `BL-DEV`) |
| CECOs | 6 (`CC-GA`, `CC-MKT`, `CC-OPS`, `CC-DEV`, `CC-FIN`, `CC-NA`) |
| Asientos | **84** (83 del ejercicio 2026 + 1 apertura de 2027), **326 líneas** |
| Plantillas cubiertas | **28 / 28** |

Cobertura por plantilla: `FACTURA_EMITIDA_SERVICIOS` 12 · `FACTURA_RECIBIDA` 10 · `AMORTIZACION_MENSUAL` 12 · `COBRO_CLIENTE` 6 · `NOMINA` 4 · `PAGO_NOMINA` 4 · `PAGO_SEGURIDAD_SOCIAL` 4 · `REGULARIZACION_IVA` 4 · `PAGO_PROVEEDOR` 3 · `PAGO_RETENCIONES` 3 · `AJUSTE_EJERCICIO_CERRADO` 2 · `APERTURA_EJERCICIO` 2 · `ASIENTO_MANUAL` 2 · `PAGO_IMPUESTO` 2 · y 1 de cada: `ABONO_EMITIDO`, `ABONO_RECIBIDO`, `ANTICIPO_CLIENTE`, `ANTICIPO_PROVEEDOR`, `CIERRE_EJERCICIO`, `CONTRA_ASIENTO`, `DEVENGO_PERIODIFICACION_GASTO`, `DEVENGO_PERIODIFICACION_INGRESO`, `FACTURA_RECIBIDA_ISP`, `IMPUESTO_BENEFICIOS`, `PERIODIFICACION_GASTO`, `PERIODIFICACION_INGRESO`, `REGULARIZACION_RESULTADO`, `TRASPASO_TESORERIA`.

Casos límite deliberadamente incluidos: dos tipos de IVA en un mismo documento · retención de IRPF practicada por el cliente · recargo de equivalencia 5,2 % · anticipo de cliente con IVA devengado y su posterior aplicación · IVA con prorrata 90 % (dos veces) · IVA íntegramente no deducible · inversión del sujeto pasivo (doble apunte neto 0) · rectificativas emitida y recibida · cobro parcial · comisión bancaria · diferencias de cambio en ambos sentidos · redondeo de 1 céntimo en cobro y en pago · anticipo a empleado aplicado en nómina · error de ejercicio cerrado material (113) y no significativo (678) · asiento duplicado anulado con contra-asiento · trimestre de IVA **a compensar** y su compensación en el trimestre siguiente.

### 4.3 Totales esperados (calculados por el script; céntimos)

| Magnitud | Valor |
|---|---|
| **Σ debe = Σ haber (todos los asientos)** | **67 193 629** |
| Σ debe = Σ haber (solo ejercicio 2026) | **52 884 809** |
| Resultado antes de impuesto | **1 996 430** |
| Impuesto sobre beneficios (25 %, ejemplo) | **499 108** |
| **Resultado antes de regularización (I3)** | **1 497 322** |
| Saldo acreedor de `129` tras T-26 | **1 497 322** (I3 ✓) |
| I2 (`Activo − Pasivo − PN` antes del cierre) | **0** |

Saldos **por cuenta hoja** a 31-12-2026 **antes del asiento de cierre** (signo: `Σdebe − Σhaber`; negativo = acreedor). Es el bloque autoritativo: son los códigos que contienen las líneas del diario.

| Cuenta | Saldo | Cuenta | Saldo | Cuenta | Saldo |
|---|---:|---|---:|---|---:|
| `4300` Clientes | 7 723 900 | `472` IVA soportado | **0** | `216` Mobiliario | 1 200 000 |
| `436` Dudoso cobro | 121 000 | `477` IVA repercutido | **0** | `217` Equipos | 2 100 000 |
| `4000` Proveedores | −1 959 800 | `4750` HP acreedora IVA | −245 490 | `2816` A.A. mobiliario | −300 000 |
| `4100` Acreedores | −2 587 100 | `4700` HP deudora IVA | **0** | `2817` A.A. equipos | −335 000 |
| `572` Bancos | 2 913 920 | `4751` HP retenciones | −75 000 | `100` Capital | −3 000 000 |
| `570` Caja | 30 000 | `4752` HP acreedora IS | −499 108 | `113` Reservas | −250 000 |
| `473` Retenciones soportadas | 120 000 | `476` SS acreedora | **0** | `120` Remanente | −3 560 000 |
| `407` Anticipos a proveedores | 100 000 | `465` Remuneraciones | **0** | `129` Resultado | −1 497 322 |
| `438` Anticipos de clientes | **0** | `480`/`485` Periodificaciones | **0** | `460` Anticipos remun. | **0** |

Liquidaciones de IVA (`expected.ivaQuarters`), en céntimos:

| Trimestre | Repercutido | Soportado | Compensación aplicada | Resultado |
|---|---:|---:|---:|---:|
| 1T | 411 000 | 113 820 | 0 | **297 180** a ingresar |
| 2T | 257 100 | 31 500 | 0 | **225 600** a ingresar |
| 3T | 304 500 | 405 300 | 0 | **−100 800** a compensar |
| 4T | 363 300 | 17 010 | 100 800 | **245 490** a ingresar |

**`expected.balancesByPrefix3Cents`** añade el mismo saldo **agregado por prefijo de 3 dígitos** (criterio del balance de sumas y saldos jerárquico): `430` 7 723 900 · `400` −1 959 800 · `410` −2 587 100 · `475` −819 598 (agrega 4750+4751+4752) · `281` −635 000 (agrega 2816+2817), etc. Es un check **adicional**, nunca el sustituto del saldo por hoja: al agregar por prefijo, un error entre dos hojas hermanas (postear en `4304` en vez de `4300`, o en `4751` en vez de `4752`) se cancela dentro del mismo padre y queda invisible — que es exactamente la clase de defecto que el agregado a 3 dígitos ocultó en v1.0. Regla: **el test compara por hoja; el agregado por prefijo se usa para conciliar con informes jerárquicos (mayor, sumas y saldos, balance por epígrafe), no para validar el diario.**

Retenciones (`expected.irpfQuarters`): 1T `120 300` · 2T `75 000` · 3T `75 000` ingresados; el 4T (`75 000`) queda vivo en `4751` a 31-12 (se ingresa en enero de 2027), que es exactamente el saldo de la tabla anterior.

### 4.4 `ejercicio-minimo.json`

5 asientos, el caso irreducible para tests de arranque: apertura (`572`/`100` por `500 000`), una factura emitida (`100 000` + IVA `21 000`), su cobro, la regularización (`705 → 129`) y el cierre. `Σdebe = Σhaber`, resultado `100 000`, saldo de `129` = `100 000`. Sirve para probar numeración, `kind`, exclusión de `REGULARIZATION`/`CLOSING`/`OPENING` de la PyG y el cuadre I2 sin ruido.

### 4.5 Cómo los consumen los tests

| Test | Fixture | Comprobación |
|---|---|---|
| `lib/ledger/invariants.test.ts` | ambos | I1 por asiento, I7 (numeración contigua por ejercicio), I8, I9, I10 |
| `lib/ledger/post.test.ts` | mínimo | numeración con `FOR UPDATE`, rechazo de descuadres, línea a 0, asiento de 1 línea |
| `lib/ledger/templates/*.test.ts` | completo | I-E3-5: cada asiento con `template` se reproduce con su plantilla y su input, byte a byte |
| `lib/reports/*.test.ts` (E6) | completo | PyG = 1 497 322 · balance cuadrado · cashflow = Δ57x |
| CI | ambos | `build_ejercicio_completo.py --check` en verde |

---

## 5. Veredicto sobre `docs/MODELO-DATOS.md` §Ejercicios y diario

### **CONFORME CON OBSERVACIONES** — la estructura soporta las 28 plantillas sin cambios de ruptura; faltan 5 campos y 2 restricciones para que el diseño de E3 sea implementable tal como está escrito aquí.

**Lo que está bien y no debe tocarse**

| Elemento | Valoración |
|---|---|
| `JournalEntry` / `JournalLine` como fuente única, con `Transaction` degradado a documento | Correcto y es la decisión estructural más valiosa (ADR-0003) |
| `EntryKind` con `OPENING/CLOSING/REGULARIZATION` explícitos y PyG definida por exclusión de `kind` | Correcto: es lo que hace I3 computable con una sola definición y evita el clásico "resultado duplicado" del asiento de regularización |
| `CHECK(debit>=0 AND credit>=0 AND (debit=0)<>(credit=0))` | Correcto: prohíbe de raíz importes negativos y líneas a 0, sin depender de la app |
| `constraint trigger` **diferido** para Σdebe=Σhaber | Correcto: permite insertar líneas una a una y comprueba al COMMIT |
| Anulación **solo** por contra-asiento, con `voidedAt/voidedBy/voidReason` informativos y ninguna query filtrando por ellos | Correcto y coherente con el principio 6 de SPEC-FIABILIDAD |
| `FiscalYear.lastEntryNumber` + `@@unique([organizationId, fiscalYearId, entryNumber])` + `FOR UPDATE` | Correcto: numeración sin huecos, que una secuencia de Postgres no daría |
| `PeriodLock` por `(fiscalYear, month)` | Correcto |
| Denormalización en `JournalLine` de `entryDate`, `fiscalYearId`, `entryKind`, `businessLineId` | Correcta y necesaria: los informes agregan sobre líneas sin `JOIN` al asiento |
| FK compuesta `(organization_id, account_code)` | Correcta: I9 e I10 en la BD, no solo en código |

**Observaciones — campos y restricciones que faltan** (todos Nivel 2: tocan el esquema del motor ⇒ ADR + firma humana)

| # | Carencia | Propuesta | Plantilla que la necesita |
|---|---|---|---|
| **O-1** | `JournalEntry` solo tiene `entryDate`. Las tres fechas de §2.2 no son representables, y sin ellas el desplazamiento por mes bloqueado o por ejercicio cerrado es **invisible** en el drill-down y **no reproducible** (viola P7) | `documentDate Date?`, `accrualDate Date?` en `JournalEntry` | T-01…T-05, T-22, T-21 |
| **O-2** | No se sella el método de redondeo del documento. R-IVA-4 exige que el asiento sea recalculable para siempre, y `Organization.taxRoundingMode` es mutable | `taxRoundingMode TaxRoundingMode` en `JournalEntry` | T-01…T-05 |
| **O-3** | No hay `templateVersion`. Si una plantilla cambia, I-E3-5 no puede distinguir "asiento antiguo correcto" de "asiento incorrecto" | `templateVersion Int` junto a `templateCode` | todas |
| **O-4** | Falta la restricción que impide anular un `REVERSAL` (I-E3-4) y la que impide dos `REVERSAL` vivos sobre el mismo asiento (I-E3-2) | `UNIQUE(organization_id, reverses_entry_id)` parcial + `CHECK` en trigger: `reverses_entry_id` no puede apuntar a un asiento con `kind = 'REVERSAL'` | T-21 |
| **O-5** | Nada obliga a que `OPENING` sea `entryNumber = 1` ni `CLOSING` el último, ni a que sus fechas sean los extremos del ejercicio | Trigger o check de aplicación con test sobre el fixture | T-27, T-28 |
| **O-6** | `JournalLine` no tiene campo para el importe en divisa ni el tipo de cambio; T-08/T-09 registran la diferencia (668/768) pero el importe original se pierde | `originalCurrency String?`, `originalAmountCents Int?`, `exchangeRateId String?` | T-08, T-09 |
| **O-7** | `Organization.prorrataPermille` está declarado en **por mil**, mientras `TaxRate` ya migró a **bps**. Mezclar dos escalas en el mismo cálculo (`applyBps(cuota, prorrata)`) es un error esperando a ocurrir | Renombrar a `prorrataBps Int?` (E-1 de E2 aplicado también aquí) | T-03, T-04 |
| **O-8** | No hay campo para marcar previsiones, pero I8 las contempla ("sin fechas futuras salvo previsión marcada") | `isForecast Boolean @default(false)` en `JournalEntry`, excluido de todos los informes de Capa 1 | I8 |
| **O-9** | `SourceType` no distingue una factura **recibida** de un documento genérico (`DOCUMENT`), lo que complica el cuadre del libro registro de facturas recibidas (SII/303) | Añadir `INVOICE_IN` al enum | T-03…T-05 |

**Corrección de norma (afecta al enunciado de la épica, no al modelo):** las cuentas **679 y 779 no existen en el PGC 2007** (se suprimieron con el resultado extraordinario) y no están en `seeds/npgc.csv`. El tratamiento de documentos de ejercicios cerrados es **113/121** (error material o cambio de criterio, NRV 22ª) y **678/778** (importes no significativos, epígrafe 13 "Otros resultados", dentro del resultado de explotación). El documento y el fixture aplican esta regla.

**Nada de lo anterior invalida el modelo.** O-1, O-2, O-4 y O-7 deberían entrar en la migración de E3 (son baratos ahora y caros después de tener asientos posteados); O-3, O-5, O-6, O-8 y O-9 admiten diferirse a E5/E8 sin bloquear las plantillas de esta épica.

---

## 6. Respuestas al arquitecto (`docs/design/E3-libro-diario.md` §9.2)

### 6.1 — Serie única por ejercicio, **no** series por tipo de asiento

**Decisión: una sola serie correlativa por ejercicio, como propone el diseño. No se crea `EntrySeries`.** El art. 28.2 CdC exige que el libro diario registre *"día a día"* y *"por orden de fechas"* todas las operaciones, y el art. 29.1 que los libros se lleven *"por orden de fechas, sin espacios en blanco, interpolaciones, tachaduras ni raspaduras"*: el libro diario es **uno**, y su correlatividad es la garantía de integridad exigida por la norma. Las "series" de los despachos son un artefacto de presentación de sus programas (diarios auxiliares de ventas, compras, tesorería), no una exigencia contable: se reproducen en el ERP **filtrando por `sourceType`/`templateCode`** al presentar el diario, sin tocar la numeración. Lo que sí es de serie múltiple obligatoria es la **facturación emitida** (art. 6.1.a y 11 RD 1619/2012), y eso ya vive en `InvoiceSeries`, que es otra cosa: numera facturas, no asientos. Se mantiene `FiscalYear.lastEntryNumber` + `FOR UPDATE`, y las reglas N-1…N-7 de §2.1 (con `OPENING` = nº 1 y `CLOSING` = último) dan a apertura y cierre la identidad que se busca con una serie propia, sin fragmentar el diario.

### 6.2 — Fecha del contra-asiento: la del original si su mes sigue abierto; si no, **primer día del primer mes abierto**, no "hoy"

**Decisión: la regla de §2.5, que corrige el diseño en el segundo tramo.** Misma fecha que el original mientras el mes esté abierto (el hecho anulado y su anulación pertenecen al mismo periodo: es lo único coherente con el devengo, NRV 14ª, y evita ensuciar dos meses con un hecho económico que nunca existió). Si el mes está bloqueado, la alternativa "fecha de hoy" del diseño **es incorrecta cuando "hoy" cae en un mes distinto del primero abierto**: produciría un asiento posterior a periodos ya reabiertos y dejaría un hueco de dos meses entre el error y su corrección. La regla correcta es el **primer día del primer mes abierto ≥ `entryDate` del original**, que es la fecha más temprana admisible sin reexpresar un periodo presentado, y en el caso normal (se anula algo del mes recién cerrado) coincide con "hoy" salvo por el día. Obligatorio: `description = "Anulación del asiento nº <n> de <fecha> — <motivo>"` y `reversesEntryId`. Si el original está en **ejercicio cerrado**, no hay contra-asiento: se va a T-22 (§6.4).

### 6.3 — Prorrata de IVA: **se aplica en E3**; la regularización anual se aplaza a E9

**Decisión: la prorrata entra en E3, la regularización anual no.** Son dos cosas distintas y solo la segunda es diferible. El art. 103 y ss. LIVA y la Resolución del ICAC sobre determinación del coste obligan a que la cuota **no deducible forme parte del precio de adquisición** del bien o servicio (NRV 2ª y 10ª): no es un ajuste de la cuenta 472, es **el importe de la línea de gasto o de inmovilizado**. Si E3 "lee la prorrata y la ignora", toda factura de una organización con prorrata queda contabilizada con un gasto **infravalorado** y un 472 **sobrevalorado** — es decir, con la PyG, el balance, el MC1/MC2 y el coste de los proyectos mal desde el primer asiento, y con un 472 que ninguna liquidación del 303 cuadrará. Rehacerlo después obliga a reexpresar asientos ya posteados, que es justo lo que el modelo prohíbe. El coste de hacerlo ahora es una línea de la plantilla T-03/T-04 (`deductibility: FULL | NONE | PRORRATA`, con `NDᵢ = cuotaᵢ − applyBps(cuotaᵢ, p)` sumado a la línea de gasto), ya especificada, con dos casos en el fixture. **Sí se aplaza a E9** la *regularización anual de la prorrata definitiva* y la de *bienes de inversión* (5/10 años, arts. 105–110 LIVA), que son asientos anuales independientes contra `AJUSTE_IVA_NEGATIVO` (634) / `AJUSTE_IVA_POSITIVO` (639) y no tocan ni 472 ni las plantillas de E3. Requisito de esquema: `prorrataPermille` debe renombrarse a **`prorrataBps`** antes de usarse (O-7 de §5); mezclar por mil y puntos básicos en `applyBps` es un error latente.

### 6.4 — Anulación en ejercicio cerrado: **rectificación en el ejercicio abierto; sin mecanismo de reapertura**

**Decisión: la prohibición del diseño (`FY_CLOSED`) es correcta y suficiente.** Un ejercicio cerrado tiene cuentas anuales **formuladas** por los administradores (art. 253 LSC) y, normalmente, **aprobadas y depositadas** (arts. 272 y 279 LSC): tocar un asiento suyo equivale a modificar unas cuentas ya rendidas, lo que solo puede hacerse por el procedimiento societario de reformulación, nunca por una operación de usuario en un ERP. La vía contable es la que ya recoge T-22 (§1, NRV 22ª): **113/121** para el error material o el cambio de criterio, **678/778** para lo no significativo, siempre con asiento en el ejercicio abierto y desglose en la memoria. No se implementa reapertura: si excepcionalmente procede (reformulación acordada antes de la aprobación), es una operación de `ADMIN` con ADR, `AuditLog` y regeneración de informes, fuera del alcance de E3. Corolario ya incorporado: `PeriodLock` es reversible por `ADMIN` (mes), `FyStatus = CLOSED` no lo es.

### 6.5 — Asientos de una sola línea: **no existen; el mínimo de 2 se mantiene**

**Decisión: confirmar el trigger `≥ 2` líneas, sin excepciones.** Un asiento de una línea solo puede cuadrar con debe = haber = 0, que el `CHECK((debit=0) <> (credit=0))` ya prohíbe: la partida doble (art. 25.1 CdC y todo el PGC) no admite un apunte sin contrapartida. Los tres casos que suelen invocarse no son excepciones: (a) el *asiento de ajuste técnico* o reclasificación es siempre entre dos cuentas (`430 → 436`, `572 → 570`) y por tanto tiene dos líneas; (b) las *cuentas de orden* del antiguo grupo 0 desaparecieron del PGC 2007 y su información va a la memoria, no al diario; (c) los *asientos estadísticos o extracontables* (unidades, horas, presupuesto) no son asientos: viven en `TimeEntry`, `Budget` y la capa analítica, que por ADR-0004 nunca toca el diario financiero. Refuerzo aprobado en §3 (I1): además de `≥ 2` líneas, se exige **≥ 1 línea con debe > 0 y ≥ 1 con haber > 0** — un asiento de dos líneas ambas al debe cuadraría a 0 solo con importes 0 y ya está bloqueado, pero la comprobación explícita da un mensaje de error útil en vez de uno críptico.

### 6.6 — `dueDate` en la línea: correcto, y **una línea por vencimiento**

**Decisión: `dueDate` en `JournalLine`, como está, y desglose por plazos cuando la factura los tiene.** El vencimiento es un atributo del **crédito o de la deuda**, no del hecho económico: una misma factura con pago a 30/60/90 días genera tres derechos de cobro con vencimientos distintos, y el art. 6.1.n) RD 1619/2012 obliga a consignar la fecha de vencimiento en la factura cuando difiere de la de expedición. Guardarlo en el asiento haría inviables el aging (430/400 por tramos), la previsión de tesorería (E10), la conciliación de un cobro parcial contra el plazo concreto y el cumplimiento del informe de periodo medio de pago (Ley 15/2010 y art. 262 LSC). Regla operativa para las plantillas: **T-01/T-03 emiten una línea de `CLIENTES`/`PROVEEDORES` por vencimiento**, cada una con su `dueDate` y su importe, cuya suma es el total del documento (C-5 sigue cuadrando); con vencimiento único, una sola línea, que es el caso del fixture. `dueDate` es `NULL` en toda línea que no sea de una cuenta de crédito/deuda comercial (43x, 40x, 41x, 44x, 47x), y la Auditoría lista como WARN las líneas de esas cuentas con `dueDate` nulo, porque son las que se caen del aging.
