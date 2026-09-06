# E5 — Revisión de código (liquidación de CECOs)

> Rol: `revisor-codigo`, contexto limpio. Diff revisado: `git diff ab9fb99...HEAD`
> (f57d6ee backend · 7d6d213 UI · 17b8fe9 fixes) — 39 ficheros, +9 853 / −59.
> Fuentes: `CLAUDE.md` (§Estándar de calidad), `docs/design/E5-liquidacion.md`,
> `docs/design/E5-validacion-liquidacion.md`, `docs/adr/0013-liquidacion-cecos.md`,
> `docs/ESTADO.md`. No se ha usado el razonamiento del autor.
>
> **Veredicto: CAMBIOS REQUERIDOS** (3 BLOQUEA · 7 DEBE · 7 PUEDE).
> No es `BLOQUEADO`: el cambio es Nivel 2 y **ADR-0013 está APROBADO** y cubre
> las cinco decisiones del motor (E5-D1/D2/D3, `MANUAL`, `HOURS`/`HEADCOUNT`).

## 0. Verificación ejecutada

| Comprobación | Resultado |
|---|---|
| `npm run lint` | **0 errores**, 14 warnings preexistentes (`hooks/**`, `components/ui/**`) |
| `npm run test` | **814 ✓**, 11 skipped (todos `describe.skipIf(!TEST_DATABASE_URL)`, preexistentes) |
| `npm run test:integration -- tests/integration/e5` | **22 ✓** |
| `npm run test:integration:rls` | 126 ✓ / **1 ✗** en `rls-strict.test.ts:389` (`app_maintenance` ve 0 organizaciones). **Ajeno a E5**: la BD de test está vacía de organizaciones; `e5-tenant.test.ts` pasa entero |
| Test byte a byte contra `docs/design/fixtures/liquidacion-esperada.json` | existe y pasa (`lib/analytics/allocate.test.ts:634`, total `1_075_524` en :505) |
| Pureza de `lib/analytics/allocate.ts` | sin `Date.now()`, `new Date()`, `prisma`, `fetch`, `Math.random`. Aritmética entera. **Correcto** |
| Migraciones aplicadas editadas | ninguna: sólo se añade `20260910100000_e5_allocations` |
| e2e (`tests/e2e/liquidacion.spec.ts`, 535 líneas) | **no ejecutados** en esta revisión (requieren `npm run dev`) |

## 1. Tabla de hallazgos

| # | Fichero:línea | Sev. | Problema | Sugerencia |
|---|---|---|---|---|
| 1 | `lib/analytics/allocate.ts:584` + `forms/allocations.ts:134` + `components/analytics/allocation-rule-form.tsx:240,304` | **BLOQUEA** | **Regla inerte y silenciosa, prohibida por ADR-0013 D4.** Con `targetKind = COST_CENTERS` o `BUSINESS_LINES`, `driverWeights` toma los pesos SIEMPRE de `rule.targets` (:584), pero el zod (:134) **exige `targets = []`** para todo driver que no sea `FIXED_PERCENT`/`MANUAL`. Resultado: `rows = []` → `allocate.ts:920` hace `continue` **sin emitir warning**; el CECO no liquida un céntimo y nada lo dice. Es alcanzable desde la UI en dos clics (driver por defecto `DIRECT_COST_SHARE`, se cambia sólo el destino a «Centros de coste (cascada)»; el selector de targets sólo aparece con `FIXED_PERCENT`/`MANUAL`) | Rechazar la combinación en `validate()` de `allocate.ts` con un `AllocationErrorCode` nuevo (p. ej. `TARGETS_REQUIRED`) **y** en el zod, y no dejar que el formulario ofrezca esos `targetKind` con drivers calculados. En ningún camino puede quedar una regla que reparta 0 € en silencio |
| 2 | `models/reports.ts:428-434` y `:276`; `lib/ledger/report-run.ts:72-79` | **BLOQUEA** | **`allocationRunSetHash` no llega al `ReportRun`: ADR-0013 D3 y criterio 17 incumplidos.** `getOrCreateReportRun(PYG_ANALITICA)` llama a `getAnalyticPnl` **sin** `withAllocations`, `analyticsKeyOf` sigue recibiendo `allocationRunId` (nunca el hash del conjunto) y la columna `report_runs.allocation_run_set_hash` que crea la migración **no la escribe ningún camino de producción**. Consecuencia: liquidar **no caduca** el `PYG_ANALITICA` sellado, y el informe persistido/exportado del periodo sigue siendo el NO imputado mientras la pantalla muestra el imputado — dos verdades para el mismo periodo, que es lo que la capa de fiabilidad existe para impedir | Pasar `withAllocations` al `ReportRunRequest` (en `paramsHash`), propagarlo a `getAnalyticPnl`, escribir `allocationRunSetHash` en la fila y renombrar el parámetro de `analyticsKeyOf` a `allocationRunSetHash`. Test de criterio 17 en los dos sentidos (analíticos caducan, `BALANCE`/`PYG`/`CASHFLOW` no) |
| 3 | `lib/analytics/invariants.ts:384-406`; `lib/ledger/invariants.ts:484`; `models/margins.ts:194` | **BLOQUEA** | **I5 y los doce `I-E5-*` no se ejecutan en ningún camino de producción.** `runAnalyticInvariants` sólo lanza I4 e I-E4-*; `checkAllocationInvariants` no lo llama nadie fuera de los tests (`grep` sobre `app/`, `models/`, `lib/`, `scripts/`). `models/margins.ts:194` **aparenta** cablearlos (`...(withAllocations ? { allocations } : {})`) pero `runAnalyticInvariants` ignora la propiedad. `scripts/run-invariants.ts` no aporta el bloque `allocations`, así que `validacion.json` nunca los contiene (T8 a medias). I4 **sí** se evalúa sobre la matriz imputada (`AnalyticsInvariantInput.allocations`, :51), pero el cuadre de la liquidación (I5.a/b/c, tolerancia 0) no se comprueba en tiempo de ejecución | Componer el bloque `allocations` (reglas, `balances`, runs) en `models/margins.getAnalyticPnl` y en `getOrCreateReportRun`, pasarlo a `runInvariants`, y volcarlo en `scripts/run-invariants.ts`. Sin esto, el sello «comprobado» de la PyG imputada no acredita I5 |
| 4 | `forms/allocations.ts:196-203` | DEBE | `expectedHashes` es `.nullish()`: `sealAllocationRunTx` sólo comprueba los tres sellos **si el cliente los manda**. La garantía del criterio 14 («no persiste lo aprobado, responde `LIQUIDACION_DESFASADA`») depende de que el navegador colabore. La UI los manda (`allocation-preview-table.tsx:100`), pero el contrato de la acción no puede apoyarse en eso | Hacerlo obligatorio en el schema; la simulación es obligatoria por ADR-0013 D5 |
| 5 | `prisma/migrations/20260910100000_e5_allocations/migration.sql:451-477` y `:516` | DEBE | **Versionado con un agujero**: `allocation_rules_immutable_when_used` sólo protege `allocation_rules`. `allocation_rule_targets` tiene `GRANT … UPDATE` (:516) y **ningún trigger** impide cambiar `percent_bps` / `amount_cents` / el destino de una regla que ya emitió líneas. Hoy ningún código lo hace (el versionado crea regla nueva), pero la barrera de BD que el diseño exige no existe y el «el pasado no cambia» deja de ser demostrable | Extender el trigger a `allocation_rule_targets` (INSERT y UPDATE) consultando si la regla padre tiene `allocation_lines`, con su test en `e5-tenant.test.ts` |
| 6 | `migration.sql` (falta el bloque 9) vs. `docs/MODELO-DATOS.md:105,142` y `docs/adr/0013-...:83` | DEBE | **Deuda O-A6 declarada CERRADA sin cerrarla.** El diseño §2.3 bloque 9 y T17 exigían los índices únicos parciales de `budgets` + el `CHECK` de exclusividad; la migración **no menciona `budgets`** (no existe la tabla todavía). Los documentos ya afirman «O-A6 queda CERRADA en E5», así que la deuda desaparece del seguimiento sin haberse resuelto — justo lo que el §Estándar de calidad prohíbe | O reponer el bloque 9 (o dejarlo explícitamente para la épica que crea `Budget`, E10) y **corregir** `MODELO-DATOS.md` y la línea 83 del ADR: una deuda sólo se marca cerrada cuando hay SQL que la cierra |
| 7 | `tests/integration/perf-pages.test.ts:58,229-271` | DEBE | **Criterio 20 no medido.** Sólo hay el techo genérico `MAX_MS = 1500` y dos cargadores nuevos (`/analytics/allocations` y `/runs`). Faltan los dos umbrales del criterio: liquidación anual del fixture **< 400 ms** y **PyG analítica IMPUTADA < 800 ms** — de hecho no hay ningún cargador que construya la matriz con `withAllocations: true`, así que el camino nuevo más caro no se mide | Añadir el cargador `/analytics/pyg?imputaciones=si` y un test de tiempo de `sealAllocationRunTx` sobre los 17 periodos, con los umbrales del diseño |
| 8 | `models/allocations.ts:984-1028, 1045-1061`; `models/margins.ts:getAllocationCellDetail` | DEBE | **Sin agregados SQL** (§Estándar de calidad, riesgo R5 del diseño). `readAllocationLines` trae **todas** las líneas del conjunto de runs y además `project`, `businessLine` y `costCenter` **completas en cada llamada**; la matriz sólo necesita `Σ` por `(fuente, columna, nivel)`. `getAllocationCellDetail` vuelve a llamar a `getAppliedAllocations` (lectura completa) **sólo para obtener los `runIds`**. Con los 40 000 registros que el propio diseño contempla, esto materializa el reparto en memoria | Agregar por SQL (`GROUP BY source_cost_center_id, target_*, margin_level`) para la matriz, y una consulta de `runIds` sola para el drill-down |
| 9 | `app/(app)/analytics/allocations/actions.ts:145-152` + `models/allocations.ts:892-906` | DEBE | **N+1 en `/analytics/allocations/runs`**: por cada run `SEALED` se llama a `allocationRunStaleness` → `loadRunContext`, que recalcula `computeLedgerHash` y relee las reglas. Sólo se memoiza el contexto del ejercicio (`fiscalYearContextCache`). Con los 17 runs del fixture son ~34 consultas por render, y el propio test de perf lo reconoce como «la pantalla con más riesgo de N+1» sin medirlo aparte | Calcular los sellos de todos los runs del ejercicio en una pasada (un `ledgerHash` por periodo distinto, reglas una sola vez) o memoizar por `(periodStart, periodEnd)` |
| 10 | `docs/ESTADO.md:145` | DEBE | **Deuda nueva sin anotar.** `ESTADO.md` sigue diciendo «SIGUIENTE: /epica E5» y no recoge nada de lo que el riesgo R9 del diseño se comprometía a anotar: `MIXED` y `DRAFT` como contrato sin uso, la matriz imputada sin agregado SQL (#8), el N+1 de `/runs` (#9) y el grafo de cascada no entregado (#16). El §Estándar de calidad manda que el revisor bloquee si una épica añade deuda sin épica de cierre | Anotar cada punto en `ESTADO.md` con su épica de cierre antes de dar E5 por cerrada |
| 11 | `lib/analytics/allocate.ts:231-233` | PUEDE | `hamilton` calcula `abs * w.weight` en coma flotante. Con importes y bases realistas de una empresa de 10 M€ el producto supera 2^53 (p. ej. 25 M c × 700 M c = 1,75e16) y el **resto** (`abs*w − q*total`) se calcula por diferencia de dos dobles enormes: queda cuantizado a múltiplos de ~256, así que los desempates dejan de ser los reales. Verificado: la **suma sigue siendo exacta** y el reparto es determinista (400 000 casos aleatorios de hasta 5 M€ × 20 M€: ningún remanente negativo), pero el céntimo de remanente puede caer en el receptor equivocado | Hacer el producto y el resto en `BigInt` (el cociente cabe siempre en `Number`), o añadir la guarda `isSafeInt` que ya usa `lib/money.ts:132` |
| 12 | `lib/analytics/allocate.test.ts:756,761` | PUEDE | Dos bytes **NUL (0x00)** literales usados como separador dentro de un template y de un `split`. `grep`/`ripgrep` clasifican el fichero como binario y **lo saltan en silencio**: cualquier búsqueda o guarda basada en texto (incluida esta revisión, al principio) deja de ver 878 líneas de test | Usar `` o `"|"` como separador |
| 13 | `models/allocations.ts:404`; `forms/allocations.ts:127`; `lib/analytics/allocate.ts:738,758` | PUEDE | `toFixed(2)` fuera de `lib/money.ts`. Son mensajes de porcentaje (bps/100), no dinero, así que no rompen la regla en su espíritu, pero el checklist es literal y el patrón se copia | Un helper `formatBps` (ya existe en `components/analytics/types.ts`) o `Intl.NumberFormat` |
| 14 | `components/analytics/allocation-rule-form.tsx:140` y `components/analytics/allocation-rules-table.tsx:204` vs. el comentario de `allocation-rule-form.tsx:44` | PUEDE | El comentario afirma que la conversión a puntos básicos «ocurre en el servidor (`ui-actions.ts`, `lib/money.parseCents`)» — y así es para lo que se persiste (`ui-actions.ts:62`) — pero el cliente hace además `Math.round(Number(texto.replace(",", ".")) * 100)` para la banda de Σ. Es coma flotante en el navegador sobre la cifra que mueve dinero entre columnas; `Math.round` lo salva hoy | Reutilizar el mismo parser en cliente y servidor, o pedir la Σ al servidor. Y corregir el comentario, que hoy no describe el código |
| 15 | `app/(app)/analytics/allocations/actions.ts:126` | PUEDE | `previewAllocationAction` es un dry-run de rol `VIEWER` pero abre `runLedgerTransaction` (transacción de escritura) | `tenantTransaction(..., { readOnly: true })`, como el resto de lecturas |
| 16 | `components/analytics/` (falta `allocation-cascade-graph.tsx`) | PUEDE | El diseño §6/T11 pide el «diagrama de cascada (grafo de aristas fuente → CECO) con el orden de ejecución numerado» en `/analytics/allocations`. No se ha entregado; la pantalla lo sustituye por un párrafo explicativo (`page.tsx:127`) | Entregarlo o retirarlo del diseño y anotarlo en `ESTADO.md` (ver #10) |
| 17 | `migration.sql:52` vs. `docs/design/E5-liquidacion.md:130` | PUEDE | La implementación usa `UNIQUE (organization_id, code, valid_from)` + `EXCLUDE` de vigencias; el diseño escribió `@@unique([organizationId, code])`, que **habría impedido versionar**. La implementación es la correcta: es el diseño el que hay que corregir | Corregir §2.2 del diseño para que el documento no contradiga al código |

## 2. Checklist del rol

- [x] **Dinero en `Int` céntimos**: todo el motor y el esquema en céntimos enteros; sin `Float`, `parseFloat` ni `Decimal`. Salvedades menores: #13 y #14.
- [x] **Tenant**: las cuatro tablas llevan `organization_id`, entran en `TENANT_MODELS` (`lib/db.ts:116-120`) y todo acceso pasa por `tenantDb`/`tenantTransaction`. Ningún `findUnique({ where: { id } })` suelto: se usa `findFirst` bajo el cliente de tenant. FK compuestas `(organization_id, id)` en las seis relaciones. `$queryRawUnsafe` de `getAllocationCellDetail` va **parametrizado** (`...params`), sin interpolación.
- [x] **`lib/analytics/allocate.ts` puro**: sin `Date.now()`, IO, Prisma ni LLM; aritmética de fechas por cadenas. El `new Date()` de la reversión se decide en el borde (`actions.ts:360`), como manda el diseño.
- [x] **Asientos**: la liquidación **no toca `journal_lines`** (ADR-0004). Nada se borra: `REVOKE DELETE` + políticas `RESTRICTIVE … USING (false)` en las cuatro tablas; `allocation_lines` sin `UPDATE`; `allocation_runs` con `GRANT UPDATE` de cinco columnas + trigger espejo.
- [x] **Ninguna cifra contable en cliente ni en prompt**: la matriz y el reparto se calculan en servidor (salvedad #14, que es presentación).
- [x] **Migraciones**: aditiva, nombrada, ninguna aplicada editada, `enforce_tenant_rls` sobre las cuatro tablas, `NO FORCE → UPDATE → FORCE` sólo donde hay DML (`report_runs`), guarda final de `NO FORCE`. **Falta el bloque 9** (#6).
- [~] **Tests**: 22 de integración, 350 líneas de RLS, 878 de unitarios, test de propiedad de Hamilton y byte a byte contra el fixture. Ninguno debilitado; ningún `skip` nuevo. **Pero** faltan los umbrales del criterio 20 (#7) y los e2e no se han ejecutado aquí.
- [x] **Seguridad**: zod en `forms/allocations.ts` para las nueve acciones, `withOrg(<rol>)` en todas, matriz de roles exacta al diseño (VIEWER lee y simula · ADMIN política de reglas · EDITOR sella y revierte con motivo ≥ 10).
- [x] **Trazabilidad**: `AuditLog` en la misma transacción para `create`/`supersede`/`close`/`seal`/`reverse`, con `before`/`after` y `reason`; `driverBase`/`driverBaseTotal`/`driverShareBps`/`fallbackApplied`/`eligibilityReason` en cada línea; los cuatro sellos en el run.
- [x] **Nivel 2 con ADR**: ADR-0013 APROBADO cubre E5-D1/D2/D3, `MANUAL`, el rechazo de `HOURS`/`HEADCOUNT` y I5 a tolerancia 0.
- [x] **Legibilidad**: identificadores en inglés, dominio en español, sin `any`, sin código muerto salvo lo señalado en #2 y #3.

## 3. Ejes específicos de esta épica

| Eje | Veredicto |
|---|---|
| Reglas versionadas | Correcto en la app (`supersedeAllocationRuleTx` cierra y crea, nunca edita) y en BD para `allocation_rules`; **agujero en `allocation_rule_targets`** (#5) |
| Runs inmutables | Correcto: sin `UPDATE` de `allocation_lines` (GRANT + política + test 42501), `allocation_runs` append-only salvo las cinco columnas, índice único parcial `WHERE status = 'SEALED'`, sustitución antes del INSERT del nuevo run |
| RLS / tenant | Correcto: `app.enforce_tenant_rls` × 4 + `TENANT_MODELS` + suite `e5-tenant.test.ts` en verde |
| Determinismo | Correcto: motor puro, orden `(priority, code)`, niveles ordenados alfabéticamente, byte a byte contra el fixture. Matiz de precisión en #11 |
| Hamilton con desempate por código | Correcto (`allocate.ts:239-241`), y deliberadamente distinto de `splitLargestRemainder` |
| «El nivel viaja con el importe» | Correcto y bien defendido: `marginLevel` en la línea con `CHECK`, Δ de suma cero por nivel (`lib/analytics/margins.ts`), I-E5-6 con test |
| Caché / hashes | `dimensionsHash` ≠ `analyticsHash` bien separados y no circulares; `allocationRunSetHash` correcto en `lib/analytics/hash.ts` y en `models/margins.ts`. **No llega al `ReportRun`** (#2) |
| Rendimiento | Índices por periodo y por destino correctos; una transacción por petición respetada; lecturas en serie. **Sin agregados SQL** (#8), **N+1 en `/runs`** (#9), **criterio 20 sin medir** (#7) |
| UX | Periodo, cuatro sellos, fila de cuadre que deshabilita «Liquidar» con residual ≠ 0, drill-down de la parte imputada, estados vacío/error, motivo obligatorio en reversión y en sustitución, avisos de método en pantalla. Falta el grafo de cascada (#16) |
| Deuda técnica | **Incumple el §Estándar de calidad**: O-A6 marcada como cerrada sin cerrarla (#6) y deuda nueva sin anotar (#10) |

## 4. Veredicto

**CAMBIOS REQUERIDOS.** El motor es sólido —puro, entero, determinista, byte a byte
contra el fixture, con I4 en pie por construcción— y la capa de BD (RLS, append-only,
DAG diferido, versionado) está a la altura del resto del proyecto. Lo que impide
aprobar son tres cabos sueltos que dejan la épica sin cerrar el círculo: una regla que
puede quedar **inerte y muda** (#1), el **`allocationRunSetHash` que no llega al
`ReportRun`** y por tanto no caduca nada (#2), y **I5 y los doce invariantes sin
ejecutarse fuera de los tests** (#3). Los tres son de cableado, no de diseño.

Re-revisión recomendada tras la ronda de fixes, con `test:integration` completo y los
e2e ejecutados.

---

# Ronda 2 — verificación del commit 62ded40

> Rol: `revisor-codigo`, contexto limpio. Diff revisado: `git diff 17b8fe9...62ded40`
> (34 ficheros, +3 351 / −167) y el acumulado `ab9fb99...HEAD`.
>
> **Veredicto: CAMBIOS REQUERIDOS** (0 BLOQUEA · 1 DEBE · 2 PUEDE).
> Los tres BLOQUEA, los siete DEBE, BUG-E5-1 y los cuatro hallazgos del auditor
> están cerrados con evidencia. Queda **un FAIL falso de I5.b** que la propia
> corrección de BLOQUEA #3 ha hecho alcanzable, y dos restos menores.

## R2.0 Suites ejecutadas (todas sobre `erp_test`, 33 migraciones aplicadas)

| Suite | Resultado |
|---|---|
| `npm run lint` | **0 errores**, 14 warnings preexistentes (`hooks/**`, `components/ui/**`) |
| `npm run test` | **833 ✓** / 11 skipped (44 ficheros; +19 tests y +1 fichero respecto a la ronda 1) |
| `npm run test:integration` | **1156 ✓** (67 ficheros) |
| `npm run test:integration:rls` | **127 ✓** (9 ficheros). El fallo de la ronda 1 (`rls-strict.test.ts:389`, `app_maintenance` veía 0 organizaciones) queda cerrado: el test siembra ahora su propia organización |

## R2.1 Estado de los hallazgos de la ronda 1

| # | Sev. ronda 1 | Estado | Evidencia |
|---|---|---|---|
| 1 | BLOQUEA | **CERRADO** | Triple barrera: `lib/analytics/allocate.ts:746-777` (`TARGETS_REQUIRED` en `validate()`), `forms/allocations.ts:142-167` (zod), `models/allocations.ts:400-435` (al guardar). `driverWeights` ya sólo lee `targets` con `FIXED_PERCENT`/`MANUAL` (`allocate.ts:613`), y el caso «tiene saldo y ningún receptor con peso» devuelve `RULE_INERT` (`allocate.ts:988-998`) salvo base cero DECLARADA (`declaredZeroBase`, :937-940). `MIXED` retirado del selector |
| 2 | BLOQUEA | **CERRADO** | `models/reports.ts:253,265-283` compone el `runSetHash` real, `:290-300` lo mete en `analyticsKeyOf`, `:624,632` lo escribe en `allocation_run_set_hash`, y `:461` propaga `withAllocations` al informe SELLADO. `lib/ledger/report-run.ts:75-90` renombra el parámetro. `withAllocations` entra en `paramsHash`, así que imputado y no imputado son dos `ReportRun` distintos |
| 3 | BLOQUEA | **CERRADO** | `lib/analytics/invariants.ts:416-421`: `runAnalyticInvariants` lanza los trece de E5 cuando llega `allocations`. `models/margins.ts:201-230` aporta `rules`, `runs`, `balances` (reconstruidas) y `runLinesHashes`; `models/reports.ts:552-555` los mete en la validación del run, así que un FAIL pasa el sello a `REQUIERE REVISIÓN` por EV-9. Test de error inyectado por SQL: `tests/integration/e5-fixes.test.ts:360` |
| 4 | DEBE | **CERRADO** | `forms/allocations.ts:222-232`: `expectedHashes` obligatorio (sin `.nullish()`); `actions.ts:344` lo pasa sin `?? null` |
| 5 | DEBE | **CERRADO** | `20260910110000_e5_fixes` bloque 4: `app.allocation_rule_targets_immutable_when_used()` en `BEFORE INSERT OR UPDATE`, con exención para el `UPDATE` idéntico |
| 6 | DEBE | **CERRADO con honestidad** | La deuda no se cierra: se **reabre y se fecha**. `docs/MODELO-DATOS.md:105,138-143` («O-A6 **NO** queda cerrada en E5 … su épica de cierre es **E10**»), nota al pie en `docs/adr/0013-liquidacion-cecos.md:84-91` que conserva el párrafo aprobado y corrige el hecho, y fila en `ESTADO.md` §«E5 — deuda y decisiones». Es la resolución correcta: `Budget` no existe todavía |
| 7 | DEBE | **CERRADO** | `tests/integration/perf-pages.test.ts:71-72` (`MAX_MS_LIQUIDACION_ANUAL = 400`, `MAX_MS_PYG_IMPUTADA = 800`), tests en `:415` y `:441`, cargador nuevo `/analytics/pyg?imputaciones=si` en `:289-298`. El test comprueba además que la matriz medida lleva imputaciones de verdad (`:453-455`) |
| 8 | DEBE | **CERRADO (parcial, y bien acotado)** | `models/allocations.ts:1168-1200` (`getAllocationTotals` con `groupBy` + `SUM`), `:1095-1105` (sólo las dimensiones REFERENCIADAS, antes tres catálogos enteros por llamada) y `:1210-1225` (`getSealedRunRefs`: el drill-down ya no lee el reparto entero para sacar los `runIds`). `buildAnalyticPnl` sigue consumiendo las líneas una a una, pero ahora es **necesario**: `linesHash` e I-E5-12 se verifican línea a línea. Anotado en `ESTADO.md` |
| 9 | DEBE | **CERRADO** | `models/allocations.ts:470-505,548-583`: memoización por transacción del ejercicio, del `ledgerHash` por `(periodo, ejercicio)` y de las reglas por `(periodicidad, fin de periodo)`. La clave sigue siendo la identidad del cliente transaccional, así que no cruza peticiones ni organizaciones |
| 10 | DEBE | **CERRADO** | `docs/ESTADO.md:150-166`: tabla «E5 — deuda y decisiones» con las nueve entradas, su estado y su **épica de cierre** (O-A6, `MIXED`, `DRAFT`, `HOURS`/`HEADCOUNT` → E10; `ReportRun` ajeno a un `UPDATE` por SQL → E7) |
| 11 | PUEDE | **CERRADO** | `lib/analytics/allocate.ts:239-278`: producto, resto y `shareBps` en `BigInt`; exactitud por construcción, no por suerte. Refuerzo en BD: `20260910110000_e5_fixes` bloque 2 pasa `amount_cents`, `driver_base`, `driver_base_total` y `total_allocated_cents` a `bigint`. Conversión a `number` **sólo en el borde** (`models/allocations.ts:803-828, 1128-1130`; `models/margins.ts:500-503`), como ya hacía `models/ledger.ts` |
| 12 | PUEDE | **CERRADO** | Barrido de `lib/**` y `models/**`: ningún byte NUL. `allocate.test.ts` vuelve a ser texto para `grep`/`ripgrep` |
| 13 | PUEDE | **CERRADO** | `lib/money.ts:137-149` (`formatBps`, aritmética entera) y sus cuatro llamantes: `allocate.ts:802,822`, `models/allocations.ts:410,441`, `forms/allocations.ts:128` |
| 14 | PUEDE | **PARCIAL** | `allocation-rule-form.tsx:143` usa ya `parseCents` y el comentario deja de mentir, pero `components/analytics/allocation-rules-table.tsx:204` conserva `Math.round(Number(sharePercent.replace(",", ".")) * 100)`. Ver R2-1 |
| 15 | PUEDE | **CERRADO** | `actions.ts:126-137`: `previewAllocationAction` con `{ readOnly: true }` |
| 16 | PUEDE | **CERRADO** | `components/analytics/allocation-cascade-graph.tsx` (127 líneas), montado en `allocations/page.tsx:147`. Aristas `fuente → destino` numeradas por `(prioridad, código)` y agrupadas por periodicidad; sin dinero. La decisión de no usar librería de layout está argumentada en el propio fichero |
| 17 | PUEDE | **CERRADO** | `docs/design/E5-liquidacion.md`: `@@unique([organizationId, code, validFrom])` con la corrección fechada. El documento ya no contradice al código |
| **BUG-E5-1** (QA) | — | **CERRADO** | `models/allocations.ts:400-414` rechaza `Σ percentBps ≠ 10000` **al guardar** y `20260910110000_e5_fixes` bloque 3 lo repite en la base con un **constraint trigger diferido** sobre las dos tablas (un `CHECK` no puede: agrega sobre otras filas) |
| **Auditor 1** (sin sello de la salida) | — | **CERRADO** | `allocation_runs.lines_hash` (migración bloque 1 + 5, que lo mete en la lista de columnas inmutables), `canonicalLinesForm`/`linesHash` en `allocate.ts:1229-1266` con orden TOTAL independiente del orden de lectura, sellado en `models/allocations.ts:805`, y **I-E5-12 verificable sobre datos** (`invariants.ts:706-752`). El caso B del auditor (mover el céntimo de remanente por `UPDATE`) ya se detecta: `e5-fixes.test.ts:442-444` documenta que I5/I-E5-4/I-E5-9 siguen en PASS y es I-E5-12 quien lo caza |
| **Auditor 2** (I5.a nunca evaluada) | — | **CERRADO** | `reconstructBalances` (`allocate.ts:1096-1180`) reconstruye la base **desde el diario y las líneas persistidas**, por un camino independiente del que las produjo; `models/margins.ts:222-227` la aporta. I5 ya no declara «0 combinación(es)» (`allocate-fixes.test.ts:358`) |
| **Auditor 3** (clave de caché divergente) | — | **CERRADO** | Mismo cambio que #2: `analyticsKeyOf` con `allocationRunSetHash`, espejo exacto de `app.report_runs_analytics_key` |
| **Auditor 4** (techo de `integer`) | — | **CERRADO** | Mismo cambio que #11: `bigint` en las cuatro columnas |

## R2.2 Hallazgos nuevos

| # | Fichero:línea | Sev. | Problema | Sugerencia |
|---|---|---|---|---|
| R2-1 | `models/margins.ts:157-160` + `lib/analytics/invariants.ts:483-509` | **DEBE** | **I5.b da FAIL falso con periodicidades mixtas, y la corrección de BLOQUEA #3 lo ha puesto en pantalla.** `getAllocationRuleSpecs(tx, { periodEnd: request.to })` se llama **sin filtro de `period`**, así que `sourcesWithRule` incluye CECOs cuya regla es de periodicidad más gruesa y todavía no está liquidada. I5.b exige entonces cierre a 0 en el periodo del informe, cuando el diseño §3.3 y el criterio 18 declaran ese saldo **«pendiente de liquidar»**, no un descuadre. Reproducido: informe mensual 2026-03 con un run mensual de `CC-OPS` sellado y una regla ANUAL vigente sobre `CC-GA` ⇒ `FAIL :: I5.b CC-GA/EBITDA: quedan 100000 c sin liquidar al cierre`. Mismo efecto con `zeroBaseFallback = SKIP_WARN` (que es el **default**) en cuanto el periodo tenga alguna otra imputación. Consecuencia: la PyG imputada se sella `REQUIERE REVISIÓN` en un escenario legítimo, y un FAIL que se sabe falso deja de mirarse | Acotar I5.b a lo que dice su definición: sólo los CECOs cuya regla es del **periodo del informe** (y sobre el ejercicio, no sobre un mes suelto), o restar el `pendingCents` ya calculado por `buildAnalyticPnl`. Añadir el caso mixto al fixture de tests: hoy ninguno lo cubre |
| R2-2 | `components/analytics/allocation-rules-table.tsx:204` | PUEDE | Resto de #14: la banda de Σ de esta tabla sigue convirtiendo el porcentaje a bps con `Math.round(Number(texto.replace(",", ".")) * 100)`. `Math.round` lo salva hoy, pero es el patrón que #14 vino a retirar y el formulario hermano ya usa `parseCents` | Un `parseCents` más, igual que en `allocation-rule-form.tsx:143` |
| R2-3 | `docs/ESTADO.md:146` | PUEDE | El punto 16 sigue diciendo «**SIGUIENTE**: `/epica E5` … → `/sprint E5`» justo debajo del punto 15, que ya declara E5 implementada y en corrección. Contradicción de estado en el fichero que existe para decir dónde se retoma | Reescribir el punto 16 como «E8 → E7 → E9 → E10 → E11 → E12» |

## R2.3 Lo nuevo, revisado en detalle

- **Migración `20260910110000_e5_fixes`**: **aditiva** (no toca ninguna migración aplicada), **sin sentencias de SUPERUSER** (sólo `ALTER TABLE`, `CREATE OR REPLACE FUNCTION`/`TRIGGER` y `COMMENT` sobre objetos propios; ningún `ALTER ROLE`, ningún `ALTER FUNCTION … OWNER TO`), **sin DML** — por eso no necesita el baile `NO FORCE → UPDATE → FORCE`, y el razonamiento está escrito en la cabecera. Cierra con la guarda de `NO FORCE` de rigor. El `ALTER COLUMN … TYPE bigint` es DDL, así que la RLS `FORCE` no lo estorba. `lines_hash` queda `NULL` en runs anteriores y **I-E5-12 lo declara** en vez de fingir un sello (`invariants.ts:728-745`), que es la conducta correcta.
- **BigInt en `lib/analytics`**: la pureza se mantiene (sin `Date.now()`, sin IO, sin `prisma`; la única importación nueva es `formatBps` de `lib/money.ts`, que es aritmética entera). Toda la conversión `BigInt ⇄ number` vive en `models/**` y en el `$queryRawUnsafe` del drill-down. `canonicalLinesForm` y `canonicalAllocationJson` serializan `number`, así que **el fixture byte a byte no se ve afectado** (`allocate.test.ts:634` sigue en verde) y no hay `BigInt` que llegue a `JSON.stringify` — el `result` del `ReportRun` excluye explícitamente `levelTotalsBig` (`models/reports.ts:666-676`). El cociente de Hamilton se convierte con `Number(q)` y está acotado por `A ≤ 2^53`, correcto.
- **`linesHash` e I-E5-12**: el orden del canónico —`(regla, fuente, tipo de destino, destino, nivel)` más importe y columnas del driver— es total y no depende del orden de lectura de la base; el `sort()` posterior lo hace idempotente. Sella la SALIDA, que es justo lo que faltaba.
- **`reconstructBalances`**: independiente del motor (la base sale del diario), con el mismo filtro de `yaRepartido` que `loadRunContext` y emitiendo sólo las combinaciones que el run repartió. La suposición `liquidatedCents = baseCents` se apoya en I-E5-3 y está comentada; es correcta cuando todas las reglas del CECO reparten, y es exactamente el borde que R2-1 pone al descubierto en I5.b.
- **`getAllocationTotals`**: `groupBy` de Prisma con `_sum`, filtrado por `runId IN (…)` bajo el cliente de tenant (RLS como segunda barrera) y con orden estable posterior. Correcto; hoy lo consumen el total exacto del drill-down y su test (`e5-fixes.test.ts:536`).
- **`tests/support/ensure-self-hosted.ts`**: arnés idempotente que **siembra** el usuario self-hosted y una segunda organización `e2e-analitica` con plan sin subcuentas. El motivo (planes incompatibles y `--reset-org` cruzado) está documentado y es real. Importa `prisma` directamente, admisible en `tests/**`; el lint pasa.
- **`allocation-cascade-graph.tsx`**: componente de servidor, sin dinero, con estado vacío propio; la renuncia al layout de grafo está argumentada. Cumple lo que §6 pedía de utilidad (el orden de ejecución visible), no la forma.

## R2.4 Veredicto de la ronda 2

**CAMBIOS REQUERIDOS** — a un solo hallazgo de la aprobación. La ronda 1 se ha
aplicado con rigor poco común: no hay ningún cierre cosmético, las tres barreras de
BLOQUEA #1 son código + zod + BD, el `linesHash` cierra el agujero que el auditor
había demostrado, y la deuda O-A6 se ha **reabierto y fechado** en vez de taparse,
que era la única salida honesta. Las suites completas están en verde.

Lo que falta es un efecto colateral de la propia corrección: al poner I5 en
producción (BLOQUEA #3) se ha hecho visible un **FAIL falso de I5.b** en el escenario
de periodicidades mixtas que el diseño declara legítimo (R2-1). Un invariante que
falla cuando no debe se aprende a ignorar, y eso vale menos que no tenerlo. Con
R2-1 corregido y un test del caso mixto, **APROBADO**; R2-2 y R2-3 son de un minuto y
pueden ir en el mismo commit.
