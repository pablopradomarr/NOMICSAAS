#!/usr/bin/env python3
"""
E9 - Generador del VALOR ACTUAL esperado (T9).

    python3 docs/design/fixtures/build_valor_actual_esperado.py [--check]

Calcula, SIN usar `lib/` (ni TypeScript, ni Prisma, ni la BD), el valor actual del
aplazamiento y su cuadro de interes implicito segun
`docs/design/E9-cierre-recurrentes.md` §4.7 (R-VA-1..R-VA-6, ADR-0016 D7):

    V1  caso A del experto: nominal 10.000.000 a 24 meses con el tipo MENSUAL
        equivalente al 6 % efectivo anual -> valor actual 8.899.964, descuento
        1.100.036; con 10 meses amortizados sobre el coste bruto y vida util 60,
        el exceso dotado es 183.340 (criterio 22 de §12)
    V2  el mismo nominal con i_m = i_a / 12 = 0,5 % (TIN): valor actual distinto.
        Es la prueba numerica de O-2: interpretar el 6 % como efectivo o como
        nominal NO da lo mismo, y por eso el tipo se DECLARA mensual
    V3  aplazamiento de 18 meses del lado ACTIVO (253, credito por enajenacion de
        inmovilizado): su interes implicito es INGRESO en 762 (O-3)
    V4  aplazamiento de 12 meses: NO se descuenta (R-VA-2, la frontera es > 12)
    V5  descuento por debajo del umbral de materialidad: no se descuenta
    V6  tipo mensual 0: el valor actual es el nominal y el cuadro es todo ceros
    V7  Sigma intereses = descuento inicial con tolerancia 0 y el pasivo vale su
        NOMINAL a vencimiento (I-E9-19), con la ULTIMA cuota como cuadre

Escribe `docs/design/fixtures/valor-actual-esperado.json`. Con `--check` no
escribe: reconstruye y compara byte a byte. `lib/closing/present-value.test.ts`
hace la comparacion contraria desde TypeScript.

Convenciones
------------
* Centimos ENTEROS. Aritmetica en punto fijo de escala 10^10, que es la unidad
  nativa del micro-punto-basico (1 micro-bps = 10^-10): el diseno la describe como
  "base 10^9", pero en 10^9 el tipo pierde su ultimo digito y el resultado dejaria
  de ser reproducible byte a byte.
* Truncamiento hacia cero en CADA multiplicacion y en un orden FIJO. Nada de
  `Math.pow` ni de raices duodecimas: el tipo ya viene mensual.
* El interes de la ULTIMA cuota es el que cuadra: `nominal - valor contable
  anterior`. Asi `Sigma intereses = descuento` con tolerancia 0 (I-E9-19).

Nota contable abierta (para el experto-contable)
------------------------------------------------
El ejemplo del experto cita, para el caso A, un interes implicito de 454.133 c en
diez meses. La cadena entera de este fixture -y la de `lib/closing/present-value.ts`,
que es la misma- da 442.817 c partiendo del valor actual 8.899.964 que el propio
ejemplo fija. Los otros tres numeros del ejemplo (8.899.964, 1.100.036 y 183.340)
se reproducen EXACTAMENTE. La diferencia procede de la tasa con la que se devenga:
442.817 es el devengo por tipo efectivo mensual coherente con ese valor actual
(1,06^(1/12)-1), mientras que 454.133 se aproxima al que sale de aplicar 0,5 %
mensual sobre 8.899.964, que es un tipo distinto del que se uso para descontar.
Se deja anotado aqui y en el modulo: el fixture manda, y el numero del ejemplo
queda pendiente de confirmacion.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
OUT = HERE / "valor-actual-esperado.json"

SCALE = 10 ** 10  # 1 micro-bps = 10^-10

# Tipo mensual equivalente al 6 % EFECTIVO anual, en micro-bps: (1,06^(1/12)-1)*10^10.
I_M_6_EFECTIVO = 48_675_506
# Tipo mensual de un 6 % NOMINAL (TIN): 0,5 % = 0,005 * 10^10.
I_M_6_NOMINAL = 50_000_000


# ---------------------------------------------------------------------------
# Aritmetica entera en punto fijo (la MISMA cadena que lib/closing/present-value.ts)
# ---------------------------------------------------------------------------


def compound_factor(monthly_micro_bps: int, months: int) -> int:
    """(1 + i)^months en punto fijo 10^10, truncando en CADA multiplicacion."""
    factor = SCALE + monthly_micro_bps
    acc = SCALE
    for _ in range(months):
        acc = acc * factor // SCALE
    return acc


def present_value(nominal_cents: int, monthly_micro_bps: int, months: int) -> int:
    return nominal_cents * SCALE // compound_factor(monthly_micro_bps, months)


def next_month(period: str) -> str:
    total = int(period[:4]) * 12 + int(period[5:7])
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def interest_schedule(
    nominal_cents: int, pv_cents: int, months: int, monthly_micro_bps: int, first_period: str
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    carrying = pv_cents
    period = first_period
    for m in range(1, months + 1):
        interest = nominal_cents - carrying if m == months else carrying * monthly_micro_bps // SCALE
        carrying += interest
        rows.append({"period": period, "interestCents": interest, "carryingCents": carrying})
        period = next_month(period)
    return rows


def straight_line(cost_cents: int, months: int) -> list[int]:
    """Cuadro lineal con residuo a la ULTIMA cuota (R-AM-2), residual 0."""
    quota = cost_cents // months
    rows = [quota] * months
    rows[-1] = cost_cents - quota * (months - 1)
    return rows


# ---------------------------------------------------------------------------
# Casos
# ---------------------------------------------------------------------------


def case(
    cid: str,
    titulo: str,
    nominal: int,
    monthly: int,
    months: int,
    first_period: str,
    side: str,
    materiality: int,
) -> dict[str, Any]:
    pv = present_value(nominal, monthly, months)
    discount = nominal - pv
    rows = interest_schedule(nominal, pv, months, monthly, first_period)
    aplica = months > 12 and abs(discount) >= materiality
    return {
        "id": cid,
        "titulo": titulo,
        "input": {
            "nominalCents": nominal,
            "monthlyRateMicroBps": monthly,
            "months": months,
            "firstPeriod": first_period,
            "side": side,
            "materialityCents": materiality,
        },
        "presentValueCents": pv,
        "discountCents": discount,
        "annualEquivalentMicroBps": compound_factor(monthly, 12) - SCALE,
        "requiresPresentValue": aplica,
        "interestAccount": "662" if side == "PASIVO" else "762",
        "rows": rows,
        "totals": {
            "rowCount": len(rows),
            "interestCents": sum(r["interestCents"] for r in rows),
            "finalCarryingCents": rows[-1]["carryingCents"],
        },
    }


def build() -> dict[str, Any]:
    cases = [
        case("V1", "Caso A del experto: 10.000.000 a 24 meses al 6 % EFECTIVO anual (tipo mensual)",
             10_000_000, I_M_6_EFECTIVO, 24, "2026-03", "PASIVO", 100_000),
        case("V2", "El mismo nominal con i_m = 6 %/12 = 0,5 % (TIN): O-2, no da lo mismo",
             10_000_000, I_M_6_NOMINAL, 24, "2026-03", "PASIVO", 100_000),
        case("V3", "Lado ACTIVO: credito 253 por enajenacion a 18 meses; el interes es INGRESO en 762 (O-3)",
             4_500_000, I_M_6_EFECTIVO, 18, "2026-07", "ACTIVO", 100_000),
        case("V4", "Aplazamiento de 12 meses: NO se descuenta (la frontera es > 12, R-VA-2)",
             3_000_000, I_M_6_EFECTIVO, 12, "2026-01", "PASIVO", 1_000),
        case("V5", "Descuento por debajo del umbral de materialidad: no se descuenta",
             50_000, I_M_6_EFECTIVO, 24, "2026-01", "PASIVO", 100_000),
        case("V6", "Tipo mensual 0: el valor actual es el nominal y el cuadro es todo ceros",
             1_000_000, 0, 24, "2026-01", "PASIVO", 1),
        case("V7", "Un mes de mas para ver el cuadre de la ULTIMA cuota (I-E9-19)",
             7_777_777, I_M_6_EFECTIVO, 25, "2026-12", "PASIVO", 1_000),
    ]

    # Caso A completo: el activo, su cuadro bruto y el recalculado con el coste
    # corregido. El exceso dotado es la diferencia de acumuladas a los 10 meses.
    v1 = cases[0]
    cost = 10_000_000
    life = 60
    posted_months = 10
    gross = straight_line(cost, life)
    corrected = straight_line(cost - v1["discountCents"], life)
    excess = sum(gross[:posted_months]) - sum(corrected[:posted_months])
    caso_a = {
        "id": "A1",
        "titulo": "Caso A: correccion dentro del ejercicio, con recalculo del cuadro y reversion del exceso",
        "assetCostCents": cost,
        "usefulLifeMonths": life,
        "postedMonths": posted_months,
        "discountCents": v1["discountCents"],
        "correctedCostCents": cost - v1["discountCents"],
        "grossAccumulatedCents": sum(gross[:posted_months]),
        "correctedAccumulatedCents": sum(corrected[:posted_months]),
        "excessDepreciationCents": excess,
        "accruedInterestCents": sum(r["interestCents"] for r in v1["rows"][:posted_months]),
        "nota": (
            "No se crea AssetRevision: una revision es un cambio de estimacion (prospectivo) y esto "
            "es la correccion de un error (retroactiva), D7.2 de ADR-0016"
        ),
    }

    checks = [
        {
            "id": "I-E9-19",
            "descripcion": "Sigma intereses = descuento inicial, y a vencimiento el pasivo vale su nominal",
            "expected": [c["discountCents"] for c in cases],
            "actual": [c["totals"]["interestCents"] for c in cases],
            "status": "PASS"
            if all(c["discountCents"] == c["totals"]["interestCents"] for c in cases)
            else "FAIL",
        },
        {
            "id": "NOMINAL_A_VENCIMIENTO",
            "descripcion": "El valor contable final es exactamente el nominal",
            "expected": [c["input"]["nominalCents"] for c in cases],
            "actual": [c["totals"]["finalCarryingCents"] for c in cases],
            "status": "PASS"
            if all(c["input"]["nominalCents"] == c["totals"]["finalCarryingCents"] for c in cases)
            else "FAIL",
        },
        {
            "id": "CRITERIO-22",
            "descripcion": "Caso A del experto: valor actual 8.899.964, descuento 1.100.036, exceso 183.340",
            "expected": [8_899_964, 1_100_036, 183_340],
            "actual": [v1["presentValueCents"], v1["discountCents"], caso_a["excessDepreciationCents"]],
            "status": "PASS"
            if [v1["presentValueCents"], v1["discountCents"], caso_a["excessDepreciationCents"]]
            == [8_899_964, 1_100_036, 183_340]
            else "FAIL",
        },
        {
            "id": "O-2",
            "descripcion": "Efectivo y nominal NO dan el mismo valor actual: el tipo se declara mensual",
            "expected": True,
            "actual": cases[0]["presentValueCents"] != cases[1]["presentValueCents"],
            "status": "PASS" if cases[0]["presentValueCents"] != cases[1]["presentValueCents"] else "FAIL",
        },
        {
            "id": "R-VA-2",
            "descripcion": "12 meses justos y descuento inmaterial no se descuentan",
            "expected": [False, False],
            "actual": [cases[3]["requiresPresentValue"], cases[4]["requiresPresentValue"]],
            "status": "PASS"
            if not cases[3]["requiresPresentValue"] and not cases[4]["requiresPresentValue"]
            else "FAIL",
        },
    ]

    return {
        "fixture": "valor-actual-esperado",
        "epica": "E9",
        "tarea": "T9",
        "reglas": "R-VA-1..R-VA-6 (docs/design/E9-cierre-recurrentes.md §4.7, ADR-0016 D7)",
        "escala": SCALE,
        "cases": cases,
        "casoA": caso_a,
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
        print("OK: valor-actual-esperado.json reproducible byte a byte")
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(f"escrito {OUT}")
    for c in data["cases"]:
        print(
            f"  {c['id']}  VA={c['presentValueCents']:>10,}  descuento={c['discountCents']:>9,}  "
            f"filas={c['totals']['rowCount']:>3}  Sigma_int={c['totals']['interestCents']:>9,}"
        )
    print(f"  A1  exceso={data['casoA']['excessDepreciationCents']:,}  "
          f"interes 10m={data['casoA']['accruedInterestCents']:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
