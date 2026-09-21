# E12 · RE-AUDITORÍA de la ronda 1 de corrección

> Agente `auditor-fiabilidad`, **contexto limpio**. Entradas recibidas: mi informe anterior
> (`docs/design/E12-auditoria-informe.md`), los diez commits `c0623f5..HEAD`, `docs/ESTADO.md`
> §«E12 · RONDA 1 DE CORRECCIÓN», `docs/design/E12-revision.md`, los ADR **0021** y **0022** y los
> fixtures. **No se me pasó razonamiento ni conversación del productor**: no hay nada que ignorar
> por ese lado. Bases `audit_r2_a…d`, todas creadas con `createdb -T erp_test` y **destruidas al
> terminar** (`audit_e12` es anterior y no la he tocado). No se ha modificado ni una línea de
> producto ni de fixture: `git status` limpio salvo este informe.

**Método:** de cada hallazgo declarado cerrado he **ejecutado el control**, no leído el diff; donde
había un mecanismo (el job que no puede salir verde, la guarda de borrado, la detección por
dimensión) lo he **roto en una copia** para ver si falla de verdad.

---

## 1. Las doce cifras, por un TERCER camino, otra vez

Python puro sobre `tests/fixtures/ejercicio-completo.json` y `seeds/npgc.csv`: sin base de datos,
sin SQL, sin TypeScript y **sin importar una línea del repositorio**. Aritmética entera en
céntimos. El mapa `AccountKey → código` se tomó de `docs/design/E2-validacion-contable.md` §3.1/§3.2
(documentación, no motor) y la clasificación de cada cuenta de `estado_financiero` /
`tipo_analitico` del seed. La cascada aplica R-A3/R-A4 (override implícito por dimensión), R-A7
(`INDIRECTO_CECO` se rutea por `CostCenter.marginLevel`), R-A11 (`NO_ANALITICO` partido, con
`630`/`633`/`638` fijo a RESULTADO) y la `MarginLevelConfig` por defecto de
`docs/design/E4-analitica.md:512`. Script: `recon.py` (efímero, fuera del repo, borrado).

| # | Métrica | Motor (sellado) | `audit-reconstruct` | Python (3.er camino) | Δ |
|---|---|--:|--:|--:|--:|
| 1 | Σdebe total (= Σhaber) | 67 193 629 | — | 67 193 629 | **0** |
| 2 | Σdebe 2026 (= Σhaber) | 52 884 809 | 52 884 809 | 52 884 809 | **0** |
| 3 | Activo | 13 673 820 | 13 673 820 | 13 673 820 | **0** |
| 4 | PN + Pasivo | 13 673 820 | 13 673 820 | 13 673 820 | **0** |
| 5 | Resultado del ejercicio | 1 497 322 | 1 497 322 | 1 497 322 | **0** |
| 6 | Tesorería (57x) | 2 943 920 | 2 943 920 | 2 943 920 | **0** |
| 7 | INGRESOS | 6 250 000 | 6 250 000 | 6 250 000 | **0** |
| 8 | MC1 | 5 670 000 | 5 670 000 | 5 670 000 | **0** |
| 9 | MC2 | 3 276 000 | 3 276 000 | 3 276 000 | **0** |
| 10 | MC3 | 3 084 110 | 3 084 110 | 3 084 110 | **0** |
| 11 | EBITDA | 2 390 430 | 2 390 430 | 2 390 430 | **0** |
| 12 | EBIT | 1 995 430 | 1 995 430 | 1 995 430 | **0** |
| 13 | BAI | 1 996 430 | 1 996 430 | 1 996 430 | **0** |

Además: los 84 asientos cuadran uno a uno (Σdebe = Σhaber por asiento), los saldos de balance por
prefijo de tres dígitos coinciden con `expected.balancesByPrefix3Cents` del fixture, y **la cascada
analítica cierra sobre la contable**: BAI + `NO_ANALITICO` fijo = 1 497 322 = el resultado de I3,
Δ 0. Sellos: `ledgerHash **4a1af0ee555f…**`, 83/83 `entry_hash` reproducidos, **24 contrastes de
sello** (eran nueve antes de la ronda: la matriz por dimensión añade quince).

**La ronda 1 no ha movido ni un céntimo.** El sustrato documental nuevo no toca el diario: la
comprobación no es una promesa del `README`, es que `tests/fixtures/documental-minimo.json` no tiene
bloque de asientos y que la liquidación de IVA se engancha al asiento de regularización **que ya
existía** (`tests/support/documental-minimo.ts:331-388`).

**Trazabilidad: OK.** El auditor independiente corre sobre una copia recién sembrada y devuelve
`CONFORME · 12/12 reconstruidas · 11/12 contrastadas` con código de salida 0.

---

## 2. Hallazgo por hallazgo

| Hallazgo | Veredicto | Evidencia (comando o fichero:línea) |
|---|---|---|
| **BLOQUEA-1** · `deletionOrder` y las FK entrantes `RESTRICT` | **CERRADO VERIFICADO** | Reproducido en clon: `DELETE FROM fiscal_years WHERE organization_id=…` desnudo sigue dando `23503 invariant_runs_fiscal_year_fkey`; el `DELETE` que emite `deleteStatement()` —con `NOT EXISTS` por arista entrante, derivado de `pg_constraint`— devuelve `DELETE 0` **sin error**. `retainersOf("store_sweeps")` = `[invariant_runs]`, `files` = `[bank_statements, extraction_runs, journal_entries]`. Y `runResetOrg` se ejecuta de verdad: `tests/integration/e12-ronda1.test.ts` 9/9 en verde sobre `audit_r2_c` |
| **BLOQUEA-2 / H-2** · el test de AST no lo ejecutaba nadie | **CERRADO VERIFICADO** | `vitest.config.ts:26` incluye `scripts/**/*.test.ts`; `npx vitest list` colecciona los **4** tests del fichero; `npm run test` → **129 ficheros, 2 723 ✓**; paso propio en `.github/workflows/fiabilidad.yml:291-292`, antes de usar el auditor. Grafo de imports del auditor: **3 módulos** (`node:crypto`, `node:fs`, `pg`), ninguno de `lib/models/ai/app` |
| **H-1** · 5/10 inyecciones sin ejercer | **CERRADO VERIFICADO** | `python3 docs/design/fixtures/build_documental_minimo.py --check` → reproduce byte a byte (0,06 s). `npm run test:acceptance`: `C4-inyeccion-1…10` **las diez en PASS** y `C4-cobertura: inyecciones ejercidas: 10/10`. WARN pasó a FAIL de verdad: `tests/acceptance/c4-inyeccion.test.ts:548` anota `FAIL` con el nombre de la tabla vacía y `:647` exige `toBe(10)`; y hay guarda anti-vacuidad en `:347` («el sustrato documental no está cargado: la cobertura no puede ser 10/10») |
| **H-3** · CI no ejecutaba lo que §8 dice | **CERRADO VERIFICADO** | **Doce** jobs en `fiabilidad.yml`, con `pureza-motor` (6-bis) y `perf` (6-ter). El guard de pureza **no está ciego**: reproducido su `grep` exacto contra un `lib/platform/impuro.ts` con `Date.now()` → lo detecta y el job fallaría. Matriz de e2e derivada de `ls tests/e2e/*.spec.ts` con suelo 13 (hay **13**); `fixtures-check` recorre los **13** generadores con suelo 12. Criterio 47 sólo en el disparador nocturno, **declarado** en el job y en §8 |
| **H-4** · job verde con sello rojo | **PARCIAL** | Ejecutado `scripts/ci-audit-fixture.ts` sobre un clon: sello **«REQUIERE REVISIÓN»** (I-E9-14, I-E11-5, I-E11-10), 86 checks / 3 FAIL, **`EXIT=0`**. La puerta nueva sí funciona para lo que cubre —`failesNoDeclarados(["I-E9-14","I-E3-7"])` → `["I-E3-7"]`, y con eso el script lanza—, pero la comprobación del sello es `sello === "VALIDADO AUTOMÁTICAMENTE" \|\| fallos.length > 0` (`scripts/ci-audit-fixture.ts:189`): como el sustrato **siempre** deja tres FAIL declarados, la segunda rama es siempre cierta y la comprobación del sello **nunca se evalúa**. El criterio 13 («el ciclo sale con sello VALIDADO AUTOMÁTICAMENTE») sigue sin cumplirse en el fixture de CI, y el resumen del PR sigue publicando un sello rojo con el job en verde. Es mucho mejor que antes (lo rojo está **declarado con motivo** y lo no declarado sí rompe), pero el enunciado de H-4 no está cerrado |
| **H-5 / AUD-8** · el auditor sólo contrastaba agregados | **CERRADO VERIFICADO** | Reinyectada AUD-8 en un clon (100 000 céntimos de `matrixCents.BAI["PROJ:P-01"]` a `["PROJ:P-02"]`, totales de nivel intactos): el auditor pasa de `CONFORME` a **`DISCREPANCIA`**, `[ALTA] I4-DIMENSION: la matriz analítica sellada no reproduce 2 de 88 celda(s)`, **`EXIT=1`**. Sobre la copia intacta, `CONFORME` sin falso positivo |
| **H-6** · `verifyRestore` no comprobaba el inventario | **PARCIAL** | La séptima comprobación existe y **nombra** la tabla ausente (`lib/platform/backup.ts:522`, test en `backup.test.ts:292`), y `I-E11-2` exige las siete en verde (`lib/ledger/invariants-e11.ts:417`). **Pero `COBERTURA_INVENTARIO` no está en `REQUIRED_CHECKS`** (`lib/platform/backup.ts:427-434`), que es lo que decide `verified`: ejecutado `isVerified([COBERTURA_INVENTARIO=FAIL, las seis PASS])` → **`verified: true`, `status: DONE`**. Una restauración a la que le falta una tabla entera se entrega como verificada; sólo el barrido posterior la desmiente. Ver **N-2** |
| **H-7** · la mitad «sellos» de `purgeDerived` | **CERRADO VERIFICADO** | `tests/integration/e12-ronda1.test.ts` (ejecutado): siembra `invoice_series.last_hash` —la única columna-sello recomputable que sobrevive a la purga— y comprueba que queda a `NULL`; el informe distingue `nulled` de `error` y las `NOT NULL` se saltan **declarándolo**, en vez de tragarse la excepción |
| **H-10** · un tick verde sobre una comparación que no se hace | **CERRADO VERIFICADO** | `models/backups.ts:1884` — la fila del `checksHash` del barrido es ahora **informativa** (sin `ok`), con el motivo escrito y remitida a ADR-0021; `evidence[].ok` es opcional en el tipo (`lib/platform/backup.ts:411`) y el estado se calcula con `row.ok !== false` |
| **H-11** · `SUMA_DEBE` nunca se contrasta | **CERRADO VERIFICADO (la parte que se eligió cerrar)** | El auditor ya **distingue**: `A-METRICA-NO-SELLADA · «SUMA_DEBE: el producto NO la sella en ningún JSON (el headline trae ACTIVO, PN_MAS_PASIVO, RESULTADO, TESORERIA). No es que se le haya cambiado el nombre: no está»`. La otra rama de la recomendación —exigir 12/12 contrastadas para conceder `CONFORME`— **no** se tomó: el veredicto sigue siendo `CONFORME` con **11/12 contrastadas**, y el criterio 13 pide Δ = 0 en las doce. Queda dicho, ya no oculto |
| **H-8** (re-fechado a E14) | **MOTIVO, no excusa** | «Ejercer dos versiones exige un artefacto del motor anterior; es una pieza propia y no entra en una ronda de corrección». Es cierto y es caro: construir y conservar un binario del motor N-1 es infraestructura, no un test |
| **H-12** (re-fechado a E14) | **MOTIVO, no excusa** | INFO puro: 4 min del job 7 para comprobar el fichero más pequeño. Re-fecharlo no deja ningún control sin ejecutar |
| **H-9** (re-fechado a E14) | **MOTIVO INEXACTO** · ver **N-4** | El motivo escrito es «atar un documento a un asiento del fixture movería el diario y con él las doce cifras canónicas». **No es así**: ni `canonicalForm` (el de `ledgerHash`) ni `canonicalEntryForm`/`V3` (el de `entryHash`) incluyen `journal_entries.file_id` (`lib/ledger/hash.ts:185-243`), y `file_id` no entra en ninguna de las doce cifras. Lo que sí es cierto —y es lo que debería decir— es que el fixture está **sellado e inmutable** y que un asiento con documento activa los invariantes de E8 (empezando por I-E8-17, ya declarado FAIL de sustrato). El re-fechado es razonable; el motivo, tal como está escrito, no se sostiene |

---

## 3. Hallazgos nuevos

**N-1 · (ALTA) La suite de aceptación está ROJA en `HEAD`, y la rompe el último commit de la
ronda.** `npm run test:acceptance` → **9 ficheros, 2 fallos / 50 ✓** (88,7 s), no los «52 ✓» que
declara `docs/ESTADO.md`. Las dos que fallan son de C7:

```
C7-1: línea 79 (2026-09-21_e12_ronda1_correccion): tests: Invalid input
tests/acceptance/c7-registro-runs.test.ts:100  (criterio 27)
tests/acceptance/c7-registro-runs.test.ts:253  (criterio 29)
```

La línea 79 de `runs/registro.jsonl` —la que añade el commit `6c9a6d5`, el último de la ronda—
lleva `tests.e2e_detalle` como **objeto anidado**, y el schema admite en `tests` un registro de
valores `number | string` o una cadena (`runs/registro.schema.ts:103-106`). El registro del run
**no valida contra su propio schema**, con lo que **I-E12-7** («`registro.jsonl` valida contra su
schema») está en **FAIL** y el job 5 de CI saldría rojo. Es la misma clase de fallo que la ronda
vino a cerrar: el commit que documenta el cierre rompe el control que la épica introduce.
*Recomendación*: aplanar `e2e_detalle` a claves de primer nivel (o serializarlo como cadena), o
ampliar el schema **a propósito** y con motivo escrito; y volver a correr la aceptación antes de
declararla verde.

**N-2 · (MEDIA) La séptima comprobación de la restauración detecta pero no decide.**
`COBERTURA_INVENTARIO` no está en `REQUIRED_CHECKS` (`lib/platform/backup.ts:427-434`), que es la
lista que `isVerified()` recorre y la que fija `verified` y `DONE`/`DONE_UNVERIFIED`
(`models/backups.ts:1920`). Ejercido: con la séptima en **FAIL** y las seis en PASS, `isVerified`
devuelve **`true`** y el estado es **`DONE`**. El documento de verificación que el cliente lee dirá
«verificada» sobre una copia a la que le falta una tabla entera —el escenario exacto de H-6 y de
H-2 de E11—; sólo `I-E11-2`, más tarde y en otro sitio, lo desmiente. *Recomendación*: añadirla a
`REQUIRED_CHECKS` (una línea) y actualizar el comentario «las SEIS».

**N-3 · (BAJA) ADR-0022 D2 («una sola definición») no se cumple del todo.** El predicado vive en
`app/(app)/admin/admin.ts:44-47` y `settings/subscription/actions.ts:55` lo importa —eso está
bien—, pero `app/(app)/settings/backups/actions.ts:276` vuelve a escribirlo en línea
(`config.billing.adminEmails.includes((user.email ?? "").trim().toLowerCase())`) en vez de llamar a
`isPlatformAdminEmail()`. Hoy el comportamiento es idéntico y **cerrado por defecto** (con la lista
vacía `adminEmails` es `[]` y `includes` es `false`, comprobado en `lib/config.ts:170-172`), así que
no hay fuga; lo que hay es la tercera copia de una autorización, que es justo lo que D2 prohíbe.

**N-4 · (BAJA) El motivo del re-fechado de H-9 no es correcto** (detallado en la tabla anterior):
`file_id` no entra en ninguna forma canónica de ADR-0011, luego atar un documento a un asiento **no**
movería las doce cifras. El re-fechado a E14 se sostiene por otras razones; el motivo escrito hay
que corregirlo, porque un motivo falso en `ESTADO.md` es el que nadie vuelve a cuestionar.

---

## 4. Lo que está bien, y conviene que conste

- **El planificador de borrado es de verdad derivado.** Lee `pg_constraint`, no una lista; el mismo
  módulo sirve a `reset-org` y a `purgeDerived`; y la decisión de **retener y declarar** en vez de
  desenganchar está razonada desde los privilegios de ADR-0020 D2, no desde el gusto.
- **La detección por dimensión existe y caza.** AUD-8, que se me escapó en la ronda anterior, ahora
  sale `DISCREPANCIA` con el check nombrado. Los contrastes de sello pasan de 9 a 24.
- **Las diez inyecciones se ejercen, y la cobertura es un aserto, no un aviso.**
- **El sustrato documental no toca el diario**, y eso se puede comprobar desde fuera: las doce
  cifras reconstruyen igual por un camino que no sabe que el sustrato existe.
- **ADR-0021 y ADR-0022** están bien hechos: el 0021 saca la nota de dentro de un ADR inmutable y
  deja una línea que apunta; el 0022 cierra por defecto en **los dos** modos de facturación, con el
  predicado único, el aviso de arranque que no falla y el runbook cambiado de «Opcional» a
  obligatoria. Comprobado en código: con `PLATFORM_ADMIN_EMAILS` vacía **no es operador nadie**.
- `npm run test` **129 ficheros / 2 723 ✓ / 11 skip**; `npm run test:integration` **186 ficheros /
  3 624 ✓** con la invocación documentada. (En mi primera pasada forcé
  `DATABASE_URL_MAINTENANCE` a un superusuario sobre el clon y saqué cinco falsos rojos en
  `e10-ronda1` y `e11a-webhook-cron`; con la invocación normal los 41 tests de esos dos ficheros
  pasan. El error era mío y lo anoto.)

---

```
VEREDICTO: DISCREPANCIA
  (en las CIFRAS no hay discrepancia: las trece reconstruyen con Δ = 0 por un tercer camino y la
   ronda 1 no ha movido ni un céntimo — ledgerHash 4a1af0ee555f…, 83/83 entry_hash, 24 sellos.
   La discrepancia es de estado: la suite de ACEPTACIÓN está roja en HEAD por el propio commit
   que cierra la ronda (N-1, I-E12-7 en FAIL), y dos de los once hallazgos declarados cerrados
   lo están a medias.)

Cifras reconstruidas: 13/13 con Δ = 0 (tabla §1, Python puro sobre el fixture y seeds/npgc.csv)
| Σdebe total 67 193 629 · Σdebe 2026 52 884 809 · Activo 13 673 820 · PN+Pasivo 13 673 820   |
| Resultado 1 497 322 · Tesorería 2 943 920 · INGRESOS 6 250 000 · MC1 5 670 000               |
| MC2 3 276 000 · MC3 3 084 110 · EBITDA 2 390 430 · EBIT 1 995 430 · BAI 1 996 430 — todas Δ 0 |

Hallazgos: 9 CERRADOS VERIFICADOS (BLOQUEA-1, BLOQUEA-2/H-2, H-1, H-3, H-5/AUD-8, H-7, H-10,
H-11 y las cifras) · 2 PARCIALES (H-4, H-6) · 4 nuevos (N-1 ALTA · N-2 MEDIA · N-3 y N-4 BAJA)
· re-fechados: H-8 y H-12 con motivo; H-9 con motivo inexacto (N-4).
Trazabilidad: OK — auditor independiente CONFORME sobre copia limpia, 12/12 reconstruidas.
Recomendación: N-1 antes que nada (una línea del registro deja roja la suite que acredita la
épica), y N-2 con ella (una línea en REQUIRED_CHECKS). H-4 y H-6 se cierran del todo con dos
cambios pequeños; H-9 no necesita código, necesita que el motivo diga la verdad.
```

---

*Re-auditoría ejecutada el 2026-09-21 en contexto limpio. Clones `audit_r2_a…d` creados desde
`erp_test` y destruidos; scripts temporales fuera del repositorio y borrados; no se modificó
producto ni fixture.*
