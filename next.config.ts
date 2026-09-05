import { withSentryConfig } from "@sentry/nextjs"
import type { NextConfig } from "next"
import { execFileSync } from "node:child_process"

/**
 * E3 (revisión ronda 1, #4) — git-sha del BUILD, congelado en el bundle.
 *
 * El sello de validación (`lib/ledger/invariants.seal`) dice «primer run tras
 * cambiar el motor» comparando el sha actual con el del run anterior, y la
 * provenance de cada celda lleva `calculado_por: <módulo>@<sha>`. Sin sha, esas
 * dos cosas mienten en silencio; por eso `seal()` marca REQUIERE REVISIÓN
 * cuando el sha es desconocido, y por eso conviene inyectarlo aquí.
 *
 * Prioridad: `GIT_SHA` del entorno (Docker, CI) → `git rev-parse HEAD` →
 * "desconocido".
 */
function resolveGitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return "desconocido"
  }
}

const nextConfig: NextConfig = {
  env: {
    GIT_SHA: resolveGitSha(),
  },
  images: {
    unoptimized: true, // FIXME: bug on prod, images always empty, investigate later
  },
  serverExternalPackages: ["@prisma/adapter-pg"],
  experimental: {
    serverActions: {
      bodySizeLimit: "256mb",
    },
  },
}

const isSentryEnabled = process.env.NEXT_PUBLIC_SENTRY_DSN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT

export default isSentryEnabled
  ? withSentryConfig(nextConfig, {
      silent: !process.env.CI,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      disableLogger: true,
      widenClientFileUpload: true,
      tunnelRoute: "/monitoring",
    })
  : nextConfig
