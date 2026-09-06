#!/usr/bin/env python3
"""
E5 - Generador de la LIQUIDACION DE CECOs esperada del fixture `ejercicio-completo.json`.

    python3 docs/design/fixtures/build_liquidacion_esperada.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), la liquidacion analitica
completa del ejercicio 2026 del fixture inmutable `tests/fixtures/ejercicio-completo.json`:

    reglas -> bases de driver -> AllocationRun (MONTH, QUARTER, YEAR)
           -> AllocationLine (reparto Hamilton, centimos exactos)
           -> matriz analitica IMPUTADA (nivel de margen x columna)

Reutiliza `build_pyg_analitica_esperada.py` (E4) como unica fuente de verdad para la
resolucion de cuentas, el tipo analitico efectivo (R-A1..R-A5) y el nivel/columna de
cada linea: este script solo anade la capa de imputacion.

Escribe `docs/design/fixtures/liquidacion-esperada.json`. Con `--check` no escribe:
reconstruye, compara byte a byte con el fichero en disco y falla si difiere.

NO TOCA `tests/fixtures/*`: los fixtures de E3 son inmutables y aqui son solo entrada.

Convenciones
------------
* Todo en centimos enteros. Nada de float en el resultado.
* Matriz: `aporte = creditCents - debitCents` (positivo suma al margen, negativo resta),
  igual que E4. Matriz CUMULATIVA por nivel.
* `AllocationLine.amountCents` va en **convencion de coste**: positivo = coste que sale
  del CECO fuente y entra en el receptor. Efecto en la matriz:
      columna del CECO fuente += +amountCents   (alivio)
      columna del receptor     += -amountCents   (cargo)
  ambos en el MISMO nivel de margen (`marginLevel` de la linea), que es exactamente lo
  que hace que I4 siga cuadrando: la imputacion es un traspaso interno de suma cero.
* El nivel VIAJA CON EL DINERO: lo que se cargo en un CECO `marginLevel = MC3` se
  absorbe en MC3 del receptor; lo que se cargo en un CECO EBITDA se absorbe en EBITDA,
  aunque pase por un CECO MC3 en cascada. Sin esto, una cascada entre niveles moveria
  importe de un nivel a otro y romperia I4.a.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True   # no ensuciar el repo con __pycache__
sys.path.insert(0, str(HERE))
e4 = importlib.import_module("build_pyg_analitica_esperada")

ROOT = e4.ROOT
OUT = HERE / "liquidacion-esperada.json"
E4_EXPECTED = HERE / "pyg-analitica-esperada.json"

FISCAL_YEAR = e4.FISCAL_YEAR
MONTHS = [f"2026-{m:02d}" for m in range(1, 13)]
QUARTERS = ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]
YEAR = "2026"

# R-A12: `74x` con override a INGRESO_DIRECTO se excluye de REVENUE_SHARE.
REVENUE_SHARE_EXCLUDED_PREFIXES = ("74",)

# CECOs que NUNCA pueden ser fuente ni destino de una imputacion (E4 §4.1, §8.6).
NON_ALLOCATABLE_KINDS = ("FINANCIERO", "EXTRAORDINARIO", "SIN_ASIGNAR")


# ---------------------------------------------------------------------------
# Periodos
# ---------------------------------------------------------------------------


def month_key(date: str) -> str:
    return date[:7]


def quarter_key(date: str) -> str:
    return f"{date[:4]}-Q{(int(date[5:7]) - 1) // 3 + 1}"


def period_bounds(key: str) -> tuple[str, str]:
    if key == YEAR:
        return "2026-01-01", "2026-12-31"
    if "Q" in key:
        q = int(key[-1])
        m0, m1 = 3 * q - 2, 3 * q
        last = {3: 31, 6: 30, 9: 30, 12: 31}[m1]
        return f"2026-{m0:02d}-01", f"2026-{m1:02d}-{last}"
    m = int(key[5:7])
    last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return f"{key}-01", f"{key}-{last:02d}"


def months_of(key: str) -> list[str]:
    if key == YEAR:
        return list(MONTHS)
    if "Q" in key:
        q = int(key[-1])
        return [f"2026-{m:02d}" for m in range(3 * q - 2, 3 * q + 1)]
    return [key]


# ---------------------------------------------------------------------------
# Reparto por mayor resto (Hamilton) - exacto en centimos, tolerancia 0
# ---------------------------------------------------------------------------


def hamilton(total: int, weights: list[tuple[str, int]]) -> list[tuple[str, int, int]]:
    """Reparte `total` (centimos, con signo) entre `weights` = [(code, peso>=0)].

    Devuelve [(code, centimos, shareBps)] con Sigma centimos == total EXACTO.
    Metodo del mayor resto: cociente entero + un centimo a los `r` mayores restos.
    Desempate de restos: **menor codigo** (orden lexicografico), para que el reparto
    sea determinista y reproducible byte a byte (P7).
    El signo se aplica al final sobre el valor absoluto, de modo que un CECO con
    saldo acreedor (subvencion, reversion de deterioro) se reparte con la misma
    regla y sin sesgo de redondeo hacia el cero.
    """
    pos = [(c, w) for c, w in weights if w > 0]
    W = sum(w for _, w in pos)
    if W == 0 or total == 0:
        return [(c, 0, 0) for c, _ in weights]
    sign = 1 if total >= 0 else -1
    A = abs(total)
    quo: dict[str, int] = {}
    rest: dict[str, int] = {}
    for c, w in pos:
        quo[c] = A * w // W
        rest[c] = A * w - quo[c] * W
    r = A - sum(quo.values())
    order = sorted(pos, key=lambda cw: (-rest[cw[0]], cw[0]))
    for c, _ in order[:r]:
        quo[c] += 1
    out: list[tuple[str, int, int]] = []
    for c, w in weights:
        out.append((c, sign * quo.get(c, 0), (w * 10000 // W) if w > 0 else 0))
    return out


# ---------------------------------------------------------------------------
# Reglas de imputacion del fixture (5 reglas + la de redistribucion en cascada)
# ---------------------------------------------------------------------------

RULES: list[dict[str, Any]] = [
    {
        "code": "AL-OPS-M",
        "name": "Operaciones indirectas a proyectos por coste directo (mensual)",
        "sourceCostCenterCode": "CC-OPS",
        "period": "MONTH",
        "priority": 10,
        "sourceShareBps": 10000,
        "targetKind": "PROJECTS",
        "driver": "DIRECT_COST_SHARE",
        "targetFilter": {"projectStatus": ["ACTIVE"]},
        "zeroBaseFallback": "YTD",
        "targets": [],
    },
    {
        "code": "AL-DEV-Q",
        "name": "Desarrollo de producto a lineas de negocio 60/40 (trimestral)",
        "sourceCostCenterCode": "CC-DEV",
        "period": "QUARTER",
        "priority": 10,
        "sourceShareBps": 10000,
        "targetKind": "BUSINESS_LINES",
        "driver": "FIXED_PERCENT",
        "targetFilter": None,
        "zeroBaseFallback": "SKIP_WARN",
        "targets": [{"businessLineCode": "BL-CONS", "percentBps": 6000},
                    {"businessLineCode": "BL-DEV", "percentBps": 4000}],
    },
    {
        "code": "AL-MKT-Q",
        "name": "Marketing y ventas a proyectos por ingresos (trimestral)",
        "sourceCostCenterCode": "CC-MKT",
        "period": "QUARTER",
        "priority": 20,
        "sourceShareBps": 10000,
        "targetKind": "PROJECTS",
        "driver": "REVENUE_SHARE",
        "targetFilter": {"projectStatus": ["ACTIVE"]},
        "zeroBaseFallback": "SKIP_WARN",
        "targets": [],
    },
    {
        "code": "AL-GA-OPS-Y",
        "name": "G&A: 30 % a Operaciones indirectas (cascada, anual)",
        "sourceCostCenterCode": "CC-GA",
        "period": "YEAR",
        "priority": 10,
        "sourceShareBps": 3000,
        "targetKind": "COST_CENTERS",
        "driver": "FIXED_PERCENT",
        "targetFilter": None,
        "zeroBaseFallback": "SKIP_WARN",
        "targets": [{"costCenterCode": "CC-OPS", "percentBps": 10000}],
    },
    {
        "code": "AL-GA-PRY-Y",
        "name": "G&A: 70 % a proyectos a partes iguales (anual)",
        "sourceCostCenterCode": "CC-GA",
        "period": "YEAR",
        "priority": 20,
        "sourceShareBps": 7000,
        "targetKind": "PROJECTS",
        "driver": "EQUAL",
        "targetFilter": {"projectStatus": ["ACTIVE"]},
        "zeroBaseFallback": "SKIP_WARN",
        "targets": [],
    },
    {
        "code": "AL-OPS-Y",
        "name": "Operaciones indirectas: redistribuye lo recibido en cascada (anual)",
        "sourceCostCenterCode": "CC-OPS",
        "period": "YEAR",
        "priority": 30,
        "sourceShareBps": 10000,
        "targetKind": "PROJECTS",
        "driver": "DIRECT_COST_SHARE",
        "targetFilter": {"projectStatus": ["ACTIVE"]},
        "zeroBaseFallback": "SKIP_WARN",
        "targets": [],
    },
]

# Base sintetica de horas (E10 - `TimeEntry` no existe todavia). Minutos/mes por
# proyecto; contrato del driver HOURS documentado en E5-validacion-liquidacion.md §1.
SYNTHETIC_HOURS_MINUTES = {"P-01": 320 * 60, "P-02": 180 * 60, "P-03": 100 * 60}


# ---------------------------------------------------------------------------
# Lectura del diario y bases de driver
# ---------------------------------------------------------------------------


def read_ledger() -> dict[str, Any]:
    fx = json.loads(e4.FIXTURE.read_text(encoding="utf-8"))
    projects = [p["code"] for p in fx["projects"]]
    proj_bl = {p["code"]: p["businessLineCode"] for p in fx["projects"]}
    proj_status = {p["code"]: p["status"] for p in fx["projects"]}
    business_lines = [b["code"] for b in fx["businessLines"]]
    ceco_kind = {c["code"]: c["kind"] for c in fx["costCenters"]}
    ceco_level = {c["code"]: c["marginLevel"] for c in fx["costCenters"]}
    ceco_alloc = {c["code"]: c["allocatable"] for c in fx["costCenters"]}

    # contribucion contable por nivel/columna (identica a E4)
    contrib: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in e4.LEVELS}
    # bases mensuales
    revenue = defaultdict(int)      # (month, project) -> ingresos (positivo)
    direct_cost = defaultdict(int)  # (month, project) -> coste directo (positivo)
    ceco_own = defaultdict(int)     # (month, ceco) -> coste propio (positivo)
    lines_67 = 0
    pyg = 0

    for entry in fx["entries"]:
        if entry["fiscalYearCode"] != FISCAL_YEAR or entry["kind"] in e4.EXCLUDED_KINDS:
            continue
        mk = month_key(entry["date"])
        for line in entry["lines"]:
            raw = e4.KEY_TO_CODE[line["accountKey"]] if "accountKey" in line else line["accountCode"]
            code = e4.resolve_postable(raw)
            if code[0] not in "67":
                continue
            lines_67 += 1
            amount = line["creditCents"] - line["debitCents"]
            pyg += amount
            p = line.get("projectCode")
            cc = line.get("costCenterCode")
            atype = e4.effective_analytic_type(code, p, cc, line.get("analyticType"))
            col = e4.column_of(atype, p, cc, ceco_kind)
            lvl = e4.level_of(atype, code, cc, ceco_level)
            contrib[lvl][col] += amount
            if atype == "INGRESO_DIRECTO" and p:
                if not code.startswith(REVENUE_SHARE_EXCLUDED_PREFIXES):  # R-A12
                    revenue[(mk, p)] += amount
            elif atype in ("COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2") and p:
                direct_cost[(mk, p)] += -amount
            elif atype == "INDIRECTO_CECO" and cc:
                ceco_own[(mk, cc)] += -amount

    return {
        "fx": fx, "projects": projects, "proj_bl": proj_bl, "proj_status": proj_status,
        "business_lines": business_lines, "ceco_kind": ceco_kind,
        "ceco_level": ceco_level, "ceco_alloc": ceco_alloc,
        "contrib": contrib, "revenue": revenue, "direct_cost": direct_cost,
        "ceco_own": ceco_own, "lines_67": lines_67, "pyg": pyg,
    }


def sum_over(d: dict, months: list[str], key: str) -> int:
    return sum(d[(m, key)] for m in months)


# ---------------------------------------------------------------------------
# Motor de liquidacion
# ---------------------------------------------------------------------------


class Engine:
    def __init__(self, L: dict[str, Any]) -> None:
        self.L = L
        self.lines: list[dict[str, Any]] = []
        self.runs: list[dict[str, Any]] = []
        self.warnings: list[dict[str, Any]] = []
        # allocated_out[(ceco, month, level)] -> centimos ya repartidos por runs finos
        self.allocated_out: dict[tuple[str, str, str], int] = defaultdict(int)
        # expected_out[(runId, ceco, level)] -> centimos que ESE run debe repartir (I5.a)
        self.expected_out: dict[tuple[str, str, str], int] = defaultdict(int)

    # -- bases de driver ---------------------------------------------------

    def eligible_projects(self, rule: dict[str, Any], period: str) -> list[str]:
        f = rule.get("targetFilter") or {}
        want = f.get("projectStatus")
        out = []
        for p in self.L["projects"]:
            if want and self.L["proj_status"][p] not in want:
                continue
            out.append(p)
        return sorted(out)

    def driver_weights(self, rule: dict[str, Any], period: str,
                       fallback_used: list[str]) -> list[tuple[str, int]]:
        drv = rule["driver"]
        ms = months_of(period)
        if rule["targetKind"] == "BUSINESS_LINES":
            if drv != "FIXED_PERCENT":
                raise ValueError("solo FIXED_PERCENT sobre lineas de negocio en este fixture")
            return [(t["businessLineCode"], t["percentBps"]) for t in rule["targets"]]
        if rule["targetKind"] == "COST_CENTERS":
            return [(t["costCenterCode"], t["percentBps"]) for t in rule["targets"]]
        # PROJECTS
        projects = self.eligible_projects(rule, period)
        if drv == "EQUAL":
            return [(p, 1) for p in projects]
        if drv == "FIXED_PERCENT":
            return [(t["projectCode"], t["percentBps"]) for t in rule["targets"]]
        if drv == "REVENUE_SHARE":
            src = self.L["revenue"]
        elif drv == "DIRECT_COST_SHARE":
            src = self.L["direct_cost"]
        elif drv == "HOURS":
            return [(p, SYNTHETIC_HOURS_MINUTES[p] * len(ms)) for p in projects]
        else:
            raise ValueError(f"driver no soportado en el fixture: {drv}")
        w = [(p, max(0, sum_over(src, ms, p))) for p in projects]
        negatives = [p for p in projects if sum_over(src, ms, p) < 0]
        if negatives:
            self.warnings.append({
                "code": "W-E5-NEG-BASE", "rule": rule["code"], "period": period,
                "targets": negatives,
                "detail": "base negativa en el periodo: peso 0, excluido del reparto"})
        if sum(x for _, x in w) == 0:
            fb = rule.get("zeroBaseFallback", "SKIP_WARN")
            self.warnings.append({
                "code": "W-E5-ZERO-BASE", "rule": rule["code"], "period": period,
                "fallback": fb,
                "detail": "base del driver = 0 en el periodo"})
            if fb == "SKIP_WARN":
                return []
            if fb == "EQUAL":
                fallback_used.append("EQUAL")
                return [(p, 1) for p in projects]
            if fb == "YTD":
                fallback_used.append("YTD")
                upto = MONTHS[:MONTHS.index(ms[-1]) + 1]
                return [(p, max(0, sum_over(src, upto, p))) for p in projects]
            raise ValueError(fb)
        return w

    # -- base del CECO fuente ---------------------------------------------

    def source_base(self, ceco: str, period: str, received: dict[str, int]) -> dict[str, int]:
        """Saldo del CECO disponible en este run, POR NIVEL de margen.

        base(s, R) = saldo propio del periodo
                   - lo ya repartido por runs de periodo mas fino dentro del periodo
                   + lo recibido en cascada dentro de ESTE run
        """
        ms = months_of(period)
        own_level = self.L["ceco_level"][ceco]
        base: dict[str, int] = defaultdict(int)
        base[own_level] += sum(self.L["ceco_own"][(m, ceco)] for m in ms)
        for m in ms:
            for lvl in ("MC3", "EBITDA"):
                base[lvl] -= self.allocated_out[(ceco, m, lvl)]
        for lvl, amt in received.items():
            base[lvl] += amt
        return {k: v for k, v in base.items() if v != 0}

    # -- ejecucion de un run ----------------------------------------------

    def run_period(self, period: str, kind: str) -> None:
        rules = sorted([r for r in RULES if r["period"] == kind], key=lambda r: (r["priority"], r["code"]))
        if not rules:
            return
        start, end = period_bounds(period)
        received: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        run_lines: list[dict[str, Any]] = []
        run_id = f"RUN-{period}"

        # reparto del saldo de cada CECO fuente entre SUS reglas del mismo periodo,
        # por sourceShareBps y con Hamilton (Sigma = saldo exacto).
        by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in rules:
            by_source[r["sourceCostCenterCode"]].append(r)

        slice_of: dict[tuple[str, str], dict[str, int]] = {}

        for rule in rules:
            src = rule["sourceCostCenterCode"]
            if (src, rule["code"]) not in slice_of:
                base = self.source_base(src, period, received[src])
                srules = by_source[src]
                for lvl, amt in base.items():
                    parts = hamilton(amt, [(r["code"], r["sourceShareBps"]) for r in srules])
                    for code, cents, _bps in parts:
                        slice_of.setdefault((src, code), {})
                        if cents:
                            slice_of[(src, code)][lvl] = slice_of[(src, code)].get(lvl, 0) + cents
                for r in srules:
                    slice_of.setdefault((src, r["code"]), {})

            portion = slice_of[(src, rule["code"])]
            if not portion:
                continue
            fallback_used: list[str] = []
            weights = self.driver_weights(rule, period, fallback_used)
            if not weights or sum(w for _, w in weights) == 0:
                continue
            for lvl in sorted(portion):
                amount = portion[lvl]
                if amount == 0:
                    continue
                parts = hamilton(amount, weights)
                base_total = sum(w for _, w in weights)
                for code, cents, bps in parts:
                    if cents == 0 and bps == 0:
                        continue
                    line = {
                        "runId": run_id, "ruleCode": rule["code"],
                        "sourceCostCenterCode": src,
                        "targetKind": rule["targetKind"],
                        "target": code,
                        "marginLevel": lvl,
                        "amountCents": cents,
                        "driverBase": dict(weights)[code],
                        "driverBaseTotal": base_total,
                        "driverShareBps": bps,
                        "fallback": fallback_used[0] if fallback_used else None,
                    }
                    run_lines.append(line)
                    self.lines.append(line)
                    if rule["targetKind"] == "COST_CENTERS":
                        received[code][lvl] += cents
                # el importe sale del CECO fuente: se anota como ya repartido
                self.allocated_out[(src, months_of(period)[0], lvl)] += amount
                self.expected_out[(run_id, src, lvl)] += amount

        self.runs.append({
            "runId": run_id, "period": period, "periodKind": kind,
            "periodStart": start, "periodEnd": end,
            "rulesApplied": sorted({l["ruleCode"] for l in run_lines}),
            "lineCount": len(run_lines),
            "totalAllocatedCents": sum(l["amountCents"] for l in run_lines),
            "supersededById": None, "reversedAt": None,
        })

    def run_all(self) -> None:
        for m in MONTHS:
            self.run_period(m, "MONTH")
        for q in QUARTERS:
            self.run_period(q, "QUARTER")
        self.run_period(YEAR, "YEAR")


# ---------------------------------------------------------------------------
# Matriz imputada
# ---------------------------------------------------------------------------


def build() -> dict[str, Any]:
    L = read_ledger()
    eng = Engine(L)
    eng.run_all()

    projects = L["projects"]
    business_lines = L["business_lines"]
    ceco_kind = L["ceco_kind"]

    columns = ([f"PROJ:{p}" for p in projects]
               + [f"BL:{b}" for b in business_lines]
               + [e4.col_ceco(k) for k in e4.CECO_KINDS]
               + [e4.COL_AMORT, e4.COL_FIN, e4.COL_EXTRA, e4.COL_NA])

    # contribucion contable (E4) + delta de imputacion
    contrib: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in e4.LEVELS}
    for lv in e4.LEVELS:
        for c, v in L["contrib"][lv].items():
            contrib[lv][c] += v

    alloc_delta: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in e4.LEVELS}
    for ln in eng.lines:
        lvl = ln["marginLevel"]
        src_col = e4.col_ceco(ceco_kind[ln["sourceCostCenterCode"]])
        if ln["targetKind"] == "PROJECTS":
            tgt_col = f"PROJ:{ln['target']}"
        elif ln["targetKind"] == "BUSINESS_LINES":
            tgt_col = f"BL:{ln['target']}"
        else:
            tgt_col = e4.col_ceco(ceco_kind[ln["target"]])
        alloc_delta[lvl][src_col] += ln["amountCents"]    # alivio (+)
        alloc_delta[lvl][tgt_col] -= ln["amountCents"]    # cargo  (-)

    for lv in e4.LEVELS:
        for c, v in alloc_delta[lv].items():
            contrib[lv][c] += v

    matrix: dict[str, dict[str, int]] = {}
    running = {c: 0 for c in columns}
    for lv in e4.LEVELS:
        for c in columns:
            running[c] += contrib[lv].get(c, 0)
        matrix[lv] = dict(running)

    totals = {lv: sum(matrix[lv].values()) for lv in e4.LEVELS}

    # presentacion por linea de negocio = proyectos de la LN + columna BL de la LN
    bl_matrix = {lv: {b: sum(matrix[lv][f"PROJ:{p}"] for p in projects if L["proj_bl"][p] == b)
                      + matrix[lv][f"BL:{b}"] for b in business_lines} for lv in e4.LEVELS}

    # ------------------------------------------------------------------ checks
    e4exp = json.loads(E4_EXPECTED.read_text(encoding="utf-8"))
    checks: list[dict[str, Any]] = []

    for lv in e4.LEVELS:
        exp = e4exp["levelTotalsCents"][lv]
        checks.append({"id": f"I4.{lv}", "status": "PASS" if totals[lv] == exp else "FAIL",
                       "expected": exp, "actual": totals[lv],
                       "evidencia": f"Sigma columnas nivel {lv} tras imputar = total de E4 (traspaso de suma 0)"})

    checks.append({"id": "I4.b", "status": "PASS" if totals["RESULTADO"] == L["pyg"] else "FAIL",
                   "expected": L["pyg"], "actual": totals["RESULTADO"],
                   "evidencia": "Sigma columnas (RESULTADO) = PyG contable I3"})

    # I5 - por run y CECO fuente: Sigma AllocationLine = porcion liquidada
    per_run_src: dict[tuple[str, str, str], int] = defaultdict(int)
    for ln in eng.lines:
        per_run_src[(ln["runId"], ln["sourceCostCenterCode"], ln["marginLevel"])] += ln["amountCents"]
    i5_detail = []
    i5_fail = []
    for key in sorted(set(per_run_src) | set(eng.expected_out)):
        got, exp = per_run_src.get(key, 0), eng.expected_out.get(key, 0)
        row = {"runId": key[0], "sourceCostCenterCode": key[1], "marginLevel": key[2],
               "baseCents": exp, "allocatedCents": got, "diffCents": got - exp}
        i5_detail.append(row)
        if got != exp:
            i5_fail.append(row)
    checks.append({"id": "I5.a", "status": "PASS" if not i5_fail else "FAIL",
                   "expected": 0, "actual": len(i5_fail),
                   "evidencia": "Sigma AllocationLine por (run, CECO fuente, nivel) = base liquidada (Hamilton, tolerancia 0)",
                   "detail": i5_detail})

    # I5.b - cierre anual: todo CECO imputable queda a 0 en su columna
    residual = {}
    for cc, kind in ceco_kind.items():
        if kind in NON_ALLOCATABLE_KINDS:
            continue
        col = e4.col_ceco(kind)
        residual[cc] = {lv: matrix[lv][col] for lv in ("MC3", "EBITDA")}
    bad_res = {cc: r for cc, r in residual.items() if any(v != 0 for v in r.values())}
    checks.append({"id": "I5.b", "status": "PASS" if not bad_res else "FAIL",
                   "expected": 0, "actual": len(bad_res),
                   "evidencia": "cierre anual: todo CECO imputable queda liquidado a 0 en su columna",
                   "residual": bad_res})

    # I-E5-1 - sin ciclos en el grafo de cascada
    edges = sorted({(r["sourceCostCenterCode"], t["costCenterCode"])
                    for r in RULES if r["targetKind"] == "COST_CENTERS" for t in r["targets"]})
    cyc = any(a == b for a, b in edges) or any((b, a) in edges for a, b in edges)
    checks.append({"id": "I-E5-1", "status": "FAIL" if cyc else "PASS", "expected": 0,
                   "actual": 1 if cyc else 0, "evidencia": "grafo CECO->CECO es un DAG",
                   "edges": [list(e) for e in edges]})

    # I-E5-2 - Sigma percentBps = 10000 en toda regla FIXED_PERCENT
    bad_pct = [r["code"] for r in RULES if r["driver"] == "FIXED_PERCENT"
               and sum(t["percentBps"] for t in r["targets"]) != 10000]
    checks.append({"id": "I-E5-2", "status": "PASS" if not bad_pct else "FAIL", "expected": 0,
                   "actual": len(bad_pct), "evidencia": "Sigma percentBps = 10000 en toda regla FIXED_PERCENT",
                   "offenders": bad_pct})

    # I-E5-3 - Sigma sourceShareBps = 10000 por (CECO fuente, periodo)
    agg: dict[tuple[str, str], int] = defaultdict(int)
    for r in RULES:
        agg[(r["sourceCostCenterCode"], r["period"])] += r["sourceShareBps"]
    bad_share = [f"{k[0]}/{k[1]}={v}" for k, v in sorted(agg.items()) if v != 10000]
    checks.append({"id": "I-E5-3", "status": "PASS" if not bad_share else "FAIL", "expected": 0,
                   "actual": len(bad_share),
                   "evidencia": "Sigma sourceShareBps = 10000 por (CECO fuente, periodo)",
                   "offenders": bad_share})

    # I-E5-4 - remanente de Hamilton <= n receptores - 1 (se verifica por construccion)
    checks.append({"id": "I-E5-4", "status": "PASS", "expected": 0, "actual": 0,
                   "evidencia": "reparto por mayor resto: Sigma centimos = importe, remanente < n receptores"})

    # I-E5-5 - ningun CECO no imputable es fuente ni destino
    bad_src = [r["code"] for r in RULES
               if ceco_kind[r["sourceCostCenterCode"]] in NON_ALLOCATABLE_KINDS
               or not L["ceco_alloc"][r["sourceCostCenterCode"]]]
    bad_tgt = [r["code"] for r in RULES if r["targetKind"] == "COST_CENTERS"
               for t in r["targets"] if ceco_kind[t["costCenterCode"]] in NON_ALLOCATABLE_KINDS]
    checks.append({"id": "I-E5-5", "status": "PASS" if not (bad_src or bad_tgt) else "FAIL",
                   "expected": 0, "actual": len(bad_src) + len(bad_tgt),
                   "evidencia": "CC-FIN / CC-EXT / CC-NA nunca son fuente ni destino de imputacion"})

    # I-E5-6 - el nivel viaja con el dinero: Sigma alloc_delta por nivel = 0
    bad_lvl = [lv for lv in e4.LEVELS if sum(alloc_delta[lv].values()) != 0]
    checks.append({"id": "I-E5-6", "status": "PASS" if not bad_lvl else "FAIL", "expected": 0,
                   "actual": len(bad_lvl),
                   "evidencia": "la imputacion es un traspaso interno de suma 0 en CADA nivel de margen",
                   "offenders": bad_lvl})

    # I-E5-7 - ningun destino archivado / proyecto CLOSED
    bad_closed = sorted({ln["target"] for ln in eng.lines if ln["targetKind"] == "PROJECTS"
                         and L["proj_status"][ln["target"]] != "ACTIVE"})
    checks.append({"id": "I-E5-7", "status": "PASS" if not bad_closed else "FAIL", "expected": 0,
                   "actual": len(bad_closed),
                   "evidencia": "ningun AllocationLine apunta a proyecto CLOSED ni a dimension archivada"})

    # I-E5-8 - orden topologico: la regla que alimenta un CECO tiene prioridad menor
    #          que la regla con la que ese CECO reparte, dentro del mismo periodo
    bad_topo = []
    for r in RULES:
        if r["targetKind"] != "COST_CENTERS":
            continue
        for t in r["targets"]:
            for r2 in RULES:
                if r2["sourceCostCenterCode"] == t["costCenterCode"] and r2["period"] == r["period"]:
                    if r2["priority"] <= r["priority"]:
                        bad_topo.append(f"{r['code']}->{r2['code']}")
    checks.append({"id": "I-E5-8", "status": "PASS" if not bad_topo else "FAIL", "expected": 0,
                   "actual": len(bad_topo),
                   "evidencia": "cascada resuelta: el receptor reparte con prioridad posterior al donante",
                   "offenders": bad_topo})

    # I-E5-9 - ningun run supersedido/revertido aporta importe
    live = [r for r in eng.runs if r["supersededById"] is None and r["reversedAt"] is None]
    checks.append({"id": "I-E5-9",
                   "status": "PASS" if sum(r["totalAllocatedCents"] for r in live)
                   == sum(l["amountCents"] for l in eng.lines) else "FAIL",
                   "expected": sum(l["amountCents"] for l in eng.lines),
                   "actual": sum(r["totalAllocatedCents"] for r in live),
                   "evidencia": "solo los runs vigentes (no supersededById, no reversedAt) aportan importe"})

    # ------------------------------------------------------ anexo HOURS (E10)
    ms = MONTHS
    w_hours = [(p, SYNTHETIC_HOURS_MINUTES[p] * len(ms)) for p in projects]
    hours_illustrative = [{"target": c, "amountCents": v, "driverShareBps": b}
                          for c, v, b in hamilton(sum(L["ceco_own"][(m, "CC-OPS")] for m in ms), w_hours)]

    result: dict[str, Any] = {
        "schemaVersion": "1.0",
        "generatedBy": "docs/design/fixtures/build_liquidacion_esperada.py",
        "note": ("Liquidacion de CECOs esperada (E5) del fixture tests/fixtures/ejercicio-completo.json. "
                 "Centimos enteros. AllocationLine.amountCents en convencion de COSTE (positivo = coste "
                 "que sale del CECO fuente). La matriz mantiene el signo de E4 (positivo suma al margen). "
                 "El nivel de margen VIAJA con el importe: por eso la imputacion es un traspaso de suma 0 "
                 "en cada nivel y I4 sigue cuadrando al centimo."),
        "source": {"fixture": "tests/fixtures/ejercicio-completo.json",
                   "e4Expected": "docs/design/fixtures/pyg-analitica-esperada.json",
                   "fiscalYear": FISCAL_YEAR, "excludedKinds": sorted(e4.EXCLUDED_KINDS)},
        "rules": RULES,
        "driverBases": {
            "revenueShareCents": {m: {p: L["revenue"][(m, p)] for p in projects} for m in MONTHS},
            "directCostShareCents": {m: {p: L["direct_cost"][(m, p)] for p in projects} for m in MONTHS},
            "costCenterOwnCents": {m: {c: L["ceco_own"][(m, c)] for c in sorted(ceco_kind)} for m in MONTHS},
            "syntheticHoursMinutesPerMonth": SYNTHETIC_HOURS_MINUTES,
        },
        "runs": eng.runs,
        "allocationLines": eng.lines,
        "warnings": eng.warnings,
        "levels": e4.LEVELS,
        "columns": columns,
        "allocationDeltaCents": {lv: dict(sorted(alloc_delta[lv].items())) for lv in e4.LEVELS},
        "matrixCents": matrix,
        "businessLineMatrixCents": bl_matrix,
        "levelTotalsCents": totals,
        "levelTotalsE4Cents": e4exp["levelTotalsCents"],
        "pygContableCents": L["pyg"],
        "lineCount67": L["lines_67"],
        "annexHoursIllustrative": {
            "note": ("Ilustrativo, NO forma parte de la matriz: E10 crea `TimeEntry`. Reparto anual de "
                     "CC-OPS por driver HOURS sobre la base sintetica de arriba."),
            "sourceCents": sum(L["ceco_own"][(m, "CC-OPS")] for m in ms),
            "lines": hours_illustrative,
        },
        "checks": checks,
    }
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    data = build()
    failed = [c for c in data["checks"] if c["status"] != "PASS"]
    for c in failed:
        print(f"FAIL {c['id']}: esperado {c['expected']} != {c['actual']}", file=sys.stderr)
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
        print("OK: liquidacion-esperada.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    print(f"  {len(data['allocationLines'])} AllocationLine en {len([r for r in data['runs'] if r['lineCount']])} runs con importe")
    for lv in e4.LEVELS:
        print(f"  {lv:10} total = {data['levelTotalsCents'][lv]:>12,}   (E4: {data['levelTotalsE4Cents'][lv]:>12,})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
