# E2 — Plan de cuentas e impuestos (diseño)

**Épica:** E2 · **Depende de:** E1 (CERRADA) · **Nivel global:** 1 (configuración), con **3 tareas Nivel 2** (RLS de tablas nuevas, FK compuesta `(organization_id, account_code)` que es esquema de sistema del futuro diario, y `audit_logs` append-only) → **ADR-0008 (PROPUESTO)**.
**Estado:** PROPUESTO · **Fecha:** 2026-09-04 · **Autor:** arquitecto
**Ronda 2 (2026-09-04):** incorpora `docs/design/E2-validacion-contable.md` (veredicto OBSERVACIONES). Ver **§10 — Validación contable: CONFORME tras ronda 2** y la tabla de descartes.

---

## 1. Objetivo y alcance

Dar a cada organización un **plan contable propio y editable** (PGC 2007, variantes GENERAL/PYMES) sembrado desde `seeds/npgc.csv`, un **mapa de cuentas de sistema** (`OrganizationAccountMap`) que evita que el motor contable hardcodee códigos, una tabla de **tipos impositivos vigentes** (`TaxRate`: IVA, IRPF, recargo, exento) y un **registro de auditoría genérico** (`AuditLog`) que grabe toda mutación de configuración. Todo con `tenantDb` + RLS (barrera 2) siguiendo el patrón de E1.

**NO incluye**: asientos, ejercicios (`FiscalYear`), numeración, liquidación de IVA, informes, `Counterparty`, contabilización de retenciones, prorrata de IVA, ni cálculo alguno de importes. E2 no escribe una sola cifra contable: solo configuración. Los `check` de "cuenta con movimientos" se dejan **preparados** (interfaz `AccountUsage`) y devuelven 0 hasta que E3 cree `journal_lines`.

**Resto de E0 incluido aquí**: `test:e2e` con `@playwright/test` (smoke de login + plan de cuentas) y su job de CI.

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

- Tablas y columnas NUEVAS en snake_case (`@@map` / `@map`) — obligatorio: el SQL de RLS, triggers e informes las usa por nombre físico.
- `organizationId String @db.Uuid` en las cuatro tablas + `@@unique`/`@@index` compuestos empezando por `organizationId`.
- `code` como **texto** (`VarChar(12)`), nunca numérico: `0` a la izquierda no existe en PGC pero la comparación lexicográfica por prefijo es la que define la jerarquía. 12 caracteres son necesarios: `useSubaccounts` crea nivel 5 (`47510`).
- **Sin dinero en E2** (no hay ningún `Int` de céntimos). El tipo impositivo se guarda en **puntos básicos** (`rateBps Int`): 21 % = `2100`; 5,2 % = `520`; **1,75 % (recargo de labores del tabaco) = `175`** — que es justamente lo que `ratePermille` no podía representar (carencia E-1 del experto). `rateBps` es un ratio, no un importe.
- Fechas de vigencia como `@db.Date` (sin hora, zona de la organización). `createdAt/updatedAt/ts` son `DateTime` de auditoría técnica.
- Una cuenta **nunca se borra si tiene dependientes**; se desactiva (`isActive = false`).

### 2.2 Fragmento Prisma (completo)

```prisma
// ─────────────────────────────────────────────────────────────────────────────
// E2 — Plan de cuentas e impuestos (docs/design/E2-plan-cuentas.md)
// ─────────────────────────────────────────────────────────────────────────────

enum Nature {
  DEUDORA
  ACREEDORA

  @@map("nature")
}

enum Statement {
  BALANCE_ACTIVO
  BALANCE_PASIVO
  BALANCE_PN
  PYG
  ECPN

  @@map("statement")
}

enum AnalyticType {
  INGRESO_DIRECTO
  COSTE_DIRECTO_MC1
  COSTE_DIRECTO_MC2
  INDIRECTO_CECO
  AMORTIZACION_DETERIORO
  FINANCIERO
  EXTRAORDINARIO
  NO_ANALITICO

  @@map("analytic_type")
}

enum CashflowCategory {
  OPERATING
  INVESTING
  FINANCING

  @@map("cashflow_category")
}

/// 57 claves. Las 16 originales + las 41 de §3.2 de la validación contable.
/// El enum se declara ENTERO ahora (añadir un valor a un enum Postgres en caliente
/// es una migración más, y E3–E8 los necesitan), pero `defaultAccountMap` solo
/// EXIGE resolver el bloque marcado (*) — el resto se mapea cuando su épica llega.
enum AccountKey {
  // ── Bloque obligatorio (*): E3 factura/cobro/pago + E8 impuestos ──
  CLIENTES                      // * 430
  PROVEEDORES                   // * 400
  ACREEDORES                    // * 410
  BANCO_DEFAULT                 // * 572
  CAJA                          // * 570
  IVA_SOPORTADO                 // * 472
  IVA_REPERCUTIDO               // * 477
  IRPF_RETENIDO_CLIENTES        // * 473
  IRPF_A_PAGAR                  // * 4751
  HP_ACREEDORA_IVA              // * 4750
  HP_DEUDORA_IVA                // * 4700
  SS_ACREEDORA                  // * 476
  REMUNERACIONES_PENDIENTES     // * 465
  RESULTADO_EJERCICIO           // * 129
  VENTAS_DEFAULT                // * 705
  COMPRAS_DEFAULT               // * 600
  SUBCONTRATACION_DEFAULT       // * 607 — default real de una empresa de servicios (MC1)
  ANTICIPOS_PROVEEDORES         // * 407
  ANTICIPOS_CLIENTES            // * 438
  DESCUENTO_PP_VENTAS           // * 706
  DESCUENTO_PP_COMPRAS          // * 606
  DEVOLUCION_VENTAS             // * 708
  DEVOLUCION_COMPRAS            // * 608
  RAPPEL_VENTAS                 // * 709
  RAPPEL_COMPRAS                // * 609
  REDONDEO_GASTO                // * 669 — regla R-IVA-7
  REDONDEO_INGRESO              // * 769 — regla R-IVA-7
  IRPF_PROFESIONALES_A_PAGAR    // * 4751 / 47510
  IRPF_ALQUILERES_A_PAGAR       // * 4751 / 47511 (modelo 115)
  IRPF_TRABAJO_A_PAGAR          // * 4751 / 47512 (modelo 111)
  IVA_SOPORTADO_ISP             // * 472 / 4720 (bajo demanda, §2.6)
  IVA_REPERCUTIDO_ISP           // * 477 / 4770 (bajo demanda, §2.6)
  AJUSTE_IVA_NEGATIVO           // * 634 — prorrata y bienes de inversión
  AJUSTE_IVA_POSITIVO           // * 639
  IMPUESTO_BENEFICIOS_GASTO     // * 630
  HP_ACREEDORA_IS               // * 4752
  HP_DEUDORA_IS                 // * 4709
  ACTIVO_IMPUESTO_DIFERIDO      // * 4740
  PASIVO_IMPUESTO_DIFERIDO      // * 479
  PERIODIFICACION_GASTO         // * 480
  PERIODIFICACION_INGRESO       // * 485
  DIFERENCIA_CAMBIO_NEGATIVA    // * 668
  DIFERENCIA_CAMBIO_POSITIVA    // * 768
  // ── Declaradas ahora, mapeadas por su épica (sin default obligatorio) ──
  RETENCIONES_CAPITAL_SOPORTADAS // 473  (E5)
  SS_DEUDORA                     // 471  (E4)
  ANTICIPOS_REMUNERACIONES       // 460  (E4)
  SUELDOS_DEFAULT                // 640  (E4)
  SS_EMPRESA_DEFAULT             // 642  (E4)
  CLIENTES_DUDOSO_COBRO          // 436  (E6)
  DETERIORO_CLIENTES             // 490  (E6)
  DOTACION_DETERIORO_CREDITOS    // 694  (E6)
  REVERSION_DETERIORO_CREDITOS   // 794  (E6)
  PERDIDA_CREDITOS_INCOBRABLES   // 650  (E6)
  CUENTA_PUENTE_TESORERIA        // 555  (E5, bidireccional)
  COMISIONES_BANCARIAS           // 626  (E5)
  REMANENTE                      // 120  (E8)
  RESULTADOS_NEGATIVOS_ANTERIORES // 121 (E8)

  @@map("account_key")
}

enum TaxKind {
  IVA
  IRPF
  RECARGO
  EXENTO

  @@map("tax_kind")
}

/// A qué lado del hecho económico aplica el tipo. Una sola fila por tipo
/// impositivo (21 % es 21 % se compre o se venda): la dirección la fija el
/// asiento tipo, no el impuesto (respuesta C-2 del experto).
enum TaxAppliesTo {
  SALE
  PURCHASE
  BOTH

  @@map("tax_applies_to")
}

/// Método de redondeo de cuotas del documento (regla R-IVA-4: se sella en el
/// asiento para que el recálculo sea reproducible). El motor lo consume en E3.
enum TaxRoundingMode {
  PER_TIPO
  PER_LINEA

  @@map("tax_rounding_mode")
}

/// Origen de la fila: distingue lo sembrado de lo que ha tocado la organización.
/// Necesario para que `importNpgc` sea idempotente SIN pisar ediciones del usuario.
enum AccountOrigin {
  SEED
  MANUAL
  CSV_IMPORT

  @@map("account_origin")
}

/// Cuenta CONTABLE. Se llama `LedgerAccount` en TypeScript (no `Account`) porque
/// ese nombre ya lo ocupa better-auth; ver el recuadro tras el fragmento. La tabla
/// física es `accounts`, que es lo que ve el SQL de RLS, triggers e informes.
model LedgerAccount {
  id               String            @id @default(uuid()) @db.Uuid
  organizationId   String            @map("organization_id") @db.Uuid
  organization     Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code             String            @db.VarChar(12)
  name             String            @db.VarChar(255)
  /// Longitud del código (1–4 = grupo/subgrupo/cuenta/subcuenta oficial; >4 = subcuenta propia).
  level            Int
  /// Prefijo estricto más largo que EXISTE en el plan de la organización (no code[:-1]).
  parentCode       String?           @map("parent_code") @db.VarChar(12)

  nature           Nature
  statement        Statement?
  /// Epígrafe del modelo NORMAL (columna `epigrafe` del seed).
  epigraph         String?           @db.VarChar(255)
  /// Epígrafe del modelo PYMES/abreviado (columna `epigrafe_pymes`). Se guardan
  /// LOS DOS: cambiar de variante no debe obligar a reimportar el plan (C-1).
  /// El informe elige por `Organization.pgcVariant`; `epigraphFor(account, variant)`.
  epigraphPymes    String?           @map("epigraph_pymes") @db.VarChar(255)
  /// Cuenta de saldo indistinto (551, 552, 5523–5525, 554, 555 · 7 en el seed):
  /// el balance la reclasifica POR SIGNO, no por `statement` fijo (carencia E-3).
  /// `statement`/`epigraph` guardan la ruta del saldo DEUDOR; la acreedora la
  /// resuelve la tabla de reclasificación del generador de balance (E6).
  bidirectional    Boolean           @default(false)
  /// Contra-cuenta: naturaleza contraria a su masa (28x, 29x, 39x, 49x, 59x, 406,
  /// 437, 606/608/609, 706/708/709 · 165 en el seed). El renderizador RESTA, no
  /// suma (carencia E-2, regla R-13).
  isContra         Boolean           @default(false) @map("is_contra")
  analyticType     AnalyticType?     @map("analytic_type")
  cashflowCategory CashflowCategory? @map("cashflow_category")

  /// Solo las hojas reciben líneas de asiento (E3). Derivado: se recalcula al crear un hijo.
  isPostable       Boolean           @default(true) @map("is_postable")
  isActive         Boolean           @default(true) @map("is_active")
  /// Mapeada en OrganizationAccountMap o usada por un TaxRate: no desactivable ni borrable.
  isSystem         Boolean           @default(false) @map("is_system")
  origin           AccountOrigin     @default(MANUAL)

  createdAt        DateTime          @default(now()) @map("created_at")
  updatedAt        DateTime          @updatedAt @map("updated_at")

  parent           LedgerAccount?    @relation("AccountTree", fields: [organizationId, parentCode], references: [organizationId, code], onDelete: NoAction, onUpdate: NoAction)
  children         LedgerAccount[]   @relation("AccountTree")
  accountMaps      OrganizationAccountMap[]
  taxRatesMain     TaxRate[]         @relation("TaxRateAccount")
  taxRatesCounter  TaxRate[]         @relation("TaxRateCounterAccount")

  @@unique([organizationId, code])
  @@index([organizationId, parentCode])
  @@index([organizationId, isActive, isPostable])
  @@index([organizationId, statement])
  @@map("accounts")
}

model OrganizationAccountMap {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  key            AccountKey
  accountCode    String        @map("account_code") @db.VarChar(12)
  account        LedgerAccount @relation(fields: [organizationId, accountCode], references: [organizationId, code], onDelete: Restrict, onUpdate: Cascade)

  createdAt      DateTime     @default(now()) @map("created_at")
  updatedAt      DateTime     @updatedAt @map("updated_at")

  @@unique([organizationId, key])
  @@index([organizationId, accountCode])
  @@map("organization_account_maps")
}

model TaxRate {
  id                 String       @id @default(uuid()) @db.Uuid
  organizationId     String       @map("organization_id") @db.Uuid
  organization       Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code               String        @db.VarChar(24)
  name               String        @db.VarChar(128)
  kind               TaxKind
  /// Puntos básicos: 21 % = 2100, 5,2 % = 520, **1,75 % = 175**, 0 % = 0.
  /// `ratePermille` NO servía (1,75 % = 17,5 ‰ no es entero) — carencia E-1.
  rateBps            Int           @map("rate_bps")
  /// Un tipo, una fila: la dirección la fija el asiento tipo (C-2). `BOTH` es lo
  /// normal en IVA e IRPF; `SALE`/`PURCHASE` para exenciones y regímenes de un
  /// solo lado (entrega intracomunitaria, recargo soportado).
  appliesTo          TaxAppliesTo  @default(BOTH) @map("applies_to")

  /// Cuenta del lado VENTA (repercutido 477 / retención que practicamos 4751).
  accountCode        String        @map("account_code") @db.VarChar(12)
  account            LedgerAccount @relation("TaxRateAccount", fields: [organizationId, accountCode], references: [organizationId, code], onDelete: Restrict, onUpdate: Cascade)
  /// Cuenta del lado COMPRA (soportado 472 / retención que nos practican 473).
  /// Con `IVA_ISP` ambas se usan A LA VEZ en el mismo asiento (efecto neto 0).
  counterAccountCode String?       @map("counter_account_code") @db.VarChar(12)
  counterAccount     LedgerAccount? @relation("TaxRateCounterAccount", fields: [organizationId, counterAccountCode], references: [organizationId, code], onDelete: Restrict, onUpdate: Cascade)

  /// Recargo de equivalencia → el tipo de IVA al que acompaña (5,2↔21, 1,4↔10,
  /// 0,5↔4, 1,75↔labores del tabaco). Tributo distinto, fila propia, versionable
  /// por separado (C-2). Autorreferencia dentro de la misma organización.
  linkedTaxRateId    String?       @map("linked_tax_rate_id") @db.Uuid
  linkedTaxRate      TaxRate?      @relation("TaxRateLink", fields: [linkedTaxRateId], references: [id], onDelete: SetNull, onUpdate: Cascade)
  linkedBy           TaxRate[]     @relation("TaxRateLink")

  /// Siempre explícita, nunca abierta hacia atrás: un asiento de 2024 no puede
  /// coger el tipo de 2026 (C-7). El seed usa 2025-01-01 (fin de las rebajas
  /// temporales de 2022–2024).
  validFrom          DateTime      @map("valid_from") @db.Date
  validTo            DateTime?     @map("valid_to") @db.Date
  isActive           Boolean       @default(true) @map("is_active")
  isSystem           Boolean       @default(false) @map("is_system")

  createdAt          DateTime      @default(now()) @map("created_at")
  updatedAt          DateTime      @updatedAt @map("updated_at")

  @@unique([organizationId, code, validFrom])
  @@index([organizationId, kind, validFrom])
  @@index([organizationId, accountCode])
  @@map("tax_rates")
}
```

`Organization` gana además los tres parámetros fiscales que el experto echa en falta (carencia E-5). Se declaran y se editan en E2; **los consume el motor en E3** (reglas R-IVA-1…R-IVA-7):

```prisma
model Organization {
  // … campos de E1 …
  /// Prorrata general aplicable (‰). Null = 100 % deducible. Versionada por
  /// ejercicio en E8; en E2 es el valor vigente.
  prorrataPermille       Int?            @map("prorrata_permille")
  /// R-IVA-1 canónica: una cuota por tipo impositivo.
  taxRoundingMode        TaxRoundingMode @default(PER_TIPO) @map("tax_rounding_mode")
  /// R-IVA-7: diferencia residual admitida contra 669/769. Por encima, bloquea.
  redondeoToleranciaCents Int            @default(1) @map("redondeo_tolerancia_cents")
}

model AuditLog {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  /// Null solo para mutaciones de sistema (seed de alta de organización, CLI).
  userId         String?      @map("user_id") @db.Uuid

  /// Nombre del modelo Prisma: "Account", "TaxRate", "OrganizationAccountMap", "Organization", "Membership".
  entity         String       @db.VarChar(64)
  entityId       String       @map("entity_id") @db.VarChar(64)
  /// "create" | "update" | "deactivate" | "activate" | "delete" | "seed" | "import" | "remap".
  action         String       @db.VarChar(64)
  before         Json?
  after          Json?
  reason         String?      @db.VarChar(512)
  ts             DateTime     @default(now())

  @@index([organizationId, ts])
  @@index([organizationId, entity, entityId, ts])
  @@map("audit_logs")
}
```

`Organization` gana cuatro relaciones inversas: `ledgerAccounts LedgerAccount[]`, `accountMaps OrganizationAccountMap[]`, `taxRates TaxRate[]`, `auditLogs AuditLog[]`.
`lib/db.ts` gana en `TENANT_MODELS`: `"LedgerAccount"`, `"OrganizationAccountMap"`, `"TaxRate"`, `"AuditLog"`.

> ⚠ **Colisión de nombre — decidida en ronda 2 tras verificar el código**: `Account` de better-auth (tabla física `account`) ya ocupa ese nombre y Prisma no admite dos modelos homónimos.
> **Decisión: la cuenta contable se llama `LedgerAccount` (`@@map("accounts")`) y better-auth NO se toca.**
> Motivo, comprobado en `lib/auth.ts:28`: la instancia es `betterAuth({ database: prismaAdapter(prisma, { provider: "postgresql" }), … })`, **sin ningún mapeo de nombres de modelo**. `prismaAdapter` resuelve cada modelo interno por nombre (`prisma.account`), así que renombrarlo a `AuthAccount` obliga a añadir un `account: { modelName: "authAccount" }` cuyo contrato varía entre versiones de better-auth y que el compilador no valida: el fallo aparecería **en runtime, en el login**, y el plugin `emailOTP` y el propio flujo de sesión también tocan ese modelo. Cambiar el nombre TypeScript de una tabla que gestiona la librería de autenticación para ahorrar un prefijo en una tabla nuestra es un mal reparto del riesgo.
> Coste de `LedgerAccount`: el nombre TypeScript no coincide con `docs/MODELO-DATOS.md` (que dice `Account`). Se resuelve documentándolo — MODELO-DATOS se actualiza en T14 — y **el nombre físico, que es el que ve el SQL de RLS, triggers e informes, sigue siendo `accounts`**, que es lo único que el motor contable y el auditor necesitan que sea estable. Alternativas descartadas en §9.3.

### 2.3 Desviaciones respecto a `docs/MODELO-DATOS.md`

| # | Desviación | Motivo |
|---|---|---|
| D2-1 | `LedgerAccount.origin` (enum `AccountOrigin`) no está en MODELO-DATOS | Sin él, `importNpgc` idempotente no puede distinguir "cuenta sembrada que puedo refrescar" de "cuenta que el usuario editó y no debo pisar". Alternativa (guardar el sha del seed en `Setting`) no resuelve el caso por-fila. |
| D2-2 | `TaxRate.name`, `isActive`, `isSystem` añadidos | La UI necesita etiqueta legible ("IVA 21 % general") y la baja lógica; `isSystem` protege los tipos sembrados. |
| D2-3 | `LedgerAccount.isPostable` con `@default(true)` | MODELO-DATOS no fija default. Una cuenta nace hoja ⇒ postable; deja de serlo al ganar el primer hijo. |
| **D2-4** | ~~Dos `TaxRate` por tipo de IVA~~ → **una fila por tipo con `appliesTo` + las dos cuentas** | **Cerrada en ronda 2 (C-2).** El tipo es el mismo hecho jurídico se compre o se venda; duplicarlo obliga a sincronizar dos filas ante cada cambio normativo y rompe el cuadre de la 303, que agrega por tipo. La inversión del sujeto pasivo necesita además ambas cuentas **en el mismo asiento**. |
| **D2-5** | `rateBps Int` en vez de `ratePermille Int` | Carencia E-1: el recargo de labores del tabaco (1,75 % = 17,5 ‰) no es entero en tanto por mil. En bps es 175. |
| **D2-6** | `bidirectional`, `isContra`, `epigraphPymes` en la cuenta | Carencias E-2/E-3 y respuesta C-1. Sin `isContra` el balance suma las 165 contra-cuentas en vez de restarlas; sin `bidirectional` las 7 cuentas de saldo indistinto presentan un activo ficticio cuando el socio financia a la sociedad; sin `epigraphPymes` cambiar de variante obligaría a reimportar el plan. |
| **D2-7** | `AccountKey` pasa de 16 a **57** claves; `linkedTaxRateId` en `TaxRate` | Carencia E-4: las 16 originales no cubren ni la factura con anticipo, ni rectificativas, ni ISP, ni cierre. El enum se declara entero ahora para no encadenar migraciones de enum en E3–E8. |
| **D2-8** | `Organization.prorrataPermille`, `taxRoundingMode`, `redondeoToleranciaCents` | Carencia E-5: el método de redondeo y la prorrata son política de la organización, no constantes del motor (principio "las políticas viven en configuración versionada"). |
| **D2-9** | El modelo TypeScript se llama `LedgerAccount`, no `Account` | Colisión con better-auth; ver el recuadro de §2.2. El nombre físico `accounts` no cambia. |

`docs/MODELO-DATOS.md` (§Plan de cuentas e impuestos) se actualiza en T14 con estas nueve filas.

### 2.4 Variante GENERAL / PYMES — contrato de `importNpgc`

El seed regenerado por el experto trae las cuatro columnas que faltaban (`pymes`, `epigrafe_pymes`, `bidireccional`, `is_contra`) y **T2 queda desbloqueada**: el criterio contable (reglas P-01…P-13) vive en `build_npgc.py`, no en TypeScript. Verificado sobre el CSV entregado: 906 filas · 794 con `pymes = 1` · 165 `is_contra` · 7 bidireccionales · 0 huérfanos tras el filtro PYMES · `EXTRAORDINARIO` sin uso a propósito.

```ts
importNpgc(db, variant: PgcVariant, rows: SeedAccount[], actor, now, opts?: {
  useSubaccounts?: boolean        // default TRUE  — crea 5720/4300/4000/4100 y 47510/47511/47512
  createSoftwareAccounts?: boolean // default FALSE — 4720/4730/4760/4770 (§2.6)
}): { created: number; skipped: number; mapKeys: number }
```

| Regla | Comportamiento |
|---|---|
| Filtrado | `variant = PYMES` ⇒ solo filas con `pymes = 1`. La cascada por padre ya viene resuelta en el dato; `planDiff` la **revalida** igualmente (0 padres huérfanos) y falla si no. |
| Epígrafe | `epigraph` ← `epigrafe` **y** `epigraphPymes` ← `epigrafe_pymes`, **siempre las dos**, sea cual sea la variante. Los informes eligen con `epigraphFor(account, variant)`. |
| `isPostable` | Se recalcula **después** del filtrado: al excluir `6632`, la cuenta `663` pasa a ser hoja y postable. No se copia del seed. |
| Orden | Inserción por `code` ascendente: el padre existe antes que el hijo. |
| `useSubaccounts` | Crea `5720`, `4300`, `4000`, `4100` (una cuenta bancaria = una subcuenta; mayor de clientes legible) y `47510`/`47511`/`47512` (modelos 111 profesionales / 115 alquileres / 111 trabajo). Los padres `572`, `430`, `400`, `410`, `4751` quedan `isPostable = false` y **el mapa apunta siempre a la hoja**. Con `false`, las tres claves de IRPF apuntan a `4751` y el cuadre por modelo se hace agrupando por `taxRateId`. |
| `isSystem` | `true` en toda cuenta referenciada por `OrganizationAccountMap`. |
| Idempotencia | `planDiff(…, "seed")`: nunca desactiva, nunca renombra, nunca pisa una fila con `origin ≠ SEED`. |
| Revalidación final | 0 padres huérfanos · 0 claves del bloque obligatorio apuntando a cuenta inexistente, inactiva o no postable (invariante **I-plan-1**). Si falla, la transacción entera se revierte. |
| **R-14** | `Organization.pgcVariant` **no se puede cambiar si existe algún `JournalEntry` posteado**. En E2 no hay diario: la comprobación se implementa contra la misma interfaz `AccountUsage` (`movementCount`) y queda activa el día que E3 crea la tabla. |

### 2.5 Cuentas de convención de software (4720 / 4730 / 4760 / 4770)

`createSoftwareAccounts = false` por defecto (respuesta C-6): no son cuentas oficiales del PGC y una PYME con un solo tipo de IVA no las necesita. Se crean **siempre como subcuentas** de 472/473/476/477 (libre desarrollo, parte quinta del PGC), nunca como cuentas de nivel 3 (regla R-20), en tres supuestos:

1. Bajo demanda explícita del ADMIN desde `/settings/accounts`.
2. **Automáticamente** cuando la organización tiene más de un tipo de IVA simultáneamente vigente y pide el mayor desglosado.
3. **Automáticamente** al activar inversión del sujeto pasivo o adquisiciones intracomunitarias: el doble apunte 472/477 sobre la misma cuenta hace ilegible el mayor. En ese caso las claves `IVA_SOPORTADO_ISP` / `IVA_REPERCUTIDO_ISP` se remapean a `4720` / `4770`.

### 2.6 Migraciones

| Migración | Contenido | Nivel |
|---|---|---|
| `20260905100000_e2_accounts_taxes_audit` (Prisma) | Crea `accounts`, `organization_account_maps`, `tax_rates`, `audit_logs`, los 9 enums (incl. `tax_applies_to`, `tax_rounding_mode`), las 3 columnas fiscales de `organizations`, índices y uniques. **No toca better-auth** (§2.2). | 1 |
| `.../20260905100000_e2_accounts_taxes_audit/constraints.sql` (SQL manual dentro de la carpeta) | FK compuesta `(organization_id, parent_code) → accounts(organization_id, code)`; FK compuestas de `organization_account_maps` y `tax_rates` (incluida la de `counter_account_code`); FK `linked_tax_rate_id → tax_rates(id)`; `CHECK (code ~ '^[1-9][0-9]{0,11}$')`; `CHECK (level = length(code))`; `CHECK (rate_bps BETWEEN 0 AND 10000)`; `CHECK (kind = 'EXENTO' → rate_bps = 0)`; `CHECK (valid_to IS NULL OR valid_to >= valid_from)`; `CHECK (prorrata_permille BETWEEN 0 AND 1000)`; índice de exclusión de solapes de vigencia (`EXCLUDE USING gist`) — ver §5, I-E2-3. | **2** (esquema de sistema: la FK compuesta es la que impedirá en E3 que una línea apunte a una cuenta de otra organización) |
| `20260905110000_e2_rls` (SQL manual) | `ENABLE ROW LEVEL SECURITY` + política `tenant_isolation` en las 4 tablas, con la MISMA cláusula de escape de E1 (`OR app.current_org() IS NULL` en `USING`, `WITH CHECK` estricto, sin `FORCE`); `audit_logs` **append-only**: `FOR UPDATE USING (false)` y `FOR DELETE USING (false)`; GRANTs a `app_runtime`. | **2** (ADR-0008) |

**Estrategia de datos existentes**: ninguna. Las cuatro tablas nacen vacías; las organizaciones creadas en E1 (incluidas las personales del backfill) se siembran con el **backfill idempotente de T7** (`seeds/import_npgc.ts --all`), que recorre `organizations` y llama a `importNpgc`. Ejecutarlo dos veces no crea nada nuevo.

---

## 3. Motor / funciones puras — `lib/accounts/`

Sin IO, sin LLM, sin `Date.now()`: la fecha de referencia entra como parámetro `refDate: Date`. Todas devuelven `Result` (`{ ok: true, value } | { ok: false, errors: AccountError[] }`) en vez de lanzar, para que la server action pinte los errores en el formulario. El hook `.claude/hooks/guard.sh` debe cubrir también `lib/accounts/` (T1).

```ts
// lib/accounts/types.ts
export type AccountCode = string & { readonly __brand: "AccountCode" }

export type PlanAccount = {
  code: string; name: string; level: number; parentCode: string | null
  nature: Nature; statement: Statement | null
  epigraph: string | null; epigraphPymes: string | null
  bidirectional: boolean; isContra: boolean
  analyticType: AnalyticType | null; cashflowCategory: CashflowCategory | null
  isPostable: boolean; isActive: boolean; isSystem: boolean; origin: AccountOrigin
}
/** Índice inmutable del plan de una organización. Se construye una vez por request. */
export type Plan = { byCode: ReadonlyMap<string, PlanAccount>; codes: readonly string[] }

export type AccountError =
  | { code: "CODE_FORMAT"; field: "code"; message: string }
  | { code: "CODE_DUPLICATE"; field: "code"; message: string }
  | { code: "PARENT_NOT_FOUND"; field: "code"; message: string }
  | { code: "PARENT_INACTIVE" | "PARENT_HAS_MOVEMENTS"; field: "code"; message: string }
  | { code: "SYSTEM_ACCOUNT"; field: string; message: string }
  | { code: "HAS_CHILDREN" | "HAS_MOVEMENTS" | "IS_MAPPED" | "IS_TAXED"; field: string; message: string }
  | { code: "STATEMENT_LOCKED" | "EPIGRAPH_LOCKED" | "ROLE_REQUIRED"; field: string; message: string }
  | { code: "STATEMENT_GROUP_MISMATCH"; field: "statement"; message: string }   // R-11 / R-12
  | { code: "EPIGRAPH_UNKNOWN"; field: "epigraph"; message: string }            // R-15
  | { code: "ANALYTIC_INCOHERENT"; field: "analyticType"; message: string }     // R-16 (aviso)
  | { code: "CLOSED_PERIOD"; field: string; message: string }                   // R-10b
  | { code: "VARIANT_LOCKED"; field: "pgcVariant"; message: string }            // R-14
  | { code: "RATE_RANGE" | "RATE_OVERLAP" | "VALIDITY_RANGE" | "RATE_LINK"; field: string; message: string }
  | { code: "CSV_HEADER" | "CSV_ROW" | "CSV_CYCLE"; field: string; row?: number; message: string }
```

| Función | Firma | Qué garantiza |
|---|---|---|
| `validateAccountCode` | `(code: string) => Result<AccountCode>` | `^[1-9][0-9]{0,11}$`; ≥ 3 dígitos si va a ser postable (regla de la skill `pgc-npgc`). |
| `accountLevel` | `(code: AccountCode) => number` | `= code.length`. |
| `resolveParentCode` | `(code: AccountCode, plan: Plan) => string \| null` | Prefijo estricto **más largo que existe** en el plan (no `code[:-1]`): `7050001` bajo `705` si `70500` no existe. |
| `validateNewAccount` | `(input: NewAccountInput, plan: Plan, usage: AccountUsage) => Result<PlanAccount>` | Código válido y libre; padre existe, está activo y **sin movimientos** (`usage.movementCount === 0`); hereda `nature`/`statement`/`epigraph`/`analyticType` del padre si no se dan; `isPostable = true`. |
| `applyNewAccount` | `(plan: Plan, account: PlanAccount) => { plan: Plan; parentDemoted: string \| null }` | Devuelve el plan resultante y **qué padre deja de ser postable**. Puro: la persistencia de ambos cambios la hace `models/accounts.ts` en una transacción. |
| `validateAccountUpdate` | `(before: PlanAccount, patch: AccountPatch, ctx: EditContext) => Result<AccountPatch>` | **Reglas R-10a/R-10b/R-11/R-12/R-15/R-16/R-18/R-19/R-21 del experto** (§3.2). `ctx = { plan, role, variant, epigraphCatalog, usage, hasClosedPeriodLines }`. |
| `canDeactivateAccount` | `(account: PlanAccount, plan: Plan) => Result<void>` | No si `isSystem` (R-06); no si tiene hijos activos. Desactivar en cascada NO se hace: se listan los hijos y el usuario decide. Una cuenta inactiva **sigue apareciendo en informes históricos** (R-09): `isActive` solo bloquea líneas NUEVAS. |
| `canDeleteAccount` | `(account: PlanAccount, plan: Plan, usage: AccountUsage) => Result<void>` | R-08: solo si `usage.movementCount === 0` **y** sin hijos **y** `!isSystem` **y** `usage.mappedKeys.length === 0` **y** `usage.taxRateCodes.length === 0`. Es el **check preparado para E3**. |
| `buildAccountTree` | `(accounts: readonly PlanAccount[], opts?: { query?: string; showInactive?: boolean; variant: PgcVariant }) => AccountNode[]` | Árbol ordenado por `code`; con `query` devuelve las coincidencias **más sus ancestros** y marca `matched: true`. Cada nodo lleva el `epigraph` de la variante activa y las marcas `isContra` / `bidirectional` para que la UI las pinte. Detecta ciclos → `CSV_CYCLE`. |
| `epigraphFor` | `(account: PlanAccount, variant: PgcVariant) => string \| null` | `PYMES ⇒ epigraphPymes ?? epigraph`. Único punto del código que elige entre las dos columnas. |
| `epigraphCatalog` | `(rows: readonly SeedAccount[], variant: PgcVariant) => ReadonlySet<string>` | Catálogo **cerrado** de epígrafes de la variante, derivado del seed. Alimenta R-15: nada de texto libre que no agregue en ningún informe. |
| `parseNpgcCsv` | `(csvText: string) => Result<SeedAccount[]>` | Parser puro del seed. Cabecera exacta de 13 columnas: `codigo,nombre,nivel,padre,grupo,naturaleza,estado_financiero,epigrafe,tipo_analitico,bidireccional,is_contra,pymes,epigrafe_pymes`. Valida que todo `padre` exista y que `nivel === len(codigo)`. |
| `filterByVariant` | `(rows: readonly SeedAccount[], variant: PgcVariant) => SeedAccount[]` | `GENERAL` = todas; `PYMES` = `pymes === 1`. Función tonta a propósito: el criterio contable (P-01…P-13) vive en `build_npgc.py`, no aquí. Revalida 0 huérfanos y **recalcula `isPostable`** sobre el subconjunto. |
| `planDiff` | `(existing: Plan, incoming: readonly SeedAccount[], policy: "seed" \| "import") => PlanDiff` | `{ create[], update[], skip[] }`. Con `policy: "seed"` **nunca** actualiza una fila cuyo `origin !== SEED`. Con `policy: "import"` actualiza solo los campos mapeados. |
| `parseCustomPlanCsv` | `(csvText: string, mapping: ColumnMapping, defaults: ImportDefaults) => Result<SeedAccount[]>` | Import de plan propio; normaliza los textos contra los enums con diccionario de sinónimos español y contra el `epigraphCatalog` (R-15). Errores con nº de fila; todo o nada. |
| `validateAccountMap` | `(entries, plan: Plan, required: readonly AccountKey[]) => Result<void>` | **I-plan-1**: cada cuenta existe, está activa, es **postable** y es de la organización. `required` = las 43 claves del bloque obligatorio; el resto se admite sin mapear. |
| `defaultAccountMap` | `(plan: Plan, opts: { useSubaccounts: boolean }) => { key: AccountKey; accountCode: string }[]` | Defaults de §3.2 de la validación contable. Con `useSubaccounts` apunta a las hojas (`5720`, `4300`, `47510`…); si un código no existe en la variante, cae al ancestro más cercano que sí exista **y lo reporta**. |
| `validateTaxRate` | `(input: TaxRateInput, existing: readonly TaxRateRow[], plan: Plan, refDate: Date) => Result<TaxRateRow>` | `0 ≤ rateBps ≤ 10000`; `validTo ≥ validFrom`; **sin solape de vigencia para el mismo `code`**; cuentas existentes, activas y postables; `kind = EXENTO ⇒ rateBps = 0`; `kind = RECARGO ⇒ linkedTaxRateId` apunta a un `IVA` vigente en el mismo intervalo (`RATE_LINK`). |
| `selectTaxRate` | `(rates: readonly TaxRateRow[], code: string, refDate: Date) => TaxRateRow \| null` | El vigente a `refDate`. Un asiento de 2024 **no** coge el tipo de 2026 (C-7). Lo consumirá `lib/ledger/templates/` en E3; aquí solo se testea. |
| `taxAccountFor` | `(rate: TaxRateRow, side: "SALE" \| "PURCHASE") => string` | Resuelve la cuenta por dirección: `SALE → accountCode`, `PURCHASE → counterAccountCode ?? accountCode`. Es lo que sustituye a duplicar la fila (C-2); con `IVA_ISP` el asiento pide **las dos**. |
| `seedTaxRates` | `(plan: Plan, validFrom: Date) => TaxRateRow[]` | Catálogo inicial (§3.1). |

```ts
/** Uso de una cuenta. En E2 `movementCount` es SIEMPRE 0 (no hay diario);
 *  E3 lo rellena desde journal_lines. La firma no cambia. */
export type AccountUsage = {
  movementCount: number
  childCount: number
  mappedKeys: readonly AccountKey[]
  taxRateCodes: readonly string[]
}
```

### 3.1 Catálogo inicial de `TaxRate` (`seedTaxRates`, `isSystem: true`)

Una fila por tipo, `appliesTo` y las dos cuentas (C-2). `validFrom = 2025-01-01` en todos los de IVA — fin de las rebajas temporales de 2022-2024 (C-7) —; los de IRPF, la fecha de alta de la organización. Ninguno lleva `validTo`. **No se siembra ningún tipo derogado** (IVA 18 %/16 %): quien migre contabilidad antigua lo carga desde el editor con su vigencia.

| `code` | `kind` | `rateBps` | `appliesTo` | `accountCode` (venta) | `counterAccountCode` (compra) | Nota |
|---|---|---|---|---|---|---|
| `IVA_21` | `IVA` | 2100 | BOTH | `IVA_REPERCUTIDO` 477 | `IVA_SOPORTADO` 472 | General |
| `IVA_10` | `IVA` | 1000 | BOTH | 477 | 472 | Reducido |
| `IVA_4` | `IVA` | 400 | BOTH | 477 | 472 | Superreducido |
| `IVA_0_INTRA` | `EXENTO` | 0 | SALE | 477 | — | Entrega intracomunitaria (art. 25). Requiere ROI/VIES |
| `IVA_0_EXPORT` | `EXENTO` | 0 | SALE | 477 | — | Exportación (art. 21) |
| `IVA_EXENTO_20` | `EXENTO` | 0 | BOTH | 477 | 472 | Exención art. 20. **Genera prorrata** (`prorrataPermille`) |
| `IVA_NO_SUJETO` | `EXENTO` | 0 | BOTH | 477 | 472 | Art. 7: suplidos, transmisión de unidad económica. Fuera de la base de la 303 |
| `IVA_ISP` | `IVA` | 2100 | PURCHASE | `IVA_REPERCUTIDO_ISP` 477/4770 | `IVA_SOPORTADO_ISP` 472/4720 | Inversión del sujeto pasivo: **doble apunte simultáneo**, efecto neto 0 |
| `IVA_ADQ_INTRA_21/10/4` | `IVA` | 2100/1000/400 | PURCHASE | 477/4770 | 472/4720 | Adquisición intracomunitaria: ídem doble apunte |
| `REQ_5_2` | `RECARGO` | 520 | SALE | 477 (4770x) | — | `linkedTaxRateId → IVA_21` |
| `REQ_1_4` | `RECARGO` | 140 | SALE | 477 (4770x) | — | `linkedTaxRateId → IVA_10` |
| `REQ_0_5` | `RECARGO` | 50 | SALE | 477 (4770x) | — | `linkedTaxRateId → IVA_4` |
| `REQ_1_75` | `RECARGO` | **175** | SALE | 477 (4770x) | — | Labores del tabaco. **El caso que `ratePermille` no representaba** |
| `IRPF_PROF_15` | `IRPF` | 1500 | BOTH | `IRPF_PROFESIONALES_A_PAGAR` 4751/47510 | `IRPF_RETENIDO_CLIENTES` 473 | Profesionales, general |
| `IRPF_PROF_7` | `IRPF` | 700 | BOTH | 4751/47510 | 473 | Inicio de actividad: año de inicio y los dos siguientes |
| `IRPF_ALQ_19` | `IRPF` | 1900 | BOTH | `IRPF_ALQUILERES_A_PAGAR` 4751/47511 | 473 | Arrendamiento urbano (modelo 115/180) |
| `IRPF_CURSOS_15` | `IRPF` | 1500 | BOTH | 4751/47512 | 473 | Cursos, conferencias y obras con cesión de derechos |
| `IRPF_PI_15` / `IRPF_PI_7` | `IRPF` | 1500 / 700 | BOTH | 4751/47510 | 473 | Propiedad intelectual (el 7 % exige comunicación del autor) |
| `IRPF_AGRO_2` / `IRPF_AGRO_1` / `IRPF_FORESTAL_2` | `IRPF` | 200 / 100 / 200 | BOTH | 4751 | 473 | Agrícola-ganadera, engorde porcino y avicultura, forestal |
| `IRPF_MODULOS_1` | `IRPF` | 100 | BOTH | 4751 | 473 | Estimación objetiva (art. 95.6 RIRPF) |
| `IRPF_CAPITAL_19` | `IRPF` | 1900 | BOTH | 4751 | `RETENCIONES_CAPITAL_SOPORTADAS` 473 | Capital mobiliario |
| `IRPF_ADMIN_35` / `IRPF_ADMIN_19` | `IRPF` | 3500 / 1900 | SALE | 4751/47512 | — | Administradores (19 % si INCN < 100.000 €) |

**No se siembran** (fuera del alcance de E2, anotados para su épica):
- `IRPF_TRABAJO_VAR` — tipo calculado por empleado (art. 82 RIRPF). El ERP **no lo calcula**: lo toma del proveedor de nóminas. Necesita un campo `computed` que se añade en **E4** junto con la nómina.
- `IGIC_*` / `IPSI_*` — Canarias y Ceuta/Melilla. Los tipos los fijan normas territoriales que cambian con frecuencia: se cargan **por organización** desde el editor, nunca en el seed global. El mecanismo (`TaxKind.IVA` + `code` propio + vigencia) ya los soporta sin tocar código.

### 3.2 Reglas del editor de plan (R-01 … R-22 del experto → dónde vive cada una)

| Regla | Dónde se implementa en E2 |
|---|---|
| R-01 código solo dígitos, 1–12 · R-02 ≥ 3 dígitos para postable | `validateAccountCode` + `CHECK` en BD |
| R-03 el padre debe existir y estar activo | `resolveParentCode` + FK compuesta. **Divergencia consciente**: el experto exige `code[:-1]`; usamos el *prefijo existente más largo* — ver §10, descarte T-6 |
| R-04 cuenta con hijos ⇒ `isPostable = false` (forzado) | `applyNewAccount`, en la misma transacción que el alta del hijo (I-E2-2) |
| R-05 no se puede crear un hijo de una cuenta con líneas | `validateNewAccount` con `usage.movementCount` (0 hasta E3) |
| R-06 `isSystem` ⇒ no desactivable, no borrable, `code` no editable | `canDeactivateAccount`, `canDeleteAccount`, `validateAccountUpdate` |
| R-07 mapa → cuenta existente, activa, postable, de la org | `validateAccountMap` (**I-plan-1**) + FK compuesta + revalidación al sembrar |
| R-08 borrado solo sin líneas, sin hijos, no de sistema | `canDeleteAccount` |
| R-09 inactiva ⇒ no admite líneas nuevas, **sí aparece en informes históricos** | `isActive` no filtra ninguna consulta de informe (contrato escrito en el test) |
| **R-10a `statement` de cuenta oficial de nivel ≤ 3: PROHIBIDO a todos los roles** | `validateAccountUpdate` → `STATEMENT_LOCKED`. La UI ni siquiera muestra el campo: el destino correcto se consigue creando una subcuenta |
| **R-10b `epigraph` de cuenta oficial: ADMIN + motivo + `AuditLog`; prohibido si hay líneas en ejercicio `CLOSED`** | `validateAccountUpdate` → `EPIGRAPH_LOCKED` / `CLOSED_PERIOD` (`ctx.hasClosedPeriodLines`, `false` hasta E3) |
| R-11 `BALANCE_*` prohibido en grupos 6/7 y `PYG` en 1–5 · R-12 `ECPN` solo en 8/9 | `validateAccountUpdate` → `STATEMENT_GROUP_MISMATCH` |
| R-13 naturaleza contraria a su masa ⇒ `isContra = true` | Columna `isContra` (sembrada, 165 filas) + aviso en el editor al crear subcuentas |
| R-14 `pgcVariant` inmutable con asientos posteados | `validateVariantChange` en `settings/organization` → `VARIANT_LOCKED` |
| R-15 `epigraph` del catálogo cerrado de la variante | `epigraphCatalog` + `EPIGRAPH_UNKNOWN` |
| R-16 coherencia `analyticType` ↔ bloque de PyG del `epigraph` | **Aviso**, no bloqueo: `checkAnalyticCoherence(plan)` → lista de divergencias, mostrada en el editor y expuesta a la pestaña Auditoría en E7. Test parametrizado sobre las 906 filas del seed |
| R-17 cambiar `analyticType` con `AllocationRun` vigente ⇒ recalcular | Aviso preparado; el `AllocationRun` no existe hasta E5 (la función recibe `activeAllocationRuns: number`, hoy 0) |
| R-18 `cashflowCategory` solo en 57x y contrapartidas | Aviso en `validateAccountUpdate` |
| R-19 renombrar siempre permitido, incluso en cuentas de sistema | `validateAccountUpdate` (única mutación sin restricción de cuenta) |
| R-20 4720/4730/4760/4770 solo como subcuentas | §2.5; `createSoftwareAccounts` las crea bajo 472/473/476/477 |
| R-21 cambiar `code`: prohibido con líneas; sin líneas, arrastra hijos en cascada | **En E2 el `code` es inmutable** (recodificar = crear + desactivar). La cascada se implementa en E3, cuando `JournalLine.accountCode` exista y haya algo que arrastrar — ver §10, descarte T-5 |
| R-22 editar el plan requiere ≥ EDITOR | **Descartado**: en este proyecto el plan de cuentas es ADMIN. Ver §10, descarte T-1 |

## 4. Capa de aplicación

### 4.1 `models/` (IO, siempre `tenantDb` / `tenantTransaction`)

| Fichero | Funciones |
|---|---|
| `models/accounts.ts` | `getPlan(db)` → `Plan` (una consulta, cacheada por request con `react.cache`) · `getAccountUsage(db, code)` → `AccountUsage` (en E2 `movementCount: 0` **hardcodeado con un TODO(E3) explícito y un test que lo fija**) · `createAccount` · `updateAccount` · `setAccountActive` · `deleteAccount` · `importNpgc(db, variant, rows, actor, now, opts)` · `importCustomPlan(db, rows, mapping, actor, now)` · `checkAnalyticCoherence(plan)` (R-16, aviso) |
| `models/account-map.ts` | `getAccountMap(db)` · `setAccountMapEntry(db, key, code, actor, reason)` (marca la cuenta destino `isSystem: true` y desmarca la anterior si ya no la usa nadie) |
| `models/taxes.ts` | `listTaxRates(db, { kind?, refDate? })` · `createTaxRate` · `updateTaxRate` · `closeTaxRate(db, id, validTo)` (vigencia, no borrado) |
| `models/audit-log.ts` | `writeAuditLog(tx, { entity, entityId, action, before, after, reason, userId })` — **recibe el `tx` de `tenantTransaction`**, nunca abre transacción propia: el log y la mutación viven o mueren juntos. `listAuditLog(db, filtro)` para E7. |

**Toda mutación de configuración** de E2 sigue exactamente este patrón:

```ts
await tenantTransaction(org.id, user.id, async (tx) => {
  const before = await tx.ledgerAccount.findUnique({ where: { organizationId_code: { organizationId: org.id, code } } })
  const after  = await tx.ledgerAccount.update({ where: { … }, data: patch })
  await writeAuditLog(tx, { entity: "LedgerAccount", entityId: after.id, action: "update", before, after, reason, userId: user.id })
  return after
})
```

### 4.2 Server actions

Todas empiezan por `withOrg(Role.ADMIN, …)` — la matriz de `supabase-multitenant` sitúa *plan de cuentas, impuestos y mapeos de sistema* en ADMIN, sin excepción. `EDITOR` y `VIEWER` **leen** (los RSC usan `requireOrg()` a secas) y no ven ningún botón de mutación.

| Fichero | Action | Rol | Schema zod (`forms/accounts.ts`, `forms/taxes.ts`) |
|---|---|---|---|
| `app/(app)/settings/accounts/actions.ts` | `createAccountAction` | ADMIN | `{ code, name, parentCodeHint?, statement?, epigraph?, analyticType?, cashflowCategory? }` |
| | `renameAccountAction` | ADMIN | `{ code, name }` |
| | `updateAccountClassificationAction` | ADMIN | `{ code, epigraph?, analyticType?, cashflowCategory?, reason? }` — **`statement` NO es editable** en cuentas oficiales de nivel ≤ 3 (R-10a) y en el resto se deriva del padre; `reason` obligatorio si cambia `epigraph` de una cuenta `origin = SEED` (R-10b) |
| | `setAccountActiveAction` | ADMIN | `{ code, isActive, reason }` — motivo **obligatorio** al desactivar |
| | `deleteAccountAction` | ADMIN | `{ code, reason }` |
| | `importPlanCsvAction` | ADMIN | `{ file, mapping, dryRun }` — `dryRun: true` devuelve el `PlanDiff` para previsualizar; nada se escribe |
| | `reseedPlanAction` | ADMIN | `{ variant, reason }` — re-lanza `importNpgc` (idempotente, solo crea las que faltan) |
| `app/(app)/settings/accounts/map/actions.ts` | `setAccountMapEntryAction` | ADMIN | `{ key, accountCode, reason }` |
| | `createSoftwareAccountsAction` | ADMIN | `{ keys: ("4720"|"4730"|"4760"|"4770")[], reason }` — §2.5, bajo demanda |
| `app/(app)/settings/taxes/actions.ts` | `createTaxRateAction` / `updateTaxRateAction` / `closeTaxRateAction` | ADMIN | `{ code, name, kind, rateBps, appliesTo, accountCode, counterAccountCode?, linkedTaxRateId?, validFrom, validTo? }` |
| | `updateTaxPolicyAction` | ADMIN | `{ prorrataPermille?, taxRoundingMode, redondeoToleranciaCents }` — parámetros de organización (D2-8) |

`rateBps` se captura en la UI como texto `"21"`, `"5,2"` o `"1,75"` y se convierte con un `z.preprocess` que reutiliza el parser entero de `lib/money.ts` (dos decimales → ×100, sin `Float` en ningún paso) → puntos básicos. Nunca `parseFloat` suelto. `validateVariantChange` se añade a `updateOrganizationAction` (R-14).

### 4.3 Alta de organización

`createOrganizationDefaults(db)` gana, al final y dentro de la MISMA `tenantTransaction` que ya usa el alta:

```ts
const rows = await loadNpgcSeed()          // IO: fuera de lib/accounts (lee seeds/npgc.csv, cacheado en módulo)
await importNpgc(db, org.pgcVariant, rows, { userId: null }, now,
                 { useSubaccounts: true, createSoftwareAccounts: false })   // idempotente (§2.4)
await seedAccountMap(db, now)              // defaultAccountMap(plan, { useSubaccounts })
await seedTaxRatesForOrg(db, now)          // seedTaxRates(plan, VIGENCIA_IVA_2025)
```

Idempotencia: `planDiff(existing, incoming, "seed")` no crea lo que ya está y no toca lo que el usuario editó (`origin !== SEED`). Un `AuditLog` `{entity:"Organization", action:"seed", after:{variant, seedSha256, created, skipped}}` deja constancia. El sha256 del CSV se guarda además en `Setting("npgc.seed.sha256")` para detectar en E7 que una organización se sembró con un seed distinto del actual.

### 4.4 CLI `seeds/import_npgc.ts`

```
npx tsx seeds/import_npgc.ts --org <uuid> --variant PYMES [--dry-run] [--reason "..."]
                             [--no-subaccounts] [--software-accounts]
npx tsx seeds/import_npgc.ts --all --dry-run      # backfill de organizaciones pre-E2
```
Usa `withTenantGucs(orgId, undefined, …)` (no hay usuario de sesión) → `AuditLog.userId = null`, `action: "seed"`. `--dry-run` imprime el `PlanDiff` y sale con código 0 sin escribir. Sin `--org` ni `--all`, sale con código 2 y el uso.

---

## 5. Invariantes

E2 no introduce cifras, así que I1–I6 no aplican. Introduce la **base** de I7, I9 y I10 y añade seis invariantes propios de configuración (tres de ellos nacen de la validación contable). Tests en `lib/ledger/invariants.test.ts` (los que el auditor ya conoce) y en `lib/accounts/*.test.ts`.

| Invariante | Enunciado en E2 | Dónde se garantiza | Test propuesto |
|---|---|---|---|
| **I7** (unicidad) | `(organizationId, code)` único en `accounts`; `(organizationId, key)` único en `organization_account_maps`; `(organizationId, code, validFrom)` único en `tax_rates` | `@@unique` + BD | `invariants.test.ts › I7 · dos cuentas con el mismo código en la misma organización → violación; el mismo código en dos organizaciones → OK` (fixture `plan-duplicado.json`) |
| **I9** (cuenta válida) | Preparado: `assertLineAccounts(lines, plan)` devuelve las líneas cuya cuenta no existe, está inactiva o no es postable. En E2 se testea con líneas **sintéticas** (no hay diario) | Función pura `lib/accounts/assert-line-accounts.ts` + FK compuesta `(organization_id, account_code)` que E3 creará contra `accounts(organization_id, code)` — el `@@unique` que la hace posible se crea AQUÍ | `invariants.test.ts › I9 · línea contra cuenta inexistente / inactiva / no postable → violación` (fixture `plan-min.json` + 4 líneas) |
| **I10** (tenant) | Ninguna cuenta, mapeo o tipo apunta fuera de su organización | FK compuestas de §2.6 + `tenantDb` | `tests/integration/e2-tenant-leak.test.ts`: intentar mapear `AccountKey.CLIENTES` a una cuenta de otra organización → error de FK, no fila creada |
| **I-E2-1** (jerarquía) | Todo `parentCode` no nulo existe en el plan de la organización y es prefijo estricto del `code` | Pura (`validateNewAccount`) + FK compuesta + `CHECK` | `accounts/hierarchy.test.ts`: `resolveParentCode("7050001", plan) === "705"`; padre inexistente → `PARENT_NOT_FOUND` |
| **I-E2-2** (hoja postable) | `isPostable = true ⇔ no tiene hijos`. Al crear un hijo, el padre pasa a `isPostable = false` en la misma transacción | `applyNewAccount` + `models/accounts.createAccount` | `accounts/postable.test.ts` + `tests/integration/e2-accounts.test.ts` |
| **I-E2-3** (vigencia) | Para un mismo `(organizationId, code)`, dos `TaxRate` no solapan `[validFrom, validTo]` | `validateTaxRate` + `EXCLUDE USING gist (organization_id WITH =, code WITH =, daterange(valid_from, valid_to, '[]') WITH &&)` (requiere `btree_gist`) | `accounts/tax-rates.test.ts`: solape exacto, solape parcial, contiguos sin solape (`validTo = X`, `validFrom = X+1día`) → OK |
| **I-plan-1** (mapa resoluble) | Las **43 claves del bloque obligatorio** resuelven a una cuenta existente, activa, **postable** y de la organización. Las 14 restantes, si están mapeadas, cumplen lo mismo | `validateAccountMap` + FK compuesta; revalidación al final de `importNpgc` (si falla, rollback) | `accounts/account-map.test.ts` sobre el plan sembrado real de **ambas variantes** y con `useSubaccounts` en `true` y `false` |
| **I-E2-5** (contra-cuentas) | Toda cuenta con `nature` contraria a la masa de su `statement` tiene `isContra = true` (R-13) | Columna sembrada + test sobre las 906 filas | `accounts/seed.test.ts › 165 contra-cuentas, ninguna sin marcar` |
| **I-E2-6** (coherencia analítica) | Para toda cuenta 6/7, el bloque de PyG de su `epigraph` (explotación / financiero / impuesto) es coherente con el `marginLevel` implícito en su `analyticType` (R-16) | `checkAnalyticCoherence` — **aviso**, no bloqueo | `accounts/analytic-coherence.test.ts` parametrizado sobre las 906 filas: 0 divergencias en el seed entregado. Es el test que impide que vuelva el defecto D-3 del experto |
| **I-E2-7** (variante) | Con `pgcVariant = PYMES` no existe en el plan ninguna cuenta con `pymes = 0`; 0 padres huérfanos; 0 filas sin `epigraphPymes` teniendo `statement` | `filterByVariant` + revalidación de `importNpgc` | `accounts/variant.test.ts`: 794 creadas en PYMES, 906 en GENERAL, y `663` postable en PYMES (su hijo `6632` está filtrado) |

---

## 6. UI

Rutas nuevas bajo `settings/` (`components/settings/side-nav.tsx` gana dos entradas: **Plan de cuentas**, **Impuestos**).

| Ruta | Contenido | VIEWER / EDITOR | ADMIN |
|---|---|---|---|
| `/settings/accounts` | Árbol del plan | Solo lectura: sin botones, sin edición inline, sin menú contextual | Todo |
| `/settings/accounts/map` | Claves de sistema → cuenta, en dos bloques: **43 obligatorias** (con aviso si alguna no resuelve) y 14 *pendientes de su épica*, plegadas | Lectura | `Select` de cuenta con buscador + motivo |
| `/settings/accounts/import` | Import CSV en 3 pasos | 403 (no aparece en el nav) | Sí |
| `/settings/taxes` | Tipos con vigencia (agrupados por `kind`, con la línea de tiempo de cada `code`) + panel de **política fiscal** (prorrata, método de redondeo, tolerancia) | Lectura | Alta / edición / cerrar vigencia / editar política |

**Componentes** (`components/settings/`, base shadcn ya presente en `crud.tsx`, `page-header.tsx`):

- `accounts-tree.tsx` (cliente) — árbol virtualizado (906 filas en GENERAL): filas de 32 px, código en JetBrains Mono, nombre editable inline (doble clic → `input`, Enter guarda, Esc cancela, optimistic con `useActionState`), chips de `statement` / `analyticType` / `cashflowCategory`, **marca `(−)` en las contra-cuentas y `(↔)` en las 7 bidireccionales** con tooltip que explica que restan / se reclasifican por signo, cuentas inactivas en gris con tachado suave, `isSystem` con candado. El epígrafe mostrado es el de la variante activa (`epigraphFor`), con el de la otra variante en el tooltip. Colapsable por nivel; el estado de expansión vive en `localStorage` por organización.
- `accounts-search.tsx` — un solo `input` que filtra por **código o nombre** (`buildAccountTree({ query })`, que ya devuelve ancestros). Sin debounce servidor: el plan completo llega en el RSC y el filtrado es cliente y puro.
- `account-row-actions.tsx` — menú: *Crear subcuenta* · *Renombrar* · *Editar clasificación* · *Desactivar* · *Eliminar*. **Desactivar y Eliminar abren `AlertDialog` con motivo obligatorio** (skill `ui-erp`: todo botón destructivo exige motivo y queda en `AuditLog`). *Eliminar* aparece deshabilitado con tooltip explicando por qué (`canDeleteAccount` corre también en el servidor al pintar).
- `new-account-dialog.tsx` — código pre-rellenado con el del padre + un dígito; muestra en vivo el padre resuelto y la clasificación heredada.
- `account-import-wizard.tsx` — (1) subir CSV → (2) mapear columnas (`Select` por columna detectada, con previsualización de 10 filas) → (3) `dryRun` que muestra `PlanDiff` (`N a crear`, `M a actualizar`, `K sin cambios`, errores por fila) y solo entonces habilita *Importar*.
- `account-map-form.tsx`, `tax-rates-table.tsx` (línea de tiempo de vigencia por `code`; el recargo muestra el IVA enlazado), `tax-rate-dialog.tsx` (`rateBps` con dos decimales, `appliesTo`, cuenta de venta y de compra), `tax-policy-form.tsx`.
- **Clasificación**: el `Select` de `statement` **no se renderiza** en cuentas oficiales de nivel ≤ 3 (R-10a) — en su lugar, un texto con enlace a *Crear subcuenta*, que es la vía correcta. El de `epigraph` es un combo del catálogo cerrado de la variante (R-15), nunca texto libre, y exige motivo. Las divergencias de R-16 se pintan como aviso ámbar `#F5A623` en la fila, no como error.

**Estados**: `loading.tsx` con skeleton de árbol (ya hay patrón en `settings/loading.tsx`); error de action → `ActionState.error` bajo el campo; conflicto de concurrencia (`updatedAt` distinto) → aviso "otro administrador cambió esta cuenta, recarga". Vacío imposible (siempre hay plan sembrado), pero si lo hubiera: CTA *Sembrar plan NPGC*.

Sin rojo/verde semáforo. Acento lima `#EAFF69` solo en foco y en el chip de cuenta de sistema.

---

## 7. Trazabilidad

E2 **es** la infraestructura de trazabilidad de configuración. Lo que se guarda:

| Evento | `entity` | `action` | `before` / `after` | `reason` |
|---|---|---|---|---|
| Alta de cuenta | `LedgerAccount` | `create` | `null` / fila completa | — |
| Renombrado | `LedgerAccount` | `update` | `{name}` / `{name}` | opcional |
| Cambio de clasificación | `LedgerAccount` | `update` | `{epigraph, analyticType, cashflowCategory}` × 2 | **obligatorio** si `origin = SEED` (R-10b). `statement` no aparece: es inmutable en cuentas oficiales |
| Desactivar / activar | `LedgerAccount` | `deactivate` / `activate` | `{isActive}` × 2 | **obligatorio** al desactivar |
| Borrado | `LedgerAccount` | `delete` | fila completa / `null` | **obligatorio** |
| Seed NPGC | `Organization` | `seed` | `null` / `{variant, seedSha256, created, skipped, useSubaccounts, createSoftwareAccounts}` | — |
| Import CSV | `Organization` | `import` | `null` / `{fileName, fileSha256, mapping, created, updated, errors}` | opcional |
| Remapeo de clave | `OrganizationAccountMap` | `remap` | `{key, accountCode}` × 2 | **obligatorio** |
| Tipo impositivo | `TaxRate` | `create`/`update`/`close` | fila × 2 | obligatorio en `close` |
| Política fiscal | `Organization` | `update` | `{prorrataPermille, taxRoundingMode, redondeoToleranciaCents}` × 2 | **obligatorio** (cambia cómo se calculan las cuotas de todo documento posterior) |
| Cuentas de software | `LedgerAccount` | `create` | `null` / filas 4720/4770… | **obligatorio** |

Provenance por fila: `LedgerAccount.origin` + `AuditLog` completo. Los `TODO(E2): auditLog(...)` ya sembrados en `settings/organization/actions.ts` y `settings/members/actions.ts` (6 puntos) **se cierran en T11**: E2 entrega el registro y quien lo dejó anotado lo consume.

`runs/registro.jsonl` recibe una entrada por sprint, como siempre.

---

## 8. Criterios de aceptación y plan de tareas

### 8.1 Criterios de aceptación (Given/When/Then)

1. **Seed en el alta.** *Given* un usuario sin organización, *when* crea una con `pgcVariant = PYMES`, *then* su plan tiene exactamente **794** cuentas (`pymes = 1`), 0 padres huérfanos, `663` postable (su hijo `6632` está filtrado), las **43 claves obligatorias** de `OrganizationAccountMap` resueltas a cuentas activas y postables, los tipos de sistema de §3.1 vigentes desde 2025-01-01, y un `AuditLog` `Organization/seed`. Con `GENERAL`, 906 cuentas.
2. **Idempotencia.** *Given* una organización ya sembrada cuyo ADMIN renombró la 705 y desactivó la 640, *when* se ejecuta `import_npgc.ts --org … --variant PYMES` otra vez, *then* `created: 0, updated: 0`, el nombre de la 705 y el estado de la 640 se conservan, y el `AuditLog` registra el intento.
3. **Subcuenta.** *Given* la cuenta `705` postable y sin movimientos, *when* un ADMIN crea `7050001 "Consultoría – Cliente X"`, *then* hereda `statement = PYG`, ambos epígrafes y `analyticType = INGRESO_DIRECTO` de `705`, con `parentCode = "705"`, `level = 7`, `isPostable = true`, y `705` pasa a `isPostable = false` en la misma transacción.
4. **Borrado.** *Given* una cuenta creada a mano, sin movimientos, sin hijos, no mapeada y sin tipos que la usen, *when* un ADMIN la borra con motivo, *then* desaparece y queda `AuditLog` con la fila completa en `before`. *Given* la `5720` (mapeada a `BANCO_DEFAULT`), *when* se intenta borrar, *then* falla con `IS_MAPPED` y no se escribe nada.
5. **Roles.** *Given* un `EDITOR`, *when* abre `/settings/accounts`, *then* ve el árbol completo y **ningún** control de mutación; *when* invoca `renameAccountAction` directamente, *then* `{ success: false, error: "Sin permiso" }` y no hay `AuditLog`.
6. **R-10a / R-10b.** *Given* la cuenta oficial `430` (nivel 3, `origin = SEED`), *when* un ADMIN intenta cambiar su `statement` a `PYG`, *then* la action falla con `STATEMENT_LOCKED` **y la UI no ofrecía siquiera el campo**; *when* cambia su `epigraph` a otro valor **del catálogo de la variante** con motivo, *then* se guarda y queda en `AuditLog`; *when* lo cambia a un texto libre, *then* `EPIGRAPH_UNKNOWN`.
7. **Import CSV.** *Given* un CSV de 40 cuentas con columnas `Cuenta;Descripción;Masa;Epígrafe`, *when* el ADMIN mapea columnas y ejecuta con `dryRun`, *then* ve `40 a crear, 0 a actualizar` sin escribir nada; *when* confirma, *then* las 40 existen con `origin = CSV_IMPORT`. Una fila con código `0705`, con padre inexistente o con epígrafe fuera del catálogo aparece como error con su nº de fila y **la importación entera se rechaza**.
8. **Vigencia de impuestos.** *Given* `IVA_21` vigente desde 2025-01-01, *when* se crea otro `IVA_21` desde 2026-06-01 sin cerrar el anterior, *then* `RATE_OVERLAP`; *when* primero se cierra con `validTo = 2026-05-31`, *then* ambos conviven y `selectTaxRate(rates, "IVA_21", 2024-03-01)` devuelve **null** (ningún tipo vigente en 2024: C-7) mientras que a 2026-07-01 devuelve el segundo.
9. **Recargo de tabaco (el caso que rompía el modelo).** *Given* el catálogo sembrado, *when* se lee `REQ_1_75`, *then* `rateBps === 175` y `linkedTaxRateId` apunta al `IVA` correspondiente; *when* se intenta crear un `RECARGO` sin `linkedTaxRateId`, *then* `RATE_LINK`.
10. **Coherencia analítica (I-E2-6).** *Given* el seed entregado, *when* corre `checkAnalyticCoherence` sobre las 906 filas, *then* **0 divergencias**; *when* un ADMIN pone `analyticType = FINANCIERO` a una cuenta de epígrafe 7 (explotación), *then* la mutación se guarda pero la fila queda marcada con aviso ámbar y aparece en la lista de divergencias.
11. **RLS.** *Given* una conexión como `app_runtime` con `app.current_org` = A, *when* `SELECT count(*) FROM accounts` de datos de B, *then* 0; *when* `UPDATE` o `DELETE` sobre `audit_logs`, *then* 0 filas afectadas.
12. **E2E (resto de E0).** *Given* la app arrancada con una organización sembrada, *when* Playwright hace login y navega a `/settings/accounts`, *then* ve `430 Clientes`, escribe `705` en la búsqueda y la lista se reduce a la rama de `705`, sin errores de consola. **El login es además la red del riesgo R2** (better-auth intacto).

### 8.2 Plan de tareas

Cambios de la ronda 2 marcados **(R2)**.

| ID | Tarea | Depende de | Nivel | Horas |
|---|---|---|---|---|
| **T1** | Esquema Prisma de §2.2 (4 modelos, **9 enums**, 3 columnas fiscales en `organizations`), `TENANT_MODELS` += 4, migración `20260905100000` + `constraints.sql` (FK compuestas incl. `counter_account_code` y `linked_tax_rate_id`, CHECKs, `btree_gist`, EXCLUDE de vigencia). **(R2)** better-auth NO se toca. Ampliar `.claude/hooks/guard.sh` y `vitest.config.ts` a `lib/accounts/` | — | **2** | 7 |
| **T2** | **(R2)** Verificar y blindar el seed regenerado por el experto: `parseNpgcCsv` de 13 columnas + `tests/fixtures/npgc-seed.test.ts` con las cifras acordadas (906 · 794 PYMES · 165 contra · 7 bidireccionales · 0 huérfanos · `EXTRAORDINARIO` sin uso) y `validate_analytic_coherence` portado a TS (I-E2-6). **El trabajo de datos ya está hecho: esta tarea es la red que impide que se pierda** | — | 1 | 4 |
| **T3** | `lib/accounts/`: `types.ts`, `codes.ts`, `tree.ts`, `epigraphs.ts` **(R2)**, `validate.ts` con **R-01…R-21** de §3.2 **(R2: R-10a/R-10b/R-11/R-12/R-15/R-16 nuevas)** + tests | — | 1 | 13 |
| **T4** | `lib/accounts/csv.ts`: `parseNpgcCsv`, `filterByVariant` (+ recálculo de `isPostable` y revalidación de huérfanos, **R2**), `parseCustomPlanCsv`, `planDiff` + tests con CSV feos | T3 | 1 | 8 |
| **T5** | `lib/accounts/account-map.ts` (`defaultAccountMap` con **57 claves / 43 obligatorias**, `useSubaccounts`) y `tax-rates.ts` (`validateTaxRate` con `rateBps`/`linkedTaxRateId`, `selectTaxRate`, `taxAccountFor`, `seedTaxRates` de §3.1) + tests **(R2: +5 h)** | T3 | 1 | 11 |
| **T6** | `models/accounts.ts`, `models/account-map.ts`, `models/taxes.ts`, `models/audit-log.ts` — todo por `tenantTransaction`; `getAccountUsage` con `movementCount: 0` + `TODO(E3)` y su test; `checkAnalyticCoherence` **(R2)** | T1, T3, T5 | 1 | 10 |
| **T7** | `importNpgc` con `opts` (`useSubaccounts`, `createSoftwareAccounts`) **(R2)** + enganche en `createOrganizationDefaults` + CLI + backfill + `Setting("npgc.seed.sha256")` | T2, T4, T6 | 1 | 8 |
| **T8** | Migración `20260905110000_e2_rls` (políticas de las 4 tablas, `audit_logs` append-only, GRANTs) + deuda anotada en `docs/ESTADO.md` | T1 | **2** | 5 |
| **T9** | `forms/accounts.ts` / `forms/taxes.ts` (zod, `rateBps` desde `"1,75"`) + las **13** server actions de §4.2 **(R2: +`createSoftwareAccountsAction`, +`updateTaxPolicyAction`, +`validateVariantChange` en la action de organización)** | T6 | 1 | 9 |
| **T10** | UI plan de cuentas: `/settings/accounts` + `accounts-tree` (marcas `(−)` y `(↔)`, epígrafe por variante), `accounts-search`, `account-row-actions`, `new-account-dialog`, `side-nav` **(R2: +1 h)** | T9 | 1 | 13 |
| **T11** | UI `/settings/accounts/map` (2 bloques), `/settings/taxes` (+ `tax-policy-form`, línea de tiempo de vigencia) **(R2)**, `/settings/accounts/import` + cerrar los 6 `TODO(E2): auditLog(...)` de E1 | T9, T10 | 1 | 12 |
| **T12** | Tests de integración: `e2-accounts.test.ts` (seed idempotente por variante, subcuenta, borrado bloqueado, R-10a/R-10b), `e2-tenant-leak.test.ts`, `tests/integration-rls/e2-app-runtime.test.ts` | T7, T8, T9 | 1 | 10 |
| **T13** | **Resto de E0**: `@playwright/test`, `playwright.config.ts`, `auth.setup.ts`, `login.spec.ts`, `accounts.spec.ts`, script `test:e2e`, job de CI | T10 | 1 | 8 |
| **T14** | Docs: **`docs/MODELO-DATOS.md` §Plan de cuentas e impuestos reescrita (R2)**, `.claude/skills/pgc-npgc/SKILL.md` (13 columnas del seed, catálogo de `TaxRate`, `LedgerAccount`), `docs/ESTADO.md`, ROADMAP E2 → CERRADA, `runs/registro.jsonl`; ADR-0008 a APROBADO | T12, T13 | 1 | 4 |

**Total: 122 h** (~15 jornadas; +15 h sobre la ronda 1, todas en el motor puro y la UI de impuestos).
**Camino crítico:** T1 → T6 → T9 → T10 → T11 → T12 → T14 (**65 h**). Rama de motor en paralelo desde el día 1: T3 → T4/T5 → T7 (**32 h**). T2 y T8 independientes; T13 solo necesita T10.
**Reparto:** dev-backend (T1, T6, T7, T8, T9) · motor (T2, T3, T4, T5) · dev-frontend (T10, T11) · qa (T12, T13).

## 9. Riesgos, dudas y alternativas descartadas

### 9.1 Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | **906 filas por organización** en GENERAL (**794** en PYMES, que es el default). Mil organizaciones = ~800 k filas en `accounts` y un árbol pesado en el navegador. | PYMES por defecto; virtualización del árbol; el RSC envía solo `code/name/level/parentCode/flags` (no `epigraph` completo) salvo en la fila expandida. Medir en T10 con 906 filas antes de dar por buena la UI. |
| R2 | **Colisión de nombres con better-auth.** Verificado en `lib/auth.ts:28`: `prismaAdapter` no lleva mapeo de modelos y los resuelve por nombre, así que renombrar `Account` rompería el login **en runtime, compilando igual**. | **Cerrado en ronda 2**: la cuenta contable se llama `LedgerAccount` y better-auth no se toca (§2.2). Riesgo residual: el nombre TypeScript diverge de MODELO-DATOS — resuelto documentándolo (T14). El smoke de login de T13 sigue siendo la red. |
| R3 | **Cambiar `statement`/`epigraph` de una cuenta oficial** descuadra el balance en E6 sin que nadie se entere. | **Cerrado por C-4**: `statement` de cuenta oficial de nivel ≤ 3 **prohibido a todos los roles** (R-10a; la vía correcta es crear una subcuenta) y `epigraph` solo ADMIN + motivo + `AuditLog` y contra catálogo cerrado (R-10b/R-15), bloqueado si hay líneas en ejercicio `CLOSED`. En E7, check de divergencias respecto al seed. |
| R4 | **Import CSV** de un plan ajeno con códigos no numéricos, jerarquía implícita o epígrafes libres → plan inconsistente. | `parseCustomPlanCsv` rechaza todo o nada, con errores por fila; `dryRun` obligatorio en la UI; los epígrafes no reconocidos se importan como texto libre pero se marcan para revisión. |
| R5 | **Deuda RLS heredada** (escape `OR app.current_org() IS NULL`) se extiende a 4 tablas más. | Consciente y consistente con ADR-0007; anotada en `docs/ESTADO.md` y retirada en la misma migración de E3. `audit_logs` **no** hereda la deuda en UPDATE/DELETE (siempre `false`). |
| R7 | **Deriva entre el seed y los planes ya sembrados**: el experto corrige `build_npgc.py` y las organizaciones creadas antes conservan la clasificación antigua. | `Setting("npgc.seed.sha256")` por organización + check en E7 que lista las que se sembraron con otro seed. `reseedPlanAction` solo CREA lo que falta (no pisa ediciones), así que la reclasificación de una cuenta ya sembrada es una decisión explícita del ADMIN, con motivo y `AuditLog`. |
| R6 | `getAccountUsage.movementCount = 0` **hardcodeado** sobrevive a E3 y se permite borrar una cuenta con asientos. | Test que fija el contrato hoy + entrada explícita en el plan de E3 ("cablear `movementCount` desde `journal_lines`") + `TODO(E3)` en el código, que el guard de CI lista. |

### 9.2 Dudas del arquitecto — **todas resueltas en ronda 2**

`docs/design/E2-validacion-contable.md` §7 responde C-1…C-7. Resumen de lo que quedó decidido y dónde vive:

| Duda | Respuesta del experto | Dónde se aplica |
|---|---|---|
| C-1 subconjunto y epígrafe PYMES | Dos columnas (`pymes`, `epigrafe_pymes`); reglas P-01…P-13 en `build_npgc.py`; **794** cuentas PYMES. La regla provisional del arquitecto sobrevaloraba la exclusión (15/16/17 de vinculadas **sí** existen en PYMES) | §2.4, `LedgerAccount.epigraphPymes`, T2 desbloqueada |
| C-2 IVA una fila o dos; recargo | **Una fila** por tipo + `appliesTo` + dos cuentas; recargo **fila propia** con `linkedTaxRateId`; recargo soportado por el minorista = mayor coste, sin cuenta. **`ratePermille` no vale**: 1,75 % | D2-4, D2-5, §3.1, `taxAccountFor` |
| C-3 IRPF emitidas/recibidas; alquileres | Mismo `code`, cuentas por dirección (4751 / 473); alquileres **sí** separados vía subcuentas `47510/47511/47512` con `useSubaccounts` | §2.4, §3.1, 3 claves nuevas |
| C-4 `statement`/`epígrafe` de cuenta oficial | `statement` **prohibido a todos** (crear subcuenta es la vía); `epígrafe` ADMIN + motivo + `AuditLog`, prohibido con líneas en ejercicio `CLOSED` | R-10a / R-10b en §3.2, criterio de aceptación 6 |
| C-5 tipos analíticos 71/75/64 | 71 correcto; 75 correcto como default pero **configurable**; 64 se queda en MC2 y **el reparto lo decide la línea, no la cuenta** | Seed regenerado; el override por línea es de E4 |
| C-6 4720/4770 | **No por defecto**; bajo demanda y automáticas en dos supuestos (multi-tipo, ISP/intracomunitarias), siempre como subcuentas | §2.5, `createSoftwareAccountsAction` |
| C-7 histórico de tipos | **No** sembrar derogados; sí **vigencia explícita** de los actuales (`validFrom = 2025-01-01`) para que un asiento de 2024 no coja el tipo de 2026 | §3.1, criterio de aceptación 8 |

**Nueva duda abierta (para cuando llegue su épica, no bloquea E2):** el experto propone `COMPRAS_DEFAULT → 607` para empresas de servicios (o renombrar la clave a `APROVISIONAMIENTO_DEFAULT`). En E2 se conserva `COMPRAS_DEFAULT → 600` (nombre canónico de MODELO-DATOS) y se añade `SUBCONTRATACION_DEFAULT → 607`, que es la que usarán las plantillas de servicios en E3; **confirmar en E3 cuál de las dos usa por defecto la factura recibida.**

### 9.3 Alternativas descartadas

- **Plan de cuentas global compartido + tabla de overrides por organización.** Ahorraría 906 filas por tenant, pero rompe el principio de que toda tabla de negocio lleva `organizationId` y complica cada consulta del motor con un `COALESCE(override, global)`; además el borrado y el renombrado dejarían de ser operaciones locales. Descartada: la simplicidad del motor vale más que el espacio en disco.
- **`code` como columna numérica (`Int`) para ordenar barato.** La jerarquía es por prefijo de texto (`705` es padre de `7050001`) y `Int` no la expresa; además impediría códigos alfanuméricos si algún día un plan importado los trae. Descartada.
- **Renombrar el modelo de auth a `AuthAccount` (o su tabla a `auth_accounts`) para que la cuenta contable se llamara `Account`.** Comprobado en `lib/auth.ts:28`: `prismaAdapter` no lleva ningún mapeo de nombres, los resuelve por convención, y el error aparecería en runtime en el login, no al compilar. Se prefiere `LedgerAccount`: el nombre físico `accounts` —el único que ven RLS, triggers e informes— se conserva igual. §2.2.
- **Guardar un solo epígrafe y traducirlo al vuelo según la variante.** Obligaría a mantener en código la tabla de renumeración de §2.2/§2.3 del experto (PyG 13→12…20→19 y todo el activo/pasivo corriente del balance) y a reimportar el plan al cambiar de variante. Con dos columnas sembradas, `epigraphFor` es una línea. Descartada.
- **Duplicar `TaxRate` por dirección (`IVA21_REP` / `IVA21_SOP`).** Era la propuesta de la ronda 1; el experto la descarta (C-2): dos filas que sincronizar ante cada cambio normativo, cuadre de la 303 roto —agrega por tipo, no por dirección— y la inversión del sujeto pasivo necesita las dos cuentas **en el mismo asiento**.

---

## 10. Validación contable: **CONFORME tras ronda 2**

`docs/design/E2-validacion-contable.md` cerró con veredicto **OBSERVACIONES**: 3 defectos de datos (D-1, D-2, D-3) y 5 carencias de esquema (E-1…E-6, con E-6 sobre el contrato de variante). Estado tras esta ronda:

| Punto | Estado | Dónde |
|---|---|---|
| D-1 5530–5533 cruzados · D-2 190/192/194/1034/1044 a PN · D-3 coherencia `epigrafe`↔`tipo_analitico` | **Cerrados por el experto** en `build_npgc.py` y verificados aquí sobre el CSV entregado (906 · 794 · 165 · 7 · 0 huérfanos) | T2 los blinda con test de regresión + `checkAnalyticCoherence` (I-E2-6) |
| E-1 `ratePermille` no representa 1,75 % | **Incorporado**: `rateBps Int` | D2-5, §3.1, criterio 9 |
| E-2 contra-cuentas | **Incorporado**: `isContra` (165 sembradas) + R-13 | D2-6, I-E2-5, UI `(−)` |
| E-3 cuentas bidireccionales | **Incorporado**: `bidirectional` (7 sembradas). La reclasificación por signo del balance es de **E6**; aquí se guarda la marca y la ruta deudora | D2-6, UI `(↔)`; descarte T-4 para el par `statementIfDebit/Credit` |
| E-4 `AccountKey` insuficiente | **Incorporado**: 16 → **57** claves; 43 obligatorias (E3/E8), 14 declaradas sin default | D2-7, §2.2, I-plan-1 |
| E-5 prorrata y redondeo | **Incorporado**: `prorrataPermille`, `taxRoundingMode`, `redondeoToleranciaCents` en `Organization` + `REDONDEO_GASTO`/`REDONDEO_INGRESO`. Las reglas R-IVA-1…R-IVA-8 las **ejecuta el motor en E3**; E2 entrega los parámetros y las cuentas | D2-8, §4.2 `updateTaxPolicyAction` |
| E-6 contrato de `importNPGC` | **Incorporado**: firma con `opts`, filtrado por columna, recálculo de `isPostable`, revalidación, R-14 | §2.4 |
| R-01…R-22 del editor | **Incorporadas 21 de 22**; R-22 descartada (ver abajo) | §3.2 |
| C-1…C-7 | **Todas aplicadas** | §9.2 |

### 10.1 Descartes y divergencias conscientes

| # | Punto del experto | Decisión | Motivo |
|---|---|---|---|
| **T-1** | **R-22**: editar el plan requiere ≥ `EDITOR`; solo `statement`/`isSystem`/variante exigen ADMIN | **Descartado**: en este proyecto **toda** mutación del plan, impuestos y mapeos es ADMIN | La matriz de roles del proyecto (`.claude/skills/supabase-multitenant`, fila "Plan de cuentas, CECOs, LN, reglas de imputación, impuestos, mapeos de sistema") y `CLAUDE.md` sitúan el plan en ADMIN. Cambiar la matriz es Nivel 2 y afecta a E4–E8, no solo a E2. Si el experto insiste, se abre ADR propio |
| **T-2** | Nuevo `AnalyticType.RESULTADO_ENAJENACION` para 670–672/770–772 | **Descartado**: se usa `AMORTIZACION_DETERIORO` (nivel EBIT), la segunda opción que el propio experto da | Añadir un valor al enum `AnalyticType` toca `MarginLevelConfig` y la matriz analítica de E4/E5 sin ganar precisión: ambos tipos caen en el mismo nivel de margen. El seed regenerado ya lo resuelve así |
| **T-3** | Sembrar `IRPF_TRABAJO_VAR` con marca `computed` | **Aplazado a E4** | Necesita un campo `computed` en `TaxRate` que solo consume la nómina (E4), y el tipo lo fija el proveedor de nóminas, no el ERP. Sembrarlo ahora es una fila que nadie puede usar |
| **T-4** | Columnas `statementIfDebit` / `statementIfCredit` para las bidireccionales | **Reducido a `bidirectional Boolean`**; el par de rutas se resuelve en **E6** con la tabla de reclasificación del generador de balance | En E2 no hay ningún consumidor: sin balance, dos columnas más solo pueden desincronizarse. La marca es lo que hace falta para no perder la información |
| **T-5** | **R-21**: cambiar `code` arrastra a los hijos en cascada | **En E2 el `code` es inmutable** (recodificar = crear + desactivar); la cascada se implementa en E3 | `JournalLine.accountCode` no existe todavía: no hay nada que arrastrar, y una cascada sin su caso de uso es código muerto que hay que reescribir en E3 |
| **T-6** | **R-03**: el padre es `code[:-1]` y debe existir | **Divergencia**: `resolveParentCode` usa el *prefijo existente más largo* | Con `code[:-1]` estricto, crear `7050001` obligaría a inventar `70500` y `705000` vacías. El agregado por prefijo sigue siendo exacto y el árbol, navegable. En el seed no hay diferencia: todos los padres son `code[:-1]` |
| **T-7** | `COMPRAS_DEFAULT → 607` o renombrar la clave | **Aplazado a E3**: se conserva `COMPRAS_DEFAULT → 600` y se añade `SUBCONTRATACION_DEFAULT → 607` | `COMPRAS_DEFAULT` es el nombre canónico de `docs/MODELO-DATOS.md`; qué clave usa por defecto la factura recibida de una empresa de servicios se decide con las plantillas de asiento, en E3 |

Ninguno de los siete descartes toca una corrección contable: son decisiones de alcance (qué épica lo implementa) o de matriz de roles del proyecto. **Con eso, el diseño se declara CONFORME a la validación contable de ronda 2.**
