#!/usr/bin/env python3
"""
E3 · Generador de los fixtures inmutables del libro diario.

    python3 docs/design/fixtures/build_ejercicio_completo.py [--check]

Genera `tests/fixtures/ejercicio-completo.json` y `tests/fixtures/ejercicio-minimo.json`
segun el esquema definido en `docs/design/E3-asientos-tipo.md` §4, y CALCULA los
totales esperados (bloque `expected`) recorriendo el diario que el propio script
construye. Con `--check` no escribe: reconstruye, compara con el fichero en disco
y falla si difiere en un solo centimo (los fixtures son inmutables).

Reglas respetadas (todas en enteros; ni un solo float en el camino del dinero):
  · R-IVA-2  cuota = redondeo half-up sobre la MAGNITUD de base_cents * bps / 10000
  · R-IVA-1  una cuota por tipo impositivo (PER_TIPO), no por linea
  · R-IVA-6  la retencion de IRPF se calcula sobre la base total del documento
  · I1       Sigma debe = Sigma haber en cada asiento (tolerancia 0)
  · I7       entryNumber correlativo por ejercicio, sin huecos, en orden de fecha
  · I8       toda fecha dentro de su ejercicio
  · Convencion de linea: debitCents >= 0, creditCents >= 0, exactamente uno > 0

Las cifras son ILUSTRATIVAS: ninguna procede de datos reales.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
OUT_FULL = ROOT / "tests" / "fixtures" / "ejercicio-completo.json"
OUT_MIN = ROOT / "tests" / "fixtures" / "ejercicio-minimo.json"

# ---------------------------------------------------------------------------
# Aritmetica fiscal (espejo exacto de lib/taxes/bps.ts::applyBps)
# ---------------------------------------------------------------------------


def apply_bps(base_cents: int, bps: int) -> int:
    """Cuota half-up sobre la magnitud (simetrica en negativos: R-IVA-2)."""
    assert isinstance(base_cents, int) and isinstance(bps, int)
    assert 0 <= bps <= 10000
    sign = -1 if base_cents < 0 else 1
    magnitude = abs(base_cents) * bps
    quotient, remainder = divmod(magnitude, 10000)
    if remainder * 2 >= 10000:
        quotient += 1
    return sign * quotient


# ---------------------------------------------------------------------------
# Mapa de cuentas de sistema. El fixture se declara con `accountKey` siempre que
# exista clave; esta tabla (useSubaccounts=false, createSoftwareAccounts=false)
# es la de lib/accounts/map.ts::ACCOUNT_KEY_DEFAULT_CODE y solo se usa para
# resolver los codigos al calcular los totales esperados.
# ---------------------------------------------------------------------------

KEY_TO_CODE: dict[str, str] = {
    "CLIENTES": "430",
    "PROVEEDORES": "400",
    "ACREEDORES": "410",
    "BANCO_DEFAULT": "572",
    "CAJA": "570",
    "IVA_SOPORTADO": "472",
    "IVA_REPERCUTIDO": "477",
    "IRPF_RETENIDO_CLIENTES": "473",
    "IRPF_A_PAGAR": "4751",
    "HP_ACREEDORA_IVA": "4750",
    "HP_DEUDORA_IVA": "4700",
    "SS_ACREEDORA": "476",
    "REMUNERACIONES_PENDIENTES": "465",
    "RESULTADO_EJERCICIO": "129",
    "VENTAS_DEFAULT": "705",
    "COMPRAS_DEFAULT": "600",
    "SUBCONTRATACION_DEFAULT": "607",
    "ANTICIPOS_PROVEEDORES": "407",
    "ANTICIPOS_CLIENTES": "438",
    "DESCUENTO_PP_VENTAS": "706",
    "DESCUENTO_PP_COMPRAS": "606",
    "DEVOLUCION_VENTAS": "708",
    "DEVOLUCION_COMPRAS": "608",
    "RAPPEL_VENTAS": "709",
    "RAPPEL_COMPRAS": "609",
    "REDONDEO_GASTO": "669",
    "REDONDEO_INGRESO": "769",
    "IRPF_PROFESIONALES_A_PAGAR": "4751",
    "IRPF_ALQUILERES_A_PAGAR": "4751",
    "IRPF_TRABAJO_A_PAGAR": "4751",
    "IVA_SOPORTADO_ISP": "472",
    "IVA_REPERCUTIDO_ISP": "477",
    "AJUSTE_IVA_NEGATIVO": "634",
    "AJUSTE_IVA_POSITIVO": "639",
    "IMPUESTO_BENEFICIOS_GASTO": "630",
    "HP_ACREEDORA_IS": "4752",
    "HP_DEUDORA_IS": "4709",
    "ACTIVO_IMPUESTO_DIFERIDO": "4740",
    "PASIVO_IMPUESTO_DIFERIDO": "479",
    "PERIODIFICACION_GASTO": "480",
    "PERIODIFICACION_INGRESO": "485",
    "DIFERENCIA_CAMBIO_NEGATIVA": "668",
    "DIFERENCIA_CAMBIO_POSITIVA": "768",
    "RETENCIONES_CAPITAL_SOPORTADAS": "473",
    "SS_DEUDORA": "471",
    "ANTICIPOS_REMUNERACIONES": "460",
    "SUELDOS_DEFAULT": "640",
    "SS_EMPRESA_DEFAULT": "642",
    "CLIENTES_DUDOSO_COBRO": "436",
    "DETERIORO_CLIENTES": "490",
    "DOTACION_DETERIORO_CREDITOS": "694",
    "REVERSION_DETERIORO_CREDITOS": "794",
    "PERDIDA_CREDITOS_INCOBRABLES": "650",
    "CUENTA_PUENTE_TESORERIA": "555",
    "COMISIONES_BANCARIAS": "626",
    "REMANENTE": "120",
    "RESULTADOS_NEGATIVOS_ANTERIORES": "121",
}

# Cuentas usadas por codigo (no tienen AccountKey). Se declaran en `accountsExtra`
# solo si NO estan en el seed npgc.csv; todas estas SI estan (verificado).
BY_CODE_USED = {
    "100": "Capital social",
    "113": "Reservas voluntarias",
    "216": "Mobiliario",
    "217": "Equipos para procesos de informacion",
    "2816": "Amortizacion acumulada de mobiliario",
    "2817": "Amortizacion acumulada de equipos para procesos de informacion",
    "621": "Arrendamientos y canones",
    "623": "Servicios de profesionales independientes",
    "628": "Suministros",
    "629": "Otros servicios",
    "678": "Gastos excepcionales",
    "681": "Amortizacion del inmovilizado material",
}

IVA21, IVA10, RE52, IRPF15, IRPF19, PRORRATA, IS_BPS = 2100, 1000, 520, 1500, 1900, 9000, 2500

# ---------------------------------------------------------------------------
# Dimensiones analiticas
# ---------------------------------------------------------------------------

BUSINESS_LINES = [
    {"code": "BL-CONS", "name": "Consultoria", "sortOrder": 1},
    {"code": "BL-DEV", "name": "Desarrollo de producto", "sortOrder": 2},
]

PROJECTS = [
    {"code": "P-01", "name": "Implantacion ERP Cliente Alfa", "businessLineCode": "BL-CONS", "status": "ACTIVE"},
    {"code": "P-02", "name": "Oficina de proyectos Cliente Beta", "businessLineCode": "BL-CONS", "status": "ACTIVE"},
    {"code": "P-03", "name": "Plataforma SaaS Gamma", "businessLineCode": "BL-DEV", "status": "ACTIVE"},
]

COST_CENTERS = [
    {"code": "CC-GA", "name": "General y administracion", "kind": "G_A", "marginLevel": "EBITDA", "allocatable": True},
    {"code": "CC-MKT", "name": "Marketing y ventas", "kind": "MARKETING_VENTAS", "marginLevel": "EBITDA", "allocatable": True},
    {"code": "CC-OPS", "name": "Operaciones indirectas", "kind": "OPERACIONES_INDIRECTAS", "marginLevel": "MC3", "allocatable": True},
    {"code": "CC-DEV", "name": "Desarrollo de producto", "kind": "DESARROLLO_PRODUCTO", "marginLevel": "MC3", "allocatable": True},
    {"code": "CC-FIN", "name": "Financiero", "kind": "FINANCIERO", "marginLevel": "EBITDA", "allocatable": False},
    {"code": "CC-NA", "name": "Sin asignar", "kind": "SIN_ASIGNAR", "marginLevel": "EBITDA", "allocatable": False},
]

# ---------------------------------------------------------------------------
# Constructores
# ---------------------------------------------------------------------------

Line = dict[str, Any]
Entry = dict[str, Any]


def L(acc: str, debit: int = 0, credit: int = 0, project: str | None = None, cc: str | None = None,
      tax: str | None = None, desc: str | None = None) -> Line:
    """Una linea. `acc` es AccountKey si esta en KEY_TO_CODE, si no un codigo."""
    assert debit >= 0 and credit >= 0, "importes negativos prohibidos"
    assert (debit == 0) != (credit == 0), f"exactamente un importe > 0 ({acc}: {debit}/{credit})"
    line: Line = {}
    if acc in KEY_TO_CODE:
        line["accountKey"] = acc
    else:
        assert acc in BY_CODE_USED, f"codigo {acc} no declarado"
        line["accountCode"] = acc
    line["debitCents"] = debit
    line["creditCents"] = credit
    if project:
        line["projectCode"] = project
    if cc:
        line["costCenterCode"] = cc
    if tax:
        line["taxRateCode"] = tax
    if desc:
        line["description"] = desc
    return line


ENTRIES: list[Entry] = []


def E(d: str, kind: str, description: str, lines: list[Line], template: str | None = None,
      source: str = "MANUAL", reverses: str | None = None, ref: str | None = None,
      fy: str = "2026") -> Entry:
    deb = sum(x["debitCents"] for x in lines)
    cre = sum(x["creditCents"] for x in lines)
    assert deb == cre, f"I1 roto en {description}: {deb} != {cre}"
    assert len(lines) >= 2, f"asiento de una sola linea prohibido: {description}"
    e: Entry = {"ref": ref or description[:24], "date": d, "kind": kind, "fiscalYearCode": fy,
                "description": description, "sourceType": source}
    if template:
        e["template"] = template
    if reverses:
        e["reversesRef"] = reverses
    e["lines"] = lines
    ENTRIES.append(e)
    return e


def code_of(line: Line) -> str:
    return KEY_TO_CODE[line["accountKey"]] if "accountKey" in line else line["accountCode"]


def q(d: str) -> int:
    return (int(d[5:7]) - 1) // 3 + 1


# ---------------------------------------------------------------------------
# 1. Apertura del ejercicio 2026 (T-27)
# ---------------------------------------------------------------------------

E("2026-01-01", "OPENING", "Apertura del ejercicio 2026", template="APERTURA_EJERCICIO", source="SYSTEM", ref="AP-2026", lines=[
    L("216", debit=1_200_000),
    L("217", debit=600_000),
    L("CLIENTES", debit=3_000_000),
    L("BANCO_DEFAULT", debit=4_000_000),
    L("2816", credit=180_000),
    L("2817", credit=60_000),
    L("PROVEEDORES", credit=1_500_000),
    L("100", credit=3_000_000),
    L("113", credit=500_000),
    L("REMANENTE", credit=3_560_000),
])

# ---------------------------------------------------------------------------
# 2. Facturas emitidas (T-01) — una por mes, dia 20
# ---------------------------------------------------------------------------

# F-01 enero: dos tipos de IVA en el mismo documento (21 % y 10 %)
b21, b10 = 500_000, 120_000
c21, c10 = apply_bps(b21, IVA21), apply_bps(b10, IVA10)
E("2026-01-20", "NORMAL", "Factura emitida 2026/001 - Alfa (IVA 21 % + 10 %)", template="FACTURA_EMITIDA_SERVICIOS",
  source="INVOICE_OUT", ref="F-001", lines=[
      L("CLIENTES", debit=b21 + b10 + c21 + c10),
      L("VENTAS_DEFAULT", credit=b21, project="P-01"),
      L("VENTAS_DEFAULT", credit=b10, project="P-01"),
      L("IVA_REPERCUTIDO", credit=c21, tax="IVA_21"),
      L("IVA_REPERCUTIDO", credit=c10, tax="IVA_10"),
  ])

# F-02 febrero: retencion de IRPF profesional practicada por el cliente
base = 800_000
cuota = apply_bps(base, IVA21)
ret = apply_bps(base, IRPF15)
E("2026-02-20", "NORMAL", "Factura emitida 2026/002 - Beta (IRPF 15 % retenido)", template="FACTURA_EMITIDA_SERVICIOS",
  source="INVOICE_OUT", ref="F-002", lines=[
      L("CLIENTES", debit=base + cuota - ret),
      L("IRPF_RETENIDO_CLIENTES", debit=ret, tax="IRPF_PROF_15"),
      L("VENTAS_DEFAULT", credit=base, project="P-02"),
      L("IVA_REPERCUTIDO", credit=cuota, tax="IVA_21"),
  ])

# Anticipo de cliente cobrado en febrero (T-09), con IVA devengado
ant_base, ant_iva = 200_000, apply_bps(200_000, IVA21)
E("2026-02-05", "NORMAL", "Anticipo de cliente Gamma s/ proyecto P-03", template="ANTICIPO_CLIENTE",
  source="MANUAL", ref="ANT-C-01", lines=[
      L("BANCO_DEFAULT", debit=ant_base + ant_iva),
      L("ANTICIPOS_CLIENTES", credit=ant_base),
      L("IVA_REPERCUTIDO", credit=ant_iva, tax="IVA_21"),
  ])

# F-03 marzo: aplicacion del anticipo 438
base = 600_000
cuota = apply_bps(base, IVA21)
E("2026-03-20", "NORMAL", "Factura emitida 2026/003 - Gamma (anticipo aplicado)", template="FACTURA_EMITIDA_SERVICIOS",
  source="INVOICE_OUT", ref="F-003", lines=[
      L("ANTICIPOS_CLIENTES", debit=ant_base),
      L("IVA_REPERCUTIDO", debit=ant_iva, tax="IVA_21"),
      L("CLIENTES", debit=base + cuota - ant_base - ant_iva),
      L("VENTAS_DEFAULT", credit=base, project="P-03"),
      L("IVA_REPERCUTIDO", credit=cuota, tax="IVA_21"),
  ])

# F-04 abril: recargo de equivalencia 5,2 %
base = 300_000
cuota, req = apply_bps(base, IVA21), apply_bps(base, RE52)
E("2026-04-20", "NORMAL", "Factura emitida 2026/004 - minorista (recargo 5,2 %)", template="FACTURA_EMITIDA_SERVICIOS",
  source="INVOICE_OUT", ref="F-004", lines=[
      L("CLIENTES", debit=base + cuota + req),
      L("VENTAS_DEFAULT", credit=base, project="P-01"),
      L("IVA_REPERCUTIDO", credit=cuota, tax="IVA_21"),
      L("IVA_REPERCUTIDO", credit=req, tax="REQ_5_2"),
  ])

SIMPLE_SALES = [
    ("2026-05-20", 400_000, "P-01", "005"), ("2026-06-20", 450_000, "P-02", "006"),
    ("2026-07-20", 500_000, "P-03", "007"), ("2026-08-20", 350_000, "P-01", "008"),
    ("2026-09-20", 600_000, "P-02", "009"), ("2026-10-20", 550_000, "P-03", "010"),
    ("2026-11-20", 480_000, "P-01", "011"), ("2026-12-20", 700_000, "P-02", "012"),
]
for d, base, proj, num in SIMPLE_SALES:
    cuota = apply_bps(base, IVA21)
    E(d, "NORMAL", f"Factura emitida 2026/{num}", template="FACTURA_EMITIDA_SERVICIOS", source="INVOICE_OUT",
      ref=f"F-{num}", lines=[
          L("CLIENTES", debit=base + cuota),
          L("VENTAS_DEFAULT", credit=base, project=proj),
          L("IVA_REPERCUTIDO", credit=cuota, tax="IVA_21"),
      ])

# Abono emitido / rectificativa de F-001 (T-05): signos espejo
ab_base = 100_000
ab_cuota = apply_bps(ab_base, IVA21)
E("2026-05-10", "NORMAL", "Abono 2026/R-001 rectificativa de la factura 2026/001", template="ABONO_EMITIDO",
  source="INVOICE_OUT", ref="AB-001", lines=[
      L("DEVOLUCION_VENTAS", debit=ab_base, project="P-01"),
      L("IVA_REPERCUTIDO", debit=ab_cuota, tax="IVA_21"),
      L("CLIENTES", credit=ab_base + ab_cuota),
  ])

# ---------------------------------------------------------------------------
# 3. Facturas recibidas (T-03 / T-04)
# ---------------------------------------------------------------------------

# R-01 subcontratacion, IVA integramente deducible
base = 200_000
cuota = apply_bps(base, IVA21)
E("2026-01-15", "NORMAL", "Factura recibida - subcontrata Delta (P-01)", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-001", lines=[
      L("SUBCONTRATACION_DEFAULT", debit=base, project="P-01"),
      L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
      L("PROVEEDORES", credit=base + cuota),
  ])

# R-02 alquiler con retencion 19 % (modelo 115)
base = 120_000
cuota, ret = apply_bps(base, IVA21), apply_bps(base, IRPF19)
E("2026-01-31", "NORMAL", "Factura recibida - alquiler oficina (IRPF 19 %)", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-002", lines=[
      L("621", debit=base, cc="CC-GA"),
      L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
      L("ACREEDORES", credit=base + cuota - ret),
      L("IRPF_ALQUILERES_A_PAGAR", credit=ret, tax="IRPF_ALQ_19"),
  ])

# R-03 profesional con retencion 15 %, coste directo de proyecto (override MC2)
base = 150_000
cuota, ret = apply_bps(base, IVA21), apply_bps(base, IRPF15)
E("2026-02-12", "NORMAL", "Factura recibida - profesional independiente (P-02)", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-003", lines=[
      L("623", debit=base, project="P-02"),
      L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
      L("ACREEDORES", credit=base + cuota - ret),
      L("IRPF_PROFESIONALES_A_PAGAR", credit=ret, tax="IRPF_PROF_15"),
  ])

# R-04 suministros con prorrata 90 %: la parte no deducible engorda el gasto
base = 80_000
cuota = apply_bps(base, IVA21)
ded = apply_bps(cuota, PRORRATA)
E("2026-03-10", "NORMAL", "Factura recibida - suministros (prorrata 90 %)", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-004", lines=[
      L("628", debit=base + (cuota - ded), cc="CC-GA"),
      L("IVA_SOPORTADO", debit=ded, tax="IVA_21"),
      L("ACREEDORES", credit=base + cuota),
  ])

# R-05 IVA integramente no deducible (atenciones a clientes)
base = 50_000
cuota = apply_bps(base, IVA21)
E("2026-04-08", "NORMAL", "Factura recibida - atenciones a clientes (IVA no deducible)", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-005", lines=[
      L("629", debit=base + cuota, cc="CC-MKT"),
      L("ACREEDORES", credit=base + cuota),
  ])

# R-06 inversion del sujeto pasivo: doble apunte, efecto neto 0
base = 100_000
cuota = apply_bps(base, IVA21)
E("2026-05-14", "NORMAL", "Factura recibida UE - inversion del sujeto pasivo", template="FACTURA_RECIBIDA_ISP",
  source="DOCUMENT", ref="R-006", lines=[
      L("623", debit=base, cc="CC-DEV"),
      L("IVA_SOPORTADO_ISP", debit=cuota, tax="IVA_ISP"),
      L("ACREEDORES", credit=base),
      L("IVA_REPERCUTIDO_ISP", credit=cuota, tax="IVA_ISP"),
  ])

for d, base, proj, ref in [("2026-07-09", 250_000, "P-03", "R-007"), ("2026-09-09", 180_000, "P-02", "R-008")]:
    cuota = apply_bps(base, IVA21)
    E(d, "NORMAL", f"Factura recibida - subcontrata ({proj})", template="FACTURA_RECIBIDA", source="DOCUMENT",
      ref=ref, lines=[
          L("SUBCONTRATACION_DEFAULT", debit=base, project=proj),
          L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
          L("PROVEEDORES", credit=base + cuota),
      ])

# R-009 inversion en equipos (genera IVA a compensar en Q3)
base = 1_500_000
cuota = apply_bps(base, IVA21)
E("2026-08-14", "NORMAL", "Factura recibida - equipos para procesos de informacion", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-009", lines=[
      L("217", debit=base),
      L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
      L("ACREEDORES", credit=base + cuota),
  ])

# R-010 suministros con prorrata, CECO de operaciones
base = 90_000
cuota = apply_bps(base, IVA21)
ded = apply_bps(cuota, PRORRATA)
E("2026-11-06", "NORMAL", "Factura recibida - suministros (prorrata 90 %)", template="FACTURA_RECIBIDA",
  source="DOCUMENT", ref="R-010", lines=[
      L("628", debit=base + (cuota - ded), cc="CC-OPS"),
      L("IVA_SOPORTADO", debit=ded, tax="IVA_21"),
      L("ACREEDORES", credit=base + cuota),
  ])

# Abono recibido (T-06)
ab_base = 50_000
ab_cuota = apply_bps(ab_base, IVA21)
E("2026-06-05", "NORMAL", "Abono recibido - rectificativa de subcontrata Delta", template="ABONO_RECIBIDO",
  source="DOCUMENT", ref="AB-R-001", lines=[
      L("PROVEEDORES", debit=ab_base + ab_cuota),
      L("DEVOLUCION_COMPRAS", credit=ab_base, project="P-01"),
      L("IVA_SOPORTADO", credit=ab_cuota, tax="IVA_21"),
  ])

# Anticipo a proveedor (T-10)
base = 100_000
cuota = apply_bps(base, IVA21)
E("2026-04-03", "NORMAL", "Anticipo a proveedor Delta", template="ANTICIPO_PROVEEDOR", source="MANUAL",
  ref="ANT-P-01", lines=[
      L("ANTICIPOS_PROVEEDORES", debit=base),
      L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
      L("BANCO_DEFAULT", credit=base + cuota),
  ])

# ---------------------------------------------------------------------------
# 4. Cobros y pagos (T-07 / T-08)
# ---------------------------------------------------------------------------

E("2026-02-28", "NORMAL", "Cobro total factura 2026/001", template="COBRO_CLIENTE", source="BANK_IMPORT", ref="CO-001", lines=[
    L("BANCO_DEFAULT", debit=737_000), L("CLIENTES", credit=737_000)])

E("2026-03-31", "NORMAL", "Cobro parcial factura 2026/002", template="COBRO_CLIENTE", source="BANK_IMPORT", ref="CO-002", lines=[
    L("BANCO_DEFAULT", debit=400_000), L("CLIENTES", credit=400_000)])

E("2026-04-30", "NORMAL", "Cobro con comision bancaria", template="COBRO_CLIENTE", source="BANK_IMPORT", ref="CO-003", lines=[
    L("BANCO_DEFAULT", debit=299_500),
    L("COMISIONES_BANCARIAS", debit=500, cc="CC-GA"),
    L("CLIENTES", credit=300_000)])

E("2026-05-29", "NORMAL", "Cobro en divisa con diferencia negativa de cambio", template="COBRO_CLIENTE",
  source="BANK_IMPORT", ref="CO-004", lines=[
      L("BANCO_DEFAULT", debit=495_000),
      L("DIFERENCIA_CAMBIO_NEGATIVA", debit=5_000, cc="CC-FIN"),
      L("CLIENTES", credit=500_000)])

E("2026-06-30", "NORMAL", "Cobro en divisa con diferencia positiva de cambio", template="COBRO_CLIENTE",
  source="BANK_IMPORT", ref="CO-005", lines=[
      L("BANCO_DEFAULT", debit=306_000),
      L("CLIENTES", credit=300_000),
      L("DIFERENCIA_CAMBIO_POSITIVA", credit=6_000, cc="CC-FIN")])

E("2026-07-31", "NORMAL", "Cobro con diferencia de redondeo de 1 centimo", template="COBRO_CLIENTE",
  source="BANK_IMPORT", ref="CO-006", lines=[
      L("BANCO_DEFAULT", debit=120_999),
      L("REDONDEO_GASTO", debit=1, cc="CC-FIN"),
      L("CLIENTES", credit=121_000)])

E("2026-02-25", "NORMAL", "Pago total proveedor Delta", template="PAGO_PROVEEDOR", source="BANK_IMPORT", ref="PA-001", lines=[
    L("PROVEEDORES", debit=242_000), L("BANCO_DEFAULT", credit=242_000)])

E("2026-06-25", "NORMAL", "Pago parcial acreedor", template="PAGO_PROVEEDOR", source="BANK_IMPORT", ref="PA-002", lines=[
    L("ACREEDORES", debit=100_000), L("BANCO_DEFAULT", credit=100_000)])

E("2026-08-25", "NORMAL", "Pago con diferencia de redondeo de 1 centimo", template="PAGO_PROVEEDOR",
  source="BANK_IMPORT", ref="PA-003", lines=[
      L("ACREEDORES", debit=60_500),
      L("BANCO_DEFAULT", credit=60_499),
      L("REDONDEO_INGRESO", credit=1, cc="CC-FIN")])

# ---------------------------------------------------------------------------
# 5. Nominas (T-11), pagos de nomina (T-12), SS (T-13) y retenciones (T-14)
# ---------------------------------------------------------------------------

E("2026-03-05", "NORMAL", "Anticipo de remuneraciones a empleado", template="ASIENTO_MANUAL", source="MANUAL",
  ref="ANT-N-01", lines=[
      L("ANTICIPOS_REMUNERACIONES", debit=50_000), L("BANCO_DEFAULT", credit=50_000)])

BRUTO = [(300_000, "P-01", None), (125_000, "P-02", None), (75_000, None, "CC-GA")]
SS_EMP = [(96_000, "P-01", None), (40_000, "P-02", None), (24_000, None, "CC-GA")]
SS_TRAB, IRPF_NOM = 31_750, 75_000
TOTAL_BRUTO = sum(x[0] for x in BRUTO)
TOTAL_SS_EMP = sum(x[0] for x in SS_EMP)

for i, d in enumerate(["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"]):
    anticipo = 50_000 if d == "2026-04-30" else 0
    neto = TOTAL_BRUTO - SS_TRAB - IRPF_NOM - anticipo
    lines = [L("SUELDOS_DEFAULT", debit=a, project=p, cc=c) for a, p, c in BRUTO]
    lines += [L("SS_EMPRESA_DEFAULT", debit=a, project=p, cc=c) for a, p, c in SS_EMP]
    lines.append(L("REMUNERACIONES_PENDIENTES", credit=neto))
    if anticipo:
        lines.append(L("ANTICIPOS_REMUNERACIONES", credit=anticipo))
    lines.append(L("SS_ACREEDORA", credit=SS_TRAB + TOTAL_SS_EMP))
    lines.append(L("IRPF_TRABAJO_A_PAGAR", credit=IRPF_NOM, tax="IRPF_TRABAJO_VAR"))
    E(d, "NORMAL", f"Nomina mes {d[5:7]}", template="NOMINA", source="MANUAL", ref=f"NOM-{d[5:7]}", lines=lines)

    pago_d = {"2026-01-31": "2026-02-03", "2026-04-30": "2026-05-04", "2026-07-31": "2026-08-03",
              "2026-10-31": "2026-11-03"}[d]
    E(pago_d, "NORMAL", f"Pago de nomina mes {d[5:7]}", template="PAGO_NOMINA", source="BANK_IMPORT",
      ref=f"PNOM-{d[5:7]}", lines=[
          L("REMUNERACIONES_PENDIENTES", debit=neto), L("BANCO_DEFAULT", credit=neto)])

    ss_d = {"2026-01-31": "2026-02-28", "2026-04-30": "2026-05-29", "2026-07-31": "2026-08-31",
            "2026-10-31": "2026-11-30"}[d]
    E(ss_d, "NORMAL", f"Pago de Seguridad Social mes {d[5:7]}", template="PAGO_SEGURIDAD_SOCIAL",
      source="BANK_IMPORT", ref=f"PSS-{d[5:7]}", lines=[
          L("SS_ACREEDORA", debit=SS_TRAB + TOTAL_SS_EMP), L("BANCO_DEFAULT", credit=SS_TRAB + TOTAL_SS_EMP)])

# ---------------------------------------------------------------------------
# 6. Amortizacion mensual (T-15)
# ---------------------------------------------------------------------------

MESES = [f"2026-{m:02d}-{d}" for m, d in [(1, 31), (2, 28), (3, 31), (4, 30), (5, 31), (6, 30),
                                          (7, 31), (8, 31), (9, 30), (10, 31), (11, 30), (12, 31)]]
for idx, d in enumerate(MESES):
    mob, equipos = 10_000, 12_500
    if idx >= 8:  # equipos adquiridos en agosto: amortizan desde septiembre
        equipos += 31_250
    E(d, "NORMAL", f"Amortizacion del inmovilizado material - mes {d[5:7]}", template="AMORTIZACION_MENSUAL",
      source="SYSTEM", ref=f"AM-{d[5:7]}", lines=[
          L("681", debit=mob, cc="CC-GA"),
          L("681", debit=equipos, cc="CC-OPS"),
          L("2816", credit=mob),
          L("2817", credit=equipos)])

# ---------------------------------------------------------------------------
# 7. Periodificaciones (T-16 a T-19)
# ---------------------------------------------------------------------------

E("2026-06-30", "NORMAL", "Periodificacion de gasto anticipado (seguro)", template="PERIODIFICACION_GASTO",
  source="MANUAL", ref="PER-G-01", lines=[
      L("PERIODIFICACION_GASTO", debit=60_000), L("628", credit=60_000, cc="CC-GA")])

E("2026-09-30", "NORMAL", "Devengo del gasto anticipado (seguro)", template="DEVENGO_PERIODIFICACION_GASTO",
  source="MANUAL", ref="PER-G-02", lines=[
      L("628", debit=60_000, cc="CC-GA"), L("PERIODIFICACION_GASTO", credit=60_000)])

E("2026-06-30", "NORMAL", "Periodificacion de ingreso anticipado (P-03)", template="PERIODIFICACION_INGRESO",
  source="MANUAL", ref="PER-I-01", lines=[
      L("VENTAS_DEFAULT", debit=90_000, project="P-03"), L("PERIODIFICACION_INGRESO", credit=90_000)])

E("2026-10-31", "NORMAL", "Devengo del ingreso anticipado (P-03)", template="DEVENGO_PERIODIFICACION_INGRESO",
  source="MANUAL", ref="PER-I-02", lines=[
      L("PERIODIFICACION_INGRESO", debit=90_000), L("VENTAS_DEFAULT", credit=90_000, project="P-03")])

# ---------------------------------------------------------------------------
# 8. Traspaso, manual, error de ejercicio cerrado, contra-asiento
# ---------------------------------------------------------------------------

E("2026-07-15", "NORMAL", "Traspaso de banco a caja", template="TRASPASO_TESORERIA", source="BANK_IMPORT",
  ref="TR-001", lines=[L("CAJA", debit=30_000), L("BANCO_DEFAULT", credit=30_000)])

E("2026-11-30", "NORMAL", "Reclasificacion a clientes de dudoso cobro", template="ASIENTO_MANUAL",
  source="MANUAL", ref="MAN-001", lines=[
      L("CLIENTES_DUDOSO_COBRO", debit=121_000), L("CLIENTES", credit=121_000)])

E("2026-02-10", "NORMAL", "Gasto de 2025 no registrado (importe no significativo)", template="AJUSTE_EJERCICIO_CERRADO",
  source="MANUAL", ref="AJ-001", lines=[
      L("678", debit=35_000, cc="CC-GA"), L("ACREEDORES", credit=35_000)])

E("2026-03-15", "NORMAL", "Correccion de error material de 2025 contra reservas", template="AJUSTE_EJERCICIO_CERRADO",
  source="MANUAL", ref="AJ-002", lines=[
      L("113", debit=250_000), L("ACREEDORES", credit=250_000)])

base = 100_000
cuota = apply_bps(base, IVA21)
E("2026-10-10", "NORMAL", "Factura recibida duplicada (error)", template="FACTURA_RECIBIDA", source="DOCUMENT",
  ref="R-ERR", lines=[
      L("SUBCONTRATACION_DEFAULT", debit=base, project="P-01"),
      L("IVA_SOPORTADO", debit=cuota, tax="IVA_21"),
      L("PROVEEDORES", credit=base + cuota)])

E("2026-10-15", "REVERSAL", "Contra-asiento de anulacion de la factura duplicada", template="CONTRA_ASIENTO",
  source="SYSTEM", ref="REV-R-ERR", reverses="R-ERR", lines=[
      L("PROVEEDORES", debit=base + cuota),
      L("SUBCONTRATACION_DEFAULT", credit=base, project="P-01"),
      L("IVA_SOPORTADO", credit=cuota, tax="IVA_21")])

# ---------------------------------------------------------------------------
# 9. Regularizacion trimestral de IVA (T-23) y su pago (T-24)
# ---------------------------------------------------------------------------

QUARTER_END = {1: "2026-03-31", 2: "2026-06-30", 3: "2026-09-30", 4: "2026-12-31"}
QUARTER_PAY = {1: "2026-04-20", 2: "2026-07-20", 3: "2026-10-20", 4: "2027-01-20"}


def balance_of(code: str, upto: str, only_quarter: int | None = None) -> tuple[int, int]:
    d = c = 0
    for e in ENTRIES:
        if e["date"] > upto:
            continue
        if only_quarter is not None and q(e["date"]) != only_quarter:
            continue
        for ln in e["lines"]:
            if code_of(ln) == code:
                d += ln["debitCents"]
                c += ln["creditCents"]
    return d, c


pendiente_compensar = 0
iva_quarters: list[dict[str, Any]] = []
for quarter in (1, 2, 3, 4):
    end = QUARTER_END[quarter]
    rep_d, rep_c = balance_of("477", end, quarter)
    sop_d, sop_c = balance_of("472", end, quarter)
    repercutido = rep_c - rep_d          # saldo acreedor de 477 del trimestre
    soportado = sop_d - sop_c            # saldo deudor de 472 del trimestre
    resultado = repercutido - soportado - pendiente_compensar
    lines = []
    if repercutido:
        lines.append(L("IVA_REPERCUTIDO", debit=repercutido))
    if soportado:
        lines.append(L("IVA_SOPORTADO", credit=soportado))
    compensado = 0
    if pendiente_compensar:
        compensado = pendiente_compensar
        lines.append(L("HP_DEUDORA_IVA", credit=pendiente_compensar))
    if resultado > 0:
        lines.append(L("HP_ACREEDORA_IVA", credit=resultado))
        pendiente_compensar = 0
    elif resultado < 0:
        lines.append(L("HP_DEUDORA_IVA", debit=-resultado))
        pendiente_compensar = -resultado
    else:
        pendiente_compensar = 0
    E(end, "NORMAL", f"Liquidacion de IVA {quarter}T 2026 (modelo 303)", template="REGULARIZACION_IVA",
      source="SYSTEM", ref=f"IVA-Q{quarter}", lines=lines)
    iva_quarters.append({"quarter": quarter, "repercutidoCents": repercutido, "soportadoCents": soportado,
                         "compensadoCents": compensado, "resultadoCents": resultado})
    if resultado > 0 and quarter in (1, 2, 3):
        E(QUARTER_PAY[quarter], "NORMAL", f"Pago del modelo 303 {quarter}T 2026", template="PAGO_IMPUESTO",
          source="BANK_IMPORT", ref=f"P-IVA-Q{quarter}", lines=[
              L("HP_ACREEDORA_IVA", debit=resultado), L("BANCO_DEFAULT", credit=resultado)])

# Pago trimestral de retenciones (modelo 111 / 115) de Q1..Q3; el 4T queda pendiente
irpf_quarters: list[dict[str, Any]] = []
for quarter in (1, 2, 3):
    end = QUARTER_END[quarter]
    # saldo VIVO de 4751 a fin de trimestre (acumulado menos lo ya ingresado)
    d, c = balance_of("4751", end)
    saldo = c - d
    irpf_quarters.append({"quarter": quarter, "saldoCents": saldo})
    E(QUARTER_PAY[quarter], "NORMAL", f"Pago de retenciones {quarter}T 2026 (modelos 111 y 115)",
      template="PAGO_RETENCIONES", source="BANK_IMPORT", ref=f"P-IRPF-Q{quarter}", lines=[
          L("IRPF_A_PAGAR", debit=saldo), L("BANCO_DEFAULT", credit=saldo)])

# ---------------------------------------------------------------------------
# 10. Impuesto sobre beneficios, regularizacion (T-25), cierre (T-26) y apertura 2027
# ---------------------------------------------------------------------------

PYG_EXCLUDED_KINDS = {"REGULARIZATION", "CLOSING", "OPENING"}


def pyg_balances() -> dict[str, int]:
    """Saldo (haber - debe) por cuenta 6/7 con kind fuera de la exclusion (I3)."""
    out: dict[str, int] = defaultdict(int)
    for e in ENTRIES:
        if e["kind"] in PYG_EXCLUDED_KINDS:
            continue
        for ln in e["lines"]:
            code = code_of(ln)
            if code[0] in "67":
                out[code] += ln["creditCents"] - ln["debitCents"]
    return dict(out)


resultado_antes_impuesto = sum(pyg_balances().values())
cuota_is = apply_bps(max(resultado_antes_impuesto, 0), IS_BPS)
E("2026-12-31", "NORMAL", "Gasto por impuesto sobre beneficios del ejercicio", template="IMPUESTO_BENEFICIOS",
  source="SYSTEM", ref="IS-2026", lines=[
      L("IMPUESTO_BENEFICIOS_GASTO", debit=cuota_is),
      L("HP_ACREEDORA_IS", credit=cuota_is)])

pyg = pyg_balances()
resultado_ejercicio = sum(pyg.values())
reg_lines = []
for code in sorted(pyg):
    saldo = pyg[code]
    if saldo == 0:
        continue
    if saldo > 0:  # cuenta con saldo acreedor (ingreso): se salda por el debe
        reg_lines.append({"accountCode": code, "debitCents": saldo, "creditCents": 0})
    else:
        reg_lines.append({"accountCode": code, "debitCents": 0, "creditCents": -saldo})
reg_lines.append({"accountCode": "129", "debitCents": 0 if resultado_ejercicio > 0 else -resultado_ejercicio,
                  "creditCents": resultado_ejercicio if resultado_ejercicio > 0 else 0})
E("2026-12-31", "REGULARIZATION", "Regularizacion de gastos e ingresos del ejercicio 2026",
  template="REGULARIZACION_RESULTADO", source="SYSTEM", ref="REG-2026", lines=reg_lines)


def balance_sheet_balances() -> dict[str, int]:
    """Saldo (debe - haber) por cuenta de balance, tras la regularizacion."""
    out: dict[str, int] = defaultdict(int)
    for e in ENTRIES:
        if e["kind"] in ("CLOSING",) or e["fiscalYearCode"] != "2026":
            continue
        for ln in e["lines"]:
            code = code_of(ln)
            if code[0] in "67":
                continue
            out[code] += ln["debitCents"] - ln["creditCents"]
    return {k: v for k, v in out.items() if v != 0}


cierre = balance_sheet_balances()
cierre_lines = []
for code in sorted(cierre):
    saldo = cierre[code]
    cierre_lines.append({"accountCode": code, "debitCents": 0 if saldo > 0 else -saldo,
                         "creditCents": saldo if saldo > 0 else 0})
E("2026-12-31", "CLOSING", "Cierre del ejercicio 2026", template="CIERRE_EJERCICIO", source="SYSTEM",
  ref="CIE-2026", lines=cierre_lines)

apertura_lines = []
for code in sorted(cierre):
    saldo = cierre[code]
    apertura_lines.append({"accountCode": code, "debitCents": saldo if saldo > 0 else 0,
                           "creditCents": 0 if saldo > 0 else -saldo})
E("2027-01-01", "OPENING", "Apertura del ejercicio 2027", template="APERTURA_EJERCICIO", source="SYSTEM",
  ref="AP-2027", fy="2027", lines=apertura_lines)

# ---------------------------------------------------------------------------
# 11. Orden, numeracion y bloque `expected`
# ---------------------------------------------------------------------------

KIND_ORDER = {"OPENING": 0, "NORMAL": 1, "REVERSAL": 1, "RECURRING": 1, "REGULARIZATION": 2, "CLOSING": 3}
ENTRIES.sort(key=lambda e: (e["fiscalYearCode"], e["date"], KIND_ORDER[e["kind"]]))

counters: dict[str, int] = defaultdict(int)
for e in ENTRIES:
    counters[e["fiscalYearCode"]] += 1
    e["entryNumber"] = counters[e["fiscalYearCode"]]
    for i, ln in enumerate(e["lines"], start=1):
        ln["lineNo"] = i
        ln.setdefault("debitCents", 0)
        ln.setdefault("creditCents", 0)
        assert (ln["debitCents"] == 0) != (ln["creditCents"] == 0), f"linea a 0 o con dos importes en {e['ref']}"
        assert ln["debitCents"] >= 0 and ln["creditCents"] >= 0


def totals(fy: str | None = None) -> tuple[int, int]:
    d = c = 0
    for e in ENTRIES:
        if fy and e["fiscalYearCode"] != fy:
            continue
        d += sum(x["debitCents"] for x in e["lines"])
        c += sum(x["creditCents"] for x in e["lines"])
    return d, c


def saldo(code: str, exclude_kinds: set[str], fy: str = "2026") -> int:
    s = 0
    for e in ENTRIES:
        if e["fiscalYearCode"] != fy or e["kind"] in exclude_kinds:
            continue
        for ln in e["lines"]:
            if code_of(ln) == code:
                s += ln["debitCents"] - ln["creditCents"]
    return s


TRACKED = ["430", "436", "400", "410", "472", "477", "4750", "4700", "4751", "4752", "476", "465",
           "572", "570", "473", "407", "438", "480", "485", "129", "113", "120", "100",
           "216", "217", "2816", "2817", "460"]

deb_2026, cre_2026 = totals("2026")
deb_all, cre_all = totals()
assert deb_2026 == cre_2026 and deb_all == cre_all

pyg_final = pyg_balances()
resultado_i3 = sum(pyg_final.values())
saldo_129 = -saldo("129", {"CLOSING"})  # saldo acreedor
assert saldo_129 == resultado_i3, f"I3 roto: 129={saldo_129} vs PyG={resultado_i3}"

# I2 antes del cierre: Activo = Pasivo + PN (con el resultado ya en 129)
activo_pasivo = 0
for e in ENTRIES:
    if e["fiscalYearCode"] != "2026" or e["kind"] == "CLOSING":
        continue
    for ln in e["lines"]:
        if code_of(ln)[0] not in "67":
            activo_pasivo += ln["debitCents"] - ln["creditCents"]
assert activo_pasivo == 0, f"I2 roto: {activo_pasivo}"

template_coverage: dict[str, int] = defaultdict(int)
for e in ENTRIES:
    template_coverage[e.get("template", "SIN_PLANTILLA")] += 1
template_coverage = dict(sorted(template_coverage.items()))

numbering_ok = True
seen: dict[str, int] = defaultdict(int)
for e in ENTRIES:
    seen[e["fiscalYearCode"]] += 1
    if e["entryNumber"] != seen[e["fiscalYearCode"]]:
        numbering_ok = False
assert numbering_ok, "I7: numeracion con huecos"

expected = {
    "entryCount": len(ENTRIES),
    "entryCount2026": sum(1 for e in ENTRIES if e["fiscalYearCode"] == "2026"),
    "totalDebitCents": deb_all,
    "totalCreditCents": cre_all,
    "totalDebitCents2026": deb_2026,
    "totalCreditCents2026": cre_2026,
    "resultadoAntesRegularizacionCents": resultado_i3,
    "resultadoAntesImpuestoCents": resultado_antes_impuesto,
    "impuestoBeneficiosCents": cuota_is,
    "saldo129Cents": saldo_129,
    "balancesBeforeClosingCents": {c: saldo(c, {"CLOSING"}) for c in TRACKED},
    "balancesBeforeRegularizationCents": {c: saldo(c, {"CLOSING", "REGULARIZATION"}) for c in TRACKED},
    "templateCoverage": template_coverage,
    "ivaQuarters": iva_quarters,
    "irpfQuarters": irpf_quarters,
    "invariants": {
        "I1_all_entries_balanced": True,
        "I2_balance_sheet_diff_cents": activo_pasivo,
        "I3_pyg_equals_129_diff_cents": saldo_129 - resultado_i3,
        "I7_entry_numbers_contiguous": numbering_ok,
    },
}

ORG = {
    "slug": "fixture-erp",
    "name": "Fixture Proyectos SL",
    "baseCurrency": "EUR",
    "pgcVariant": "PYMES",
    "taxRoundingMode": "PER_TIPO",
    "prorrataBps": PRORRATA,
    "redondeoToleranciaCents": 1,
    "analyticsRequired": True,
    "useSubaccounts": False,
    "createSoftwareAccounts": False,
}

FIXTURE = {
    "schemaVersion": "1.0",
    "generatedBy": "docs/design/fixtures/build_ejercicio_completo.py",
    "note": "Fixture INMUTABLE. Cifras ilustrativas, ningun dato real. No editar a mano: regenerar con el script.",
    "organization": ORG,
    "fiscalYear": {"code": "2026", "startDate": "2026-01-01", "endDate": "2026-12-31", "status": "OPEN"},
    "fiscalYearsExtra": [{"code": "2027", "startDate": "2027-01-01", "endDate": "2027-12-31", "status": "OPEN"}],
    "accountsExtra": [],
    "businessLines": BUSINESS_LINES,
    "projects": PROJECTS,
    "costCenters": COST_CENTERS,
    "entries": ENTRIES,
    "expected": expected,
}

# ---------------------------------------------------------------------------
# Fixture minimo: el caso irreducible (apertura, venta, cobro, regularizacion, cierre)
# ---------------------------------------------------------------------------

MIN_BASE = 100_000
MIN_IVA = apply_bps(MIN_BASE, IVA21)
min_entries = [
    {"ref": "AP", "date": "2026-01-01", "kind": "OPENING", "fiscalYearCode": "2026",
     "description": "Apertura del ejercicio 2026", "sourceType": "SYSTEM", "template": "APERTURA_EJERCICIO",
     "lines": [{"accountKey": "BANCO_DEFAULT", "debitCents": 500_000, "creditCents": 0, "lineNo": 1},
               {"accountCode": "100", "debitCents": 0, "creditCents": 500_000, "lineNo": 2}]},
    {"ref": "F1", "date": "2026-03-31", "kind": "NORMAL", "fiscalYearCode": "2026",
     "description": "Factura emitida 2026/001", "sourceType": "INVOICE_OUT", "template": "FACTURA_EMITIDA_SERVICIOS",
     "lines": [{"accountKey": "CLIENTES", "debitCents": MIN_BASE + MIN_IVA, "creditCents": 0, "lineNo": 1},
               {"accountKey": "VENTAS_DEFAULT", "debitCents": 0, "creditCents": MIN_BASE, "projectCode": "P-01",
                "taxRateCode": None, "lineNo": 2},
               {"accountKey": "IVA_REPERCUTIDO", "debitCents": 0, "creditCents": MIN_IVA, "taxRateCode": "IVA_21",
                "lineNo": 3}]},
    {"ref": "CO", "date": "2026-04-15", "kind": "NORMAL", "fiscalYearCode": "2026",
     "description": "Cobro de la factura 2026/001", "sourceType": "BANK_IMPORT", "template": "COBRO_CLIENTE",
     "lines": [{"accountKey": "BANCO_DEFAULT", "debitCents": MIN_BASE + MIN_IVA, "creditCents": 0, "lineNo": 1},
               {"accountKey": "CLIENTES", "debitCents": 0, "creditCents": MIN_BASE + MIN_IVA, "lineNo": 2}]},
    {"ref": "REG", "date": "2026-12-31", "kind": "REGULARIZATION", "fiscalYearCode": "2026",
     "description": "Regularizacion de gastos e ingresos", "sourceType": "SYSTEM",
     "template": "REGULARIZACION_RESULTADO",
     "lines": [{"accountCode": "705", "debitCents": MIN_BASE, "creditCents": 0, "lineNo": 1},
               {"accountCode": "129", "debitCents": 0, "creditCents": MIN_BASE, "lineNo": 2}]},
]
for e in min_entries:
    for ln in e["lines"]:
        ln.pop("taxRateCode", None) if ln.get("taxRateCode") is None else None
min_closing = {"572": 500_000 + MIN_BASE + MIN_IVA, "477": -MIN_IVA, "100": -500_000, "129": -MIN_BASE}
min_entries.append({"ref": "CIE", "date": "2026-12-31", "kind": "CLOSING", "fiscalYearCode": "2026",
                    "description": "Cierre del ejercicio 2026", "sourceType": "SYSTEM",
                    "template": "CIERRE_EJERCICIO",
                    "lines": [{"accountCode": c, "debitCents": 0 if s > 0 else -s,
                               "creditCents": s if s > 0 else 0, "lineNo": i}
                              for i, (c, s) in enumerate(sorted(min_closing.items()), start=1)]})
for i, e in enumerate(min_entries, start=1):
    e["entryNumber"] = i
    d = sum(x["debitCents"] for x in e["lines"])
    c = sum(x["creditCents"] for x in e["lines"])
    assert d == c, f"minimo descuadrado en {e['ref']}: {d} != {c}"

MIN_FIXTURE = {
    "schemaVersion": "1.0",
    "generatedBy": "docs/design/fixtures/build_ejercicio_completo.py",
    "note": "Fixture INMUTABLE minimo. Cifras ilustrativas.",
    "organization": ORG,
    "fiscalYear": {"code": "2026", "startDate": "2026-01-01", "endDate": "2026-12-31", "status": "OPEN"},
    "fiscalYearsExtra": [],
    "accountsExtra": [],
    "businessLines": [BUSINESS_LINES[0]],
    "projects": [PROJECTS[0]],
    "costCenters": [COST_CENTERS[0]],
    "entries": min_entries,
    "expected": {
        "entryCount": len(min_entries),
        "totalDebitCents": sum(sum(x["debitCents"] for x in e["lines"]) for e in min_entries),
        "totalCreditCents": sum(sum(x["creditCents"] for x in e["lines"]) for e in min_entries),
        "resultadoAntesRegularizacionCents": MIN_BASE,
        "saldo129Cents": MIN_BASE,
        "balancesBeforeClosingCents": {"572": 500_000 + MIN_BASE + MIN_IVA, "477": -MIN_IVA,
                                       "100": -500_000, "129": -MIN_BASE},
    },
}


def dump(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="no escribe: compara con el fichero en disco")
    args = ap.parse_args()
    for path, data in ((OUT_FULL, FIXTURE), (OUT_MIN, MIN_FIXTURE)):
        text = dump(data)
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                print(f"FAIL: {path} difiere de la reconstruccion", file=sys.stderr)
                return 1
            print(f"OK: {path} coincide")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            print(f"escrito: {path.relative_to(ROOT)}")
    if not args.check:
        print(f"\nAsientos: {expected['entryCount']} (2026: {expected['entryCount2026']})")
        print(f"Sigma debe = Sigma haber = {deb_all} centimos (2026: {deb_2026})")
        print(f"Resultado antes de regularizacion (I3) = {resultado_i3} centimos")
        print(f"  antes de impuesto = {resultado_antes_impuesto} · IS = {cuota_is}")
        print("Saldos antes del cierre:")
        for c, v in expected["balancesBeforeClosingCents"].items():
            print(f"  {c:>5}: {v:>12}")
        print(f"IVA por trimestre: {iva_quarters}")
        print(f"IRPF por trimestre: {irpf_quarters}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
