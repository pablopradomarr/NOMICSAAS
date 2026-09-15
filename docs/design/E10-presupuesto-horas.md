# E10 — Presupuesto y horas (diseño)

> Entregable del agente `arquitecto`. **Ronda 1, cerrada.** La validación de
> control de gestión `docs/design/E10-validacion-controlling.md` dio **CONFORME
> CON OBSERVACIONES** con **cinco bloqueantes** (O-E10-1, O-E10-2, O-E10-4,
> O-E10-5, O-E10-6), **veintidós observaciones** en total (O-E10-0…22), las
> **siete respuestas** a Q-1…Q-7, **cinco invariantes nuevos** (I-E10-14…18) y un
> **contrato de cifras a congelar antes de T10** (§6 de la validación).
> **Las veintitrés están incorporadas** —las veintidós de la validación más
> **O-E10-23**, del cierre— y ADR-0018 pasa de cinco decisiones a **seis** (D6
> congela el contrato de cifras). **ADR-0018 está APROBADO** por Pablo el
> 2026-09-14 (permiso general delegado de 2026-09-04): E10 queda lista para
> `/sprint E10`.
>
> **O-E10-0 aplicada:** la validación se llama
> `docs/design/E10-validacion-controlling.md`; toda referencia a
> `E10-validacion-presupuesto.md` queda corregida aquí y en ADR-0018.
>
> Documentos que mandan sobre éste: `docs/spec/SPEC-FIABILIDAD.md` (P1–P7),
> `CLAUDE.md` §«Estándar de calidad», `.claude/skills/fiabilidad/SKILL.md`
> (I1–I10 e I-E3/E4/E5/E6/E7/E8/E9-*, **definidos una sola vez y aquí sólo
> agregados**), `.claude/skills/contabilidad-analitica/SKILL.md`,
> `.claude/skills/estados-financieros/SKILL.md`, y **ADR-0003, 0004, 0006, 0009,
> 0010, 0011, 0012, 0013, 0016**.
>
> Código real sobre el que se diseña: `lib/analytics/{allocate,margins,invariants,types,hash}.ts`,
> `models/{allocations,margins,analytics,reports,closing}.ts`,
> `lib/ledger/report-run.ts`, `tests/support/fixtures.ts`,
> `docs/design/fixtures/build_ejercicio_completo.py`.
>
> Formato de referencia: `docs/design/E9-cierre-recurrentes.md`.

---

## 0. Ronda 1 — qué cambió y dónde

### Los cinco bloqueantes

| Obs. | Qué cambia | Sección |
|---|---|---|
| **O-E10-1** | El `timeHash` se sella sobre la **ventana efectivamente consumida** por el run (`YTD` ⇒ desde el inicio del ejercicio; `PRIOR_PERIOD` ⇒ desde el periodo anterior), y la ventana se **persiste** en el run. Con la ventana del periodo, un run con fallback `YTD` no aparecía `STALE` al aprobarse un parte de enero: el fallo exacto que D1 dice cerrar | §2.2, §3.5, §3.6, §3.8, **I-E10-17**, D1 |
| **O-E10-2** | `W-E10-UNAPPROVED-HOURS` se emite **siempre que haya minutos sin aprobar** de receptores elegibles en la ventana, no sólo con base 0, con importe y % sobre la base; y mueve el sello **del `AllocationRun`** con `HORAS_SIN_APROBAR` | §3.6, §5.3 (EV-15) |
| **O-E10-4** | **Presupuesto y real se comparan en el MISMO estado de imputación.** `buildBudgetMatrix` pasa por una **liquidación presupuestaria en dry-run puro** con las mismas reglas vigentes y el mismo `allocate()`, alimentada por las **horas presupuestadas**; sin ella, las celdas de MC3 y por debajo **no se publican** por dimensión. Nunca una matriz mixta | §3.2, §3.3, §5.1, **I-E10-18**, D4 |
| **O-E10-5** | **`EV-14` se retira**: un `BORRADOR` no puede producir un `ReportRun` (el CHECK de M5 lo hacía imposible). La comparación contra un borrador es **previsualización no sellada**; `PRESUPUESTO_NO_SELLADO` deja de ser motivo de sello y pasa a ser rechazo `BUDGET_NOT_SEALED` | §4.2, §5.3, D5 |
| **O-E10-6** | **El signo del importe presupuestado lo fuerza el tipo analítico efectivo**, con validación al guardar, CHECK de refuerzo, excepciones declaradas con aviso, y rechazo del CSV completo si > 90 % de las líneas de grupo 6 vienen en positivo | §2.3 M2, §3.2, §4.2, **I-E10-14** |

### Las respuestas a Q-1 … Q-7

| Q | Decisión adoptada |
|---|---|
| **Q-1** | `COSTE_EMPRESA_CON_SS` por defecto = **`640` + `642` + `645` + `649`**; **`641` (indemnizaciones) excluido** por no recurrente y por contaminar la tarifa del último periodo del empleado (O-E10-11) |
| **Q-2** | **MINUTOS ENTEROS.** Se confirma el contrato de E5 y se **retira la divergencia** de la ronda 0: la fuente primaria es el registro de jornada del art. 34.9 ET, que se lleva en `hh:mm`, y toda conversión a centésimas pierde décimas de minuto por parte (≈ 29 h/año con 8 800 partes) |
| **Q-3** | **Modelo de absorción plena en la tarifa (modelo A)**: las horas no productivas quedan fuera del driver **y** del denominador, y su coste **no se vuelve a repartir**. El reparto lo hace la regla `HOURS` sobre el **saldo real del CECO**; la tarifa es unidad de medida para KPI, **no** una segunda vía de imputación (O-E10-14) |
| **Q-4** | Presupuesto **sólo de explotación**, y `proposeDepreciationBudget()` precarga la `68x` con la dotación de los activos ya en alta (propuesta, nunca aplicación). **CAPEX y `BudgetCapexLine` → E11** |
| **Q-5** | **No** se presupuesta sobre una LN sin proyecto; el caso real —presupuestar en noviembre negocio aún no contratado— se resuelve con un **proyecto contenedor** `P-<LN>-NUEVOS` (`PLANNED`, excluido del reparto), y su reasignación posterior es una `REVISADO n` fechada |
| **Q-6** | Descomposición **volumen / precio con el cruce al precio**: `Δvolumen = ⌊(Q_r − Q_p) × Importe_ppto / Q_p⌋` y `Δprecio = Δtotal − Δvolumen` (**residuo ⇒ suma exacta**). **No se implementa en E10**; la convención queda **congelada** en D6. Sin efecto mezcla |
| **Q-7** | `HEADCOUNT` = **Σ `fteMilli` de los snapshots mensuales del periodo (FTE·mes)**. Para un run mensual es idéntico al stock actual —el fixture no se mueve—; para trimestre y año deja de ser falso. CECO sin snapshot: peso 0, aviso **y** motivo de sello `PLANTILLA_AUSENTE` |

### Las dieciocho observaciones no bloqueantes

| Obs. | Dónde entra |
|---|---|
| **O-E10-0** | Cabecera: la validación es `E10-validacion-controlling.md` |
| **O-E10-3** | §3.5: **una sola** forma canónica del `timeHash`, `fecha\|códigoEmpleado\|códigoReceptor\|minutos\|productiva`, **sin `id`** |
| **O-E10-7** | §2.2: **`BudgetLine.marginLevel` congelado en la línea** y dentro del `budgetHash` — E5-D1 aplicada al presupuesto |
| **O-E10-8** | §4.1 y **I-E10-15**: `sealBudget` cierra la anterior con `validTo = validFrom − 1 día` en la misma transacción; sin huecos de vigencia |
| **O-E10-9** | §2.2 y **I-E10-16**: `Budget.partialFrom`; el informe **compone** BASE + REVISADO con procedencia mes a mes |
| **O-E10-10** | §2.2 y §2.3: `BudgetHoursLine` gana las tres FK compuestas, el CHECK de día 1, el trigger de mes en ejercicio y **dos índices parciales** |
| **O-E10-11** | §3.5 y D3: prefijos `640/642/645/649`; `641` fuera |
| **O-E10-12** | §3.5: la derivación es **por CECO** por defecto; la individual exige `counterpartyId` en las líneas `64x` y **declara su cobertura**, no evaluable por debajo del umbral |
| **O-E10-13** | §3.5: el Hamilton del coste-hora, **definido**: `T = ⌊Σ mᵢrᵢ / 60⌋` repartido por mayor resto sobre `mᵢrᵢ`, desempate por `(fecha, código de empleado, id)` |
| **O-E10-14** | §2.2 y D3: `COSTE_TOTAL_CON_ESTRUCTURA` **excluyente** con reglas de actividad vigentes |
| **O-E10-15** | §5.2: agregar receptores con `basis` distinta ⇒ KPI **no evaluable** con las bases en conflicto |
| **O-E10-16** | §3.6, §5.3 (EV-16), **I-E10-11** reescrito; aviso cuando `HEADCOUNT` reparte a CECOs sin regla propia hacia proyectos |
| **O-E10-17** | §5.3: **EV-15**, **EV-16** y **EV-17**; ningún motivo de sello sin regla que lo emita |
| **O-E10-18** | §5.3: cuarto KPI **`desviacionMaxDimension`**, sobre `max \|desviación\|` **por dimensión** |
| **O-E10-19** | §2.2: `referenceProductiveMinutesPerYear = 90000` (1 500 h), sólo como denominador de respaldo |
| **O-E10-20** | §5.2: bloque de **desviación de absorción**, con signo, % y desglose por CECO. Informe, no invariante |
| **O-E10-21** | **I-E10-10**: techo agregado `Σ minutos por (empleado, fecha) ≤ 1 440` |
| **O-E10-22** | §3.7: `concentrationBps` **fijo en 10000**, sin parámetro |
| **O-E10-23** | §2.3 M2 (**`budget_lines_type_required`**), criterio 4-bis y la evidencia de **I-E10-14**: `analytic_type` pasa a ser **obligatorio en toda línea**. Con él nulo, el CHECK de signo de O-E10-6 **no evaluaba nada** —su primera rama lo deja pasar— y la celda tampoco tenía nivel de margen: era el hueco por el que un gasto en positivo seguía entrando |

### Las dos confirmaciones del experto

**(i)** La imputación de personal por horas **no genera ningún hecho contable**
(NRV 14ª, arts. 25–29 CdC, grupo 9 libre, ADR-0003/0004/0010): **confirmado**, con
el matiz —ahora escrito en §3.7— de que el camino (b) **mueve MC2 y MC3 de
periodos ya informados**, y que la ventana de ADR-0010 es la salvaguarda que lo
acota. **(ii)** Un presupuesto sellado **no es documento contable**: la ceremonia
del diseño es suficiente y proporcionada, y el CFO pide además **ver el diff entre
dos versiones**, que ahora es pantalla (§7).

---

## 0-bis. Deuda heredada: qué cierra E10 y qué re-fecha

El §Estándar de calidad de `CLAUDE.md` exige que lo aplazado se cierre en su
épica o se vuelva a fechar **con motivo**. Ésta es la lista completa de todo lo
que hoy dice «E10» en `docs/`, con su destino en este diseño.

### Se cierra en E10

| # | Deuda | Viene de | Dónde se cierra |
|---|---|---|---|
| 1 | **O-A6** — `Budget` con `@@unique` de tres columnas nullables: `NULL <> NULL`, no impide duplicados | E4 → E5 (ADR-0013, nota al pie) | §2.3 **M2**: cuatro índices únicos **parciales** + `CHECK ((project_id IS NULL) <> (cost_center_id IS NULL))`, con test que inserta el duplicado y espera `23505` (criterio 6) |
| 2 | **Drivers `HOURS` / `HEADCOUNT`** rechazados por acción y por `CHECK` | E5 (ADR-0013 D4) | §3.6, **M4** retira el `CHECK`; **D1** de ADR-0018 fija la base, el sello (`timeHash`) y la validación al sellar que ADR-0013 D4 exige (nunca una regla inerte) |
| 3 | **`TargetKind.MIXED`** — valor de enum sin uso | E5 | §2.3 **M6**: se **retira** del enum, con guardia que aborta si alguna fila lo usa |
| 4 | **`AllocationRunStatus.DRAFT`** — valor de enum sin persistencia | E5 | §2.3 **M6**: se **retira** igual. La simulación sigue siendo un dry-run puro (ADR-0013 D5) |
| 5 | **`ejercicio-completo-v2` no se puede cargar**: internamente incoherente (`4751` en las nóminas **y** la clave `IRPF_A_PAGAR_123`) | E9 (era T24) | §2.5 y **T20**: se **reversiona** a `schemaVersion 3.1` y se escribe `build_ejercicio_completo_v2.py`, que enruta **todas** las retenciones por `IRPF_A_PAGAR_111/115/123` (ADR-0016 D12) y no postea nunca contra `4751` |
| 6 | **N+1 de la staleness de CECOs**: se deriva run a run | E9 (era T26) | §3.9 y **T12**: `allocationRunStalenessBatch` — **tres** consultas para N runs, con los hashes agregados por periodo en SQL |
| 7 | **El formulario de alta de inmovilizado no ofrece proyecto ni CECO** | E9 | **T17**: `components/assets/asset-form.tsx` gana el selector de destino analítico (`dimension-combobox`), con la regla xor y el aviso de `analyticsRequired` |
| 8 | **PUEDE 12** — Σ Debe / Σ Haber del cuadre sumadas en cliente | E9 | **T17**: el cuadre lo compone el servidor junto con las líneas, y el cliente sólo lo pinta |
| 9 | **`ReportType.PRESUPUESTO_REAL`** declarado y rechazado en runtime (`models/reports.ts:157`) | E6 | §5 y **T13**: se implementa y sale de `NOT_IMPLEMENTED` |

### Se re-fecha, con motivo

Lo siguiente lleva la etiqueta «E10» en documentos de E3 y E9, pero **no es
presupuesto ni horas**: es fiscalidad y tesorería. Meterlo aquí convertiría la
épica en un cajón y dejaría lo que sí es suyo a medias.

| Deuda | Viene de | Nueva épica | Motivo |
|---|---|---|---|
| **Diferencias temporarias, BIN y ajustes extracontables** (`4740`/`4745`/`479` contra `6301`, NRV 13ª) | E9 §2, D9 | **E14 Fiscalidad del IS** (nueva, a planificar tras E11) | Es el impuesto sobre beneficios completo: base imponible, conciliación contable-fiscal y activos/pasivos por impuesto diferido. Tiene su propia validación contable y su propio ADR; no comparte ni una tabla con el presupuesto |
| **Regularización de bienes de inversión** (art. 107 LIVA, casilla 43) | E9 (O-12) | **E14** | Mismo bloque fiscal. La **guardia bloqueante** de E9 sigue impidiendo cerrar en silencio, así que no hay riesgo abierto |
| **Prorrata especial (art. 103.Dos) y sectores diferenciados (art. 101)** | E9 (Q-7) | **E14** | Hoy se **bloquean**, no se aproximan. Sigue siendo la conducta correcta |
| **`SettlementAllocation`** — imputación explícita de cobros/pagos a vencimientos con onerosidad distinta | E9 (O-6, R-RC-3) | **E12** | Es conciliación de partidas, hermana de la bancaria de E7. Hoy hay WARN que nombra el caso |
| **`JournalLine.isForecast` y la rama «salvo previsión marcada» de I8** | E3 (O-8) | **E12 Previsión de tesorería** | E10 **no introduce ninguna previsión en el diario** (ver §2.6 y D4): la reproyección es una vista derivada. La rama de I8 sigue retirada y toda fecha futura sigue bloqueando |
| **Parámetro del mes de alta de la amortización en la UI** | E3 §9.2 (b) | **E11** | Es una preferencia de organización de `/settings/assets`, no un cálculo. El motor ya lo fija en el asiento |

Ninguna de las seis queda sin épica, y las tres primeras van juntas a la misma
porque son el mismo problema contable.

---

## 1. Objetivo y alcance

E10 es **el plan frente a los hechos, y las horas que explican la diferencia**.
Cierra el requisito de `SPEC-FUNCIONAL.md` §3.4 («Presupuestos por
proyecto/CECO/mes; registro de horas opcional (driver y coste de personal)»),
§3.5 («Presupuesto vs real») y §3.4 (drivers «horas, headcount» de las reglas de
imputación).

Seis entregas:

1. **`Budget` versionado por ejercicio y escenario** (`BASE`, `REVISADO n`), con
   vigencia **sin solape ni hueco**, sello `budgetHash` e inmutabilidad tras
   sellar; líneas por **cuenta × mes × dimensión** (proyecto xor CECO; LN
   denormalizada) en céntimos, con **`marginLevel` congelado en la línea** y el
   **signo forzado por el tipo analítico**, y líneas de **horas presupuestadas**
   aparte.
2. **Reproyección (`forecast`)** como **vista derivada**: real hasta el último
   mes cerrado + presupuesto del resto, sin solape ni hueco. No es una tabla.
3. **`TimeEntry`**: parte de horas por empleado, fecha y destino (proyecto xor
   CECO), en **minutos enteros** —la unidad del registro de jornada del art. 34.9
   ET—, con aprobación, origen manual o import CSV, **inmutable tras aprobar** y
   corregible sólo por **contra-apunte**.
4. **`Employee` + `EmployeeRate`**: coste-hora vigente en céntimos con vigencias
   sin solape (`EXCLUDE`) y **`basis` explícita** (`COSTE_EMPRESA_CON_SS` =
   `640`+`642`+`645`+`649`, **sin `641`**), declarado o **derivado** de la nómina
   y de las horas productivas — derivado como **propuesta con sus términos**,
   nunca aplicado solo. **`HeadcountSnapshot`** mensual por CECO.
5. **Drivers `HOURS` y `HEADCOUNT`** vivos en las reglas de liquidación de E5,
   con su base sellada sobre la **ventana efectivamente consumida**
   (`timeHash` + su ventana), su `zeroBaseFallback`, el aviso de horas sin
   aprobar **también con base parcial** y la validación al sellar que ADR-0013 D4
   exige. Determinismo, Hamilton y cascada **sin un solo cambio**.
6. **Informes**: `PRESUPUESTO_REAL` sobre la matriz de E4 (presupuesto · real ·
   desviación absoluta · desviación % · forecast) por nivel de margen ×
   dimensión × mes, **presupuesto y real siempre en el mismo estado de
   imputación**, con provenance por celda, doble sello y umbrales `EV-*`; y
   **rentabilidad por proyecto con horas** (margen por hora, coste-hora medio,
   horas presupuestadas vs reales y **desviación de absorción**).

Más los motores puros **`lib/budget/`** y **`lib/time/`**, los invariantes
**I-E10-1…18**, y la deuda heredada de §0-bis.

### Qué NO incluye

- **No inventa invariantes ya existentes**: I1–I10 e I-E3/E4/E5/E6/E7/E8/E9-*
  siguen definidos donde están; E10 los **exige en PASS** y añade los suyos.
- **No almacena ni una cifra de informe** (ADR-0003). Ni la desviación, ni el
  forecast, ni el coste por hora, ni el margen por hora. Lo único que se
  persiste es el **presupuesto**, que es una **decisión**, no un cálculo — la
  misma razón por la que se persiste `AllocationLine` y no la matriz.
- **No genera ni un asiento contable.** La imputación del coste de personal a
  proyectos vive entera en la capa analítica (ADR-0004) o en la
  **reclasificación analítica auditada** de ADR-0010. No hay asientos de
  traspaso, ni cuentas del grupo 9, ni «asientos analíticos» de ninguna clase
  (§3.7).
- **No usa el LLM para nada** (P1, ADR-0005): ni para proponer un presupuesto, ni
  para repartir horas, ni para estimar un coste-hora.
- **No calcula nóminas** (`SPEC-FUNCIONAL.md` §4): se contabilizan y se leen.
  `Employee` es un maestro de controlling, no un expediente laboral.
- **No hace previsión de tesorería** (`isForecast`, vencimientos + recurrentes +
  presupuesto) → **E12**. La reproyección de E10 es de **PyG**, no de caja.
- **No introduce un driver `HEADCOUNT_AVG`** (media del periodo): no hay ninguna
  media ni ninguna división, sólo la suma **FTE·mes** de los snapshots del
  periodo, que para un run mensual coincide con el stock (Q-7, D1).
- **No implementa presupuesto de balance ni de inversiones**: el presupuesto es
  de **explotación** (grupos 6 y 7). E10 sí precarga la `68x` de los activos ya
  en alta con `proposeDepreciationBudget()`; el **CAPEX del grupo 2 y
  `BudgetCapexLine` van a E11** (Q-4), porque presupuestar el grupo 2 en
  `budget_lines` obligaría a levantar el CHECK y a mezclar un presupuesto de
  balance con uno de explotación en la misma tabla.
- **No permite presupuestar directamente sobre una línea de negocio sin
  proyecto**: la LN es un agregado de presentación y viaja denormalizada desde
  el proyecto (R-A9). El negocio aún no contratado se presupuesta en el
  **proyecto contenedor `P-<LN>-NUEVOS`** (Q-5). Razonado en §15.
- **No descompone la desviación en volumen y precio** ni el efecto mezcla: la
  **convención queda congelada** en D6 (cruce al precio, precio como residuo) y
  se implementa en E11, para que las columnas no cambien de significado (Q-6).

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

`@@map`/`@map` en **snake_case** en las siete tablas y en todos sus campos
(O-A5 es ley desde E4: el SQL de RLS, triggers e informes usa nombres físicos).
`organizationId` en **todas**, sin excepción — sin él no puede llevar RLS y sería
la puerta trasera del tenant. Dinero en **céntimos `Int`**; agregados en
**`BigInt`** (lección de E5: `integer` topa en 21 474 836,47 €, por debajo del
rango de producto). Tiempo en **minutos enteros** (`Int`), nunca decimales y
nunca centésimas de hora: la fuente primaria es el registro de jornada del
**art. 34.9 ET**, que se lleva en `hh:mm`, y todo `hh:mm` es un entero exacto de
minutos mientras que en centésimas no lo es (un minuto son 5/3 centésimas). Es la
**unidad del contrato de E5**, confirmada en Q-2. FTE en **milésimas enteras**
(`fteMilli`, 1000 = una jornada completa), la unidad que ya fijó el mismo
contrato. Fechas de periodo y de vigencia como
`@db.Date`; `DateTime` sólo para auditoría técnica (`approvedAt`, `sealedAt`,
`createdAt`). `@@unique([organizationId, id])` en toda tabla que sea destino de
FK compuesta por tenant (O-A1). Nada se borra: se archiva o se contra-apunta.

### 2.2 Fragmento Prisma

```prisma
// ─────────────────────────────────────────────────────────────────────────────
// E10 — Presupuesto y horas (docs/design/E10-presupuesto-horas.md, ADR-0018)
// ─────────────────────────────────────────────────────────────────────────────

/// `BASE` es la versión aprobada al abrir el ejercicio; `REVISADO` son las
/// reproyecciones sucesivas, numeradas por `revision` (1, 2, …). No hay más
/// escenarios: un «optimista/pesimista» es otra `REVISADO` con su vigencia, y
/// tratarlo como dimensión obligaría a elegir cuál es «el» presupuesto en cada
/// informe — decisión que debe tomar una persona y quedar escrita (D2).
enum BudgetScenario {
  BASE
  REVISADO
  @@map("budget_scenario")
}

/// `BORRADOR` se edita; `VIGENTE` está sellado y es inmutable; `SUSTITUIDO` lo
/// reemplazó otra versión. **No existe `ANULADO`**: una versión sellada no se
/// retira, se sustituye — es la misma doctrina que `AllocationRun` (ADR-0013 D5).
enum BudgetStatus {
  BORRADOR
  VIGENTE
  SUSTITUIDO
  @@map("budget_status")
}

enum BudgetLineSource {
  MANUAL
  CSV_IMPORT
  COPIED_FROM_VERSION
  @@map("budget_line_source")
}

/// Cabecera de UNA versión de presupuesto. Versionada, sellada e inmutable en
/// `VIGENTE` (patrón `AllocationRun` + `ReportRun`).
model Budget {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  fiscalYearId String     @map("fiscal_year_id") @db.Uuid
  fiscalYear   FiscalYear @relation(fields: [organizationId, fiscalYearId], references: [organizationId, id])

  scenario BudgetScenario
  /// 0 en `BASE`; 1..n en `REVISADO`. `(ejercicio, escenario, revisión)` es la
  /// identidad y produce el código visible `2026-BASE` / `2026-REV2`.
  revision Int            @default(0)
  name     String         @db.VarChar(120)
  note     String?        @db.VarChar(1000)

  status BudgetStatus @default(BORRADOR)

  /// **Vigencia** (D2): desde qué fecha esta versión es la que manda para los
  /// informes. `validTo` **lo cierra `sealBudget` en la misma transacción** con
  /// `validFrom(nueva) − 1 día` (O-E10-8): el `EXCLUDE` impide el solape, pero
  /// no impedía el **hueco**, y un mes sin versión vigente disparaba
  /// `PRESUPUESTO_AUSENTE` teniendo presupuesto. I-E10-15 exige la continuidad.
  validFrom DateTime  @map("valid_from") @db.Date
  validTo   DateTime? @map("valid_to") @db.Date

  /// **O-E10-9.** `NULL` = la versión cubre los DOCE meses del ejercicio.
  /// Con valor (primer día de un mes), la versión es **parcial**: sustituye
  /// desde ese mes y el informe **compone** BASE(ene–jun) + REVISADO(jul–dic)
  /// diciendo de qué versión sale cada mes, igual que `provenanceByMonth` hace
  /// con el forecast. Sin esto, una revisión de julio que sólo trae jul–dic
  /// desinfla el año a la mitad **y nada lo dice** (I-E10-16).
  partialFrom DateTime? @map("partial_from") @db.Date

  /// Sello de la versión. `NULL` mientras es `BORRADOR`; NOT NULL en cuanto se
  /// sella, y a partir de ahí **I-E10-6** lo recomputa sobre lo que la fila
  /// tiene hoy: editar una línea por SQL delata la versión.
  budgetHash       String? @map("budget_hash") @db.Char(64)
  /// El nivel de cada línea depende de `MarginLevelConfig`: si cambia, el
  /// presupuesto se lee en otra fila de la matriz. Entra en `budgetHash`.
  marginConfigHash String? @map("margin_config_hash") @db.Char(64)
  gitSha           String? @map("git_sha") @db.VarChar(64)

  sealedAt       DateTime? @map("sealed_at")
  sealedById     String?   @map("sealed_by_id") @db.Uuid
  supersededById String?   @map("superseded_by_id") @db.Uuid
  supersededBy   Budget?   @relation("BudgetSupersedes", fields: [supersededById], references: [id])
  supersedes     Budget[]  @relation("BudgetSupersedes")

  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  lines      BudgetLine[]
  hoursLines BudgetHoursLine[]

  @@unique([organizationId, fiscalYearId, scenario, revision], map: "budgets_version_unique")
  @@unique([organizationId, id])
  @@index([organizationId, fiscalYearId, status])
  @@map("budgets")
}

/// Una celda de presupuesto: **cuenta × mes × dimensión**.
///
/// **Convención de signo (D2): `amountCents` es el APORTE**, `haber − debe`,
/// igual que R-P1 de ADR-0012 y que la matriz analítica de E4. Ingreso
/// presupuestado **positivo**, gasto presupuestado **negativo**. Así
/// `desviación = real − presupuesto` se calcula sin una sola conversión de
/// signo, y un gasto por encima de lo previsto da desviación **negativa**, que
/// es lo que un controller espera leer.
model BudgetLine {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  budgetId       String       @map("budget_id") @db.Uuid
  budget         Budget       @relation(fields: [organizationId, budgetId], references: [organizationId, id], onDelete: Cascade)

  /// Primer día del mes presupuestado, dentro del ejercicio de la versión.
  month DateTime @map("month") @db.Date

  /// `NULL` = la celda es del total de la dimensión, sin desglose por cuenta
  /// (O-A6 lo contempla explícitamente). Con `NULL`, `analyticType` es
  /// OBLIGATORIO: sin cuenta y sin tipo no hay forma de situar la celda en un
  /// nivel de margen, y un presupuesto que no sabe en qué fila va no es un
  /// presupuesto.
  accountCode String? @map("account_code") @db.VarChar(12)

  /// **Exactamente uno** de los dos (O-A6: `CHECK ((project_id IS NULL) <> (cost_center_id IS NULL))`).
  projectId    String? @map("project_id") @db.Uuid
  project      Project?    @relation(fields: [organizationId, projectId], references: [organizationId, id], onDelete: Restrict)
  costCenterId String? @map("cost_center_id") @db.Uuid
  costCenter   CostCenter? @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)
  /// **Denormalizada del proyecto (R-A9)**: la escribe el código, la verifica un
  /// trigger y no se recalcula nunca. `NULL` con CECO.
  businessLineId String?       @map("business_line_id") @db.Uuid
  businessLine   BusinessLine? @relation(fields: [organizationId, businessLineId], references: [organizationId, id], onDelete: Restrict)

  /// Tipo **efectivo** ya resuelto al guardar, con las mismas reglas R-A2/R-A3/
  /// R-A4 que usa el diario: la matriz de presupuesto lee, no decide.
  ///
  /// **O-E10-23 — NOT NULL, siempre**, tenga cuenta la línea o no. Con el tipo
  /// nulo, el CHECK de signo de O-E10-6 no evaluaba nada y la celda no tenía
  /// nivel de margen: era el hueco por el que un gasto en positivo seguía
  /// entrando. Lo resuelve `resolveEffectiveAnalyticType` al guardar.
  analyticType AnalyticType @map("analytic_type")

  /// **O-E10-7 — el nivel viaja con la línea**, exactamente como
  /// `AllocationLine.marginLevel` desde E5-D1 y por la misma razón. Con
  /// `INDIRECTO_CECO` el nivel lo pone `CostCenter.marginLevel`, que **no está
  /// cubierto por `marginConfigHash`**: si un CECO pasa de MC3 a EBITDA después
  /// de sellar, el `budgetHash` no cambiaría y el mismo presupuesto sellado se
  /// leería en otra fila — la desviación de MC3 se movería sola. Se puebla al
  /// guardar con el nivel vigente y entra en la forma canónica del sello.
  marginLevel MarginLevel @map("margin_level")

  /// **APORTE** (`haber − debe`). El signo NO es libre: lo fuerza el tipo
  /// analítico efectivo (O-E10-6), con validación al guardar, CHECK de refuerzo
  /// y las tres excepciones declaradas (§2.3 M2). Un `6400` tecleado en positivo
  /// duplicaba la desviación con ejecución exacta y no lo detectaba nada.
  amountCents Int              @map("amount_cents")
  /// Sólo se rellena en las excepciones de signo admitidas, para que I-E10-14
  /// las liste en vez de callarlas.
  signException Boolean        @default(false) @map("sign_exception")
  source      BudgetLineSource @default(MANUAL)
  note        String?          @db.VarChar(400)

  createdAt DateTime @default(now()) @map("created_at")

  // Los cuatro índices únicos PARCIALES van en la MIGRACIÓN (§2.3 M2): un
  // `@@unique` con columnas nullables NO impide duplicados (NULL <> NULL).
  // Es literalmente la deuda O-A6 y aquí es donde se cierra.
  @@index([organizationId, budgetId, month])
  @@index([organizationId, budgetId, projectId, month])
  @@index([organizationId, budgetId, costCenterId, month])
  @@index([organizationId, budgetId, accountCode])
  @@map("budget_lines")
}

/// Horas presupuestadas. Tabla aparte de `BudgetLine` a propósito: las horas no
/// tienen cuenta contable, no llevan signo de aporte y no entran en ningún nivel
/// de margen. Meterlas en la misma tabla con un `kind` obligaría a un CHECK
/// excluyente sobre `amount_cents`/`minutes` y a meter `kind` en los cuatro
/// índices únicos de O-A6, que es exactamente el enredo que O-A6 existe para
/// evitar.
model BudgetHoursLine {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  budgetId       String       @map("budget_id") @db.Uuid
  budget         Budget       @relation(fields: [organizationId, budgetId], references: [organizationId, id], onDelete: Cascade)

  month DateTime @map("month") @db.Date

  /// **O-E10-10** — las tres con FK COMPUESTA por tenant y `onDelete: Restrict`,
  /// como `budget_lines`. En la ronda 0 eran uuid sueltos, sin integridad
  /// referencial, sin CHECK de día 1 y sin trigger de mes dentro del ejercicio.
  projectId    String?     @map("project_id") @db.Uuid
  project      Project?    @relation(fields: [organizationId, projectId], references: [organizationId, id], onDelete: Restrict)
  costCenterId String?     @map("cost_center_id") @db.Uuid
  costCenter   CostCenter? @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)
  /// Opcional: presupuesto de horas por empleado dentro de la dimensión.
  employeeId   String?     @map("employee_id") @db.Uuid
  employee     Employee?   @relation(fields: [organizationId, employeeId], references: [organizationId, id], onDelete: Restrict)

  /// **Minutos enteros y ≥ 0** (Q-2). Alimentan dos cosas: el KPI de horas
  /// presupuestadas y —esto es nuevo en la ronda 1— la **liquidación
  /// presupuestaria** de los drivers de actividad (O-E10-4, §3.2).
  minutes Int              @map("minutes")
  source  BudgetLineSource @default(MANUAL)

  createdAt DateTime @default(now()) @map("created_at")

  @@index([organizationId, budgetId, month])
  @@map("budget_hours_lines")
}

// ── Horas ────────────────────────────────────────────────────────────────────

enum TimeEntrySource {
  MANUAL
  CSV_IMPORT
  @@map("time_entry_source")
}

/// `ANULADO` no existe: una entrada aprobada se corrige con un **contra-apunte**
/// (otra entrada de horas negativas que la referencia), igual que un asiento se
/// anula con un contra-asiento (ADR-0003). Un `BORRADOR` sí se puede borrar,
/// porque nadie ha afirmado nada todavía.
enum TimeEntryStatus {
  BORRADOR
  APROBADO
  @@map("time_entry_status")
}

model TimeEntry {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  employeeId String   @map("employee_id") @db.Uuid
  employee   Employee @relation(fields: [organizationId, employeeId], references: [organizationId, id], onDelete: Restrict)

  /// Fecha del trabajo, no de la captura. Debe caer dentro de un `FiscalYear`.
  date DateTime @map("date") @db.Date

  /// **Exactamente uno** (CHECK), misma regla que una línea 6/7 del diario.
  projectId    String?     @map("project_id") @db.Uuid
  project      Project?    @relation(fields: [organizationId, projectId], references: [organizationId, id], onDelete: Restrict)
  costCenterId String?     @map("cost_center_id") @db.Uuid
  costCenter   CostCenter? @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)
  /// Denormalizada del proyecto (R-A9), verificada por trigger.
  businessLineId String?       @map("business_line_id") @db.Uuid
  businessLine   BusinessLine? @relation(fields: [organizationId, businessLineId], references: [organizationId, id], onDelete: Restrict)

  /// **Minutos enteros** (Q-2). 7 h 20 min = `440`, exacto — en centésimas de
  /// hora serían 733,33 y habría que redondear, perdiendo 0,2 min por parte
  /// (≈ 29 h al año con 8 800 partes, y un descuadre permanente con el registro
  /// de jornada del art. 34.9 ET). Nunca un decimal, nunca un `Float`: la misma
  /// regla que el céntimo (ADR-0006) aplicada al tiempo.
  /// Positivo en una entrada normal; **negativo sólo en un contra-apunte**.
  minutes Int @map("minutes")

  /// Productiva / no productiva (vacaciones, formación, baja, comercial no
  /// facturable). **Sólo las productivas alimentan el driver `HOURS`** y el
  /// denominador del coste-hora (Q-3, **modelo A de absorción plena**): la
  /// tarifa ya absorbe el coste de las no productivas, así que ese coste **no se
  /// vuelve a repartir**. El reparto lo hace la regla `HOURS` sobre el saldo
  /// real del CECO, que ya contiene la nómina íntegra.
  productive Boolean @default(true)

  note   String?         @db.VarChar(400)
  source TimeEntrySource @default(MANUAL)
  status TimeEntryStatus @default(BORRADOR)

  approvedAt   DateTime? @map("approved_at")
  approvedById String?   @map("approved_by_id") @db.Uuid

  /// Contra-apunte: apunta a la entrada APROBADA que corrige. Mismo día, misma
  /// dimensión, mismo empleado y horas con el signo contrario (trigger).
  correctsEntryId String?     @map("corrects_entry_id") @db.Uuid
  corrects        TimeEntry?  @relation("TimeEntryCorrects", fields: [correctsEntryId], references: [id])
  correctedBy     TimeEntry[] @relation("TimeEntryCorrects")
  correctionReason String?    @map("correction_reason") @db.VarChar(1000)

  /// Idempotencia del import CSV: `sha256(fichero ‖ nº de línea)`.
  importKey String?  @map("import_key") @db.VarChar(64)
  createdById String? @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([organizationId, id])
  @@index([organizationId, date])
  @@index([organizationId, employeeId, date])
  @@index([organizationId, projectId, date])
  @@index([organizationId, costCenterId, date])
  @@map("time_entries")
}

// ── Empleados y coste-hora ───────────────────────────────────────────────────

model Employee {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code String @db.VarChar(24)
  name String @db.VarChar(120)

  /// Enlace OPCIONAL al maestro documental de E8 (`Counterparty.isEmployee`) y
  /// al usuario de la aplicación. Ninguno de los dos es obligatorio: hay
  /// empleados que no entran en la aplicación y notas de gasto de personas que
  /// no imputan horas.
  counterpartyId String? @map("counterparty_id") @db.Uuid
  userId         String? @map("user_id") @db.Uuid

  /// CECO por defecto al capturar un parte y base del `HeadcountSnapshot`
  /// derivado.
  defaultCostCenterId String?     @map("default_cost_center_id") @db.Uuid
  defaultCostCenter   CostCenter? @relation(fields: [organizationId, defaultCostCenterId], references: [organizationId, id], onDelete: Restrict)

  /// Jornada en milésimas de FTE (1000 = completa). Entra en el `HEADCOUNT`.
  fteMilli Int @default(1000) @map("fte_milli")

  hireDate DateTime? @map("hire_date") @db.Date
  endDate  DateTime? @map("end_date") @db.Date

  isActive   Boolean   @default(true) @map("is_active")
  archivedAt DateTime? @map("archived_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")

  rates       EmployeeRate[]
  timeEntries TimeEntry[]

  @@unique([organizationId, code])
  @@unique([organizationId, id])
  @@index([organizationId, isActive])
  @@map("employees")
}

/// De dónde sale la cifra. `DERIVADO_NOMINA` guarda **además** la procedencia
/// del cálculo (`derivation`), porque un coste-hora derivado sin sus términos no
/// se puede auditar y acabaría siendo un número de origen desconocido.
enum EmployeeRateSource {
  DECLARADO
  DERIVADO_NOMINA
  @@map("employee_rate_source")
}

/// Qué contiene el coste-hora. La elección es **de la organización** y viaja en
/// la tarifa, nunca implícita: `BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` difieren
/// en torno al **31,9 %** (Q-1), y un proyecto de 1 000 h medido con una y
/// comparado con otro medido con la otra difiere en ~851 000 c de margen sin que
/// nada haya pasado.
///
///   BRUTO_SIN_SS               → 640                       (negociación salarial)
///   COSTE_EMPRESA_CON_SS       → 640 + 642 + 645 + 649      **DEFAULT** (Q-1)
///   COSTE_TOTAL_CON_ESTRUCTURA → lo anterior + estructura   (ver abajo)
///
/// **`641` (indemnizaciones) queda FUERA** de todas ellas (O-E10-11): es un coste
/// no recurrente y ligado a personas que dejan de generar horas, así que
/// incluirlo dispara la tarifa del último periodo del empleado y contamina el
/// margen de los proyectos que casualmente tocó ese mes. Va al CECO de G&A y se
/// presupuesta como línea propia.
///
/// **`COSTE_TOTAL_CON_ESTRUCTURA` es EXCLUYENTE con las reglas de actividad**
/// (O-E10-14): si la tarifa ya lleva estructura imputada y además una regla
/// `HOURS`/`HEADCOUNT` reparte los CECOs a los proyectos, la estructura se carga
/// **dos veces**. Se valida al fijar la tarifa —`RATE_BASIS_CONFLICT` si hay
/// alguna regla de actividad vigente— y el informe lleva aviso permanente.
enum EmployeeRateBasis {
  BRUTO_SIN_SS
  COSTE_EMPRESA_CON_SS
  COSTE_TOTAL_CON_ESTRUCTURA
  @@map("employee_rate_basis")
}

model EmployeeRate {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  employeeId     String       @map("employee_id") @db.Uuid
  employee       Employee     @relation(fields: [organizationId, employeeId], references: [organizationId, id], onDelete: Cascade)

  /// Céntimos por hora, entero y > 0.
  hourlyCostCents Int                @map("hourly_cost_cents")
  basis           EmployeeRateBasis
  source          EmployeeRateSource @default(DECLARADO)

  /// Sólo con `DERIVADO_NOMINA`. `{ scope: "COST_CENTER" | "EMPLOYEE",
  /// costCenterCode?, periodStart, periodEnd, payrollCents, accountPrefixes,
  /// productiveMinutes, coverageBps, linesTotal, linesMatched, formula }` — los
  /// términos exactos con los que salió la cifra, para que el número se pueda
  /// **rehacer a mano** (O-E10-12: `coverageBps` y el recuento de líneas son
  /// obligatorios en el ámbito `EMPLOYEE`; sin ellos la propuesta extrapolaría
  /// en silencio desde una fracción de la nómina).
  derivation Json? @map("derivation")

  validFrom DateTime  @map("valid_from") @db.Date
  validTo   DateTime? @map("valid_to") @db.Date

  note        String?  @db.VarChar(400)
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  // Sin solape de vigencias por empleado: `EXCLUDE USING gist` en la migración
  // (mismo patrón que `TaxRate` de E2 y `AllocationRule` de E5).
  @@index([organizationId, employeeId, validFrom])
  @@map("employee_rates")
}

/// Plantilla a fin de mes por CECO. Es un **hecho declarado**, no un derivado:
/// se puede calcular desde `Employee` (`DERIVADO_EMPLEADOS`) o teclear
/// (`MANUAL`), y en los dos casos queda sellado con quién y cuándo. El driver
/// `HEADCOUNT` lee esta tabla y sólo esta tabla.
enum HeadcountSource {
  MANUAL
  DERIVADO_EMPLEADOS
  @@map("headcount_source")
}

model HeadcountSnapshot {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  costCenterId String     @map("cost_center_id") @db.Uuid
  costCenter   CostCenter @relation(fields: [organizationId, costCenterId], references: [organizationId, id], onDelete: Restrict)

  /// **Último día** del mes: el stock es a fin de periodo (contrato del experto
  /// en E5, confirmado en D1).
  periodEnd DateTime @map("period_end") @db.Date

  fteMilli  Int             @map("fte_milli")
  headcount Int
  source    HeadcountSource @default(MANUAL)
  note      String?         @db.VarChar(400)

  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([organizationId, costCenterId, periodEnd])
  @@index([organizationId, periodEnd])
  @@map("headcount_snapshots")
}
```

**Cambios en modelos existentes**

| Modelo | Cambio | Por qué |
|---|---|---|
| `AllocationRun` | **`timeHash String @default("∅") @map("time_hash") @db.VarChar(64)`** más **`timeHashWindowStart DateTime? @db.Date`** y **`timeHashWindowEnd DateTime? @db.Date`** | **D1 + O-E10-1.** La base de `HOURS`/`HEADCOUNT` **no está en el diario**: no entra ni en `ledgerHash`, ni en `dimensionsHash`, ni en `rulesHash`. Sin este cuarto sello, aprobar un parte de un periodo ya liquidado dejaría el run desfasado **sin que nada lo dijera**. Y sin **la ventana**, el sello se quedaba corto: una regla con `zeroBaseFallback = YTD` reparte con partes de **todo el ejercicio**, así que aprobar en mayo un parte de enero no cambiaba el `timeHash` de marzo y el run seguía luciendo vigente. La ventana se persiste para que la comprobación de staleness sea reproducible **sin releer las reglas**. `∅` y ventana `NULL` cuando ninguna regla del run usa un driver de actividad |
| `ReportRun` | **`budgetHash String @default("∅") @map("budget_hash") @db.VarChar(64)`**, dentro de la clave de reutilización `report_runs_cache_key` | Dos `PRESUPUESTO_REAL` del mismo periodo y el mismo diario con **versiones distintas de presupuesto** son informes distintos. Sin el hash en la clave, la caché serviría el de la versión equivocada — el mismo razonamiento de `paramsHash` (O-5) y de `allocationRunSetHash` (O-E5-7) |
| `Organization` | `timeTrackingEnabled Boolean @default(false)` · `defaultRateBasis EmployeeRateBasis @default(COSTE_EMPRESA_CON_SS)` · **`referenceProductiveMinutesPerYear Int @default(90000)`** (1 500 h) · `payrollAccountPrefixes String[] @default(["640","642","645","649"])` · `derivationMinCoverageBps Int @default(7500)` | El registro de horas es **opcional** (`SPEC-FUNCIONAL.md` §3.4). **O-E10-19**: el default de la ronda 0 (1 700 h) no eran horas productivas sino **jornada anual**, e infravaloraba la tarifa ~12 %; 1 500 h es la cifra tras vacaciones, festivos, formación y absentismo, y se usa **sólo como denominador de respaldo** cuando no hay partes reales, nunca por delante de ellos. Los prefijos y la cobertura mínima son política de controlling: configuración versionada, nunca código |
| `Organization.reviewThresholds` | **Cuatro** KPI nuevos: `desviacionIngresos`, `desviacionEbitda`, `desviacionMc3` y **`desviacionMaxDimension`** (O-E10-18) | §5.3 |
| `Project` | Ninguna columna nueva. `budgetRevenueCents`/`budgetCostCents` (E4) **se deprecan**: pasan a derivarse de la versión vigente de `Budget` y la ficha deja de admitir su edición | Dos verdades para la misma cifra. Se conservan las columnas para no romper la UI heredada, con `@deprecated` en el modelo y un WARN de calidad de datos si difieren del presupuesto vigente (T18) |
| `CostCenter`, `BusinessLine`, `FiscalYear` | Relaciones inversas nuevas; ninguna columna | — |
| `TargetKind` | **`MIXED` se retira** | Deuda §0-bis #3 |
| `AllocationRunStatus` | **`DRAFT` se retira** | Deuda §0-bis #4 |
| `Driver` | Sin cambios. `HOURS` y `HEADCOUNT` ya están en el enum desde E5; lo que se retira es el `CHECK` que los bloqueaba | ADR-0013 D4 |

`lib/db.ts` → `TENANT_MODELS` += `"Budget"`, `"BudgetLine"`, `"BudgetHoursLine"`,
`"TimeEntry"`, `"Employee"`, `"EmployeeRate"`, `"HeadcountSnapshot"`.
ESLint `BUSINESS_DELEGATES` += los siete delegados equivalentes.
`.claude/hooks/guard.sh`, `eslint.config.mjs` y CI: **`lib/budget/**` y
`lib/time/**` entran en el guard de pureza** (sin `Date.now()`, sin IO, sin LLM).

### 2.3 Migraciones

Seis, **aditivas** y ejecutables por un rol **no superusuario** (§Convenciones de
`CLAUDE.md`): ni un `ALTER ROLE`, ni un `ALTER FUNCTION … OWNER TO`, ni una
sentencia que exija `SUPERUSER`. Las tablas nacen vacías, así que **sólo M5 y M6
necesitan el baile `NO FORCE` → backfill → `FORCE`**, con la marca de conversión
escrita **antes** del backfill (runbook de E3, `20260907120000`).

**M1 · `20260924090000_e10_enums`** — los **ocho** enums nuevos, solos
(`budget_scenario`, `budget_status`, `budget_line_source`, `time_entry_status`,
`time_entry_source`, `employee_rate_basis`, `headcount_source` y la ampliación
de `allocation_driver` con `HOURS`/`HEADCOUNT`; la ronda 0 decía «siete», un
recuento corto del propio documento — PUEDE 9 de la revisión). Un enum
creado en la misma transacción que su primer uso no se puede referenciar en
PostgreSQL; ésa es la razón por la que E9 ya los separó.

**M2 · `20260924100000_e10_presupuesto`** — `budgets`, `budget_lines`,
`budget_hours_lines`, con PK, FK simples a `organizations` y **FK compuestas por
tenant** `(organization_id, <id>)`, los índices del fragmento y:

```sql
ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_revision_base"     CHECK (("scenario" = 'BASE') = ("revision" = 0)),
  ADD CONSTRAINT "budgets_revision_positive" CHECK ("revision" >= 0),
  ADD CONSTRAINT "budgets_validity"          CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- Sellado ⇔ VIGENTE o SUSTITUIDO, y siempre con los tres sellos.
  ADD CONSTRAINT "budgets_sealed_marks" CHECK (
    ("status" = 'BORRADOR') = ("sealed_at" IS NULL)
    AND ("sealed_at" IS NULL) = ("budget_hash" IS NULL)
    AND ("sealed_at" IS NULL) = ("margin_config_hash" IS NULL)
    AND ("sealed_at" IS NULL) = ("git_sha" IS NULL)),
  ADD CONSTRAINT "budgets_superseded_marks" CHECK (
    ("status" = 'SUSTITUIDO') = ("superseded_by_id" IS NOT NULL));

-- Una sola versión VIGENTE por ejercicio en cada fecha (I-E10-9). btree_gist
-- está disponible desde E2.
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "fiscal_year_id" WITH =,
                      daterange("valid_from", "valid_to", '[]') WITH &&)
  WHERE ("status" <> 'BORRADOR');
-- O-E10-9: una versión parcial declara desde qué mes sustituye, y ese mes es un
-- día 1. La continuidad de vigencias (O-E10-8) la exige `sealBudget` en la misma
-- transacción y la comprueba I-E10-15; un EXCLUDE no puede expresar «sin hueco».
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_partial_from_first_day" CHECK (
  "partial_from" IS NULL OR date_part('day', "partial_from") = 1);

ALTER TABLE "budget_lines"
  -- ══ O-A6, primera mitad: el CHECK de exclusividad ════════════════════════
  ADD CONSTRAINT "budget_lines_one_dimension" CHECK (
    ("project_id" IS NULL) <> ("cost_center_id" IS NULL)),
  ADD CONSTRAINT "budget_lines_bl_needs_project" CHECK (
    "business_line_id" IS NULL OR "project_id" IS NOT NULL),
  -- **O-E10-23** — `analytic_type` es OBLIGATORIO en toda línea, tenga cuenta o
  -- no. La ronda 1 sólo lo exigía sin cuenta (`account_code IS NOT NULL OR
  -- analytic_type IS NOT NULL`), y ése era el hueco: con el tipo nulo, la primera
  -- rama del CHECK de signo (`analytic_type IS NULL`) lo dejaba pasar, de modo
  -- que un `6400` tecleado en positivo volvía a entrar por la puerta de atrás, y
  -- la celda tampoco tenía nivel de margen que congelar. El tipo se resuelve al
  -- guardar con `resolveEffectiveAnalyticType` —la misma función del diario—, así
  -- que exigirlo no le cuesta un clic a nadie.
  ADD CONSTRAINT "budget_lines_type_required" CHECK ("analytic_type" IS NOT NULL),
  -- Presupuesto de EXPLOTACIÓN: la cuenta, si se declara, es de grupo 6 o 7.
  ADD CONSTRAINT "budget_lines_pnl_only" CHECK (
    "account_code" IS NULL OR left("account_code", 1) IN ('6','7')),
  ADD CONSTRAINT "budget_lines_month_is_first_day" CHECK (
    date_part('day', "month") = 1),
  -- O-E10-7: el nivel viaja con la línea, como en `allocation_lines`.
  ADD CONSTRAINT "budget_lines_margin_level" CHECK (
    "margin_level" IN ('INGRESOS','MC1','MC2','MC3','EBITDA','EBIT','BAI','RESULTADO')),
  -- ══ O-E10-6: el signo lo FUERZA el tipo analítico efectivo ═════════════════
  -- Un `6400` tecleado como +1.200.000 contra un real de −1.200.000 daba una
  -- desviación de −2.400.000 c con ejecución exacta: el doble del importe y con
  -- signo de «hemos gastado de más». La validación fina (con sus mensajes y las
  -- excepciones por cuenta) vive en la acción; esto es el refuerzo de la base.
  ADD CONSTRAINT "budget_lines_sign_by_type" CHECK (
    "sign_exception"
    OR "analytic_type" IS NULL
    OR ("analytic_type" = 'INGRESO_DIRECTO' AND "amount_cents" >= 0)
    OR ("analytic_type" IN ('COSTE_DIRECTO_MC1','COSTE_DIRECTO_MC2',
                            'INDIRECTO_CECO','AMORTIZACION_DETERIORO')
        AND "amount_cents" <= 0)
    OR "analytic_type" IN ('FINANCIERO','EXTRAORDINARIO','NO_ANALITICO'));

-- ══ O-A6, segunda mitad: CUATRO índices únicos PARCIALES ═══════════════════
-- Un `@@unique(budget_id, month, account_code, project_id, cost_center_id)` NO
-- sirve: `NULL <> NULL` en PostgreSQL, así que dos filas con `account_code`
-- nulo o con `cost_center_id` nulo NO colisionan y el duplicado entra. Es la
-- deuda O-A6 literal, abierta desde E4 y fechada en E5 para esta migración.
CREATE UNIQUE INDEX "budget_lines_unique_proj_account" ON "budget_lines"
  ("organization_id","budget_id","month","project_id","account_code")
  WHERE "project_id" IS NOT NULL AND "account_code" IS NOT NULL;
CREATE UNIQUE INDEX "budget_lines_unique_proj_total" ON "budget_lines"
  ("organization_id","budget_id","month","project_id","analytic_type")
  WHERE "project_id" IS NOT NULL AND "account_code" IS NULL;
CREATE UNIQUE INDEX "budget_lines_unique_ceco_account" ON "budget_lines"
  ("organization_id","budget_id","month","cost_center_id","account_code")
  WHERE "cost_center_id" IS NOT NULL AND "account_code" IS NOT NULL;
CREATE UNIQUE INDEX "budget_lines_unique_ceco_total" ON "budget_lines"
  ("organization_id","budget_id","month","cost_center_id","analytic_type")
  WHERE "cost_center_id" IS NOT NULL AND "account_code" IS NULL;

-- O-E10-10: `budget_hours_lines` con la misma disciplina que `budget_lines`.
ALTER TABLE "budget_hours_lines"
  ADD CONSTRAINT "budget_hours_one_dimension" CHECK (
    ("project_id" IS NULL) <> ("cost_center_id" IS NULL)),
  ADD CONSTRAINT "budget_hours_nonneg" CHECK ("minutes" >= 0),
  ADD CONSTRAINT "budget_hours_month_is_first_day" CHECK (
    date_part('day', "month") = 1),
  ADD CONSTRAINT "budget_hours_project_fk" FOREIGN KEY ("organization_id","project_id")
    REFERENCES "projects"("organization_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "budget_hours_cost_center_fk" FOREIGN KEY ("organization_id","cost_center_id")
    REFERENCES "cost_centers"("organization_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "budget_hours_employee_fk" FOREIGN KEY ("organization_id","employee_id")
    REFERENCES "employees"("organization_id","id") ON DELETE RESTRICT;

-- Dos índices PARCIALES, no un `COALESCE`: misma doctrina que O-A6 en
-- `budget_lines`. El `COALESCE` de la ronda 0 funcionaba, pero enterraba la
-- exclusividad en una expresión y no era legible en `\d`.
CREATE UNIQUE INDEX "budget_hours_unique_proj" ON "budget_hours_lines"
  ("organization_id","budget_id","month","project_id","employee_id")
  WHERE "project_id" IS NOT NULL AND "employee_id" IS NOT NULL;
CREATE UNIQUE INDEX "budget_hours_unique_proj_total" ON "budget_hours_lines"
  ("organization_id","budget_id","month","project_id")
  WHERE "project_id" IS NOT NULL AND "employee_id" IS NULL;
CREATE UNIQUE INDEX "budget_hours_unique_ceco" ON "budget_hours_lines"
  ("organization_id","budget_id","month","cost_center_id","employee_id")
  WHERE "cost_center_id" IS NOT NULL AND "employee_id" IS NOT NULL;
CREATE UNIQUE INDEX "budget_hours_unique_ceco_total" ON "budget_hours_lines"
  ("organization_id","budget_id","month","cost_center_id")
  WHERE "cost_center_id" IS NOT NULL AND "employee_id" IS NULL;
```

Triggers de M2 — lo que ningún `CHECK` puede expresar porque mira otra tabla:

| Trigger | Qué impide | Invariante |
|---|---|---|
| `budget_lines_business_line_denorm` (BEFORE INSERT/UPDATE) | `business_line_id` distinto del del proyecto, o presente sin proyecto. **Verifica, nunca rellena** — rellenar rompería `budgetHash` (misma lección que R-A9 en E4) | I-E10-8 |
| `budget_lines_month_in_fiscal_year` (BEFORE INSERT/UPDATE) | Mes fuera del ejercicio de la versión. **El mismo trigger se aplica a `budget_hours_lines`** (O-E10-10) | I-E10-1 |
| `budget_lines_margin_level_matches` (BEFORE INSERT/UPDATE) | `marginLevel` distinto del que resolverían el tipo efectivo y el `CostCenter.marginLevel` vigentes. **Verifica, nunca rellena** — rellenar rompería `budgetHash`, misma lección que R-A9 | I-E10-1, O-E10-7 |
| `budget_lines_dimension_alive` (BEFORE INSERT) | Dimensión archivada, CECO `SIN_ASIGNAR` o proyecto `CLOSED` **anterior al mes** | I-E10-8 |
| `budgets_immutable_when_sealed` (BEFORE UPDATE) | Cualquier `UPDATE` de una versión no `BORRADOR` fuera de `status`, `valid_to`, `superseded_by_id` | I-E10-6 |
| `budget_lines_no_write_when_sealed` (BEFORE INSERT/UPDATE/DELETE) | Tocar líneas de una versión sellada. En `BORRADOR` se editan y se borran libremente: nadie ha afirmado nada todavía | I-E10-6 |

RLS y permisos:

```sql
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['budgets','budget_lines','budget_hours_lines'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- Las líneas de un BORRADOR se editan y se borran: es una hoja de cálculo.
GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_lines","budget_hours_lines" TO app_runtime;
-- La cabecera es semi-append-only (patrón ADR-0010 / manual_review_flags).
GRANT SELECT, INSERT ON "budgets" TO app_runtime;
REVOKE UPDATE, DELETE ON "budgets" FROM app_runtime;
GRANT UPDATE ("status","valid_to","superseded_by_id","budget_hash",
              "margin_config_hash","git_sha","sealed_at","sealed_by_id",
              "name","note","updated_at") ON "budgets" TO app_runtime;
CREATE POLICY "budgets_no_delete" ON "budgets" AS RESTRICTIVE FOR DELETE USING (false);
```

**M3 · `20260924110000_e10_horas`** — `employees`, `employee_rates`,
`headcount_snapshots`, `time_entries`:

```sql
ALTER TABLE "employee_rates"
  ADD CONSTRAINT "employee_rates_positive" CHECK ("hourly_cost_cents" > 0),
  ADD CONSTRAINT "employee_rates_validity" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  ADD CONSTRAINT "employee_rates_derivation" CHECK (
    ("source" = 'DERIVADO_NOMINA') = ("derivation" IS NOT NULL));
-- I-E10-5: un coste-hora vigente y sólo uno en cada fecha.
ALTER TABLE "employee_rates" ADD CONSTRAINT "employee_rates_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "employee_id" WITH =,
                      daterange("valid_from", "valid_to", '[]') WITH &&);

ALTER TABLE "headcount_snapshots"
  ADD CONSTRAINT "headcount_nonneg" CHECK ("fte_milli" >= 0 AND "headcount" >= 0),
  ADD CONSTRAINT "headcount_last_day" CHECK (
    "period_end" = (date_trunc('month', "period_end") + interval '1 month - 1 day')::date);

ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_one_dimension" CHECK (
    ("project_id" IS NULL) <> ("cost_center_id" IS NULL)),
  ADD CONSTRAINT "time_entries_bl_needs_project" CHECK (
    "business_line_id" IS NULL OR "project_id" IS NOT NULL),
  ADD CONSTRAINT "time_entries_minutes_nonzero" CHECK ("minutes" <> 0),
  -- Minutos negativos SOLO en un contra-apunte, y un contra-apunte SOLO negativo.
  ADD CONSTRAINT "time_entries_negative_iff_correction" CHECK (
    ("minutes" < 0) = ("corrects_entry_id" IS NOT NULL)),
  ADD CONSTRAINT "time_entries_correction_reason" CHECK (
    "corrects_entry_id" IS NULL
    OR ("correction_reason" IS NOT NULL AND length("correction_reason") >= 10)),
  ADD CONSTRAINT "time_entries_approval_marks" CHECK (
    ("status" = 'APROBADO') = ("approved_at" IS NOT NULL)
    AND ("approved_at" IS NULL) = ("approved_by_id" IS NULL)),
  -- Techo de cordura POR FILA: 24 h = 1 440 minutos. Un parte de 30 h es un
  -- error de tecleo, y detectarlo al insertar es más barato que en el informe.
  -- **O-E10-21**: el techo por fila no basta —cuatro partes de 1 440 dan 96 h en
  -- un día y ningún CHECK lo ve—, así que el agregado
  -- `Σ minutos por (empleado, fecha) ≤ 1 440` entra en **I-E10-10** y como aviso
  -- en la acción de alta. No se pone como constraint porque exige mirar el resto
  -- de filas del día, que es justo lo que un CHECK no puede hacer.
  ADD CONSTRAINT "time_entries_daily_ceiling" CHECK ("minutes" BETWEEN -1440 AND 1440);

CREATE UNIQUE INDEX "time_entries_import_key" ON "time_entries"
  ("organization_id","import_key") WHERE "import_key" IS NOT NULL;
-- El agregado del driver sólo mira APROBADAS y PRODUCTIVAS: índice parcial.
CREATE INDEX "time_entries_approved_project" ON "time_entries"
  ("organization_id","project_id","date") WHERE "status" = 'APROBADO' AND "productive";
CREATE INDEX "time_entries_approved_ceco" ON "time_entries"
  ("organization_id","cost_center_id","date") WHERE "status" = 'APROBADO' AND "productive";
```

| Trigger | Qué impide |
|---|---|
| `time_entries_immutable_when_approved` (BEFORE UPDATE) | Cualquier cambio de una entrada `APROBADO`. La **única** transición admitida es `BORRADOR → APROBADO`, que escribe `status`, `approved_at` y `approved_by_id` y nada más (I-E10-4) |
| `time_entries_no_delete_when_approved` (BEFORE DELETE) | Borrar una entrada aprobada. Un `BORRADOR` sí se borra |
| `time_entries_correction_mirror` (BEFORE INSERT) | Contra-apunte que no case con su original: distinto empleado, distinta fecha, distinta dimensión, original no `APROBADO`, o Σ de contra-apuntes que supere en magnitud al original |
| `time_entries_date_in_fiscal_year` (BEFORE INSERT) | Fecha fuera de todo `FiscalYear`, o dentro de un ejercicio `CLOSED`, o en un mes con `PeriodLock` (B-9, §4.3) |
| `time_entries_business_line_denorm` (BEFORE INSERT/UPDATE) | Igual que en `budget_lines` y por lo mismo |
| `employees_fte_range` (BEFORE INSERT/UPDATE) | `fte_milli` fuera de `[0, 1000]` |

RLS: las cuatro con `app.enforce_tenant_rls`. `time_entries` **semi-append-only**
—`GRANT UPDATE ("status","approved_at","approved_by_id")` y nada más, con
política `RESTRICTIVE … FOR DELETE USING (false)` **sobre las aprobadas** vía el
trigger, porque una política no puede distinguir `OLD.status`—;
`employee_rates` y `headcount_snapshots` **append-only puras** (una tarifa no se
edita: se cierra su vigencia y se abre otra, patrón `TaxRate`).

**M4 · `20260924120000_e10_drivers_horas`** — enciende los dos drivers:

```sql
-- ADR-0013 D4 se cumple: E10 retira el CHECK *y* aporta los datos, la base
-- sellada y la validación al sellar. No queda ninguna regla inerte.
ALTER TABLE "allocation_rules" DROP CONSTRAINT "allocation_rules_driver_available";

-- D1 + O-E10-1 · el cuarto sello del run y LA VENTANA QUE CUBRE: la base de
-- HOURS/HEADCOUNT no vive en el diario, y con fallback YTD/PRIOR_PERIOD tampoco
-- vive dentro del periodo del run.
ALTER TABLE "allocation_runs"
  ADD COLUMN "time_hash" varchar(64) NOT NULL DEFAULT '∅',
  ADD COLUMN "time_hash_window_start" date,
  ADD COLUMN "time_hash_window_end"   date,
  ADD CONSTRAINT "allocation_runs_time_window" CHECK (
    ("time_hash" = '∅') = ("time_hash_window_start" IS NULL)
    AND ("time_hash_window_start" IS NULL) = ("time_hash_window_end" IS NULL)
    AND ("time_hash_window_end" IS NULL
         OR ("time_hash_window_end" >= "time_hash_window_start"
             AND "time_hash_window_end" >= "period_end"
             AND "time_hash_window_start" <= "period_start")));
-- `app_runtime` no puede actualizarlo: el run sigue siendo append-only salvo en
-- las cinco columnas de sustitución y reversión (E5 §2.3 bloque 7).

-- HEADCOUNT sólo reparte entre CECOs (D1): con proyectos no hay plantilla
-- declarada y derivarla de las horas sería el driver HOURS con otro nombre.
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_headcount_targets"
  CHECK ("driver" <> 'HEADCOUNT' OR "target_kind" = 'COST_CENTERS');
```

**M5 · `20260924130000_e10_report_runs_presupuesto`** — `report_runs` gana
`budget_hash varchar(64) NOT NULL DEFAULT '∅'` y se **rehace** la clave de
reutilización para incluirlo:

```sql
ALTER TABLE "report_runs" ADD COLUMN "budget_hash" varchar(64) NOT NULL DEFAULT '∅';
DROP INDEX "report_runs_cache_key";
CREATE UNIQUE INDEX "report_runs_cache_key" ON "report_runs"
  ("organization_id","type","period_start","period_end","params_hash",
   "ledger_hash","analytics_key","git_sha","budget_hash");
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_budget_hash_required"
  CHECK ("type" <> 'PRESUPUESTO_REAL' OR "budget_hash" <> '∅');
```

Las filas existentes quedan con `'∅'` y **su clave no cambia** (sólo se le añade
un componente constante), así que **ningún informe cacheado se invalida por la
migración** — lo contrario de lo que habría pasado recomponiendo `analytics_key`,
que es la alternativa descartada en §15.

**M6 · `20260924140000_e10_deuda_heredada`** — retirada de `MIXED` y `DRAFT`, con
guardia. PostgreSQL no permite eliminar un valor de enum, así que se recrea el
tipo; el `DO $$` aborta si alguien los usa, de modo que la migración **nunca
pierde un dato**:

```sql
DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "allocation_rules" WHERE "target_kind" = 'MIXED';
  IF n > 0 THEN RAISE EXCEPTION 'hay % reglas con target_kind = MIXED: no se retira el valor', n; END IF;
  SELECT count(*) INTO n FROM "allocation_runs" WHERE "status" = 'DRAFT';
  IF n > 0 THEN RAISE EXCEPTION 'hay % runs en DRAFT: no se retira el valor', n; END IF;
END $$;

CREATE TYPE "target_kind_v2" AS ENUM ('PROJECTS','BUSINESS_LINES','COST_CENTERS');
ALTER TABLE "allocation_rules" ALTER COLUMN "target_kind"
  TYPE "target_kind_v2" USING ("target_kind"::text::"target_kind_v2");
DROP TYPE "target_kind";
ALTER TYPE "target_kind_v2" RENAME TO "target_kind";
-- Ídem con allocation_run_status, conservando el DEFAULT 'SEALED'.
```

**Guarda final de cada migración**: el mismo `DO $$` de E4/E5/E6/E9 que recorre
`pg_class` y falla si alguna tabla de negocio quedó en `NO FORCE`.

### 2.4 Reglas de integridad propias de E10

| # | Regla | Dónde vive |
|---|---|---|
| **R-B-1** | Una celda de presupuesto es única por `(versión, mes, dimensión, cuenta)`; sin cuenta, por `(versión, mes, dimensión, tipo analítico)` | Los cuatro índices parciales de M2 (O-A6) |
| **R-B-2** | El nivel de margen de una línea de presupuesto se resuelve con **las mismas funciones** que el real (`resolveEffectiveAnalyticType`, `resolveLevel`, `resolveColumn`) | `lib/budget/matrix.ts` importa de `lib/analytics/margins.ts`; nunca reimplementa |
| **R-B-3** | Una versión sellada no cambia: ni cabecera, ni líneas, ni horas | Triggers de M2 + I-E10-6 |
| **R-B-4** | Presupuestar a una dimensión no imputable (`CC-FIN`, `CC-EXT`, `CC-NA`) está **permitido** —son costes reales que hay que prever— pero esas columnas nunca se liquidan (I-E5-5 intacto) | Nota en la UI; sin CHECK |
| **R-B-5** | **Toda línea declara su tipo analítico efectivo** (O-E10-23, `NOT NULL`) y **el signo lo fuerza ese tipo** (O-E10-6). Tres excepciones **admitidas con aviso, no con bloqueo**, marcadas con `signException`: `61x`/`71x` (variación de existencias), `706`/`708`/`709` (rappels y devoluciones, negativos sobre ingreso) y `79x`/`759` (reversiones, positivos sobre gasto) | Validación en `upsertBudgetCells`, CHECK de refuerzo en M2, I-E10-14 |
| **R-B-6** | **El importador CSV rechaza el fichero completo** si más del **90 %** de las líneas de cuentas del grupo 6 vienen en positivo: es el síntoma inequívoco de una hoja con la convención contraria, y aceptarla a medias es peor que rechazarla | `importBudgetCsv`, criterio 27 |
| **R-B-7** | **Un `BORRADOR` nunca produce un `ReportRun`** (O-E10-5). Comparar contra un borrador es una **previsualización no sellada**, sin fila en `report_runs` y con banda «borrador, no firmable», igual que `previewAllocation` en E5 | `budgetVsActualAction` → `BUDGET_NOT_SEALED` |
| **R-B-8** | **`sealBudget` cierra la versión anterior en la misma transacción** con `validTo = validFrom(nueva) − 1 día`: sin huecos de vigencia (O-E10-8) | `models/budget.sealBudget`, I-E10-15 |
| **R-B-9** | Una versión no `BORRADOR` **cubre los doce meses** del ejercicio o declara `partialFrom`; el informe **compone** las versiones y publica la procedencia mes a mes (O-E10-9) | `activeBudgetAt` → `composeBudget`, I-E10-16 |
| **R-H-1** | Un parte aprobado es inmutable; se corrige con contra-apunte y motivo ≥ 10 caracteres | Triggers de M3 + I-E10-4 |
| **R-H-2** | Σ de contra-apuntes de una entrada **nunca** supera en magnitud al original: no se puede «desimputar» más de lo imputado | `time_entries_correction_mirror` |
| **R-H-3** | Sólo las entradas **aprobadas y productivas** alimentan el driver `HOURS` y el denominador del coste-hora derivado | `lib/time/aggregate.ts`, I-E10-3 |
| **R-H-4** | Un `EDITOR` **no aprueba sus propios partes**; hace falta otro `EDITOR` o un `ADMIN` (P5, segregación) | `approveTimeEntriesAction` + test |
| **R-H-5** | Un parte no entra en un mes bloqueado ni en un ejercicio cerrado: la cifra de horas alimenta informes ya rendidos | `time_entries_date_in_fiscal_year`, B-9 |
| **R-R-1** | El coste-hora vigente en una fecha es único; sin tarifa vigente el cálculo es **no evaluable**, nunca cero | `EXCLUDE` de M3 + I-E10-5 |
| **R-R-2** | Un coste-hora derivado de la nómina se guarda como **propuesta con sus términos**; aplicarlo es un acto de un ADMIN, con `AuditLog` | §3.5, `EmployeeRate.derivation` |
| **R-R-3** | **Modelo A de absorción plena** (Q-3): el denominador son las horas **productivas**, así que la tarifa **ya absorbe** el coste de las no productivas y ese coste **no se vuelve a repartir**. La tarifa es **unidad de medida para KPI**, no una segunda vía de imputación; quien reparte es la regla `HOURS` sobre el **saldo real del CECO** | §3.5, §3.7, I-E10-12 + informe de absorción |
| **R-R-4** | `COSTE_TOTAL_CON_ESTRUCTURA` es **excluyente** con la existencia de reglas de actividad vigentes (O-E10-14): las dos juntas cargan la estructura dos veces | `createEmployeeRateAction` → `RATE_BASIS_CONFLICT` + aviso permanente |
| **R-R-5** | Un KPI que agregue receptores con **`basis` distinta** sale **no evaluable**, con la lista de bases en conflicto; jamás se suman (O-E10-15) | `lib/time/cost.ts`, §5.2 |
| **R-C-1** | **La base de `HEADCOUNT` es FTE·mes**: Σ `fteMilli` de los snapshots cuyo fin de mes cae dentro del periodo. Con un run mensual es un solo snapshot ⇒ idéntico al stock (Q-7) | `lib/analytics/allocate.ts`, I-E10-11 |
| **R-C-2** | **CECO sin snapshot en ningún mes del periodo**: peso 0, `W-E10-NO-HEADCOUNT` **y motivo de sello `PLANTILLA_AUSENTE`**. Un snapshot con `fteMilli = 0` **sí es un dato** y no mueve nada: la diferencia entre «no hay nadie» y «no lo hemos rellenado» es lo que ADR-0013 D4 existe para no perder | §3.6, §5.3 (EV-16) |

### 2.5 Estrategia de datos existentes

Las siete tablas nacen **vacías**: ninguna organización tiene presupuesto ni
horas. Las dos columnas añadidas (`allocation_runs.time_hash`,
`report_runs.budget_hash`) nacen con `'∅'`, que es el valor correcto para todo lo
ya sellado — ningún run existente usa drivers de actividad y ningún informe
existente es de presupuesto. **No hay backfill de cifras en ninguna migración.**
La siembra por organización **no crea presupuesto ni empleados**: un presupuesto
inventado es peor que ninguno.

`Project.budgetRevenueCents` / `budgetCostCents` conservan sus valores; T18 añade
el WARN de calidad de datos que los compara con la versión vigente y la ficha
deja de admitir su edición.

**Fixture `ejercicio-completo-v2`, reversionado (deuda §0-bis #5).** Se escribe
`docs/design/fixtures/build_ejercicio_completo_v2.py` —que nunca existió— y
emite `tests/fixtures/ejercicio-completo-v2.json` con `schemaVersion 3.1`. La
incoherencia que impide cargarlo hoy es de **retenciones**: el fichero usa a la
vez `4751` (directo y por la clave genérica) y `IRPF_A_PAGAR_123`, y crear la
subcuenta deja a la madre sin admitir apuntes. El generador la resuelve
aplicando **ADR-0016 D12 de forma uniforme**: declara en `accountsExtra` las tres
subcuentas por modelo con el código que les da `ACCOUNT_KEY_DEFAULT_CODE`
(`47510`/`47511`/`47513`, hijas de `4751`) y enruta **todas** las retenciones por
las claves `IRPF_A_PAGAR_111` / `_115` / `_123`. Ninguna línea postea contra
`4751`, que pasa a ser un contenedor legítimo. El fichero v1 **no se toca**
(su `ledgerHash` es el de E3); la versión anterior de v2 se conserva como
evidencia, igual que se hizo con `extraccion-esperada.v1.0.json`.

El fixture v2 gana además el bloque que E10 necesita, y **los cinco casos
adversariales que el experto exige** (§6 de la validación: *«un fixture que sólo
recorre el camino feliz no prueba nada»*):

| Bloque | Contenido, con su caso adverso |
|---|---|
| `employees` | 8 empleados, uno de ellos **sin tarifa vigente durante dos semanas** (I-E10-5 en INFO y motivo `TARIFA_AUSENTE`) |
| `employeeRates` | Un **cambio de tarifa a mitad de ejercicio**, para ejercer la vigencia y el «coste con la tarifa del día del parte» |
| `timeEntries` | Año completo en **minutos**, con un **contra-apunte**, horas **no productivas**, y **un mes con aprobadas y sin aprobar mezcladas** (O-E10-2: base parcial) |
| `headcountSnapshots` | 12 × 4 CECOs, con **un CECO que nace en febrero y muere en noviembre** (Q-7: FTE·mes contra stock anual) y otro **sin snapshot** en un mes (`PLANTILLA_AUSENTE`) |
| `budgets` | `BASE` de los doce meses + una **`REVISADO 1` que sólo cubre el segundo semestre** (`partialFrom`, I-E10-16), una línea de **ingreso con signo correcto** y otra de **gasto en positivo que el importador rechaza** (O-E10-6) |
| `budgetHoursLines` | Horas presupuestadas por proyecto y mes: son las que alimentan la **liquidación presupuestaria** de O-E10-4 |

### 2.6 Lo que **no** existe como tabla, y por qué

| Candidato | Decisión | Motivo |
|---|---|---|
| **`Forecast`** | **No es tabla** (D4) | El forecast es `real(m)` para los meses cerrados y `presupuesto(m)` para los abiertos: una **función de dos cosas que ya están persistidas**. Guardarlo sería una segunda verdad que puede diverger de las dos a la vez (ADR-0003, P2), y obligaría a un proceso que lo mantuviera al día cada vez que se postea un asiento. La fecha de corte es un **parámetro** del informe y entra en `paramsHash`; el `budgetHash` y el `ledgerHash` sellan las dos mitades. Una reproyección con cifras **distintas** del presupuesto para los meses abiertos no es un forecast: es una versión `REVISADO n`, que sí se persiste porque es una decisión |
| **Desviación** | No es tabla | `real − presupuesto`. Almacenarla es almacenar una resta (ADR-0003) |
| **Coste-hora medio, margen por hora** | No es tabla | Derivados de horas y de la matriz. Se calculan y se sellan en el `ReportRun` |
| **`EmployeeAssignment`** (asignación empleado→proyecto) | No entra | El contrato de E5 la mencionaba para `HEADCOUNT`; con `HeadcountSnapshot` por CECO y `TimeEntry` por proyecto, la asignación nominal no aporta ninguna cifra que no esté ya. Añadirla sería una tercera fuente para el mismo dato |
| **`BudgetCapexLine`** (presupuesto de inversiones) | **→ E11** (Q-4) | Presupuestar el grupo 2 en `budget_lines` obligaría a levantar `budget_lines_pnl_only` y a mezclar un presupuesto de **balance** con uno de **explotación** en la misma tabla. En E11 tendrá tabla propia (mes de alta previsto, importe, método, vida útil, dimensión) y su dotación derivada **se sumará** a la de los activos ya en alta |
| **Liquidación presupuestaria** (`BudgetAllocationRun`) | **No es tabla** (O-E10-4) | Se calcula en **dry-run puro** con `allocate()` cada vez que se pide el informe, con las reglas vigentes y las horas presupuestadas. Persistirla la convertiría en un `AllocationRun` que no reparte dinero real, con su propio ciclo de vida, su sello y su caducidad — tres cosas nuevas que mantener para reproducir algo que es determinista a partir de lo que ya está sellado. El `rulesHash` usado viaja en `params` del `ReportRun` |
| **Desviación en volumen y precio** | **→ E11** (Q-6) | La **convención está congelada** en D6 y no se implementa aquí. Publicar la descomposición con una convención y cambiarla después movería dos columnas sin que cambiara el total, que es la peor clase de cambio |
| **Asiento de traspaso de personal** | **Nunca** | ADR-0004 y NRV 14ª. La imputación de personal a proyectos es analítica (§3.7) |
| **`JournalLine.isForecast`** | No entra (→ E12) | E10 no escribe una sola línea en el diario |

---

## 3. Motor / funciones puras

Dos módulos nuevos, `lib/budget/` y `lib/time/`, **puros**: sin IO, sin Prisma,
sin LLM, sin `Date.now()` — el hook `.claude/hooks/guard.sh` los cubre desde T3.
Toda la aritmética es **entera**: prohibidos `float`, `Decimal` y `round()` en el
camino del dinero y de las horas. Agregados en **`BigInt`**; el borde convierte.

### 3.1 `lib/budget/types.ts` y `lib/budget/hash.ts`

```ts
export type BudgetCell = {
  month: LocalDate                       // primer día del mes
  accountCode: string | null
  dimension: { kind: "PROJECT"; id: string; code: string; businessLineCode: string | null }
            | { kind: "COST_CENTER"; id: string; code: string }
  analyticType: AnalyticType          // O-E10-23: nunca nulo
  marginLevel: MarginLevel            // O-E10-7: congelado en la línea
  amountCents: Cents                     // APORTE: ingreso +, gasto − (D2)
}

export type BudgetHoursCell = {
  month: LocalDate
  dimension: BudgetCell["dimension"]
  employeeCode: string | null
  minutes: number                        // Q-2
}

export type BudgetVersion = {
  id: string; scenario: BudgetScenario; revision: number
  fiscalYearId: string; fiscalYearStart: LocalDate; fiscalYearEnd: LocalDate
  validFrom: LocalDate; validTo: LocalDate | null
  /** O-E10-9: `null` = cubre los doce meses; con valor, sustituye desde ese mes. */
  partialFrom: LocalDate | null
  cells: readonly BudgetCell[]
  hours: readonly BudgetHoursCell[]
}

/**
 * Forma canónica: líneas ordenadas por (mes, tipo de dimensión, código de
 * dimensión, cuenta ‖ "∅", tipo analítico ‖ "∅"), una por renglón, importes en
 * céntimos sin separadores. El orden NO depende de la base de datos.
 *
 * **O-E10-7**: cada renglón incluye el `marginLevel` congelado de la línea. Sin
 * él, mover un CECO de MC3 a EBITDA leería el mismo presupuesto sellado en otra
 * fila **sin cambiar el hash**.
 */
export function canonicalBudgetForm(v: BudgetVersion, marginConfigHash: string): string
export function budgetHash(v: BudgetVersion, marginConfigHash: string): string

/**
 * **O-E10-9 — composición de versiones.** Devuelve la versión efectiva de un
 * ejercicio: la última no parcial, sustituida mes a mes por las `partialFrom`
 * posteriores, con la **procedencia de cada mes**. Es lo que impide que una
 * `REVISADO` que sólo trae julio-diciembre desinfle el año a la mitad.
 */
export function composeBudget(
  versions: readonly BudgetVersion[], fiscalYearMonths: readonly string[]
): { effective: BudgetVersion; provenanceByMonth: Record<string, { budgetId: string; label: string }> }

/**
 * **O-E10-6 — coherencia de signo.** Pura, la misma que usa la acción al guardar
 * y el importador CSV al validar, para que el mensaje y el CHECK digan lo mismo.
 *   INGRESO_DIRECTO                                   ⇒ amountCents ≥ 0
 *   COSTE_DIRECTO_MC1 | MC2 | INDIRECTO_CECO |
 *   AMORTIZACION_DETERIORO                            ⇒ amountCents ≤ 0
 *   FINANCIERO | EXTRAORDINARIO | NO_ANALITICO        ⇒ sin restricción
 * Excepciones **con aviso, no con bloqueo** (`signException = true`): `61x`/`71x`
 * (variación de existencias), `706`/`708`/`709` (rappels y devoluciones) y
 * `79x`/`759` (reversiones).
 */
export function checkBudgetSign(cell: BudgetCell): { ok: true } | { ok: false; kind: "WRONG_SIGN" | "EXCEPTION_ALLOWED"; message: string }
// Sin rama para «tipo nulo»: O-E10-23 lo hace imposible, y con ella el CHECK de
// signo tenía un camino por el que no comprobaba nada.

/** R-B-6: > 90 % de líneas de grupo 6 en positivo ⇒ el fichero entero se rechaza. */
export function detectInvertedSignConvention(cells: readonly BudgetCell[]): boolean
```

### 3.2 `lib/budget/matrix.ts` — el presupuesto en la matriz de E4

```ts
export type BudgetMatrix = {
  /** `M[nivel][columna]` CUMULATIVA, exactamente como `buildAnalyticPnl`. */
  cumulativeCents: Record<MarginLevel, Record<ColumnKey, Cents>>
  contributionByLevelCents: Record<MarginLevel, Record<ColumnKey, Cents>>
  levelTotalsCents: Record<MarginLevel, Cents>
  byMonth: Record<string, Record<MarginLevel, Record<ColumnKey, Cents>>>   // "2026-03"
  businessLineAggregates: Record<string, Record<MarginLevel, Cents>>
  /** Celdas que no se pudieron situar (cuenta desconocida, tipo nulo). Nunca se
   *  «arreglan» en silencio: alimentan I-E10-1 y salen en pantalla. */
  unresolved: readonly UnresolvedBudgetCell[]
  /** **O-E10-4** — estado de imputación de ESTA matriz. `NONE` = presupuesto en
   *  bruto, tal como se tecleó; `SETTLED` = pasado por la liquidación
   *  presupuestaria, comparable con un real imputado. El informe **no publica**
   *  una desviación por dimensión en niveles ≥ MC3 si los dos estados no
   *  coinciden (I-E10-18). */
  allocationState: "NONE" | "SETTLED"
  /** `rulesHash` de las reglas usadas en la liquidación presupuestaria; `null`
   *  con `NONE`. Viaja en `params` del `ReportRun` para que el informe sea
   *  reproducible sin persistir la liquidación. */
  budgetRulesHash: string | null
  /** Los avisos de la liquidación presupuestaria (`W-E5-*`, `W-E10-*`),
   *  etiquetados como del presupuesto para no confundirlos con los del real. */
  settlementWarnings: readonly AllocationWarning[]
}

/**
 * **O-E10-4 — liquidación presupuestaria, en dry-run PURO.**
 *
 * El bloqueante de fondo de la ronda 0: el presupuesto se teclea sobre proyectos
 * y CECOs, y el real con `withAllocations = true` ya ha trasladado el saldo de
 * los CECOs a las columnas de proyecto. **Por debajo de MC2 las dos matrices no
 * miden lo mismo.** Con `CC-OPS` presupuestado y ejecutado en 900 000 c exactos y
 * las horas exactamente previstas, P-01 recibe 400 000 c en el real y 0 en el
 * presupuesto: **desviación de MC3 de P-01 = −400 000 c con ejecución perfecta**,
 * y el total compañía cuadra, que es lo que hace que nadie lo detecte.
 *
 * La corrección es pasar el presupuesto por **el mismo `allocate()`**, con las
 * **mismas reglas vigentes**, y con los drivers de actividad alimentados por las
 * **horas presupuestadas** (`BudgetHoursLine`, que para eso existen y hasta ahora
 * no alimentaban nada). No se persiste nada: no es un `AllocationRun`, no ocupa
 * el índice único de periodo y no caduca informes; el `rulesHash` usado viaja en
 * `params`.
 *
 * Si el presupuesto **no puede seguir** al real —no hay horas presupuestadas para
 * una regla `HOURS`, o falta el snapshot de una `HEADCOUNT`— la función devuelve
 * `allocationState: "NONE"` con el motivo, y el informe aplica la salida mínima
 * de I-E10-18: **no publica** esas celdas por dimensión, sólo a total compañía y
 * con leyenda. Nunca produce una matriz mixta.
 */
export function settleBudgetMatrix(
  matrix: BudgetMatrix, input: {
    rules: readonly AllocationRuleSpec[]
    budgetHours: readonly BudgetHoursCell[]
    headcount: readonly HeadcountRow[]
    config: AnalyticsConfig
    period: AllocationPeriodRef
  }
): Result<BudgetMatrix, { code: "BUDGET_NOT_SETTLEABLE"; reason: string }>

/**
 * Construye la matriz del presupuesto con **las mismas funciones** que la del
 * real (`resolveEffectiveAnalyticType`, `resolveLevel`, `resolveColumn` de
 * `lib/analytics/margins.ts`). Reimplementarlas aquí sería garantizar que las
 * dos matrices divergen el día que alguien toque una regla de destino.
 */
export function buildBudgetMatrix(
  version: BudgetVersion, config: AnalyticsConfig, window: DateWindow
): BudgetMatrix
```

**Por qué reusa y no copia.** La columna la fija el **tipo efectivo** (R-A5), el
nivel de un `INDIRECTO_CECO` lo fija `CostCenter.marginLevel` (R-A6/R-A7) y
`NO_ANALITICO` se parte por `nonAnalyticLevel` (R-A11). Las tres reglas ya
existen, están probadas contra `pyg-analitica-esperada.json` y son **la
definición**. Un presupuesto que las resolviera de otra manera produciría una
desviación distinta de cero sin que nada hubiera cambiado.

### 3.3 `lib/budget/variance.ts` — desviaciones

```ts
export type VarianceCell = {
  level: MarginLevel; column: ColumnKey; month: string | null
  actualCents: Cents
  budgetCents: Cents | null          // `null` = sin presupuesto para la celda
  varianceCents: Cents | null        // actual − budget, EXACTO (I-E10-2)
  varianceBps: number | null         // en puntos básicos ENTEROS; null si budget = 0
  forecastCents: Cents | null
  /** **O-E10-4 / I-E10-18.** `true` cuando la celda NO se publica porque el
   *  presupuesto y el real están en estados de imputación distintos: las tres
   *  columnas derivadas salen `null` y la UI imprime la leyenda, en vez de
   *  calcular una desviación que no significa nada. */
  notComparable: boolean
}

/** `desviación = real − presupuesto`, resta entera y nada más. Sin presupuesto
 *  la celda es `null` en las tres columnas derivadas: **nunca 0**, que es una
 *  cifra y afirmaría algo falso (misma regla que el comparativo de ADR-0012).
 *
 *  **Regla de comparabilidad (I-E10-18)**: si `budget.allocationState` y el
 *  estado del real no coinciden, toda celda **por dimensión** de nivel ≥ MC3
 *  sale con `notComparable = true`. Las de INGRESOS, MC1 y MC2 sí se publican:
 *  la liquidación no las toca. Y el total compañía se publica en todos los
 *  niveles, porque ahí la imputación es de suma cero (E5-D1). */
export function buildVariance(input: {
  actual: AnalyticPnl; budget: BudgetMatrix; forecast: ForecastMatrix | null
  actualAllocationState: "NONE" | "SETTLED"
  granularity: "MONTH" | "QUARTER" | "YEAR" | "YTD"
}): readonly VarianceCell[]

/**
 * **Q-6 / D6 — descomposición volumen / precio. Convención CONGELADA; la
 * implementación es de E11.** Se escribe aquí para que las columnas no cambien
 * de significado cuando llegue:
 *
 *   Δ total   = P_r·Q_r − P_p·Q_p
 *   Δ volumen = ⌊ (Q_r − Q_p) × Importe_ppto / Q_p ⌋      (Q_p = 0 ⇒ todo volumen)
 *   Δ precio  = Δ total − Δ volumen                        ← RESIDUO ⇒ Σ exacta
 *
 * El **cruce va al precio**: el efecto volumen se mide a condiciones del plan
 * —lo único que controla producción— y el efecto precio sobre la actividad
 * realmente ejecutada. Un tercer término «cruce» es honesto e inservible en un
 * comité: nadie tiene responsabilidad sobre él. El precio unitario **no se
 * almacena** y `importe / horas` no es exacto, de ahí el residuo.
 * **No se descompone el efecto mezcla**: exige una jerarquía de producto que el
 * modelo no tiene, y mejor no publicarlo que publicarlo mal.
 */

/** `varianceBps = ⌊|real − ppto| · 10000 / |ppto|⌋` con signo, en ENTERO. Si el
 *  presupuesto es 0, `null`: decide el umbral absoluto (misma regla que
 *  `deltaBps` de `lib/ledger/report-run.ts`). Ni `Float`, ni `NaN`, ni `Infinity`. */
export function varianceBps(actualCents: Cents, budgetCents: Cents): number | null
```

### 3.4 `lib/budget/forecast.ts` — la reproyección

```ts
export type ForecastSource = "REAL_CERRADO" | "PRESUPUESTO_ABIERTO"

/**
 * `forecast(m) = real(m)` si `m ≤ cutoff`, `presupuesto(m)` si `m > cutoff`.
 *
 * `cutoff` es el **último mes cerrado**, y lo decide el borde: el mayor mes con
 * `PeriodLock` del ejercicio, o el fin del ejercicio si está `CLOSED`. Viaja
 * como parámetro (`forecastCutoff`) y entra en `paramsHash`, de modo que dos
 * ejecuciones del mismo informe con el mismo corte dan el mismo resultado (P7).
 *
 * **I-E10-7**: cada mes del ejercicio aparece EXACTAMENTE una vez y con UNA sola
 * procedencia. Ni solape (un mes contado dos veces infla el año) ni hueco (un mes
 * ausente lo desinfla), y las dos cosas son invisibles en el total si nadie las
 * comprueba.
 */
export function buildForecast(input: {
  actualByMonth: Record<string, Record<MarginLevel, Record<ColumnKey, Cents>>>
  budget: BudgetMatrix
  fiscalYearMonths: readonly string[]
  cutoffMonth: string | null          // `null` = ningún mes cerrado ⇒ todo presupuesto
}): ForecastMatrix

export type ForecastMatrix = {
  byMonth: Record<string, { source: ForecastSource; cells: Record<MarginLevel, Record<ColumnKey, Cents>> }>
  levelTotalsCents: Record<MarginLevel, Cents>
  /** Procedencia mes a mes, para pintarla en la cabecera de cada columna. */
  provenanceByMonth: Record<string, ForecastSource>
}
```

### 3.5 `lib/time/` — agregados de horas y coste-hora

```ts
// ── lib/time/aggregate.ts ────────────────────────────────────────────────────

export type TimeEntryRow = {
  id: string; employeeId: string; employeeCode: string
  date: LocalDate
  target: { kind: "PROJECT"; id: string; code: string } | { kind: "COST_CENTER"; id: string; code: string }
  businessLineCode: string | null
  minutes: number                    // negativo en un contra-apunte
  productive: boolean
  approved: boolean
}

/**
 * Minutos por receptor en una ventana. **Sólo aprobados** (R-H-3) y, con
 * `productiveOnly`, sólo productivos. Los contra-apuntes suman con su signo, así
 * que una entrada corregida aporta exactamente su neto sin que nadie tenga que
 * filtrarla. Determinista: el resultado va ordenado por código de receptor.
 */
export function minutesByTarget(
  rows: readonly TimeEntryRow[], window: DateWindow,
  opts: { productiveOnly: boolean; approvedOnly: true }
): readonly { code: string; id: string; kind: "PROJECT" | "COST_CENTER"; minutes: number }[]

export function minutesByEmployee(rows, window, opts): readonly { employeeCode: string; minutes: number }[]

/**
 * **O-E10-2 — lo que falta por aprobar.** No es un detalle: sin esto, un reparto
 * hecho sobre el 75 % de la actividad se publica **en silencio**. Devuelve, por
 * receptor elegible y para la ventana del driver, los minutos **sin aprobar** y
 * el porcentaje que representan sobre la base aprobada.
 */
export function unapprovedMinutesByTarget(
  rows: readonly TimeEntryRow[], window: DateWindow, opts: { productiveOnly: boolean }
): readonly { code: string; unapprovedMinutes: number; shareOfBaseBps: number | null }[]

/**
 * **O-E10-3 — UNA sola forma canónica**, la misma en el motor, en el ADR y en el
 * fixture. La ronda 0 la definía dos veces y de dos maneras, y una de ellas
 * incluía el `id` —un uuid aleatorio—, con lo que el hash de un fixture recargado
 * **nunca** habría coincidido y la reproducibilidad byte a byte de T10 y el
 * criterio 12 se caían solas.
 *
 *   fecha|códigoEmpleado|códigoReceptor|minutos|productiva
 *
 * Ordenada por esa misma tupla; el `id` sólo desempata dos renglones **idénticos**,
 * en cuyo caso el hash no cambia. Sólo entradas **APROBADAS** de la ventana.
 */
export function canonicalTimeForm(rows: readonly TimeEntryRow[], window: DateWindow): string
export function timeHash(rows: readonly TimeEntryRow[], window: DateWindow): string

/**
 * **O-E10-1 — la ventana que el run consume de verdad.** Pura, y la usan tanto
 * el sellado como la derivación de `STALE`, para que no puedan discrepar:
 *   alguna regla con `YTD`          ⇒ [inicio del ejercicio, periodEnd]
 *   alguna regla con `PRIOR_PERIOD` ⇒ [inicio del periodo anterior, periodEnd]
 *   en el resto                     ⇒ [periodStart, periodEnd]
 * (con las dos primeras a la vez, la unión: la más ancha).
 */
export function timeWindowOf(
  rules: readonly AllocationRuleSpec[], period: AllocationPeriodRef
): DateWindow | null            // `null` ⇒ ninguna regla de actividad ⇒ timeHash "∅"

// ── lib/time/cost.ts ─────────────────────────────────────────────────────────

/**
 * Coste de los partes de un receptor con la tarifa **vigente el día de cada
 * parte** (no la del fin de periodo): un cambio de tarifa a mitad de mes se
 * refleja parte a parte, que es lo que un controller espera.
 *
 * **O-E10-13 — el Hamilton, definido.** «Σ coste por parte = coste del receptor»
 * no decía qué es el coste del receptor, y sin definirlo dos implementaciones dan
 * cifras distintas. Con partes `i` de `mᵢ` minutos y tarifa `rᵢ` c/h del día:
 *
 *   T = ⌊ Σ (mᵢ · rᵢ) / 60 ⌋                       ← el total del receptor
 *   se reparte T entre los partes por MAYOR RESTO sobre los pesos mᵢ·rᵢ,
 *   con empate a favor del parte de menor (fecha, código de empleado, id)
 *
 * Es el mismo desempate determinista de ADR-0013 D5. Sin esta regla escrita, el
 * motor pierde un céntimo en cada receptor y cada mes. Sin tarifa vigente para un
 * parte, la fila sale **no evaluable** con el empleado y la fecha nombrados;
 * jamás se aplica 0 ni la tarifa anterior (I-E10-5, motivo `TARIFA_AUSENTE`).
 */
export function costOfTime(
  rows: readonly TimeEntryRow[], rates: readonly EmployeeRateRow[], window: DateWindow
): { byTarget: readonly TargetCost[]; unpriced: readonly UnpricedRow[]; basisConflict: readonly EmployeeRateBasis[] }

/**
 * Coste-hora **derivado** de la nómina (D3). Propuesta, no aplicación:
 *
 *   hourlyCostCents = ⌊ payrollCents × 60 / productiveMinutes ⌋
 *
 * `payrollCents` = Σ −aporte de las líneas del periodo cuyas cuentas caen en
 * `accountPrefixes` — default **`["640","642","645","649"]`**, configurable y
 * versionado. **`641` (indemnizaciones) queda fuera** (O-E10-11): es un coste no
 * recurrente ligado a personas que dejan de generar horas, y lo contrario dispara
 * la tarifa del último periodo del empleado. `["640"]` es `BRUTO_SIN_SS`.
 *
 * **O-E10-12 — de dónde sale la nómina de una persona.** `JournalLine` no tiene
 * `employeeId`, y la nómina se contabiliza normalmente en una o dos líneas de
 * `640` **por CECO**, no por persona: con el diseño de la ronda 0 la función no
 * tenía fuente. Dos ámbitos, declarados:
 *
 *   scope = "COST_CENTER"  (DEFAULT) — ⌊64x del CECO × 60 / minutos productivos
 *                           aprobados del CECO⌋; la propuesta se aplica a todos
 *                           los empleados del CECO sin tarifa propia. Honesto y
 *                           suficiente para gestión.
 *   scope = "EMPLOYEE"     — sólo si las líneas `64x` llevan el `counterpartyId`
 *                           del `Counterparty` del empleado. La propuesta informa
 *                           su **cobertura** («8 de 34 líneas, 78 % del importe»)
 *                           y queda **no evaluable** por debajo de
 *                           `Organization.derivationMinCoverageBps`. Nunca
 *                           extrapola en silencio.
 *
 * Con 0 minutos productivos o sin nómina, **no evaluable**, nunca ∞ ni 0.
 * Devuelve la cifra **y sus términos**, que es lo que se guarda en
 * `EmployeeRate.derivation` para que el número se pueda rehacer a mano.
 */
export function deriveHourlyCost(input: {
  scope: "COST_CENTER" | "EMPLOYEE"
  payrollCents: Cents; productiveMinutes: number
  linesTotal: number; linesMatched: number; matchedAmountCents: Cents
  accountPrefixes: readonly string[]; basis: EmployeeRateBasis
  minCoverageBps: number
  periodStart: LocalDate; periodEnd: LocalDate
}): Result<{ hourlyCostCents: Cents; derivation: Record<string, unknown> },
           "NO_PRODUCTIVE_TIME" | "NO_PAYROLL" | "COVERAGE_TOO_LOW">

/**
 * **O-E10-20 — desviación de absorción.** La primera cifra que un CFO pide
 * cuando hay tarifas, y que la ronda 0 no tenía en ninguna pantalla:
 *
 *   absorción = Σ (minutos × tarifa / 60) − Σ (−aporte) de 64x del periodo
 *
 * con su signo, su % y su desglose por CECO. **No es un invariante**: I-E10-12
 * sólo garantiza que no se pase (`≤`), de modo que una **infraabsorción del 20 %
 * lo pasa en silencio**; y endurecerlo a igualdad sería exigir horas y tarifas
 * perfectas. Su sitio es el informe.
 */
export function absorptionVariance(input: {
  valuedCents: Cents; payrollCents: Cents; byCostCenter: readonly { code: string; valuedCents: Cents; payrollCents: Cents }[]
}): AbsorptionReport
```

### 3.6 Drivers `HOURS` y `HEADCOUNT` en `lib/analytics/allocate.ts`

**Lo que NO cambia**, y es la mitad del valor de esta tarea: `hamilton()`, el
grafo, `findCycle`, `checkTopologicalOrder`, `liquidableBase`, el orden de
ejecución de ocho pasos, la cascada, **E5-D1 (el nivel viaja con el importe)**,
`sourceShareBps`, los dos Hamilton anidados, el desempate por **menor código** y
la forma canónica de la salida. E10 añade **dos ramas en `driverWeights` y un
campo en `AllocationInput`**, nada más. El test byte a byte contra
`liquidacion-esperada.json` sigue en verde sin tocar el fixture, porque ninguna
de sus seis reglas usa un driver de actividad — y ése es el criterio 1.

```ts
export type AllocationInput = {
  /* …lo de E5, intacto… */
  /** **E10.** Partes del ejercicio, **aprobados y sin aprobar** (no sólo del
   *  periodo: `YTD` y `PRIOR_PERIOD` los necesitan, igual que las líneas). El
   *  driver usa sólo los aprobados; los demás viajan para poder emitir
   *  `W-E10-UNAPPROVED-HOURS` con su importe (O-E10-2). Vacío ⇒ los drivers de
   *  actividad caen en su `zeroBaseFallback`. */
  timeEntries: readonly TimeEntryRow[]
  /** **E10.** Snapshots de plantilla del ejercicio, por CECO y fin de mes. */
  headcount: readonly HeadcountRow[]
}
```

Bases, en la tabla de `driverWeights`:

| Driver | Peso `wᵢ` | Notas |
|---|---|---|
| **`HOURS`** | `Σ minutes` de `TimeEntry` **`APROBADO` y `productive`** con receptor `i` y `date` dentro de la **ventana del PERIODO del run**, ensanchada **sólo si el `zeroBaseFallback` se aplicó de hecho** (`YTD` ⇒ desde el inicio del ejercicio; `PRIOR_PERIOD` ⇒ el periodo anterior); contra-apuntes incluidos con su signo; `max(0, ·)` | Receptores: proyectos (`PROJECTS`), CECOs (`COST_CENTERS`) o la LN del proyecto (`BUSINESS_LINES`). Cumple el contrato del experto de E5: **minutos enteros** (Q-2), **sólo aprobadas**, y las horas de personal ya imputado directamente a MC2 **cuentan igual** —el driver mide consumo de estructura, no coste— |
| **`HEADCOUNT`** | **`Σ fteMilli` de los `HeadcountSnapshot` cuyo fin de mes cae dentro del periodo del run** («FTE·mes», Q-7) | **Sólo `targetKind = COST_CENTERS`** (CHECK en M4 y validación en la acción): con proyectos no hay plantilla declarada y derivarla de las horas sería `HOURS` con otro nombre. Para un run `MONTH` hay **un solo snapshot** ⇒ es exactamente el stock a fin de periodo de la ronda 0, y el fixture no se mueve; para `QUARTER` y `YEAR` deja de ser falso: un CECO que vive de febrero a noviembre tenía **peso 0** en el run anual (stock a 31-12) y no absorbía nada de sus diez meses vivos, trasladando esa estructura a los demás. **Sin división y sin redondeo** |

Avisos nuevos, del mismo vocabulario cerrado que los `W-E5-*`:

```ts
export type AllocationWarning =
  /* …los tres de E5… */
  | { code: "W-E10-NO-HOURS";     ruleCode: string; period: string; detail: string }
  | { code: "W-E10-NO-HEADCOUNT"; ruleCode: string; period: string; targets: readonly string[]; detail: string }
  | { code: "W-E10-UNAPPROVED-HOURS"; ruleCode: string; period: string
      unapprovedMinutes: number; shareOfBaseBps: number | null
      targets: readonly string[]; detail: string }
  | { code: "W-E10-HEADCOUNT-TRAPPED"; ruleCode: string; period: string; targets: readonly string[]; detail: string }
```

> **Corrección de la ronda 1 (auditoría H-6, documental).** La ronda 0 escribía
> aquí «dentro de la ventana efectiva del run (§3.5 `timeWindowOf`)», y eso **no
> es lo que hace el motor ni lo que dice el fixture**: `timeWindowOf` es la
> ventana que el **`timeHash`** sella —deliberadamente ancha, para que aprobar en
> mayo un parte de enero caduque el run de marzo (O-E10-1)—, mientras que la
> **base del driver** es la del periodo y sólo se ensancha cuando el fallback se
> aplicó. Con la letra de la ronda 0, el run de 2026-11 tendría base 52 204 min
> en vez de 4 532. La implementación (`driverWindowOf`, `hoursWeights`) era la
> correcta; el texto —y la redacción de **I-E10-3**, que ahora dice «ventana
> efectiva del run» en el mismo sentido: periodo, o periodo ensanchado por el
> fallback REALMENTE aplicado— se alinean con ella.

**`W-E10-UNAPPROVED-HOURS` se emite SIEMPRE que haya minutos sin aprobar** de
receptores elegibles en la ventana del driver, **no sólo cuando la base es cero**
(O-E10-2) **y tampoco sólo cuando la base es mayor que cero** (revisión de la
ronda 1, hallazgo 4): con 0 minutos aprobados y 12 000 sin firmar, el aviso sale
igual, con `shareOfBaseBps: null` —no hay porcentaje sobre una base vacía—, y el
run se sella con `HORAS_SIN_APROBAR` además de caer en su `zeroBaseFallback`. El
100 % sin aprobar es el caso extremo del parcial, no una excepción. El caso peligroso es justamente el parcial: con `CC-OPS` repartiendo
900 000 c, base aprobada 36 000 min y 12 000 min de P-03 sin firmar, el reparto
sale P-01 480 000 / P-02 270 000 / P-03 150 000 y con la base completa habría sido
360 000 / 202 500 / 337 500 — **187 500 c de diferencia en P-03** y nadie
avisado. El aviso lleva los minutos y su **% sobre la base**, y **mueve el sello
del propio `AllocationRun`** con `HORAS_SIN_APROBAR`, no sólo el del `ReportRun`.

**`W-E10-HEADCOUNT-TRAPPED`** (O-E10-16): una regla `HEADCOUNT` reparte a CECOs
que **no tienen a su vez regla vigente** hacia proyectos, así que el saldo queda
atrapado un nivel más abajo. I5.b acabará detectándolo, pero tarde y sin decir por
qué; el aviso lo dice al simular.

**ADR-0013 D4 — «prohíbe regla inerte»: cómo se cumple ahora.** El `CHECK` de la
base desaparece, así que la garantía se traslada a dos puntos, los dos con test:

1. **Al guardar la regla** (`createAllocationRuleAction`): con `HOURS` o
   `HEADCOUNT`, la organización debe tener `timeTrackingEnabled = true` **y** al
   menos un dato de la clase que el driver consume (un `TimeEntry` aprobado, o un
   `HeadcountSnapshot`, en el ejercicio de `validFrom`). Si no, `DRIVER_UNAVAILABLE`
   con el texto que dice **qué falta y dónde darlo de alta** — no un «no
   disponible» mudo.
2. **Al sellar el run** (`sealAllocationRun`): una regla de actividad cuya base
   es 0 **en todos** los receptores y cuyo `zeroBaseFallback` es `SKIP_WARN`
   deja el saldo del CECO **visible** en «pendiente de liquidar» con el motivo
   (mecanismo de E5 §3.3, sin cambios) **y** emite el aviso. Una regla que
   reparte 0 € nunca queda muda.
3. **Y con base parcial** (O-E10-2): aunque la base sea > 0, si quedan minutos
   sin aprobar de receptores elegibles, el run se sella con
   `W-E10-UNAPPROVED-HOURS` y el motivo `HORAS_SIN_APROBAR`. Repartir sobre el
   75 % de la actividad **sin decirlo** es tan malo como repartir 0 € en
   silencio, y es mucho más frecuente.

### 3.7 Imputación del coste de personal a proyectos por horas

Dos caminos, los **dos ya existentes**, y ninguno genera un asiento contable.

**(a) Camino por defecto — capa analítica (ADR-0004).** El personal indirecto se
contabiliza contra un CECO (`CC-OPS`, `CC-DEV`…) y una `AllocationRule` con
driver `HOURS` lo reparte a los proyectos. El importe aterriza en la columna del
proyecto **con el `marginLevel` del CECO donde nació** (E5-D1), es reversible,
sellado y reproducible. Es la respuesta correcta para «el equipo de Operaciones
dedicó el 40 % de sus horas a P-01».

**(b) Camino opcional — reclasificación analítica auditada (ADR-0010).** Cuando
una línea 64x es **íntegramente** de un proyecto (un técnico dedicado en
exclusiva), la línea puede reasignarse de CECO a proyecto: R-A3 la convierte
automáticamente en `COSTE_DIRECTO_MC2` y el coste baja de MC3 a MC2, que es la
lectura correcta. `lib/time/payroll-reclass.ts` produce la **propuesta** pura:

```ts
/**
 * Propone qué líneas 64x de un CECO son atribuibles a un solo proyecto según las
 * horas aprobadas del periodo. Devuelve SIEMPRE una propuesta, nunca un cambio.
 *
 * **Sólo propone líneas atribuibles al 100 % a un proyecto.** Una línea repartida
 * entre varios NO se puede reclasificar: partir una `JournalLine` está prohibido
 * (ADR-0003, ADR-0010 salvaguarda 1 — sólo cambian las cuatro columnas
 * analíticas). Ese caso es el camino (a) y la propuesta lo dice así.
 */
export function proposePayrollReclass(input: {
  payrollLines: readonly AnalyticLine[]      // 64x del periodo con costCenterId
  hours: readonly TimeEntryRow[]
  window: DateWindow
  // **O-E10-22**: sin parámetro. La concentración exigida es 10000 bps = 100 %,
  // fija. Con 8000, una línea de 300 000 c de la que el proyecto sólo consumió
  // el 80 % se reasignaría ENTERA y el MC2 del proyecto se llevaría 60 000 c que
  // no son suyos. El caso no íntegro es el camino (a), como ya decía el propio
  // comentario de esta función.
}): { proposals: readonly ReclassProposal[]; notAttributable: readonly NotAttributable[] }
```

La aplica `models/analytics.reclassifyLines` **sin un solo cambio**: misma
ventana, mismo motivo obligatorio, mismo `AuditLog`, mismo recálculo de
`entryHash` y misma caducidad de sólo los informes analíticos. **`ledgerHash` no
cambia**, y hay un test que lo exige al céntimo (criterio 14).

**El matiz que el experto exige escribir, y no dar por sabido.** El camino (b)
**cambia el nivel de margen** del importe: de `INDIRECTO_CECO`/MC3 pasa a
`COSTE_DIRECTO_MC2` por R-A3. Es la lectura correcta, pero significa que una
reclasificación **mueve MC2 y MC3 de periodos ya informados**. La salvaguarda es
la **ventana temporal de ADR-0010**, y se cita expresamente porque es lo que acota
el daño: ejercicio `OPEN` y mes abierto ⇒ `EDITOR`; **mes bloqueado del ejercicio
abierto ⇒ sólo `ADMIN`, con motivo**; **ejercicio `CLOSED` ⇒ nunca, sin excepción
de rol** (arts. 253, 272 y 279 LSC).

**Lo que no se hace, y por qué.** No se crea un asiento de traspaso 64x → 64x por
dimensión: no es un hecho económico (NRV 14ª), contaminaría el diario, obligaría
a un flag de exclusión de informes —prohibido por `CLAUDE.md`— y ya lo
descartaron ADR-0004 y ADR-0013. Tampoco se crean cuentas del grupo 9.

### 3.8 Sellos

```
budgetHash = sha256( cabecera(ejercicio, escenario, revisión, vigencia, partialFrom)
                     ‖ líneas de importe en forma canónica, CON su marginLevel   (O-E10-7)
                     ‖ líneas de horas en forma canónica, en minutos
                     ‖ marginConfigHash )

W          = timeWindowOf(reglas del run, periodo)          ← O-E10-1, §3.5
timeHash   = sha256( join("\n", entradas APROBADAS con date ∈ W,
                          ordenadas por (fecha, códigoEmpleado, códigoReceptor, minutos, productiva),
                          en la forma  fecha|códigoEmpleado|códigoReceptor|minutos|productiva) )
           = "∅"  cuando el run no tiene ninguna regla de driver de actividad
             (y entonces `timeHashWindowStart/End` quedan a NULL)

analyticsKey  = analyticsHash | marginConfigHash | allocationRunSetHash        (sin cambios)
claveDeCaché  = (organización, tipo, periodo, paramsHash, ledgerHash,
                 analyticsKey, gitSha, budgetHash)                             (M5)
```

**Caducidad de un run, con el cuarto sello.** Un `AllocationRun` está `STALE`
—derivado, nunca almacenado— si difiere (a) el `ledgerHash` del periodo,
(b) el `dimensionsHash`, (c) el `rulesHash`, o **(d) el `timeHash` recomputado
sobre la ventana `[timeHashWindowStart, timeHashWindowEnd]` que el propio run
persiste**. (d) es nuevo y es indispensable: aprobar un parte de diciembre en
enero cambia la base del reparto de diciembre, y sin (d) el run seguiría luciendo
vigente con un reparto que ya no se puede reproducir.

**Y la ventana no es cosmética** (O-E10-1). Con el sello acotado al periodo, un
run de marzo con `zeroBaseFallback = YTD` reparte usando partes de **enero**, y
aprobar en mayo un parte de enero de 800 minutos **no cambiaba el `timeHash` de
marzo**: el run no aparecía `STALE` y lucía vigente con un reparto irreproducible
— literalmente el fallo que D1 dice cerrar. Persistir la ventana además de
recomputarla evita tener que releer las reglas vigentes para comprobar la
staleness, que es lo que la volvería dependiente de una tercera cosa que también
cambia. Es la misma lección que O-E5-7 (el conjunto de runs) aplicada a la capa de
abajo, y la comprueba **I-E10-17**.

**Qué caduca al sellar un presupuesto.** Sólo `PRESUPUESTO_REAL`. `budgetHash`
vive **exclusivamente** en la clave de caché de ese tipo: el balance, la PyG
contable, el cashflow, el diario y la PyG analítica **conservan su caché**,
porque ni `ledgerHash` ni `analyticsKey` se mueven. Criterio 17 lo comprueba en
los dos sentidos.

### 3.9 `allocationRunStalenessBatch` — el N+1 de la staleness (deuda §0-bis #6)

Hoy `allocationRunStaleness` llama a `loadRunContext` **por run**; la memoización
por transacción de E5 lo dejó en «una consulta por periodo distinto», que con
doce runs mensuales sellados siguen siendo doce. La forma correcta es agregar por
periodo en SQL:

```ts
/** Staleness de N runs en **tres** consultas, sea cual sea N:
 *   1. `ledgerHash` y `dimensionsHash` por periodo — UNA consulta con la lista de
 *      periodos en un `VALUES`, `JOIN` contra `journal_lines`, `digest(string_agg(
 *      forma canónica, E'\n' ORDER BY entry_date, entry_number, line_no), 'sha256')`
 *      agrupado por periodo. Es exactamente la forma canónica de `lib/ledger/hash.ts`
 *      escrita en SQL, y hay un test que compara los dos caminos fila a fila
 *      (mismo patrón que el trigger espejo de `report_runs_analytics_key`).
 *   2. Reglas vigentes de todas las `(periodicidad, fin de periodo)` distintas —
 *      UNA consulta; el `rulesHash` se compone en TS con `canonicalRulesForm`.
 *   3. `timeHash` **por ventana** — UNA consulta agregada sobre `time_entries`
 *      APROBADAS, con el mismo `digest(string_agg(...))`, usando las ventanas
 *      `[time_hash_window_start, time_hash_window_end]` que **los propios runs
 *      persisten** (O-E10-1): no hay que releer las reglas para saber qué
 *      ventana consumió cada uno.
 */
export async function allocationRunStalenessBatch(
  tx: TenantTransactionClient, runs: readonly AllocationRunListItem[]
): Promise<Map<string, { isStale: boolean; reasons: string[] }>>
```

`listAllocationRuns` deja de devolver `isStale: false` de relleno y lo rellena de
verdad; `models/closing.ts` (paso del checklist que lista los CECOs pendientes) y
`/analytics/allocations/runs` pasan a la versión en lote. `allocationRunStaleness`
(singular) se conserva como envoltorio de un elemento, para no duplicar reglas.

---

## 4. Capa de aplicación

### 4.1 Modelos (IO y tenant; no calculan nada)

```ts
// models/budget.ts
listBudgets(db, { fiscalYearId }): Promise<BudgetListItem[]>           // con estado, vigencia y nº de líneas
getBudgetVersion(tx, budgetId): Promise<BudgetVersion>                 // cabecera + celdas + horas
/** **O-E10-9**: devuelve la versión EFECTIVA del ejercicio en esa fecha, ya
 *  compuesta a partir de la BASE y de las REVISADO parciales, con la procedencia
 *  mes a mes. Nunca una versión suelta que pueda cubrir medio año. */
activeBudgetAt(tx, { fiscalYearId, at }): Promise<ComposedBudget | null>
createBudgetVersion(tx, input, actor): LedgerResult<Budget>            // BASE, o REVISADO copiando otra
upsertBudgetCells(tx, { budgetId, cells }, actor): LedgerResult<number>   // sólo BORRADOR, por lotes; valida signo (O-E10-6)
deleteBudgetCells(tx, { budgetId, cellIds }, actor): LedgerResult<number>
importBudgetCsv(tx, { budgetId, rows }, actor): LedgerResult<ImportReport>   // R-B-6: rechaza el fichero entero si la convención está invertida
/** Calcula `budgetHash` + `marginConfigHash` + `gitSha`, y **cierra la versión
 *  anterior con `validTo = validFrom − 1 día` en LA MISMA transacción**
 *  (O-E10-8): el `EXCLUDE` impedía el solape, pero no el hueco. */
sealBudget(tx, { budgetId, validFrom }, actor): LedgerResult<Budget>
supersedeBudget(tx, { budgetId, reason }, actor): LedgerResult<Budget>
/** **Q-4** — propuesta de presupuesto de amortización: precarga las líneas `68x`
 *  mes a mes con la dotación de los **activos ya en alta**, con su dimensión
 *  analítica y sus términos (`assetId`, base, método, vida útil restante).
 *  Reutiliza el cuadro de E9; es propuesta, nunca aplicación (patrón
 *  `deriveHourlyCost`). El CAPEX del grupo 2 es E11. */
proposeDepreciationBudget(tx, { fiscalYearId }): Promise<DepreciationBudgetProposal>

// models/time.ts
listTimeEntries(db, filter): Promise<TimeEntryListItem[]>              // paginado, patrón de E3
createTimeEntries(tx, rows, actor): LedgerResult<number>               // avisa si Σ minutos del día > 1440 (O-E10-21)
approveTimeEntries(tx, { ids }, actor): LedgerResult<number>           // R-H-4: no se aprueba a sí mismo
correctTimeEntry(tx, { entryId, minutes, reason }, actor): LedgerResult<TimeEntry>
importTimeCsv(tx, { rows, fileSha256 }, actor): LedgerResult<ImportReport>   // idempotente por importKey
/** Devuelve **aprobados y sin aprobar** de la ventana: el driver usa los
 *  primeros y `W-E10-UNAPPROVED-HOURS` necesita los segundos (O-E10-2). */
getTimeRowsForWindow(tx, { from, to }): Promise<TimeEntryRow[]>

// models/employees.ts
listEmployees / createEmployee / updateEmployee / archiveEmployee
listEmployeeRates(db, employeeId)
/** Cierra la vigencia anterior; rechaza `COSTE_TOTAL_CON_ESTRUCTURA` con reglas
 *  de actividad vigentes (`RATE_BASIS_CONFLICT`, O-E10-14). */
createEmployeeRate(tx, input, actor)
/** **O-E10-12** — `scope: "COST_CENTER" | "EMPLOYEE"`. Por defecto, tarifa media
 *  del CECO; individual sólo con `counterpartyId` en las líneas `64x`, y siempre
 *  informando la **cobertura**. */
proposeHourlyCost(tx, { scope, costCenterId?, employeeId?, periodStart, periodEnd, basis }): Promise<HourlyCostProposal>
listHeadcount / upsertHeadcountSnapshot / deriveHeadcountFromEmployees

// models/reports.ts (ampliado)
// `PRESUPUESTO_REAL` sale de NOT_IMPLEMENTED; `getOrCreateReportRun` compone
// real + presupuesto + forecast y sella con el noveno componente de la clave.
```

Todo acceso por `tenantDb` / `tenantTransaction`; toda escritura con `AuditLog`
**en la misma transacción**, con `abort()` y nunca `return` (lección BLOQUEA-1 de
E3). Lecturas **en serie** dentro de la transacción (regla de E6-perf: dentro de
una transacción hay UNA conexión).

`AuditEntity` += `"Budget"`, `"BudgetLine"`, `"TimeEntry"`, `"Employee"`,
`"EmployeeRate"`, `"HeadcountSnapshot"`. `AuditAction` += `"SEAL_BUDGET"`,
`"SUPERSEDE_BUDGET"`, `"IMPORT_BUDGET"`, `"APPROVE_TIME"`, `"CORRECT_TIME"`,
`"IMPORT_TIME"`, `"SET_RATE"`.

### 4.2 Server actions y matriz de roles

Validación con zod en `forms/{budget,time,employees}.ts`; toda acción empieza por
`withOrg(<rol>)` y devuelve `ActionState`. `refDate` se decide **en el borde**,
nunca dentro de `lib/budget/` ni de `lib/time/`.

| Acción | Rol mínimo | Notas |
|---|---|---|
| `listBudgetsAction`, `getBudgetAction`, `budgetVsActualAction`, `projectProfitabilityAction`, `budgetDiffAction` | `VIEWER` | Sólo lectura. Emiten `ReportRun`, que es un hecho, no una mutación (precedente de E6). **`budgetVsActualAction` rechaza con `BUDGET_NOT_SEALED`** si la versión es `BORRADOR` (O-E10-5): un borrador no firma un informe |
| `previewBudgetVsActualAction` | `VIEWER` | **Previsualización no sellada** contra un `BORRADOR`: dry-run puro, **sin fila en `report_runs`**, con banda «borrador, no firmable». Es el patrón de `previewAllocation` en E5 |
| `upsertBudgetCellsAction`, `deleteBudgetCellsAction`, `importBudgetCsvAction` | `EDITOR` | Sólo sobre `BORRADOR`. Un `EDITOR` teclea el presupuesto. Validan el **signo por tipo analítico** (O-E10-6) y el importador **rechaza el fichero entero** con la convención invertida (R-B-6) |
| `upsertBudgetHoursAction` | `EDITOR` | Horas presupuestadas por (mes, dimensión, empleado). Sólo sobre `BORRADOR`, como sus hermanas de celdas (PUEDE 15 de la revisión de la ronda 1: la acción existía y no figuraba aquí). **Entran en el `budgetHash`** (ADR-0018 D2), así que tocarlas después de sellar es imposible por trigger |
| `proposeDepreciationBudgetAction` | `EDITOR` | Devuelve la propuesta de `68x` con sus términos; no escribe (Q-4) |
| `proposePayrollReclassAction` | `VIEWER` | **Propone**, no escribe: qué líneas 64x de un CECO son atribuibles al 100 % a un proyecto según las horas aprobadas (§3.7 camino (b)) |
| `applyPayrollReclassAction` | **`ADMIN`** | Aplica la propuesta confirmada delegando en `models/analytics.reclassifyLines` (ADR-0010), con motivo obligatorio y la ventana temporal de ADR-0010 intacta: mes bloqueado del ejercicio abierto ⇒ sólo `ADMIN`; ejercicio `CLOSED` ⇒ **nunca** |
| `createBudgetVersionAction`, `sealBudgetAction`, `supersedeBudgetAction` | **`ADMIN`** | Sellar un presupuesto fija el patrón de medida de toda la compañía: es política, no operación. Mismo criterio que `createAllocationRuleAction` |
| `listTimeEntriesAction` | `VIEWER` | Un `VIEWER` ve todos los partes; **un usuario sin `Employee` enlazado ve sólo lo agregado** |
| `createTimeEntriesAction`, `correctTimeEntryAction`, `importTimeCsvAction` | `EDITOR` | `correctTimeEntryAction` exige motivo ≥ 10 caracteres |
| `approveTimeEntriesAction` | `EDITOR` | **R-H-4**: rechaza los partes cuyo `Employee.userId` es el del actor, salvo que sea `ADMIN`. Segregación P5 |
| `createEmployeeRateAction`, `proposeHourlyCostAction` (aplicar) | **`ADMIN`** | El coste-hora mueve el margen de todos los proyectos |
| `upsertHeadcountSnapshotAction` | `EDITOR` · sellar: `ADMIN` | Es la base de un reparto |
| `createAllocationRuleAction` con `HOURS`/`HEADCOUNT` | **`ADMIN`** (sin cambios) | Valida §3.6 punto 1 |
| `GET /analytics/budget/export?format=csv\|xlsx\|pdf&runId=…` | `VIEWER` | Binario: route handler, no server action (patrón de E6) |

Errores en español contable, anclados al objeto: `DRIVER_UNAVAILABLE` →
«el driver HORAS necesita partes de horas aprobados: la organización no tiene
ninguno en 2026. Actívalos en Configuración → Horas y aprueba al menos un parte»;
`BUDGET_SEALED` → «la versión 2026-BASE está sellada desde el 15-01-2026: crea
una revisión en vez de editarla»; `TIME_ENTRY_APPROVED` → «el parte de A. García
del 12-03 está aprobado: corrígelo con un contra-apunte, con motivo»;
`BUDGET_NOT_SEALED` → «2026-REV2 está en borrador: puedes verla en
previsualización, pero un informe firmado necesita una versión sellada»;
`BUDGET_SIGN` → «la cuenta 6400 es un coste directo: el importe presupuestado va
en negativo (−12.000,00 €). Lo has tecleado en positivo»; `RATE_BASIS_CONFLICT` →
«hay reglas de imputación por horas vigentes: una tarifa con estructura incluida
cargaría la estructura dos veces».

### 4.3 Bloqueo de periodos: B-9

`PeriodLock` gana un noveno efecto: **un mes bloqueado no admite partes de horas
nuevos ni aprobaciones**, porque las horas de ese mes ya alimentaron una
liquidación y un informe rendidos. Barrera 1 en la acción, barrera 2 en el
trigger `time_entries_date_in_fiscal_year`. Un `ADMIN` puede desbloquear el mes,
con motivo, como en E9.

---

## 5. Informes

### 5.1 `PRESUPUESTO_REAL`

Es **la matriz de E4 con cinco columnas por celda**. Ni un informe nuevo ni una
tabla nueva: la misma retícula `nivel de margen × columna`, la misma provenance y
el mismo drill-down.

```
params = { budgetId, scenario, granularity: MONTH|QUARTER|YEAR|YTD,
           withAllocations: boolean, forecastCutoff: "AAAA-MM" | null,
           budgetRulesHash: string | null,      // O-E10-4: reglas de la liquidación presupuestaria
           budgetComposition: { "2026-01": "2026-BASE", … },   // O-E10-9: procedencia por mes
           dimensionFilter?: { businessLineCode? }, currency, comparative }
```

**La regla de comparabilidad, primero, porque condiciona todo lo demás**
(O-E10-4, **I-E10-18**). Presupuesto y real se publican **en el mismo estado de
imputación**:

- `withAllocations = false` ⇒ los dos **sin imputar**. Nada que hacer.
- `withAllocations = true` ⇒ el presupuesto pasa por `settleBudgetMatrix()`
  —mismas reglas vigentes, mismo `allocate()`, drivers de actividad alimentados
  por las **horas presupuestadas**— y las dos matrices son comparables en todos
  los niveles.
- Si el presupuesto **no puede seguirlo** (faltan horas presupuestadas o
  snapshots): las celdas **por dimensión** de nivel ≥ MC3 salen `notComparable`,
  **no se publican** y la UI imprime el motivo. INGRESOS, MC1 y MC2 sí se
  publican —la liquidación no las toca— y el **total compañía** también, porque
  ahí la imputación es de suma cero (E5-D1). **El toggle se bloquea** con el
  motivo, en vez de producir una matriz mixta.

Nunca se calcula una desviación entre dos magnitudes que no miden lo mismo: con
`CC-OPS` presupuestado y ejecutado en 900 000 c exactos, la ronda 0 publicaba
**−400 000 c de desviación de MC3 en P-01 con ejecución perfecta**, y el total
compañía cuadraba.

| Columna | Origen | Sello |
|---|---|---|
| **Presupuesto** | `composeBudget` + `buildBudgetMatrix` (+ `settleBudgetMatrix` con imputaciones) | `budgetHash` de cada versión compuesta + `budgetRulesHash` |
| **Real** | `buildAnalyticPnl` (con o sin imputaciones, según `withAllocations`) | `ledgerHash` + `analyticsKey` |
| **Desviación abs.** | `real − presupuesto`, entero, tolerancia 0 | los dos |
| **Desviación %** | `varianceBps`, entero; `—` si el presupuesto es 0 | los dos |
| **Forecast** | `buildForecast` con `forecastCutoff` | los dos + `paramsHash` |

Desglose por **proyecto / CECO / LN / mes**, agregable a trimestre, año y YTD.
Sin presupuesto para una celda: las tres columnas derivadas salen **vacías con
leyenda**, nunca a cero (misma regla que el comparativo de ADR-0012). Celda
`notComparable`: igual, con el motivo de I-E10-18.

**Cabecera de procedencia del presupuesto** (O-E10-9): cuando el ejercicio tiene
versiones parciales, la cabecera dice **de qué versión sale cada mes**
(`ene–jun: 2026-BASE · jul–dic: 2026-REV1`), igual que `provenanceByMonth` hace
con el forecast. Un año compuesto a medias sin decirlo es un año mal sumado.

**Provenance por celda** (P6), con **tres** consultas parametrizadas, porque una
celda de desviación no se reproduce con una sola:

```json
{"valor": -184320, "moneda": "EUR", "metrica": "desviacion.mc3.PROJ:P-01.2026-03",
 "run_id": "…", "ledgerHash": "…", "budgetHash": "…", "analyticsKey": "…",
 "calculado_por": "lib/budget/variance.ts@<git-sha>",
 "registros_origen": {
   "real":         "SELECT id FROM journal_lines WHERE …",
   "imputado":     "SELECT id FROM allocation_lines WHERE …",
   "presupuesto":  "SELECT id FROM budget_lines WHERE budget_id = $1 AND …" },
 "confianza": "calculado"}
```

**Export CSV / XLSX / PDF** con el motor de E6 sin cambios: el informe, la hoja
**«Procedencia»** (con las tres consultas y los tres sellos) y la hoja
**«Validación»** (checks y sello con motivos), más las notas al pie —«informe de
gestión», «el presupuesto es una decisión, no un cálculo», «las filas EBIT, BAI y
RESULTADO de una columna de proyecto no son márgenes de proyecto»—. CSV: tres
ficheros en un `.zip`. XLSX: importes como número con formato `#.##0,00 €`,
compuestos por aritmética entera desde los céntimos.

### 5.2 Rentabilidad por proyecto con horas

Bloque propio dentro del mismo `ReportRun` y pantalla en `/analytics/projects/[code]`:

| Métrica | Fórmula | Nota |
|---|---|---|
| **Minutos reales** | `Σ minutes` aprobados y productivos del proyecto | Contra-apuntes con su signo |
| **Minutos presupuestados** | `Σ BudgetHoursLine.minutes` de la versión efectiva | `—` si no se presupuestaron |
| **Desviación de horas** | reales − presupuestados | Entero, en minutos; se presenta en `hh:mm` |
| **Coste-hora medio** | `⌊ coste de personal imputado × 60 / minutos ⌋` | **No evaluable** con 0 minutos, con partes sin tarifa vigente (`TARIFA_AUSENTE`) o **con `basis` en conflicto** entre los empleados que intervinieron (O-E10-15); nunca 0 |
| **Margen por hora** | `⌊ MC2 (y MC3) × 60 / minutos ⌋` | Se publican **los dos niveles**, porque MC3 depende de una política de reparto y MC2 no |
| **Tarifa media facturada** | `⌊ ingresos × 60 / minutos ⌋` | Sólo con `INGRESO_DIRECTO` del proyecto |
| **Desviación de absorción** | `Σ (minutos × tarifa / 60) − Σ (−aporte) de 64x` | **O-E10-20.** Con su signo, su % y su desglose por CECO. Es la primera cifra que un CFO pide cuando hay tarifas, y la ronda 0 no la tenía: I-E10-12 sólo comprueba que no se pase (`≤`), así que **una infraabsorción del 20 % pasaba el invariante en silencio**. Es información de gestión, **no** un FAIL |

Los porcentajes y los ratios **no se persisten** (ADR-0003): viajan en el
`result` del run, que sí es una foto sellada.

**Y la `basis` viaja con la cifra.** Todo coste-hora, margen por hora y absorción
se imprime junto a su `EmployeeRateBasis` —en pantalla y en el export—, porque
`BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` difieren ~31,9 % y compararlos es comparar
dos magnitudes distintas (Q-1).

### 5.3 Umbrales `EV-*` de desviación

`Organization.reviewThresholds` gana **cuatro** KPI, con la misma forma que los
siete de ADR-0012 (`pctBps` **y** `minAbsCents`, y dispara sólo si **supera los
dos**):

| KPI | Definición | `pctBps` | `minAbsCents` |
|---|---|---:|---:|
| `desviacionIngresos` | `real − ppto` de la fila INGRESOS, total compañía | 1000 | 500 000 |
| `desviacionEbitda` | ídem en EBITDA | 1500 | 300 000 |
| `desviacionMc3` | ídem en MC3 | 1500 | 300 000 |
| **`desviacionMaxDimension`** | **`max \|desviación\|` POR DIMENSIÓN** en INGRESOS, MC2 y MC3 | 2000 | 500 000 |

**Por qué el cuarto** (O-E10-18). Los tres primeros son «total compañía», y dos
desviaciones grandes de signo contrario **se anulan**: con MC3 de P-01 a
−1 500 000 c y MC3 de P-02 a +1 500 000 c, la desviación total es 0 c y 0 bps, no
dispara nada y el informe se firma **`VALIDADO AUTOMÁTICAMENTE` con dos proyectos
fuera de control**. El coste marginal es nulo: la matriz ya está calculada.

Reglas nuevas de la familia `EV-*`, funciones puras con test, hermanas de las
diez de ADR-0012:

- **EV-11 · dispara siempre**: `budgetHash` distinto del del run anterior del
  mismo periodo. Cambiar de versión de presupuesto **redefine la medida**, no es
  una variación; presentarlo como tal escondería una reproyección detrás de un
  «dentro de umbral».
- **EV-12 · no dispara por variación, pero mueve el sello**: no hay versión
  vigente para el periodo. La columna sale vacía con leyenda y el sello lleva
  `PRESUPUESTO_AUSENTE` como **AVISO** (lección H-4 de E7: un aviso que no mueve
  el sello es decorativo).
- **EV-13 · no dispara**: el periodo comparado contiene meses **no cerrados**. La
  desviación es parcial por construcción y se marca como tal; lo que informa ahí
  es el forecast, que para eso existe.
- ~~**EV-14**~~ · **retirada (O-E10-5)**. Presuponía que un `BORRADOR` puede
  emitir un `ReportRun`, y el esquema lo impide: `budgets_sealed_marks` obliga a
  `budget_hash IS NULL` mientras el estado es `BORRADOR`, y
  `report_runs_budget_hash_required` exige `budget_hash <> '∅'` para este tipo de
  informe — **no hay hash que escribir**. La ambigüedad se cierra por el lado
  correcto: **un borrador nunca produce un `ReportRun`**, y compararse contra él
  es una **previsualización no sellada** (§4.2). `PRESUPUESTO_NO_SELLADO` deja de
  ser motivo de sello y pasa a ser **rechazo** `BUDGET_NOT_SEALED`. Es lo que ya
  decía la propia frase de D5: *«un presupuesto sin sellar no puede firmar un
  informe»*.
- **EV-15 · dispara siempre** (O-E10-2 / O-E10-17): existen minutos **sin
  aprobar** del periodo que alguna regla de actividad habría usado. Motivo
  `HORAS_SIN_APROBAR`, con los minutos y su % sobre la base.
- **EV-16 · dispara siempre** (O-E10-16): alguna regla `HEADCOUNT` reparte a un
  CECO **sin snapshot** en el periodo. Motivo `PLANTILLA_AUSENTE`. Un snapshot con
  `fteMilli = 0` **no** dispara: es un dato.
- **EV-17 · dispara siempre** (§4 de la validación): hay partes **sin tarifa
  vigente** y el informe publica coste-hora o margen por hora. Motivo
  `TARIFA_AUSENTE`. I-E10-5 puede quedarse en `INFO` —no es un error de cuadre—,
  pero un margen por hora calculado con partes sin tarifa **no es un margen**, así
  que el sello sí se mueve.

`SealReasonCode` gana **`DESVIACION_PRESUPUESTO`**, **`PRESUPUESTO_AUSENTE`**,
**`HORAS_SIN_APROBAR`**, **`PLANTILLA_AUSENTE`** y **`TARIFA_AUSENTE`**. Códigos
cerrados: la Auditoría filtra por código, no hace `LIKE`. **Ningún motivo sin
regla que lo emita y ninguna regla sin motivo**: es la comprobación que O-E10-17
exige y que tiene test propio.

---

## 6. Invariantes

`lib/budget/invariants-e10.ts`, mismo contrato que los bloques de E7, E8 y E9:
**nunca un PASS que no se haya comprobado**; lo no evaluable sale `INFO`
diciendo **qué falta**; **tolerancia 0** en todo lo que compara cifras. Se
cablean en `runLedgerInvariants` con un bloque opcional `budget?` / `time?` —una
organización sin presupuesto ni horas no tiene por qué ver FAIL— y en
`scripts/run-invariants.ts`. Entran en la familia **`PRESUPUESTO`** de
`lib/audit/families.ts`, con la regla de E7: **una familia sin evaluar sale
`SIN_EVALUAR`, jamás en verde**.

| Id | Qué garantiza | Tol. |
|---|---|---|
| **I-E10-1** | **Σ líneas = totales por nivel**: para cada nivel, `Σ_c presupuesto[ℓ][c]` construido por `buildBudgetMatrix` = `Σ` de las líneas de la versión que ese nivel recoge; y `Σ` de los doce meses = el anual. Ninguna línea queda fuera de la matriz (`unresolved` vacío) | 0 |
| **I-E10-2** | **Desviación exacta**: `desviación[ℓ][c][m] = real[ℓ][c][m] − presupuesto[ℓ][c][m]`, celda a celda y en todos los agregados. Un redondeo en el porcentaje **nunca** toca el importe | 0 |
| **I-E10-3** | **Σ minutos imputados por regla `HOURS` = base**: para todo run y toda regla de driver `HOURS`, `Σ driverBase` de sus líneas = `Σ minutes` aprobados y productivos de los receptores elegibles **en la ventana efectiva del run** (no en `[periodStart, periodEnd]`: O-E10-1), y `driverBaseTotal` es ese mismo número en todas sus líneas | 0 |
| **I-E10-4** | **`TimeEntry` aprobadas inmutables**: ningún `UPDATE` sobre una fila `APROBADO` fuera de la transición de aprobación, ningún `DELETE`, y toda corrección es un contra-apunte con motivo que cuadra con su original en empleado, fecha, dimensión y signo | — |
| **I-E10-5** | **Coste-hora vigente única por fecha**: para todo empleado y toda fecha, 0 ó 1 `EmployeeRate` vigente. Con 0 y partes ese día, **INFO** nombrando empleado y fecha; nunca se aplica 0 ni la tarifa anterior. **Y mueve el sello** con `TARIFA_AUSENTE` (EV-17) cuando el informe publica coste-hora o margen por hora: un margen por hora calculado con partes sin tarifa **no es un margen**, y dejarlo sólo en `INFO` era quedarse corto | — |
| **I-E10-6** | **Una versión sellada no cambia**: `budgetHash` recomputado sobre lo que la fila y sus líneas tienen hoy = el sellado. Editar una celda por SQL delata la versión por su nombre | — |
| **I-E10-7** | **Forecast sin solape ni hueco**: cada mes del ejercicio aparece exactamente una vez en `ForecastMatrix` y con una sola procedencia; `Σ meses REAL_CERRADO` = real hasta el corte y `Σ meses PRESUPUESTO_ABIERTO` = presupuesto desde el corte | 0 |
| **I-E10-8** | **Unicidad y exclusividad de celda** (O-A6): ninguna versión tiene dos líneas para la misma `(mes, dimensión, cuenta)`; toda línea tiene exactamente una dimensión; la LN denormalizada coincide con la del proyecto | — |
| **I-E10-9** | **Una versión vigente por ejercicio y fecha**: vigencias sin solape entre versiones no `BORRADOR`; toda `REVISADO n` tiene una `BASE` anterior; `revision` correlativa sin huecos | — |
| **I-E10-10** | **Partes bien formados**: exactamente una dimensión, fecha dentro de un ejercicio y fuera de un mes bloqueado, `minutes ≠ 0`, negativos sólo en contra-apuntes, `Σ` contra-apuntes ≤ original en magnitud, y **`Σ minutos por (empleado, fecha) ≤ 1 440`** con los contra-apuntes a su signo (**O-E10-21**: el techo por fila no veía cuatro partes de 1 440 en el mismo día) | — |
| **I-E10-11** | **Base de `HEADCOUNT`**: `fteMilli ≥ 0`; un snapshot por `(CECO, mes)`; y `Σ driverBase` del run = **`Σ fteMilli` de los snapshots de los receptores cuyo fin de mes cae dentro del periodo** (FTE·mes, Q-7). Receptor **sin ningún snapshot** en el periodo: peso 0, aviso y sello `PLANTILLA_AUSENTE` — nunca se confunde «no hay nadie» (snapshot a 0) con «no lo hemos rellenado» | 0 |
| **I-E10-12** | **El personal imputado no excede al contabilizado**: `Σ` coste de personal atribuido a proyectos por horas (caminos a y b) ≤ `Σ −aporte` de las cuentas 64x del periodo. Con exceso, FAIL nombrando el periodo — es el síntoma de una tarifa mal puesta o de horas duplicadas. **Es una guarda, no una medida**: la infraabsorción la publica el informe de O-E10-20, y endurecer esto a igualdad exigiría horas y tarifas perfectas | 0 |
| **I-E10-13** | **Reproducibilidad y aislamiento**: dos ejecuciones con los mismos `(ledgerHash, budgetHash, timeHash, paramsHash, gitSha)` dan `canonicalResultJson` **byte a byte** idéntico; y las siete tablas nuevas devuelven 0 filas y `42501` sin GUC | — |
| **I-E10-14** | **Tipo declarado y coherencia de signo** (O-E10-6 + **O-E10-23**): **toda `BudgetLine` tiene `analyticType`** —ninguna nula, y la evidencia las contaría si las hubiera— y tiene el signo que le corresponde por él —`INGRESO_DIRECTO ≥ 0`; `COSTE_DIRECTO_MC1/MC2`, `INDIRECTO_CECO` y `AMORTIZACION_DETERIORO ≤ 0`— salvo las excepciones declaradas (`61x`/`71x`, `706`/`708`/`709`, `79x`/`759`), que salen **listadas**, no calladas. Sin el tipo obligatorio, la comprobación de signo se saltaba a sí misma | — |
| **I-E10-15** | **Continuidad de vigencias** (O-E10-8): para todo ejercicio con al menos una versión no `BORRADOR`, la unión de sus vigencias cubre `[inicio, fin]` del ejercicio **sin hueco**. Un julio sin versión vigente disparaba `PRESUPUESTO_AUSENTE` teniendo presupuesto | — |
| **I-E10-16** | **Completitud de la versión** (O-E10-9): toda versión no `BORRADOR` cubre los **doce meses** del ejercicio, o declara `partialFrom` y el informe **compone** la procedencia mes a mes. Sin esto, una revisión que sólo trae jul–dic desinfla el año a la mitad en silencio | — |
| **I-E10-17** | **El `timeHash` cubre la ventana consumida** (O-E10-1): para todo run con alguna regla de fallback `YTD`/`PRIOR_PERIOD`, la ventana sellada (`timeHashWindowStart/End`) **contiene** la que el driver usó; y el hash recomputado sobre ella = el sellado | — |
| **I-E10-18** | **Comparabilidad** (O-E10-4): si el informe publica desviación **por dimensión** en niveles ≥ MC3 con `withAllocations = true`, el presupuesto está imputado **con las mismas reglas** (`budgetRulesHash` = `rulesHash` del real); en caso contrario esas celdas salen **no publicadas**, nunca calculadas | 0 |

### 6.1 Invariantes existentes que E10 puede romper

| Invariante | Cómo se rompería | Cómo se impide | Test |
|---|---|---|---|
| **I1, I2, I3, I6** | Si E10 generase asientos | **No genera ninguno**. Ni presupuesto, ni horas, ni imputación de personal tocan `journal_lines`… | `ledgerHash` del periodo idéntico antes y después de sellar un presupuesto, aprobar horas y liquidar con `HOURS` (criterio 14) |
| **I-E3-7** (`entryHash` estable) | …salvo el camino (b) de §3.7, que sí escribe las cuatro columnas analíticas | Es `reclassifyLines` **sin modificar**: recalcula `entryHash` en la misma transacción, con `AuditLog` y motivo (ADR-0010 salvaguarda 2) | El test de ADR-0010, en verde y sin tocar |
| **I4** (Σ matriz = PyG contable) | Si el presupuesto entrase en la matriz del **real** | Son dos matrices distintas que comparten forma y funciones; `buildAnalyticPnl` no recibe ni una celda de presupuesto | `checkI4` sobre el real, idéntico a E5 |
| **I5** (liquidación a 0) | Un driver `HOURS` mal agregado dejaría saldo en el CECO | La base sale de un agregado determinista y el reparto sigue siendo Hamilton entero con tolerancia 0; **I5.a** se comprueba por `(run, fuente, nivel)` como siempre | `liquidacion-esperada.json` **intacto** + el nuevo fixture de horas |
| **I-E5-12** (reproducibilidad del run) | El `timeHash` ausente haría irreproducible un run con `HOURS` | D1 lo añade al run y a la derivación de `STALE` | Criterio 12 |
| **I-E9-\*** | El fixture v2 reversionado podría mover una cifra de cierre | El generador **recalcula** el bloque `expected` y el test byte a byte de E9 corre contra él; si una cifra de cierre cambia, el test lo dice antes de llegar a revisión | T20 + criterio 20 |

---

## 7. UI

`ui-erp`: cada pantalla financiera muestra **periodo, sello y cuadre**, y
drill-down hasta el documento en ≤ 3 clics; acciones destructivas con motivo;
estados vacío / carga / error siempre; importes en formato español y `—` en vez
de `0` cuando no hay dato.

| Ruta | Contenido | VIEWER | EDITOR | ADMIN |
|---|---|---|---|---|
| `/analytics/budget` | **Editor tipo hoja**: filas = cuentas (árbol del plan, colapsable por epígrafe) y dimensiones; columnas = los doce meses + total. Edición celda a celda con guardado por lotes; **todos los totales de fila, de columna y por nivel de margen los compone el servidor** —el cliente no suma ni un céntimo—; **el signo lo valida el servidor al guardar** y la celda avisa en el acto (O-E10-6); pegar desde una hoja de cálculo; **import CSV** con previsualización, informe de rechazos, `dry-run` y **rechazo del fichero entero** con la convención de signo invertida; botón **«Precargar amortización»** que trae la propuesta de `68x` de los activos en alta (Q-4); selector de versión con sus vigencias y su `partialFrom`; botón **Sellar** (ADMIN) que muestra antes el `budgetHash` que va a firmar, el `validTo` que va a poner a la versión anterior y qué informes caducarán | ve | **edita el borrador** | **crea versión, sella, revisa** |
| `/analytics/budget/diff` | **Diff entre dos versiones**, celda a celda y por nivel, con el Δ en euros (verde/rojo). Es lo que un CFO pide para ver **qué cambió la reproyección**, y lo que la doctrina de «sustituir, no corregir» hace posible; el patrón ya existe en `allocation-run-diff.tsx` | ve | ve | ve |
| `/analytics/budget-vs-actual` | La matriz de E4 con las cinco columnas, selector de granularidad (mes / trimestre / año / YTD), toggle «con / sin imputaciones» —**que se bloquea, con el motivo, si el presupuesto no puede seguir al real** (O-E10-4)—, corte del forecast visible y editable, cabecera con los **cinco** sellos (`ledgerHash`, `analyticsHash`, `marginConfigHash`, `allocationRunSetHash`, `budgetHash`) y con la **procedencia del presupuesto mes a mes**. Celdas `notComparable` en blanco con su leyenda, nunca calculadas. Con un `BORRADOR`, banda **«borrador, no firmable»** y **ningún `ReportRun`** (O-E10-5). **Drill-down en ≤ 3 clics**: celda de desviación → desglose real/presupuesto → líneas de diario y de reparto → asiento (y desde ahí, el documento) | ve | ve | ve |
| `/analytics/projects/[code]` | Bloque nuevo de **rentabilidad con horas**: margen por hora (MC2 y MC3), coste-hora medio **con su `basis`**, tarifa media facturada, horas presupuestadas vs reales y su desviación, y la **desviación de absorción** con su desglose por CECO (O-E10-20), con la leyenda de no evaluable donde toque | ve | ve | ve |
| `/time` | **Partes de horas**: vista **calendario** mensual por empleado (celda = `hh:mm` del día, color por proyecto) y vista de lista con filtros; alta rápida con **aviso si el día pasa de 24 h sumando todos los partes** (O-E10-21); **import CSV** idempotente; cola de **aprobación** con selección múltiple; contra-apunte con motivo desde el parte aprobado; banda con `Σ` del mes, **aprobadas vs pendientes y el % que las pendientes representan sobre la base**, y el aviso de que ninguna regla las usará | ve | **captura y aprueba** (no las suyas) | aprueba todo |
| `/settings/employees` | Empleados (código, nombre, FTE, CECO por defecto, enlace a `Counterparty` y a usuario) y **tarifas** con su historial de vigencias y su `basis`; botón **«Derivar de la nómina»** que muestra la propuesta **con sus términos** (ámbito CECO o empleado, periodo, cuentas —`641` fuera y dicho—, importe, minutos productivos, **cobertura** y fórmula) y **no la aplica**: la aplica un ADMIN, con `AuditLog`. Aviso bloqueante al elegir `COSTE_TOTAL_CON_ESTRUCTURA` con reglas de actividad vigentes | ve | ve | **edita y fija tarifas** |
| `/settings/headcount` | Plantilla por CECO y mes, con «derivar de empleados» y edición manual. Distingue en pantalla **«0 declarado»** de **«sin rellenar»**, que es lo que separa un dato de un hueco | ve | **registra** | sella |
| `/analytics/allocations` | El formulario de reglas **recupera `HORAS` y `PLANTILLA`** en el selector de driver, con la nota de qué base usan y el enlace a darla de alta si falta; `PLANTILLA` sólo se ofrece con `targetKind = COST_CENTERS`. La simulación pinta los avisos `W-E10-*`, incluidos el de **horas sin aprobar con base parcial** y el de **saldo atrapado**. El grafo de cascada y el resto, sin cambios | ve | ve | **crea reglas** |
| `/settings/assets` | **Deuda §0-bis #7**: el formulario de alta gana el selector de destino analítico (proyecto xor CECO), con el aviso de `analyticsRequired` | ve | edita | edita |
| `/audit` | Familia **`PRESUPUESTO`** con I-E10-1…18 y su evidencia | ve | ve | ve |

**Cinco avisos de método impresos en pantalla**, no en la documentación:
(a) *el presupuesto es una decisión, no un cálculo*: una desviación mide el plan
tanto como la ejecución; (b) *un coste-hora «con SS» y otro «sin SS» no son
comparables* (~31,9 % de diferencia): la base viaja en la tarifa y se muestra
siempre junto a la cifra; (c) *las horas no aprobadas no reparten dinero y no
aparecen en ningún margen*, con el recuento y su peso a la vista; (d) *la tarifa
ya absorbe las horas no productivas*, así que ese coste no se reparte otra vez
(modelo A, Q-3); (e) *presupuesto y real se comparan en el mismo estado de
imputación*, y cuando no puede ser, la celda se deja en blanco.

---

## 8. Trazabilidad

| Qué | Dónde |
|---|---|
| Versión de presupuesto usada por un informe | `ReportRun.budgetHash` + `params.budgetId`; la cabecera enseña `2026-REV1` y su vigencia |
| Quién presupuestó qué y cuándo | `BudgetLine.source` y `createdAt`; `AuditLog` de `SEAL_BUDGET` con `budgetHash` antes/después y el nº de líneas |
| Por qué una celda vale lo que vale | Provenance de **tres** consultas (§5.1): diario, reparto y presupuesto, cada una con su importe |
| Estado del mundo al liquidar con horas | `AllocationRun`: `ledgerHash` + `analyticsHash` (dimensiones) + `rulesHash` + **`timeHash` con su ventana `[timeHashWindowStart, timeHashWindowEnd]`** + `gitSha` |
| Estado del presupuesto en un informe | `ReportRun.budgetHash` + `params.budgetComposition` (qué versión aporta cada mes) + `params.budgetRulesHash` (con qué reglas se imputó el presupuesto) |
| Base del driver de cada celda de reparto | `driverBase`, `driverBaseTotal`, `driverShareBps` en la propia `AllocationLine`: la celda es auditable **sin recomputar** |
| Quién aprobó un parte | `TimeEntry.approvedById` / `approvedAt`; el contra-apunte lleva `correctsEntryId` y `correctionReason` |
| De dónde sale un coste-hora | `EmployeeRate.source` + `derivation` (periodo, prefijos de cuenta, importe de nómina, horas productivas y fórmula) + `AuditLog` de `SET_RATE` |
| Import CSV | `importKey = sha256(fichero ‖ nº de línea)` en cada parte; `AuditLog` de `IMPORT_TIME` / `IMPORT_BUDGET` con el sha del fichero, filas aceptadas y rechazadas |
| Camino al documento | celda de desviación → línea de presupuesto **o** línea de diario → asiento → `File`/`ExtractionRun`. **Tres clics** con la fila de detalle desplegada |
| Caducidad de informes | `budgetHash` dentro de la clave de caché de `PRESUPUESTO_REAL`, y **sólo** de ése |

---

## 9. Rendimiento

**Nueve** techos, medidos en `tests/integration/perf-budget.test.ts` sobre el fixture
`ejercicio-completo-v2` reversionado (dos ejercicios, 40 empleados, un año de
partes, presupuesto completo), con las dos métricas de E6-perf: **ms** y
**conexiones simultáneas por petición**.

| Cargador / operación | Techo |
|---|---|
| `/analytics/budget` con 12 meses × 120 cuentas × 20 dimensiones (**28 800 celdas**) | **< 900 ms** · 1 transacción · ≤ 2 conexiones — **exige** el índice `(organization_id, budget_id, month)` y los totales por agregado SQL |
| Guardado por lotes de 500 celdas | **< 300 ms** (`createMany` + `updateMany`, nunca 500 `upsert`) |
| Import CSV de **30 000** líneas de presupuesto | **< 20 s** en lotes de 5 000, con progreso; ninguna transacción > 15 s |
| `/analytics/budget-vs-actual` anual **con imputaciones** | **< 1 500 ms** — el real imputado ya cuesta < 800 ms desde E5 y **O-E10-4 añade la liquidación presupuestaria en dry-run** (otro `allocate()` completo sobre el presupuesto). Sin ella el techo sería 1 200 ms, y sin ella la cifra sería falsa |
| `settleBudgetMatrix` de un ejercicio (17 periodos, 6 reglas) | **< 350 ms** — es `allocate()` puro sobre celdas ya leídas: sin IO |
| `/time` de un mes con **40 empleados × 22 días** (880 partes) | **< 400 ms** — índices parciales `WHERE status = 'APROBADO' AND productive` |
| Agregado de horas del **ejercicio completo** (120 000 partes) | **< 600 ms**, agregado SQL por `(receptor, mes)`; jamás materializando los partes |
| Liquidación anual con reglas `HOURS` (17 runs) | **< 500 ms** (E5 medía < 400 ms sin horas; el margen es el agregado de horas) |
| **`allocationRunStalenessBatch`** con 17 runs | **3 consultas** y **< 250 ms**, frente a las ~17 de hoy — es la deuda §0-bis #6, y el test **cuenta las consultas**, no sólo los ms |
| **Nueve** techos en total (uno más que la ronda 0) | Todos en `tests/integration/perf-budget.test.ts` |

Agregados en SQL, **nunca** materializar el diario ni los partes para una cifra;
lecturas **en serie** dentro de la transacción; una transacción por petición
(`tenantPage`), con `readOnly: false` sólo donde el render emite un `ReportRun`.

---

## 10. Seguridad y roles

Además de la matriz de §4.2:

- **RLS**: las **siete** tablas nuevas en `TENANT_MODELS` y con
  `app.enforce_tenant_rls`. `budgets` **semi-append-only** con `GRANT UPDATE` de
  columna; `time_entries` semi-append-only (sólo las tres columnas de
  aprobación) y con el trigger que protege lo aprobado; `employee_rates` y
  `headcount_snapshots` **append-only puras**. `test:integration:rls` tabla por
  tabla: sin GUC, **0 filas** y **42501** al escribir.
- **Sin escapes**: ninguna consulta de negocio fuera de `tenantDb` /
  `tenantTransaction` (ESLint `no-restricted-imports` + `no-restricted-syntax` y
  la suite RLS).
- **Datos de personas.** `Employee` y `TimeEntry` son datos de empleados: un
  `VIEWER` ve el agregado, y el detalle nominal por empleado exige `EDITOR`. La
  tarifa individual (`EmployeeRate.hourlyCostCents`) **sólo la ve `ADMIN`** —el
  coste-hora de una persona es su salario dividido por sus horas—; el resto ve el
  coste-hora **medio del receptor**, que es la cifra de gestión. Es una decisión
  de producto, y se declara en pantalla.
- **Import CSV**: mismo endurecimiento que las subidas de E1 (mimetype, tamaño) y
  parseo **en servidor**; ninguna fila se acepta a medias.
- El presupuesto **no se borra nunca**: una versión sellada se sustituye.

---

## 11. Decisiones de Nivel 2 → ADR-0018 (**APROBADO** 2026-09-14, D1–D6)

`docs/adr/0018-presupuesto-horas-y-drivers-de-actividad.md`, **APROBADO por Pablo
el 2026-09-14** (permiso general delegado de 2026-09-04), **seis** decisiones tras
la ronda 1. Las tareas de Nivel 2 quedan **desbloqueadas**.

| # | Decisión | Por qué es Nivel 2 |
|---|---|---|
| **D1** | **Drivers `HOURS` y `HEADCOUNT` y su base.** `HOURS` = Σ **minutos** aprobados y productivos del receptor **en la ventana efectiva del run**, contra-apuntes con su signo. `HEADCOUNT` = **Σ `fteMilli` de los snapshots del periodo (FTE·mes)**, y **sólo con `targetKind = COST_CENTERS`**. Hamilton, cascada, E5-D1 y determinismo **intactos**. `AllocationRun` gana **`timeHash` con su ventana persistida**, y `STALE` su cuarta causa. ADR-0013 D4 se cumple con la validación al guardar, al sellar **y con base parcial** | Cambia el esquema del motor de liquidación y la definición de un invariante (I5 con una base nueva) |
| **D2** | **Presupuesto versionado y sellado.** `(ejercicio, escenario, revisión)` con vigencia **sin solape ni hueco** y `partialFrom`; `budgetHash` sobre la forma canónica de sus líneas —**con el `marginLevel` congelado en cada una**— más `marginConfigHash`; inmutable al sellar; `amountCents` es el **aporte** y **su signo lo fuerza el tipo analítico**; O-A6 cerrada con cuatro índices únicos parciales y el CHECK de exclusividad | Crea la tabla que O-A6 lleva abierta desde E4 y fija la convención de signo de todas las desviaciones |
| **D3** | **Coste-hora y su derivación.** `EmployeeRate` con vigencias `EXCLUDE`, en céntimos por hora, con **`basis` explícita**; default `COSTE_EMPRESA_CON_SS` = `640`+`642`+`645`+`649`, **`641` fuera**; `COSTE_TOTAL_CON_ESTRUCTURA` **excluyente** con reglas de actividad. **Modelo A de absorción plena**: la tarifa absorbe las horas no productivas y su coste no se reparte otra vez. Derivación **por CECO** por defecto, individual sólo con cobertura declarada, y siempre como **propuesta con sus términos**. Sin tarifa vigente: **no evaluable**, jamás 0, y mueve el sello | Introduce una cifra que mueve el margen de todos los proyectos y que no sale del diario |
| **D4** | **El forecast es una vista derivada, no una tabla; y presupuesto y real se comparan en el mismo estado de imputación.** `forecast(m) = real(m)` hasta el corte y `presupuesto(m)` después, con el corte en `paramsHash` e I-E10-7. Y **liquidación presupuestaria en dry-run puro** con las mismas reglas y las horas presupuestadas; sin ella, las celdas ≥ MC3 por dimensión **no se publican** (I-E10-18) | Es ADR-0003 aplicado a una cifra que muchos ERP almacenan, y es el bloqueante de fondo del informe |
| **D5** | **Umbrales de desviación.** **Cuatro** KPI nuevos —incluido `desviacionMaxDimension`, que impide que dos desviaciones de signo contrario se anulen— con la conjunción `pctBps` **y** `minAbsCents`; reglas `EV-11…EV-13` y `EV-15…EV-17`; **`EV-14` retirada** porque un `BORRADOR` no puede emitir un `ReportRun`; cinco motivos de sello de código cerrado, **ninguno sin regla que lo emita** | Cambia cuándo un informe se firma `VALIDADO AUTOMATICAMENTE`, que es la definición del sello |
| **D6** ✚ | **Contrato de cifras congelado antes de T10** (§6 de la validación): unidad **minutos**, coste de un parte `⌊mᵢrᵢ/60⌋` con **Hamilton definido**, base de `HOURS` sobre la ventana efectiva, base de `HEADCOUNT` en FTE·mes, forma canónica del `timeHash` **sin `id`**, `basis` y prefijos por defecto, signo del presupuesto, y la **convención volumen/precio** (cruce al precio, precio como residuo) que E11 implementará | Cada uno de estos siete puntos cuesta un reversionado del fixture sellado si se decide después |

---

## 12. Criterios de aceptación (Given / When / Then)

1. **O-A6 cerrada.** *Given* una versión de presupuesto con una línea
   `(2026-03, P-01, cuenta NULL, INGRESO_DIRECTO)`, *when* se inserta otra
   idéntica, *then* la base la rechaza con **`23505`**; ídem con
   `(2026-03, CC-GA, 6400)`. *And* `INSERT` con proyecto **y** CECO, o con
   ninguno, falla con `23514`. **Los cuatro índices parciales y el CHECK tienen
   test propio**: es la deuda abierta desde E4.
2. **Matriz de presupuesto = suma de sus líneas.** *Given* el presupuesto del
   fixture, *then* `Σ_c presupuesto[ℓ][c] = Σ` líneas del nivel para los ocho
   niveles y los doce meses, `unresolved` está vacío y **I-E10-1** en PASS.
3. **Desviación exacta.** *Then* para las 8 × 12 × N celdas,
   `desviación = real − presupuesto` al céntimo, y el anual es la suma de los
   doce meses. Un porcentaje redondeado **no mueve ni un céntimo** del importe.
4. **Sin presupuesto no hay cero.** *Given* un proyecto sin líneas
   presupuestadas, *then* presupuesto, desviación y % salen **vacíos con
   leyenda** en pantalla, CSV, XLSX y PDF; el sello lleva `PRESUPUESTO_AUSENTE`
   y el informe pasa a `REQUIERE REVISIÓN`.
4-bis. **Toda celda declara su tipo** (O-E10-23). *When* se intenta guardar una
   línea de presupuesto **sin `analyticType`** —con cuenta o sin ella—, *then* la
   acción la rechaza y, saltándose la acción, el CHECK
   `budget_lines_type_required` lanza `23514`. *And* el mismo caso, forzado por
   SQL como propietario sobre una versión en borrador, **I-E10-14 lo cuenta y lo
   nombra**: sin esta exigencia, el CHECK de signo de O-E10-6 tenía una rama
   (`analytic_type IS NULL`) por la que **no comprobaba nada** y un gasto en
   positivo volvía a entrar.
5. **Sello e inmutabilidad del presupuesto.** *When* se sella `2026-BASE`, *then*
   `budgetHash` y `marginConfigHash` quedan escritos y `status = VIGENTE`.
   *When* se intenta editar una celda suya, *then* la acción responde
   `BUDGET_SEALED` y, saltándose la acción, el trigger lanza `23514`. *When* se
   altera una celda por SQL como propietario, *then* **I-E10-6 da FAIL**
   nombrando la versión.
6. **Versiones, vigencias y continuidad.** *Given* `2026-BASE` vigente desde el
   01-01, *when* se sella `2026-REV1` con `validFrom = 01-07`, *then* **la misma
   transacción** deja la `BASE` con `validTo = 30-06` (O-E10-8), las dos
   coexisten, un informe de mayo usa la `BASE` y uno de agosto la `REV1`, y
   **I-E10-15** en PASS. *When* se intenta sellar una tercera con vigencia
   solapada, *then* `EXCLUDE` lo rechaza (`23P01`). *When* se fuerza por SQL un
   hueco en julio, *then* **I-E10-15 da FAIL** nombrando el mes — antes salía
   `PRESUPUESTO_AUSENTE` teniendo presupuesto.
6-bis. **Versión parcial.** *Given* una `REVISADO 1` con `partialFrom = 01-07`
   que sólo trae jul–dic, *then* el informe anual **compone** BASE(ene–jun) +
   REV1(jul–dic), la cabecera dice de qué versión sale cada mes, el total anual
   es el correcto y **I-E10-16** en PASS. *Given* la misma versión **sin**
   declarar `partialFrom`, *then* **I-E10-16 da FAIL**: en la ronda 0 el año se
   quedaba a la mitad en silencio.
7. **Forecast.** *Given* meses cerrados hasta abril, *then* el forecast usa real
   de enero a abril y presupuesto de mayo a diciembre, `provenanceByMonth` lo
   dice mes a mes, **I-E10-7** en PASS, y `Σ forecast = Σ real(ene-abr) + Σ
   ppto(may-dic)` al céntimo. *Given* ningún mes cerrado, *then* forecast =
   presupuesto entero, sin excepción ni error.
8. **Horas: alta, aprobación e inmutabilidad.** *When* un EDITOR aprueba un parte
   y después intenta cambiarle las horas, *then* `42501`/`23514` y la fila
   intacta. *When* lo corrige con un contra-apunte de −250 con motivo de 9
   caracteres, *then* se rechaza; con 10 o más, se crea la entrada negativa, el
   neto del día baja y **el original sigue ahí**.
9. **Segregación en la aprobación.** *Given* un EDITOR cuyo usuario está enlazado
   a un `Employee`, *when* intenta aprobar sus propios partes, *then* se rechaza
   nombrando la regla; un ADMIN sí puede.
10. **Import CSV idempotente.** *When* se importa dos veces el mismo fichero de
    partes, *then* la segunda vez se insertan **0 filas** (índice único por
    `importKey`) y el informe dice cuántas se omitieron y por qué.
11. **Driver `HOURS`.** *Given* `CC-OPS` con saldo MC3 y partes aprobados
    P-01 19 200 / P-02 10 800 / P-03 6 000 **minutos**, *when* se liquida, *then*
    el reparto es el del fixture sellado **byte a byte**, `marginLevel = MC3` en
    las tres líneas, `driverBaseTotal = 36 000` en todas, la columna de `CC-OPS`
    queda a **0** (I5.b) y **I-E10-3** en PASS.
12. **Cuarto sello, con su ventana.** *When* se aprueba un parte de un periodo
    **ya liquidado**, *then* el run aparece como **caducado** con el motivo «los
    partes de horas del periodo han cambiado»; *when* se resimula y se sella,
    *then* nace un run nuevo y el anterior pasa a `SUPERSEDED`.
12-bis. **La ventana del `timeHash`** (O-E10-1). *Given* un run de **marzo** con
    una regla de `zeroBaseFallback = YTD`, *when* en mayo se aprueba un parte de
    **enero** de 800 minutos, *then* el run de marzo aparece **`STALE`** —en la
    ronda 0 no lo hacía— porque su `timeHash` se selló sobre
    `[01-01, 31-03]`, y **I-E10-17** en PASS. *Given* un run sin reglas de
    actividad, *then* `timeHash = '∅'` y la ventana `NULL`.
13. **Horas sin aprobar, también con base parcial** (O-E10-2). *Given* base
    aprobada P-01 19 200 / P-02 10 800 / P-03 6 000 y **12 000 minutos de P-03
    sin aprobar**, *when* se simula una regla `HOURS` de 900 000 c, *then* el
    reparto sale 480 000 / 270 000 / 150 000 **y se emite
    `W-E10-UNAPPROVED-HOURS`** con los 12 000 minutos y su % sobre la base, el
    run se sella con motivo `HORAS_SIN_APROBAR` y el informe pasa a `REQUIERE
    REVISIÓN` (EV-15). En la ronda 0 el aviso sólo aparecía con base 0, y los
    **187 500 c** que P-03 dejaba de absorber se publicaban en silencio.
13-bis. **Sin ninguna hora aprobada.** *Given* 40 000 minutos sin aprobar y
    ninguno aprobado, *then* además la regla cae en su `zeroBaseFallback` y con
    `SKIP_WARN` el saldo del CECO queda **visible** en «pendiente de liquidar».
    **En ningún camino la regla queda muda.**
14. **Nada toca el diario.** *When* se sella un presupuesto, se aprueban 1 000
    partes y se liquida con `HOURS`, *then* el `ledgerHash` y el `entryHash` de
    todos los asientos del periodo son **idénticos** al céntimo y al byte, y
    I1/I2/I3/I6 siguen en PASS.
15. **Reclasificación de personal (camino b).** *Given* una línea `640` de 300 000
    c en `CC-OPS` con el 100 % de las horas del empleado en P-01, *when* se aplica
    la propuesta con motivo, *then* la línea pasa a `projectId = P-01` con tipo
    efectivo `COSTE_DIRECTO_MC2` (R-A3), el MC2 de P-01 baja 300 000 c, el MC3 de
    la compañía **no cambia**, `ledgerHash` es el mismo, `entryHash` se recalcula
    y hay `AuditLog`. *Given* una línea repartida 60/40 entre dos proyectos,
    *then* la propuesta la declara **no atribuible** y remite al camino (a): no
    se parte ninguna línea.
16. **`HEADCOUNT` mensual.** *Given* una regla `HEADCOUNT` de `CC-GA` a tres
    CECOs con snapshots 3 000 / 2 000 / 1 000 `fteMilli` a 31-03, *then* el
    reparto es exacto por Hamilton y **I-E10-11** en PASS — un run mensual tiene
    **un solo snapshot** por receptor, así que la base FTE·mes coincide con el
    stock y el fixture no se mueve. *When* se intenta guardar una regla
    `HEADCOUNT` con `targetKind = PROJECTS`, *then* la acción la rechaza y el
    CHECK de M4 también (`23514`).
16-bis. **`HEADCOUNT` anual, FTE·mes** (Q-7). *Given* `CC-SOP`, que nace el
    01-02 y se cierra el 30-11 con 3 000 `fteMilli`, *when* se liquida un run
    **anual**, *then* su peso es **30 000** (10 meses × 3 000) y absorbe la parte
    proporcional a su presencia real; con el stock a 31-12 su peso era **0** y los
    diez meses de estructura se trasladaban a los demás CECOs.
16-ter. **Plantilla ausente y cero declarado.** *Given* un receptor **sin
    snapshot** en el periodo, *then* peso 0, `W-E10-NO-HEADCOUNT` nombrándolo y
    motivo de sello **`PLANTILLA_AUSENTE`** (EV-16). *Given* un snapshot con
    `fteMilli = 0`, *then* peso 0 **y ningún motivo**: es un dato, no un hueco.
16-quater. **Saldo atrapado.** *Given* una regla `HEADCOUNT` que reparte a un
    CECO **sin regla vigente propia** hacia proyectos, *then* se emite
    `W-E10-HEADCOUNT-TRAPPED` al simular, antes de que I5.b lo denuncie sin decir
    por qué.
17. **Caducidad de informes, y sólo del de presupuesto.** *When* se sella una
    versión nueva de presupuesto, *then* el `PRESUPUESTO_REAL` del periodo **no**
    se sirve de caché y se emite otro; el `BALANCE`, la `PYG`, el `CASHFLOW`, el
    `DIARIO` y la `PYG_ANALITICA` del mismo periodo **conservan su caché**, porque
    ni `ledgerHash` ni `analyticsKey` han cambiado.
18. **Umbrales.** *Given* `desviacionEbitda` a 1500 bps / 300 000 c y una
    desviación de 1800 bps y 250 000 c, *then* **no** dispara (falla el absoluto);
    con 1800 bps y 400 000 c, *then* dispara con motivo `DESVIACION_PRESUPUESTO`
    y el sello pasa a `REQUIERE REVISIÓN`.
18-bis. **Compensación entre dimensiones** (O-E10-18). *Given* MC3 de P-01
    a −1 500 000 c y MC3 de P-02 a +1 500 000 c, *then* los tres umbrales de
    total compañía dan **0 c y 0 bps** y no disparan, pero
    **`desviacionMaxDimension` sí**: el informe pasa a `REQUIERE REVISIÓN`
    nombrando las dos dimensiones. En la ronda 0 se firmaba en verde con dos
    proyectos fuera de control.
18-ter. **Un borrador no firma** (O-E10-5). *When* se pide un `PRESUPUESTO_REAL`
    contra una versión en `BORRADOR`, *then* la acción responde
    `BUDGET_NOT_SEALED` y **no se crea ninguna fila en `report_runs`**; la
    previsualización sí se pinta, con banda «borrador, no firmable». *And* no
    existe ningún camino que intente escribir un run con `budget_hash = '∅'`
    (el CHECK de M5 lo haría imposible, y ahora nadie lo intenta).
19. **Coste-hora.** *Given* dos tarifas del mismo empleado con vigencias
    solapadas, *then* `23P01`. *Given* un parte sin tarifa vigente ese día,
    *then* el coste del receptor sale **no evaluable** nombrando empleado y
    fecha, **I-E10-5 en INFO** y motivo de sello **`TARIFA_AUSENTE`** (EV-17), y
    no se aplica 0. *Given* nómina `640`+`642` de 5 276 000 c y **90 000 minutos**
    productivos, *then* la propuesta derivada es **3 517 c/hora** con sus términos
    en `derivation`, y **no se aplica** hasta que un ADMIN la confirma. *Given*
    la misma nómina con `BRUTO_SIN_SS` (`640` = 4 000 000 c), *then* **2 666
    c/hora**: la diferencia de **851 c/h (+31,9 %)** aparece en pantalla junto a
    la `basis` de cada cifra.
19-bis. **`641` fuera y estructura excluyente.** *Then* el prefijo `641` no entra
    en ninguna `basis` por defecto, y la ficha de la tarifa lo dice. *When* se
    intenta fijar `COSTE_TOTAL_CON_ESTRUCTURA` con una regla de actividad
    vigente, *then* `RATE_BASIS_CONFLICT` (O-E10-14): las dos juntas cargarían la
    estructura dos veces.
19-ter. **Derivación con cobertura** (O-E10-12). *Given* `scope = "EMPLOYEE"` y
    líneas `64x` con `counterpartyId` en 8 de 34 (78 % del importe), *then* la
    propuesta **declara la cobertura**; por debajo de
    `derivationMinCoverageBps`, sale **no evaluable** (`COVERAGE_TOO_LOW`) y no
    extrapola. *Given* `scope = "COST_CENTER"`, *then* la tarifa media del CECO se
    propone sin exigir `counterpartyId`.
19-quater. **Hamilton del coste** (O-E10-13). *Given* dos partes del mismo
    receptor cuyos costes truncados suman **un céntimo menos** que
    `T = ⌊Σ mᵢrᵢ / 60⌋`, *then* el céntimo va al de **mayor resto** y, en empate,
    al de menor `(fecha, código de empleado, id)`; `Σ coste por parte = T`
    exacto, en dos ejecuciones iguales.
19-quinquies. **Absorción** (O-E10-20). *Given* horas valoradas por 5 275 500 c
    y nómina contabilizada de 5 276 000 c, *then* el informe publica una
    **infraabsorción de −500 c** con su % y su desglose por CECO, **I-E10-12 en
    PASS** (no se ha pasado) y ningún FAIL: es información de gestión.
19-sexies. **Modelo A, sin doble cómputo** (Q-3). *Given* 1 800 h pagadas y
    1 500 productivas, *then* las productivas valoradas a la tarifa suman ≈ la
    nómina entera y **el coste de las 300 no productivas no se reparte por
    segunda vez**; el reparto lo hace la regla `HOURS` sobre el **saldo real del
    CECO**. Con el doble cómputo, I-E10-12 daría **FAIL todos los meses** con un
    exceso del 20 %.
20. **Fixture v2 reversionado.** *When* se ejecuta
    `build_ejercicio_completo_v2.py --check`, *then* reproduce
    `tests/fixtures/ejercicio-completo-v2.json` **byte a byte**; *when* se carga
    con `load-fixture.ts`, *then* **los 225 asientos entran** (hoy muere en el
    primero), ninguna línea postea contra `4751`, y los invariantes de E9 sobre él
    salen en PASS.
21. **Staleness en lote.** *Given* 17 runs sellados, *when* se carga
    `/analytics/allocations/runs`, *then* se ejecutan **3** consultas para
    derivar la staleness (contadas en el test, no estimadas) y el render está por
    debajo de **250 ms**; y el `ledgerHash` que calcula el SQL agregado coincide
    **fila a fila** con el de `lib/ledger/hash.ts`.
22. **Activos con destino analítico.** *Given* una organización con
    `analyticsRequired = true`, *when* se da de alta un inmovilizado **por
    pantalla** eligiendo proyecto, *then* la amortización y la venta se
    contabilizan sin tocar SQL (hoy es imposible: deuda §0-bis #7).
23. **Enums retirados.** *Then* `target_kind` tiene tres valores y
    `allocation_run_status` tres; la migración **aborta** si alguna fila usaba
    `MIXED` o `DRAFT`, con un mensaje que dice cuántas.
24. **Aislamiento.** `tests/integration-rls/e10-tenant.test.ts`: sin GUC, las
    siete tablas devuelven **0 filas** y rechazan el `INSERT` con **42501**;
    ninguna queda en `NO FORCE`.
25. **UX.** Desde una celda de desviación de MC3 de P-01 se llega al documento
    origen del gasto en **3 clics**, y la pantalla dice en todo momento periodo,
    los cinco sellos, el cuadre y qué parte del presupuesto no tiene contrapartida
    real.
26. **Rendimiento y pureza.** Los **nueve** techos de §9 se cumplen con volumen
    real; el guard no encuentra `Date.now()` ni IO en `lib/budget/**` ni en
    `lib/time/**`.
27. **Comparabilidad presupuesto ↔ real** (O-E10-4, el bloqueante de fondo).
    *Given* `CC-OPS` presupuestado en 900 000 c y ejecutado en 900 000 c exactos,
    con las horas exactamente previstas, *when* se pide el informe con
    `withAllocations = true`, *then* el presupuesto pasa por
    `settleBudgetMatrix()` con las mismas reglas y las **horas presupuestadas**,
    P-01 recibe los mismos 400 000 c en las dos matrices y **la desviación de MC3
    de P-01 es 0 c**. En la ronda 0 era **−400 000 c con ejecución perfecta**, y
    el total compañía cuadraba.
27-bis. **Cuando el presupuesto no puede seguir.** *Given* una regla `HOURS` sin
    horas presupuestadas, *then* `settleBudgetMatrix` devuelve
    `BUDGET_NOT_SETTLEABLE`, las celdas **por dimensión** de MC3, EBITDA, EBIT,
    BAI y RESULTADO salen **no publicadas** con su leyenda, las de INGRESOS, MC1
    y MC2 **sí** se publican, el **total compañía** también, el toggle se bloquea
    con el motivo y **I-E10-18** en PASS. En ningún caso se produce una matriz
    mixta.
28. **Signo del presupuesto** (O-E10-6). *When* se teclea `6400` de marzo en
    P-01 con `+1 200 000`, *then* la acción responde `BUDGET_SIGN` diciendo el
    signo correcto y, saltándose la acción, el CHECK
    `budget_lines_sign_by_type` lo rechaza con `23514`. *Given* una línea `7080`
    (devolución de ventas) en negativo con `signException = true`, *then* se
    admite y **I-E10-14 la lista** en su evidencia. *When* se importa un CSV con
    el **95 %** de las líneas de grupo 6 en positivo, *then* **el fichero entero
    se rechaza** con el diagnóstico, sin insertar una sola fila.
29. **Minutos, no centésimas** (Q-2). *Given* un fichaje de **7 h 20 min**,
    *then* se almacena `440` exacto y se presenta `7:20`; el techo por fila es
    ±1 440 (`23514` fuera de rango) y el coste es `⌊440 × r / 60⌋`. *And* el
    denominador de respaldo por defecto es **90 000 minutos** (1 500 h), no
    102 000 (O-E10-19).
30. **Techo diario agregado** (O-E10-21). *Given* cuatro partes de 1 440 minutos
    del mismo empleado y el mismo día —cada uno legal por separado—, *then*
    **I-E10-10 da FAIL** nombrando empleado y fecha, y la acción de alta avisa al
    insertar el segundo.
31. **Presupuesto de amortización** (Q-4). *Given* un activo de 3 000 000 c,
    lineal a 5 años, alta en abril, *when* se pulsa «Precargar amortización»,
    *then* la propuesta trae **450 000 c** repartidos en 50 000 c/mes de abril a
    diciembre, con su dimensión analítica y sus términos (`assetId`, base,
    método, vida útil restante), y **no escribe nada** hasta que el usuario la
    acepta. *And* ninguna línea de grupo 2 entra en `budget_lines` (`23514`).
32. **Proyecto contenedor** (Q-5). *Given* una LN con `P-<LN>-NUEVOS` sembrado en
    `PLANNED`, *then* admite presupuesto, **queda excluido del reparto de
    estructura** (`targetFilter` por defecto `projectStatus: [ACTIVE]`), y el
    traspaso posterior de su importe a los proyectos reales es una **`REVISADO n`
    fechada** cuyo diff enseña exactamente qué se movió de pipeline a cartera.
33. **Un motivo, una regla** (O-E10-17). *Then* el test recorre
    `SealReasonCode` y comprueba que **cada** motivo de E10 tiene al menos una
    regla `EV-*` que lo emite, y que **cada** regla emite un motivo del código
    cerrado. Ningún motivo decorativo.

---

## 13. Plan de tareas

| # | Tarea | Depende de | Agente | Nivel | h |
|---|---|---|---|---|---:|
| **T1** | ~~Validación de control de gestión~~ · **HECHA**: `docs/design/E10-validacion-controlling.md`, **CONFORME CON OBSERVACIONES** con cinco bloqueantes, O-E10-0…22, Q-1…Q-7 resueltas, I-E10-14…18 y el contrato de cifras de su §6 | — | experto-contable | 2 | 16 |
| **T2** | ~~ADR-0018 a firma humana~~ · **HECHA**: **APROBADO** el 2026-09-14 (permiso delegado de 2026-09-04), **D1–D6**, con las veintitrés observaciones incorporadas y **D6** (contrato de cifras congelado) nueva. Desbloquea T4, T7, T8, T9, T10, T11 y T13 | T1 | arquitecto | 2 | 10 |
| **T3** ▶ | Prisma: siete modelos, **ocho** enums, `BudgetLine.marginLevel`/`signException`, `Budget.partialFrom`, `AllocationRun.timeHash` **+ ventana**, `ReportRun.budgetHash`, las **cinco** columnas de `Organization`, relaciones inversas (incluidas las tres de `BudgetHoursLine`); `TENANT_MODELS`; **`lib/budget/**` y `lib/time/**` en el guard de pureza, ESLint y CI** | — | dev-backend | 2 | 12 |
| **T4** | Migraciones **M1…M6** de §2.3: enums solos; tablas con FK compuesta y `enforce_tenant_rls`; **los cuatro índices parciales y el CHECK de O-A6**; el **CHECK de signo por tipo analítico** (O-E10-6); `budget_hours_lines` con sus tres FK, su CHECK de día 1 y sus **cuatro** índices parciales (O-E10-10); `EXCLUDE` de vigencias (presupuesto y tarifas); los **once** triggers, incluido el de `marginLevel` (O-E10-7); append-only y `GRANT` de columna; `time_hash` **+ ventana**; `headcount` en FTE·mes; clave de caché de `report_runs`; retirada de `MIXED`/`DRAFT` con guardia; siembra de `P-<LN>-NUEVOS` (Q-5). Tests de integración del SQL | T2, T3 | dev-backend | 2 | 40 |
| **T5** ▶ | `lib/time/aggregate.ts` (`minutesByTarget`, `minutesByEmployee`, **`unapprovedMinutesByTarget`**, `canonicalTimeForm` **sin `id`**, `timeHash`, **`timeWindowOf`**) + tests de determinismo, contra-apuntes y ventana efectiva | T3 | dev-backend | 2 | 16 |
| **T6** ▶ | `lib/time/cost.ts`: `costOfTime` con el **Hamilton definido** (O-E10-13), `deriveHourlyCost` con **ámbito CECO/empleado y cobertura** (O-E10-12), `absorptionVariance` (O-E10-20) + tests, incluidos los cuatro casos no evaluables y el conflicto de `basis` | T3 | dev-backend | 2 | 18 |
| **T7** | `lib/budget/{types,hash,matrix}.ts`: forma canónica **con `marginLevel`**, `budgetHash`, `composeBudget` (O-E10-9), `checkBudgetSign` + `detectInvertedSignConvention` (O-E10-6) y `buildBudgetMatrix` **reutilizando** `resolveLevel`/`resolveColumn` de `lib/analytics/margins.ts` | T2, T3 | dev-backend | 2 | 24 |
| **T8** | `lib/budget/{variance,forecast}.ts` con `notComparable` + **`settleBudgetMatrix`** (liquidación presupuestaria en dry-run puro, O-E10-4) + `lib/time/payroll-reclass.ts` (`proposePayrollReclass`, **100 % fijo**, O-E10-22) | T2, T7, T9 | dev-backend | 2 | 30 |
| **T9** | **Drivers en `lib/analytics/allocate.ts`**: `timeEntries` (aprobados y no) y `headcount` en `AllocationInput`, las dos ramas de `driverWeights` con **ventana efectiva** y **FTE·mes**, los **cuatro** avisos `W-E10-*` (incluido el de base parcial), `timeHash` **con su ventana** en el run. **Sin tocar** Hamilton, grafo, cascada ni forma canónica | T2, T3, T5 | dev-backend | 2 | 24 |
| **T10** ▶ | **Fixture Python sellado**: `build_presupuesto_horas_esperado.py` → `presupuesto-horas-esperado.json` (presupuesto por nivel y mes, minutos aprobados por proyecto y mes, **liquidación `HOURS` esperada**, **liquidación PRESUPUESTARIA esperada**, matriz de desviación y forecast) + los **cinco casos adversariales** de §6 de la validación + test byte a byte + `--check` en CI. **Congela el contrato de D6** | T1, T2 | qa | 2 | 28 |
| **T11** | `lib/budget/invariants-e10.ts` (**I-E10-1…18**, con las cinco revisiones de la ronda 1) + familia `PRESUPUESTO` en `lib/audit/families.ts` + los **cinco** motivos de sello + cableado en `runLedgerInvariants` y `scripts/run-invariants.ts`; fixtures adversariales | T7, T8, T9 | dev-backend | 2 | 34 |
| **T12** | `models/{budget,time,employees}.ts` con `sealBudget` **cerrando la vigencia anterior** (O-E10-8), `activeBudgetAt` **componiendo** versiones (O-E10-9), `proposeDepreciationBudget` (Q-4) y `proposeHourlyCost` **con ámbito y cobertura**; + **`allocationRunStalenessBatch`** (deuda §0-bis #6) con su test espejo TS↔SQL y su cuenta de consultas; `models/closing.ts` y `/analytics/allocations/runs` migrados al lote | T4, T11 | dev-backend | 1 | 34 |
| **T13** | `PRESUPUESTO_REAL` en `models/reports.ts` (sale de `NOT_IMPLEMENTED`), `budgetHash` en la clave, la **regla de comparabilidad** y el bloqueo del toggle (O-E10-4), `EV-11…EV-13` + `EV-15…EV-17` (**`EV-14` retirada**), los **cuatro** KPI de umbral, el bloque de **absorción**, la previsualización **no sellada** contra un borrador, export CSV/XLSX/PDF con la hoja de procedencia de tres consultas | T2, T12 | dev-backend | 2 | 32 |
| **T14** | `forms/{budget,time,employees}.ts` + las cinco `actions.ts` con la matriz de roles de §4.2, R-H-4, B-9, **validación de signo y rechazo del CSV invertido**, `BUDGET_NOT_SEALED`, `RATE_BASIS_CONFLICT` y el aviso del techo diario agregado; import CSV en servidor con `dry-run` | T12, T13 | dev-backend | 1 | 24 |
| **T15** | UI **`/analytics/budget`**: editor tipo hoja con totales de servidor, aviso de signo en la celda, pegado, import CSV con previsualización, «Precargar amortización», versiones con `partialFrom`, vigencias y sellado + **`/analytics/budget/diff`** entre dos versiones | T14 | dev-frontend | 1 | 34 |
| **T16** | UI **`/analytics/budget-vs-actual`** (celdas `notComparable`, toggle bloqueado con motivo, procedencia del presupuesto mes a mes, banda de borrador) + bloque de **rentabilidad con horas y absorción** en `/analytics/projects/[code]` + drill-down ≤ 3 clics | T14 | dev-frontend | 1 | 32 |
| **T17** | UI **`/time`** (calendario en `hh:mm`, lista, aprobación en lote, contra-apunte, banda de pendientes con su %) + **`/settings/employees`** (tarifas con `basis` y propuesta con cobertura) + **`/settings/headcount`** (0 declarado vs sin rellenar); y las dos deudas de interfaz: **destino analítico en el alta de inmovilizado** (§0-bis #7) y **cuadre Σ Debe/Σ Haber compuesto en servidor** (§0-bis #8) | T14 | dev-frontend | 1 | 32 |
| **T18** | `/analytics/allocations`: `HORAS`/`PLANTILLA` en el selector con su nota y su enlace; `/audit` gana la familia `PRESUPUESTO`; WARN de `Project.budgetRevenueCents` divergente | T14 | dev-frontend | 1 | 10 |
| **T19** | Integración + RLS: `e10-presupuesto.test.ts` (criterios 1–19 y 23, 27–33), `e10-tenant.test.ts` (24), `perf-budget.test.ts` (los **nueve** techos de §9, con la **cuenta de consultas** del criterio 21) | T15–T18, T20 | qa | 1 | 38 |
| **T20** ▶ | **Fixture `ejercicio-completo-v2` reversionado** (deuda §0-bis #5): `build_ejercicio_completo_v2.py` nuevo, `schemaVersion 3.1`, retenciones por `IRPF_A_PAGAR_111/115/123`, bloques `employees`/`employeeRates`/`timeEntries`/`headcountSnapshots`/`budgets`/`budgetHoursLines` **con los cinco casos adversariales**, `expected` recalculado, `--check` en CI; carga verificada con `load-fixture.ts` | T3 | qa | 1 | 26 |
| **T21** | e2e Playwright: presupuesto → sellar → presupuesto vs real → drill-down al documento · **revisión parcial y diff entre versiones** · parte de horas → aprobar → regla `HOURS` → liquidar → PyG imputada · contra-apunte · tarifa derivada de nómina · activo con proyecto · VIEWER sin botones | T19 | qa | 1 | 26 |
| **T22** | **Auditoría de fiabilidad en contexto limpio**: reconstruir por SQL/Python la matriz de presupuesto, la **liquidación presupuestaria**, la desviación de ocho niveles, el forecast con corte en abril, el reparto `HOURS` y el coste-hora derivado; error inyectado en una celda sellada (I-E10-6), en un parte aprobado (I-E10-4) y en la **ventana del `timeHash`** (I-E10-17) | T19 | auditor-fiabilidad | 2 | 22 |
| **T23** | Cierre documental: `MODELO-DATOS.md` (bloque E10 en su forma final y **O-A6 marcada CERRADA con el SQL que la cierra**), `ARQUITECTURA.md` (§`lib/budget`, `lib/time`, rutas), skills `fiabilidad` (I-E10-*, familia `PRESUPUESTO`, los **cinco** motivos), `contabilidad-analitica` (drivers vivos con su base, `MIXED` retirado, presupuesto versionado, **minutos**) y `estados-financieros` (presupuesto vs real y la regla de comparabilidad); `ESTADO.md` con la deuda de §0-bis cerrada y la re-fechada; ROADMAP E10 → CERRADA; `runs/registro.jsonl`; ADR-0018 → APROBADO | T21, T22 | arquitecto | 1 | 16 |

**Total: 578 h** (~72 jornadas, 23 tareas; **+108 h sobre la ronda 0**: la
liquidación presupuestaria de O-E10-4, la ventana del `timeHash`, el aviso con
base parcial, la base FTE·mes, el `marginLevel` congelado, la validación de
signo, la continuidad y composición de versiones, la derivación con cobertura, el
Hamilton del coste, el informe de absorción, el cuarto KPI, la previsualización no
sellada, los cinco invariantes nuevos y los cinco casos adversariales del fixture).

**Camino crítico:** T1 → T2 → T4 → T7 → T9 → T8 → T11 → T12 → T13 → T14 →
T15/T16/T17 → T19 → T21/T22 → T23. **T8 pasa a depender de T9** (la liquidación
presupuestaria reutiliza `allocate()` con los drivers ya encendidos).
**En paralelo desde ya** (▶): T3, T5, T6, T10 y T20 — **las cinco desbloqueadas**,
porque T1 y T2 están hechas. T20 debe estar **antes** de T19; T10 antes de T11.

---

## 14. Plan de ejecución en tres olas (tres agentes en paralelo)

Las 21 tareas ejecutables (**552 h**; T1 y T2 son de diseño y firma) se reparten
en **tres olas de tres agentes** más una cola de verificación. La regla es una
sola: **dentro de una ola, dos agentes no tocan el mismo fichero**.

### Ola A — cimientos, esquema y motores de horas

| Agente | Tareas | h | Ficheros (exclusivos en la ola) |
|---|---|---:|---|
| **A1** dev-backend | **T3 → T4** | 52 | `prisma/schema.prisma`, `prisma/migrations/**` (M1…M6), `lib/db.ts`, `eslint.config.mjs`, `.claude/hooks/guard.sh`, `tests/integration/e10-esquema.test.ts` |
| **A2** dev-backend | **T5, T6** | 34 | `lib/time/aggregate.ts`, `lib/time/cost.ts` (+ sus `*.test.ts`) |
| **A3** qa | **T20, T10** | 54 | `docs/design/fixtures/build_ejercicio_completo_v2.py`, `tests/fixtures/ejercicio-completo-v2.json`, `docs/design/fixtures/build_presupuesto_horas_esperado.py`, `…/presupuesto-horas-esperado.json` |

**Sincronización única:** A1 entrega **T3 en su primer commit** (esquema +
`TENANT_MODELS` + guard) y A2/A3 arrancan de ahí; A1 continúa con T4 sin bloquear
a nadie. A2 y A3 **no tocan `prisma/`**.

### Ola B — presupuesto, drivers, invariantes y modelos

| Agente | Tareas | h | Ficheros |
|---|---|---:|---|
| **B1** dev-backend | **T7, T8** | 54 | `lib/budget/{types,hash,matrix,variance,forecast}.ts`, `lib/time/payroll-reclass.ts` (+ tests) |
| **B2** dev-backend | **T9, T11** | 58 | `lib/analytics/allocate.ts`, `lib/budget/invariants-e10.ts`, `lib/ledger/invariants.ts` (cableado), `lib/audit/families.ts`, `scripts/run-invariants.ts` |
| **B3** dev-backend | **T12, T13** | 66 | `models/{budget,time,employees,allocations,reports,closing}.ts`, `lib/ledger/report-run.ts`, `lib/export/**` |

**La única colisión posible, evitada:** `lib/analytics/allocate.ts` es de **B2 y
sólo de B2**; B1 trabaja en `lib/budget/**`, que no existe todavía, y B3 en
`models/**`. **Dependencia nueva de la ronda 1**: T8 necesita T9, porque
`settleBudgetMatrix` (O-E10-4) **llama a `allocate()` con los drivers de actividad
ya encendidos**. Se resuelve con el orden dentro de la ola —B2 empieza por T9,
que sólo necesita T5 de la ola A, y publica su firma en el primer commit; B1
empieza por T7, que no depende de nadie, y hace T8 después— **sin mover T8 de
agente**: T8 escribe en `lib/budget/**` y en `lib/time/payroll-reclass.ts`, y no
toca `allocate.ts`. Cuando B1 termina T8, B2 hace T11. B3 arranca con T12 sobre
las firmas que B1 y B2 publican en su primer commit.

### Ola C — acciones e interfaz

| Agente | Tareas | h | Ficheros |
|---|---|---:|---|
| **C1** dev-backend | **T14** | 24 | `forms/{budget,time,employees}.ts`, `app/(app)/analytics/budget/actions.ts`, `app/(app)/time/actions.ts`, `app/(app)/settings/{employees,headcount}/actions.ts` |
| **C2** dev-frontend | **T15, T18** | 44 | `app/(app)/analytics/budget/**`, `app/(app)/analytics/allocations/**`, `app/(app)/audit/**`, `components/budget/**` |
| **C3** dev-frontend | **T16, T17** | 64 | `app/(app)/analytics/budget-vs-actual/**`, `app/(app)/analytics/projects/**`, `app/(app)/time/**`, `app/(app)/settings/{employees,headcount,assets}/**`, `components/{time,employees,assets}/**`, `app/(app)/ledger/**` (sólo el cuadre de §0-bis #8) |

**Frontera limpia:** C1 es el **único** que escribe `actions.ts` y `forms/`; C2 y
C3 consumen esas acciones y tocan árboles de rutas **disjuntos**. C2 y C3
arrancan cuando C1 publica las firmas (contrato primero, implementación después),
que es el patrón que ya funcionó en E6, E7 y E9.

### Cola de verificación

| Orden | Tarea | Agente | h |
|---|---|---|---:|
| 1 | **T19** integración + RLS + `perf-budget` (nueve techos) | qa | 38 |
| 2a | **T21** e2e Playwright | qa | 26 |
| 2b | **T22** auditoría de fiabilidad **en contexto limpio** (paralela a T21, P5) | auditor-fiabilidad | 22 |
| 3 | **T23** cierre documental, ROADMAP, `ESTADO.md`, registro | arquitecto | 16 |

### Calendario

| | Serie | Tres olas |
|---|---:|---:|
| Ola A | 140 h | **54 h** (A3) |
| Ola B | 178 h | **66 h** (B3) |
| Ola C | 132 h | **64 h** (C3) |
| Cola | 102 h | **80 h** (T19 → máx(T21, T22) → T23) |
| **Total** | **552 h** | **≈ 264 h** de calendario (~33 jornadas frente a 69) |

Reglas de la ejecución en paralelo, heredadas de E7 y E9: **un fichero, un agente
y una ola**; **el esquema es de A1 y de nadie más**; **contrato antes que
implementación**; `npm run lint && npm run test` en verde al cerrar cada tarea y
una línea por ola en `runs/registro.jsonl`; **la cola no empieza hasta que las
tres olas están integradas**.

---

## 15. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | **El presupuesto se convierte en una segunda contabilidad**: alguien empieza a «cuadrar» la PyG contra el presupuesto | El presupuesto vive en su propia tabla, no entra jamás en la matriz del real, y I4 se sigue comprobando **sólo** sobre el diario. Los avisos de método van impresos en pantalla |
| **R2** | **Un `HOURS` mal agregado descuadra I5** y deja saldo en el CECO | La base es un agregado determinista, el reparto sigue siendo el Hamilton entero de E5 con tolerancia 0, y I5.a se comprueba por `(run, fuente, nivel)` como siempre. El fixture sellado de horas es el contrato |
| **R3** | **El run con `HOURS` envejece en silencio** al aprobar un parte tardío | **D1**: `timeHash` en el run y cuarta causa de `STALE`. Criterio 12 |
| **R4** | **Horas sin aprobar reparten de menos y nadie se entera** — con base 0 (ADR-0013 D4) y, peor, **con base parcial**, que es el caso frecuente | `W-E10-UNAPPROVED-HOURS` **siempre que haya minutos sin firmar**, con importe y % sobre la base; motivo `HORAS_SIN_APROBAR` en el run y `EV-15` en el informe; validación al guardar la regla y «pendiente de liquidar» visible. Criterios 13 y 13-bis |
| **R5** | **El coste-hora se usa sin saber qué contiene** y dos proyectos se comparan con magnitudes distintas | `EmployeeRateBasis` obligatoria en la tarifa, visible junto a cada cifra derivada, y en el export |
| **R6** | **Un parte corregido descuadra las horas** si alguien filtra los contra-apuntes | Los contra-apuntes suman con su signo y **no se filtran nunca**: es la misma doctrina que el contra-asiento (`CLAUDE.md`: no existe flag que excluya líneas de los informes) |
| **R7** | **El editor de presupuesto suma en cliente** y enseña un total que no es el que se sella | Todos los totales los compone el servidor (T15), y es literalmente la deuda §0-bis #8 aplicada dos pantallas más allá |
| **R8** | **Import CSV duplicado** por doble clic o dos pestañas | `importKey = sha256(fichero ‖ nº de línea)` con índice único: la segunda importación inserta 0 filas y lo dice. Criterio 10 |
| **R9** | **La caché sirve el informe de la versión equivocada** de presupuesto | `budgetHash` en la clave de reutilización (M5) y `EV-11` que dispara siempre que cambia. Criterio 17 |
| **R10** | **Reversionar el fixture v2 mueve una cifra de cierre de E9** sin que nadie lo vea | El generador recalcula `expected` y el test byte a byte de E9 corre contra él; cualquier movimiento sale antes de revisión. Criterio 20 |
| **R11** | **Retirar `MIXED`/`DRAFT` pierde datos** en un entorno que sí los use | La migración **aborta** con el recuento. Criterio 23 |
| **R12** | **`allocationRunStalenessBatch` calcula un `ledgerHash` distinto** del motor y todo sale caducado | Test espejo TS↔SQL fila a fila, el mismo patrón que el trigger de `report_runs_analytics_key`. Criterio 21 |
| **R13** | **Datos de nómina a la vista de todos** | La tarifa individual sólo la ve ADMIN; el resto ve el coste-hora medio del receptor (§10) |
| **R14** | **El editor tipo hoja se arrastra** con 28 800 celdas | Techo medido en §9, agregados SQL, guardado por lotes e índices por `(budget_id, month)` |
| **R15** | **La desviación por proyecto por debajo de MC2 es falsa** porque el presupuesto no está imputado y el real sí — y **el total compañía cuadra**, que es lo que hace que nadie lo detecte | **O-E10-4**: liquidación presupuestaria en dry-run con las mismas reglas, o celdas **no publicadas** con leyenda; nunca una matriz mixta. **I-E10-18** y criterios 27 / 27-bis |
| **R16** | **Un run con fallback `YTD` envejece en silencio** porque el sello no cubre la ventana que usó | **O-E10-1**: `timeHash` sobre la **ventana efectiva**, persistida en el run; **I-E10-17** y criterio 12-bis |
| **R17** | **Un gasto tecleado en positivo duplica la desviación** con ejecución exacta, y con signo de «hemos gastado de más» | **O-E10-6**: validación por tipo analítico, CHECK de refuerzo, excepciones declaradas y **rechazo del CSV con la convención invertida**. **I-E10-14** y criterio 28 |
| **R18** | **Dos proyectos fuera de control con un informe en verde** porque sus desviaciones se compensan en el total | **O-E10-18**: `desviacionMaxDimension` sobre `max \|desviación\|` por dimensión. Criterio 18-bis |
| **R19** | **La estructura se carga dos veces**: tarifa con estructura incluida **más** regla de actividad, o horas no productivas absorbidas en la tarifa **y** repartidas otra vez | **Modelo A escrito en D3** y `COSTE_TOTAL_CON_ESTRUCTURA` excluyente con las reglas de actividad. Sin ello, I-E10-12 daría FAIL todos los meses con un exceso del 20 %. Criterios 19-bis y 19-sexies |
| **R20** | **Una revisión parcial desinfla el año a la mitad** sin que nada lo diga, o un hueco de vigencia hace creer que no hay presupuesto | **O-E10-8/9**: `sealBudget` cierra la anterior en la misma transacción, `partialFrom` y composición con procedencia por mes. **I-E10-15**, **I-E10-16**, criterios 6 y 6-bis |
| **R21** | **Un coste-hora que no se puede rehacer a mano** porque nadie sabe de dónde sale la nómina de esa persona | **O-E10-12**: ámbito CECO por defecto, individual sólo con `counterpartyId` y **cobertura declarada**; no evaluable por debajo del umbral. Criterio 19-ter |
| **R22** | **Una infraabsorción del 20 % pasa el invariante en silencio** porque I-E10-12 sólo mira que no se pase | **O-E10-20**: el informe publica la absorción con su signo, su % y su desglose por CECO. Criterio 19-quinquies |

**Alternativas descartadas**

- **`Forecast` como tabla.** Es `real` hasta el corte y `presupuesto` después:
  una función de dos cosas persistidas. Almacenarlo crea una tercera verdad que
  puede diverger de las otras dos a la vez, y obliga a un proceso que la
  mantenga. Se prefiere el parámetro dentro de `paramsHash` (ADR-0003, D4).
- **Desviación almacenada** en una tabla «para que el informe vaya rápido». Es
  almacenar una resta. Si va lenta, se indexa el minuendo.
- **`amountCents` con signo natural del gasto** (gasto positivo). Obligaría a una
  conversión de signo en cada comparación con la matriz de E4 y a dos
  convenciones en el mismo producto. Se adopta el **aporte** de R-P1.
- **Presupuestar directamente sobre una línea de negocio sin proyecto.** La LN es
  un agregado de presentación (E4) y su columna `BL:` sólo recibe imputaciones
  (E5-D3). Un presupuesto de LN que no sea la suma de sus proyectos produciría
  una desviación de LN que no es la suma de las desviaciones de sus proyectos:
  dos cifras verdaderas que se contradicen. Si el experto lo pide, se reabre con
  ADR (Q-5).
- **Un `ReportType` nuevo por escenario** (`PRESUPUESTO_BASE`,
  `PRESUPUESTO_REVISADO`). Son **parámetros**; para eso existen `paramsHash` y
  `budgetHash` (misma lección que la foto del balance en ADR-0012).
- **Recomponer `analytics_key` para meter `budgetHash`.** Cambiaría la clave de
  **todos** los `ReportRun` existentes y los invalidaría en bloque, por un
  componente que sólo interesa a un tipo de informe. Una columna nueva en el
  índice no toca nada de lo ya emitido.
- **`HEADCOUNT` repartiendo a proyectos** derivando el FTE de las horas. Es el
  driver `HOURS` con otro nombre y un rodeo: el mismo dato, dos veces, con dos
  resultados posibles.
- **`HEADCOUNT_AVG`** (media del periodo) en lugar del stock a fin de periodo.
  Es un driver **distinto**, no un parámetro; el experto ya lo dijo en E5 y se
  mantiene. Si se quiere, se añade como valor nuevo del enum, con su ADR.
- **Horas en centésimas de hora** (lo que proponía la ronda 0). **Descartada por
  Q-2**: la fuente primaria es el registro de jornada del art. 34.9 ET, que se
  lleva en `hh:mm`, y todo `hh:mm` es un entero exacto de minutos mientras que en
  centésimas no lo es (un minuto son 5/3). Un fichaje de 7 h 20 min se convierte
  en 733,33 → 733, y se pierden 0,2 min por parte: con 8 800 partes al año son
  **29,33 h** fuera del denominador, ~103 000 c de coste sin sitio y un descuadre
  permanente con el registro legal. Los dos argumentos de la ronda 0 no se
  sostenían: la centésima es unidad de **presentación**, no del dato de origen, y
  el truncamiento no se evita (`⌊h·r/100⌋` trunca igual que `⌊m·r/60⌋`; en los dos
  casos lo compensa el mismo Hamilton). **Segundos enteros** se consideró como
  refinamiento —representa exactamente las dos fuentes— y se descarta por no
  aportar nada sobre el minuto en este dominio.
- **Horas con `Decimal` o `Float`.** Misma razón que el céntimo (ADR-0006): una
  suma de 120 000 partes en coma flotante no es reproducible byte a byte.
- **Repartir el coste de personal partiendo una `JournalLine`** entre varios
  proyectos. Prohibido por ADR-0003 y ADR-0010 (sólo las cuatro columnas
  analíticas cambian). Ese caso es exactamente para lo que existe el driver
  `HOURS`.
- **Un asiento de traspaso analítico 64x → 64x** para materializar la imputación
  de personal. No es un hecho económico (NRV 14ª), ya lo descartaron ADR-0004 y
  ADR-0013, y obligaría a un flag de exclusión de informes que `CLAUDE.md`
  prohíbe.
- **Aplicar automáticamente el coste-hora derivado de la nómina.** Convertiría
  una estimación de controlling en un dato del sistema sin que nadie la firmara.
  Se propone con sus términos y la aplica un ADMIN.
- **Permitir editar una versión sellada «sólo un poco».** Destruye P3/P7: la foto
  dejaría de ser una foto. Se crea una revisión, y el diff entre las dos es la
  información útil — igual que con `ReportRun` y con `AllocationRun`.
- **Meter todo lo que dice «E10» en E10** (diferencias temporarias, art. 107,
  prorrata especial, `SettlementAllocation`, previsión de tesorería). Son cuatro
  problemas contables distintos del presupuesto y de las horas; §0-bis los
  re-fecha con su épica y su motivo.
- **Publicar la desviación por proyecto en MC3 sin imputar el presupuesto**
  (opción «mínima» que la validación admitía como salida). Se descarta a favor de
  la recomendada —liquidación presupuestaria— y se conserva **sólo como
  degradación** cuando el presupuesto no puede seguir al real: mejor no publicar
  una celda que publicarla falsa, pero mejor todavía publicarla bien.
- **Un tercer término «cruce» en la descomposición volumen/precio.** Es
  matemáticamente honesto e inservible en un comité: nadie tiene responsabilidad
  sobre él. El cruce va al precio (Q-6, D6).
- **Descomponer el efecto mezcla.** Exige una jerarquía de producto que el modelo
  no tiene; mejor no publicarlo que publicarlo mal.
- **`concentrationBps` parametrizable** en la reclasificación de personal. Con
  8000, una línea de 300 000 c consumida al 80 % por un proyecto se reasignaría
  entera y su MC2 se llevaría 60 000 c ajenos (O-E10-22). Queda fijo en 100 %.
- **Endurecer I-E10-12 a igualdad** en vez de publicar la absorción. La igualdad
  sólo se da con horas y tarifas perfectas; lo que falta no es un invariante más
  duro, es una cifra en el informe (O-E10-20).

---

## 16. Validación de control de gestión: **CONFORME CON OBSERVACIONES**, todas incorporadas

`docs/design/E10-validacion-controlling.md` (rol `experto-contable` con sombrero
de controller/CFO) dio **CONFORME CON OBSERVACIONES** sobre la ronda 0, con cinco
bloqueantes. **Las veintidós observaciones y las siete respuestas están
incorporadas**; §0 dice dónde entra cada una. Aquí queda el estado.

### Las siete cuestiones, resueltas

| # | Cuestión | Decisión firme (queda congelada en **D6**) |
|---|---|---|
| **Q-1** | Coste-hora con o sin SS, y default | **`COSTE_EMPRESA_CON_SS`** = `640` + `642` + `645` + `649`. **`641` excluido**. `basis` obligatoria y visible junto a cada cifra |
| **Q-2** | Unidad de las horas | **Minutos enteros** (art. 34.9 ET). Se retira la centésima de hora de la ronda 0 |
| **Q-3** | Horas no productivas | Fuera del driver **y** del denominador (**modelo A**); su coste **no se reparte otra vez**: reparte la regla `HOURS` sobre el saldo real del CECO |
| **Q-4** | Presupuesto de inversiones y amortización | Sólo explotación + **`proposeDepreciationBudget()`**; CAPEX y `BudgetCapexLine` → **E11** |
| **Q-5** | Presupuesto directo sobre una LN | **No**; el negocio no contratado va al proyecto contenedor **`P-<LN>-NUEVOS`** (`PLANNED`, excluido del reparto) |
| **Q-6** | Desviación volumen vs precio | **Cruce al precio**, precio como **residuo** ⇒ suma exacta. Sin efecto mezcla. **Convención congelada; implementación en E11** |
| **Q-7** | `HEADCOUNT` stock o media | **FTE·mes** (Σ de los snapshots del periodo). Un run mensual = el stock actual; trimestre y año dejan de ser falsos |

### Las dos confirmaciones que el diseño pedía

**(i) La imputación de personal por horas no genera ningún hecho contable, y por
tanto ningún asiento. CONFIRMADO** por NRV 14ª (no hay hecho económico que
registrar al mover un coste ya registrado entre dimensiones de gestión), arts.
25–29 CdC (la contabilidad analítica **no es libro obligatorio**), el grupo 9
libre del PGC, ADR-0003/`CLAUDE.md` (un asiento de traspaso exigiría un flag de
exclusión de informes, prohibido) y la salvaguarda 1 de ADR-0010. Los dos caminos
de §3.7 son los correctos, con **O-E10-22** aplicada y con el matiz de la ventana
temporal ahora **escrito** y no dado por sabido.

**(ii) Un presupuesto sellado no es documento contable. CONFIRMADO**: no es libro
obligatorio, no se deposita y no se audita en el sentido del art. 268 LSC. La
ceremonia del diseño —versión, vigencia sin solape **ni hueco**, sello triple,
inmutabilidad por trigger, sustitución en vez de corrección y `AuditLog`— es
**suficiente y proporcionada**. Lo único que el CFO pedía además —**ver el diff
entre dos versiones**— es ahora pantalla (`/analytics/budget/diff`, §7).

### Lo que queda abierto para la ronda de firma

**Nada.** ADR-0018 (D1–D6) está **APROBADO** el 2026-09-14 y el contrato de cifras
de §6 de la validación queda congelado en **D6**. Lo único que queda en pie es la
regla que ese contrato impone: **a partir de T10, que sella
`presupuesto-horas-esperado.json`, cambiar cualquiera de los siete puntos cuesta
un reversionado del fixture.** E10 está lista para `/sprint E10`.
