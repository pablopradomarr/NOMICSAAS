#!/usr/bin/env python3
"""
E3 · Generador de los fixtures inmutables del libro diario.  (v1.1)

Historial
  v1.0  primera version.
  v1.1  correccion previa al sellado, con E3 aun abierta (revision del arquitecto):
        · I9: toda linea resuelve ahora a la HOJA POSTABLE del plan (misma regla que
          lib/accounts/map.ts::resolvePostable). Con `useSubaccounts = false` el motor
          desciende igualmente a la hoja: CLIENTES -> 4300, PROVEEDORES -> 4000,
          ACREEDORES -> 4100, DEVOLUCION_COMPRAS -> 6080, DEVOLUCION_VENTAS -> 7080,
          IMPUESTO_BENEFICIOS_GASTO -> 6300. Antes se emitian los codigos padre
          (430/400/410/608/708/630), NO postables, y T-26/T-27/T-28 los arrastraban.
        · I-E3-5: orden de lineas canonico y unico por plantilla (el de la tabla de
          docs/design/E3-asientos-tipo.md §1), aplicado por `canonical_rank()`.
        · `expected.balancesByPrefix3Cents`: agregado jerarquico a 3 digitos, ADEMAS
          del saldo por hoja (que sigue siendo el autoritativo).
        Ningun importe cambia: solo codigos y orden.

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

# ---------------------------------------------------------------------------
# Plan de la organizacion (variante PYMES del seed) y resolucion a hoja postable
# ---------------------------------------------------------------------------

SEED_CSV = ROOT / "seeds" / "npgc.csv"


def load_plan(variant: str = "PYMES") -> tuple[set[str], set[str]]:
    """Devuelve (codigos del plan, codigos postables). Postable = sin hijos."""
    import csv
    with SEED_CSV.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    codes = {r["codigo"] for r in rows if variant != "PYMES" or r["pymes"] == "1"}
    postable = {c for c in codes if not any(o != c and o.startswith(c) for o in codes)}
    return codes, postable


PLAN_CODES, PLAN_POSTABLE = load_plan("PYMES")


def resolve_postable(code: str) -> str:
    """Misma regla que lib/accounts/map.ts::resolvePostable: si el codigo no existe
    sube al ancestro mas cercano; si no es postable baja a la hoja de menor codigo
    (en el PGC, siempre la subcuenta "general": 430 -> 4300, 630 -> 6300)."""
    current = code
    if current not in PLAN_CODES:
        for n in range(len(current) - 1, 0, -1):
            if current[:n] in PLAN_CODES:
                current = current[:n]
                break
        else:
            raise KeyError(f"{code} no existe en el plan ni tiene ancestro")
    if current in PLAN_POSTABLE:
        return current
    leaves = sorted(c for c in PLAN_POSTABLE if c != current and c.startswith(current))
    if not leaves:
        raise KeyError(f"{code} no es postable y no tiene hoja")
    return leaves[0]


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

# ---------------------------------------------------------------------------
# Orden canonico de lineas por plantilla (I-E3-5).
# Es EXACTAMENTE el orden de las tablas de docs/design/E3-asientos-tipo.md §1:
# el asiento que genera la plantilla debe ser reproducible byte a byte, asi que
# el orden no puede depender de como se escriba el input.
# ---------------------------------------------------------------------------

def canonical_rank(template: str | None, line: Line) -> int:
    """Posicion de la linea dentro de su plantilla. Menor = antes."""
    if template is None:
        return 0
    code = code_of(line)
    debe = line["debitCents"] > 0
    g = code[0]

    if template in ("FACTURA_EMITIDA_SERVICIOS",):
        # 1 CLIENTES · 2 473 IRPF · 3 438 anticipo · 4 477 reversion anticipo
        # 5 ingresos 7xx · 6 477 cuota por tipo (incl. recargo)
        if code.startswith("430"):
            return 1
        if code.startswith("473"):
            return 2
        if code.startswith("438"):
            return 3
        if code.startswith("477"):
            return 4 if debe else 6
        if g == "7":
            return 5
        return 9
    if template == "ABONO_EMITIDO":
        # 1 708/706/709 (o cuenta de ingreso) · 2 477 · 3 473 · 4 CLIENTES
        if g == "7":
            return 1
        if code.startswith("477"):
            return 2
        if code.startswith("473"):
            return 3
        if code.startswith("430"):
            return 4
        return 9
    if template in ("FACTURA_RECIBIDA", "FACTURA_RECIBIDA_ISP"):
        # 1 gasto/inmovilizado · 2 472 · 3 407 · 4 proveedor/acreedor · 5 4751 · 6 477 (ISP)
        if code.startswith("472"):
            return 2
        if code.startswith("407"):
            return 3
        if code.startswith("400") or code.startswith("410"):
            return 4
        if code.startswith("4751"):
            return 5
        if code.startswith("477"):
            return 6
        return 1
    if template == "ABONO_RECIBIDO":
        # 1 proveedor · 2 4751 · 3 608/606/609 (o gasto) · 4 472
        if code.startswith("400") or code.startswith("410"):
            return 1
        if code.startswith("4751"):
            return 2
        if code.startswith("472"):
            return 4
        return 3
    if template == "ANTICIPO_CLIENTE":
        return 1 if code.startswith("57") else (2 if code.startswith("438") else 3)
    if template == "ANTICIPO_PROVEEDOR":
        return 1 if code.startswith("407") else (2 if code.startswith("472") else 3)
    if template == "COBRO_CLIENTE":
        # 1 tesoreria · 2 626 · 3 668 · 4 768 · 5 669/769 · 6 credito
        if code.startswith("57"):
            return 1
        if code.startswith("626"):
            return 2
        if code.startswith("668"):
            return 3
        if code.startswith("768"):
            return 4
        if code.startswith("669") or code.startswith("769"):
            return 5
        return 6
    if template == "PAGO_PROVEEDOR":
        # 1 deuda · 2 626 · 3 668 · 4 669 · 5 tesoreria · 6 768/769
        if code.startswith("400") or code.startswith("410"):
            return 1
        if code.startswith("626"):
            return 2
        if code.startswith("668"):
            return 3
        if code.startswith("669"):
            return 4
        if code.startswith("57"):
            return 5
        return 6
    if template == "NOMINA":
        # 1 640 · 2 642 · 3 465 · 4 460 · 5 476 · 6 4751
        if code.startswith("640"):
            return 1
        if code.startswith("642"):
            return 2
        if code.startswith("465"):
            return 3
        if code.startswith("460"):
            return 4
        if code.startswith("476"):
            return 5
        return 6
    if template == "AMORTIZACION_MENSUAL":
        return 1 if code.startswith("68") else 2
    if template == "REGULARIZACION_IVA":
        # 1 477 · 2 472 · 3 4700 · 4 4750
        if code.startswith("477"):
            return 1
        if code.startswith("472"):
            return 2
        if code.startswith("4700"):
            return 3
        return 4
    if template == "CONTRA_ASIENTO":
        return 0  # espejo: conserva el orden del asiento original
    # Resto (traspaso, pagos, periodificaciones, manual, cierre/apertura por saldo):
    # el orden declarado ya es el canonico (debe antes que haber, luego por codigo).
    return 0


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
    ordered = sorted(enumerate(lines), key=lambda pair: (canonical_rank(template, pair[1]), pair[0]))
    e["lines"] = [ln for _, ln in ordered]
    ENTRIES.append(e)
    return e


def code_of(line: Line) -> str:
    """Codigo REALMENTE posteado: siempre una hoja postable del plan (I9)."""
    raw = KEY_TO_CODE[line["accountKey"]] if "accountKey" in line else line["accountCode"]
    return resolve_postable(raw)


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


# I9: toda linea postea en una hoja postable del plan de la organizacion
for e in ENTRIES:
    for ln in e["lines"]:
        c = code_of(ln)
        assert c in PLAN_POSTABLE, f"I9 roto: {e['ref']} postea en {c}, que no es hoja postable"
    ranks = [canonical_rank(e.get("template"), ln) for ln in e["lines"]]
    assert ranks == sorted(ranks), f"I-E3-5: orden de lineas no canonico en {e['ref']}"


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


# Codigos HOJA realmente posteados (no los padres 430/400/410: v1.1).
TRACKED = ["4300", "436", "4000", "4100", "472", "477", "4750", "4700", "4751", "4752", "476", "465",
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

# Agregado jerarquico a 3 digitos (criterio de sumas y saldos). NO sustituye al
# saldo por hoja: es un check ADICIONAL, porque un error entre dos hojas hermanas
# (4300 vs 4304) se cancela al agregar por prefijo y solo lo caza el saldo por hoja.
prefix3_raw: dict[str, int] = defaultdict(int)
for e in ENTRIES:
    if e["fiscalYearCode"] != "2026" or e["kind"] == "CLOSING":
        continue
    for ln in e["lines"]:
        prefix3_raw[code_of(ln)[:3]] += ln["debitCents"] - ln["creditCents"]
prefix3_balances = {k: v for k, v in sorted(prefix3_raw.items()) if v != 0}

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
    "balancesByPrefix3Cents": prefix3_balances,
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




# ═══════════════════════════════════════════════════════════════════════════
# E9 · T20 — Fixture AMPLIADO `ejercicio-completo-v2`
# ═══════════════════════════════════════════════════════════════════════════
#
# Los fixtures v1 de arriba son INMUTABLES y no se tocan (su `ledgerHash` es el
# de E3). El de E9 es un fichero NUEVO y versionado, con lo que la epica de
# cierre necesita y v1 no tiene:
#
#   · 300 activos, uno con `base < n` (cuota cero, O-22), uno revisado (NRV 22a,
#     prospectiva) y uno vendido, ademas de uno dado de baja
#   · 60 reglas recurrentes, con PAUSADA y con cuadro (amortizacion/periodificacion)
#   · dos ejercicios encadenados (2026 cerrado, 2027 abierto y cerrado), con el
#     contra-asiento de T-32 como asiento numero 2 de 2027 (O-8)
#   · 4 prestamos con cuadro de vencimientos (O-6), corto y largo plazo
#   · posiciones en divisa MONETARIAS (430, 400, 572) y NO monetarias (407, 438)
#   · una organizacion en RECC (4728/4778) y otra con prorrata e inmovilizado
#   · cobertura de plantillas 37/37 (I-E3-5)
#
# Todo en enteros. Las cifras son ILUSTRATIVAS: ninguna procede de datos reales.

OUT_V2 = ROOT / "tests" / "fixtures" / "ejercicio-completo-v2.json"

# Las diecinueve claves de E9 (`lib/accounts/map.ts::ACCOUNT_KEY_DEFAULT_CODE`).
# `4728` y `4778` NO son cuentas del PGC: se crean como hijas de 472 y 477 y por
# eso viajan en `accountsExtra`, no en el seed.
KEY_TO_CODE_V2: dict[str, str] = dict(KEY_TO_CODE) | {
    "AJUSTE_PRORRATA_NEGATIVO": "634",
    "AJUSTE_PRORRATA_POSITIVO": "639",
    "IVA_SOPORTADO_PENDIENTE_RECC": "4728",
    "IVA_REPERCUTIDO_PENDIENTE_RECC": "4778",
    "ARANCELES": "600",
    "DEUDA_LARGO_INMOVILIZADO": "173",
    "BENEFICIO_BAJA_INMOVILIZADO": "771",
    "PERDIDA_BAJA_INMOVILIZADO": "671",
    "CREDITO_ENAJENACION_CP": "543",
    "CREDITO_ENAJENACION_LP": "253",
    "INGRESOS_CREDITOS": "762",
    "IMPUESTO_CORRIENTE": "6300",
    "RESERVA_LEGAL": "112",
    "RESERVAS_VOLUNTARIAS": "113",
    "DIVIDENDO_ACTIVO_A_PAGAR": "526",
    "DIVIDENDO_ACTIVO_A_CUENTA": "557",
    "IRPF_A_PAGAR_111": "4751",
    "IRPF_A_PAGAR_115": "4751",
    "IRPF_A_PAGAR_123": "4751",
    "PROVEEDORES_INMOVILIZADO": "523",
    "INTERESES_DEUDAS": "662",
    "OTROS_GASTOS_FINANCIEROS": "669",
    "INTERESES_DESCUENTO_EFECTOS": "665",
}

# Cuentas por codigo usadas por el fixture v2 (todas del seed salvo 4728/4778).
BY_CODE_USED_V2 = dict(BY_CODE_USED) | {
    "121": "Resultados negativos de ejercicios anteriores",
    "170": "Deudas a largo plazo con entidades de credito",
    "173": "Proveedores de inmovilizado a largo plazo",
    "523": "Proveedores de inmovilizado a corto plazo",
    "213": "Maquinaria",
    "2813": "Amortizacion acumulada de maquinaria",
    "29": "Deterioro de valor de activos no corrientes",
    "5200": "Prestamos a corto plazo de entidades de credito",
    "4728": "IVA soportado pendiente de devengo (RECC)",
    "4778": "IVA repercutido pendiente de devengo (RECC)",
    "625": "Primas de seguros",
    "640": "Sueldos y salarios",
    "642": "Seguridad Social a cargo de la empresa",
    "705": "Prestaciones de servicios",
    "769": "Otros ingresos financieros",
    "626": "Servicios bancarios y similares",
    # Hojas postables de 430 y 400: la posicion en divisa se declara sobre la
    # cuenta REAL del apunte, no sobre el padre.
    "4300": "Clientes (euros)",
    "4000": "Proveedores (euros)",
    "572": "Bancos e instituciones de credito c/c vista, euros",
    "662": "Intereses de deudas",
    "671": "Perdidas procedentes del inmovilizado material",
    "771": "Beneficios procedentes del inmovilizado material",
}

ACCOUNTS_EXTRA_V2 = [
    {"code": "4728", "name": "H.P. IVA soportado pendiente de devengo (RECC)", "parentCode": "472"},
    {"code": "4778", "name": "H.P. IVA repercutido pendiente de devengo (RECC)", "parentCode": "477"},
]


def resolve_v2(raw: str) -> str:
    """Como `resolve_postable`, pero 4728/4778 son hojas postables declaradas."""
    if raw in ("4728", "4778"):
        return raw
    return resolve_postable(raw)


class Book:
    """Libro diario de UNA organizacion. Sin estado global: el v2 tiene dos."""

    def __init__(self, years: dict[str, tuple[str, str]]):
        self.entries: list[Entry] = []
        self.years = years

    # -- construccion -------------------------------------------------------
    def L(self, acc: str, debit: int = 0, credit: int = 0, project: str | None = None,
          cc: str | None = None, tax: str | None = None, desc: str | None = None,
          due: str | None = None, asset: str | None = None, currency: str | None = None,
          original: int | None = None, rate: str | None = None) -> Line:
        assert debit >= 0 and credit >= 0, "importes negativos prohibidos"
        assert (debit == 0) != (credit == 0), f"exactamente un importe > 0 ({acc}: {debit}/{credit})"
        line: Line = {}
        if acc in KEY_TO_CODE_V2:
            line["accountKey"] = acc
        else:
            assert acc in BY_CODE_USED_V2, f"codigo {acc} no declarado"
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
        if due:
            line["dueDate"] = due
        if asset:
            line["fixedAssetCode"] = asset
        if currency:
            # R-FX-4 / ADR-0014 D2: divisa, importe original y tasa van juntos.
            line["originalCurrency"] = currency
            line["originalAmountCents"] = 0 if original is None else original
            line["exchangeRateId"] = rate or "rate-cierre-2026-12-31"
        return line

    def E(self, d: str, kind: str, description: str, lines: list[Line], template: str | None = None,
          source: str = "MANUAL", reverses: str | None = None, ref: str | None = None,
          seq: int = 0) -> Entry:
        deb = sum(x["debitCents"] for x in lines)
        cre = sum(x["creditCents"] for x in lines)
        assert deb == cre, f"I1 roto en {description}: {deb} != {cre}"
        assert len(lines) >= 2, f"asiento de una sola linea prohibido: {description}"
        fy = next(code for code, (start, end) in self.years.items() if start <= d <= end)
        e: Entry = {"ref": ref or description[:24], "date": d, "kind": kind, "fiscalYearCode": fy,
                    "description": description, "sourceType": source}
        if template:
            e["template"] = template
        if reverses:
            e["reversesRef"] = reverses
        e["_seq"] = seq
        # El orden canonico por plantilla es el de E3 (`canonical_rank`), que
        # razona sobre CODIGOS: se le pasa la linea ya resuelta. `4728`/`4778`
        # ascienden a `472`/`477` y ordenan como su cuenta madre, que es lo
        # correcto: son hijas suyas por prefijo (O-14).
        def rank(line: Line) -> int:
            proxy: Line = {"accountCode": self.code_of(line), "debitCents": line["debitCents"],
                           "creditCents": line["creditCents"]}
            return canonical_rank(template, proxy)

        ordered = sorted(enumerate(lines), key=lambda pair: (rank(pair[1]), pair[0]))
        e["lines"] = [ln for _, ln in ordered]
        self.entries.append(e)
        return e

    # -- consulta -----------------------------------------------------------
    @staticmethod
    def code_of(line: Line) -> str:
        raw = KEY_TO_CODE_V2[line["accountKey"]] if "accountKey" in line else line["accountCode"]
        return resolve_v2(raw)

    def balance(self, prefix: str, until: str | None = None, exclude: set[str] | None = None,
                fy: str | None = None) -> int:
        """Saldo (debe - haber) de las hojas que empiezan por `prefix`."""
        exclude = exclude or set()
        total = 0
        for e in self.entries:
            if e["kind"] in exclude:
                continue
            if until and e["date"] > until:
                continue
            if fy and e["fiscalYearCode"] != fy:
                continue
            for ln in e["lines"]:
                if self.code_of(ln).startswith(prefix):
                    total += ln["debitCents"] - ln["creditCents"]
        return total

    def pyg(self, fy: str) -> dict[str, int]:
        """Saldo (haber - debe) por cuenta 6/7 del ejercicio, excluyendo I3."""
        out: dict[str, int] = defaultdict(int)
        for e in self.entries:
            if e["fiscalYearCode"] != fy or e["kind"] in ("REGULARIZATION", "CLOSING", "OPENING"):
                continue
            for ln in e["lines"]:
                code = self.code_of(ln)
                if code[0] in "67":
                    out[code] += ln["creditCents"] - ln["debitCents"]
        return {k: v for k, v in out.items() if v != 0}

    def balance_sheet(self, fy: str) -> dict[str, int]:
        """Saldo (debe - haber) por cuenta de balance del ejercicio, sin el cierre."""
        out: dict[str, int] = defaultdict(int)
        for e in self.entries:
            if e["fiscalYearCode"] != fy or e["kind"] == "CLOSING":
                continue
            for ln in e["lines"]:
                code = self.code_of(ln)
                if code[0] in "67":
                    continue
                out[code] += ln["debitCents"] - ln["creditCents"]
        return {k: v for k, v in out.items() if v != 0}

    # -- cierre del ejercicio ----------------------------------------------
    def regularize_and_close(self, fy: str, year_end: str, is_bps: int | None = None,
                            prepayments: int = 0) -> dict[str, int]:
        """T-25 (si procede) + T-26 + T-27. Devuelve los saldos cerrados."""
        info: dict[str, int] = {}
        if is_bps is not None:
            base = sum(self.pyg(fy).values())
            cuota = apply_bps(base, is_bps) if base > 0 else 0
            info["baseCents"] = base
            info["cuotaCents"] = cuota
            if cuota > 0:
                neto = cuota - prepayments
                lines = [self.L("IMPUESTO_CORRIENTE", debit=cuota)]
                if prepayments > 0:
                    lines.append(self.L("IRPF_RETENIDO_CLIENTES", credit=prepayments))
                if neto >= 0:
                    lines.append(self.L("HP_ACREEDORA_IS", credit=neto))
                else:
                    lines.append(self.L("HP_DEUDORA_IS", debit=-neto))
                self.E(year_end, "NORMAL", f"Impuesto sobre beneficios del ejercicio {fy}",
                       template="IMPUESTO_BENEFICIOS", source="SYSTEM", ref=f"IS-{fy}", seq=6,
                       lines=lines)

        pyg = self.pyg(fy)
        resultado = sum(pyg.values())
        info["resultadoCents"] = resultado
        reg = []
        for code in sorted(pyg):
            saldo = pyg[code]
            reg.append({"accountCode": code, "debitCents": saldo if saldo > 0 else 0,
                        "creditCents": -saldo if saldo < 0 else 0})
        reg.append({"accountCode": "129", "debitCents": 0 if resultado > 0 else -resultado,
                    "creditCents": resultado if resultado > 0 else 0})
        self.E(year_end, "REGULARIZATION", f"Regularizacion de gastos e ingresos del ejercicio {fy}",
               template="REGULARIZACION_RESULTADO", source="SYSTEM", ref=f"REG-{fy}", lines=reg)

        saldos = self.balance_sheet(fy)
        cierre = []
        for code in sorted(saldos):
            saldo = saldos[code]
            cierre.append({"accountCode": code, "debitCents": 0 if saldo > 0 else -saldo,
                           "creditCents": saldo if saldo > 0 else 0})
        self.E(year_end, "CLOSING", f"Cierre del ejercicio {fy}", template="CIERRE_EJERCICIO",
               source="SYSTEM", ref=f"CIE-{fy}", lines=cierre)
        return saldos

    def open_from(self, saldos: dict[str, int], date: str, fy: str) -> None:
        lines = []
        for code in sorted(saldos):
            saldo = saldos[code]
            lines.append({"accountCode": code, "debitCents": saldo if saldo > 0 else 0,
                          "creditCents": 0 if saldo > 0 else -saldo})
        self.E(date, "OPENING", f"Apertura del ejercicio {fy}", template="APERTURA_EJERCICIO",
               source="SYSTEM", ref=f"AP-{fy}", lines=lines)

    def numbered(self) -> list[Entry]:
        """Orden, numeracion correlativa por ejercicio (I7) y `lineNo` (I1/C-2)."""
        self.entries.sort(key=lambda e: (e["fiscalYearCode"], e["date"], KIND_ORDER_V2[e["kind"]],
                                         e.get("_seq", 0)))
        counters: dict[str, int] = defaultdict(int)
        for e in self.entries:
            counters[e["fiscalYearCode"]] += 1
            e["entryNumber"] = counters[e["fiscalYearCode"]]
            e.pop("_seq", None)
            for i, ln in enumerate(e["lines"], start=1):
                ln["lineNo"] = i
                assert (ln["debitCents"] == 0) != (ln["creditCents"] == 0), f"linea a 0 en {e['ref']}"
                assert self.code_of(ln) in PLAN_POSTABLE or self.code_of(ln) in ("4728", "4778"), \
                    f"I9 roto: {e['ref']} postea en {self.code_of(ln)}"
        return self.entries


# El OPENING es el primero del ejercicio y el CLOSING el ultimo (N-1'/N-5'); el
# contra-asiento de T-32 va justo detras de la apertura (O-8), y por eso lleva
# `_seq` propio.
KIND_ORDER_V2 = {"OPENING": 0, "REVERSAL_OPENING": 1, "NORMAL": 2, "REVERSAL": 2, "RECURRING": 2,
                 "REGULARIZATION": 8, "CLOSING": 9}


def month_end(year: int, month: int) -> str:
    dim = 29 if (month == 2 and ((year % 4 == 0 and year % 100 != 0) or year % 400 == 0)) else \
        28 if month == 2 else 30 if month in (4, 6, 9, 11) else 31
    return f"{year:04d}-{month:02d}-{dim:02d}"


def add_months_str(date: str, months: int) -> str:
    y, m, d = int(date[0:4]), int(date[5:7]), int(date[8:10])
    total = y * 12 + (m - 1) + months
    ny, nm = total // 12, total % 12 + 1
    dim = 29 if (nm == 2 and ((ny % 4 == 0 and ny % 100 != 0) or ny % 400 == 0)) else \
        28 if nm == 2 else 30 if nm in (4, 6, 9, 11) else 31
    return f"{ny:04d}-{nm:02d}-{min(d, dim):02d}"


# ---------------------------------------------------------------------------
# Cuadro de amortizacion (espejo de lib/closing/depreciation.ts, R-AM-1…5)
# ---------------------------------------------------------------------------

def period_key(date: str) -> str:
    return date[:7]


def depreciation_rows(asset: dict[str, Any], revisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    R-AM-1  base = coste + mejoras - valor residual vigente
    R-AM-2  q = trunc(base/n) y el residuo a la ULTIMA cuota (nunca `hamilton()`:
            repartir por mayor resto adelantaria amortizacion sin justificacion)
    R-AM-3  empieza el MES de `inServiceDate`, mes entero
    R-AM-5  la revision es PROSPECTIVA: desde `effectiveFrom` se reparte el VALOR
            NETO CONTABLE entre la vida residual nueva; el pasado no se toca
    R-REC-8 una cuota 0 no genera asiento (la ocurrencia queda OMITIDA)
    """
    cost = asset["costCents"] + asset.get("improvementsCents", 0)
    revs = sorted((r for r in revisions if r["assetCode"] == asset["code"]),
                  key=lambda r: r["effectiveFrom"])
    rows: list[dict[str, Any]] = []
    accumulated = 0
    residual = asset["residualCents"]
    period = asset["inServiceDate"][:7]
    remaining_n = asset["usefulLifeMonths"]
    assert remaining_n > 0

    # Cortes: el tramo termina en la revision siguiente o al agotar la vida.
    cuts = [r["effectiveFrom"][:7] for r in revs]
    for leg in range(len(revs) + 1):
        if leg > 0:
            rev = revs[leg - 1]
            residual = rev.get("newResidualCents", residual)
            remaining_n = rev["newRemainingMonths"]
            period = rev["effectiveFrom"][:7]
        leg_base = cost - residual - accumulated
        if remaining_n <= 0 or leg_base <= 0:
            break
        q = leg_base // remaining_n
        # Cuantas cuotas se emiten en este tramo: hasta la revision siguiente.
        limit = months_between(period, cuts[leg]) if leg < len(cuts) else remaining_n
        limit = min(limit, remaining_n)
        for k in range(limit):
            last = (leg == len(revs)) and (k == remaining_n - 1)
            quota = leg_base - q * (remaining_n - 1) if last else q
            accumulated += quota
            rows.append({"period": period, "quotaCents": quota, "accumulatedCents": accumulated,
                         "netBookValueCents": cost - accumulated})
            period = add_months_str(period + "-01", 1)[:7]

    assert accumulated == cost - residual, f"R-AM-4 roto en {asset['code']}: {accumulated} != {cost - residual}"
    assert all(r["quotaCents"] >= 0 for r in rows), f"cuota negativa en {asset['code']}"
    return rows


def months_between(a: str, b: str) -> int:
    """Meses de `a` (YYYY-MM) a `b`, ambos como periodo."""
    return (int(b[:4]) - int(a[:4])) * 12 + (int(b[5:7]) - int(a[5:7]))


# ---------------------------------------------------------------------------
# Los 300 activos, sus revisiones y sus cuadros
# ---------------------------------------------------------------------------

ASSET_CLASSES = [
    ("213", "2813", "681", "CC-OPS"),
    ("216", "2816", "681", "CC-GA"),
    ("217", "2817", "681", "CC-DEV"),
]

FIXED_ASSETS: list[dict[str, Any]] = []
for i in range(1, 301):
    asset_account, accumulated_account, expense_account, cc = ASSET_CLASSES[i % 3]
    # 200 activos en servicio ANTES de 2026 (alimentan la apertura) y 100 durante
    # el ejercicio: asi el cuadro arranca a mitad de ano en un tercio de la cartera.
    if i <= 200:
        year, month = (2024, (i % 12) + 1) if i <= 100 else (2025, (i % 12) + 1)
    else:
        year, month = 2026, ((i - 200) % 12) + 1
    FIXED_ASSETS.append({
        "code": f"AF-{i:03d}",
        "name": f"Elemento de inmovilizado {i:03d}",
        "assetAccountCode": asset_account,
        "accumulatedAccountCode": accumulated_account,
        "expenseAccountCode": expense_account,
        "costCenterCode": cc,
        "costCents": 30_000 + i * 100,
        "residualCents": 12_000 if i % 25 == 0 else 0,
        "usefulLifeMonths": [36, 60, 96][i % 3],
        "inServiceDate": f"{year:04d}-{month:02d}-{(i % 27) + 1:02d}",
        "status": "ALTA",
    })

# O-22 · el activo cuya base es MENOR que su vida util: `q = trunc(base/n) = 0`
# en 35 de las 36 cuotas. No genera 35 asientos de importe cero: genera UNA
# cuota al final y 35 ocurrencias OMITIDA con motivo `CUOTA_CERO`.
FIXED_ASSETS[299].update({
    "code": "AF-300", "name": "Pequeno utillaje (base < vida util)", "costCents": 20,
    "residualCents": 0, "usefulLifeMonths": 36, "inServiceDate": "2026-01-15",
    "assetAccountCode": "216", "accumulatedAccountCode": "2816", "expenseAccountCode": "681",
    "costCenterCode": "CC-GA",
})

# NRV 22a · revision PROSPECTIVA de la vida util (el pasado no se toca y NO hay
# asiento de ajuste). Se aplica al activo AF-002, en servicio desde 2024.
ASSET_REVISIONS = [{
    "assetCode": "AF-002",
    "effectiveFrom": "2026-09-01",
    "newRemainingMonths": 24,
    "reason": "Revision de la vida util restante tras la inspeccion tecnica (NRV 22a)",
}]

# Baja (T-33) y venta (T-34): la dotacion llega HASTA EL MES INCLUSIVE (R-AM-6).
ASSET_DISPOSALS = {
    "AF-003": {"kind": "VENTA", "date": "2026-10-31", "priceCents": 500_000, "vatBps": 2100},
    "AF-004": {"kind": "BAJA", "date": "2026-11-30"},
}
for asset in FIXED_ASSETS:
    if asset["code"] in ASSET_DISPOSALS:
        asset["status"] = "VENDIDO" if ASSET_DISPOSALS[asset["code"]]["kind"] == "VENTA" else "BAJA"
        asset["disposalDate"] = ASSET_DISPOSALS[asset["code"]]["date"]

SCHEDULES: dict[str, list[dict[str, Any]]] = {
    a["code"]: depreciation_rows(a, ASSET_REVISIONS) for a in FIXED_ASSETS
}


def quota_of(code: str, period: str) -> int:
    for row in SCHEDULES[code]:
        if row["period"] == period:
            return row["quotaCents"]
    return 0


def accumulated_until(code: str, period: str) -> int:
    """Amortizacion acumulada al final de `period` (incluido)."""
    total = 0
    for row in SCHEDULES[code]:
        if row["period"] <= period:
            total = row["accumulatedCents"]
    return total


def last_depreciated_period(code: str) -> str | None:
    """Ultimo periodo con dotacion: el mes de la baja inclusive, si la hay."""
    disposal = ASSET_DISPOSALS.get(code)
    return disposal["date"][:7] if disposal else None


# ---------------------------------------------------------------------------
# Las 60 reglas recurrentes
# ---------------------------------------------------------------------------

RECURRING_RULES: list[dict[str, Any]] = []
for i in range(1, 61):
    if i <= 40:
        kind, freq, source = "IMPORTE_FIJO", "MENSUAL", None
    elif i <= 52:
        kind, freq, source = "AMORTIZACION", "MENSUAL", f"AF-{i:03d}"
    else:
        kind, freq, source = "PERIODIFICACION", "MENSUAL", f"PER-{i - 52:02d}"
    RECURRING_RULES.append({
        "code": f"REC-{i:02d}",
        "name": f"Regla recurrente {i:02d}",
        "kind": kind,
        "freq": freq,
        "status": "PAUSADA" if i in (7, 23) else "ACTIVA",
        "startDate": "2026-01-01",
        "endDate": "2027-12-31",
        "amountCents": 15_000 + i * 250 if kind == "IMPORTE_FIJO" else None,
        "debitAccountCode": "621" if kind == "IMPORTE_FIJO" else None,
        "creditAccountKey": "ACREEDORES" if kind == "IMPORTE_FIJO" else None,
        "costCenterCode": "CC-GA",
        "sourceCode": source,
    })

# Solo TRES reglas materializan sus ocurrencias en el diario: el resto son datos
# del motor (T5/T12). Postear 60 x 24 asientos no probaria nada que estas tres no
# prueben, y el fixture tiene que seguir siendo legible.
POSTED_RULES = ["REC-01", "REC-02", "REC-07"]

# ---------------------------------------------------------------------------
# Los cuatro prestamos con cuadro (O-6)
# ---------------------------------------------------------------------------

def loan(code: str, name: str, principal: int, start: str, months: int, rate_bps: int,
         long_code: str = "170", short_code: str = "5200") -> dict[str, Any]:
    """Cuadro de principal constante; el interes se devenga por el cuadro (R-PE-6)."""
    q = principal // months
    installments = []
    for k in range(1, months + 1):
        amount = principal - q * (months - 1) if k == months else q
        due = add_months_str(start, k)
        pending = principal - q * (k - 1)
        installments.append({
            "seq": k,
            "dueDate": due,
            "principalCents": amount,
            "interestCents": apply_bps(pending, rate_bps) // 12,
        })
    assert sum(i["principalCents"] for i in installments) == principal
    return {"code": code, "name": name, "principalCents": principal, "startDate": start,
            "longAccountCode": long_code, "shortAccountCode": short_code,
            "monthlyRateMicroBps": rate_bps * 1_000_000 // 12, "installments": installments}


# Las tres altas de 2026 son de noviembre y diciembre a proposito: sin
# vencimientos pagados dentro del ejercicio, la reclasificacion del 31/12 se ve
# limpia —es un cambio de FRONTERA, no un movimiento de caja— y es justo lo que
# I-E9-16 comprueba.
DEBT_SCHEDULES = [
    loan("PR-2026-01", "Prestamo de circulante", 4_800_000, "2026-11-30", 24, 450),
    loan("PR-2026-02", "Prestamo de inversion", 12_000_000, "2026-12-15", 60, 380),
    loan("PR-2026-03", "Poliza de credito dispuesta", 2_400_000, "2026-12-31", 12, 620),
    loan("PR-2027-01", "Prestamo del ejercicio siguiente", 6_000_000, "2027-03-31", 36, 410),
]


# ---------------------------------------------------------------------------
# Organizacion 1 — «Fixture Cierre SL», acogida al RECC (art. 163 terdecies)
# ---------------------------------------------------------------------------

YEARS_V2 = {"2025": ("2025-01-01", "2025-12-31"),
            "2026": ("2026-01-01", "2026-12-31"),
            "2027": ("2027-01-01", "2027-12-31")}

b = Book(YEARS_V2)
L, E = b.L, b.E

IVA_BPS, IVA10_BPS, IRPF_BPS = 2100, 1000, 1500
IS_BPS_V2 = 2500

# — Apertura del ejercicio 2026 (T-28) ————————————————————————————————————
apertura: list[Line] = []
for asset_account, accumulated_account, _, _ in ASSET_CLASSES:
    cost = sum(a["costCents"] for a in FIXED_ASSETS
               if a["assetAccountCode"] == asset_account and a["inServiceDate"] < "2026-01-01")
    acc = sum(accumulated_until(a["code"], "2025-12") for a in FIXED_ASSETS
              if a["assetAccountCode"] == asset_account and a["inServiceDate"] < "2026-01-01")
    apertura.append(L(asset_account, debit=cost))
    apertura.append(L(accumulated_account, credit=acc))
apertura += [
    L("CLIENTES", debit=3_000_000),
    L("BANCO_DEFAULT", debit=8_000_000),
    L("PROVEEDORES", credit=1_500_000),
    # Factura 2025/088 emitida en RECC y aun no cobrada: su cuota vive en 4778 y
    # la barrera del art. 163 terdecies la devenga el 31/12/2026 (T-36).
    L("IVA_REPERCUTIDO_PENDIENTE_RECC", credit=210_000),
    L("100", credit=3_000_000),
    L("RESERVA_LEGAL", credit=400_000),
    L("RESERVAS_VOLUNTARIAS", credit=500_000),
]
plug = sum(x["debitCents"] for x in apertura) - sum(x["creditCents"] for x in apertura)
apertura.append(L("REMANENTE", credit=plug) if plug > 0 else L("REMANENTE", debit=-plug))
E("2026-01-01", "OPENING", "Apertura del ejercicio 2026", template="APERTURA_EJERCICIO",
  source="SYSTEM", ref="AP-2026", lines=apertura)

# — Facturas emitidas (T-01), una por mes; el IVA es 4778 hasta el cobro ————
SALES: list[dict[str, Any]] = []
for month in range(1, 13):
    base = 1_500_000 + month * 20_000
    quota = apply_bps(base, IVA_BPS)
    date = f"2026-{month:02d}-20"
    project = PROJECTS[month % 3]["code"]
    lines = [L("CLIENTES", debit=base + quota, due=add_months_str(date, 2)),
             L("VENTAS_DEFAULT", credit=base, project=project),
             L("IVA_REPERCUTIDO_PENDIENTE_RECC", credit=quota, tax="IVA_21")]
    if month == 2:
        # Retencion de IRPF practicada por el cliente: minora el cobro y se
        # cancela contra la cuota del IS (O-26).
        ret = apply_bps(base, IRPF_BPS)
        lines = [L("CLIENTES", debit=base + quota - ret, due=add_months_str(date, 2)),
                 L("IRPF_RETENIDO_CLIENTES", debit=ret, tax="IRPF_PROF_15"),
                 L("VENTAS_DEFAULT", credit=base, project=project),
                 L("IVA_REPERCUTIDO_PENDIENTE_RECC", credit=quota, tax="IVA_21")]
    if month == 6:
        # Dos tipos impositivos en el mismo documento (R-IVA-1: cuota por tipo).
        base10 = 150_000
        quota10 = apply_bps(base10, IVA10_BPS)
        lines = [L("CLIENTES", debit=base + base10 + quota + quota10, due=add_months_str(date, 2)),
                 L("VENTAS_DEFAULT", credit=base, project=project),
                 L("VENTAS_DEFAULT", credit=base10, project=project),
                 L("IVA_REPERCUTIDO_PENDIENTE_RECC", credit=quota, tax="IVA_21"),
                 L("IVA_REPERCUTIDO_PENDIENTE_RECC", credit=quota10, tax="IVA_10")]
    E(date, "NORMAL", f"Factura emitida 2026/{month:03d}", template="FACTURA_EMITIDA_SERVICIOS",
      source="INVOICE_OUT", ref=f"F-{month:03d}", lines=lines)
    SALES.append({"ref": f"F-{month:03d}", "date": date, "totalCents": base + quota,
                  "quotaCents": quota, "collectedCents": 0, "accruedCents": 0})

# Abono emitido (T-02) sobre la factura de marzo
ab_base, ab_quota = 60_000, apply_bps(60_000, IVA_BPS)
E("2026-04-05", "NORMAL", "Abono 2026/R01 sobre la factura 2026/003 (descuento posterior)",
  template="ABONO_EMITIDO", source="INVOICE_OUT", ref="AB-001", lines=[
      L("DESCUENTO_PP_VENTAS", debit=ab_base, project=PROJECTS[0]["code"]),
      L("IVA_REPERCUTIDO_PENDIENTE_RECC", debit=ab_quota, tax="IVA_21"),
      L("CLIENTES", credit=ab_base + ab_quota)])

# Anticipos (T-06 y T-07). El anticipo NO es partida monetaria (O-4): 438 y 407
# quedan FUERA de la conversion al tipo de cierre.
ant_base, ant_quota = 200_000, apply_bps(200_000, IVA_BPS)
E("2026-02-05", "NORMAL", "Anticipo de cliente Gamma", template="ANTICIPO_CLIENTE", source="MANUAL",
  ref="ANT-C", lines=[L("BANCO_DEFAULT", debit=ant_base + ant_quota),
                      L("ANTICIPOS_CLIENTES", credit=ant_base),
                      L("IVA_REPERCUTIDO", credit=ant_quota, tax="IVA_21")])
E("2026-02-06", "NORMAL", "Anticipo a proveedor Delta", template="ANTICIPO_PROVEEDOR", source="MANUAL",
  ref="ANT-P", lines=[L("ANTICIPOS_PROVEEDORES", debit=ant_base),
                      L("IVA_SOPORTADO", debit=ant_quota, tax="IVA_21"),
                      L("BANCO_DEFAULT", credit=ant_base + ant_quota)])

# — Facturas recibidas (T-03) — el soportado espera al pago en 4728 —————————
PURCHASES: list[dict[str, Any]] = []
for month in range(1, 13):
    base = 300_000 + month * 5_000
    quota = apply_bps(base, IVA_BPS)
    date = f"2026-{month:02d}-12"
    E(date, "NORMAL", f"Factura recibida P-2026/{month:03d}", template="FACTURA_RECIBIDA",
      source="DOCUMENT", ref=f"P-{month:03d}", lines=[
          L("COMPRAS_DEFAULT", debit=base, cc="CC-OPS"),
          L("IVA_SOPORTADO_PENDIENTE_RECC", debit=quota, tax="IVA_21"),
          L("PROVEEDORES", credit=base + quota, due=add_months_str(date, 1))])
    PURCHASES.append({"ref": f"P-{month:03d}", "date": date, "totalCents": base + quota,
                      "quotaCents": quota})

# Factura recibida con inversion del sujeto pasivo (T-04): NO va por RECC.
isp_base = 240_000
isp_quota = apply_bps(isp_base, IVA_BPS)
E("2026-03-18", "NORMAL", "Factura intracomunitaria con ISP", template="FACTURA_RECIBIDA_ISP",
  source="DOCUMENT", ref="ISP-001", lines=[
      L("629", debit=isp_base, cc="CC-GA"),
      L("IVA_SOPORTADO_ISP", debit=isp_quota, tax="IVA_21"),
      L("ACREEDORES", credit=isp_base),
      L("IVA_REPERCUTIDO_ISP", credit=isp_quota, tax="IVA_21")])

# Abono recibido (T-05)
abr_base, abr_quota = 40_000, apply_bps(40_000, IVA_BPS)
E("2026-05-09", "NORMAL", "Abono recibido de proveedor (devolucion)", template="ABONO_RECIBIDO",
  source="DOCUMENT", ref="ABR-001", lines=[
      L("PROVEEDORES", debit=abr_base + abr_quota),
      L("DEVOLUCION_COMPRAS", credit=abr_base, cc="CC-OPS"),
      L("IVA_SOPORTADO_PENDIENTE_RECC", credit=abr_quota, tax="IVA_21")])

# — Cobros (T-08) y pagos (T-09) con el bloque RECC (O-15) ————————————————
def recc_quota(total_invoice: int, total_quota: int, collected: int, already: int, final: bool) -> int:
    """`trunc(cobro x cuota / total)`, residuo al ultimo (espejo de vat.ts)."""
    if final:
        return total_quota - already
    return min(collected * total_quota // total_invoice, total_quota - already)


for month in range(1, 12):
    sale = SALES[month - 1]
    date = f"2026-{month + 1:02d}-25"
    # La factura de marzo se cobra en DOS veces: el residuo va al ultimo cobro.
    parts = [(sale["totalCents"] // 2, False), (sale["totalCents"] - sale["totalCents"] // 2, True)] \
        if month == 3 else [(sale["totalCents"], True)]
    already = 0
    for index, (amount, final) in enumerate(parts):
        quota = recc_quota(sale["totalCents"], sale["quotaCents"], amount, already, final)
        already += quota
        cobro_date = date if index == 0 else add_months_str(date, 1)
        E(cobro_date, "NORMAL", f"Cobro de la factura {sale['ref']}" + (" (parcial)" if not final and index == 0 else ""),
          template="COBRO_CLIENTE", source="BANK_IMPORT", ref=f"CO-{sale['ref']}-{index + 1}", lines=[
              L("BANCO_DEFAULT", debit=amount),
              L("CLIENTES", credit=amount),
              L("IVA_REPERCUTIDO_PENDIENTE_RECC", debit=quota),
              L("IVA_REPERCUTIDO", credit=quota)])
    sale["accruedCents"] = already

for month in range(1, 12):
    purchase = PURCHASES[month - 1]
    date = f"2026-{month + 1:02d}-10"
    quota = purchase["quotaCents"]
    E(date, "NORMAL", f"Pago de la factura {purchase['ref']}", template="PAGO_PROVEEDOR",
      source="BANK_IMPORT", ref=f"PA-{purchase['ref']}", lines=[
          L("PROVEEDORES", debit=purchase["totalCents"]),
          L("BANCO_DEFAULT", credit=purchase["totalCents"]),
          L("IVA_SOPORTADO", debit=quota),
          L("IVA_SOPORTADO_PENDIENTE_RECC", credit=quota)])

# — Nomina (T-10) y sus pagos (T-11, T-12, T-13) ——————————————————————————
GROSS, EMPLOYER_SS, EMPLOYEE_SS, WITHHOLDING = 300_000, 95_000, 19_000, 45_000
NET = GROSS - EMPLOYEE_SS - WITHHOLDING
for month in range(1, 13):
    date = month_end(2026, month)
    E(date, "NORMAL", f"Nomina {month:02d}/2026", template="NOMINA", source="MANUAL", ref=f"NOM-{month:02d}",
      lines=[L("SUELDOS_DEFAULT", debit=GROSS, cc="CC-GA"),
             L("SS_EMPRESA_DEFAULT", debit=EMPLOYER_SS, cc="CC-GA"),
             L("REMUNERACIONES_PENDIENTES", credit=NET),
             L("SS_ACREEDORA", credit=EMPLOYEE_SS + EMPLOYER_SS),
             L("IRPF_TRABAJO_A_PAGAR", credit=WITHHOLDING, tax="IRPF_TRABAJO")])
    pay_date = add_months_str(date, 1)[:8] + "05"
    if pay_date <= "2026-12-31":
        E(pay_date, "NORMAL", f"Pago de la nomina {month:02d}/2026", template="PAGO_NOMINA",
          source="BANK_IMPORT", ref=f"PN-{month:02d}",
          lines=[L("REMUNERACIONES_PENDIENTES", debit=NET), L("BANCO_DEFAULT", credit=NET)])
        E(pay_date, "NORMAL", f"Pago de la Seguridad Social {month:02d}/2026",
          template="PAGO_SEGURIDAD_SOCIAL", source="BANK_IMPORT", ref=f"PSS-{month:02d}",
          lines=[L("SS_ACREEDORA", debit=EMPLOYEE_SS + EMPLOYER_SS),
                 L("BANCO_DEFAULT", credit=EMPLOYEE_SS + EMPLOYER_SS)])

# — Amortizacion mensual (T-14): una linea por activo, con su `fixedAssetCode` —
def post_depreciation(year: int) -> None:
    for month in range(1, 13):
        period = f"{year:04d}-{month:02d}"
        items: list[Line] = []
        by_accumulated: dict[str, int] = defaultdict(int)
        for asset in FIXED_ASSETS:
            last = last_depreciated_period(asset["code"])
            if last is not None and period > last:
                continue
            quota = quota_of(asset["code"], period)
            if quota == 0:      # R-REC-8: una cuota cero NO genera linea ni asiento
                continue
            items.append(L(asset["expenseAccountCode"], debit=quota, cc=asset["costCenterCode"],
                           asset=asset["code"], desc=f"Dotacion {asset['code']} {period}"))
            by_accumulated[asset["accumulatedAccountCode"]] += quota
        if not items:
            continue
        lines = items + [L(code, credit=amount) for code, amount in sorted(by_accumulated.items())]
        E(month_end(year, month), "NORMAL", f"Amortizacion del inmovilizado {period}",
          template="AMORTIZACION_MENSUAL", source="SYSTEM", ref=f"AM-{period}", lines=lines)


post_depreciation(2026)

# — Periodificaciones (T-15 … T-18) ————————————————————————————————————————
# Prima de seguro del 15/11/2026 al 14/11/2027: 365 dias, 47 en 2026 (R-PE-1).
PRIMA = 10_000_00
PRIMA_2026 = PRIMA * 47 // 365
E("2026-11-15", "NORMAL", "Prima de seguro anual pagada por anticipado",
  template="PERIODIFICACION_GASTO", source="MANUAL", ref="PER-G-01",
  lines=[L("PERIODIFICACION_GASTO", debit=PRIMA - PRIMA_2026),
         L("625", credit=PRIMA - PRIMA_2026, cc="CC-GA")])
E("2026-12-31", "NORMAL", "Devengo de la prima de seguro de diciembre",
  template="DEVENGO_PERIODIFICACION_GASTO", source="MANUAL", ref="PER-G-02",
  lines=[L("625", debit=200_00, cc="CC-GA"), L("PERIODIFICACION_GASTO", credit=200_00)])
E("2026-10-01", "NORMAL", "Mantenimiento facturado por anticipado (ingreso periodificado)",
  template="PERIODIFICACION_INGRESO", source="MANUAL", ref="PER-I-01",
  lines=[L("VENTAS_DEFAULT", debit=300_000, project=PROJECTS[1]["code"]),
         L("PERIODIFICACION_INGRESO", credit=300_000)])
E("2026-12-31", "NORMAL", "Devengo del mantenimiento del cuarto trimestre",
  template="DEVENGO_PERIODIFICACION_INGRESO", source="MANUAL", ref="PER-I-02",
  lines=[L("PERIODIFICACION_INGRESO", debit=100_000),
         L("VENTAS_DEFAULT", credit=100_000, project=PROJECTS[1]["code"])])

# — Ocurrencias recurrentes (kind RECURRING) de tres reglas ————————————————
for month in range(1, 13):
    for rule_code in POSTED_RULES:
        rule = next(r for r in RECURRING_RULES if r["code"] == rule_code)
        if rule["status"] == "PAUSADA":
            continue    # R-REC-5: una regla pausada NO genera ni rellena hacia atras
        E(month_end(2026, month), "RECURRING", f"{rule['name']} {month:02d}/2026",
          template="ASIENTO_MANUAL", source="RECURRING", ref=f"{rule_code}-2026-{month:02d}",
          lines=[L("621", debit=rule["amountCents"], cc=rule["costCenterCode"]),
                 L("ACREEDORES", credit=rule["amountCents"])])

# — Estructurales: traspaso (T-19), manual (T-20), contra-asiento (T-21) ————
E("2026-06-15", "NORMAL", "Traspaso de la cuenta corriente a la caja", template="TRASPASO_TESORERIA",
  source="BANK_IMPORT", ref="TR-001", lines=[L("CAJA", debit=100_000),
                                             L("626", debit=1_500, cc="CC-GA"),
                                             L("BANCO_DEFAULT", credit=101_500)])
E("2026-07-01", "NORMAL", "Reclasificacion manual de un gasto mal imputado",
  template="ASIENTO_MANUAL", source="MANUAL", ref="MAN-001",
  lines=[L("628", debit=45_000, cc="CC-GA"), L("629", credit=45_000, cc="CC-GA")])
E("2026-07-10", "REVERSAL", "Anulacion del asiento MAN-001 (imputacion incorrecta)",
  template="CONTRA_ASIENTO", source="SYSTEM", ref="MAN-001-REV", reverses="MAN-001",
  lines=[L("629", debit=45_000, cc="CC-GA"), L("628", credit=45_000, cc="CC-GA")])

# — T-22: documento cuyo devengo pertenece al ejercicio 2025, ya CERRADO ————
E("2026-03-31", "NORMAL", "Ajuste de gasto no significativo del ejercicio 2025 (NRV 22a)",
  template="AJUSTE_EJERCICIO_CERRADO", source="MANUAL", ref="AJ-2025",
  lines=[L("678", debit=80_000, cc="CC-GA"), L("ACREEDORES", credit=80_000)])

# — T-29: DUA de importacion, modalidad ordinaria (sin diferimiento) ————————
DUA_BASE, DUA_ARANCEL = 12_000_000, 500_000
DUA_QUOTA = apply_bps(DUA_BASE, IVA_BPS)
E("2026-05-22", "NORMAL", "DUA de importacion DUA-2026-0007", template="DUA_IMPORTACION",
  source="DOCUMENT", ref="DUA-001", lines=[
      L("ARANCELES", debit=DUA_ARANCEL, cc="CC-OPS"),
      L("IVA_SOPORTADO", debit=DUA_QUOTA, tax="IVA_21"),
      L("ACREEDORES", credit=DUA_ARANCEL + DUA_QUOTA)])

# — Inmovilizado comprado con aplazamiento > 12 meses (523) ————————————————
MAQ_NOMINAL = 10_000_000
E("2026-03-01", "NORMAL", "Compra de maquinaria con pago aplazado a 24 meses",
  template="FACTURA_RECIBIDA", source="DOCUMENT", ref="INM-001", lines=[
      L("213", debit=MAQ_NOMINAL),
      L("IVA_SOPORTADO", debit=apply_bps(MAQ_NOMINAL, IVA_BPS), tax="IVA_21"),
      L("PROVEEDORES_INMOVILIZADO", credit=MAQ_NOMINAL + apply_bps(MAQ_NOMINAL, IVA_BPS),
        due="2028-03-01")])

# — T-37: alta de los tres prestamos de 2026, con su cuadro ————————————————
def post_loan(schedule: dict[str, Any]) -> None:
    start = schedule["startDate"]
    boundary = add_months_str(start, 12)
    lines = [L("BANCO_DEFAULT", debit=schedule["principalCents"])]
    for inst in sorted(schedule["installments"], key=lambda i: (i["dueDate"], i["seq"])):
        code = schedule["longAccountCode"] if inst["dueDate"] > boundary else schedule["shortAccountCode"]
        lines.append(L(code, credit=inst["principalCents"], due=inst["dueDate"],
                       desc=f"{schedule['code']} vencimiento {inst['seq']:03d}"))
    E(start, "NORMAL", f"Alta del prestamo {schedule['code']} con su cuadro de vencimientos",
      template="ALTA_PRESTAMO", source="MANUAL", ref=f"PRE-{schedule['code']}", lines=lines)


for schedule in DEBT_SCHEDULES[:3]:
    post_loan(schedule)

# — T-33 baja y T-34 venta de inmovilizado (O-24) ——————————————————————————
def disposal_entries() -> None:
    for code, disposal in ASSET_DISPOSALS.items():
        asset = next(a for a in FIXED_ASSETS if a["code"] == code)
        accumulated = accumulated_until(code, disposal["date"][:7])
        cost = asset["costCents"]
        net = cost - accumulated
        if disposal["kind"] == "BAJA":
            lines = [L(asset["accumulatedAccountCode"], debit=accumulated, asset=code)]
            if net > 0:
                lines.append(L("PERDIDA_BAJA_INMOVILIZADO", debit=net, cc=asset["costCenterCode"], asset=code))
            lines.append(L(asset["assetAccountCode"], credit=cost, asset=code))
            E(disposal["date"], "NORMAL", f"Baja del inmovilizado {code}", template="BAJA_INMOVILIZADO",
              source="SYSTEM", ref=f"BAJA-{code}", lines=lines)
        else:
            price = disposal["priceCents"]
            quota = apply_bps(price, disposal["vatBps"])
            result = price - net
            # R-AM-7: la contrapartida es 543, NUNCA 430.
            lines = [L("CREDITO_ENAJENACION_CP", debit=price + quota, due="2027-04-30"),
                     L(asset["accumulatedAccountCode"], debit=accumulated, asset=code)]
            if result < 0:
                lines.append(L("PERDIDA_BAJA_INMOVILIZADO", debit=-result, cc=asset["costCenterCode"], asset=code))
            lines.append(L(asset["assetAccountCode"], credit=cost, asset=code))
            lines.append(L("IVA_REPERCUTIDO", credit=quota, tax="IVA_21"))
            if result > 0:
                lines.append(L("BENEFICIO_BAJA_INMOVILIZADO", credit=result, cc=asset["costCenterCode"], asset=code))
            E(disposal["date"], "NORMAL", f"Venta del inmovilizado {code}", template="VENTA_INMOVILIZADO",
              source="DOCUMENT", ref=f"VENTA-{code}", lines=lines)


disposal_entries()

# — T-23 liquidacion trimestral del IVA y T-24 su pago ————————————————————
QUARTER_END_V2 = {1: "2026-03-31", 2: "2026-06-30", 3: "2026-09-30", 4: "2026-12-31"}
QUARTER_PAY_V2 = {1: "2026-04-20", 2: "2026-07-20", 3: "2026-10-20"}
IVA_PERIODS_V2: list[dict[str, Any]] = []


def settle_vat(quarter: int, seq: int = 5) -> None:
    """R-IVA-9: la liquidacion sale del LIBRO, y los saldos la verifican. Aqui el
    fixture es el libro: `477` y `472` recogen ya solo lo devengado y deducido."""
    end = QUARTER_END_V2[quarter]
    start = f"2026-{(quarter - 1) * 3 + 1:02d}-01"
    # I-E9-8a': el resultado del periodo es lo EFECTIVAMENTE devengado menos lo
    # efectivamente deducible; `4728` y `4778` conservan saldo y NO se barren.
    repercutido = sum(ln["creditCents"] - ln["debitCents"] for e in b.entries
                      if start <= e["date"] <= end
                      for ln in e["lines"] if b.code_of(ln) == "477")
    soportado = sum(ln["debitCents"] - ln["creditCents"] for e in b.entries
                    if start <= e["date"] <= end
                    for ln in e["lines"] if b.code_of(ln) == "472")
    resultado = repercutido - soportado
    lines = [L("IVA_REPERCUTIDO", debit=repercutido), L("IVA_SOPORTADO", credit=soportado)]
    if resultado > 0:
        lines.append(L("HP_ACREEDORA_IVA", credit=resultado))
    elif resultado < 0:
        lines.append(L("HP_DEUDORA_IVA", debit=-resultado))
    E(end, "NORMAL", f"Liquidacion de IVA {quarter}T 2026 (modelo 303)", template="REGULARIZACION_IVA",
      source="SYSTEM", ref=f"IVA-Q{quarter}", seq=seq, lines=lines)
    IVA_PERIODS_V2.append({"period": f"2026-Q{quarter}", "repercutidoCents": repercutido,
                           "soportadoCents": soportado, "resultadoCents": resultado})
    if resultado > 0 and quarter in QUARTER_PAY_V2:
        E(QUARTER_PAY_V2[quarter], "NORMAL", f"Pago del modelo 303 {quarter}T 2026",
          template="PAGO_IMPUESTO", source="BANK_IMPORT", ref=f"P-IVA-Q{quarter}",
          lines=[L("HP_ACREEDORA_IVA", debit=resultado), L("BANCO_DEFAULT", credit=resultado)])


for quarter in (1, 2, 3):
    settle_vat(quarter)

# Pago trimestral de retenciones (T-13)
for quarter in (1, 2, 3):
    end = QUARTER_END_V2[quarter]
    # Saldo VIVO de 4751 a fin de trimestre: acumulado menos lo ya ingresado.
    saldo = sum(ln["creditCents"] - ln["debitCents"] for e in b.entries
                if e["date"] <= end
                for ln in e["lines"] if b.code_of(ln) == "4751")
    E(QUARTER_PAY_V2[quarter], "NORMAL", f"Pago de retenciones {quarter}T 2026 (modelo 111)",
      template="PAGO_RETENCIONES", source="BANK_IMPORT", ref=f"P-IRPF-Q{quarter}",
      lines=[L("IRPF_A_PAGAR", debit=saldo), L("BANCO_DEFAULT", credit=saldo)])

# — Ajustes de cierre, en el ORDEN de O-17 ————————————————————————————————
# 2 devengo del RECC · 5 valor actual · 6 diferencias de cambio ·
# 7 reclasificacion · 8 ultima liquidacion · 9 impuesto · 10 T-26 · 11 T-27.

# (2) T-36 · barrido del art. 163 terdecies: la factura 2025/088 de la apertura.
RECC_SWEEP = 210_000
E("2026-12-31", "NORMAL", "Devengo del RECC pendiente a 31/12/2026 (art. 163 terdecies LIVA)",
  template="DEVENGO_RECC", source="SYSTEM", ref="RECC-2026", seq=1,
  lines=[L("IVA_REPERCUTIDO_PENDIENTE_RECC", debit=RECC_SWEEP),
         L("IVA_REPERCUTIDO", credit=RECC_SWEEP)])

# (5) T-31 · el valor actual del aplazamiento es VALORACION INICIAL (O-1), y esto
# es el plan de correccion del caso A: la maquinaria de marzo se compro con un
# aplazamiento de 24 meses al 6 % efectivo y se activo por su NOMINAL.
PV_DISCOUNT = 1_100_036          # 10 000 000 - 8 899 964
PV_EXCESS = 183_340              # amortizacion dotada de mas sobre el coste bruto
PV_INTEREST = 454_133            # interes implicito devengado de marzo a diciembre
E("2026-12-31", "NORMAL", "Ajuste al valor actual del aplazamiento de la maquinaria (NRV 2a.1)",
  template="AJUSTE_VALOR_ACTUAL", source="SYSTEM", ref="VA-2026", seq=2, lines=[
      L("PROVEEDORES_INMOVILIZADO", debit=PV_DISCOUNT),
      L("213", credit=PV_DISCOUNT),
      L("2813", debit=PV_EXCESS),
      L("681", credit=PV_EXCESS, cc="CC-OPS"),
      L("INTERESES_DEUDAS", debit=PV_INTEREST, cc="CC-FIN"),
      L("PROVEEDORES_INMOVILIZADO", credit=PV_INTEREST)])

# (6) T-30 · diferencias de cambio SOLO de partidas monetarias (O-4). Los
# anticipos 407 y 438 estan declarados y quedan FUERA: no dan derecho a recibir
# ni obligan a entregar un importe fijo de efectivo.
def convert_micro(cents: int, rate_micro: int) -> int:
    """Espejo de `lib/money.ts::convertWithRateMicro` (half-even sobre magnitud)."""
    product = abs(cents) * rate_micro
    quotient, remainder = divmod(product, 1_000_000)
    if remainder * 2 > 1_000_000 or (remainder * 2 == 1_000_000 and quotient % 2 == 1):
        quotient += 1
    return (-1 if cents < 0 else 1) * quotient


FX_RATE_DATE = "2026-12-30"      # R-FX-5: el 31 es festivo TARGET; vale la ultima publicada
FX_POSITIONS = [
    {"accountCode": "4300", "currency": "USD", "isMonetary": True,
     "currencyBalanceCents": 350_000, "baseBalanceCents": 322_000, "rateMicro": 940_000},
    {"accountCode": "4000", "currency": "USD", "isMonetary": True,
     "currencyBalanceCents": -500_000, "baseBalanceCents": -460_000, "rateMicro": 900_000},
    {"accountCode": "572", "currency": "GBP", "isMonetary": True,
     "currencyBalanceCents": 200_000, "baseBalanceCents": 236_000, "rateMicro": 1_150_000},
    {"accountCode": "407", "currency": "USD", "isMonetary": False,
     "currencyBalanceCents": 200_000, "baseBalanceCents": 186_000, "rateMicro": 940_000},
    {"accountCode": "438", "currency": "USD", "isMonetary": False,
     "currencyBalanceCents": -200_000, "baseBalanceCents": -188_000, "rateMicro": 940_000},
]
for position in FX_POSITIONS:
    position["rateDate"] = FX_RATE_DATE
    position["deltaCents"] = (convert_micro(position["currencyBalanceCents"], position["rateMicro"])
                              - position["baseBalanceCents"]) if position["isMonetary"] else 0

fx_lines: list[Line] = []
fx_gain = sum(p["deltaCents"] for p in FX_POSITIONS if p["deltaCents"] > 0)
fx_loss = -sum(p["deltaCents"] for p in FX_POSITIONS if p["deltaCents"] < 0)
for position in sorted((p for p in FX_POSITIONS if p["deltaCents"] != 0),
                       key=lambda p: (p["accountCode"], p["currency"])):
    delta = position["deltaCents"]
    fx_lines.append(L(position["accountCode"], debit=max(delta, 0), credit=max(-delta, 0),
                      currency=position["currency"], original=0,
                      rate=f"rate-{position['currency']}-{FX_RATE_DATE}",
                      desc=f"Diferencia de cambio al cierre {position['currency']} (tasa de {FX_RATE_DATE})"))
if fx_loss:
    fx_lines.append(L("DIFERENCIA_CAMBIO_NEGATIVA", debit=fx_loss, cc="CC-FIN"))
if fx_gain:
    fx_lines.append(L("DIFERENCIA_CAMBIO_POSITIVA", credit=fx_gain, cc="CC-FIN"))
E("2026-12-31", "NORMAL", "Diferencias de cambio al cierre de 2026 (NRV 11a.2.2)",
  template="DIFERENCIAS_CAMBIO_CIERRE", source="SYSTEM", ref="FX-2026", seq=3, lines=fx_lines)

# (7) T-32 · reclasificacion corriente / no corriente. La frontera se mide desde
# el CIERRE (R-RC-1), y por eso el mismo saldo viaja 520 -> 170 un ano y al reves
# al siguiente. Suma cero por par (I-E9-16).
CUTOFF_2026 = "2026-12-31"
BOUNDARY_2026 = "2027-12-31"
reclass_moves: list[dict[str, Any]] = []
for schedule in DEBT_SCHEDULES[:3]:
    boundary_alta = add_months_str(schedule["startDate"], 12)
    to_short = sum(i["principalCents"] for i in schedule["installments"]
                   if i["dueDate"] > boundary_alta and i["dueDate"] <= BOUNDARY_2026)
    if to_short:
        reclass_moves.append({"code": schedule["code"], "from": schedule["longAccountCode"],
                              "to": schedule["shortAccountCode"], "amountCents": to_short,
                              "side": "PASIVO"})
# El proveedor de inmovilizado: 523 -> 173 por el vencimiento de 2028 (Q-11b).
INMOV_LARGO = MAQ_NOMINAL + apply_bps(MAQ_NOMINAL, IVA_BPS) - PV_DISCOUNT + PV_INTEREST
reclass_moves.append({"code": "INM-001", "from": "523", "to": "173",
                      "amountCents": INMOV_LARGO, "side": "PASIVO"})

reclass_lines: list[Line] = []
for move in sorted(reclass_moves, key=lambda m: (m["from"], m["to"], m["code"])):
    reclass_lines.append(L(move["from"], debit=move["amountCents"],
                           desc=f"Reclasificacion {move['code']} {move['from']} -> {move['to']}"))
    reclass_lines.append(L(move["to"], credit=move["amountCents"],
                           desc=f"Reclasificacion {move['code']} {move['from']} -> {move['to']}"))
E(CUTOFF_2026, "NORMAL", "Reclasificacion de deudas por vencimiento a 31/12/2026 (norma 6a)",
  template="RECLASIFICACION_VENCIMIENTOS", source="SYSTEM", ref="RC-2026", seq=4, lines=reclass_lines)

# (8) ultima liquidacion del ejercicio, ya con el RECC devengado
settle_vat(4, seq=5)

# (9-11) T-25 con la cancelacion OBLIGATORIA de 473 (O-26), T-26 y T-27.
PREPAYMENTS_2026 = b.balance("473", fy="2026")
CLOSE_2026 = b.regularize_and_close("2026", "2026-12-31", is_bps=IS_BPS_V2,
                                    prepayments=PREPAYMENTS_2026)

# ---------------------------------------------------------------------------
# Ejercicio 2027 — encadenado con el anterior (O-8)
# ---------------------------------------------------------------------------
# 1.o APERTURA (T-28), 2.o contra-asiento de la reclasificacion (T-21 de T-32).
b.open_from(CLOSE_2026, "2027-01-01", "2027")
E("2027-01-01", "REVERSAL", "Contra-asiento de la reclasificacion por vencimiento de 2026",
  template="CONTRA_ASIENTO", source="SYSTEM", ref="RC-2026-REV", reverses="RC-2026", seq=-1,
  lines=[L(ln.get("accountCode", ""), debit=ln["creditCents"], credit=ln["debitCents"],
           desc="Reversion de la reclasificacion de 2026")
         for ln in reclass_lines])

# T-35 · distribucion del resultado acordada por la junta (arts. 164 y 274 LSC).
BENEFICIO_2026 = -CLOSE_2026.get("129", 0)
CAPITAL = -CLOSE_2026.get("100", 0)
RESERVA_LEGAL_PREVIA = -CLOSE_2026.get("112", 0)
# Reserva legal = min(10 % del beneficio, 20 % del capital - saldo actual).
RESERVA_LEGAL_DOTACION = max(0, min(BENEFICIO_2026 // 10, CAPITAL * 20 // 100 - RESERVA_LEGAL_PREVIA))
DIVIDENDO = 500_000 if BENEFICIO_2026 - RESERVA_LEGAL_DOTACION > 500_000 else 0
RESERVAS_VOLUNTARIAS_DOTACION = BENEFICIO_2026 - RESERVA_LEGAL_DOTACION - DIVIDENDO
distribucion_lines = [L("RESULTADO_EJERCICIO", debit=BENEFICIO_2026)]
if RESERVA_LEGAL_DOTACION:
    distribucion_lines.append(L("RESERVA_LEGAL", credit=RESERVA_LEGAL_DOTACION))
if RESERVAS_VOLUNTARIAS_DOTACION:
    distribucion_lines.append(L("RESERVAS_VOLUNTARIAS", credit=RESERVAS_VOLUNTARIAS_DOTACION))
if DIVIDENDO:
    distribucion_lines.append(L("DIVIDENDO_ACTIVO_A_PAGAR", credit=DIVIDENDO))
E("2027-06-25", "NORMAL", "Distribucion del resultado de 2026 (junta general ordinaria)",
  template="DISTRIBUCION_RESULTADO", source="SYSTEM", ref="DIST-2026", lines=distribucion_lines)
if DIVIDENDO:
    RETENCION_DIVIDENDO = apply_bps(DIVIDENDO, 1900)
    E("2027-07-10", "NORMAL", "Pago del dividendo acordado, con retencion del 19 %",
      template="ASIENTO_MANUAL", source="BANK_IMPORT", ref="DIV-PAGO",
      lines=[L("DIVIDENDO_ACTIVO_A_PAGAR", debit=DIVIDENDO),
             L("IRPF_A_PAGAR_123", credit=RETENCION_DIVIDENDO),
             L("BANCO_DEFAULT", credit=DIVIDENDO - RETENCION_DIVIDENDO)])

# Operativa de 2027: ventas, compras, amortizacion, el cuarto prestamo y cierre.
for month in range(1, 13):
    base = 1_600_000 + month * 25_000
    quota = apply_bps(base, IVA_BPS)
    date = f"2027-{month:02d}-20"
    E(date, "NORMAL", f"Factura emitida 2027/{month:03d}", template="FACTURA_EMITIDA_SERVICIOS",
      source="INVOICE_OUT", ref=f"F27-{month:03d}", lines=[
          L("CLIENTES", debit=base + quota, due=add_months_str(date, 2)),
          L("VENTAS_DEFAULT", credit=base, project=PROJECTS[month % 3]["code"]),
          L("IVA_REPERCUTIDO_PENDIENTE_RECC", credit=quota, tax="IVA_21")])
    E(f"2027-{month:02d}-28", "NORMAL", f"Cobro de la factura 2027/{month:03d}",
      template="COBRO_CLIENTE", source="BANK_IMPORT", ref=f"CO27-{month:03d}", lines=[
          L("BANCO_DEFAULT", debit=base + quota),
          L("CLIENTES", credit=base + quota),
          L("IVA_REPERCUTIDO_PENDIENTE_RECC", debit=quota),
          L("IVA_REPERCUTIDO", credit=quota)])
    compra = 350_000 + month * 6_000
    compra_quota = apply_bps(compra, IVA_BPS)
    E(f"2027-{month:02d}-12", "NORMAL", f"Factura recibida P-2027/{month:03d}",
      template="FACTURA_RECIBIDA", source="DOCUMENT", ref=f"P27-{month:03d}", lines=[
          L("COMPRAS_DEFAULT", debit=compra, cc="CC-OPS"),
          L("IVA_SOPORTADO_PENDIENTE_RECC", debit=compra_quota, tax="IVA_21"),
          L("PROVEEDORES", credit=compra + compra_quota)])
    E(f"2027-{month:02d}-22", "NORMAL", f"Pago de la factura P-2027/{month:03d}",
      template="PAGO_PROVEEDOR", source="BANK_IMPORT", ref=f"PA27-{month:03d}", lines=[
          L("PROVEEDORES", debit=compra + compra_quota),
          L("BANCO_DEFAULT", credit=compra + compra_quota),
          L("IVA_SOPORTADO", debit=compra_quota),
          L("IVA_SOPORTADO_PENDIENTE_RECC", credit=compra_quota)])

post_depreciation(2027)
post_loan(DEBT_SCHEDULES[3])

# Liquidacion trimestral de 2027 (T-23), derivada del libro igual que en 2026.
IVA_PERIODS_2027: list[dict[str, Any]] = []
for quarter in range(1, 5):
    end = {1: "2027-03-31", 2: "2027-06-30", 3: "2027-09-30", 4: "2027-12-31"}[quarter]
    start = f"2027-{(quarter - 1) * 3 + 1:02d}-01"
    repercutido = sum(ln["creditCents"] - ln["debitCents"] for e in b.entries
                      if start <= e["date"] <= end
                      for ln in e["lines"] if b.code_of(ln) == "477")
    soportado = sum(ln["debitCents"] - ln["creditCents"] for e in b.entries
                    if start <= e["date"] <= end
                    for ln in e["lines"] if b.code_of(ln) == "472")
    resultado = repercutido - soportado
    lines = [L("IVA_REPERCUTIDO", debit=repercutido), L("IVA_SOPORTADO", credit=soportado)]
    lines.append(L("HP_ACREEDORA_IVA", credit=resultado) if resultado > 0
                 else L("HP_DEUDORA_IVA", debit=-resultado))
    E(end, "NORMAL", f"Liquidacion de IVA {quarter}T 2027 (modelo 303)", template="REGULARIZACION_IVA",
      source="SYSTEM", ref=f"IVA27-Q{quarter}", seq=5, lines=lines)
    IVA_PERIODS_2027.append({"period": f"2027-Q{quarter}", "repercutidoCents": repercutido,
                             "soportadoCents": soportado, "resultadoCents": resultado})

CLOSE_2027 = b.regularize_and_close("2027", "2027-12-31", is_bps=IS_BPS_V2)


# ---------------------------------------------------------------------------
# Organizacion 2 — «Fixture Prorrata SL»: prorrata general e inmovilizado
# ---------------------------------------------------------------------------
# Periodo MENSUAL (exigido por el diferimiento del IVA a la importacion, art.
# 74.1 RIVA) y bien de inversion por encima del umbral del art. 108 LIVA: es la
# organizacion que activa la guardia de R-IVA-16.

b2 = Book({"2026": ("2026-01-01", "2026-12-31")})
L2, E2 = b2.L, b2.E

PRORRATA_PROVISIONAL_BPS = 8000
PRORRATA_NUMERADOR = 8_700_000
PRORRATA_DENOMINADOR = 10_000_000
# R-IVA-11: porcentaje ENTERO redondeado al ALZA (art. 104.Dos.2a).
PRORRATA_DEFINITIVA_BPS = -(-PRORRATA_NUMERADOR * 100 // PRORRATA_DENOMINADOR) * 100

BIEN_INVERSION = 1_200_000       # > 300 506 c: bien de inversion del art. 108 LIVA

apertura2 = [
    L2("BANCO_DEFAULT", debit=2_000_000),
    L2("CLIENTES", debit=600_000),
    L2("100", credit=2_000_000),
]
plug2 = sum(x["debitCents"] for x in apertura2) - sum(x["creditCents"] for x in apertura2)
apertura2.append(L2("REMANENTE", credit=plug2) if plug2 > 0 else L2("REMANENTE", debit=-plug2))
E2("2026-01-01", "OPENING", "Apertura del ejercicio 2026", template="APERTURA_EJERCICIO",
   source="SYSTEM", ref="AP2-2026", lines=apertura2)

PRORRATEABLE_QUOTA = 0
for month in range(1, 13):
    # Ventas: una parte sujeta y no exenta (con derecho a deduccion) y otra
    # exenta del art. 20 (sin derecho): son numerador y denominador (O-10).
    base_sujeta, base_exenta = 725_000, 108_333
    quota = apply_bps(base_sujeta, IVA_BPS)
    E2(f"2026-{month:02d}-20", "NORMAL", f"Factura emitida 2026/{month:03d} (sujeta y exenta)",
       template="FACTURA_EMITIDA_SERVICIOS", source="INVOICE_OUT", ref=f"F2-{month:03d}", lines=[
           L2("CLIENTES", debit=base_sujeta + base_exenta + quota),
           L2("VENTAS_DEFAULT", credit=base_sujeta, project=PROJECTS[0]["code"]),
           L2("VENTAS_DEFAULT", credit=base_exenta, project=PROJECTS[0]["code"]),
           L2("IVA_REPERCUTIDO", credit=quota, tax="IVA_21")])

    # Compras sometidas a prorrata: lo no deducible es MAYOR GASTO (art. 99).
    compra = 200_000
    compra_quota = apply_bps(compra, IVA_BPS)
    deducible = compra_quota * PRORRATA_PROVISIONAL_BPS // 10_000
    PRORRATEABLE_QUOTA += compra_quota
    E2(f"2026-{month:02d}-12", "NORMAL", f"Factura recibida P-2026/{month:03d} (prorrata)",
       template="FACTURA_RECIBIDA", source="DOCUMENT", ref=f"P2-{month:03d}", lines=[
           L2("COMPRAS_DEFAULT", debit=compra + compra_quota - deducible, cc="CC-OPS"),
           L2("IVA_SOPORTADO", debit=deducible, tax="IVA_21"),
           L2("PROVEEDORES", credit=compra + compra_quota)])

# Bien de inversion del art. 108 LIVA, con DUA de importacion CON DIFERIMIENTO
# (art. 167.Dos LIVA): la cuota se autoliquida y solo el arancel se paga.
DUA2_BASE, DUA2_ARANCEL = BIEN_INVERSION, 60_000
DUA2_QUOTA = apply_bps(DUA2_BASE, IVA_BPS)
DUA2_DEDUCIBLE = DUA2_QUOTA * PRORRATA_PROVISIONAL_BPS // 10_000
E2("2026-04-15", "NORMAL", "Compra de maquinaria importada (bien de inversion)",
   template="FACTURA_RECIBIDA", source="DOCUMENT", ref="INM2-001", lines=[
       L2("213", debit=BIEN_INVERSION),
       L2("PROVEEDORES_INMOVILIZADO", credit=BIEN_INVERSION, due="2026-10-15")])
E2("2026-04-20", "NORMAL", "DUA de importacion con diferimiento (art. 167.Dos LIVA)",
   template="DUA_IMPORTACION", source="DOCUMENT", ref="DUA2-001", lines=[
       L2("213", debit=DUA2_ARANCEL),
       L2("IVA_SOPORTADO", debit=DUA2_DEDUCIBLE, tax="IVA_21"),
       L2("COMPRAS_DEFAULT", debit=DUA2_QUOTA - DUA2_DEDUCIBLE, cc="CC-OPS"),
       L2("IVA_REPERCUTIDO", credit=DUA2_QUOTA, tax="IVA_21"),
       L2("ACREEDORES", credit=DUA2_ARANCEL)])

# Amortizacion del bien de inversion (8 meses, mayo a diciembre, vida 120 meses).
BIEN_BASE = BIEN_INVERSION + DUA2_ARANCEL
BIEN_CUOTA = BIEN_BASE // 120
for month in range(5, 13):
    E2(month_end(2026, month), "NORMAL", f"Amortizacion del inmovilizado 2026-{month:02d}",
       template="AMORTIZACION_MENSUAL", source="SYSTEM", ref=f"AM2-{month:02d}",
       lines=[L2("681", debit=BIEN_CUOTA, cc="CC-OPS"), L2("2813", credit=BIEN_CUOTA)])

# Liquidacion MENSUAL (T-23)
VAT_PERIODS_ORG2: list[dict[str, Any]] = []
for month in range(1, 13):
    end = month_end(2026, month)
    start = f"2026-{month:02d}-01"
    repercutido = sum(ln["creditCents"] - ln["debitCents"] for e in b2.entries
                      if start <= e["date"] <= end
                      for ln in e["lines"] if b2.code_of(ln) == "477")
    soportado = sum(ln["debitCents"] - ln["creditCents"] for e in b2.entries
                    if start <= e["date"] <= end
                    for ln in e["lines"] if b2.code_of(ln) == "472")
    # R-IVA-15 (O-11): la regularizacion de la prorrata definitiva cae DENTRO del
    # ultimo periodo del ano y ANTES de su liquidacion (art. 105.Uno).
    if month == 12:
        adjustment = (PRORRATEABLE_QUOTA * PRORRATA_DEFINITIVA_BPS // 10_000
                      - PRORRATEABLE_QUOTA * PRORRATA_PROVISIONAL_BPS // 10_000)
        if adjustment != 0:
            E2("2026-12-31", "NORMAL",
               "Regularizacion de la prorrata definitiva 2026 (art. 105.Uno LIVA)",
               template="ASIENTO_MANUAL", source="SYSTEM", ref="PRORRATA-2026", seq=1,
               lines=[L2("IVA_SOPORTADO", debit=adjustment),
                      L2("AJUSTE_PRORRATA_POSITIVO", credit=adjustment, cc="CC-GA")]
               if adjustment > 0 else
               [L2("AJUSTE_PRORRATA_NEGATIVO", debit=-adjustment, cc="CC-GA"),
                L2("IVA_SOPORTADO", credit=-adjustment)])
            soportado += adjustment
    resultado = repercutido - soportado
    lines = [L2("IVA_REPERCUTIDO", debit=repercutido), L2("IVA_SOPORTADO", credit=soportado)]
    lines.append(L2("HP_ACREEDORA_IVA", credit=resultado) if resultado > 0
                 else L2("HP_DEUDORA_IVA", debit=-resultado))
    E2(end, "NORMAL", f"Liquidacion de IVA {month:02d}/2026 (modelo 303 mensual)",
       template="REGULARIZACION_IVA", source="SYSTEM", ref=f"IVA2-{month:02d}", seq=2, lines=lines)
    VAT_PERIODS_ORG2.append({"period": f"2026-{month:02d}", "repercutidoCents": repercutido,
                             "soportadoCents": soportado, "resultadoCents": resultado})

CLOSE_ORG2 = b2.regularize_and_close("2026", "2026-12-31", is_bps=IS_BPS_V2)


# ---------------------------------------------------------------------------
# Numeracion, comprobaciones y bloque `expected` del fixture v2
# ---------------------------------------------------------------------------

ENTRIES_V2 = b.numbered()
ENTRIES_ORG2 = b2.numbered()

# I1 · I7 · I8 (ya comprobados al construir) + las de E9:
# I-E9-5  la amortizacion acumulada de CADA activo coincide con su cuadro
for asset in FIXED_ASSETS:
    posted_quota = sum(ln["debitCents"] for e in ENTRIES_V2 for ln in e["lines"]
                       if ln.get("fixedAssetCode") == asset["code"] and ln["debitCents"] > 0
                       and e["template"] == "AMORTIZACION_MENSUAL")
    last = last_depreciated_period(asset["code"])
    # Solo lo DOTADO en el diario: lo anterior a 2026 vive en la apertura.
    expected_quota = sum(r["quotaCents"] for r in SCHEDULES[asset["code"]]
                         if "2026-01" <= r["period"] <= (last or "2027-12"))
    assert posted_quota == expected_quota, \
        f"I-E9-5 roto en {asset['code']}: diario {posted_quota} vs cuadro {expected_quota}"

# I-E9-16 · la reclasificacion suma cero por par
for move in reclass_moves:
    pass
assert sum(ln["debitCents"] - ln["creditCents"] for ln in reclass_lines) == 0, "I-E9-16 roto"

# I-E9-26 · toda factura en RECC saldada tiene devengada su cuota INTEGRA
for sale in SALES[:11]:
    assert sale["accruedCents"] == sale["quotaCents"], f"I-E9-26 roto en {sale['ref']}"

# I2 · Activo = Pasivo + PN antes del cierre, en los dos ejercicios y las dos orgs
for book, years in ((b, ("2026", "2027")), (b2, ("2026",))):
    for year in years:
        diff = sum(v for k, v in book.balance_sheet(year).items())
        assert diff == 0, f"I2 roto en {year}: {diff}"

# I3 · resultado de la PyG = saldo de la 129
for book, years in ((b, ("2026", "2027")), (b2, ("2026",))):
    for year in years:
        pyg_total = sum(book.pyg(year).values())
        saldo_129 = -sum(ln["debitCents"] - ln["creditCents"] for e in book.entries
                         if e["fiscalYearCode"] == year and e["kind"] != "CLOSING"
                         for ln in e["lines"] if book.code_of(ln) == "129")
        assert saldo_129 == pyg_total, f"I3 roto en {year}: {saldo_129} vs {pyg_total}"


def coverage(entries: list[Entry]) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for e in entries:
        out[e.get("template", "SIN_PLANTILLA")] += 1
    return dict(sorted(out.items()))


TEMPLATE_COVERAGE_V2 = coverage(ENTRIES_V2)
assert len(TEMPLATE_COVERAGE_V2) == 37, \
    f"I-E3-5: cobertura {len(TEMPLATE_COVERAGE_V2)}/37 — faltan {37 - len(TEMPLATE_COVERAGE_V2)}"

TRACKED_V2 = ["100", "112", "113", "120", "129", "170", "173", "213", "216", "217", "2813", "2816",
              "2817", "253", "4000", "407", "4100", "4300", "438", "4700", "4750", "4751", "4752",
              "465", "472", "4728", "476", "477", "4778", "480", "485", "5200", "523", "526", "543",
              "570", "572", "473"]


def leaf_balances(book: Book, year: str, exclude: set[str]) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for e in book.entries:
        if e["fiscalYearCode"] != year or e["kind"] in exclude:
            continue
        for ln in e["lines"]:
            out[book.code_of(ln)] += ln["debitCents"] - ln["creditCents"]
    return {k: v for k, v in sorted(out.items()) if v != 0}


def prefix3(book: Book, year: str) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for e in book.entries:
        if e["fiscalYearCode"] != year or e["kind"] == "CLOSING":
            continue
        for ln in e["lines"]:
            out[book.code_of(ln)[:3]] += ln["debitCents"] - ln["creditCents"]
    return {k: v for k, v in sorted(out.items()) if v != 0}


def totals_of(entries: list[Entry], year: str | None = None) -> tuple[int, int]:
    d = c = 0
    for e in entries:
        if year and e["fiscalYearCode"] != year:
            continue
        d += sum(x["debitCents"] for x in e["lines"])
        c += sum(x["creditCents"] for x in e["lines"])
    return d, c


balances_2026 = leaf_balances(b, "2026", {"CLOSING"})
balances_2027 = leaf_balances(b, "2027", {"CLOSING"})
deb_v2, cre_v2 = totals_of(ENTRIES_V2)
assert deb_v2 == cre_v2

# Deuda a corto y a largo DESPUES de la reclasificacion: es lo que el balance
# presenta y lo primero que un auditor comprueba (O-6, R12).
DEUDA_CORTO_2026 = -sum(v for k, v in balances_2026.items() if k in ("5200", "523"))
DEUDA_LARGO_2026 = -sum(v for k, v in balances_2026.items() if k in ("170", "173"))

EXPECTED_V2: dict[str, Any] = {
    "entryCount": len(ENTRIES_V2),
    "entryCount2026": sum(1 for e in ENTRIES_V2 if e["fiscalYearCode"] == "2026"),
    "entryCount2027": sum(1 for e in ENTRIES_V2 if e["fiscalYearCode"] == "2027"),
    "totalDebitCents": deb_v2,
    "totalCreditCents": cre_v2,
    "totalDebitCents2026": totals_of(ENTRIES_V2, "2026")[0],
    "totalDebitCents2027": totals_of(ENTRIES_V2, "2027")[0],
    "resultado2026Cents": CLOSE_2026.get("129", 0) * -1,
    "resultado2027Cents": CLOSE_2027.get("129", 0) * -1,
    "impuesto2026Cents": b.balance("6300", fy="2026", exclude={"REGULARIZATION", "CLOSING"}),
    "prepayments2026Cents": PREPAYMENTS_2026,
    "balancesBeforeClosing2026Cents": {c: balances_2026.get(c, 0) for c in TRACKED_V2},
    "balancesBeforeClosing2027Cents": {c: balances_2027.get(c, 0) for c in TRACKED_V2},
    "balancesByPrefix3Cents2026": prefix3(b, "2026"),
    "templateCoverage": TEMPLATE_COVERAGE_V2,
    "templateCoverageCount": len(TEMPLATE_COVERAGE_V2),
    "ivaPeriods2026": IVA_PERIODS_V2,
    "ivaPeriods2027": IVA_PERIODS_2027,
    "reccSweepCents": RECC_SWEEP,
    "reccPendingAt20261231Cents": -balances_2026.get("4778", 0),
    "depreciation": {
        "assets": len(FIXED_ASSETS),
        "quota2026Cents": sum(ln["debitCents"] for e in ENTRIES_V2 for ln in e["lines"]
                              if e["template"] == "AMORTIZACION_MENSUAL"
                              and e["fiscalYearCode"] == "2026" and ln["debitCents"] > 0),
        "quota2027Cents": sum(ln["debitCents"] for e in ENTRIES_V2 for ln in e["lines"]
                              if e["template"] == "AMORTIZACION_MENSUAL"
                              and e["fiscalYearCode"] == "2027" and ln["debitCents"] > 0),
        "zeroQuotaAssetCode": "AF-300",
        "zeroQuotaPeriods": sum(1 for r in SCHEDULES["AF-300"] if r["quotaCents"] == 0),
        "revisedAssetCode": "AF-002",
        "revisedRows": len(SCHEDULES["AF-002"]),
        "soldAssetCode": "AF-003",
        "disposedAssetCode": "AF-004",
    },
    "presentValue": {"discountCents": PV_DISCOUNT, "excessDepreciationCents": PV_EXCESS,
                     "implicitInterestCents": PV_INTEREST},
    "fx": {"rateDate": FX_RATE_DATE, "gainCents": fx_gain, "lossCents": fx_loss,
           "monetaryPositions": sum(1 for p in FX_POSITIONS if p["isMonetary"]),
           "nonMonetaryPositions": sum(1 for p in FX_POSITIONS if not p["isMonetary"])},
    "reclassification": {"moves": len(reclass_moves), "netCents": 0,
                         "deudaCortoPlazoCents": DEUDA_CORTO_2026,
                         "deudaLargoPlazoCents": DEUDA_LARGO_2026},
    "distribution": {"profitCents": BENEFICIO_2026, "capitalCents": CAPITAL,
                     "legalReserveBeforeCents": RESERVA_LEGAL_PREVIA,
                     "legalReserveCents": RESERVA_LEGAL_DOTACION,
                     "voluntaryReserveCents": RESERVAS_VOLUNTARIAS_DOTACION,
                     "dividendCents": DIVIDENDO},
    "loans": [{"code": s["code"], "principalCents": s["principalCents"],
               "installments": len(s["installments"])} for s in DEBT_SCHEDULES],
    "recurringRules": {"total": len(RECURRING_RULES),
                       "paused": sum(1 for r in RECURRING_RULES if r["status"] == "PAUSADA"),
                       "postedRules": POSTED_RULES},
    "invariants": {
        "I1_all_entries_balanced": True,
        "I2_balance_sheet_diff_cents": 0,
        "I3_pyg_equals_129_diff_cents": 0,
        "I7_entry_numbers_contiguous": True,
        "I-E3-5_template_coverage": f"{len(TEMPLATE_COVERAGE_V2)}/37",
        "I-E9-5_schedule_matches_ledger": True,
        "I-E9-16_reclassification_nets_to_zero": True,
        "I-E9-26_recc_fully_accrued": True,
    },
}

ORG_V2 = {
    "slug": "fixture-cierre",
    "name": "Fixture Cierre SL",
    "baseCurrency": "EUR",
    "pgcVariant": "PYMES",
    "taxRoundingMode": "PER_TIPO",
    "prorrataBps": None,
    "redondeoToleranciaCents": 1,
    "analyticsRequired": True,
    "useSubaccounts": False,
    "createSoftwareAccounts": False,
    "ivaRegime": "RECC",
    "vatPeriodKind": "TRIMESTRAL",
    "discountRateMonthlyMicroBps": 5_000_000,
    "pvMaterialityCents": 100_000,
}

ORG2_V2 = dict(ORG_V2) | {
    "slug": "fixture-prorrata",
    "name": "Fixture Prorrata SL",
    "prorrataBps": PRORRATA_PROVISIONAL_BPS,
    "ivaRegime": "GENERAL",
    "vatPeriodKind": "MENSUAL",
}

balances_org2 = leaf_balances(b2, "2026", {"CLOSING"})
deb_org2, cre_org2 = totals_of(ENTRIES_ORG2)

FIXTURE_V2 = {
    "schemaVersion": "2.0",
    "generatedBy": "docs/design/fixtures/build_ejercicio_completo.py",
    "note": ("Fixture INMUTABLE de E9 (T20). Amplia `ejercicio-completo` con 300 activos, "
             "60 reglas recurrentes, dos ejercicios encadenados, 4 prestamos con cuadro, "
             "posiciones en divisa monetarias y no monetarias, RECC y prorrata. Los fixtures "
             "v1 NO se tocan: su ledgerHash es el de E3. Cifras ilustrativas, ningun dato real. "
             "No editar a mano: regenerar con el script."),
    "organization": ORG_V2,
    "fiscalYear": {"code": "2026", "startDate": "2026-01-01", "endDate": "2026-12-31", "status": "OPEN"},
    "fiscalYearsExtra": [
        {"code": "2025", "startDate": "2025-01-01", "endDate": "2025-12-31", "status": "CLOSED"},
        {"code": "2027", "startDate": "2027-01-01", "endDate": "2027-12-31", "status": "OPEN"},
    ],
    "accountsExtra": ACCOUNTS_EXTRA_V2,
    "businessLines": BUSINESS_LINES,
    "projects": PROJECTS,
    "costCenters": COST_CENTERS,
    "entries": ENTRIES_V2,
    "fixedAssets": FIXED_ASSETS,
    "assetRevisions": ASSET_REVISIONS,
    "assetDisposals": [{"assetCode": code, **data} for code, data in sorted(ASSET_DISPOSALS.items())],
    "recurringRules": RECURRING_RULES,
    "debtSchedules": DEBT_SCHEDULES,
    "fxPositions": FX_POSITIONS,
    "vatRegimePeriods": [{"from": "2026-01-01", "to": "2027-12-31", "regime": "RECC",
                          "periodKind": "TRIMESTRAL", "importDeferral": False}],
    "reccPending": [{"documentNumber": "2025/088", "side": "EMITIDA", "operationDate": "2025-11-30",
                     "totalQuotaCents": RECC_SWEEP, "accruedCents": 0}],
    "expected": EXPECTED_V2,
    "secondaryOrganization": {
        "organization": ORG2_V2,
        "fiscalYear": {"code": "2026", "startDate": "2026-01-01", "endDate": "2026-12-31",
                       "status": "OPEN"},
        "entries": ENTRIES_ORG2,
        "prorrataYears": [{
            "year": 2026,
            "provisionalBps": PRORRATA_PROVISIONAL_BPS,
            "definitiveBps": PRORRATA_DEFINITIVA_BPS,
            "numeratorCents": PRORRATA_NUMERADOR,
            "denominatorCents": PRORRATA_DENOMINADOR,
            "prorrateableQuotaCents": PRORRATEABLE_QUOTA,
            "adjustmentCents": (PRORRATEABLE_QUOTA * PRORRATA_DEFINITIVA_BPS // 10_000
                                - PRORRATEABLE_QUOTA * PRORRATA_PROVISIONAL_BPS // 10_000),
        }],
        "capitalGoods": [{"assetCode": "INM2-001", "acquisitionYear": 2026,
                          "costCents": BIEN_INVERSION + DUA2_ARANCEL,
                          "thresholdCents": 300_506, "isCapitalGood": True}],
        "vatRegimePeriods": [{"from": "2026-01-01", "to": "2026-12-31", "regime": "GENERAL",
                              "periodKind": "MENSUAL", "importDeferral": True}],
        "expected": {
            "entryCount": len(ENTRIES_ORG2),
            "totalDebitCents": deb_org2,
            "totalCreditCents": cre_org2,
            "resultadoCents": CLOSE_ORG2.get("129", 0) * -1,
            "balancesBeforeClosingCents": {c: balances_org2.get(c, 0) for c in TRACKED_V2},
            "templateCoverage": coverage(ENTRIES_ORG2),
            "vatPeriods": VAT_PERIODS_ORG2,
            "prorrataAdjustmentCents": (PRORRATEABLE_QUOTA * PRORRATA_DEFINITIVA_BPS // 10_000
                                        - PRORRATEABLE_QUOTA * PRORRATA_PROVISIONAL_BPS // 10_000),
            "duaDeferredQuotaCents": DUA2_QUOTA,
        },
    },
}


# ---------------------------------------------------------------------------
# Escritura y comprobacion de los TRES fixtures
# ---------------------------------------------------------------------------

def dump(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="no escribe: compara con el fichero en disco")
    args = ap.parse_args()
    outputs = ((OUT_FULL, FIXTURE), (OUT_MIN, MIN_FIXTURE), (OUT_V2, FIXTURE_V2))
    failed = False
    for path, data in outputs:
        text = dump(data)
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                print(f"FAIL: {path} difiere de la reconstruccion", file=sys.stderr)
                failed = True
            else:
                print(f"OK: {path} coincide")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            print(f"escrito: {path.relative_to(ROOT)}")
    if failed:
        return 1
    if not args.check:
        print(f"\nv1 · asientos: {expected['entryCount']} (2026: {expected['entryCount2026']})")
        print(f"v1 · Sigma debe = Sigma haber = {deb_all} centimos (2026: {deb_2026})")
        print(f"v1 · resultado antes de regularizacion (I3) = {resultado_i3} centimos")
        print(f"     antes de impuesto = {resultado_antes_impuesto} · IS = {cuota_is}")
        print(f"v1 · IVA por trimestre: {iva_quarters}")
        print(f"\nv2 · asientos: {EXPECTED_V2['entryCount']} "
              f"(2026: {EXPECTED_V2['entryCount2026']} · 2027: {EXPECTED_V2['entryCount2027']}) "
              f"+ {len(ENTRIES_ORG2)} de la organizacion con prorrata")
        print(f"v2 · cobertura de plantillas: {EXPECTED_V2['templateCoverageCount']}/37 (I-E3-5)")
        print(f"v2 · resultado 2026 = {EXPECTED_V2['resultado2026Cents']} · "
              f"2027 = {EXPECTED_V2['resultado2027Cents']}")
        print(f"v2 · activos: {len(FIXED_ASSETS)} · reglas: {len(RECURRING_RULES)} · "
              f"prestamos: {len(DEBT_SCHEDULES)} · posiciones en divisa: {len(FX_POSITIONS)}")
        print(f"v2 · deuda a corto {EXPECTED_V2['reclassification']['deudaCortoPlazoCents']} · "
              f"a largo {EXPECTED_V2['reclassification']['deudaLargoPlazoCents']} tras la reclasificacion")
        print(f"v2 · distribucion: {EXPECTED_V2['distribution']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
