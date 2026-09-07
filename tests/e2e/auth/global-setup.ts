import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"
import type { CloudAuthSeed } from "@/tests/support/ensure-cloud-auth"

/**
 * E13 · T14 — siembra el entorno de la suite de auth UNA vez, antes de todos los
 * specs (docs/design/E13-autenticacion.md §8.3). Escribe el resultado en un
 * fichero: `tests/support.ts` no puede importarse desde los specs (el cargador
 * ESM de Playwright no soporta el `import` de `@/prisma/client` sin atributo
 * `type: json`, igual que documenta `tests/e2e/session.ts`), así que el puente
 * es un fichero JSON, leído por `tests/e2e/auth/support.ts`.
 */
export default async function globalSetup(): Promise<void> {
  const out = execFileSync("npx", ["tsx", "tests/support/ensure-cloud-auth.ts"], {
    env: { ...process.env, PRISMA_LOG: "" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop()
  if (!line) throw new Error(`El arnés de auth no ha podido sembrar el entorno: ${out.slice(-1000)}`)
  const seed = JSON.parse(line) as CloudAuthSeed
  writeFileSync(path.join(process.cwd(), "tests/e2e/auth/.seed.json"), JSON.stringify(seed, null, 2))
}
