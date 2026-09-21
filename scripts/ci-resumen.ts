/**
 * E12 · T22 — El resumen que se lee SIN abrir un artefacto.
 *
 *   npx tsx scripts/ci-resumen.ts [--dir artifacts]
 *
 * Escribe en `$GITHUB_STEP_SUMMARY` (y por `stdout` si no existe) la tabla que
 * pide §8 del diseño: el sello del barrido, los **cinco hashes**, las **doce
 * cifras con su Δ** y el recuento PASS/FAIL/INFO **por familia**.
 *
 * Por qué existe: «que se lea sin abrir un artefacto es la diferencia entre un
 * control y un adorno». Un job que sólo deja un `validacion.json` de 300 KB en
 * la pestaña de artefactos no lo mira nadie, y un control que nadie mira no es
 * un control.
 *
 * Lee, y no calcula nada: `artifacts/validacion.json` y `artifacts/barrido.json`
 * (los deja `scripts/ci-audit-fixture.ts`) y `artifacts/audit-reconstruct.json`
 * (lo deja el auditor). Si falta alguno **lo dice en el resumen** en vez de
 * callarse: un resumen incompleto que parece completo es peor que ninguno.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { CHECK_FAMILIES, FAMILY_LABEL, familyOf, familyStatus } from "@/lib/audit/families"
import type { CheckResult } from "@/lib/audit/types"

type Validacion = { run_id: string; ledgerHash: string; gitSha: string; refDate: string; checks: CheckResult[] }
type Barrido = {
  sello: string
  motivos: string[]
  gitSha: string
  refDate: string
  seals: Record<string, string> | null
}
type Cifra = { metrica: string; producto: string | null; reconstruccion: string | null; delta: string | null }
type Auditor = { veredicto: string; cifras: Cifra[]; hallazgos: { codigo: string; gravedad: string; mensaje: string }[] }

const dir = (() => {
  const i = process.argv.indexOf("--dir")
  return path.resolve(i >= 0 ? (process.argv[i + 1] ?? "artifacts") : "artifacts")
})()

const leer = <T>(fichero: string): T | null => {
  const ruta = path.join(dir, fichero)
  if (!existsSync(ruta)) return null
  try {
    return JSON.parse(readFileSync(ruta, "utf8")) as T
  } catch {
    return null
  }
}

const lineas: string[] = []
const escribir = (texto = ""): void => {
  lineas.push(texto)
}

const validacion = leer<Validacion>("validacion.json")
const barrido = leer<Barrido>("barrido.json")
const auditor = leer<Auditor>("audit-reconstruct.json")

escribir("## Capa de fiabilidad — barrido y reconstrucción independiente")
escribir()

// ── El sello ─────────────────────────────────────────────────────────────────
if (barrido) {
  escribir(`**Sello del periodo:** \`${barrido.sello}\``)
  escribir(
    barrido.motivos.length > 0
      ? `**Motivos:** ${barrido.motivos.map((m) => `\`${m}\``).join(" · ")}`
      : "**Motivos:** ninguno"
  )
  escribir(`**git-sha:** \`${barrido.gitSha}\` · **fecha de referencia:** \`${barrido.refDate}\``)
} else {
  escribir("> ⚠️ **No hay `barrido.json`**: el sello y los cinco hashes no se han podido leer.")
}
escribir()

// ── Los cinco sellos ─────────────────────────────────────────────────────────
escribir("### Los cinco sellos")
escribir()
if (barrido?.seals) {
  escribir("| Sello | Valor |")
  escribir("|---|---|")
  for (const [nombre, valor] of Object.entries(barrido.seals)) {
    escribir(`| \`${nombre}\` | \`${valor}\` |`)
  }
} else {
  escribir("> ⚠️ sin `InvariantRun` persistido: no hay sellos que publicar.")
}
escribir()

// ── Las doce cifras ──────────────────────────────────────────────────────────
escribir("### Las doce cifras canónicas y su Δ")
escribir()
if (auditor) {
  escribir(`**Veredicto del auditor automatizado:** \`${auditor.veredicto}\``)
  escribir()
  escribir("| Cifra | Producto | Reconstrucción | Δ |")
  escribir("|---|--:|--:|--:|")
  for (const cifra of auditor.cifras) {
    const delta = cifra.delta === null ? "— *sin contrastar*" : cifra.delta === "0" ? "**0**" : `❌ ${cifra.delta}`
    escribir(`| \`${cifra.metrica}\` | ${cifra.producto ?? "—"} | ${cifra.reconstruccion ?? "—"} | ${delta} |`)
  }
  const graves = auditor.hallazgos.filter((h) => h.gravedad !== "INFO")
  escribir()
  escribir(
    graves.length === 0
      ? `Hallazgos: ${auditor.hallazgos.length} (ninguno por encima de INFO).`
      : `**Hallazgos por encima de INFO:** ${graves.map((h) => `\`${h.codigo}\` ${h.mensaje}`).join(" · ")}`
  )
} else {
  escribir("> ⚠️ **No hay `audit-reconstruct.json`**: la Capa 2 no ha dejado salida.")
}
escribir()

// ── Familias ─────────────────────────────────────────────────────────────────
escribir("### Recuento por familia")
escribir()
if (validacion) {
  const porFamilia = new Map<string, CheckResult[]>(CHECK_FAMILIES.map((f) => [f, [] as CheckResult[]]))
  for (const check of validacion.checks) {
    const familia = familyOf(check.id)
    porFamilia.get(familia)?.push(check)
  }
  escribir("| Familia | Estado | PASS | FAIL | WARN | INFO |")
  escribir("|---|---|--:|--:|--:|--:|")
  for (const familia of CHECK_FAMILIES) {
    const checks = porFamilia.get(familia) ?? []
    const cuenta = (estado: string) => checks.filter((c) => c.status === estado).length
    const estado = familyStatus(checks)
    const marca = estado === "OK" ? "✅" : estado === "SIN_EVALUAR" ? "⬜" : "❌"
    escribir(
      `| ${FAMILY_LABEL[familia]} | ${marca} ${estado} | ${cuenta("PASS")} | ${cuenta("FAIL")} | ${cuenta("WARN")} | ${cuenta("INFO")} |`
    )
  }
  const fails = validacion.checks.filter((c) => c.status === "FAIL")
  escribir()
  escribir(`Total: ${validacion.checks.length} checks · ${fails.length} en FAIL.`)
  if (fails.length > 0) {
    escribir()
    escribir("<details><summary>Los FAIL, uno a uno</summary>")
    escribir()
    for (const fail of fails) escribir(`- \`${fail.id}\`: ${fail.evidencia}`)
    escribir()
    escribir("</details>")
  }
} else {
  escribir("> ⚠️ **No hay `validacion.json`**: el barrido no ha dejado salida.")
}
escribir()

const salida = `${lineas.join("\n")}\n`
const destino = process.env.GITHUB_STEP_SUMMARY
if (destino) appendFileSync(destino, salida, "utf8")
process.stdout.write(salida)
