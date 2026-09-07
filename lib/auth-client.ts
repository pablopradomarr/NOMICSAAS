import { createAuthClient } from "better-auth/client"
import { emailOTPClient } from "better-auth/client/plugins"

// E13 · T2 (docs/design/E13-autenticacion.md §4.1, D-13-2): el servidor (lib/auth.ts) ya NO
// registra el plugin `emailOTP` — el login por email+contraseña es el único método activo.
// `emailOTPClient()` se conserva aquí TEMPORALMENTE sólo para que
// `components/auth/{login,invite}-form.tsx` sigan compilando; sus llamadas a
// `authClient.emailOtp.*` fallarán en runtime (404) hasta que dev-frontend los reescriba en
// T6/T9, que es cuando este plugin se retira del todo. `signIn.email` / `requestPasswordReset`
// / `resetPassword` / `changePassword` ya están disponibles: son parte del core del cliente.
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
})
