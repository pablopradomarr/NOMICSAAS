#!/usr/bin/env python3
"""
E9 - Generador de los CUADROS DE AMORTIZACION esperados (T6).

    python3 docs/design/fixtures/build_cuadros_esperados.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), los ocho casos del
cuadro de amortizacion que exige `docs/design/E9-cierre-recurrentes.md` §4.2:

    1. base indivisible (residuo a la ultima cuota)
    2. valor residual > 0            -> criterio 5 de §12: ultima cuota 128 574
    3. alta a mitad de mes           -> mes entero desde la puesta en servicio (R-AM-3)
    4. revision de vida util en el mes 20   -> prospectiva, el pasado no se toca (R-AM-5)
    5. mejora capitalizada           -> base = coste + mejoras - residual (R-AM-1, O-28)
    6. baja en el mes 14             -> dotacion hasta el mes de la baja inclusive (R-AM-6)
    7. venta con 543 e IVA           -> criterio 7 de §12; nunca 430 (R-AM-7)
    8. base < n (cuota cero, O-22)   -> 35 cuotas de 0 y la ultima de 20 (R-REC-8)

Escribe `docs/design/fixtures/cuadros-esperados.json`. Con `--check` no escribe:
reconstruye, compara byte a byte con el fichero en disco y falla si difiere.
`lib/closing/depreciation.test.ts` hace la comparacion contraria desde TypeScript,
de modo que las dos implementaciones tienen que coincidir hasta el ultimo centimo.

Convenciones (ADR-0006, ADR-0016 D2)
------------------------------------
* Todo en centimos ENTEROS. Nada de float en el resultado.
* `q = trunc(base / n)`; el residuo `base - n*q` va a la ULTIMA cuota. NO se usa
  mayor resto (Hamilton): repartiria el residuo a los primeros meses y el activo
  alcanzaria su valor residual antes de agotar su vida util.
* Mes entero desde `inServiceDate` y hasta el mes de la baja inclusive (O-30).
* `scheduleHash` = sha256 de la forma canonica del cuadro (claves ordenadas, sin
  espacios, NFC), la misma disciplina de ADR-0011.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from calendar import monthrange
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True   # no ensuciar el repo con __pycache__
OUT = HERE / "cuadros-esperados.json"


# ---------------------------------------------------------------------------
# Aritmetica de meses (sobre la cadena, nunca sobre datetime)
# ---------------------------------------------------------------------------


def month_key(date: str) -> str:
    return date[:7]


def month_index(key: str) -> int:
    return int(key[:4]) * 12 + int(key[5:7]) - 1


def key_from_index(idx: int) -> str:
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def add_months(key: str, n: int) -> str:
    return key_from_index(month_index(key) + n)


def months_between(a: str, b: str) -> int:
    return month_index(b) - month_index(a)


def month_bounds(key: str) -> tuple[str, str]:
    y, m = int(key[:4]), int(key[5:7])
    return f"{key}-01", f"{key}-{monthrange(y, m)[1]:02d}"


# ---------------------------------------------------------------------------
# El cuadro (R-AM-1..R-AM-5)
# ---------------------------------------------------------------------------


def depreciation_schedule(asset: dict[str, Any], revisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if asset["method"] != "LINEAL":
        raise ValueError("solo LINEAL se contabiliza (D2.1)")

    first = month_key(asset["inServiceDate"])
    by_month: dict[str, list[dict[str, Any]]] = {}
    for rev in sorted(revisions, key=lambda r: r["effectiveFrom"]):
        k = month_key(rev["effectiveFrom"])
        by_month.setdefault(max(k, first), []).append(rev)

    cost = asset["acquisitionCostCents"]
    residual = asset["residualValueCents"]
    life = asset["usefulLifeMonths"]
    accumulated = 0
    disposal_month = month_key(asset["disposalDate"]) if asset.get("disposalDate") else None
    if disposal_month is not None and disposal_month < first:
        return []

    rows: list[dict[str, Any]] = []
    month = first
    quota = 0
    for step in range(1200):
        elapsed = months_between(first, month)
        revs = by_month.get(month)
        if revs or step == 0:
            for rev in revs or []:
                if rev.get("addedCostCents"):
                    cost += rev["addedCostCents"]
                if rev.get("newResidualValueCents") is not None:
                    residual = rev["newResidualValueCents"]
                if rev.get("newUsefulLifeMonths") is not None:
                    life = rev["newUsefulLifeMonths"]
            remaining = max(life - elapsed, 1)
            pending = max(cost - accumulated - residual, 0)
            quota = pending // remaining

        last_of_life = add_months(first, life - 1)
        is_last = month >= last_of_life
        pending_now = max(cost - accumulated - residual, 0)
        q = pending_now if is_last else min(quota, pending_now)

        accumulated += q
        frm, to = month_bounds(month)
        rows.append({
            "period": month,
            "from": frm,
            "to": to,
            "quotaCents": q,
            "accumulatedCents": accumulated,
            "netBookValueCents": cost - accumulated,
        })

        if disposal_month is not None and month == disposal_month:
            break
        if is_last:
            break
        month = add_months(month, 1)

    return rows


def canonical(value: Any) -> str:
    """Forma canonica de ADR-0011: claves ordenadas, sin espacios, NFC."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def schedule_hash(rows: list[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical(rows).encode("utf-8")).hexdigest()


def accumulated_through(rows: list[dict[str, Any]], period: str) -> int:
    acc = 0
    for row in rows:
        if row["period"] > period:
            break
        acc = row["accumulatedCents"]
    return acc


# ---------------------------------------------------------------------------
# Baja y venta (R-AM-6, R-AM-7)
# ---------------------------------------------------------------------------


def disposal_lines(asset: dict[str, Any], rows: list[dict[str, Any]], disposal: dict[str, Any]) -> list[dict[str, Any]]:
    month = month_key(disposal["date"])
    accumulated = accumulated_through(rows, month)
    last = rows[-1] if rows else None
    cost = last["netBookValueCents"] + last["accumulatedCents"] if last else asset["acquisitionCostCents"]
    nbv = cost - accumulated

    lines: list[dict[str, Any]] = []

    def push(**line: Any) -> None:
        lines.append({"lineNo": len(lines) + 1, **line})

    if disposal["kind"] == "VENTA":
        price = disposal.get("priceCents", 0)
        vat = disposal.get("vatCents", 0)
        receivable = disposal["receivableAccountCode"]
        if receivable.startswith("430") or receivable.startswith("431"):
            raise ValueError("la contrapartida de la venta de inmovilizado es 543/253, nunca 430 (R-AM-7)")
        push(accountCode=receivable, debitCents=price + vat, creditCents=0,
             description=f"Enajenación {asset['code']}",
             counterpartyId=disposal.get("counterpartyId"), dueDate=disposal.get("dueDate"))
        if accumulated > 0:
            push(accountCode=asset["accumulatedAccountCode"], debitCents=accumulated, creditCents=0,
                 description=f"Cancelación amortización acumulada {asset['code']}", fixedAssetId=asset["id"])
        push(accountCode=asset["assetAccountCode"], debitCents=0, creditCents=cost,
             description=f"Baja del inmovilizado {asset['code']}", fixedAssetId=asset["id"])
        if vat > 0:
            push(accountCode=disposal["vatAccountCode"], debitCents=0, creditCents=vat,
                 description=f"IVA repercutido en la enajenación de {asset['code']}")
        result = price - nbv
        if result > 0:
            push(accountCode=disposal["gainAccountCode"], debitCents=0, creditCents=result,
                 description=f"Beneficio en la enajenación de {asset['code']}",
                 projectId=asset.get("projectId"), costCenterId=asset.get("costCenterId"))
        elif result < 0:
            push(accountCode=disposal["lossAccountCode"], debitCents=-result, creditCents=0,
                 description=f"Pérdida en la enajenación de {asset['code']}",
                 projectId=asset.get("projectId"), costCenterId=asset.get("costCenterId"))
        return lines

    if accumulated > 0:
        push(accountCode=asset["accumulatedAccountCode"], debitCents=accumulated, creditCents=0,
             description=f"Cancelación amortización acumulada {asset['code']}", fixedAssetId=asset["id"])
    if nbv > 0:
        push(accountCode=disposal["lossAccountCode"], debitCents=nbv, creditCents=0,
             description=f"Pérdida por baja de {asset['code']}",
             projectId=asset.get("projectId"), costCenterId=asset.get("costCenterId"))
    push(accountCode=asset["assetAccountCode"], debitCents=0, creditCents=cost,
         description=f"Baja del inmovilizado {asset['code']}", fixedAssetId=asset["id"])
    return lines


def disposal_warnings(asset: dict[str, Any], disposal: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    years = 10 if asset.get("isBuilding") else 5
    elapsed = int(disposal["date"][:4]) - int(asset["inServiceDate"][:4])
    if asset.get("isCapitalGood") and disposal["kind"] == "VENTA" and elapsed < years:
        out.append({
            "code": "ART_110_LIVA_BIEN_INVERSION",
            "message": (
                f"{asset['code']} es bien de inversión (art. 108 LIVA) y se vende dentro del periodo de "
                f"regularización ({years} años desde {asset['inServiceDate']}): procede la regularización ÚNICA "
                "del art. 110 LIVA. El producto no la calcula: consulte con su asesor."
            ),
        })
    if asset.get("isBuilding") and disposal["kind"] == "VENTA":
        out.append({
            "code": "ART_20_UNO_22_EDIFICACION",
            "message": (
                "La entrega de una edificación puede estar exenta (art. 20.Uno.22º LIVA). Decida sobre la renuncia "
                "a la exención y la inversión del sujeto pasivo (art. 84.Uno.2º.e LIVA) antes de repercutir."
            ),
        })
    if disposal["kind"] == "VENTA" and str(disposal.get("receivableAccountCode", "")).startswith("253"):
        out.append({
            "code": "APLAZAMIENTO_MAS_DE_UN_ANO",
            "message": (
                "El crédito por enajenación se ha registrado en 253 (largo plazo): recuerde reclasificar a 543 el "
                "importe que venza dentro de los doce meses siguientes al cierre (norma 6ª de elaboración)."
            ),
        })
    return out


# ---------------------------------------------------------------------------
# Los ocho casos
# ---------------------------------------------------------------------------


def asset(code: str, **over: Any) -> dict[str, Any]:
    base = {
        "id": f"fa-{code.lower()}",
        "code": code,
        "name": code,
        "method": "LINEAL",
        "inServiceDate": "2026-01-01",
        "acquisitionCostCents": 0,
        "residualValueCents": 0,
        "usefulLifeMonths": 12,
        "assetAccountCode": "2131",
        "accumulatedAccountCode": "2811",
        "expenseAccountCode": "6813",
        "status": "EN_USO",
        "disposalDate": None,
        "isCapitalGood": False,
        "isBuilding": False,
        "projectId": None,
        "costCenterId": None,
    }
    base.update(over)
    return base


CASES: list[dict[str, Any]] = [
    {
        "id": "C1",
        "titulo": "Base indivisible sin residual: 1.000.000 / 7 meses, residuo de 1 a la última cuota (R-AM-2)",
        "asset": asset("AM-C1", acquisitionCostCents=1_000_000, usefulLifeMonths=7, inServiceDate="2026-01-10"),
        "revisions": [],
        "disposal": None,
    },
    {
        "id": "C2",
        "titulo": "Valor residual > 0: base 900.000 / 7 meses; última cuota 128.574 (criterio 5 de §12)",
        "asset": asset("AM-C2", acquisitionCostCents=1_000_000, residualValueCents=100_000,
                       usefulLifeMonths=7, inServiceDate="2026-03-01"),
        "revisions": [],
        "disposal": None,
    },
    {
        "id": "C3",
        "titulo": "Alta a mitad de mes: mes entero desde la puesta en servicio, no prorrateo (R-AM-3, O-30)",
        "asset": asset("AM-C3", acquisitionCostCents=600_000, usefulLifeMonths=12, inServiceDate="2026-03-17"),
        "revisions": [],
        "disposal": None,
    },
    {
        "id": "C4",
        "titulo": "Revisión prospectiva de vida útil en el mes 20: 36 → 48 meses, el pasado no se toca (R-AM-5)",
        "asset": asset("AM-C4", acquisitionCostCents=3_600_000, usefulLifeMonths=36, inServiceDate="2026-01-01"),
        "revisions": [{"effectiveFrom": "2027-08-01", "newUsefulLifeMonths": 48,
                       "newResidualValueCents": None, "addedCostCents": None,
                       "reason": "Ampliación de la vida útil estimada tras la revisión técnica"}],
        "disposal": None,
    },
    {
        "id": "C5",
        "titulo": "Mejora capitalizada de 300.000 en el mes 7: base = coste + mejoras − residual (R-AM-1, O-28)",
        "asset": asset("AM-C5", acquisitionCostCents=1_200_000, usefulLifeMonths=24, inServiceDate="2026-01-01"),
        "revisions": [{"effectiveFrom": "2026-07-01", "newUsefulLifeMonths": None,
                       "newResidualValueCents": None, "addedCostCents": 300_000,
                       "reason": "Mejora capitalizada que amplía la capacidad del elemento"}],
        "disposal": None,
    },
    {
        "id": "C6",
        "titulo": "Baja en el mes 14: se dota hasta el mes de la baja inclusive y el VNC va a 671 (R-AM-6)",
        "asset": asset("AM-C6", acquisitionCostCents=1_000_000, usefulLifeMonths=60,
                       inServiceDate="2026-01-01", disposalDate="2027-02-10", status="BAJA"),
        "revisions": [],
        "disposal": {"kind": "BAJA", "date": "2027-02-10", "lossAccountCode": "671"},
    },
    {
        "id": "C7",
        "titulo": "Venta con 543 e IVA: acumulada 640.000, beneficio 140.000 en 771 (criterio 7 de §12, R-AM-7)",
        "asset": asset("AM-C7", acquisitionCostCents=1_000_000, usefulLifeMonths=25,
                       inServiceDate="2026-01-01", disposalDate="2027-04-20", status="VENDIDO",
                       isCapitalGood=True),
        "revisions": [],
        "disposal": {"kind": "VENTA", "date": "2027-04-20", "priceCents": 500_000, "vatCents": 105_000,
                     "receivableAccountCode": "543", "vatAccountCode": "477",
                     "gainAccountCode": "771", "lossAccountCode": "671",
                     "counterpartyId": None, "dueDate": "2027-05-20"},
    },
    {
        "id": "C8",
        "titulo": "base < n (O-22): 20 céntimos y 36 meses; 35 cuotas de 0 y la última de 20 (R-REC-8)",
        "asset": asset("AM-C8", acquisitionCostCents=20, usefulLifeMonths=36, inServiceDate="2026-01-01"),
        "revisions": [],
        "disposal": None,
    },
]


def build() -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []

    for case in CASES:
        a = case["asset"]
        revisions = case["revisions"]
        rows = depreciation_schedule(a, revisions)
        added = sum(r.get("addedCostCents") or 0 for r in revisions)
        residual = a["residualValueCents"]
        for rev in sorted(revisions, key=lambda r: r["effectiveFrom"]):
            if rev.get("newResidualValueCents") is not None:
                residual = rev["newResidualValueCents"]
        total = sum(r["quotaCents"] for r in rows)

        entry: dict[str, Any] = {
            "id": case["id"],
            "titulo": case["titulo"],
            "asset": a,
            "revisions": revisions,
            "rows": rows,
            "totals": {
                "quotaCents": total,
                "rowCount": len(rows),
                "zeroQuotaRows": sum(1 for r in rows if r["quotaCents"] == 0),
                "lastQuotaCents": rows[-1]["quotaCents"] if rows else 0,
                "amortizableBaseCents": a["acquisitionCostCents"] + added - residual,
            },
            "scheduleHash": schedule_hash(rows),
            "disposal": case["disposal"],
            "disposalLines": disposal_lines(a, rows, case["disposal"]) if case["disposal"] else [],
            "disposalWarnings": disposal_warnings(a, case["disposal"]) if case["disposal"] else [],
        }
        cases.append(entry)

        # I-E9-4 (O-28): Sigma cuotas = coste + Sigma mejoras - residual vigente,
        # salvo cuando la baja corta el cuadro antes del fin de la vida util.
        if not a.get("disposalDate"):
            checks.append({
                "id": f"I-E9-4/{case['id']}",
                "expected": entry["totals"]["amortizableBaseCents"],
                "actual": total,
                "status": "PASS" if total == entry["totals"]["amortizableBaseCents"] else "FAIL",
            })
        # R-AM-4: ninguna cuota negativa y la acumulada nunca supera la base.
        checks.append({
            "id": f"R-AM-4/{case['id']}",
            "expected": 0,
            "actual": sum(1 for r in rows if r["quotaCents"] < 0),
            "status": "PASS" if all(r["quotaCents"] >= 0 for r in rows) else "FAIL",
        })
        # Partida doble de la baja/venta (I1).
        if entry["disposalLines"]:
            debit = sum(line["debitCents"] for line in entry["disposalLines"])
            credit = sum(line["creditCents"] for line in entry["disposalLines"])
            checks.append({
                "id": f"I1/{case['id']}",
                "expected": debit,
                "actual": credit,
                "status": "PASS" if debit == credit else "FAIL",
            })

    # Los tres numeros que la validacion contable fijo a mano.
    c2 = next(c for c in cases if c["id"] == "C2")
    checks.append({"id": "Q-2/ultima-cuota-128574", "expected": 128_574,
                   "actual": c2["totals"]["lastQuotaCents"],
                   "status": "PASS" if c2["totals"]["lastQuotaCents"] == 128_574 else "FAIL"})
    c7 = next(c for c in cases if c["id"] == "C7")
    acc7 = accumulated_through(c7["rows"], "2027-04")
    checks.append({"id": "criterio-7/acumulada-640000", "expected": 640_000, "actual": acc7,
                   "status": "PASS" if acc7 == 640_000 else "FAIL"})
    gain = next((line["creditCents"] for line in c7["disposalLines"] if line["accountCode"] == "771"), 0)
    checks.append({"id": "criterio-7/beneficio-140000", "expected": 140_000, "actual": gain,
                   "status": "PASS" if gain == 140_000 else "FAIL"})
    c8 = next(c for c in cases if c["id"] == "C8")
    checks.append({"id": "O-22/cuota-cero", "expected": 35, "actual": c8["totals"]["zeroQuotaRows"],
                   "status": "PASS" if c8["totals"]["zeroQuotaRows"] == 35 else "FAIL"})

    return {
        "fixture": "cuadros-esperados",
        "epica": "E9",
        "tarea": "T6",
        "reglas": "R-AM-1..R-AM-10 (docs/design/E9-cierre-recurrentes.md §4.2, ADR-0016 D2)",
        "cases": cases,
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
        print("OK: cuadros-esperados.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    for case in data["cases"]:
        t = case["totals"]
        print(f"  {case['id']}  filas={t['rowCount']:>3}  Sigma={t['quotaCents']:>10,}  "
              f"ultima={t['lastQuotaCents']:>8,}  cuotas0={t['zeroQuotaRows']:>2}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
