# E12 — Fiabilidad DoD (diseño)

> **Qué es esta épica.** E12 no añade contabilidad. E12 **demuestra** lo que las
> once épicas anteriores afirman, y cierra la spec que las gobierna. La
> `SPEC-FIABILIDAD v1.0` tiene su propia *Definition of Done* escrita (§6):
> auditoría con los ALTA cerrados, **tests de aceptación de C1–C7 pasando**
> —incluido el de error inyectado y el de **memoria borrada**—, un ciclo completo
> con sello `VALIDADO AUTOMÁTICAMENTE` y provenance consultable, un
> `README-FIABILIDAD.md` para humanos, y **la propuesta de v1.1**. Esa lista, y
> no otra, es el alcance de E12.

| | |
|---|---|
| Épica | **E12 Fiabilidad DoD** |
| Depende de | E7, E8 (y de hecho de E11: cierra su deuda) |
| Nivel | **2** sólo en tres puntos: **ADR-0020** (escrituras de operador), la **enmienda a ADR-0018 D2** (CAPEX en el `budgetHash`) y el cambio del `backupInventory`/formato del ZIP en streaming. El resto es Nivel 1 |
| Diseño | este documento |
| ADR nuevo | `docs/adr/0020-escrituras-de-operador-y-excepciones-auditadas.md` — **APROBADO por Pablo** (permiso delegado de 2026-09-04) **el 2026-09-15**, D1–D6 |
| ADR enmendado | **ADR-0018 · D2 ENMENDADA el 2026-09-15**: CAPEX dentro del `budgetHash`, fixture sellado a **v1.4** (v1.0–v1.3 congeladas). Se implementa en **T19** |
| Propuesta de spec | `docs/spec/SPEC-FIABILIDAD-v1.1-propuesta.md` (**no modifica la v1.0**) |
| Esfuerzo | **584 h · 26 tareas · 3 olas + cola de verificación** |

---

## 1. Objetivo y alcance

**Objetivo.** Que cualquier persona —Pablo, un auditor externo, un cliente— pueda
sentarse delante del sistema y **comprobar en diez minutos** que sus cifras son
las que dice, y que una máquina lo compruebe en cada `push`.

### 1.1 Alcance

1. **Matriz de cumplimiento** de `SPEC-FIABILIDAD v1.0`: P1–P7 × C1–C7, con
   fichero/invariante/pantalla que lo implementa, test que lo demuestra y **qué
   falta** (§2).
2. **Siete tests de aceptación end-to-end** en `tests/acceptance/`, uno por
   componente, sobre el **fixture completo** y el **preview local** (§3).
3. **Auditor adversarial automatizado** (`scripts/audit-reconstruct.ts`): un
   segundo motor, en SQL crudo, que reconstruye **las 12 cifras canónicas** sin
   importar ni una línea de `lib/**`, y exige **Δ = 0**. En CI, no sólo en la
   cabeza de un agente (§3.4).
4. **Test «memoria borrada» (P4)** y **test «reconstrucción desde backup»** (§4).
5. **`/admin` con escrituras de operador**, gobernadas por **ADR-0020**:
   excepciones auditadas a los invariantes, con motivo, `PlatformAuditLog`, doble
   confirmación y una regla sin excepciones — **nunca tocan el diario** (§5).
6. **Cierre de TODA la deuda fechada en E12** por E9, E10 y E11, con tarea
   asignada; lo que no cabe se re-fecha **con motivo** y es **mínimo** (§6).
7. **`README-FIABILIDAD.md` final** y **`SPEC-FIABILIDAD-v1.1-propuesta.md`** (§7).
8. **CI**: workflow que ejecuta unit + integración + RLS + aceptación C1–C7 +
   auditor automatizado + `fixtures --check` + e2e **por fichero**, y publica
   `validacion.json` como artefacto (§8).

### 1.2 Qué NO incluye

- **Contabilidad nueva.** Ni un asiento, ni una plantilla, ni un impuesto.
- **El ciclo comercial** (factura emitida con PDF, envío, cobro, aging) y la
  **pantalla de export 303/349**: son **E14**, ya fechadas.
- **Regularización de bienes de inversión** (arts. 107-110 LIVA): sigue
  declarada como «lo que el sistema NO garantiza».
- **Un `/admin` completo de plataforma.** E12 entrega **cuatro** escrituras de
  operador (§5.2), no un back-office. Lo demás sigue siendo SQL de runbook.
- **Arqueo de caja como fuente equivalente** al extracto bancario (la nota de
  `fiabilidad/SKILL.md` §C5 dice «podría serlo en E12, con ADR»): **no**. Un
  arqueo lo firma la misma parte que lleva la caja; no es fuente externa. Queda
  cerrado como decisión, no como deuda.

---

## 2. Matriz de cumplimiento de `SPEC-FIABILIDAD v1.0`

Leyenda: **C** cumple · **P** parcial (el hueco está nombrado) · **NC** no cumple.
«Qué falta» es lo que E12 tiene que entregar; cada hueco lleva su tarea de §9.

### 2.1 Principios P1–P7

| # | Principio | Estado hoy | Qué lo implementa | Qué lo demuestra hoy | Qué falta (tarea) |
|---|---|---|---|---|---|
| **P1** | El LLM decide y redacta; el código calcula | **C** | `ai/analyze.ts` sólo produce candidatos → `lib/extraction/reconcile.ts` (RC-01…RC-25) → `lib/ledger/postFromProposal.ts`. Informes: `lib/ledger/reports/**`, `lib/analytics/margins.ts`, agregados SQL en `models/reports.ts`. Guard de pureza en CI sobre diez directorios | `reconcile.test.ts`, `postFromProposal.test.ts`, I-E8-1/8/9/10, job `pureza-motor` | **Prueba negativa que falta**: nadie comprueba que el prompt de redacción prohíbe recalcular (§C2 de la spec lo pide literalmente: «grep sobre los prompts»). **T3** |
| **P2** | Fuente única de verdad | **C** | `JournalEntry`/`JournalLine` única fuente de cifras; `ExchangeRate` append-only; `Transaction` degradado a operación | I-E8-4, I-E8-14, I7, I10 | **`organizations.storage_used`/`storage_limit`** son una segunda fuente viva y deprecada del mismo dato que `models/usage.ts` deriva. **T15** |
| **P3** | Snapshot antes de calcular | **C** | `ReportRun` por `(paramsHash, ledgerHash, analyticsKey, planHash, accountMapHash, gitSha)`; `InvariantRun` sellado; `ClosingRun`, `AllocationRun`, `UsageRun`, `BackupJob` | I-E7-10, I-E11-1, I-E11-3, `report-run.test.ts` | **Retención de snapshots** (C1 pide «12 ciclos + 1 por mes histórico») no está declarada ni comprobada: `scripts/prune-runs.ts` poda, pero nadie verifica el mínimo. **T2** |
| **P4** | La memoria nunca es fuente de cifras | **P** | `File.cachedParseResult` eliminada (E8); niveles de confianza derivados en lectura, nunca persistidos; cachés siempre con hash de fuente | I-E11-1 (una caché con `sourceHash` distinto es **FAIL**, no «caducada») | **El test que lo prueba no existe**: nadie ha borrado nunca todas las cachés y comprobado que las cifras vuelven **byte a byte**. Es el test que la spec §6 exige por su nombre. **T10** |
| **P5** | Quien calcula ≠ quien redacta ≠ quien audita | **P** | Extractor ≠ `reconcile` ≠ `/audit` ≠ agente `auditor-fiabilidad` en contexto limpio; segregación de agentes en `CLAUDE.md` | Los informes `docs/design/E*-auditoria*.md`: E7 (7 hallazgos, 3 ALTA), E9 (H-1…H-6), E10 (H-1…H-7), E11 (3 bloqueantes) | **La tercera firma es humana-en-el-bucle y no corre en CI.** Un `push` puede romper una cifra y no enterarse hasta la próxima épica. Falta el **auditor automatizado**. **T5, T6** · *Éste es el `G-14` canónico* |
| **P6** | Todo output lleva nivel de confianza | **C** | `lib/audit/confidence.ts`, cuatro niveles por campo en `ExtractionRun.fieldOrigins`, tres niveles por cifra derivados en lectura, badges en informes y `/audit` | I-E7-6b, I-E8-10, `confidence.test.ts` | Nada estructural. Falta **una** comprobación de cobertura: que no exista celda de informe **sin** etiqueta. **T7** |
| **P7** | Todo es reproducible | **P** | `gitSha` en `ReportRun`/`InvariantRun`; `prompt_sha`/`schema_sha`/`proposal_sha` en `ExtractionRun`; `runs/registro.jsonl`; backup 2.0 firmado con las seis comprobaciones como criterio de P7 (ADR-0019 D2) | I-E8-11, I-E11-2, I-E11-3, `hash.test.ts`, fixtures sellados `--check` en CI | (a) **El ZIP se construye en memoria** y a volumen real no cabe: la prueba de P7 no escala. **T14** · (b) No hay **test de reconstrucción desde backup** como parte de la aceptación. **T11** · (c) Sin `GIT_SHA` el sello es `REQUIERE REVISIÓN` a propósito, pero **CI no lo inyecta** en todas las suites. **T22** |

**Lectura de conjunto.** De los siete principios, cinco están cumplidos y
demostrados. Los dos que no —**P4** y **P5**— fallan por la misma raza: *el
mecanismo existe y nadie lo ha ejercido nunca de extremo a extremo*. Es la misma
patología que el auditor encontró en E9, E10 y E11 (invariantes que el motor sabía
calcular y el barrido nunca componía). E12 la cierra con tests, no con código
nuevo.

### 2.2 Componentes C1–C7

| # | Componente | Estado | Qué lo implementa | Test que lo demuestra (hoy → E12) | Qué falta |
|---|---|---|---|---|---|
| **C1** | Snapshots versionados | **C** | `ReportRun`, `InvariantRun`, `AllocationRun`, `ClosingRun`, `UsageRun`, `BackupJob`; sellos `ledgerHash`/`analyticsKey`/`planHash`/`accountMapHash`/`configHash`; append-only en base (`REVOKE UPDATE, DELETE` + RESTRICTIVE) | `report-run.test.ts`, `e7-esquema.test.ts` → **`tests/acceptance/c1-snapshots.test.ts`** | Aceptación literal de la spec: «ejecutar **dos veces** el ciclo sobre el mismo snapshot produce resultados **byte-idénticos**». Y la **retención mínima** |
| **C2** | Motor de cálculo determinista | **C** | `lib/{ledger,analytics,audit,bank,closing,recurring,budget,time,accounts,taxes}/**` puros, `f(input, config, refDate)`; guard en CI | ~2 531 tests unitarios → **`c2-motor.test.ts`** | Los **casos límite que la spec nombra** (vacío, un registro, negativos, fechas límite) no están reunidos en un solo sitio, y **falta el grep sobre los prompts de redacción** |
| **C3** | Trazabilidad (provenance) | **P** | `lib/ledger/provenance.ts`: métrica, `run_id`, `ledgerHash`, `calculado_por`, consulta **parametrizada** y `confianza`; drill-down de `/reports` y `/analytics` | `e4-analytics.test.ts`, e2e `informes` → **`c3-provenance.test.ts`** | **La consulta viaja pero nadie la ejecuta en un test.** E10 ya destapó que en los niveles acumulados devolvía **0 filas**. Falta: para las 12 cifras, **ejecutar** la consulta y exigir `Σ = valor` |
| **C4** | Validación por capas | **P** | Capa 1: `runLedgerInvariants` (nueve familias, `validacion.json`) · Capa 2: agente `auditor-fiabilidad` · Capa 3: `ManualReviewFlag` + umbrales `EV-*` + `lib/audit/diff.ts` | `run-invariants.ts`, `perf-audit.test.ts`, prueba de detección de `/audit` → **`c4-auditor.test.ts` + `scripts/audit-reconstruct.ts`** | **La Capa 2 no es automática.** Es la brecha principal de E12 (§3.4) |
| **C5** | Niveles de confianza | **C** | `lib/audit/confidence.ts`; sello del periodo con **motivos de código cerrado** (E7×4, E8×6, E9×5, E10×5); `SIN_EVALUAR` jamás en verde | `confidence.test.ts`, `families.test.ts` → **`c5-sellos.test.ts`** | Cobertura: **ninguna celda sin etiqueta**, y **ningún motivo de sello huérfano** (declarado en la skill y no emitido por nadie, o al revés) |
| **C6** | Memoria | **P** | `AuditLog` y `PlatformAuditLog` append-only y estructurados; `runs/registro.jsonl`; `ManualReviewFlag` con `invariantRunId` + `checkFamily` (enum, no texto) | `e7-ronda1.test.ts` → **`c6-revision-humana.test.ts`** | La aceptación de C6 **es** el test de memoria borrada (§4). Y falta el camino completo «forzar revisión → sello cambia → limpiar con motivo → sello vuelve» probado de punta a punta |
| **C7** | Versionado del propio sistema | **P** | `runs/registro.jsonl` (72 runs), `gitSha` en los runs, prompts en `ai/prompts/*.md`, fixtures sellados con `--check` en CI | `fixtures.test.ts`, job `fixtures-sellados` → **`c7-registro-runs.test.ts`** | (a) `registro.jsonl` **no tiene esquema ni validador**: un run mal escrito pasa · (b) falta el **ciclo en paralelo viejo/nuevo sobre el mismo snapshot** que §C7 exige antes de promover un cambio de motor · (c) la trazabilidad inversa «entregable histórico → versión + snapshot» no está probada |

### 2.3 Los 22 gaps de `AUDITORIA-FIABILIDAD.md`: qué queda abierto

| Estado | Gaps | Nota |
|---|---|---|
| **CERRADOS** | G-01…G-13, G-15…G-19, G-21, G-22 | Los seis ALTA en E6/E8; G-15 (backups) en E11 |
| **ABIERTO** | **G-14** — *roles no separados: un solo prompt extrae y redacta, y el único auditor es el humano; no existe validación automática* | **Erratum de doble numeración, el segundo de la serie.** `docs/ESTADO.md` §«E8 — deuda» lo rotula «G-14 · conciliación bancaria» y lo fecha en E12; el `G-14` **canónico** de `AUDITORIA-FIABILIDAD.md` es la **segregación de funciones (P5)**. La conciliación bancaria la entregó **E7** entera. Lo que de verdad falta de G-14 es la **Capa 2 automática**, que es el corazón de E12 → **T5, T6, T18** |
| **ABIERTO** | **G-20** — *sin tests de `models/stats.ts`, `lib/stats.ts`, `ai/*`* | `stats` se reescribió en E6 y `ai/*` en E8, pero **G-20 no apareció en la lista de cierre de ninguna épica**. → **T18** |
| **ABIERTO** | **G-20-bis** — *restaurar un ZIP ajeno desde la interfaz* (resto de G-15) | La numeración `G-20` está usada **dos veces** en el seguimiento (`ESTADO.md` y `ROADMAP.md`). Se renombra a **`G-15b`** en la documentación de cierre, **sin reenumerar `AUDITORIA-FIABILIDAD.md`**, que es inmutable → **T16** |

> **Regla que E12 escribe y T23 aplica:** un identificador `G-nn` sólo significa
> lo que dice `AUDITORIA-FIABILIDAD.md`. Cualquier otro uso se renombra en el
> documento que lo inventó, nunca en la auditoría. Es la tercera vez que esta
> errata cuesta una épica de confusión (G-14, G-15, G-20).

---

## 3. Tests de aceptación C1–C7 (`tests/acceptance/`)

### 3.1 Andamiaje (T1)

Directorio nuevo `tests/acceptance/`, suite propia
`vitest.acceptance.config.ts` (secuencial, sin paralelismo entre ficheros: todos
tocan la misma organización efímera), y `npm run test:acceptance`.

**Sobre qué corre.** Dos sustratos, siempre los dos:

| Sustrato | Qué es | Por qué |
|---|---|---|
| **Fixture completo** | `tests/fixtures/ejercicio-completo.json` cargado **por el motor** (`scripts/load-fixture.ts`, nunca por SQL de arnés) en una organización efímera | Las cifras esperadas son conocidas y están congeladas |
| **Preview local** | `docker compose up` + `prisma migrate deploy` + siembra por el asistente de onboarding real | Un test que sólo corre sobre un arnés prueba el arnés. Lección de H-6 de E8 |

**Contrato común de la suite** (`tests/acceptance/harness.ts`):

- `GIT_SHA` **fijado y explícito**. Sin él el sello es `REQUIERE REVISIÓN` a
  propósito (runbook de E3) y la mitad de los asertos serían falsos negativos.
- `refDate` **siempre explícita**. Nada depende del día en que corra el test.
- Cada test escribe su `validacion.json` en `artifacts/acceptance/<C>/`, con el
  **mismo formato** que `scripts/run-invariants.ts` — es lo que CI publica (§8).
- **Ningún test importa el módulo que prueba para calcular lo esperado.** Las
  cifras esperadas son literales congelados o vienen de SQL propio.

### 3.2 Las 12 cifras canónicas

Es el contrato de comparación de C3, C4 y del test de memoria borrada. Sobre el
fixture completo, ejercicio 2026, en céntimos:

| # | Cifra | Valor esperado | De dónde sale |
|---|---|---|---|
| 1 | Σdebe = Σhaber del diario | **67 193 629** (2026: 52 884 809) | I1 |
| 2 | Activo total | derivado, sellado en `InvariantRun` | I2 |
| 3 | PN + Pasivo total | = #2, tolerancia 0 | I2 |
| 4 | Resultado del ejercicio | **1 497 322** | I3 · **es el nudo**: cierra el bloque contable y abre el analítico |
| 5 | Tesorería (saldo final 57x) | derivado, sellado | I6 |
| 6 | INGRESOS | **6 250 000** | I4, nivel |
| 7 | MC1 | **5 670 000** | I4 |
| 8 | MC2 | **3 276 000** | I4 |
| 9 | MC3 | **3 084 110** | I4 |
| 10 | EBITDA | **2 390 430** | I4 |
| 11 | EBIT | **1 995 430** | I4 |
| 12 | BAI | **1 996 430** | I4 · y `resultadoAntesImpuestoCents` del fixture |

*(`RESULTADO` del bloque analítico = #4 por construcción: si I3 e I4 no se tocan
en el mismo número, uno de los dos miente. Por eso son 12 y no 13.)*

Y **cinco sellos**: `ledgerHash`, `analyticsKey`, `planHash`, `accountMapHash`,
`configHash`.

### 3.3 Un test por componente

| Fichero | Componente | Qué ejerce, de punta a punta |
|---|---|---|
| **`c1-snapshots.test.ts`** | C1 | Carga el fixture → emite los cuatro informes → **repite el ciclo entero** sin tocar el diario → los `ReportRun` **se sirven de caché** y el JSON de resultado es **byte-idéntico**. Postea un asiento → el `ledgerHash` cambia, el informe anterior **sigue existiendo** y no se ha sobrescrito. Intenta `UPDATE` sobre `report_runs` como `app_runtime` → `42501`. Comprueba la **retención**: ≥ 12 runs recientes + 1 por mes, y que `prune-runs.ts` no cruza ese suelo |
| **`c2-motor.test.ts`** | C2 | Los cinco casos límite de la spec sobre **todos** los motores puros: dataset vacío, un solo registro, importes negativos, fecha de inicio y fin de ejercicio, y periodo sin ningún movimiento. Ningún motor devuelve `NaN`, ninguno lanza, ninguno inventa una fila. Más el **grep exigido por §C2**: todo prompt de `ai/prompts/*.md` que redacte contiene la instrucción explícita de **no recalcular**, y ninguno contiene una operación aritmética pedida al modelo (lista negra: `suma`, `calcula el total`, `multiplica`…) |
| **`c3-provenance.test.ts`** | C3 | Para **las 12 cifras**: pide la celda al informe, **ejecuta su `provenance.query` con sus `parametros`** dentro de `tenantTransaction`, y exige `Σ(filas) = valor`, tolerancia 0. Repite en los **niveles acumulados** (que es donde E10 lo pilló en 0 filas). Y mide el recorrido que la spec cronometra: **de la celda al documento en < 2 min** — aquí, en ≤ 3 saltos de identificador y < 5 s de máquina |
| **`c4-auditor.test.ts`** | C4 | Capa 1: barrido completo, las nueve familias **evaluadas** (ninguna `SIN_EVALUAR`), `validacion.json` con cada check en PASS/FAIL **y evidencia**. Capa 2: ejecuta `scripts/audit-reconstruct.ts` y exige **Δ = 0 en las 12**. Capa 3: la **matriz de inyección** de §3.5. Ciclo limpio → sale **sin intervención**; ciclo con error → **alguien lo caza y se nombra** |
| **`c5-sellos.test.ts`** | C5 | Las tres etiquetas se conceden **por composición** y se **retiran** al llegar un dato nuevo (extracto de febrero con movimiento de diciembre retira un badge de diciembre). Cobertura: **0 celdas sin etiqueta** en los cuatro informes. Vocabulario **cerrado**: ningún motivo de sello emitido que no esté en `fiabilidad/SKILL.md`, y ninguno declarado que nadie emita. Una familia no compuesta sale `SIN_EVALUAR`, **jamás en verde** |
| **`c6-revision-humana.test.ts`** | C6 | Camino completo: barrido limpio (`VALIDADO AUTOMÁTICAMENTE`) → ADMIN **fuerza revisión** con motivo y familia → el sello pasa a `REQUIERE REVISIÓN` **nombrando el motivo** → un informe emitido en ese estado **lo lleva impreso** → se limpia con `clearReason` → vuelve. `VIEWER` no puede forzar ni limpiar. El `ManualReviewFlag` queda con su `invariantRunId` y su `checkFamily` (enum). Y la memoria: `AuditLog` **no acepta** `UPDATE`/`DELETE`, y **ninguna de sus filas contiene una cifra de negocio como verdad vigente** (test estructural sobre las claves del JSON) |
| **`c7-registro-runs.test.ts`** | C7 | `runs/registro.jsonl` valida contra un **schema zod nuevo** (`run_id` único, `ts_utc`, `git_sha_base`, `tipo`, `epica`, `tareas`, `agentes`, `modelos`, `tests`, `sello`), es append-only (el fichero sólo crece entre dos commits) y **todo `ReportRun`/`InvariantRun` sellado tiene su `run_id` localizable**. Trazabilidad inversa: dado un `ReportRun` cualquiera, se recupera git-sha + snapshot + parámetros y **se vuelve a emitir el mismo informe**. Y el **ciclo en paralelo**: dos versiones del motor sobre el mismo snapshot → diff cero o diff explicado (lo ejecuta `lib/audit/diff.ts`, que ya clasifica `DATOS`/`MOTOR`/`CONFIGURACION`) |

### 3.4 C4 · El auditor adversarial **automatizado** (T5) — el corazón de E12

Hasta hoy la Capa 2 la ha hecho un agente en contexto limpio, una vez por épica,
y **ha encontrado lo que los tests no veían las cuatro veces**. Eso es la prueba
de que funciona y, a la vez, de que no basta: entre épica y épica no vigila nadie.

**Qué es.** `scripts/audit-reconstruct.ts`: un segundo motor, mínimo y hostil.

| Regla | Por qué |
|---|---|
| **No importa nada de `lib/**`, `models/**` ni `ai/**`** | Si comparte código con el productor, confirma en vez de refutar. Lo comprueba un **test estático sobre el AST de sus importaciones**, no una promesa en un comentario |
| Habla con la base por **SQL crudo** (`pg`), con `DATABASE_URL_MAINTENANCE` | Mismo rol y mismo camino que el auditor humano usó en E10 y E11 |
| Reimplementa los sellos **desde la tupla de ADR-0011**, no desde `lib/ledger/hash.ts` | Un hash que se compara consigo mismo no prueba nada |
| **Aritmética entera**, sin `float`, sin `Decimal` de librería | Es la aritmética que el auditor humano usó en Python |
| Recibe **sólo** `--org`, `--ref-date`, `--fiscal-year` y el fichero de cifras esperadas | «Recibe sólo el snapshot, el entregable y el provenance» (§C4 de la spec), nada del razonamiento del productor |
| Emite veredicto **estructurado**: `CONFORME` / `DISCREPANCIA` / `NO_VERIFICABLE`, con las 12 filas y su Δ | Mismo vocabulario que el agente. La salida es `artifacts/audit-reconstruct.json` |
| **`NO_VERIFICABLE` no es un aprobado.** En CI falla igual que `DISCREPANCIA` | Es la regla que ha salvado cuatro épicas: nunca un PASS que no se haya comprobado |

**Qué reconstruye**, por su cuenta y por otro camino:

1. Σdebe/Σhaber por asiento y del periodo, desde `journal_lines`.
2. Activo y PN+Pasivo, agrupando por el **primer dígito de cuenta y el mapeo del
   plan leído de la base**, no del código.
3. Resultado: grupos 6/7 excluyendo `REGULARIZATION`/`CLOSING`/`OPENING`, **y**
   saldo de la 129 si el ejercicio está regularizado. Las dos vías, y exige que
   coincidan entre sí antes de compararlas con el motor.
4. Tesorería: saldo inicial 57x + Σ flujos = saldo final.
5. Los **ocho niveles de margen**, aplicando `MarginLevelConfig` **vigente leída
   de la base**, con la cascada de liquidación rehecha (Hamilton entero, desempate
   por menor código).
6. Los **cinco sellos**, en forma canónica reimplementada.

**Dónde corre:** en el job `auditor-automatizado` de CI (§8), sobre el fixture
completo cargado por el motor, en cada `push` a `main` y en cada PR.

### 3.5 La matriz de inyección (T6)

La spec pide *un* error inyectado. E12 pide **diez**, porque cuatro épicas han
demostrado que un solo error inyectado se detecta y nueve no. Cada fila se
inyecta **sobre una copia** (nunca sobre el diario: el `ledgerHash` antes y
después es idéntico y la ejecución queda en `AuditLog`, como ya hace la prueba de
detección de `/audit`), y **debe** ser cazada por al menos un check **nombrado**.
Una inyección no detectada es **FAIL de la suite**, no un aviso.

| # | Inyección | Quién debe cazarla |
|---|---|---|
| 1 | Un céntimo en una línea del diario | I1 + `ledgerHash` |
| 2 | Dos `entryNumber` **intercambiados** (los hashes no se mueven) | I7 + numeración sin huecos |
| 3 | Una línea analítica reasignada a otro proyecto | I4 (el total compañía compensa; **por dimensión** no) |
| 4 | Una `allocation_lines` alterada bajo un `ReportRun` vigente | I5 + `linesHash` + I-E7-10 |
| 5 | Un `proposal_sha` reescrito en un run ya contabilizado | I-E8-11 y I-E8-7a |
| 6 | Un byte del documento en el almacén | I-E8-2 / I-E11-6 |
| 7 | Una fila **menos** en `AuditLog` | recuento + sha del registro |
| 8 | Un `UsageRun` con una métrica retocada y su `sourceHash` **intacto** | I-E11-1 |
| 9 | Una cuota del 303 tocada en el libro registro | I-E8-15a/b/c |
| 10 | El `configHash`: bajar un umbral `EV-*` sin tocar un dato | `diffRuns` debe decir **`CONFIGURACION`**, nunca `NINGUNA` |

---

## 4. El test «memoria borrada» (P4) y el de reconstrucción desde backup

### 4.1 «Memoria borrada» — `tests/acceptance/memoria-borrada.test.ts` (T10)

Es el test que la spec §6 nombra y que nunca se ha hecho. Enunciado, sin
suavizar:

> **Borrado todo lo que el sistema recuerda haber calculado, y regenerado desde
> el diario, las cifras y los sellos son idénticos byte a byte.**

**Qué se borra.** Un helper único, `purgeDerived(orgId)`, cuya lista es el
**registro declarado `DERIVED_MODELS`**: tabla a tabla, con el motivo por el que
se puede recomputar desde la fuente (**ADR-0023**). El criterio estructural que
este documento proponía al escribirse —derivar la lista del esquema, la lección
de BUG-E7-1 / BUG-E9-5 / BUG-E10-1 / BUG-E11-2— se conserva como **detector que
acusa y no borra**: el esquema sabe qué tablas hay, pero no cuál es caché y cuál
es fuente, y medido contra las tablas reales acertaba menos de la mitad de las
veces (cuatro excepciones sobre nueve candidatas). Lo que se purga hoy:

| Categoría | Tablas / estado |
|---|---|
| Informes | `report_runs` (todas las filas y su `validation`) |
| Barridos | `invariant_runs` |
| Uso | `usage_runs` |
| Analítica | staleness de `allocation_runs`, memoizaciones por transacción |
| Cachés | `lib/cache.ts` en memoria de proceso, y el proceso se **reinicia** |
| Derivados de sello | toda columna listada por `derivedSealColumns()` que sea **recomputable** (`linesHash`, `budgetHash`, `timeHash`, `checksHash`, `proposal_sha`…): se ponen a `NULL` con el baile `NO FORCE → UPDATE → FORCE` |
| Extras | previsualizaciones en el almacén, `validacion.json` en disco |

**Qué NO se borra, y por qué es la mitad del test.** El diario, los documentos y
sus bytes, el `AuditLog`, los `ExtractionRun`, los extractos bancarios, la
configuración versionada. Eso es la SoT. Si algo de la SoT hiciera falta borrarlo
para que el test pase, el test estaría mal escrito; si algo **derivado** no se
puede borrar sin perder una cifra, entonces **es** una fuente encubierta y el
producto está mal.

**Qué se compara, byte a byte:**

1. Las **12 cifras canónicas**.
2. Los **cinco sellos**.
3. El `validacion.json` completo, **normalizado**: se comparan `id`, `status` y
   `evidencia` de cada check; se excluyen y se **declaran** los cuatro campos que
   no pueden coincidir (`run_id`, `createdAt`, `duracionMs`, y el `id` uuid).
   Esa exclusión va en una constante con nombre y comentario, no dispersa.
4. Los cuatro informes serializados en forma canónica.

**Tres variantes, y la tercera es la que muerde:**

| Variante | Qué prueba |
|---|---|
| (a) Purga → regenerar en el **mismo proceso** | Que no hay caché de proceso que sostenga una cifra |
| (b) Purga → **reiniciar** → regenerar | Que no hay estado en memoria entre peticiones |
| (c) Purga → regenerar **en otro orden** (informes antes que barrido, analítica antes que contable, un informe mensual antes que el anual) | Que ningún derivado depende del orden en que alguien lo pidió. *Es donde este test tiene probabilidad real de encontrar algo* |

**Y una cuarta comprobación, negativa:** tras la purga, y **antes** de regenerar,
las pantallas de informes **no enseñan una cifra**: enseñan «sin calcular». Si
alguna enseña un número, ese número venía de la memoria y P4 estaba roto.

### 4.2 «Reconstrucción desde backup» — `tests/acceptance/reconstruccion-backup.test.ts` (T11)

P7 en su forma fuerte, y extensión natural de lo que E11 ya montó:

1. Fixture completo en la organización A.
2. Backup 2.0 por la **acción real** (`requestBackupAction`), no por un helper.
3. **Se destruye A**: borrado físico de la organización en una base de trabajo.
4. Restauración a B desde el ZIP, por la acción real.
5. Las **seis comprobaciones** de §5.4 de E11 en verde, `verified = true`.
6. **Y además**, que es lo que E12 añade: las **12 cifras** y los **cinco
   sellos** de B son **idénticos** a los que A tenía, y
   `scripts/audit-reconstruct.ts` corre sobre B con **Δ = 0**.
7. Y el cruce con §4.1: **purga de derivados en B → regenerar → idénticos otra
   vez**. Reconstruir desde cero, dos veces, por dos caminos, y que salga lo
   mismo: eso es P7.

**Casos negativos** (heredan de los criterios 28–34 de E11 y añaden uno):
manifest alterado, firma ajena, `entryNumber` intercambiados, `AuditLog` mermado,
tasa ausente, **y — nuevo — un ZIP de una versión de esquema anterior**: se
rechaza nombrando `schemaVersion`, no se restaura «lo que se pueda».

---

## 5. `/admin`: escrituras de operador (ADR-0020, **PROPUESTO**)

### 5.1 El problema

Hay cuatro cosas que un operador de la plataforma necesita hacer y que hoy sólo
se pueden hacer con `psql` y las manos: vaciar una organización de pruebas,
desbloquear algo que un invariante o una guardia dejó atascado, reasignar un
plan, y purgar lo que la retención dice que hay que purgar. Hacerlo por SQL tiene
tres defectos que no son de comodidad: **no deja motivo**, **no deja actor** y
**no tiene límites** — nada impide que un `DELETE` mal escrito toque el diario.

`/admin` no existe para tener un panel. Existe para que **esas cuatro cosas
dejen rastro**.

### 5.2 Las cuatro escrituras, y sus límites

| Operación | Qué hace | Límite duro |
|---|---|---|
| **`reset-org`** | Vacía **toda** una organización marcada `isDemo` **o** sin un solo asiento posteado | **Se niega** si la organización tiene un `JournalEntry`. No hay `--force`. La lista de tablas se **deriva de `TENANT_MODELS`** (BUG-E11-2) |
| **`unblock`** | Levanta **una** guardia nombrada y acotada en el tiempo: un `PeriodLock`, una guardia de cierre, un `RestoreJob` colgado, un job de cron en `PARTIAL` | **Nunca** levanta un invariante. Levanta la **puerta**, y el invariante que la cerró **sigue en FAIL** y sigue moviendo el sello. Caduca sola a las 24 h |
| **`reassign-plan`** | Cambia el plan de una organización | Ya existe en E11 (D9) como acción de administración; aquí gana motivo obligatorio y doble confirmación |
| **`purge-retention`** | Ejecuta la purga que la política de retención ya ordena | **Sólo** borra lo que `expiresAt` declara vencido; enumera antes de borrar y **no** puede purgar un `BackupJob` con un `RestoreJob` vivo (I-E11-11) |

### 5.3 Las cinco reglas de ADR-0020

1. **Nunca tocan el diario.** Ninguna escritura de operador puede `INSERT`,
   `UPDATE` o `DELETE` sobre `journal_entries`, `journal_lines`, `audit_logs`,
   `extraction_runs`, `invariant_runs` ni `closing_runs`. Se comprueba por **tres
   vías**: revocación de privilegios al rol de operador, **test estático sobre el
   AST** de `app/(app)/admin/**`, e **I-E12-5**.
2. **Motivo obligatorio**, ≥ 20 caracteres, y no vale texto genérico (lista negra
   `test`, `arreglo`, `.`, la cadena vacía). Va al `PlatformAuditLog` y, cuando
   la operación afecta a una organización, **también** a su `AuditLog`: el
   cliente tiene derecho a ver que alguien de la plataforma tocó algo suyo.
3. **Doble confirmación**: la segunda exige **teclear el nombre exacto** de la
   organización, como el borrado de un repositorio. Y es del **servidor**, no del
   diálogo: la acción recibe el nombre y lo compara.
4. **Una excepción es un evento, no un estado.** `unblock` crea una
   `OperatorException` con `expiresAt`, y cuando caduca la puerta vuelve a estar
   cerrada. No hay excepciones permanentes.
5. **Toda excepción viva mueve el sello.** Motivo de sello nuevo
   **`EXCEPCION_DE_OPERADOR_VIGENTE`**, familia `PLATAFORMA`, naturaleza
   `ENTORNO`. Un periodo con una excepción viva **no puede** firmarse como
   `VALIDADO AUTOMÁTICAMENTE`. Sin esta regla, `/admin` sería una forma elegante
   de apagar la capa de fiabilidad.

### 5.4 Modelo de datos (fragmento)

```prisma
/// E12 · ADR-0020 — una excepción de operador a una guardia, acotada y caduca.
/// NO es una excepción a un invariante: el invariante sigue en FAIL y sigue
/// moviendo el sello. Lo que caduca es la PUERTA, no la comprobación.
model OperatorException {
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String        @map("organization_id") @db.Uuid
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  kind        OperatorExceptionKind
  /// Qué guardia concreta. Enum + referencia, nunca texto libre (lección O-21).
  targetKind  OperatorTargetKind    @map("target_kind")
  targetId    String?               @map("target_id") @db.Uuid

  reason      String    @db.VarChar(1000)
  requestedBy String    @map("requested_by") @db.VarChar(120)
  createdAt   DateTime  @default(now()) @map("created_at")
  /// Caduca sola. CHECK: `expires_at > created_at` y `expires_at <= created_at + 24h`.
  expiresAt   DateTime  @map("expires_at")
  revokedAt   DateTime? @map("revoked_at")

  @@index([organizationId, expiresAt])
  @@map("operator_exceptions")
}
```

`PlatformAuditLog` (ya existe) gana los cuatro `action` nuevos: `admin.reset_org`,
`admin.unblock`, `admin.plan_changed`, `admin.purge_retention`; `detail` lleva
**siempre** `{ reason, confirmedName, before, after, affectedCounts }`.

### 5.5 UI

`/admin` (sólo `User.isPlatformAdmin`, ya existente): lista de organizaciones con
plan, uso, sello del último barrido y **excepciones vivas en rojo arriba del
todo**. Cada operación: diálogo con lo que va a pasar **enumerado antes de
hacerlo** (recuentos por tabla), campo de motivo, campo de confirmación por
nombre. Estados vacío/carga/error. `VIEWER`, `EDITOR` y `ADMIN` de organización
**no ven la ruta**: `404`, no `403`.

---

## 6. Cierre de la deuda fechada en E12

**Dieciséis entradas.** Quince se cierran en E12; **una** se re-fecha, con motivo.

| # | Deuda | Origen | Tarea | Cómo se cierra |
|---|---|---|---|---|
| 1 | **ZIP del backup construido en memoria** (`JSZip`) | E11 integración | **T14** | Generación en **streaming** por lotes con cursor y subida **multipart** al almacén. Techo 5 de §12 de E11 medido con 1,5 GB reales y **pico de memoria estable** |
| 2 | **Camino de lectura al disco heredado** (`lib/documents.ts`) | E11 | **T15** | `scripts/migrate-uploads-to-storage.ts --apply` corrido en los tres entornos (runbook), **rama de disco eliminada**, y test que falla si alguien la reintroduce |
| 3 | **`organizations.storage_used` / `storage_limit`** deprecadas | E11 | **T15** | Migración que las **elimina**; la cifra buena es la derivada de `models/usage.ts`. Guardia que aborta si alguna lectura viva las usa (AST) |
| 4 | **Ficheros `static/` (logo, avatar) en disco** | E11 | **T15** | Al almacén con `kind = BRANDING`, nombrados por `sha256`, con índice `(organizationId, purpose)`. No cuentan para la cuota del cliente (O-12c) |
| 5 | **`/admin`: las escrituras** (y el panel) | E11 ×2 (P-6) | **T12, T13** | §5 y **ADR-0020** |
| 6 | **Techos 3, 5, 6 y 8 de §12 con volumen REAL** | E11 | **T17** | Fixture de gran volumen dedicado (`tests/fixtures/gran-volumen/`, generado y **`--check`eable**): 50 000 asientos, 150 000 líneas, 2 000 ficheros / 1,5 GB, 50 organizaciones. Sin extrapolación |
| 7 | **`stored_objects` restaurado con la clave del prefijo del ORIGEN** | E11 | **T16** | Las claves se **rederivan** en el destino junto con los bytes; la comprobación 6 pasa de «relativa tolerante» a **exacta** |
| 8 | **G-15b — restaurar un ZIP ajeno desde la interfaz** | E11 ×2 | **T16** | Subida del ZIP en `/settings/backups`, **verificación de firma antes de descomprimir un byte**, firma ajena ⇒ rechazo salvo autorización explícita del operador **registrada** (criterio 33 de E11), y siempre a organización nueva |
| 9 | **G-20 — sin tests de `models/stats.ts`, `lib/stats.ts`, `ai/*`** | E11 | **T18** | Golden tests: documentos de ejemplo → salida esperada; agregados multi-moneda; **test que falla si un prompt cambia sin bump de versión** (es literalmente lo que la auditoría propuso en 2026-09-04) |
| 10 | **G-14 — segregación de funciones sin Capa 2 automática** | AUDITORÍA (errata en ESTADO) | **T5, T6** | El auditor automatizado en CI. Y corrección de la errata (§2.3) |
| 11 | **CAPEX en presupuesto** (`BudgetCapexLine`, Q-4 de E10) + **enmienda a ADR-0018 D2** + fixture `presupuesto-horas-esperado.v1.4.json` | E11 re-fecha | **T19** | Nivel 2: la enmienda entra como **ADR-0018 · D8** (fichero nuevo `docs/adr/0018-…` no se toca: se añade una nota de enmienda fechada, como ya se hizo con ADR-0013) |
| 12 | **Granularidad `MONTH` de varios meses**, **desglose mes a mes** y **descomposición volumen/precio** (Q-6 / ADR-0018 D6) | E11 re-fecha | **T19** | La convención ya está congelada; falta implementarla y sellarla |
| 13 | **Contrato del bloque de rentabilidad por proyecto** (C3 de E10) | E10 → E11 → E12 | **T19** | Depende de 12; sale con ella |
| 14 | **Backups programados**, **CSV dentro del ZIP**, **`email-sync` como job de cron** | E11 re-fecha | **T20** | Tres jobs más en el cron de plataforma (D4), CSV como **segunda representación** del JSONL —el JSONL sigue mandando y el manifest sella los dos— |
| 15 | **`btree_gist` en `public`** (WARN del linter de Supabase) + **script de compat para la próxima base Supabase (prod)** | Despliegue E3/E11 | **T21** | `scripts/supabase-bootstrap.sql` con las cuatro adaptaciones ya documentadas en `DESPLIEGUE-PREVIEW.md` §4, idempotente; el `btree_gist` se mueve a un esquema propio **si el rol lo permite** y, si no, se **declara como aceptado con motivo** y deja de figurar como deuda |
| 16 | **«G-14 · conciliación bancaria»** de la tabla de E8 | ESTADO | **T23** | **No es deuda: es la errata.** E7 entregó la conciliación entera (I-E7-1…13). Se corrige la fila |

### 6.1 Lo que se re-fecha (uno, y con motivo)

| Deuda | Nueva épica | Motivo |
|---|---|---|
| **Arqueo de caja como fuente equivalente al extracto** (nota de `fiabilidad/SKILL.md` §C5: «podría serlo en E12, con ADR») | **RETIRADA, no re-fechada** | Un arqueo lo firma quien lleva la caja. Admitirlo como «✓ validado contra fuente» degradaría la etiqueta más fuerte que tiene el sistema para ganar un badge en un epígrafe. Se resuelve **cerrándolo como decisión**, no aplazándolo. La consecuencia documentada —una organización con caja no ve el badge en la tesorería total— se queda tal cual en el README final |

*(Y nada más. Las quince restantes se cierran en E12. Si en la ronda de
integración alguna no cupiera, el revisor bloquea salvo que se re-feche **con
motivo escrito**, que es el estándar de `CLAUDE.md`.)*

---

## 7. Los dos documentos

### 7.1 `README-FIABILIDAD.md` **final** (T23)

El actual (E7 · T22) es bueno y **no se tira**: se completa. Estructura final:

| § | Contenido | Estado |
|---|---|---|
| 1 | **Qué garantiza el sistema** — las cinco promesas | existe, se conserva |
| 2 | **Los invariantes por familia** (diez familias) | existe; **+ familia `PLATAFORMA` completa y los `I-E12-*`** |
| 3 | **Los sellos**: sello del periodo, motivos de código cerrado, niveles de confianza, provenance por celda | existe; **+ `EXCEPCION_DE_OPERADOR_VIGENTE`** |
| 4 | **Cómo auditarlo en 10 minutos** | **NUEVO**, §7.2 |
| 5 | **Qué NO garantiza** | existe; **+ los cuatro puntos de §1.2 de este diseño**, y el arqueo de caja resuelto |
| 6 | **Cómo se extiende sin romper la capa** | **NUEVO**, §7.3 |
| 7 | Segregación de funciones y registro de runs | existe; **+ el auditor automatizado** |

#### 7.2 «Cómo auditarlo en 10 minutos» — el guion literal

Cronometrado, sin conocimiento previo del código, sobre el preview:

| min | Paso | Qué se ve |
|---|---|---|
| 0–1 | `/audit` → **Ejecutar barrido** | Sello, motivos, **cinco sellos** y las **cuatro cifras firmadas** |
| 1–3 | Abrir la familia que sea → un check → sus registros de origen → el asiento → el documento | **Tres clics** hasta el asiento, uno más hasta el PDF |
| 3–4 | **Prueba de detección** desde la UI | Se altera un céntimo en copia, se ve qué invariantes lo cazan, y el `ledgerHash` **no se ha movido** |
| 4–6 | `npx tsx scripts/audit-reconstruct.ts --org <id> --ref-date …` | Doce filas, **Δ = 0**, veredicto `CONFORME`. **Sin usar el motor** |
| 6–8 | Comparar los dos últimos barridos | El diff dice `DATOS`, `MOTOR` o `CONFIGURACION`. Nunca «no se sabe» |
| 8–9 | Abrir cualquier celda de un informe → «cómo se calcula» | La consulta, sus parámetros, el git-sha y el `run_id` |
| 9–10 | `runs/registro.jsonl` → buscar ese `run_id` | Quién, cuándo, con qué versión, con qué tests y con qué sello |

Si alguno de los siete pasos tarda más o requiere preguntar a alguien, **el paso
está mal diseñado** y es un hallazgo de E12, no un problema del auditor.

#### 7.3 «Cómo se extiende sin romper la capa» — las siete reglas

1. **Un invariante nace con su llamante y su test de inyección.** Escribir
   `lib/**/invariants-eNN.ts` no es entregar un invariante: hay que componer su
   bloque de entrada, enchufarlo al barrido, darle familia y **demostrar con una
   inyección que da FAIL**. Tres épicas seguidas entregaron invariantes muertos.
2. **Una familia sin evaluar sale `SIN_EVALUAR`, jamás en verde.**
3. **Una tabla nueva de negocio** se protege con `app.enforce_tenant_rls`, entra
   en `TENANT_MODELS`, y con eso entra sola en el backup y en `--reset-org`.
   **Nunca se mantiene una lista a mano**: la lista a mano ha fallado cuatro veces
   (BUG-E7-1, BUG-E9-5, BUG-E10-1, BUG-E11-2). **Excepción única, y es
   `purgeDerived`** (ADR-0023): allí la pregunta no es «¿qué tablas hay?» —que el
   esquema contesta— sino «¿qué es caché y qué es fuente?», que no contesta; la
   tabla se **declara** en `DERIVED_MODELS` o en `FUENTES_AUNQUE_LO_PAREZCAN`, con
   motivo, y el detector estructural pone la suite roja si no está en ninguna.
4. **Un derivado nuevo** declara su **hash de fuente** y su entrada en
   `derivedSealColumns()`. Si no se puede recomputar, no es un derivado: es una
   fuente, y necesita ADR.
5. **Una cifra nueva en pantalla** trae `provenance` con consulta ejecutable y
   etiqueta de confianza. C3 y C5 fallan si no.
6. **Un cambio en el motor** exige ciclo en paralelo viejo/nuevo sobre el mismo
   snapshot con diff cero o diff explicado (§C7), y es **Nivel 2**.
7. **Un test que se escribe mirando el código que prueba no prueba nada.** Las
   cifras esperadas se congelan en un fixture o se reconstruyen por otro camino.

### 7.4 `docs/spec/SPEC-FIABILIDAD-v1.1-propuesta.md` (T23)

Fichero **nuevo**; la v1.0 **no se toca** (es inmutable por su propia cabecera).
Se entrega como **propuesta de enmiendas a Pablo**, con coste/beneficio, y no se
da por aprobada. Contiene **diez enmiendas** destiladas de E0–E11 —cada una con
la cicatriz que la produjo—. El documento se escribe completo en T23; su índice y
su contenido están fijados aquí:

| # | Enmienda | Nace de |
|---|---|---|
| **E-1** | **Un invariante nace con su llamante y su test de inyección.** Añadir a §C4 Capa 1: «un invariante sin bloque de entrada compuesto y sin test que lo haga FAIL **no cuenta como implementado**» | H-1 de E9 (27 invariantes muertos), H-1 de E10 (18), H-1 de E11 (13). **Tres veces el mismo fallo** |
| **E-2** | **Nunca un PASS que no se haya comprobado.** Elevar a §1 como principio **P8**: lo no evaluable sale `SIN_EVALUAR`/`INFO`, jamás en verde | La regla ya gobierna el ERP y salvó E7, E9, E10 y E11; no está en la spec |
| **E-3** | **Un test que tapa un hallazgo es un defecto de severidad ALTA.** Añadir a los anti-patrones de §5: «un test escrito a la medida del código que prueba», «un test que pasa por vacuidad» y «un test cuyo fixture contradice al motor» | E7 (dos tests que pasaban con datos imposibles), E9 R-2 (I-E9-16 pasaba por vacuidad), E10 (el fixture contradecía al motor) |
| **E-4** | **Todo inventario es derivado.** Añadir a §C1/§C7: ninguna lista de tablas, sellos, familias o rutas se mantiene a mano; se deriva del esquema o del código, y hay un invariante que lo comprueba | BUG-E7-1, BUG-E9-5, BUG-E10-1, BUG-E11-2 y H-2 de E11 (`currencies`, 177 filas/org, perdidas **con las seis comprobaciones en PASS**) |
| **E-5** | **La forma canónica no admite campos mutables.** Añadir a §C1: un hash de contenido se computa sobre **claves naturales y valores inmutables**; nunca sobre ids de fila, timestamps ni secretos | `budgetHash` irreproducible al relevar una versión (E10); `invitations.token_hash` fuera de `derivedSealColumns()` (E11) |
| **E-6** | **Una caché alterada es FAIL, no «caducada».** Añadir a §C1: toda caché lleva hash de sus fuentes y una discordancia es un **fallo de integridad**, no una invalidación | I-E11-1; el `UsageRun` alterado por SQL |
| **E-7** | **Ningún control puede impedir registrar un hecho ya ocurrido.** Añadir a §1 como corolario de P2: los límites del sistema acotan recursos, nunca la SoT | ADR-0019 D7 / O-3 |
| **E-8** | **El auditor adversarial tiene que ser ejecutable, no sólo humano.** Reescribir §C4 Capa 2: «se lanza en contexto limpio **y existe además una reconstrucción automatizada que corre en cada integración**, con la misma prohibición de compartir código con el productor» | Los cuatro informes de auditoría encontraron lo que los tests no veían — y sólo corrían una vez por épica |
| **E-9** | **`NO_VERIFICABLE` no es un aprobado.** Añadir a §C4: en integración continua, `NO_VERIFICABLE` falla igual que `DISCREPANCIA` | Práctica del ERP; la spec lo deja ambiguo |
| **E-10** | **Un identificador de gap es inmutable.** Añadir a §2.3: los `G-nn` sólo significan lo que dice el informe de Fase 1; reusarlos cuesta una épica de confusión | G-14, G-15 y G-20, **tres erratas de doble numeración** |

Coste/beneficio de cada una, y qué parte ya está implementada de facto en el ERP,
van en el propio documento. Ninguna enmienda pide reescribir nada de lo hecho:
las diez describen lo que el ERP ya aprendió a la fuerza.

---

## 8. CI — `.github/workflows/fiabilidad.yml`

El `ci.yml` actual tiene seis jobs (lint, test, typecheck, docker-build,
test-integration, fixtures-sellados, pureza-motor) y **no ejecuta ni e2e ni
aceptación ni auditor**. E12 añade un workflow hermano, con los mismos servicios
de Postgres, disparado en `pull_request` y `push` a `main`.

| Job | Qué ejecuta | Falla si |
|---|---|---|
| `unit` | `npm run test` | cualquier test rojo |
| `integracion` | `npm run test:integration` | ídem |
| `rls` | `npm run test:integration:rls` | ídem (rol `app_runtime`, NOBYPASSRLS) |
| **`aceptacion`** | `npm run test:acceptance` — **los siete C1–C7 + memoria borrada + reconstrucción desde backup** | cualquiera rojo, **o una familia `SIN_EVALUAR`** |
| **`auditor-automatizado`** | carga el fixture por el motor y corre `scripts/audit-reconstruct.ts` | **Δ ≠ 0 en cualquiera de las 12**, o veredicto ≠ `CONFORME` (**`NO_VERIFICABLE` falla**) |
| `fixtures-check` | **todos** los generadores de `docs/design/fixtures/build_*.py` con `--check` (hoy trece, con el suelo escrito en el job) | un fixture que ya no se reproduce byte a byte |
| **`e2e`** | `npx playwright test <fichero>` en **matriz por fichero** (13 specs) | cualquiera rojo. Por fichero, para que un fallo diga **cuál** sin leer 600 líneas de log |
| `pureza-motor` | el guard existente, extendido a `lib/platform/**` y `scripts/audit-reconstruct.ts` (que además **no puede importar `lib/**`**) | impureza o importación prohibida |
| `perf` | los techos de §12 de E11 (3, 5, 6, 8) sobre `gran-volumen`, **sólo en `push` a `main`** | un techo incumplido, **o degradación > 20 % contra la medición anterior publicada** |


> **Ronda 1 de corrección (2026-09-21) — lo que el workflow ejecuta HOY.** La
> auditoría (H-3) encontró que el workflow tenía nueve jobs pero **dos eran
> otros**: faltaban `pureza-motor` y `perf`, y en su lugar estaban `lint-tsc` y
> `build`. Ahora son **doce**, y los de esta tabla están todos:
>
> | Nuevo o corregido | Qué cambia |
> |---|---|
> | **1 `lint-tsc`** y **9 `build`** | se quedan: son útiles y no sustituyen a nadie |
> | **6-bis `pureza-motor`** | los once directorios del motor **más `lib/platform`**, y el auditor con su propia regla (`new Date()` sólo para fechar su informe, nunca para calcular). Los dos filtros que le faltaban —comentarios e `import type` del cliente generado— hacían saltar el guard en **todos** los directorios, así que no decía nada útil; corregido también en `ci.yml` |
> | **6-ter `perf`** | `perf-audit`, `perf-budget`, `perf-closing` y `perf-pages` en cada push; **el criterio 47** (volumen real, 1,5 GB) en el disparador **nocturno** (`schedule`) o a mano, porque seis minutos y el bloat que deja no caben en cada push — pero *no correr nunca* tampoco era una opción |
> | **6 `auditor-automatizado`** | ejecuta además `scripts/audit-reconstruct.imports.test.ts` (BLOQUEA 2 / H-2) **antes** de usar el auditor, y **se pone rojo** si el barrido deja un FAIL que no esté en la lista cerrada de FAIL del sustrato. **Ronda 2 (H-4):** la comprobación del sello dejó de ser vacua —contaba FAIL, y con tres FAIL de sustrato permanentes nunca se evaluaba—: ahora recorre las RAZONES del sello y exige que **cada una** esté explicada por esa lista cerrada; cualquier razón de otra naturaleza pone el job en rojo aunque no haya ni un FAIL nuevo |
> | **8 `e2e`** | la matriz **se deriva del directorio** (`ls tests/e2e/*.spec.ts`), con suelo de 13: un fichero nuevo corre solo (PUEDE #12) |

**Entorno común:** `GIT_SHA: ${{ github.sha }}` **en todos los jobs** (sin él los
sellos salen `REQUIERE REVISIÓN` y la mitad de los asertos serían falsos) y
`TZ: Europe/Madrid` (la hidratación ya costó dos incidentes).

**Artefactos publicados** (`actions/upload-artifact`, retención 90 días):

```
artifacts/
  validacion.json                    # barrido completo del fixture
  acceptance/c1..c7/validacion.json  # uno por componente
  audit-reconstruct.json             # las 12 cifras y sus Δ
  perf/techos.json                   # las mediciones, para comparar con la siguiente
  playwright-report/                 # sólo si algún e2e falla
```

**Resumen en el PR** (`$GITHUB_STEP_SUMMARY`): una tabla con el sello, los cinco
hashes, las 12 cifras con su Δ y el recuento PASS/FAIL/INFO por familia. Que se
lea sin abrir un artefacto es la diferencia entre un control y un adorno.

---

## 9. Invariantes que E12 introduce (`I-E12-1…8`)

Se definen **una sola vez** en `.claude/skills/fiabilidad/SKILL.md`, familia
`INTEGRIDAD` salvo indicación. Tolerancia 0 en los que comparan cifras.

| ID | Invariante | Tol. |
|---|---|---|
| **I-E12-1** | **Determinismo de extremo a extremo.** Purgados todos los derivados (`purgeDerived`, con el registro declarado `DERIVED_MODELS` de ADR-0023, y sin ninguna tabla de caché sin declarar) y regenerados, las **12 cifras** y los **cinco sellos** son idénticos **byte a byte**, en los tres órdenes de regeneración | 0 |
| **I-E12-2** | **Reconstrucción independiente.** `audit-reconstruct` da **Δ = 0** en las 12, y su grafo de importaciones **no contiene `lib/**`, `models/**` ni `ai/**`** (test estático sobre el AST) | 0 |
| **I-E12-3** | **Provenance ejecutable.** Toda celda de informe trae consulta parametrizada que, ejecutada, devuelve su propio valor. **Cero celdas sin consulta** y cero consultas que devuelvan 0 filas para un valor ≠ 0 | 0 |
| **I-E12-4** | **Cobertura de la spec.** Cada componente C1–C7 tiene ≥ 1 test de aceptación que lo ejerce **y está en CI**. Un componente sin test es **FAIL**, no INFO | — |
| **I-E12-5** | **Escrituras de operador acotadas** (familia `PLATAFORMA`). Toda fila de `PlatformAuditLog` con `action LIKE 'admin.%'` tiene motivo ≥ 20 caracteres, actor y confirmación; **ninguna** escritura de `/admin` alcanza el diario ni las tablas append-only; ninguna `OperatorException` dura > 24 h ni existe sin su registro | — |
| **I-E12-6** | **Detección demostrada.** Las **diez** inyecciones de §3.5 son cazadas, cada una, por ≥ 1 check **nombrado**. Una inyección no detectada es FAIL | — |
| **I-E12-7** | **Registro de runs completo y válido.** `runs/registro.jsonl` valida contra su schema, sin `run_id` duplicado, y **todo entregable sellado es localizable** por su `run_id` con su git-sha y su snapshot | — |
| **I-E12-8** | **Ningún derivado es fuente.** Ninguna cifra de informe se sirve de una columna de caché sin que su hash de fuente se haya recomputado en la misma petición (test estático + barrido) | — |

### 9.1 Invariantes existentes que E12 puede romper

| Invariante | Riesgo | Mitigación |
|---|---|---|
| **I-E11-7** (cobertura del backup) | El ZIP en streaming cambia el generador | El inventario sigue derivándose de `TENANT_MODELS`; el test de cobertura corre **antes** del de streaming |
| **I-E11-2** (restauración reproducible) | Rederivar claves de `stored_objects` cambia la comprobación 6 | Pasa de relativa a **exacta**: es más estricta, no menos |
| **I-E11-6** (bytes del almacén) | `static/` entra al almacén | Ganan `kind = BRANDING`, excluido de la cuota (O-12c) y **incluido** en el barrido |
| **I-E10-1…18** | T19 toca el `budgetHash` (CAPEX) | Nivel 2 con enmienda a ADR-0018 y **reversionado del fixture a v1.4**; las v1.0–v1.3 quedan congeladas |
| **I1…I10 y todas las familias** | `purgeDerived` borra columnas-sello con el baile `NO FORCE/FORCE` | Sólo en base de test; **prohibido** en producción por privilegios, y test que lo comprueba |

---

## 10. Criterios de aceptación (Given / When / Then)

**Matriz de cumplimiento (§2)**

1. Dado el documento entregado, **cada** celda «qué falta» tiene una tarea de §9
   y **cada** tarea cerrada tacha su celda. Al cerrar E12, **cero** celdas P o NC.
2. G-14 y G-20 constan como **cerrados** con el trabajo que los cierra nombrado, y
   las tres erratas de numeración están corregidas en los documentos que las
   inventaron, **sin tocar `AUDITORIA-FIABILIDAD.md`**.

**C1 — snapshots**

3. Dos ciclos sobre el mismo `ledgerHash` ⇒ resultados **byte-idénticos** y el
   segundo **servido de caché** (medido: < 50 ms).
4. Un asiento nuevo ⇒ `ledgerHash` distinto, informe nuevo, **el anterior intacto**.
5. `UPDATE report_runs` como `app_runtime` ⇒ `42501`.
6. Tras `prune-runs.ts`, quedan ≥ 12 runs recientes y ≥ 1 por mes histórico.

**C2 — motor**

7. Los cinco casos límite sobre los diez motores puros ⇒ ni `NaN`, ni excepción,
   ni fila inventada; dataset vacío devuelve **ceros con etiqueta**, no `null`.
8. Un prompt de redacción sin la instrucción de no recalcular ⇒ **test rojo**.
9. Una operación aritmética pedida a un modelo en cualquier prompt ⇒ test rojo.

**C3 — provenance**

10. Para las 12 cifras, **ejecutar** la consulta de provenance devuelve `Σ = valor`.
11. Lo mismo en los **niveles acumulados** de la matriz analítica (donde E10 lo
    encontró en 0 filas).
12. De una celda al documento origen: ≤ 3 clics y < 5 s.

**C4 — auditor automatizado**

13. Fixture limpio ⇒ `CONFORME`, **Δ = 0 en las 12**, y el ciclo **sale sin
    intervención humana** con sello `VALIDADO AUTOMÁTICAMENTE`.
14. `audit-reconstruct.ts` importando cualquier cosa de `lib/**` ⇒ **test rojo**.
15. Las **diez** inyecciones ⇒ cada una cazada por un check nombrado; la salida
    dice **cuál**.
16. Inyección #2 (dos `entryNumber` intercambiados, hashes intactos) ⇒ detectada.
    *Es el caso que O-1 de E11 destapó.*
17. Inyección #10 (umbral `EV-*` bajado sin tocar datos) ⇒ `diffRuns` dice
    **`CONFIGURACION`**, nunca `NINGUNA`.
18. Veredicto `NO_VERIFICABLE` ⇒ el job de CI **falla**.

**C5 — sellos y confianza**

19. Cero celdas de informe sin etiqueta de confianza.
20. Un extracto de febrero con un movimiento de diciembre ⇒ **retira** el badge
    `✓ validado contra fuente` de diciembre.
21. Motivo de sello emitido y no declarado en la skill ⇒ test rojo. Declarado y
    nunca emitido ⇒ test rojo.
22. Una familia cuyo bloque de entrada no se compone ⇒ `SIN_EVALUAR` y sello
    `REQUIERE REVISIÓN`; **nunca** PASS.

**C6 — revisión humana**

23. ADMIN fuerza revisión con motivo y familia ⇒ sello `REQUIERE REVISIÓN` con el
    motivo **impreso en el informe emitido**; se limpia con `clearReason` ⇒ vuelve.
24. `VIEWER` no puede forzar ni limpiar.
25. `UPDATE`/`DELETE` sobre `audit_logs` ⇒ `42501`.
26. Ninguna fila de memoria contiene una cifra de negocio como verdad vigente.

**C7 — versionado**

27. `registro.jsonl` valida contra su schema; un run sin `git_sha_base` ⇒ rojo.
28. Dado cualquier `ReportRun` histórico ⇒ se recupera versión + snapshot y **se
    reemite idéntico**.
29. Dos versiones del motor sobre el mismo snapshot ⇒ diff cero **o** diff
    clasificado como `MOTOR`.

**Memoria borrada (P4)**

30. Purga → regenerar ⇒ 12 cifras y 5 sellos **byte a byte** idénticos.
31. Lo mismo tras **reiniciar el proceso**.
32. Lo mismo **regenerando en otro orden**.
33. Tras la purga y **antes** de regenerar, ninguna pantalla enseña una cifra:
    enseña «sin calcular».
34. `purgeDerived` borra **lo que el registro `DERIVED_MODELS` declara**, tabla
    a tabla y con motivo (**ADR-0023**); el criterio estructural se conserva como
    **detector que acusa y no borra**. Ninguna tabla de caché queda fuera del
    registro en silencio: `tablasSinDeclarar()` la nombra y la suite falla. Test
    que **añade una tabla ficticia** y comprueba las tres cosas: sin declarar se
    detecta y **no** se purga; declarada derivada entra en la lista sin tocar
    ninguna otra línea; declarada fuente sale del detector y no se purga.
    *(Enunciado anterior —«deriva su lista del esquema: una tabla derivada nueva
    entra sola»— derogado por ADR-0023, que explica por qué el esquema sabe qué
    tablas hay pero no cuál es caché y cuál es fuente.)*

**Reconstrucción desde backup (P7)**

35. A → ZIP → **destruir A** → restaurar B ⇒ seis comprobaciones en verde,
    `verified = true`, y **12 cifras + 5 sellos idénticos** a los de A.
36. `audit-reconstruct` sobre B ⇒ **Δ = 0**.
37. Purga de derivados en B → regenerar ⇒ idéntico otra vez.
38. ZIP con `schemaVersion` anterior ⇒ **rechazo nombrando la versión**; no se
    restaura «lo que se pueda».
39. Un ZIP **ajeno** subido desde la interfaz ⇒ firma verificada **antes de
    descomprimir un byte**; rechazo salvo autorización de operador **registrada**.

**`/admin` y ADR-0020**

40. `reset-org` sobre una organización **con un asiento** ⇒ denegado. No hay
    `--force`.
41. Cualquier escritura sin motivo, o con motivo genérico, o sin teclear el nombre
    exacto ⇒ denegada **en el servidor**.
42. Toda escritura ⇒ `PlatformAuditLog` **y** `AuditLog` de la organización, con
    `before`/`after` y recuentos.
43. **Ningún camino** de `/admin` escribe en el diario ni en las tablas
    append-only: privilegios revocados **+** test estático **+** I-E12-5.
44. Una `OperatorException` viva ⇒ el periodo **no puede** firmarse como
    `VALIDADO AUTOMÁTICAMENTE`; sale con `EXCEPCION_DE_OPERADOR_VIGENTE`.
45. La excepción **caduca sola** a las 24 h y la puerta vuelve a cerrarse.
46. Un usuario no `isPlatformAdmin` ⇒ `/admin` responde **404**, no 403.

**Deuda de §6**

47. Backup de 1,5 GB ⇒ streaming, **pico de memoria estable**, < 15 min (techo 5
    con volumen real, sin extrapolar).
48. Ninguna lectura de fichero pasa por disco: la rama heredada **no existe** y un
    test falla si vuelve.
49. `organizations.storage_used`/`storage_limit` **no existen**; ninguna lectura
    las nombra.
50. Logo y avatar en el almacén, por `sha256`, **fuera** de la cuota del cliente.
51. Claves de `stored_objects` **rederivadas** en el destino; comprobación 6
    exacta.
52. `models/stats.ts`, `lib/stats.ts` y `ai/*` con golden tests; **un prompt que
    cambia sin bump de versión ⇒ test rojo** (G-20).
53. CAPEX, celda mensual, volumen/precio y rentabilidad por proyecto entregados,
    con fixture **v1.4** y enmienda a ADR-0018 escrita.
54. Backups programados, CSV en el ZIP y `email-sync` como job de cron, los tres
    idempotentes por `(job, periodKey)`.
55. `scripts/supabase-bootstrap.sql` levanta una base Supabase nueva sin
    superusuario y sin ninguna adaptación manual; el WARN de `btree_gist` está
    resuelto **o declarado y aceptado con motivo**.

**CI y documentación**

56. El workflow publica `validacion.json`, `audit-reconstruct.json` y las
    mediciones como artefactos, y el resumen del PR se lee **sin abrir ninguno**.
57. Los e2e corren **por fichero**: un fallo dice cuál sin leer el log entero.
58. `README-FIABILIDAD.md` final: **una persona ajena al proyecto completa el
    guion de 10 minutos sin preguntar nada**. Se cronometra en el QA (T24) con
    alguien que no ha escrito el código.
59. `SPEC-FIABILIDAD-v1.1-propuesta.md` existe con las diez enmiendas y su
    coste/beneficio; **`SPEC-FIABILIDAD.md` v1.0 no tiene ni un byte cambiado**
    (`git diff` vacío, comprobado en CI).
60. La **Definition of Done global de la spec (§6)** se puede tachar entera, punto
    por punto, en el informe de cierre.

---

## 11. Plan de tareas

**26 tareas · 584 h.** Nivel 1 salvo lo marcado; las Nivel 2 **bloqueadas hasta
ADR-0020 APROBADO** (T12, T13) y hasta la enmienda a ADR-0018 (T19).

| T | Tarea | H | Depende | Agente | Niv. |
|---|---|---|---|---|---|
| **T1** | Andamiaje `tests/acceptance/`: `vitest.acceptance.config.ts`, `npm run test:acceptance`, `harness.ts` (organización efímera, `GIT_SHA`/`refDate` fijos, `validacion.json` por test), arranque del **preview local** en la suite | 16 | — | dev-backend | 1 |
| **T2** | **C1** `c1-snapshots.test.ts` + retención mínima comprobada en `prune-runs.ts` | 18 | T1 | dev-backend | 1 |
| **T3** | **C2** `c2-motor.test.ts`: cinco casos límite × diez motores + **grep sobre los prompts de redacción** | 18 | T1 | dev-backend | 1 |
| **T4** | **C3** `c3-provenance.test.ts`: ejecutar la consulta de las 12 cifras y de los niveles acumulados; cronómetro celda→documento | 22 | T1 | dev-backend | 1 |
| **T5** | **C4 · auditor automatizado**: `scripts/audit-reconstruct.ts` (SQL crudo, sellos desde ADR-0011, aritmética entera, veredicto estructurado) + test estático de importaciones | **40** | T1 | dev-backend | 1 |
| **T6** | **C4 · inyección**: la matriz de **diez** de §3.5, sobre copia, con Capa 3 (`ManualReviewFlag`, umbrales, `diffRuns`) | 20 | T5 | dev-backend | 1 |
| **T7** | **C5** `c5-sellos.test.ts`: composición y retirada de badges, cobertura de etiquetas, vocabulario cerrado de motivos | 16 | T1 | dev-backend | 1 |
| **T8** | **C6** `c6-revision-humana.test.ts`: camino completo forzar/limpiar, roles, append-only, memoria sin cifras | 16 | T1 | dev-backend | 1 |
| **T9** | **C7** `c7-registro-runs.test.ts` + **schema zod de `registro.jsonl`** + trazabilidad inversa + ciclo en paralelo | 14 | T1 | dev-backend | 1 |
| **T10** | **Test «memoria borrada»**: `purgeDerived` **derivado del esquema**, tres variantes, comprobación negativa de pantallas | **28** | T2, T5 | dev-backend | 1 |
| **T11** | **Test «reconstrucción desde backup»**: A→ZIP→destruir→B, 12 cifras + 5 sellos, `audit-reconstruct` sobre B, cinco casos negativos | 20 | T10 | dev-backend | 1 |
| **T12** | **ADR-0020** + modelo: `OperatorException`, `OperatorExceptionKind`/`OperatorTargetKind`, migración, RLS, motivo de sello `EXCEPCION_DE_OPERADOR_VIGENTE`, **I-E12-5** | 12 | — | arquitecto → dev-backend | **2** |
| **T13** | **`/admin` escrituras**: las cuatro operaciones, doble confirmación en servidor, `PlatformAuditLog` + `AuditLog`, revocación de privilegios, test AST, UI con enumeración previa | **34** | T12 | dev-backend + dev-frontend | **2** |
| **T14** | **Deuda 1**: ZIP del backup en **streaming** + subida multipart + pico de memoria medido | 26 | — | dev-backend | **2** |
| **T15** | **Deuda 2, 3, 4**: retirar el disco heredado, **eliminar** `storage_used`/`storage_limit`, `static/` al almacén con `kind = BRANDING` | 22 | T14 | dev-backend | 1 |
| **T16** | **Deuda 7, 8**: rederivar claves de `stored_objects` (comprobación 6 **exacta**) + **G-15b** restaurar ZIP ajeno desde la interfaz con verificación de firma previa | 22 | T14 | dev-backend + dev-frontend | 1 |
| **T17** | **Deuda 6**: fixture `gran-volumen` generado y `--check`eable + techos **3, 5, 6 y 8** medidos con volumen real | 24 | T14 | qa-tester | 1 |
| **T18** | **G-20 + G-14**: golden tests de `models/stats.ts`, `lib/stats.ts` y `ai/*`; test que falla si un prompt cambia sin bump de versión | 18 | T1 | dev-backend | 1 |
| **T19** | **Deuda 11, 12, 13**: `BudgetCapexLine`, granularidad `MONTH` multi-mes, desglose mes a mes, **descomposición volumen/precio**, bloque de rentabilidad por proyecto; **enmienda a ADR-0018 D2** y fixture **v1.4** | **60** | T12 | dev-backend + dev-frontend | **2** |
| **T20** | **Deuda 14**: backups programados, CSV dentro del ZIP (segunda representación; manda el JSONL), `email-sync` como job de cron | 18 | T14 | dev-backend | 1 |
| **T21** | **Deuda 15**: `scripts/supabase-bootstrap.sql` idempotente + resolución o aceptación declarada del WARN `btree_gist` | 10 | — | dev-backend | 1 |
| **T22** | **CI**: `.github/workflows/fiabilidad.yml` con los nueve jobs, `GIT_SHA` y `TZ` en todos, artefactos y resumen en el PR; e2e **por fichero** | 18 | T9, T11, T17 | dev-backend | 1 |
| **T23** | **Documentación**: `README-FIABILIDAD.md` final (§7.1–7.3), **`SPEC-FIABILIDAD-v1.1-propuesta.md`** (diez enmiendas), `fiabilidad/SKILL.md` (`I-E12-1…8`, motivo nuevo), `ESTADO.md` (deuda tachada + erratas), `ROADMAP.md` (E12 cerrada), `ARQUITECTURA.md`, `codebase-taxhacker/SKILL.md` | 24 | T22 | documentador | 1 |
| **T24** | **QA**: los **60** criterios de §10 + adversarial (purga a medias, restauración a medias, excepción de operador caducada en vuelo, ZIP ajeno firmado, dos operadores concurrentes sobre la misma organización) + **cronometrar el guion de 10 minutos con alguien que no ha escrito el código** | 26 | T23 | qa-tester | 1 |
| **T25** | **Auditoría** en contexto limpio: reconstruir las 12 por un **tercer** camino, verificar que `audit-reconstruct` no comparte código, ejercer la purga y la restauración a mano, inyectar errores propios | 22 | T24 | auditor-fiabilidad | 1 |
| **T26** | **Revisión** en contexto limpio + rondas hasta APROBADO | 20 | T25 | revisor-codigo | 1 |

---

## 12. Plan de olas (tres agentes en paralelo, sin colisión)

**Regla de no colisión: dos olas nunca tocan el mismo fichero.**

### Ola A — la capa de aceptación y el auditor automatizado · **180 h**
`tests/acceptance/**` · `scripts/audit-reconstruct.ts` · `vitest.acceptance.config.ts` · schema de `registro.jsonl`

**T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9**

### Ola B — memoria borrada, backup y deuda de plataforma · **170 h**
`lib/platform/backup.ts` · `lib/storage/**` · `lib/documents.ts` · `models/{backups,storage,usage}.ts` · `scripts/{migrate-uploads-to-storage,supabase-bootstrap,prune-runs}` · `tests/fixtures/gran-volumen/`

**T14 → T15 → T16 → T17 → T20 → T21 → T10 → T11**
*(T10 y T11 esperan a T2 y T5 de la ola A: se planifican a partir de la semana 4.)*

### Ola C — `/admin`, controlling y los golden tests · **124 h**
`app/(app)/admin/**` · `models/operator-exceptions.ts` · `lib/budget/**` · `lib/analytics/margins.ts` · `models/stats.ts` · `lib/stats.ts` · `ai/**`

**T12 → T13 → T19 → T18**

### Cola de verificación (secuencial, contexto limpio) · **110 h**
**T22** → **T23** → **T24** → **T25** → **T26**

### Calendario

| Sem. | Ola A | Ola B | Ola C |
|---|---|---|---|
| 1 | T1, T2, T3 | T14 | T12 |
| 2 | T4, T5 | T15, T16 | T13 |
| 3 | T5, T6, T7 | T17, T20, T21 | T19 |
| 4 | T8, T9 | **T10** | T19 |
| 5 | — | **T11** | T18 |
| 6 | **T22** (sincronización) | | |
| 7 | T23, T24 | | |
| 8 | T25, T26 (rondas) | | |

**Punto de sincronización obligatorio: T22 no empieza hasta que las tres olas han
cerrado.** Un workflow de CI escrito sobre la mitad de las suites es el mismo
error que H-1 de E9, E10 y E11 —controles que no ejecutan nada—, y en E12 sería
especialmente ridículo.

**Y una regla propia de esta épica:** **T5 (el auditor automatizado) lo escribe un
agente que no ha escrito ninguna de las otras 25 tareas**, en contexto limpio, con
acceso sólo a `docs/spec/`, `docs/adr/`, el esquema de la base y el fixture. Si el
mismo agente escribe el motor y su refutador, la refutación es teatro.

---

## 13. Riesgos y alternativas descartadas

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| **El auditor automatizado deriva hacia el motor.** Alguien «factoriza» una función común y la Capa 2 pasa a confirmar en vez de refutar | **Alta** — es la tentación natural en cada refactor | Fatal: se pierde la única defensa independiente | Test estático sobre el AST de importaciones **en CI**, no en revisión humana. Y regla de autoría del §12 |
| **El test de memoria borrada encuentra una fuente encubierta** y E12 se convierte en una épica de motor | Media | Alto: se desborda | Es el resultado *deseable*. Si aparece, se abre como hallazgo con ADR y se re-fecha lo que sea necesario **antes** de tocar nada. La variante (c) —regenerar en otro orden— es la que más probabilidad tiene |
| **T19 (CAPEX + celda mensual) infla la épica.** Son 60 h de controlling dentro de una épica de fiabilidad | Media | Medio | Va en su propia ola, no bloquea a nadie, y es **lo primero que se re-fecha a E14** si la ronda de integración se estrecha. Su ADR (enmienda a 0018) se escribe al principio, no al final |
| **El fixture de gran volumen tarda demasiado en CI** (50 000 asientos) | Alta | Medio | Se genera una vez y se **cachea** por su hash; el job `perf` corre **sólo en `push` a `main`**, no en cada PR |
| **`/admin` se convierte en la puerta trasera de la capa de fiabilidad** | Baja, pero catastrófica | Fatal | Las cinco reglas de ADR-0020, y sobre todo la quinta: **toda excepción viva mueve el sello**. Si alguien propone una excepción que no mueva el sello, es que quiere apagar el control |
| **El e2e por matriz multiplica el tiempo de CI** (13 specs) | Media | Bajo | Corren en paralelo; el coste de pared no crece, el de minutos sí. Aceptado: un log de 600 líneas que no dice qué falló cuesta más |
| **La v1.1 se lee como «la spec estaba mal»** | Media | Medio, político | El documento se abre diciendo lo contrario: las diez enmiendas son lo que la v1.0 **provocó que aprendiéramos**, y nueve de las diez ya están implementadas de facto. Es una propuesta, no un parche |

### Alternativas descartadas

1. **Auditor automatizado como segundo LLM** en vez de SQL crudo. Descartada:
   viola P1 (una cifra saldría de un modelo) y no es reproducible. El agente
   `auditor-fiabilidad` sigue existiendo **encima**, para lo que una máquina no
   hace: sospechar.
2. **Reutilizar `run-invariants.ts` como Capa 2.** Descartada: comparte el motor
   entero. Es Capa 1, y ya está.
3. **Test de memoria borrada por `TRUNCATE` de la base entera.** Descartada: eso
   prueba que el fixture se recarga, no que los derivados se regeneran. Hay que
   borrar **sólo** lo derivado y dejar la SoT en pie — ahí está la prueba.
4. **`/admin` sin escrituras, dejando el SQL de runbook.** Descartada: es el
   estado actual, y es precisamente el que no deja motivo ni actor.
5. **Modificar `SPEC-FIABILIDAD.md` en sitio con las enmiendas.** Descartada: la
   v1.0 se declara inmutable en su cabecera y es de Pablo. Fichero nuevo,
   propuesta, firma.

---

## 14. Decisiones de Pablo, resueltas (P-1 … P-5)

Permiso general delegado de 2026-09-04; resueltas el **2026-09-15**.

| # | Decisión | Estado |
|---|---|---|
| **P-1** | **ADR-0020** (escrituras de operador y excepciones auditadas), D1–D6 | **APROBADO**. Desbloquea **T12** y **T13** |
| **P-2** | **Enmienda a ADR-0018 D2**: CAPEX dentro del `budgetHash`, fixture a **v1.4** | **APROBADA** con nota fechada en el propio ADR-0018. Desbloquea **T19** |
| **P-3** | ¿T19 (60 h de controlling) dentro de E12 o a E14? | **SE QUEDA EN E12.** El controlling mensual —celda mensual, volumen/precio, rentabilidad por proyecto— es **núcleo para un CFO**, no un extra de fiabilidad. Deja de ser «lo primero que se re-fecha» del §13: con esto, **E12 no re-fecha nada** |
| **P-4** | Errata **G-14** | Corregida en `docs/ESTADO.md` y anotada en `docs/AUDITORIA-FIABILIDAD.md` **sin reenumerar** (regla **E-10**), junto con G-15 y G-20. El `G-14` real lo cierra T5/T6 |
| **P-5** | **`SPEC-FIABILIDAD-v1.1-propuesta.md`** | Se entrega como **propuesta**. Su aprobación —total, parcial o ninguna— es de Pablo y **no bloquea el cierre de E12** |

> **Consecuencia sobre §13:** el riesgo «T19 infla la épica» deja de tener válvula
> de escape por decisión expresa. Su mitigación pasa a ser **temporal**: T19 corre
> entero en la ola C, entre las semanas 3 y 4, con su ADR ya firmado, y **no
> bloquea a nadie**. Si se desbordara, lo que se re-fecha es el **alcance de T19**
> (p. ej. el bloque de rentabilidad por proyecto), nunca la tarea entera.
