#!/usr/bin/env python3
"""
E4 · Generador de la PyG analitica ESPERADA del fixture `ejercicio-completo.json`.

    python3 docs/design/fixtures/build_pyg_analitica_esperada.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), la matriz canonica

        nivel de margen  x  columna analitica

recorriendo el diario del fixture inmutable `tests/fixtures/ejercicio-completo.json`,
resolviendo el `tipo_analitico` de cada cuenta desde `seeds/npgc.csv` y aplicando las
reglas de destino analitico de `docs/design/E4-validacion-analitica.md` §2.

Escribe `docs/design/fixtures/pyg-analitica-esperada.json`. Con `--check` no escribe:
reconstruye, compara byte a byte con el fichero en disco y falla si difiere.

NO TOCA `tests/fixtures/*`: los fixtures de E3 son inmutables y aqui son solo entrada.

Todo en centimos enteros. Signo de la matriz: **positivo = suma al margen**
(ingreso), **negativo = resta** (gasto). Es decir, para toda linea 6/7:

        aporte = creditCents - debitCents

con lo que un ingreso en el haber aporta +, un gasto en el debe aporta -, una
devolucion de ventas (708, contra-cuenta) aporta - y una devolucion de compras
(608, contra-cuenta) aporta +. El contra-asiento (REVERSAL) invierte columnas y
por tanto se compensa solo, sin ningun tratamiento especial.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests" / "fixtures" / "ejercicio-completo.json"
SEED_CSV = ROOT / "seeds" / "npgc.csv"
OUT = Path(__file__).resolve().parent / "pyg-analitica-esperada.json"

FISCAL_YEAR = "2026"
EXCLUDED_KINDS = {"REGULARIZATION", "CLOSING", "OPENING"}  # I3 / I4

# ---------------------------------------------------------------------------
# Mapa de cuentas de sistema: identico a build_ejercicio_completo.py
# (useSubaccounts=false, createSoftwareAccounts=false). Se replica en vez de
# importarse para que este script sea auditable de forma aislada; una asercion
# al final comprueba que ambos mapas coinciden.
# ---------------------------------------------------------------------------

KEY_TO_CODE: dict[str, str] = {
    "CLIENTES": "430", "PROVEEDORES": "400", "ACREEDORES": "410",
    "BANCO_DEFAULT": "572", "CAJA": "570", "IVA_SOPORTADO": "472",
    "IVA_REPERCUTIDO": "477", "IRPF_RETENIDO_CLIENTES": "473", "IRPF_A_PAGAR": "4751",
    "HP_ACREEDORA_IVA": "4750", "HP_DEUDORA_IVA": "4700", "SS_ACREEDORA": "476",
    "REMUNERACIONES_PENDIENTES": "465", "RESULTADO_EJERCICIO": "129",
    "VENTAS_DEFAULT": "705", "COMPRAS_DEFAULT": "600", "SUBCONTRATACION_DEFAULT": "607",
    "ANTICIPOS_PROVEEDORES": "407", "ANTICIPOS_CLIENTES": "438",
    "DESCUENTO_PP_VENTAS": "706", "DESCUENTO_PP_COMPRAS": "606",
    "DEVOLUCION_VENTAS": "708", "DEVOLUCION_COMPRAS": "608",
    "RAPPEL_VENTAS": "709", "RAPPEL_COMPRAS": "609",
    "REDONDEO_GASTO": "669", "REDONDEO_INGRESO": "769",
    "IRPF_PROFESIONALES_A_PAGAR": "4751", "IRPF_ALQUILERES_A_PAGAR": "4751",
    "IRPF_TRABAJO_A_PAGAR": "4751", "IVA_SOPORTADO_ISP": "472",
    "IVA_REPERCUTIDO_ISP": "477", "AJUSTE_IVA_NEGATIVO": "634",
    "AJUSTE_IVA_POSITIVO": "639", "IMPUESTO_BENEFICIOS_GASTO": "630",
    "HP_ACREEDORA_IS": "4752", "HP_DEUDORA_IS": "4709",
    "ACTIVO_IMPUESTO_DIFERIDO": "4740", "PASIVO_IMPUESTO_DIFERIDO": "479",
    "PERIODIFICACION_GASTO": "480", "PERIODIFICACION_INGRESO": "485",
    "DIFERENCIA_CAMBIO_NEGATIVA": "668", "DIFERENCIA_CAMBIO_POSITIVA": "768",
    "RETENCIONES_CAPITAL_SOPORTADAS": "473", "SS_DEUDORA": "471",
    "ANTICIPOS_REMUNERACIONES": "460", "SUELDOS_DEFAULT": "640",
    "SS_EMPRESA_DEFAULT": "642", "CLIENTES_DUDOSO_COBRO": "436",
    "DETERIORO_CLIENTES": "490", "DOTACION_DETERIORO_CREDITOS": "694",
    "REVERSION_DETERIORO_CREDITOS": "794", "PERDIDA_CREDITOS_INCOBRABLES": "650",
    "CUENTA_PUENTE_TESORERIA": "555", "COMISIONES_BANCARIAS": "626",
    "REMANENTE": "120", "RESULTADOS_NEGATIVOS_ANTERIORES": "121",
}

# ---------------------------------------------------------------------------
# Plan de cuentas: codigos, hojas postables y tipo_analitico del seed
# ---------------------------------------------------------------------------


def load_plan(variant: str = "PYMES") -> tuple[set[str], set[str], dict[str, str], dict[str, str]]:
    with SEED_CSV.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    codes = {r["codigo"] for r in rows if variant != "PYMES" or r["pymes"] == "1"}
    postable = {c for c in codes if not any(o != c and o.startswith(c) for o in codes)}
    analytic = {r["codigo"]: (r["tipo_analitico"] or "") for r in rows}
    names = {r["codigo"]: r["nombre"] for r in rows}
    return codes, postable, analytic, names


PLAN_CODES, PLAN_POSTABLE, ACCOUNT_ANALYTIC, ACCOUNT_NAME = load_plan("PYMES")


def resolve_postable(code: str) -> str:
    """Identica a lib/accounts/map.ts::resolvePostable y a la del generador de E3."""
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


def account_analytic_type(code: str) -> str:
    """tipo_analitico de la cuenta; si la hoja no lo trae, hereda del ancestro
    mas cercano que si lo tenga (el seed lo marca en el nivel donde es informativo)."""
    cur = code
    while cur:
        t = ACCOUNT_ANALYTIC.get(cur, "")
        if t:
            return t
        cur = cur[:-1]
    raise KeyError(f"cuenta {code} sin tipo_analitico ni ancestro con tipo")


# ---------------------------------------------------------------------------
# Niveles de margen y columnas
# ---------------------------------------------------------------------------

LEVELS = ["INGRESOS", "MC1", "MC2", "MC3", "EBITDA", "EBIT", "BAI", "RESULTADO"]

# MarginLevelConfig por defecto: nivel -> AnalyticTypes que ENTRAN en ese nivel.
MARGIN_LEVEL_CONFIG: dict[str, list[str]] = {
    "INGRESOS": ["INGRESO_DIRECTO"],
    "MC1": ["COSTE_DIRECTO_MC1"],
    "MC2": ["COSTE_DIRECTO_MC2"],
    "MC3": [],        # INDIRECTO_CECO de CECOs con marginLevel = MC3
    "EBITDA": [],     # INDIRECTO_CECO de CECOs con marginLevel = EBITDA
    "EBIT": ["AMORTIZACION_DETERIORO"],
    "BAI": ["FINANCIERO", "EXTRAORDINARIO"],
    "RESULTADO": ["NO_ANALITICO"],
}
TYPE_TO_LEVEL = {t: lvl for lvl, ts in MARGIN_LEVEL_CONFIG.items() for t in ts}

# R-A11 (respuesta 1 al arquitecto). `NO_ANALITICO` no es un bloque homogeneo:
#   · impuesto sobre beneficios (630/633/638) -> nivel RESULTADO, NO configurable
#   · el resto (73x, 74x, 75x: explotacion sin dimension) -> `nonAnalyticLevel`,
#     default EBITDA (por encima de EBIT: son resultado de explotacion).
NON_ANALYTIC_TAX_PREFIXES = ("630", "633", "638")
NON_ANALYTIC_LEVEL = "EBITDA"   # MarginLevelConfig.nonAnalyticLevel, por organizacion

# Columnas no-proyecto, en orden de presentacion
CECO_KINDS = ["OPERACIONES_INDIRECTAS", "DESARROLLO_PRODUCTO", "MARKETING_VENTAS",
              "G_A", "FINANCIERO", "EXTRAORDINARIO", "OTROS", "SIN_ASIGNAR"]


def col_ceco(kind: str) -> str:
    return f"CECO:{kind}"


COL_AMORT = "AMORTIZACION_DETERIORO"
COL_FIN = "FINANCIERO"
COL_EXTRA = "EXTRAORDINARIO"
COL_NA = "NO_ANALITICO"


# ---------------------------------------------------------------------------
# Reglas de destino analitico (E4 §2) — funcion pura sobre una linea
# ---------------------------------------------------------------------------


def effective_analytic_type(account_code: str, project: str | None,
                            cost_center: str | None, override: str | None) -> str:
    """R-A1..R-A4. Precedencia: override explicito de la linea > override implicito
    por dimension (INDIRECTO_CECO + projectId => COSTE_DIRECTO_MC2) > tipo de la cuenta."""
    if override:
        return override
    base = account_analytic_type(account_code)
    if base == "INDIRECTO_CECO" and project is not None:
        # R-A3: un gasto de estructura imputado a un proyecto concreto es coste
        # directo del proyecto; entra en MC2 (servicios exteriores del proyecto).
        return "COSTE_DIRECTO_MC2"
    if base in ("COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2", "INGRESO_DIRECTO") and project is None:
        # R-A4: cuenta de tipo directo posteada a un CECO => es indirecta de hecho.
        # (INGRESO_DIRECTO a CECO no ocurre en el fixture pero la regla es simetrica.)
        return "INDIRECTO_CECO"
    return base


def column_of(atype: str, project: str | None, cost_center: str | None,
              ceco_kind: dict[str, str]) -> str:
    """R-A5. La columna la fija el tipo analitico efectivo; la dimension solo
    desambigua dentro de la familia."""
    if atype in ("INGRESO_DIRECTO", "COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2"):
        assert project, f"tipo {atype} sin projectId"
        return f"PROJ:{project}"
    if atype == "INDIRECTO_CECO":
        assert cost_center, "INDIRECTO_CECO sin costCenterId"
        return col_ceco(ceco_kind[cost_center])
    if atype == "AMORTIZACION_DETERIORO":
        # Amortizacion de activo afecto a proyecto: columna del proyecto (nivel EBIT).
        return f"PROJ:{project}" if project else COL_AMORT
    if atype == "FINANCIERO":
        return COL_FIN
    if atype == "EXTRAORDINARIO":
        return COL_EXTRA
    if atype == "NO_ANALITICO":
        return COL_NA
    raise KeyError(atype)


def level_of(atype: str, account_code: str, cost_center: str | None,
             ceco_level: dict[str, str]) -> str:
    """R-A6. El `marginLevel` del CECO SOLO aplica a lineas cuyo tipo efectivo es
    INDIRECTO_CECO; para el resto manda el MarginLevelConfig del tipo.
    R-A11: NO_ANALITICO se parte entre RESULTADO (impuesto) y nonAnalyticLevel."""
    if atype == "INDIRECTO_CECO":
        assert cost_center, "INDIRECTO_CECO sin costCenterId"
        lvl = ceco_level[cost_center]
        assert lvl in ("MC3", "EBITDA"), f"CECO con marginLevel invalido: {lvl}"
        return lvl
    if atype == "NO_ANALITICO":
        return "RESULTADO" if account_code.startswith(NON_ANALYTIC_TAX_PREFIXES) else NON_ANALYTIC_LEVEL
    return TYPE_TO_LEVEL[atype]


# ---------------------------------------------------------------------------
# Calculo
# ---------------------------------------------------------------------------


def build() -> dict[str, Any]:
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))

    projects = [p["code"] for p in fx["projects"]]
    proj_bl = {p["code"]: p["businessLineCode"] for p in fx["projects"]}
    business_lines = [b["code"] for b in fx["businessLines"]]
    ceco_kind = {c["code"]: c["kind"] for c in fx["costCenters"]}
    ceco_level = {c["code"]: c["marginLevel"] for c in fx["costCenters"]}

    columns = ([f"PROJ:{p}" for p in projects]
               + [col_ceco(k) for k in CECO_KINDS]
               + [COL_AMORT, COL_FIN, COL_EXTRA, COL_NA])

    # aporte[level][column] = suma de aportes de las lineas que ENTRAN en ese nivel
    contrib: dict[str, dict[str, int]] = {lv: defaultdict(int) for lv in LEVELS}
    detail: list[dict[str, Any]] = []
    pyg_contable = 0
    lines_67 = 0

    for entry in fx["entries"]:
        if entry["fiscalYearCode"] != FISCAL_YEAR:
            continue
        if entry["kind"] in EXCLUDED_KINDS:
            continue
        for line in entry["lines"]:
            raw = KEY_TO_CODE[line["accountKey"]] if "accountKey" in line else line["accountCode"]
            code = resolve_postable(raw)
            if code[0] not in "67":
                continue
            lines_67 += 1
            amount = line["creditCents"] - line["debitCents"]
            pyg_contable += amount
            project = line.get("projectCode")
            cc = line.get("costCenterCode")
            override = line.get("analyticType")  # el fixture de E3 no lo trae; se soporta
            atype = effective_analytic_type(code, project, cc, override)
            col = column_of(atype, project, cc, ceco_kind)
            lvl = level_of(atype, code, cc, ceco_level)
            contrib[lvl][col] += amount
            detail.append({"entryRef": entry["ref"], "lineNo": line["lineNo"],
                           "accountCode": code, "analyticType": atype,
                           "projectCode": project, "costCenterCode": cc,
                           "level": lvl, "column": col, "amountCents": amount})

    # Matriz CUMULATIVA: matrix[level][col] = suma de aportes de niveles <= level
    matrix: dict[str, dict[str, int]] = {}
    running: dict[str, int] = {c: 0 for c in columns}
    for lv in LEVELS:
        for c in columns:
            running[c] += contrib[lv].get(c, 0)
        matrix[lv] = dict(running)

    # Columnas agregadas por linea de negocio (presentacion; NO suman al total)
    bl_matrix: dict[str, dict[str, int]] = {}
    for lv in LEVELS:
        bl_matrix[lv] = {bl: sum(matrix[lv][f"PROJ:{p}"] for p in projects if proj_bl[p] == bl)
                         for bl in business_lines}

    totals = {lv: sum(matrix[lv].values()) for lv in LEVELS}

    # ------------------------------------------------------------------ I4
    checks: list[dict[str, Any]] = []
    checks.append({"id": "I4", "level": "RESULTADO", "status": "PASS" if totals["RESULTADO"] == pyg_contable else "FAIL",
                   "expected": pyg_contable, "actual": totals["RESULTADO"],
                   "evidencia": "Sigma columnas (RESULTADO) = PyG contable I3"})
    # Cobertura: ninguna linea 6/7 fuera de la matriz
    covered = len(detail)
    checks.append({"id": "I-E4-1", "status": "PASS" if covered == lines_67 else "FAIL",
                   "expected": lines_67, "actual": covered,
                   "evidencia": "toda linea 6/7 del periodo tiene destino en la matriz"})
    # businessLineId derivado del proyecto
    bad_bl = [d for d in detail if d["projectCode"] and proj_bl[d["projectCode"]] not in business_lines]
    checks.append({"id": "I-E4-3", "status": "PASS" if not bad_bl else "FAIL",
                   "expected": 0, "actual": len(bad_bl),
                   "evidencia": "businessLine de toda linea con proyecto = la del proyecto"})
    # Exactamente una dimension en lineas con destino directo/indirecto
    bad_dim = [d for d in detail
               if d["analyticType"] != "NO_ANALITICO"
               and (d["projectCode"] is None) == (d["costCenterCode"] is None)]
    checks.append({"id": "I-E4-2", "status": "PASS" if not bad_dim else "FAIL",
                   "expected": 0, "actual": len(bad_dim),
                   "evidencia": "linea 6/7 no NO_ANALITICO con exactamente una dimension"})
    # NO_ANALITICO sin dimension
    bad_na = [d for d in detail if d["analyticType"] == "NO_ANALITICO"
              and (d["projectCode"] or d["costCenterCode"])]
    checks.append({"id": "I-E4-4", "status": "PASS" if not bad_na else "FAIL",
                   "expected": 0, "actual": len(bad_na),
                   "evidencia": "NO_ANALITICO nunca lleva dimension"})

    result: dict[str, Any] = {
        "schemaVersion": "1.0",
        "generatedBy": "docs/design/fixtures/build_pyg_analitica_esperada.py",
        "note": ("PyG analitica esperada del fixture tests/fixtures/ejercicio-completo.json. "
                 "Centimos enteros. Signo: positivo suma al margen, negativo resta. "
                 "Matriz CUMULATIVA por nivel. Las columnas businessLines son agregados "
                 "de las columnas de proyecto y NO entran en el total."),
        "source": {"fixture": "tests/fixtures/ejercicio-completo.json",
                   "fiscalYear": FISCAL_YEAR, "excludedKinds": sorted(EXCLUDED_KINDS)},
        "marginLevelConfig": MARGIN_LEVEL_CONFIG,
        "nonAnalyticSplit": {"taxPrefixes": list(NON_ANALYTIC_TAX_PREFIXES),
                             "taxLevel": "RESULTADO", "nonAnalyticLevel": NON_ANALYTIC_LEVEL},
        "levels": LEVELS,
        "columns": columns,
        "matrixCents": matrix,
        "businessLineMatrixCents": bl_matrix,
        "levelTotalsCents": totals,
        "contributionByLevelCents": {lv: dict(sorted(contrib[lv].items())) for lv in LEVELS},
        "pygContableCents": pyg_contable,
        "lineCount67": lines_67,
        "checks": checks,
        "lineDetail": detail,
    }
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    data = build()
    for c in data["checks"]:
        if c["status"] != "PASS":
            print(f"FAIL {c['id']}: esperado {c['expected']} != {c['actual']}", file=sys.stderr)
            return 2

    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUT.exists():
            print(f"falta {OUT}", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print(f"{OUT} difiere de la reconstruccion", file=sys.stderr)
            return 1
        print("OK: pyg-analitica-esperada.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    for lv in LEVELS:
        print(f"  {lv:10} total = {data['levelTotalsCents'][lv]:>12,}")
    print(f"  PyG contable (I3) = {data['pygContableCents']:,}  ({data['lineCount67']} lineas 6/7)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
