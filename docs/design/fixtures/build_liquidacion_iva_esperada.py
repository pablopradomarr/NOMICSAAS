#!/usr/bin/env python3
"""
E9 - Generador de la LIQUIDACION DE IVA esperada (T8).

    python3 docs/design/fixtures/build_liquidacion_iva_esperada.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), lo que la
liquidacion de IVA, la prorrata, el RECC, la importacion y el mapa del 303 deben
dar segun `docs/design/E9-cierre-recurrentes.md` §4.4 (R-IVA-8..R-IVA-20) y
ADR-0016 D4/D8/D12, con las observaciones O-9..O-16 y O-27 de la validacion
contable:

    L1  trimestral 2026-Q4 en regimen general: dos tipos, ISP, AIB, IVA no
        deducible del art. 96, bien de inversion y rectificativa de venta y de
        compra. Cadena completa 27 -> 45 -> 46 -> 64 -> 66 -> 69 -> 71 (O-13)
    L2  mensual 2026-12 con DIFERIMIENTO del IVA a la importacion (O-16): el DUA
        SI devenga 477, casillas 32-33 y 77, y la liquidacion no cambia
    L3  ultimo periodo del ano con el ajuste de PRORRATA DEFINITIVA en la
        casilla 44 y cuota a compensar en la 67 (O-9, O-11)
    L4  organizacion en RECC (O-14, O-15): el libro anota la factura integra y
        477 solo recoge lo cobrado. 15a'/15c' PASAN donde 15a/15c FALLABAN

    P1  prorrata definitiva 8.700 bps y ajuste +7.000 sobre cuota prorrateable
        100.000 con provisional 8.000 (criterio 13 de §12, O-9)
    P2  el caso simetrico: definitiva 7.500 bps -> ajuste -5.000, asiento 634/472
    P3  redondeo AL ALZA del art. 104.Dos.2: 8.700.001/10.000.000 -> 8.800 bps
    P4  un documento SIN clave de operacion -> INFO con su lista, nunca un %
    P5  denominador 0 -> INFO, nunca 0 %

    R1  cobro parcial de 500.000 sobre 1.210.000 con cuota 210.000 -> 86.776
    R2  el cobro final se lleva el residuo -> 123.224 (suma exacta 210.000)
    R3  barrido del 31/12 (T-36): se devenga lo pendiente del ano anterior
    R4  el CHECK de O-15: nada del ano N-1 queda sin devengar

    B1  guardia del art. 107 (O-12): desviacion de 12 puntos -> FAIL BLOQUEANTE
    B2  la misma cartera con 1 punto de desviacion -> PASS
    B3  bien por debajo del umbral del art. 108 -> PASS
    B4  terrenos y edificaciones: ventana de NUEVE anos (art. 107.Tres) -> FAIL
    B5  sin prorrata del ano de alta: WARN, la desviacion no es medible

Escribe `docs/design/fixtures/liquidacion-iva-esperada.json`. Con `--check` no
escribe: reconstruye y compara byte a byte. `lib/closing/vat.test.ts` hace la
comparacion contraria desde TypeScript.

Convenciones
------------
* Centimos ENTEROS; `trunc` hacia cero y residuo al ULTIMO cobro (R-IVA-19).
* El porcentaje definitivo de prorrata se redondea AL ALZA a entero
  (art. 104.Dos.2), que es la unica excepcion al truncamiento.
* La liquidacion sale del LIBRO REGISTRO; los saldos del diario solo verifican.
"""

from __future__ import annotations

import argparse
import json
import sys
from calendar import monthrange
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
OUT = HERE / "liquidacion-iva-esperada.json"

# Casillas OFRECIDAS, en el orden de presentacion de lib/closing/model303.map.ts
OFFERED = [
    "01", "02", "03", "04", "05", "06", "07", "08", "09",
    "10", "11", "12", "13", "14", "15", "27",
    "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
    "40", "41", "43", "44", "45", "46",
    "59", "60", "61",
    "62", "63", "74", "75",
    "64", "65", "66", "77", "67", "69", "70", "71",
]
REQUIRES = {"62": "RECC", "63": "RECC", "74": "RECC", "75": "RECC", "77": "IMPORT_DEFERRAL"}

RATE_BOXES = [(400, "01", "02", "03"), (1000, "04", "05", "06"), (2100, "07", "08", "09")]

NUMERATOR_KEYS = {"INTERIOR", "EXPORTACION", "EIB", "EXENTA_PLENA", "NO_SUJETA_ISP"}
DENOMINATOR_ONLY_KEYS = {"EXENTA_LIMITADA"}
EXCLUDED_KEYS = {
    "BIEN_INVERSION_USADO": "entrega de bien de inversión utilizado (art. 104.Tres.1º)",
    "INMOBILIARIA_NO_HABITUAL": "operación inmobiliaria no habitual (art. 104.Tres.4º)",
    "FINANCIERA_NO_HABITUAL": "operación financiera no habitual (art. 104.Tres.4º)",
    "AUTOCONSUMO_9_1_C_D": "autoconsumo del art. 9.1º.c) y d) (art. 104.Tres.2º)",
    "FUERA_TAI": "operación realizada fuera del TAI desde un establecimiento no situado en él (art. 104.Tres.5º)",
}

CAPITAL_GOODS_THRESHOLD_CENTS = 300_506
CAPITAL_GOODS_DEVIATION_BPS = 1000
WINDOW_YEARS = 4
WINDOW_YEARS_REAL_ESTATE = 9


# ── Aritmetica entera ────────────────────────────────────────────────────────

def trunc_div(a: int, b: int) -> int:
    """Division entera truncada HACIA CERO (no el floor de Python)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def mul_div_trunc(a: int, b: int, d: int) -> int:
    return trunc_div(a * b, d)


# ── Periodos ─────────────────────────────────────────────────────────────────

def period_bounds(period: str) -> dict[str, str]:
    year = int(period[:4])
    if period[5] == "Q":
        q = int(period[6])
        first, last = (q - 1) * 3 + 1, (q - 1) * 3 + 3
    else:
        first = last = int(period[5:7])
    return {
        "start": f"{year:04d}-{first:02d}-01",
        "end": f"{year:04d}-{last:02d}-{monthrange(year, last)[1]:02d}",
    }


# ── Libro registro ───────────────────────────────────────────────────────────

def row(**kw: Any) -> dict[str, Any]:
    """Fila del libro con TODAS las columnas, en el orden canonico."""
    base = kw["baseCents"]
    quota = kw.get("cuotaTotalCents", 0)
    r = {
        "id": kw["id"],
        "entryId": kw.get("entryId", kw["id"]),
        "ivaPeriod": kw["ivaPeriod"],
        "tipo": kw["tipo"],
        "docKind": kw.get("docKind", "FACTURA"),
        "operationKey": kw.get("operationKey", "INTERIOR"),
        "rateBps": kw.get("rateBps"),
        "baseCents": base,
        "baseEnPeriodoCents": kw.get("baseEnPeriodoCents", base),
        "cuotaTotalCents": quota,
        "cuotaDeducibleCents": kw.get("cuotaDeducibleCents", 0),
        "cuotaNoDeducibleAlCosteCents": kw.get("cuotaNoDeducibleAlCosteCents", 0),
        "cuotaRepercutidaCents": kw.get("cuotaRepercutidaCents", 0),
        "cuotaDevengadaIspAibCents": kw.get("cuotaDevengadaIspAibCents", 0),
        "cuotaDevengadaEnPeriodoCents": kw.get(
            "cuotaDevengadaEnPeriodoCents", kw.get("cuotaRepercutidaCents", 0)
        ),
        "cuotaDeducibleEnPeriodoCents": kw.get(
            "cuotaDeducibleEnPeriodoCents", kw.get("cuotaDeducibleCents", 0)
        ),
        "investmentGood": kw.get("investmentGood", False),
        "deductibility": kw.get("deductibility"),
        "recc": kw.get("recc", False),
        "importDeferred": kw.get("importDeferred", False),
        "documentDate": kw["documentDate"],
        "deductionDate": kw.get("deductionDate", kw["documentDate"]),
    }
    return r


def issued(book: list[dict]) -> list[dict]:
    return [r for r in book if r["tipo"] == "EMITIDAS"]


def received(book: list[dict]) -> list[dict]:
    return [r for r in book if r["tipo"] == "RECIBIDAS"]


def s(rows: list[dict], field: str) -> int:
    return sum(r[field] for r in rows)


def period_totals(book: list[dict], period: str) -> dict[str, int]:
    rows = [r for r in book if r["ivaPeriod"] == period]
    iss, rec = issued(rows), received(rows)
    deferred = [r for r in rec if r["importDeferred"]]
    return {
        "outputCents": s(iss, "cuotaDevengadaEnPeriodoCents")
        + s(rec, "cuotaDevengadaIspAibCents")
        + s(deferred, "cuotaTotalCents"),
        "inputCents": s(rec, "cuotaDeducibleEnPeriodoCents"),
        "nonDeductibleCents": s(rec, "cuotaNoDeducibleAlCosteCents"),
        "bookIssuedCents": s(iss, "cuotaRepercutidaCents") + s(rec, "cuotaDevengadaIspAibCents"),
        "bookReceivedCents": s(rec, "cuotaDeducibleCents"),
        "importDeferredCents": s(deferred, "cuotaTotalCents"),
    }


# ── T-23 y los puentes ───────────────────────────────────────────────────────

def settlement(case: dict, totals: dict[str, int]) -> dict[str, Any]:
    bounds = period_bounds(case["period"])
    carry = case["carryForwardCents"]
    adjustment = case["prorrataAdjustmentCents"]
    return {
        "ok": True,
        "periodStart": bounds["start"],
        "periodEnd": bounds["end"],
        "outputCents": totals["outputCents"],
        "inputCents": totals["inputCents"] + adjustment,
        "carryForwardCents": carry,
        "description": f"Liquidación de IVA {case['period']} (modelo 303, régimen {case['regime'].lower()})",
    }


def bridges(case: dict, totals: dict[str, int]) -> list[dict[str, str]]:
    b = case["balance"]
    libro_ded = totals["bookReceivedCents"] + case["prorrataAdjustmentCents"]
    diario_ded = b["saldo472Cents"] + b["saldo4728Cents"]
    libro_dev = totals["bookIssuedCents"] + totals["importDeferredCents"]
    diario_dev = b["saldo477Cents"] + b["saldo4778Cents"]
    return [
        {"id": "I-E8-15a′", "status": "PASS" if libro_ded == diario_ded else "FAIL"},
        {"id": "I-E8-15c′", "status": "PASS" if libro_dev == diario_dev else "FAIL"},
        # El enunciado ANTERIOR (sin 4728/4778) sobre el mismo libro: O-14.
        {"id": "I-E8-15a", "status": "PASS" if libro_ded == b["saldo472Cents"] else "FAIL"},
        {"id": "I-E8-15c", "status": "PASS" if libro_dev == b["saldo477Cents"] else "FAIL"},
    ]


# ── Las casillas del 303 ─────────────────────────────────────────────────────

def boxes_303(case: dict) -> list[dict[str, Any]]:
    rows = [r for r in case["book"] if r["ivaPeriod"] == case["period"]]
    iss, rec = issued(rows), received(rows)
    v: dict[str, int] = {}

    def facturas(rs): return [r for r in rs if r["docKind"] != "RECTIFICATIVA"]
    def rects(rs): return [r for r in rs if r["docKind"] == "RECTIFICATIVA"]
    def key(rs, *keys): return [r for r in rs if r["operationKey"] in keys]

    for bps, base, rate, quota in RATE_BOXES:
        hits = [r for r in facturas(iss) if r["rateBps"] == bps]
        v[base] = s(hits, "baseEnPeriodoCents")
        v[rate] = bps // 100
        v[quota] = s(hits, "cuotaDevengadaEnPeriodoCents")

    aib = key(rec, "AIB")
    isp = key(rec, "ISP")
    v["10"] = s(aib, "baseEnPeriodoCents")
    v["11"] = s(aib, "cuotaDevengadaIspAibCents")
    v["12"] = s(isp, "baseEnPeriodoCents")
    v["13"] = s(isp, "cuotaDevengadaIspAibCents")
    rect_venta = rects(iss)
    v["14"] = s(rect_venta, "baseEnPeriodoCents")
    v["15"] = s(rect_venta, "cuotaDevengadaEnPeriodoCents")
    v["27"] = v["03"] + v["06"] + v["09"] + v["11"] + v["13"] + v["15"]

    interiores = key(facturas(rec), "INTERIOR", "ISP")
    corrientes = [r for r in interiores if not r["investmentGood"]]
    inversion = [r for r in interiores if r["investmentGood"]]
    v["28"] = s(corrientes, "baseEnPeriodoCents")
    v["29"] = s(corrientes, "cuotaDeducibleEnPeriodoCents")
    v["30"] = s(inversion, "baseEnPeriodoCents")
    v["31"] = s(inversion, "cuotaDeducibleEnPeriodoCents")

    duas = [r for r in rec if r["docKind"] == "DUA_IMPORTACION"]
    dua_c = [r for r in duas if not r["investmentGood"]]
    dua_i = [r for r in duas if r["investmentGood"]]
    v["32"] = s(dua_c, "baseEnPeriodoCents")
    v["33"] = s(dua_c, "cuotaDeducibleEnPeriodoCents")
    v["34"] = s(dua_i, "baseEnPeriodoCents")
    v["35"] = s(dua_i, "cuotaDeducibleEnPeriodoCents")

    aib_c = [r for r in aib if not r["investmentGood"]]
    aib_i = [r for r in aib if r["investmentGood"]]
    v["36"] = s(aib_c, "baseEnPeriodoCents")
    v["37"] = s(aib_c, "cuotaDeducibleEnPeriodoCents")
    v["38"] = s(aib_i, "baseEnPeriodoCents")
    v["39"] = s(aib_i, "cuotaDeducibleEnPeriodoCents")

    rect_compra = rects(rec)
    v["40"] = s(rect_compra, "baseEnPeriodoCents")
    v["41"] = s(rect_compra, "cuotaDeducibleEnPeriodoCents")

    v["43"] = 0
    v["44"] = case["prorrataAdjustmentCents"]
    v["45"] = v["29"] + v["31"] + v["33"] + v["35"] + v["37"] + v["39"] + v["41"] + v["43"] + v["44"]
    v["46"] = v["27"] - v["45"]

    v["59"] = s(key(iss, "EIB"), "baseCents")
    v["60"] = s(key(iss, "EXPORTACION"), "baseCents")
    v["61"] = s(key(iss, "NO_SUJETA_ISP", "EXENTA_PLENA"), "baseCents")

    recc_active = case["regime"] == "RECC"
    recc_iss = [r for r in iss if r["recc"]]
    recc_rec = [r for r in rec if r["recc"]]
    v["62"] = s(recc_iss, "baseCents") if recc_active else 0
    v["63"] = s(recc_iss, "cuotaRepercutidaCents") if recc_active else 0
    v["74"] = s(recc_rec, "baseCents") if recc_active else 0
    v["75"] = s(recc_rec, "cuotaDeducibleCents") if recc_active else 0

    state = case["statePct"]
    deferred = s([r for r in rec if r["importDeferred"]], "cuotaTotalCents") if case["importDeferral"] else 0
    v["64"] = v["46"]
    v["65"] = state
    v["66"] = mul_div_trunc(v["64"], state, 100)
    v["77"] = deferred
    v["67"] = case["carryForwardCents"]
    v["69"] = v["66"] + v["77"] - v["67"]
    v["70"] = case["previousDeclarationCents"]
    v["71"] = v["69"] - v["70"]

    out = []
    for box in OFFERED:
        req = REQUIRES.get(box)
        if req == "RECC" and not recc_active:
            continue
        if req == "IMPORT_DEFERRAL" and not case["importDeferral"]:
            continue
        out.append({"box": box, "value": v[box]})
    return out


# ── Prorrata ─────────────────────────────────────────────────────────────────

def prorrata_definitiva_bps(num: int, den: int) -> int:
    pct = -(-(num * 100) // den)  # ceil entero
    return min(pct, 100) * 100


def prorrata_terms(book: list[dict], year: int) -> dict[str, Any]:
    rows = [r for r in issued(book) if int(r["ivaPeriod"][:4]) == year]
    unclassified = [
        {"id": r["id"], "documentDate": r["documentDate"], "baseCents": r["baseCents"]}
        for r in rows
        if r["operationKey"] is None
    ]
    excluded = [
        {
            "id": r["id"],
            "operationKey": r["operationKey"],
            "baseCents": r["baseCents"],
            "motivo": EXCLUDED_KEYS[r["operationKey"]],
        }
        for r in rows
        if r["operationKey"] in EXCLUDED_KEYS
    ]
    numerator = s([r for r in rows if r["operationKey"] in NUMERATOR_KEYS], "baseCents")
    denominator = numerator + s([r for r in rows if r["operationKey"] in DENOMINATOR_ONLY_KEYS], "baseCents")
    if unclassified or denominator == 0:
        definitive = None
        status = "INFO"
    else:
        definitive = prorrata_definitiva_bps(numerator, denominator)
        status = "OK"
    return {
        "year": year,
        "numeratorCents": numerator,
        "denominatorCents": denominator,
        "definitiveBps": definitive,
        "status": status,
        "unclassified": unclassified,
        "excluded": excluded,
    }


def prorrateable_quota(book: list[dict], year: int) -> int:
    return s(
        [
            r
            for r in received(book)
            if int(r["ivaPeriod"][:4]) == year and r["deductibility"] == "PRORRATA" and not r["investmentGood"]
        ],
        "cuotaTotalCents",
    )


def prorrata_regularization(quota: int, provisional: int, definitive: int) -> dict[str, Any]:
    adjustment = mul_div_trunc(quota, definitive, 10000) - mul_div_trunc(quota, provisional, 10000)
    return {
        "adjustmentCents": adjustment,
        "accountKey": "AJUSTE_PRORRATA_POSITIVO" if adjustment >= 0 else "AJUSTE_PRORRATA_NEGATIVO",
    }


def prorrata_lines(reg: dict[str, Any], year: int) -> list[dict[str, Any]]:
    adj = reg["adjustmentCents"]
    if adj == 0:
        return []
    amount = abs(adj)
    d = f"Regularización de la prorrata definitiva {year} (art. 105 LIVA)"
    if adj > 0:
        return [
            {"lineNo": 1, "accountKey": "IVA_SOPORTADO", "debitCents": amount, "creditCents": 0, "description": d},
            {"lineNo": 2, "accountKey": reg["accountKey"], "debitCents": 0, "creditCents": amount, "description": d},
        ]
    return [
        {"lineNo": 1, "accountKey": reg["accountKey"], "debitCents": amount, "creditCents": 0, "description": d},
        {"lineNo": 2, "accountKey": "IVA_SOPORTADO", "debitCents": 0, "creditCents": amount, "description": d},
    ]


# ── RECC ─────────────────────────────────────────────────────────────────────

def recc_accrual(collected: int, total_invoice: int, total_quota: int, already: int, is_final: bool) -> int:
    if is_final:
        return total_quota - already
    return min(mul_div_trunc(collected, total_quota, total_invoice), total_quota - already)


def recc_sweep(pending: list[dict], cutoff: str) -> list[dict[str, Any]]:
    limit_year = int(cutoff[:4]) - 1
    due = sorted(
        [p for p in pending if int(p["operationDate"][:4]) <= limit_year and p["totalQuotaCents"] - p["accruedCents"] > 0],
        key=lambda p: (p["side"], p["operationDate"], p["documentNumber"]),
    )
    lines: list[dict[str, Any]] = []
    n = 1
    for p in due:
        amount = p["totalQuotaCents"] - p["accruedCents"]
        d = f"Devengo RECC 31/12 · {p['documentNumber']} (art. 163 terdecies LIVA)"
        if p["side"] == "EMITIDA":
            keys = ("IVA_REPERCUTIDO_PENDIENTE_RECC", "IVA_REPERCUTIDO")
        else:
            keys = ("IVA_SOPORTADO", "IVA_SOPORTADO_PENDIENTE_RECC")
        lines.append({"lineNo": n, "accountKey": keys[0], "debitCents": amount, "creditCents": 0, "description": d})
        n += 1
        lines.append({"lineNo": n, "accountKey": keys[1], "debitCents": 0, "creditCents": amount, "description": d})
        n += 1
    return lines


def recc_check(pending: list[dict], cutoff: str) -> dict[str, str]:
    limit_year = int(cutoff[:4]) - 1
    bad = [
        p
        for p in pending
        if int(p["operationDate"][:4]) <= limit_year and p["accruedCents"] != p["totalQuotaCents"]
    ]
    return {"id": "I-E9-26", "status": "PASS" if not bad else "FAIL"}


# ── Guardia de bienes de inversion (art. 107) ────────────────────────────────

def capital_goods_guard(inp: dict[str, Any]) -> dict[str, Any]:
    year = inp["year"]
    bps = {p["year"]: p["bps"] for p in inp["prorrataByYear"]}
    current = bps.get(year)
    result = {"step": "BIENES_DE_INVERSION", "block": "Fiscal", "status": "PASS", "blocking": True, "sealReason": None}

    in_window = [
        a
        for a in inp["assets"]
        if a["acquisitionYear"] >= year - (WINDOW_YEARS_REAL_ESTATE if a["realEstate"] else WINDOW_YEARS)
        and a["acquisitionYear"] <= year
        and a["costCents"] >= CAPITAL_GOODS_THRESHOLD_CENTS
    ]
    if not in_window:
        return result

    with_prorrata = [
        p for p in inp["prorrataByYear"] if year - WINDOW_YEARS_REAL_ESTATE <= p["year"] <= year and p["bps"] != 10000
    ]
    if not with_prorrata and current is not None:
        return result

    unknown = [a for a in in_window if bps.get(a["acquisitionYear"]) is None]
    breached = [
        a
        for a in in_window
        if bps.get(a["acquisitionYear"]) is not None
        and current is not None
        and abs(current - bps[a["acquisitionYear"]]) > CAPITAL_GOODS_DEVIATION_BPS
    ]
    if breached:
        return {
            "step": "BIENES_DE_INVERSION",
            "block": "Fiscal",
            "status": "FAIL",
            "blocking": True,
            "sealReason": "REGULARIZACION_BIENES_INVERSION_PENDIENTE",
        }
    if unknown or current is None:
        return {
            "step": "BIENES_DE_INVERSION",
            "block": "Fiscal",
            "status": "WARN",
            "blocking": False,
            "sealReason": "REGULARIZACION_BIENES_INVERSION_PENDIENTE",
        }
    return result


# ── Los casos ────────────────────────────────────────────────────────────────

def liquidacion(
    id_: str,
    titulo: str,
    period: str,
    period_kind: str,
    regime: str,
    book: list[dict],
    balance: dict[str, int],
    *,
    import_deferral: bool = False,
    carry: int = 0,
    previous: int = 0,
    state_pct: int = 100,
    adjustment: int = 0,
) -> dict[str, Any]:
    case = {
        "id": id_,
        "titulo": titulo,
        "period": period,
        "periodKind": period_kind,
        "regime": regime,
        "importDeferral": import_deferral,
        "carryForwardCents": carry,
        "previousDeclarationCents": previous,
        "statePct": state_pct,
        "prorrataAdjustmentCents": adjustment,
        "book": book,
        "balance": balance,
    }
    totals = period_totals(book, period)
    boxes = boxes_303(case)
    case["bounds"] = period_bounds(period)
    case["totals"] = totals
    case["settlement"] = settlement(case, totals)
    case["boxes"] = boxes
    case["resultCents"] = next(b["value"] for b in boxes if b["box"] == "71")
    case["bridges"] = bridges(case, totals)
    return case


def build_liquidaciones() -> list[dict[str, Any]]:
    # ── L1 · trimestral, regimen general, el caso completo ───────────────────
    p = "2026-Q4"
    l1_book = [
        row(id="E1", ivaPeriod=p, tipo="EMITIDAS", rateBps=2100, baseCents=1_000_000,
            cuotaTotalCents=210_000, cuotaRepercutidaCents=210_000, documentDate="2026-10-05"),
        row(id="E2", ivaPeriod=p, tipo="EMITIDAS", rateBps=1000, baseCents=500_000,
            cuotaTotalCents=50_000, cuotaRepercutidaCents=50_000, documentDate="2026-11-02"),
        row(id="E3", ivaPeriod=p, tipo="EMITIDAS", operationKey="EXPORTACION", baseCents=300_000,
            documentDate="2026-11-20"),
        row(id="E4", ivaPeriod=p, tipo="EMITIDAS", operationKey="EIB", baseCents=200_000,
            documentDate="2026-12-01"),
        row(id="E5", ivaPeriod=p, tipo="EMITIDAS", docKind="RECTIFICATIVA", rateBps=2100,
            baseCents=-100_000, cuotaTotalCents=-21_000, cuotaRepercutidaCents=-21_000,
            documentDate="2026-12-15"),
        row(id="R1", ivaPeriod=p, tipo="RECIBIDAS", rateBps=2100, baseCents=400_000,
            cuotaTotalCents=84_000, cuotaDeducibleCents=84_000, deductibility="FULL",
            documentDate="2026-10-10"),
        row(id="R2", ivaPeriod=p, tipo="RECIBIDAS", rateBps=2100, baseCents=100_000,
            cuotaTotalCents=21_000, cuotaNoDeducibleAlCosteCents=21_000, deductibility="NONE",
            documentDate="2026-10-18"),
        row(id="R3", ivaPeriod=p, tipo="RECIBIDAS", rateBps=2100, baseCents=600_000,
            cuotaTotalCents=126_000, cuotaDeducibleCents=126_000, investmentGood=True,
            deductibility="FULL", documentDate="2026-11-11"),
        row(id="R4", ivaPeriod=p, tipo="RECIBIDAS", operationKey="ISP", rateBps=2100, baseCents=200_000,
            cuotaTotalCents=42_000, cuotaDeducibleCents=42_000, cuotaDevengadaIspAibCents=42_000,
            deductibility="FULL", documentDate="2026-11-25"),
        row(id="R5", ivaPeriod=p, tipo="RECIBIDAS", operationKey="AIB", rateBps=2100, baseCents=150_000,
            cuotaTotalCents=31_500, cuotaDeducibleCents=31_500, cuotaDevengadaIspAibCents=31_500,
            deductibility="FULL", documentDate="2026-12-03"),
        row(id="R6", ivaPeriod=p, tipo="RECIBIDAS", docKind="RECTIFICATIVA", rateBps=2100,
            baseCents=-50_000, cuotaTotalCents=-10_500, cuotaDeducibleCents=-10_500,
            deductibility="FULL", documentDate="2026-12-20"),
    ]
    t1 = period_totals(l1_book, p)
    l1_balance = {
        "ivaPeriod": p,
        "saldo472Cents": t1["bookReceivedCents"],
        "saldo477Cents": t1["bookIssuedCents"],
        "saldo4728Cents": 0,
        "saldo4778Cents": 0,
    }
    l1 = liquidacion(
        "L1",
        "Trimestral 2026-Q4 en régimen general: dos tipos, ISP, AIB, IVA no deducible del art. 96, "
        "bien de inversión y rectificativas de venta y de compra",
        p, "TRIMESTRAL", "GENERAL", l1_book, l1_balance,
    )

    # ── L2 · mensual con diferimiento del IVA a la importacion (O-16) ────────
    p2 = "2026-12"
    l2_book = [
        row(id="E1", ivaPeriod=p2, tipo="EMITIDAS", rateBps=2100, baseCents=2_000_000,
            cuotaTotalCents=420_000, cuotaRepercutidaCents=420_000, documentDate="2026-12-04"),
        row(id="D1", ivaPeriod=p2, tipo="RECIBIDAS", docKind="DUA_IMPORTACION", operationKey="IMPORTACION",
            rateBps=2100, baseCents=12_000_000, cuotaTotalCents=2_520_000,
            cuotaDeducibleCents=2_520_000, importDeferred=True, deductibility="FULL",
            documentDate="2026-12-12"),
    ]
    t2 = period_totals(l2_book, p2)
    l2_balance = {
        "ivaPeriod": p2,
        "saldo472Cents": t2["bookReceivedCents"],
        "saldo477Cents": t2["bookIssuedCents"] + t2["importDeferredCents"],
        "saldo4728Cents": 0,
        "saldo4778Cents": 0,
    }
    l2 = liquidacion(
        "L2",
        "Mensual 2026-12 con diferimiento del IVA a la importación (O-16): el DUA SÍ devenga 477, "
        "casillas 32-33 y 77",
        p2, "MENSUAL", "REDEME", l2_book, l2_balance, import_deferral=True,
    )

    # ── L3 · ultimo periodo con el ajuste de prorrata y cuota a compensar ────
    p3 = "2026-Q4"
    l3_book = [
        row(id="E1", ivaPeriod=p3, tipo="EMITIDAS", rateBps=2100, baseCents=1_000_000,
            cuotaTotalCents=210_000, cuotaRepercutidaCents=210_000, documentDate="2026-10-07"),
        row(id="R1", ivaPeriod=p3, tipo="RECIBIDAS", rateBps=2100, baseCents=500_000,
            cuotaTotalCents=105_000, cuotaDeducibleCents=84_000, cuotaNoDeducibleAlCosteCents=21_000,
            deductibility="PRORRATA", documentDate="2026-10-09"),
    ]
    t3 = period_totals(l3_book, p3)
    l3_balance = {
        "ivaPeriod": p3,
        "saldo472Cents": t3["bookReceivedCents"] + 7_000,
        "saldo477Cents": t3["bookIssuedCents"],
        "saldo4728Cents": 0,
        "saldo4778Cents": 0,
    }
    l3 = liquidacion(
        "L3",
        "Último periodo del año con el ajuste de prorrata definitiva en la casilla 44 (+7.000, O-9) "
        "y cuota a compensar en la 67",
        p3, "TRIMESTRAL", "GENERAL", l3_book, l3_balance, carry=5_000, adjustment=7_000,
    )

    # ── L4 · RECC: el libro anota la integra y 477 solo lo cobrado (O-14) ────
    p4 = "2027-Q1"
    l4_book = [
        row(id="E1", ivaPeriod=p4, tipo="EMITIDAS", rateBps=2100, baseCents=1_000_000,
            baseEnPeriodoCents=413_224, cuotaTotalCents=210_000, cuotaRepercutidaCents=210_000,
            cuotaDevengadaEnPeriodoCents=86_776, recc=True, documentDate="2027-01-15"),
        row(id="R1", ivaPeriod=p4, tipo="RECIBIDAS", rateBps=2100, baseCents=200_000,
            baseEnPeriodoCents=0, cuotaTotalCents=42_000, cuotaDeducibleCents=42_000,
            cuotaDeducibleEnPeriodoCents=0, recc=True, deductibility="FULL",
            documentDate="2027-02-02"),
    ]
    l4_balance = {
        "ivaPeriod": p4,
        "saldo472Cents": 0,
        "saldo477Cents": 86_776,
        "saldo4728Cents": 42_000,
        "saldo4778Cents": 123_224,
    }
    l4 = liquidacion(
        "L4",
        "Organización en RECC (O-14, O-15): el libro anota la factura íntegra y 477 sólo recoge lo "
        "cobrado; 15a′/15c′ pasan donde 15a/15c fallaban",
        p4, "TRIMESTRAL", "RECC", l4_book, l4_balance,
    )
    return [l1, l2, l3, l4]


def build_prorratas() -> list[dict[str, Any]]:
    def emit(id_, key, base, date="2026-06-30", period="2026-Q2"):
        return row(id=id_, ivaPeriod=period, tipo="EMITIDAS", operationKey=key, baseCents=base, documentDate=date)

    def sop(id_, quota, *, deductibility="PRORRATA", investment=False, period="2026-Q2"):
        return row(id=id_, ivaPeriod=period, tipo="RECIBIDAS", baseCents=0, cuotaTotalCents=quota,
                   cuotaDeducibleCents=0, deductibility=deductibility, investmentGood=investment,
                   documentDate="2026-06-30")

    cases: list[dict[str, Any]] = []

    def case(id_, titulo, book, year, provisional):
        terms = prorrata_terms(book, year)
        quota = prorrateable_quota(book, year)
        reg = (
            prorrata_regularization(quota, provisional, terms["definitiveBps"])
            if terms["definitiveBps"] is not None
            else None
        )
        return {
            "id": id_,
            "titulo": titulo,
            "year": year,
            "provisionalBps": provisional,
            "book": book,
            "terms": terms,
            "prorrateableQuotaCents": quota,
            "regularization": reg,
            "lines": prorrata_lines(reg, year) if reg else [],
        }

    base_book = [
        emit("P-E1", "INTERIOR", 8_700_000),
        emit("P-E2", "EXENTA_LIMITADA", 1_300_000),
        emit("P-E3", "BIEN_INVERSION_USADO", 500_000),
        sop("P-R1", 100_000),
        sop("P-R2", 40_000, deductibility="FULL"),
        sop("P-R3", 30_000, deductibility="NONE"),
        sop("P-R4", 60_000, investment=True),
    ]
    cases.append(case(
        "P1",
        "Definitiva 8.700 bps sobre 8.700.000/10.000.000 y ajuste +7.000 con provisional 8.000 "
        "(criterio 13 de §12, O-9): la base es la cuota PRORRATEABLE, no lo ya deducido",
        base_book, 2026, 8_000,
    ))
    cases.append(case(
        "P2",
        "El caso simétrico: definitiva 7.500 bps ⇒ ajuste −5.000 y asiento 634 (D) / 472 (H)",
        [emit("P-E1", "INTERIOR", 7_500_000), emit("P-E2", "EXENTA_LIMITADA", 2_500_000), sop("P-R1", 100_000)],
        2026, 8_000,
    ))
    cases.append(case(
        "P3",
        "Redondeo AL ALZA del art. 104.Dos.2ª: 8.700.001/10.000.000 = 87,00001 % ⇒ 88 % (8.800 bps)",
        [emit("P-E1", "INTERIOR", 8_700_001), emit("P-E2", "EXENTA_LIMITADA", 1_299_999), sop("P-R1", 100_000)],
        2026, 8_000,
    ))
    cases.append(case(
        "P4",
        "Un documento SIN clave de operación (O-10): INFO con su lista y nunca un porcentaje",
        [emit("P-E1", "INTERIOR", 8_700_000), emit("P-E2", None, 1_300_000), sop("P-R1", 100_000)],
        2026, 8_000,
    ))
    cases.append(case(
        "P5",
        "Denominador 0: INFO, nunca 0 % (R-IVA-11)",
        [emit("P-E1", "BIEN_INVERSION_USADO", 500_000), sop("P-R1", 100_000)],
        2026, 8_000,
    ))
    return cases


def build_recc() -> list[dict[str, Any]]:
    def case(id_, titulo, tipo, *, cobro=None, devengado=None, pendientes=None, cutoff=None, lines=None, check=None):
        return {
            "id": id_,
            "titulo": titulo,
            "tipo": tipo,
            "cobro": cobro,
            "devengadoCents": devengado,
            "pendientes": pendientes,
            "cutoff": cutoff,
            "lines": lines,
            "check": check,
        }

    c1 = {"collectedCents": 500_000, "totalInvoiceCents": 1_210_000, "totalQuotaCents": 210_000,
          "alreadyAccruedCents": 0, "isFinal": False}
    c2 = {"collectedCents": 710_000, "totalInvoiceCents": 1_210_000, "totalQuotaCents": 210_000,
          "alreadyAccruedCents": 86_776, "isFinal": True}
    pendientes = [
        {"id": "RC-1", "side": "EMITIDA", "documentNumber": "F-2026-014", "operationDate": "2026-05-10",
         "totalQuotaCents": 210_000, "accruedCents": 86_776},
        {"id": "RC-2", "side": "RECIBIDA", "documentNumber": "C-2026-091", "operationDate": "2026-09-30",
         "totalQuotaCents": 42_000, "accruedCents": 0},
        {"id": "RC-3", "side": "EMITIDA", "documentNumber": "F-2027-003", "operationDate": "2027-03-01",
         "totalQuotaCents": 63_000, "accruedCents": 0},
    ]
    saldadas = [dict(p, accruedCents=p["totalQuotaCents"]) for p in pendientes]
    return [
        case("R1", "Cobro parcial de 500.000 sobre 1.210.000 con cuota 210.000 ⇒ 86.776 (O-15)",
             "COBRO", cobro=c1, devengado=recc_accrual(
                 c1["collectedCents"], c1["totalInvoiceCents"], c1["totalQuotaCents"],
                 c1["alreadyAccruedCents"], c1["isFinal"])),
        case("R2", "El cobro final se lleva el residuo: 123.224, y Σ devengadas = 210.000 exactos",
             "COBRO", cobro=c2, devengado=recc_accrual(
                 c2["collectedCents"], c2["totalInvoiceCents"], c2["totalQuotaCents"],
                 c2["alreadyAccruedCents"], c2["isFinal"])),
        case("R3", "Barrido del 31/12 (T-36, art. 163 terdecies): sólo lo pendiente del año anterior",
             "BARRIDO", pendientes=pendientes, cutoff="2027-12-31", lines=recc_sweep(pendientes, "2027-12-31"),
             check=recc_check(pendientes, "2027-12-31")),
        case("R4", "Tras el barrido, nada del año N−1 queda sin devengar (I-E9-26 en PASS)",
             "CHECK", pendientes=saldadas, cutoff="2027-12-31", lines=recc_sweep(saldadas, "2027-12-31"),
             check=recc_check(saldadas, "2027-12-31")),
    ]


def build_bienes_inversion() -> list[dict[str, Any]]:
    def asset(id_, year, cost, real_estate=False):
        return {"id": id_, "code": id_, "accountCode": "2131", "acquisitionYear": year,
                "costCents": cost, "realEstate": real_estate}

    def case(id_, titulo, inp):
        return {"id": id_, "titulo": titulo, "input": inp, "guard": capital_goods_guard(inp)}

    prorratas = [{"year": 2024, "bps": 9_700}, {"year": 2025, "bps": 9_000}, {"year": 2026, "bps": 8_500}]
    return [
        case("B1", "Prorrata 85 % en N y alta de grupo 2 de 400.000 c en N−2 con 97 % (criterio 15 de §12): "
                   "FAIL bloqueante con REGULARIZACION_BIENES_INVERSION_PENDIENTE",
             {"year": 2026, "prorrataByYear": prorratas, "assets": [asset("BI-1", 2024, 400_000)]}),
        case("B2", "La misma cartera con 96 % en N: un punto de desviación, PASS",
             {"year": 2026,
              "prorrataByYear": [{"year": 2024, "bps": 9_700}, {"year": 2026, "bps": 9_600}],
              "assets": [asset("BI-1", 2024, 400_000)]}),
        case("B3", "Bien por debajo del umbral del art. 108 (3.005,06 €): fuera de la guardia",
             {"year": 2026, "prorrataByYear": prorratas, "assets": [asset("BI-2", 2024, 300_000)]}),
        case("B4", "Terrenos y edificaciones: ventana de NUEVE años (art. 107.Tres), alta de 2019",
             {"year": 2026,
              "prorrataByYear": [{"year": 2019, "bps": 10_000}, {"year": 2026, "bps": 8_500}],
              "assets": [asset("BI-3", 2019, 5_000_000, True)]}),
        case("B5", "Sin prorrata del año de alta: WARN, la desviación del art. 107 no es medible",
             {"year": 2026,
              "prorrataByYear": [{"year": 2026, "bps": 8_500}],
              "assets": [asset("BI-4", 2024, 400_000)]}),
    ]


def check(id_: str, expected: Any, actual: Any) -> dict[str, Any]:
    return {"id": id_, "expected": expected, "actual": actual, "status": "PASS" if expected == actual else "FAIL"}


def build() -> dict[str, Any]:
    liquidaciones = build_liquidaciones()
    prorratas = build_prorratas()
    recc = build_recc()
    bienes = build_bienes_inversion()

    def box(case_id: str, box_id: str) -> int:
        c = next(c for c in liquidaciones if c["id"] == case_id)
        return next(b["value"] for b in c["boxes"] if b["box"] == box_id)

    def caso(cases: list[dict], id_: str) -> dict:
        return next(c for c in cases if c["id"] == id_)

    checks: list[dict[str, Any]] = []
    # Criterio 16 de §12: la cadena 27 -> 45 -> 46 -> 64 -> 66 -> 69 -> 71 y
    # `casilla 71 = importe del asiento T-23`.
    for c in liquidaciones:
        t23 = c["settlement"]["outputCents"] - c["settlement"]["inputCents"] - c["settlement"]["carryForwardCents"]
        b70 = next(b["value"] for b in c["boxes"] if b["box"] == "70")
        checks.append(check(f"criterio-16/71=T-23/{c['id']}", t23 - b70, c["resultCents"]))
        checks.append(check(f"criterio-16/45/{c['id']}",
                            sum(next(b["value"] for b in c["boxes"] if b["box"] == k)
                                for k in ("29", "31", "33", "35", "37", "39", "41", "43", "44")),
                            next(b["value"] for b in c["boxes"] if b["box"] == "45")))
    checks.append(check("criterio-16/27/L1", 312_500, box("L1", "27")))
    checks.append(check("criterio-16/45/L1", 273_000, box("L1", "45")))
    checks.append(check("criterio-16/46/L1", 39_500, box("L1", "46")))
    checks.append(check("criterio-16/71/L1", 39_500, box("L1", "71")))
    checks.append(check("O-16/77/L2", 2_520_000, box("L2", "77")))
    checks.append(check("O-16/33/L2", 2_520_000, box("L2", "33")))
    checks.append(check("O-16/71/L2", 420_000, box("L2", "71")))
    checks.append(check("O-9/44/L3", 7_000, box("L3", "44")))
    checks.append(check("O-11/71/L3", 114_000, box("L3", "71")))
    # O-14: los puentes viejos fallaban por hacer lo correcto; los nuevos pasan.
    l4 = caso(liquidaciones, "L4")
    st = {b["id"]: b["status"] for b in l4["bridges"]}
    checks.append(check("O-14/15a′/L4", "PASS", st["I-E8-15a′"]))
    checks.append(check("O-14/15c′/L4", "PASS", st["I-E8-15c′"]))
    checks.append(check("O-14/15a-sin-4728/L4", "FAIL", st["I-E8-15a"]))
    checks.append(check("O-14/15c-sin-4778/L4", "FAIL", st["I-E8-15c"]))
    checks.append(check("O-15/09/L4", 86_776, box("L4", "09")))
    checks.append(check("O-15/63/L4", 210_000, box("L4", "63")))
    # Prorrata (criterio 13 y 14 de §12)
    p1 = caso(prorratas, "P1")
    checks.append(check("O-9/definitiva/P1", 8_700, p1["terms"]["definitiveBps"]))
    checks.append(check("O-9/prorrateable/P1", 100_000, p1["prorrateableQuotaCents"]))
    checks.append(check("O-9/ajuste/P1", 7_000, p1["regularization"]["adjustmentCents"]))
    checks.append(check("O-9/cuenta/P1", "AJUSTE_PRORRATA_POSITIVO", p1["regularization"]["accountKey"]))
    p2 = caso(prorratas, "P2")
    checks.append(check("O-9/ajuste/P2", -5_000, p2["regularization"]["adjustmentCents"]))
    checks.append(check("O-9/cuenta/P2", "AJUSTE_PRORRATA_NEGATIVO", p2["regularization"]["accountKey"]))
    checks.append(check("R-IVA-11/alza/P3", 8_800, caso(prorratas, "P3")["terms"]["definitiveBps"]))
    p4 = caso(prorratas, "P4")
    checks.append(check("O-10/info/P4", "INFO", p4["terms"]["status"]))
    checks.append(check("O-10/sin-porcentaje/P4", None, p4["terms"]["definitiveBps"]))
    checks.append(check("O-10/excluidas/P1", 1, len(p1["terms"]["excluded"])))
    checks.append(check("R-IVA-11/denominador-0/P5", "INFO", caso(prorratas, "P5")["terms"]["status"]))
    # RECC (criterio 17)
    checks.append(check("O-15/cobro-parcial/R1", 86_776, caso(recc, "R1")["devengadoCents"]))
    checks.append(check("O-15/residuo/R2", 123_224, caso(recc, "R2")["devengadoCents"]))
    checks.append(check("O-15/suma/R1+R2", 210_000,
                        caso(recc, "R1")["devengadoCents"] + caso(recc, "R2")["devengadoCents"]))
    checks.append(check("D8.4/barrido/R3", 4, len(caso(recc, "R3")["lines"])))
    checks.append(check("I-E9-26/R3", "FAIL", caso(recc, "R3")["check"]["status"]))
    checks.append(check("I-E9-26/R4", "PASS", caso(recc, "R4")["check"]["status"]))
    # Bienes de inversion (criterio 15)
    checks.append(check("O-12/B1", "FAIL", caso(bienes, "B1")["guard"]["status"]))
    checks.append(check("O-12/sello/B1", "REGULARIZACION_BIENES_INVERSION_PENDIENTE",
                        caso(bienes, "B1")["guard"]["sealReason"]))
    checks.append(check("O-12/B2", "PASS", caso(bienes, "B2")["guard"]["status"]))
    checks.append(check("O-12/umbral/B3", "PASS", caso(bienes, "B3")["guard"]["status"]))
    checks.append(check("O-12/nueve-anos/B4", "FAIL", caso(bienes, "B4")["guard"]["status"]))
    checks.append(check("O-12/desconocida/B5", "WARN", caso(bienes, "B5")["guard"]["status"]))

    return {
        "fixture": "liquidacion-iva-esperada",
        "epica": "E9",
        "tarea": "T8",
        "reglas": "R-IVA-8..R-IVA-20 (docs/design/E9-cierre-recurrentes.md §4.4, ADR-0016 D4/D8/D12)",
        "liquidaciones": liquidaciones,
        "prorratas": prorratas,
        "recc": recc,
        "bienesInversion": bienes,
        "checks": checks,
    }


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
        print("OK: liquidacion-iva-esperada.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    for c in data["liquidaciones"]:
        print(f"  {c['id']}  27={c['boxes'][15]['value']:>10,}  71={c['resultCents']:>10,}  "
              f"puentes={[b['status'] for b in c['bridges']]}")
    for c in data["prorratas"]:
        print(f"  {c['id']}  definitiva={c['terms']['definitiveBps']}  "
              f"ajuste={c['regularization']['adjustmentCents'] if c['regularization'] else None}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
