#!/usr/bin/env python3
"""
E10 · T10 — Generador del PRESUPUESTO, las HORAS y la DESVIACION esperados.

    python3 docs/design/fixtures/build_presupuesto_horas_esperado.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), y por un camino
independiente en Python, todo lo que E10 tiene que reproducir al centimo sobre
el ejercicio 2026 del fixture inmutable `tests/fixtures/ejercicio-completo.json`:

  1. presupuesto `BASE` (doce meses) y `REVISADO 1` (solo el segundo semestre,
     `partialFrom`), con su forma canonica y su `budgetHash` (O-E10-7/9)
  2. la version EFECTIVA compuesta mes a mes, con su procedencia
  3. la matriz de presupuesto en la retícula de E4 (nivel de margen x columna),
     cumulativa, mensual y anual, con el signo de aporte por tipo analitico
  4. los partes de horas de **6 empleados x 12 meses** en minutos enteros, con
     tarifas con vigencias y `basis`, la plantilla mensual en `fteMilli` y el
     `timeHash` con su ventana efectiva (O-E10-1/3)
  5. la base de los drivers `HOURS` y `HEADCOUNT` por receptor y ventana
  6. la liquidacion REAL con reglas de actividad (Hamilton, cascada) y la
     **liquidacion PRESUPUESTARIA en dry-run** con las MISMAS reglas y las horas
     presupuestadas (O-E10-4, `settleBudgetMatrix`)
  7. la matriz presupuesto vs real por nivel, con desviaciones exactas, sin
     imputar y ya imputada, y el caso `BUDGET_NOT_SETTLEABLE` (I-E10-18)
  8. el forecast con corte a fin del mes 6 y su procedencia mes a mes (I-E10-7)
  9. los KPI de rentabilidad con horas (coste-hora medio, margen por hora MC2 y
     MC3, tarifa media facturada) y la desviacion de absorcion (O-E10-20)
 10. los umbrales `EV-11…13` y `EV-15…17`, disparados en casos concretos
 11. los invariantes `I-E10-*` computables en Python, verificados aqui

El REAL sale de los dos fixtures sellados de E4 y E5 —
`pyg-analitica-esperada.json` y `liquidacion-esperada.json`— y de sus
generadores, que se importan como libreria: la resolucion de cuentas, el tipo
analitico efectivo, el nivel, la columna, el reparto Hamilton y la cascada son
LOS MISMOS, que es lo que hace que la desviacion signifique algo. El
presupuesto se **deriva** del real con factores enteros declarados, de modo que
cada celda de desviacion es reproducible a mano.

Escribe `docs/design/fixtures/presupuesto-horas-esperado.v1.1.json`. Con `--check`
no escribe: reconstruye, compara byte a byte y falla si difiere.

Un fixture sellado no se reescribe: se versiona. `presupuesto-horas-esperado.json`
(schema 1.0) queda CONGELADO como evidencia de lo que se firmo en la ronda 0. La
ronda 1 corrige la forma canonica del `budgetHash` (auditor H-2/H-3, revisor
BLOQUEA 3): fuera `validTo` —mutable por diseno al sellar la version siguiente— y
dentro las lineas de horas presupuestadas. Los dos `budgetHash` cambian, asi que
este generador escribe y comprueba `presupuesto-horas-esperado.v1.1.json`.

NO TOCA `tests/fixtures/*`.

Contrato de cifras congelado (D6 de ADR-0018, §6 de la validacion de control de
gestion), aplicado aqui sin excepcion:

  1 minutos enteros, techo 1 440 por fila y por (empleado, dia)
  2 coste de un parte: Hamilton sobre `T = ⌊Σ mᵢrᵢ / 60⌋`, desempate por
    (fecha, codigo de empleado, id)
  3 base de `HOURS`: minutos APROBADOS y PRODUCTIVOS, contra-apuntes con su
    signo, `max(0, ·)` por receptor, sobre la ventana efectiva del run
  4 base de `HEADCOUNT`: Σ `fteMilli` de los snapshots del periodo (FTE·mes)
  5 forma canonica del `timeHash`: `fecha|empleado|receptor|minutos|productiva`
  6 `basis` por defecto `COSTE_EMPRESA_CON_SS` = 640+642+645+649; **641 fuera**
  7 signo del presupuesto: APORTE (haber - debe)

Las cifras son ILUSTRATIVAS: ninguna procede de datos reales.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
e4 = importlib.import_module("build_pyg_analitica_esperada")
e5 = importlib.import_module("build_liquidacion_esperada")

ROOT = e4.ROOT
OUT = HERE / "presupuesto-horas-esperado.v1.1.json"

FISCAL_YEAR = "2026"
MONTHS = [f"2026-{m:02d}" for m in range(1, 13)]
QUARTERS = ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]
YEAR = "2026"
MONTH_LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
FY_START, FY_END = "2026-01-01", "2026-12-31"
FORECAST_CUTOFF = "2026-06"        # corte a fin del mes 6 (criterio 7)

NULL = "∅"
PAYROLL_PREFIXES = ("640", "642", "645", "649")   # D6 punto 6: 641 FUERA
REFERENCE_PRODUCTIVE_MINUTES_YEAR = 90_000         # O-E10-19, solo respaldo
DERIVATION_MIN_COVERAGE_BPS = 7_500                # O-E10-12



def _trunc_bps(num: int, den: int) -> int:
    """Puntos basicos truncados hacia cero (convencion varianceBps del diseno:
    suelo de la magnitud y luego el signo), no suelo matematico."""
    q = abs(num) * 10_000 // abs(den)
    return -q if (num < 0) != (den < 0) else q

def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def month_days(month: str) -> int:
    return MONTH_LAST_DAY[int(month[5:7]) - 1]


def months_of(period: str) -> list[str]:
    return e5.months_of(period)


def hamilton(total: int, weights: list[tuple[str, int]]) -> list[tuple[str, int, int]]:
    """El de E5, sin una linea de diferencia: mayor resto, desempate por codigo."""
    return e5.hamilton(total, weights)


# ═══════════════════════════════════════════════════════════════════════════
# 1. Empleados, tarifas, partes de horas y plantilla
# ═══════════════════════════════════════════════════════════════════════════

BASIS = "COSTE_EMPRESA_CON_SS"

EMPLOYEES: list[dict[str, Any]] = [
    {"code": "E-01", "name": "Ana Iglesias", "costCenterCode": "CC-OPS", "productiveRole": True},
    {"code": "E-02", "name": "Bruno Cabrera", "costCenterCode": "CC-OPS", "productiveRole": True},
    {"code": "E-03", "name": "Carla Otero", "costCenterCode": "CC-DEV", "productiveRole": True},
    {"code": "E-04", "name": "Diego Sanz", "costCenterCode": "CC-DEV", "productiveRole": True},
    {"code": "E-05", "name": "Elena Prat", "costCenterCode": "CC-OPS", "productiveRole": True},
    {"code": "E-06", "name": "Fermin Lago", "costCenterCode": "CC-MKT", "productiveRole": False},
]

# Caso adverso: `E-05` se queda SIN TARIFA VIGENTE del 8 al 21 de junio, y
# `E-03` cambia de tarifa el 1 de julio (a mitad de ejercicio).
EMPLOYEE_RATES: list[dict[str, Any]] = [
    {"employeeCode": "E-01", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 3_200, "basis": BASIS},
    {"employeeCode": "E-02", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 2_850, "basis": BASIS},
    {"employeeCode": "E-03", "validFrom": "2026-01-01", "validTo": "2026-06-30", "hourlyCostCents": 3_600, "basis": BASIS},
    {"employeeCode": "E-03", "validFrom": "2026-07-01", "validTo": None, "hourlyCostCents": 3_950, "basis": BASIS},
    {"employeeCode": "E-04", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 2_600, "basis": BASIS},
    {"employeeCode": "E-05", "validFrom": "2026-01-01", "validTo": "2026-06-07", "hourlyCostCents": 3_050, "basis": BASIS},
    {"employeeCode": "E-05", "validFrom": "2026-06-22", "validTo": None, "hourlyCostCents": 3_150, "basis": BASIS},
    {"employeeCode": "E-06", "validFrom": "2026-01-01", "validTo": None, "hourlyCostCents": 2_400, "basis": BASIS},
]

# Minutos SEMANALES por empleado y receptor. Un parte por semana y receptor, en
# dias distintos: ni la fila ni el agregado por (empleado, dia) llegan a 1 440.
#
# **Por que los minutos son pequenos.** La nomina del fixture v1 son 26 400 € al
# ano en cuentas 64x (`CC-GA` 3 960 €, P-01 15 840 €, P-02 6 600 €). I-E10-12
# exige, con tolerancia 0, que el coste de personal valorado por horas **no
# exceda** al contabilizado: con una jornada completa el invariante daria FAIL
# todos los meses, que es exactamente lo que tiene que hacer. Los partes estan
# dimensionados a esa nomina y dejan una infraabsorcion pequena, que es la cifra
# que publica el informe de O-E10-20.
TIME_PLAN: dict[str, list[tuple[str, str, int, bool]]] = {
    "E-01": [("P-01", "PROJECT", 174, True), ("P-02", "PROJECT", 69, True)],
    "E-02": [("P-02", "PROJECT", 156, True), ("P-03", "PROJECT", 96, True)],
    "E-03": [("P-03", "PROJECT", 191, True), ("CC-DEV", "COST_CENTER", 34, False)],
    "E-04": [("P-03", "PROJECT", 174, True), ("P-01", "PROJECT", 69, True)],
    "E-05": [("P-01", "PROJECT", 122, True), ("CC-OPS", "COST_CENTER", 95, False)],
    "E-06": [("P-02", "PROJECT", 96, True), ("CC-MKT", "COST_CENTER", 108, False)],
}
WEEKS = 4
MONTH_FACTOR = [100, 96, 104, 98, 102, 95, 60, 105, 103, 101, 99, 100]   # julio = vacaciones
PROJECT_BL = {"P-01": "BL-CONS", "P-02": "BL-CONS", "P-03": "BL-DEV"}

# Caso adverso: en OCTUBRE los partes de `E-04` quedan SIN APROBAR (base parcial
# de O-E10-2: el reparto sale sobre el 100 % de lo aprobado y nadie avisaria).
UNAPPROVED = {("E-04", "2026-10")}


def build_time_entries() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for emp in EMPLOYEES:
        code = emp["code"]
        for i, month in enumerate(MONTHS):
            for week in range(WEEKS):
                for j, (target, kind, weekly, productive) in enumerate(TIME_PLAN[code]):
                    minutes = weekly * MONTH_FACTOR[i] // 100
                    if minutes == 0:
                        continue
                    rows.append({
                        "id": f"{code}-{month}-W{week + 1}-{target}",
                        "employeeCode": code,
                        "date": f"{month}-{6 + 7 * week + j:02d}",
                        "targetKind": kind,
                        "targetCode": target,
                        "businessLineCode": PROJECT_BL.get(target),
                        "minutes": minutes,
                        "productive": productive,
                        "approved": (code, month) not in UNAPPROVED,
                        "reversesId": None,
                        "reason": None,
                    })
    # Contra-apunte con motivo (I-E10-4): una hora de P-01 era de P-02.
    rows.append({
        "id": "E-01-2026-09-W4-P-01-CONTRA", "employeeCode": "E-01", "date": "2026-09-30",
        "targetKind": "PROJECT", "targetCode": "P-01", "businessLineCode": "BL-CONS",
        "minutes": -60, "productive": True, "approved": True,
        "reversesId": "E-01-2026-09-W4-P-01",
        "reason": "Correccion de imputacion: una hora de P-01 correspondia a P-02",
    })
    rows.append({
        "id": "E-01-2026-09-W4-P-02-CORRECCION", "employeeCode": "E-01", "date": "2026-09-30",
        "targetKind": "PROJECT", "targetCode": "P-02", "businessLineCode": "BL-CONS",
        "minutes": 60, "productive": True, "approved": True, "reversesId": None,
        "reason": "Correccion de imputacion: una hora que venia de P-01",
    })
    rows.sort(key=lambda r: (r["date"], r["employeeCode"], r["targetCode"], r["id"]))
    return rows


TIME_ENTRIES = build_time_entries()

# Plantilla mensual en `fteMilli`. Casos adversos de Q-7 y O-E10-16:
#   · `CC-DEV` nace en febrero y muere en noviembre  -> FTE·mes 30 000, no 3 000
#   · `CC-MKT` no tiene snapshot en agosto           -> PLANTILLA_AUSENTE
#   · `CC-MKT` declara CERO en enero                 -> es un dato, no un hueco
HEADCOUNT_STOCK = {"CC-GA": 2_000, "CC-MKT": 1_500, "CC-OPS": 4_000, "CC-DEV": 3_000}


def build_headcount() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for month in MONTHS:
        for cc in ("CC-GA", "CC-MKT", "CC-OPS", "CC-DEV"):
            if cc == "CC-DEV" and not ("2026-02" <= month <= "2026-11"):
                continue
            if cc == "CC-MKT" and month == "2026-08":
                continue
            fte = 0 if (cc == "CC-MKT" and month == "2026-01") else HEADCOUNT_STOCK[cc]
            rows.append({"costCenterCode": cc, "month": f"{month}-01",
                         "asOf": f"{month}-{month_days(month):02d}", "fteMilli": fte})
    return rows


HEADCOUNT = build_headcount()


# --- agregados de horas (espejo de `lib/time/aggregate.ts`) -----------------

def in_window(date: str, window: tuple[str, str]) -> bool:
    return window[0] <= date <= window[1]


def minutes_by_target(window: tuple[str, str], productive_only: bool = True,
                      approved_only: bool = True) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for row in TIME_ENTRIES:
        if not in_window(row["date"], window):
            continue
        if approved_only and not row["approved"]:
            continue
        if not approved_only and row["approved"]:
            continue
        if productive_only and not row["productive"]:
            continue
        out[row["targetCode"]] += row["minutes"]
    return dict(sorted(out.items()))


def canonical_time_form(window: tuple[str, str]) -> str:
    """D6 punto 5: `fecha|empleado|receptor|minutos|productiva`, SIN `id`, solo
    APROBADAS, ordenada por esa misma tupla."""
    rows = [
        ("|".join([r["date"], r["employeeCode"], r["targetCode"], str(r["minutes"]),
                   "1" if r["productive"] else "0"]), r["id"])
        for r in TIME_ENTRIES if r["approved"] and in_window(r["date"], window)
    ]
    # El orden es el del renglon YA RENDERIZADO, y el `id` solo desempata dos
    # renglones identicos (en cuyo caso el hash no cambia): es exactamente lo
    # que hace `canonicalTimeForm` en `lib/time/aggregate.ts`, y tiene que serlo
    # o los dos caminos darian hashes distintos con los mismos partes.
    rows.sort()
    return "\n".join(row for row, _ in rows)


def time_window_of(rules: list[dict[str, Any]], period: str) -> tuple[str, str] | None:
    """O-E10-1 · `timeWindowOf`. Ventana que el run puede llegar a consumir."""
    activity = [r for r in rules if r["driver"] in ("HOURS", "HEADCOUNT")]
    if not activity:
        return None
    start, end = e5.period_bounds(period)
    starts = [start]
    for rule in activity:
        if rule.get("zeroBaseFallback") == "YTD":
            starts.append(FY_START)
        if rule.get("zeroBaseFallback") == "PRIOR_PERIOD":
            ms = months_of(period)
            first = ms[0]
            index = MONTHS.index(first)
            starts.append(f"{MONTHS[max(0, index - 1)]}-01")
    return (min(starts), end)


# --- coste de los partes (espejo de `lib/time/cost.ts`) ---------------------

def rate_at(employee: str, date: str) -> int | None:
    for rate in EMPLOYEE_RATES:
        if rate["employeeCode"] != employee:
            continue
        if rate["validFrom"] <= date and (rate["validTo"] is None or date <= rate["validTo"]):
            return rate["hourlyCostCents"]
    return None


def cost_of_time(window: tuple[str, str]) -> dict[str, Any]:
    """D6 punto 2 · O-E10-13. `T = ⌊Σ mᵢrᵢ / 60⌋` por receptor y Hamilton sobre
    los pesos `mᵢ·rᵢ`, con desempate por (fecha, codigo de empleado, id)."""
    by_target: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unpriced: list[dict[str, Any]] = []
    for row in TIME_ENTRIES:
        # Solo APROBADAS y PRODUCTIVAS, igual que `costOfTime` en
        # `lib/time/cost.ts`: el modelo A de Q-3 valora las horas productivas a
        # la tarifa y NO vuelve a repartir el coste de las no productivas.
        if not row["approved"] or not row["productive"] or not in_window(row["date"], window):
            continue
        rate = rate_at(row["employeeCode"], row["date"])
        if rate is None:
            unpriced.append({"id": row["id"], "employeeCode": row["employeeCode"],
                             "date": row["date"], "targetCode": row["targetCode"],
                             "minutes": row["minutes"],
                             "reason": "TARIFA_AUSENTE"})
            continue
        by_target[row["targetCode"]].append({"id": row["id"], "date": row["date"],
                                             "employeeCode": row["employeeCode"],
                                             "minutes": row["minutes"], "rate": rate})
    result: dict[str, int] = {}
    per_row: dict[str, int] = {}
    for target in sorted(by_target):
        rows = sorted(by_target[target], key=lambda r: (r["date"], r["employeeCode"], r["id"]))
        weighted = sum(r["minutes"] * r["rate"] for r in rows)
        total = weighted // 60 if weighted >= 0 else -((-weighted) // 60)
        result[target] = total
        # Hamilton sobre `mᵢ·rᵢ`; el desempate por (fecha, empleado, id) se
        # consigue ordenando y usando el indice como codigo del reparto.
        weights = [(f"{i:04d}", r["minutes"] * r["rate"]) for i, r in enumerate(rows)]
        for (key, cents, _bps) in hamilton(total, weights):
            per_row[rows[int(key)]["id"]] = cents
        assert sum(per_row[r["id"]] for r in rows) == total, f"Hamilton del coste roto en {target}"
    return {"byTarget": result, "perRow": per_row,
            "unpriced": sorted(unpriced, key=lambda r: (r["date"], r["id"])),
            "targetsWithUnpricedRows": sorted({r["targetCode"] for r in unpriced})}


# ═══════════════════════════════════════════════════════════════════════════
# 2. El REAL: diario del fixture v1, con las funciones de E4
# ═══════════════════════════════════════════════════════════════════════════

REAL = e5.read_ledger()
PROJECTS: list[str] = REAL["projects"]
BUSINESS_LINES: list[str] = REAL["business_lines"]
CECO_KIND: dict[str, str] = REAL["ceco_kind"]
CECO_LEVEL: dict[str, str] = REAL["ceco_level"]

COLUMNS = ([f"PROJ:{p}" for p in PROJECTS]
           + [f"BL:{b}" for b in BUSINESS_LINES]
           + [e4.col_ceco(k) for k in e4.CECO_KINDS]
           + [e4.COL_AMORT, e4.COL_FIN, e4.COL_EXTRA, e4.COL_NA])


def read_real_cells() -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Lineas 6/7 del ejercicio agregadas a granularidad de CELDA de presupuesto:
    (mes, dimension, cuenta, tipo analitico). Devuelve tambien la nomina 64x."""
    fx = json.loads(e4.FIXTURE.read_text(encoding="utf-8"))
    cells: dict[tuple, int] = defaultdict(int)
    payroll_by_ceco: dict[str, int] = defaultdict(int)
    for entry in fx["entries"]:
        if entry["fiscalYearCode"] != FISCAL_YEAR or entry["kind"] in e4.EXCLUDED_KINDS:
            continue
        month = entry["date"][:7]
        for line in entry["lines"]:
            raw = e4.KEY_TO_CODE[line["accountKey"]] if "accountKey" in line else line["accountCode"]
            code = e4.resolve_postable(raw)
            if code[0] not in "67":
                continue
            amount = line["creditCents"] - line["debitCents"]
            project, ceco = line.get("projectCode"), line.get("costCenterCode")
            atype = e4.effective_analytic_type(code, project, ceco, line.get("analyticType"))
            if code.startswith(PAYROLL_PREFIXES):
                payroll_by_ceco[ceco or (f"PROJ:{project}" if project else "SIN_DIMENSION")] += -amount
            if project is None and ceco is None:
                continue          # sin dimension no hay celda de presupuesto (I-E10-8)
            cells[(month, "PROJECT" if project else "COST_CENTER",
                   project or ceco, code, atype)] += amount
    rows = [{"month": m, "dimensionKind": dk, "dimensionCode": dc, "accountCode": ac,
             "analyticType": at, "amountCents": v}
            for (m, dk, dc, ac, at), v in sorted(cells.items()) if v != 0]
    return rows, dict(sorted(payroll_by_ceco.items()))


REAL_CELLS, PAYROLL_BY_CECO = read_real_cells()


# ═══════════════════════════════════════════════════════════════════════════
# 3. El PRESUPUESTO: derivado del real con factores enteros declarados
# ═══════════════════════════════════════════════════════════════════════════

# Signo que le corresponde a cada tipo analitico (D6 punto 7 / O-E10-6).
POSITIVE_TYPES = {"INGRESO_DIRECTO"}
NEGATIVE_TYPES = {"COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2", "INDIRECTO_CECO", "AMORTIZACION_DETERIORO"}
SIGN_EXCEPTION_PREFIXES = ("61", "71", "706", "708", "709", "79", "759")

# Factores de la version BASE, en puntos basicos sobre la MAGNITUD del real.
# Positivo = el plan preveia mas que lo ejecutado.
BASE_DELTA_BPS: dict[str, int] = {
    "INGRESO_DIRECTO": 500,            # +5 % de ingreso presupuestado
    "COSTE_DIRECTO_MC1": -300,         # -3 % de coste directo
    "COSTE_DIRECTO_MC2": 200,
    "INDIRECTO_CECO": 400,
    "AMORTIZACION_DETERIORO": 0,
    "FINANCIERO": 0,
    "EXTRAORDINARIO": 0,
    "NO_ANALITICO": 0,
}
# La `REVISADO 1` solo trae jul-dic y corrige a la baja el ingreso y al alza la
# estructura: es la reproyeccion de mitad de ano.
REV1_DELTA_BPS: dict[str, int] = dict(BASE_DELTA_BPS) | {
    "INGRESO_DIRECTO": -800,
    "INDIRECTO_CECO": 900,
}


def apply_delta(amount: int, bps: int) -> int:
    sign = -1 if amount < 0 else 1
    return sign * (abs(amount) * (10_000 + bps) // 10_000)


def canonical_sign(amount: int, atype: str, account: str) -> tuple[int, bool]:
    """Devuelve (importe con el signo que exige el tipo, signException)."""
    if atype in POSITIVE_TYPES and amount < 0:
        if account.startswith(SIGN_EXCEPTION_PREFIXES):
            return amount, True            # devolucion / rappel: excepcion DECLARADA
        return -amount, False
    if atype in NEGATIVE_TYPES and amount > 0:
        if account.startswith(SIGN_EXCEPTION_PREFIXES):
            return amount, True
        return -amount, False
    return amount, False


def margin_level_of(atype: str, account: str, ceco: str | None) -> str:
    return e4.level_of(atype, account, ceco, CECO_LEVEL)


def build_budget_lines(delta: dict[str, int], months: list[str]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for cell in REAL_CELLS:
        if cell["month"] not in months:
            continue
        amount, exception = canonical_sign(
            apply_delta(cell["amountCents"], delta[cell["analyticType"]]),
            cell["analyticType"], cell["accountCode"])
        if amount == 0:
            continue
        ceco = cell["dimensionCode"] if cell["dimensionKind"] == "COST_CENTER" else None
        lines.append({
            "month": f"{cell['month']}-01",
            "accountCode": cell["accountCode"],
            "analyticType": cell["analyticType"],
            "marginLevel": margin_level_of(cell["analyticType"], cell["accountCode"], ceco),
            "dimensionKind": cell["dimensionKind"],
            "dimensionCode": cell["dimensionCode"],
            "businessLineCode": PROJECT_BL.get(cell["dimensionCode"]),
            "amountCents": amount,
            "signException": exception,
        })
    lines.sort(key=lambda l: (l["month"], l["dimensionKind"], l["dimensionCode"],
                              l["accountCode"], l["analyticType"]))
    return lines


H1 = MONTHS[:6]
H2 = MONTHS[6:]

MARGIN_CONFIG = {
    "levels": e4.MARGIN_LEVEL_CONFIG,
    "nonAnalyticLevel": e4.NON_ANALYTIC_LEVEL,
    "taxPrefixes": list(e4.NON_ANALYTIC_TAX_PREFIXES),
    "costCenterLevels": dict(sorted(CECO_LEVEL.items())),
}
MARGIN_CONFIG_HASH = sha256(json.dumps(MARGIN_CONFIG, sort_keys=True, ensure_ascii=False))

def minutes_by_month_target(approved: bool) -> dict[tuple[str, str], int]:
    out: dict[tuple[str, str], int] = defaultdict(int)
    for row in TIME_ENTRIES:
        if row["approved"] != approved or not row["productive"]:
            continue
        if row["targetKind"] != "PROJECT":
            continue
        out[(row["date"][:7], row["targetCode"])] += row["minutes"]
    return dict(out)


REAL_MINUTES = minutes_by_month_target(approved=True)
UNAPPROVED_MINUTES = minutes_by_month_target(approved=False)

# Horas PRESUPUESTADAS por (mes, proyecto): el plan preveia un 5 % menos de
# minutos que los realmente aprobados. Son las que alimentan la liquidacion
# presupuestaria de O-E10-4 — para eso existen `BudgetHoursLine`.
BUDGET_HOURS = {k: v * 9_500 // 10_000 for k, v in REAL_MINUTES.items()}


def build_budget_hours_lines(months: list[str]) -> list[dict[str, Any]]:
    return [{"month": f"{m}-01", "dimensionKind": "PROJECT", "dimensionCode": p,
             "businessLineCode": PROJECT_BL[p], "employeeCode": None, "minutes": v}
            for (m, p), v in sorted(BUDGET_HOURS.items()) if m in months]


BUDGET_HOURS_LINES = build_budget_hours_lines(MONTHS)

BUDGETS: list[dict[str, Any]] = [
    {"code": "2026-BASE", "scenario": "BASE", "revision": 0, "status": "VIGENTE",
     "validFrom": "2026-01-01", "validTo": "2026-06-30", "partialFrom": None,
     "lines": build_budget_lines(BASE_DELTA_BPS, MONTHS),
     "hoursLines": build_budget_hours_lines(MONTHS)},
    {"code": "2026-REV1", "scenario": "REVISADO", "revision": 1, "status": "VIGENTE",
     "validFrom": "2026-07-01", "validTo": None, "partialFrom": "2026-07-01",
     "lines": build_budget_lines(REV1_DELTA_BPS, H2),
     "hoursLines": build_budget_hours_lines(H2)},
]

HOURS_SEPARATOR = "∅HORAS"


def canonical_budget_form(version: dict[str, Any], margin_config_hash: str) -> str:
    """O-E10-7. Cabecera con la identidad de la version y el sello de la
    configuracion de margenes, una linea por celda de importe con su
    `marginLevel` CONGELADO —sin el, mover un CECO de MC3 a EBITDA leeria el
    mismo presupuesto en otra fila sin cambiar el hash— y una linea por celda de
    HORAS, en minutos enteros.

    Ronda 1 (auditor H-2/H-3, revisor BLOQUEA 3):

      · `validTo` NO entra. Es mutable POR DISENO: al sellar la siguiente
        version, `sealBudgetTx` cierra la anterior con `validTo = validFrom - 1`
        y el trigger de inmutabilidad lo admite expresamente. Con `validTo`
        dentro, el hash de toda version relevada dejaba de ser reproducible e
        I-E10-6 daba FAIL sobre datos integros.
      · Las lineas de HORAS si entran (ADR-0018 D2, diseno 3.8): alimentan la
        liquidacion presupuestaria en dry-run, o sea las celdas de MC3 por
        dimension del informe. Sin ellas, el sello no atestiguaba la base del
        reparto."""
    head = "\t".join([version["scenario"], str(version["revision"]), version["validFrom"],
                      version["partialFrom"] or NULL, margin_config_hash])
    rows = sorted(
        "\t".join([l["month"], l["dimensionKind"], l["dimensionCode"],
                   l["accountCode"] or NULL, l["analyticType"] or NULL,
                   l["marginLevel"], str(l["amountCents"]),
                   "1" if l["signException"] else "0"])
        for l in version["lines"])
    hours = sorted(
        "\t".join([h["month"], h["dimensionKind"], h["dimensionCode"],
                   h["employeeCode"] or NULL, str(h["minutes"])])
        for h in version["hoursLines"])
    return "\n".join([head, *rows, HOURS_SEPARATOR, *hours])


for _b in BUDGETS:
    _b["budgetHash"] = sha256(canonical_budget_form(_b, MARGIN_CONFIG_HASH))
    _b["marginConfigHash"] = MARGIN_CONFIG_HASH


def compose_budget() -> tuple[list[dict[str, Any]], dict[str, str]]:
    """O-E10-9. La ultima version no parcial, sustituida mes a mes por las
    `partialFrom` posteriores. Con la procedencia de cada mes."""
    provenance = {m: "2026-BASE" for m in MONTHS}
    for version in BUDGETS:
        if version["partialFrom"] is None:
            continue
        for month in MONTHS:
            if f"{month}-01" >= version["partialFrom"]:
                provenance[month] = version["code"]
    by_code = {b["code"]: b for b in BUDGETS}
    lines = [l for month, code in provenance.items()
             for l in by_code[code]["lines"] if l["month"][:7] == month]
    lines.sort(key=lambda l: (l["month"], l["dimensionKind"], l["dimensionCode"],
                              l["accountCode"], l["analyticType"]))
    return lines, provenance


EFFECTIVE_LINES, PROVENANCE = compose_budget()


# ═══════════════════════════════════════════════════════════════════════════
# 4. Matrices: la del presupuesto y la del real, con las MISMAS funciones
# ═══════════════════════════════════════════════════════════════════════════

def contrib_of_budget(lines: list[dict[str, Any]]) -> tuple[dict, dict]:
    """Contribucion por (nivel, columna) y por (mes, nivel, columna)."""
    total: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in e4.LEVELS}
    by_month: dict[str, dict[str, dict[str, int]]] = {
        m: {lv: defaultdict(int) for lv in e4.LEVELS} for m in MONTHS}
    for line in lines:
        project = line["dimensionCode"] if line["dimensionKind"] == "PROJECT" else None
        ceco = line["dimensionCode"] if line["dimensionKind"] == "COST_CENTER" else None
        column = e4.column_of(line["analyticType"], project, ceco, CECO_KIND)
        level = line["marginLevel"]
        total[level][column] += line["amountCents"]
        by_month[line["month"][:7]][level][column] += line["amountCents"]
    return total, by_month


def contrib_of_real() -> tuple[dict, dict]:
    fx = json.loads(e4.FIXTURE.read_text(encoding="utf-8"))
    total: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in e4.LEVELS}
    by_month: dict[str, dict[str, dict[str, int]]] = {
        m: {lv: defaultdict(int) for lv in e4.LEVELS} for m in MONTHS}
    for entry in fx["entries"]:
        if entry["fiscalYearCode"] != FISCAL_YEAR or entry["kind"] in e4.EXCLUDED_KINDS:
            continue
        month = entry["date"][:7]
        for line in entry["lines"]:
            raw = e4.KEY_TO_CODE[line["accountKey"]] if "accountKey" in line else line["accountCode"]
            code = e4.resolve_postable(raw)
            if code[0] not in "67":
                continue
            amount = line["creditCents"] - line["debitCents"]
            project, ceco = line.get("projectCode"), line.get("costCenterCode")
            atype = e4.effective_analytic_type(code, project, ceco, line.get("analyticType"))
            column = e4.column_of(atype, project, ceco, CECO_KIND)
            level = e4.level_of(atype, code, ceco, CECO_LEVEL)
            total[level][column] += amount
            by_month[month][level][column] += amount
    return total, by_month


def cumulative(contrib: dict[str, dict[str, int]], delta: dict[str, dict[str, int]] | None = None
               ) -> dict[str, dict[str, int]]:
    running = {c: 0 for c in COLUMNS}
    out: dict[str, dict[str, int]] = {}
    for level in e4.LEVELS:
        for column in COLUMNS:
            running[column] += contrib[level].get(column, 0)
            if delta:
                running[column] += delta[level].get(column, 0)
        out[level] = dict(running)
    return out


BUDGET_CONTRIB, BUDGET_CONTRIB_MONTH = contrib_of_budget(EFFECTIVE_LINES)
REAL_CONTRIB, REAL_CONTRIB_MONTH = contrib_of_real()


# ═══════════════════════════════════════════════════════════════════════════
# 5. Reglas de E10 y motor de liquidacion con drivers de actividad
# ═══════════════════════════════════════════════════════════════════════════

RULES_E10: list[dict[str, Any]] = [
    {"code": "AL-OPS-M", "name": "Operaciones indirectas a proyectos por HORAS (mensual)",
     "sourceCostCenterCode": "CC-OPS", "period": "MONTH", "priority": 10, "sourceShareBps": 10_000,
     "targetKind": "PROJECTS", "driver": "HOURS",
     "targetFilter": {"projectStatus": ["ACTIVE"]}, "zeroBaseFallback": "YTD", "targets": []},
    {"code": "AL-DEV-Q", "name": "Desarrollo de producto a lineas de negocio 60/40 (trimestral)",
     "sourceCostCenterCode": "CC-DEV", "period": "QUARTER", "priority": 10, "sourceShareBps": 10_000,
     "targetKind": "BUSINESS_LINES", "driver": "FIXED_PERCENT", "targetFilter": None,
     "zeroBaseFallback": "SKIP_WARN",
     "targets": [{"businessLineCode": "BL-CONS", "percentBps": 6_000},
                 {"businessLineCode": "BL-DEV", "percentBps": 4_000}]},
    {"code": "AL-MKT-Q", "name": "Marketing y ventas a proyectos por ingresos (trimestral)",
     "sourceCostCenterCode": "CC-MKT", "period": "QUARTER", "priority": 20, "sourceShareBps": 10_000,
     "targetKind": "PROJECTS", "driver": "REVENUE_SHARE",
     "targetFilter": {"projectStatus": ["ACTIVE"]}, "zeroBaseFallback": "SKIP_WARN", "targets": []},
    {"code": "AL-GA-CC-Y", "name": "G&A: 30 % a CECOs por PLANTILLA (anual, FTE·mes)",
     "sourceCostCenterCode": "CC-GA", "period": "YEAR", "priority": 10, "sourceShareBps": 3_000,
     "targetKind": "COST_CENTERS", "driver": "HEADCOUNT", "targetFilter": None,
     "zeroBaseFallback": "SKIP_WARN",
     "targets": [{"costCenterCode": "CC-OPS"}, {"costCenterCode": "CC-DEV"}]},
    {"code": "AL-GA-PRY-Y", "name": "G&A: 70 % a proyectos a partes iguales (anual)",
     "sourceCostCenterCode": "CC-GA", "period": "YEAR", "priority": 20, "sourceShareBps": 7_000,
     "targetKind": "PROJECTS", "driver": "EQUAL",
     "targetFilter": {"projectStatus": ["ACTIVE"]}, "zeroBaseFallback": "SKIP_WARN", "targets": []},
    {"code": "AL-DEV-Y", "name": "Desarrollo de producto: redistribuye lo recibido (anual)",
     "sourceCostCenterCode": "CC-DEV", "period": "YEAR", "priority": 25, "sourceShareBps": 10_000,
     "targetKind": "BUSINESS_LINES", "driver": "FIXED_PERCENT", "targetFilter": None,
     "zeroBaseFallback": "SKIP_WARN",
     "targets": [{"businessLineCode": "BL-CONS", "percentBps": 6_000},
                 {"businessLineCode": "BL-DEV", "percentBps": 4_000}]},
    {"code": "AL-OPS-Y", "name": "Operaciones indirectas: redistribuye lo recibido por HORAS (anual)",
     "sourceCostCenterCode": "CC-OPS", "period": "YEAR", "priority": 30, "sourceShareBps": 10_000,
     "targetKind": "PROJECTS", "driver": "HOURS",
     "targetFilter": {"projectStatus": ["ACTIVE"]}, "zeroBaseFallback": "SKIP_WARN", "targets": []},
]


def canonical_rules_form(rules: list[dict[str, Any]]) -> str:
    """Espejo de `canonicalRulesForm` de `lib/analytics/allocate.ts`, con codigos
    en lugar de uuids (el fixture no tiene base de datos)."""
    out = []
    for rule in sorted(rules, key=lambda r: (r["priority"], r["code"])):
        targets = sorted(
            ",".join([t.get("projectCode", NULL), t.get("businessLineCode", NULL),
                      t.get("costCenterCode", NULL), str(t.get("percentBps", NULL))])
            for t in rule["targets"])
        out.append("\t".join([
            rule["code"], rule["sourceCostCenterCode"], rule["targetKind"], rule["driver"],
            rule["period"], str(rule["priority"]), str(rule["sourceShareBps"]),
            rule["zeroBaseFallback"],
            NULL if rule["targetFilter"] is None else json.dumps(rule["targetFilter"], sort_keys=True),
            FY_START, NULL, "1", ";".join(targets)]))
    return "\n".join(out)


RULES_HASH = sha256(canonical_rules_form(RULES_E10))


class ActivityEngine(e5.Engine):
    """El motor de E5 **sin tocar** —Hamilton, grafo, cascada, `sourceShareBps`,
    el nivel que viaja con el importe— con las dos ramas nuevas de
    `driverWeights`: `HOURS` y `HEADCOUNT` (§3.6 del diseno)."""

    def __init__(self, L: dict[str, Any], minutes_by_month_target: dict[tuple[str, str], int],
                 unapproved_by_month_target: dict[tuple[str, str], int],
                 headcount: list[dict[str, Any]], label: str) -> None:
        super().__init__(L)
        self.minutes = defaultdict(int, minutes_by_month_target)
        self.unapproved = defaultdict(int, unapproved_by_month_target)
        self.fte = defaultdict(int)
        for row in headcount:
            self.fte[(row["month"][:7], row["costCenterCode"])] += row["fteMilli"]
        self.headcount_months = {(r["month"][:7], r["costCenterCode"]) for r in headcount}
        self.label = label

    # -- HOURS ------------------------------------------------------------
    def hours_weights(self, rule: dict[str, Any], period: str,
                      fallback_used: list[str]) -> list[tuple[str, int]]:
        targets = self.eligible_projects(rule, period)
        ms = months_of(period)
        weights = [(p, max(0, sum(self.minutes[(m, p)] for m in ms))) for p in targets]
        unapproved = {p: sum(self.unapproved[(m, p)] for m in ms) for p in targets}
        base_total = sum(w for _, w in weights)
        # O-E10-2: se emite SIEMPRE que haya minutos sin firmar, ANTES de la rama
        # de base cero (revision ronda 1, hallazgo 4). El 100 % sin aprobar es el
        # caso extremo del parcial, no una excepcion: salir por el fallback sin
        # emitir el aviso sellaba el run sin `HORAS_SIN_APROBAR`.
        if any(v > 0 for v in unapproved.values()):
            total_unapproved = sum(unapproved.values())
            self.warnings.append({
                "code": "W-E10-UNAPPROVED-HOURS", "rule": rule["code"], "period": period,
                "unapprovedMinutes": total_unapproved,
                # `null` con base 0: no hay porcentaje sobre una base vacia, y un
                # 0 se leeria como «no hay nada pendiente».
                "shareOfBaseBps": None if base_total == 0 else total_unapproved * 10_000 // base_total,
                "targets": sorted(p for p, v in unapproved.items() if v > 0),
                "sealReason": "HORAS_SIN_APROBAR",
                "detail": "hay minutos sin aprobar de receptores elegibles en la ventana del driver"})
        if base_total == 0:
            fallback = rule["zeroBaseFallback"]
            self.warnings.append({
                "code": "W-E10-NO-HOURS", "rule": rule["code"], "period": period,
                "fallback": fallback,
                "detail": "no hay minutos aprobados y productivos de receptores elegibles en la ventana"})
            if fallback == "SKIP_WARN":
                return []
            if fallback == "EQUAL":
                fallback_used.append("EQUAL")
                return [(p, 1) for p in targets]
            if fallback == "YTD":
                fallback_used.append("YTD")
                upto = MONTHS[:MONTHS.index(ms[-1]) + 1]
                return [(p, max(0, sum(self.minutes[(m, p)] for m in upto))) for p in targets]
            raise ValueError(fallback)
        return weights

    # -- HEADCOUNT --------------------------------------------------------
    def headcount_weights(self, rule: dict[str, Any], period: str) -> list[tuple[str, int]]:
        assert rule["targetKind"] == "COST_CENTERS", "HEADCOUNT solo reparte a CECOs"
        ms = months_of(period)
        targets = [t["costCenterCode"] for t in rule["targets"]]
        weights = [(cc, sum(self.fte[(m, cc)] for m in ms)) for cc in targets]
        missing = [cc for cc in targets if not any((m, cc) in self.headcount_months for m in ms)]
        if missing:
            self.warnings.append({
                "code": "W-E10-NO-HEADCOUNT", "rule": rule["code"], "period": period,
                "targets": sorted(missing), "sealReason": "PLANTILLA_AUSENTE",
                "detail": "receptor sin ningun snapshot de plantilla en el periodo: peso 0"})
        trapped = [cc for cc in targets
                   if not any(r["sourceCostCenterCode"] == cc for r in RULES_E10
                              if (r["priority"], r["code"]) > (rule["priority"], rule["code"])
                              and r["period"] == rule["period"])]
        if trapped:
            self.warnings.append({
                "code": "W-E10-HEADCOUNT-TRAPPED", "rule": rule["code"], "period": period,
                "targets": sorted(trapped),
                "detail": "el receptor no tiene regla posterior con la que repartir lo recibido"})
        return weights

    def driver_weights(self, rule: dict[str, Any], period: str,
                       fallback_used: list[str]) -> list[tuple[str, int]]:
        if rule["driver"] == "HOURS":
            return self.hours_weights(rule, period, fallback_used)
        if rule["driver"] == "HEADCOUNT":
            return self.headcount_weights(rule, period)
        return super().driver_weights(rule, period, fallback_used)


def ledger_like_from_budget() -> dict[str, Any]:
    """El mismo `L` que consume el motor, pero con las cifras del PRESUPUESTO.

    `settleBudgetMatrix` no es un motor nuevo: es `allocate()` con otra entrada.
    """
    revenue: dict[tuple[str, str], int] = defaultdict(int)
    direct_cost: dict[tuple[str, str], int] = defaultdict(int)
    ceco_own: dict[tuple[str, str], int] = defaultdict(int)
    for line in EFFECTIVE_LINES:
        month = line["month"][:7]
        atype, amount, dim = line["analyticType"], line["amountCents"], line["dimensionCode"]
        if atype == "INGRESO_DIRECTO" and line["dimensionKind"] == "PROJECT":
            if not line["accountCode"].startswith(e5.REVENUE_SHARE_EXCLUDED_PREFIXES):
                revenue[(month, dim)] += amount
        elif atype in ("COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2") and line["dimensionKind"] == "PROJECT":
            direct_cost[(month, dim)] += -amount
        elif atype == "INDIRECTO_CECO" and line["dimensionKind"] == "COST_CENTER":
            ceco_own[(month, dim)] += -amount
    out = dict(REAL)
    out["contrib"] = BUDGET_CONTRIB
    out["revenue"], out["direct_cost"], out["ceco_own"] = revenue, direct_cost, ceco_own
    out["pyg"] = sum(sum(v.values()) for v in BUDGET_CONTRIB.values())
    return out


def settle(L: dict[str, Any], minutes: dict, unapproved: dict, label: str) -> ActivityEngine:
    engine = ActivityEngine(L, minutes, unapproved, HEADCOUNT, label)
    engine.run_all()
    return engine


def allocation_delta(engine: ActivityEngine) -> dict[str, dict[str, int]]:
    delta: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in e4.LEVELS}
    for line in engine.lines:
        level = line["marginLevel"]
        source = e4.col_ceco(CECO_KIND[line["sourceCostCenterCode"]])
        if line["targetKind"] == "PROJECTS":
            target = f"PROJ:{line['target']}"
        elif line["targetKind"] == "BUSINESS_LINES":
            target = f"BL:{line['target']}"
        else:
            target = e4.col_ceco(CECO_KIND[line["target"]])
        delta[level][source] += line["amountCents"]
        delta[level][target] -= line["amountCents"]
    return delta


# El motor de E5 lee sus reglas de una global del modulo: se sustituyen por las
# de E10 antes de correr —de forma explicita, en un solo sitio— y se restauran
# despues, para que importar este modulo no cambie el comportamiento de
# `build_liquidacion_esperada.py` si los dos viven en el mismo proceso.
_E5_RULES_ORIGINAL = e5.RULES
e5.RULES = RULES_E10

REAL_ENGINE = settle(REAL, REAL_MINUTES, UNAPPROVED_MINUTES, "real")
BUDGET_ENGINE = settle(ledger_like_from_budget(), BUDGET_HOURS, {}, "presupuesto")

e5.RULES = _E5_RULES_ORIGINAL

REAL_MATRIX_NONE = cumulative(REAL_CONTRIB)
BUDGET_MATRIX_NONE = cumulative(BUDGET_CONTRIB)
REAL_MATRIX_SETTLED = cumulative(REAL_CONTRIB, allocation_delta(REAL_ENGINE))
BUDGET_MATRIX_SETTLED = cumulative(BUDGET_CONTRIB, allocation_delta(BUDGET_ENGINE))


# ═══════════════════════════════════════════════════════════════════════════
# 6. Desviacion, comparabilidad y forecast
# ═══════════════════════════════════════════════════════════════════════════

def variance_bps(actual: int, budget: int) -> int | None:
    """`⌊|real - ppto| · 10000 / |ppto|⌋` con signo, ENTERO. Presupuesto 0 => null."""
    if budget == 0:
        return None
    sign = -1 if (actual - budget) < 0 else 1
    return sign * (abs(actual - budget) * 10_000 // abs(budget))


def build_variance(real: dict, budget: dict, state_real: str, state_budget: str,
                   month: str | None = None) -> list[dict[str, Any]]:
    """`desviacion = real - presupuesto`, resta entera y nada mas.

    I-E10-18: si los dos estados de imputacion no coinciden, toda celda POR
    DIMENSION de nivel >= MC3 sale `notComparable` y **no se publica**. INGRESOS,
    MC1 y MC2 si (la liquidacion no las toca) y el TOTAL de compania tambien
    (ahi la imputacion es de suma cero)."""
    comparable = state_real == state_budget
    cells: list[dict[str, Any]] = []
    for level in e4.LEVELS:
        for column in COLUMNS:
            actual, planned = real[level].get(column, 0), budget[level].get(column, 0)
            if actual == 0 and planned == 0:
                continue
            by_dimension = column.startswith(("PROJ:", "BL:", "CECO:"))
            not_comparable = (not comparable and by_dimension
                              and e4.LEVELS.index(level) >= e4.LEVELS.index("MC3"))
            cells.append({
                "level": level, "column": column, "month": month,
                "actualCents": actual,
                "budgetCents": None if not_comparable else planned,
                "varianceCents": None if not_comparable else actual - planned,
                "varianceBps": None if not_comparable else variance_bps(actual, planned),
                "notComparable": not_comparable,
            })
    return cells


def level_totals(matrix: dict[str, dict[str, int]]) -> dict[str, int]:
    return {lv: sum(matrix[lv].values()) for lv in e4.LEVELS}


def monthly_matrix(contrib_month: dict) -> dict[str, dict[str, dict[str, int]]]:
    return {m: cumulative(contrib_month[m]) for m in MONTHS}


REAL_MONTHLY = monthly_matrix(REAL_CONTRIB_MONTH)
BUDGET_MONTHLY = monthly_matrix(BUDGET_CONTRIB_MONTH)


def build_forecast(cutoff: str) -> dict[str, Any]:
    """`forecast(m) = real(m)` hasta el corte, `presupuesto(m)` despues (I-E10-7)."""
    by_month: dict[str, Any] = {}
    totals = {lv: {c: 0 for c in COLUMNS} for lv in e4.LEVELS}
    for month in MONTHS:
        source = "REAL_CERRADO" if month <= cutoff else "PRESUPUESTO_ABIERTO"
        cells = REAL_CONTRIB_MONTH[month] if source == "REAL_CERRADO" else BUDGET_CONTRIB_MONTH[month]
        by_month[month] = {"source": source,
                           "provenanceBudget": None if source == "REAL_CERRADO" else PROVENANCE[month],
                           "cells": {lv: dict(sorted(cells[lv].items())) for lv in e4.LEVELS}}
        for lv in e4.LEVELS:
            for column, value in cells[lv].items():
                totals[lv][column] += value
    cumulative_totals = cumulative({lv: totals[lv] for lv in e4.LEVELS})
    return {
        "cutoffMonth": cutoff,
        "byMonth": by_month,
        "provenanceByMonth": {m: by_month[m]["source"] for m in MONTHS},
        "levelTotalsCents": level_totals(cumulative_totals),
        "matrixCents": cumulative_totals,
    }


FORECAST = build_forecast(FORECAST_CUTOFF)


# ═══════════════════════════════════════════════════════════════════════════
# 7. KPI de rentabilidad con horas y absorcion
# ═══════════════════════════════════════════════════════════════════════════

YEAR_WINDOW = (FY_START, FY_END)
COST = cost_of_time(YEAR_WINDOW)
APPROVED_PRODUCTIVE = minutes_by_target(YEAR_WINDOW)
UNAPPROVED_ALL = minutes_by_target(YEAR_WINDOW, productive_only=False, approved_only=False)


def per_hour(amount: int, minutes: int) -> int | None:
    """`⌊importe × 60 / minutos⌋`. Sin minutos, **no evaluable**; nunca 0."""
    if minutes <= 0:
        return None
    sign = -1 if amount < 0 else 1
    return sign * (abs(amount) * 60 // minutes)


def build_kpis() -> dict[str, Any]:
    basis_in_play = sorted({r["basis"] for r in EMPLOYEE_RATES})
    out: dict[str, Any] = {"basis": basis_in_play[0] if len(basis_in_play) == 1 else None,
                           "basisConflict": len(basis_in_play) > 1, "byProject": {}}
    for project in PROJECTS:
        column = f"PROJ:{project}"
        minutes = APPROVED_PRODUCTIVE.get(project, 0)
        budget_minutes = sum(v for (m, p), v in BUDGET_HOURS.items() if p == project)
        valued = COST["byTarget"].get(project, 0)
        unpriced = project in COST["targetsWithUnpricedRows"]
        out["byProject"][project] = {
            "minutesReal": minutes,
            "minutesBudget": budget_minutes,
            "minutesVariance": minutes - budget_minutes,
            "personnelCostValuedCents": valued,
            # No evaluable con partes sin tarifa vigente: un margen por hora
            # calculado con partes sin tarifa NO es un margen (EV-17).
            "hourlyCostCents": None if unpriced else per_hour(valued, minutes),
            "marginPerHourMc2Cents": per_hour(REAL_MATRIX_SETTLED["MC2"][column], minutes),
            "marginPerHourMc3Cents": per_hour(REAL_MATRIX_SETTLED["MC3"][column], minutes),
            "averageBilledRateCents": per_hour(REAL_MATRIX_SETTLED["INGRESOS"][column], minutes),
            "notEvaluable": ["TARIFA_AUSENTE"] if unpriced else [],
        }
    return out


def build_absorption() -> dict[str, Any]:
    """O-E10-20. `absorcion = Σ (minutos × tarifa / 60) − Σ (−aporte) de 64x`."""
    payroll_total = sum(PAYROLL_BY_CECO.values())
    valued_total = sum(COST["byTarget"].values())
    by_ceco = []
    for ceco in sorted(set(list(PAYROLL_BY_CECO) + [k for k in COST["byTarget"] if k.startswith("CC-")])):
        valued = COST["byTarget"].get(ceco, 0)
        payroll = PAYROLL_BY_CECO.get(ceco, 0)
        by_ceco.append({"costCenterCode": ceco, "valuedCents": valued,
                        "payrollCents": payroll, "absorptionCents": valued - payroll})
    return {
        "valuedCents": valued_total,
        "payrollCents": payroll_total,
        "absorptionCents": valued_total - payroll_total,
        "absorptionBps": (None if payroll_total == 0
                          else _trunc_bps(valued_total - payroll_total, payroll_total)),
        "byCostCenter": by_ceco,
        "note": ("Informacion de gestion, NO un invariante: I-E10-12 solo garantiza que el "
                 "personal imputado no EXCEDA al contabilizado, asi que una infraabsorcion "
                 "pasaria en silencio si no se publicase aqui."),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 8. Umbrales EV-11…13 y EV-15…17
# ═══════════════════════════════════════════════════════════════════════════

REVIEW_THRESHOLDS = {
    "desviacionIngresos": {"pctBps": 1_000, "minAbsCents": 500_000},
    "desviacionEbitda": {"pctBps": 1_500, "minAbsCents": 300_000},
    "desviacionMc3": {"pctBps": 1_500, "minAbsCents": 300_000},
    "desviacionMaxDimension": {"pctBps": 2_000, "minAbsCents": 500_000},
}


def kpi_fires(name: str, actual: int, budget: int) -> dict[str, Any]:
    """Dispara solo si SUPERA LOS DOS (mismo contrato que los siete de ADR-0012)."""
    threshold = REVIEW_THRESHOLDS[name]
    bps = variance_bps(actual, budget)
    diff = actual - budget
    fires = bps is not None and abs(bps) >= threshold["pctBps"] and abs(diff) >= threshold["minAbsCents"]
    return {"kpi": name, "actualCents": actual, "budgetCents": budget, "varianceCents": diff,
            "varianceBps": bps, "pctBps": threshold["pctBps"],
            "minAbsCents": threshold["minAbsCents"], "fires": fires,
            "sealReason": "DESVIACION_PRESUPUESTO" if fires else None}


def build_thresholds() -> dict[str, Any]:
    real_totals = level_totals(REAL_MATRIX_SETTLED)
    budget_totals = level_totals(BUDGET_MATRIX_SETTLED)
    kpis = [
        kpi_fires("desviacionIngresos", real_totals["INGRESOS"], budget_totals["INGRESOS"]),
        kpi_fires("desviacionEbitda", real_totals["EBITDA"], budget_totals["EBITDA"]),
        kpi_fires("desviacionMc3", real_totals["MC3"], budget_totals["MC3"]),
    ]
    # O-E10-18: el cuarto KPI mira POR DIMENSION, porque dos desviaciones grandes
    # de signo contrario se anulan en el total y el informe se firmaria en verde.
    worst = None
    for level in ("INGRESOS", "MC2", "MC3"):
        for column in COLUMNS:
            if not column.startswith(("PROJ:", "BL:")):
                continue
            actual = REAL_MATRIX_SETTLED[level].get(column, 0)
            planned = BUDGET_MATRIX_SETTLED[level].get(column, 0)
            candidate = kpi_fires("desviacionMaxDimension", actual, planned)
            candidate = dict(candidate, level=level, column=column)
            if worst is None or abs(candidate["varianceCents"]) > abs(worst["varianceCents"]):
                worst = candidate
    kpis.append(worst)

    unapproved_total = sum(UNAPPROVED_MINUTES.values())
    approved_total = sum(REAL_MINUTES.values())
    rules_missing_headcount = sorted({w["rule"] for w in REAL_ENGINE.warnings
                                      if w["code"] == "W-E10-NO-HEADCOUNT"})
    return {
        "thresholds": REVIEW_THRESHOLDS,
        "kpis": kpis,
        "rules": [
            {"id": "EV-11", "fires": True, "sealReason": "DESVIACION_PRESUPUESTO",
             "case": ("el `budgetHash` del periodo cambia respecto del run anterior: cambiar de "
                      "version REDEFINE la medida, no es una variacion"),
             "budgetHashBase": BUDGETS[0]["budgetHash"], "budgetHashRev1": BUDGETS[1]["budgetHash"],
             "evidence": "2026-BASE y 2026-REV1 tienen hash distinto con las mismas dimensiones"},
            {"id": "EV-12", "fires": False, "movesSeal": True, "sealReason": "PRESUPUESTO_AUSENTE",
             "case": "columnas sin presupuesto: las tres derivadas salen vacias, nunca a cero",
             "columnsWithoutBudget": sorted(
                 {c["column"] for c in build_variance(REAL_MATRIX_NONE, BUDGET_MATRIX_NONE, "NONE", "NONE")
                  if c["budgetCents"] == 0 and c["actualCents"] != 0})},
            {"id": "EV-13", "fires": False, "movesSeal": True,
             "case": ("el periodo comparado contiene meses no cerrados: la desviacion es parcial "
                      "por construccion y lo que informa ahi es el forecast"),
             "openMonths": [m for m in MONTHS if m > FORECAST_CUTOFF]},
            {"id": "EV-15", "fires": unapproved_total > 0, "sealReason": "HORAS_SIN_APROBAR",
             "unapprovedMinutes": unapproved_total,
             "shareOfBaseBps": (unapproved_total * 10_000 // approved_total) if approved_total else None,
             "case": "minutos sin aprobar de receptores elegibles: el reparto va sobre base parcial",
             "warnings": [w for w in REAL_ENGINE.warnings if w["code"] == "W-E10-UNAPPROVED-HOURS"]},
            {"id": "EV-16", "fires": True, "sealReason": "PLANTILLA_AUSENTE",
             "rulesInMainRun": rules_missing_headcount,
             "firesInMainRun": bool(rules_missing_headcount),
             "scenario": "criterio-16-ter · run mensual de agosto con CC-MKT sin snapshot",
             "case": ("una regla HEADCOUNT reparte a un CECO sin snapshot en el periodo. Un "
                      "snapshot con fteMilli = 0 NO dispara: es un dato")},
            {"id": "EV-17", "fires": bool(COST["unpriced"]), "sealReason": "TARIFA_AUSENTE",
             "unpricedRows": len(COST["unpriced"]),
             "targets": COST["targetsWithUnpricedRows"],
             "case": ("partes sin tarifa vigente y el informe publica coste-hora o margen por "
                      "hora: I-E10-5 puede quedarse en INFO, pero el sello si se mueve")},
        ],
        "sealReasonsEmitted": sorted({r["sealReason"] for r in [
            {"sealReason": "DESVIACION_PRESUPUESTO"}, {"sealReason": "PRESUPUESTO_AUSENTE"},
            {"sealReason": "HORAS_SIN_APROBAR"}, {"sealReason": "PLANTILLA_AUSENTE"},
            {"sealReason": "TARIFA_AUSENTE"}]}),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 9. Casos del diseno, verificados aritmeticamente
# ═══════════════════════════════════════════════════════════════════════════

def design_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    # Criterio 11 · reparto HOURS de 900 000 c con base 19 200 / 10 800 / 6 000.
    weights = [("P-01", 19_200), ("P-02", 10_800), ("P-03", 6_000)]
    split = hamilton(900_000, weights)
    cases.append({"id": "criterio-11", "titulo": "driver HOURS, base 36 000 minutos",
                  "driverBaseTotal": 36_000,
                  "lines": [{"target": t, "amountCents": c, "driverShareBps": b} for t, c, b in split],
                  "expected": {"P-01": 480_000, "P-02": 270_000, "P-03": 150_000}})

    # Criterio 13 · con 12 000 minutos de P-03 SIN aprobar, el reparto no cambia
    # (solo se reparte lo aprobado) pero P-03 deja de absorber 187 500 c.
    full = hamilton(900_000, [("P-01", 19_200), ("P-02", 10_800), ("P-03", 18_000)])
    cases.append({"id": "criterio-13", "titulo": "base parcial: 12 000 minutos sin firmar en P-03",
                  "approvedSplit": {t: c for t, c, _ in split},
                  "splitIfApproved": {t: c for t, c, _ in full},
                  "differenceP03Cents": dict((t, c) for t, c, _ in full)["P-03"]
                  - dict((t, c) for t, c, _ in split)["P-03"],
                  "warning": "W-E10-UNAPPROVED-HOURS", "sealReason": "HORAS_SIN_APROBAR"})

    # Criterio 16 · HEADCOUNT mensual con 3 000 / 2 000 / 1 000 fteMilli.
    monthly = hamilton(600_000, [("CC-A", 3_000), ("CC-B", 2_000), ("CC-C", 1_000)])
    cases.append({"id": "criterio-16", "titulo": "HEADCOUNT mensual: un snapshot = stock",
                  "lines": [{"target": t, "amountCents": c, "driverShareBps": b} for t, c, b in monthly]})

    # Criterio 16-bis · FTE·mes de un CECO que vive de febrero a noviembre.
    fte_month = sum(3_000 for m in MONTHS if "2026-02" <= m <= "2026-11")
    cases.append({"id": "criterio-16-bis", "titulo": "FTE·mes frente a stock a 31-12",
                  "fteMonthCents": fte_month, "stockAt1231": 0,
                  "evidencia": "10 meses x 3 000 = 30 000; con el stock a 31-12 su peso seria 0"})
    assert fte_month == 30_000

    # Criterio 19 · coste-hora derivado (D3), con y sin Seguridad Social.
    con_ss = 5_276_000 * 60 // 90_000
    sin_ss = 4_000_000 * 60 // 90_000
    cases.append({"id": "criterio-19", "titulo": "coste-hora derivado de la nomina",
                  "COSTE_EMPRESA_CON_SS": {"payrollCents": 5_276_000, "productiveMinutes": 90_000,
                                           "hourlyCostCents": con_ss},
                  "BRUTO_SIN_SS": {"payrollCents": 4_000_000, "productiveMinutes": 90_000,
                                   "hourlyCostCents": sin_ss},
                  "differenceCents": con_ss - sin_ss,
                  "differenceBps": (con_ss - sin_ss) * 10_000 // sin_ss,
                  "accountPrefixes": list(PAYROLL_PREFIXES),
                  "excluded": ["641"]})
    assert (con_ss, sin_ss) == (3_517, 2_666), (con_ss, sin_ss)

    # 19-ter · cobertura de la derivacion por empleado.
    coverage_bps = 78_00
    cases.append({"id": "criterio-19-ter", "titulo": "derivacion con cobertura",
                  "scope": "EMPLOYEE", "linesMatched": 8, "linesTotal": 34,
                  "coverageBps": coverage_bps, "minCoverageBps": DERIVATION_MIN_COVERAGE_BPS,
                  "result": "aplicable" if coverage_bps >= DERIVATION_MIN_COVERAGE_BPS else "COVERAGE_TOO_LOW"})

    # 19-quinquies · absorcion de -500 c del diseno.
    cases.append({"id": "criterio-19-quinquies", "titulo": "infraabsorcion de 500 c",
                  "valuedCents": 5_275_500, "payrollCents": 5_276_000,
                  "absorptionCents": 5_275_500 - 5_276_000, "invariant": "I-E10-12 PASS (no se pasa)"})

    # 27 · comparabilidad: con CC-OPS presupuestado y ejecutado igual y las horas
    # exactamente previstas, la desviacion de MC3 de P-01 es CERO.
    same_minutes = {("2026-01", "P-01"): 19_200, ("2026-01", "P-02"): 10_800, ("2026-01", "P-03"): 6_000}
    real_split = hamilton(900_000, [(p, same_minutes[("2026-01", p)]) for p in PROJECTS])
    budget_split = hamilton(900_000, [(p, same_minutes[("2026-01", p)]) for p in PROJECTS])
    cases.append({"id": "criterio-27", "titulo": "presupuesto imputado con las mismas reglas",
                  "realP01Cents": dict((t, c) for t, c, _ in real_split)["P-01"],
                  "budgetP01Cents": dict((t, c) for t, c, _ in budget_split)["P-01"],
                  "varianceMc3P01Cents": 0,
                  "rondaCero": -400_000,
                  "evidencia": "sin liquidar el presupuesto, P-01 recibia 400 000 c en el real y 0 en el plan"})

    # 18 · el umbral dispara solo si SUPERA LOS DOS (porcentaje y absoluto).
    cases.append({"id": "criterio-18", "titulo": "umbral: 1 800 bps con 250 000 c no dispara",
                  "noDispara": kpi_fires("desviacionEbitda", 1_638_889, 1_388_889),
                  "dispara": kpi_fires("desviacionEbitda", 2_622_222, 2_222_222)})

    # 18-bis · compensacion entre dimensiones (O-E10-18): el total da 0 y no
    # dispara; el cuarto KPI, por dimension, si.
    total_kpi = kpi_fires("desviacionMc3", 1_000_000, 1_000_000)
    p01 = dict(kpi_fires("desviacionMaxDimension", -1_000_000, 500_000), level="MC3", column="PROJ:P-01")
    p02 = dict(kpi_fires("desviacionMaxDimension", 2_000_000, 500_000), level="MC3", column="PROJ:P-02")
    cases.append({"id": "criterio-18-bis", "titulo": "dos desviaciones que se anulan en el total",
                  "totalCompania": total_kpi,
                  "porDimension": [p01, p02],
                  "evidencia": ("el total compania da 0 c y 0 bps y no dispara ninguno de los tres "
                                "umbrales; `desviacionMaxDimension` si, y el informe pasa a "
                                "REQUIERE REVISION nombrando las dos dimensiones")})
    assert total_kpi["fires"] is False and p01["fires"] and p02["fires"]

    # 29 · minutos, no centesimas.
    cases.append({"id": "criterio-29", "titulo": "7 h 20 min son 440 minutos",
                  "minutes": 440, "display": "7:20",
                  "costAtRate3200Cents": 440 * 3_200 // 60,
                  "dailyCapMinutes": 1_440,
                  "referenceProductiveMinutesPerYear": REFERENCE_PRODUCTIVE_MINUTES_YEAR})
    return cases


def adversarial_scenarios() -> list[dict[str, Any]]:
    """Los caminos que el run principal NO recorre, calculados en aislamiento.

    Un fixture que solo recorre el camino feliz no prueba nada (§6 de la
    validacion): aqui quedan los tres avisos de actividad con su cifra.
    """
    out: list[dict[str, Any]] = []

    # 16-ter · receptor SIN snapshot en el periodo: peso 0 y PLANTILLA_AUSENTE.
    # `CC-MKT` no tiene plantilla en agosto; un run mensual de agosto que le
    # reparta lo deja a 0 y mueve el sello. Un `fteMilli = 0` DECLARADO (enero)
    # no dispara nada: es un dato.
    august = [(cc, sum(r["fteMilli"] for r in HEADCOUNT
                       if r["costCenterCode"] == cc and r["month"][:7] == "2026-08"))
              for cc in ("CC-MKT", "CC-OPS")]
    january = [(cc, sum(r["fteMilli"] for r in HEADCOUNT
                        if r["costCenterCode"] == cc and r["month"][:7] == "2026-01"))
               for cc in ("CC-MKT", "CC-OPS")]
    out.append({
        "id": "criterio-16-ter", "titulo": "plantilla ausente frente a cero declarado",
        "runAgosto": {"weights": dict(august),
                      "split": [{"target": t, "amountCents": c, "driverShareBps": b}
                                for t, c, b in hamilton(300_000, august)],
                      "warning": "W-E10-NO-HEADCOUNT", "sealReason": "PLANTILLA_AUSENTE",
                      "evidencia": "CC-MKT no tiene snapshot en agosto: peso 0 y motivo de sello"},
        "runEnero": {"weights": dict(january),
                     "split": [{"target": t, "amountCents": c, "driverShareBps": b}
                               for t, c, b in hamilton(300_000, january)],
                     "warning": None, "sealReason": None,
                     "evidencia": "CC-MKT declara fteMilli = 0 en enero: peso 0 y NINGUN motivo"},
    })

    # 16-quater · saldo atrapado: una regla HEADCOUNT que reparte a un CECO sin
    # regla vigente propia hacia proyectos.
    trapped_engine = ActivityEngine(REAL, REAL_MINUTES, UNAPPROVED_MINUTES, HEADCOUNT, "atrapado")
    trapped_rule = {"code": "AL-GA-MKT-Y", "sourceCostCenterCode": "CC-GA", "period": "YEAR",
                    "priority": 10, "sourceShareBps": 10_000, "targetKind": "COST_CENTERS",
                    "driver": "HEADCOUNT", "targetFilter": None, "zeroBaseFallback": "SKIP_WARN",
                    "targets": [{"costCenterCode": "CC-MKT"}]}
    trapped_engine.headcount_weights(trapped_rule, YEAR)
    out.append({
        "id": "criterio-16-quater", "titulo": "saldo atrapado un nivel mas abajo",
        "rule": trapped_rule["code"],
        "warnings": trapped_engine.warnings,
        "evidencia": ("CC-MKT solo reparte con una regla TRIMESTRAL de prioridad anterior: lo que "
                      "reciba en el run anual se queda ahi. I5.b lo denunciaria despues y sin decir "
                      "por que; el aviso lo dice al simular")})

    # 13-bis · sin NINGUNA hora aprobada, la regla cae en su `zeroBaseFallback` y
    # con SKIP_WARN el saldo del CECO queda visible en «pendiente de liquidar».
    empty_engine = ActivityEngine(REAL, {}, UNAPPROVED_MINUTES, HEADCOUNT, "sin-horas")
    skip_rule = dict(RULES_E10[6])       # AL-OPS-Y, SKIP_WARN
    weights_skip = empty_engine.driver_weights(skip_rule, YEAR, [])
    fallback_used: list[str] = []
    ytd_rule = dict(RULES_E10[0])        # AL-OPS-M, YTD
    weights_ytd = empty_engine.driver_weights(ytd_rule, "2026-03", fallback_used)
    out.append({
        "id": "criterio-13-bis", "titulo": "ninguna hora aprobada: la regla nunca queda muda",
        "skipWarn": {"rule": skip_rule["code"], "weights": weights_skip,
                     "pendienteDeLiquidar": True},
        "ytd": {"rule": ytd_rule["code"], "period": "2026-03",
                "fallbackApplied": fallback_used[0] if fallback_used else None,
                "weights": [list(w) for w in weights_ytd]},
        "warnings": empty_engine.warnings,
    })

    # 12-bis · la ventana del `timeHash`. Un run de marzo con fallback YTD sella
    # `[01-01, 31-03]`: aprobar en mayo un parte de ENERO lo pone STALE.
    window = time_window_of([r for r in RULES_E10 if r["period"] == "MONTH"], "2026-03")
    out.append({
        "id": "criterio-12-bis", "titulo": "la ventana del timeHash",
        "windowMarch": list(window) if window else None,
        "timeHashMarchWindow": sha256(canonical_time_form(window)) if window else NULL,
        "timeHashMarchPeriodOnly": sha256(canonical_time_form(("2026-03-01", "2026-03-31"))),
        "evidencia": ("los dos hashes son distintos: sellando solo el periodo, un parte de enero "
                      "aprobado en mayo no caducaria el run de marzo, que SI lo consume por YTD"),
        "sinReglasDeActividad": {"window": None, "timeHash": NULL},
    })
    return out


# ═══════════════════════════════════════════════════════════════════════════
# 10. Invariantes I-E10-*
# ═══════════════════════════════════════════════════════════════════════════

def build_checks(variance_settled: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def add(id_: str, ok: bool, evidencia: str, **extra: Any) -> None:
        checks.append({"id": id_, "status": "PASS" if ok else "FAIL",
                       "evidencia": evidencia, **extra})

    # I-E10-1 · Σ lineas = totales por nivel, y Σ de los doce meses = el anual.
    by_level: dict[str, int] = defaultdict(int)
    for line in EFFECTIVE_LINES:
        by_level[line["marginLevel"]] += line["amountCents"]
    contrib_totals = {lv: sum(BUDGET_CONTRIB[lv].values()) for lv in e4.LEVELS}
    months_sum = {lv: sum(sum(BUDGET_CONTRIB_MONTH[m][lv].values()) for m in MONTHS) for lv in e4.LEVELS}
    add("I-E10-1", all(contrib_totals[lv] == by_level.get(lv, 0) == months_sum[lv] for lv in e4.LEVELS),
        "Σ celdas por nivel = contribucion de la matriz = Σ de los doce meses; `unresolved` vacio",
        levelSums={lv: by_level.get(lv, 0) for lv in e4.LEVELS}, unresolved=0)

    # I-E10-2 · desviacion exacta, celda a celda.
    bad = [c for c in variance_settled
           if not c["notComparable"] and c["varianceCents"] != c["actualCents"] - (c["budgetCents"] or 0)]
    add("I-E10-2", not bad, "desviacion = real - presupuesto al centimo en todas las celdas",
        cells=len(variance_settled), offenders=len(bad))

    # I-E10-3 · Σ driverBase de las lineas HOURS = base de la ventana del run.
    offenders = []
    for line in REAL_ENGINE.lines:
        rule = next(r for r in RULES_E10 if r["code"] == line["ruleCode"])
        if rule["driver"] != "HOURS":
            continue
        period = line["runId"].removeprefix("RUN-")
        expected = max(0, sum(REAL_MINUTES.get((m, line["target"]), 0) for m in months_of(period)))
        if line["driverBase"] != expected and line["fallback"] is None:
            offenders.append({"runId": line["runId"], "target": line["target"],
                              "driverBase": line["driverBase"], "expected": expected})
    add("I-E10-3", not offenders,
        "Σ driverBase de toda linea HOURS = minutos aprobados y productivos de la ventana del run",
        offenders=offenders)

    # I-E10-4 · contra-apuntes: cuadran con su original en empleado, fecha y signo.
    by_id = {r["id"]: r for r in TIME_ENTRIES}
    bad_counter = []
    for row in TIME_ENTRIES:
        if row["reversesId"] is None:
            continue
        original = by_id.get(row["reversesId"])
        if (original is None or original["employeeCode"] != row["employeeCode"]
                or original["targetCode"] != row["targetCode"]
                or row["minutes"] >= 0 or abs(row["minutes"]) > original["minutes"]
                or not row["reason"] or len(row["reason"]) < 10):
            bad_counter.append(row["id"])
    add("I-E10-4", not bad_counter,
        "todo contra-apunte es negativo, no excede a su original y lleva motivo de 10 caracteres o mas",
        counterEntries=sum(1 for r in TIME_ENTRIES if r["reversesId"]), offenders=bad_counter)

    # I-E10-5 · a lo sumo una tarifa vigente por empleado y fecha.
    overlaps = []
    for employee in {r["employeeCode"] for r in EMPLOYEE_RATES}:
        rates = sorted((r for r in EMPLOYEE_RATES if r["employeeCode"] == employee),
                       key=lambda r: r["validFrom"])
        for previous, nxt in zip(rates, rates[1:]):
            if previous["validTo"] is None or previous["validTo"] >= nxt["validFrom"]:
                overlaps.append(f"{employee}:{previous['validFrom']}")
    add("I-E10-5", not overlaps,
        "0 o 1 tarifa vigente por empleado y fecha; los partes sin tarifa salen NO EVALUABLES",
        overlaps=overlaps, unpricedRows=len(COST["unpriced"]),
        sealReason="TARIFA_AUSENTE" if COST["unpriced"] else None)

    # I-E10-6 · el hash sellado se recomputa sobre lo que la version tiene hoy.
    add("I-E10-6", all(b["budgetHash"] == sha256(canonical_budget_form(b, MARGIN_CONFIG_HASH))
                       for b in BUDGETS),
        "budgetHash recomputado = el sellado, para las dos versiones",
        hashes={b["code"]: b["budgetHash"] for b in BUDGETS})

    # I-E10-7 · forecast sin solape ni hueco.
    sources = FORECAST["provenanceByMonth"]
    real_part = {lv: sum(sum(REAL_CONTRIB_MONTH[m][lv].values())
                         for m in MONTHS if sources[m] == "REAL_CERRADO") for lv in e4.LEVELS}
    budget_part = {lv: sum(sum(BUDGET_CONTRIB_MONTH[m][lv].values())
                           for m in MONTHS if sources[m] == "PRESUPUESTO_ABIERTO") for lv in e4.LEVELS}
    forecast_levels = {lv: sum(FORECAST["byMonth"][m]["cells"][lv].get(c, 0)
                               for m in MONTHS for c in COLUMNS) for lv in e4.LEVELS}
    add("I-E10-7", (len(sources) == 12
                    and all(forecast_levels[lv] == real_part[lv] + budget_part[lv] for lv in e4.LEVELS)),
        "cada mes aparece una sola vez y con una sola procedencia; Σ real(ene-jun) + Σ ppto(jul-dic)",
        cutoff=FORECAST_CUTOFF, realMonths=sum(1 for v in sources.values() if v == "REAL_CERRADO"),
        budgetMonths=sum(1 for v in sources.values() if v == "PRESUPUESTO_ABIERTO"))

    # I-E10-8 · unicidad y exclusividad de celda (O-A6).
    duplicates = []
    for version in BUDGETS:
        seen: set = set()
        for line in version["lines"]:
            key = (line["month"], line["dimensionKind"], line["dimensionCode"], line["accountCode"])
            if key in seen:
                duplicates.append(f"{version['code']}:{key}")
            seen.add(key)
    add("I-E10-8", not duplicates,
        "ninguna version tiene dos lineas para la misma (mes, dimension, cuenta); una sola dimension por linea",
        duplicates=duplicates)

    # I-E10-9 / I-E10-15 · vigencias sin solape y sin hueco, y revision correlativa.
    spans = sorted((b["validFrom"], b["validTo"] or FY_END, b["code"]) for b in BUDGETS)
    gapless = spans[0][0] == FY_START and spans[-1][1] == FY_END
    for (_, end, _), (start, _, _) in zip(spans, spans[1:]):
        # Sin hueco ni solape: la siguiente vigencia arranca el DIA SIGUIENTE al
        # cierre de la anterior (O-E10-8: `sealBudget` cierra con validFrom - 1).
        gapless = gapless and start == (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    add("I-E10-9", [b["revision"] for b in BUDGETS] == list(range(len(BUDGETS))),
        "revision correlativa sin huecos y toda REVISADO tiene una BASE anterior")
    add("I-E10-15", gapless,
        "la union de las vigencias cubre el ejercicio entero sin hueco", spans=[list(s) for s in spans])

    # I-E10-10 · partes bien formados y techo diario AGREGADO.
    per_day: dict[tuple[str, str], int] = defaultdict(int)
    malformed = []
    for row in TIME_ENTRIES:
        per_day[(row["employeeCode"], row["date"])] += row["minutes"]
        if row["minutes"] == 0 or abs(row["minutes"]) > 1_440:
            malformed.append(row["id"])
        if not (FY_START <= row["date"] <= FY_END):
            malformed.append(row["id"])
        if row["minutes"] < 0 and row["reversesId"] is None:
            malformed.append(row["id"])
    over = [f"{e}/{d}={v}" for (e, d), v in sorted(per_day.items()) if v > 1_440]
    add("I-E10-10", not malformed and not over,
        "minutes != 0, |minutes| <= 1 440, fecha dentro del ejercicio, negativos solo en "
        "contra-apuntes y Σ por (empleado, fecha) <= 1 440",
        rows=len(TIME_ENTRIES), malformed=malformed, overDailyCap=over)

    # I-E10-11 · base de HEADCOUNT en FTE·mes.
    offenders_hc = []
    for line in REAL_ENGINE.lines:
        rule = next(r for r in RULES_E10 if r["code"] == line["ruleCode"])
        if rule["driver"] != "HEADCOUNT":
            continue
        period = line["runId"].removeprefix("RUN-")
        expected = sum(row["fteMilli"] for row in HEADCOUNT
                       if row["costCenterCode"] == line["target"] and row["month"][:7] in months_of(period))
        if line["driverBase"] != expected:
            offenders_hc.append({"target": line["target"], "driverBase": line["driverBase"],
                                 "expected": expected})
    add("I-E10-11", not offenders_hc,
        "Σ driverBase = Σ fteMilli de los snapshots del periodo (FTE·mes); un snapshot a 0 es un dato",
        offenders=offenders_hc,
        fteMonthByCostCenter={cc: sum(r["fteMilli"] for r in HEADCOUNT if r["costCenterCode"] == cc)
                              for cc in sorted({r["costCenterCode"] for r in HEADCOUNT})})

    # I-E10-12 · el personal imputado no excede al contabilizado.
    valued = sum(COST["byTarget"].values())
    payroll = sum(PAYROLL_BY_CECO.values())
    add("I-E10-12", valued <= payroll,
        "Σ coste de personal valorado por horas <= Σ -aporte de las 64x del periodo (guarda, no medida)",
        valuedCents=valued, payrollCents=payroll, slackCents=payroll - valued)

    # I-E10-13 · reproducibilidad: dos construcciones dan el mismo hash de salida.
    add("I-E10-13", True,
        "la salida es funcion pura de las entradas: `--check` compara byte a byte en CI")

    # I-E10-14 · tipo declarado y coherencia de signo.
    untyped = [l for l in EFFECTIVE_LINES if not l["analyticType"]]
    wrong_sign = [l for l in EFFECTIVE_LINES
                  if not l["signException"]
                  and ((l["analyticType"] in POSITIVE_TYPES and l["amountCents"] < 0)
                       or (l["analyticType"] in NEGATIVE_TYPES and l["amountCents"] > 0))]
    add("I-E10-14", not untyped and not wrong_sign,
        "toda linea tiene analyticType y el signo que le corresponde; las excepciones salen LISTADAS",
        untyped=len(untyped), wrongSign=len(wrong_sign),
        exceptions=sorted({(l["accountCode"]) for l in EFFECTIVE_LINES if l["signException"]}))

    # I-E10-16 · completitud de la version.
    incomplete = []
    for version in BUDGETS:
        covered = {l["month"][:7] for l in version["lines"]}
        if len(covered) != 12 and version["partialFrom"] is None:
            incomplete.append(version["code"])
    add("I-E10-16", not incomplete,
        "toda version cubre los doce meses o declara partialFrom, y el informe compone la procedencia",
        provenanceByMonth=PROVENANCE, incomplete=incomplete)

    # I-E10-17 · el timeHash cubre la ventana consumida.
    window_march = time_window_of([r for r in RULES_E10 if r["period"] == "MONTH"], "2026-03")
    add("I-E10-17", window_march == (FY_START, "2026-03-31"),
        "con una regla de fallback YTD, la ventana sellada del run de marzo arranca el 1 de enero",
        windowMarch=list(window_march) if window_march else None)

    # I-E10-18 · comparabilidad.
    not_published = [c for c in variance_settled if c["notComparable"]]
    add("I-E10-18", not not_published,
        "presupuesto y real estan imputados con las MISMAS reglas: ninguna celda queda sin publicar",
        rulesHash=RULES_HASH, notComparableCells=len(not_published))

    # Contra los DOS fixtures sellados: el real de aqui es el de E4, y el de E5
    # no se mueve un centimo por encender drivers de actividad (criterio 1).
    e4exp = json.loads((HERE / "pyg-analitica-esperada.json").read_text(encoding="utf-8"))
    e5exp = json.loads((HERE / "liquidacion-esperada.json").read_text(encoding="utf-8"))
    add("E4.levelTotals",
        level_totals(REAL_MATRIX_NONE) == e4exp["levelTotalsCents"]
        == level_totals(REAL_MATRIX_SETTLED),
        "los totales por nivel del real, antes y despues de imputar, son los de pyg-analitica-esperada.json",
        expected=e4exp["levelTotalsCents"], actual=level_totals(REAL_MATRIX_SETTLED))
    e5_drivers = {r["code"]: r["driver"] for r in e5exp["rules"]}
    changed = {code: (e5_drivers.get(code), rule["driver"]) for code, rule in
               ((r["code"], r) for r in RULES_E10) if e5_drivers.get(code) not in (None, rule["driver"])}
    add("E5.fixtureIntacto", set(e5_drivers.values()).isdisjoint({"HOURS", "HEADCOUNT"}),
        "ninguna regla del fixture sellado de E5 usa un driver de actividad: su test byte a byte "
        "sigue en verde sin tocarlo",
        rulesChangedInE10={k: list(v) for k, v in sorted(changed.items())})

    # I4 / I5, heredados: la imputacion es un traspaso de suma cero por nivel y
    # todo CECO imputable queda a cero.
    for label, engine, matrix, contrib in (("real", REAL_ENGINE, REAL_MATRIX_SETTLED, REAL_CONTRIB),
                                           ("presupuesto", BUDGET_ENGINE, BUDGET_MATRIX_SETTLED, BUDGET_CONTRIB)):
        delta = allocation_delta(engine)
        add(f"I-E5-6.{label}", all(sum(delta[lv].values()) == 0 for lv in e4.LEVELS),
            f"la liquidacion {label} es un traspaso interno de suma cero en cada nivel")
        residual = {cc: {lv: matrix[lv][e4.col_ceco(CECO_KIND[cc])] for lv in ("MC3", "EBITDA")}
                    for cc, kind in CECO_KIND.items() if kind not in e5.NON_ALLOCATABLE_KINDS}
        add(f"I5.b.{label}", all(v == 0 for r in residual.values() for v in r.values()),
            f"cierre anual {label}: todo CECO imputable queda a 0 en su columna", residual=residual)
        add(f"I4.{label}", all(sum(matrix[lv].values()) == sum(
            sum(contrib[l2].get(c, 0) for c in COLUMNS) for l2 in e4.LEVELS[:e4.LEVELS.index(lv) + 1])
            for lv in e4.LEVELS),
            f"Σ columnas tras imputar = Σ contribucion acumulada ({label})")
    return checks


# ═══════════════════════════════════════════════════════════════════════════
# 11. Ensamblado
# ═══════════════════════════════════════════════════════════════════════════

def build() -> dict[str, Any]:
    variance_none = build_variance(REAL_MATRIX_NONE, BUDGET_MATRIX_NONE, "NONE", "NONE")
    variance_settled = build_variance(REAL_MATRIX_SETTLED, BUDGET_MATRIX_SETTLED, "SETTLED", "SETTLED")
    # 27-bis · cuando el presupuesto NO puede seguir al real: las celdas por
    # dimension de nivel >= MC3 no se publican; INGRESOS, MC1 y MC2 si.
    variance_not_settleable = build_variance(REAL_MATRIX_SETTLED, BUDGET_MATRIX_NONE, "SETTLED", "NONE")

    window_year = YEAR_WINDOW
    checks = build_checks(variance_settled)

    return {
        "schemaVersion": "1.1",
        "generatedBy": "docs/design/fixtures/build_presupuesto_horas_esperado.py",
        "note": (
            "Presupuesto, horas, liquidacion presupuestaria, desviacion, forecast y KPI esperados "
            "(E10 · T10) sobre el ejercicio 2026 del fixture tests/fixtures/ejercicio-completo.json. "
            "Centimos y minutos ENTEROS. Signo de APORTE (haber - debe): positivo suma al margen. "
            "El presupuesto se deriva del real con factores en puntos basicos declarados, de modo "
            "que cada celda de desviacion es reproducible a mano. El real y la liquidacion real "
            "salen de pyg-analitica-esperada.json y de la maquinaria de build_liquidacion_esperada.py, "
            "sin reimplementar ni el Hamilton ni la cascada."
        ),
        "source": {
            "fixture": "tests/fixtures/ejercicio-completo.json",
            "e4Expected": "docs/design/fixtures/pyg-analitica-esperada.json",
            "e5Expected": "docs/design/fixtures/liquidacion-esperada.json",
            "fiscalYear": FISCAL_YEAR,
            "excludedKinds": sorted(e4.EXCLUDED_KINDS),
            "contratoDeCifras": {
                "unidadDeHoras": "minutos enteros",
                "techoDiario": 1_440,
                "costeDeUnParte": "Hamilton sobre T = floor(sum(m*r)/60), desempate (fecha, empleado, id)",
                "baseHours": "aprobados y productivos, contra-apuntes con su signo, max(0, ·)",
                "baseHeadcount": "suma de fteMilli de los snapshots del periodo (FTE·mes)",
                "formaCanonicaTimeHash": "fecha|empleado|receptor|minutos|productiva (sin id)",
                "basisPorDefecto": BASIS,
                "payrollAccountPrefixes": list(PAYROLL_PREFIXES),
                "signoDelPresupuesto": "aporte (haber - debe)",
            },
        },
        "marginConfig": MARGIN_CONFIG,
        "marginConfigHash": MARGIN_CONFIG_HASH,

        "employees": EMPLOYEES,
        "employeeRates": EMPLOYEE_RATES,
        "timeEntries": TIME_ENTRIES,
        "headcountSnapshots": HEADCOUNT,

        "timeAggregates": {
            "window": list(window_year),
            "approvedProductiveMinutesByTarget": APPROVED_PRODUCTIVE,
            "unapprovedMinutesByTarget": UNAPPROVED_ALL,
            "approvedProductiveMinutesByMonthAndProject": {
                m: {p: REAL_MINUTES.get((m, p), 0) for p in PROJECTS} for m in MONTHS},
            "budgetedMinutesByMonthAndProject": {
                m: {p: BUDGET_HOURS.get((m, p), 0) for p in PROJECTS} for m in MONTHS},
            "canonicalTimeFormSha256": sha256(canonical_time_form(window_year)),
            "timeHashByWindow": {
                "2026-01-01..2026-12-31": sha256(canonical_time_form(window_year)),
                "2026-03-01..2026-03-31": sha256(canonical_time_form(("2026-03-01", "2026-03-31"))),
                "2026-01-01..2026-03-31": sha256(canonical_time_form((FY_START, "2026-03-31"))),
            },
            "timeWindowOf": {
                "2026-03 con regla YTD": list(time_window_of(
                    [r for r in RULES_E10 if r["period"] == "MONTH"], "2026-03") or []),
                "2026-03 sin reglas de actividad": time_window_of(
                    [r for r in RULES_E10 if r["driver"] == "FIXED_PERCENT"], "2026-03"),
                "timeHashSinReglasDeActividad": NULL,
            },
            "costOfTime": {
                "byTargetCents": COST["byTarget"],
                "unpricedRows": COST["unpriced"],
                "targetsWithUnpricedRows": COST["targetsWithUnpricedRows"],
                "perRowCentsSample": dict(sorted(COST["perRow"].items())[:12]),
            },
        },

        "budgets": [{k: v for k, v in b.items() if k not in ("lines", "hoursLines")}
                    | {"lineCount": len(b["lines"]), "hoursLineCount": len(b["hoursLines"])}
                    for b in BUDGETS],
        "budgetLines": {b["code"]: b["lines"] for b in BUDGETS},
        "budgetHoursLinesByVersion": {b["code"]: b["hoursLines"] for b in BUDGETS},
        "budgetComposition": {"provenanceByMonth": PROVENANCE, "effectiveLineCount": len(EFFECTIVE_LINES)},
        "budgetHoursLines": BUDGET_HOURS_LINES,
        "budgetDerivation": {"baseDeltaBps": BASE_DELTA_BPS, "rev1DeltaBps": REV1_DELTA_BPS,
                             "note": "importe = signo(tipo) x floor(|real| x (10000 + bps) / 10000)"},

        "levels": e4.LEVELS,
        "columns": COLUMNS,
        "budgetMatrixCents": BUDGET_MATRIX_NONE,
        "budgetMatrixByMonthCents": BUDGET_MONTHLY,
        "budgetLevelTotalsCents": level_totals(BUDGET_MATRIX_NONE),
        "budgetBusinessLineMatrixCents": {
            lv: {b: sum(BUDGET_MATRIX_NONE[lv][f"PROJ:{p}"] for p in PROJECTS if REAL["proj_bl"][p] == b)
                 + BUDGET_MATRIX_NONE[lv][f"BL:{b}"] for b in BUSINESS_LINES} for lv in e4.LEVELS},
        "realMatrixCents": REAL_MATRIX_NONE,
        "realMatrixByMonthCents": REAL_MONTHLY,

        "allocation": {
            "rules": RULES_E10,
            "rulesHash": RULES_HASH,
            "real": {
                "allocationState": "SETTLED",
                "runs": REAL_ENGINE.runs,
                "lines": REAL_ENGINE.lines,
                "warnings": REAL_ENGINE.warnings,
                "matrixCents": REAL_MATRIX_SETTLED,
                "levelTotalsCents": level_totals(REAL_MATRIX_SETTLED),
            },
            "budgetDryRun": {
                "allocationState": "SETTLED",
                "note": ("Liquidacion PRESUPUESTARIA en dry-run puro (O-E10-4): no es un "
                         "AllocationRun, no ocupa el indice unico de periodo y no caduca "
                         "informes; el rulesHash viaja en `params` del ReportRun."),
                "budgetRulesHash": RULES_HASH,
                "runs": BUDGET_ENGINE.runs,
                "lines": BUDGET_ENGINE.lines,
                "warnings": BUDGET_ENGINE.warnings,
                "matrixCents": BUDGET_MATRIX_SETTLED,
                "levelTotalsCents": level_totals(BUDGET_MATRIX_SETTLED),
            },
        },

        "variance": {
            "withAllocationsFalse": {
                "allocationStateReal": "NONE", "allocationStateBudget": "NONE",
                "cells": variance_none,
                "levelTotalsCents": {lv: level_totals(REAL_MATRIX_NONE)[lv]
                                     - level_totals(BUDGET_MATRIX_NONE)[lv] for lv in e4.LEVELS},
            },
            "withAllocationsTrue": {
                "allocationStateReal": "SETTLED", "allocationStateBudget": "SETTLED",
                "budgetRulesHash": RULES_HASH,
                "cells": variance_settled,
                "levelTotalsCents": {lv: level_totals(REAL_MATRIX_SETTLED)[lv]
                                     - level_totals(BUDGET_MATRIX_SETTLED)[lv] for lv in e4.LEVELS},
            },
            "budgetNotSettleable": {
                "code": "BUDGET_NOT_SETTLEABLE",
                "reason": ("una regla HOURS sin horas presupuestadas: el presupuesto no puede "
                           "seguir al real y las celdas por dimension de nivel >= MC3 NO se publican"),
                "allocationStateReal": "SETTLED", "allocationStateBudget": "NONE",
                "notComparableCells": sum(1 for c in variance_not_settleable if c["notComparable"]),
                "publishedCells": sum(1 for c in variance_not_settleable if not c["notComparable"]),
                "cells": variance_not_settleable,
            },
        },

        "forecast": FORECAST,
        "kpis": build_kpis(),
        "absorption": build_absorption(),
        "thresholds": build_thresholds(),
        "designCases": design_cases(),
        "adversarialScenarios": adversarial_scenarios(),
        "checks": checks,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    data = build()
    failed = [c for c in data["checks"] if c["status"] != "PASS"]
    for c in failed:
        print(f"FAIL {c['id']}: {c['evidencia']}", file=sys.stderr)
    if failed:
        return 2

    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUT.exists():
            print(f"falta {OUT}", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print(f"{OUT} difiere de la reconstruccion", file=sys.stderr)
            return 1
        print("OK: presupuesto-horas-esperado.v1.1.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT.relative_to(ROOT)}")
    print(f"  presupuesto: {len(EFFECTIVE_LINES)} celdas efectivas · "
          f"BASE {BUDGETS[0]['budgetHash'][:12]} · REV1 {BUDGETS[1]['budgetHash'][:12]}")
    for lv in e4.LEVELS:
        print(f"  {lv:10} real {level_totals(REAL_MATRIX_SETTLED)[lv]:>12,} · "
              f"ppto {level_totals(BUDGET_MATRIX_SETTLED)[lv]:>12,} · "
              f"desv {level_totals(REAL_MATRIX_SETTLED)[lv] - level_totals(BUDGET_MATRIX_SETTLED)[lv]:>12,}")
    print(f"  horas: {sum(APPROVED_PRODUCTIVE.values())} minutos aprobados y productivos · "
          f"{len(TIME_ENTRIES)} partes · {len(COST['unpriced'])} sin tarifa")
    print(f"  checks: {len(data['checks'])} en PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
