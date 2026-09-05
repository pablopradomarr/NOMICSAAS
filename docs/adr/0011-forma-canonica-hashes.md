# ADR-0011 — Forma canónica real de `ledgerHash` v2, `entryHash` y `analyticsHash`

**Estado:** APROBADO por Pablo el 2026-09-05 (permiso general delegado) · **Nivel:** 2 · **Fecha:** 2026-09-05 · **Épica:** E4 · **Sustituye:** la tabla de tuplas de `docs/adr/0010-reclasificacion-analitica.md` §«Decisión E4-D2 — Tres sellos, tres oficios» · **Implementación:** `lib/ledger/hash.ts`, `lib/analytics/hash.ts`, `models/ledger.computeLedgerHash`, migración `20260908100000_e4_analytics` §7f

## Contexto

ADR-0010 fijó la separación de sellos (E4-D2) y es correcta: `ledgerHash` deja de incluir las cuatro columnas analíticas, `entryHash` las conserva y nace `analyticsHash`. Al implementarlo apareció una **contradicción interna en la tupla concreta** que aquel ADR enumera para `ledgerHash`:

```
(entryId, lineNo, accountCode, debitCents, creditCents, entryDate, fiscalYearId, entryKind, taxRateId)
```

`entryId`, `fiscalYearId` y `taxRateId` son **uuid generados por fila y por organización**. Incluirlos hace que el sello financiero:

1. **Rompa la reproducibilidad entre cargas.** El criterio 15 de E3 exige —y su test lo comprueba desde E3, en verde— que dos cargas del mismo fixture en dos organizaciones distintas produzcan **el mismo `ledgerHash`**. Con uuids dentro, dos diarios idénticos al céntimo producen sellos distintos.
2. **Rompa el criterio 18 de E4** («dos cargas del fixture ⇒ mismos `entryHash`, `ledgerHash`, `analyticsHash`, `marginConfigHash` y matriz al céntimo»).
3. **Anule el efecto colateral que el propio ADR-0010 declara valioso**: «dos organizaciones con el mismo diario y distinta analítica producen el mismo `ledgerHash` y las verificaciones de I1–I3 son comparables». Con uuids eso es imposible por construcción.

No es un defecto de la decisión, sino de la enumeración de columnas: ADR-0010 nombraba las columnas *conceptuales* del hecho económico, y las claves técnicas se colaron en la lista.

## Decisión

Se fija la forma canónica **real y definitiva** de los tres sellos. En todos los casos: una fila TSV por línea, `\n` entre filas, `∅` para nulos, orden canónico `(entryDate, entryNumber, lineNo)`, `sha256` en hexadecimal minúscula sobre UTF-8.

| Sello | Tupla por línea | Ámbito | Cambia al reclasificar |
|---|---|---|---|
| **`ledgerHash`** (financiero, **v2**) | `(entryDate, entryNumber, lineNo, accountCode, debitCents, creditCents, entryKind)` | Conjunto de líneas de un periodo o ejercicio | **No** |
| **`entryHash`** (de fila, **v2**) | `(entryId, entryNumber, lineNo, accountCode, debitCents, creditCents, entryDate, fiscalYearId, entryKind, taxRateId, taxBaseCents, counterpartyId, dueDate, description, analyticType, projectId, costCenterId, businessLineId)` | Las líneas de UN asiento | **Sí**: se recalcula en la misma transacción |
| **`analyticsHash`** | `(entryId, lineNo, projectId, costCenterId, businessLineId, analyticType)` ordenado por `(entryId, lineNo)`, más `marginConfigHash` y `allocationRunId` | Conjunto de líneas del periodo | **Sí** |

### Criterio de comparabilidad: por qué `ledgerHash` no lleva uuids y `entryHash` sí

Los dos sellos tienen oficios distintos y por eso llevan cosas distintas:

- **`ledgerHash` es un sello de INFORME.** Responde a «¿qué cifras contables componen este periodo?». Debe ser **comparable entre organizaciones y entre cargas**: es la clave de reutilización de un `ReportRun` y lo que permite afirmar que dos verificaciones de I1–I3 miran el mismo diario. Una clave técnica no es parte del hecho económico —cambiar el uuid de un asiento no cambia ni un céntimo—, así que no puede sellarlo. La identidad de una línea **dentro de su organización** ya la fijan `(entryDate, entryNumber, lineNo)`, que es además el orden canónico y es único por I7 (numeración contigua sin huecos por ejercicio). `taxRateId` tampoco entra: el tipo impositivo no es una cifra del diario y su efecto ya está en `debitCents`/`creditCents`; lo que sí lo custodia es `entryHash`.
- **`entryHash` es un sello de FILA.** Responde a «¿ha cambiado algo de este asiento?» (I-E3-7). Su trabajo es detectar **cualquier** mutación, incluidas las que no mueven un céntimo —una reclasificación analítica, un cambio de vencimiento, una descripción—, así que lleva **todas** las columnas, uuids incluidos. No tiene por qué ser comparable entre organizaciones y no se usa para nada que lo requiera.

Corolario operativo: **cualquier futura columna que represente una cifra o una fecha contable entra en `ledgerHash`; cualquier clave técnica o dato de gestión, no** —pero sí en `entryHash`.

### Implementación única

La forma canónica v2 se implementa **una sola vez** en `lib/ledger/hash.ts` (`canonicalForm` para el financiero, `canonicalEntryForm` para el de fila) y se replica en SQL en exactamente dos sitios, ambos con test que compara los dos caminos sobre el fixture completo:

- `models/ledger.computeLedgerHash` (agregado en la base, para no materializar el diario).
- El recálculo del histórico de la migración `20260908100000_e4_analytics` §7f.

`hashVersion = 2` queda escrito en cada asiento. **v1 no vuelve a emitirse y v2 no se toca nunca más**: cualquier cambio futuro de forma exige una versión nueva y convivencia de ambas, jamás una reescritura. La única reescritura admisible fue la de E4, posible solo porque no había datos en producción.

## Alternativas descartadas

- **Dejar la tupla literal de ADR-0010.** Rompe dos criterios de aceptación con test en verde (E3-15 y E4-18) y contradice el beneficio que el propio ADR-0010 declara. Habría obligado además a borrar el test de E3 en lugar de a corregir la tupla, que es exactamente lo que CLAUDE.md prohíbe.
- **Hacer deterministas los uuid** (derivarlos del contenido). Convertiría la clave primaria en un hash de negocio, con colisión garantizada en cuanto dos asientos idénticos convivan legítimamente (dos facturas iguales el mismo día) y con una migración de claves primarias por delante.
- **Dos `ledgerHash`, uno comparable y otro con ids.** Dos sellos para el mismo oficio: nadie sabría cuál sella un `ReportRun` y la ambigüedad acabaría en informes irreproducibles, que es lo que P7 prohíbe.
- **Excluir también `entryKind` del financiero.** `entryKind` decide qué entra en I3 y en I4 (`REGULARIZATION`/`CLOSING`/`OPENING` quedan fuera): es parte de la cifra, no una etiqueta técnica.

## Consecuencias

`ledgerHash` es una función pura del **contenido contable** del periodo: mismo diario ⇒ mismo sello, en cualquier organización y en cualquier carga. Eso hace comparables las verificaciones de I1–I3, permite reutilizar un `ReportRun` entre entornos y convierte la reproducibilidad en algo comprobable con un test barato. A cambio, `ledgerHash` **no identifica** qué filas concretas lo compusieron: para eso está la provenance (consulta parametrizada por organización y periodo), y para detectar la mutación de una fila concreta está `entryHash`.

La tabla de tuplas de ADR-0010 §E4-D2 queda **sustituida** por la de este ADR. Todo lo demás de ADR-0010 —la decisión de reclasificar, las cinco salvaguardas y la separación conceptual de los tres sellos— sigue vigente sin cambios.
