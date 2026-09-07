# E7 — Auditoría (diseño)

> Entregable del agente `arquitecto`. **Ronda 2, cerrada.** Validación contable
> `docs/design/E7-validacion-auditoria.md`: **CONFORME CON OBSERVACIONES** (10
> bloqueantes, 9 importantes, 6 de mejora). Las **25**, más los dos retoques de
> cierre **m1** y **m2**, están incorporadas.
> `docs/adr/0015-auditoria-bigint-conciliacion-retencion.md` (D1–D6) está
> **APROBADO** por Pablo el 2026-09-07 (permiso delegado de 2026-09-04): T3, T4,
> T6, T14 y T15 quedan desbloqueadas y la épica puede pasar a `/sprint E7`.
>
> Documentos que mandan sobre este: `docs/spec/SPEC-FIABILIDAD.md` (C4 validación
> por capas, C5 niveles de confianza, C6 memoria, C7 versionado), `CLAUDE.md`
> §«Estándar de calidad», `.claude/skills/fiabilidad/SKILL.md` (I1–I10 e I-E8-*,
> definidos UNA sola vez y aquí sólo agregados) y ADR-0003/0005/0009/0011/0012/0014.

---

## 0. Ronda 2 — qué cambió y dónde

| Obs. | Tipo | Qué cambia | Sección |
|---|---|---|---|
| **O-1** | B · esquema | I-E7-1 reformulada como **`E − B = Ue − Ub`**; `reconciledFromDate` + `reconciledOpeningBalanceCents` en `BankAccount` (**anclaje**); sin anclaje, INFO | §2.2, §3.5, §12·c9 |
| **O-2** | B | `B` agrega la 57x de asientos con `kind ∉ {CLOSING}` (**`OPENING` sí**), reutilizando la foto `PRE_REGULARIZACION` de E6 | §3.5 |
| **O-3** | B · esquema · **D6** | `BankMatchGroup` (SIMPLE/N_A_1/1_A_N/N_A_N) + `groupId`; desconciliar por grupo; **I-E7-11** | §2.2, §2.4, §3.5, §4.3 |
| **O-4** | B | `IGNORED` con **vocabulario cerrado** y dato asociado; movimiento sin asiento ⇒ **propuesta de asiento** por `previewFromProposal`/`postFromProposal`; seis `AccountKey`; matiz IVA art. 20.Uno.18º | §2.2, §4.4, §6, T23 |
| **O-5** | B · esquema · **D6** | `currency` y `originalAmountCents` en la línea de extracto; cuadre **en la divisa de la cuenta**; **I-E7-12** (768/668) | §2.2, §3.5 |
| **O-6** | B | El corte es por **`operationDate`**; `valueDate` prohibida en agregaciones de cuadre y sólo `+500` en la sugerencia; índice y mapeo N43 explícitos | §2.2, §3.4, §3.5, §4.2 |
| **O-7** | I · esquema | CHECK de cuenta ∈ {572,573,574,575}; `@@unique([organizationId, accountCode])`; una cuenta corriente = una subcuenta | §2.2, §2.4 |
| **O-8** | I | Pendientes **tipados y envejecidos**; motivo de sello `PARTIDA_EN_TRANSITO_ANTIGUA`; 4311/4312 no conciliables | §3.5, §6 |
| **O-9** | B · esquema · **D6** | **I-E7-2 revisado**: `bankLine.amount = debe − haber`, tolerancia 0, verificado también en `matchAction`. I-E7-4 subsumido | §3.5, §4.3 |
| **O-10** | B | La tolerancia de fechas **sale de los invariantes**; `dateGapDays` sellado en el punteo; métrica `DESFASE_FECHA_ALTO` | §2.2, §3.5 |
| **O-11** | I | **I-E7-6a** (cuadre interno) e **I-E7-6b** (cobertura de la cadena, hueco = FAIL); cotejo con el registro 33 | §3.5, §4.2 |
| **O-12** | I | **I-E7-13**: ignorados acotados y Σ ignorado como línea visible del cuadre | §3.5, §6 |
| **O-13** | M | Conciliar sobre ejercicio `CLOSED` **permitido**; `ledgerHash` idéntico antes y después; la propuesta de asiento sí queda sujeta a I8 | §4.3, §12·c14 |
| **O-14** | I | Tabla de signos del registro 22 (`1`=cargo, `2`=abono), ventana de siglo, desbordamiento a `bigint` | §4.2 |
| **O-15** | I | `reference1`, `reference2`, `conceptCommon`, `conceptOwn`; `reference1` como clave de agrupación N-a-1 | §2.2, §3.4, §4.2 |
| **O-16** | B | El badge se concede **por composición**: todas las cuentas que componen la cifra. La **caja queda excluida** | §3.6, ADR D2 |
| **O-17** | B | `explicado` con criterio verificable; el badge exige I-E7-6b; **se deriva en lectura, nunca se persiste** | §3.6, §12·c19 |
| **O-18** | I | **I-E7-14…17**: continuidad entre ejercicios, saldos contrarios a naturaleza, cuentas puente, sumas y saldos por mes; vista «Cuadres de cierre» | §3.5, §6 |
| **O-19** | I | El diff añade **Δ de cuatro cifras** (activo, PN+pasivo, resultado, tesorería) | §3.3, §6 |
| **O-20** | I | **`configHash`** en `InvariantRun`, en la clave de caché y en el diff (`cause: CONFIGURACION`) | §2.2, §3.3, §8 |
| **O-21** | M | `checkFamily` como **enum**; forzar revisión sobre ejercicio `CLOSED` explícitamente permitido | §2.2, §2.7 |
| **O-22** | M | Extractos y su `File` **no se purgan** (art. 30 CCom, 6 años; art. 26.5 LIS, 10) | ADR D3, §2.5 |
| **O-23** | M | Criterio 17 con las **tres aserciones del borde JS** | §12·c24 |
| §9.3 | — | Al aceptar una sugerencia se **recomputa en servidor**; error legible si otro usuario la concilió antes | §4.3 |
| **m1** | cierre | Rótulo corregido: **seis `AccountKey` en juego, tres nuevas** (626, 668 y 768 ya existían desde E2/E8) | §2.2 |
| **m2** | cierre | CHECK **`amount_cents IS NOT NULL`**, nunca `<> 0`: el apunte de 0,00 € del banco se importa y nace `IGNORED` con `IMPORTE_CERO`; rechazarlo partiría el `lineNo` (I-E7-5) y el cotejo con el registro 33 (I-E7-6a) | §2.2, §2.3, §3.5, §12·c16 |

Lo que el experto declaró **correcto y no se toca** (§9 de la validación): sin LLM
en ninguna parte, empate ⇒ ninguna sugerencia, nunca se puntea solo,
`SIN_EVALUAR` como estado propio con `coverage` obligatorio, `DataQualityIssue`
sin tabla, `linesHash` sin rellenar por script, conciliar contra la `JournalLine`
de 57x y no contra el asiento, y la prueba de detección que no escribe.

---

## 1. Objetivo y alcance

E7 es **la pantalla donde se mira si el ERP está diciendo la verdad**, y el sitio
donde una cifra pasa de `✓ comprobado automáticamente` a `✓ validado contra
fuente` (C5). Cierra el requisito R8 de `SPEC-FUNCIONAL.md` §3.6 y el criterio de
aceptación C4 de la spec de fiabilidad («ciclo con un error inyectado a propósito
→ algún check lo captura»), y **paga la deuda que E5, E6 y E8 le dejaron
fechada** en `docs/ESTADO.md`.

Cinco entregas:

1. **`InvariantRun` persistente**: hoy los invariantes se recalculan en cada
   render y su resultado sólo vive dentro de un `ReportRun`. E7 los convierte en
   una foto sellada, comparable y con historial (P3/P7).
2. **Pestaña `/audit`**: semáforo por familia, evidencia con drill-down a los
   registros de origen en ≤ 3 clics, **vista «Cuadres de cierre»** en lenguaje
   contable (O-18), calidad de datos (los `dataQualityWarnings` que E8 ya produce
   y nadie pinta), `AuditLog` filtrable, historial con diff **de estados y de
   cifras**, forzar revisión y ejecutar barridos.
3. **Conciliación bancaria** (`/audit/bank`): `BankAccount`, `BankStatement`,
   `BankStatementLine`, **`BankMatchGroup`** con conciliación N-a-M, importación
   CSV/Norma 43, sugerencias **deterministas**, punteo humano contra los apuntes
   de 57x y **propuesta de asiento** para el movimiento que no está en libros.
   Es la fuente del badge P6 `✓ validado contra fuente`.
4. **Deuda heredada**: runs de liquidación con `lines_hash` NULL, `journal_lines`
   a `bigint`, detección de `allocation_lines` alteradas bajo un `ReportRun`
   sellado, barrido **completo** del almacén para I-E8-2, split N-a-1 en la
   interfaz, unificación de `CASHFLOW_DIRECTO`/`CASHFLOW_INDIRECTO`, RLS en
   `users`, y el test de rendimiento **por cargador** que E6 dejó pedido.
5. **`lib/audit/`**: motor puro de agregación, semáforos, diff, cuadre de
   conciliación e **I-E7-1…17**.

### Qué NO incluye

- **No inventa invariantes de contabilidad ni de analítica ya existentes.**
  I1–I10, I-E3-*, I-E4-*, I-E5-*, I-E6-* e I-E8-* siguen definidos donde están;
  E7 los **agrega, sella, historifica y pinta**. Los I-E7-* son de conciliación,
  de integridad del propio barrido y los **cuatro cuadres de cierre** que el
  experto echó en falta y que **no existían en ninguna parte** (O-18).
- **No materializa ninguna cifra de informe.** `DataQualityIssue` no existe como
  tabla (§2.6): es una vista derivada. ADR-0003. El badge P6 tampoco se persiste
  (O-17).
- **No usa el LLM para nada.** Ni para sugerir un emparejamiento, ni para
  redactar una evidencia, ni para clasificar un movimiento (P1, ADR-0005).
- **No hace punteo automático sin persona**, ni contabiliza una comisión sola: la
  propuesta de asiento va por el mismo camino humano que el documental (O-4).
- **No deduce cuentas del texto del movimiento.** Eso es auto-punteo por patrón:
  **E12** y con ADR.
- **No automatiza la purga.** E7 define la política de retención y entrega
  `scripts/prune-runs.ts`; el cron y el archivado en frío son E9 (ADR-0015 D3).
- **No es la conciliación bancaria completa de G-14** (E12): quedan fuera las
  reglas de auto-punteo por patrón y la previsión de tesorería.
- **No toca `ExchangeRate` global**, ni RECC/REDEME, ni 523→173, ni el
  reconocimiento de las diferencias de cambio al cierre (`768`/`668`): son E9.
  E7 las **mide y avisa** (I-E7-12), no las contabiliza.

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

`@@map`/`@map` en snake_case en **todo** modelo y columna nuevos (MODELO-DATOS
§Convenciones); `organizationId` en toda tabla de negocio, con FK compuesta por
tenant `(organization_id, <id>)`; dinero en céntimos enteros y **`bigint` desde el
día 1** en las tablas nuevas; fechas de negocio `@db.Date` y `DateTime` sólo para
auditoría técnica; toda tabla nueva entra a la vez en `TENANT_MODELS`
(`lib/db.ts`) y en `SELECT app.enforce_tenant_rls('<tabla>')` (ENABLE + FORCE +
política estricta). **Ninguna migración exige SUPERUSER**; los backfills van
envueltos en `NO FORCE` → backfill → `FORCE` dentro de la misma migración, con la
marca de conversión escrita **antes** del backfill (lección de `20260907120000`).

### 2.2 Fragmento Prisma

```prisma
// ── E7 · el barrido de invariantes, sellado y comparable ─────────────────────
model InvariantRun {                                              // APPEND-ONLY
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  scopeKind    AuditScopeKind @map("scope_kind")
  fiscalYearId String?        @map("fiscal_year_id") @db.Uuid
  periodStart  DateTime?      @map("period_start") @db.Date
  periodEnd    DateTime?      @map("period_end") @db.Date

  trigger AuditTrigger
  /// La fecha de referencia que decidió I8. Sin ella el run no es reproducible.
  refDate DateTime @map("ref_date") @db.Date

  /// Los sellos del estado sobre el que se calculó: la clave de comparación
  /// entre dos runs. Si coinciden y los checks difieren, el motor cambió.
  ledgerHash     String @map("ledger_hash") @db.Char(64)
  analyticsKey   String @default("∅") @map("analytics_key") @db.VarChar(210)
  planHash       String @map("plan_hash") @db.Char(64)
  accountMapHash String @map("account_map_hash") @db.Char(64)
  /// **O-20.** sha256 de la forma canónica de TODA la configuración que puede
  /// mover un check sin mover un dato: umbrales de revisión,
  /// `MAX_MATERIALIZED_ENTRIES`, `matchToleranceDays` por cuenta, umbral de
  /// tránsito, umbral de materialidad de ignorados y variante del plan. Sin él,
  /// bajar un umbral servía el barrido cacheado —justo cuando hay que rebarrer—
  /// y `diffRuns` concluía `cause: "NINGUNA"` con deltas, caso que el criterio 4
  /// declara imposible.
  configHash String @map("config_hash") @db.Char(64)
  gitSha     String @map("git_sha")

  /// sha256 de la forma canónica de `checks` (id + status + evidencia), para que
  /// **I-E7-7** demuestre que la fila no se ha tocado por SQL.
  checksHash String @map("checks_hash") @db.Char(64)

  /// [{ id, family, status, evidencia, query?, provenance? }]
  checks   Json
  /// { PASS, WARN, FAIL, INFO } global y por familia.
  counts   Json
  /// Qué se evaluó de verdad y qué se declaró INFO, y por qué.
  coverage Json
  /// **O-19.** Las cuatro cifras de cierre derivadas de este estado, para que el
  /// diff sea legible por quien firma: { activo, pnMasPasivo, resultado, tesoreria }
  /// con su provenance. Derivadas por SQL del mismo `ledgerHash`: no es una
  /// cifra de informe almacenada (ADR-0003), es la foto del sello.
  headline Json

  seal        Seal
  sealReasons Json @default("[]") @map("seal_reasons")

  storeSweepId String?  @map("store_sweep_id") @db.Uuid
  durationMs   Int      @map("duration_ms")
  runById      String?  @map("run_by_id") @db.Uuid
  createdAt    DateTime @default(now()) @map("created_at")

  @@unique([organizationId, id])
  @@index([organizationId, createdAt(desc)])
  @@index([organizationId, scopeKind, fiscalYearId, createdAt(desc)])
  @@index([organizationId, ledgerHash])
  @@map("invariant_runs")
}
enum AuditScopeKind { ORGANIZATION FISCAL_YEAR PERIOD             @@map("audit_scope_kind") }
enum AuditTrigger   { MANUAL SCHEDULED POST_CLOSE POST_IMPORT     @@map("audit_trigger") }
/// **O-21.** Las siete familias como ENUM, no como texto: con texto libre una
/// errata en `ManualReviewFlag.checkFamily` acota la revisión a nada y el
/// periodo queda sellado como si se hubiera revisado.
enum CheckFamily { PARTIDA_DOBLE ESTADOS ANALITICA LIQUIDACION DOCUMENTAL CONCILIACION INTEGRIDAD  @@map("check_family") }
// Append-only en RLS como `report_runs` y `audit_logs`.

// ── E7 · barrido del almacén de ficheros (cierra la deuda de I-E8-2) ─────────
model StoreSweep {                                                // APPEND-ONLY
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  status       SweepStatus @default(RUNNING)
  filesTotal   Int         @default(0) @map("files_total")
  filesOk      Int         @default(0) @map("files_ok")
  filesMissing Int         @default(0) @map("files_missing")
  filesAltered Int         @default(0) @map("files_altered")
  bytesRead    BigInt      @default(0) @map("bytes_read")

  /// SÓLO los hallazgos, con cota dura de 1000 + `findingsOverflow`.
  findings         Json @default("[]")
  findingsOverflow Int  @default(0) @map("findings_overflow")

  startedAt  DateTime  @default(now()) @map("started_at")
  finishedAt DateTime? @map("finished_at")
  runById    String?   @map("run_by_id") @db.Uuid

  @@unique([organizationId, id])
  @@index([organizationId, startedAt(desc)])
  @@map("store_sweeps")
}
enum SweepStatus { RUNNING DONE FAILED CANCELLED                  @@map("sweep_status") }

// ── E7 · conciliación bancaria ───────────────────────────────────────────────
model BankAccount {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  code String @db.VarChar(24)
  name String @db.VarChar(200)
  /// **O-7.** La subcuenta 57x contra la que se puntea. CHECK: `572`/`573`/`574`/
  /// `575` (o subcuenta suya). Quedan FUERA `570`/`571` (caja: no tiene extracto
  /// y no es conciliable jamás) y `576`. Y `@@unique` por `accountCode`: dos
  /// cuentas bancarias contra la misma subcuenta computarían `B` dos veces y
  /// I-E7-1 descuadraría por diseño. Regla PGC que la UI enseña al dar de alta:
  /// **cada cuenta corriente es su propia subcuenta** (`5720001`, `5720002`…).
  accountCode String        @map("account_code") @db.VarChar(12)
  account     LedgerAccount @relation(fields: [organizationId, accountCode], references: [organizationId, code], onDelete: Restrict, onUpdate: Cascade)

  iban     String? @db.VarChar(34)     // normalizado, sólo para casar extractos
  bic      String? @db.VarChar(11)
  currency String  @default("EUR") @db.VarChar(3)

  /// **O-1 · el anclaje.** Punto desde el que la cuenta está conciliada, fijado
  /// por un ADMIN al darla de alta y no editable sin `AuditLog`. Sin anclaje,
  /// I-E7-1 sale **INFO**: no se puede afirmar que un saldo cuadra si no se sabe
  /// desde dónde. `reconciledOpeningBalanceCents` es el saldo del extracto en esa
  /// fecha, y se coteja contra el saldo contable en el alta.
  reconciledFromDate           DateTime? @map("reconciled_from_date") @db.Date
  reconciledOpeningBalanceCents BigInt?  @map("reconciled_opening_balance_cents")

  /// Mapeo de columnas del CSV de ESTE banco, versionado como configuración:
  /// { delimiter, decimal, dateFormat, centuryWindow, columns:{ operationDate,
  ///   valueDate, amount, sign, description, reference1, reference2, currency },
  ///   signMode: SIGNED|DEBIT_CREDIT, skipRows }. Norma 43 no lo usa.
  csvMapping Json? @map("csv_mapping")
  /// **O-10.** Sólo alimenta la SUGERENCIA. No entra en ningún invariante: es
  /// configuración editable, y un invariante que dependa de ella daría resultados
  /// distintos sobre el mismo `ledgerHash` y el mismo `gitSha` (P7). Sí entra en
  /// `configHash`.
  matchToleranceDays Int @default(3) @map("match_tolerance_days")
  /// **O-8.** Antigüedad a partir de la cual una partida en tránsito deja de ser
  /// normal. Configuración, nunca constante en el código.
  transitWarnDays Int @default(90) @map("transit_warn_days")

  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([organizationId, code])
  @@unique([organizationId, accountCode])          // O-7
  @@unique([organizationId, id])
  @@map("bank_accounts")
}

model BankStatement {                                             // APPEND-ONLY
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  bankAccountId  String       @map("bank_account_id") @db.Uuid
  bankAccount    BankAccount  @relation(fields: [organizationId, bankAccountId], references: [organizationId, id], onDelete: Restrict)

  format     StatementFormat
  /// sha256 de los BYTES importados: clave de idempotencia (I-E7-5).
  fileSha256 String  @map("file_sha256") @db.Char(64)
  fileName   String  @map("file_name") @db.VarChar(255)
  /// El `File` original. Es la «fuente» del badge P6 y tiene que poder
  /// enseñarse; **no se purga nunca** (ADR-0015 D3, art. 30 CCom).
  fileId     String? @map("file_id") @db.Uuid

  /// **O-5.** Divisa del extracto. La importación exige
  /// `statement.currency = bankAccount.currency` y rechaza el fichero entero si
  /// no coincide: un extracto en USD sobre una cuenta declarada en EUR pasaba
  /// todos los checks del diseño de la ronda 1.
  currency String @default("EUR") @db.VarChar(3)

  /// **O-6.** Los periodos se acotan por FECHA DE OPERACIÓN.
  periodStart DateTime @map("period_start") @db.Date
  periodEnd   DateTime @map("period_end") @db.Date
  /// Saldos DECLARADOS POR EL BANCO (registro 11 y registro 33 de la N43), no
  /// calculados por nosotros: I-E7-6a compara contra ellos.
  openingBalanceCents  BigInt @map("opening_balance_cents")
  closingBalanceCents  BigInt @map("closing_balance_cents")
  /// Registro 33: número de apuntes declarado por el banco. Contra él se coteja
  /// `lineCount` (O-11).
  declaredLineCount    Int?   @map("declared_line_count")
  lineCount            Int    @default(0) @map("line_count")

  importedById String?  @map("imported_by_id") @db.Uuid
  importedAt   DateTime @default(now()) @map("imported_at")

  lines BankStatementLine[]

  @@unique([organizationId, bankAccountId, fileSha256])
  @@unique([organizationId, id])
  @@index([organizationId, bankAccountId, periodStart])
  @@map("bank_statements")
}
enum StatementFormat { CSV N43 MANUAL                             @@map("statement_format") }

model BankStatementLine {                                         // APPEND-ONLY
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String        @map("organization_id") @db.Uuid
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  statementId    String        @map("statement_id") @db.Uuid
  statement      BankStatement @relation(fields: [organizationId, statementId], references: [organizationId, id], onDelete: Restrict)
  bankAccountId  String        @map("bank_account_id") @db.Uuid

  lineNo Int @map("line_no")     // orden en el extracto, 1..n, sin huecos (I-E7-5)

  /// **O-6.** `operationDate` es la fecha CONTABLE del banco y la ÚNICA que
  /// corta periodos. `valueDate` es dato financiero (intereses, descubiertos):
  /// se guarda, se enseña y **está prohibida en toda agregación de cuadre**.
  /// Cortar por fecha valor mueve movimientos a través del cierre.
  operationDate DateTime @map("operation_date") @db.Date
  valueDate     DateTime @map("value_date") @db.Date

  /// CON SIGNO: negativo = cargo, positivo = abono. En la **divisa de la cuenta**.
  /// **m2.** El CHECK es `amount_cents IS NOT NULL`, **no** `<> 0`: los bancos
  /// emiten apuntes de 0,00 € (regularizaciones, anotaciones informativas, un
  /// cargo y su reverso netos en el mismo registro), y rechazarlos partiría el
  /// extracto —`lineNo` con hueco (I-E7-5 FAIL) y `lineCount` distinto del
  /// registro 33 (I-E7-6a FAIL)— por un movimiento que el banco sí declaró. Se
  /// importan y nacen `IGNORED` con `ignoreReason = IMPORTE_CERO`, que es la
  /// única causa de ignorado que **no exige evidencia** porque la evidencia es el
  /// propio importe. Un apunte de 0,00 € no altera `Ue` ni el cuadre.
  amountCents  BigInt  @map("amount_cents")
  /// **O-5.** Divisa de la línea (cabecera N43 registro 11 / mapeo CSV) e importe
  /// en divisa original cuando el banco lo declara (**registro 24** de la N43,
  /// que la ronda 1 decía parsear y no guardaba en ninguna parte).
  currency            String  @db.VarChar(3)
  originalCurrency    String? @map("original_currency") @db.VarChar(3)
  originalAmountCents BigInt? @map("original_amount_cents")
  balanceCents        BigInt? @map("balance_cents")

  description String  @db.VarChar(512)
  /// **O-15.** El registro 22 lleva DOS referencias, y la **referencia 1** es la
  /// que identifica la REMESA: colapsarlas dejaba el emparejamiento N-a-1 de O-3
  /// sin ninguna clave determinista con la que agrupar.
  reference1    String? @map("reference_1") @db.VarChar(12)
  reference2    String? @map("reference_2") @db.VarChar(16)
  conceptCommon String? @map("concept_common") @db.VarChar(2)
  conceptOwn    String? @map("concept_own") @db.VarChar(3)
  counterpartyName String? @map("counterparty_name") @db.VarChar(200)

  /// sha256 de la forma canónica de la línea (§2.4).
  sha256 String @db.Char(64)

  status BankLineStatus @default(UNMATCHED)
  /// **O-4/O-12.** Vocabulario CERRADO, con dato asociado obligatorio. `IGNORED`
  /// con texto libre era la puerta por la que se escapa el rigor: una comisión
  /// que nadie contabilizó no se ignora, se contabiliza (§4.4).
  ignoreReason      IgnoreReason? @map("ignore_reason")
  ignoreEvidenceId  String?       @map("ignore_evidence_id") @db.Uuid
  ignoredById       String?       @map("ignored_by_id") @db.Uuid
  ignoredAt         DateTime?     @map("ignored_at")

  matches BankReconciliation[]

  @@unique([organizationId, statementId, lineNo])
  @@unique([organizationId, bankAccountId, sha256])
  @@unique([organizationId, id])
  @@index([organizationId, bankAccountId, status, operationDate])   // O-6
  @@map("bank_statement_lines")
}
/// `SUGGESTED` NO se persiste: una sugerencia es un cálculo sobre el estado de
/// hoy, no un hecho.
enum BankLineStatus { UNMATCHED MATCHED IGNORED                   @@map("bank_line_status") }
/// **O-4.** `ERROR_BANCO_REVERSADO` exige la línea de extracto que lo revierte;
/// `YA_CONTABILIZADO_EN_OTRA_CUENTA` exige el `journalLineId` concreto —y
/// entonces no es «ignorar», es un dato auditable—; `NO_ES_NUESTRA_CUENTA` no
/// exige nada; **`IMPORTE_CERO`** (m2) lo pone la importación sola y su evidencia
/// es el propio importe. **Cualquier otro caso no es ignorable.**
enum IgnoreReason { ERROR_BANCO_REVERSADO NO_ES_NUESTRA_CUENTA YA_CONTABILIZADO_EN_OTRA_CUENTA IMPORTE_CERO  @@map("ignore_reason") }

/// **O-3 · el grupo de conciliación (ADR-0015 D6).** El 1:1 no representa una
/// remesa (14 recibos contra un abono), una nómina pagada en un cargo global, un
/// descuento de efectos ni una devolución parcial. Con el modelo de la ronda 1 el
/// usuario tenía dos salidas y las dos eran peores que el problema: dejarlo todo
/// `UNMATCHED` (I-E7-1 en FAIL permanente, badge nunca) o `IGNORED` (el cuadre
/// «cierra» con el saldo mal, que es el anti-patrón de la spec §5).
model BankMatchGroup {                                 // SEMI-APPEND-ONLY (§2.4)
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  bankAccountId  String       @map("bank_account_id") @db.Uuid

  kind MatchGroupKind
  note String? @db.VarChar(500)

  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  /// Desconciliar es del GRUPO, con motivo ≥ 10 caracteres (CHECK).
  unmatchedAt   DateTime? @map("unmatched_at")
  unmatchedById String?   @map("unmatched_by_id") @db.Uuid
  unmatchReason String?   @map("unmatch_reason") @db.VarChar(1000)

  members BankReconciliation[]

  @@unique([organizationId, id])
  @@index([organizationId, bankAccountId, unmatchedAt])
  @@map("bank_match_groups")
}
enum MatchGroupKind { SIMPLE N_A_1 UNO_A_N N_A_N                  @@map("match_group_kind") }

/// Pasa a ser la **fila de pertenencia** a un grupo. Un grupo `SIMPLE` tiene una
/// línea y un apunte, y todo lo de la ronda 1 sigue siendo su caso particular.
model BankReconciliation {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  groupId        String       @map("group_id") @db.Uuid
  group          BankMatchGroup @relation(fields: [organizationId, groupId], references: [organizationId, id], onDelete: Restrict)

  statementLineId String            @map("statement_line_id") @db.Uuid
  statementLine   BankStatementLine @relation(fields: [organizationId, statementLineId], references: [organizationId, id], onDelete: Restrict)
  /// **Una `JournalLine` de una cuenta 57x**, no un asiento: un traspaso mueve
  /// dos bancos y conciliar el asiento cruzaría las dos cuentas.
  journalLineId   String            @map("journal_line_id") @db.Uuid
  journalLine     JournalLine       @relation(fields: [organizationId, journalLineId], references: [organizationId, id], onDelete: Restrict)

  method   MatchMethod
  scoreBps Int @default(0) @map("score_bps")
  /// **O-10.** Desfase en días entre `operationDate` y `entryDate` **sellado en
  /// el momento del punteo**: es un dato del hecho, inmune a que alguien cambie
  /// `matchToleranceDays` después. Alimenta la métrica `DESFASE_FECHA_ALTO`
  /// (WARN), nunca un FAIL.
  dateGapDays Int @map("date_gap_days")

  matchedById String?  @map("matched_by_id") @db.Uuid
  matchedAt   DateTime @default(now()) @map("matched_at")

  @@unique([organizationId, id])
  @@index([organizationId, groupId])
  @@index([organizationId, journalLineId])
  @@index([organizationId, statementLineId])
  @@map("bank_reconciliations")
}
enum MatchMethod { MANUAL SUGGESTION_ACCEPTED                     @@map("match_method") }
// No hay `AUTO`: E7 no puntea solo. El valor se añadiría en E12, con ADR.
```

Columnas que se añaden a modelos existentes:

```prisma
model ManualReviewFlag {
  // … lo de E6 …
  invariantRunId String?      @map("invariant_run_id") @db.Uuid
  checkFamily    CheckFamily? @map("check_family")      // O-21: enum, no texto
}

model JournalEntry {
  // … lo de E3/E8 …
  /// **O-4.** `SourceType` gana `BANK_RECONCILIATION`: el asiento propuesto desde
  /// un movimiento de extracto guarda su origen y su `statementLineId` en
  /// `sourceId`. `BANK_IMPORT` ya existía y significa otra cosa (import masivo).
}

model AllocationRun {
  /// Índice parcial que enumera barato los sellados sin `linesHash` (I-E7-9).
  @@index([organizationId, periodStart], map: "allocation_runs_sin_lines_hash")   // WHERE lines_hash IS NULL AND status='SEALED'
}
```

**Seis `AccountKey` en juego, tres nuevas (O-4, m1).** `COMISIONES_BANCARIAS` (626),
`DIFERENCIA_CAMBIO_NEGATIVA` (668) y `DIFERENCIA_CAMBIO_POSITIVA` (768) **ya
existen** en el enum desde E2/E8. Se añaden: **`INTERESES_DEUDAS` (662)**,
**`OTROS_GASTOS_FINANCIEROS` (669)** e **`INTERESES_DESCUENTO_EFECTOS` (665)**,
con su default en el seed. Ninguna cuenta de una propuesta sale del código ni del
texto del movimiento: salen del mapa de la organización.

### 2.3 Migraciones

Cinco, en este orden. M1–M3 son **aditivas puras** pero **M3 depende de D6**
(O-3/O-5/O-1/O-9 cambian su esquema); M4 y M5 dependen de D1 y D5.

| # | Migración | Qué hace |
|---|---|---|
| **M1** | `20260916090000_e7_enums` | `CREATE TYPE` de `audit_scope_kind`, `audit_trigger`, `check_family`, `sweep_status`, `statement_format`, `bank_line_status`, `ignore_reason`, `match_group_kind`, `match_method`; **`ALTER TYPE report_type ADD VALUE 'CASHFLOW'`**, **`ALTER TYPE source_type ADD VALUE 'BANK_RECONCILIATION'`** y las **tres** `AccountKey` nuevas. Va sola: `ALTER TYPE … ADD VALUE` no puede usarse en la misma transacción que lo consume (lección de `20260913090000_e8_enums`) |
| **M2** | `20260916100000_e7_auditoria` | `invariant_runs` (con `config_hash` y `headline`), `store_sweeps`; `enforce_tenant_rls` + append-only (`RESTRICTIVE … USING(false)` en UPDATE/DELETE + `REVOKE`); CHECK de coherencia de alcance; cota de 1 MB en `checks` y 1000 entradas en `findings`; `manual_review_flags.invariant_run_id` y `check_family` (enum, nullable); índice parcial `allocation_runs_sin_lines_hash`; seed de las tres `AccountKey` bajo `NO FORCE`/`FORCE` |
| **M3** | `20260916110000_e7_conciliacion` | `bank_accounts`, `bank_statements`, `bank_statement_lines`, **`bank_match_groups`**, `bank_reconciliations`; `enforce_tenant_rls` en las cinco; append-only en extractos y líneas, **semi**-append-only en `bank_match_groups` (`GRANT UPDATE` de las tres columnas de desconciliación + trigger, patrón ADR-0010) y en la marca de ignorado; FK compuestas por tenant. CHECKs: **`amount_cents IS NOT NULL`** —nunca `<> 0` (m2): un apunte de 0,00 € del banco se importa y nace `IGNORED` con `IMPORTE_CERO`, porque rechazarlo partiría el `lineNo` y descuadraría el cotejo con el registro 33—; **cuenta ∈ {572,573,574,575} o subcuenta suya** (O-7); `period_start ≤ period_end`; motivo ≥ 10 caracteres al desconciliar; `ignore_reason` con evidencia obligatoria en dos de sus cuatro valores (O-4); `statement.currency = bank_account.currency` por trigger (O-5); `date_gap_days ≥ 0`. Índices únicos **parciales** `WHERE group.unmatched_at IS NULL` sobre `statement_line_id` y sobre `journal_line_id` (**I-E7-3 en la base**), que siguen valiendo con grupos: una línea y un apunte pertenecen a lo sumo a un grupo vivo |
| **M4** | `20260916120000_e7_bigint_diario` | **ADR-0015 D1.** `journal_lines.debit_cents`, `credit_cents`, `tax_base_cents` y `original_amount_cents` de `integer` a `bigint`. DDL puro, sin SUPERUSER, pero **reescribe la tabla más grande** con `ACCESS EXCLUSIVE`: ventana de mantenimiento, medida antes en un clon del preview (§8) |
| **M5** | `20260916130000_e7_users_rls` | **ADR-0015 D5.** `ENABLE` + `FORCE` en `users` con **políticas por rol**: `app_auth` (rol nuevo, sólo para better-auth) con acceso pleno; `app_runtime` con `USING (id = app.current_user() OR …membresía compartida…)` y sin `DELETE` |

**Migración de datos de `ReportType` (ADR-0015 D4).** No va en SQL: `params_hash`
es el sha256 de la forma canónica de `params` y calcularlo en PL/pgSQL sería
reimplementar `canonicalJson` en otro lenguaje —la deriva que ADR-0011 corrigió—.
Va en `scripts/migrate-cashflow-report-type.ts` (operador,
`DATABASE_URL_MAINTENANCE`, por organización, reanudable): lee los runs
`CASHFLOW_DIRECTO`/`CASHFLOW_INDIRECTO`, compone `params' = {…, method}`,
recalcula el hash **con la función de la aplicación**, actualiza bajo
`NO FORCE`/`FORCE` (los `report_runs` son append-only también para el
propietario), hace lo propio con `manual_review_flags.scope`, y escribe su marca
`Setting('e7.cashflow_report_type_migrated')` **antes** del backfill. Los dos
valores viejos no se borran del enum (PostgreSQL no lo permite): quedan
prohibidos por un CHECK `NOT VALID` que el script valida al terminar.

### 2.4 Reglas de integridad propias de E7

| Regla | Dónde vive |
|---|---|
| Forma canónica de la línea: `sha256(operationDate‖valueDate‖amountCents‖currency‖normalize(description)‖normalize(reference1)‖normalize(reference2)‖ordinalDelDíaEnElExtracto)`. `normalize` = mayúsculas, colapso de espacios, sin acentos | `lib/bank/hash.ts` (puro) + `@@unique([organizationId, bankAccountId, sha256])` |
| Un extracto no se importa dos veces | `@@unique([organizationId, bankAccountId, fileSha256])` |
| Una línea de extracto y un apunte 57x pertenecen **a lo sumo a un grupo vivo** | dos índices únicos parciales `WHERE unmatched_at IS NULL` + **I-E7-3** |
| **Un grupo cuadra**: Σ líneas = Σ (debe − haber) de sus apuntes, tolerancia 0 | **I-E7-11** (+ revalidación en `matchAction`) |
| La conciliación apunta a una `JournalLine` de la **misma** subcuenta de la `BankAccount` y con **el mismo importe con signo** | CHECK + FK compuesta + **I-E7-2 revisado**, verificado también al escribir |
| Una `BankAccount` por subcuenta, y sólo 572/573/574/575 | CHECK + `@@unique([organizationId, accountCode])` |
| El extracto está en la divisa de la cuenta | trigger de importación + rechazo del fichero entero |
| Desconciliar no borra: marca el **grupo** con autor y motivo ≥ 10 caracteres | `GRANT` de columna + trigger + CHECK |
| `IGNORED` sólo con vocabulario cerrado y evidencia (salvo `IMPORTE_CERO`, cuya evidencia es el propio importe) | enum + CHECK + **I-E7-13** |
| Un apunte de 0,00 € del banco se importa, nunca se rechaza | CHECK `amount_cents IS NOT NULL` (m2) + `IMPORTE_CERO` |
| Un `InvariantRun` no se edita | RLS append-only + **I-E7-7** (`checksHash` recomputado) |
| Nada se borra | RLS `FOR DELETE USING(false)` en las seis tablas nuevas |

### 2.5 Estrategia de datos existentes

- **`invariant_runs`, `store_sweeps` y las cinco de banca nacen vacías.** No se
  reconstruye histórico: un `InvariantRun` es la foto de un estado, y un estado
  pasado no se fotografía hoy sin mentir (P3). El primer barrido tras desplegar
  E7 es el run cero y su sello dice `MOTOR_CAMBIADO`, que es lo correcto.
- **El anclaje de cada `BankAccount` lo fija un ADMIN al darla de alta** (O-1),
  cotejando el saldo del extracto en esa fecha contra el saldo contable. Mientras
  no exista, I-E7-1 es **INFO** y el badge P6 no se concede.
- **`allocation_runs` con `lines_hash` NULL**: no se rellenan por script. Un
  `linesHash` calculado hoy sobre líneas que quizá alguien tocó ayer no es un
  sello. La pantalla los **lista** con periodo y fecha para re-liquidarlos
  (`supersede`), único camino que produce un sello legítimo. I-E7-9 los cuenta.
- **Extractos y su `File`: no se purgan nunca** (O-22, art. 30 CCom seis años;
  diez con bases imponibles negativas, art. 26.5 LIS). `prune-runs.ts` comprueba
  que un `File` referenciado por un `BankStatement` jamás se borra, y hay test.
- **`journal_lines` a `bigint`**: la conversión no cambia ni un valor, así que
  `entryHash`, `ledgerHash` y los fixtures **no se mueven** — con test que falla
  si se mueven (criterio 24).

### 2.6 `DataQualityIssue` **no existe como tabla** — y por qué

1. Sería una **segunda verdad** sobre el mismo hecho: `dataQualityWarnings()`
   (E8) ya lo deriva del estado real; una tabla podría decir «resuelto» mientras
   el documento sigue sin asiento.
2. Un aviso «resuelto a mano» es el anti-patrón de la spec §5 («entregar un
   informe cuya validación falló, sin sello de advertencia»).
3. ADR-0003: nada derivable del diario se almacena.

E7 los **pinta con su consulta de `registros_origen` y un botón que lleva a la
pantalla donde se arreglan**. Si hay que convivir con un aviso, el mecanismo es
`ManualReviewFlag` con motivo, que sí es un hecho de gobierno.

### 2.7 `ReviewRequest` **es `ManualReviewFlag`**

Ya existe desde E6 (periodo, `scope: ReportType?`, motivo obligatorio, ADMIN,
semi-append-only, `AuditLog` en la misma transacción). Crear una tabla paralela
partiría en dos el mecanismo y dejaría dos sellos posibles para el mismo periodo
— el experto lo confirma (O-21). E7 la extiende con `invariantRunId` y
`checkFamily` **como enum**, y le da la superficie de UI que le faltaba: hoy sólo
se fuerza desde `/settings/reports` y quien detecta el problema mira `/audit`.
**Forzar revisión sobre un ejercicio `CLOSED` es explícitamente posible**:
descubrir un error después del cierre es precisamente cuando se fuerza.

### 2.8 RLS en `users` (ADR-0015 D5)

`users` es la única tabla sin RLS. No es descuido: **no tiene `organization_id`**
(un usuario pertenece a varias organizaciones) y el camino de autenticación la lee
**sin sesión**. La decisión propuesta usa que las políticas se pueden acotar **por
rol**: `app_auth` (rol nuevo, sólo para la conexión de better-auth) con
`USING(true)`; `app_runtime` con `SELECT` de uno mismo y de quien comparte
membresía, `UPDATE` sólo de la propia fila y `DELETE` prohibido. Coste: un
**segundo cliente Prisma** para better-auth (~10 h, T14). La alternativa —dejarlo
como está— se documenta en el ADR: hoy un `SELECT * FROM users` desde
`app_runtime` enumera los correos de todos los clientes del SaaS.

---

## 3. Motor / funciones puras (`lib/audit/`)

Carpeta nueva. Todo **puro**: sin IO, sin `Date.now()`, sin LLM. Hay que añadir
`lib/audit/**` y `lib/bank/**` a las dos listas del guard de pureza (hook y CI) o
la carpeta nueva queda sin vigilar (T2).

### 3.1 `lib/audit/families.ts` — agregación y semáforos

```ts
export type CheckFamily =
  | "PARTIDA_DOBLE"   // I1, I-E3-1..7, N-5
  | "ESTADOS"         // I2, I3, I6, I-E6-*, I-E7-14..17  (cuadres de cierre)
  | "ANALITICA"       // I4, I-E4-1..12
  | "LIQUIDACION"     // I5, I-E5-1..12, I-E7-9, I-E7-10
  | "DOCUMENTAL"      // I-E8-1..20 (7b es métrica), I-E7-8
  | "CONCILIACION"    // I-E7-1, 2, 3, 5, 6a, 6b, 11, 12, 13
  | "INTEGRIDAD"      // I7..I10, I-E7-7
export type FamilyStatus = "OK" | "AVISO" | "FALLO" | "SIN_EVALUAR"

export function familyOf(checkId: string): CheckFamily
export function groupByFamily(checks: readonly CheckResult[]): FamilySummary[]
export function familyStatus(checks: readonly CheckResult[]): FamilyStatus
export function countsOf(checks: readonly CheckResult[]): AuditCounts
```

Un id sin familia se devuelve como `INTEGRIDAD` **y** se declara en `unknownIds`:
un check nuevo que nadie clasificó no puede desaparecer del semáforo. Composición
del semáforo, escrita una vez: **un solo FAIL pinta la familia en FALLO**; sin
FAIL, un WARN la pinta en AVISO; si todo lo que hay es INFO, `SIN_EVALUAR` — no
«OK»: la diferencia entre «comprobado y bien» y «no comprobado» es la razón de ser
de la pantalla.

### 3.2 `lib/audit/run.ts` — la foto y su sello

```ts
export type AuditRunInput = {
  checks: readonly CheckResult[]
  scope: AuditScope
  hashes: { ledgerHash: string; analyticsKey: string; planHash: string
            accountMapHash: string; configHash: string }        // O-20
  headline: HeadlineFigures                                     // O-19
  gitSha: string; lastGitSha: string | null
  refDate: LocalDate
  manualFlags: readonly ManualReviewFlagRef[]
  coverage: CoverageReport
  durationMs: number
}
export function buildInvariantRun(input: AuditRunInput): InvariantRunDraft
export function checksHashOf(checks: readonly CheckResult[]): string   // I-E7-7
export function configHashOf(config: AuditConfigSnapshot): string      // O-20
```

El sello **reutiliza `seal()` de `lib/ledger/invariants.ts`**; E7 no define un
segundo criterio de sellado (el experto lo confirma). Aporta cuatro motivos al
vocabulario existente: `CONCILIACION_PENDIENTE` (AVISO), `ALMACEN_NO_BARRIDO`
(ENTORNO), **`PARTIDA_EN_TRANSITO_ANTIGUA`** (AVISO, O-8) y
**`DIFERENCIA_DE_CAMBIO_SIN_RECONOCER`** (AVISO, O-5).

### 3.3 `lib/audit/diff.ts` — dos barridos comparados

```ts
export type CheckDelta = { id: string; family: CheckFamily
  from: CheckStatus | null; to: CheckStatus | null
  evidenciaFrom?: string; evidenciaTo?: string }
/** O-19: lo que mira quien firma no es un check, es una cifra. */
export type FigureDelta = { metric: "ACTIVO" | "PN_MAS_PASIVO" | "RESULTADO" | "TESORERIA"
  fromCents: Cents; toCents: Cents; deltaCents: Cents; provenance: Provenance }
export type RunDiff = {
  deltas: readonly CheckDelta[]
  figures: readonly FigureDelta[]
  cause: "DATOS" | "MOTOR" | "CONFIGURACION" | "VARIOS" | "NINGUNA"
  hashChanges: readonly { hash: string; from: string; to: string }[]
}
export function diffRuns(a: InvariantRunRef, b: InvariantRunRef): RunDiff
```

`cause` sale de comparar los sellos, no de adivinar: mismos hashes y distinto
`gitSha` ⇒ `MOTOR`; distinto `ledgerHash`/`analyticsKey` ⇒ `DATOS`; distinto
`configHash` ⇒ `CONFIGURACION` (O-20); más de uno ⇒ `VARIOS`. Es la exigencia de
la spec §0: «dos ejecuciones que se contradigan, explicables por diff, nunca un
misterio». Las cuatro cifras se leen de `headline`, ya derivado por SQL de cada
`ledgerHash`: es barato, es derivado y no viola ADR-0003.

### 3.4 `lib/audit/bank-match.ts` — sugerencias deterministas, **jamás LLM**

```ts
export type MatchReason =
  | "IMPORTE_EXACTO" | "MISMA_FECHA_OPERACION" | "FECHA_EN_TOLERANCIA"
  | "FECHA_VALOR" | "REFERENCIA_1" | "REFERENCIA_2" | "CONTRAPARTE"
export type MatchCandidate = { journalLineIds: readonly string[]; scoreBps: number
  kind: MatchGroupKind; reasons: readonly MatchReason[] }

export function suggestMatches(
  lines: readonly BankLineRef[], ledger: readonly LedgerCashLineRef[],
  config: { toleranceDays: number },
): ReadonlyMap<string, readonly MatchCandidate[]>
```

Reglas, en este orden y sin excepciones:

1. **El importe tiene que coincidir al céntimo**, con signo y **en la divisa de la
   cuenta** (O-5). Sin importe exacto no hay candidato: no existe «casi». Para un
   candidato N-a-1, la igualdad es la del **grupo** (Σ = Σ), que es I-E7-11.
2. La distancia se mide sobre **`operationDate`** (O-6): `|operationDate −
   entryDate| ≤ toleranceDays` de la cuenta (configuración, no constante).
3. Puntuación entera y reproducible: `10000` importe exacto · `+2000` misma
   `operationDate` (`1000 − 200·días` si no) · **`+500` si lo que casa es la
   fecha valor** —información útil que no debe decidir (O-6)— · `+2500`
   `reference1` por contención exacta tras normalizar · `+1000` `reference2` ·
   `+1500` misma contraparte. Nada de distancias difusas ni de similitud textual.
4. **Agrupación N-a-1 propuesta por `reference1`** (O-15): las líneas o apuntes
   que comparten referencia de remesa se ofrecen como grupo, con la misma
   puntuación determinista. Sin `reference1`, la agrupación **no se ofrece**.
5. **Empate ⇒ ninguna sugerencia.** Dos candidatos a puntuación máxima ⇒ la línea
   sale «ambigua» con los dos listados y una persona elige. Un desempate
   automático es donde se cuela el error silencioso.
6. Asignación por pasadas deterministas (primero únicos y mutuos; luego
   `(scoreBps desc, operationDate asc, id asc)`): dos ejecuciones sobre el mismo
   estado producen la misma lista byte a byte.
7. Un candidato ya conciliado no vuelve a proponerse.

### 3.5 `lib/audit/invariants-e7.ts` — los invariantes nuevos

Mismo contrato: **nunca un PASS que no se haya comprobado**; lo no evaluable sale
`INFO` diciendo qué falta. **Tolerancia 0 en todo lo que compara importes** — no
aplica aquí la tolerancia del reparto por mayor resto de I5: en conciliación no
hay reparto, hay igualdad o no la hay.

#### La identidad del cuadre (O-1, O-2)

Sea, a la fecha de corte `D` —**siempre por fecha de operación** (O-6)— y para
**una** cuenta bancaria:

| | |
|---|---|
| `B` | saldo contable de la subcuenta 57x = `Σ (debitCents − creditCents)` de las líneas de asientos con **`kind ∉ {CLOSING}`** — es decir, **`OPENING` sí entra** (O-2). Es la foto `PRE_REGULARIZACION` de E6 restringida a la cuenta, y se calcula **con la misma función**, no con una segunda |
| `E` | saldo del extracto a `D`, **declarado por el banco** |
| `Ue` | Σ con signo de las **líneas de extracto no conciliadas** hasta `D` |
| `Ub` | Σ con signo (`debe − haber`) de los **apuntes de la 57x no conciliados** hasta `D` |

> **I-E7-1 · `E − B = Ue − Ub`**, tolerancia **0**, con `Ue` y `Ub` **enumerados
> uno a uno y tipados** (O-8). El saldo inicial del extracto no interviene:
> desaparece al ser `E` acumulado. La fórmula de la ronda 1 daba FAIL en cualquier
> empresa con un cheque de diciembre cargado en enero y contaba los pendientes dos
> veces.

Salida estructurada:
`{ saldoExtracto, saldoContable, diferencia, pendientesBanco[], pendientesLibros[], ignoradosCents }`.
**I-E7-1 sólo puede dar PASS** si (a) la cuenta tiene **anclaje**
(`reconciledFromDate`) y (b) **I-E7-6b** está en PASS —la cadena de extractos
cubre `[anclaje, D]` sin huecos—. Sin cualquiera de las dos, **INFO**, nunca PASS.

`REGULARIZATION` no toca 57x; si la tocara sería un error, y I-E7-1 debe
delatarlo, no absorberlo.

#### Tipos de pendiente y envejecimiento (O-8)

| Tipo | Lado | Tratamiento |
|---|---|---|
| `CHEQUE_EMITIDO_NO_CARGADO` | libros | normal hasta el plazo de presentación; WARN pasado `transitWarnDays` |
| `REMESA_NO_ABONADA` | libros | normal dentro de los días de abono pactados |
| `TRASPASO_ENTRE_CUENTAS_EN_CAMINO` | ambos | **debe casar con el pendiente espejo** de la otra cuenta; si no casa, WARN |
| `MOVIMIENTO_BANCO_SIN_ASIENTO` | banco | va a propuesta de asiento (§4.4) |
| `APUNTE_SIN_MOVIMIENTO` | libros | sospechoso por definición pasado el umbral |
| `EFECTO_EN_GESTION_DE_COBRO` | — | **no conciliable**: vive en `4312`/`4311`, no en 57x. **Excluido del cuadre** |

El **descuento de efectos** (`4311`/`5208`/`665`) y los efectos en gestión de
cobro (`4312`) entran por el camino documental: lo único conciliable contra el
extracto es el **abono neto** que el banco practica, que es un grupo N-a-1 con
tres cuentas (nominal − intereses `665` − comisión `626`). Un pendiente con
antigüedad > `transitWarnDays` aporta el motivo de sello
`PARTIDA_EN_TRANSITO_ANTIGUA`.

#### Tabla de invariantes

| ID | Invariante | Tol. |
|---|---|---|
| **I-E7-1** | **Cuadre**: `E − B = Ue − Ub` con pendientes enumerados y tipados; exige anclaje e I-E7-6b, o INFO | 0 |
| **I-E7-2** *(revisado, O-9)* | Para toda conciliación viva: misma organización · cuenta de la `JournalLine` ∈ {572,573,574,575} e **igual** a la de la `BankAccount` · y **`bankLine.amountCents = debitCents − creditCents`**, con signo, al céntimo, en la divisa de la cuenta. En grupo, la igualdad es la de I-E7-11. **La tolerancia de fechas NO forma parte de este invariante** (O-10). Se verifica también en `matchAction` | 0 |
| **I-E7-3** | Ninguna línea de extracto ni ningún apunte 57x pertenece a dos grupos vivos. Lo impiden dos índices únicos parciales; el invariante lo **verifica** y deja evidencia | — |
| ~~I-E7-4~~ | **Subsumido en I-E7-2** (O-9). Se conserva como **evidencia legible** del signo (cargo ⇔ haber de la 57x), no como check independiente | — |
| **I-E7-5** | Integridad del importado: `fileSha256` único por cuenta, `sha256` de línea único por cuenta, `lineNo` correlativo sin huecos | — |
| **I-E7-6a** | El extracto cuadra **consigo mismo**: `opening + Σ amountCents = closing`, y `lineCount = declaredLineCount` del **registro 33**. INFO si el banco no declara saldos | 0 |
| **I-E7-6b** | **Cobertura de la cadena** (O-11): para el periodo auditado y cada cuenta, la unión de los periodos de extracto cubre `[anclaje, corte]` **sin huecos** y sin solapes contradictorios. Un hueco es **FAIL**, y mientras exista I-E7-1 sale INFO | — |
| **I-E7-7** | **Reproducibilidad**: `checksHash` recomputado sobre `checks` = el almacenado, en los N últimos runs. Editar una fila por SQL lo delata nombrando el run (mecanismo de I-E8-11) | — |
| **I-E7-8** | **Cobertura del almacén**: todo `File` tiene veredicto en el último `StoreSweep` `DONE`, posterior al último fichero ingerido. Amplía I-E8-2, que sólo mira los que respaldan un asiento | — |
| **I-E7-9** | Todo `AllocationRun` `SEALED` tiene `linesHash`. Los anteriores a `20260910110000` salen **WARN** enumerados con periodo y fecha; uno sellado después sin `linesHash` es **FAIL** | — |
| **I-E7-10** | **`allocation_lines` no alteradas** bajo un `ReportRun` vigente: el `linesHash` recomputado de cada run de su `allocationRunSetHash` = el sellado. Cierra la deuda de E5 | 0 |
| **I-E7-11** *(nuevo, O-3)* | **Cuadre del grupo**: para todo grupo vivo, `Σ amountCents de sus líneas = Σ (debitCents − creditCents) de sus apuntes`. Un grupo 1:1 también lo cumple; con él, I-E7-1 sigue siendo exacta sin cambios (los grupos se cancelan como los pares) | 0 |
| **I-E7-12** *(nuevo, O-5)* | **Divisa**: el cuadre de una cuenta en moneda extranjera se hace **en su divisa**. El saldo en euros = Σ contravalores históricos de sus apuntes; la diferencia con `saldo en divisa × tasa de cierre` es la **diferencia de cambio** pendiente (NRV 11ª.2.2, a `768`/`668`) y se presenta **como tal**. A fecha de cierre sin asiento que la recoja, **WARN** con su importe. Regla negativa explícita: *una diferencia de cambio jamás aparece en `Ue` ni en `Ub`; si aparece, el cuadre se está haciendo en la divisa equivocada* | 0 |
| **I-E7-13** *(nuevo, O-12)* | **Ignorados acotados**: toda línea `IGNORED` tiene motivo del vocabulario cerrado y, si es `YA_CONTABILIZADO_EN_OTRA_CUENTA` o `ERROR_BANCO_REVERSADO`, la evidencia que lo respalda. `Σ importes ignorados` se presenta **como línea propia y visible** del cuadre; por encima del umbral de materialidad de la cuenta, **WARN** con la lista. Los `IMPORTE_CERO` (m2) se cuentan aparte y **nunca** disparan el WARN: suman 0 por definición | — |
| **I-E7-14** *(nuevo, O-18)* | **Continuidad entre ejercicios**: el saldo de apertura de N, **cuenta a cuenta**, = saldo de cierre de N−1 (art. 25 CCom; R-B5 de E6). El fixture lo probaba, pero **no había check que lo verificara en datos reales** | 0 |
| **I-E7-15** *(nuevo, O-18)* | **Saldos contrarios a su naturaleza**, generalizando R-B6 de E6 (que sólo miraba 472/477): `430` acreedor, `400`/`410` deudor, `572` acreedor sin póliza de crédito declarada, `473` acreedor. **WARN** nombrando cuenta e importe | — |
| **I-E7-16** *(nuevo, O-18)* | **Cuentas puente con saldo**: `555` (partidas pendientes de aplicación), `551` y `4749` a fecha de cierre de ejercicio. `555` con **cualquier** saldo al cierre es un **hallazgo** (FAIL en fecha de cierre; WARN intraperiodo) | — |
| **I-E7-17** *(nuevo, O-18)* | **Sumas y saldos**: Σdebe = Σhaber del periodo **y mes a mes**, con los cuatro totales del balance de comprobación (art. 28.1 CCom, trimestral y obligatorio). I1 comprueba el asiento; éste comprueba el **libro** | 0 |

### 3.6 El badge `✓ validado contra fuente` (ADR-0015 D2, O-16 y O-17)

`lib/audit/confidence.ts`. Dos precisiones que la ronda 1 no tenía y sin las
cuales el badge mentiría:

**Por composición (O-16).** El epígrafe `B.VII.1 Tesorería` agrega **todas** las
57x, **caja incluida**, y la caja no tiene extracto ni puede tenerlo. La regla es:

> Una cifra lleva `✓ validado contra fuente` si y sólo si **todas** las cuentas
> que la componen están íntegramente conciliadas para el periodo, con I-E7-1 y
> **I-E7-6b** en PASS y **ni un pendiente sin explicar**.

Consecuencia explícita y honesta, escrita también en el ADR: *una organización con
caja no verá nunca el badge en la tesorería total del balance; lo verá en el
detalle por cuenta bancaria y en el cashflow si su cashflow no incluye caja.* Un
arqueo de caja firmado **no** es fuente equivalente en E7 (podría serlo en E12,
con ADR).

**`explicado`, con criterio verificable (O-17).** Listar un pendiente no lo
explica — eso es conceder el sello por enumeración, el anti-patrón de la spec §5:

| Un pendiente está **explicado** si… |
|---|
| es del lado **banco** y existe ya un asiento posterior conciliado que lo recoge; **o** |
| es del lado **libros** y existe ya una línea de extracto posterior conciliada que lo recoge; **o** |
| está **tipado** (§3.5) y su antigüedad es **menor** que `transitWarnDays` de la cuenta |

Cualquier otro pendiente es `sin explicar` y **retira el badge**.

**El badge se deriva en lectura y no se persiste nunca** (O-17): un extracto
importado en febrero puede contener un movimiento con fecha de operación de
diciembre y tiene que **retirar** un badge ya concedido sobre diciembre. Un badge
almacenado no podría hacerlo.

### 3.7 Qué se toca del motor existente (y qué no)

- `lib/ledger/invariants.ts`: **no se toca ni un check**. Se re-exporta el bloque
  E7 en `runInvariants`, como se hizo con E4/E5/E6/E8.
- `B` (§3.5) reutiliza la función de la foto `PRE_REGULARIZACION` de
  `lib/ledger/reports/balance.ts` restringida a la cuenta; **no se escribe una
  segunda** (O-2).
- `models/ledger.runLedgerInvariants` gana `persist?: { trigger, scope, runById }`:
  con él escribe el `InvariantRun` en la misma transacción; sin él se comporta
  como hoy (la caché por `ledgerHash` sigue sirviendo a las cabeceras de informe,
  que no deben escribir una fila por render).
- `lib/ledger/postFromProposal.ts` **no se modifica**: la propuesta de asiento
  desde el extracto (§4.4) construye un `ExtractionProposal` y entra por el camino
  existente. Un segundo camino de posteo sería una segunda verdad.

---

## 4. Capa de aplicación

### 4.1 Modelos (IO, tenant) — no calculan nada

| Fichero | Responsabilidad |
|---|---|
| `models/audit.ts` | `createInvariantRun`, `listInvariantRuns`, `getInvariantRun`, `latestInvariantRun`, `headlineFigures(ledgerHash)` (SQL), `pruneInvariantRuns` |
| `models/store-sweep.ts` | `startSweep`, `appendFindings` por lotes, `finishSweep`, `latestSweep` |
| `models/bank.ts` | CRUD de `BankAccount` con anclaje; `importStatement` idempotente por `fileSha256`; `listUnmatched`, `listCashLines(period)` (agregado SQL sobre 57x, sin N+1), `createGroup`, `unmatchGroup`, `ignoreLine`, `pendingItems(period)` tipados y envejecidos |
| `models/reports.ts` | `listStaleAllocationBackedRuns()` para I-E7-10 |

Todo por `tenantDb`/`tenantTransaction`; lecturas dentro de una transacción **en
serie** (regla de E6-perf).

### 4.2 Parsers (IO acotado, salida pura)

`lib/bank/csv.ts` y `lib/bank/n43.ts` son **puros**: reciben el texto ya leído y
el mapeo, devuelven `{ statement, lines, errors }`. Un registro que no cuadre **no
se importa a medias**: se rechaza el fichero entero con la línea y el motivo.

**Norma 43, lo que hay que escribir para que no haya un error silencioso** (O-6,
O-14, O-15):

| Registro | Contenido usado |
|---|---|
| `11` cabecera de cuenta | cuenta, **divisa**, `openingBalanceCents`, fechas del periodo |
| `22` movimiento | **fecha de operación pos. 11–16**, **fecha valor pos. 17–22** (invertirlas es un error silencioso que ningún invariante detectaría), concepto común (2), concepto propio (3), **importe 14 dígitos sin signo**, **indicador debe/haber**, **referencia 1 (12)** y **referencia 2 (16)** |
| `23` concepto complementario | concatenado en `description` |
| `24` importe en divisa | `originalCurrency` + `originalAmountCents` (O-5) |
| `33` final de cuenta | **número de apuntes y saldo final declarados**, contra los que cotejan I-E7-6a e I-E7-5 |
| `88` fin de fichero | control de totales |

- **Signos (O-14):** indicador `1` = **debe** (cargo: disminuye el saldo del
  titular ⇒ `amountCents < 0`); `2` = **haber** (abono ⇒ `amountCents > 0`).
  Invertirlo produce un extracto que cuadra consigo mismo y punteos que I-E7-2
  «confirmaría». El fixture de T7 lleva **un cargo y un abono con aserción
  explícita de signo**, más un caso de **saldo final negativo** (descubierto).
- **Ventana de siglo (O-14):** las fechas son `AAMMDD`; constante documentada
  `00–79 → 20xx`, `80–99 → 19xx`. Sin ella, un extracto de 1998 se parsea como
  2098.
- **Desbordamiento (O-14):** 14 dígitos sin signo caben en `bigint`; se comprueba
  al parsear y se **rechaza el fichero**, nunca se trunca.

En CSV, el mapeo por banco declara qué columna es cada cosa; si no hay
`reference1`, es `null` y **la agrupación por referencia simplemente no se
ofrece**.

### 4.3 Server actions — `app/(app)/audit/actions.ts`

`zod` en `forms/audit.ts` y `forms/bank.ts`, `requireOrg(minRol)` al principio,
`AuditLog` en la misma transacción que la mutación.

| Acción | Rol | Qué hace |
|---|---|---|
| `runInvariantsAction({ scopeKind, fiscalYearId?, period?, refDate? })` | EDITOR | Barrido + `InvariantRun` con `trigger: MANUAL`. Lock consultivo contra barridos concurrentes de la misma organización |
| `runStoreSweepAction()` / `cancelStoreSweepAction(id)` | ADMIN | Encola / cancela el barrido del almacén (§8) |
| `forceReviewAction` / `clearReviewAction` | ADMIN | Ya existen (E6); ganan `invariantRunId` y `checkFamily`. **Permitidas sobre ejercicio `CLOSED`** (O-21) |
| `createBankAccountAction` / `updateBankAccountAction` | ADMIN | Alta con **anclaje** (fecha y saldo, cotejados contra el saldo contable), mapeo CSV, `matchToleranceDays`, `transitWarnDays`. Todo con `AuditLog`; el anclaje no se edita sin motivo |
| `importStatementAction(bankAccountId, file)` | EDITOR | Valida mimetype/tamaño, calcula `sha256`, parsea, **corre I-E7-5, I-E7-6a y la comprobación de divisa ANTES de escribir** y aborta si fallan; idempotente por `fileSha256` |
| `createMatchGroupAction({ statementLineIds[], journalLineIds[], kind, note? })` | EDITOR | Concilia **N-a-M**. Revalida en servidor tenant, cuenta, divisa, signo e **igualdad de sumas (I-E7-11 / I-E7-2)**: el camino de escritura manual es justo el que usa una persona con prisa en un cierre (O-9). Sella `dateGapDays` |
| `acceptSuggestionsAction(ids[])` | EDITOR | Acepta N sugerencias **explícitamente elegidas**; **recomputa la sugerencia en servidor** y da error legible si el candidato fue conciliado por otro usuario entre el render y la aceptación (§9.3 de la validación) |
| `unmatchGroupAction({ groupId, reason })` | EDITOR | Desconcilia el **grupo** con motivo ≥ 10 caracteres |
| `ignoreLineAction({ id, reason, evidenceId? })` | EDITOR | `IGNORED` con vocabulario cerrado; exige evidencia en dos de sus tres valores (O-4) |
| `proposeEntryFromLineAction(statementLineId)` | EDITOR | **No postea**: devuelve una propuesta precargada para `previewFromProposal` (§4.4) |
| `confirmEntryFromLineAction(...)` | EDITOR | Confirma la propuesta: `postFromProposal` + conciliación de la línea con el asiento **en la misma transacción** + `AuditLog` |
| `detectionTestAction(scope)` | ADMIN | Test de error inyectado desde la UI (§7). No escribe nada |
| `splitProposalAction` | EDITOR | Ya existe (E8); E7 le pone pantalla |

**Conciliar sobre un ejercicio `CLOSED` está permitido** (O-13): la conciliación
es un hecho de gobierno que **no escribe en el diario**. Hay test de que
`createMatchGroupAction`/`unmatchGroupAction` dejan el `ledgerHash` del periodo
**idéntico** antes y después. La **propuesta de asiento** sí escribe y por tanto
queda sujeta a I8 y a `resolveEntryDate`: si el devengo cae en un ejercicio no
`OPEN`, se bloquea con mensaje; llevarlo a otro ejercicio es decisión del ADMIN,
nunca del motor.

`VIEWER`: lee `/audit` y `/audit/bank` enteros salvo el bloque `AuditLog`, sin un
solo botón de mutación. **El bloque `AuditLog` es ADMIN**, por coherencia con
`/settings/audit`, que responde `notFound()` a quien no lo es: contiene los
`before`/`after` de la configuración y los motivos de cada administrador, y
enseñárselo a un EDITOR es una fuga de gobierno (hallazgo 5 de la revisión de E2).

### 4.4 Movimiento sin asiento ⇒ **propuesta**, nunca automatismo (O-4)

Una comisión de mantenimiento de 3,50 € que nadie ha contabilizado **existe en el
banco y no existe en los libros**. Ignorarla no la concilia: la esconde y deja la
572 permanentemente corta sin que ningún check lo diga.

```
línea de extracto UNMATCHED
   └─ «Proponer asiento» ──→ ExtractionProposal precargada
                              (importe, fecha de operación, contrapartida
                               elegida por el usuario de una lista del MAPA)
        └─ previewFromProposal()  ← el MISMO código que el camino documental
             └─ confirmación HUMANA (P1, ADR-0005)
                  └─ postFromProposal() → JournalEntry
                       sourceType = BANK_RECONCILIATION · sourceId = statementLineId
                       └─ grupo de conciliación creado en la MISMA transacción
                            └─ AuditLog
```

- **Las cuentas salen de `OrganizationAccountMap`, nunca del código ni del texto
  del movimiento**: `COMISIONES_BANCARIAS` (626), `INTERESES_DEUDAS` (662),
  `OTROS_GASTOS_FINANCIEROS` (669), `INTERESES_DESCUENTO_EFECTOS` (665),
  `DIFERENCIA_CAMBIO_NEGATIVA` (668), `DIFERENCIA_CAMBIO_POSITIVA` (768).
  Deducir la cuenta del concepto del apunte **es auto-punteo por patrón: E12, con
  ADR**.
- **IVA (art. 20.Uno.18º LIVA).** Los servicios financieros están **exentos**: la
  propuesta de una comisión de transferencia, de mantenimiento o de descubierto
  es `626 / 572` por el total, **sin cuota**. Pero la **gestión de cobro de
  efectos** (letra h del mismo artículo), el alquiler de cajas de seguridad y los
  servicios de custodia **están sujetos y no exentos**: llegan con factura y
  **deben entrar por el camino documental (E8)**. La pantalla **bloquea la
  propuesta y lo explica** cuando el usuario elige una cuenta con IVA soportado
  asociado.

---

## 5. Invariantes

### 5.1 Los que E7 introduce

I-E7-1…17 (§3.5), en `lib/audit/invariants-e7.ts`, con test propio sobre fixtures
fijos: extracto vacío; un solo movimiento; importes negativos; **cargo y abono
con aserción de signo N43**; saldo final negativo; dos movimientos idénticos el
mismo día; extracto solapado reimportado; **hueco en la cadena**; cuenta sin
anclaje; **remesa de 14 recibos contra un abono**; **descuento de efectos con
665 y 626**; devolución parcial 1-a-N; empate de candidatos; conciliación con
signo invertido; conciliación de 100 € contra 1 000 € (**la que la ronda 1 dejaba
pasar**); cuenta en USD; `IGNORED` sin evidencia; `AllocationRun` sin `linesHash`;
`checks` alterados por SQL; apertura de N ≠ cierre de N−1; `555` con saldo al
cierre.

### 5.2 Los que E7 puede romper

| Invariante | Cómo | Defensa |
|---|---|---|
| **I1, I-E3-7, I6** | La conversión a `bigint` toca columnas que entran en `canonicalEntryForm` y en `ledgerHash` | Los **valores** no cambian; el borde convierte `bigint → number` como ya hace `models/allocations.ts`, con `Number.isSafeInteger` y excepción por encima de 2^53−1. Criterio 24 |
| **I-E6-16** (`report_runs` inmutable) | El script de `ReportType` levanta `FORCE` sobre filas selladas | Operador, `app_maintenance`, marca previa, por organización, con test de que al terminar vuelve a `FORCE` y `app_runtime` sigue recibiendo `42501` |
| **I8 / periodos** | La propuesta de asiento desde el extracto escribe en el diario | Pasa por `postFromProposal` y `resolveEntryDate` como cualquier otro asiento; bloqueo explícito si el ejercicio no está `OPEN` (O-13) |
| **I10 / aislamiento** | Seis tablas nuevas con el dato más sensible del ERP | `enforce_tenant_rls`, `TENANT_MODELS` y `tests/integration-rls/e7-tenant.test.ts` con 0 filas y `42501` sin GUC |
| **P7 (reproducibilidad)** | Un check que dependa de configuración editable daría resultados distintos sobre el mismo `ledgerHash` y `gitSha` | `matchToleranceDays` **fuera** de los invariantes (O-10); `configHash` en el sello y en la clave de caché (O-20) |
| **P3 (snapshot)** | Un `InvariantRun` por render sería ruido | Sólo se persiste con `persist`: barrido explícito, programado o post-cierre |

### 5.3 Lugar en el sello

Un FAIL de I-E7-* entra en `validacion.json` como cualquier otro y sella el
periodo `REQUIERE REVISIÓN` con motivo `INVARIANTE_FAIL`. Los cuatro motivos
nuevos —`CONCILIACION_PENDIENTE`, `ALMACEN_NO_BARRIDO`,
`PARTIDA_EN_TRANSITO_ANTIGUA`, `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER`— son de tipo
`AVISO`/`ENTORNO`: **no** convierten un informe correcto en sospechoso, pero
impiden que una cifra suba a `✓ validado contra fuente`.

---

## 6. UI

| Ruta | Contenido | Rol |
|---|---|---|
| `/audit` | **Resumen**: sello del último `InvariantRun` con motivos, alcance, `refDate`, `gitSha`, duración; **los cinco hashes** (incluido `configHash`); botón **Ejecutar barrido** | VIEWER lee |
| `/audit` §Familias | Siete tarjetas con semáforo y recuento. Al abrir: checks con **evidencia literal** y **Ver registros de origen**, que abre la tabla de su `query` con enlace a cada asiento y a su documento. **3 clics**: familia → check → registros | VIEWER |
| `/audit` §**Cuadres de cierre** *(O-18)* | Vista curada, **en lenguaje de cierre**, no por id de check: *Sumas y saldos por mes* (I-E7-17, art. 28.1 CCom) · *Continuidad con el ejercicio anterior* (I-E7-14) · *Saldos contrarios a su naturaleza* (I-E7-15) · *Cuentas puente con saldo* (I-E7-16: `555`, `551`, `4749`) · *Antigüedad de saldos* (aging de 430/400/410 e I-E6-14/15) · *Puentes fiscales* con **el modelo y el periodo** («303 · 2026-Q4»), no con el id (I-E8-15a/b/c, I-E8-17) | VIEWER |
| `/audit` §Calidad de datos | Los `dataQualityWarnings` de E8 con recuento y **acción**; más `AllocationRun` con `lines_hash` NULL (periodo, fecha, botón **Re-liquidar**) y los hallazgos del último barrido del almacén | VIEWER lee · EDITOR actúa |
| `/audit` §Almacén | Último `StoreSweep` con **progreso en vivo** (n/total, MB, ETA), hallazgos por tipo, **Barrer** / **Cancelar** | ADMIN |
| `/audit` §Registro | `AuditLog` filtrable por entidad, acción, autor y fecha, **paginado por cursor** | **ADMIN** |
| `/audit` §Historial | `InvariantRun` con sello, alcance, disparador y contadores; selección de **dos** → **Comparar** | VIEWER |
| `/audit/runs/[id]` | La foto: checks por familia, `coverage`, los cinco sellos, `headline`, provenance, **Exportar `validacion.json`** (mismo formato que `scripts/run-invariants.ts`) | VIEWER |
| `/audit/runs/diff?a=&b=` | Diff: checks que cambiaron con las dos evidencias, **Δ de las cuatro cifras** (activo, PN+pasivo, resultado, tesorería) *(O-19)*, y **la causa** (`DATOS`/`MOTOR`/`CONFIGURACION`/`VARIOS`) | VIEWER |
| `/audit/bank` | Cuentas con su subcuenta 57x, **anclaje**, saldo contable, saldo del último extracto, **diferencia, pendientes y Σ ignorado**; importar (CSV/N43) con vista previa antes de escribir; aviso si falta anclaje o hay hueco en la cadena | VIEWER lee · EDITOR importa |
| `/audit/bank/[id]` | Dos columnas enfrentadas (extracto ↔ diario) con **selección múltiple a los dos lados** para grupos N-a-M; sugerencias **marcadas como tales** con puntuación y motivos; ambiguas señaladas sin candidato elegido; conciliar/desconciliar (motivo)/ignorar (vocabulario cerrado); **Proponer asiento** para el movimiento sin libros; panel de cuadre I-E7-1 con **pendientes tipados y su antigüedad**, línea propia de ignorados y, en cuenta en divisa, la **diferencia de cambio presentada como tal** | EDITOR |
| `/unsorted/[fileId]` §Split | **Diálogo de reparto por líneas** (deuda de E8): casillas de grupo, N grupos con descripción, totales por grupo calculados por `splitProposal()` **en servidor**, aviso de partición incompleta y de documento no divisible | EDITOR |
| `/settings/reports` | Enlace a `/audit` y `checkFamily` en el diálogo de forzar revisión | ADMIN |

Estados vacío / carga / error en todas. Colores y tipografías de la skill
`ui-erp`; sin semáforo rojo/verde: FALLO con chip de error, AVISO con `#F5A623`.
Fechas con `lib/dates-ui.ts` (`fechaUtc`), **nunca** `toLocaleDateString`
(desajuste de hidratación de E8). En el panel de conciliación, `valueDate` se
**muestra** junto a `operationDate` y se marca cuál manda.

---

## 7. Trazabilidad y el test de error inyectado

**Provenance (C3).** Cada check lleva `{id, family, status, evidencia, query,
provenance: {run_id, ledgerHash, configHash, calculado_por, refDate}}`. Cada
conciliación lleva `{groupId, kind, matchedById, matchedAt, method, scoreBps,
dateGapDays, statementId, fileSha256}`: la cadena llega desde una cifra de
tesorería hasta **los bytes del extracto que el banco emitió**, que es lo que
justifica el badge P6.

**El test de error inyectado, desde la interfaz** (SPEC §C4). No se inyecta el
error en la base: se inyecta en una **copia en memoria** de la entrada del motor.

1. `detectionTestAction` lee la entrada de invariantes del alcance elegido y la
   **congela**;
2. altera **un céntimo** en una línea elegida de forma **determinista** (la
   primera por `(entryDate, entryNumber, lineNo)` del periodo, con la semilla a la
   vista — lección del flaky del criterio 15 de E6: elegir «una cualquiera» hace
   que el resultado dependa del orden de los uuid);
3. ejecuta el **mismo** motor puro sobre la copia;
4. muestra el antes y el después: I1 e I2 en FAIL con evidencia y diferencia, y el
   sello que habría salido.

Nada se escribe en `journal_lines` y no se emite `InvariantRun` (resultado marcado
`PRUEBA`). Un producto que ofrece «corromper la contabilidad para probar que lo
detecta» acaba con alguien pulsándolo en producción. La variante destructiva
—`UPDATE` real como `app_maintenance`— **sigue en los tests** (criterio 17), que
es donde tiene que estar.

---

## 8. Rendimiento

Medido en `tests/integration/perf-audit.test.ts` sobre `ejercicio-completo`, **por
cargador** —lo que E6 dejó pendiente— y con los techos de E6: ≤ 2 conexiones
simultáneas por petición y una transacción por render.

| Camino | Techo |
|---|---|
| `/audit` (resumen + familias + cierre + calidad, sin barrer) | < 500 ms · 1 transacción |
| Barrido de un ejercicio (`FISCAL_YEAR`) | < 3 s en el fixture; INFO honesto por encima de `MAX_MATERIALIZED_ENTRIES` |
| `/audit/bank/[id]` con 5 000 líneas y 5 000 apuntes | < 800 ms, agregados en SQL, paginado |
| `suggestMatches` 5 000 × 5 000 (con agrupación por `reference1`) | < 700 ms; índice por `(amountCents, operationDate)` y por `reference1` en memoria, **nunca** producto cartesiano |
| `/audit` §Registro con 100 000 `audit_logs` | < 300 ms, paginación por cursor |

Decisiones: barrido **incremental por ejercicio** (alcance por defecto);
agregados en SQL (saldos de 57x, recuentos, `headline`), nunca materializar el
diario; **caché por los cinco hashes** —`configHash` incluido (O-20)—, mostrando
el run existente y ofreciendo «Ejecutar de nuevo»; el barrido del almacén **en
cola** (`ai/queue.ts` + `Progress`/SSE, lotes de 50, `sha256` en streaming,
cancelación entre lotes), nunca en la petición; M4 medida en un clon del preview
antes de tocar producción.

---

## 9. Seguridad

- Las seis tablas nuevas: `enforce_tenant_rls`, `TENANT_MODELS`, FK compuestas por
  tenant, sin `DELETE`.
- **Los extractos son el dato más sensible que el ERP va a almacenar.** `VIEWER`
  los ve (es información de gestión), pero el fichero original se sirve por el
  camino controlado (`/files/preview`), con `organizationId` en la ruta física y
  `410` si no está.
- Importación: mimetype y tamaño validados, `sha256` en servidor, parseo sin
  `eval` y sin regex catastrófico; fichero que no cuadra, rechazado entero.
- `detectionTestAction`: ADMIN, no escribe, y su ejecución queda en `AuditLog`.
- `scripts/migrate-cashflow-report-type.ts` y `scripts/prune-runs.ts` abortan si
  falta `DATABASE_URL_MAINTENANCE` o si el rol no tiene `BYPASSRLS`.
- RLS en `users` con rol `app_auth` separado (§2.8).
- Sin SQL interpolado: las `query` de provenance que la UI ejecuta son
  **parametrizadas y de la lista blanca del motor**; una `query` no viaja nunca
  desde el cliente para ejecutarse tal cual.

---

## 10. Decisiones de Nivel 2 y ADR

`docs/adr/0015-auditoria-bigint-conciliacion-retencion.md`, **APROBADO** el
2026-09-07, seis decisiones. Bloqueaban T3 (M3, camino crítico), T4, T6, T14 y
T15; con la firma, ninguna tarea de E7 queda a la espera.

| D | Decisión | Por qué Nivel 2 |
|---|---|---|
| **D1** | `journal_lines` a **`bigint`** | Esquema del diario y motor contable |
| **D2** | La conciliación es la fuente de `✓ validado contra fuente`, **por composición** (caja excluida) y con `explicado` definido | Semántica de una etiqueta de C5 |
| **D3** | **Retención** de runs; extractos y su `File` **no se purgan** (6/10 años) | C1 y conservación mercantil |
| **D4** | **`ReportType.CASHFLOW`** con `method` en `params` | Clave de caché de un informe e histórico sellado |
| **D5** | **RLS en `users`** con políticas por rol y `app_auth` | RLS es Nivel 2 (CLAUDE.md) |
| **D6** *(nueva, ronda 2)* | **Esquema de la conciliación**: `BankMatchGroup` N-a-M (O-3), divisa en la línea (O-5), anclaje en la cuenta (O-1), `dateGapDays` sellado y la tolerancia de fechas fuera de los invariantes (O-9/O-10) | Cambia M3, define I-E7-2/11/12 y toca la reproducibilidad P7 |

---

## 11. Criterios de aceptación (Given / When / Then)

1. **Barrido sellado y reproducible.** *Given* `ejercicio-completo`, *when* se
   ejecuta un barrido `FISCAL_YEAR` con `refDate` explícita, *then* se persiste un
   `InvariantRun` con **los cinco hashes**, `gitSha`, `headline`, `durationMs` y
   todos los checks de I1–I10, I-E3-*, I-E4-*, I-E5-*, I-E6-*, I-E8-* e I-E7-*;
   *and when* se repite sin tocar nada, *then* `checksHash` es **idéntico** y se
   ofrece el run existente.
2. **Semáforo honesto.** *Given* 80 000 asientos, *then* las familias no evaluadas
   salen **`SIN_EVALUAR`** con motivo en `coverage` y **ninguna** en verde. Test
   que falla si un INFO se pinta como OK.
3. **Drill-down en 3 clics.** *Given* I2 en FAIL, *when* familia → check → «Ver
   registros de origen», *then* ve las líneas de la diferencia y llega al asiento
   y a su documento. Se mide contando navegaciones en el e2e.
4. **Diff con causa y con cifras.** *Given* mismo `ledgerHash` y distinto
   `gitSha`, *then* `cause: "MOTOR"`; *given* mismo `gitSha` y distinto
   `ledgerHash`, `"DATOS"`; *given* sólo un umbral cambiado, **`"CONFIGURACION"`**;
   ningún caso devuelve `"NINGUNA"` con deltas. *And then* el diff muestra los
   **Δ de activo, PN+pasivo, resultado y tesorería** con su provenance.
5. **Calidad de datos pintada.** *Given* 3 documentos sin asiento, 1 extracción
   parcial y 1 duplicado forzado, *then* `/audit` los muestra con recuento exacto
   y enlace a donde se resuelven; *and* los `AllocationRun` sin `linesHash` salen
   con periodo, fecha y botón de re-liquidar.
6. **Barrido del almacén completo.** *Given* 500 ficheros de los que 3 no
   respaldan asiento y 1 de esos falta, *then* aparece como `MISSING` (I-E8-2 sola
   no lo veía), `filesTotal = 500`, progreso visible sin bloquear; *and* I-E7-8
   pasa a PASS sólo tras un barrido `DONE` posterior al último fichero ingerido.
7. **Importación idempotente y solapada.** *Given* un N43 de 120 movimientos,
   *when* se importa dos veces, *then* la segunda no crea ni una línea y lo dice;
   *and given* un extracto que solapa 30, *then* se importan sólo los 90 nuevos y
   los 30 se declaran.
8. **Dos movimientos idénticos el mismo día.** *Then* se importan **los dos** (el
   ordinal del día entra en el `sha256`) y ninguno se pierde.
9. **Cuadre I-E7-1 con la identidad correcta.** *Given* una cuenta anclada, con
   cadena completa, un cheque emitido en diciembre y cargado en enero, *then*
   `E − B = Ue − Ub` da **PASS** con ese pendiente enumerado y tipado
   `CHEQUE_EMITIDO_NO_CARGADO` — *con la fórmula de la ronda 1 salía FAIL sin
   error contable alguno*. *When* se altera un céntimo por SQL, *then* **FAIL**.
10. **Anclaje y hueco en la cadena.** *Given* una cuenta **sin** anclaje, *then*
    I-E7-1 sale **INFO**, jamás PASS, y el badge no se concede. *Given* un hueco
    entre dos extractos, *then* I-E7-6b **FAIL** e I-E7-1 **INFO**.
11. **`OPENING` cuenta y `CLOSING` no.** *Given* el 2 de enero del ejercicio
    siguiente, *then* `B` incluye el asiento de apertura y I-E7-1 cuadra; *given*
    el 31 de diciembre con el asiento de cierre posteado, *then* `B` lo excluye y
    sigue cuadrando. Con los dos criterios invertidos, el test falla.
12. **Remesa N-a-1.** *Given* 14 apuntes al debe de 572 y **un** abono de
    8 420,00 €, *when* se agrupan, *then* I-E7-11 en PASS, I-E7-1 sigue exacta y
    los 14 apuntes quedan `MATCHED`. *And given* un descuento de efectos (nominal
    − `665` − `626`), *then* el grupo cuadra contra el abono neto. *And given* una
    devolución parcial, *then* el grupo 1-a-N cuadra.
13. **Punteo desigual imposible.** *When* se intenta conciliar 100,00 € contra
    1 000,00 €, *then* `createMatchGroupAction` **lo rechaza en servidor** e
    I-E7-2 lo detectaría en el barrido — *la ronda 1 lo dejaba pasar y sólo
    afloraba como una diferencia sin nombre*.
14. **Ejercicio cerrado.** *Given* un ejercicio `CLOSED`, *when* se concilia y se
    desconcilia, *then* funciona y el **`ledgerHash` del periodo es idéntico**
    antes y después; *when* se intenta **proponer un asiento** con devengo en ese
    ejercicio, *then* se bloquea con mensaje.
15. **Comisión sin asiento.** *Given* un cargo de 3,50 € por mantenimiento sin
    apunte, *then* **no es ignorable**; *when* se propone asiento, *then* la
    cuenta sale de `COMISIONES_BANCARIAS` del mapa, la propuesta es `626 / 572`
    **sin cuota** (art. 20.Uno.18º), pasa por `previewFromProposal`, exige
    confirmación humana y, al confirmar, crea asiento **y** conciliación en la
    misma transacción; *and given* que el usuario elige una cuenta con IVA
    soportado asociado (gestión de cobro de efectos), *then* la pantalla
    **bloquea** y remite al camino documental.
16. **Ignorados acotados y apunte de 0,00 €.** *When* se marca `IGNORED` con
    `YA_CONTABILIZADO_EN_OTRA_CUENTA` **sin** `journalLineId`, *then* se rechaza;
    *and then* `Σ ignorado` aparece como **línea propia** del cuadre y, por encima
    del umbral, I-E7-13 sale WARN con la lista. *And given* un extracto con un
    apunte de **0,00 €** (m2), *then* se importa —no se rechaza—, nace `IGNORED`
    con `IMPORTE_CERO` sin exigir evidencia, `lineNo` sigue **correlativo sin
    huecos** (I-E7-5 PASS), `lineCount` coincide con el **registro 33** (I-E7-6a
    PASS), I-E7-1 no se mueve y el WARN de materialidad **no** se dispara.
17. **Error inyectado — las dos formas.** (a) *When* se altera una línea por SQL
    como `app_maintenance`, *then* el siguiente barrido da I1/I2 en FAIL con
    evidencia y consulta, **en menos de 1 minuto**. (b) *When* un ADMIN pulsa
    «Prueba de detección», *then* ve el FAIL simulado y **`journal_lines` no ha
    cambiado** (`ledgerHash` idéntico) y no se ha escrito ningún `InvariantRun`.
18. **`checksHash` recomputado.** *When* se edita `checks` por SQL, *then* I-E7-7
    **FAIL** nombrando el run; `UPDATE`/`DELETE` como `app_runtime` → `42501`.
19. **Badge P6 por composición y retirada retroactiva.** *Given* un periodo con la
    572 íntegramente conciliada y **sin caja**, *then* la tesorería del cashflow
    sale `✓ validado contra fuente` con enlace al extracto; *given* que la
    organización **tiene caja**, *then* la tesorería total del balance **nunca**
    lo lleva, y sí lo lleva el detalle por cuenta bancaria; *given* un pendiente
    sin explicar según el criterio de §3.6, *then* vuelve a `✓ comprobado
    automáticamente`; *and when* en febrero se importa un extracto con un
    movimiento de **fecha de operación de diciembre**, *then* el badge ya
    concedido sobre diciembre **se retira** (se deriva en lectura, no se persiste).
20. **Divisa.** *Given* una cuenta en USD, *then* el cuadre se hace **en USD** con
    tolerancia 0; *when* se importa un extracto en EUR sobre ella, *then* se
    rechaza entero; *and then* la diferencia entre el saldo en euros y
    `saldo USD × tasa de cierre` se presenta como **diferencia de cambio**
    (I-E7-12), **nunca** como pendiente de conciliación, y sin asiento de
    `768`/`668` a fecha de cierre sale WARN con su importe.
21. **Norma 43 fiel.** *Given* el fixture con **un cargo y un abono**, *then*
    `1` ⇒ `amountCents < 0` y `2` ⇒ `> 0`, con aserción explícita; *given* un
    saldo final negativo, *then* se importa; *given* fecha `981231`, *then* se
    parsea como **1998**; *given* un importe que desborda, *then* el fichero se
    **rechaza**, nunca se trunca; *and then* `reference1` se guarda aparte y es lo
    que agrupa la remesa; *and then* `lineCount` se coteja contra el **registro
    33**.
22. **Corte por fecha de operación.** *Given* un pago con operación 30/12 y valor
    02/01, *then* pertenece a diciembre en el cuadre y en el informe; *and* la
    sugerencia que casa por fecha valor lo declara con el motivo `FECHA_VALOR` y
    puntuación menor, sin decidir.
23. **La configuración no mueve un check sellado.** *Given* un barrido sellado,
    *when* un ADMIN baja `matchToleranceDays` de 5 a 2, *then* **ningún check del
    run cambia** (la tolerancia no es invariante), el `configHash` sí cambia, la
    caché **no** sirve el run anterior y el diff dice `cause: "CONFIGURACION"`.
24. **`bigint` sin mover un céntimo, y el borde de JS.** *After* M4, *then*
    `ejercicio-{minimo,completo}` siguen **byte a byte**, `entryHash`/`ledgerHash`
    de los 84 asientos no cambian y `estados-esperados.json` y
    `pyg-analitica-esperada.json` cuadran. *And* (a) `canonicalEntryForm` recibe
    `number`, **nunca** `BigInt` ni `string` (test de tipo + JSON canónico idéntico
    antes y después de M4 — serializar como cadena `"1234"` cambiaría el hash sin
    cambiar una cifra); (b) el borde comprueba `Number.isSafeInteger` y **lanza**
    por encima de 2^53−1 en vez de perder precisión en silencio; (c) una línea de
    25 000 000,00 € recorre postear → agregar → hash → informe.
25. **Cuadres de cierre.** *Then* la vista los nombra en lenguaje contable y:
    I-E7-14 detecta una apertura de N que no cuadra con el cierre de N−1;
    I-E7-15 marca un `430` acreedor; I-E7-16 declara **hallazgo** un `555` con
    saldo al cierre; I-E7-17 cuadra Σdebe = Σhaber **mes a mes**; los puentes al
    303/111/115 se muestran con **modelo y periodo**.
26. **`ReportType` unificado.** *Given* runs históricos de los dos tipos, *when*
    corre el script, *then* quedan como `CASHFLOW` con `method` en `params` y
    `paramsHash` recalculado, el histórico sigue abriéndose, el CHECK queda
    validado y `report_runs` vuelve a `FORCE` (verificado por test).
27. **Split N-a-1 en pantalla.** *Given* una factura de 6 líneas y 2 grupos,
    *then* los totales por grupo salen con la cuota por mayor resto y
    `Σ cuotas = cuota del documento`; *when* deja una línea fuera,
    `SPLIT_NOT_A_PARTITION`; *given* retención, el diálogo no se abre y lo explica.
28. **Roles.** `VIEWER` ve `/audit` y `/audit/bank` sin un botón de mutación y
    **no ve** el bloque `AuditLog`; `EDITOR` barre y concilia pero no fuerza
    revisión, no da de alta cuentas ni lanza el barrido del almacén; `ADMIN` todo.
    Cada negativa se comprueba **en servidor**.
29. **Tenant.** `tests/integration-rls/e7-tenant.test.ts`: sin GUC, las seis tablas
    nuevas devuelven **0 filas** y `42501`; ninguna queda en `NO FORCE`; una línea
    de extracto de otra organización no es visible ni conciliable.
30. **Rendimiento por cargador.** Los cinco techos de §8, con «un render abre
    exactamente 1 transacción» y ≤ 2 conexiones. Cierra la deuda de E6.

---

## 12. Plan de tareas

| # | Tarea | Depende de | Agente | Nivel | h |
|---|---|---|---|---|---:|
| **T1** | ~~**ADR-0015 (D1…D6) a firma humana**~~ · **HECHA**: **APROBADO** el 2026-09-07 (permiso delegado de Pablo de 2026-09-04). Desbloquea T3, T4, T6, T14 y T15 | — | arquitecto | 2 | 8 |
| **T2** | Prisma: `InvariantRun` (+`configHash`, `headline`), `StoreSweep`, `BankAccount`, `BankStatement`, `BankStatementLine`, **`BankMatchGroup`**, `BankReconciliation`, once enums (incl. `CheckFamily`, `IgnoreReason`, `MatchGroupKind`), tres `AccountKey`, `SourceType.BANK_RECONCILIATION`, columnas de `ManualReviewFlag`; `TENANT_MODELS`; **`lib/audit/**` y `lib/bank/**` en el guard de pureza y en CI** | — | dev-backend | 2 | 10 |
| **T3** | Migraciones **M1/M2/M3**: enums, auditoría, conciliación con el esquema de **D6** (grupos, divisa, anclaje, `dateGapDays`, CHECK 572–575, `@@unique` de `accountCode`, vocabulario de ignorado con evidencia, índices únicos parciales por grupo vivo); append-only y semi-append-only con `GRANT` de columna + trigger; seed de las tres `AccountKey`; tests de integración del SQL | T1, T2 | dev-backend | 2 | 24 |
| **T4** | Migración **M4** (`bigint`) + conversión en el borde con `Number.isSafeInteger` + medición en clon de preview + **las tres aserciones del criterio 24** | T1, T2 | dev-backend | 2 | 14 |
| **T5** | `lib/audit/{families,run,diff}.ts` + `checksHashOf` + `configHashOf` + `headline` + diff con **cifras y `cause: CONFIGURACION`**; tests | T2 | dev-backend | 2 | 16 |
| **T6** | `lib/audit/invariants-e7.ts` (**I-E7-1…17**, con 6a/6b y la identidad `E−B=Ue−Ub`, pendientes tipados y envejecidos) + `lib/audit/confidence.ts` (badge por composición y `explicado`) + los 21 fixtures adversariales de §5.1 | T1, T5 | dev-backend | 2 | 30 |
| **T7** | `lib/bank/{csv,n43,hash}.ts`: parseo puro con registros 11/22/23/24/33/88, **tabla de signos**, ventana de siglo, desbordamiento, dos referencias y conceptos, divisa; forma canónica y `sha256`; fixtures de 3 bancos + N43 con cargo, abono y descubierto | T2 | dev-backend | 2 | 22 |
| **T8** | `lib/audit/bank-match.ts`: puntuación por `operationDate` con `FECHA_VALOR` secundaria, **agrupación N-a-1 por `reference1`**, empates sin sugerencia, pasadas deterministas; test de estabilidad byte a byte y de 5 000 × 5 000 | T7 | dev-backend | 2 | 20 |
| **T9** | `models/{audit,store-sweep,bank}.ts` + `runLedgerInvariants({persist})` + `headlineFigures` + `pendingItems` tipados + `listStaleAllocationBackedRuns`; agregados SQL, sin N+1, lecturas en serie | T3, T5, T6 | dev-backend | 2 | 24 |
| **T10** | Barrido del almacén: trabajador en cola (`ai/queue.ts` + `Progress`/SSE), lotes de 50, streaming, cancelación, cota de hallazgos | T9 | dev-backend | 1 | 12 |
| **T11** | `forms/{audit,bank}.ts` + `app/(app)/audit/actions.ts`: matriz de roles, **revalidación en servidor de I-E7-2/11**, grupos N-a-M, ignorado con evidencia, recomputo de sugerencia al aceptar, lock de barrido, `detectionTestAction`; test de `ledgerHash` intacto tras conciliar | T9, T10 | dev-backend | 2 | 20 |
| **T23** | **Propuesta de asiento desde el extracto** (O-4): las tres `AccountKey` en el seed y en la UI del mapa, adaptador `statementLine → ExtractionProposal`, `previewFromProposal`/`postFromProposal` sin tocar, `SourceType.BANK_RECONCILIATION`, conciliación en la misma transacción, **bloqueo por IVA del art. 20.Uno.18º** | T11 | dev-backend | 2 | 14 |
| **T12** | **UI `/audit`**: resumen con los cinco hashes, siete familias con evidencia y drill-down, **§Cuadres de cierre**, calidad de datos con acción, §Almacén con progreso, §Registro paginado (ADMIN), §Historial | T11 | dev-frontend | 1 | 28 |
| **T13** | **UI `/audit/runs/[id]`**, `/audit/runs/diff` con **Δ de cifras** y causa, export de `validacion.json`, diálogo de forzar revisión con `checkFamily` | T12 | dev-frontend | 1 | 14 |
| **T14** | Migración **M5** (RLS en `users`) + rol `app_auth` + segundo cliente Prisma para better-auth + `.env.example` + test RLS y e2e de login | T1, T3 | dev-backend | 2 | 10 |
| **T15** | **D3/D4**: `scripts/prune-runs.ts` con la política y la **protección de los `File` de extracto**; `scripts/migrate-cashflow-report-type.ts`; unificación de `CASHFLOW` en `forms/reports.ts`, `models/reports.ts` y `/reports/cashflow` | T1, T3 | dev-backend | 2 | 16 |
| **T16** | **UI `/audit/bank`** y `/audit/bank/[id]`: alta con **anclaje**, mapeo CSV, importar con vista previa, dos columnas con **selección múltiple para grupos N-a-M**, sugerencias con puntuación y ambiguas, conciliar/desconciliar/ignorar, **Proponer asiento**, panel de cuadre con pendientes tipados, Σ ignorado y diferencia de cambio | T11, T23 | dev-frontend | 1 | 32 |
| **T17** | **UI del split N-a-1** en `/unsorted/[fileId]` (deuda de E8) | T11 | dev-frontend | 1 | 12 |
| **T18** | `scripts/run-invariants.ts` con `--persist` y `--trigger SCHEDULED`; formato de `validacion.json` sin cambios | T9 | dev-backend | 1 | 4 |
| **T19** | Integración + RLS: `e7-auditoria.test.ts` (criterios 1–27), `e7-tenant.test.ts` (29), `perf-audit.test.ts` (30, **por cargador**) | T12, T13, T16, T17 | qa | 1 | 26 |
| **T20** | e2e Playwright: barrido → familia → check → registros → documento (3 clics); importar N43 → agrupar remesa → cuadre; comisión → proponer asiento → confirmar; prueba de detección; split; VIEWER sin botones | T19 | qa | 1 | 18 |
| **T21** | Auditoría de fiabilidad en contexto limpio: reconstruir por SQL/Python `E − B = Ue − Ub` de dos cuentas y las cuatro cifras de `headline`, verificar el badge y su retirada retroactiva, error inyectado real (17a) y `checksHash` alterado (18) | T19 | qa | 2 | 14 |
| **T22** | Cierre documental: `MODELO-DATOS.md` (bloque E7), `ARQUITECTURA.md` (`lib/audit`, `lib/bank`, rutas), skill `fiabilidad` (I-E7-*, cuatro motivos nuevos, regla del badge P6), `README-FIABILIDAD.md` inicial (adelanta E12), `ESTADO.md` con la deuda cerrada y la nueva fechada, ROADMAP E7 → CERRADA, `runs/registro.jsonl`, ADR-0015 → APROBADO | T20, T21 | arquitecto | 1 | 12 |

**Total: 400 h** (~50 jornadas, 23 tareas; **+82 h sobre la ronda 1**: los grupos
N-a-M, la divisa, el anclaje, la propuesta de asiento, los cuatro cuadres de
cierre, el `configHash` y la fidelidad al cuaderno 43). **Camino crítico:**
T1 → T2 → T3 → T5/T6 → T9 → T11 → T23 → T16 → T19 → T20/T21 → T22.
T4, T14 y T15 corren en paralelo desde T1/T3 y **no bloquean** la pestaña.
T7 y T8 son independientes desde T2; T17 desde T11.

---

## 13. Riesgos y alternativas descartadas

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | **La conversión a `bigint` bloquea la tabla más grande** | Medida antes en un clon del preview, ventana documentada; los valores no cambian y el test de fixtures byte a byte es la red. Descartado: tabla nueva + copia + `RENAME` (triplica el riesgo sobre la fuente única de cifras) |
| **R2** | **La sugerencia se percibe como conciliación**: alguien acepta 300 sin mirar y el badge miente | Nunca se puntea solo; ids explícitos y **recomputo en servidor**; empate ⇒ sin sugerencia; cada conciliación guarda autor, método, puntuación y `dateGapDays`; I-E7-2/11 revalidan al escribir **y** en el barrido, con tolerancia 0 |
| **R3** | **Semáforo en verde con la mitad sin evaluar**: el fallo más peligroso de una pestaña de auditoría | `SIN_EVALUAR` como estado propio, `coverage` obligatorio, criterio 2 con test que falla si un INFO se pinta como OK |
| **R4** | **El cuadre no cuadra nunca** en una empresa real y la pestaña se abandona | Es exactamente lo que la ronda 1 producía. Corregido con la identidad `E−B=Ue−Ub`, los grupos N-a-M, los pendientes tipados y la propuesta de asiento: los tres hechos bancarios ordinarios que el modelo no representaba |
| **R5** | **`IGNORED` como vertedero**: el cuadre «cierra» con el saldo mal | Vocabulario cerrado con evidencia obligatoria, I-E7-13, Σ ignorado como línea visible y WARN por materialidad |
| **R6** | **La prueba de detección corrompe datos reales** | No escribe: copia en memoria y motor puro (§7). La destructiva vive en los tests |
| **R7** | **El barrido del almacén tumba el servidor** con 20 000 ficheros | Cola, lotes, streaming, cancelación, hallazgos acotados a 1 000 + contador |
| **R8** | **Un cambio de configuración mueve checks ya sellados** y rompe P7 | `matchToleranceDays` fuera de los invariantes, `dateGapDays` sellado en el hecho, `configHash` en el sello, la caché y el diff |
| **R9** | **Signo o siglo invertidos en la N43**: cuadran consigo mismos y son indetectables | Tabla de signos escrita, fixture con cargo, abono y descubierto con aserción explícita, ventana de siglo constante documentada, cotejo con el registro 33 |
| **R10** | **RLS en `users` rompe el login** | Rol `app_auth` con política propia y e2e completo antes de promover; si se complica, D5 se aplaza **con justificación escrita** en vez de quedarse a medias |
| **R11** | **La migración de `ReportType` rompe el histórico sellado** | Script reanudable con marca previa, `paramsHash` con **la misma función** de la aplicación, baile `NO FORCE`/`FORCE` verificado por test |
| **R12** | **`InvariantRun` crece sin límite** | Cota de 1 MB por fila, política D3 y `prune-runs.ts` desde el día 1; automatización fechada en E9 |

**Alternativas descartadas:**

- **`DataQualityIssue` como tabla con estado «resuelto»**: segunda verdad sobre un
  hecho derivable, y un botón para tapar avisos.
- **Conciliación estrictamente 1:1** (la ronda 1). No representa una remesa, una
  nómina en un cargo global, un descuento de efectos ni una devolución parcial.
- **Marcar `IGNORED` la comisión que nadie contabilizó.** Esconde el problema y
  deja la 572 permanentemente corta.
- **Deducir la cuenta de la comisión del texto del apunte.** Auto-punteo por
  patrón: E12 y con ADR.
- **Auto-punteo por reglas.** Útil, y es E12: el atajo no se construye antes que
  el camino.
- **Similitud textual con umbral** (Levenshtein, embeddings). Sugerencias
  inexplicables que cambian al cambiar de modelo; viola P1 y P7.
- **Usar el LLM para clasificar movimientos bancarios**: la cifra que sale de un
  modelo que ADR-0005 y P1 prohíben.
- **Cortar el cuadre por fecha valor.** Mueve movimientos a través del cierre.
- **La tolerancia de fechas como invariante.** Deja el barrido en FAIL perpetuo
  por un cheque de 40 días y hace que configuración editable mueva checks
  sellados.
- **Conciliar contra el `JournalEntry`**: un traspaso mueve dos bancos.
- **Una `BankAccount` contra una 572 agregada.** Imposible de cuadrar; el modelo
  lo impide, no lo advierte.
- **Cuadrar en euros una cuenta en divisa.** La diferencia incluiría la variación
  de la tasa, que no es una partida en tránsito.
- **Un `AuditRun` que además recalcule informes.** Auditar cambiaría el estado que
  se audita.
- **Rellenar por script los `linesHash` que faltan.** Una firma sobre lo que haya
  hoy no es un sello.
- **Una segunda función de sellado para la auditoría.** El sello es uno.
- **Materializar el saldo bancario conciliado o el badge P6.** ADR-0003, y un
  badge almacenado no podría retirarse cuando llega un extracto retroactivo.
