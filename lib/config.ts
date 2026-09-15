import { z } from "zod"
import packageJson from "../package.json"

const envSchema = z.object({
  BASE_URL: z.string().url().default("http://localhost:7331"),
  PORT: z.string().default("7331"),
  SELF_HOSTED_MODE: z.enum(["true", "false"]).default("true"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_NAME: z.string().default("gpt-4o-mini"),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_MODEL_NAME: z.string().default("gemini-2.5-flash"),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL_NAME: z.string().default("mistral-medium-latest"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(16, "Auth secret must be at least 16 characters")
    .default("please-set-your-key-here"),
  DISABLE_SIGNUP: z.enum(["true", "false"]).default("false"),
  // E13 · T1 — duración de la sesión en días, configurable (docs/design/E13-autenticacion.md §4.1, D-1).
  AUTH_SESSION_DAYS: z.coerce.number().int().positive().default(30),
  RESEND_API_KEY: z.string().default("please-set-your-resend-api-key-here"),
  RESEND_FROM_EMAIL: z.string().default("TaxHacker <user@localhost>"),
  RESEND_AUDIENCE_ID: z.string().default(""),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),

  // ── E11 · plataforma SaaS (docs/design/E11-plataforma-saas.md §9.1) ────────
  // Los secretos viven en el ENTORNO, nunca en la base de datos. Los de
  // organización (IMAP) siguen cifrados con `lib/encryption.ts`.
  /** §7.2 · protege `POST /api/cron/[job]`. Vacío = la ruta está CERRADA. */
  CRON_SECRET: z.string().default(""),
  /** §5.2 · HMAC-SHA256 del manifest del backup. La usa la ola B. */
  PLATFORM_SIGNING_KEY: z.string().default(""),
  /** `keyId` del manifest, para poder ROTAR: `verifyManifest` acepta la vigente y la anterior. */
  PLATFORM_SIGNING_KEY_ID: z.string().default("k1"),
  PLATFORM_SIGNING_KEY_PREVIOUS: z.string().default(""),
  /** §4 · almacén de objetos. `local` en desarrollo y self-hosted; `s3` en cloud (P-3). */
  STORAGE_BACKEND: z.enum(["local", "s3"]).default("local"),
  STORAGE_BUCKET: z.string().default(""),
  /** Un bucket por ENTORNO con prefijo por organización (ADR-0019 D3). */
  STORAGE_PREFIX: z.string().default("erp"),
  STORAGE_ENDPOINT: z.string().default(""),
  STORAGE_REGION: z.string().default("auto"),
  STORAGE_ACCESS_KEY_ID: z.string().default(""),
  STORAGE_SECRET_ACCESS_KEY: z.string().default(""),
  /** Sello de versión del despliegue; lo publica `/api/health` (§7.3). */
  GIT_SHA: z.string().default("desconocido"),
})

const env = envSchema.parse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== "")))

/**
 * **§9.1 · el secreto por defecto hace fallar el arranque fuera de self-hosted.**
 *
 * `BETTER_AUTH_SECRET` es la clave de la que `lib/encryption.ts` deriva (scrypt)
 * la de AES-256-GCM con la que se cifran los secretos por organización. Arrancar
 * una instalación cloud con el valor de ejemplo significa que **todas** esas
 * credenciales están cifradas con una clave pública, y el fallo es silencioso:
 * todo funciona, y no hay cifrado.
 *
 * Se falla al ARRANCAR y no al primer uso, que es cuando ya hay datos cifrados.
 * En self-hosted se avisa y se sigue: ahí el operador es el dueño de la máquina
 * y TaxHacker genera y persiste una clave por él.
 */
const SECRETOS_DE_EJEMPLO = new Set([
  "please-set-your-key-here",
  "insecure-self-hosted-secret",
  "random-secret-key",
  "change-me",
])

if (SECRETOS_DE_EJEMPLO.has(env.BETTER_AUTH_SECRET)) {
  const mensaje =
    "BETTER_AUTH_SECRET tiene el valor de ejemplo. De esa clave deriva el cifrado AES-256-GCM de los " +
    "secretos por organizacion (lib/encryption.ts): con el valor por defecto no hay cifrado, solo apariencia " +
    "de cifrado. Defina una cadena larga y aleatoria."
  if (env.SELF_HOSTED_MODE === "false") {
    throw new Error(`E11 · §9.1 — ${mensaje}`)
  }
  console.warn(`[config] ${mensaje}`)
}

const config = {
  app: {
    title: "TaxHacker",
    description: "Your personal AI accountant",
    version: packageJson.version || "0.0.1",
    baseURL: env.BASE_URL || `http://localhost:${env.PORT || "7331"}`,
    supportEmail: "me@vas3k.com",
  },
  upload: {
    acceptedMimeTypes: "image/*,.pdf,.doc,.docx,.xls,.xlsx",
    images: {
      maxWidth: 1800,
      maxHeight: 1800,
      quality: 90,
    },
    pdfs: {
      maxPages: 10,
      dpi: 150,
      quality: 90,
      maxWidth: 1500,
      maxHeight: 1500,
    },
  },
  selfHosted: {
    isEnabled: env.SELF_HOSTED_MODE === "true",
    redirectUrl: "/self-hosted/redirect",
    welcomeUrl: "/self-hosted",
  },
  ai: {
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModelName: env.OPENAI_MODEL_NAME,
    googleApiKey: env.GOOGLE_API_KEY,
    googleModelName: env.GOOGLE_MODEL_NAME,
    mistralApiKey: env.MISTRAL_API_KEY,
    mistralModelName: env.MISTRAL_MODEL_NAME,
  },
  auth: {
    secret: env.BETTER_AUTH_SECRET,
    loginUrl: "/enter",
    disableSignup: env.DISABLE_SIGNUP === "true" || env.SELF_HOSTED_MODE === "true",
    // E13 · T1 (docs/design/E13-autenticacion.md §3, §4.1).
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetTokenTtlSeconds: 60 * 60, // 1 hora
    sessionDays: env.AUTH_SESSION_DAYS,
  },
  // E13 · T1 — identidad visible sólo en las pantallas de acceso (§6.2, D-3).
  // `config.app.title` no se toca: el resto de la aplicación sigue siendo TaxHacker.
  brand: {
    product: "NOMIC",
    company: "CFOnomic",
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    paymentSuccessUrl: `${env.BASE_URL}/cloud/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    paymentCancelUrl: `${env.BASE_URL}/cloud`,
  },
  // E11 · §7.2 y §9.1 — el reloj y la firma de los backups.
  cron: {
    /** Vacío = `/api/cron/[job]` responde 401 a todo. Cerrado por defecto. */
    secret: env.CRON_SECRET,
  },
  platform: {
    signingKey: env.PLATFORM_SIGNING_KEY,
    signingKeyId: env.PLATFORM_SIGNING_KEY_ID,
    /** Rotación: `verifyManifest` acepta la vigente y la anterior (§9.1). */
    signingKeyPrevious: env.PLATFORM_SIGNING_KEY_PREVIOUS,
    gitSha: env.GIT_SHA,
  },
  // E11 · §4 — almacenamiento de objetos (ADR-0019 D3). Lo consume la ola B.
  storage: {
    backend: env.STORAGE_BACKEND,
    bucket: env.STORAGE_BUCKET,
    prefix: env.STORAGE_PREFIX,
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  },
  email: {
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM_EMAIL,
    audienceId: env.RESEND_AUDIENCE_ID,
  },
} as const

export default config
