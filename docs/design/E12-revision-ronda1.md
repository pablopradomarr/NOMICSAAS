# E12 — RE-REVISIÓN de la ronda 1 de corrección (`revisor-codigo`, contexto limpio)

**Diff revisado:** `git diff c0623f5...b56eafd` · 63 ficheros, +4 339 / −444 (el
commit `b56eafd` es sólo el informe del auditor y no se revisa como código) ·
**Fecha:** 2026-09-21 · **Contexto usado:** `CLAUDE.md`,
`.claude/agents/revisor-codigo.md`, mi informe anterior
`docs/design/E12-revision.md`, `docs/design/E12-fiabilidad-dod.md`,
`docs/adr/0020`, `0021`, `0022`, `docs/ESTADO.md` §«E12 · RONDA 1 DE CORRECCIÓN»
y `docs/design/E12-reauditoria-informe.md`.

> **Nota sobre el recuento.** El encargo habla de «13 hallazgos, 2 BLOQUEA ·
> 6 DEBE · 5 PUEDE». Mi informe anterior tiene **15** (#1–#15): 2 BLOQUEA ·
> 6 DEBE · **7** PUEDE. Se siguen los quince.

## Suites ejecutadas (una a una, en esta máquina)

| Suite | Resultado |
|---|---|
| `npm run lint` | ✅ **0 errores**, 12 avisos heredados (los mismos de la ronda anterior, ninguno en ficheros de E12) |
| `npx tsc --noEmit` | ✅ limpio (exit 0) |
| `npm run test` | ✅ **129 ficheros · 2 723 ✓ / 11 skip** (eran 125 / 2 689: los 4 ficheros y los 34 tests nuevos incluyen los del AST del auditor) |
| `npm run test:integration` | ✅ **186 ficheros · 3 624 ✓** · 333 s — **verde en la pasada completa**: los dos fallos intermitentes de la ronda anterior (#4 y #5) no reaparecen |
| `npm run test:integration:rls` | ✅ 12 ficheros · 211 ✓ |
| `npm run test:acceptance` | ❌ **ROJA: 9 ficheros · 2 fallos / 50 ✓** — `c7-registro-runs.test.ts:100` y `:253`, línea 79 de `runs/registro.jsonl` (`tests: Invalid input`) |
| e2e / `next build` | no lanzados (instrucción del encargo) |
| Privilegios en `erp_test` (a mano) | ✅ `has_function_privilege('app_runtime', 'app.operator_organizations(timestamp(3))','EXECUTE')` = **f**, `app_operator` = **t**; `BEGIN; SET LOCAL ROLE app_operator; SELECT …` devuelve 6 filas; sin `SET ROLE` → `permission denied for function operator_organizations` |

`git status` limpio salvo este informe.

## Seguimiento de los quince hallazgos de la ronda anterior

| # | Sev. anterior | Estado | Evidencia en el diff |
|---|---|---|---|
| **1** `deletionOrder` y las FK entrantes | BLOQUEA | **CERRADO** | `lib/platform/deletion-plan.ts` (nuevo, 234 líneas, **puro**): `planDeletion()` calcula el conjunto `sobreviven` por punto fijo y emite una guarda `NOT EXISTS` por arista entrante viva (`retentionWhere:185-200`); `operations.ts:189-211` y `models/purge-derived.ts:279-292` usan **el mismo** módulo. Test: `tests/integration/e12-ronda1.test.ts:70-256` siembra `FiscalYear`, `StoreSweep`, `InvariantRun`, `File` + `ExtractionRun`, cierre `CERRADO` y `BORRADOR`, `ReportRun` y marca de revisión, y ejerce `runResetOrg` de verdad (`:210`). `lib/platform/deletion-plan.test.ts` (137 líneas) cubre el planificador puro |
| **2** el test de AST no lo ejecutaba nadie | BLOQUEA | **CERRADO** | `vitest.config.ts:15-24` añade `scripts/**/*.test.ts` (129 ficheros frente a 125) **y** `.github/workflows/fiabilidad.yml:286-292` lo corre como paso propio del job 6 **antes** de usar el auditor. El fichero tiene los dos modos con guarda de ejecución directa (`imports.test.ts:142-144`) |
| **3** `purgeDerived` en orden alfabético | DEBE | **CERRADO** (con reserva, ver **A**) | `models/purge-derived.ts:279-292` reutiliza `planDeletion`/`deleteStatement` y aborta si hay ciclo; `:296-306` cuenta y **declara** lo retenido. Test `e12-ronda1.test.ts:258` con cierre sellado y `ManualReviewFlag` |
| **4** `DELETE` de `time_entries` sin tenant | DEBE | **CERRADO** | `tests/integration/e10-esquema.test.ts:748-750` lleva `organization_id = $1::uuid`. La suite completa sale verde |
| **5** techo 2/9 de perf-budget | DEBE | **CERRADO** | `perf-budget.test.ts:370-379` (`ANALYZE` tras la siembra) y `:487-489` (calentamiento fuera de la medida); el techo pasa (142 ms en el registro, verde aquí). Reserva menor en **F** |
| **6** `app.operator_organizations` desde `app_runtime` | DEBE | **CERRADO Y VERIFICADO EN BASE** | Migración `20261002090000`: `REVOKE … FROM app_runtime`, `GRANT … TO app_operator, app_maintenance` y bloque `DO` que comprueba las dos cosas. `models/platform.ts:385-404` la llama dentro de `$transaction` con `SET LOCAL ROLE app_operator`. Comprobado a mano contra `erp_test` (arriba). Reserva en **C** |
| **7** efecto fuera de la transacción de los registros | DEBE | **CERRADO** | `operations.ts:573-590` (`changeOrganizationPlanTx`) y `:676-690` (`expireBackupsTx`) ejecutan el efecto **dentro** de la misma `tenantTransaction` que escribe `AuditLog` + `PlatformAuditLog`. `models/subscriptions.ts:428-496` y `models/backups.ts:2159-2182` extraen la variante `…Tx` conservando el envoltorio. Reserva en **E** |
| **8** operador abierto por defecto | DEBE | **CERRADO** | **ADR-0022** (Nivel 2, aprobado y fechado); `admin.ts:44-47` → `if (adminEmails.length === 0) return false`; `warnIfNoPlatformAdmins()` en `admin.ts:95-104` llamado desde `instrumentation.ts:6-18`; runbook §10.1 de «Opcional» a obligatoria. Resto en **B** y en N-3 del auditor |
| **9** `requirePlatformAdmin()` tras el `FormData` | PUEDE | **CERRADO** | `actions.ts:138`, `:201`, `:253`, `:297`: `await requirePlatformAdmin()` es la primera sentencia de las cuatro `runXAction` |
| **10** `revoke_operator_exception` depende de `rolbypassrls` | PUEDE | **NO CERRADO** | La migración `20261001090000` no gana ni el `RAISE` sugerido ni una línea que lo documente (`grep -n rolbypassrls` → 0 resultados), y no aparece en la deuda con fecha de `ESTADO.md:65-72`. Sigue abierto, sin empeorar |
| **11** el ZIP sólo se probaba contra JSZip | PUEDE | **CERRADO** | `lib/platform/zip-stream.test.ts:157-221`: escribe el archivo a disco y lo valida con **`unzip -t`** (Info-ZIP) y con el `zipfile` de Python (`testzip()`, nombres, tamaños y sha256 del contenido), con `STORE` + `DEFLATE` y una entrada no ASCII |
| **12** matriz de e2e escrita a mano | PUEDE | **CERRADO** | `fiabilidad.yml:470-489`: job `e2e-matriz` que deriva la lista de `ls tests/e2e/*.spec.ts` con suelo `[ "$n" -ge 13 ]`, y `e2e` la consume con `fromJSON` |
| **13** nota de alcance dentro de ADR-0011 | PUEDE | **CERRADO** | La nota sale íntegra de `docs/adr/0011:49-89` y queda una referencia de tres líneas (`0011:49-54`); nace `docs/adr/0021-alcance-de-los-sellos-entre-copias.md` que **complementa** y no enmienda. Rastro pendiente en **D** |
| **14** `ESTADO.md:125` contradecía la cabecera | PUEDE | **CERRADO** | `ESTADO.md:212-215` ya trae «*(previsión del diseño; el resultado real está arriba…)*» |
| **15** el token de `/admin` firmado con el secreto de sesión | PUEDE | **CERRADO** | `confirmation.ts:52-71`: `ADMIN_CONFIRMATION_SECRET` si está puesta y, si no, `hkdfSync(sha256, authSecret, "", "erp:admin-confirmation:v1", 32)`. Variable declarada en `.env.example:151` (vacía; ningún secreto en el código) |

**Resumen:** 13 CERRADOS · 1 NO CERRADO (#10, PUEDE) · 1 cerrado con reserva (#3).

## Confirmación de lo que el auditor ya dice y toca a código

No se duplican N-1…N-4 ni los parciales H-4/H-6; se **confirman** los cuatro que
tocan código, porque pesan en el veredicto:

- **N-1 · CONFIRMADO, y es el bloqueo.** Reproducido aquí: `npm run test:acceptance`
  → 2 fallos / 50 ✓. `runs/registro.jsonl:79` lleva `tests.e2e_detalle` como
  **objeto anidado** y `runs/registro.schema.ts:103-106` admite en `tests` un
  `Record<string, number|string>` o una cadena. `I-E12-7` en FAIL y el job 5 de
  CI rojo. `ESTADO.md:77` declara «`acceptance` (9 · 52 ✓)»: no es cierto en HEAD.
- **N-2 · CONFIRMADO.** `lib/platform/backup.ts:427-434` no incluye
  `COBERTURA_INVENTARIO`, y es la lista que recorre `isVerified()` (`:443`) y la
  que fija `DONE`/`DONE_UNVERIFIED` (`:447-449`). La séptima comprobación existe
  (`:479-520`), se emite (`models/backups.ts:1577-1589`) y `I-E11-2` sí la exige
  (`invariants-e11.ts:408-418`), pero **no decide**: una restauración a la que le
  falta una tabla entera se entrega como `verified`. Una línea.
- **H-4 · CONFIRMADO PARCIAL.** `scripts/ci-audit-fixture.ts:189`:
  `sello === "VALIDADO AUTOMÁTICAMENTE" || fallos.length > 0`. Con tres FAIL de
  sustrato permanentes la segunda rama es siempre cierta y la comprobación del
  sello **nunca se evalúa**. La puerta de los FAIL no declarados (`:174-188`) sí
  funciona y es lo que salva el job.
- **N-3 · CONFIRMADO.** `app/(app)/settings/backups/actions.ts:276` vuelve a
  escribir el predicado en línea en vez de importar `isPlatformAdminEmail()`
  (ADR-0022 D2). Sin fuga hoy —con la lista vacía `includes` es `false`—, pero es
  la tercera copia de una autorización.
- **N-4 · CONFIRMADO.** `ESTADO.md:70` sigue diciendo que atar un documento a un
  asiento «movería el diario y con él las doce cifras canónicas»; `file_id` no
  entra en ninguna forma canónica de ADR-0011 (`lib/ledger/hash.ts:185-243`).

## Hallazgos NUEVOS de esta re-revisión

| # | Fichero:línea | Severidad | Problema | Sugerencia |
|---|---|---|---|---|
| **A** | `models/purge-derived.ts:57-105` · `docs/design/E12-fiabilidad-dod.md:684` · `.claude/skills/fiabilidad/SKILL.md:420` · `tests/acceptance/memoria-borrada.test.ts:136-160` | **DEBE** | La ronda cambia `purgeDerived` de **lista derivada del esquema** a **registro explícito** (`DERIVED_MODELS`) con un detector que sólo acusa. El cambio es defendible y está razonado, pero **el criterio 34 sigue escrito al revés** —«`purgeDerived` deriva su lista del esquema: una tabla derivada nueva entra sola»—, **`I-E12-1` sigue diciendo «con la lista derivada del esquema»**, y el test que afirmaba el criterio 34 (`criterio 34 · una tabla derivada NUEVA entra sola en la lista, sin tocar código`) **se ha borrado** y sustituido por uno más débil (`tablasSinDeclarar() === []`). Un criterio de aceptación deja de ser cierto, su test desaparece y ningún documento lo enmienda: es exactamente el patrón que la enmienda E-1 y el estándar «sin deuda que se acumule» existen para impedir | Enmendar el criterio 34 y el enunciado de `I-E12-1` (o, si se prefiere, un ADR corto que revoque la aplicación de E-4 a `purgeDerived`, que es una decisión de diseño con consecuencias). El test nuevo está bien; lo que falta es que el texto diga lo que el código hace |
| **B** | `.env.example:148-150` | **DEBE** | El comentario de `PLATFORM_ADMIN_EMAILS` sigue diciendo «**Vacía en modo interno = el ADMIN de la organización** (quien opera y quien administra son la misma persona)». Es la regla que **ADR-0022 D1 deroga** y que `admin.ts:44-47` ya no implementa. `.env.example` es lo que un operador copia para configurar la instalación: deja escrito, en el sitio donde se decide, lo contrario de lo que hace el candado | Reescribir las tres líneas: «vacía = **NADIE** es operador de plataforma, en los dos modos de facturación (ADR-0022 D1); `/admin` responde 404 y el cambio de plan se niega». Añadir la referencia al aviso de arranque |
| **C** | `models/platform.ts:385-404` | **DEBE** | `listOrganizationsForOperator` es la **única** llamada a la función que la migración `20261002090000` acaba de cerrar, y **no la ejercita ni un test**: `grep -rn listOrganizationsForOperator` sólo la encuentra en su propia definición. Ni `test`, ni `integration`, ni `rls`, ni `acceptance` la tocan; el único llamante que la probaría es el e2e `admin`, que es justo el que esta ronda no pudo correr en esta máquina. Si mañana se pierde el `SET LOCAL ROLE`, o el `GRANT` cambia, `/admin` se queda sin inventario y **ninguna suite lo dice**. Verificado a mano que hoy funciona (§Suites) | Un test de integración de cuatro líneas: con `prisma` (rol `app_runtime`) la llamada **sin** `SET LOCAL ROLE` da `42501`, y `listOrganizationsForOperator(now)` devuelve filas. Cubre el `GRANT`, el `SET LOCAL` y la negativa en base, que es lo que DEBE #6 compró |
| **D** | `docs/ESTADO.md:115-127` y `:139-146` | PUEDE | Rastro de la ronda: la sección de la ola B sigue diciendo «nota de alcance fechada en **ADR-0011** (2026-09-21…)» cuando la nota vive ya en **ADR-0021** (hallazgo #13, cerrado); y §T22 sigue diciendo «**Nueve** trabajos … **e2e uno por fichero (matriz de 13)**» cuando el workflow tiene **doce** jobs y la matriz se deriva del directorio | Dos frases: apuntar a ADR-0021 y actualizar el recuento de jobs. `ESTADO.md` es el documento que se lee para saber dónde está el proyecto |
| **E** | `models/backups.ts:2159-2182` · `app/(app)/admin/operations.ts:683` | PUEDE | `expireBackupsTx` llama a `deleteObject` —IO del almacén de objetos— **dentro** de la transacción del llamante, que desde el DEBE #7 escribe además los dos registros. Si la transacción revierte después del primer `deleteObject`, los bytes ya no están y las filas de `BackupJob` vuelven: quedan copias con `objectKey` apuntando a nada, y el barrido las verá como «ficheros sin bytes». Además alarga una transacción que `CLAUDE.md` pide corta. El patrón es anterior a esta ronda, pero la ronda le mete dentro dos escrituras más | Borrar los objetos **después** del `COMMIT` (recoger las claves en la transacción y purgarlas fuera, con reintento), o marcar `objectKey` a `NULL` en la transacción y dejar el borrado físico al barrido del almacén |
| **F** | `tests/integration/perf-budget.test.ts:487-489` | PUEDE | El calentamiento usa `lote(SCALE.batchCells * 3)`, es decir desplazamiento **1500**. Los meses y los proyectos **sí** coinciden con el lote medido (`1500 % 12 = 0`, `1500 % 25 = 0`); lo único que hace que las claves `(mes, cuenta, proyecto)` sean distintas es que `1500 % 120 = 60 ≠ 0`. Si alguien cambia `SCALE.accounts` a 100, 125, 150, 250 o 500, el calentamiento sembraría **las mismas** celdas y el `createMany` que el techo mide pasaría a ser un `updateMany`: el número seguiría saliendo verde midiendo otra cosa | Usar un desplazamiento **coprimo** por construcción (p. ej. otra cuenta/proyecto explícitos, o `budgetId` distinto para el calentamiento) y, mejor, añadir un aserto de que la intersección de claves entre los dos lotes es vacía |
| **G** | `docs/design/E12-fiabilidad-dod.md:540-552` | PUEDE | El bloque nuevo de §8 («lo que el workflow ejecuta HOY») está escrito **sin tildes** —«auditoria», «tenia», «mas», «solo», «util», «AUTOMATICAMENTE»— dentro de un documento canónico que el resto del fichero escribe en español correcto. `CLAUDE.md` fija el idioma de los documentos | Restituir las tildes del bloque |
| **H** | `lib/budget/variance.ts:517-522` | PUEDE | El arreglo de tenant es correcto y cierra una fuga real (BUG-E12-3), pero la consulta de provenance se sigue componiendo por **interpolación de cadena**, ahora también con el `organizationId`. `I-E12-3` la llama «consulta **parametrizada**» y `CLAUDE.md` prohíbe el SQL crudo con interpolación. Hoy no es explotable —los valores son uuid del contexto y códigos ya validados, y la cadena no se ejecuta desde aquí— pero es una práctica que se copia | Emitir `$1…$n` y llevar los valores en un array paralelo en `BudgetCellProvenance`, como pide el enunciado de `I-E12-3`. Es un cambio mecánico y de una sola vez |

## Lo que se ha comprobado y está bien

- **El planificador de borrado es de verdad único, puro y derivado.** `planDeletion`
  no abre conexión, recibe las aristas; el cálculo de `sobreviven` por punto fijo
  evita declarar «retenida» una tabla que sólo espera a sus hijos; la decisión de
  **retener y declarar** en vez de desenganchar está razonada desde los
  privilegios de ADR-0020 D2 (el operador no tiene `UPDATE`), no desde el gusto; y
  la enumeración del plan usa **la misma cláusula** que la ejecución
  (`countDeletable`), así que el plan anuncia lo que va a pasar.
- **`retenidas` entra en `DETAIL_ALLOWED_KEYS` y en `DETAIL_OBJECT_KEYS`**
  (`models/platform.ts:97-118`) con el tope de claves ya existente: el registro de
  plataforma sigue llevando recuentos, no filas de negocio.
- **Migración `20261002090000`:** aditiva, nombrada, no edita ninguna aplicada, no
  exige SUPERUSER (`REVOKE`/`GRANT`/`COMMENT` sobre una función propia) y **verifica
  lo que promete** con un bloque `DO` que falla nombrando el privilegio.
- **Nivel 2 con ADR:** ADR-0021 (alcance de los sellos, complementa 0011 sin
  enmendarlo) y ADR-0022 (operador cerrado por defecto, sustituye **una** frase de
  ADR-0019 D9 y lo dice), los dos aprobados y fechados. El resto del diff es
  Nivel 1. No hay cambio de motor contable, de esquema de asientos ni de RLS.
- **Dinero:** ni un `Float`, `parseFloat` ni `toFixed` nuevo; el único cálculo
  monetario tocado (`variance.ts`) sigue en céntimos `Int`.
- **Pureza:** `lib/platform/deletion-plan.ts`, `lib/budget/variance.ts` y
  `lib/ledger/invariants-e11.ts` no ganan `Date.now()`, `new Date()` vacío,
  `prisma`, `fetch` ni LLM; el job `pureza-motor` extiende el guard a
  `lib/platform/**` y **se ha comprobado que el `grep` no está ciego** (el diff
  arregla los dos filtros que lo hacían saltar en todos los directorios).
- **Tests no debilitados, salvo el caso A.** Ningún `skip` nuevo (el único
  `describe.skipIf` añadido es el condicional de base de datos que usa toda la
  suite de integración); ningún `any`; ningún `TODO`/`FIXME` nuevo. El test de #1
  cubre vacío/uno/límites y el de `purgeDerived` distingue los tres desenlaces de
  una columna-sello (`nulled` / `skipped` / `error`).
- **Secretos:** `ADMIN_CONFIRMATION_SECRET` se declara **vacía** en `.env.example`
  y con caída derivada por HKDF; el workflow sigue sin un solo `secrets.*`.
- **Trazabilidad:** `reset-org` escribe ahora también `filasRetenidas` en los dos
  registros, y `runResetOrg`/`runUnblock`/`runReassignPlan`/`runPurgeRetention`
  hacen efecto y registros en **una** transacción.
- **`models/accounts.ts:508-535`** cierra un fallo real de producto (las
  diecinueve claves diferidas de E9 sólo las sembraba la migración M4, así que
  toda organización nueva nacía sin ellas) respetando la regla de M4 al pie:
  código exacto, sólo si la cuenta existe, está activa y es postable.

## Veredicto

**CAMBIOS REQUERIDOS** — 0 BLOQUEA propios · 3 DEBE · 5 PUEDE, **más el bloqueo
de estado que ya nombra el auditor**.

Los dos BLOQUEA de mi ronda anterior están **cerrados y verificados**, y con
ellos once de los quince hallazgos; el #10 sigue abierto tal cual (PUEDE) y el #3
queda cerrado con la reserva **A**. El trabajo de corrección es sólido: el
planificador de borrado es un módulo puro y único en vez de dos criterios
improvisados, la negativa de `/admin` vive ahora **en la base** (comprobado
ejecutándolo) y no sólo en la aplicación, y los efectos de operador ya no pueden
quedar hechos sin registro.

**Lo que impide aprobar no es ninguno de mis hallazgos nuevos: es que la suite de
aceptación está ROJA en `HEAD`** por la línea 79 de `runs/registro.jsonl`
(N-1 del auditor, reproducido aquí), con `I-E12-7` en FAIL y el job 5 de CI que
saldría rojo — mientras `ESTADO.md:77` la declara verde. Eso, más la línea que le
falta a `REQUIRED_CHECKS` (N-2), se arregla en dos cambios de una línea cada uno.
De lo mío, **A** y **B** son los que no deberían pasar a la ronda 2: un criterio
de aceptación que ya no es cierto y un `.env.example` que documenta la regla que
ADR-0022 deroga.

**No hay cambio de Nivel 2 sin ADR.**

---

*Re-revisión ejecutada el 2026-09-21 en contexto limpio. No se modificó producto
ni fixture; las suites se lanzaron una a una sobre `erp_test`
(`psql -h /var/run/postgresql`). Los e2e y `next build` no se lanzaron, por
instrucción del encargo.*
