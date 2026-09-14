# E9 — Revisión de código (`revisor-codigo`)

**Diff revisado:** `git diff 51608bb...HEAD` (17 commits, b054d42 … 98e89cc) ·
158 ficheros, +119 689 / −124 · **Fecha:** 2026-09-14

**Verificación ejecutada (todo en verde):** `lint` 0 errores (12 avisos
preexistentes, ninguno en ficheros de E9) · `test` 96/96 ficheros, 1 968 pasan,
11 saltados (todos `skipIf(!TEST_DATABASE_URL)`, patrón heredado) ·
`test:integration` 131/131, 2 514 pasan · `test:integration:rls` 11/11, 185
pasan · `build` OK. No se ejecuta `e2e` (indicado).

## Hallazgos

| # | Fichero:línea | Severidad | Problema | Sugerencia |
|---|---|---|---|---|
| 1 | `models/fiscal-years.ts:486` | **BLOQUEA** | **El paso 12 de O-17 no existe.** `closeFiscalYear` postea T-26, T-27 y T-28 y nada más; `closeFiscalYearE9` busca `templateCode: "RECLASIFICACION_VENCIMIENTOS"` **en el ejercicio N** —que es T-32 **misma**, no su contra-asiento— y la sella como `reclassEntryId`, devolviéndola además como `reclassReversalEntryId`. La columna `closing_runs.reclass_reversal_entry_id` existe y **nadie la escribe** (sólo aparece en el cliente Prisma generado). Consecuencia contable de D5.6/O-8: la reclasificación queda «pegada» en N+1, los pagos del año siguiente cancelan `173` en vez de `523` y la base del FIFO queda contaminada | Postear el contra-asiento de T-32 con `voidEntryTx`/`reversesEntryId` dentro de la **misma** transacción que T-28, con `entryDate` = primer día de N+1 y **después** de la apertura (nº 2 de N+1), sellarlo en `reclassReversalEntryId`, y añadir el aserto al test de los doce asientos |
| 2 | `models/closing.ts:1256` | **DEBE** | `aperturaEntryId: null` está **cableado a `null`**: la apertura vive en N+1 y `byTemplate` sólo mira `fiscalYearId = N`. Tras un cierre correcto el paso `CIERRE_APERTURA` sale `WARN` («Cierre incompleto: sólo hay regularización, cierre») **para siempre**, y como el WARN mueve el sello (`closingSeal`), un ejercicio bien cerrado queda permanentemente en `REQUIERE_REVISION` | Leer `aperturaEntryId` del `ClosingRun` sellado (la columna ya se escribe en `closeFiscalYearE9`), o buscar `APERTURA_EJERCICIO` en el ejercicio siguiente |
| 3 | `tests/integration/` (ausente) | **DEBE** | **No existe `perf-closing.test.ts`.** Los **ocho** techos de §9 (recurrentes < 600 ms, cuadro de 300 activos < 400 ms, `/reports/vat` < 800 ms, checklist < 2 000 ms con **una** transacción, cierre < 45 s…) no se miden en ninguna parte. El estándar de calidad de CLAUDE.md exige medir en ms sobre el fixture completo, y `ejercicio-completo-v2` ya existe (T20) | Cerrar T23 con el fichero y las dos métricas de E6-perf (ms y conexiones por petición) antes de dar E9 por terminada |
| 4 | `models/closing.ts:926` | **DEBE** | **N+1 dentro de la transacción del checklist**, contra §9 («`readClosingInput` en una consulta por bloque, sin N+1»). `allocationRunStaleness` se llama **run a run**; su memoización por transacción se indexa por `(periodStart, periodEnd)` y `(periodKind, periodEnd)`, así que con runs **mensuales** falla siempre: ≈ 4-5 consultas por run (ejercicio, `computeLedgerHash`, specs de reglas, líneas previas), es decir **≈ 50 consultas** con doce runs, más el resto de bloques | Derivar el `STALE` de los runs sellados en **una** consulta agregada (hashes por periodo en un solo `GROUP BY`), o al menos medirlo en el perf test del punto 3 |
| 5 | `app/(app)/ledger/closing/actions.ts:340` y `:749` | **DEBE** | `postClosingStepAction` llama a `postEntryTx` **sin `idempotencyKey`** y no hay índice único que cubra estos asientos. Un doble envío duplica T-31 (valor actual) y T-25 (impuesto) —T-30 y T-32 se autoprotegen recalculando Δ=0, los otros dos no—, y con T-25 duplicado `6300` queda al doble y `473` sobrecancelada, que es justo lo que O-26 y la reversión de O-21 existen para evitar | Derivar una clave determinista (`cierre:<fiscalYearId>:<step>:<templateCode>`) y pasarla a `postEntryTx`, que ya resuelve la reentrada por clave |
| 6 | `models/fiscal-years.ts:451`, `:474`, `:484` | **DEBE** | **La atomicidad de los doce asientos no es «todo o nada»**: `closeFiscalYearE9` usa **tres transacciones** (guardia → `closeFiscalYear` → sellado del run). Si la tercera falla, el ejercicio queda `CLOSED` con los doce meses bloqueados y el `ClosingRun` en `COMPROBADO`, sin `closedAt` ni ids sellados: un cierre sin sello. Los pasos 1-8, además, son transacciones de usuario independientes (aceptable por diseño), pero entonces el contrato «doce asientos en una transacción» de §9 no es el que se implementa | Sellar el `ClosingRun` **dentro** de la transacción de `closeFiscalYear` (o dejar el cierre del ejercicio como último acto de esa misma transacción), y corregir §9 para que describa el alcance real |
| 7 | `tests/integration/e9-cierre-completo.test.ts:554` | **DEBE** | El test «los doce asientos de O-17 se recorren» **sólo comprueba que existen las doce columnas** del `ClosingRun` («esté posteada o no. Ese es el contrato»). Nueve de las doce posiciones no se postean en ningún test: RECC, prorrata, valor actual, diferencias de cambio, reclasificación y su contra-asiento. Es lo que deja pasar el hallazgo 1. Además el propio test siembra `473` por 50 000 c diciendo que «T-25 tiene que cancelarlo» y **nunca comprueba `balance("473") === 0`** | Un caso con posiciones en divisa, deuda con vencimientos y prorrata que recorra las doce posiciones de verdad, y el aserto de `473` que el comentario promete |
| 8 | `docs/ESTADO.md` (bloque «Anotado para T26») | **DEBE** | **Interés implícito 442 817 vs 454 133.** Dos fuentes selladas discrepan en una cifra que va a `662` (PyG, nivel BAI): el criterio 22 de §12 y el fixture `docs/design/fixtures/valor-actual-esperado.json`. `cierre-e9.test.ts` sigue al criterio, de modo que **el fixture sellado contradice al motor**. No es documental: una de las dos es un error de cálculo, y hasta resolverlo I-E9-19 (`descuento inicial = Σ intereses implícitos`) se está verificando contra una referencia dudosa. Queda sólo **anotado**, sin fecha ni épica | Resolver con `experto-contable` **antes** del merge de E9 (rehacer el generador Python y comparar byte a byte), o fechar la deuda con épica de cierre explícita, como exige CLAUDE.md |
| 9 | `app/(app)/ledger/closing/actions.ts:228` | **DEBE** | `runClosingChecklistAction` es `Role.VIEWER` pero **escribe**: `createClosingRunTx` inserta una fila en `closing_runs` (append-only) y su `AuditLog`. Un VIEWER puede así generar runs indefinidamente y ensuciar la traza; §10 le concede «ver el checklist», no crearlo | Separar lectura (`getClosingRunAction`, VIEWER) de la ejecución que persiste (EDITOR/ADMIN), o calcular el checklist sin persistir cuando el actor es VIEWER |
| 10 | `lib/closing/vat.ts:893` | PUEDE | `capitalGoodsGuard` devuelve `blocking: false` en la rama WARN, contradiciendo el catálogo (`BIENES_DE_INVERSION` es uno de los nueve). El campo es **inerte** —`fromMotor` sólo copia `status`, `evidencia` y `query`, y el `blocking` real sale de `CLOSING_STEPS`—, pero quien lea el motor concluirá lo contrario | Quitar `blocking` del retorno del motor o fijarlo siempre a `true`; el catálogo es la única fuente |
| 11 | `lib/closing/reclass.ts:171-178` · `lib/closing/checklist.ts:104` | PUEDE | Las dos discrepancias de cardinal siguen **abiertas en los documentos canónicos**: §4.5/D5.2 dicen «23 pares» y se implementan **22**; §4.8/D9.3 dicen «41 pasos» y se implementan **43** (los que su propia tabla enumera). El código elige bien —la lista enumerada, verificable cuenta a cuenta— y lo deja escrito, pero ADR-0016 y el diseño siguen diciendo otra cosa | Corregir los cardinales en `docs/design/E9-cierre-recurrentes.md` y ADR-0016 en T26 (los nueve bloqueantes sí coinciden y no hay nada que decidir en ellos) |
| 12 | `components/closing/entry-preview.tsx:40-45` · `components/assets/entry-draft-preview.tsx:24` | PUEDE | Σ Debe / Σ Haber se suman **en cliente** para pintar el cuadre. Está documentado como «feedback visual» de líneas que compone el servidor en `dryRun`, y la partida doble la imponen el motor y el trigger, pero es aritmética contable en el navegador | Devolver `debeCents`/`haberCents` ya sumados en el `dryRun` y que el cliente sólo compare |

## Lo que se ha comprobado y está bien

- **Migraciones M1…M6 + `20260921090000`.** Ninguna sentencia exige SUPERUSER;
  `ALTER TYPE … ADD VALUE` va **sola** en M1; **ninguna migración aplicada se ha
  editado** (`git log` por fichero: un solo commit cada una, y el arreglo de la
  forma canónica llega como migración **nueva y aditiva**); todos los backfills
  van bajo `NO FORCE` → DML → `FORCE` con la marca escrita antes y verificación
  final de que ninguna tabla queda en `NO FORCE`. `app.iva_period` es
  **IMMUTABLE** de verdad (`extract` + `lpad`, no `to_char`), con `REVOKE ALL …
  FROM PUBLIC` y `GRANT EXECUTE` acotado; la forma canónica **`AAAA-Qn`** es
  coherente en BD (función, trigger, CHECK), motor y fixtures, y la migración lo
  autocomprueba (`app.iva_period(2026-08-14) = '2026-Q3'`).
- **Append-only real.** `REVOKE UPDATE, DELETE … FROM app_runtime` **explícito**
  en las cuatro tablas antes de cualquier `GRANT`, con el comentario que explica
  por qué el `ALTER DEFAULT PRIVILEGES` de la base lo haría decorativo;
  `closing_runs` y `vat_settlements` avanzan por `GRANT UPDATE` **de columna**.
  `entry ⇔ GENERADA` lo garantiza la BD: `CHECK (("entry_id" IS NOT NULL) =
  ("status" = 'GENERADA'))`, y T12 invierte el orden (asiento primero) para
  cumplirlo en todo momento sin `UPDATE`.
- **Motor puro.** `lib/closing/**` y `lib/recurring/**` están en el guard
  (`.claude/hooks/guard.sh:25-26`) y en ESLint (`eslint.config.mjs:113-124`); ni
  un `Date.now()`, `new Date()`, `prisma`, `fetch` ni `Math.random` en los once
  módulos. Las conversiones `BigInt → Number` validan con `Number.isSafeInteger`
  antes de operar y el cociente nunca supera la magnitud de la entrada.
- **`fixedAssetId` en el INSERT** (`models/ledger.ts:1087`), filtrado por
  `lineCarriesAsset` con la misma lista que el CHECK de M2 — la vía del `UPDATE`
  posterior era imposible contra la tabla append-only.
- **Orden O-17** completo y explícito en `CLOSING_ENTRY_ORDER`; reapertura sólo
  con `BORRADOR` y mensaje **con salida** (NRV 23ª), reversión T-28 → T-27 →
  T-26 → **T-25** en una transacción, pasos 5-7 en `PENDIENTE_RECOMPUTO`,
  numeración **viva** (M6). `dryRun` recorre **el mismo** `buildFromTemplate`.
- **Checklist**: 43 pasos en nueve bloques y **nueve** bloqueantes exactos;
  ningún bloqueante puede salir `NA` (la decisión de `RECC_DEVENGADO_31_12` y de
  `capitalGoodsGuard` está razonada y probada); `closingSeal` se calcula
  **después** de los motivos (H-4 de E7).
- **IVA**: casilla 77 entra por la 69 (`69 = 66 + 77 − 67`), la 70 se descuenta
  en la 71 (`71 = 69 − 70`, = importe de T-23); prorrata con `ceil` en aritmética
  entera con `BigInt` y tope 100; `capitalGoodsGuard` con ventana 4/9 años,
  umbral 300 506 c y desviación > 1 000 bps.
- **FX**: universo por `LedgerAccount.isMonetary`, tasa del **último día
  publicado** dentro de la ventana con la `rateDate` sellada, y
  `originalAmountCents = 0` en la línea que mueve la partida.
- **Valor actual** como **valoración inicial** con los tres casos A/B/C, tipo
  mensual y aritmética entera escalada; **distribución** con capital derivado del
  saldo de `100` y `DECLARADO` sólo como contingencia con WARN.
- **Roles y traza**: las seis `actions.ts` pasan por `withOrg` con el rol de §10
  (ADMIN para postear, cerrar, reabrir, liquidar y distribuir), validan con
  `zod` (`safeParse`) y el `AuditLog` lo escriben los modelos. Una transacción
  por petición en todas ellas.
- **Tests no debilitados**: los cuatro ficheros existentes que cambian actualizan
  cardinales (28→37 plantillas, 61→80 `AccountKey`, 7→8 familias) y **añaden**
  asertos; no hay `skip`, `todo` ni `fixme` nuevos.
- **UX**: `loading.tsx` y `error.tsx` en las cinco rutas nuevas; sello, cuadre y
  evidencia con enlace al asiento en el asistente.

## Veredicto

**CAMBIOS REQUERIDOS** — un bloqueante (hallazgo 1: el contra-asiento de la
reclasificación, paso 12 de O-17, no se postea y la API declara lo contrario),
ocho DEBE y tres PUEDE. No hay Nivel 2 sin ADR: ADR-0016 está APROBADO y cubre
D1–D12. La suite completa está en verde, pero el hallazgo 7 explica por qué eso
no basta: el test del cierre completo no ejercita nueve de las doce posiciones.
