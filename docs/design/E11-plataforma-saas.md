# E11 — Plataforma SaaS (diseño)

Autor: `arquitecto` · **Ronda 2** (validación contable incorporada), 2026-09-15 ·
Épica: **E11** · Depende de: E1, E2, E3, E8, E9, E10, E13 · Nivel: **2** →
**ADR-0019 PROPUESTO (D1–D8)** ·
**Validación contable:** `docs/design/E11-validacion-plataforma.md` —
**OBSERVACIONES**: cinco bloqueantes (**O-1, O-3, O-4, O-7, O-9/O-10**), diez no
bloqueantes y **C-1…C-7 respondidas**. **Las quince están incorporadas.** ·
**Decisiones de Pablo** (permiso delegado 2026-09-04): **P-1…P-8 resueltas** (§17) ·
Formato de referencia: `docs/design/E10-presupuesto-horas.md`

> **Nada de este documento es código de producto.** Los fragmentos Prisma y las
> firmas TypeScript son **contratos**.

---

## 0. Ronda 2 — qué cambió y dónde

### 0.1 Los cinco bloqueantes del `experto-contable`

| # | Qué era | Dónde se cierra ahora |
|---|---|---|
| **O-1** | **Los tres hashes no bastan como criterio P7.** No cubren `entryNumber` (dos asientos con los números intercambiados dan el mismo `ledgerHash`), ni las series, ni los sellos derivados, ni el `AuditLog`, ni `exchange_rates` —que es **tabla global y por tanto no está en `TENANT_MODELS` ni en el backup**—, ni el estado del cierre | **§5.4** (`restoreVerification.json` con seis comprobaciones), **§5.2** (sección `global/` del ZIP con las tasas referenciadas), **I-E11-2 reescrito** (§11), **ADR-0019 D2.6** |
| **O-3** | **Un límite de plan impedía registrar un hecho contable ya ocurrido.** `maxEntriesMonth` pasaba por el guardián y el asiento 2 001 se rechazaba; en `READ_ONLY`, `postEntryAction` devolvía error. Y la excepción de I-E11-4 exigía un operador que en E11 **no existe** | **§3.5** (cuotas **duras** vs **blandas**), **§3.2** (las tres clases que siguen permitidas en mora), **I-E11-4 con excepción automática y registrada**, **ADR-0019 D7** (decisión nueva) |
| **O-4** | **El FREE en mora no podía ejercer la portabilidad que D6 promete**: `maxBackupsMonth = 1`, `graceDays = 0`, retención 7 días. Gastado el backup, no hay salida | **§3.5** (`BackupTrigger.EXIT` sin cuota), **§5.5** (ventana de 90 días tras `CANCELED`), **ADR-0019 D6 ampliado** |
| **O-7** | **La siembra dejaba organizaciones que incumplen I-E11-10 por construcción**: series en el paso 4 y exigidas siempre (a); ejercicio creado en dos sitios (b); **I-E11-10 no miraba `TaxRate`** (c) — literalmente R-2 de E9 otra vez | **§6.1** (series y ejercicio provisional en el paso 1; el asistente sólo renombra), **I-E11-10 con nueve piezas** |
| **O-9 / O-10** | **`PlatformInvoice` no podía sostener una obligación de facturación** (sin serie, sin `number NOT NULL`, sin fecha de operación, sin tratamiento fiscal, sin copia conservada) y **nuestra serie no la vigilaba nadie**, aplicándole al cliente un rigor que no nos aplicamos (I-E8-20) | **§2.2** (`PlatformInvoiceSeries` + 14 campos nuevos), **§2.5** (`StoredObjectKind.PLATFORM_INVOICE`), **I-E11-13** (espejo exacto de I-E8-20), **ADR-0019 D8** (decisión nueva) |

### 0.2 Las diez no bloqueantes

| # | Corrección aplicada |
|---|---|
| **O-2** | `RestoreStatus` gana **`DONE_UNVERIFIED`**: `DONE` queda reservado a `verified = true`. Un operador que filtre por `DONE` no puede leer como bueno lo que el ADR declara FAIL (§2.4) |
| **O-5** | El recuento de `entries` **excluye** contra-asientos (`reversesEntryId IS NOT NULL`), asientos de sistema (`kind ∈ {REGULARIZATION, CLOSING, OPENING}` y T-25…T-28) y los de la demo. Corregir un error dejaba de costar el doble que dejarlo (§3.4) |
| **O-6** | **La demo va a una organización propia** (`Organization.isDemo`, inmutable), nunca dentro de la del cliente: «vaciar la demo» pasa a ser borrar esa organización y **desaparece el botón que borraba asientos posteados** (§6.3) |
| **O-8** | **I-E11-8 se conserva palabra por palabra** y se le añaden dos puertas: ningún `Transaction`/`ExtractionRun`/`File` puede tener por origen una `PlatformInvoice`, y la contabilidad de CFOnomic **no vive en una «organización plataforma» con privilegios** (§11) |
| **O-11** | `kind = PLATFORM_INVOICE` **excluido de la retención** de 30/90 días y de la cuota del cliente; se escribe que **no existe borrado de organización con asientos** y que el `Cascade` es integridad referencial, no camino de producto (§5.5) |
| **O-12** | (a) `CHECK (currency IN ('EUR','USD'))` en `PlatformInvoice`; (b) `usageSourceHash` declara **`periodMonth` como periodo exacto** del `ledgerHash`; (c) el cálculo de `storageBytes` y I-E11-6 filtran **por `kind`**, no por prefijo (§2.2, §3.4) |
| **O-13** | El cron **pasa `refDate` explícito** y la ocurrencia se fecha por **su periodo de devengo**, nunca por la ejecución; y se escribe qué hace cada job en mora (§7.2) |
| **O-14** | No aplica: **no hay ningún cliente con saldo** (P-4 verificado sobre el preview, 1 organización). Aun así, M4 **comprueba y aborta** si encuentra `aiBalance > 0` en alguna organización, e imprime el importe en euros al precio de venta. No se supone: se comprueba (§2.7) |
| **O-15** | El tratamiento de la venta a empresario UE se llama **`NO_SUJETO_LOCALIZACION_UE`**, no «ISP» —la inversión la aplica el destinatario en su Estado—; en la **factura** sí se imprime la mención. Y se corrige la afirmación de la ronda 1: C-3, C-4 y C-5 **sí cambian el esquema**; «no cambian el motor» no es «no cambian nada» |

### 0.3 El recorte: 836 h → **726 h**

La ronda 2 añade **104 h de trabajo bloqueante** (O-1, O-3, O-4, O-6, O-7, O-9,
O-10, O-13). Para que la épica siga siendo entregable, **salen 214 h** de alcance
que no es lo que el ROADMAP pide de E11 («Stripe por organización, backups por
organización de todas las tablas, límites por plan, onboarding»):

| Sale | h | A dónde, y por qué |
|---|---|---|
| **CAPEX (`BudgetCapexLine`, D-4)** | 34 | **→ E12.** Es control de gestión, no plataforma: no comparte una tabla con nada de esta épica, y arrastra el reversionado del fixture y una enmienda a ADR-0018 D2 que no tiene por qué ir empaquetada con Stripe. **Sale también de ADR-0019** (la D5 de la ronda 1 desaparece) |
| **Celda mensual, volumen/precio y rentabilidad por proyecto (D-5, D-6, D-7)** | 40 | **→ E12.** Mismo motivo. La convención ya está congelada en **ADR-0018 D6**; implementarla no urge y no bloquea nada de plataforma |
| **`/admin` completo** | 24 | **→ E12.** En E11 queda sólo `/api/health`. Sin escrituras (P-6) su valor es un panel de lectura que el operador puede sustituir por SQL durante una épica |
| **Export 303 / 349 desde `/admin` (C-6)** | 10 | **→ E14**, con la venta. Los campos que lo alimentan (O-9) **sí entran ahora**: lo que se aplaza es la pantalla, no el dato |
| **Backups programados (`backup-schedule`)** | 14 | **→ E12.** El backup manual y el de salida cubren lo que el ROADMAP pide y lo que O-4 exige |
| **Restaurar desde un ZIP subido por el usuario, en la UI** | 12 | **→ E12.** En E11 se restaura desde un backup que vive en la plataforma, que es el caso real; un ZIP ajeno entra por script de operador |
| **CSV dentro del ZIP** | 8 | **→ E12.** El JSONL es el formato que manda; el CSV era comodidad |
| **Lector de `formatVersion 1.0`** | 10 | **Retirado.** No existe ni un backup 1.0: el preview tiene una organización y nunca se descargó uno |
| **`email-sync` como job de cron** | 6 | **→ E12.** Es funcionalidad heredada de TaxHacker, no plataforma |
| **Asistente de 7 pasos → 6, y poda de UI** | 20 | Simplificación (§6.2) |
| **Reestimación tras acotar** | 36 | — |

**Queda fechado en `ESTADO.md` con épica de cierre**, como exige `CLAUDE.md`. Lo que
**no** sale: las ocho deudas que sí son de plataforma (§0.4).

### 0.4 Deuda heredada que E11 cierra

| # | Deuda | Origen | Tarea |
|---|---|---|---|
| **D-1** | **G-15 · backups**: volcado incompleto, restore que silencia errores por fila y los cuenta como insertados. Último gap MEDIA abierto junto a G-14 | `AUDITORIA-FIABILIDAD.md` | T7–T9 |
| **D-2** | **Serie `ORDINARIA` no sembrada** | `ESTADO.md` §E8 | T12 |
| **D-3** | **Mes de alta de la amortización como preferencia de organización** | E10 §0-bis | T14 |
| **D-8** | **Calendario de `/time`: agregado por (empleado, día) en SQL** | `ESTADO.md` §E10 (C1) | T21 |
| **D-9** | **PUEDE 14 · extensión y mimetype del import en el borde** | `ESTADO.md` §E10 | T21 |
| **D-10** | **Rate limit en memoria** (E1 → E13 R4) | ADR-0017 | T17 |
| **D-11** | **Uploads efímeros en `/tmp`** | `DESPLIEGUE-PREVIEW.md` §7 | T4–T5 |
| **D-12** | **Sin cron en el despliegue** | `DESPLIEGUE-PREVIEW.md` §7 | T15–T16 |

Y dos **erratas documentales** que se corrigen en T24, no se arrastran:

- **`G-15` estaba duplicado.** El canónico de `AUDITORIA-FIABILIDAD.md` —el que
  `codebase-taxhacker/SKILL.md` ordena no reenumerar— es **backups**, que E11
  cierra. La fila de `ESTADO.md` que fechaba en E11 «facturación emitida completa
  (PDF, envío, cobro)» habla de otra cosa: **→ E14 Ciclo comercial**, épica nueva
  (P-7 aprobado).
- **`G-20`** (sin tests de `models/stats.ts`, `lib/stats.ts`, `ai/*`) **no aparece
  en ninguna lista de cierre de ninguna épica.** Fechado en **E12**.

---

## 1. Objetivo y alcance

**Objetivo.** Convertir el ERP en un producto SaaS operable: una organización se da
de alta sola y **nace completa**; su plan y su suscripción viven en Stripe y se
reflejan en la organización, no en el usuario; los límites se aplican en el
servidor **sin impedir jamás el registro de un hecho contable ya ocurrido**; sus
ficheros viven en un almacén persistente y verificable; puede descargar un backup
íntegro y firmado **y restaurarlo obteniendo los mismos sellos**; y hay un reloj que
hace lo que hoy depende de que alguien ejecute un script.

El criterio que manda es **P7**, y tras O-1 su enunciado es más exigente que en la
ronda 1: un backup restaurado tiene que reproducir los tres hashes **y** la
numeración, **y** las series, **y** todos los sellos derivados, **y** el `AuditLog`,
**y** las tasas de cambio que sus líneas referencian, **y** pasar el barrido de las
nueve familias de invariantes. Si no, no es un backup: es una copia parecida.

### 1.1 Alcance

1. **Facturación por organización**: `Plan` versionado, `Subscription`,
   `SubscriptionEvent` append-only, `PlatformInvoiceSeries` + `PlatformInvoice`
   **con numeración propia y copia conservada** (O-9, O-10, C-1…C-5).
2. **Uso derivado**, nunca almacenado: `UsageRun` cacheado por hash de fuentes.
3. **Límites en dos clases** (O-3): **cuota de recurso**, que bloquea; **cuota sobre
   el registro contable**, que **nunca** bloquea.
4. **Backup y restauración** con manifest firmado y verificación P7 ampliada.
5. **Almacenamiento persistente** (Supabase Storage por su endpoint S3).
6. **Onboarding** con siembra atómica de **nueve piezas** y demo **en organización
   propia**.
7. **Cron de plataforma** (cuatro jobs) por **GitHub Actions**, con `refDate`
   explícito.
8. **Seguridad**: webhook idempotente, secretos cifrados, rate limits persistentes,
   RLS estricta.
9. **UI**: `/settings/subscription`, `/settings/backups`, `/onboarding`.
10. **Las ocho deudas de §0.4.**

### 1.2 Qué NO incluye

- Todo lo de **§0.3** (CAPEX, celda mensual, `/admin`, 303/349, backups
  programados, restaurar ZIP ajeno por UI, CSV en el ZIP, lector 1.0, `email-sync`).
- **Ciclo comercial** (PDF de la factura emitida al cliente, envío, cobro): **E14**.
- **G-14** (segundo LLM verificador) y los tests C1–C7: **E12**.
- **Venta B2C y OSS.** **B2B-only con NIF-IVA obligatorio y validado** (P-1, C-1):
  admitir B2C UE obliga a alta en OSS (modelos 035 y 369) por un segmento residual
  en un ERP para PYMEs, y construir sobre el umbral de 10 000 € del art. 73 LIVA es
  deuda fiscal con fecha.
- **Facturación por consumo, prorrateos y créditos.** El importe lo decide Stripe.
- **Plan de continuidad del operador** (copias de Supabase, RPO/RTO): el backup es
  una **exportación del cliente**, no el DR del operador. Va al runbook.
- **Contabilizar la facturación de la plataforma en el diario del cliente**:
  prohibido por **I-E11-8**, y ahora también por el camino indirecto (O-8).
- **Borrado de organización.** No existe, y §5.5 explica por qué.
- SSO, SCIM, 2FA, transferencia de propiedad.

---

## 2. Modelo de datos

### 2.1 Convenciones

Importes en **céntimos enteros**; los de la plataforma en la moneda de la
suscripción, **con la cuota siempre además en euros** (C-4). `organizationId` en
toda tabla de negocio + `SELECT app.enforce_tenant_rls('<tabla>')` + alta en
`TENANT_MODELS`; las que no lo llevan son catálogo global o de plataforma (§9.5).
Bytes en `BigInt` (`storage_used` es hoy `integer`: techo 2,1 GB, y un plan PRO son
100 GB). Fechas contables `@db.Date`; `DateTime` sólo para auditoría técnica y para
los instantes que manda Stripe. Nada se borra.

### 2.2 Facturación

```prisma
/// Catálogo GLOBAL versionado por vigencia. Límites como COLUMNAS, no JSON:
/// así la base los puede comprobar y un cambio de forma exige migración.
model Plan {
  id   String @id @default(uuid()) @db.Uuid
  code String @db.VarChar(32)

  name        String @db.VarChar(64)
  description String @db.VarChar(512)

  listPriceCents Int          @map("list_price_cents")
  currency       String       @default("EUR") @db.VarChar(3)
  interval       PlanInterval
  stripePriceId  String?      @unique @map("stripe_price_id") @db.VarChar(64)

  // Cuotas de RECURSO (bloquean — §3.5)
  maxMembers       Int    @map("max_members")
  maxOcrDocsMonth  Int    @map("max_ocr_docs_month")
  maxStorageBytes  BigInt @map("max_storage_bytes")
  maxExportsMonth  Int    @map("max_exports_month")
  maxBackupsMonth  Int    @map("max_backups_month")
  maxOrganizations Int    @map("max_organizations")

  /// Cuota BLANDA sobre el registro contable (O-3): avisa, nunca bloquea.
  /// El nombre lo dice, para que nadie la cablee al guardián por descuido.
  softMaxEntriesMonth Int @map("soft_max_entries_month")

  graceDays Int @default(14) @map("grace_days")
  isPublic  Boolean @default(true) @map("is_public")

  validFrom DateTime  @map("valid_from") @db.Date
  validTo   DateTime? @map("valid_to")   @db.Date

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  subscriptions Subscription[]

  @@unique([code, validFrom])
  @@map("plans")
}

enum PlanInterval { MONTH YEAR }

model Subscription {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @unique @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  planCode String @map("plan_code") @db.VarChar(32)
  /// FK a la VERSIÓN contratada: un cambio de límites no reescribe
  /// retroactivamente lo que se le prometió a un cliente.
  planId   String @map("plan_id") @db.Uuid
  plan     Plan   @relation(fields: [planId], references: [id], onDelete: Restrict)

  stripeSubscriptionId String?            @unique @map("stripe_subscription_id") @db.VarChar(64)
  status               SubscriptionStatus @default(TRIALING)

  currentPeriodStart DateTime? @map("current_period_start")
  currentPeriodEnd   DateTime? @map("current_period_end")
  cancelAtPeriodEnd  Boolean   @default(false) @map("cancel_at_period_end")
  trialEnd           DateTime? @map("trial_end")
  graceUntil         DateTime? @map("grace_until")
  /// O-4: ventana de descarga tras CANCELED (90 días), por encima de la
  /// retención del plan. La portabilidad no la puede desactivar un precio.
  exportWindowUntil  DateTime? @map("export_window_until")

  // Datos fiscales del destinatario (C-1). La prueba se conserva EN NUESTRO
  // LADO y se revalida en CADA devengo: un NIF-IVA se da de baja.
  customerCountry    String?   @map("customer_country") @db.VarChar(2)
  vatNumber          String?   @map("vat_number") @db.VarChar(20)
  vatValidatedAt     DateTime? @map("vat_validated_at")
  vatValidationSource String?  @map("vat_validation_source") @db.VarChar(24)
  vatValidationRef   String?   @map("vat_validation_ref") @db.VarChar(64)

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  events   SubscriptionEvent[]
  invoices PlatformInvoice[]

  @@index([status, currentPeriodEnd])
  @@map("subscriptions")
}

enum SubscriptionStatus { TRIALING ACTIVE PAST_DUE GRACE CANCELED INCOMPLETE PAUSED }

/// Append-only. `stripeEventId` UNIQUE es la idempotencia (I-E11-9).
model SubscriptionEvent {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  subscriptionId String?       @map("subscription_id") @db.Uuid
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)

  stripeEventId String   @unique @map("stripe_event_id") @db.VarChar(64)
  eventType     String   @map("event_type") @db.VarChar(64)
  occurredAt    DateTime @map("occurred_at")

  statusBefore SubscriptionStatus? @map("status_before")
  statusAfter  SubscriptionStatus  @map("status_after")
  /// Payload RECORTADO (§9.2): ids, tipo, precio, periodo y estado. Nunca el
  /// objeto íntegro, que lleva email, dirección de facturación e importes.
  payload      Json

  createdAt DateTime @default(now()) @map("created_at")

  @@index([organizationId, occurredAt])
  @@map("subscription_events")
}
```

**Serie y factura de la plataforma (O-9, O-10, C-1…C-5).** La numeración correlativa
dentro de serie la asigna **el expedidor**, que somos nosotros (arts. 6.1.a y 7
RD 1619/2012). Stripe deja **huecos** (borradores anulados, `void`, `draft` no
finalizadas) y según configuración numera por cliente: no puede ser nuestra serie.
Stripe queda como **pasarela de cobro y generador del PDF**.

```prisma
/// Serie propia de facturación de la plataforma. Global (no de tenant): la
/// serie es de CFOnomic, no de la organización. Espejo de `InvoiceSeries`.
model PlatformInvoiceSeries {
  id         String             @id @default(uuid()) @db.Uuid
  code       String             @unique @db.VarChar(16)   // PLT, PLT-R
  kind       InvoiceSeriesKind                             // ORDINARIA | RECTIFICATIVA
  prefix     String             @db.VarChar(16)            // PLT-2026-, PLT-R-2026-
  lastNumber Int                @default(0) @map("last_number")

  createdAt DateTime @default(now()) @map("created_at")

  invoices PlatformInvoice[]

  @@map("platform_invoice_series")
}

/// Factura que CFOnomic EMITE al cliente. **No genera asiento** (I-E11-8) y no
/// tiene ni una columna que lo permita.
model PlatformInvoice {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  subscriptionId String?       @map("subscription_id") @db.Uuid
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)

  // --- Serie propia (O-9, O-10) ---
  seriesId String                @map("series_id") @db.Uuid
  series   PlatformInvoiceSeries @relation(fields: [seriesId], references: [id], onDelete: Restrict)
  number   Int
  /// `PLT-2026-0001`. Denormalizado para imprimir y para indexar el objeto.
  fullNumber String @map("full_number") @db.VarChar(32)

  rectifiesInvoiceId  String?              @map("rectifies_invoice_id") @db.Uuid
  rectifies           PlatformInvoice?     @relation("Rectifica", fields: [rectifiesInvoiceId], references: [id], onDelete: Restrict)
  rectifiedBy         PlatformInvoice[]    @relation("Rectifica")
  rectificationCause  String?              @map("rectification_cause") @db.VarChar(256)
  rectificationMode   RectificationMode?   @map("rectification_mode")   // DIFERENCIAS | SUSTITUCION

  // --- Fechas (C-2). El plazo de expedición llega al día 16 del mes siguiente
  // al devengo; si difieren, AMBAS constan (arts. 6.1.f y 11 RD 1619/2012).
  operationDate DateTime @map("operation_date") @db.Date   // DEVENGO
  issuedAt      DateTime @map("issued_at")     @db.Date    // expedición
  /// Clave canónica del ERP, `AAAA-Qn` (ADR-0014 D8), derivada de operationDate.
  ivaPeriod     String   @map("iva_period") @db.VarChar(8)
  periodStart   DateTime? @map("period_start") @db.Date
  periodEnd     DateTime? @map("period_end")   @db.Date

  // --- Régimen fiscal (C-1, C-6) ---
  taxTreatment          TaxTreatment @map("tax_treatment")
  customerCountry       String       @map("customer_country") @db.VarChar(2)
  vatNumber             String?      @map("vat_number") @db.VarChar(20)
  vatValidatedAt        DateTime?    @map("vat_validated_at")
  vatValidationSource   String?      @map("vat_validation_source") @db.VarChar(24)
  vatValidationRef      String?      @map("vat_validation_ref") @db.VarChar(64)
  /// Texto impreso de la mención obligatoria (art. 6.1.m RD 1619/2012).
  reverseChargeMention  String?      @map("reverse_charge_mention") @db.VarChar(256)

  // --- Cifras. Tal cual las publica Stripe, en céntimos de SU moneda…
  subtotalCents Int    @map("subtotal_cents")
  taxCents      Int    @map("tax_cents")
  totalCents    Int    @map("total_cents")
  currency      String @db.VarChar(3)     // CHECK IN ('EUR','USD')  — O-12a
  // …y la CUOTA, siempre además en euros, a la tasa del DEVENGO (C-4).
  taxCentsEur   Int      @map("tax_cents_eur")
  fxRateMicro   Int?     @map("fx_rate_micro")
  fxRateDate    DateTime? @map("fx_rate_date") @db.Date
  fxSource      String?  @map("fx_source") @db.VarChar(24)

  status          String  @db.VarChar(24)
  stripeInvoiceId String  @unique @map("stripe_invoice_id") @db.VarChar(64)
  hostedInvoiceUrl String? @map("hosted_invoice_url") @db.VarChar(512)
  /// C-5: el PDF COPIADO a nuestro almacén. Un enlace a la copia de un tercero
  /// no es una copia conservada (art. 165.Uno LIVA, arts. 19–23 RD 1619/2012).
  storedObjectId  String? @map("stored_object_id") @db.Uuid

  createdAt DateTime @default(now()) @map("created_at")

  @@unique([seriesId, number])
  @@index([organizationId, operationDate])
  @@index([ivaPeriod])
  @@map("platform_invoices")
}

enum RectificationMode { DIFERENCIAS SUSTITUCION }

/// O-15: para NOSOTROS la venta a empresario UE **no es una ISP**: es una no
/// sujeción por regla de localización (art. 69.Uno.1º LIVA). La inversión la
/// aplica el destinatario en su Estado. En la FACTURA sí se imprime la mención.
enum TaxTreatment {
  REPERCUTIDO_ES
  NO_SUJETO_LOCALIZACION_UE
  NO_SUJETO_TERCER_PAIS
  NO_SUJETO_CANARIAS_CEUTA_MELILLA
}
```

**Regla de tipo de cambio para la factura de la plataforma (C-4).** La tasa es la
del **devengo** (`operationDate`), de la misma `ExchangeRate` del ERP (BCE vía
Frankfurter). **`RC-14` no aplica aquí**: la factura hay que emitirla igual, así que
en día sin publicación se usa la **última tasa anterior al devengo** y **la fecha de
esa tasa se imprime**. Se convierte **una sola vez y se sella**: no se recalcula al
mirarla.

### 2.3 Uso derivado: `UsageRun`

No existe ningún contador que se incremente al escribir. El uso es una **vista**, y
lo único que se persiste es una caché invalidable por hash, con el patrón de
`ReportRun` (ADR-0012).

```prisma
model UsageRun {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// Mes natural en la zona de la organización, primer día. Nunca `now()`.
  /// **O-12b**: éste, y no otro, es el periodo del `ledgerHash` que entra en
  /// `sourceHash`. Declararlo evita que dos meses colisionen.
  periodMonth DateTime @map("period_month") @db.Date

  sourceHash String @map("source_hash") @db.VarChar(64)
  gitSha     String @map("git_sha") @db.VarChar(40)

  members      Int    @map("members")
  entries      Int    @map("entries")
  ocrDocs      Int    @map("ocr_docs")
  exports      Int    @map("exports")
  backups      Int    @map("backups")
  storageBytes BigInt @map("storage_bytes")

  computedAt DateTime @default(now()) @map("computed_at")
  durationMs Int      @map("duration_ms")

  @@unique([organizationId, periodMonth, sourceHash, gitSha])
  @@index([organizationId, periodMonth])
  @@map("usage_runs")
}
```

> **Por qué `sourceHash` y no `updatedAt`.** Un `updatedAt` no detecta un borrado, y
> el uso tiene que bajar cuando alguien anula. El hash se calcula sobre recuentos y
> sellos, que sí bajan.

### 2.4 Backup y restauración

```prisma
model BackupJob {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  status      BackupStatus  @default(QUEUED)
  trigger     BackupTrigger
  progressBps Int           @default(0) @map("progress_bps")

  formatVersion String @map("format_version") @db.VarChar(8)   // "2.0"
  schemaVersion String @map("schema_version") @db.VarChar(16)
  gitSha        String @map("git_sha") @db.VarChar(40)

  objectKey      String? @map("object_key") @db.VarChar(512)
  sizeBytes      BigInt? @map("size_bytes")
  archiveSha256  String? @map("archive_sha256")  @db.VarChar(64)
  manifestSha256 String? @map("manifest_sha256") @db.VarChar(64)
  signature      String? @db.VarChar(128)
  signingKeyId   String? @map("signing_key_id") @db.VarChar(16)

  /// Los sellos del contenido en el momento del volcado. Son parte —**sólo
  /// parte**, tras O-1— del criterio P7 de §5.4.
  ledgerHash   String? @map("ledger_hash")   @db.VarChar(64)
  analyticsKey String? @map("analytics_key") @db.VarChar(64)
  budgetHash   String? @map("budget_hash")   @db.VarChar(64)

  rowCounts Json?   @map("row_counts")
  error     String? @db.VarChar(1024)

  requestedById String?   @map("requested_by_id") @db.Uuid
  startedAt     DateTime? @map("started_at")
  finishedAt    DateTime? @map("finished_at")
  expiresAt     DateTime? @map("expires_at")
  downloadCount Int       @default(0) @map("download_count")

  createdAt DateTime @default(now()) @map("created_at")

  restores RestoreJob[]

  @@index([organizationId, createdAt])
  @@index([status, createdAt])
  @@map("backup_jobs")
}

enum BackupStatus { QUEUED RUNNING DONE FAILED EXPIRED }
/// **O-4**: `EXIT` es el backup de portabilidad. No consume cuota, nunca.
enum BackupTrigger { MANUAL EXIT }

model RestoreJob {
  id String @id @default(uuid()) @db.Uuid

  /// Organización DESTINO: es la que acota la RLS de esta fila.
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  backupJobId String?    @map("backup_job_id") @db.Uuid
  backupJob   BackupJob? @relation(fields: [backupJobId], references: [id], onDelete: SetNull)

  status      RestoreStatus @default(QUEUED)
  progressBps Int           @default(0) @map("progress_bps")

  /// **O-1**: la verificación ya no son tres hashes. Es el documento completo
  /// de §5.4, con las seis comprobaciones enfrentadas una a una.
  verification Json?   @map("verification")
  verified     Boolean @default(false)
  /// Filas rechazadas CON MOTIVO. Una sola aborta el trabajo (§5.4).
  rejected     Json?
  error        String? @db.VarChar(1024)

  requestedById String?   @map("requested_by_id") @db.Uuid
  startedAt     DateTime? @map("started_at")
  finishedAt    DateTime? @map("finished_at")
  createdAt     DateTime  @default(now()) @map("created_at")

  @@index([organizationId, createdAt])
  @@map("restore_jobs")
}

/// **O-2**: `DONE` queda reservado a `verified = true`. Un operador que filtre
/// por DONE no puede leer como bueno lo que el ADR declara FAIL.
enum RestoreStatus { QUEUED RUNNING VERIFYING DONE DONE_UNVERIFIED FAILED }
```

### 2.5 Almacenamiento: `StoredObject`

```prisma
model StoredObject {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  objectKey String         @map("object_key") @db.VarChar(512)
  backend   StorageBackend
  sha256    String         @db.VarChar(64)
  sizeBytes BigInt         @map("size_bytes")
  mimeType  String         @map("mime_type") @db.VarChar(128)
  kind      StoredObjectKind

  verifiedAt DateTime? @map("verified_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  @@unique([organizationId, objectKey])
  @@index([organizationId, sha256])
  @@index([organizationId, kind, createdAt])
  @@map("stored_objects")
}

enum StorageBackend { LOCAL SUPABASE S3 }

/// **O-9/O-11**: `PLATFORM_INVOICE` es la copia conservada de NUESTRA factura.
/// No es del cliente: ni cuenta en su cuota ni cae bajo la retención de los ZIP.
enum StoredObjectKind { DOCUMENT PREVIEW BACKUP LOGO AVATAR PLATFORM_INVOICE }
```

### 2.6 Onboarding y plataforma

```prisma
model OnboardingRun {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @unique @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  step        OnboardingStep @default(COMPANY)
  completedAt DateTime?      @map("completed_at")

  pgcVariant PgcVariant @map("pgc_variant")
  /// **O-6**: la organización de DEMO que se creó desde este asistente, si se
  /// creó. La demo nunca vive dentro de la organización del cliente.
  demoOrganizationId String? @map("demo_organization_id") @db.Uuid

  seedReport Json? @map("seed_report")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  @@map("onboarding_runs")
}

/// Seis pasos (§6.2). El de facturación se fusiona con el de empresa: la serie
/// se siembra en el paso 1 (O-7a) y sólo se renombra.
enum OnboardingStep { COMPANY PLAN_ACCOUNTS FISCAL_YEAR MEMBERS DEMO DONE }

/// Idempotencia del reloj (I-E11-12). Tabla de PLATAFORMA: sin organizationId.
model CronRun {
  id        String     @id @default(uuid()) @db.Uuid
  job       String     @db.VarChar(48)
  periodKey String     @map("period_key") @db.VarChar(24)
  status    CronStatus @default(RUNNING)

  /// **O-13**: la fecha de referencia con la que se invocó. Un asiento generado
  /// por el reloj tiene que poder explicar con qué `refDate` se fechó.
  refDate   DateTime @map("ref_date") @db.Date

  cursor    Json?
  processed Int     @default(0)
  failed    Int     @default(0)
  error     String? @db.VarChar(1024)

  startedAt  DateTime  @default(now()) @map("started_at")
  finishedAt DateTime? @map("finished_at")

  @@unique([job, periodKey])
  @@index([job, startedAt])
  @@map("cron_runs")
}

enum CronStatus { RUNNING DONE PARTIAL FAILED }

/// Rate limit persistente (cierra D-10). `key` es SIEMPRE un sha256 (§9.2).
model RateLimitBucket {
  id        String   @id @default(uuid()) @db.Uuid
  scope     String   @db.VarChar(48)
  key       String   @db.VarChar(64)
  windowAt  DateTime @map("window_at")
  count     Int      @default(0)
  expiresAt DateTime @map("expires_at")

  @@unique([scope, key, windowAt])
  @@index([expiresAt])
  @@map("rate_limit_buckets")
}

/// Auditoría DE PLATAFORMA, append-only con el patrón RESTRICTIVE de `audit_logs`.
/// `organizationId` es opcional a propósito: un webhook cuyo cliente no resuelve
/// es justamente la fila que hay que poder ver.
model PlatformAuditLog {
  id             String   @id @default(uuid()) @db.Uuid
  at             DateTime @default(now())
  actor          String   @db.VarChar(64)      // "stripe" | "cron" | "operator:<sha256>"
  action         String   @db.VarChar(64)
  organizationId String?  @map("organization_id") @db.Uuid
  detail         Json

  @@index([at])
  @@index([organizationId, at])
  @@map("platform_audit_logs")
}
```

Y en `Organization`, tres columnas nuevas:

```prisma
  /// **O-6**: inmutable (trigger). Una organización de demo no cuenta contra
  /// `maxOrganizations`, no entra en el uso y se puede BORRAR ENTERA — que es
  /// como se «vacía la demo» sin borrar ni un asiento posteado.
  isDemo Boolean @default(false) @map("is_demo")
  /// **D-3**: preferencia de organización, no un cálculo. Por defecto
  /// MES_SIGUIENTE, que es lo que el motor de E9 ya hace.
  depreciationStartsOn DepreciationStart @default(MES_SIGUIENTE) @map("depreciation_starts_on")
  backupRetentionDays  Int               @default(30) @map("backup_retention_days")
```

### 2.7 Migración de las columnas heredadas

| Columna | Qué se hace |
|---|---|
| `membershipPlan`, `membershipExpiresAt`, `storageLimit` | Backfill → `Subscription` / `Plan`. Quedan **deprecadas y vivas** hasta E12 (retirarlas en la misma épica que las sustituye haría imposible un rollback), sin lectores: ESLint las prohíbe fuera de la migración |
| `aiBalance` | **Se retira como saldo.** Un saldo que se decrementa es la cifra que P2/P4 prohíben, y además nunca funcionó (G-12). **O-14**: M4 **comprueba y aborta** si encuentra alguna organización con `aiBalance > 0`, e imprime el importe **en euros al precio de venta**; la baja de un pasivo prepagado (438/485 en NUESTRA contabilidad) exige canje o devolución aceptados, no una novación unilateral. Verificado sobre el preview: **1 organización, saldo 0** — el punto decae, pero se comprueba, no se supone |
| `storageUsed` | Se conserva como **caché**, no como verdad. Pasa a `bigint`. El límite se evalúa contra `Σ StoredObject.sizeBytes` filtrado **por `kind`** (O-12c) en la misma transacción que escribe |

Backfill con el patrón obligatorio de `CLAUDE.md`: `NO FORCE` → backfill → `FORCE`
en la **misma** migración, con la marca escrita **antes** del backfill (runbook de
E3, `20260907120000_e3_prorrata_marker_order`). Toda organización existente recibe
`Subscription` `FREE`/`ACTIVE` sin `stripeSubscriptionId`: **I-E11-5** exige que
ninguna se quede sin fila.

### 2.8 Migraciones propuestas

| Nº | Nombre | Contenido |
|---|---|---|
| M1 | `e11_planes_suscripciones` | `plans`, `subscriptions`, `subscription_events` + enums + `EXCLUDE USING gist` de vigencias + `enforce_tenant_rls` en las dos con `organization_id` |
| M2 | `e11_uso_backups_almacen` | `usage_runs`, `backup_jobs`, `restore_jobs`, `stored_objects` + RLS |
| M3 | `e11_plataforma` | `cron_runs`, `rate_limit_buckets`, `platform_audit_logs` (append-only RESTRICTIVE), `onboarding_runs` + RLS en la última |
| M4 | `e11_backfill_suscripciones` | Catálogo de planes sembrado, backfill de `Subscription`, `storage_used/limit` a `bigint`, `Organization.isDemo`/`depreciationStartsOn`/`backupRetentionDays`, **guardia de `aiBalance > 0` (O-14)**, marca antes del backfill, baile `NO FORCE`/`FORCE` |
| M5 | `e11_facturacion_plataforma` | `platform_invoice_series`, `platform_invoices` con sus CHECK (`currency IN ('EUR','USD')`, `number > 0`, rectificativa ⇒ serie `RECTIFICATIVA` + `rectifies` no nulo), `StoredObjectKind.PLATFORM_INVOICE`, índice `(organization_id, work_date, employee_id)` en `time_entries` (D-8) |

Las cinco son **aditivas** y ninguna exige SUPERUSER.

---

## 3. Motor / funciones puras

Todo en `lib/platform/`, **puro** (sin IO, sin LLM, sin `Date.now()`: la fecha entra
por `refDate`), con test junto al fichero. **T1 extiende `.claude/hooks/guard.sh` a
`lib/platform/`.**

### 3.1 Tipos

```ts
export type HardLimitKey =
  | "maxMembers" | "maxOcrDocsMonth" | "maxStorageBytes"
  | "maxExportsMonth" | "maxBackupsMonth" | "maxOrganizations"
/** O-3: la única cuota sobre el registro contable, y es BLANDA. */
export type SoftLimitKey = "softMaxEntriesMonth"

export type AccessLevel = "FULL" | "READ_ONLY" | "BLOCKED"
```

### 3.2 `subscription.ts` — estado ⇔ acceso, y qué sobrevive a la mora

```ts
export function mapStripeStatus(raw: string): SubscriptionStatus
export function graceUntilOf(sub, limits, refDate): Date | null
export function accessLevelOf(sub, limits, refDate): { level: AccessLevel; reason: string | null }
```

Regla, definida **una sola vez** y verificada por **I-E11-5**:

| Estado | Acceso |
|---|---|
| `TRIALING`, `ACTIVE` | `FULL` |
| `PAST_DUE` dentro de gracia (14 d, P-2) | `FULL`, con aviso y fecha exacta |
| `PAST_DUE` fuera de gracia · `GRACE` · `CANCELED` · `PAUSED` · `INCOMPLETE` | `READ_ONLY` |
| Organización desactivada por su propio ADMIN | `BLOCKED` |

**Nunca `BLOCKED` por impago** (ADR-0019 D6). Y **O-3 acota qué es «escritura»**:
en `READ_ONLY` siguen permitidos, con marca de mora y `AuditLog`:

1. **Los contra-asientos de anulación** — única forma de corregir (ADR-0003).
2. **Los asientos del sistema que cierran obligaciones ya devengadas**: recurrentes
   vencidos, devengo RECC (T-36), liquidación de IVA del periodo, y los cuatro del
   cierre si el ejercicio vence durante la mora.
3. **El registro de documentos ya recibidos**: la obligación de anotación en el
   libro registro no se suspende porque nosotros no hayamos cobrado. **O-16**: eso
   incluye **subir el papel** (`uploadFileAction`), porque el justificante es parte
   del registro y sin bytes no hay `sha256` ni I-E8-2 que valga. **No incluye
   `analyzeFileAction`**: el OCR es consumo de un proveedor que pagamos nosotros,
   no un acto de llevanza, y el documento se puede registrar y contabilizar a mano.
4. **Exportar, consultar y pedir un backup** (D6 + O-4).

El mensaje de `READ_ONLY` lo dice en español y sin eufemismo: el cliente puede
llevarse sus libros y la llevanza sigue siendo suya.

```ts
/** Las cuatro clases de escritura que la mora NO detiene. Lista cerrada,
 *  verificada por I-E11-5 contra las acciones marcadas `allowInReadOnly`. */
export function isPermittedInArrears(op: WriteKind): boolean
```

### 3.3 `plan.ts`

```ts
/** Vigencias sin solape (la base lo garantiza con EXCLUDE). Si aun así hubiera
 *  dos, LANZA. Nunca «la primera que aparezca». */
export function resolvePlanAt(plans: PlanRow[], code: string, refDate: Date): PlanRow
export function planCatalogHash(plans: PlanRow[]): string
```

### 3.4 `usage.ts` — el uso, derivado

```ts
export function computeUsage(input: UsageInput, refDate: Date): UsageFigures
/** Forma canónica de las FUENTES → sha256. Entran: recuentos y `max(updated_at)`
 *  por tabla, el `ledgerHash` **del periodo `periodMonth`** (O-12b),
 *  `Σ stored_objects.size_bytes` **por kind** (O-12c) y los miembros aceptados.
 *  NO entra ninguna cifra derivada: se validaría a sí misma. */
export function usageSourceHash(input: UsageInput): string
```

| Métrica | Definición exacta |
|---|---|
| `members` | `Membership` con `acceptedAt IS NOT NULL`. Las invitaciones pendientes no cuentan aquí, pero **sí** cuentan al invitar (§3.5): no se promete una plaza que no existe |
| `entries` | `JournalEntry` del mes por `entryDate`, **excluyendo** (O-5) contra-asientos (`reversesEntryId IS NOT NULL`), asientos de sistema (`kind ∈ {REGULARIZATION, CLOSING, OPENING}` y T-25…T-28) y los de una organización `isDemo`. *Corregir un error no puede costar el doble que dejarlo, cuando el contra-asiento es el **único** camino admitido (ADR-0003)* |
| `ocrDocs` | `ExtractionRun` con `parentRunId IS NULL` del mes. Un run de revisión no consume: ya lo pagó el original (ADR-0014 D5) |
| `exports` | `ReportRun` con export materializado + `BackupJob` del mes con `trigger = MANUAL`. Un informe visto en pantalla no es una exportación |
| `storageBytes` | `Σ StoredObject.sizeBytes` con `kind ∈ {DOCUMENT, PREVIEW, LOGO, AVATAR}`. **Filtrado por `kind`, no por prefijo** (O-12c): los ZIP y las copias de nuestras facturas viven en el mismo bucket y no son cuota del cliente |
| `backups` | `BackupJob` del mes en `DONE`/`RUNNING` con `trigger = MANUAL`. **`EXIT` nunca cuenta** (O-4) |

Las seis se enseñan con su `computedAt` y su `gitSha`, y con la exclusión declarada:
son cifras derivadas y P6 obliga.

### 3.5 `limits.ts` — dos clases de cuota (O-3)

> **Regla, textual, y va al ADR (D7):** *«Ningún límite de plan puede impedir el
> registro de un hecho contable ya ocurrido, ni en cuota agotada ni en mora.»*

| Clase | Claves | Régimen |
|---|---|---|
| **Cuota de recurso** — consumo real nuestro | `maxMembers`, `maxOcrDocsMonth`, `maxExportsMonth`, `maxBackupsMonth`, `maxOrganizations` | **Bloqueo legítimo.** No son hechos contables: son recursos de la plataforma |
| **Cuota de recurso con excepción por mora (O-16)** | `maxStorageBytes` | **Dura en `FULL`, blanda fuera de `FULL`.** Subir el justificante de un hecho ya ocurrido es parte del registro (§3.2, punto 3): en mora avisa y deja subir, con `PlatformAuditLog` de excepción automática |
| **Cuota sobre el registro contable** | `softMaxEntriesMonth` | **Blanda.** Nunca rechaza un `postEntry` |

El límite blando, al superarse: **aviso al 80 % y al 100 %**, motivo de plataforma
`CUOTA_DE_ASIENTOS_SUPERADA` en cabecera y en `/settings/subscription`, **WARN en la
familia `PLATAFORMA` de `/audit`**, bloqueo de lo **accesorio** (crear la demo,
importaciones masivas, nuevas organizaciones) y propuesta de cambio de plan **el mes
siguiente**. Nunca un asiento rechazado, nunca un hueco en el diario.

**La excepción es automática y registrada** (O-3, callejón sin salida detectado): la
ronda 1 admitía superar un límite «si existe un `AuditLog` de excepción con motivo»,
pero `/admin` es de sólo lectura y **nadie podía concederla**. Ahora la concede el
propio motor al rebasar una cuota blanda, y queda en `PlatformAuditLog`.

```ts
export type LimitVerdict =
  | { ok: true; warn?: { key: SoftLimitKey; current: bigint; soft: bigint } }
  | { ok: false; key: HardLimitKey; current: bigint; limit: bigint; message: string }

/** PURA. `-1` (ilimitado) se resuelve ANTES de mirar el uso. Una clave blanda
 *  NUNCA devuelve `ok: false`: el tipo lo impide. */
export function checkLimit(key, usage, limits, delta, access): LimitVerdict
```

Y el guardián de servidor, en `models/platform-limits.ts`:

```ts
/** Lanza `LimitExceededError` (traducida a un ActionState en español con la
 *  cifra concreta). Dentro de la MISMA transacción que la escritura, tras leer
 *  el uso con `FOR SHARE` sobre la suscripción: dos peticiones simultáneas no
 *  cuelan la última plaza. Sólo acepta `HardLimitKey`. */
export async function assertWithinLimit(db, key: HardLimitKey, delta: bigint, refDate: Date): Promise<void>
```

**Las siete acciones que consumen cuota dura.** Lista exhaustiva a propósito:
**I-E11-4** la verifica **contra el AST** para que la octava que alguien añada en
E12 no se olvide.

| Acción | Clave | `delta` |
|---|---|---|
| `inviteMemberAction` | `maxMembers` | 1 |
| `acceptInvitationAction` | `maxMembers` | 1 (revalida: la invitación pudo emitirse hace un mes) |
| `analyzeFileAction` | `maxOcrDocsMonth` | 1 por run raíz — **denegada en `READ_ONLY`** (O-16) |
| `uploadFileAction` | `maxStorageBytes` | `file.size` — **permitida en `READ_ONLY` con cuota blanda** (O-16) |
| `exportReportAction` | `maxExportsMonth` | 1 |
| `requestBackupAction` | `maxBackupsMonth` | 1 — **salvo `trigger = EXIT` o `accessLevelOf ≠ FULL`, donde no se comprueba** (O-4) |
| `createOrganizationAction` | `maxOrganizations` | 1 contra el **usuario**; una `isDemo` no cuenta |

`postEntryAction`, `postFromProposal` y la generación de recurrentes **no aparecen**:
esa es la corrección de O-3.

**Nunca pérdida de datos.** El guardián corre **antes** de cualquier escritura y en
su misma transacción: ni fila a medias, ni fichero huérfano (la subida se confirma
después), ni documento descartado — la cola lo devuelve a `PENDIENTE` con el motivo.

### 3.6 `backup/` — el formato

```ts
export type BackupManifest = {
  formatVersion: "2.0"
  schemaVersion: string
  gitSha: string
  organization: { id: string; slug: string; baseCurrency: string; timezone: string; pgcVariant: string }
  createdAt: string
  seals: { ledgerHash: string; analyticsKey: string; budgetHash: string | null }
  /** O-1.2 — numeración, que los tres hashes NO cubren. */
  numbering: Array<{ fiscalYearId: string; maxEntryNumber: number; count: number; gaps: number[]; duplicates: number[] }>
  invoiceSeries: Array<{ code: string; kind: string; lastNumber: number }>
  /** O-1.3 — TODOS los sellos derivados, sobre una lista DERIVADA DEL CÓDIGO. */
  derivedSeals: Array<{ table: string; column: string; rows: number; sha256: string }>
  /** O-1.4 */
  auditLog: { rows: number; canonicalSha256: string }
  tables: Array<{ name: string; rows: number; jsonl: string; sha256: string }>
  /** O-1.5 — tabla GLOBAL, no está en TENANT_MODELS: sin esto el destino no
   *  reproduce `convertedTotal` (I-E8-5). Sólo las tasas REFERENCIADAS. */
  globalRefs: { exchangeRates: { rows: number; sha256: string } }
  files: Array<{ path: string; sha256: string; sizeBytes: number }>
  totals: { tables: number; rows: number; files: number; bytes: number }
}

export function manifestSha256(m: BackupManifest): string
export function signManifest(sha: string, key: Buffer, keyId: string): string
export function verifyManifest(m, sha, sig, keys): VerifyResult
/** El inventario, DERIVADO de `TENANT_MODELS`. Nunca escrito a mano. */
export function backupInventory(tenantModels: ReadonlySet<string>): string[]
/** O-1.3: la lista de columnas-sello, DERIVADA del código igual que el
 *  inventario. Es la parte que más fácil se olvida en la épica 68. */
export function derivedSealColumns(): Array<{ table: string; column: string }>
```

### 3.7 `cron.ts`

```ts
export function periodKeyOf(job: CronJobName, cadence: Cadence, refDate: Date): string
export function isDue(job: CronJobSpec, lastRun: CronRunRow | null, refDate: Date): boolean
```

---

## 4. Almacenamiento de ficheros (D-11)

`lib/files.ts:7` resuelve todo contra `FILE_UPLOAD_PATH`, que en Vercel es `/tmp`:
efímero entre despliegues y no compartido entre funciones. Hoy el `sha256 NOT NULL`
de E8 y el invariante I-E8-2 **vigilan unos bytes que el despliegue siguiente no
tiene**.

```ts
// lib/storage/driver.ts — la aplicación NO conoce Supabase ni S3.
export interface StorageDriver {
  readonly backend: StorageBackend
  put(key: string, body: Readable | Buffer, meta: { mimeType: string; sha256: string }): Promise<{ sizeBytes: bigint }>
  get(key: string): Promise<Readable>
  head(key: string): Promise<{ sizeBytes: bigint; sha256?: string } | null>
  delete(key: string): Promise<void>
  /** URL firmada de corta vida: un ZIP de 2 GB no cabe en una respuesta. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>
}
```

Dos implementaciones: `LocalDriver` (desarrollo y self-hosted, el comportamiento de
hoy) y `S3Driver`. **Supabase Storage se consume por su endpoint S3** (P-3), así que
hay **un solo driver de red**, no dos.

**Clave determinista**: `<STORAGE_PREFIX>/<organizationId>/<kind>/<sha256[0:2]>/<sha256>`.
**Un bucket por entorno con prefijo por organización** (P-3, ADR-0019 D3), no un
bucket por organización: eso obligaría a crear un recurso de infraestructura
**dentro de la transacción de alta** —que es justo lo que la siembra atómica no
puede permitirse—, choca con las cuotas de bucket del proveedor y no aporta
aislamiento que la política no dé ya.

**Migración** (`scripts/migrate-uploads-to-storage.ts`, patrón de
`migrate-uploads-to-org.ts`): simulación por defecto, `--apply`, idempotente, como
`app_maintenance`. Por cada `File`: leer → **comprobar `sha256` contra
`files.sha256`** → subir → `head()` y verificar → `StoredObject` → actualizar
`File.path`. **Sha discordante ⇒ no se sube y se informa**: un fichero alterado no
se propaga al almacén nuevo con la bendición de la migración.

`files.sha256` **sigue siendo la verdad** y I-E8-2 no cambia de enunciado: sólo
cambia de dónde se leen los bytes, y eso ya se **inyecta** desde el arreglo de H-3
de E8. El `StoreSweep` de E7 pasa a recorrer el almacén y escribe
`StoredObject.verifiedAt`.

---

## 5. Backup y restauración

### 5.1 Por qué se reescribe entero (G-15)

`models/backups.ts` + `settings/backups/actions.ts` cubren **9 tablas de las 66**,
ninguna contable; `modelFromJSON` captura el error por fila, lo manda a
`console.error` **y suma igual a `insertedCount`**; `preprocessRowData` **adivina
tipos** (`!isNaN(Number(value))` convierte la cuenta `0400` en `400`);
`REMOVE_EXISTING_DATA = true` **borra la organización de destino antes** de leer si
el archivo sirve; y no hay manifest, ni hashes, ni firma, ni verificación.

### 5.2 Qué se vuelca

El inventario **se deriva de `TENANT_MODELS`**, y **I-E11-7** falla si
`TENANT_MODELS ⊄ inventario`. Es la decisión que impide repetir por cuarta vez el
mismo fallo (BUG-E7-1, BUG-E9-5, BUG-E10-1: el `--reset-org` que no conocía las
tablas nuevas de la épica).

```
manifest.json                  ← firmado; se verifica ANTES que nada
signature.txt                  ← HMAC-SHA256 del sha del manifest, con keyId
data/<tabla>.jsonl             ← una fila por línea, tipos EXPLÍCITOS
global/exchange_rates.jsonl    ← O-1.5: SÓLO las tasas referenciadas por lo volcado
files/<sha256[0:2]>/<sha256>
seals.json                     ← los tres sellos, la numeración, las series,
                                 los sellos derivados y el sha del AuditLog
README.txt                     ← en español: qué es esto y cómo se restaura
```

- **JSONL y no un JSON gigante**: 500 000 líneas no caben en memoria en una función
  serverless; JSONL se escribe y se lee en streaming.
- **Tipos explícitos** (`{"v":"0400","t":"s"}` para lo ambiguo). Nada de adivinar.
- **`organization_id` no se vuelca**: lo inyecta `tenantDb` al restaurar, así que un
  backup **no puede aterrizar en otra organización** por accidente.
- **`global/exchange_rates.jsonl` (O-1.5)**: `exchange_rates` es tabla global y por
  tanto **no está en `TENANT_MODELS` ni saldría en el backup**; sin ella el destino
  no reproduce `convertedTotal` (I-E8-5). Se vuelcan **las referenciadas**, se
  marcan como globales, y el restore las inserta si faltan (append-only, única por
  `(fecha, par, fuente)`) y **falla si una existe con otro valor**.

### 5.3 Cómo se produce

Vercel corta a 300 s y no tiene disco. El worker **trocea y reanuda**:

1. `requestBackupAction` crea el job en `QUEUED` con su `expiresAt`.
2. El cron `backup-worker` (cada 5 min) lo toma, procesa **por lotes de 5 000
   filas**, escribe al almacén por **multipart** y guarda el cursor en el propio
   job; `progressBps` alimenta el SSE de `app/api/progress/[id]`, que ya existe.
3. **Los sellos se calculan al principio y se recalculan al final.** Si difieren, el
   diario cambió durante el volcado: `FAILED` con `LEDGER_MOVED_DURING_BACKUP` y se
   reencola. *Un backup de un estado que nunca existió es peor que no tener backup.*
4. Manifest → sha → firma → `DONE`.

### 5.4 Cómo se restaura: siempre a organización nueva, y qué se verifica (O-1)

> **Restaurar nunca sobrescribe una organización con datos.** Se crea una
> organización nueva, se restaura dentro, se verifica, y el usuario compara y
> decide. La de origen no se toca.

1. `startRestoreAction(backupId, nombre)` → **ADMIN**; cuenta contra
   `maxOrganizations`.
2. **Verificar firma y manifest antes de descomprimir un byte.** Firma inválida o
   `formatVersion ≠ 2.0` ⇒ rechazo con motivo.
3. Crear la organización destino **sin la siembra** de §6.1: el backup ya trae plan,
   mapa, series y pares; sembrar encima duplicaría códigos.
4. Restaurar tabla por tabla **en orden de FK**, en lotes, con `tenantDb(destino)`.
   **Una sola fila rechazada aborta el trabajo entero**, con tabla, nº de línea y
   motivo en `rejected`. Se acabó el `catch` que suma igual (G-15).
5. Insertar las `exchange_rates` referenciadas (O-1.5).
6. Restaurar los ficheros **verificando el sha256 de cada uno** contra el manifest.
7. **Verificación P7 — `restoreVerification.json`, seis comprobaciones** (O-1). No
   basta con los tres hashes: **si la forma canónica del `ledgerHash` ordena por
   fecha/cuenta/importe, dos asientos con los números intercambiados dan el mismo
   hash**, y un auditor mira la numeración antes que nada.

| # | Comprobación | Sostiene |
|---|---|---|
| 1 | **Recuentos tabla a tabla** contra el manifest, con `=` (no `⊇`) | I-E11-7 |
| 2 | **Numeración**: `max(entry_number)`, **ausencia de huecos y de duplicados** por `(ejercicio, serie)`, y último número de cada `InvoiceSeries` | I7, art. 28.2 CCom, I-E8-20 |
| 3 | **Recomputo de *todos* los sellos derivados** —`proposal_sha`/`schema_sha`/`prompt_sha`, `linesHash`, `checksHash`, `scheduleHash`, `inputHash`, `timeHash`, `ReportRun.validation`— sobre una lista **derivada del código** (`derivedSealColumns()`), no escrita a mano | I-E8-11, I-E7-7/9/10, I-E9-1b/3/25, I-E10-6/17 |
| 4 | **`AuditLog`**: recuento y sha256 de su forma canónica, enfrentados. *Sin esto se pierde quién forzó qué y con qué motivo* | P6, I-E8-13 |
| 5 | **Los tres sellos** `ledgerHash`, `analyticsKey`, `budgetHash`, y el **estado del cierre** (`FiscalYear.status`/`closedAt`, `ClosingRun`) | ADR-0011, I-E9-15/20/21 |
| 6 | **Barrido completo de las nueve familias** de invariantes sobre el destino, con su `checksHash`, y **correspondencia `File` ↔ objeto**: todo fichero restaurado tiene sus bytes | Todas, I-E8-2, I-E11-6 |

8. `verified = true` sólo con las **seis** en verde ⇒ `DONE`. Si no ⇒
   **`DONE_UNVERIFIED`** (O-2), con las seis enfrentadas a la vista y la
   organización **conservada y marcada**: borrarla sería destruir la evidencia.
9. `PlatformAuditLog` + `AuditLog` del destino.

> §11.1 de la ronda 1 prometía el barrido en prosa, pero **el contrato de I-E11-2 no
> lo decía**. Y lo que no está en el enunciado no se ejecuta: H-1 de E9 y H-1 de E10,
> dos veces, fueron invariantes escritos que nadie corría.

### 5.5 Retención, portabilidad y borrado

- `expiresAt = createdAt + Organization.backupRetentionDays` (30 por defecto, dentro
  del máximo del plan). El job `retention` borra el **objeto** y pasa la fila a
  `EXPIRED`.
- **Nunca se borra un backup con un `RestoreJob` vivo que lo referencie.**
- **Portabilidad (O-4), tres reglas que están en el ADR y no en la UI:**
  1. El **backup de salida** (`trigger = EXIT`, o cualquiera pedido por una
     organización que no esté en `FULL`) **no consume `maxBackupsMonth`**.
  2. Tras `CANCELED`, ventana mínima de descarga de **90 días**
     (`exportWindowUntil`), por encima de la retención del plan, con aviso por
     correo al inicio y a falta de 15 días.
  3. `maxBackupsMonth` **nunca** se aplica cuando `accessLevelOf ≠ FULL`.
- **`kind = PLATFORM_INVOICE` excluido de la retención** (O-11): son **nuestras**
  facturas emitidas, sujetas a conservación (art. 165.Uno LIVA, arts. 19–23
  RD 1619/2012), no ZIP de exportación. Con test propio.
- **Conservación mercantil**: el art. 30 CCom (seis años; diez con BIN, art. 26.5
  LIS) obliga sobre **libros y justificantes**, que viven en la base y en el almacén
  de documentos, **no** sobre los ZIP. Se dice así en la UI, palabra por palabra,
  para que nadie confunda una copia caducada con documentación destruida.
- **No existe borrado de organización** (O-11). Sólo desactivación (`BLOCKED` por su
  propio ADMIN). El `onDelete: Cascade` de las tablas nuevas es **salvaguarda de
  integridad referencial, no un camino de producto**; un test comprueba que ninguna
  server action ni ningún script borra una organización con asientos.

---

## 6. Onboarding

### 6.1 La siembra atómica, y sus tres defectos corregidos (O-7)

`createOrganizationWithOwner(..., { seed })` ya ejecuta la siembra **dentro de la
transacción** que crea la organización (E3 T10). `createOrganizationDefaults` siembra
categorías, monedas, campos, settings, plan NPGC, mapa y tipos impositivos.
`seedOrganization(tx, spec, now, userId)` pasa a ser **la única** puerta de siembra
—la usan el asistente, `scripts/create-admin.ts`, `ensure-self-hosted.ts` y los
tests— y añade, **todo en el paso 1**:

| Pieza | Por qué en el paso 1, y no después |
|---|---|
| **`FiscalYear` provisional** por año natural | **O-7b**: la ronda 1 lo creaba en la siembra **y** en el paso 3. O había dos solapados, o el paso 3 no hacía nada. Ahora el paso 3 **lo edita mientras no tenga asientos**, con CHECK de no solape |
| **Series `ORDINARIA` y `RECTIFICATIVA`** con prefijo por defecto | **O-7a** (y cierra **D-2**): la ronda 1 las creaba en el paso 4, pero I-E11-10 las exige en toda organización activa, así que quien abandonaba en el paso 3 hacía **fallar el invariante con datos limpios** — y un invariante que falla con datos limpios no distingue una manipulación (lección de E10). El asistente sólo **renombra el prefijo mientras `lastNumber = 0`**, que es además la única ventana en que renombrar es legal (art. 6.1.a RD 1619/2012) |
| **22 pares de reclasificación** | R-2 de E9: existían **sólo por el backfill**, e `I-E9-16` pasaba **por vacuidad** |
| **Config analítica** (`seedAnalyticsDefaults`, `MarginLevelConfig`, CECOs) | Sin niveles, `/analytics` está vacío |
| **Tarifas** (`EmployeeRate` por defecto, `basis`) | Los drivers `HOURS` de E10 caen en su `zeroBaseFallback` |

**I-E11-10 pasa de siete a nueve piezas** (O-7c), y la novena es la que faltaba: la
siembra crea `TaxRate`, pero **el invariante no los miraba**. Es literalmente R-2 de
E9 otra vez —la pieza que se siembra y nadie verifica es la que desaparece en la
épica siguiente—, y sin `TaxRate` vigente `postFromProposal` no puede construir una
línea de IVA: **el camino documental completo de E8 queda muerto**.

### 6.2 El asistente, seis pasos

`/onboarding`, reanudable, cada paso una server action, progreso en
`OnboardingRun.step`.

| Paso | Qué pide | Qué hace |
|---|---|---|
| **1 · Empresa** | Nombre, NIF, moneda, zona, variante NPGC, **prefijo de serie** | `createOrganizationWithOwner` + `seedOrganization` **en una transacción**. Falla ⇒ no nace nada |
| **2 · Plan de cuentas** | Confirmar variante, subcuentas sí/no | Enseña el árbol sembrado; permite `importCustomPlan` (E2) |
| **3 · Ejercicio** | Fechas del primer ejercicio | **Edita** el provisional mientras no tenga asientos |
| **4 · Equipo** | Emails y rol | `inviteMemberAction`, contra `maxMembers`. Saltable |
| **5 · Demo** | Sí / no | §6.3 |
| **6 · Listo** | — | `completedAt` → `/dashboard` |

`VIEWER` no ve `/onboarding`: sólo existe para quien acaba de crear la organización,
que por construcción es su `ADMIN`.

### 6.3 La demo, en su propia organización (O-6)

La ronda 1 cargaba el fixture **dentro de la organización del cliente** y decía que
esos asientos «no cuentan». Tres problemas encadenados: (1) no había marca por fila,
así que **I-E11-1 habría fallado en toda organización con demo**, que es el caso por
defecto del alta; (2) sus documentos sí consumían `storageBytes` y `ocrDocs`, sin
declararlo; y (3) el vaciado «por el camino de producción» **borraba asientos
posteados**, contra el append-only de ADR-0003 y, con datos reales mezclados, contra
el art. 30 CCom. **Un botón que borra asientos no puede existir en este producto.**

Corrección: la demo va a una organización propia, `Demo — <nombre>`, con
`Organization.isDemo` **inmutable** (trigger). Entonces:

- «vaciar la demo» es **borrar esa organización entera** —no tiene asientos
  ajenos—, y el append-only se respeta sin excepción;
- la exclusión del uso vive **una sola vez** (`isDemo` entra en `computeUsage` **y**
  en `usageSourceHash`);
- la demo **no cuenta** contra `maxOrganizations`;
- se conserva íntegro lo que la demo aportaba: el fixture
  `tests/fixtures/ejercicio-completo.json` se postea **por el motor**, no por SQL, de
  modo que **la demo es un test de humo de producción**. Si el fixture no se puede
  cargar por el camino del producto, el producto está roto, y nos enteramos en el
  alta y no en el sprint siguiente (que es exactamente lo que pasó con
  `ejercicio-completo-v2`). Cifras conocidas: INGRESOS 6 250 000 · MC1 5 670 000 ·
  MC2 3 276 000 · MC3 3 084 110 · EBITDA 2 390 430 · EBIT 1 995 430 · BAI 1 996 430
  · RESULTADO 1 497 322.

### 6.4 Preferencias de organización (D-3)

`/settings/organization` gana un bloque de preferencias del motor:
**mes de arranque de la amortización** (`MES_DE_ALTA` | `MES_SIGUIENTE`; por defecto
`MES_SIGUIENTE`, que es lo que el motor de E9 ya hace — cambiar el valor por defecto
alteraría cuadros ya posteados, y eso no se hace en una épica de plataforma),
retención de backups y destinatario de los avisos de plataforma.

---

## 7. Cron de plataforma

### 7.1 Los cuatro jobs

| Job | Cadencia | Qué hace | Venía de |
|---|---|---|---|
| `recurring-due` | diaria 06:00 Europe/Madrid | Ocurrencias vencidas de `RecurringEntry` | E9; hoy no lo lanza nadie |
| `invariant-sweep` | diaria 03:00 | `runLedgerInvariants` por organización con ejercicio abierto → `InvariantRun` | E7; hoy es un script a mano |
| `backup-worker` | cada 5 min | Avanza el cursor de los `BackupJob` vivos | E11 |
| `retention` | semanal, domingo 04:00 | `prune-runs` + caducidad de ZIP + limpieza de `rate_limit_buckets` | E7 (ADR-0015 D3) |

`backup-schedule` y `email-sync` salen a E12 (§0.3).

### 7.2 Cómo se ejecuta, y qué NO decide el reloj (O-13)

- **Una sola ruta**, `POST /api/cron/[job]`, protegida por `Authorization: Bearer
  ${CRON_SECRET}` con **comparación en tiempo constante**. La llama un **GitHub
  Actions scheduled workflow** (P-5: gratis, cadencias de 5 y 15 min), con **Vercel
  Cron diario como respaldo**. **Un camino, dos relojes.**
- **Idempotencia**: `CronRun` con `@@unique([job, periodKey])`. La ruta inserta
  primero; si choca, `200 {skipped:true}` y no ejecuta nada.
- **Troceado**: presupuesto de 240 s; al agotarlo guarda `cursor`, marca `PARTIAL` y
  devuelve `202`. **Un job que no cabe nunca se declara `DONE`.**
- **Aislamiento**: que la organización 7 falle no impide que corra la 8. `failed`
  cuenta, `PlatformAuditLog` registra, el job termina `PARTIAL`.
- **El reloj nunca entra en una cifra contable (O-13).** El job pasa **`refDate`
  explícito** (persistido en `CronRun.refDate`) y la ocurrencia **se fecha por su
  periodo de devengo**, jamás por el instante de ejecución — que es exactamente lo
  que `.claude/hooks/guard.sh` prohíbe dentro de `lib/ledger`. Test: lanzar el job
  **con dos días de retraso, o dos veces**, produce **el mismo asiento y el mismo
  `inputHash`** (I-E9-1b lo verifica).
- **Qué hace el cron en mora**, escrito: `invariant-sweep` **corre** (es lectura);
  `backup-worker` y `retention` **corren**; `recurring-due` **genera** las
  ocurrencias de obligación devengada de §3.2 y **omite** el resto, dejándolas en
  `OMITIDA` con motivo `SUSCRIPCION_EN_MORA` — I-E9-1a exige motivo, así que el
  invariante no falla por un impago nuestro.
- `scripts/run-invariants.ts` y `scripts/prune-runs.ts` **se conservan**: el cron los
  invoca como biblioteca. Un operador tiene que poder lanzarlos a mano.

### 7.3 Observabilidad

- **`GET /api/health`**, sin autenticación, sin PII: `{status, version, gitSha,
  db:{ok,latencyMs}, storage:{ok,latencyMs}, cron:[{job,lastRun,status}],
  migrations:{applied,pending}}`. `pending > 0` ⇒ `degraded`.
- **`PlatformAuditLog`**: todo webhook (id y tipo), toda ejecución de cron, toda
  firma de backup, toda restauración, toda excepción automática de cuota blanda.
- **Métricas por organización sin PII**: id, plan, las seis del uso, invariantes en
  FAIL, edad del último backup. **Ni un nombre, ni un email, ni un NIF, ni un
  importe del diario.** El operador ve *cuánto*, no *qué*. `/admin` que las pinta:
  **E12**.

**O-17 · el 349 sin pantalla, pero no sin salida.** La pantalla de export 303/349
sale del alcance (§0.3) y va a **E14**, pero **los campos que la alimentan entran
ahora** (D8) y la obligación no espera a una épica: el modelo 349 es **obligatorio**
para las prestaciones a empresarios UE con inversión del sujeto pasivo (arts. 79–81
RIVA), trimestral con carácter general y **mensual** si se superan 50 000 € en el
trimestre en curso o en alguno de los cuatro anteriores. Mientras no haya pantalla,
**T23 escribe en `docs/deploy/e11-plataforma.md` la consulta SQL de operador**, con
su comprobación del umbral:

```sql
-- Modelo 349, clave S (prestaciones de servicios intracomunitarias).
-- Periodo por DEVENGO (operation_date), nunca por fecha de expedición ni de cobro.
SELECT i.vat_number, i.customer_country,
       SUM(i.subtotal_cents) / 100.0 AS base_euros, COUNT(*) AS facturas
  FROM platform_invoices i
 WHERE i.tax_treatment = 'NO_SUJETO_LOCALIZACION_UE'
   AND i.operation_date >= :desde AND i.operation_date < :hasta
 GROUP BY 1, 2
 ORDER BY 1;

-- Umbral de periodicidad mensual (50.000 € en el trimestre en curso o en alguno
-- de los cuatro anteriores). Si alguna fila supera 5.000.000 c, el 349 pasa a mensual.
SELECT i.iva_period, SUM(i.subtotal_cents) AS base_cents
  FROM platform_invoices i
 WHERE i.tax_treatment = 'NO_SUJETO_LOCALIZACION_UE'
 GROUP BY 1 ORDER BY 1 DESC LIMIT 5;
```

La casilla **59** del 303 («operaciones no sujetas o con ISP») recoge, además de la
no sujeción UE, la de tercer país y la de Canarias/Ceuta/Melilla: la misma consulta
sin el filtro de `tax_treatment` y agrupando por él. **La deuda de la pantalla queda
fechada en E14 en `ESTADO.md`** (T24), no se da por resuelta con el SQL.

---

## 8. Capa de aplicación

### 8.1 Modelos

`models/subscriptions.ts` · `models/plans.ts` · `models/platform-invoices.ts` (serie
propia, numeración `FOR UPDATE` como `InvoiceSeries` de E8) · `models/usage.ts` ·
`models/platform-limits.ts` · `models/backups.ts` (**reescrito**) ·
`models/storage.ts` · `models/onboarding.ts` · `models/cron.ts` ·
`models/rate-limit.ts`.

### 8.2 Server actions y matriz de roles

Toda acción empieza por `requireOrg(minRole)`. `READ_ONLY` se aplica en **un solo
sitio**: `requireOrg` consulta `accessLevelOf` y lanza `SubscriptionReadOnlyError`
para toda acción no marcada `allowInReadOnly`. No se reparte por treinta ficheros.

| Acción | Rol | En `READ_ONLY` |
|---|---|---|
| `startCheckoutAction`, `openBillingPortalAction` | ADMIN | **permitida** (es cómo se sale del impago) |
| `listPlatformInvoicesAction`, `getUsageAction` | ADMIN / VIEWER | permitida |
| `requestBackupAction`, `downloadBackupAction` | ADMIN | **permitida y sin cuota** (D6 + O-4) |
| `exportReportAction` | VIEWER | permitida |
| `postEntryAction` con contra-asiento, o de obligación devengada | EDITOR | **permitida**, con marca de mora (O-3) |
| `postEntryAction` ordinario, `postFromProposal` | EDITOR | **permitida** — O-3: nunca se impide registrar un hecho ocurrido |
| `uploadFileAction` | EDITOR | **permitida**, con `maxStorageBytes` blando (O-16) |
| `analyzeFileAction` | EDITOR | **denegada** con motivo: el OCR es recurso nuestro, no llevanza (O-16) |
| `startRestoreAction`, `createOrganizationAction`, `loadDemoDataAction` | ADMIN | denegada (crean organización) |
| `setBackupScheduleAction`, `setOrganizationPreferencesAction` | ADMIN | denegada |
| `inviteMemberAction` | ADMIN | denegada |
| `onboardingStepAction` (6) | ADMIN de la org nueva | n/a |

### 8.3 Webhook de Stripe, reescrito

El de hoy: **no es idempotente** (Stripe reintenta y el efecto se aplica otra vez);
**da de alta un usuario y una organización** con el email del cliente
(`getOrCreateCloudUser`) si no encuentra el `stripeCustomerId`; y devuelve `400` a
todo evento no manejado, que Stripe interpreta como fallo y **reintenta
indefinidamente**.

Reescrito: firma → `SubscriptionEvent` con `stripeEventId` **único** (si choca:
`200`, ya aplicado) → resolver por `stripeCustomerId`; **si no existe, `200` +
`ORPHAN_WEBHOOK`** y nada más — **un webhook no puede crear tenants** → aplicar el
estado con el motor puro → **emitir `PlatformInvoice` con nuestra serie** en
`invoice.finalized`, revalidando el NIF-IVA **en el devengo** (C-1) → `200`. Evento
no manejado: **`200`** y registro. El único `4xx` es la firma inválida.

Eventos: `checkout.session.completed`,
`customer.subscription.{created,updated,deleted}`,
`invoice.{finalized,paid,payment_failed}`, `credit_note.created` (→ rectificativa,
C-3).

---

## 9. Seguridad

**9.1 Secretos.** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`,
`PLATFORM_SIGNING_KEY`, credenciales del almacén: **entorno**, nunca base de datos.
Los **secretos por organización** (IMAP) siguen cifrados con `lib/encryption.ts`
(AES-256-GCM + scrypt de `BETTER_AUTH_SECRET`), que es lo que TaxHacker ya hacía
bien; se añade que el valor por defecto (`"insecure-self-hosted-secret"`) **haga
fallar el arranque** con `SELF_HOSTED_MODE=false`. `PLATFORM_SIGNING_KEY` lleva
`keyId` en el manifest para poder rotar: `verifyManifest` acepta la vigente y la
anterior.

**9.2 PII.** Al log y a `PlatformAuditLog` van **id y tipo**, nunca el objeto de
Stripe (lleva email, dirección e importes) — regla de E1 #16, extendida a
`SubscriptionEvent.payload`, que se **recorta** antes de persistir. En
`RateLimitBucket` la clave es `sha256(email)` o `sha256(ip)`.

**9.3 Rate limits (D-10).** `lib/auth-rate-limit.ts` pasa de memoria de proceso a
`RateLimitBucket`: mismos techos, ahora compartidos entre réplicas y supervivientes
a un reinicio. Tres cubos nuevos: webhook por IP, `/api/cron` por IP y
`requestBackupAction` por organización.

**9.4 Validación en el borde (D-9).** `assertAcceptableUpload` de E8 (lista blanca +
*sniff* + 25 MB) se aplica **también** al import CSV y al ZIP: un `.xlsx` renombrado
a `.csv` devuelve «esto no es un CSV» en vez de 30 000 rechazos.

**9.5 RLS.**

- Las **ocho** tablas con `organization_id` (`subscriptions`, `subscription_events`,
  `platform_invoices`, `usage_runs`, `backup_jobs`, `restore_jobs`,
  `stored_objects`, `onboarding_runs`) nacen con
  `SELECT app.enforce_tenant_rls('<tabla>')` **y** entran en `TENANT_MODELS`. Sin
  las dos cosas, una consulta fuera de `tenantDb` devuelve **vacío en silencio**
  (ADR-0009).
- `plans` y `platform_invoice_series`: **catálogo global**. `ENABLE` + `FORCE`,
  `SELECT` abierto, `RESTRICTIVE … USING (false)` en escritura para `app_runtime`:
  el catálogo lo cambia una **migración** y la serie la mueve una función
  `SECURITY DEFINER` acotada al webhook. Patrón de `exchange_rates`.
- `cron_runs`, `rate_limit_buckets`, `platform_audit_logs`: **sin
  `organization_id`**, y por tanto **fuera** de `TENANT_MODELS` — si estuvieran,
  `tenantDb` filtraría por una columna inexistente y toda lectura fallaría (el aviso
  que ADR-0014 D7 dejó escrito). `platform_audit_logs` es **append-only** con
  `RESTRICTIVE … USING (false)` en `UPDATE`/`DELETE`.
- `app.organization_id_by_stripe_customer(text)` **ya existe** (E3): no hace falta
  ninguna puerta nueva para el webhook.
- Un `RestoreJob` toca **dos** organizaciones: se acota por la de **destino**, y el
  origen entra por el ZIP, nunca por una consulta cruzada. Test de fuga explícito en
  `test:integration:rls`.

---

## 10. UI

**`/settings/subscription`** (ADMIN; VIEWER ve uso, no facturación). Cuatro bloques:
plan actual con estado y, si procede, el aviso de gracia **con la fecha exacta**;
**uso del mes** con las seis barras (ámbar al 80 %, rojo al 100 %), el sello
`computedAt` + `gitSha` y **las exclusiones declaradas** (P6); **facturas** de
`PlatformInvoice` con **nuestro número de serie** y descarga del **PDF conservado**
(no del enlace de Stripe); y el botón al **portal de Stripe**, donde se cambia de
plan, la tarjeta y los datos fiscales — no se reimplementa ni uno. El aviso de
`CUOTA_DE_ASIENTOS_SUPERADA` va aquí y en la cabecera, **sin bloquear nada** (O-3).
Sin Stripe configurado (self-hosted), la página dice «facturación no disponible en
esta instalación» y enseña el uso igual.

**`/settings/backups`** (reescrita). Lista con estado, progreso en vivo (SSE),
tamaño, sha256 abreviado, los sellos, caducidad y descarga por URL firmada. Botón
«Crear copia» y, cuando la organización no está en `FULL`, **«Descargar todos mis
datos»** sin cuota y sin límite (O-4). Restauración con el aviso en grande —**«la
restauración crea una organización nueva; la actual no se toca»**— y el resultado de
la verificación con **las seis comprobaciones enfrentadas**, no tres hashes. Motivo
obligatorio, que va a `AuditLog`.

**`/onboarding`**: seis pasos, barra de progreso, reanudable, «volver atrás» sin
perder lo escrito. Cada paso enseña **qué se ha sembrado** (nº de cuentas, claves
del mapa, tipos impositivos, pares, series) — no un spinner: es la primera prueba
que el producto le da al cliente de que sabe lo que hace.

**`/admin`**: **fuera de E11** (§0.3). Queda `/api/health`.

Estados vacío / carga / error en todas, y textos en español contable claro.

---

## 11. Invariantes `I-E11-*`

Se definen **una sola vez** en `.claude/skills/fiabilidad/SKILL.md` (familia
`PLATAFORMA` de `/audit`), como los de E7–E10. Tolerancia **0** en los que comparan
cifras. **Nunca un PASS que no se haya comprobado**: lo no evaluable sale `INFO`
diciendo qué falta.

| ID | Invariante | Tol. |
|---|---|---|
| **I-E11-1** | **Uso derivado = Σ real.** Las seis cifras del `UsageRun` vigente = el recuento hecho ahora sobre las fuentes, **con las exclusiones de §3.4** (contra-asientos, asientos de sistema, `isDemo`). Una caché servida con `sourceHash` distinto del actual es FAIL, no una caché caducada | 0 |
| **I-E11-2** | **Restauración reproducible (P7).** Para todo `RestoreJob` terminado, las **seis comprobaciones de §5.4** en verde: recuentos `=`, numeración sin huecos ni duplicados + series, **todos** los sellos derivados recomputados sobre `derivedSealColumns()`, sha del `AuditLog`, los tres sellos + estado del cierre, y el **barrido de las nueve familias** con correspondencia `File` ↔ objeto. `DONE_UNVERIFIED` es **FAIL** | 0 |
| **I-E11-3** | **Manifest íntegro y firmado.** sha256 del manifest recomputado = `manifestSha256`, firma válida con su `keyId`, y sha256 de cada entrada = el del manifest (completo en el barrido nocturno, muestra en el de petición) | 0 |
| **I-E11-4** | **Cuotas.** (a) Ninguna **cuota de recurso** superada; (b) toda superación de la **cuota blanda** tiene su `PlatformAuditLog` de excepción **automática** —no de operador, que en E11 no existe—; (c) **test estático sobre el AST**: las acciones que invocan `assertWithinLimit` son **exactamente** las siete de §3.5, y **ninguna acción de posteo la invoca** | 0 |
| **I-E11-5** | **Estado ⇔ acceso.** El nivel efectivo de cada organización = `accessLevelOf(...)`; ninguna sin `Subscription`, ninguna con dos; y las acciones marcadas `allowInReadOnly` son exactamente las cuatro clases de §3.2 | — |
| **I-E11-6** | **Ficheros: `sha256` = almacén.** Para todo `StoredObject`, el almacén devuelve el mismo sha256 y tamaño; todo `File` tiene su objeto. **Filtra por `kind`, no por prefijo** (O-12c). Extiende I-E8-2 del disco al almacén | 0 |
| **I-E11-7** | **Cobertura del backup.** `TENANT_MODELS ⊆ backupInventory()`, `derivedSealColumns()` cubre toda columna-sello del esquema, y toda tabla del inventario aparece en el manifest con su recuento. *Impide repetir BUG-E7-1 / BUG-E9-5 / BUG-E10-1* | — |
| **I-E11-8** | **La plataforma no toca el diario del cliente.** Ningún `JournalEntry` referencia una `PlatformInvoice`, `Subscription` ni `BackupJob`; ninguna plantilla las nombra. **(O-8)** Y tampoco por el camino indirecto: **ningún `Transaction`, `ExtractionRun` ni `File` tiene por origen una `PlatformInvoice`** — si algún día se ofrece pre-cargarla, entra como documento subido con sus bytes y su `sha256`, nunca como propuesta fabricada, que I-E8-1 e I-E8-9 rechazarían con razón. **Y CFOnomic no lleva su contabilidad en una «organización plataforma» con privilegios**: si usa su producto, es una organización cliente más | 0 |
| **I-E11-9** | **Webhook idempotente.** `stripeEventId` único, y por evento exactamente una transición con `statusBefore`/`statusAfter` encadenados sin hueco | — |
| **I-E11-10** | **Siembra completa — nueve piezas** (O-7c). Toda organización activa tiene: plan postable · mapa con las 57 claves · **exactamente un** `FiscalYear` sin solape · series `ORDINARIA` y `RECTIFICATIVA` · 22 pares de reclasificación · `MarginLevelConfig` vigente · `OnboardingRun` · **`TaxRate` vigente de IVA e IRPF** · **`Currency` de su `baseCurrency`** (y, si no es EUR, al menos una `ExchangeRate` accesible: con RC-14 la organización no podría convertir nada) | — |
| **I-E11-11** | **Retención honrada.** Ningún `BackupJob` `DONE` con objeto vivo pasado su `expiresAt`; ninguno borrado antes de tiempo o con un `RestoreJob` vivo; **ningún `StoredObject` de `kind = PLATFORM_INVOICE` caducado** (O-11) | — |
| **I-E11-12** | **Cron idempotente y al día.** `(job, periodKey)` único; ningún job con la última ejecución más vieja que dos cadencias sin un `PARTIAL`/`FAILED` que lo explique; **y ninguna ocurrencia generada cuya `entryDate` coincida con el instante de ejecución en vez de con su periodo de devengo** (O-13) | — |
| **I-E11-13** | **Serie de plataforma (O-10).** Para cada serie de `PlatformInvoice`: numeración correlativa **sin huecos**, sin duplicados, `operationDate` **no decreciente** respecto del número, y toda factura con `rectifiesInvoiceId` pertenece a una serie `RECTIFICATIVA` y referencia una existente. **Espejo exacto de I-E8-20**: es indefendible exigirle al cliente un rigor que no nos aplicamos | 0 |

### 11.1 Invariantes existentes que E11 puede romper

| Invariante | Riesgo | Mitigación |
|---|---|---|
| **I-E8-2** | Los bytes se leen de otro sitio | `readStoredFile` ya se **inyecta** desde H-3 de E8: cambia la implementación, no el enunciado. Test con los dos drivers |
| **I-E8-20** | Sembrar las series crea contadores vivos | Nacen con `lastNumber = 0`: `I-E8-20` sigue en `INFO` hasta la primera factura, que es su contrato |
| **I-E9-16** | Ya pasó por vacuidad una vez (R-2) | La siembra los crea e **I-E11-10** comprueba que existen |
| **I-E9-1a/1b** | El cron genera ocurrencias | `refDate` explícito, fecha por periodo de devengo, `OMITIDA` con motivo en mora (O-13) |
| **I1…I10, I-E5/E7/E8/E9/E10-*** | Una restauración crea miles de filas por un camino nuevo | El `RestoreJob` **ejecuta el barrido de las nueve familias** antes de declarar `DONE` (§5.4, comprobación 6) |
| **I10** | `RestoreJob` toca dos organizaciones | Test de fuga dedicado en `test:integration:rls` |

---

## 12. Rendimiento

Techos en `tests/integration/perf-platform.test.ts`, sobre volumen sembrado **en el
propio test** (lección de DEBE 3 de E9).

| # | Camino | Volumen | Techo |
|---|---|---|---|
| 1 | `/settings/subscription` en frío | 12 facturas, 24 eventos | < 400 ms · 1 transacción |
| 2 | `computeUsage` con caché válida | — | < 50 ms |
| 3 | `computeUsage` recalculando | 50 000 asientos, 5 000 documentos, 20 000 objetos | < 1 200 ms · **≤ 8 consultas** |
| 4 | `assertWithinLimit` en una escritura | ídem | **< 25 ms · ≤ 2 consultas** (camino caliente) |
| 5 | Backup completo | 50 000 asientos, 150 000 líneas, 2 000 ficheros / 1,5 GB | < 15 min · **memoria estable** (se mide el pico) |
| 6 | Restauración + **las seis verificaciones** | ídem | < 30 min · ninguna transacción > 30 s |
| 7 | Webhook de Stripe | — | < 300 ms (Stripe reintenta a ~10 s) |
| 8 | `/api/cron/invariant-sweep` | 50 organizaciones | < 240 s o `PARTIAL` con cursor |
| 9 | `/api/health` | — | < 200 ms |
| 10 | Calendario de `/time` (D-8) | 250 empleados × 22 días | < 400 ms · **1 consulta agregada** |

No se negocia: **una transacción por petición** (`tenantPage`), lecturas **en serie**
dentro de una transacción (E6-perf), agregados en SQL, nada de `Promise.all` en
ficheros que importen `@/lib/page-tenant`.

---

## 13. Decisiones de Nivel 2 → `docs/adr/0019-plataforma-saas.md` (**PROPUESTO**)

**Ocho decisiones** (la ronda 1 tenía seis; **D5-CAPEX sale** con el alcance y
entran **D7** y **D8**, las dos nacidas de la validación):

| # | Decisión |
|---|---|
| **D1** | Facturación y límites **por organización**: `Plan` versionado, `Subscription` con FK a la versión contratada, webhook idempotente que no crea tenants, **uso derivado y nunca almacenado**, `aiBalance` retirado |
| **D2** | **Backup/restore como criterio de reproducibilidad (P7)**, con el enunciado **ampliado por O-1**: formato 2.0 firmado, inventario y lista de sellos **derivados del código**, `exchange_rates` referenciadas en el ZIP, restauración siempre a organización nueva, aborto a la primera fila rechazada, y **las seis comprobaciones** de §5.4 como condición de éxito |
| **D3** | **Almacenamiento**: driver S3 único, **un bucket por entorno con prefijo por organización**, clave por `sha256`, `StoredObject` como localización e integridad |
| **D4** | **Cron de plataforma**: ruta única autenticada, idempotencia por `(job, periodKey)`, troceado con cursor, **`refDate` explícito y fecha por periodo de devengo** (O-13), conducta declarada en mora |
| **D5** | **La portabilidad no la puede desactivar un precio** (O-4): `BackupTrigger.EXIT` sin cuota, `maxBackupsMonth` inaplicable fuera de `FULL`, ventana de 90 días tras `CANCELED` |
| **D6** | **Un cliente que no paga pierde la escritura ordinaria, nunca la lectura ni la exportación** |
| **D7** ✚ | **«Ningún límite de plan puede impedir el registro de un hecho contable ya ocurrido, ni en cuota agotada ni en mora»** (O-3): cuotas **duras** de recurso vs **blanda** sobre el registro, excepción **automática y registrada**, y las cuatro clases de escritura que la mora no detiene |
| **D8** ✚ | **La serie de facturación de la plataforma es nuestra y se vigila como la del cliente** (O-9, O-10, C-1…C-5): `PlatformInvoiceSeries` con numeración propia, `operationDate` ≠ `issuedAt`, tratamiento fiscal probado y revalidado **en cada devengo**, cuota siempre en euros a la tasa del devengo, copia del PDF **conservada en nuestro almacén**, e **I-E11-13** como espejo de I-E8-20 |

**Sale de ADR-0019** la D5 de la ronda 1 (CAPEX en el `budgetHash`): con el alcance
recortado, la enmienda a **ADR-0018 D2** y el reversionado del fixture a v1.4 se
deciden en **E12**, donde se implementan.

---

## 14. Criterios de aceptación (Given / When / Then)

**Facturación y serie propia (D1, D8)**

1. Checkout completado ⇒ **una** `Subscription` `ACTIVE` con `planId` = la versión
   vigente en la fecha, un `SubscriptionEvent` y el plan a la vista.
2. El mismo evento entregado **tres veces** ⇒ **un** `SubscriptionEvent`, **una**
   transición, `200` las tres (I-E11-9).
3. `stripeCustomerId` desconocido ⇒ `200` + `ORPHAN_WEBHOOK`, y **ningún usuario ni
   organización creados**.
4. Evento de tipo no manejado ⇒ `200`; Stripe no reintenta.
5. `invoice.finalized` ⇒ `PlatformInvoice` con **número de nuestra serie**
   (`PLT-2026-0001`), `operationDate` = devengo, `issuedAt` = expedición, `ivaPeriod`
   en forma `AAAA-Qn`, y el **PDF copiado** como `StoredObject` de `kind =
   PLATFORM_INVOICE`.
6. Cliente UE con NIF-IVA válido ⇒ `taxTreatment = NO_SUJETO_LOCALIZACION_UE`,
   `taxCents = 0`, **mención impresa**, y `vatValidatedAt` **del devengo**, no del
   alta. Con VIES caído o NIF inválido ⇒ **se repercute 21 %**; nunca se presume.
7. Factura en USD ⇒ `taxCentsEur` presente, con `fxRateMicro`, `fxRateDate` (la del
   **devengo**, o la **última anterior** si ese día no hay publicación) y `fxSource`.
8. `credit_note.created` ⇒ factura **rectificativa** en la serie `PLT-R`, con
   `rectifiesInvoiceId`, causa y modo.
9. Tres facturas emitidas y una anulada en Stripe ⇒ **I-E11-13 PASS**: nuestra serie
   no tiene el hueco que Stripe sí tiene.
10. `PlatformInvoice` con `number` duplicado insertada por SQL ⇒ **I-E11-13 FAIL**
    nombrando serie y número.

**Estado ⇔ acceso, y O-3**

11. `past_due` con `graceDays = 14` ⇒ `PAST_DUE`, `graceUntil` calculado, acceso
    `FULL` y aviso con la fecha exacta.
12. Quince días después ⇒ `READ_ONLY`; **pero** `postEntryAction` **sigue
    funcionando** con marca de mora, y también el contra-asiento de anulación, el
    registro de un documento recibido, la liquidación de IVA del periodo, el
    checkout, los informes y el backup. **Se deniegan** invitar, crear organización,
    restaurar y cambiar preferencias.
12-bis. **O-16**: en `READ_ONLY` y con `maxStorageBytes` agotado, `uploadFileAction`
    **sube el fichero** con aviso y `PlatformAuditLog` de excepción automática;
    `analyzeFileAction` **se deniega** con motivo legible («el análisis con IA
    requiere una suscripción al día; el documento se puede registrar y contabilizar
    a mano»), y el documento queda en la bandeja con sus bytes y su `sha256`.
13. **Ningún camino** —acción, API ni formulario— rechaza un `postEntry` por cuota:
    test estático sobre el AST (I-E11-4c).
14. Superado `softMaxEntriesMonth` ⇒ asiento **posteado**, aviso en cabecera y en
    `/settings/subscription`, **WARN** en la familia `PLATAFORMA`, `PlatformAuditLog`
    de excepción **automática**, y la demo y las importaciones masivas bloqueadas.

**Límites duros**

15. `maxMembers = 3` con tres aceptados ⇒ invitar al cuarto da error legible,
    **ninguna `Invitation`** y ningún correo.
16. 99 MB de 100 MB y un fichero de 5 MB ⇒ error, **ningún byte en el almacén**,
    ningún `File`, ningún `StoredObject`.
17. Cuota de OCR agotada ⇒ el documento queda `PENDIENTE` con el motivo, **no se
    descarta** y no se llama al proveedor.
18. Dos peticiones simultáneas por la última plaza ⇒ **una** gana (`FOR SHARE`).
19. `-1` ⇒ ninguna escritura bloqueada y `checkLimit` **sin consultar** el uso.

**Portabilidad (D5 / O-4)**

20. FREE (`maxBackupsMonth = 1`) que ya gastó su backup y está en `READ_ONLY` ⇒
    **puede pedir y descargar otro**, `trigger = EXIT`, sin consumir cuota.
21. Organización `CANCELED` ⇒ `exportWindowUntil` a 90 días; el ZIP no caduca antes
    aunque la retención del plan sea de 7 días (I-E11-11).

**Uso derivado**

22. 120 asientos ordinarios + 8 contra-asientos + los 4 del cierre ⇒ `entries = 120`
    (O-5), y un recuento independiente por SQL da lo mismo (I-E11-1).
23. Organización con demo ⇒ **I-E11-1 PASS**: la demo está en otra organización y
    sus asientos, documentos y bytes no entran en ninguna de las seis métricas.
24. Anular un asiento ⇒ cambia `sourceHash`, la caché no se sirve, y `entries`
    **baja** en 1 (el original sale por `voidedAt`… y el contra-asiento nunca entró).
25. `UsageRun` alterado por SQL ⇒ **I-E11-1 FAIL** nombrando métrica y las dos cifras.

**Backup y restauración (D2 / O-1 / O-2)**

26. Backup del fixture ⇒ el ZIP trae **una entrada por cada tabla de
    `TENANT_MODELS`** con su recuento, manifest firmado, `global/exchange_rates.jsonl`
    con **las referenciadas** y los sellos (I-E11-7).
27. Restaurado a organización nueva ⇒ las **seis** comprobaciones en verde,
    `verified = true`, `DONE`, y la PyG analítica devuelve **al céntimo** las ocho
    cifras conocidas (INGRESOS 6 250 000 … RESULTADO 1 497 322).
28. **Dos asientos con los `entryNumber` intercambiados** en el ZIP ⇒ los tres hashes
    coinciden **y aun así** la comprobación 2 falla: `DONE_UNVERIFIED` nombrando el
    ejercicio y los dos números. *Es el caso exacto que O-1 destapó.*
29. Un `proposal_sha` alterado en el JSONL ⇒ la comprobación 3 lo detecta al
    recomputarlo (I-E8-11 en el destino).
30. Un `AuditLog` con una fila menos ⇒ comprobación 4 en rojo: se ve que se perdió
    quién forzó qué.
31. Una línea que referencia una tasa que no viaja en `global/` ⇒ el restore **falla
    nombrándola**; y si viaja con **otro valor** que el existente, también.
32. Un byte alterado en `data/journal_lines.jsonl` ⇒ **la verificación del manifest
    falla antes de tocar la base** y no se crea ninguna organización.
33. Firma de otra instalación ⇒ rechazo, salvo autorización explícita del operador
    que queda registrada.
34. Una cuenta inexistente en una línea ⇒ el `RestoreJob` **aborta** con tabla, línea
    y motivo; la organización destino queda vacía y marcada; **no se informa de éxito
    parcial** (G-15).
35. **No existe ningún camino** que restaure encima de una organización con datos, ni
    que borre una organización con asientos (O-11).
36. Un asiento posteado durante el volcado ⇒ el job detecta el cambio de sello y se
    reencola; nunca sella un estado intermedio.
37. ZIP caducado ⇒ objeto borrado, fila `EXPIRED`, descarga `410` con motivo; un
    `StoredObject` de `kind = PLATFORM_INVOICE` **nunca** caduca (I-E11-11).

**Almacenamiento**

38. `STORAGE_BACKEND=s3` ⇒ `StoredObject` con su `sha256`, previsualización servida,
    sha del almacén coincidente (I-E11-6).
39. Migración sin `--apply` ⇒ enumera y no mueve; con `--apply` ⇒ idempotente, y un
    fichero con sha discordante **no se sube** y se informa.

**Onboarding (O-6, O-7)**

40. Seis pasos completados ⇒ **las nueve piezas** de I-E11-10, con `TaxRate` de IVA
    e IRPF vigentes y `Currency` de la moneda base.
41. **Asistente abandonado en el paso 3** ⇒ **I-E11-10 PASS**: series y ejercicio
    provisional se sembraron en el paso 1 (O-7a/b). *En la ronda 1 esto fallaba con
    datos limpios.*
42. Paso 3 ⇒ **edita** el ejercicio provisional; nunca hay dos solapados.
43. Renombrar el prefijo con `lastNumber = 0` ⇒ permitido; con un número emitido ⇒
    **rechazado** (art. 6.1.a RD 1619/2012).
44. Fallo inyectado al sembrar el mapa ⇒ **no queda organización**: revierte todo.
45. Demo ⇒ **organización propia** `isDemo`, fixture posteado **por el motor**, ocho
    cifras cuadradas, no cuenta contra `maxOrganizations` ni contra ninguna métrica.
46. «Vaciar la demo» ⇒ **borra la organización de demo entera**; **no existe ningún
    botón que borre un asiento posteado** (O-6).
47. `isDemo` no se puede cambiar por SQL: el trigger lo rechaza.

**Cron (D4 / O-13)**

48. Dos invocaciones simultáneas del mismo periodo ⇒ una ejecuta, la otra
    `{skipped:true}`; mismas ocurrencias que con una sola (I-E11-12).
49. **El job lanzado con dos días de retraso produce el MISMO asiento y el mismo
    `inputHash`** que en su día (O-13): la ocurrencia se fecha por su periodo de
    devengo, no por el reloj.
50. Organización en mora ⇒ `invariant-sweep` corre; `recurring-due` genera la
    liquidación de IVA vencida y deja el resto en `OMITIDA` con motivo
    `SUSCRIPCION_EN_MORA`, **sin que I-E9-1a falle**.
51. `/api/cron/x` sin `Bearer` correcto ⇒ `401`, sin pista y con el cubo consumido.
52. 50 organizaciones y 240 s ⇒ `PARTIAL` con cursor; la siguiente **continúa en la
    31**.
53. Organización con FK rota ⇒ las otras 49 se procesan, `failed = 1`, registrada.
54. Migración pendiente ⇒ `/api/health` responde `degraded`.

**Deuda heredada**

55. 250 empleados con partes (D-8) ⇒ calendario con **una** consulta agregada por
    (empleado, día), < 400 ms.
56. `.xlsx` renombrado a `.csv` (D-9) ⇒ rechazo en el borde, sin 30 000 rechazos.
57. Seis intentos de login repartidos entre dos réplicas (D-10) ⇒ se cuentan juntos
    y sobreviven a un reinicio.
58. `depreciationStartsOn = MES_DE_ALTA` (D-3) ⇒ el cuadro arranca el mes del alta;
    con el valor por defecto, el siguiente, **como hoy**.

**I-E11-8, la puerta indirecta (O-8)**

59. **No existe ningún camino** que convierta una `PlatformInvoice` en un
    `Transaction`, un `ExtractionRun` o un `File` de la organización: test estático
    + barrido.

**El 349 sin pantalla (O-17)**

60. Emitidas tres facturas `NO_SUJETO_LOCALIZACION_UE` en un trimestre ⇒ la consulta
    del runbook devuelve una fila por NIF-IVA con la base en euros, agrupada por
    **`operation_date`** (devengo) y no por `issued_at`; y la del umbral enseña el
    trimestre con su base acumulada. Test de integración que **ejecuta las dos
    consultas del runbook**, para que no se pudran al cambiar una columna.

---

## 15. Plan de tareas

**28 tareas · 726 h.** Nivel 1 salvo lo marcado; las **Nivel 2 están bloqueadas
hasta que ADR-0019 esté APROBADO**.

| T | Tarea | H | Depende | Agente | Niv. |
|---|---|---|---|---|---|
| **T1** | Tipos `lib/platform/`, guard de pureza extendido, `lib/config.ts` (`STORAGE_*`, `CRON_SECRET`, `PLATFORM_SIGNING_KEY`), arranque que falla con `BETTER_AUTH_SECRET` por defecto fuera de self-hosted | 10 | — | dev-backend | 1 |
| **T2** | **M1 + M4**: planes, suscripciones, eventos, RLS, catálogo sembrado (**P-1**), backfill, `bigint`, `isDemo`/`depreciationStartsOn`, **guardia `aiBalance > 0` (O-14)** | 30 | T1 | dev-backend | **2** |
| **T3** | Motor `subscription.ts` + `plan.ts`: mapeo, gracia, `accessLevelOf`, **`isPermittedInArrears` (O-3)**, `resolvePlanAt`, `planCatalogHash` + tests | 24 | T1 | dev-backend | **2** |
| **T4** | `lib/storage/driver.ts` + `LocalDriver` + `S3Driver`, `models/storage.ts`, `StoredObject` (M2 parte) | 26 | T1 | dev-backend | **2** |
| **T5** | Cablear `files`/`uploads`/`previews`/`files-integrity`/`preview` al driver + `scripts/migrate-uploads-to-storage.ts` | 26 | T4 | dev-backend | 1 |
| **T6** | **M2 resto**: `usage_runs`, `backup_jobs`, `restore_jobs` + RLS + `TENANT_MODELS` | 14 | T2 | dev-backend | 1 |
| **T7** | `lib/platform/backup/` puro: manifest (con numeración, series, sellos derivados y `AuditLog`), firma con `keyId`, **`backupInventory` y `derivedSealColumns` derivados del código (O-1.3)** | 28 | T6 | dev-backend | **2** |
| **T8** | Volcado en streaming por lotes con cursor: JSONL, ficheros, **`global/exchange_rates.jsonl` (O-1.5)**, sellos al principio y al final | 34 | T7, T4 | dev-backend | **2** |
| **T9** | Restauración a organización nueva + **las seis verificaciones de §5.4** + `DONE_UNVERIFIED` (O-2) + barrido de las nueve familias | 42 | T8 | dev-backend | **2** |
| **T10** | `usage.ts` + `models/usage.ts`: seis métricas por agregado SQL **con las exclusiones de O-5/O-6**, `usageSourceHash` con `periodMonth` (O-12b) y filtro por `kind` (O-12c) | 26 | T6 | dev-backend | 1 |
| **T11** | `limits.ts` + `models/platform-limits.ts`: **duras vs blanda (O-3)**, excepción automática, `FOR SHARE`, **portabilidad sin cuota (O-4)**, `LimitExceededError` en español | 24 | T10, T3 | dev-backend | 1 |
| **T12** | `seedOrganization` con las **nueve piezas** y **O-7a/b** + `OnboardingRun` (M3) + backfill + **demo en organización propia (O-6)** con trigger de inmutabilidad | 32 | T2 | dev-backend | 1 |
| **T13** | Cablear el guardián en las **siete** acciones + `requireOrg` con `accessLevelOf` y `allowInReadOnly` **acotado por `isPermittedInArrears`**, incluida la asimetría **`uploadFileAction` permitida / `analyzeFileAction` denegada** en mora (**O-16**) | 24 | T11 | dev-backend | 1 |
| **T14** | Preferencias de organización: `depreciationStartsOn` (**D-3**), retención, destinatario de avisos | 10 | T2 | dev-backend | 1 |
| **T15** | **M3** + `models/cron.ts` + `app/api/cron/[job]` (secreto en tiempo constante, idempotencia, cursor, **`refDate` explícito — O-13**) | 28 | T1 | dev-backend | **2** |
| **T16** | Los **cuatro** jobs cableados a lo existente + **conducta declarada en mora (O-13)** + test de retraso de dos días con mismo `inputHash` | 24 | T15, T8 | dev-backend | **2** |
| **T17** | Webhook reescrito (idempotente, sin alta de tenants, `200` por defecto), checkout y portal por organización, **rate limit persistente (D-10)** | 30 | T3, T15 | dev-backend | **2** |
| **T18** | **`PlatformInvoiceSeries` + `PlatformInvoice` (M5, O-9)**: numeración propia `FOR UPDATE`, `operationDate`/`ivaPeriod`, tratamiento fiscal con revalidación VIES **en el devengo**, cuota en euros a la tasa del devengo, rectificativas, **copia del PDF conservada (C-5)** | 30 | T17, T4 | dev-backend | **2** |
| **T19** | `PlatformAuditLog`, `/api/health`, métricas sin PII, `User.isPlatformAdmin` | 14 | T15 | dev-backend | 1 |
| **T20** | `lib/ledger/invariants-e11.ts` con **I-E11-1…13**, bloque `platform` en `runLedgerInvariants`, familia `PLATAFORMA`, motivos de sello, **los tres tests estáticos de AST** (I-E11-4c, I-E11-7, I-E11-8) | 38 | T9, T10, T13, T16, T18 | dev-backend | **2** |
| **T21** | **D-8** calendario agregado en SQL (+ índice de M5) y **D-9** validación de extensión/mimetype en import y ZIP | 14 | T1 | dev-backend | 1 |
| **T22** | **UI**: `/settings/subscription`, `/settings/backups` reescrita con SSE y las seis comprobaciones, `/onboarding` (6 pasos), avisos de cuota, estados vacío/carga/error | 54 | T13, T9, T12, T18 | dev-frontend | 1 |
| **T23** | **Despliegue**: **GitHub Actions scheduled workflow** (P-5) + Vercel Cron de respaldo, bucket y credenciales de Supabase Storage, `sslmode` del pooler, runbook `docs/deploy/e11-plataforma.md` **con las dos consultas SQL del 349 y del umbral (O-17)**, `DESPLIEGUE-PREVIEW.md` del Project | 18 | T16, T4, T18 | dev-backend | 1 |
| **T24** | **Documentación**: `fiabilidad/SKILL.md` (familia `PLATAFORMA`, I-E11-1…13), `MODELO-DATOS.md` (12 tablas), `ARQUITECTURA.md`, `codebase-taxhacker/SKILL.md`, **corrección de la errata `G-15`**, **`G-20` fechado en E12**, ROADMAP con **E14**, la deuda de §0.3 fechada en `ESTADO.md` y **la pantalla de export 303/349 fechada en E14 (O-17)** | 20 | T20 | documentador | 1 |
| **T25** | **QA**: los **59** criterios de §14 + adversarial (numeración intercambiada, `AuditLog` mermado, tasa ausente, webhook ×3, dos invitaciones concurrentes, cron doble y con retraso, mora, VIEWER, fuga de tenant en `RestoreJob`) | 38 | T22 | qa-tester | 1 |
| **T26** | **Rendimiento**: los **diez** techos de §12, volumen sembrado en el propio test | 22 | T22 | qa-tester | 1 |
| **T27** | **Auditoría** en contexto limpio: reconstruir el uso por SQL, restaurar el fixture y verificar **las seis comprobaciones** a mano, errores inyectados en manifest / numeración / `UsageRun` / serie de plataforma | 22 | T25, T26 | auditor-fiabilidad | 1 |
| **T28** | **Revisión** en contexto limpio + rondas hasta APROBADO | 24 | T27 | revisor-codigo | 1 |

---

## 16. Plan de olas (tres agentes en paralelo, sin colisión)

**Regla de no colisión: dos olas nunca tocan el mismo fichero.** Las migraciones se
reparten por número (M1/M3/M4/M5 → ola A y su cola; M2 → ola B).

### Ola A — facturación, plataforma y reloj · **190 h**
`lib/platform/{types,subscription,plan,cron}.ts` · `models/{subscriptions,plans,platform-invoices,cron,rate-limit}.ts` ·
`app/api/stripe/**` · `app/api/cron/**` · `app/api/health` · M1, M3, M4, M5

**T1 → T2 → T3 → T15 → T16 → T17 → T18 → T19**

### Ola B — almacén, backup, uso y límites · **244 h**
`lib/storage/**` · `lib/platform/{backup,usage,limits}.ts` · `models/{storage,backups,usage,platform-limits}.ts` ·
`lib/files*.ts` · `scripts/migrate-uploads-to-storage.ts` · M2

**T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T13**
*(T6 espera a T2 de la ola A: se planifica al final de la semana 1.)*

### Ola C — siembra, preferencias, deuda de E10 e interfaz · **110 h**
`models/onboarding.ts` · `app/(onboarding)/**` · `app/(app)/settings/{organization,subscription,backups}/**` ·
`lib/time/**` · `lib/uploads` (borde del import)

**T12 → T14 → T21 → T22**
*(T22 es la última: espera a T13, T9, T12 y T18.)*

### Cola de verificación (secuencial, contexto limpio) · **182 h**
**T20** → **T23** → **T24** → **T25** → **T26** → **T27** → **T28**

### Calendario

| Sem. | Ola A | Ola B | Ola C |
|---|---|---|---|
| 1 | T1, T2 | T4 | *(espera M1/M4)* |
| 2 | T3, T15 | T5, T6 | T12, T14 |
| 3 | T16, T17 | T7, T8 | T21 |
| 4 | T18, T19 | T9 | — |
| 5 | — | T10, T11, T13 | T22 |
| 6 | **T20** (sincronización) | | T22 |
| 7 | T23, T24, T25, T26 | | |
| 8 | T27, T28 (rondas) | | |

**Punto de sincronización obligatorio**: **T20 no empieza hasta que las tres olas han
cerrado**. Un invariante escrito sobre la mitad del código es H-1 de E9 y H-1 de E10
repetidos: las dos veces, invariantes que nadie ejecutaba.

---

## 17. Decisiones de Pablo, resueltas (P-1 … P-8)

Permiso delegado de 2026-09-04; el orquestador decide en su nombre salvo coste.

| # | Decisión |
|---|---|
| **P-1** | **Tabla de planes ACEPTADA como parámetro** (§17.1), sembrada por M4. **B2B-only** con NIF-IVA obligatorio y validado; **FREE no vendible** (`stripePriceId` vacío, `isPublic` para el alta) |
| **P-2** | **Sí**: 14 días de gracia con acceso completo, luego `READ_ONLY`, **nunca bloqueo**. Y **O-3**: los límites sobre el **registro contable** son **blandos** (aviso + WARN en Auditoría) y nunca impiden asentar un hecho ocurrido; sólo bloquean las **cuotas de recurso** |
| **P-3** | **Supabase Storage**, un bucket por entorno con **prefijo por organización**. D3 confirmado |
| **P-4** | **No hay clientes con saldo**: `aiBalance` se retira. M4 lo **comprueba y aborta** si aparece alguno (O-14) |
| **P-5** | **Sin coste**: cron por **GitHub Actions scheduled workflow** (gratis, cadencias de 5 y 15 min) llamando a la ruta autenticada; **Vercel Cron diario sólo como respaldo** |
| **P-6** | `/admin` **sólo lectura**, y **fuera de E11**: escrituras y panel a **E12** (§0.3) |
| **P-7** | **Sí**: ciclo comercial a **E14** y corrección de la fila de `ESTADO.md` (T24) |
| **P-8** | **Sí**: 30 días de retención, configurable dentro del máximo del plan. Y **O-4**: FREE con **un** backup mensual, pero **la exportación de portabilidad siempre disponible, sin cuota y en cualquier estado** |

### 17.1 Catálogo de planes (parámetro, sembrado por M4)

| | **FREE** | **STARTER** | **PRO** |
|---|---|---|---|
| Precio de referencia | 0 € | **49 €/mes** | **149 €/mes** |
| Vendible | **No** (`stripePriceId` vacío) | Sí | Sí |
| Organizaciones por usuario | 1 | 3 | 10 |
| Miembros | 2 | 5 | 25 |
| **Asientos / mes (BLANDO)** | 100 | 2 000 | 20 000 |
| Documentos OCR / mes | 20 | 300 | 3 000 |
| Almacenamiento | 500 MB | 10 GB | 100 GB |
| Exportaciones / mes | 5 | 100 | −1 |
| Backups / mes (**el de salida no cuenta**) | 1 | 10 | −1 |
| Días de gracia | 0 | 14 | 30 |
| Retención de backups | 7 d | 30 d | 90 d |

El límite que primero muerde en la práctica es **documentos OCR/mes**, que es el que
tiene coste variable real. El de asientos es **blando por decisión contable** (O-3,
ADR-0019 D7), no por holgura: nadie puede dejar de contabilizar por una cuota.

---

## 18. Riesgos y alternativas descartadas

### Riesgos

- **R-1 · El backup no cabe en una función serverless.** 1,5 GB y 300 s son
  incompatibles con un ZIP en memoria. Mitigación: streaming, multipart, cursor y el
  techo 5 medido con volumen real. Si no basta, worker en contenedor → ADR nuevo.
- **R-2 · La verificación ampliada de O-1 dispara el tiempo de restauración.**
  Recomputar todos los sellos derivados y correr las nueve familias sobre 150 000
  líneas no es gratis. Mitigación: techo 6 subido a 30 min, en lotes, ninguna
  transacción > 30 s. **No se recorta la verificación para ganar tiempo**: era el
  bloqueante.
- **R-3 · Un `DONE_UNVERIFIED` que nadie mira.** Mitigación: la organización queda
  marcada en la cabecera, I-E11-2 la declara FAIL y el sello del periodo sale
  `REQUIERE REVISIÓN`.
- **R-4 · El límite blando se percibe como «gratis ilimitado».** Mitigación: aviso al
  80 %, WARN en Auditoría y propuesta de cambio de plan **el mes siguiente**; el
  coste real está en OCR y almacenamiento, que sí bloquean.
- **R-5 · La revalidación VIES en cada devengo depende de un servicio de terceros
  intermitente.** Mitigación: VIES caído ⇒ **se repercute 21 %** (nunca se presume
  válido), con aviso al cliente y posibilidad de rectificativa posterior.
- **R-6 · GitHub Actions no garantiza puntualidad** (los `schedule` se retrasan con
  carga). Mitigación: la idempotencia por `(job, periodKey)` y el `refDate` explícito
  hacen el retraso **inocuo** (criterio 49), y `/api/health` enseña la edad del
  último run.
- **R-7 · Almacenamiento nuevo en la ruta crítica de la evidencia documental.** Si el
  almacén cae, I-E8-2 e I-E11-6 pasan a `INFO` en masa — y eso es correcto: no se
  miente con un PASS.
- **R-8 · 726 h sigue siendo una épica grande.** Mitigación: §0.3 nombra lo que ya
  salió; la siguiente línea de corte sería T18 (facturación fiscal, 30 h) **sólo si
  se retrasa la puesta de precios**, porque sin ella no se puede facturar.

### Alternativas descartadas

- **Contadores de uso incrementales**: cifra almacenada que puede divergir y que no
  baja al anular (P2/P4). La caché por hash es auditable; un contador no.
- **Bloquear el posteo al agotar la cuota de asientos**: O-3. Un diario con un salto
  de tres semanas y un ticket que diga «límite de plan» lo rechaza un auditor, y el
  impedimento lo habríamos creado nosotros (art. 28.2 CCom, plazos del SII).
- **Un bucket por organización**: crea infraestructura dentro de la transacción de
  alta y no aporta aislamiento que la política no dé.
- **Restaurar sobre la organización existente**: contradice el append-only y es el
  camino por el que el restore actual destruye datos.
- **Verificar la restauración sólo con los tres hashes**: O-1. Dos asientos con los
  números intercambiados dan el mismo `ledgerHash`.
- **Que numere Stripe**: deja huecos (borradores anulados, `void`) y según
  configuración numera por cliente. Sólo sería admisible como expedición por tercero
  (art. 5 RD 1619/2012), con autorización previa, serie exclusiva y **un control de
  huecos ejecutado** — que es justo lo que I-E11-13 hace ahora por nuestra cuenta.
- **Conservar las facturas emitidas «en Stripe»**: un `hostedInvoiceUrl` no es una
  copia conservada, es un enlace a la copia de otro; y conservar fuera de España
  exige acceso completo en línea y su comunicación (art. 23 RD 1619/2012).
- **La demo dentro de la organización del cliente**: exigiría marca por fila,
  exclusión en tres métricas y un botón que borra asientos posteados (O-6).
- **Vender B2C en la UE**: obliga a OSS (035 y 369) por un segmento residual.
- **Límites en JSON**: sin CHECK, sin tipo, y un cambio de forma que rompe en
  silencio.
- **Ampliar `models/backups.ts` tabla a tabla**: multiplicar G-15 por 66.
- **Contabilizar la suscripción en el diario del cliente**: prohibido por I-E11-8,
  ahora también por el camino indirecto (O-8).
- **Colas gestionadas (QStash, Inngest, SQS)**: un proveedor y un modo de fallo más a
  cambio de lo que `CronRun` + cursor resuelven.

---

## 19. Estado de la validación contable

`docs/design/E11-validacion-plataforma.md`: **OBSERVACIONES** → **las quince
incorporadas** (cinco bloqueantes y diez no bloqueantes), y **C-1…C-7 respondidas y
llevadas al esquema**. Lo que el validador aprueba **sin reservas** y que este
diseño conserva **con su redacción**: **I-E11-8** (la plataforma no toca el diario
del cliente), **D6** (el impago no retira la lectura ni la exportación), **el uso
derivado y nunca almacenado** con la retirada de `aiBalance`, y **restaurar siempre
a organización nueva abortando a la primera fila rechazada**.

**Condición de cierre del validador, y dónde queda cubierta:**

| Condición | Estado |
|---|---|
| D2, D3, D4 conformes **con O-1 y O-2 incorporadas** | §5.2, §5.4, §2.4, I-E11-2 |
| D1 firmable **con O-3, O-5, O-9 y O-14** | §3.4, §3.5, §2.2, §2.7, D7, D8 |
| D6 firmable **con O-3 y O-4** | §3.2, §3.5, §5.5, D5, D6 |
| **Precios en producción** bloqueados hasta O-9, O-10, C-5 y B2B-only | T18 los entrega; **B2B-only decidido en P-1** |
| Arranque del sprint **no bloqueado** | Confirmado: ninguna observación toca `lib/ledger`, `lib/analytics` ni `lib/closing` |
