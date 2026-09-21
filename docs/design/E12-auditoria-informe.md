# E12 · T25 — Auditoría en contexto limpio

> Agente `auditor-fiabilidad`, contexto limpio. Entradas recibidas: `docs/spec/SPEC-FIABILIDAD.md`,
> `docs/design/E12-fiabilidad-dod.md`, `README-FIABILIDAD.md`, `docs/adr/0020-*`,
> `tests/acceptance/**`, `scripts/audit-reconstruct.ts`, `lib/ledger/invariants-e12.ts`,
> `tests/fixtures/ejercicio-completo.json` y los fixtures sellados. **No se me pasó
> razonamiento ni conversación del productor**, así que no hay nada que ignorar por ese lado.
> Base de trabajo: `audit_t25` y seis clones, todos creados desde `erp_test` y **destruidos al
> terminar**. No se ha modificado ni una línea de producto ni de fixture (`git status` limpio).

---

## 1. Las doce cifras por un TERCER camino

El primer camino es el motor. El segundo es `scripts/audit-reconstruct.ts` (SQL crudo + Node).
El tercero, el de este informe, es **Python puro sobre el JSON del fixture y `seeds/npgc.csv`**:
sin base de datos, sin SQL, sin TypeScript, sin importar nada del repositorio. Aritmética entera
en céntimos. Las reglas se tomaron de fuentes normativas —I1/I3/I4/I6 de la skill, R-B1/R-B2 del
`MODELO-DATOS`, R-A3/R-A4/R-A11 y los `MarginLevelConfig` por defecto— y no del código que las
implementa.

Sustrato: fixture `ejercicio-completo` cargado **por el motor** (`scripts/ci-audit-fixture.ts`),
los cuatro informes sellados y el barrido persistido, en ese orden; después
`npx tsx scripts/audit-reconstruct.ts --org … --ref-date 2026-12-31 --out …`.

| # | Cifra | Producto (sellado) | `audit-reconstruct` | Python (3.er camino) | Δ |
|---|---|--:|--:|--:|--:|
| 1 | Σdebe = Σhaber (total / 2026) | 67 193 629 / 52 884 809 | 52 884 809 | 67 193 629 / 52 884 809 | **0** |
| 2 | Activo | 13 673 820 | 13 673 820 | 13 673 820 | **0** |
| 3 | PN + Pasivo | 13 673 820 | 13 673 820 | 13 673 820 | **0** |
| 4 | Resultado del ejercicio | 1 497 322 | 1 497 322 | 1 497 322 | **0** |
| 5 | Tesorería (57x) | 2 943 920 | 2 943 920 | 2 943 920 | **0** |
| 6 | INGRESOS | 6 250 000 | 6 250 000 | 6 250 000 | **0** |
| 7 | MC1 | 5 670 000 | 5 670 000 | 5 670 000 | **0** |
| 8 | MC2 | 3 276 000 | 3 276 000 | 3 276 000 | **0** |
| 9 | MC3 | 3 084 110 | 3 084 110 | 3 084 110 | **0** |
| 10 | EBITDA | 2 390 430 | 2 390 430 | 2 390 430 | **0** |
| 11 | EBIT | 1 995 430 | 1 995 430 | 1 995 430 | **0** |
| 12 | BAI | 1 996 430 | 1 996 430 | 1 996 430 | **0** |

Y los cinco sellos coinciden con los del producto (`ledgerHash 4a1af0ee555f…`, nueve contrastes
de sello, 83/83 `entry_hash` reproducidos desde la tupla de ADR-0011).

**Dos veces me equivoqué yo, y las dos el producto tenía razón.** (a) Sin filtrar por ejercicio,
Activo y Tesorería salían exactamente el doble: el fixture trae la apertura de 2027. (b) Sin
aplicar R-A3/R-A4 —`INDIRECTO_CECO` + proyecto ⇒ `COSTE_DIRECTO_MC2`, y tipo directo + CECO ⇒
`INDIRECTO_CECO`— MC2 y MC3 salían 246 000 por debajo. Las reglas están escritas en
`docs/MODELO-DATOS.md` §218 y el motor las aplica bien. Lo anoto porque es la prueba de que la
reconstrucción fue de verdad independiente: un tercer camino que no se equivoca nunca es un
camino que estaba mirando el primero.

**Trazabilidad: OK.** Cifra elegida al azar: Activo. La `provenance.registros_origen` del
`headline` del `InvariantRun` se ejecuta tal cual y devuelve **104 líneas que suman 13 673 820**.
Segundos, no minutos.

---

## 2. ¿Comparte código el auditor automatizado?

**No.** Su grafo de importaciones es `node:crypto`, `node:fs` y `pg`: tres módulos, ninguno del
productor (comprobado ejecutando a mano `scripts/audit-reconstruct.imports.test.ts`, que lee el
AST con el compilador de TypeScript y cubre `import`, `import type`, `export … from`, `import()`
y `require()`). **Reimplementa** la forma canónica de ADR-0011: lee columnas crudas por SQL y
rehace el TSV y el sha256 en Node (`ledgerHashDe`, `entryHash` v2/v3 por `hash_version`). No la
copia de `lib/ledger/hash.ts` ni la delega en una función de la base. Es independencia real.

Y **dice lo que no puede ver**: su cabecera declara diez límites, con nombre y motivo —diario
coherente pero falso, error de clasificación consistente, `budgetHash` sin forma canónica fijada,
`analyticsHash` completo, ausencia de sellos, la cascada de liquidación, alteraciones simultáneas
de diario y sellos, multidivisa, periodos que no son el ejercicio, y su propio silencio—. Esa
honestidad es lo mejor del entregable. Le falta **un** límite, y es el que encontré (H-5).

### 2.1 Mis propias inyecciones (nueve, distintas de las diez del diseño)

Cada una sobre un clon recién creado, con el auditor corriendo después.

| ID | Inyección | Resultado |
|---|---|---|
| **AUD-1** | `analytic_type` de cuatro líneas de 640 cambiado de `COSTE_DIRECTO_MC2` a `COSTE_DIRECTO_MC1`, importes intactos | **Cazada** · `DISCREPANCIA` · `I-E3-7-SELLO-ROTO` (4/83) + `C4-DELTA` MC1 Δ 1 200 000 |
| **AUD-2** | `account_code` 607 → 600 (misma cuenta de grupo, mismo tipo analítico) | **La base la rechaza**: trigger `journal_lines_only_analytics_update` — «una línea posteada solo admite reclasificación analítica (ADR-0010)». La inyección no llega a existir |
| **AUD-2b** | Lo mismo con los disparadores desactivados | **Cazada** · `DISCREPANCIA` · `I-E3-7-SELLO-ROTO` |
| **AUD-3** | `entry_date` de un asiento movida del 15 al 16 de marzo (mismo ejercicio, cifras anuales idénticas) | **Cazada** · `DISCREPANCIA` · `I-E3-7-SELLO-ROTO` |
| **AUD-4** | `invariant_runs.headline.ACTIVO.cents` +1 céntimo, diario intacto | **Cazada** · `DISCREPANCIA` · `P-PRODUCTO-CONTRADICTORIO` (10/12 contrastadas) |
| **AUD-5** | `cost_centers.margin_level` de CC-GA: `EBITDA` → `MC3` (configuración, no dato) | **Cazada** · `DISCREPANCIA` · `C4-DELTA` MC3 Δ 633 180 |
| **AUD-6** | Una línea de ingresos borrada de `journal_lines` | **Cazada** · `DISCREPANCIA` · `I3-DOS-VIAS` + `I-E3-7-SELLO-ROTO` + 8 × `C4-DELTA` |
| **AUD-7** | `accounts.statement` de la 473: `BALANCE_ACTIVO` → `BALANCE_PASIVO` | **Cazada** · `DISCREPANCIA` · `C4-DELTA` en ACTIVO y PN_MAS_PASIVO, Δ 120 000 |
| **AUD-8** | 100 000 céntimos movidos de `PROJ:P-01` a `PROJ:P-02` dentro de `matrixCents.BAI` del `report_runs` de PYG_ANALITICA; **totales de nivel intactos** | **NO cazada** · veredicto `CONFORME`, ningún hallazgo nuevo → **H-5** |
| **AUD-9** | Una `OperatorException` viva insertada a mano, sin su fila en `PlatformAuditLog` | **Cazada** · el barrido pasa a `REQUIERE REVISIÓN` con `I-E12-5` en FAIL |

Ocho de nueve cazadas, una rechazada por la propia base antes de escribirse. La única que se
escapa es AUD-8, y su hueco es estructural, no accidental (H-5).

---

## 3. Purga «memoria borrada», a mano

Ejercida sobre un clon, sin usar el test: capturar → `purgeDerived` con el rol `app_maintenance`
→ comprobar el vacío → regenerar **en otro orden** (barrido **antes** de los informes y los
cuatro informes invertidos) → comparar en forma canónica, excluyendo `run_id`, `createdAt`,
`duracionMs` e `id`.

- **Tras la purga**: `report_runs = 0`, `invariant_runs = 0`, sin `InvariantRun` del que sacar
  sellos. No queda ni una cifra guardada — la comprobación negativa de §4.1 se cumple.
- **Tras regenerar en otro orden**: los **cinco sellos idénticos**, el `headline` idéntico y los
  **cuatro informes idénticos** (sha256 del conjunto serializado: `e478f20b98d36e8b…` antes y
  después). P4 se sostiene, también contra el orden, que es la variante que el diseño señalaba
  como la de mayor probabilidad de encontrar algo.
- Lo que **no** se ejerce: la mitad de `purgeDerived` que pone columnas-sello a `NULL` → **H-7**.

---

## 4. Backup → destruir → restaurar, a mano

La suite de aceptación cubre A → ZIP (por la acción real) → destruir A → restaurar B, con las
seis comprobaciones en verde, las 12 cifras y los 5 sellos de B iguales a los de A,
`audit-reconstruct` sobre B con Δ = 0, y los cinco negativos (manifest alterado ⇒
`SHA_DISCORDANTE`; firma ajena ⇒ `CLAVE_DESCONOCIDA`; `entryNumber` intercambiados; `AuditLog`
mermado; `schemaVersion` anterior ⇒ rechazo **nombrando la versión**). Los verifiqué ejecutando
la suite: **9 ficheros, 53 tests, 53 en verde, 103 s**.

Añadí **un negativo propio que la lista no tiene**: quitar una **tabla entera** del ZIP y rehacer
manifest, `manifest.sha256` y firma de forma perfectamente coherente.

| Tabla retirada | Resultado |
|---|---|
| Primer intento, con el sha recomputado a mano | `FAILED` · `SHA_DISCORDANTE` — la forma canónica del manifest no es `JSON.stringify`; correcto |
| `currencies` (0 filas) | `DONE_UNVERIFIED`, `verified = false` — pero sólo porque el barrido relativo detecta que **desaparece** `I-E11-5`. De rebote |
| `margin_level_configs` (8 filas) | `DONE_UNVERIFIED`, `verified = false` — aparecen `I-E4-1` e `I-E4-9`. También de rebote |
| `accounts` (794 filas) | `FAILED` · «fila rechazada en organization_account_maps, línea 1: » — por una clave ajena, con la causa vacía |

Se rechaza en los tres casos, pero **nunca por el motivo correcto** → **H-6**.

---

## 5. `/admin`, ADR-0020 y el rol de operador

Todo ejercido contra la base, no leyendo la interfaz.

- **`reset-org` con un asiento**: `app.operator_reset_allowed()` devuelve **`false`** sobre la
  organización del fixture (84 asientos). La negativa vive en la base, en políticas
  `RESTRICTIVE` `… OR app.operator_reset_allowed()` sobre decenas de tablas. No hay `--force`
  posible: **criterio 40 cumplido**.
- **El rol `app_operator` no toca el diario**: sólo `SELECT` sobre `journal_entries`,
  `journal_lines`, `extraction_runs`, `invariant_runs` y `closing_runs`; sobre `audit_logs`,
  `INSERT` y `SELECT` y nada más. Intentos reales: `DELETE FROM journal_entries`,
  `UPDATE journal_lines`, `UPDATE audit_logs`, `DELETE FROM audit_logs`,
  `DELETE FROM extraction_runs` → **`permission denied` los cinco**. **Criterio 43 cumplido** por
  privilegios, no por confianza.
- **La excepción mueve el sello y caduca sola.** Con el reloj inyectado por `refDate`:
  `@2026-12-30` (excepción viva) el sello lleva `EXCEPCION_DE_OPERADOR_VIGENTE` y no puede ser
  `VALIDADO AUTOMÁTICAMENTE`; `@2026-12-31`, pasada la caducidad, **el motivo desaparece**.
  **Criterios 44 y 45 cumplidos.**
- **La base rechaza las excepciones mal formadas**: `expires_at` a 48 h ⇒
  `operator_exceptions_expires_within_24h`; motivo de cinco letras ⇒
  `operator_exceptions_reason_min_length`. No es validación de formulario: es un `CHECK`.
- Matiz menor: un `DELETE` denegado por política `RESTRICTIVE` devuelve `DELETE 0`, no un error.
  Quien llame no distingue «no había nada» de «no se te permite». No es defecto; conviene que la
  acción de `/admin` lo sepa.

---

## 6. CI — qué dice `fiabilidad.yml` y qué ejecuta

Ejecutado localmente lo ejecutable:

- **`npm run test:acceptance`**: 9 ficheros, **53/53 en verde**, y los nueve
  `artifacts/acceptance/*/validacion.json` (el job exige ≥ 7).
- **`fixtures --check`**: los **12** generadores de `docs/design/fixtures/build_*.py` reproducen
  su fixture **byte a byte**, incluidos `ejercicio_completo` y `gran_volumen`. El aserto
  `[ "$n" -ge 12 ]` se cumple justo. (`build_gran_volumen.py --check` tarda **4 min 06 s** y sólo
  comprueba `spec.json`, 32 líneas → **H-12**.)
- **e2e por fichero**: los 13 specs de la matriz existen y coinciden uno a uno con
  `tests/e2e/*.spec.ts`. Correcto.
- **`NO_VERIFICABLE` = fallo**: verificado con códigos de salida reales sobre bases preparadas.
  `CONFORME` → **0**; `DISCREPANCIA` → **1**; sin nada sellado (`P-SIN-SELLOS`,
  `NO_VERIFICABLE`, 0/12 contrastadas) → **1**. **Criterio 18 cumplido.**
- **`ci-resumen.ts`**: publica el sello, los cinco hashes, las doce cifras con su Δ y el recuento
  por familia. Se lee sin abrir un artefacto. Cumple lo que §8 pide.

Lo que **no** ejecuta lo que dice: **H-3** (faltan `pureza-motor` extendido y `perf`), **H-2**
(nadie corre el test AST) y **H-4** (el job siembra un barrido rojo y no falla).

---

## 7. Matriz P1–P7 × C1–C7: qué se ejerce y qué pasa por vacuidad

La suite es, en general, **inusualmente cuidadosa con la vacuidad**: hay guardas explícitas
(`> 50` celdas etiquetadas, `> 15` motivos declarados, `> 50` runs en el registro,
`totalDeleted > 0`, `ficheros.length > 0`, «el test pasaría por vacuidad» escrito en el mensaje).
Eso hay que decirlo antes que los huecos. Los huecos son cuatro.

| Fila | Test que la cubre | ¿La ejerce de verdad? |
|---|---|---|
| **P1** LLM decide / código calcula | `c2` criterios 8–9 (grep sobre `ai/prompts/*.md`) | **Sí** · 63 PASS, con guarda anti-vacuidad |
| **P2** Fuente única | T15 + AST | **Sí** · `organizations.storage_used`/`storage_limit` no existen y ninguna lectura viva las nombra (criterio 49) |
| **P3** Snapshot antes de calcular | `c1` criterio 6 (retención) | **Sí** · 11 PASS |
| **P4** La memoria no es fuente | `memoria-borrada` (a)(b)(c) + negativa | **Sí en lo esencial** (verificado a mano), **salvo** la rama de columnas-sello → **H-7** |
| **P5** Segregación de funciones | `audit-reconstruct` + test AST | **A medias** · la reconstrucción corre en CI; **el AST no corre en ninguna suite** → **H-2** |
| **P6** Nivel de confianza en todo output | `c5` criterio 19 | **Sí** · > 50 celdas inspeccionadas, 0 sin etiqueta |
| **P7** Reproducible | `t11` + `fixtures --check` | **Sí**, salvo el criterio 47 (1,5 GB) que **ningún job ejecuta** → **H-3** |
| **C1** Snapshots versionados | `c1-snapshots` | **Sí** · incluye el `42501` real sobre `report_runs` |
| **C2** Motor determinista | `c2-motor` | **Sí** |
| **C3** Provenance ejecutable | `c3-provenance` | **Sí** para las 12 cifras y los niveles acumulados; **criterio 12 (celda → documento) no se ejerce**: el tercer salto devuelve vacío → **H-9** |
| **C4** Validación por capas | `c4-inyeccion` + `audit-reconstruct` | **No del todo** · **5 de las 10 inyecciones no se ejercen** → **H-1**; y el auditor no compara por dimensión → **H-5** |
| **C5** Niveles de confianza | `c5-sellos` | **Sí** · 12 PASS, con prueba negativa |
| **C6** Memoria | `c6-revision-humana` | **Sí** · 10 PASS, con guardas anti-vacuidad |
| **C7** Versionado del sistema | `c7-registro-runs` | **A medias** · el criterio 29 («dos versiones del motor») es **el mismo motor con dos git-sha** → **H-8** |

**Pasan por vacuidad, con nombre y apellidos:** criterio 15 (cinco de diez inyecciones),
criterio 29 (ciclo en paralelo), criterio 12 (celda → documento) y la mitad «sellos» de
`purgeDerived`. Cuatro celdas de catorce filas; las diez restantes se ejercen de verdad.

---

## 8. Hallazgos

1. **(ALTA) Cinco de las diez inyecciones de §3.5 no se ejercen y la suite sale verde.**
   `artifacts/acceptance/c4/validacion.json` · `C4-cobertura`: «inyecciones ejercidas: **5/10**».
   Las #4 (`allocation_lines`), #5 (`proposal_sha`), #6 (byte del documento), #8 (`UsageRun`) y
   #9 (cuota del 303) salen **WARN** por falta de sustrato —`allocation_lines`,
   `extraction_runs`, `files` y `usage_runs` están vacías en el fixture—. El aserto es
   `tests/acceptance/c4-inyeccion.test.ts:581` → `toBeGreaterThanOrEqual(5)`. El criterio 15 y
   **I-E12-6** dicen «las **diez** … una inyección no detectada es **FAIL**». Es la enmienda E-9
   («`NO_VERIFICABLE` no es un aprobado») incumplida justo por el control que la vigila.
   *Recomendación*: dar sustrato al fixture (un `ExtractionRun`, un `File` con bytes, un
   `UsageRun`, un `AllocationRun` y una liquidación sellada) o declarar **FAIL** la no ejercida.

2. **(ALTA) El test AST que protege la independencia del auditor no corre en ninguna parte.**
   `scripts/audit-reconstruct.imports.test.ts` no está en el `include` de `vitest.config.ts`
   (`ai/**`, `lib/**`, `forms/**`, `models/**`, `components/**`), ni en el de
   `vitest.integration.config.ts`, ni en el de `vitest.acceptance.config.ts`; y ningún job de
   `.github/workflows/**` lo invoca. El propio fichero lo admite en su cabecera. El criterio 14 e
   **I-E12-2** exigen que sea rojo **en CI**, y §13 llama a esto «el primer riesgo, alta
   probabilidad, impacto fatal». Ejecutado a mano pasa (3 módulos admitidos).
   *Recomendación*: añadir `scripts/**/*.test.ts` al `include` de `vitest.config.ts`, o un paso
   explícito en el job de pureza.

3. **(ALTA) `fiabilidad.yml` no ejecuta los nueve jobs que §8 describe.** Tiene nueve, pero dos
   son otros: faltan **`pureza-motor`** —que §8 exige *extendido a `lib/platform/**` y a
   `scripts/audit-reconstruct.ts`*— y **`perf`** —techos 3, 5, 6 y 8 sobre `gran-volumen`, sólo
   en `push` a `main`, con degradación > 20 % como fallo—; en su lugar hay `lint-tsc` y `build`.
   El `pureza-motor` de `ci.yml:152` cubre ocho directorios de `lib/` y **no** `lib/platform` ni
   el auditor. Consecuencia directa: el **criterio 47** (backup de 1,5 GB en streaming, pico de
   memoria estable, < 15 min) no lo ejecuta **ningún** job de CI.

4. **(MEDIA) El job `auditor-automatizado` siembra un barrido rojo y no falla.** Reproducido con
   `scripts/ci-audit-fixture.ts`: sello **`REQUIERE REVISIÓN`**, motivos «invariantes en FAIL:
   I-E9-14, I-E11-5, I-E11-10», 86 checks / 3 FAIL. El script cuenta los FAIL y sólo los imprime;
   el job sigue en verde y publica ese sello en el resumen del PR. El **criterio 13** dice «el
   ciclo **sale sin intervención humana** con sello `VALIDADO AUTOMÁTICAMENTE`». La suite de
   aceptación sí clasifica esos tres como sustrato (`C4-sustrato-*`, INFO, con motivo escrito);
   el job de CI no hace esa distinción ni la declara.
   *Recomendación*: que `ci-audit-fixture.ts` falle ante cualquier FAIL que no esté en una lista
   **cerrada y con motivo** de FAIL de sustrato, igual que hace la suite.

5. **(MEDIA) El auditor automatizado sólo contrasta agregados: una redistribución por dimensión
   dentro de un informe sellado pasa como `CONFORME`.** Inyección **AUD-8**: 100 000 céntimos
   movidos de `matrixCents.BAI["PROJ:P-01"]` a `["PROJ:P-02"]` en el `report_runs` de
   `PYG_ANALITICA`, totales de nivel intactos → veredicto **`CONFORME`**, ningún hallazgo nuevo.
   Ninguno de los diez límites declarados en la cabecera del script cubre esto. Y es el mismo
   hueco que delata la inyección **#3 del propio diseño**: el diseño dice que la cazará «I4 **por
   dimensión**», y en la ejecución real la cazó `I-E3-7` (el `entry_hash`), porque **la
   comparación por dimensión no existe en ningún sitio**.
   *Recomendación*: reconstruir también `matrixCents` por columna (el auditor ya calcula el nivel
   de cada línea: le falta agrupar por dimensión) y, mientras no lo haga, **añadir el límite nº 11
   a la cabecera**. Un auditor que no dice lo que no ve es peor que uno que no lo ve.

6. **(MEDIA) `verifyRestore` no comprueba la cobertura del inventario.** La comprobación 1
   (RECUENTOS) itera sobre **`manifest.tables`** (`models/backups.ts:1568-1575`), es decir, sobre
   la lista que el propio ZIP declara: si una tabla desaparece del ZIP **y** del manifest, esa
   comprobación no puede notarlo. Ejercido a mano (§4): los tres casos se rechazan, pero por un
   invariante que se mueve de rebote o por una clave ajena con la causa vacía, nunca por
   inventario. Es la forma exacta de **H-2 de E11** —`currencies`, 177 filas/org, perdida con las
   seis comprobaciones en PASS— trasladada al lado de la restauración, y la enmienda **E-4**
   («todo inventario es derivado») aplicada al emitir pero no al verificar.
   *Recomendación*: comparar `manifest.tables` contra
   `backupInventory(BACKUP_TENANT_MODELS, prismaSchemaMeta())` y **FALLAR nombrando las tablas
   ausentes**. La derivación ya existe y se usa al emitir (`models/backups.ts:457`).

7. **(MEDIA) La mitad «columnas-sello» de `purgeDerived` no la ejerce nada.** Purga manual sobre
   el fixture: 5 filas borradas (4 `report_runs` + 1 `invariant_run`) y **0 de las 44 columnas
   listadas por `purgableSeals()` puestas a `NULL`** —las filas que las contienen ya se habían
   borrado, o la tabla está vacía—. Además `purgeDerived` **captura cualquier excepción del
   `UPDATE` y la anota como `nulled: 0`** (`models/purge-derived.ts:213-219`), de modo que «no
   había nada que anular» y «el `UPDATE` falló» son indistinguibles en el informe. El test sólo
   exige `totalDeleted > 0`. El párrafo de §4.1 sobre el baile `NO FORCE → UPDATE → FORCE` no
   está demostrado por nada.
   *Recomendación*: distinguir en `PurgeReport` entre `nulled: 0` y `error`, y añadir al fixture
   (o a la organización del test) al menos una fila con columna-sello recomputable que sobreviva
   a la purga de tablas.

8. **(MEDIA) El criterio 29 pasa por vacuidad.** «Dos versiones del motor sobre el mismo
   snapshot» se simula en `tests/acceptance/c7-registro-runs.test.ts:219-243` ejecutando **el
   mismo motor dos veces** con dos cadenas de git-sha (`"0000aaa"` / `"0000bbb"`). Que
   `diff.cause === "MOTOR"` y que las cifras coincidan son consecuencias de la construcción, no
   resultados. Es un test correcto **de `diffRuns`**, etiquetado como el ciclo en paralelo que
   §C7 exige antes de promover un cambio de motor.

9. **(BAJA) El criterio 12 no se ejerce.** `C3-drilldown-documento` sale **WARN**: «el asiento del
   fixture completo es MANUAL y no tiene documento adjunto: el tercer salto se ejecuta y devuelve
   vacío». Declarado con honestidad —y remitido al e2e documental de E8—, pero la celda queda sin
   cubrir por la suite de aceptación, que es donde el criterio está escrito.

10. **(BAJA) Un tick verde sobre una comparación que no se hace.** En `BARRIDO_INVARIANTES`, la
    fila de evidencia `checksHash del barrido` lleva **`ok: true` escrito a mano**
    (`models/backups.ts:1860-1865`): enseña `expected` y `actual` distintos y los marca en verde.
    Observado en mis restauraciones (`f624dd81…` vs `19d4ba64…`, `ok: true`). Es exactamente el
    anti-patrón que la enmienda **E-2** prohíbe. Debe ser informativa, sin `ok`.

11. **(BAJA) `SUMA_DEBE` nunca se contrasta, y el veredicto sigue siendo `CONFORME`.** El
    producto no la sella en ningún JSON, el sondeo por nombre de clave no la encuentra, la fila
    sale «sin comparar» y el resultado es **11/12 contrastadas** con veredicto `CONFORME`. El
    criterio 13 dice «Δ = 0 **en las 12**». El mecanismo —buscar la métrica por el nombre de la
    clave dentro del JSON sellado— hace además indistinguible «el producto no la sella» de «al
    producto le cambiaron el nombre de la clave». La propia suite lo anota en `C4-limite-sondeo`.
    *Recomendación*: sellar `SUMA_DEBE` en el `headline`, o exigir explícitamente que las doce
    estén contrastadas para conceder `CONFORME`.

12. **(INFO) `build_gran_volumen.py --check` tarda 4 min 06 s** y comprueba `spec.json` (32
    líneas), no el dataset de 50 000 asientos que `generate.ts` deriva de él. Es el 80 % del
    tiempo del job `fixtures-check` para verificar el fichero más pequeño de los doce.

---

## 9. Lo que está bien, y conviene que conste

- La reconstrucción independiente **funciona y es independiente de verdad**: tres módulos, forma
  canónica reimplementada desde el ADR, y ocho de mis nueve inyecciones cazadas con el check
  nombrado. La novena la rechazó la propia base.
- **La base defiende el diario mejor que el código.** Un `UPDATE` de `account_code` sobre una
  línea posteada no se puede hacer ni como propietario sin desactivar disparadores; el rol
  `app_operator` no tiene privilegio alguno de escritura sobre el diario ni sobre las tablas
  append-only; `reset-org` lo niega Postgres, no la aplicación.
- **P4 se sostiene**, incluido el orden de regeneración, que era la variante con más
  probabilidad de encontrar algo.
- **El sello se mueve con la excepción de operador y vuelve al caducar.** ADR-0020 D5/D6
  funciona, con `refDate` inyectable y `CHECK` en la base, no en el formulario.
- La suite de aceptación está escrita **contra la vacuidad** de forma deliberada y sistemática.
  Los cuatro huecos que encontré son cuatro entre catorce, y tres de ellos están **declarados en
  el propio artefacto** (`C4-cobertura`, `C3-drilldown-documento`, `C4-limite-sondeo`). Un
  proyecto que escribe sus propios huecos en el `validacion.json` es un proyecto que se puede
  auditar.

---

```
VEREDICTO: DISCREPANCIA
  (en las CIFRAS no hay discrepancia: las doce reconstruyen con Δ = 0 por un tercer camino.
   La discrepancia es entre lo que E12 declara cumplido en §10 y lo que de verdad se ejecuta:
   criterios 14 y 15 incumplidos, criterio 13 no comprobado en CI, criterio 47 sin job.)

Cifras reconstruidas:
| Métrica        | Motor      | Reconstrucción | Δ | Método                                  |
| Σdebe 2026     | 52 884 809 | 52 884 809     | 0 | Python sobre el JSON del fixture        |
| Σdebe total    | 67 193 629 | 67 193 629     | 0 | ídem                                    |
| Activo         | 13 673 820 | 13 673 820     | 0 | estado_financiero de seeds/npgc.csv     |
| PN + Pasivo    | 13 673 820 | 13 673 820     | 0 | ídem, signo invertido                   |
| Resultado      |  1 497 322 |  1 497 322     | 0 | I3: 6/7 sin REGULARIZATION/CLOSING/OPEN |
| Tesorería      |  2 943 920 |  2 943 920     | 0 | saldo 57x, kind ≠ CLOSING               |
| INGRESOS…BAI   | 6 250 000… | idénticas      | 0 | cascada R-A3/R-A4/R-A11 + MarginLevel   |
| 5 sellos       | 4a1af0ee…  | idénticos      | 0 | forma canónica ADR-0011, 83/83 entryHash|

Hallazgos: 12 (3 ALTA · 4 MEDIA · 4 BAJA · 1 INFO). Ver §8.
Trazabilidad: OK — Activo → 104 líneas de origen ejecutando su propia consulta de provenance.
Recomendación: cerrar H-1 y H-2 antes de dar E12 por hecha (son la mitad de la matriz de
detección y el único control que protege la independencia de la Capa 2), y H-3 en la misma
ronda: un workflow que no ejecuta lo que su diseño dice es, en una épica sobre fiabilidad, el
hallazgo que más caro sale. H-5, H-6 y H-7 son deuda con fecha, no bloqueo.
```

---

*Auditoría ejecutada el 2026-09-21 en contexto limpio. Bases `audit_t25*` creadas desde
`erp_test` y destruidas; scripts temporales del auditor eliminados; `git status` limpio. No se
modificó producto ni fixture.*
