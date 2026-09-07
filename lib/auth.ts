import { checkAuthAttempt } from "@/lib/auth-rate-limit"
import config from "@/lib/config"
import { getSelfHostedUser, getUserById, SELF_HOSTED_MEMBERSHIP_PLAN } from "@/models/users"
import { Organization, User } from "@/prisma/client"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { nextCookies } from "better-auth/next-js"
import { createHash } from "node:crypto"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
// E7 · T14 (ADR-0015 D5): better-auth escribe `users`, `sessions`, `account` y
// `verification` SIN sesión; con RLS en `users` eso ya no lo puede hacer
// `app_runtime`. El adaptador usa el cliente de `app_auth`, y E13 (email+
// contraseña) se apoya en el MISMO cliente: el alta, el reset y el cambio de
// contraseña ocurren igualmente sin sesión.
import { authPrisma } from "./auth-db"
import { logAuthEvent } from "./auth-log"
import { revokeAllSessions } from "./auth-password"
import { resend, sendPasswordResetEmail } from "./email"

/** sha256 del email en minúsculas — nunca el email en claro (mismo criterio que E1 con el token). */
function emailSubjectHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
}

/** IP del cliente a partir de las cabeceras del request (better-auth no la expone en `before`). */
function ipFromHeaders(headers?: Headers): string {
  const forwardedFor = headers?.get("x-forwarded-for")
  if (forwardedFor) return forwardedFor.split(",")[0].trim()
  return headers?.get("x-real-ip") || "unknown"
}

/** Datos que el sidebar pinta: identidad del usuario + plan/cuota de la organización activa. */
export type UserProfile = {
  id: string
  name: string
  email: string
  avatar?: string
  organizationName: string
  membershipPlan: string
  storageUsed: number
  storageLimit: number
  aiBalance: number
}

export const auth = betterAuth({
  database: prismaAdapter(authPrisma, { provider: "postgresql" }),
  appName: config.app.title,
  baseURL: config.app.baseURL,
  secret: config.auth.secret,
  email: {
    provider: "resend",
    from: config.email.from,
    resend,
  },
  session: {
    strategy: "jwt",
    // E13 · T2 — 30 días (§4.1, D-1): un ERP con datos contables, no una app de notas.
    expiresIn: config.auth.sessionDays * 24 * 60 * 60,
    updateAge: 24 * 60 * 60, // 24 hours
    cookieCache: {
      enabled: true,
      // E13 · T2 — 5 minutos (§4.1): con la caché a un año, una sesión revocada al cambiar
      // la contraseña se seguiría aceptando durante un año sin volver a mirar `sessions`
      // (R2). Es un hallazgo de seguridad, no una preferencia.
      maxAge: 5 * 60,
    },
  },
  // E13 · T2 — activa emailAndPassword como método único de acceso (§4.1, ADR-0017).
  emailAndPassword: {
    enabled: true,
    disableSignUp: config.auth.disableSignup, // DISABLE_SIGNUP=true o SELF_HOSTED_MODE=true
    minPasswordLength: config.auth.minPasswordLength,
    maxPasswordLength: config.auth.maxPasswordLength,
    autoSignIn: false,
    requireEmailVerification: false, // la invitación ya prueba la posesión del buzón
    resetPasswordTokenExpiresIn: config.auth.resetTokenTtlSeconds, // 1 h
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, token }) => {
      await sendPasswordResetEmail({ email: user.email, resetUrl: `${config.app.baseURL}/reset-password/${token}` })
    },
    onPasswordReset: async ({ user }) => {
      // Cinturón y tirantes: `revokeSessionsOnPasswordReset` ya lo hace, pero un reset es
      // el momento de mayor riesgo (S2) y no cuesta nada reforzarlo aquí.
      await revokeAllSessions(user.id)
    },
  },
  advanced: {
    cookiePrefix: "taxhacker",
    database: {
      generateId: "uuid",
    },
  },
  // E13 · T2 — retirado `emailOTP` del servidor (D-13-2): el reset por email cubre la
  // recuperación con un solo camino. El plugin cliente se conserva temporalmente en
  // `lib/auth-client.ts` para no romper la compilación de `components/auth/{login,invite}-form.tsx`
  // (dev-frontend los reescribe en T6/T9).
  plugins: [
    nextCookies(), // make sure this is the last plugin in the array
  ],
  hooks: {
    // E13 · T2 — rate limit por IP y por hash del email sobre /sign-in/email y
    // /request-password-reset (§4.1, S1, S3). Mensaje genérico único: nunca revela si el
    // límite lo agotó la IP o el email.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/email" || ctx.path === "/request-password-reset") {
        const kind = ctx.path === "/sign-in/email" ? "login" : "reset"
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : ""
        const subjectHash = emailSubjectHash(email)
        const ip = ipFromHeaders(ctx.headers)

        const result = checkAuthAttempt(kind, ip, subjectHash, Date.now())
        if (!result.allowed) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Demasiados intentos. Vuelve a probar en unos minutos",
          })
        }
      }
    }),
    // E13 · T2 — log de proceso de login (§7b): nunca el email en claro, sólo su sha256.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/email") {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : ""
        const ok = Boolean(ctx.context.newSession)
        logAuthEvent({
          event: ok ? "login_ok" : "login_ko",
          emailHash: emailSubjectHash(email),
          ip: ipFromHeaders(ctx.headers),
          userAgent: ctx.headers?.get("user-agent"),
          userId: ok ? ctx.context.newSession?.user.id : undefined,
        })
      }

      // "reset_requested" responde OK siempre (S1: nunca revela si el email existe), así
      // que se registra aquí sin condicionar al resultado. "reset_completed" se añade en T7
      // cuando exista la pantalla `/reset-password/[token]` que ejercita el flujo completo.
      if (ctx.path === "/request-password-reset") {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : ""
        logAuthEvent({
          event: "reset_requested",
          emailHash: emailSubjectHash(email),
          ip: ipFromHeaders(ctx.headers),
          userAgent: ctx.headers?.get("user-agent"),
        })
      }
    }),
  },
})

export async function getSession() {
  if (config.selfHosted.isEnabled) {
    const user = await getSelfHostedUser()
    return user ? { user } : null
  }

  return await auth.api.getSession({
    headers: await headers(),
  })
}

export async function getCurrentUser(): Promise<User> {
  if (config.selfHosted.isEnabled) {
    const user = await getSelfHostedUser()
    if (user) {
      return user
    } else {
      redirect(config.selfHosted.redirectUrl)
    }
  }

  // Try to return user from session
  const session = await getSession()
  if (session && session.user) {
    const user = await getUserById(session.user.id)
    if (user) {
      return user
    }
  }

  // No session or user found
  redirect(config.auth.loginUrl)
}

// E1 (T11): plan, caducidad y saldo de IA son de la ORGANIZACIÓN, no del usuario.
export function isSubscriptionExpired(organization: Organization) {
  if (config.selfHosted.isEnabled) {
    return false
  }
  return Boolean(organization.membershipExpiresAt && organization.membershipExpiresAt < new Date())
}

export function isAiBalanceExhausted(organization: Organization) {
  if (config.selfHosted.isEnabled || organization.membershipPlan === SELF_HOSTED_MEMBERSHIP_PLAN) {
    return false
  }
  return organization.aiBalance <= 0
}
