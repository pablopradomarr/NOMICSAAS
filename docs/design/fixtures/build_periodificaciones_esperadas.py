#!/usr/bin/env python3
"""
E9 - Generador de las PERIODIFICACIONES esperadas (T7).

    python3 docs/design/fixtures/build_periodificaciones_esperadas.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), los cuadros de
devengo de `docs/design/E9-cierre-recurrentes.md` §4.3 (R-PE-1..R-PE-6, ADR-0016 D3):

    P1  prima 100.000 del 15-11-2026 al 14-11-2027, ACT/ACT anual  -> 12.876 / 87.124
        (criterio 9 de §12 y ejemplo de Q-6 de la validacion contable)
    P2  la misma prima, mensual: el saldo de 480 queda en CERO exacto
    P3  MESES con pesos iguales y residuo a la ultima fila (R-PE-2)
    P4  ingreso anticipado 485 por trimestres (R-PE-5)
    P5  567 con basis = DIAS, horizonte > 12 meses y principal decreciente -> WARN
        con la desviacion estimada (R-PE-6, O-25)
    P6  el mismo prestamo con basis = TIPO_EFECTIVO: el devengo lo aporta el cuadro
    P7  base < n (O-22): 20 centimos en 36 meses -> 35 cuotas de 0 y la ultima de 20
    P8  cancelacion anticipada (R-PE-4): el pendiente se devenga en el periodo de la
        cancelacion, nunca se borra
    P9  ano bisiesto: 366 dias con el 29-feb dentro (caso limite obligatorio)

Escribe `docs/design/fixtures/periodificaciones-esperadas.json`. Con `--check` no
escribe: reconstruye y compara byte a byte. `lib/closing/accrual.test.ts` hace la
comparacion contraria desde TypeScript.

Convenciones
------------
* Centimos ENTEROS; `trunc` y residuo a la ULTIMA fila (nunca mayor resto).
* ACT/ACT, dias naturales, AMBOS EXTREMOS INCLUIDOS: del 15-11-2026 al 14-11-2027
  hay 365 dias, no 364. No existe norma contable que imponga 30/360.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from calendar import monthrange
from datetime import date
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
OUT = HERE / "periodificaciones-esperadas.json"

MONTHS_PER_PERIOD = {"MENSUAL": 1, "TRIMESTRAL": 3, "SEMESTRAL": 6, "ANUAL": 12}


# ---------------------------------------------------------------------------
# Periodos
# ---------------------------------------------------------------------------


def period_key_of(d: str, freq: str) -> str:
    y, m = int(d[:4]), int(d[5:7])
    if freq == "MENSUAL":
        return d[:7]
    if freq == "TRIMESTRAL":
        return f"{y}-Q{(m - 1) // 3 + 1}"
    if freq == "SEMESTRAL":
        return f"{y}-S{1 if m <= 6 else 2}"
    return str(y)


def parse_key(key: str, freq: str) -> tuple[int, int]:
    if freq == "MENSUAL":
        return int(key[:4]), int(key[5:7])
    if freq == "ANUAL":
        return int(key[:4]), 1
    return int(key[:4]), int(key[-1])


def period_index(key: str, freq: str) -> int:
    y, ordinal = parse_key(key, freq)
    return y * (12 // MONTHS_PER_PERIOD[freq]) + ordinal - 1


def key_from_index(idx: int, freq: str) -> str:
    per_year = 12 // MONTHS_PER_PERIOD[freq]
    y, ordinal = idx // per_year, idx % per_year + 1
    if freq == "MENSUAL":
        return f"{y:04d}-{ordinal:02d}"
    if freq == "TRIMESTRAL":
        return f"{y:04d}-Q{ordinal}"
    if freq == "SEMESTRAL":
        return f"{y:04d}-S{ordinal}"
    return f"{y:04d}"


def period_bounds(key: str, freq: str) -> tuple[str, str]:
    y, ordinal = parse_key(key, freq)
    span = MONTHS_PER_PERIOD[freq]
    first = ordinal if freq == "MENSUAL" else (ordinal - 1) * span + 1
    last = first + span - 1
    return f"{y:04d}-{first:02d}-01", f"{y:04d}-{last:02d}-{monthrange(y, last)[1]:02d}"


def days_inclusive(frm: str, to: str) -> int:
    n = (date.fromisoformat(to) - date.fromisoformat(frm)).days + 1
    return n if n > 0 else 0


# ---------------------------------------------------------------------------
# El cuadro (R-PE-1..R-PE-6)
# ---------------------------------------------------------------------------

INTEREST_KINDS = ("INTERESES_PAGADOS_ANTICIPADO", "INTERESES_COBRADOS_ANTICIPADO")


def has_decreasing_principal(installments: list[dict[str, Any]] | None) -> bool:
    if not installments or len(installments) < 2:
        return False
    ordered = sorted(installments, key=lambda i: i["seq"])
    return any(inst["interestCents"] < ordered[i - 1]["interestCents"] for i, inst in enumerate(ordered) if i > 0)


def linear_vs_effective_deviation(rows: list[dict[str, Any]], installments: list[dict[str, Any]] | None) -> int | None:
    if not installments:
        return None
    linear = effective = worst = 0
    for row in rows:
        linear += row["quotaCents"]
        effective += sum(i["interestCents"] for i in installments if row["from"] <= i["dueDate"] <= row["to"])
        worst = max(worst, abs(linear - effective))
    return worst


def accrual_schedule(accrual: dict[str, Any], freq: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    warnings: list[dict[str, Any]] = []
    first = period_index(period_key_of(accrual["periodStart"], freq), freq)
    last = period_index(period_key_of(accrual["periodEnd"], freq), freq)
    cancel = period_index(accrual["cancelledAtPeriod"], freq) if accrual.get("cancelledAtPeriod") else None
    end = cancel if cancel is not None and cancel < last else last

    # El reparto se calcula sobre el intervalo COMPLETO y solo despues se recorta
    # en la cancelacion (R-PE-4): repartir sobre el intervalo recortado cambiaria
    # las cuotas ya contabilizadas.
    slots: list[dict[str, Any]] = []
    for i in range(first, last + 1):
        key = key_from_index(i, freq)
        start, stop = period_bounds(key, freq)
        frm = max(start, accrual["periodStart"])
        to = min(stop, accrual["periodEnd"])
        slots.append({"key": key, "from": frm, "to": to, "days": days_inclusive(frm, to)})
    if not slots:
        return [], warnings

    total_days = days_inclusive(accrual["periodStart"], accrual["periodEnd"])
    installments = accrual.get("debtInstallments") or []

    if accrual["basis"] == "TIPO_EFECTIVO":
        if not installments:
            warnings.append({
                "code": "SIN_CUADRO_DE_DEUDA",
                "severity": "ERROR",
                "message": (
                    f"{accrual['code']} declara basis = TIPO_EFECTIVO y no aporta el cuadro de la deuda: el devengo "
                    "por tipo efectivo lo dicta el cuadro del préstamo (R-PE-6), no un reparto lineal."
                ),
            })
            return [], warnings
        quotas = [sum(i["interestCents"] for i in installments if s["from"] <= i["dueDate"] <= s["to"]) for s in slots]
        covered = sum(quotas)
        if covered != accrual["totalCents"]:
            warnings.append({
                "code": "CUADRO_NO_CUBRE_EL_INTERVALO",
                "severity": "WARN",
                "message": (
                    f"El cuadro de la deuda devenga {covered} céntimos en "
                    f"[{accrual['periodStart']}, {accrual['periodEnd']}] y la periodificación declara "
                    f"{accrual['totalCents']}: manda el cuadro."
                ),
                "deviationCents": accrual["totalCents"] - covered,
            })
    else:
        weights = [s["days"] for s in slots] if accrual["basis"] == "DIAS" else [1] * len(slots)
        denominator = total_days if accrual["basis"] == "DIAS" else sum(weights)
        quotas = [(accrual["totalCents"] * w) // denominator if denominator > 0 else 0 for w in weights]
        quotas[-1] += accrual["totalCents"] - sum(quotas)

    kept_slots = slots
    if end < last:
        keep = end - first + 1
        kept_slots = slots[:keep]
        quotas = quotas[:keep]
        remaining = accrual["totalCents"] - sum(quotas)
        if remaining != 0:
            quotas[-1] += remaining
            warnings.append({
                "code": "CANCELACION_ANTICIPADA",
                "severity": "WARN",
                "message": (
                    f"{accrual['code']} se cancela en {accrual['cancelledAtPeriod']}: se devengan {remaining} "
                    "céntimos pendientes en ese periodo (R-PE-4)."
                ),
                "deviationCents": remaining,
            })

    rows: list[dict[str, Any]] = []
    pending = accrual["totalCents"]
    for slot, quota in zip(kept_slots, quotas):
        pending -= quota
        rows.append({
            "period": slot["key"], "from": slot["from"], "to": slot["to"], "days": slot["days"],
            "quotaCents": quota, "pendingCents": pending,
        })

    zeros = sum(1 for r in rows if r["quotaCents"] == 0)
    if zeros:
        warnings.append({
            "code": "CUOTA_CERO",
            "severity": "WARN",
            "message": (
                f"{accrual['code']} tiene {zeros} periodo(s) con cuota 0: no generan asiento (R-REC-8/O-22) y la "
                "ocurrencia queda OMITIDA con motivo CUOTA_CERO."
            ),
        })

    if accrual["kind"] in INTEREST_KINDS and accrual["basis"] == "DIAS":
        decreasing = has_decreasing_principal(installments)
        if decreasing or total_days > 366:
            warning: dict[str, Any] = {
                "code": "DIAS_SOBRE_INTERESES",
                "severity": "WARN",
                "message": (
                    f"{accrual['code']} devenga intereses ({accrual['kind']}) por reparto lineal de días sobre un "
                    f"horizonte de {total_days} días{' y principal decreciente' if decreasing else ''}. Los intereses "
                    "se devengan por tipo de interés efectivo sobre el coste amortizado (NRV 9ª.2.2 y 9ª.3.1): use "
                    "basis = TIPO_EFECTIVO con el cuadro del préstamo."
                ),
            }
            deviation = linear_vs_effective_deviation(rows, installments)
            if deviation is not None:
                warning["deviationCents"] = deviation
            warnings.append(warning)

    return rows, warnings


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def schedule_hash(rows: list[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical(rows).encode("utf-8")).hexdigest()


def period_lines(accrual: dict[str, Any], row: dict[str, Any]) -> list[dict[str, Any]]:
    """R-PE-3: el asiento de devengo del periodo. Cuota 0 no genera asiento."""
    if row["quotaCents"] <= 0:
        return []
    amount = row["quotaCents"]
    description = f"{accrual.get('name') or accrual['code']} · devengo {row['period']}"
    analytic = {"projectId": accrual.get("projectId"), "costCenterId": accrual.get("costCenterId")}
    if accrual["kind"] in ("GASTO_ANTICIPADO", "INTERESES_PAGADOS_ANTICIPADO"):
        return [
            {"lineNo": 1, "accountCode": accrual["pnlAccountCode"], "debitCents": amount, "creditCents": 0,
             "description": description, **analytic},
            {"lineNo": 2, "accountCode": accrual["accrualAccountCode"], "debitCents": 0, "creditCents": amount,
             "description": description},
        ]
    return [
        {"lineNo": 1, "accountCode": accrual["accrualAccountCode"], "debitCents": amount, "creditCents": 0,
         "description": description},
        {"lineNo": 2, "accountCode": accrual["pnlAccountCode"], "debitCents": 0, "creditCents": amount,
         "description": description, **analytic},
    ]


# ---------------------------------------------------------------------------
# Los nueve casos
# ---------------------------------------------------------------------------


# Prestamo de 4 cuotas trimestrales con principal DECRECIENTE: los intereses
# bajan cuota a cuota, que es justo lo que el reparto lineal no sabe reflejar.
PRESTAMO = [
    {"seq": 1, "dueDate": "2026-03-31", "principalCents": 2_500_000, "interestCents": 100_000},
    {"seq": 2, "dueDate": "2026-06-30", "principalCents": 2_500_000, "interestCents": 75_000},
    {"seq": 3, "dueDate": "2026-09-30", "principalCents": 2_500_000, "interestCents": 50_000},
    {"seq": 4, "dueDate": "2026-12-31", "principalCents": 2_500_000, "interestCents": 25_000},
]


def accrual(code: str, **over: Any) -> dict[str, Any]:
    base = {
        "id": f"ac-{code.lower()}",
        "code": code,
        "name": code,
        "kind": "GASTO_ANTICIPADO",
        "accrualAccountCode": "480",
        "pnlAccountCode": "625",
        "totalCents": 0,
        "periodStart": "2026-01-01",
        "periodEnd": "2026-12-31",
        "basis": "DIAS",
        "debtInstallments": None,
        "cancelledAtPeriod": None,
        "projectId": None,
        "costCenterId": None,
    }
    base.update(over)
    return base


CASES: list[dict[str, Any]] = [
    {
        "id": "P1",
        "titulo": "Prima 100.000 del 15-11-2026 al 14-11-2027, ACT/ACT anual: 12.876 / 87.124 (criterio 9)",
        "freq": "ANUAL",
        "accrual": accrual("PE-P1", totalCents=100_000, periodStart="2026-11-15", periodEnd="2027-11-14"),
    },
    {
        "id": "P2",
        "titulo": "La misma prima repartida por meses: el saldo de 480 queda en CERO exacto (R-PE-2)",
        "freq": "MENSUAL",
        "accrual": accrual("PE-P2", totalCents=100_000, periodStart="2026-11-15", periodEnd="2027-11-14"),
    },
    {
        "id": "P3",
        "titulo": "MESES con pesos iguales: 100.000 / 12 y residuo de 4 a la última fila (R-PE-2)",
        "freq": "MENSUAL",
        "accrual": accrual("PE-P3", totalCents=100_000, basis="MESES"),
    },
    {
        "id": "P4",
        "titulo": "Ingreso anticipado 485 contra 705 por trimestres (R-PE-5)",
        "freq": "TRIMESTRAL",
        "accrual": accrual("PE-P4", kind="INGRESO_ANTICIPADO", accrualAccountCode="485", pnlAccountCode="705",
                           totalCents=1_000_000, basis="MESES"),
    },
    {
        "id": "P5",
        "titulo": "567 por DIAS con principal decreciente: WARN con la desviación estimada (R-PE-6, O-25)",
        "freq": "TRIMESTRAL",
        "accrual": accrual("PE-P5", kind="INTERESES_PAGADOS_ANTICIPADO", accrualAccountCode="567",
                           pnlAccountCode="662", totalCents=250_000, basis="DIAS", debtInstallments=PRESTAMO),
    },
    {
        "id": "P6",
        "titulo": "El mismo préstamo con basis = TIPO_EFECTIVO: el devengo lo aporta el cuadro (R-PE-6)",
        "freq": "TRIMESTRAL",
        "accrual": accrual("PE-P6", kind="INTERESES_PAGADOS_ANTICIPADO", accrualAccountCode="567",
                           pnlAccountCode="662", totalCents=250_000, basis="TIPO_EFECTIVO",
                           debtInstallments=PRESTAMO),
    },
    {
        "id": "P7",
        "titulo": "base < n (O-22): 20 céntimos en 36 meses; 35 cuotas de 0 y la última de 20 (R-REC-8)",
        "freq": "MENSUAL",
        "accrual": accrual("PE-P7", totalCents=20, basis="MESES", periodStart="2026-01-01", periodEnd="2028-12-31"),
    },
    {
        "id": "P8",
        "titulo": "Cancelación anticipada en 2026-05: el pendiente se devenga en ese periodo (R-PE-4)",
        "freq": "MENSUAL",
        "accrual": accrual("PE-P8", totalCents=120_000, basis="MESES", cancelledAtPeriod="2026-05"),
    },
    {
        "id": "P9",
        "titulo": "Año bisiesto: 366 días con el 29-feb dentro, ACT/ACT mensual (caso límite)",
        "freq": "MENSUAL",
        "accrual": accrual("PE-P9", totalCents=366_000, periodStart="2028-01-01", periodEnd="2028-12-31"),
    },
]


def build() -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []

    for case in CASES:
        a = case["accrual"]
        rows, warnings = accrual_schedule(a, case["freq"])
        total = sum(r["quotaCents"] for r in rows)
        entry = {
            "id": case["id"],
            "titulo": case["titulo"],
            "freq": case["freq"],
            "accrual": a,
            "rows": rows,
            "warnings": warnings,
            "totals": {
                "quotaCents": total,
                "rowCount": len(rows),
                "zeroQuotaRows": sum(1 for r in rows if r["quotaCents"] == 0),
                "lastPendingCents": rows[-1]["pendingCents"] if rows else a["totalCents"],
                "totalDays": days_inclusive(a["periodStart"], a["periodEnd"]),
            },
            "scheduleHash": schedule_hash(rows),
            "firstEntryLines": period_lines(a, rows[0]) if rows else [],
        }
        cases.append(entry)

        # R-PE-2: la cuenta de periodificacion queda en CERO exacto.
        if rows and a["basis"] != "TIPO_EFECTIVO":
            checks.append({"id": f"R-PE-2/{case['id']}", "expected": 0, "actual": rows[-1]["pendingCents"],
                           "status": "PASS" if rows[-1]["pendingCents"] == 0 else "FAIL"})
            checks.append({"id": f"Sigma/{case['id']}", "expected": a["totalCents"], "actual": total,
                           "status": "PASS" if total == a["totalCents"] else "FAIL"})

    p1 = next(c for c in cases if c["id"] == "P1")
    checks.append({"id": "criterio-9/2026", "expected": 12_876, "actual": p1["rows"][0]["quotaCents"],
                   "status": "PASS" if p1["rows"][0]["quotaCents"] == 12_876 else "FAIL"})
    checks.append({"id": "criterio-9/2027", "expected": 87_124, "actual": p1["rows"][1]["quotaCents"],
                   "status": "PASS" if p1["rows"][1]["quotaCents"] == 87_124 else "FAIL"})
    checks.append({"id": "Q-6/365-dias", "expected": 365, "actual": p1["totals"]["totalDays"],
                   "status": "PASS" if p1["totals"]["totalDays"] == 365 else "FAIL"})
    p5 = next(c for c in cases if c["id"] == "P5")
    warn5 = [w["code"] for w in p5["warnings"]]
    checks.append({"id": "O-25/warn-dias-sobre-intereses", "expected": 1, "actual": warn5.count("DIAS_SOBRE_INTERESES"),
                   "status": "PASS" if "DIAS_SOBRE_INTERESES" in warn5 else "FAIL"})
    p7 = next(c for c in cases if c["id"] == "P7")
    checks.append({"id": "O-22/cuota-cero", "expected": 35, "actual": p7["totals"]["zeroQuotaRows"],
                   "status": "PASS" if p7["totals"]["zeroQuotaRows"] == 35 else "FAIL"})
    p9 = next(c for c in cases if c["id"] == "P9")
    feb = next(r for r in p9["rows"] if r["period"] == "2028-02")
    checks.append({"id": "bisiesto/29-feb", "expected": 29, "actual": feb["days"],
                   "status": "PASS" if feb["days"] == 29 else "FAIL"})

    return {
        "fixture": "periodificaciones-esperadas",
        "epica": "E9",
        "tarea": "T7",
        "reglas": "R-PE-1..R-PE-6 (docs/design/E9-cierre-recurrentes.md §4.3, ADR-0016 D3)",
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
        print("OK: periodificaciones-esperadas.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    for case in data["cases"]:
        t = case["totals"]
        print(f"  {case['id']}  filas={t['rowCount']:>3}  Sigma={t['quotaCents']:>9,}  "
              f"pendiente={t['lastPendingCents']:>7,}  avisos={[w['code'] for w in case['warnings']]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
