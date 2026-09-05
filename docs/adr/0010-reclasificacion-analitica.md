# ADR-0010 — Reclasificación analítica de líneas ya posteadas y separación del sello financiero del analítico

**Estado:** APROBADO por Pablo el 2026-09-05 (permiso general delegado) · **Nivel:** 2 · **Fecha:** 2026-09-05 (ronda 2) · **Épica:** E4 · **Diseño:** `docs/design/E4-analitica.md` §2.5 y §2.6 · **Validación contable:** `docs/design/E4-validacion-analitica.md` §3 y §8.5 (decisiones **E4-D1** y **E4-D2**)

## Contexto

ADR-0003 y la migración de E3 (`20260907100000_e3_ledger`) fijaron un diario inmutable: `REVOKE ALL … GRANT SELECT, INSERT ON journal_entries, journal_lines`, sin `UPDATE` sobre las líneas y con anulación **solo** por contra-asiento. ADR-0004 puso las dimensiones analíticas (`projectId`, `costCenterId`, `businessLineId`, `analyticType`) **dentro de la propia línea**. Consecuencia no resuelta: equivocarse de proyecto al imputar un gasto —el error más frecuente del día a día— sería irreparable, o solo reparable anulando y volviendo a postear un asiento contable que es correcto.

## Decisión

Se crea la operación **reclasificación analítica**: cambiar `project_id`, `cost_center_id`, `business_line_id` y `analytic_type` de una o varias líneas posteadas, **sin tocar el diario financiero** (cuenta, importe, fecha, número, contrapartida, impuesto y vencimiento son inmutables).

Justificación: la dimensión analítica **no es partida doble** y **no es libro obligatorio**. No lleva debe ni haber, no altera ningún saldo de cuenta, ni la PyG contable (I3), ni el balance (I2), ni el modelo 303, ni la numeración. Los libros que impone el art. 25.1 CdC son el de inventarios y cuentas anuales y el diario; la contabilidad de costes no se legaliza (art. 27 CdC) ni se deposita, y el art. 29.1 CdC protege el registro del hecho económico —importe, cuenta, fecha, contrapartida—, ninguno de los cuales se mueve. La inmutabilidad que protege ADR-0003 es la de *la cifra contable*, y la cifra contable no se mueve: hay un test que lo exige (`pnlContableCents` y `ledgerHash` idénticos al céntimo antes y después).

## Decisión E4-D2 — Tres sellos, tres oficios

La decisión anterior es incompatible con P3/P7 mientras `ledgerHash` incluya las columnas analíticas, como las incluía la forma canónica v1 de E3: reimputar un gasto invalidaría el balance, la PyG contable, el cashflow y el libro diario ya sellados, que no han cambiado en un solo céntimo. Por eso se separan:

| Sello | Contenido | Cambia al reclasificar |
|---|---|---|
| **`ledgerHash`** (financiero, **v2**) | `(entryId, lineNo, accountCode, debitCents, creditCents, entryDate, fiscalYearId, entryKind, taxRateId)` — **sin** las cuatro columnas analíticas | **No** |
| **`entryHash`** (de fila) | Todas las columnas de las líneas del asiento, dimensiones incluidas | **Sí**: se recalcula en la misma transacción |
| **`analyticsHash`** (nuevo) | `(entryId, lineNo, projectId, costCenterId, businessLineId, analyticType)` + `marginConfigHash` + `allocationRunId` vigente | **Sí** |

Cambiar la forma canónica de `ledgerHash` solo es admisible **ahora**: no hay ningún despliegue con diario posteado y el único diario existente es el fixture, que se recarga entero. La migración de E4 recalcula `journal_entries.entry_hash` con la forma v2 bajo el patrón `NO FORCE` → recálculo → `FORCE` (marca **antes** del backfill) y escribe `hash_version = 2`. **v1 no vuelve a emitirse y v2 no se toca nunca más**: cualquier cambio futuro de forma exige versión nueva y convivencia, no reescritura. Efecto colateral valioso: el sello financiero deja de depender de datos de gestión, así que dos organizaciones con el mismo diario y distinta analítica producen el mismo `ledgerHash` y las verificaciones de I1–I3 son comparables.

Salvaguardas, las cinco obligatorias y cada una con test:

1. **Solo las cuatro columnas.** `GRANT UPDATE ("project_id","cost_center_id","business_line_id","analytic_type") ON journal_lines TO app_runtime` y nada más; trigger `journal_lines_only_analytics_update` que lanza si cualquier otra columna cambia (el propietario esquiva los GRANT, el trigger no).
2. **El sello se rehace, no se rompe.** `entry_hash` se recalcula en la misma transacción (`GRANT UPDATE ("entry_hash") ON journal_entries`), de modo que I-E3-7 sigue en PASS; los dos hashes quedan en el `AuditLog`.
3. **Traza obligatoria.** `AuditLog(entity="JournalLine", action="reclassify", before, after, reason, userId)` en la misma transacción, con motivo de ≥ 8 caracteres. Sin motivo no hay reclasificación.
4. **Ventana.** Ejercicio `OPEN` y mes abierto: EDITOR. Mes bloqueado del ejercicio abierto: solo ADMIN, con motivo — lo que el `PeriodLock` congela es la cifra rendida (diario, saldos, 303 y balance), y ninguna de las cuatro se mueve. Ejercicio `CLOSED`: **nunca, sin excepción de rol** (arts. 253, 272 y 279 LSC): ahí hay cuentas formuladas y depositadas, e informes de gestión que sirvieron para decidir y retribuir. Barrera 1 en la acción, barrera 2 en el trigger `journal_lines_reclassify_window`.
5. **Caduca solo lo analítico.** *(Corregido en ronda 2 por la enmienda del experto, §8.5 de `E4-validacion-analitica.md`.)* Por E4-D2 el `ledgerHash` **no cambia**, así que los `ReportRun` financieros —`DIARIO`, `MAYOR`, `SUMAS_SALDOS`, `BALANCE`, `PYG`, `CASHFLOW_*`— siguen vigentes y no se reemiten. Lo que cambia es `analyticsHash`, que caduca únicamente `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD` (quedan históricos, nunca se sobrescriben, P3) e invalida los `AllocationRun` del periodo (`supersededById`, E5). La Auditoría lista nº de reclasificaciones, importe reclasificado y runs invalidados.

## Alternativas descartadas

- **Anular y volver a postear.** Mete en el diario pares de asientos que netean cero, consume dos números por cada corrección, choca con «un solo contra-asiento por asiento» (I-E3-2) a la segunda, y hace ilegible el mayor de cualquier empresa que impute bien. Todo eso para un dato que no es contable.
- **No permitir la corrección.** La analítica queda mal para siempre en cuanto alguien se equivoca de proyecto; el producto que ADR-0004 justifica deja de servir.
- **Sacar las dimensiones a una tabla `AnalyticAllocation` aparte**, mutable sin tocar el diario. Contradice ADR-0004, obliga a cambiar la forma canónica de `ledgerHash` fijada en E3, y abre la puerta a líneas con cero o dos destinos, que es justo lo que C-9 impide por construcción.

- **Corregir imputación no es anular.** El contra-asiento hereda **literalmente** el destino analítico del original y `validateAnalytics()` no se ejecuta sobre un `REVERSAL` (§8.7 del experto): si la anulación fuera a otro destino, el par cuadraría en la PyG contable y descuadraría en dos columnas de la matriz sin que I4 lo detectase, porque los totales de fila son ciegos a la distribución. Eso lo comprueba I-E4-11 (Σ aporte = 0 por cuenta **y** por destino).

## Consecuencias

`journal_lines` deja de ser estrictamente *append-only*: pasa a ser *append-only en lo contable* y *auditable en lo analítico*. Cualquier revisión futura de RLS o de GRANTs debe preservar exactamente estos cuatro nombres de columna y los tres triggers. Se asume además una única reescritura de sellos (`hashVersion` 1 → 2), viable solo por la ausencia de datos en producción. A cambio, la imputación es corregible sin ensuciar el diario, con traza nominal y motivo; los invariantes I2, I3 e I-E3-7 siguen en PASS por construcción; y los informes financieros dejan de caducar por causas de gestión.

**Sin la firma de este ADR, E4 se implementa completa salvo T11, parte de T12 y media T15, y `journal_lines` se queda sin ningún `GRANT UPDATE`.** La parte E4-D2 (separación de hashes) es, en cambio, condición de entrada de T4: sin ella no hay reclasificación posible que respete P3.
