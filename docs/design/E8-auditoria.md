# E8 · Auditoría adversarial de fiabilidad — Documentos → asientos

**Auditor:** `auditor-fiabilidad` (contexto limpio, SPEC-FIABILIDAD C4 capa 2)
**Fecha:** 2026-09-06 · **Diff auditado:** `607f53c…HEAD` (7 commits, `HEAD = 1652150`)
**Entradas recibidas:** fixture sellado `docs/design/fixtures/extraccion-esperada.json`, diseño
`docs/design/E8-documentos-asientos.md`, `docs/adr/0014-…`, validación contable
`docs/design/E8-validacion-documentos.md`, invariantes `lib/ledger/invariants-e8.ts`.
No se recibió ni se leyó razonamiento del productor.

**Veredicto: DISCREPANCIA.** Los quince asientos son correctos al céntimo; los **tres puentes al
modelo 303** (I-E8-15a/15b/15c) están mal derivados y marcan FAIL sobre un diario impecable.

---

## 1 · Método (reconstrucción por otro camino)

No se ha reutilizado `lib/extraction/reconcile.ts`, `lib/ledger/postFromProposal.ts` ni `lib/fx`
para reconstruir ninguna cifra. La reconstrucción es **aritmética propia en Python** (`Decimal`,
`ROUND_HALF_UP` para impuestos, `ROUND_HALF_EVEN` para divisa, Hamilton por mayor resto con
desempate por menor código) más **SQL directo** contra `journal_lines`.

Tres caminos independientes, comparados entre sí con tolerancia 0:

| Camino | Qué produce |
|---|---|
| **A · Python del auditor** | base, cuota por tipo, retención, bloques de pasivo, conversión de divisa y las tres identidades de IVA de los 15 casos, a partir de `propuesta` + `contexto` del fixture |
| **B · Fixture sellado** | `asiento`, `libroRegistro`, `identidadesIva` (generador reproducible: `build_extraccion_esperada.py --check` → *OK, byte a byte*) |
| **C · Motor real sobre Postgres** | los 15 casos replicados en la base aislada `erp_audit` (clon migrado de `erp_test`) con plan NPGC PYMES real, tipos reales, contrapartes reales, tasa persistida real: `buildReconcileContext → reconcile → postFromProposal → postEntryTx`, y lectura posterior por SQL |

El camino C exigió tres traducciones **del arnés, no del motor**, porque el fixture usa un plan y un
catálogo sintéticos: `IRPF_15 → IRPF_PROF_15`, y `400/410/430/608/708 → 4000/4100/4300/6080/7080`
(en el NPGC sembrado esas cinco cuentas de cuatro dígitos son las postables; las de tres no lo son).
Toda diferencia de estado que quedó tras esas traducciones está explicada en §5.

---

## 2 · Cifras reconstruidas

| Métrica | Motor (SQL sobre `journal_lines`) | Reconstrucción | Δ | Método |
|---|---:|---:|---:|---|
| Σ debe = Σ haber (15 asientos + el original de C07) | 5 441 794 / 5 441 794 | idéntico | **0** | SQL `sum(debit)`/`sum(credit)` |
| Σ 472 del ejercicio | 530 383 | 530 383 | **0** | Python sobre las cuotas del fixture |
| Σ 477 del ejercicio | 79 800 | 58 800 + 21 000 del original sembrado | **0** | ídem |
| Σ 4751 (retención practicada) | 30 000 | 15 000 (C08) + 15 000 (C09) | **0** | 15 % sobre base 100 000, dos casos |
| C12 · total convertido USD→EUR | 925 926 | 925 926 | **0** | `Decimal(1 000 000 × 925 926 / 10⁶)` half-even |
| C12 · las cuatro líneas convertidas | 462 963 / 332 492 / 97 222 / 33 249 | idénticas | **0** | half-even línea a línea; residuo de conversión **0** |
| C05 · bloques de pasivo 523 / 4100 | 1 210 000 / 242 000 | 1 210 000 / 242 000 | **0** | reparto de 252 000 por base (Hamilton, sin resto) |
| Identidades IVA 15a/15b/15c por trimestre **sobre el fixture** | — | 0 en Q1–Q4 y en global | **0** | Python: Σ472 vs libro deducible, etc. |
| Identidades IVA 15a/15b/15c **sobre el motor** | Q4 −10 438 · Q3 +12 600 | 0 | **≠0** | ver H-1 y H-2 |

Comprobaciones puntuales exigidas, todas **conformes** en el motor real:

- **C02 · cuota del documento, no la recalculada**: el diario lleva `472 = 21 001` y `472 = 4 999`
  (las del papel), no 21 000 / 5 000. La desviación de 1 c queda como métrica I-E8-7b, no como asiento.
- **C03 · ticket no cualificado**: `629 = 1 234`, `572 = 1 234`. **Sin 472.**
- **C04 · ticket cualificado**: `629 = 1 122`, `472 = 112`, `572 = 1 234`. Base por RC-17
  (`round_half_up(1 234 × 10 000 / 11 000) = 1 122`), cuota residual 112: base + cuota = total, sin línea de redondeo.
- **C10 · importación**: `600 / 4000` por 500 000. **Sin 472 ni 477.**
- **C11 · inversión del sujeto pasivo**: `472 = 63 000` y `477 = 63 000`, **iguales**.
- **C14 · anticipo de cliente**: `4300 / 438` por 1 210 000. **Sin 477** (art. 75.Dos LIVA, ADR-0014 D13).
- **C07 · rectificativa por sustitución = diferencia**: contra un asiento original **real**
  (`FV2026/0041`, base 100 000 / cuota 21 000) contabilizado antes por el mismo motor, la
  rectificativa que sustituye por 80 000 produce `7080 = 20 000`, `477 = 4 200`, `4300 = 24 200`.
  Es la diferencia, no el documento entero.
- **C13 · extracción parcial**: `pagesAnalyzed 4 < pagesTotal 9` → `reconcile` FAIL por **RC-09** y
  **no hay asiento ni `Transaction` colgada**.

---

## 3 · Hallazgos

### H-1 · [ALTA] El libro registro no convierte la divisa: I-E8-15a y I-E8-15b fallan con toda factura en moneda extranjera

`lib/ledger/invariants-e8.ts:184 vatBookRowFromProposal()` deriva la anotación del libro **de la
propuesta sellada**, y la propuesta está en la **moneda del documento**. El diario está en moneda
base. Nadie convierte entre las dos orillas del puente.

Evidencia (C12, factura de 10 000,00 USD del 2026-11-20, tasa persistida 925 926 µ):

```
propuesta.taxes  →  105 000 + 35 909 = 140 909   (USD)
journal_lines    →   97 222 + 33 249 = 130 471   (EUR)
I-E8-15a 2026-Q4 →  libro 455 909 vs diario 445 471   (diferencia −10 438 = 140 909 − 130 471)
```

`BookableProposal` (`invariants-e8.ts:151`) no tiene campo de moneda ni de tasa, y el ensamblador
(`models/ledger.ts:1634`) le pasa la propuesta cruda. Retirado C12 del periodo, 15a y 15b dan 0.

### H-2 · [ALTA] La rectificativa por sustitución anota en el libro la cuota del documento sustituido, no la diferencia contabilizada: I-E8-15c falla

`BookableProposal` tampoco conoce `rectifies`, de modo que el libro toma
`Σ taxes.quotaCents × signo` — la cuota **entera** del documento rectificativo — mientras el asiento
lleva, correctamente, la **diferencia** (ADR-0014 D12).

Evidencia (C07):

```
propuesta.taxes  →  16 800  (80 000 × 21 %)   ⇒ libro cuotaRepercutida −16 800
journal_lines    →   4 200                    ⇒ 477 del diario          −4 200
I-E8-15c 2026-Q3 →  libro −16 800 vs diario −4 200  (diferencia 12 600)
```

El fixture sellado dice `libroRegistro.cuotaRepercutidaCents = −4 200` para C07: **la derivación del
motor contradice al fixture**, y el fixture es el que tiene razón.

**Efecto combinado de H-1 y H-2.** Sobre un diario de quince documentos donde cada asiento es
correcto al céntimo, `scripts/run-invariants.ts` da `I-E8-15a FAIL · I-E8-15b FAIL · I-E8-15c FAIL`
y **sello REQUIERE REVISIÓN**. Un invariante que grita con datos buenos deja de leerse: es el peor
resultado posible para el puente al 303.

### H-3 · [MEDIA] `diskSha256` no lo escribe nadie: I-E8-2 nunca compara los bytes en disco

`invariants-e8.ts:79` declara `diskSha256` y las líneas 341-342 lo consumen, pero **no hay un solo
productor en todo el repositorio** (`grep -rn diskSha256 --include=*.ts` → sólo la declaración y los
dos consumidores). El propio texto de evidencia dice «ejecuta `scripts/run-invariants.ts`, que sí lee
los bytes»; el script no lee ningún byte. Resultado permanente:

```
I-E8-2  WARN  15 run(s) con asiento cuadran con el fichero; 15 sin comprobar en disco
```

y ese WARN, por encima del umbral 0, empuja el sello a REQUIERE REVISIÓN en toda ejecución. La mitad
de la cadena que detecta un documento **cambiado bajo los pies del ERP** no está implementada. El
auditor la comprobó a mano: los 16 ficheros del replay tienen `sha256(bytes en disco) = files.sha256`.

### H-4 · [MEDIA] `ExchangeRateUnavailableError` no se captura en ninguna server action

`lib/fx/rates.ts` lanza la excepción cuando la fuente no publica (correcto: **nunca inventa** una
tasa). Pero nadie la captura: `app/(app)/unsorted/actions.ts` no la importa, y `buildReconcileContext`
la deja propagar. Consecuencias: (i) `analyzeFileAction`/`previewProposalAction`/`confirmProposalAction`
rompen su contrato `ActionState` y devuelven una excepción sin tipar; (ii) la rama «sin tasa» de
**RC-14** es código muerto en producción, porque `rate` sólo llega a `null` cuando divisa = moneda
base, caso que ni siquiera entra en la rama.

### H-5 · [MEDIA] Ningún invariante recomputa `proposal_sha`: el run es inmutable por permisos, no por evidencia criptográfica

`ExtractionRunRef` (`invariants-e8.ts:35`) no lleva `proposalSha`, y ningún check vuelve a calcular
`proposalHash(run.proposal)`. Se editó por SQL como `postgres` la cuota de la propuesta de un run **ya
contabilizado** (21 000 → 25 000): `proposal_sha` quedó intacto y **ningún invariante nombró el
run**. Sólo saltó, de rebote, `I-E8-15a/15b` del trimestre. Una manipulación de un campo que no sea
cuota (contraparte, fechas, `accountCode`, `deductibility`) sería **invisible**. Compárese con
`journal_entries`, que sí tiene `entry_hash` con trigger de guarda.

### H-6 · [BAJA] El fixture sellado sólo se verifica contra un plan sintético

`lib/extraction/reconcile.fixture.ts:19-21` construye un `Plan` sintético a propósito y lo documenta.
Es defendible para el motor puro, pero significa que **ningún test replica los quince casos sobre el
NPGC sembrado**. El replay de esta auditoría es el primero que lo hace, y para lograrlo hubo que
traducir cinco cuentas y un código de retención (§1). Un cambio en `seeds/npgc.csv` o en
`organization_account_maps` no rompería ninguna prueba de E8.

### H-7 · [BAJA] El único caso en divisa tiene residuo de conversión 0

`1 000 000 × 925 926 / 10⁶ = 925 926,000000` exacto, y la suma de las cuatro líneas convertidas da el
total sin sobrante. El reparto Hamilton del residuo de conversión sobre las cuotas (ADR-0014 D2,
`convenciones.hamilton` del propio fixture) **no está ejercido por ningún caso sellado**.

### H-8 · [OBSERVACIÓN] `exchange_rates` es global y visible entre organizaciones — por diseño

Comprobado: desde la organización B se ven **2 tasas** de A, y **0** runs, ficheros, asientos,
contrapartes y transacciones. Es ADR-0014 D7 («`exchange_rates` por organización» figura entre las
alternativas descartadas) y la tabla lleva `FORCE` con RESTRICTIVE en UPDATE/DELETE. Se anota porque
el encargo pedía aislamiento también de las tasas: la referencia del BCE es pública, pero *qué* pares
y *qué* fechas consulta una organización sí es información suya.

### H-9 · [OBSERVACIÓN] `resolveRectifiedEntry` no valida el formato de `rectifies.entryId`

`models/reconcile-context.ts` pasa el valor directo a `findFirst({ where: { id } })`: un identificador
no-UUID produce `22P02 → P2007` sin tipar en vez de un RC-21 FAIL. **Hoy es inalcanzable** —
`ai/schema.ts:123` no expone `entryId` al modelo y `forms/extraction.ts:104` lo valida como `uuid`—,
así que es endurecimiento defensivo, no un defecto abierto.

---

## 4 · Lo que resistió (verificado, no asumido)

| Prueba | Resultado |
|---|---|
| **Cadena** asiento → `extraction_run` → `file` | 15/15 asientos con run y fichero; `runs.file_sha256 = files.sha256` en 15/15; `sha256(bytes en disco) = files.sha256` en 16/16 |
| **Inmutabilidad del run** como `app_runtime` | `UPDATE`/`DELETE` sobre `extraction_runs` → **42501** `permission denied`. Ídem `journal_entries` |
| **Revisión = run nuevo** | `createRevisionRun` cuelga de `parentRunId`; el run del modelo queda intacto (código y esquema) |
| **CHECK D1 `POSTED ⟺ journal_entry`** | 0 filas fuera de la semántica; `transactions_status_entry_d1` presente |
| **(a) `sha256` alterado por SQL** | `I-E8-2 FAIL — el sha del run no es el del fichero (documento alterado)`; sello **REQUIERE REVISIÓN** |
| **(b) `reconcile_status` FAIL→PASS y confirmar** | **Rechazado.** El estado guardado no es la puerta: `judge()` vuelve a reconciliar contra la base y devuelve `FAIL · RC-09`. Motor: `PASS` en BD → `FAIL` recalculado |
| **(c) propuesta editada por SQL** | Detectado **sólo de rebote** por I-E8-15a/15b → ver **H-5** |
| **(d) borrar el asiento vinculado** | **Imposible incluso como `postgres`.** `DELETE` de líneas → trigger `app.assert_entry_balanced()`; `DELETE` del asiento → FK RESTRICT desde `journal_lines`; anular el `journal_entry_id` de la operación → `transactions_status_entry_d1`. Ni con `DISABLE TRIGGER ALL` sobre `journal_lines`, porque el CHECK de la operación bloquea la cascada |
| **(e) run parcial** | C13 no se puede confirmar: RC-09 FAIL, sin asiento y sin operación. `I-E8-10 PASS` |
| **FX · tasa a fecha de documento, persistida y reutilizada** | `2026-11-20 USD→EUR 925 926 µ`, `source = ECB_FRANKFURTER`, `fetchedAt` sellado; dos llamadas devuelven el **mismo id** sin re-fetch (memo por petición + tabla); `convertedTotal` exacto, residuo 0 |
| **Tenant** | Desde B: 0 runs, 0 ficheros, 0 asientos, 0 contrapartes, 0 transacciones de A; el run concreto de A es **invisible** (`findFirst` → `null`). Tasas: ver H-8 |
| **Suites** | `npm run test` 56 ficheros / 1 294 tests en verde; integración E8 (`e8-actions`, `e8-invariants`, `e8-extraccion-fx`, `e8-esquema`) 61 tests en verde sobre `erp_audit`; `build_extraccion_esperada.py --check` reproducible byte a byte |

## 5 · Trazabilidad — **OK**

Cifra elegida al azar: **623 «Servicios de profesionales independientes» = 100 000 c** de la PyG.
Una sola consulta la lleva al documento en **menos de un minuto**:

```sql
SELECT l.account_code, l.debit_cents, e.entry_number, e.document_date,
       r.id AS run_id, r.model, r.prompt_sha, f.filename, f.sha256, t.name
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN extraction_runs r ON r.id = e.extraction_run_id
  JOIN files          f ON f.id = e.file_id
  JOIN transactions   t ON t.journal_entry_id = e.id
 WHERE l.organization_id = $1 AND l.account_code = '623';
```

Devuelve 3 filas, cada una con asiento, número de documento, run (modelo + `prompt_sha`), fichero y
`sha256` verificable contra el disco. La cadena está completa y es navegable en un salto.

## 6 · Diferencias de estado del replay, explicadas

Los quince casos reprodujeron el `reconcile.status` del fixture salvo **C03 y C04** (fixture WARN,
motor PASS). La causa es del arnés: el WARN sellado es `RC-11 — NIF válido del emisor sin ficha de
contraparte`, y el replay sembró `CP-ES-TICKET` en el maestro. Con la ficha presente, PASS es la
respuesta correcta. **No hay ninguna diferencia atribuible al motor.**

## 7 · Recomendación

1. Dar a `vatBookRowFromProposal` la moneda y la tasa del documento y el modo de la rectificativa
   (H-1, H-2), o derivar el libro de las líneas del asiento y contrastarlo contra la propuesta por
   otro invariante: hoy los tres puentes al 303 no son fiables.
2. Escribir `diskSha256` en `scripts/run-invariants.ts` (H-3) y capturar
   `ExchangeRateUnavailableError` en las server actions devolviendo RC-14 (H-4).
3. Añadir `proposalSha` a `ExtractionRunRef` con un check que lo recompute (H-5) y un test de
   integración que replique los quince casos sobre el NPGC sembrado (H-6).

---

### Restauración y aislamiento

Todo el trabajo se hizo en la base **`erp_audit`**, clon migrado de `erp_test`, y en
`UPLOAD_PATH` del scratchpad. Las bases `erp` y `erp_test` no se tocaron. Las alteraciones inyectadas
(`files.sha256`, `extraction_runs.reconcile_status`, `extraction_runs.proposal`, la tasa JPY→EUR del
sondeo) se revirtieron y se verificó que los invariantes vuelven a la línea base; después se eliminó
`erp_audit` y los scripts temporales del auditor. **No se modificó ni producto ni fixtures.**

---

# Re-auditoría (ronda 1) — `1652150…008fa0d`

**Fecha:** 2026-09-06 · **Commit:** `008fa0d` · **Base aislada:** `erp_audit` (clon migrado de `erp_test`),
almacén de ficheros propio en el scratchpad. Reconstrucción **de nuevo por Python/SQL propios**.

```
VEREDICTO: CONFORME
```

| # | Comprobación exigida | Resultado |
|---|---|---|
| 1 | Las 6 cifras y los 15 asientos | **Δ = 0.** Σdebe = Σhaber = 6 361 798 (5 441 794 de la ronda 0 + 920 004 del caso CHF nuevo); Σ472 = 660 020 (530 383 + 129 637); Σ477 = 79 800; Σ4751 = 30 000; C12 = 925 926; C05 bloques 523/4100 = 1 210 000 / 242 000. Los **14 asientos con `asiento` en el fixture se compararon línea a línea con `journal_lines`: 0 discrepancias**; C13 sigue sin asiento (RC-09) |
| 2 | I-E8-15a/b/c a 0 con C12 y C07, y I-E8-7a **no tautológico** | **15a/15b/15c PASS en los cuatro trimestres** con C12 (divisa) y C07 (sustitución) dentro. **Ojo:** ahora ambas orillas de 15a/b/c salen del asiento, así que **15a/b/c sí son tautológicos**; el puente real es I-E8-7a con su `contrast` (libro-desde-propuesta convertido y con `rectificationDelta`). Se alteró por SQL la cuota de la propuesta de C01 (21 000 → 25 000) y **I-E8-7a FAIL**: *«asiento 2: cuota deducible — el asiento dice 21000 y el documento 25000 (diferencia −4000)»*, mientras 15a/b/c seguían en PASS. **No es tautología, y es el único que lo detecta** |
| 3 | `diskSha256` | **Implementado y efectivo.** Con el almacén intacto: `I-E8-2 PASS — 16 run(s) con asiento: sha en disco = sha del fichero = sha del run`. Alterando los bytes de un fichero **y borrando otro**: `I-E8-2 FAIL` con los dos motivos distinguidos (*«los bytes en disco no son los registrados»* y *«no se pueden leer los bytes en disco — el fichero no está en el almacén»*) y **sello REQUIERE REVISIÓN**. Cierra H-3 |
| 4 | Sin tasa disponible → RC-14 sin inventar | **Correcto.** Con la fuente inalcanzable y un documento en GBP sin tasa persistida, el camino real devuelve un `ActionState { success:false }` con el texto **RC-14** («no se ha guardado nada»); `exchange_rates` pasa de 3 filas a 3 (**no se inventa ni se persiste nada**) y **ninguna excepción escapa**. `guardingRates` envuelve las seis acciones exportadas de `unsorted/actions.ts`, y su predicado es exactamente la clase `ExchangeRateUnavailableError` que se provocó. Cierra H-4 |
| 5 | `proposal_sha` editado por SQL | **I-E8-11 FAIL** aislado: *«run c8432865…: proposal_sha ffffffffffff ≠ 29a23d24d5aa recalculado sobre su contenido (el run se ha editado después de sellarse)»*, con I-E8-2 y I-E8-7a en PASS. El invariante recalcula además `schema_sha` y `prompt_sha`. Cierra H-5 |
| 6 | CHF con residuo ≠ 0 | **Δ = 0.** Caso construido por el auditor (no se tocó el fixture): bases 500 001 @21 % y 359 094 @10 %, cuotas 105 000 y 35 909, total 1 000 004 CHF, `rateMicro = 920 000`. Σ half-even de las partes = 920 003 vs `convertedTotal` 920 004 → **residuo +1**. Hamilton propio (mayor resto sobre el reparto de 129 637 entre las cuotas, desempate por menor código): restos 75 600 (IVA_21) > 65 309 (IVA_10) ⇒ el céntimo va a **IVA_21**. El motor: `600 460 001 · 600 330 366 · 472 96 601 · 472 33 036 · 4000 920 004 (CHF 1 000 004)`. **Idéntico**, y Σ = `convertedTotal` exacto. Cierra H-7 |
| 7 | Los 15 casos sobre el NPGC real | **Δ = 0** contra la reconstrucción Python, con plan PYMES sembrado, tipos y contrapartes reales. Persisten las tres traducciones del arnés (`IRPF_15→IRPF_PROF_15`, `400/410/430/608/708 → 4000/4100/4300/6080/7080`), de modo que **H-6 sigue abierto**: no hay test de producto que replique los quince casos sobre el plan sembrado |

**Estado del sello.** Con los diecisiete documentos correctos y el almacén intacto: **ningún invariante en
FAIL** (antes: 15a, 15b, 15c). El sello sigue en REQUIERE REVISIÓN, pero ya sólo por motivos legítimos:
git-sha desconocido (ejecución fuera de una build), la métrica I-E8-7b (el céntimo de C02, por diseño) y
los tres motivos documentales de ADR-0014 D7 que los propios casos provocan (C01 IVA en otro periodo,
C13 sin reconciliar, C08 sin retención consignada).

**Hallazgos de la ronda 0:** H-1, H-2, H-3, H-4, H-5 y H-7 **cerrados y verificados**. **H-6 abierto**
(cobertura del plan real). H-8 y H-9 siguen como observaciones asumidas. **No hay hallazgos nuevos**; la
única anotación es que I-E8-15a/b/c pasaron a ser confirmaciones internas del diario y toda la carga de
prueba del puente al 303 recae ahora en I-E8-7a, que es donde debe estar pero es un punto único.

**Restauración.** Se revirtieron las cinco alteraciones (cuota de la propuesta, `proposal_sha`, bytes
alterados, fichero borrado, `schema_sha` del arnés) y una ejecución final de invariantes es **idéntica a la
línea base limpia, sin ningún FAIL**. Después se eliminó `erp_audit` y los scripts temporales. `erp` y
`erp_test` no se tocaron. **No se modificó ni producto ni fixtures.**
