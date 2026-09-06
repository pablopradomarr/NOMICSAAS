# ADR-0013 — Liquidación de CECOs: el nivel de margen viaja con el importe, `sourceShareBps`, `allocationRunSetHash` y disponibilidad estricta de drivers

**Estado:** APROBADO por Pablo el 2026-09-06 (permiso general delegado) · **Nivel:** 2 · **Fecha:** 2026-09-06 · **Épica:** E5 · **Complementa:** ADR-0004 (capa analítica paralela; **no lo sustituye ni lo enmienda**) · **Precisa:** ADR-0010 / ADR-0011 (`analyticsHash`) · **Diseño:** `docs/design/E5-liquidacion.md` · **Validación contable:** `docs/design/E5-validacion-liquidacion.md` (CONFORME CON OBSERVACIONES, O-E5-1…10) y `docs/design/fixtures/liquidacion-esperada.json` (14 líneas, 25 checks en PASS)

## Contexto

ADR-0004 fijó la arquitectura de la liquidación y sigue vigente sin un cambio: capa paralela al diario, `AllocationRule` versionada → `AllocationRun` inmutable y reversible → `AllocationLine` con reparto por mayor resto, **sin generar jamás asientos financieros**. Al diseñar E5 sobre el fixture real aparecieron **cinco decisiones que ADR-0004 no cubre** y que son de Nivel 2 porque cambian el esquema del motor, la definición de un invariante o la clave de caché de un informe. Se abre un ADR **nuevo** en vez de enmendar el 0004 porque este no corrige nada de aquel: lo completa donde callaba.

1. **El nivel de absorción de un importe imputado no estaba definido.** Con una cascada entre CECOs de niveles distintos (`CC-GA` EBITDA → `CC-OPS` MC3, que es el caso del fixture), la lectura intuitiva —el nivel lo pone el receptor— mueve 189 954 céntimos de EBITDA a MC3 sin que la PyG contable cambie, y **I4.a falla en la fila MC3**.
2. **`AllocationRule` no decía qué fracción del saldo liquida cada regla.** Con dos reglas sobre el mismo CECO, el reparto del saldo entre ellas quedaba indefinido: «CC-GA reparte 30 % a un sitio y 70 % a otro» no era representable salvo inventando una regla `MIXED` con targets heterogéneos, que además obliga a fijar por porcentaje lo que se quiere repartir por driver.
3. **`analyticsHash` incluía `allocationRunId` en singular** (E4-D2). Un informe anual con reglas mensuales se apoya en 12 runs; con tres periodicidades, en 17. La caché serviría un informe calculado con 11 runs como si tuviera 12.
4. **Dos de los siete drivers no tienen datos hasta E10** (`HOURS` necesita `TimeEntry`, `HEADCOUNT` necesita `EmployeeAssignment`). Sin decisión explícita, una regla con esos drivers se guardaría y repartiría 0 € en silencio.
5. **I5 estaba escrito con tolerancia de 1 céntimo** y con desempate «al mayor receptor», dos cosas incompatibles con el método del mayor resto y con P7.

## Decisión

### D1 — El nivel de margen **viaja con el importe**, no con el receptor (E5-D1)

`AllocationLine` gana **`marginLevel MarginLevel @map("margin_level")`** con `CHECK IN ('MC3','EBITDA')`, poblado con el `CostCenter.marginLevel` del CECO **donde nació el gasto** —no el del receptor ni el del emisor intermedio— y conservado a lo largo de toda la cascada.

Consecuencia aritmética, que es la razón de ser de la decisión: la imputación pasa a ser un **traspaso de suma cero en cada nivel**,

```
Δ[ℓ][columna del CECO fuente] += +importe
Δ[ℓ][columna del receptor]    += −importe        con el MISMO ℓ en las dos
⇒ ∀ℓ:  Σ_c Δ[ℓ][c] = 0   ⇒   Σ_c M_E5[ℓ][c] = Σ_c M_E4[ℓ][c] = PyG contable hasta ℓ
```

**I4 no se «vuelve a comprobar» tras imputar: se cumple por construcción**, con tolerancia 0 y nivel a nivel. Un CECO en cascada puede sostener simultáneamente un bucket MC3 (suyo) y uno EBITDA (recibido), y **cada uno se reparte por separado con su propio Hamilton**.

Es además la lectura de gestión correcta: el alquiler de la oficina no se convierte en coste operativo de un proyecto por el hecho de pasar por Operaciones. La cascada entre niveles queda **permitida** (es organizativamente normal que parte de la G&A sea soporte a Operaciones); lo prohibido es que el importe **cambie de nivel** al pasar.

### D2 — `AllocationRule.sourceShareBps`, con Σ = 10000 por `(CECO fuente, período)` (E5-D2)

`sourceShareBps Int @default(10000)`, `CHECK BETWEEN 0 AND 10000`, y validación `Σ = 10000` por cada `(sourceCostCenterId, period)` vigente (**I-E5-3**). Cada regla conserva **un solo driver** y **un solo `targetKind`**, y el reparto del saldo entre reglas es a su vez por mayor resto, así que la suma es exacta. `MIXED` queda como contrato en el enum, **desaconsejado y sin uso**: con `sourceShareBps` toda mezcla se expresa como N reglas de un driver, que es más legible y más auditable.

### D3 — `allocationRunSetHash` sustituye a `allocationRunId` en `analyticsHash` y en `analyticsKey`

```
allocationRunSetHash = sha256( join("\n", sorted( id de TODO AllocationRun con status='SEALED'
                                                  y [periodStart, periodEnd] ⊆ periodo del informe )) )
                     = sha256("")  con el conjunto vacío

analyticsHash = sha256( dimensiones de las líneas ‖ marginConfigHash ‖ allocationRunSetHash )
analyticsKey  = analyticsHash | marginConfigHash | allocationRunSetHash
```

`ReportRun.allocationRunId` se **sustituye** por `ReportRun.allocationRunSetHash char(64)`. Con conjunto vacío, la PyG analítica **sin** imputaciones de E4 y la **con** imputaciones de E5 son dos `ReportRun` distintos y la caché no sirve la una por la otra. Liquidar caduca `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD`, y **sólo** esos: `ledgerHash` no cambia, así que balance, PyG contable, cashflow y diario siguen vigentes (E4-D2, ADR-0010).

**No circularidad**: el `analyticsHash` que un `AllocationRun` sella es el de **dimensiones**, calculado con `allocationRunSetHash = ∅`. Se implementa como **dos funciones distintas** (`dimensionsHash` y `analyticsHash`), no como un parámetro opcional que se pueda olvidar.

### D4 — Disponibilidad de drivers: estricta, nunca inerte

- `MANUAL` **entra en E5**: `AllocationRuleTarget.amountCents Int?`, excluyente con `percentBps` por CHECK, con `Σ amountCents = base(s,R,ℓ)` exigido **antes** de persistir el run (**I-E5-10**), `reason` obligatorio y rol `ADMIN`. Un reparto manual **nunca se reescala solo**: si el saldo cambia, el run queda caducado y hay que reeditarlo, porque el usuario declaró importes, no proporciones.
- `HOURS` y `HEADCOUNT` **se rechazan hasta E10**, en los dos caminos: la acción responde `DRIVER_UNAVAILABLE` y la base de datos lo impide con `CHECK ("driver" NOT IN ('HOURS','HEADCOUNT'))`. **En ningún camino queda una regla inerte** que reparta 0 € en silencio. E10 retira el CHECK y, en la misma épica, cumple el contrato del experto (minutos enteros, sólo entradas aprobadas, `fteMilli` a fin de periodo) con su propio fixture.
- `74x` queda **excluido de `REVENUE_SHARE`** (R-A12): una subvención finalista no es capacidad de absorción de estructura, y contarla haría que el proyecto subvencionado cargase con más G&A por el mero hecho de estar subvencionado. `706`/`708`/`709` sí entran, con su signo.
- `CC-FIN`, `CC-EXT` y `CC-NA` (`allocatable = false`) **nunca** son fuente ni destino (**I-E5-5**): un CECO no imputable que recibiera quedaría con saldo inmovilizado y sin regla para sacarlo.

### D5 — I5 con **tolerancia 0** y desempate por **menor código**; simulación obligatoria

- Reparto por **mayor resto (Hamilton)** en aritmética **entera** sobre `|importe|`, con el signo restituido al final. `Σ resultado = importe`, **exacto**. La tolerancia de I5 es **0**: un céntimo sin repartir es un fallo, no un redondeo. El «≤ 1 céntimo» describe el remanente **por receptor** (`0 ≤ r ≤ n−1` en total, **I-E5-4**).
- Empate de restos ⇒ gana el receptor de **menor `code`** (orden lexicográfico). «El mayor receptor» no es determinista cuando dos empatan y depende del orden de lectura de la base de datos, lo que rompería P7.
- **`previewAllocation` (dry-run puro) antes de sellar** es obligatorio en el flujo de la UI: el usuario aprueba exactamente lo que se va a persistir. Si entre simular y sellar cambia alguno de los tres sellos, la acción **no persiste lo aprobado**: responde `LIQUIDACION_DESFASADA` y obliga a resimular.
- `AllocationRunStatus = DRAFT | SEALED | SUPERSEDED | REVERSED`. **`STALE` no es un estado almacenado**: se deriva comparando `ledgerHash`, `dimensionsHash` y `rulesHash` del run con los del periodo. Guardarlo obligaría a un `UPDATE` sobre una tabla append-only y a un proceso que lo mantuviera; derivarlo es exacto en todo momento y no escribe nada. `DRAFT` es contrato: E5 **nunca lo persiste**.

## Alternativas descartadas

- **Enmendar ADR-0004 en vez de abrir un ADR nuevo.** Los ADR son inmutables y ADR-0004 no contiene ningún error: sus decisiones se sostienen íntegras. Enmendarlo mezclaría «lo que decidimos entonces» con «lo que faltaba por decidir» y dejaría el histórico ilegible.
- **Nivel de absorción decidido por el CECO receptor.** Es la lectura intuitiva y es falsa contable y aritméticamente: baja el MC3 de la compañía 189 954 c sin que la PyG contable cambie y rompe I4.a en la fila MC3.
- **Una regla `MIXED` con targets heterogéneos** en lugar de `sourceShareBps`. Obliga a fijar por porcentaje lo que se quiere repartir por driver, hace la regla ilegible en su ficha y deja el reparto del saldo entre reglas sin definir cuando hay más de una.
- **Mantener `allocationRunId` en singular.** La caché serviría un informe anual calculado con 11 runs como si tuviera 12: un informe con cifras incompletas presentado como vigente, que es exactamente lo que la clave de reutilización existe para impedir.
- **Aceptar `HOURS`/`HEADCOUNT` como reglas inertes** hasta E10, o silenciarlas con un WARN. Una regla que existe, está vigente y reparte 0 € es indistinguible de una organización que decidió no repartir: el CECO no llega a cero y nadie sabe por qué. Rechazar es más ruidoso hoy y correcto siempre.
- **Tolerancia de 1 céntimo en I5.** Con el mayor resto la suma es exacta, así que la tolerancia sólo serviría para que un motor que pierde un céntimo pase el invariante y la columna del CECO nunca llegue a 0: un fallo silencioso permanente a cambio de nada.
- **`STALE` almacenado.** Exige `UPDATE` sobre una tabla append-only y un proceso de mantenimiento que puede quedarse atrás; la derivación por hashes no puede.
- **Asientos de traspaso analítico** para materializar la imputación. Ya descartado en ADR-0004 y se reafirma: no es un hecho económico (NRV 14ª), contamina el diario y obligaría a un flag de exclusión de informes, prohibido por `CLAUDE.md`.

## Consecuencias

La liquidación queda **cuadrada por construcción**: I4 se cumple nivel a nivel con tolerancia 0 sin necesidad de una comprobación posterior, e I5 cierra a 0 en toda columna de CECO imputable con regla. La PyG analítica pasa a ser reconstruible en cualquier fecha, con cualquier versión de reglas y con o sin imputaciones, y el usuario puede ver ambas y comparar.

A cambio: **cinco campos nuevos** en el esquema del motor (`marginLevel`, `sourceShareBps`, `zeroBaseFallback`, `amountCents`, `fallbackApplied`), un **renombrado** de escala (`percentPermille`/`driverSharePermille` → `percentBps`/`driverShareBps`, gratis hoy porque no hay datos y caro después), una **columna sustituida** en `ReportRun`, y la obligación permanente de que toda futura arista de cascada respete el nivel de origen — un cambio que lo viole tumba el test byte a byte contra `liquidacion-esperada.json` antes de llegar a revisión.

`docs/MODELO-DATOS.md` §Analítica queda actualizado con las cuatro tablas en su forma final. La deuda **O-A6** (uniques parciales de `Budget`), anotada en E4 «para E5/E7», se cierra en la migración de E5.
