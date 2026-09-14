#!/usr/bin/env python3
"""
E10 · T20 — Generador del fixture `ejercicio-completo-v2` (schemaVersion 3.1).

    python3 docs/design/fixtures/build_ejercicio_completo_v2.py [--check]

Escribe `tests/fixtures/ejercicio-completo-v2.json`. Con `--check` no escribe:
reconstruye, compara byte a byte con el fichero en disco y falla si difiere.

Por que existe
--------------
La version 2.0 del fichero —emitida por `build_ejercicio_completo.py` en E9—
**no se puede cargar**: es internamente incoherente (deuda §0-bis #5 de
`docs/design/E10-presupuesto-horas.md`). Usa a la vez `4751` como cuenta de
apunte (nominas, pagos de retenciones, apertura y cierre) y la clave
`IRPF_A_PAGAR_123`, que `ACCOUNT_KEY_DEFAULT_CODE` resuelve a `47513`. Al crear
la subcuenta, la madre `4751` deja de admitir apuntes por derivacion del plan y
el fixture muere con `ACCOUNT_NOT_POSTABLE`.

Este generador la resuelve aplicando **ADR-0016 D12 de forma uniforme**:

  · `accountsExtra` declara las tres subcuentas por modelo con el codigo que les
    da `ACCOUNT_KEY_DEFAULT_CODE`: `47510` (111), `47511` (115) y `47513` (123),
    hijas de `4751`.
  · TODA retencion viaja por las claves `IRPF_A_PAGAR_111` / `_115` / `_123`.
    Las tres claves historicas de E3 (`IRPF_A_PAGAR`, `IRPF_TRABAJO_A_PAGAR`,
    `IRPF_PROFESIONALES_A_PAGAR`, `IRPF_ALQUILERES_A_PAGAR`) no se usan en el
    fixture: apuntan a `4751`, que pasa a ser un contenedor legitimo.
  · Las lineas de apertura y de cierre que saldaban `4751` en bloque se
    **parten por modelo**, con el saldo real de cada subcuenta.

Ninguna cifra del diario cambia: cambian codigos, el numero de lineas de tres
asientos (apertura y los dos cierres) y, por tanto, los saldos por hoja del
bloque `expected`, que se **recalculan** recorriendo el diario resultante.

De donde salen los datos
------------------------
`build_ejercicio_completo.py` es el corpus de E9 (300 activos, 60 reglas
recurrentes, dos ejercicios encadenados, 4 prestamos con cuadro, divisa, RECC,
prorrata, cobertura 37/37 de plantillas) y aqui se usa **como libreria**: se
importa, se toma su `FIXTURE_V2` y se transforma. El fixture **v1**
(`ejercicio-completo.json`) es intocable y no se lee siquiera.

Encima se anaden los seis bloques que E10 necesita (§2.5 del diseno), con los
**cinco casos adversariales** que exige §6 de `E10-validacion-controlling.md`:

  employees          8 empleados; `E-05` **sin tarifa vigente dos semanas**
  employeeRates      un **cambio de tarifa** a mitad de ejercicio; `basis` declarada
  timeEntries        ano completo en **minutos enteros**, con **contra-apunte**,
                     horas **no productivas** y **un mes con aprobadas y sin
                     aprobar mezcladas** (base parcial, O-E10-2)
  headcountSnapshots 12 x 4 CECOs; `CC-DEV` **nace en febrero y muere en
                     noviembre** (FTE·mes, Q-7) y `CC-MKT` **sin snapshot** en
                     agosto (`PLANTILLA_AUSENTE`)
  budgets            `BASE` de los doce meses + **`REVISADO 1` que solo cubre el
                     segundo semestre** (`partialFrom`), con una linea de ingreso
                     de signo correcto y otra de gasto **en positivo** que el
                     importador debe rechazar (bloque `rejectedLines`)
  budgetHoursLines   horas presupuestadas por proyecto y mes: son las que
                     alimentan la liquidacion presupuestaria de O-E10-4

Todo en enteros. Las cifras son ILUSTRATIVAS: ninguna procede de datos reales.
"""

from __future__ import annotations

import argparse
import copy
import importlib
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # no ensuciar el repo con __pycache__
sys.path.insert(0, str(HERE))
base = importlib.import_module("build_ejercicio_completo")

ROOT = base.ROOT
OUT = ROOT / "tests" / "fixtures" / "ejercicio-completo-v2.json"

SCHEMA_VERSION = "3.1"
FY_2026, FY_2027 = "2026", "2027"
MONTHS_2026 = [f"2026-{m:02d}" for m in range(1, 13)]
MONTH_LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


# ---------------------------------------------------------------------------
# 1. Retenciones: ADR-0016 D12 aplicado de forma uniforme
# ---------------------------------------------------------------------------

# Las tres subcuentas por modelo, con el codigo de `ACCOUNT_KEY_DEFAULT_CODE`.
IRPF_SUBACCOUNTS: list[dict[str, str]] = [
    {"code": "47510", "name": "Hacienda Publica, acreedora por retenciones - profesionales (modelo 111)",
     "parentCode": "4751"},
    {"code": "47511", "name": "Hacienda Publica, acreedora por retenciones - arrendamientos (modelo 115)",
     "parentCode": "4751"},
    {"code": "47513", "name": "Hacienda Publica, acreedora por retenciones - capital mobiliario (modelo 123)",
     "parentCode": "4751"},
]

# Clave historica (todas resuelven a `4751`) -> clave por modelo.
KEY_REMAP: dict[str, str] = {
    "IRPF_A_PAGAR": "IRPF_A_PAGAR_111",
    "IRPF_TRABAJO_A_PAGAR": "IRPF_A_PAGAR_111",
    "IRPF_PROFESIONALES_A_PAGAR": "IRPF_A_PAGAR_111",
    "IRPF_ALQUILERES_A_PAGAR": "IRPF_A_PAGAR_115",
}

KEY_TO_CODE_V31: dict[str, str] = dict(base.KEY_TO_CODE_V2) | {
    "IRPF_A_PAGAR_111": "47510",
    "IRPF_A_PAGAR_115": "47511",
    "IRPF_A_PAGAR_123": "47513",
}

IRPF_CODES = [s["code"] for s in IRPF_SUBACCOUNTS]

# El plan efectivo del fixture: el del seed MAS sus `accountsExtra` (las dos del
# RECC que ya traia la version 2.0 y las tres subcuentas por modelo). Con ellas,
# `4751` deja de ser postable —tiene hijas— y eso es exactamente lo que la carga
# hace en la base (`planWithExtras` de `tests/support/fixtures.ts`).
EXTRA_CODES = {"4728", "4778"} | set(IRPF_CODES)
PLAN_CODES_V31 = set(base.PLAN_CODES) | EXTRA_CODES
PLAN_POSTABLE_V31 = {c for c in PLAN_CODES_V31
                     if not any(o != c and o.startswith(c) for o in PLAN_CODES_V31)}


def resolve_postable_v31(code: str) -> str:
    """`lib/accounts/map.ts::resolvePostable` sobre el plan efectivo del fixture."""
    current = code
    if current not in PLAN_CODES_V31:
        for n in range(len(current) - 1, 0, -1):
            if current[:n] in PLAN_CODES_V31:
                current = current[:n]
                break
        else:
            raise KeyError(f"{code} no existe en el plan ni tiene ancestro")
    if current in PLAN_POSTABLE_V31:
        return current
    leaves = sorted(c for c in PLAN_POSTABLE_V31 if c != current and c.startswith(current))
    if not leaves:
        raise KeyError(f"{code} no es postable y no tiene hoja")
    return leaves[0]


def code_of(line: dict[str, Any]) -> str:
    """Codigo de hoja de una linea, con el mapa ya corregido."""
    raw = KEY_TO_CODE_V31[line["accountKey"]] if "accountKey" in line else line["accountCode"]
    return resolve_postable_v31(raw)


def remap_keys(entries: list[dict[str, Any]]) -> int:
    """Enruta toda retencion por su clave de modelo. Devuelve cuantas lineas movio."""
    moved = 0
    for entry in entries:
        for line in entry["lines"]:
            key = line.get("accountKey")
            if key in KEY_REMAP:
                line["accountKey"] = KEY_REMAP[key]
                moved += 1
    return moved


def balances_of(entries: list[dict[str, Any]], year: str, codes: list[str],
                exclude_kinds: set[str]) -> dict[str, int]:
    """Saldo (debe - haber) por codigo dentro de un ejercicio."""
    out: dict[str, int] = {c: 0 for c in codes}
    for entry in entries:
        if entry["fiscalYearCode"] != year or entry["kind"] in exclude_kinds:
            continue
        for line in entry["lines"]:
            c = code_of(line)
            if c in out:
                out[c] += line["debitCents"] - line["creditCents"]
    return out


def split_irpf_line(entries: list[dict[str, Any]], ref: str, amounts: dict[str, int]) -> None:
    """Sustituye la linea `4751` del asiento `ref` por una linea por modelo.

    `amounts[code]` es el importe (debe - haber) que cada linea nueva debe
    llevar. Se conserva la posicion original y se renumeran las lineas del
    asiento.
    """
    entry = next(e for e in entries if e["ref"] == ref)
    idx = next(i for i, ln in enumerate(entry["lines"]) if ln.get("accountCode") == "4751")
    original = entry["lines"][idx]
    total = original["debitCents"] - original["creditCents"]
    replacement: list[dict[str, Any]] = []
    for code in IRPF_CODES:
        amount = amounts.get(code, 0)
        if amount == 0:
            continue
        line = dict(original)
        line.pop("accountCode", None)
        line["accountCode"] = code
        line["debitCents"] = amount if amount > 0 else 0
        line["creditCents"] = -amount if amount < 0 else 0
        replacement.append(line)
    assert replacement, f"{ref}: la linea 4751 no tiene ningun saldo por modelo que saldar"
    assert sum(l["debitCents"] - l["creditCents"] for l in replacement) == total, (
        f"{ref}: el desglose por modelo no suma lo mismo que la linea 4751 ({total})")
    entry["lines"][idx:idx + 1] = replacement
    for n, line in enumerate(entry["lines"], start=1):
        line["lineNo"] = n


def fix_retentions(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """El arreglo completo. Devuelve la traza para el bloque `expected`."""
    moved = remap_keys(entries)

    # 2026: la CLOSING SALDA lo acumulado por los asientos del propio ejercicio.
    bal_2026 = balances_of(entries, FY_2026, IRPF_CODES, {"CLOSING"})
    split_irpf_line(entries, "CIE-2026", {c: -v for c, v in bal_2026.items()})

    # 2027: la apertura REPRODUCE el saldo de cierre de 2026, con el mismo desglose…
    split_irpf_line(entries, "AP-2027", bal_2026)
    # …y la CLOSING de 2027 salda lo acumulado en 2027, apertura incluida.
    bal_2027 = balances_of(entries, FY_2027, IRPF_CODES, {"CLOSING"})
    split_irpf_line(entries, "CIE-2027", {c: -v for c, v in bal_2027.items()})

    posted_4751 = [e["ref"] for e in entries for ln in e["lines"]
                   if ln.get("accountCode") == "4751" or ln.get("accountKey") in KEY_REMAP]
    assert not posted_4751, f"todavia hay lineas contra 4751: {sorted(set(posted_4751))}"
    return {
        "linesRoutedByModel": moved,
        "closingSplit2026Cents": {c: -v for c, v in bal_2026.items() if v},
        "closingSplit2027Cents": {c: -v for c, v in bal_2027.items() if v},
    }


# ---------------------------------------------------------------------------
# 2. Bloques de E10 (§2.5), con los cinco casos adversariales
# ---------------------------------------------------------------------------

PROJECTS = ["P-01", "P-02", "P-03"]
CECOS_HC = ["CC-GA", "CC-MKT", "CC-OPS", "CC-DEV"]

# 8 empleados. `costCenterCode` es su CECO de nomina; `E-05` es el que se queda
# sin tarifa vigente dos semanas de junio.
EMPLOYEES: list[dict[str, Any]] = [
    {"code": "E-01", "name": "Ana Iglesias", "costCenterCode": "CC-OPS", "productive": True,
     "hiredOn": "2025-03-01", "terminatedOn": None},
    {"code": "E-02", "name": "Bruno Cabrera", "costCenterCode": "CC-OPS", "productive": True,
     "hiredOn": "2025-09-15", "terminatedOn": None},
    {"code": "E-03", "name": "Carla Otero", "costCenterCode": "CC-DEV", "productive": True,
     "hiredOn": "2024-11-02", "terminatedOn": None},
    {"code": "E-04", "name": "Diego Sanz", "costCenterCode": "CC-DEV", "productive": True,
     "hiredOn": "2026-01-07", "terminatedOn": None},
    {"code": "E-05", "name": "Elena Prat", "costCenterCode": "CC-OPS", "productive": True,
     "hiredOn": "2025-06-01", "terminatedOn": None},
    {"code": "E-06", "name": "Fermin Lago", "costCenterCode": "CC-MKT", "productive": True,
     "hiredOn": "2025-02-10", "terminatedOn": None},
    {"code": "E-07", "name": "Gema Ruiz", "costCenterCode": "CC-GA", "productive": False,
     "hiredOn": "2023-04-01", "terminatedOn": None},
    {"code": "E-08", "name": "Hector Vidal", "costCenterCode": "CC-GA", "productive": False,
     "hiredOn": "2025-10-01", "terminatedOn": "2026-11-30"},
]

BASIS = "COSTE_EMPRESA_CON_SS"

# Tarifas c/hora. Caso adverso 1: `E-05` sin vigencia entre el 08 y el 21 de junio.
# Caso adverso 2: `E-03` cambia de tarifa el 1 de julio (mitad de ejercicio).
EMPLOYEE_RATES: list[dict[str, Any]] = [
    {"employeeCode": "E-01", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 3200, "basis": BASIS},
    {"employeeCode": "E-02", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 2850, "basis": BASIS},
    {"employeeCode": "E-03", "validFrom": "2026-01-01", "validTo": "2026-06-30", "hourlyCostCents": 3600, "basis": BASIS},
    {"employeeCode": "E-03", "validFrom": "2026-07-01", "validTo": None, "hourlyCostCents": 3950, "basis": BASIS},
    {"employeeCode": "E-04", "validFrom": "2026-01-07", "validTo": None, "hourlyCostCents": 2600, "basis": BASIS},
    {"employeeCode": "E-05", "validFrom": "2026-01-01", "validTo": "2026-06-07", "hourlyCostCents": 3050, "basis": BASIS},
    {"employeeCode": "E-05", "validFrom": "2026-06-22", "validTo": None, "hourlyCostCents": 3150, "basis": BASIS},
    {"employeeCode": "E-06", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 2400, "basis": BASIS},
    {"employeeCode": "E-07", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 2200, "basis": BASIS},
    {"employeeCode": "E-08", "validFrom": "2026-01-01", "validTo": "2026-11-30", "hourlyCostCents": 2100, "basis": BASIS},
]

# Reparto determinista de los partes: empleado -> [(receptor, kind, minutos
# SEMANALES, productiva)]. Se emite un parte por semana y receptor, cada uno en
# un dia distinto, de modo que ni la fila ni el agregado por (empleado, dia)
# pasan de 1 440 minutos (O-E10-21 / I-E10-10). Los minutos se modulan por mes
# con una serie entera y acotada, sin azar.
TIME_PLAN: dict[str, list[tuple[str, str, int, bool]]] = {
    "E-01": [("P-01", "PROJECT", 1_200, True), ("P-02", "PROJECT", 480, True)],
    "E-02": [("P-02", "PROJECT", 1_080, True), ("P-03", "PROJECT", 660, True)],
    "E-03": [("P-03", "PROJECT", 1_320, True), ("CC-DEV", "COST_CENTER", 300, False)],
    "E-04": [("P-03", "PROJECT", 1_200, True), ("P-01", "PROJECT", 480, True)],
    "E-05": [("P-01", "PROJECT", 840, True), ("CC-OPS", "COST_CENTER", 840, False)],
    "E-06": [("P-02", "PROJECT", 660, True), ("CC-MKT", "COST_CENTER", 960, False)],
    "E-07": [("CC-GA", "COST_CENTER", 1_320, False)],
    "E-08": [("CC-GA", "COST_CENTER", 1_260, False)],
}

WEEKS = 4  # semanas por mes: dias 6/7, 13/14, 20/21 y 27/28

# Modulacion mensual en centesimas (julio = vacaciones). Ningun mes pasa de 105,
# para que el parte semanal mas alto (1 320) siga por debajo del techo de 1 440.
MONTH_FACTOR = [100, 96, 104, 98, 102, 95, 60, 105, 103, 101, 99, 100]

PROJECT_BL = {"P-01": "BL-CONS", "P-02": "BL-CONS", "P-03": "BL-DEV"}


def month_days(month: str) -> int:
    return MONTH_LAST_DAY[int(month[5:7]) - 1]


def build_time_entries() -> list[dict[str, Any]]:
    """Ano completo de partes en minutos enteros, con los tres casos adversos."""
    rows: list[dict[str, Any]] = []
    for emp in EMPLOYEES:
        code = emp["code"]
        for i, month in enumerate(MONTHS_2026):
            if emp["terminatedOn"] and month > emp["terminatedOn"][:7]:
                continue
            if emp["hiredOn"] > f"{month}-{month_days(month):02d}":
                continue
            for week in range(WEEKS):
                for j, (target, kind, weekly, productive) in enumerate(TIME_PLAN[code]):
                    minutes = weekly * MONTH_FACTOR[i] // 100
                    if minutes == 0:
                        continue
                    day = 6 + 7 * week + j
                    # Caso adverso 3: octubre mezcla aprobadas y sin aprobar. Se
                    # dejan sin aprobar los partes de `E-04` y `E-06`, que son
                    # receptores elegibles de las reglas de actividad: base
                    # PARCIAL (O-E10-2).
                    approved = not (month == "2026-10" and code in ("E-04", "E-06"))
                    rows.append({
                        "importKey": f"{code}-{month}-W{week + 1}-{target}",
                        "employeeCode": code,
                        "date": f"{month}-{day:02d}",
                        "targetKind": kind,
                        "targetCode": target,
                        "businessLineCode": PROJECT_BL.get(target),
                        "minutes": minutes,
                        "productive": productive,
                        "approved": approved,
                        "reversesImportKey": None,
                        "reason": None,
                    })
    # Caso adverso 4: contra-apunte de septiembre. `E-01` habia imputado a P-01
    # 480 minutos de mas; se corrigen con una entrada NEGATIVA y motivo, sin
    # tocar el original (I-E10-4).
    rows.append({
        "importKey": "E-01-2026-09-W4-P-01-CONTRA",
        "employeeCode": "E-01",
        "date": "2026-09-30",
        "targetKind": "PROJECT",
        "targetCode": "P-01",
        "businessLineCode": "BL-CONS",
        "minutes": -480,
        "productive": True,
        "approved": True,
        "reversesImportKey": "E-01-2026-09-W4-P-01",
        "reason": "Correccion de imputacion: ocho horas de P-01 correspondian a P-02",
    })
    rows.append({
        "importKey": "E-01-2026-09-W4-P-02-CORRECCION",
        "employeeCode": "E-01",
        "date": "2026-09-30",
        "targetKind": "PROJECT",
        "targetCode": "P-02",
        "businessLineCode": "BL-CONS",
        "minutes": 480,
        "productive": True,
        "approved": True,
        "reversesImportKey": None,
        "reason": "Correccion de imputacion: ocho horas que venian de P-01",
    })
    rows.sort(key=lambda r: (r["date"], r["employeeCode"], r["targetCode"], r["importKey"]))
    return rows


def build_headcount() -> list[dict[str, Any]]:
    """12 x 4 CECOs en `fteMilli`, con los dos casos adversos de Q-7 y O-E10-16."""
    stock = {"CC-GA": 2_000, "CC-MKT": 1_500, "CC-OPS": 4_000, "CC-DEV": 3_000}
    rows: list[dict[str, Any]] = []
    for month in MONTHS_2026:
        for cc in CECOS_HC:
            # Caso adverso 5a: CC-DEV nace en febrero y muere en noviembre. Con el
            # stock a 31-12 su peso anual seria 0 y sus diez meses vivos se
            # trasladarian a los demas CECOs (Q-7).
            if cc == "CC-DEV" and not ("2026-02" <= month <= "2026-11"):
                continue
            # Caso adverso 5b: CC-MKT no tiene snapshot en agosto. No es un cero
            # declarado: es un hueco, y dispara `PLANTILLA_AUSENTE` (EV-16).
            if cc == "CC-MKT" and month == "2026-08":
                continue
            rows.append({
                "costCenterCode": cc,
                "month": f"{month}-01",
                "asOf": f"{month}-{month_days(month):02d}",
                "fteMilli": stock[cc],
            })
    # Un cero DECLARADO, que no es un hueco: CC-MKT se queda sin nadie en enero.
    for row in rows:
        if row["costCenterCode"] == "CC-MKT" and row["month"] == "2026-01-01":
            row["fteMilli"] = 0
    return rows


# --- presupuesto -----------------------------------------------------------

# Signo de aporte por tipo analitico (D2 / O-E10-6): ingreso +, gasto -.
BUDGET_PLAN: list[tuple[str, str, str, str, str, int]] = [
    # (cuenta, tipo analitico, nivel, tipo de dimension, dimension, importe MENSUAL)
    ("705", "INGRESO_DIRECTO", "INGRESOS", "PROJECT", "P-01", 1_800_000),
    ("705", "INGRESO_DIRECTO", "INGRESOS", "PROJECT", "P-02", 2_100_000),
    ("705", "INGRESO_DIRECTO", "INGRESOS", "PROJECT", "P-03", 1_350_000),
    ("607", "COSTE_DIRECTO_MC1", "MC1", "PROJECT", "P-01", -620_000),
    ("607", "COSTE_DIRECTO_MC1", "MC1", "PROJECT", "P-02", -740_000),
    ("607", "COSTE_DIRECTO_MC1", "MC1", "PROJECT", "P-03", -410_000),
    ("640", "COSTE_DIRECTO_MC2", "MC2", "PROJECT", "P-01", -430_000),
    ("640", "COSTE_DIRECTO_MC2", "MC2", "PROJECT", "P-02", -505_000),
    ("640", "COSTE_DIRECTO_MC2", "MC2", "PROJECT", "P-03", -365_000),
    ("640", "INDIRECTO_CECO", "MC3", "COST_CENTER", "CC-OPS", -290_000),
    ("640", "INDIRECTO_CECO", "MC3", "COST_CENTER", "CC-DEV", -240_000),
    ("623", "INDIRECTO_CECO", "EBITDA", "COST_CENTER", "CC-GA", -160_000),
    ("627", "INDIRECTO_CECO", "EBITDA", "COST_CENTER", "CC-MKT", -125_000),
    ("681", "AMORTIZACION_DETERIORO", "EBIT", "COST_CENTER", "CC-GA", -95_000),
]

# La `REVISADO 1` solo trae el segundo semestre (O-E10-9 / I-E10-16): recorta el
# ingreso de P-03 y sube el coste indirecto de CC-OPS.
REV1_DELTA_BPS: dict[tuple[str, str], int] = {
    ("705", "P-03"): -1_500,   # -15 %
    ("640", "CC-OPS"): 1_200,  # +12 % de coste
}


def apply_delta(amount: int, bps: int) -> int:
    """Ajuste entero sobre la MAGNITUD, conservando el signo del aporte."""
    sign = -1 if amount < 0 else 1
    return sign * (abs(amount) * (10_000 + bps) // 10_000)


def build_budgets() -> list[dict[str, Any]]:
    def lines(scenario_delta: dict[tuple[str, str], int], months: list[str]) -> list[dict[str, Any]]:
        out = []
        for account, atype, level, dim_kind, dim, monthly in BUDGET_PLAN:
            for month in months:
                amount = apply_delta(monthly, scenario_delta.get((account, dim), 0))
                out.append({
                    "month": f"{month}-01",
                    "accountCode": account,
                    "analyticType": atype,
                    "marginLevel": level,
                    "dimensionKind": dim_kind,
                    "dimensionCode": dim,
                    "businessLineCode": PROJECT_BL.get(dim),
                    "amountCents": amount,
                    "signException": False,
                })
        out.sort(key=lambda l: (l["month"], l["dimensionKind"], l["dimensionCode"], l["accountCode"]))
        return out

    h1 = MONTHS_2026[:6]
    h2 = MONTHS_2026[6:]
    return [
        {
            "code": "2026-BASE", "scenario": "BASE", "revision": 0, "status": "VIGENTE",
            "fiscalYearCode": "2026", "validFrom": "2026-01-01", "validTo": "2026-06-30",
            "partialFrom": None, "sealedAt": "2026-01-08T09:00:00.000Z",
            "lines": lines({}, MONTHS_2026),
        },
        {
            "code": "2026-REV1", "scenario": "REVISADO", "revision": 1, "status": "VIGENTE",
            "fiscalYearCode": "2026", "validFrom": "2026-07-01", "validTo": None,
            "partialFrom": "2026-07-01", "sealedAt": "2026-07-03T09:00:00.000Z",
            "lines": lines(REV1_DELTA_BPS, h2),
        },
    ], h1, h2


# Las dos lineas de la recomendacion del experto: una de ingreso con signo
# CORRECTO (ya esta en `BUDGET_PLAN`) y una de gasto en POSITIVO que el
# importador tiene que rechazar. No entra en ninguna version sellada: viaja
# aparte para que el test la intente cargar y compruebe el rechazo.
REJECTED_BUDGET_LINES: list[dict[str, Any]] = [
    {
        "month": "2026-03-01", "accountCode": "6400", "analyticType": "COSTE_DIRECTO_MC2",
        "marginLevel": "MC2", "dimensionKind": "PROJECT", "dimensionCode": "P-01",
        "businessLineCode": "BL-CONS", "amountCents": 1_200_000, "signException": False,
        "expectedRejection": "BUDGET_SIGN",
        "note": "gasto en positivo: la accion responde BUDGET_SIGN y el CHECK "
                "budget_lines_sign_by_type lo rechaza con 23514 (O-E10-6, criterio 28)",
    },
    {
        "month": "2026-03-01", "accountCode": "6400", "analyticType": None,
        "marginLevel": "MC2", "dimensionKind": "PROJECT", "dimensionCode": "P-01",
        "businessLineCode": "BL-CONS", "amountCents": 1_200_000, "signException": False,
        "expectedRejection": "BUDGET_TYPE_REQUIRED",
        "note": "sin tipo analitico: budget_lines_type_required lanza 23514 "
                "(O-E10-23, criterio 4-bis)",
    },
]


def build_budget_hours() -> list[dict[str, Any]]:
    """Horas presupuestadas por proyecto y mes (O-E10-4).

    Se presupuesta el 95 % de lo que el plan de partes produce en minutos
    APROBADOS y PRODUCTIVOS: asi la liquidacion presupuestaria y la real se
    parecen sin ser identicas, que es lo que hace util la desviacion.
    """
    planned: dict[tuple[str, str], int] = defaultdict(int)
    for row in build_time_entries():
        if row["targetKind"] != "PROJECT" or not row["productive"]:
            continue
        planned[(row["date"][:7], row["targetCode"])] += row["minutes"]
    out = []
    for (month, project), minutes in sorted(planned.items()):
        out.append({
            "month": f"{month}-01",
            "dimensionKind": "PROJECT",
            "dimensionCode": project,
            "businessLineCode": PROJECT_BL[project],
            "employeeCode": None,
            "minutes": minutes * 9_500 // 10_000,
        })
    return out


# ---------------------------------------------------------------------------
# 3. Construccion del fichero
# ---------------------------------------------------------------------------

def build() -> dict[str, Any]:
    fx = copy.deepcopy(base.FIXTURE_V2)
    entries: list[dict[str, Any]] = fx["entries"]

    retentions = fix_retentions(entries)

    # I1 vuelve a comprobarse sobre el diario ya transformado.
    for entry in entries:
        deb = sum(l["debitCents"] for l in entry["lines"])
        cre = sum(l["creditCents"] for l in entry["lines"])
        assert deb == cre, f"I1 roto en {entry['ref']}: {deb} != {cre}"
        assert [l["lineNo"] for l in entry["lines"]] == list(range(1, len(entry["lines"]) + 1)), \
            f"lineNo no correlativo en {entry['ref']}"
        for line in entry["lines"]:
            assert (line["debitCents"] > 0) != (line["creditCents"] > 0) or \
                   (line["debitCents"] == 0 and line["creditCents"] == 0), \
                   f"convencion de linea rota en {entry['ref']}"

    time_entries = build_time_entries()
    headcount = build_headcount()
    budgets, h1, h2 = build_budgets()
    budget_hours = build_budget_hours()

    # ── bloque `expected`, recalculado ────────────────────────────────────
    tracked = sorted(set(base.TRACKED_V2) | set(IRPF_CODES))

    def leaf_balances(year: str) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for entry in entries:
            if entry["fiscalYearCode"] != year or entry["kind"] == "CLOSING":
                continue
            for line in entry["lines"]:
                out[code_of(line)] += line["debitCents"] - line["creditCents"]
        return out

    bal_2026, bal_2027 = leaf_balances(FY_2026), leaf_balances(FY_2027)
    prefix3: dict[str, int] = defaultdict(int)
    for entry in entries:
        if entry["fiscalYearCode"] != FY_2026 or entry["kind"] == "CLOSING":
            continue
        for line in entry["lines"]:
            prefix3[code_of(line)[:3]] += line["debitCents"] - line["creditCents"]

    expected = dict(fx["expected"])
    expected["balancesBeforeClosing2026Cents"] = {c: bal_2026.get(c, 0) for c in tracked}
    # Alias que `scripts/load-fixture.ts` comprueba tras cargar: saldos del
    # ejercicio principal (2026) excluyendo el asiento de cierre. Es exactamente
    # el mapa de arriba; se duplica con el nombre que el cargador espera para que
    # el fixture se verifique solo, sin tocar el script (que comparte la ola C).
    expected["balancesBeforeClosingCents"] = {c: bal_2026.get(c, 0) for c in tracked}
    expected["balancesBeforeClosing2027Cents"] = {c: bal_2027.get(c, 0) for c in tracked}
    expected["balancesByPrefix3Cents2026"] = {k: v for k, v in sorted(prefix3.items()) if v != 0}
    expected["totalDebitCents"] = sum(l["debitCents"] for e in entries for l in e["lines"])
    expected["totalCreditCents"] = sum(l["creditCents"] for e in entries for l in e["lines"])
    expected["retentionsByModel"] = retentions

    approved_productive_by_project: dict[str, int] = defaultdict(int)
    unapproved_by_target: dict[str, int] = defaultdict(int)
    for row in time_entries:
        if not row["approved"]:
            unapproved_by_target[row["targetCode"]] += row["minutes"]
        elif row["productive"] and row["targetKind"] == "PROJECT":
            approved_productive_by_project[row["targetCode"]] += row["minutes"]

    expected["e10"] = {
        "employeeCount": len(EMPLOYEES),
        "employeeRateCount": len(EMPLOYEE_RATES),
        "timeEntryCount": len(time_entries),
        "timeEntryMinutesTotal": sum(r["minutes"] for r in time_entries),
        "approvedProductiveMinutesByProject": dict(sorted(approved_productive_by_project.items())),
        "unapprovedMinutesByTarget": dict(sorted(unapproved_by_target.items())),
        "counterEntryCount": sum(1 for r in time_entries if r["minutes"] < 0),
        "headcountSnapshotCount": len(headcount),
        "headcountFteMilliMonthByCostCenter": {
            cc: sum(r["fteMilli"] for r in headcount if r["costCenterCode"] == cc)
            for cc in CECOS_HC
        },
        "budgetLineCount": {b["code"]: len(b["lines"]) for b in budgets},
        "budgetTotalCentsByVersion": {b["code"]: sum(l["amountCents"] for l in b["lines"]) for b in budgets},
        "budgetComposedMonths": {m: "2026-BASE" for m in h1} | {m: "2026-REV1" for m in h2},
        "budgetHoursMinutesTotal": sum(r["minutes"] for r in budget_hours),
        "rejectedBudgetLineCount": len(REJECTED_BUDGET_LINES),
        "adversarialCases": [
            "E-05 sin tarifa vigente del 2026-06-08 al 2026-06-21 (TARIFA_AUSENTE, I-E10-5)",
            "E-03 cambia de tarifa el 2026-07-01 (coste con la tarifa del dia del parte)",
            "2026-10 con partes aprobados y sin aprobar mezclados (base parcial, O-E10-2)",
            "contra-apunte de 480 minutos el 2026-09-30 con motivo (I-E10-4)",
            "CC-DEV con plantilla solo de febrero a noviembre (FTE·mes, Q-7)",
            "CC-MKT sin snapshot en 2026-08 (PLANTILLA_AUSENTE) y con cero declarado en enero",
            "REVISADO 1 con partialFrom 2026-07-01 (I-E10-16)",
            "linea de gasto en positivo y linea sin tipo analitico, ambas rechazadas",
        ],
    }

    out: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": "docs/design/fixtures/build_ejercicio_completo_v2.py",
        "note": (
            "Fixture de E9 REVERSIONADO en E10 (T20). Sustituye a la version 2.0, que era "
            "internamente incoherente y no se podia cargar: usaba 4751 como cuenta de apunte y a la "
            "vez la clave IRPF_A_PAGAR_123 (47513), con lo que la madre dejaba de admitir apuntes. "
            "Aqui TODA retencion viaja por IRPF_A_PAGAR_111/115/123 (ADR-0016 D12) y 4751 es un "
            "contenedor sin apuntes. Anade los seis bloques de E10 (empleados, tarifas, partes de "
            "horas en minutos, plantilla, presupuesto versionado y horas presupuestadas) con los "
            "cinco casos adversariales de la validacion de control de gestion. El fixture v1 es "
            "intocable y no interviene."
        ),
        "organization": fx["organization"],
        "fiscalYear": fx["fiscalYear"],
        # El `2025` de la version 2.0 era un ejercicio DECLARADO Y VACIO, y como
        # el fichero nunca llego a cargarse nadie vio la consecuencia: I-E7-14
        # compara la apertura de 2026 contra el cierre del ejercicio anterior y,
        # sin una sola linea en 2025, sale FAIL en catorce cuentas. Los dos
        # ejercicios encadenados del fixture son 2026 y 2027 —que si tienen
        # cierre y apertura espejo—, asi que el ejercicio hueco se retira.
        "fiscalYearsExtra": [fy for fy in fx["fiscalYearsExtra"] if fy["code"] != "2025"],
        "accountsExtra": fx["accountsExtra"] + IRPF_SUBACCOUNTS,
        "businessLines": fx["businessLines"],
        "projects": fx["projects"],
        "costCenters": fx["costCenters"],
        "entries": entries,
        "fixedAssets": fx["fixedAssets"],
        "assetRevisions": fx["assetRevisions"],
        "assetDisposals": fx["assetDisposals"],
        "recurringRules": fx["recurringRules"],
        "debtSchedules": fx["debtSchedules"],
        "fxPositions": fx["fxPositions"],
        "vatRegimePeriods": fx["vatRegimePeriods"],
        "reccPending": fx["reccPending"],
        "employees": EMPLOYEES,
        "employeeRates": EMPLOYEE_RATES,
        "timeEntries": time_entries,
        "headcountSnapshots": headcount,
        "budgets": budgets,
        "budgetHoursLines": budget_hours,
        "rejectedBudgetLines": REJECTED_BUDGET_LINES,
        "expected": expected,
        "secondaryOrganization": fx["secondaryOrganization"],
    }
    return out


def checks(fixture: dict[str, Any]) -> list[str]:
    """Las comprobaciones que el fichero tiene que superar antes de escribirse."""
    problems: list[str] = []
    codes_extra = {a["code"] for a in fixture["accountsExtra"]}
    if not {"47510", "47511", "47513"} <= codes_extra:
        problems.append("accountsExtra no declara las tres subcuentas por modelo")
    for entry in fixture["entries"]:
        for line in entry["lines"]:
            if line.get("accountCode") == "4751":
                problems.append(f"{entry['ref']} postea contra 4751")
            if line.get("accountKey") in KEY_REMAP:
                problems.append(f"{entry['ref']} usa la clave generica {line['accountKey']}")
    # I-E10-10: techo diario agregado por (empleado, fecha)
    per_day: dict[tuple[str, str], int] = defaultdict(int)
    for row in fixture["timeEntries"]:
        per_day[(row["employeeCode"], row["date"])] += row["minutes"]
        if row["minutes"] == 0 or abs(row["minutes"]) > 1_440:
            problems.append(f"parte fuera de rango: {row['importKey']}")
    for (emp, date), minutes in sorted(per_day.items()):
        if minutes > 1_440:
            problems.append(f"I-E10-10: {emp} suma {minutes} minutos el {date}")
    # I-E10-8: una celda por (mes, dimension, cuenta) y una sola dimension
    for budget in fixture["budgets"]:
        seen = set()
        for line in budget["lines"]:
            key = (line["month"], line["dimensionKind"], line["dimensionCode"], line["accountCode"])
            if key in seen:
                problems.append(f"{budget['code']}: celda duplicada {key}")
            seen.add(key)
            if line["analyticType"] is None:
                problems.append(f"{budget['code']}: linea sin tipo analitico")
    # I-E10-14: signo por tipo analitico
    positive_types = {"INGRESO_DIRECTO"}
    negative_types = {"COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2", "INDIRECTO_CECO", "AMORTIZACION_DETERIORO"}
    for budget in fixture["budgets"]:
        for line in budget["lines"]:
            atype, amount = line["analyticType"], line["amountCents"]
            if atype in positive_types and amount < 0:
                problems.append(f"{budget['code']}: ingreso negativo en {line['month']}")
            if atype in negative_types and amount > 0 and not line["signException"]:
                problems.append(f"{budget['code']}: gasto positivo en {line['month']}")
    # I-E10-9 / I-E10-15: vigencias sin solape y sin hueco
    spans = sorted((b["validFrom"], b["validTo"]) for b in fixture["budgets"])
    if spans[0][0] != "2026-01-01":
        problems.append("I-E10-15: la primera version no arranca el 1 de enero")
    for (_, end), (start, _) in zip(spans, spans[1:]):
        if end is None or start != f"2026-07-01" or end != "2026-06-30":
            problems.append(f"I-E10-15: hueco o solape entre vigencias ({end} -> {start})")
    if spans[-1][1] is not None:
        problems.append("I-E10-15: la ultima version no llega al fin del ejercicio")
    # I-E10-11: un snapshot por (CECO, mes) y fteMilli >= 0
    seen_hc = set()
    for row in fixture["headcountSnapshots"]:
        key = (row["costCenterCode"], row["month"])
        if key in seen_hc:
            problems.append(f"I-E10-11: snapshot duplicado {key}")
        seen_hc.add(key)
        if row["fteMilli"] < 0:
            problems.append(f"I-E10-11: fteMilli negativo en {key}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="no escribe: compara con el fichero en disco")
    args = ap.parse_args()

    data = build()
    problems = checks(data)
    for p in problems:
        print(f"FAIL: {p}", file=sys.stderr)
    if problems:
        return 2

    text = json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False) + "\n"
    if args.check:
        if not OUT.exists():
            print(f"FAIL: falta {OUT}", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print(f"FAIL: {OUT} difiere de la reconstruccion", file=sys.stderr)
            return 1
        print("OK: tests/fixtures/ejercicio-completo-v2.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    e10 = data["expected"]["e10"]
    print(f"escrito {OUT.relative_to(ROOT)}  (schemaVersion {data['schemaVersion']})")
    print(f"  asientos: {len(data['entries'])} · lineas contra 4751: 0 · "
          f"retenciones enrutadas por modelo: {data['expected']['retentionsByModel']['linesRoutedByModel']}")
    print(f"  empleados {e10['employeeCount']} · tarifas {e10['employeeRateCount']} · "
          f"partes {e10['timeEntryCount']} ({e10['timeEntryMinutesTotal']} minutos) · "
          f"plantilla {e10['headcountSnapshotCount']} snapshots")
    print(f"  presupuesto: {e10['budgetLineCount']} lineas · "
          f"total {e10['budgetTotalCentsByVersion']} · horas {e10['budgetHoursMinutesTotal']} minutos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
