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
| `isSystem` | Cuentas que el motor necesita (129, 4700, 4750, 4751, 472x/477x definidas por la org, 57x, 430, 400, 410, 465, 476) — no desactivables; mapeadas en `OrganizationAccountMap` (p. ej. `IVA_SOPORTADO → "4720"`) para que el motor nunca hardcodee códigos |
| `cashflowCategory` | Solo para 57x y contrapartidas: `OPERATING | INVESTING | FINANCING` |

Creación de organización = `importNPGC(orgId, variant: "GENERAL" | "PYMES")` + `OrganizationAccountMap` con defaults. Idempotente.

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
| Liquidación IVA trimestral | 477 | 472 · 4750 (a pagar) / 4700 (a compensar) |
| Periodificación ingreso anticipado | 430 | 438/485 → devengo mensual 485 → 705 |
| Anulación | Contra-asiento exacto con `reversesEntryId`; nunca `delete` |
| Regularización cierre | 7xx → 129 ; 129 → 6xx | |
| Cierre / apertura | Asiento de cierre (todas las cuentas de balance) y apertura del ejercicio siguiente | |

Tipos IVA e IRPF en tabla `TaxRate` por organización (código, %, cuenta, vigencia), no hardcodeados.

## Comprobaciones al postear (determinista, `lib/ledger/post.ts`)
1. Σdebe = Σhaber (0 céntimos). 2. Todas las cuentas postables y activas en la org. 3. Fecha en ejercicio `OPEN`. 4. Cuentas 6/7 con destino analítico (o `NO_ANALITICO`). 5. Si origen es factura: base + Σ impuestos = total, y Σ líneas de detalle = base. 6. Numeración `entryNumber` secuencial por ejercicio sin huecos (transacción serializable).
