"use client"

import { useNotification } from "@/app/(app)/context"
import { UploadButton } from "@/components/files/upload-button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { UserProfile } from "@/lib/auth"
import config from "@/lib/config"
import {
  Banknote,
  BookOpenCheck,
  Boxes,
  Building2,
  CalendarRange,
  ClockArrowUp,
  Coins,
  Contact,
  DoorClosed,
  DatabaseBackup,
  FileText,
  FolderKanban,
  FormInput,
  Gauge,
  Gift,
  History,
  Hourglass,
  House,
  Import,
  Landmark,
  Layers,
  ListTree,
  LockKeyhole,
  NotebookPen,
  Percent,
  ReceiptEuro,
  ReceiptText,
  Repeat,
  Scale,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Split,
  Table2,
  Tags,
  Target,
  TrendingUp,
  Upload,
  User,
  Users,
  Waypoints,
} from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect } from "react"
import { Blinker } from "./blinker"
import { OrgSwitcher, OrganizationOption } from "./org-switcher"
import { SidebarMenuItemWithHighlight } from "./sidebar-item"
import SidebarUser from "./sidebar-user"

type SidebarApp = {
  id: string
  name: string
  icon: string
}

const settingsItems = [
  { title: "Profile & Plan", href: "/settings/profile", icon: User, adminOnly: false },
  { title: "Organización", href: "/settings/organization", icon: Building2, adminOnly: false },
  // Ronda 2 (#12): la pantalla ya responde 404 a quien no es ADMIN; el menú no
  // debe ofrecer un enlace que lleva a un 404.
  { title: "Miembros", href: "/settings/members", icon: Users, adminOnly: true },
  // E2 · T11 — configuración contable. El plan y el mapa se LEEN con cualquier
  // rol (VIEWER incluido); sólo el import es exclusivo de ADMIN, así que es el
  // único con `adminOnly` — el resto respondería 404 y el menú no debe llevar
  // a un 404 (ronda 2, #12).
  { title: "Plan de cuentas", href: "/settings/accounts", icon: ListTree, adminOnly: false },
  // E3 · T12 — los ejercicios y su rejilla de meses los LEE cualquier rol; abrir,
  // bloquear y cerrar es de ADMIN, y eso lo deciden las acciones, no el menú.
  { title: "Ejercicios", href: "/settings/fiscal-years", icon: CalendarRange, adminOnly: false },
  // E9 · T17/T18 — inmovilizado, cuadros de deuda y rejilla de bloqueo de
  // periodos. Los tres los LEE cualquier rol: el cuadro de amortización, el de
  // vencimientos y el estado de cada mes son información de revisión. Dar de
  // alta y revisar es de EDITOR; la baja, la venta y el bloqueo son de ADMIN, y
  // lo exigen las acciones, no el menú.
  { title: "Inmovilizado", href: "/settings/assets", icon: Boxes, adminOnly: false },
  { title: "Deuda", href: "/settings/debt", icon: Landmark, adminOnly: false },
  { title: "Bloqueo de periodos", href: "/settings/periods", icon: LockKeyhole, adminOnly: false },
  { title: "Mapa de cuentas", href: "/settings/account-map", icon: Waypoints, adminOnly: false },
  { title: "Impuestos", href: "/settings/taxes", icon: Percent, adminOnly: false },
  // E8 · T23 — calificación fiscal de terceros y de la organización (ADR-0014
  // D11). La LEE cualquier rol; escribir es de ADMIN y lo exige la acción.
  { title: "Terceros y fiscalidad", href: "/settings/counterparties", icon: Contact, adminOnly: false },
  // E8 · T17 — configuración del camino documental. Los prompts son de ADMIN
  // (cambian lo que el modelo lee); las series y las tasas las LEE cualquier
  // rol y escribirlas lo exige la acción, no el menú.
  { title: "Prompts de extracción", href: "/settings/prompts", icon: Sparkles, adminOnly: true },
  { title: "Facturación", href: "/settings/invoicing", icon: ReceiptText, adminOnly: false },
  { title: "Auditoría de cambios", href: "/settings/audit", icon: ScrollText, adminOnly: true },
  { title: "LLM settings", href: "/settings/llm", icon: Sparkles, adminOnly: true },
  { title: "Fields", href: "/settings/fields", icon: FormInput, adminOnly: true },
  { title: "Categories", href: "/settings/categories", icon: Tags, adminOnly: true },
  // E4 · T13 — configuración analítica: niveles de margen versionados, destino
  // obligatorio y nivel de lo no analítico. La LEE cualquier rol; escribir es
  // de ADMIN y lo exige la acción, no el menú. `/settings/projects` ya no está:
  // el CRUD heredado lo sustituye `/analytics/projects` (D-E4-1) y la ruta
  // antigua redirige.
  { title: "Analítica", href: "/settings/analytics", icon: SlidersHorizontal, adminOnly: false },
  // E10 · T17 — empleados y tarifas, y plantilla por centro de coste y mes. Los
  // LEE cualquier rol: la tarifa individual se oculta a quien no es ADMIN dentro
  // de la propia pantalla (§10), que es donde se puede distinguir «oculta» de
  // «no hay». Registrar plantilla es de EDITOR y fijar tarifas de ADMIN, y lo
  // exigen las acciones.
  { title: "Empleados", href: "/settings/employees", icon: Contact, adminOnly: false },
  { title: "Plantilla", href: "/settings/headcount", icon: Target, adminOnly: false },
  // E6 · T17 — umbrales de variación del sello (`Organization.reviewThresholds`).
  // Los lee cualquier rol; cambiarlos es de ADMIN y lo exige la acción.
  { title: "Umbrales de revisión", href: "/settings/review-thresholds", icon: Gauge, adminOnly: false },
  { title: "Currencies", href: "/settings/currencies", icon: Coins, adminOnly: false },
  { title: "Backup & Restore", href: "/settings/backups", icon: DatabaseBackup, adminOnly: true },
]

export function AppSidebar({
  profile,
  unsortedFilesCount,
  isSelfHosted,
  apps,
  organizations,
  activeOrganizationId,
  isAdmin,
  canEdit,
}: {
  profile: UserProfile
  unsortedFilesCount: number
  isSelfHosted: boolean
  apps: SidebarApp[]
  organizations: OrganizationOption[]
  activeOrganizationId: string
  isAdmin: boolean
  canEdit: boolean
}) {
  const { open, setOpenMobile } = useSidebar()
  const pathname = usePathname()
  const { notification } = useNotification()
  const accountTitle = profile.name || profile.email
  const accountSubtitle = isSelfHosted ? `Version ${config.app.version}` : profile.email

  // Hide sidebar on mobile when clicking an item
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  return (
    <>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <Link href="/" className="flex min-w-0 items-center gap-2 px-1 py-1">
            <Image src="/logo/256.png" alt="Logo" className="h-7 w-7 shrink-0 rounded-lg" width={28} height={28} />
            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-xs text-muted-foreground">{accountTitle}</span>
              <span className="truncate text-xs text-muted-foreground">{accountSubtitle}</span>
            </div>
          </Link>
          <SidebarMenu>
            <SidebarMenuItem>
              <OrgSwitcher
                organizations={organizations}
                activeOrganizationId={activeOrganizationId}
                canManageMembers={isAdmin}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {canEdit && (
            <SidebarGroup>
              <UploadButton className="w-full mt-4 mb-2">
                <Upload className="h-4 w-4" />
                {open ? <span>Upload</span> : ""}
              </UploadButton>
            </SidebarGroup>
          )}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItemWithHighlight href="/dashboard">
                  <SidebarMenuButton asChild>
                    <Link href="/dashboard">
                      <House />
                      <span>Home</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItemWithHighlight>

                <SidebarMenuItemWithHighlight href="/transactions">
                  <SidebarMenuButton asChild>
                    <Link href="/transactions">
                      <FileText />
                      <span>Transactions</span>
                      {notification && notification.code === "sidebar.transactions" && notification.message && (
                        <Blinker />
                      )}
                      <span></span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItemWithHighlight>

                <SidebarMenuItemWithHighlight href="/unsorted">
                  <SidebarMenuButton asChild>
                    <Link href="/unsorted">
                      <ClockArrowUp />
                      <span>Bandeja de documentos</span>
                      {unsortedFilesCount > 0 && (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                          {unsortedFilesCount}
                        </span>
                      )}
                      {notification && notification.code === "sidebar.unsorted" && notification.message && <Blinker />}
                      <span></span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItemWithHighlight>
                {/* E8 · T15/T17 — el resto del camino documental. La
                    confirmación por lote la ve cualquier rol (enseña qué entra
                    y qué no, que es información de revisión) y sólo un EDITOR
                    contabiliza; la acción lo vuelve a exigir. */}
                <SidebarMenuItemWithHighlight href="/unsorted/batch">
                  <SidebarMenuButton asChild>
                    <Link href="/unsorted/batch">
                      <Layers />
                      <span>Confirmación por lote</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItemWithHighlight>

                <SidebarMenuItemWithHighlight href="/apps/invoices">
                  <SidebarMenuButton asChild>
                    <Link href="/apps/invoices">
                      <ReceiptText />
                      <span>Facturas emitidas</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItemWithHighlight>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* E3 · T11/T12 — Contabilidad (`ui-erp` §Navegación). El diario, el
              mayor y sumas y saldos los lee cualquier rol; "Nuevo asiento" sólo
              aparece con permiso de edición, y la acción lo vuelve a exigir. */}
          <SidebarGroup>
            <SidebarGroupLabel>Contabilidad</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {[
                  { title: "Libro diario", href: "/ledger", icon: BookOpenCheck, editorOnly: false },
                  { title: "Nuevo asiento", href: "/ledger/new", icon: NotebookPen, editorOnly: true },
                  { title: "Mayor", href: "/ledger/mayor", icon: ListTree, editorOnly: false },
                  { title: "Sumas y saldos", href: "/ledger/sumas-saldos", icon: Scale, editorOnly: false },
                  // E9 · T16 — el asistente de cierre lo LEE cualquier rol (§10).
                  { title: "Cierre del ejercicio", href: "/ledger/closing", icon: DoorClosed, editorOnly: false },
                  // E9 · T17 — reglas recurrentes y periodificaciones. Las LEE
                  // cualquier rol; generar es de EDITOR y revertir de ADMIN.
                  { title: "Recurrentes", href: "/ledger/recurring", icon: Repeat, editorOnly: false },
                ]
                  .filter((item) => !item.editorOnly || canEdit)
                  .map((item) => (
                    <SidebarMenuItemWithHighlight key={item.href} href={item.href}>
                      <SidebarMenuButton asChild>
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItemWithHighlight>
                  ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* E6 · T16/T17 — Informes (`ui-erp` §Navegación). Los cinco los LEE
              cualquier rol: emitir un informe escribe un `ReportRun`, que es un
              hecho fechado y no una mutación de negocio, así que un VIEWER
              consulta y exporta sin ver un solo botón de mutación. Forzar y
              levantar la revisión sólo aparecen para ADMIN dentro del
              histórico, y las acciones lo vuelven a exigir. */}
          <SidebarGroup>
            <SidebarGroupLabel>Informes</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {[
                  { title: "Balance", href: "/reports/balance", icon: Scale },
                  { title: "Pérdidas y ganancias", href: "/reports/pyg", icon: TrendingUp },
                  { title: "Cashflow", href: "/reports/cashflow", icon: Banknote },
                  { title: "Antigüedad de saldos", href: "/reports/aging", icon: Hourglass },
                  // E9 · T18 — libro registro, casillas del 303, prorrata y
                  // liquidaciones. Se LEEN con cualquier rol; liquidar, revertir
                  // y cerrar la prorrata son de ADMIN y lo exige la acción.
                  { title: "IVA", href: "/reports/vat", icon: ReceiptEuro },
                  { title: "Histórico de informes", href: "/reports/runs", icon: History },
                ].map((item) => (
                  <SidebarMenuItemWithHighlight key={item.href} href={item.href}>
                    <SidebarMenuButton asChild>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItemWithHighlight>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* E4 · T13 — Analítica (`ui-erp` §Navegación), entre Contabilidad e
              Informes. Todo se LEE con cualquier rol: la PyG analítica y las
              fichas de dimensión no tienen botones de mutación para un VIEWER,
              y las acciones vuelven a exigir el rol. */}
          <SidebarGroup>
            <SidebarGroupLabel>Analítica</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {[
                  { title: "PyG analítica", href: "/analytics/pyg", icon: Scale },
                  // E10 · T16 — presupuesto vs real: la matriz con las cinco
                  // columnas por celda. La LEE cualquier rol.
                  { title: "Presupuesto vs real", href: "/analytics/budget-vs-actual", icon: Gauge },
                  { title: "Proyectos", href: "/analytics/projects", icon: FolderKanban },
                  // E10 · T17 — partes de horas: el driver de actividad. Los LEE
                  // cualquier rol; capturar y aprobar es de EDITOR y lo exige la
                  // acción, no el menú.
                  { title: "Horas", href: "/time", icon: Hourglass },
                  { title: "Centros de coste", href: "/analytics/cost-centers", icon: Target },
                  { title: "Líneas de negocio", href: "/analytics/business-lines", icon: Waypoints },
                  // E10 · T15 — Presupuesto: la decisión con la que se mide el
                  // real. Se LEE con cualquier rol; editar y sellar exigen rol.
                  { title: "Presupuesto", href: "/analytics/budget", icon: Table2 },
                  // E5 · T11/T12 — Liquidaciones: la política (reglas) y su
                  // aplicación (runs). Ambas se LEEN con cualquier rol.
                  { title: "Reglas de liquidación", href: "/analytics/allocations", icon: Split },
                  { title: "Liquidaciones", href: "/analytics/allocations/runs", icon: History },
                ].map((item) => (
                  <SidebarMenuItemWithHighlight key={item.href} href={item.href}>
                    <SidebarMenuButton asChild>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItemWithHighlight>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* E7 · T12/T16 — Auditoría. La pestaña y la conciliación bancaria las
              LEE cualquier rol: el sello, el semáforo y el cuadre son
              información de auditoría, no de edición. Barrer, importar y
              conciliar son de EDITOR; el barrido del almacén, el alta de cuentas
              y el registro son de ADMIN, y lo exigen las acciones, no el menú.
              El bloque `AuditLog` de `/audit` sólo se pinta para ADMIN. */}
          <SidebarGroup>
            <SidebarGroupLabel>Auditoría</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {[
                  { title: "Auditoría", href: "/audit", icon: ShieldCheck },
                  { title: "Conciliación bancaria", href: "/audit/bank", icon: Banknote },
                ].map((item) => (
                  <SidebarMenuItemWithHighlight key={item.href} href={item.href}>
                    <SidebarMenuButton asChild>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItemWithHighlight>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {apps.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>Apps</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {apps.map((app) => (
                    <SidebarMenuItemWithHighlight key={app.id} href={`/apps/${app.id}`}>
                      <SidebarMenuButton asChild>
                        <Link href={`/apps/${app.id}`}>
                          <span className="text-base leading-none">{app.icon}</span>
                          <span>{app.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItemWithHighlight>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {settingsItems
                  .filter((item) => !item.adminOnly || isAdmin)
                  .map((item) => (
                  <SidebarMenuItemWithHighlight key={item.href} href={item.href}>
                    <SidebarMenuButton asChild>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItemWithHighlight>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarRail />
        <SidebarFooter>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {canEdit && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link href="/import/csv">
                        <Import />
                        Import from CSV
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {isSelfHosted && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link href="https://vas3k.com/donate/" target="_blank">
                        <Gift />
                        Thank the author
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {!open && (
                  <SidebarMenuItem>
                    <SidebarTrigger />
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {!isSelfHosted && (
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarUser profile={profile} isSelfHosted={isSelfHosted} />
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarFooter>
      </Sidebar>
    </>
  )
}
