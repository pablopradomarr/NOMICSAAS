import config from "@/lib/config"
import { getSelfHostedUser, getUserByEmail, getUserById, SELF_HOSTED_MEMBERSHIP_PLAN } from "@/models/users"
import { Organization, User } from "@/prisma/client"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError } from "better-auth/api"
import { nextCookies } from "better-auth/next-js"
import { emailOTP } from "better-auth/plugins/email-otp"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { prisma } from "./db"
import { resend, sendOTPCodeEmail } from "./email"

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
  database: prismaAdapter(prisma, { provider: "postgresql" }),
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
    expiresIn: 180 * 24 * 60 * 60, // 365 days
    updateAge: 24 * 60 * 60, // 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 365 * 24 * 60 * 60, // 365 days
    },
  },
  advanced: {
    cookiePrefix: "taxhacker",
    database: {
      generateId: "uuid",
    },
  },
  plugins: [
    emailOTP({
      disableSignUp: config.auth.disableSignup,
      otpLength: 6,
      expiresIn: 10 * 60, // 10 minutes
      sendVerificationOTP: async ({ email, otp }) => {
        const user = await getUserByEmail(email)
        if (!user) {
          throw new APIError("NOT_FOUND", { message: "User with this email does not exist" })
        }
        await sendOTPCodeEmail({ email, otp })
      },
    }),
    nextCookies(), // make sure this is the last plugin in the array
  ],
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
