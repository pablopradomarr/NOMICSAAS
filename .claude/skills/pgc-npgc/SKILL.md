---
name: pgc-npgc
description: Plan General Contable español (PGC 2007) en el ERP - seed seeds/npgc.csv, plan de cuentas configurable por organización, mapeo cuenta → epígrafe de balance/PyG y tipo analítico, asientos tipo (facturas con IVA/IRPF, nóminas, cobros, amortización, cierre). Úsala al tocar cuentas contables, seeds, mapeos a estados financieros o generación de asientos.
---

# PGC en MICRO ERP SAAS

## Seed `seeds/npgc.csv` (906 filas, generado por `seeds/build_npgc.py`)
Columnas: `codigo,nombre,nivel,padre,grupo,naturaleza,estado_financiero,epigrafe,tipo_analitico`.
- Niveles 1–4 (grupo, subgrupo, cuenta, subcuenta oficial). Grupos 8/9 (ECPN) incluidos con cuentas principales.
- `estado_financiero`: `BALANCE_ACTIVO | BALANCE_PASIVO | BALANCE_PN | PYG | ECPN`; vacío en contenedores mixtos (1, 4, 5, 46–49, 55, 553, 559, 56, 58).
- `epigrafe`: modelo normal de cuentas anuales (numeración PyG vigente RD 602/2016: "15. Gastos financieros", "20. Impuestos sobre beneficios"). Ver comentarios de mapeo dudoso en la cabecera de `build_npgc.py`.
- 4720/4730/4760/4770/4771/4790 NO son cuentas oficiales (convención de software); el seed no las crea. Las organizaciones pueden crearlas como subcuentas.

## Plan de cuentas por organización (`Account`)
| Campo | Regla |
|---|---|
| `organizationId`, `code` | Único por organización. `code` texto, hasta 12 chars, solo dígitos; longitud ≥ 3 para cuentas movibles |
| `name` | Editable libremente (requisito: renombrar) |
| `parentCode` | Derivado por prefijo; se valida que exista |
| `nature`, `statement`, `epigraph`, `analyticType` | Copiados del seed al crear la organización; **editables** salvo `statement` de cuentas oficiales de nivel ≤ 3 (cambiarlo requiere rol admin y queda en log de auditoría) |
| `isPostable` | Solo hojas (sin hijos) reciben líneas de asiento |
| `isActive` | Desactivar en lugar de borrar; borrar solo si 0 líneas |
| `isSystem` | Cuentas que el motor necesita — no desactivables; mapeadas en `OrganizationAccountMap` (defaults que EXISTEN en el seed: `IVA_SOPORTADO → 472`, `IVA_REPERCUTIDO → 477`, `HP_ACREEDORA_IVA → 4750`, `HP_DEUDORA_IVA → 4700`, `IRPF_A_PAGAR → 4751`, `IRPF_RETENIDO_CLIENTES → 473`, `CLIENTES → 430`, `PROVEEDORES → 400`, `ACREEDORES → 410`, `BANCO_DEFAULT → 572`, `SS_ACREEDORA → 476`, `REMUNERACIONES_PENDIENTES → 465`, `RESULTADO_EJERCICIO → 129`; lista completa en `docs/MODELO-DATOS.md`). Si la org crea 4720/4770 puede remapear. El motor nunca hardcodea códigos |
| `cashflowCategory` | Solo para 57x y contrapartidas: `OPERATING | INVESTING | FINANCING` |

Creación de organización = `importNPGC(orgId, variant: "GENERAL" | "PYMES")` (`models/accounts.ts`, a crear en E2; CLI `seeds/import_npgc.ts`) + `OrganizationAccountMap` con defaults. Idempotente.

## Asientos tipo (referencia para `lib/ledger/templates/`) — importes en céntimos, contrapartida por `OrganizationAccountMap`

| Evento | Debe | Haber |
|---|---|---|
| Factura emitida servicios (IVA 21%, IRPF 15% profesional) | 430 cliente (total − IRPF) · 473 (IRPF retenido) | 705 base (proyecto) · 477 IVA repercutido |
| Factura recibida servicios (IVA 21%, sin retención) | 62x/607 base (proyecto o CECO) · 472 IVA soportado | 410/400 proveedor total |
| Factura recibida con retención al proveedor | 62x base · 472 IVA | 410 (total − IRPF) · 4751 IRPF a pagar |
| Cobro cliente | 572 banco | 430 |
| Pago proveedor | 400/410 | 572 |
| Nómina | 640 sueldo bruto (proyecto/CECO) · 642 SS empresa (mismo destino) | 465 neto · 476 SS acreedora (cuota obrera + empresa) · 4751 IRPF |
| Amortización mensual | 68x (CECO) | 28x |
| Liquidación IVA trimestral | 477 · 4700 (si soportado > repercutido) | 472 · 4750 (si repercutido > soportado) |
| Periodificación ingreso anticipado | 430 | 438/485 → devengo mensual 485 → 705 |
| Anulación | Contra-asiento exacto con `reversesEntryId`; nunca `delete` |
| Regularización cierre | 7xx → 129 ; 129 → 6xx | |
| Cierre / apertura | Asiento de cierre (todas las cuentas de balance) y apertura del ejercicio siguiente | |


### Bloque de cierre y fiscalidad periódica (E9, ADR-0016) — T-29…T-37

El catálogo pasa de 28 a **37 plantillas**. Todas parametrizadas por
`OrganizationAccountMap`, deterministas y con su motor puro en `lib/closing/`.

| Cód. | Plantilla | Debe | Haber |
|---|---|---|---|
| T-29 | `DUA_IMPORTACION` | 600/21x base del **DUA** · 472 IVA del DUA | 400 proveedor · 4751/572 (y 477 si hay diferimiento, O-16) |
| T-30 | `DIFERENCIAS_CAMBIO_CIERRE` | 668 (pérdida) o la posición en divisa | 768 (beneficio) o la posición. **Sólo partidas monetarias** a tasa de cierre (NRV 11ª.2.2) |
| T-31 | `AJUSTE_VALOR_ACTUAL` | 662 intereses devengados | 17x/52x pasivo, hasta que a vencimiento vale su **nominal** (O-1) |
| T-32 | `RECLASIFICACION_VENCIMIENTOS` | 17x largo (pasivo) o 54x corto (activo) | 52x corto (pasivo) o 25x largo (activo). Por los **22 pares**, medido **desde el cierre** |
| T-33 | `BAJA_INMOVILIZADO` | 28x amortización acumulada · 671 pérdida | 21x coste |
| T-34 | `VENTA_INMOVILIZADO` | 28x · 543/572 precio · 671 si pérdida | 21x coste · 771 si beneficio |
| T-35 | `DISTRIBUCION_RESULTADO` | 129 resultado | 112 reserva legal (hasta el 20 % del capital) · 113 · 120 · 526 dividendo · 557 a cuenta |
| T-36 | `DEVENGO_RECC` | 4728 IVA soportado pendiente → 472 | 4778 IVA repercutido pendiente → 477, al **cobro** (arts. 163 *terdecies* LIVA) |
| T-37 | `ALTA_PRESTAMO` | 572 efectivo recibido | 17x/52x según vencimiento, con su `DebtSchedule` declarado |

**Los doce asientos del cierre, en orden (O-17).** Recurrentes pendientes →
devengo RECC → prorrata definitiva → liquidación de IVA → valor actual (T-31) →
diferencias de cambio (T-30) → reclasificación de vencimientos (T-32) →
**impuesto sobre beneficios (T-25)** → regularización (T-26) → cierre (T-27) →
apertura del siguiente (T-28) → contra-asiento de T-32 como **nº 2 de N+1**.
El impuesto va después de **todo** movimiento de 6/7 (art. 10.3 LIS) y antes de
la regularización, que barre también la `6300`.

### IVA periódico: RECC, prorrata y el 303

- **Clave de periodo canónica `AAAA-Qn`** (o `AAAA-MM`), la del asiento derivada
  de `max(receptionDate, documentDate)` (ADR-0014 D8).
- **RECC** (arts. 163 *terdecies* y ss. LIVA): el devengo sigue al **cobro**; la
  factura se anota íntegra en el libro en su expedición y lo no cobrado vive en
  **4728/4778** hasta T-36. El barrido del 31/12 es I-E9-26.
- **Prorrata** (arts. 104-105 LIVA): el porcentaje **definitivo** se deriva del
  libro de emitidas con las exclusiones del art. 104.Tres marcadas **en el
  documento**; se redondea **por exceso** al entero superior; la regularización
  va contra **634** (ajuste negativo) o **639** (positivo). Con documentos sin
  clave de operación el resultado es `INFO` y **nunca** un porcentaje.
- **Bienes de inversión** (arts. 107-110): la regularización queda fuera de E9,
  pero `capitalGoodsGuard` es **determinista** y avisa; una casilla en blanco con
  una nota es honesta frente al usuario, no frente a la AEAT.
- **Modelo 303**: `lib/closing/model303.map.ts` es una **vista derivada** del
  libro registro y del diario, casilla a casilla, con drill-down al asiento. Los
  puentes que lo sostienen son I-E8-15a′/15c′ e I-E9-8a′.
- **Retenciones**: 111 (rendimientos del trabajo y profesionales), 115
  (arrendamientos) y 123 (capital mobiliario), con lo practicado abonado a 4751
  (I-E8-17).

Tipos IVA e IRPF en tabla `TaxRate` por organización (código, %, cuenta, vigencia), no hardcodeados.

## Comprobaciones al postear (determinista, `lib/ledger/post.ts`)
1. Σdebe = Σhaber (0 céntimos). 2. Todas las cuentas postables y activas en la org. 3. Fecha en ejercicio `OPEN`. 4. Cuentas 6/7 con destino analítico (o `NO_ANALITICO`). 5. Si origen es factura: base + Σ impuestos = total, y Σ líneas de detalle = base. 6. Numeración `entryNumber` secuencial por ejercicio sin huecos (transacción serializable).
