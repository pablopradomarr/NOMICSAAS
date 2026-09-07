// E13 · T11 — Test de `MembersTable` (docs/design/E13-autenticacion.md §6.1, §6.4, §8.2 T11).
//
// Mismo patrón que `components/auth/*.test.tsx`: estado inicial con `renderToStaticMarkup`.
// La protección real vive en `sendMemberPasswordResetAction` (`withOrg(Role.ADMIN)`); aquí sólo
// se comprueba que el botón se pinta condicionado a `canManage` (ADMIN) y no para VIEWER/EDITOR.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { MemberRow, MembersTable } from "./members-table"

const members: MemberRow[] = [
  {
    userId: "11111111-1111-1111-1111-111111111111",
    name: "Ana Admin",
    email: "ana@example.com",
    role: "ADMIN",
    memberSince: "01/01/2026",
    isLastAdmin: false,
    isCurrentUser: false,
  },
  {
    userId: "22222222-2222-2222-2222-222222222222",
    name: "Vera Viewer",
    email: "vera@example.com",
    role: "VIEWER",
    memberSince: "02/01/2026",
    isLastAdmin: false,
    isCurrentUser: false,
  },
]

describe("MembersTable — ADMIN (canManage)", () => {
  it("pinta el botón «Enviar enlace de restablecimiento» por cada fila", () => {
    const html = renderToStaticMarkup(<MembersTable members={members} canManage />)

    const buttonCount = (html.match(/Enviar enlace de restablecimiento/g) || []).length
    expect(buttonCount).toBe(members.length)
    expect(html).toContain("Quitar")
    expect(html).toContain("Acciones")
  })
})

describe("MembersTable — VIEWER/EDITOR (sin canManage)", () => {
  it("no pinta el botón de restablecimiento ni la columna de acciones", () => {
    const html = renderToStaticMarkup(<MembersTable members={members} canManage={false} />)

    expect(html).not.toContain("Enviar enlace de restablecimiento")
    expect(html).not.toContain("Quitar")
    expect(html).not.toContain("Acciones")
  })
})
