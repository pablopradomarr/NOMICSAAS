---
name: estados-financieros
description: Cómo se derivan del libro diario los informes del ERP - libro diario y mayor, balance de sumas y saldos, balance de situación, PyG contable, PyG analítica, cashflow (directo por 57x e indirecto), pestaña de auditoría y cuadres. Úsala al implementar o revisar cualquier informe, consulta SQL de agregación, drill-down o la pestaña Auditoría.
---

# Estados financieros derivados del diario

Regla: **ningún informe se almacena como cifras editables**. Se calcula con SQL/funciones puras sobre `journal_lines` y se cachea en `ReportRun` con `ledgerHash`. Todo informe tiene: periodo, comparativo (periodo anterior / presupuesto), sello de validación, fila de cuadre, drill-down hasta asiento y documento.

## Fuente: `journal_entries` / `journal_lines`
`journal_lines(id, organization_id, entry_id, account_code, debit_cents, credit_cents, project_id, cost_center_id, business_line_id (denormalizado desde proyecto), analytic_type, description, entry_date, fiscal_year_id, entry_kind)`. Convención: `debit_cents ≥ 0`, `credit_cents ≥ 0`, exactamente uno > 0. Saldo = Σdebit − Σcredit (positivo = deudor). **Anulación = contra-asiento**: no existe flag `voided` en líneas; nunca filtres por anulación. **PyG** = líneas 6/7 con `entry_kind NOT IN ('REGULARIZATION','CLOSING','OPENING')`.

## Informes

| Informe | Derivación | Cuadre visible |
|---|---|---|
| **Libro diario** | Asientos ordenados por `entry_date, entry_number`; líneas con cuenta, concepto, debe, haber, proyecto/CECO, documento | Σdebe = Σhaber del periodo |
| **Libro mayor** | Por cuenta: saldo inicial (Σ hasta fecha-1) + movimientos + saldo final | Σ saldos finales de mayor = balance de sumas y saldos |
| **Balance de sumas y saldos** | Por cuenta: sumas debe/haber, saldo deudor/acreedor | Σdeudor = Σacreedor |
| **Balance de situación** | Saldos de cuentas `statement ∈ BALANCE_*` agrupados por `epigraph`; resultado del ejercicio = PyG (I3) si no está regularizado, mostrado en PN "VII. Resultado del ejercicio". Signos: activo con saldo deudor positivo; pasivo/PN saldo acreedor positivo; cuentas correctoras (28x, 29x, 39x, 49x, 59x) restan en su epígrafe | Activo − (Pasivo + PN) = 0 (I2) |
| **PyG contable** | Cuentas grupo 6/7 por `epigraph` del modelo normal; ingresos positivos, gastos negativos; subtotales oficiales (A.1 resultado de explotación, A.2 financiero, A.3 antes de impuestos, A.4 del ejercicio) | Resultado = I3 (definición única en skill `fiabilidad`) |
| **PyG analítica** | Matriz `nivel de margen × (proyecto ∣ línea de negocio ∣ CECO)`; usa `analytic_type` + `MarginLevelConfig` + `AllocationLine` del `AllocationRun` vigente del periodo. Columnas: Ingresos, MC1, %MC1, MC2, %MC2, MC3, %MC3; agregado por LN; columna "CECOs no imputados"; total | I4 e I5 (definición única en skill `fiabilidad`) |
| **Cashflow directo** | En cada asiento con al menos una línea 57x, **cada línea no-57x aporta `−(debe − haber)`** a su `cashflowBucket` (R-CF-3: por LÍNEA y exacta, nada de reparto proporcional). Siete buckets sembrados en `seeds/npgc.csv`: cobros de clientes, pagos a proveedores, personal, impuestos, otros de explotación, inversión, financiación; por mes | Saldo inicial 57x + flujos = saldo final 57x (I6) |
| **Cashflow indirecto** | Resultado + amortizaciones ± Δ circulante (430/400/47x…) ± inversión ± financiación | = variación de 57x del periodo |
| **Previsión de tesorería** (v2) | Vencimientos de 430/400 + recurrentes + presupuesto; etiquetado `interpretación IA` si hay estimación de modelo | — |
| **Presupuesto vs real** | `Budget` mensual por proyecto/CECO/cuenta vs real del diario | — |

### Reglas del cashflow que un motor ingenuo se salta

- **R-CF-1** Tesorería = prefijo `57`. El saldo inicial se lee del asiento `OPENING`, **no** de un campo de configuración: un saldo inicial configurable puede diverger del diario.
- **R-CF-2** Universo: `kind ∉ {OPENING, CLOSING, REGULARIZATION}`. Ninguno de los tres mueve un euro.
- **R-CF-4** Un asiento cuyas **únicas** líneas son 57x (traspaso banco↔caja) se excluye y se lista aparte. La exclusión es **porque las dos cuentas son 57x**, no porque el neto sea 0: la regla se aplica antes de mirar el importe.
- **R-CF-7** — **el IVA devengado en el mismo asiento que un cobro o un pago sigue al bloque comercial, no a impuestos.** En un asiento que mezcla tesorería, **un solo** bloque comercial (`43x`/`40x`/`41x`/`438`/`407`) y las cuentas de IVA de esa misma operación (`472`/`477`), las líneas de IVA se asignan al bucket del bloque comercial. Con **varios** bloques comerciales el IVA se queda en `PAGOS_IMPUESTOS` y la Auditoría lo lista como WARN.

  *Por qué:* el EFE mide cobros y pagos **brutos**. Un anticipo de cliente (`572` 242 000 / `438` 200 000 + `477` 42 000) sin R-CF-7 mostraría un cobro de clientes de 200 000 y un **cobro de Hacienda de 42 000**, que es falso: Hacienda no ha pagado nada. Cuando la factura y el cobro son asientos distintos —el caso normal— la cuestión no se plantea, porque en el asiento de cobro la única contrapartida es `430` por el importe bruto. El flujo con Hacienda aparece en su momento, en la liquidación trimestral.
- **R-CF-8** El impuesto sobre beneficios **no es un bucket**: la línea 8.d del EFE se deriva dentro de `PAGOS_IMPUESTOS` por las claves `HP_ACREEDORA_IS`/`HP_DEUDORA_IS` del mapa de la organización, nunca por códigos escritos a mano.
- **R-CF-5** El indirecto es una **partición mecánica y exhaustiva**: toda cuenta no-57x cae en exactamente un bloque, así que `Σ bloques = Δ57x` **por álgebra**, con tolerancia 0 y **sin partida de cuadre**.
- **R-CF-6** Los asientos sin ninguna línea 57x que tocan inversión o financiación son «operaciones que no han supuesto flujos de efectivo»: se listan aparte y explican por qué el indirecto reparte importes que el directo nunca ve.

El cashflow es **informe de gestión**, no cuenta anual: el EFE no es exigible en PYMES ni en el modelo abreviado (art. 257.3 LSC y RD 1515/2007), y la cabecera lo dice.

## Pestaña **Auditoría** (`/auditoria`)
Lista de checks I1–I10 + checks de calidad de datos, ejecutados on-demand y en cada cierre, con `PASS/FAIL/WARN`, evidencia (query + primeras 50 filas) y enlace al asiento:

| Check | Tipo |
|---|---|
| I1–I10 (skill `fiabilidad`) | Invariante |
| Asientos con propuesta IA no confirmada por humano > N días | WARN |
| Documentos en `unsorted` sin asiento > N días | WARN |
| Facturas con Σitems ≠ total en la propuesta (rechazadas por `reconcile`) | Lista |
| Cuentas 6/7 con líneas a CECO `SIN_ASIGNAR` | WARN |
| Saldos 430/400 con antigüedad > vencimiento | Info (aging) |
| Diferencias conciliación bancaria (57x vs extracto importado) | FAIL si > 0 |
| Cambios en plan de cuentas / reglas de imputación / mapeos del sistema (log `AuditLog`) | Traza |
| Runs de informes con sello `REQUIERE REVISIÓN` pendientes | Lista |

`AuditLog(organizationId, userId, entity, entityId, action, before, after, ts)` en toda mutación de configuración y de asientos (post/void).

## SQL de referencia (Postgres)
```sql
-- saldos por cuenta en periodo
SELECT account_code, SUM(debit_cents) d, SUM(credit_cents) c, SUM(debit_cents - credit_cents) saldo
FROM journal_lines WHERE organization_id = $1 AND entry_date BETWEEN $2 AND $3
GROUP BY account_code;
-- cuadre balance (I2)
SELECT SUM(CASE WHEN a.statement='BALANCE_ACTIVO' THEN l.debit_cents-l.credit_cents ELSE 0 END)
     - SUM(CASE WHEN a.statement IN ('BALANCE_PASIVO','BALANCE_PN') THEN l.credit_cents-l.debit_cents ELSE 0 END)
     - SUM(CASE WHEN a.statement='PYG' THEN l.credit_cents-l.debit_cents ELSE 0 END) AS diff  -- debe ser 0
FROM journal_lines l JOIN accounts a ON a.organization_id=l.organization_id AND a.code=l.account_code
WHERE l.organization_id=$1 AND l.entry_date<=$2 AND l.entry_kind NOT IN ('CLOSING');
```
Tolerancia 0. Usar `BIGINT` para sumas.
