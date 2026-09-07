# ADR-0015 — `bigint` en el diario, la conciliación bancaria como fuente de «validado contra fuente», retención de runs, `ReportType` unificado, RLS en `users` y el esquema de la conciliación

**Estado:** **APROBADO por Pablo el 2026-09-07** (permiso general delegado de 2026-09-04) · **Nivel:** 2 · **Fecha:** 2026-09-07 · **Épica:** E7 · **Decisiones:** D1–D6 · **Diseño:** `docs/design/E7-auditoria.md` (ronda 2) · **Validación contable:** `docs/design/E7-validacion-auditoria.md` (**CONFORME CON OBSERVACIONES**: 10 bloqueantes, 9 importantes, 6 de mejora; las 25 incorporadas, más los retoques de cierre m1 y m2) · **Precisa:** ADR-0003 (diario como fuente única), ADR-0005 (el LLM sólo propone), ADR-0006 (dinero en céntimos), ADR-0009 (RLS estricta), ADR-0012 (presentación de informes y umbrales), ADR-0013 (`allocationRunSetHash`) · **No enmienda ninguno**

> **Ronda 2.** La validación contable declaró **NO CONFORME** la identidad del
> cuadre bancario y el modelo de conciliación 1:1, y cuatro de sus observaciones
> bloqueantes cambian el esquema de la migración M3 (O-1, O-3, O-5, O-9). Se
> añade **D6** y se precisan **D1** (aserciones del borde JS, O-23), **D2**
> (composición y definición de «explicado», O-16/O-17) y **D3** (conservación
> mercantil de los extractos, O-22).

## Contexto

E7 no empieza de cero: hereda cinco decisiones que E5, E6 y E8 dejaron **fechadas
y sin tomar** en `docs/ESTADO.md`, y la validación contable ha destapado una
sexta. Las seis son de Nivel 2 porque tocan el esquema del diario, la semántica de
una etiqueta de confianza, la política de snapshots, la clave de caché de un
informe, RLS y la definición de tres invariantes. Ninguna se resuelve «al pasar»
mientras se escribe la pestaña: cambian el marco de control, y un agente no
modifica unilateralmente los checks que lo vigilan (SPEC-FIABILIDAD §7).

1. **`journal_lines.debit_cents` y `credit_cents` son `integer`.** Techo:
   21 474 836,47 €. El producto se vende a empresas de **1 a 100 M€**
   (`SPEC-FUNCIONAL` §0). En `allocation_lines` el mismo problema ya se retiró en
   E5; en el diario se aplazó a E7 a petición del auditor.
2. **El badge `✓ validado contra fuente` de C5 no tiene fuente.** La spec lo
   define como «auditor CONFORME **o cotejo directo con la SoT**», y el único
   cotejo con una fuente externa que existe en el ERP es la conciliación bancaria.
   La etiqueta lleva sin usar desde E0.
3. **Los runs se acumulan sin política.** C1 exige retención y nadie la ha
   traducido al producto; E6 lo dejó anotado para E9.
4. **`ReportType` tiene `CASHFLOW_DIRECTO` y `CASHFLOW_INDIRECTO` como tipos
   distintos**, cuando el método es un **parámetro** del mismo informe sobre el
   mismo periodo y el mismo `ledgerHash` — lo contrario de lo que ADR-0012 decidió
   para la foto del balance y la variante del PGC.
5. **`users` es la única tabla sin RLS**: no tiene `organization_id` y el camino
   de autenticación la lee sin sesión, pero hoy un `SELECT * FROM users` desde
   `app_runtime` enumera los correos de todos los clientes del SaaS.
6. **El modelo de conciliación de la ronda 1 no representa la realidad bancaria
   ordinaria** y su invariante de cuadre estaba mal formulado. La validación
   contable lo resume sin ambigüedad: *«tal como está, I-E7-1 no cuadraría nunca
   en una empresa real, el badge no se encendería jamás y, donde sí se encendiera,
   podría mentir»*.

## Decisión

### D1 — `journal_lines` a `bigint`

`debit_cents`, `credit_cents`, `tax_base_cents` y `original_amount_cents` pasan de
`integer` a **`bigint`** (migración `20260916120000_e7_bigint_diario`). El motor y
la interfaz **siguen en `number`**: la conversión vive en el borde
(`models/ledger.ts`), como en `models/allocations.ts` desde E5. El techo pasa a
ser el entero seguro de JavaScript, 2^53 − 1 ≈ **90 mil millones de euros**.

Condiciones:

- **No cambia ni un valor.** `ALTER COLUMN … TYPE bigint` preserva el valor exacto
  de todo `integer`: no hay redondeo, ni reescalado, ni cambio de representación
  decimal (confirmado en la validación, O-23). Por tanto `canonicalEntryForm`,
  `entryHash`, `ledgerHash`, `ejercicio-{minimo,completo}`,
  `estados-esperados.json` y `pyg-analitica-esperada.json` **no pueden moverse**,
  y con I1/I2/I3/I6 a tolerancia 0 cualquier desviación saltaría de inmediato.
- **El riesgo real está en el borde de JavaScript, no en el DDL** (O-23). Prisma
  devuelve `BigInt`, `JSON.stringify(BigInt)` **lanza**, y el arreglo apresurado
  —serializar como cadena `"1234"`— **sí cambiaría el hash** sin cambiar una sola
  cifra. Tres aserciones obligatorias en el criterio de aceptación 24:
  (a) `canonicalEntryForm` recibe `number`, nunca `BigInt` ni `string`, con test
  de tipo y de JSON canónico byte a byte idéntico antes y después;
  (b) el borde comprueba `Number.isSafeInteger` y **lanza** por encima de 2^53 − 1
  en vez de perder precisión en silencio;
  (c) los `SUM()` sobre `bigint` devuelven `numeric`: se conservan los `::bigint`
  existentes y hay un test que recorre postear → agregar → hash → informe con una
  línea de 25 000 000,00 €.
- Es DDL puro y **no exige SUPERUSER**, pero reescribe la tabla con
  `ACCESS EXCLUSIVE`: se mide antes en un clon del preview, se documenta el tiempo
  real en el runbook y se ejecuta en ventana de mantenimiento.

### D2 — La conciliación bancaria es la fuente de `✓ validado contra fuente`, **por composición**

Regla única, en `lib/audit/confidence.ts`:

> Una cifra lleva `✓ validado contra fuente` si y sólo si **todas** las cuentas que
> la componen están íntegramente conciliadas para el periodo, con **I-E7-1 y
> I-E7-6b en PASS** y **ni un pendiente sin explicar**.

**Por composición, no por cuenta** (O-16): el epígrafe `B.VII.1 Tesorería` agrega
**todas** las 57x, **caja incluida**, y la caja no tiene extracto ni puede
tenerlo. Consecuencia explícita y honesta: *una organización con caja no verá
nunca el badge en la tesorería total del balance; lo verá en el detalle por cuenta
bancaria y en el cashflow si su cashflow no incluye caja*. Un arqueo de caja
firmado **no** es fuente equivalente en E7 (podría serlo en E12, con ADR).

**`explicado` es un criterio verificable, no editorial** (O-17) — listar un
pendiente no lo explica, y conceder el sello por enumeración es el anti-patrón de
la spec §5. Un pendiente está explicado si: es del lado banco y existe ya un
asiento posterior conciliado que lo recoge; **o** es del lado libros y existe ya
una línea de extracto posterior conciliada que lo recoge; **o** está tipado y su
antigüedad es menor que `transitWarnDays` de la cuenta. Cualquier otro **retira el
badge**.

**El badge se deriva en lectura y no se persiste nunca** (O-17): un extracto
importado en febrero puede contener un movimiento con fecha de operación de
diciembre y debe **retirar** un badge ya concedido sobre diciembre. Un badge
almacenado no podría hacerlo.

El badge **no se contagia** a PyG ni a balance: conciliar el banco no acredita que
un gasto esté bien clasificado. El otro camino que la spec admite (auditor
CONFORME) sigue siendo el del agente `auditor-fiabilidad` y no se toca.

### D3 — Retención de runs, y conservación mercantil de los extractos

| Tabla | Se conserva |
|---|---|
| `ReportRun` | **todos** los de los últimos **24 meses**, **+** el último de cada tipo y mes histórico, **+ todos** los de un ejercicio `CLOSED` (evidencia de unas cuentas rendidas: no se purgan nunca) |
| `InvariantRun` | igual, **+** siempre el último de cada alcance y el último con sello `REQUIERE REVISIÓN` de cada ejercicio |
| `StoreSweep` | 12 meses, + el último `DONE` siempre |
| `AuditLog`, `ExtractionRun`, `AllocationRun` | **no se purgan**: son el rastro, no la foto |
| **`BankStatement`, `BankStatementLine`, `BankReconciliation`, `BankMatchGroup` y el `File` original del extracto** | **no se purgan nunca** (O-22) |

**Conservación mercantil** (O-22): el art. 30 CCom obliga a conservar libros,
correspondencia, documentación y justificantes **seis años**, y los soportes de la
conciliación son justificantes; las bases imponibles negativas alargan la
comprobación a **diez** (art. 26.5 LIS). Por tanto: (a) el archivado en frío de E9
debe garantizar **legibilidad a seis años**; (b) `prune-runs.ts` **nunca** borra un
`File` referenciado por un `BankStatement`, con comprobación en el script y test;
(c) la política de `InvariantRun` es de auditoría interna y **no sustituye** la
conservación mercantil.

E7 entrega la política escrita y `scripts/prune-runs.ts` (operador,
`DATABASE_URL_MAINTENANCE`, por organización, simulación por defecto y `--apply`).
La **automatización** (cron y archivado en frío) es **E9**, fechada. Purgar es
`DELETE` sobre tablas append-only: el script levanta `FORCE` en su ventana y lo
restaura, con el test que vigila que ninguna tabla queda en `NO FORCE`.

### D4 — `ReportType.CASHFLOW` unificado, con `method` en `params`

`CASHFLOW_DIRECTO` y `CASHFLOW_INDIRECTO` se sustituyen por **`CASHFLOW`** con
`params.method ∈ {DIRECTO, INDIRECTO}`, que entra en `paramsHash` como cualquier
otro parámetro. Los dos valores viejos **no se borran del enum** (PostgreSQL no lo
permite sin recrear el tipo): quedan prohibidos para filas nuevas por un CHECK
`NOT VALID` que se valida al terminar la migración de datos.

La migración de datos **no va en SQL**: `params_hash` es el sha256 de la forma
canónica de `params`, y reimplementar `canonicalJson` en PL/pgSQL sería crear la
deriva de dos caminos que ADR-0011 corrigió. Va en
`scripts/migrate-cashflow-report-type.ts`, que usa **la misma función** que la
aplicación (`lib/ledger/report-run.paramsHash`), escribe su marca **antes** del
backfill (orden del runbook de E3) y actualiza también
`manual_review_flags.scope`.

### D5 — RLS en `users`, con políticas por rol

`users` pasa a `ENABLE` + `FORCE ROW LEVEL SECURITY`, aprovechando que las
políticas de PostgreSQL se pueden acotar **por rol**:

- **`app_auth`** (rol nuevo, `LOGIN`, `NOBYPASSRLS`, consumido sólo por
  `AUTH_DATABASE_URL` desde el adaptador de better-auth): `USING(true)` /
  `WITH CHECK(true)`. El camino de autenticación lee y escribe sin sesión, que es
  lo que necesita.
- **`app_runtime`**: `SELECT` de uno mismo y de quien comparte membresía; `UPDATE`
  sólo de la propia fila; `DELETE` prohibido por política `RESTRICTIVE`.

Coste conocido: exige **un segundo cliente Prisma** para better-auth (~10 h, tarea
T14). Si al implementarlo apareciera un obstáculo de fondo, **D5 se aplaza con su
justificación escrita** en vez de quedarse a medias — media RLS es peor que
ninguna, porque parece que protege.

### D6 — **(nueva en la ronda 2)** El esquema de la conciliación: grupos N-a-M, divisa, anclaje y el invariante de igualdad

Las cuatro observaciones bloqueantes que cambian la migración **M3**, más las dos
que cambian la definición de los invariantes. Todas caen en migraciones que hoy
son aditivas puras: incorporarlas **antes de T3** cuesta diseño; dejarlas para
después sería una segunda migración sobre tablas ya pobladas con datos bancarios,
que es la deuda que el §Estándar de calidad de `CLAUDE.md` prohíbe acumular.

**D6.1 · `BankMatchGroup`: la conciliación es N-a-M, no 1:1 (O-3).** El 1:1 no
puede representar una remesa de recibos (N apuntes contra un abono), una remesa de
pagos o confirming, una nómina liquidada con un cargo global, un descuento de
efectos (nominal − intereses `665` − comisión `626` contra el abono neto), una
devolución parcial de remesa (1-a-N) ni una transferencia que el banco parte en
principal y gastos. Con el modelo de la ronda 1 el usuario tenía dos salidas y las
dos eran peores que el problema: dejarlo `UNMATCHED` (I-E7-1 en FAIL permanente,
badge nunca) o `IGNORED` (el cuadre «cierra» con el saldo mal).

`BankMatchGroup { id, organizationId, bankAccountId, kind: SIMPLE|N_A_1|UNO_A_N|N_A_N,
note?, createdById, createdAt, unmatchedAt?, unmatchedById?, unmatchReason? }`;
`BankReconciliation` pasa a ser la **fila de pertenencia** (`groupId` obligatorio).
Un grupo `SIMPLE` tiene una línea y un apunte, y todo el diseño de la ronda 1 sigue
siendo su caso particular. Los dos índices únicos parciales **se conservan** —una
línea y un apunte pertenecen a lo sumo a **un grupo vivo**— y desconciliar es del
grupo, con motivo ≥ 10 caracteres. Invariante nuevo:

> **I-E7-11 · Cuadre del grupo.** Para todo grupo vivo,
> `Σ amountCents de sus líneas de extracto = Σ (debitCents − creditCents) de sus
> apuntes`, **tolerancia 0**. Con él, I-E7-1 sigue siendo exacta sin cambios: los
> grupos se cancelan igual que los pares.

**D6.2 · Divisa en la línea de extracto y cuadre en la divisa de la cuenta (O-5).**
`BankStatementLine` gana `currency` y `originalAmountCents` (registro 24 de la
Norma 43, que la ronda 1 decía parsear y no guardaba); `BankStatement` gana
`currency`, y la importación exige `statement.currency = bankAccount.currency`
rechazando el fichero entero si no coincide. **El cuadre de una cuenta en moneda
extranjera se hace en su divisa**, con tolerancia 0; el emparejamiento y el signo,
también. Invariante nuevo:

> **I-E7-12 · Coherencia divisa/EUR.** El saldo en euros de la cuenta = Σ de los
> contravalores históricos de sus apuntes; la diferencia con
> `saldo en divisa × tasa de cierre` es la **diferencia de cambio** pendiente de
> reconocer (NRV 11ª.2.2, a `768`/`668`) y se presenta **como tal**; a fecha de
> cierre sin asiento que la recoja, **WARN** con su importe. Regla negativa
> explícita: *una diferencia de cambio jamás aparece entre los pendientes de
> conciliación; si aparece, el cuadre se está haciendo en la divisa equivocada.*

E7 **mide y avisa**; el reconocimiento contable de la diferencia al cierre es E9.

**D6.3 · Anclaje de la cuenta (O-1).** `BankAccount` gana `reconciledFromDate` y
`reconciledOpeningBalanceCents`, fijados por un ADMIN al dar de alta la cuenta,
cotejados contra el saldo contable y no editables sin `AuditLog`. **Sin anclaje, o
con un hueco en la cadena de extractos (I-E7-6b), I-E7-1 sale `INFO`, nunca
`PASS`**: no se puede afirmar que un saldo cuadra si no se sabe desde dónde.

**D6.4 · La igualdad de importes es el invariante, y la tolerancia de fechas no lo
es (O-9, O-10).** I-E7-2 pasa a exigir
`bankLine.amountCents = journalLine.debitCents − journalLine.creditCents` con
signo, al céntimo y en la divisa de la cuenta —la ronda 1 dejaba pasar un punteo
manual de 100,00 € contra 1 000,00 €, que sólo afloraba como una diferencia sin
nombre—, y se **revalida también en el camino de escritura**, que es el que usa
una persona con prisa en un cierre. I-E7-4 queda subsumido y se conserva sólo como
evidencia legible del signo. En sentido contrario, **la tolerancia de fechas sale
de los invariantes**: `matchToleranceDays` es configuración editable y un check que
dependa de ella daría resultados distintos sobre el mismo `ledgerHash` y el mismo
`gitSha`, rompiendo P7 y haciendo que `diffRuns` concluyera `cause: "NINGUNA"` con
deltas. El desfase se **sella en el hecho** (`dateGapDays` en
`BankReconciliation`, inmune a cambios posteriores) y se expone como métrica
`DESFASE_FECHA_ALTO` (WARN), nunca FAIL.

**D6.5 · `configHash` (O-20).** `InvariantRun` gana `configHash` —sha256 de la
forma canónica de umbrales de revisión, `MAX_MATERIALIZED_ENTRIES`,
`matchToleranceDays` por cuenta, umbral de tránsito, umbral de materialidad de
ignorados y variante del plan—, que entra en la **clave de caché** y en el diff
(`cause` gana el valor `CONFIGURACION`). Sin él, bajar un umbral servía el barrido
cacheado justo cuando hay que rebarrer.

**D6.6 · El apunte de 0,00 € se importa (m2).** El CHECK de
`bank_statement_lines.amount_cents` es **`IS NOT NULL`**, **nunca `<> 0`**. Los
bancos emiten movimientos de importe cero —regularizaciones, anotaciones
informativas, un cargo y su reverso netos en el mismo registro— y rechazarlos
rompería justo lo que E7 usa para saber que el extracto está entero: el `lineNo`
quedaría con un hueco (**I-E7-5 FAIL**) y `lineCount` no coincidiría con el número
de apuntes declarado en el **registro 33** (**I-E7-6a FAIL**), todo ello por un
movimiento que el banco sí declaró. Se importan y nacen `IGNORED` con
`IgnoreReason.IMPORTE_CERO`, cuarta causa del vocabulario cerrado de D6 y **la
única que no exige evidencia**, porque la evidencia es el propio importe. No
alteran `Ue`, no mueven el cuadre y se cuentan aparte en I-E7-13, de modo que
nunca disparan el WARN de materialidad de ignorados.

**D6.7 · El corte es por fecha de operación (O-6).** Contablemente la fecha valor
no existe: es un dato financiero para intereses y descubiertos. El devengo del
cobro o del pago —y la pertenencia de un movimiento al periodo— es la **fecha de
operación**. Cortar por fecha valor mueve movimientos a través del cierre (una
operación de 30/12 con valor 02/01 saldría del ejercicio). `valueDate` se guarda,
se muestra y **queda prohibida en toda agregación de cuadre**; en la sugerencia
aporta un motivo secundario con puntuación menor, que informa y no decide.

## Alternativas descartadas

- **D1 · Dejar `integer` con un `CHECK` que tope el importe.** Convierte un
  desbordamiento silencioso en un error al postear, pero deja al producto sin
  poder registrar una operación legítima de su rango declarado.
- **D1 · Tabla nueva + copia + `RENAME`.** Más rápido en caliente y con el triple
  de riesgo sobre la fuente única de cifras (FK, triggers, `GRANT` de columna,
  políticas y `EXCLUDE` recreados a mano).
- **D2 · Dar el badge a todo informe cuyo periodo esté conciliado.** Conciliar el
  banco no acredita la clasificación de un gasto ni la analítica.
- **D2 · Conceder el badge enumerando los pendientes.** Es el anti-patrón de la
  spec §5: listar no es explicar.
- **D2 · Persistir el badge.** No podría retirarse cuando llega un extracto
  retroactivo con un movimiento de un periodo ya sellado.
- **D2 · Un badge nuevo, `conciliado`.** C5 fija cinco etiquetas «sin variantes»:
  añadir una sexta es cambiar la spec, no aplicarla.
- **D3 · No purgar nada** (contradice C1) y **purgar por número de filas** (pierde
  la garantía de «1 por mes histórico» y borra justo lo que se consulta tras un
  cierre).
- **D4 · Dejar los dos tipos** (duplica `scope`, caché y UI, y contradice
  ADR-0012) y **migrar los históricos en SQL puro** (exigiría un sha256 canónico
  en PL/pgSQL: dos implementaciones del mismo hash).
- **D5 · Dejar `users` sin RLS y compensar en la aplicación**: la única barrera
  sería el cuidado de quien escribe la query. **Dar `BYPASSRLS` al rol de
  autenticación**: el agujero que ADR-0009 cerró.
- **D6 · Mantener el 1:1 y resolver las remesas marcando `IGNORED`.** El cuadre
  «cerraría» con el saldo real mal y sin ningún check que lo dijera.
- **D6 · Modelar la remesa como un asiento único** para que el 1:1 valga. Obliga a
  contabilizar por conveniencia del software y destruye el detalle por cliente que
  el aging necesita.
- **D6 · Cuadrar en euros una cuenta en divisa.** La diferencia entre extracto y
  libros incluiría la variación de la tasa, que no es una partida en tránsito.
- **D6 · Reconocer la diferencia de cambio automáticamente** desde la
  conciliación. Es un asiento de cierre (NRV 11ª.2.2) y pertenece a E9; E7 la mide
  y avisa.
- **D6 · La tolerancia de fechas como invariante.** Deja el barrido en FAIL
  perpetuo por un cheque de 40 días sin error contable alguno, y hace que
  configuración editable mueva checks ya sellados.
- **D6 · Cortar por fecha valor**, o guardar una sola fecha. Mueve movimientos a
  través del cierre.
- **D6 · Rechazar el apunte de 0,00 €** con un `CHECK amount_cents <> 0` (m2).
  Parece higiene y es lo contrario: deja un hueco en el `lineNo` y descuadra el
  cotejo con el registro 33, de modo que el propio invariante que vigila la
  integridad del extracto fallaría por un movimiento que el banco declaró.
- **D6 · Una sola columna `reference`.** La referencia 1 del registro 22 es la que
  identifica la remesa; colapsarla deja el emparejamiento N-a-1 sin ninguna clave
  determinista con la que agrupar, a merced del texto libre.

## Consecuencias

- **D6 bloquea T3 (M3)**, que es camino crítico: sin firma no se escribe la
  migración de conciliación. D1 bloquea T4; D2, T6; D3/D4, T15; D5, T14. El resto
  de E7 —el barrido, la pestaña, el split, el almacén— **no depende de esta firma**
  y puede arrancar.
- Obliga a actualizar `docs/MODELO-DATOS.md` (tipos del diario, `ReportType`,
  bloque E7 con las seis tablas), `.claude/skills/fiabilidad/SKILL.md` (la regla
  del badge P6 —lo único de C5 que hoy no está escrito en el producto—, los cuatro
  motivos de sello nuevos e I-E7-1…17) y `docs/ARQUITECTURA.md` §3 y §6.
- Introduce una variable de entorno (`AUTH_DATABASE_URL`) y un rol de base de
  datos (`app_auth`), con su entrada en `.env.example`, `scripts/dev-db-setup.sh`,
  `docker-compose` y el runbook del preview.
- **Seis `AccountKey` en juego, de las que sólo tres son nuevas** (m1):
  `OrganizationAccountMap` se amplía con `INTERESES_DEUDAS` (662),
  `OTROS_GASTOS_FINANCIEROS` (669) e `INTERESES_DESCUENTO_EFECTOS` (665);
  `COMISIONES_BANCARIAS` (626) y las dos de diferencias de cambio
  (`DIFERENCIA_CAMBIO_NEGATIVA` 668 y `DIFERENCIA_CAMBIO_POSITIVA` 768) **ya
  existen** desde E2/E8 y no se tocan. `SourceType` gana `BANK_RECONCILIATION`.
- Después de D4, un `ReportRun` histórico de cashflow **cambia de clave**: el
  `paramsHash` recalculado no es el que tenía. El histórico sigue siendo legible y
  auditable (el `result` no se toca), pero la clave de reutilización no coincide
  con la de antes de la migración; queda anotado en el script y en `ESTADO.md`.
- El coste de E7 sube de 301 h (ronda 1) a **400 h** por D6 y las observaciones
  importantes. Es el precio de que el cuadre exista de verdad: con el diseño de la
  ronda 1, la pieza contable central de la épica no habría funcionado en ninguna
  empresa real.
