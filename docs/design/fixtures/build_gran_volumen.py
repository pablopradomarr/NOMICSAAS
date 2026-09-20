#!/usr/bin/env python3
"""
E12 · T17 — Generador del fixture de GRAN VOLUMEN.

    python3 docs/design/fixtures/build_gran_volumen.py [--check]

## Por que este fixture no es un fichero de datos

Los techos 3, 5, 6 y 8 de la §12 de E11 estan declarados sobre **50 000
asientos, 150 000 lineas, 2 000 ficheros / 1,5 GB y 50 organizaciones**, y hasta
E12 se median **extrapolando** desde un volumen reducido: el propio
`perf-platform.test.ts` lo decia en su cabecera. Extrapolar separa el coste fijo
del marginal, que es honesto, pero no ve lo que solo aparece con volumen real: un
plan que cambia cuando la tabla crece, un indice que deja de usarse, un heap que
no da mas de si. La deuda 6 de §6 pide medirlos **sin extrapolacion**.

Un fixture de 1,5 GB **no se guarda en el repositorio**. Lo que se guarda es su
ESPECIFICACION: los parametros, la semilla y —esto es lo que lo hace un fixture
sellado y no un generador de datos al azar— **los digests de todo lo que produce**.
Con eso, `--check` reconstruye el volumen entero en memoria, recomputa los
digests y falla si difiere un byte, exactamente igual que los otros cuatro
generadores de la casa. La reproducibilidad se comprueba sobre el CONTENIDO, no
sobre un fichero que nadie puede versionar.

## Que produce

`tests/fixtures/gran-volumen/spec.json`, con:

  · `params`   — los cuatro volumenes y la semilla. Inmutables: cambiarlos es
                 emitir otra version del fixture, no editarlo.
  · `digests`  — el sha256 de cada flujo generado (asientos, lineas, ficheros,
                 organizaciones), en forma canonica y con separadores explicitos.
  · `totals`   — las cifras que el test puede comprobar sin generar nada:
                 numero de filas, suma de debe y de haber, bytes totales.

## El generador determinista

Un PRNG propio (`xorshift64*`) y no `random`: el modulo de la biblioteca estandar
no garantiza la misma secuencia entre versiones de Python, y un fixture cuyo
contenido dependa de la version del interprete no es un fixture. Cuatro lineas de
aritmetica entera de 64 bits, la misma secuencia en cualquier maquina — y
**trivial de reimplementar en TypeScript**, que es lo que hace `tests/fixtures/
gran-volumen/generate.ts` para sembrar la base sin pasar por Python.

Los BYTES de los 2 000 documentos tampoco se guardan: se derivan de la semilla y
del indice del fichero, asi que el test los materializa cuando los necesita y su
sha256 esta sellado aqui. 1,5 GB reproducibles a partir de 100 bytes de spec.

NO TOCA el resto de `tests/fixtures/*`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parents[3]
DESTINO = RAIZ / "tests" / "fixtures" / "gran-volumen" / "spec.json"

# ─────────────────────────────────────────────────────────────────────────────
# Parametros SELLADOS. Cambiar uno es emitir otra version, no editar esta.
# ─────────────────────────────────────────────────────────────────────────────

PARAMS = {
    "version": "1.0",
    # §12 de E11, techos 3, 5, 6 y 8.
    "entries": 50_000,
    "linesPerEntry": 3,          # 150 000 lineas
    "files": 2_000,
    "fileBytesTotal": 1_500_000_000,   # 1,5 GB
    "organizations": 50,
    "seed": 20261001,
    "fiscalYear": 2027,
    # Dos cuentas de movimiento y una de contrapartida: el asiento tiene TRES
    # lineas y sigue cuadrando, que es lo que hace que el volumen sea util para
    # I1 y no solo para el reloj.
    "accountDebit": "6290",
    "accountDebit2": "6210",
    "accountCredit": "5720",
    # Importes en CENTIMOS enteros. Nunca float: es la regla de la casa y
    # ademas hace el fixture reproducible sin depender del redondeo del
    # interprete.
    "amountMinCents": 100,
    "amountMaxCents": 500_000,
}

MASK64 = (1 << 64) - 1


class Xorshift64:
    """xorshift64* — determinista, portable y reimplementable en cuatro lineas.

    `random.Random` no garantiza la misma secuencia entre versiones de Python, y
    un fixture cuyo contenido dependa del interprete no se puede sellar.
    """

    def __init__(self, seed: int) -> None:
        # El estado no puede ser 0: xorshift se quedaria clavado en 0 para
        # siempre y todo el fixture saldria constante.
        self.state = seed & MASK64 or 0x9E3779B97F4A7C15

    def next_u64(self) -> int:
        x = self.state
        x ^= (x >> 12) & MASK64
        x ^= (x << 25) & MASK64
        x ^= (x >> 27) & MASK64
        self.state = x & MASK64
        return (self.state * 0x2545F4914F6CDD1D) & MASK64

    def below(self, limit: int) -> int:
        """Entero en `[0, limit)`. Rechazo por modulo: sin sesgo."""
        if limit <= 0:
            raise ValueError("limit tiene que ser positivo")
        corte = (MASK64 // limit) * limit
        while True:
            value = self.next_u64()
            if value < corte:
                return value % limit

    def between(self, low: int, high: int) -> int:
        return low + self.below(high - low + 1)


def dia_del_ejercicio(indice: int, anio: int) -> str:
    """Reparte los asientos por los 365 dias del ejercicio, en orden creciente.

    En orden y no al azar: el diario es correlativo por fecha (I8, art. 28.2
    CCom), y un fixture de volumen con las fechas desordenadas mediria el
    rendimiento de un caso que la base nunca va a ver.
    """
    from datetime import date, timedelta

    inicio = date(anio, 1, 1)
    return (inicio + timedelta(days=indice % 365)).isoformat()


def asientos(params: dict) -> list[dict]:
    """Los 50 000 asientos, cuadrados por construccion."""
    rng = Xorshift64(params["seed"])
    total = params["entries"]
    out: list[dict] = []
    for i in range(total):
        # El importe se parte en dos lineas al debe y una al haber por la suma:
        # Sdebe = Shaber con tolerancia 0, sin depender de ningun redondeo.
        a = rng.between(params["amountMinCents"], params["amountMaxCents"])
        b = rng.between(params["amountMinCents"], params["amountMaxCents"])
        out.append(
            {
                "entryNumber": i + 1,
                "date": dia_del_ejercicio(i * 365 // total, params["fiscalYear"]),
                "debit1": a,
                "debit2": b,
                "credit": a + b,
            }
        )
    return out


def ficheros(params: dict) -> list[dict]:
    """Los 2 000 documentos: tamanio y semilla propia, no los bytes.

    Los bytes se derivan de `(seed, indice)` cuando hacen falta; guardarlos aqui
    serian 1,5 GB en un JSON. Lo que se sella es el sha256 de cada uno, que es lo
    que de verdad hay que poder comprobar.
    """
    rng = Xorshift64(params["seed"] ^ 0xF11E5)
    total = params["files"]
    objetivo = params["fileBytesTotal"]
    medio = objetivo // total

    # Tamanios variables alrededor de la media (+-40 %), y el ULTIMO absorbe la
    # diferencia para que el total sea EXACTAMENTE el declarado. Sin ese ajuste,
    # «1,5 GB» seria «mas o menos 1,5 GB» y el techo 5 dejaria de ser un techo.
    tamanios: list[int] = []
    acumulado = 0
    for _ in range(total - 1):
        delta = rng.between(-(medio * 4) // 10, (medio * 4) // 10)
        tamanio = max(1_024, medio + delta)
        tamanios.append(tamanio)
        acumulado += tamanio
    tamanios.append(max(1_024, objetivo - acumulado))

    return [
        {"index": i, "sizeBytes": tamanios[i], "seed": (params["seed"] ^ (i * 0x9E3779B1)) & MASK64}
        for i in range(total)
    ]


def bytes_de_fichero(semilla: int, tamanio: int) -> bytes:
    """Los bytes de un documento, derivados de su semilla.

    **No es aleatorio de verdad y no debe serlo**: tiene que ser el mismo flujo
    en Python y en TypeScript. Se genera por bloques de 8 bytes del propio
    xorshift, que es lo unico que las dos implementaciones comparten.
    """
    rng = Xorshift64(semilla)
    trozos: list[bytes] = []
    restantes = tamanio
    while restantes > 0:
        bloque = rng.next_u64().to_bytes(8, "little")
        trozos.append(bloque[:restantes])
        restantes -= len(bloque[:restantes])
    return b"".join(trozos)


def sha256_de_fichero(semilla: int, tamanio: int) -> str:
    """El sha256 sin materializar el fichero entero: bloque a bloque."""
    rng = Xorshift64(semilla)
    h = hashlib.sha256()
    restantes = tamanio
    while restantes > 0:
        bloque = rng.next_u64().to_bytes(8, "little")[: min(8, restantes)]
        h.update(bloque)
        restantes -= len(bloque)
    return h.hexdigest()


def organizaciones(params: dict) -> list[dict]:
    """Las 50 organizaciones del techo 8, con uuid derivado y estable."""
    return [
        {
            "index": i,
            # uuid v4 sintetico y determinista: el prefijo dice de que fixture es.
            "id": f"e12f0000-0000-4000-8000-{i:012x}",
            "slug": f"gran-volumen-{i:02d}",
        }
        for i in range(params["organizations"])
    ]


def digest_de(lineas: list[str]) -> str:
    """sha256 de un flujo canonico: una fila por linea, separador `\\t`, `\\n` final no."""
    return hashlib.sha256("\n".join(lineas).encode("utf-8")).hexdigest()


def construir() -> dict:
    params = dict(PARAMS)
    entradas = asientos(params)
    docs = ficheros(params)
    orgs = organizaciones(params)

    lineas_asiento = [
        f"{e['entryNumber']}\t{e['date']}\t{e['debit1']}\t{e['debit2']}\t{e['credit']}" for e in entradas
    ]
    # Las LINEAS del diario, que son lo que el techo 3 recorre: tres por asiento.
    lineas_diario: list[str] = []
    for e in entradas:
        lineas_diario.append(f"{e['entryNumber']}\t1\t{params['accountDebit']}\t{e['debit1']}\t0")
        lineas_diario.append(f"{e['entryNumber']}\t2\t{params['accountDebit2']}\t{e['debit2']}\t0")
        lineas_diario.append(f"{e['entryNumber']}\t3\t{params['accountCredit']}\t0\t{e['credit']}")

    lineas_fichero = [f"{d['index']}\t{d['sizeBytes']}\t{sha256_de_fichero(d['seed'], d['sizeBytes'])}" for d in docs]
    lineas_org = [f"{o['index']}\t{o['id']}\t{o['slug']}" for o in orgs]

    debe = sum(e["debit1"] + e["debit2"] for e in entradas)
    haber = sum(e["credit"] for e in entradas)
    if debe != haber:
        raise SystemExit(f"el fixture no cuadra: debe {debe} != haber {haber}")

    return {
        "params": params,
        "digests": {
            "entries": digest_de(lineas_asiento),
            "journalLines": digest_de(lineas_diario),
            "files": digest_de(lineas_fichero),
            "organizations": digest_de(lineas_org),
        },
        "totals": {
            "entries": len(entradas),
            "journalLines": len(lineas_diario),
            "debitCents": debe,
            "creditCents": haber,
            "files": len(docs),
            "fileBytes": sum(d["sizeBytes"] for d in docs),
            "organizations": len(orgs),
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="no escribe: compara con el fichero en disco")
    args = ap.parse_args()

    spec = construir()
    texto = json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not DESTINO.exists():
            print(f"FALTA {DESTINO.relative_to(RAIZ)}: ejecuta el generador sin --check", file=sys.stderr)
            return 1
        actual = DESTINO.read_text(encoding="utf-8")
        if actual != texto:
            print(f"EL FIXTURE YA NO SE REPRODUCE: {DESTINO.relative_to(RAIZ)} difiere de lo generado", file=sys.stderr)
            # Se dice QUE campo difiere, no solo que difiere: un diff de 50 000
            # asientos no lo lee nadie.
            try:
                viejo = json.loads(actual)
                for bloque in ("params", "digests", "totals"):
                    if viejo.get(bloque) != spec[bloque]:
                        print(f"  · bloque «{bloque}»:", file=sys.stderr)
                        print(f"      en disco : {json.dumps(viejo.get(bloque), sort_keys=True)}", file=sys.stderr)
                        print(f"      generado : {json.dumps(spec[bloque], sort_keys=True)}", file=sys.stderr)
            except json.JSONDecodeError:
                pass
            return 1
        print(f"OK {DESTINO.relative_to(RAIZ)} se reproduce byte a byte")
        return 0

    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    DESTINO.write_text(texto, encoding="utf-8")
    print(f"escrito {DESTINO.relative_to(RAIZ)}")
    print(
        f"  {spec['totals']['entries']} asientos · {spec['totals']['journalLines']} lineas · "
        f"{spec['totals']['files']} ficheros / {spec['totals']['fileBytes'] / 1e9:.2f} GB · "
        f"{spec['totals']['organizations']} organizaciones"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
