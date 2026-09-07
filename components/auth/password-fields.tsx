"use client"

import { LineInput } from "@/components/auth/brand"
import { PASSWORD_MIN_LENGTH } from "@/forms/auth"

/**
 * E13 · T7 — Par "contraseña nueva" + "repite la contraseña", reutilizado por
 * `reset-password-form.tsx` y `invite-form.tsx` (docs/design/E13-autenticacion.md §8.2, T7).
 *
 * Sin estado propio: recibe valor/onChange del formulario que lo use, igual que `LineInput`.
 */
export function PasswordFields({
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  disabled,
  errorId,
}: {
  password: string
  confirm: string
  onPasswordChange: (value: string) => void
  onConfirmChange: (value: string) => void
  disabled?: boolean
  /** Id del mensaje de error asociado (aria-describedby), si lo hay. */
  errorId?: string
}) {
  return (
    <>
      <LineInput
        label="Contraseña nueva"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        placeholder={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`}
        value={password}
        onChange={(event) => onPasswordChange(event.target.value)}
        disabled={disabled}
        errorId={errorId}
      />
      <LineInput
        label="Repite la contraseña"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        value={confirm}
        onChange={(event) => onConfirmChange(event.target.value)}
        disabled={disabled}
        errorId={errorId}
      />
    </>
  )
}
