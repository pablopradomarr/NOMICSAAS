import { createAuthClient } from "better-auth/client"

// E13 · T6 (docs/design/E13-autenticacion.md §4.1, D-13-2): el servidor (lib/auth.ts) ya NO
// registra el plugin `emailOTP` — el login por email+contraseña es el único método activo, y
// `components/auth/{login,invite,forgot-password,reset-password}-form.tsx` ya no llaman a
// `authClient.emailOtp.*`, así que el plugin cliente temporal se retira aquí (deuda de T2
// cerrada). `signIn.email`, `requestPasswordReset`, `resetPassword` y `changePassword` son
// parte del core del cliente y no necesitan plugin.
export const authClient = createAuthClient({})
