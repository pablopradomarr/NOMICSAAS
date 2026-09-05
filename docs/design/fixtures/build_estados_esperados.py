#!/usr/bin/env python3
"""
E6 · Generador de los ESTADOS FINANCIEROS esperados del fixture `ejercicio-completo.json`.

    python3 docs/design/fixtures/build_estados_esperados.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD):

  1. Balance de situacion a 31/12/2026 en cuatro fotos
     (PRE_REGULARIZACION, POST_REGULARIZACION, POST_CIERRE, APERTURA_2027)
     x dos modelos (NORMAL, PYMES), por epigrafe oficial.
  2. PyG contable 2026, modelo NORMAL y PYMES, por epigrafe y con subtotales
     A.1 / A.2 / A.3 / A.4.
  3. Cashflow 2026: directo (por contrapartida de los movimientos de 57x),
     mensual y anual, e indirecto (particion mecanica de las cuentas no-57x).
  4. Los invariantes I2, I3, I6 y los propuestos I-E6-1 .. I-E6-10.

Escribe `docs/design/fixtures/estados-esperados.json`. Con `--check` no escribe:
reconstruye, compara byte a byte con el fichero en disco y falla si difiere.

NO TOCA `tests/fixtures/*`: los fixtures de E3 son inmutables y aqui son solo entrada.

Convenios (identicos a los de la skill `estados-financieros`):
  · Todo en centimos enteros. `saldo(cuenta) = Sigma(debit) - Sigma(credit)`, positivo = deudor.
  · Balance: activo se presenta con el saldo DEUDOR en positivo; pasivo y PN con el
    saldo ACREEDOR en positivo (`-saldo`). Con este convenio las contra-cuentas
    (`is_contra`) RESTAN solas: `2816` tiene saldo acreedor y aparece como negativa
    dentro de su epigrafe de activo. `isContra` no es un parametro del calculo,
    es (a) presentacion y (b) un check de signo anomalo.
  · PyG: `aporte = credit - debit`, con lo que ingresos suman y gastos restan;
    `708`/`608` (contra) se auto-corrigen por el signo de su propio saldo.
  · Cuentas `bidirectional`: el seed guarda SIEMPRE la ruta deudora. Si el saldo es
    acreedor el balance las reclasifica al epigrafe espejo de pasivo (tabla
    BIDIRECTIONAL_MIRROR). Nunca aparecen en los dos lados a la vez.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests" / "fixtures" / "ejercicio-completo.json"
SEED_CSV = ROOT / "seeds" / "npgc.csv"
OUT = Path(__file__).resolve().parent / "estados-esperados.json"

FISCAL_YEAR = "2026"
NEXT_FISCAL_YEAR = "2027"

# I3: la PyG excluye estos kinds. Misma constante que build_pyg_analitica_esperada.py.
PYG_EXCLUDED_KINDS = {"REGULARIZATION", "CLOSING", "OPENING"}
# El cashflow excluye ademas cualquier asiento que no mueva economia real:
# OPENING fija saldos iniciales, CLOSING los anula, REGULARIZATION solo reordena 6/7 -> 129.
CF_EXCLUDED_KINDS = {"REGULARIZATION", "CLOSING", "OPENING"}

# ---------------------------------------------------------------------------
# Mapa de cuentas de sistema (useSubaccounts=false, createSoftwareAccounts=false).
# Replicado de build_ejercicio_completo.py / build_pyg_analitica_esperada.py para
# que este script sea auditable aislado.
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
# Plan de cuentas desde el seed
# ---------------------------------------------------------------------------

VARIANT = "PYMES"   # fixture: Organization.pgcVariant = PYMES


def load_plan() -> dict[str, dict[str, str]]:
    with SEED_CSV.open(encoding="utf-8") as fh:
        return {r["codigo"]: r for r in csv.DictReader(fh)}


SEED = load_plan()
PLAN_CODES = {c for c, r in SEED.items() if VARIANT != "PYMES" or r["pymes"] == "1"}
PLAN_POSTABLE = {c for c in PLAN_CODES if not any(o != c and o.startswith(c) for o in PLAN_CODES)}


def resolve_postable(code: str) -> str:
    """Identica a lib/accounts/map.ts::resolvePostable."""
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


def inherit(code: str, field: str) -> str:
    """Valor del campo en la cuenta o, si viene vacio, en el ancestro mas cercano."""
    cur = code
    while cur:
        v = SEED.get(cur, {}).get(field, "")
        if v:
            return v
        cur = cur[:-1]
    return ""


def statement_of(code: str) -> str:
    return inherit(code, "estado_financiero")


def epigraph_of(code: str, model: str) -> str:
    col = "epigrafe" if model == "NORMAL" else "epigrafe_pymes"
    v = inherit(code, col)
    if not v and model == "PYMES":
        # Cuenta fuera del plan PYMES: se presenta en su epigrafe normal (no ocurre
        # en el fixture; el check I-E6-9 lo vigila).
        v = inherit(code, "epigrafe")
    return v


def is_contra(code: str) -> bool:
    return inherit(code, "is_contra") == "1" or SEED.get(code, {}).get("is_contra") == "1"


def is_bidirectional(code: str) -> bool:
    cur = code
    while cur:
        if SEED.get(cur, {}).get("bidireccional") == "1":
            return True
        cur = cur[:-1]
    return False


# ---------------------------------------------------------------------------
# R-B4 · Espejo de las 7 cuentas bidireccionales.
# El seed guarda la ruta DEUDORA (activo). Con saldo acreedor el balance las
# reclasifica al epigrafe de pasivo indicado aqui. Cadenas verbatim del seed.
# ---------------------------------------------------------------------------

_P_OTROS_PF_N = "C) Pasivo corriente / III. Deudas a corto plazo / 5. Otros pasivos financieros"
_P_OTROS_PF_P = "C) Pasivo corriente / II. Deudas a corto plazo / 5. Otros pasivos financieros"
_P_GRUPO_N = "C) Pasivo corriente / IV. Deudas con empresas del grupo y asociadas a corto plazo"
_P_GRUPO_P = "C) Pasivo corriente / III. Deudas con empresas del grupo y asociadas a corto plazo"
_P_ACREED_N = "C) Pasivo corriente / V. Acreedores comerciales y otras cuentas a pagar / 3. Acreedores varios"
_P_ACREED_P = "C) Pasivo corriente / IV. Acreedores comerciales y otras cuentas a pagar / 3. Acreedores varios"

BIDIRECTIONAL_MIRROR: dict[str, dict[str, str]] = {
    # codigo: {NORMAL, PYMES} epigrafe cuando el saldo es ACREEDOR
    "551": {"NORMAL": _P_OTROS_PF_N, "PYMES": _P_OTROS_PF_P},
    "552": {"NORMAL": _P_GRUPO_N, "PYMES": _P_GRUPO_P},
    "5523": {"NORMAL": _P_GRUPO_N, "PYMES": _P_GRUPO_P},
    "5524": {"NORMAL": _P_GRUPO_N, "PYMES": _P_GRUPO_P},
    "5525": {"NORMAL": _P_OTROS_PF_N, "PYMES": _P_OTROS_PF_P},
    "554": {"NORMAL": _P_ACREED_N, "PYMES": _P_ACREED_P},
    "555": {"NORMAL": _P_ACREED_N, "PYMES": _P_ACREED_P},
}


def mirror_of(code: str, model: str) -> str:
    cur = code
    while cur:
        if cur in BIDIRECTIONAL_MIRROR:
            return BIDIRECTIONAL_MIRROR[cur][model]
        cur = cur[:-1]
    raise KeyError(f"cuenta bidireccional {code} sin epigrafe espejo definido")


# ---------------------------------------------------------------------------
# Cashflow: cuenta -> bloque. Primer prefijo que casa, del mas largo al mas corto.
# `category` es el CashflowCategory del modelo de datos (3 valores);
# `bucket` es el desglose que exige el metodo directo y el EFE (no existe hoy
# en el enum: ver veredicto O-3).
# ---------------------------------------------------------------------------

CASH_PREFIX = "57"

# `cashflow_bucket` se lee del SEED (columna anadida en E6): unica fuente de verdad.
# Siete buckets; la CashflowCategory de tres valores se DERIVA, no se almacena.
CF_BUCKET_ORDER = ["COBROS_CLIENTES", "PAGOS_PROVEEDORES", "PAGOS_PERSONAL",
                   "PAGOS_IMPUESTOS", "OTROS_EXPLOTACION", "INVERSION", "FINANCIACION"]
CF_BUCKET_CATEGORY = {
    "COBROS_CLIENTES": "OPERATING", "PAGOS_PROVEEDORES": "OPERATING",
    "PAGOS_PERSONAL": "OPERATING", "PAGOS_IMPUESTOS": "OPERATING",
    "OTROS_EXPLOTACION": "OPERATING",
    "INVERSION": "INVESTING", "FINANCIACION": "FINANCING",
}

# R-CF-8: la linea 8.d del EFE ("pagos por impuesto sobre beneficios") NO es un
# bucket: se deriva DENTRO de PAGOS_IMPUESTOS por las claves del mapa de la
# organizacion, para no hardcodear codigos (el motor nunca hardcodea codigos).
IS_ACCOUNT_KEYS = ("HP_ACREEDORA_IS", "HP_DEUDORA_IS")
IS_ACCOUNTS = {resolve_postable(KEY_TO_CODE[k]) for k in IS_ACCOUNT_KEYS}


def cf_bucket(code: str) -> tuple[str, str]:
    b = inherit(code, "cashflow_bucket")
    if not b:
        raise KeyError(f"cuenta {code} sin cashflow_bucket en el seed")
    return b, CF_BUCKET_CATEGORY[b]


# ---------------------------------------------------------------------------
# Cashflow indirecto: particion MECANICA de las cuentas no-57x en bloques.
# Por construccion, Sigma de todos los bloques = Delta 57x (I6-indirecto), porque
# cada asiento del universo esta cuadrado y toda cuenta no-57x cae en un bloque
# y solo en uno.
# ---------------------------------------------------------------------------

IND_TABLE: list[tuple[str, str]] = [
    ("129", "RESULTADO"),                # solo se mueve en REGULARIZATION/CLOSING (excluidos)
    ("28", "AJUSTES_NO_MONETARIOS"),     # amortizacion acumulada
    ("29", "AJUSTES_NO_MONETARIOS"),     # deterioro de inmovilizado
    ("39", "AJUSTES_NO_MONETARIOS"),     # deterioro de existencias
    ("49", "AJUSTES_NO_MONETARIOS"),     # deterioro de creditos comerciales
    ("59", "AJUSTES_NO_MONETARIOS"),     # deterioro de inversiones financieras
    ("14", "AJUSTES_NO_MONETARIOS"),     # provisiones a largo plazo
    ("529", "AJUSTES_NO_MONETARIOS"),    # provisiones a corto plazo
    ("30", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("31", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("32", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("33", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("34", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("35", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("36", "VAR_CIRCULANTE_EXISTENCIAS"),
    ("407", "VAR_CIRCULANTE_ACREEDORES"),
    ("40", "VAR_CIRCULANTE_ACREEDORES"),
    ("41", "VAR_CIRCULANTE_ACREEDORES"),
    ("438", "VAR_CIRCULANTE_ACREEDORES"),
    ("43", "VAR_CIRCULANTE_DEUDORES"),
    ("44", "VAR_CIRCULANTE_DEUDORES"),
    ("460", "VAR_CIRCULANTE_OTROS"),
    ("465", "VAR_CIRCULANTE_OTROS"),
    ("466", "VAR_CIRCULANTE_OTROS"),
    ("47", "VAR_CIRCULANTE_ADMIN_PUBLICAS"),
    ("476", "VAR_CIRCULANTE_ADMIN_PUBLICAS"),
    ("48", "VAR_CIRCULANTE_PERIODIFICACIONES"),
    ("55", "VAR_CIRCULANTE_OTROS"),
    ("20", "INVERSION"), ("21", "INVERSION"), ("22", "INVERSION"), ("23", "INVERSION"),
    ("24", "INVERSION"), ("25", "INVERSION"), ("26", "INVERSION"), ("27", "INVERSION"),
    ("53", "INVERSION"), ("54", "INVERSION"),
    ("10", "FINANCIACION"), ("11", "FINANCIACION"), ("12", "FINANCIACION"),
    ("13", "FINANCIACION"), ("15", "FINANCIACION"), ("16", "FINANCIACION"),
    ("17", "FINANCIACION"), ("18", "FINANCIACION"), ("19", "FINANCIACION"),
    ("50", "FINANCIACION"), ("51", "FINANCIACION"), ("52", "FINANCIACION"),
    ("56", "FINANCIACION"),
    ("6", "RESULTADO"), ("7", "RESULTADO"),
]

IND_BLOCK_ORDER = [
    "RESULTADO", "AJUSTES_NO_MONETARIOS",
    "VAR_CIRCULANTE_EXISTENCIAS", "VAR_CIRCULANTE_DEUDORES", "VAR_CIRCULANTE_ACREEDORES",
    "VAR_CIRCULANTE_ADMIN_PUBLICAS", "VAR_CIRCULANTE_PERIODIFICACIONES", "VAR_CIRCULANTE_OTROS",
    "INVERSION", "FINANCIACION",
]


def ind_block(code: str) -> str:
    for pref, block in sorted(IND_TABLE, key=lambda t: -len(t[0])):
        if code.startswith(pref):
            return block
    raise KeyError(f"cuenta {code} sin bloque de cashflow indirecto")


# ---------------------------------------------------------------------------
# Orden de presentacion de epigrafes
# ---------------------------------------------------------------------------

_ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8,
          "IX": 9, "X": 10, "XI": 11, "XII": 12}


def seg_key(seg: str) -> tuple[int, int, str]:
    """(familia, indice, texto). familia 0 = 'A)'/'A-1)'/'B)'..., 1 = romano, 2 = arabigo."""
    m = re.match(r"^([A-Z])(?:-(\d+))?\)", seg)
    if m:
        return (0, (ord(m.group(1)) - 64) * 100 + int(m.group(2) or 0), seg)
    m = re.match(r"^([IVX]+)\.", seg)
    if m and m.group(1) in _ROMAN:
        return (1, _ROMAN[m.group(1)], seg)
    m = re.match(r"^(\d+)\.", seg)
    if m:
        return (2, int(m.group(1)), seg)
    m = re.match(r"^([a-z])\)", seg)
    if m:
        return (3, ord(m.group(1)) - 96, seg)
    return (4, 0, seg)


def path_key(path: str) -> list[tuple[int, int, str]]:
    return [seg_key(s) for s in path.split(" / ")]


def rollup(by_leaf: dict[str, int]) -> list[dict[str, Any]]:
    """Arbol de epigrafes: cada prefijo con la suma de sus hojas, en orden oficial."""
    agg: dict[str, int] = defaultdict(int)
    for path, cents in by_leaf.items():
        segs = path.split(" / ")
        for i in range(1, len(segs) + 1):
            agg[" / ".join(segs[:i])] += cents
    return [{"path": p, "depth": p.count(" / ") + 1, "cents": agg[p],
             "isLeaf": p in by_leaf}
            for p in sorted(agg, key=path_key)]


# ---------------------------------------------------------------------------
# Lectura del diario
# ---------------------------------------------------------------------------


def read_lines(fx: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for e in fx["entries"]:
        for l in e["lines"]:
            raw = KEY_TO_CODE[l["accountKey"]] if "accountKey" in l else l["accountCode"]
            code = resolve_postable(raw)
            out.append({
                "fy": e["fiscalYearCode"], "kind": e["kind"], "ref": e["ref"],
                "date": e["date"], "month": e["date"][:7], "template": e.get("template"),
                "lineNo": l["lineNo"], "code": code,
                "amount": l["debitCents"] - l["creditCents"],   # deudor positivo
            })
    return out


def balances(lines: list[dict[str, Any]], fy: str, kinds_excluded: set[str]) -> dict[str, int]:
    b: dict[str, int] = defaultdict(int)
    for l in lines:
        if l["fy"] != fy or l["kind"] in kinds_excluded:
            continue
        b[l["code"]] += l["amount"]
    return {k: v for k, v in b.items()}


# ---------------------------------------------------------------------------
# 1. Balance de situacion
# ---------------------------------------------------------------------------


def build_balance(bal: dict[str, int], model: str, injected_result: int | None) -> dict[str, Any]:
    """`injected_result` != None => el ejercicio NO esta regularizado y el resultado
    (I3) se presenta en PN A-1) VII sin que exista saldo en 129 (R-B5)."""
    activo: dict[str, int] = defaultdict(int)
    pasivo: dict[str, int] = defaultdict(int)
    pn: dict[str, int] = defaultdict(int)
    reclass: list[dict[str, Any]] = []
    contra_anomalies: list[dict[str, Any]] = []
    accounts_detail: list[dict[str, Any]] = []

    for code in sorted(bal):
        saldo = bal[code]
        st = statement_of(code)
        if st not in ("BALANCE_ACTIVO", "BALANCE_PASIVO", "BALANCE_PN"):
            continue
        if saldo == 0:
            continue
        epi = epigraph_of(code, model)
        side = st
        value = saldo if st == "BALANCE_ACTIVO" else -saldo

        if is_bidirectional(code) and saldo < 0:
            epi = mirror_of(code, model)
            side = "BALANCE_PASIVO"
            value = -saldo
            reclass.append({"code": code, "saldoCents": saldo, "from": epigraph_of(code, model),
                            "to": epi, "side": side})

        # Check de signo: una contra-cuenta con el signo de su cuenta principal es anomala.
        if is_contra(code) and value > 0:
            contra_anomalies.append({"code": code, "cents": value, "epigraph": epi})

        target = {"BALANCE_ACTIVO": activo, "BALANCE_PASIVO": pasivo, "BALANCE_PN": pn}[side]
        target[epi] += value
        accounts_detail.append({"code": code, "name": SEED.get(code, {}).get("nombre", ""),
                                "saldoCents": saldo, "statement": st, "side": side,
                                "epigraph": epi, "presentedCents": value,
                                "isContra": is_contra(code), "isBidirectional": is_bidirectional(code)})

    if injected_result is not None and injected_result != 0:
        epi_129 = epigraph_of("129", model)
        pn[epi_129] += injected_result
        accounts_detail.append({"code": "129", "name": "Resultado del ejercicio (calculado, I3)",
                                "saldoCents": -injected_result, "statement": "BALANCE_PN",
                                "side": "BALANCE_PN", "epigraph": epi_129,
                                "presentedCents": injected_result, "isContra": False,
                                "isBidirectional": False, "synthetic": True})

    total_activo = sum(activo.values())
    total_pn = sum(pn.values())
    total_pasivo = sum(pasivo.values())
    return {
        "model": model,
        "activo": rollup(dict(activo)),
        "patrimonioNeto": rollup(dict(pn)),
        "pasivo": rollup(dict(pasivo)),
        "totalActivoCents": total_activo,
        "totalPatrimonioNetoCents": total_pn,
        "totalPasivoCents": total_pasivo,
        "totalPasivoYPatrimonioNetoCents": total_pn + total_pasivo,
        "i2DiffCents": total_activo - (total_pn + total_pasivo),
        "reclasificacionesBidireccionales": reclass,
        "contraSignAnomalies": contra_anomalies,
        "accountDetail": sorted(accounts_detail, key=lambda a: a["code"]),
    }


# ---------------------------------------------------------------------------
# 2. PyG contable
# ---------------------------------------------------------------------------

PYG_SUBTOTALS = {
    "NORMAL": {"A.1) RESULTADO DE EXPLOTACION": list(range(1, 14)),
               "A.2) RESULTADO FINANCIERO": list(range(14, 20)),
               "A.3) RESULTADO ANTES DE IMPUESTOS": list(range(1, 20)),
               "A.4) RESULTADO DEL EJERCICIO": list(range(1, 21))},
    "PYMES": {"A.1) RESULTADO DE EXPLOTACION": list(range(1, 13)),
              "A.2) RESULTADO FINANCIERO": list(range(13, 19)),
              "A.3) RESULTADO ANTES DE IMPUESTOS": list(range(1, 19)),
              "A.4) RESULTADO DEL EJERCICIO": list(range(1, 20))},
}


def build_pyg(lines: list[dict[str, Any]], model: str) -> dict[str, Any]:
    by_leaf: dict[str, int] = defaultdict(int)
    by_number: dict[int, int] = defaultdict(int)
    detail: list[dict[str, Any]] = []
    total = 0
    for l in lines:
        if l["fy"] != FISCAL_YEAR or l["kind"] in PYG_EXCLUDED_KINDS:
            continue
        code = l["code"]
        if statement_of(code) != "PYG":
            continue
        aporte = -l["amount"]          # credit - debit
        epi = epigraph_of(code, model)
        by_leaf[epi] += aporte
        by_number[int(epi.split(".")[0])] += aporte
        total += aporte
        detail.append({"ref": l["ref"], "lineNo": l["lineNo"], "code": code,
                       "epigraph": epi, "cents": aporte})

    subs = {name: sum(by_number.get(n, 0) for n in nums)
            for name, nums in PYG_SUBTOTALS[model].items()}
    return {
        "model": model,
        "skeleton": [{"n": n, "name": nm, "cents": by_number.get(n, 0)}
                     for n, nm in PYG_SKELETON[model]],
        "lines": rollup(dict(by_leaf)),
        "byEpigraphNumberCents": {str(n): by_number[n] for n in sorted(by_number)},
        "subtotalsCents": subs,
        "resultadoDelEjercicioCents": total,
        "lineCount": len(detail),
    }


# ---------------------------------------------------------------------------
# 3. Cashflow
# ---------------------------------------------------------------------------


def build_cashflow(lines: list[dict[str, Any]], fy: str) -> dict[str, Any]:
    # Saldo inicial y final de 57x
    opening = sum(l["amount"] for l in lines
                  if l["fy"] == fy and l["kind"] == "OPENING" and l["code"].startswith(CASH_PREFIX))
    flow_lines = [l for l in lines if l["fy"] == fy and l["kind"] not in CF_EXCLUDED_KINDS]
    delta_cash = sum(l["amount"] for l in flow_lines if l["code"].startswith(CASH_PREFIX))
    closing = opening + delta_cash

    # --- DIRECTO: por asiento con al menos una linea 57x; la contribucion de cada
    # linea NO-57x es -amount, asignada a su bloque. Regla POR LINEA, exacta: la
    # suma de las contribuciones de un asiento es exactamente su Delta 57x, asi que
    # no hace falta ningun reparto proporcional (R-CF-3).
    by_entry: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for l in flow_lines:
        by_entry[l["ref"]].append(l)

    monthly: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    annual: dict[str, int] = defaultdict(int)
    directo_detail: list[dict[str, Any]] = []
    internal_transfers: list[str] = []

    for ref, ls in by_entry.items():
        cash = [l for l in ls if l["code"].startswith(CASH_PREFIX)]
        if not cash:
            continue
        d = sum(l["amount"] for l in cash)
        others = [l for l in ls if not l["code"].startswith(CASH_PREFIX)]
        if not others:
            internal_transfers.append(ref)   # traspaso 57x -> 57x, Delta = 0, no es flujo
            assert d == 0, f"{ref}: asiento solo de 57x con Delta != 0"
            continue
        month = ls[0]["month"]
        # R-CF-7: en un asiento que mezcla tesoreria con una contrapartida comercial
        # y SUS cuentas de IVA (472/477) —tipicamente el anticipo de cliente o de
        # proveedor, que devenga el IVA en el mismo asiento del cobro/pago—, las
        # lineas de IVA siguen al bloque comercial. El EFE mide cobros y pagos
        # BRUTOS: los 42.000 c de IVA de un anticipo de 242.000 c son parte del
        # cobro al cliente, no una devolucion de Hacienda.
        commercial = {cf_bucket(l["code"])[0] for l in others
                      if cf_bucket(l["code"])[0] in ("COBROS_CLIENTES", "PAGOS_PROVEEDORES")}
        vat_target = next(iter(commercial)) if len(commercial) == 1 else None
        for l in others:
            bucket, cat = cf_bucket(l["code"])
            if vat_target and l["code"].startswith(("472", "477")):
                bucket, cat = vat_target, "OPERATING"
            contrib = -l["amount"]
            monthly[month][bucket] += contrib
            annual[bucket] += contrib
            directo_detail.append({"ref": ref, "month": month, "lineNo": l["lineNo"],
                                   "code": l["code"], "bucket": bucket, "category": cat,
                                   "cents": contrib})

    months = sorted(monthly)
    directo = {
        "openingCashCents": opening,
        "closingCashCents": closing,
        "deltaCashCents": delta_cash,
        "buckets": CF_BUCKET_ORDER,
        "bucketCategory": {b: CF_BUCKET_CATEGORY[b] for b in CF_BUCKET_ORDER},
        "annualCents": {b: annual.get(b, 0) for b in CF_BUCKET_ORDER},
        "byCategoryCents": {
            cat: sum(annual.get(b, 0) for b in CF_BUCKET_ORDER if CF_BUCKET_CATEGORY[b] == cat)
            for cat in ("OPERATING", "INVESTING", "FINANCING")},
        "monthlyCents": {m: {b: monthly[m].get(b, 0) for b in CF_BUCKET_ORDER if monthly[m].get(b, 0)}
                         for m in months},
        "monthlyTotalCents": {m: sum(monthly[m].values()) for m in months},
        "monthlyRunningCashCents": {},
        # R-CF-8: linea 8.d del EFE, derivada DENTRO de PAGOS_IMPUESTOS por las
        # claves HP_ACREEDORA_IS / HP_DEUDORA_IS del mapa de la organizacion.
        "efeImpuestoBeneficiosCents": sum(d["cents"] for d in directo_detail
                                          if d["code"] in IS_ACCOUNTS),
        "efeOtrosImpuestosCents": sum(d["cents"] for d in directo_detail
                                      if d["bucket"] == "PAGOS_IMPUESTOS"
                                      and d["code"] not in IS_ACCOUNTS),
        "internalTransfers": sorted(internal_transfers),
        "totalFlowsCents": sum(annual.values()),
        "lineDetail": sorted(directo_detail, key=lambda x: (x["month"], x["ref"], x["lineNo"])),
    }
    run = opening
    for m in months:
        run += directo["monthlyTotalCents"][m]
        directo["monthlyRunningCashCents"][m] = run

    # --- INDIRECTO: particion mecanica de TODAS las cuentas no-57x del universo.
    blocks: dict[str, int] = defaultdict(int)
    block_accounts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for l in flow_lines:
        if l["code"].startswith(CASH_PREFIX):
            continue
        blk = ind_block(l["code"])
        blocks[blk] += -l["amount"]
        block_accounts[blk][l["code"]] += -l["amount"]

    indirecto = {
        "blocks": IND_BLOCK_ORDER,
        "blockCents": {b: blocks.get(b, 0) for b in IND_BLOCK_ORDER},
        "blockAccountCents": {b: dict(sorted(block_accounts[b].items()))
                              for b in IND_BLOCK_ORDER if block_accounts[b]},
        "totalCents": sum(blocks.values()),
        "openingCashCents": opening,
        "closingCashCents": closing,
        "deltaCashCents": delta_cash,
        # R-CF-6: asientos SIN ninguna linea 57x que mueven inversion o financiacion.
        # Son las "operaciones que no han supuesto flujos de efectivo" de la memoria:
        # explican por que el indirecto reparte importes que el directo nunca ve.
        "nonCashEntries": sorted(
            {l["ref"] for l in flow_lines
             if not l["code"].startswith(CASH_PREFIX)
             and ind_block(l["code"]) in ("INVERSION", "FINANCIACION")}
            - {l["ref"] for l in flow_lines if l["code"].startswith(CASH_PREFIX)}),
    }
    return {"directo": directo, "indirecto": indirecto}


# ---------------------------------------------------------------------------
# 5. Umbrales de revision propuestos
# ---------------------------------------------------------------------------

REVIEW_THRESHOLDS = {
    "_doc": ("Organization.reviewThresholds. Variacion del KPI respecto al periodo "
             "comparativo (mismo periodo del ejercicio anterior por defecto). "
             "`pctBps` en puntos basicos sobre el valor comparativo; `minAbsCents` "
             "es el suelo de materialidad: por debajo NUNCA se dispara revision, "
             "por muy grande que sea el porcentaje. Se dispara si |var| supera AMBOS."),
    "comparativeBasis": "SAME_PERIOD_PREVIOUS_YEAR",
    "kpis": {
        "ingresos":   {"pctBps": 1500, "minAbsCents": 500000,
                       "why": "INCN (epigrafe 1). 15% mes a mes es ruido comercial normal en PYME de proyectos; por encima suele ser un hito facturado o una factura duplicada"},
        "ebitda":     {"pctBps": 2500, "minAbsCents": 300000,
                       "why": "A.1 + amortizacion (epigrafe 8). Mas volatil que ingresos por el efecto de los costes fijos: 25%"},
        "resultado":  {"pctBps": 3000, "minAbsCents": 300000,
                       "why": "A.4. Apalancado sobre EBITDA; ademas el IS solo aparece en el cierre"},
        "tesoreria":  {"pctBps": 2000, "minAbsCents": 1000000,
                       "why": "Saldo final 57x. Un cobro grande a fin de mes desplaza el saldo sin significar nada; suelo alto"},
        "deuda":      {"pctBps": 1000, "minAbsCents": 500000,
                       "why": "17x + 52x + 40x + 41x. La deuda se mueve por contrato, no por ruido: umbral estrecho"},
        "dso":        {"pctBps": 2000, "minAbsCents": 0, "unit": "DAYS", "minAbsDays": 10,
                       "why": "430/INCN x 365. Sensible al mix; 10 dias de suelo"},
        "margenBruto": {"pctBps": 500, "minAbsCents": 0, "unit": "BPS_OF_REVENUE", "minAbsBps": 300,
                        "why": "MC1%. Se compara en PUNTOS de margen, no en % de variacion: 3 puntos"},
    },
    "explainableVariations": [
        {"id": "EV-1", "when": "El periodo comparado contiene un asiento kind=OPENING",
         "rule": "Se excluyen del comparativo los kinds OPENING/CLOSING/REGULARIZATION en TODO KPI de flujo (PyG, cashflow). Nunca dispara revision"},
        {"id": "EV-2", "when": "Primer periodo del ejercicio frente al ultimo del anterior",
         "rule": "La caida de resultado a cero en enero es estructural (el resultado se acumula por ejercicio). Los KPIs de PyG se comparan YoY del mismo mes, nunca contra el mes anterior de otro ejercicio"},
        {"id": "EV-3", "when": "El periodo contiene el asiento de impuesto sobre beneficios (T-25) o la regularizacion",
         "rule": "La variacion de `resultado` atribuible al epigrafe 20/19 y a kind=REGULARIZATION se descuenta antes de aplicar el umbral"},
        {"id": "EV-4", "when": "Liquidacion trimestral de IVA/IRPF (meses 4, 7, 10 y 1)",
         "rule": "El pico de `PAGOS_IMPUESTOS` en el cashflow de esos meses es esperado: umbral aplicado sobre la media de los cuatro trimestres, no mes a mes"},
        {"id": "EV-5", "when": "Un contra-asiento (kind=REVERSAL) y su original caen en el mismo periodo",
         "rule": "Se netean antes de calcular la variacion; el par no genera revision"},
        {"id": "EV-6", "when": "Alta o baja de un proyecto o de un CECO en el periodo",
         "rule": "Los KPIs por dimension se comparan solo sobre dimensiones vivas en ambos periodos; las nuevas se listan aparte como 'altas', no como variacion"},
        {"id": "EV-7", "when": "Cambio de `AllocationRun` o de `MarginLevelConfig` (analyticsHash distinto)",
         "rule": "SI dispara REQUIERE_REVISION, siempre, con motivo 'cambio de configuracion analitica'. No es una variacion explicable: es una redefinicion de la metrica"},
        {"id": "EV-8", "when": "Cambio de git-sha del motor (`ReportRun.gitSha` distinto del run comparado)",
         "rule": "SI dispara REQUIERE_REVISION en el primer run tras el cambio (SPEC-FIABILIDAD, sello)"},
    ],
}


# ---------------------------------------------------------------------------
# Invariantes
# ---------------------------------------------------------------------------


PYG_SKELETON = {
    "NORMAL": [
        (1, "Importe neto de la cifra de negocios"),
        (2, "Variación de existencias de productos terminados y en curso de fabricación"),
        (3, "Trabajos realizados por la empresa para su activo"),
        (4, "Aprovisionamientos"),
        (5, "Otros ingresos de explotación"),
        (6, "Gastos de personal"),
        (7, "Otros gastos de explotación"),
        (8, "Amortización del inmovilizado"),
        (9, "Imputación de subvenciones de inmovilizado no financiero y otras"),
        (10, "Excesos de provisiones"),
        (11, "Deterioro y resultado por enajenaciones del inmovilizado"),
        (12, "Diferencia negativa de combinaciones de negocio"),
        (13, "Otros resultados"),
        (14, "Ingresos financieros"),
        (15, "Gastos financieros"),
        (16, "Variación de valor razonable en instrumentos financieros"),
        (17, "Diferencias de cambio"),
        (18, "Deterioro y resultado por enajenaciones de instrumentos financieros"),
        (19, "Otros ingresos y gastos de carácter financiero"),
        (20, "Impuestos sobre beneficios"),
    ],
    "PYMES": [
        (1, "Importe neto de la cifra de negocios"),
        (2, "Variación de existencias de productos terminados y en curso de fabricación"),
        (3, "Trabajos realizados por la empresa para su activo"),
        (4, "Aprovisionamientos"),
        (5, "Otros ingresos de explotación"),
        (6, "Gastos de personal"),
        (7, "Otros gastos de explotación"),
        (8, "Amortización del inmovilizado"),
        (9, "Imputación de subvenciones de inmovilizado no financiero y otras"),
        (10, "Excesos de provisiones"),
        (11, "Deterioro y resultado por enajenaciones del inmovilizado"),
        (12, "Otros resultados"),
        (13, "Ingresos financieros"),
        (14, "Gastos financieros"),
        (15, "Variación de valor razonable en instrumentos financieros"),
        (16, "Diferencias de cambio"),
        (17, "Deterioro y resultado por enajenaciones de instrumentos financieros"),
        (18, "Otros ingresos y gastos de carácter financiero"),
        (19, "Impuestos sobre beneficios"),
    ],
}


def bidirectional_scenarios() -> list[dict[str, Any]]:
    """R-B4 explicito. Ninguna de las 7 cuentas bidireccionales se mueve en el
    fixture, asi que la regla se documenta y se testea con esta tabla sintetica:
    para cada cuenta, el epigrafe destino con saldo deudor (+100.000) y con saldo
    acreedor (-100.000). Es la entrada del test I-E6-5b."""
    out = []
    for code in sorted(BIDIRECTIONAL_MIRROR):
        row: dict[str, Any] = {"code": code, "name": SEED[code]["nombre"],
                               "seedStatement": SEED[code]["estado_financiero"]}
        for model in ("NORMAL", "PYMES"):
            row[model] = {
                "saldoDeudor": {"saldoCents": 100000, "side": "BALANCE_ACTIVO",
                                "epigraph": epigraph_of(code, model), "presentedCents": 100000},
                "saldoAcreedor": {"saldoCents": -100000, "side": "BALANCE_PASIVO",
                                  "epigraph": mirror_of(code, model), "presentedCents": 100000},
                "saldoCero": {"saldoCents": 0, "side": None, "epigraph": None,
                              "presentedCents": 0, "nota": "saldo 0 no se presenta en ningun lado"},
            }
        out.append(row)
    return out


def check(cid: str, ok: bool, expected: Any, actual: Any, evidencia: str) -> dict[str, Any]:
    return {"id": cid, "status": "PASS" if ok else "FAIL",
            "expected": expected, "actual": actual, "evidencia": evidencia}


def build() -> dict[str, Any]:
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    lines = read_lines(fx)
    exp = fx["expected"]

    # --- Fotos de balance
    bal_pre = balances(lines, FISCAL_YEAR, {"REGULARIZATION", "CLOSING"})
    bal_post = balances(lines, FISCAL_YEAR, {"CLOSING"})
    bal_cierre = balances(lines, FISCAL_YEAR, set())
    bal_ap27 = balances(lines, NEXT_FISCAL_YEAR, set())

    # --- PyG (I3)
    pyg_normal = build_pyg(lines, "NORMAL")
    pyg_pymes = build_pyg(lines, "PYMES")
    i3 = pyg_normal["resultadoDelEjercicioCents"]

    snapshots: dict[str, Any] = {}
    for name, bal, inject in (
        ("PRE_REGULARIZACION", bal_pre, i3),
        ("POST_REGULARIZACION", bal_post, None),
        ("POST_CIERRE", bal_cierre, None),
        ("APERTURA_2027", bal_ap27, None),
    ):
        snapshots[name] = {
            "descripcion": {
                "PRE_REGULARIZACION": "31/12/2026 con el diario tal cual: 129 = 0 y el resultado (I3) inyectado en PN A-1) VII (R-B5). Es el balance que ve el usuario durante el ejercicio.",
                "POST_REGULARIZACION": "31/12/2026 tras T-26 (7xx->129, 129->6xx) y ANTES del asiento de cierre. Es el BALANCE FORMULADO: 129 lleva el saldo acreedor del resultado.",
                "POST_CIERRE": "31/12/2026 tras el asiento de cierre: todas las cuentas de balance a cero.",
                "APERTURA_2027": "01/01/2027 tras el asiento de apertura: reproduce EXACTAMENTE POST_REGULARIZACION, 129 incluida. El resultado sigue pendiente de aplicacion hasta el acuerdo de distribucion (T-28), que lo reclasifica a 120/121 y no forma parte del asiento de apertura.",
            }[name],
            "NORMAL": build_balance(bal, "NORMAL", inject),
            "PYMES": build_balance(bal, "PYMES", inject),
            "saldosPorCuentaCents": {k: v for k, v in sorted(bal.items()) if v},
        }

    cashflow = build_cashflow(lines, FISCAL_YEAR)

    # ---------------------------------------------------------------- checks
    checks: list[dict[str, Any]] = []

    # I2 en las cuatro fotos y los dos modelos
    for name, snap in snapshots.items():
        for model in ("NORMAL", "PYMES"):
            d = snap[model]["i2DiffCents"]
            checks.append(check(f"I2[{name}/{model}]", d == 0, 0, d,
                                "Total activo - (PN + pasivo) = 0"))

    # I3
    checks.append(check("I3", i3 == exp["resultadoAntesRegularizacionCents"],
                        exp["resultadoAntesRegularizacionCents"], i3,
                        "PyG = Sigma(haber-debe) de 6/7 con kind not in {REGULARIZATION,CLOSING,OPENING}"))
    checks.append(check("I3[=129]", -bal_post.get("129", 0) == i3, i3, -bal_post.get("129", 0),
                        "tras la regularizacion, saldo acreedor de 129 = PyG"))
    checks.append(check("I3[PYMES=NORMAL]",
                        pyg_pymes["resultadoDelEjercicioCents"] == i3, i3,
                        pyg_pymes["resultadoDelEjercicioCents"],
                        "el resultado no depende del modelo de presentacion"))
    bai = pyg_normal["subtotalsCents"]["A.3) RESULTADO ANTES DE IMPUESTOS"]
    checks.append(check("I-E6-3[BAI]", bai == exp["resultadoAntesImpuestoCents"],
                        exp["resultadoAntesImpuestoCents"], bai,
                        "A.3 = BAI declarado por el fixture (coherente con E4)"))
    a4 = pyg_normal["subtotalsCents"]["A.4) RESULTADO DEL EJERCICIO"]
    checks.append(check("I-E6-4[A.4]", a4 == i3, i3, a4, "A.4 = resultado = I3"))
    checks.append(check("I-E6-4[PYMES A.3]",
                        pyg_pymes["subtotalsCents"]["A.3) RESULTADO ANTES DE IMPUESTOS"] == bai,
                        bai, pyg_pymes["subtotalsCents"]["A.3) RESULTADO ANTES DE IMPUESTOS"],
                        "BAI identico en los dos modelos"))

    # I6 directo
    d = cashflow["directo"]
    checks.append(check("I6[directo]",
                        d["openingCashCents"] + d["totalFlowsCents"] == d["closingCashCents"],
                        d["closingCashCents"], d["openingCashCents"] + d["totalFlowsCents"],
                        "saldo inicial 57x + Sigma flujos = saldo final 57x"))
    # I6 indirecto
    i = cashflow["indirecto"]
    checks.append(check("I6[indirecto]", i["totalCents"] == i["deltaCashCents"],
                        i["deltaCashCents"], i["totalCents"],
                        "Sigma bloques del indirecto = Delta 57x"))
    checks.append(check("I6[directo=indirecto]", d["totalFlowsCents"] == i["totalCents"],
                        d["totalFlowsCents"], i["totalCents"],
                        "los dos metodos dan la misma variacion"))
    # I6 mensual
    last = list(d["monthlyRunningCashCents"].values())[-1]
    checks.append(check("I-E6-6[cashflow mensual]", last == d["closingCashCents"],
                        d["closingCashCents"], last,
                        "saldo inicial + Sigma de los 12 meses = saldo final"))
    # RESULTADO del indirecto = I3
    checks.append(check("I-E6-7[indirecto/RESULTADO]",
                        i["blockCents"]["RESULTADO"] == i3, i3, i["blockCents"]["RESULTADO"],
                        "el bloque RESULTADO del indirecto es exactamente la PyG (I3)"))

    # I-E6-1: los dos modelos cuadran al mismo total
    for name, snap in snapshots.items():
        a_n, a_p = snap["NORMAL"]["totalActivoCents"], snap["PYMES"]["totalActivoCents"]
        checks.append(check(f"I-E6-1[{name}]", a_n == a_p, a_n, a_p,
                            "total activo identico en modelo NORMAL y PYMES"))

    # I-E6-2: Sigma epigrafes = Sigma saldos de las cuentas de balance
    for name, snap in snapshots.items():
        for model in ("NORMAL", "PYMES"):
            b = snap[model]
            suma_epi = b["totalActivoCents"] - b["totalPatrimonioNetoCents"] - b["totalPasivoCents"]
            checks.append(check(f"I-E6-2[{name}/{model}]", suma_epi == 0, 0, suma_epi,
                                "ninguna cuenta con saldo queda fuera de un epigrafe"))

    # I-E6-5: ninguna bidireccional en los dos lados
    for name, snap in snapshots.items():
        for model in ("NORMAL", "PYMES"):
            codes = [a["code"] for a in snap[model]["accountDetail"] if a["isBidirectional"]]
            checks.append(check(f"I-E6-5[{name}/{model}]", len(codes) == len(set(codes)),
                                len(set(codes)), len(codes),
                                "una cuenta bidireccional aparece en un solo lado del balance"))

    # I-E6-8: POST_CIERRE deja el balance a cero
    nz = {k: v for k, v in bal_cierre.items() if v and statement_of(k) != "PYG"}
    checks.append(check("I-E6-8[cierre]", not nz, {}, nz,
                        "tras el asiento de cierre no queda saldo en ninguna cuenta de balance"))

    # I-E6-9: apertura 2027 = balance formulado 2026, 129 INCLUIDA
    esperado_ap = {k: v for k, v in bal_post.items() if v}
    real_ap = {k: v for k, v in bal_ap27.items() if v}
    diff_ap = {k: (esperado_ap.get(k, 0), real_ap.get(k, 0))
               for k in set(esperado_ap) | set(real_ap)
               if esperado_ap.get(k, 0) != real_ap.get(k, 0)}
    checks.append(check("I-E6-9[apertura]", not diff_ap, {}, diff_ap,
                        "la apertura del ejercicio siguiente reproduce el balance formulado, "
                        "129 INCLUIDA: el resultado sigue pendiente de aplicacion hasta el "
                        "acuerdo de distribucion (T-28), que es el que lo lleva a 120/121"))

    # I-E6-13: regularizacion no desfasada. Si 129 tiene saldo, DEBE ser I3; si hay
    # lineas 6/7 posteriores a la REGULARIZATION la igualdad falla y es FAIL, no WARN.
    s129 = bal_post.get("129", 0)
    checks.append(check("I-E6-13[regularizacion]", s129 == 0 or -s129 == i3, i3, -s129,
                        "saldo(129) != 0 => I3 = -saldo(129). Un FAIL significa lineas 6/7 "
                        "posteriores a la regularizacion: sello REQUIERE_REVISION con motivo "
                        "REGULARIZACION_DESFASADA y las dos cifras a la vista"))

    # I-E6-11: R-B5 es neutra — pre y post regularizacion dan el mismo balance
    for model in ("NORMAL", "PYMES"):
        pre, post = snapshots["PRE_REGULARIZACION"][model], snapshots["POST_REGULARIZACION"][model]
        same = (pre["totalActivoCents"] == post["totalActivoCents"]
                and pre["totalPatrimonioNetoCents"] == post["totalPatrimonioNetoCents"]
                and pre["totalPasivoCents"] == post["totalPasivoCents"])
        checks.append(check(f"I-E6-11[{model}]", same,
                            [post["totalActivoCents"], post["totalPatrimonioNetoCents"],
                             post["totalPasivoCents"]],
                            [pre["totalActivoCents"], pre["totalPatrimonioNetoCents"],
                             pre["totalPasivoCents"]],
                            "la regularizacion no altera el balance: R-B5 solo cambia de donde "
                            "se lee el resultado"))

    # I-E6-12: 472/477 con signo contrario al natural a fecha de balance -> WARN
    warn_iva = {c: bal_post.get(c, 0) for c in ("472", "477")
                if (c == "472" and bal_post.get(c, 0) < 0) or (c == "477" and bal_post.get(c, 0) > 0)}
    checks.append(check("I-E6-12[iva]", not warn_iva, {}, warn_iva,
                        "472 nunca acreedora ni 477 deudora a fecha de balance (R-B6); si lo "
                        "fueran seria WARN de calidad de datos, no una reclasificacion"))

    # I-E6-10: contra-cuentas con signo coherente
    anomalies = {f"{n}/{m}": snapshots[n][m]["contraSignAnomalies"]
                 for n in snapshots for m in ("NORMAL", "PYMES")
                 if snapshots[n][m]["contraSignAnomalies"]}
    checks.append(check("I-E6-10[contra]", not anomalies, {}, anomalies,
                        "toda cuenta is_contra presenta importe negativo en su epigrafe"))

    # Cotejo con las cifras selladas del fixture
    for code, expected_cents in exp["balancesBeforeClosingCents"].items():
        actual = bal_post.get(code, 0)
        if actual != expected_cents:
            checks.append(check(f"FIXTURE[{code}]", False, expected_cents, actual,
                                "saldo antes del cierre coincide con expected del fixture"))
    checks.append(check("FIXTURE[balancesBeforeClosing]",
                        all(bal_post.get(c, 0) == v for c, v in exp["balancesBeforeClosingCents"].items()),
                        True, True, "todos los saldos sellados del fixture reproducidos"))

    result: dict[str, Any] = {
        "schemaVersion": "1.0",
        "generatedBy": "docs/design/fixtures/build_estados_esperados.py",
        "note": ("Estados financieros esperados del fixture tests/fixtures/ejercicio-completo.json. "
                 "Centimos enteros. Balance: activo con saldo deudor en positivo, pasivo y PN con "
                 "saldo acreedor en positivo; las contra-cuentas restan solas por el signo de su "
                 "saldo. PyG: aporte = haber - debe. Cashflow: signo = efecto sobre la tesoreria "
                 "(cobro +, pago -). Ver docs/design/E6-validacion-estados.md."),
        "source": {"fixture": "tests/fixtures/ejercicio-completo.json",
                   "seed": "seeds/npgc.csv", "variant": VARIANT,
                   "fiscalYear": FISCAL_YEAR,
                   "pygExcludedKinds": sorted(PYG_EXCLUDED_KINDS),
                   "cashflowExcludedKinds": sorted(CF_EXCLUDED_KINDS)},
        "rules": {
            "R-B1": "saldo(cuenta) = Sigma debit - Sigma credit (positivo = deudor).",
            "R-B2": "Presentacion: BALANCE_ACTIVO -> +saldo; BALANCE_PASIVO/BALANCE_PN -> -saldo.",
            "R-B3": "isContra no interviene en el calculo: con R-B2 la contra-cuenta ya resta. Es presentacion (marca '(-)') y check de signo (I-E6-10).",
            "R-B4": "bidirectional: si saldo >= 0 se presenta en su epigrafe de activo; si saldo < 0 se reclasifica al epigrafe espejo de pasivo (tabla bidirectionalMirror) por -saldo. Nunca en los dos lados (I-E6-5).",
            "R-B5": "Si el ejercicio no esta regularizado (129 = 0), el resultado del periodo (I3) se inyecta en PN A-1) VII. Si lo esta, se lee de 129. Nunca las dos cosas: si 129 != 0, no se inyecta.",
            "R-B6": "472/477 no son bidireccionales: el motor las liquida contra 4700/4750 cada trimestre (T-24). Un saldo acreedor en 472 o deudor en 477 a fecha de balance es una ANOMALIA (WARN de Auditoria), no una reclasificacion.",
            "R-CF-1": "Tesoreria = cuentas con prefijo 57. Saldo inicial = lineas 57x del asiento OPENING del ejercicio.",
            "R-CF-2": "Universo de flujos = asientos del ejercicio con kind not in {OPENING, CLOSING, REGULARIZATION}.",
            "R-CF-3": "Metodo directo, regla POR LINEA (no proporcional): para cada asiento con al menos una linea 57x, cada linea NO-57x aporta -(debit-credit) a su bloque. Como el asiento esta cuadrado, la suma de aportes es exactamente el Delta 57x del asiento, asi que el reparto proporcional es innecesario y se rechaza por perder trazabilidad linea a linea.",
            "R-CF-4": "Asiento cuyas unicas lineas son 57x (traspaso interno): Delta = 0, se excluye del cashflow y se lista en internalTransfers.",
            "R-CF-5": "Metodo indirecto: particion mecanica y EXHAUSTIVA de las cuentas no-57x en bloques (tabla indirectBlocks). Cada cuenta cae en un bloque y solo en uno, con lo que Sigma bloques = Delta 57x por construccion y con tolerancia 0.",
            "R-CF-7": "En un asiento que tiene tesoreria, una contrapartida comercial (43x/40x/41x/438/407) y las cuentas de IVA de esa misma operacion (472/477), las lineas de IVA se asignan al bloque comercial y no a PAGOS_IMPUESTOS: el EFE mide cobros y pagos BRUTOS. Aplica solo si el asiento tiene exactamente UN bloque comercial; con varios, el IVA queda en PAGOS_IMPUESTOS y la Auditoria lo lista como WARN.",
            "R-CF-6": "Los asientos sin ninguna linea 57x que tocan bloques de inversion o financiacion son 'operaciones que no han supuesto flujos de efectivo' (EFE, nota de la memoria): se listan en indirecto.nonCashEntries y explican por que el indirecto reparte importes que el directo no ve.",
        },
        "bidirectionalMirror": BIDIRECTIONAL_MIRROR,
        "bidirectionalScenarios": bidirectional_scenarios(),
        "cashflowAccountMap": {
            "source": "seeds/npgc.csv columna cashflow_bucket (anadida en E6)",
            "buckets": {b: CF_BUCKET_CATEGORY[b] for b in CF_BUCKET_ORDER},
            "impuestoBeneficiosAccountKeys": list(IS_ACCOUNT_KEYS),
            "accountsUsed": {c: cf_bucket(c)[0] for c in sorted(
                {l["code"] for l in lines if not l["code"].startswith(CASH_PREFIX)})},
        },
        "indirectBlocks": [{"prefix": p, "block": b} for p, b in IND_TABLE],
        "pygSubtotals": PYG_SUBTOTALS,
        "balance": snapshots,
        "pyg": {"NORMAL": pyg_normal, "PYMES": pyg_pymes},
        "cashflow": cashflow,
        "lossScenario": {
            "nota": ("Caso limite SINTETICO (no sale del fixture, que cierra en beneficio): "
                     "129 con perdidas. Se documenta porque es el caso que rompe la mayoria "
                     "de renderizadores de balance."),
            "regla": ("Con I3 < 0 el saldo de 129 es DEUDOR. R-B2 lo presenta como "
                      "-saldo, es decir NEGATIVO, dentro de PN A-1) VII. NO se reclasifica al "
                      "activo, NO se cambia de signo y NO se lleva a 121: 129 no es "
                      "bidireccional y 121 solo recibe el resultado por el asiento de "
                      "distribucion del ejercicio SIGUIENTE (T-28). El patrimonio neto puede "
                      "quedar negativo y el balance sigue cuadrando (I2 = 0)."),
            "ejemplo": {"i3Cents": -1497322,
                        "saldo129Cents": 1497322,
                        "epigrafeNormal": epigraph_of("129", "NORMAL"),
                        "presentedCents": -1497322,
                        "impuestoBeneficios": ("con BAI < 0 el epigrafe 20/19 puede ser POSITIVO "
                                               "(ingreso por credito fiscal, 4745/6301) o cero si "
                                               "no se activa el credito: parametrizable, nunca "
                                               "asumido por el motor")},
        },
        "reviewThresholds": REVIEW_THRESHOLDS,
        "keyFiguresCents": {
            "totalActivo": snapshots["POST_REGULARIZACION"]["NORMAL"]["totalActivoCents"],
            "patrimonioNeto": snapshots["POST_REGULARIZACION"]["NORMAL"]["totalPatrimonioNetoCents"],
            "pasivoCorriente": snapshots["POST_REGULARIZACION"]["NORMAL"]["totalPasivoCents"],
            "resultadoDelEjercicio": i3,
            "resultadoAntesImpuestos": bai,
            "ebitda": (pyg_normal["subtotalsCents"]["A.1) RESULTADO DE EXPLOTACION"]
                       - pyg_normal["byEpigraphNumberCents"].get("8", 0)
                       - pyg_normal["byEpigraphNumberCents"].get("11", 0)),
            "impuestoBeneficios": pyg_normal["byEpigraphNumberCents"].get("20", 0),
            "tesoreriaInicial": cashflow["directo"]["openingCashCents"],
            "tesoreriaFinal": cashflow["directo"]["closingCashCents"],
            "variacionTesoreria": cashflow["directo"]["deltaCashCents"],
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
        print("OK: estados-esperados.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    k = data["keyFiguresCents"]
    for name, v in k.items():
        print(f"  {name:26} {v:>14,}")
    print(f"  checks: {len(data['checks'])} PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
