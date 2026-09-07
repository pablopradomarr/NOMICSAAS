// E13 · T3 — Tests de la política de contraseña (docs/design/E13-autenticacion.md §3, §8.1 criterio 4).
import { describe, expect, it } from "vitest"
import {
  changePasswordFormSchema,
  forgotPasswordFormSchema,
  isPasswordTooObvious,
  newPasswordFormSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  setInvitedPasswordFormSchema,
  signInFormSchema,
} from "@/forms/auth"

describe("passwordSchema", () => {
  it("rechaza la contraseña vacía", () => {
    expect(passwordSchema.safeParse("").success).toBe(false)
  })

  it(`rechaza ${PASSWORD_MIN_LENGTH - 1} caracteres`, () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false)
  })

  it(`acepta exactamente ${PASSWORD_MIN_LENGTH} caracteres`, () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH)).success).toBe(true)
  })

  it(`acepta exactamente ${PASSWORD_MAX_LENGTH} caracteres`, () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_LENGTH)).success).toBe(true)
  })

  it(`rechaza más de ${PASSWORD_MAX_LENGTH} caracteres (muy larga)`, () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false)
  })

  it("cuenta puntos de código unicode multibyte como caracteres válidos", () => {
    // 12 emoji (cada uno de varios bytes UTF-16/UTF-8) deben bastar para el mínimo: `.length`
    // de JS cuenta unidades UTF-16, no bytes, así que esto documenta el comportamiento real.
    const unicodePassword = "🔒".repeat(PASSWORD_MIN_LENGTH)
    expect(passwordSchema.safeParse(unicodePassword).success).toBe(true)
  })

  it("acepta contraseñas con acentos y símbolos no ASCII", () => {
    expect(passwordSchema.safeParse("contraseñaseguraáé").success).toBe(true)
  })
})

describe("newPasswordFormSchema", () => {
  it("rechaza cuando la confirmación no coincide", () => {
    const result = newPasswordFormSchema.safeParse({
      password: "a".repeat(PASSWORD_MIN_LENGTH),
      confirm: "b".repeat(PASSWORD_MIN_LENGTH),
    })
    expect(result.success).toBe(false)
  })

  it("acepta cuando password y confirm coinciden y cumplen la política", () => {
    const password = "a".repeat(PASSWORD_MIN_LENGTH)
    expect(newPasswordFormSchema.safeParse({ password, confirm: password }).success).toBe(true)
  })
})

describe("signInFormSchema", () => {
  it("rechaza un email inválido", () => {
    expect(signInFormSchema.safeParse({ email: "no-es-un-email", password: "algo" }).success).toBe(false)
  })

  it("rechaza contraseña vacía", () => {
    expect(signInFormSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false)
  })

  it("acepta email y contraseña presentes, sin exigir el mínimo de 12 (S1: el servidor no debe distinguir)", () => {
    // El formulario de ENTRADA no aplica la política de longitud: una contraseña corta
    // simplemente falla en el servidor con el mismo mensaje genérico que una incorrecta.
    expect(signInFormSchema.safeParse({ email: "a@b.com", password: "x" }).success).toBe(true)
  })
})

describe("forgotPasswordFormSchema", () => {
  it("normaliza el email a minúsculas", () => {
    const result = forgotPasswordFormSchema.parse({ email: "USUARIO@Ejemplo.COM" })
    expect(result.email).toBe("usuario@ejemplo.com")
  })
})

describe("setInvitedPasswordFormSchema", () => {
  it("exige nombre no vacío, contraseña válida y confirmación igual", () => {
    const password = "a".repeat(PASSWORD_MIN_LENGTH)
    expect(
      setInvitedPasswordFormSchema.safeParse({ name: "Pablo", password, confirm: password }).success
    ).toBe(true)
    expect(setInvitedPasswordFormSchema.safeParse({ name: "", password, confirm: password }).success).toBe(false)
  })
})

describe("changePasswordFormSchema", () => {
  const password = "a".repeat(PASSWORD_MIN_LENGTH)

  it("exige la contraseña actual", () => {
    expect(
      changePasswordFormSchema.safeParse({ currentPassword: "", password, confirm: password }).success
    ).toBe(false)
  })

  it("rechaza cuando la confirmación no coincide", () => {
    expect(
      changePasswordFormSchema.safeParse({
        currentPassword: "vieja",
        password,
        confirm: "b".repeat(PASSWORD_MIN_LENGTH),
      }).success
    ).toBe(false)
  })

  it("acepta actual + nueva válida + confirmación igual", () => {
    expect(
      changePasswordFormSchema.safeParse({ currentPassword: "vieja", password, confirm: password }).success
    ).toBe(true)
  })

  it("no exige a la contraseña actual la política de longitud (es la de antes, no la nueva)", () => {
    expect(
      changePasswordFormSchema.safeParse({ currentPassword: "x", password, confirm: password }).success
    ).toBe(true)
  })
})

describe("isPasswordTooObvious()", () => {
  it("rechaza la parte local del correo tal cual", () => {
    expect(isPasswordTooObvious("pablo", "pablo@cfonomic.com")).toBe(true)
  })

  it("rechaza variantes con mayúsculas y símbolos de relleno", () => {
    expect(isPasswordTooObvious("Pablo!!", "pablo@cfonomic.com")).toBe(true)
  })

  it("acepta una contraseña sin relación con el email", () => {
    expect(isPasswordTooObvious("correcto-caballo-batería-grapa", "pablo@cfonomic.com")).toBe(false)
  })

  it("no da falso positivo con partes locales muy cortas", () => {
    expect(isPasswordTooObvious("una-contraseña-normal", "ab@cfonomic.com")).toBe(false)
  })
})
