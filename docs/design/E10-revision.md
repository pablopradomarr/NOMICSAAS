# E10 — Revisión de código (`revisor-codigo`)

**Diff:** `git diff fc4a863...HEAD` (17 commits, 121 ficheros, +135 925 / −484) ·
**Fecha:** 2026-09-15 · **Contexto:** `CLAUDE.md`, `docs/design/E10-presupuesto-horas.md`,
`docs/adr/0018-*`, `docs/design/E10-validacion-controlling.md`, `docs/ESTADO.md`.

**Verificación ejecutada** (Postgres `erp_test`, localhost:5432):

| Comando | Resultado |
|---|---|
| `npm run lint` | **0 errores** |
| `npm run test` | **106 ficheros, 2 240 en verde, 11 skip** (los 11 preexistentes) |
| `npm run test:integration` | **150 ficheros, 2 932 en verde** |
| `npm run test:integration:rls` | **11 ficheros, 185 en verde** |
| `npm run build` | **OK** |

Lo que está bien y no vuelve a mencionarse abajo: las siete migraciones son
aditivas, ninguna aplicada se ha editado, ninguna exige SUPERUSER, los dos
`ALTER TYPE`/recreación de enum van en su propia migración, el único backfill
(M6 §4) hace el baile `NO FORCE` → backfill → `FORCE` con verificación posterior
sobre **todas** las tablas de negocio, O-A6 se cierra con SQL (CHECK de
exclusividad + cuatro índices únicos parciales, y otros cuatro en
`budget_hours_lines`), el CHECK de signo por tipo convive con
`budget_lines_type_required`, el techo 1 440 está por fila **y** agregado por
(empleado, día) en trigger, los dos `EXCLUDE USING gist` de vigencias están, el
append-only lleva `REVOKE` explícito antes del `GRANT` de columna, `allocate()`
conserva Hamilton, cascada, `sourceShareBps`, E5-D1 y la forma canónica —el test
byte a byte contra `liquidacion-esperada.json` sigue verde sin tocar el
fixture—, el `timeSeal` persiste una ventana que contiene el periodo con CHECK
que lo exige, la cuarta causa de `STALE` está derivada y el lote de staleness se
resuelve en **3 consultas** con el log delante, la clave de `ReportRun` pasa a
nueve campos sin invalidar informes antiguos (`'∅'` constante), el espejo SQL de
`marginConfigHash` tiene test carácter a carácter, la reclasificación de nómina
exige concentración 10 000 bps fija, la matriz de roles de §4.2 se cumple
literalmente (tarifa oculta sin ADMIN, R-H-4 en la aprobación), zod es estricto
en los tres `forms/`, no hay `any` en el código nuevo, y el cliente no calcula
ninguna cifra contable.

---

## Hallazgos

| # | Fichero:línea | Severidad | Problema | Sugerencia |
|---|---|---|---|---|
| 1 | `tests/integration/` (ausente) · `docs/ESTADO.md` | **BLOQUEA** | **T19 no se ha ejecutado y su hueco no está fechado.** `tests/integration/perf-budget.test.ts` no existe: **ninguno** de los nueve techos de §9 está medido (28 800 celdas < 900 ms, lote de 500 celdas, CSV de 30 000 líneas, budget-vs-actual anual con imputaciones, `settleBudgetMatrix`, `/time`, agregado del ejercicio, liquidación anual con `HOURS`, y los ms del lote de staleness — sólo su cuenta de consultas está probada). Tampoco existen `e10-presupuesto.test.ts` ni `e10-tenant.test.ts`. `runs/registro.jsonl` no registra ningún run de T19 y `docs/ESTADO.md` no lo anota | Crear `perf-budget.test.ts` con los nueve techos, o anotar T19 en `docs/ESTADO.md` con épica de cierre. CLAUDE.md: «el revisor bloquea si una épica añade deuda sin fecha» |
| 2 | `runs/registro.jsonl` (C1, C2, C3) vs `docs/ESTADO.md:467-487` | **BLOQUEA** | **Deuda declarada en el registro y ausente de `ESTADO.md`.** C1: «el drill-down filtra las celdas **en memoria** tras `getBudgetVersion`; con las 28 800 celdas del techo de §9 conviene un agregado SQL» y «el calendario de `/time` lee hasta 5 000 partes del mes». C2: «el editor pinta las celdas de UNA versión … pide paginación». C3, literal: «**queda abierto, sin fecha propia** porque depende del contrato». `ESTADO.md` sólo recoge la deuda de granularidad `MONTH` (fechada en E11, correcta) | Llevar las tres a `docs/ESTADO.md` con épica de cierre, o cerrarlas. Es el mismo estándar que E5/E7/E9 cumplieron |
| 3 | `lib/budget/hash.ts:57-70` · `docs/design/fixtures/build_presupuesto_horas_esperado.py:495-509` | **BLOQUEA** | **`budgetHash` no sella las horas presupuestadas.** ADR-0018 D2 y §3.8 del diseño fijan `budgetHash = sha256(cabecera ‖ líneas de importe ‖ **líneas de horas en forma canónica, en minutos** ‖ marginConfigHash)`. `canonicalBudgetForm` sólo recorre `version.cells`; `version.hours` no entra. Es un contrato de **Nivel 2 firmado**, y las horas no son decorativas: `BudgetHoursLine` alimenta la liquidación presupuestaria en dry-run de D4/O-E10-4, o sea las celdas de MC3 del informe. Consecuencia: **I-E10-6 no puede ver** un cambio de horas en una versión sellada, y el propio `sealBudgetTx:547-573` reconoce que importan al emitir `PARTIAL_WITHOUT_HOURS` | Incluir las filas de `canonicalHoursRow` en la forma canónica (el fixture se reversiona, que es el coste que D6 anticipa), o —si se decide no sellarlas— enmendar ADR-0018 D2 y §3.8 con una nota fechada que lo diga y explique por qué la base del dry-run queda fuera del sello |
| 4 | `lib/analytics/allocate.ts:870-905` (`hoursWeights`) | DEBE | **`HORAS_SIN_APROBAR` no se emite cuando la base aprobada es 0.** La rama `if (baseTotal === 0) { … return }` sale **antes** del bloque de minutos sin aprobar, así que con 0 minutos aprobados y 12 000 sin firmar sólo sale `W-E10-NO-HOURS`, se cae en el `zeroBaseFallback` y el run **se sella sin el motivo**. ADR-0018 D1 punto 3 y EV-15 dicen «**siempre** que existan minutos sin aprobar de receptores elegibles en la ventana», y el 100 % sin aprobar es el caso extremo del parcial que O-E10-2 existe para cerrar. Lo delata el propio tipo: `shareOfBaseBps: number \| null` con el comentario «`null` con base 0» es una rama **inalcanzable** | Emitir `W-E10-UNAPPROVED-HOURS` con `shareOfBaseBps: null` también en la rama de base cero, antes del `return`, y añadir el caso al test de `allocate.test.ts` |
| 5 | `docs/MODELO-DATOS.md:105,142` · `docs/ESTADO.md:246` | DEBE | **O-A6 sigue declarada ABIERTA en los dos documentos** pese a estar cerrada con SQL en M2, y `MODELO-DATOS.md` §Analítica **no** incorpora `Budget`, `BudgetLine`, `BudgetHoursLine`, `TimeEntry`, `Employee`, `EmployeeRate` ni `HeadcountSnapshot`. Las dos cosas son consecuencias explícitas de ADR-0018. Una deuda que el SQL cierra y el documento deja abierta se vuelve a «cerrar» en E11 | Actualizar `MODELO-DATOS.md` con las siete tablas en su forma final y pasar O-A6 a **CERRADA** en los dos ficheros, citando la migración `20260924100000_e10_presupuesto` |
| 6 | `lib/time/payroll-reclass.ts:122` | DEBE | **`proposePayrollReclass` no tiene ni un consumidor.** 250 líneas de motor y 248 de test sin ninguna llamada desde `models/`, `app/` ni componentes: el camino (b) de §3.7 es inalcanzable desde el producto. La propia ruta correcta (`reclassifyLines`, ADR-0010) está intacta y es la única que se usa, así que no hay riesgo contable — hay código muerto en una épica que presume de no dejarlo | Darle salida (una acción ADMIN que proponga y delegue en `reclassifyLines`) o anotar en `docs/ESTADO.md` la épica en que se conecta |
| 7 | `app/(app)/analytics/budget/page.tsx:36-70` · `app/(app)/time/page.tsx:41-45` · `app/(app)/analytics/budget-vs-actual/page.tsx:60-138` | DEBE | **Varias transacciones por petición.** §9 exige «una transacción por petición (`tenantPage`)» y ≤ 2 conexiones en `/analytics/budget`. Las páginas abren la de `tenantPage` y además una por cada server action que invocan (`listBudgetsAction`, `getBudgetAction`, `listTimeEntriesAction`, `timeCalendarAction`, `listEmployeesAction`, `budgetVsActualAction`…) más un `tenantTransaction` suelto para `getAnalyticsConfig`: **4 en `/analytics/budget`, 5 en `/time`, 3-4 en `/analytics/budget-vs-actual`**. No hay N+1 por fila —los agregados son correctos—, pero sí N transacciones por render, y nadie lo mide por el hallazgo 1 | Leer dentro del `db` de `tenantPage` (las funciones de `models/` ya aceptan el cliente) y reservar las acciones para las mutaciones, como hace `/analytics/pyg` con una sola |
| 8 | `lib/budget/hash.ts:73` | DEBE | `budgetHoursHash` está exportada, no la llama nadie y no tiene test. Es el residuo del hallazgo 3: la función que sellaría las horas existe y no se usa | Usarla (dentro de `budgetHash`) o retirarla |
| 9 | `docs/design/E10-presupuesto-horas.md` §9 y §2.3/T3 | PUEDE | **Discrepancias documentales.** §9 abre con «**Ocho** techos» y la tabla lista **nueve** filas más un pie que dice «**Nueve** techos en total». §2.3 y T3 hablan de **siete** enums y M1 crea **ocho** — la migración lo anota («es un recuento corto del propio documento»), pero el diseño no se corrige | Corregir los dos recuentos en el diseño; un documento que se contradice obliga a auditar cuál de las dos cifras manda |
| 10 | `prisma/migrations/20260924100000_e10_presupuesto/migration.sql:278-285` | PUEDE | `budget_lines_sign_by_type` conserva la rama `OR "analytic_type" IS NULL` aunque la columna es `NOT NULL` y existe `budget_lines_type_required`. Es inalcanzable, pero deja a la vista en `\d` exactamente el agujero que O-E10-23 cerró, y el siguiente que lea el CHECK no sabrá si la rama protege algo | Retirarla en la próxima migración con un comentario que cite O-E10-23 |
| 11 | `prisma/migrations/20260924110000_e10_horas/migration.sql:1126-1129` | PUEDE | `employees` se protege del borrado **sólo** con la política `employees_no_delete`, sin el `REVOKE DELETE` que M2/M3 sí aplican a las otras seis tablas — y el propio comentario de M2 advierte de que `ALTER DEFAULT PRIVILEGES` concede `arwd` a `app_runtime` sobre toda tabla nueva. Hoy la política basta (con `FORCE` alcanza también al propietario), pero es la única de las siete que depende de una sola barrera | Añadir `REVOKE DELETE ON "employees" FROM app_runtime` por coherencia con las otras seis |
| 12 | `lib/time/aggregate.ts:231-242` | PUEDE | `timeWindowOf` ensancha la ventana por el `zeroBaseFallback` de **cualquier** regla, también de una `REVENUE_SHARE`, no sólo de las de driver de actividad. Es conservador —la ventana sigue conteniendo el periodo y el sello nunca queda corto—, pero un run se puede declarar `STALE` por un parte de enero que ninguna regla del run habría consumido | Filtrar el bucle con `isActivityDriver(rule.driver)`, que ya está importado dos líneas más arriba |
| 13 | `app/(app)/settings/employees/actions.ts:224-228` | PUEDE | Cuando la propuesta de coste-hora **no es evaluable**, `applyHourlyCostAction` devuelve `success` con `applied: 0` y el motivo enterrado en `skipped[0]`, en vez de un error. Un ADMIN que pulse «aplicar» ve una operación correcta que no ha escrito nada | Devolver `{ success: false, error: proposal.message }` |
| 14 | `forms/budget.ts:195-201` · `forms/time.ts:123-127` | PUEDE | El import valida el **tamaño** (5 MB) pero el fichero llega ya convertido a texto en el cliente: nada comprueba extensión ni mimetype en el borde, así que un `.xlsx` soltado por error entra como binario y sale como 30 000 rechazos en vez de un «esto no es un CSV» | Validar extensión/mimetype antes de leer el fichero y rechazar con un mensaje de una línea |
| 15 | `app/(app)/analytics/budget/actions.ts:246` | PUEDE | `upsertBudgetHoursAction` (EDITOR, coherente con sus hermanas) no figura en la matriz de roles de §4.2 del diseño | Añadir la fila a §4.2 |

---

## Veredicto

## **BLOQUEADO**

No por Nivel 2 sin ADR —ADR-0018 está firmado y la épica lo sigue con una
fidelidad poco común—, sino por tres cosas que la propia doctrina del proyecto
declara bloqueantes:

1. **Los nueve techos de §9 no están medidos y el hueco no está fechado**
   (hallazgo 1). `CLAUDE.md` es literal: *«lo que se aplaza se anota en
   `docs/ESTADO.md` con épica de cierre; el revisor bloquea si una épica añade
   deuda sin fecha»*. T19 entero —perf, `e10-presupuesto`, `e10-tenant`— no se
   ha ejecutado y no aparece ni en `ESTADO.md` ni en `registro.jsonl`.
2. **Tres deudas declaradas en `runs/registro.jsonl` no llegaron a
   `docs/ESTADO.md`** (hallazgo 2), una de ellas escrita por su autor como «sin
   fecha propia». El registro de runs no sustituye al inventario de deuda.
3. **`budgetHash` se aparta de la fórmula de ADR-0018 D2** (hallazgo 3): las
   líneas de horas quedan fuera del sello, y son la base del dry-run que produce
   las celdas de MC3 del informe. O se incluyen, o el ADR se enmienda con nota
   fechada; lo que no puede quedar es la divergencia silenciosa entre un
   documento de Nivel 2 y el código que lo implementa.

Los tres son de cierre barato. Con ellos resueltos y el hallazgo 4 corregido
—`HORAS_SIN_APROBAR` con base cero, que es el único defecto funcional de esta
revisión—, la épica es **APROBABLE**: lint, las tres suites y el build están en
verde (5 357 pruebas), las siete migraciones son ejemplares, el motor queda puro
y el núcleo de E5 intacto.
