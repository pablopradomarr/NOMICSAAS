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
  // Integración E7: `lib/db.ts` activa `log: ["query", …]` fuera de producción y de
  // `NODE_ENV=test`, así que el arnés escupe una línea por sentencia. Contra una base
  // RECIÉN creada la siembra carga el plan de cuentas (906 filas de `seeds/npgc.csv`) y
  // ese volcado supera el `maxBuffer` por defecto de `execFileSync` (1 MB): la suite
  // moría con `ENOBUFS` antes del primer spec, no por un fallo de auth sino por el log.
  // `PRISMA_LOG` no lo lee nadie (era un intento de apagarlo que nunca funcionó); el
  // buffer se declara con holgura y el JSON de la siembra se sigue extrayendo igual.
  const out = execFileSync("npx", ["tsx", "tests/support/ensure-cloud-auth.ts"], {
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  })
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop()
  if (!line) throw new Error(`El arnés de auth no ha podido sembrar el entorno: ${out.slice(-1000)}`)
  const seed = JSON.parse(line) as CloudAuthSeed
  writeFileSync(path.join(process.cwd(), "tests/e2e/auth/.seed.json"), JSON.stringify(seed, null, 2))
}
