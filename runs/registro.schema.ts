/**
 * E12 · T9 — **Esquema del registro de runs** (`runs/registro.jsonl`).
 *
 * `SPEC-FIABILIDAD` §C7 exige que el sistema se versione a sí mismo y que cada
 * entregable sea localizable por su run. El registro existe desde E0 y hasta hoy
 * **no tenía esquema ni validador**: un run mal escrito pasaba, y nadie se
 * enteraba hasta que alguien intentaba seguir el rastro de una cifra.
 *
 * Reglas del fichero, que este esquema convierte en código:
 *
 *  1. **Una línea, un run.** JSONL: nada de arrays ni de líneas continuadas.
 *  2. **`run_id` único** en todo el fichero.
 *  3. **Append-only**: las líneas existentes no se editan ni se reordenan. Lo
 *     comprueba `c7-registro-runs.test.ts` contra la versión de `HEAD`.
 *  4. **Toda línea dice con qué código se hizo** (`git_sha_base`). Las **siete**
 *     líneas de E1 a E6 que no lo traen están enumeradas en
 *     `RUNS_SIN_GIT_SHA_BASE` y son la ÚNICA excepción admitida. Un run nuevo
 *     sin `git_sha_base` es **rojo** (criterio 27 de §10).
 *  5. **Campos abiertos permitidos.** El registro documenta épicas muy distintas
 *     (`ficheros`, `deuda_nueva`, `hallazgos`, `perf`…). El esquema fija el
 *     NÚCLEO y deja pasar el resto: cerrarlo del todo obligaría a reescribir el
 *     histórico, que es exactamente lo que un registro append-only prohíbe.
 *
 * Módulo PURO: no lee ficheros, no toca la base, no mira el reloj.
 */

import { z } from "zod"

/** Tipos de run que el registro ha usado desde E0. Vocabulario CERRADO. */
export const RUN_TIPOS = [
  "setup",
  "decision",
  "epica",
  "diseño",
  "diseno",
  "sprint",
  "tarea",
  "implementacion",
  "integracion",
  "correccion",
  "fix",
  "revision",
  "auditoria",
  "informe",
  "cierre",
] as const

export type RunTipo = (typeof RUN_TIPOS)[number]

/**
 * Las **siete** líneas históricas (E1 a E6) que no traen `git_sha_base`: cinco
 * declararon el commit con la clave antigua `git_sha` —dos de ellas con el valor
 * literal `"desconocido"`— y una no lo declaró en absoluto. El registro es
 * **append-only**: no se reescriben. Se enumeran aquí, con nombre, para que la
 * excepción sea una lista CERRADA y no una laxitud del esquema (regla E-4: todo
 * inventario se declara o se deriva; nunca se deja implícito).
 *
 * **Un run nuevo que aparezca aquí es un error de quien lo escribió**: la lista
 * no crece. Lo comprueba `c7-registro-runs.test.ts`.
 */
export const RUNS_SIN_GIT_SHA_BASE: readonly string[] = [
  "2026-09-04_e1_cierre",
  "2026-09-04_e2_cierre",
  "2026-09-05_e3_revision_ronda2",
  "2026-09-05_e3_cierre",
  "2026-09-05_e4_cierre",
  "2026-09-05_e6_backend",
  "2026-09-05_e6_revision_ronda1",
]

/**
 * Los **dos** runs de diseño que escribieron `HEAD` en vez del commit. `HEAD` no
 * identifica un commit —mañana es otro—, así que la lista también está cerrada:
 * un run nuevo con `HEAD` es rojo.
 */
export const RUNS_CON_GIT_SHA_SIMBOLICO: readonly string[] = ["2026-09-07_e7_diseno", "2026-09-15_e12_diseno"]

const shaCorto = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "el git-sha se escribe en minúsculas y con 7 a 40 caracteres hexadecimales")

/** `2026-09-15T22:40:00Z`: instante UTC explícito, nunca hora local. */
const tsUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "`ts_utc` es un instante ISO-8601 en UTC, terminado en Z")

/** `E0`…`E14`, o varias épicas separadas por coma en un run de cierre. */
const epica = z.string().regex(/^E\d+([ ,/+-]+E?\d+)*$/, "`epica` es `E<n>` (o varias separadas por coma)")

/**
 * Un elemento de trabajo. **No** se cierra a `T<n>`: el registro histórico
 * referencia también hallazgos (`H-1`), rondas (`R2-1`), veredictos del revisor
 * (`DEBE-2`, `PUEDE-5`) y bugs (`BUG-E7-1`). Lo que se exige es que sea un
 * identificador escrito, no una frase.
 */
const tarea = z.string().min(1).max(60)

/**
 * `tests` es el recuento por suite (`{unit: 2461, fail: 0}`) o, en dos runs de
 * E6, la frase con la que se anotó la salida. Las dos formas están en el
 * fichero y el fichero es append-only.
 */
const tests = z.union([
  z.record(z.string(), z.union([z.number().int().nonnegative(), z.string()])),
  z.string().min(3),
])

/** El modelo por run, o el modelo POR AGENTE (`{arquitecto: "claude-opus-5"}`). */
const modelos = z.union([z.array(z.string().min(1)).min(1), z.record(z.string(), z.string().min(1))])

/** Veredicto de auditor/revisor: la frase, o el objeto con veredicto y ronda. */
const veredicto = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

/**
 * El sello del run. Puede ser el texto del sello («VALIDADO AUTOMÁTICAMENTE»,
 * «REQUIERE REVISIÓN: …») o, en un run de decisión, el objeto con la aprobación.
 */
const sello = z.union([z.string().min(3), z.record(z.string(), z.unknown())])

/** Núcleo obligatorio + campos opcionales conocidos + resto abierto. */
export const runRecordSchema = z
  .object({
    run_id: z.string().min(3),
    ts_utc: tsUtc,
    tipo: z.enum(RUN_TIPOS),
    epica: epica,
    agentes: z.array(z.string().min(1)).min(1),
    git_sha_base: z.union([shaCorto, z.literal("HEAD")]).optional(),
    /** Clave heredada; sólo en las líneas de `RUNS_SIN_GIT_SHA_BASE`. */
    git_sha: z.union([shaCorto, z.literal("desconocido")]).optional(),
    tareas: z.array(tarea).optional(),
    modelos: modelos.optional(),
    tests: tests.optional(),
    sello: sello.optional(),
    auditor: veredicto.optional(),
    revisor: veredicto.optional(),
    ficheros: z.array(z.string().min(1)).optional(),
  })
  .passthrough()
  .superRefine((run, ctx) => {
    if (run.git_sha_base === "HEAD" && !RUNS_CON_GIT_SHA_SIMBOLICO.includes(run.run_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["git_sha_base"],
        message: `el run ${run.run_id} declara \`HEAD\` como git-sha: HEAD no identifica un commit, y la lista de runs que lo hicieron está cerrada`,
      })
      return
    }
    if (run.git_sha_base) return
    if (RUNS_SIN_GIT_SHA_BASE.includes(run.run_id)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git_sha_base"],
      message: `el run ${run.run_id} no dice con qué código se hizo: falta \`git_sha_base\``,
    })
  })

export type RunRecord = z.infer<typeof runRecordSchema>

export type RunParseError = { linea: number; run_id: string | null; mensaje: string }

export type RunRegistryReport = {
  runs: readonly RunRecord[];
  errores: readonly RunParseError[]
  /** `run_id` que aparecen más de una vez. Un duplicado rompe la trazabilidad. */
  duplicados: readonly string[]
}

/**
 * Valida el contenido completo de `runs/registro.jsonl`. Devuelve TODOS los
 * errores, no el primero: un registro con tres líneas malas se arregla una vez.
 */
export function parseRunRegistry(contenido: string): RunRegistryReport {
  const runs: RunRecord[] = []
  const errores: RunParseError[] = []
  const vistos = new Map<string, number>()

  contenido.split(/\r?\n/).forEach((linea, index) => {
    const numero = index + 1
    if (linea.trim() === "") return
    let crudo: unknown
    try {
      crudo = JSON.parse(linea)
    } catch (error) {
      errores.push({
        linea: numero,
        run_id: null,
        mensaje: `no es JSON válido: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const parsed = runRecordSchema.safeParse(crudo)
    if (!parsed.success) {
      const id = typeof (crudo as { run_id?: unknown }).run_id === "string" ? (crudo as { run_id: string }).run_id : null
      for (const issue of parsed.error.issues) {
        errores.push({ linea: numero, run_id: id, mensaje: `${issue.path.join(".") || "(raíz)"}: ${issue.message}` })
      }
      return
    }
    runs.push(parsed.data)
    vistos.set(parsed.data.run_id, (vistos.get(parsed.data.run_id) ?? 0) + 1)
  })

  const duplicados = [...vistos.entries()].filter(([, veces]) => veces > 1).map(([id]) => id)
  return { runs, errores, duplicados }
}

/** El commit con el que se hizo el run, venga por la clave nueva o la heredada. */
export const gitShaOf = (run: RunRecord): string => run.git_sha_base ?? run.git_sha ?? ""
