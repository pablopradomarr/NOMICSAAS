# ESTADO DEL PROYECTO — punto de reanudación

Actualizado: 2026-09-15 (**✅ E10 CERRADA** · **E11 EN EJECUCIÓN**: olas A, B y C aterrizadas e **INTEGRADAS**, ADR-0019 **D9** aprobado · **SIGUIENTE: cierre de E11**) · Repo: `pablopradomarr/NOMICSAAS` rama `main` · Sesión origen: https://claude.ai/code/session_01HZCqGBP589Lkmf3TNgtTvb

## 🔗 E11 · RONDA DE INTEGRACIÓN DE LAS TRES OLAS (2026-09-15)

Commits de las olas: `4a43350` (A · planes, webhook, serie propia, reloj),
`4358e75` (B · almacén, uso derivado, dos clases de cuota, backup 2.0),
`75a2237` (C · siembra, asistente, pantallas). Esta ronda **cose lo que cada ola
dejó abierto a propósito** y añade la decisión **D9**.

### ADR-0019 · D9 — el SaaS es de USO INTERNO (decisión de Pablo, 2026-09-15)

`BILLING_PROVIDER=none` es **el modo por defecto**. Significa, literalmente:

| | Modo INTERNO (`none`) | Modo de pago (`stripe`) |
|---|---|---|
| Stripe | **Apagado**: `/api/stripe/*` responde **404**, ninguna clave necesaria | D1…D8 tal cual |
| Plan al alta | **`ILIMITADO`** (fila nueva del catálogo: los siete límites a `-1`, **no vendible**, sin `stripePriceId`) | `FREE` |
| `READ_ONLY` por impago | **Nunca.** `accessLevelOf` devuelve `FULL` siempre | Según D6/D7 |
| Facturas de plataforma | **Ninguna**: sin contraprestación no hay operación sujeta (art. 4.Uno LIVA) | Serie `PLT-AAAA-NNNN` (D8) |
| `/settings/subscription` | «Modo interno: sin facturación» + plan + **uso**, sin portal ni facturas | Plan, uso, facturas y portal |
| Cambio de plan | **Acción de administración de plataforma**, con `PlatformAuditLog` (`plan.changed`) y `AuditLog` — es como se **prueban los límites** | Portal de Stripe |

`BLOCKED` sigue existiendo y sigue siendo lo que era: la desactivación que decide
el propio ADMIN de la organización. No es una mora.

### Migración M6 (`20260928090000_e11_m6_plan_ilimitado_bigint`)

Plan `ILIMITADO` + backfill (organizaciones sin suscripción, y las que M4 dejó en
`FREE` **sin haber contratado nada**; ninguna con `stripe_subscription_id` se toca),
con el baile `NO FORCE → backfill → FORCE`. Además cierra las dos deudas que la ola
A aplazó por escrito: **`storage_used` / `storage_limit` a `bigint`** (§2.7 —
`integer` topaba en 2,147 GB contra un plan PRO de 100 GB) y la **retirada de
`ai_balance`** (D1.5, O-14), con la misma guardia y la misma salida de operador
(`app.e11_ai_balance_resuelto`) que M4.

`backup_retention_days` del plan interno es **3650 días** y no `-1`: el CHECK
`plans_gracia_no_negativa` exige `> 0`, y con razón — una retención de cero
caducaría el ZIP en el instante de crearlo.

### Lo que la integración cose entre olas

| Puente retirado | Qué era | Qué hay ahora |
|---|---|---|
| `models/platform-deployment.ts` | `to_regclass` en cada carga para sobrevivir a una instalación sin migrar. Su propio comentario se fechaba: «un puente con fecha de caducidad» | **Eliminado.** Una instalación sin migrar no es un estado que la pantalla dibuje: es un despliegue incompleto |
| `startRestoreAction` se negaba | La ola C no tenía motor; la ola B aterrizó el mismo día | Cableada a `requestBackup` / `runBackupJob` / `restoreBackupIntoOrganization` / `verifyRestore`, con las **seis comprobaciones** a la vista |
| Doble escritura almacén + disco | T7 la declaró transitoria «mientras los lectores no estén cableados» | **Retirada.** Los seis lectores (descarga, vista previa, OCR, ZIP de exportación, volcado del backup y las dos pantallas que comprueban el papel) pasan por `lib/documents.ts` |
| Bloque heredado de `models/backups.ts` | `MODEL_BACKUP`, `modelToJSON`, `modelFromJSON`, `preprocessRowData` (la cuenta `0400` → `400`) y `cleanupOrganizationTables` | **Eliminado**, junto con la ruta 1.0 `/settings/backups/data`, que ahora entrega el ZIP 2.0 del almacén |
| `STORAGE_DRIVER` / `STORAGE_S3_*` frente a `STORAGE_BACKEND` / `STORAGE_*` | Dos juegos de variables para una sola cosa: así se despliega una instalación que cree tener S3 y escribe en `/tmp` | Manda el de `.env.example`; los de la ola B se leen como alias |

### Cuatro defectos que la integración destapó, y su arreglo

1. **`/settings/subscription` no cargaba.** `getUsage` calentaba su caché dentro
   de la transacción `READ ONLY` de `tenantPage`: `25006`, la transacción quedaba
   envenenada y la página entera reventaba. Ahora se **pregunta antes de
   escribir** —capturar llega tarde— y la cifra se devuelve calculada.
2. **La hidratación de `/settings/backups` fallaba** por una hora formateada sin
   `timeZone`: servidor en UTC, navegador en Europe/Madrid. En desarrollo eso deja
   la pantalla **sin JavaScript**, y con ella los dos botones que son la pantalla.
3. **La restauración abortaba con `23505`** por `invitations.token_hash`, que es
   `UNIQUE` global. Copiarlo tampoco valía: **un mismo enlace de invitación daría
   acceso a dos organizaciones**. Se **reemite** en el destino, y `token_hash`
   sale de `derivedSealColumns()` — no es un sello derivado, es un secreto, y
   compararlo castigaría hacer lo correcto.
4. **La suscripción del archivo chocaba** con la que el alta siembra en el destino
   (`UNIQUE (organization_id)`). Se omite, como la membresía de quien restaura:
   la copia conserva sus libros, **no hereda el contrato**.

### Deuda que esta ronda deja abierta, con épica de cierre

| Deuda | Épica | Motivo |
|---|---|---|
| **El ZIP del backup se construye EN MEMORIA** (`JSZip`) | **E12** | Un volcado de 2 GB no cabe en el heap de una función serverless. El troceado en streaming exige cambiar el generador y subir en multipart; no es barato y no cabe en una ronda de integración. Techo medido en §12 |
| **El camino de lectura al disco heredado** (`lib/documents.ts`) | **E12** | Lo subido antes de E11 sólo está en disco. Se retira cuando `scripts/migrate-uploads-to-storage.ts --apply` haya corrido en todos los entornos (runbook `docs/deploy/e11-plataforma.md`) |
| **`organizations.storage_used` / `storage_limit`** siguen vivas y deprecadas | **E12** | La cifra buena es la derivada de `models/usage.ts`, que excluye por `kind` lo que no es cuota del cliente (O-12c). `syncOrganizationStorage` ya las alimenta **desde el almacén**, no desde el disco |
| **Ficheros `static/` (logo, avatar)** siguen en disco | **E12** | Se nombran por su nombre, no por su `sha256`, así que migrarlos al almacén exige un índice que no existe. No son justificantes: son la marca de la organización |

## ✅ E11 DISEÑADA (2026-09-15) — el diseño y su validación

Diseño: `docs/design/E11-plataforma-saas.md` (**726 h / 28 tareas**, tres olas).
ADR: `docs/adr/0019-plataforma-saas.md` — **APROBADO por Pablo el 2026-09-15**
(permiso delegado de 2026-09-04), **D1–D8**. Validación contable
`docs/design/E11-validacion-plataforma.md`: **CONFORME CON OBSERVACIONES** — cinco
bloqueantes (**O-1** los tres hashes no bastan como criterio P7 · **O-3** un límite
de plan impedía registrar un hecho contable ya ocurrido · **O-4** el FREE en mora no
podía ejercer la portabilidad que D6 promete · **O-7** la siembra dejaba
organizaciones que incumplían I-E11-10 por construcción · **O-9/O-10**
`PlatformInvoice` no sostenía una obligación de facturación y nuestra serie no la
vigilaba nadie) y diez no bloqueantes: **las quince incorporadas**, más **O-16**
(subir el justificante se permite en mora; analizarlo con IA no) y **O-17** (el 349
por SQL de runbook mientras no hay pantalla), y **C-1…C-7 respondidas y llevadas al
esquema**. El ADR pasó de seis decisiones a **ocho** (**D7** de O-3, **D8** de
O-9/O-10) y la **D5-CAPEX de la ronda 1 salió** con el alcance, así que este ADR
**ya no enmienda ADR-0018**.

### Deuda que E11 re-fecha, con motivo (recorte 836 → 726 h)

| Deuda | Épica de cierre | Motivo |
|---|---|---|
| **CAPEX en presupuesto** (`BudgetCapexLine`, Q-4 de E10), y con él la **enmienda a ADR-0018 D2** y el reversionado del fixture a `presupuesto-horas-esperado.v1.4.json` | **E12** | Es control de gestión, no plataforma: no comparte una tabla con E11 y no tiene por qué ir empaquetado con Stripe |
| **Granularidad `MONTH` de varios meses**, **desglose mes a mes en el informe** y **descomposición volumen/precio** (Q-6 / ADR-0018 **D6**, convención ya congelada) | **E12** | Mismo motivo; no bloquea nada de plataforma |
| **Contrato del bloque de rentabilidad por proyecto** (C3 de E10) | **E12** | Depende de la celda mensual, que va a E12 con ella |
| **`/admin` de plataforma** (lectura y escritura) | **E12** | Sin escrituras (P-6) su valor es un panel que el operador puede sustituir por SQL durante una épica. En E11 queda `/api/health` |
| **Pantalla de export 303 / 349** | **E14** | **O-17.** Los campos que la alimentan entran en E11 (D8); lo que se aplaza es la pantalla. Mientras tanto, las **dos consultas SQL** del runbook `docs/deploy/e11-plataforma.md`, con test de integración que las ejecuta |
| **Backups programados**, **CSV dentro del ZIP**, **restaurar un ZIP ajeno desde la UI**, **`email-sync` como job de cron** | **E12** | El backup manual y el de salida cubren lo que el ROADMAP pide y lo que O-4 exige; el JSONL es el formato que manda |
| **Lector de `formatVersion 1.0`** | **RETIRADO** | No existe ni un backup 1.0: el preview tiene una organización y nunca se descargó uno |
| **G-20** — sin tests de `models/stats.ts`, `lib/stats.ts`, `ai/*` (BAJA) | **E12** | Detectado al preparar E11: `stats` se reescribió en E6 y `ai/*` en E8, pero **G-20 no aparecía en ninguna lista de cierre de ninguna épica** |
| **«G-15 · facturación emitida completa (PDF, envío, cobro)»** | **E14 Ciclo comercial** (épica nueva) | **Errata de doble numeración.** El `G-15` canónico de `AUDITORIA-FIABILIDAD.md` es **backups**, que E11 cierra. El ciclo comercial no tiene gap `G-` asignado: es alcance funcional nuevo con su propia validación contable. **P-7 aprobado** |

Lo que **sí** cierra E11: G-15 (backups), serie `ORDINARIA` sembrada, mes de alta de
la amortización, calendario de `/time` agregado en SQL, mimetype del import
(PUEDE 14), rate limit en memoria (E13 R4), uploads efímeros en `/tmp` y la falta de
cron en el despliegue.

Registro: `2026-09-15_e11_diseno`.


## ✅ E10 CERRADA (2026-09-15) — siguiente: `/epica E11`

Presupuesto versionado y sellado, horas como unidad entera aprobada, drivers de
actividad con su cuarto sello, forecast derivado y umbrales de desviación.
Cerrada tras **tres rondas de corrección**:

- **auditor-fiabilidad: CONFORME** (ronda 3). En la ronda 0, **DISCREPANCIA** con
  H-1…H-7 —dos GRAVES: los **dieciocho `I-E10-*` que nadie ejecutaba** (el
  montaje no rellenaba los bloques `budget`/`time`, así que la familia
  `PRESUPUESTO` salía siempre `SIN_EVALUAR`) y el **`budgetHash` irreproducible**
  en cuanto se relevaba una versión, porque `valid_to` —que el propio sellado
  reescribe— entraba en la forma canónica—. En la re-auditoría de la ronda 1,
  DISCREPANCIA por cuatro puntos: la **regresión de `I-E10-12`** con el ejercicio
  regularizado, el bloque de absorción del **fixture** que contradecía al motor,
  la **provenance por celda** que devolvía 0 filas en los niveles acumulados y la
  inyección (b) sin run de actividad en el arnés. En la ronda 3, un solo punto
  accionable: `I-E10-12` contaba como personal imputado **todo** lo repartido por
  un driver `HOURS` —también el 628 del CECO— y lo comparaba mes a mes.
- **revisor-codigo: APROBADO** (ronda 2). En la ronda 1, **BLOQUEADO** con 3
  BLOQUEA (los nueve techos de §9 sin medir, tres deudas declaradas en
  `runs/registro.jsonl` que no llegaron a `ESTADO.md`, y el `budgetHash` sin las
  líneas de horas que ADR-0018 D2 exige), 5 DEBE y 7 PUEDE.
- **QA**: BUG-E10-1 (`--reset-org` no vaciaba presupuesto ni horas y las suites
  e2e se contaminaban entre ficheros) y BUG-E10-2 (un parte APROBADO no se podía
  borrar **ni como operador**, de modo que el vaciado moría; cerrado con
  **ADR-0018 D7**, un GUC verificado contra la organización y el rol) cerrados
  con test propio.

**Tests**: unit 2 250 ✓ · integración 2 967 ✓ · RLS 211 ✓ · e2e `presupuesto`
10/10 y `horas-presupuesto-real` 6/6 ✓ · build OK · lint 0 errores · **los nueve
techos de §9 activos** (`tests/integration/perf-budget.test.ts`). Fixture sellado
**v1.3**; v1.0, v1.1 y v1.2 quedan congelados como evidencia de cada ronda. Registros:
`2026-09-15_e10_ronda1`, `…_reauditoria` y `…_e10_cierre`.

**Deuda**, toda fechada abajo en «E10 — ronda 1 de corrección»: el agregado por
(empleado, día) del calendario de `/time`, el contrato del bloque de rentabilidad
por proyecto, la validación de extensión y mimetype del import en el borde y la
granularidad `MONTH` de varios meses — **las cuatro en E11**.

## ✅ E9 CERRADA (2026-09-14)

Cierre de ejercicio, recurrentes y fiscalidad periódica, cerrada tras **tres
rondas de corrección**:

- **auditor-fiabilidad: CONFORME** (ronda 3). En la ronda 0, DISCREPANCIA con
  H-1…H-6 —tres bloqueantes: el **signo de T-32 invertido** (inflaba el pasivo no
  corriente en silencio), los **27 `I-E9-*` que no corrían nunca** (0 de 215
  checks) y la **reapertura imposible** por CA-1—; en la ronda 1, DISCREPANCIA por
  **R-1** (los contra-asientos de la reapertura se fechaban fuera del ejercicio y
  el recierre marcaba `CLOSED` **sin postear** T-26/T-27/T-28) y **R-2** (los 22
  pares sólo existían por el backfill: I-E9-16 pasaba **por vacuidad**); en la
  ronda 2, **CONFORME** con un menor —tras reabrir, el impuesto no quedaba
  pendiente y el recierre podía dejar el ejercicio sin T-25, con `129` recogiendo
  el resultado **antes** de impuestos—, cerrado con `PENDIENTE_RECOMPUTO` en el
  paso, guardia en `closeFiscalYearTx` y test.
- **revisor-codigo: APROBADO** (ronda 2). En la ronda 1, 1 BLOQUEA —el **paso 12
  de O-17** no existía: se sellaba T-32 como su propio contra-asiento— y 8 DEBE.
- **QA**: BUG-E9-1 (`reviseAssetAction` admitía revisiones **retroactivas**,
  contra la NRV 22ª) cerrado con test propio.

Tests del cierre: unit **1 968 ✓** · integración **2 551 ✓** · RLS **185 ✓** ·
lint sin errores · build **OK** · e2e por fichero `cierre` **8/8** y
`recurrentes-iva` **9/9** · los **ocho** techos de `perf-closing` activos.

Lo que queda escrito y no se negocia: **43 pasos / 9 bloqueantes** en el
checklist (el diseño enumeraba 41 en su cabecera y 43 en el detalle; manda el
detalle), **22 pares** de reclasificación (R2-1 hablaba de 23; 527/528 quedan
fuera), clave de periodo canónica **`AAAA-Qn`**, y el interés implícito del
criterio 22 recalculado a mano: **442 817**, el del fixture sellado.

**Siguiente**: `/epica E10` — presupuesto y horas.

### Deuda de E9, fechada en E10

1. **`ejercicio-completo-v2` no se puede cargar**: el fixture es internamente
   incoherente (usa `4751` en sus nóminas **y** la clave `IRPF_A_PAGAR_123` →
   `47513`; al crear la subcuenta la madre deja de admitir apuntes). Exige
   **reversionar el fixture** —es inmutable— y escribir el
   `build_ejercicio_completo_v2.py` que nunca se hizo. → **E10**.
2. **El N+1 de la staleness de CECOs**: sigue derivándose run a run. Medido y
   dentro del techo con doce runs mensuales sellados; agregar los hashes por
   periodo en una sola consulta. → **E10**.
3. **El formulario de alta de inmovilizado no ofrece proyecto ni CECO**: el
   schema los admite desde T15, así que un activo dado de alta **por pantalla**
   en una organización con destino analítico obligatorio no se puede vender
   hasta que alguien le declare el destino por SQL. → **E10**.

## ✅ E7 CERRADA (2026-09-07) — siguiente: `/epica E9`

Auditoría y conciliación bancaria cerradas tras **dos rondas de corrección**:

- **auditor-fiabilidad: CONFORME** (ronda 2). En la ronda 0 dio DISCREPANCIA con
  siete hallazgos —tres ALTA: el cuadre en divisa mezclaba monedas, el `headline`
  se firmaba en cero a 31-12 e I-E7-12 no podía medir nada—; en la ronda 1,
  DISCREPANCIA por **N-1**, que introdujo el propio arreglo de H-3.
- **revisor-codigo: APROBADO** (ronda 2). En la ronda 1, CAMBIOS REQUERIDOS por
  la documentación que ADR-0015 se comprometió a escribir, «explicado» sin
  conectar y las dos pantallas nuevas sin test de rendimiento.
- **QA**: BUG-E7-1 (`--reset-org` no limpiaba las tablas de E7 y rompía la suite
  e2e completa) y BUG-E7-2 (sin medición por cargador), cerrados con test propio.

Tests del cierre: unit **1 552 ✓** · integración **2 042 ✓** · RLS **183 ✓** ·
build **OK** · e2e **35 ✓** (suite completa por fichero, en orden alfabético).

**Siguiente**: `/epica E9` — cierre de ejercicio, regularización de IVA y
asientos recurrentes. Es además donde se **reconoce** la diferencia de cambio
que E7 se limita a medir (I-E7-12, NRV 11ª.2.2), y donde se cerrarán O-1 y O-2
si la práctica pide más de lo que la ronda 2 ya dejó hecho.

## Hecho
| Épica | Estado | Commits |
|---|---|---|
| E0 Base (agentes, docs, ADR 1–7 aprobados, `lib/money.ts`, hook guard) | HECHO salvo CI/Docker | 2168fd7, c3ff192, 83cdf86 |
| E1 T1–T14 (tenancy, roles, RLS con escape, switcher, miembros, invitaciones) | IMPLEMENTADO, **revisión = CAMBIOS REQUERIDOS** | daf199f, 34e41cb, f65f37c, + commit QA |
| E1-fix ronda 1 (3 BLOQUEA + 15 DEBE + PUEDE #19/#20/#21/#24/#25/#26) | IMPLEMENTADO | 143a289 |
| E1-fix ronda 2 (2 BLOQUEA + 7 DEBE + 3 PUEDE de la re-revisión) | IMPLEMENTADO, pendiente de re-revisión | sin commit (working tree) |

QA: PASS condicionado (barrera 1 y authz resisten; migración CA-1 sin test). Revisor: 3 BLOQUEA, 15 DEBE, 8 PUEDE (informe completo en `docs/design/E1-revision.md`, ya con columna "Resolución").

**Sprint E1-fix (2026-09-04) — hecho.** RLS efectiva (`20260904140000_e1_rls_effective`: `app.current_user()`, políticas por pertenencia en `organizations`/`memberships`, `FORCE ROW LEVEL SECURITY`; `tenantDb` fija los GUC en cada operación; `DATABASE_URL`=`app_runtime` / `DIRECT_URL`=owner); ficheros por organización; members ADMIN-only sin escritura en RSC; `NO_ORGANIZATION` → `/organizations/new`; CI con `test:integration` y guard de pureza; validación de subidas; rate limit de invitaciones; aceptación transaccional; Stripe unique + log mínimo. Verificado: `npm run lint` 0 errores, `npx tsc --noEmit` limpio, `npm run test` 107 ✓, `npm run test:integration` 171 ✓, `npm run build` OK.

### Migración de ficheros en disco (obligatoria al desplegar E1-fix)
Las rutas físicas pasan de `uploads/<email>/…` a `uploads/<organizationId>/…`. Antes de arrancar la nueva versión:
```bash
npx tsx scripts/migrate-uploads-to-org.ts            # simulación: enumera qué movería
npx tsx scripts/migrate-uploads-to-org.ts --apply    # ejecuta (idempotente)
```
Resuelve la organización destino por `files.uploaded_by_id` y, en su defecto, por la organización personal del usuario. Sin este paso, los ficheros anteriores dejan de encontrarse (las filas de `files` no cambian: sólo cambia el directorio raíz).

### Deuda RLS retirada en E3 (migraciones `20260906090000_e3_rls_helpers` + `20260906100000_e3_rls_strict`)

**ADR-0009 (APROBADO) aplicado.** Las cinco deudas que introdujeron ADR-0007 y ADR-0008 están cerradas: no queda ninguna cláusula de escape y las **veinte** tablas de negocio (12 de E1 + 4 de E2 + 4 de E3) están en `ENABLE` + `FORCE ROW LEVEL SECURITY`. Una consulta de negocio que salga fuera de `tenantDb` / `tenantTransaction` / `withTenantGucs` ya no ve nada.

| Deuda (ADR-0007 / ADR-0008) | Cómo se ha cerrado |
|---|---|
| `WITH CHECK` de `organizations` con `OR app.current_user() IS NOT NULL` | Retirado. Queda `WITH CHECK (id = app.current_org())`. El alta pasa por un único camino (`createOrganizationWithOwner`), que genera el uuid y lo fija en `app.current_org` antes del INSERT — y desde E3 siembra el plan **en la misma transacción**. |
| Cláusula de escape `OR app.current_org() IS NULL` en los `USING` | Retirada de las dieciséis tablas. `currencies` conserva sólo su rama de catálogo global (`organization_id IS NULL`). |
| Una transacción por operación en `tenantDb` | **Deja de ser deuda de seguridad y queda como coste conocido** (§2.6 del diseño). Agrupados los caminos con ≥ 3 operaciones seguidas: `getOrgContext` (una transacción por petición, vía `getMembershipWithOrganization`), `isLastAdmin`, cada iteración de `runEmailSync` y el alta de organización con su siembra. El resto del código heredado se queda con la envoltura por operación. |
| Cláusula de escape en las cuatro tablas de E2 | Retirada, y `FORCE` activado en las cuatro (no lo tenían). |
| El append-only de `audit_logs` dependía de conectar como `app_runtime` | Cerrada: con `FORCE`, el propietario también queda sujeto a las políticas `RESTRICTIVE … USING (false)`. El registro es inmutable también para las migraciones y para un `psql` de operador. |

**Lo que queda (por diseño, no es deuda).** Tres puertas `SECURITY DEFINER` acotadas, propiedad de `app_maintenance` y con `GRANT EXECUTE` sólo a `app_runtime`, para los accesos que ninguna política puede autorizar: `app.invitation_by_token_hash(text)` (aceptar una invitación: no hay organización ni membresía todavía), `app.list_email_sync_targets()` (el cron enumera pares `(organización, usuario)` y acota cada iteración) y `app.organization_id_by_stripe_customer(text)` (el webhook no tiene sesión). Y el rol **`app_maintenance`** (`BYPASSRLS`, `NOLOGIN` por defecto, credencial en `DATABASE_URL_MAINTENANCE`) para los scripts de operador (`scripts/migrate-uploads-to-org.ts`) y el check de I10 (`scripts/run-invariants.ts`), que sólo puede detectar un cruce si consulta sin filtro de tenant. **La aplicación web nunca conecta con él.**

**Red de seguridad.** ESLint `no-restricted-imports` (importar `prisma`) + `no-restricted-syntax` (usar `prisma.<modelo de negocio>` dentro de la lista blanca) y la suite `test:integration:rls`, que demuestra tabla por tabla que **sin GUC no se lee (0 filas) ni se escribe (42501) nada**, que ninguna tabla queda en `NO FORCE` y que no sobrevive ninguna cláusula de escape.

**Patrón obligatorio para backfills futuros (ADR-0009 §7).** Con `FORCE`, una migración que actualice datos de negocio no ve nada. Hay que envolverla en `ALTER TABLE x NO FORCE ROW LEVEL SECURITY; … ; ALTER TABLE x FORCE ROW LEVEL SECURITY;` dentro de la misma migración, o ejecutarla como `app_maintenance`. Documentado también en `CLAUDE.md`.

### Deuda anotada: una transacción por operación — **CERRADA (E6-perf, 2026-09-05)**

**Cómo se ha cerrado.** Toda petición web abre **una sola** transacción de tenant y la publica en el AsyncLocalStorage; `tenantDb(orgId)` —y el `db` que devuelve `requireOrg`— la encuentran ahí y despachan **dentro** de ella en lugar de abrir una por operación. Nada cambia en `models/`.

| Pieza | Qué hace |
|---|---|
| `lib/db.ts` · `runWithRequestTenant(orgId, userId, fn, { readOnly })` | Abre la transacción única de la petición. Reentrante: un `tenantTransaction` interno (server action, motor del diario) la reutiliza. |
| `lib/page-tenant.ts` · `tenantPage(...)` / `withPageTenant(...)` | Envuelve el cuerpo de cada página RSC de `app/(app)/**`: `requireOrg(minRole)` + transacción única. Opciones `minRole`, `notFoundOnForbidden` (404 en vez de 403) y `readOnly`. Aplicado a **38 páginas**; las siete restantes son redirecciones, `notFound()` o componentes de cliente y no consultan la base. |
| `app/(app)/layout.tsx` | Su propia transacción única (Next renderiza layout y página en paralelo). `getUserMemberships` va **encadenado y fuera**: enumera todas las organizaciones del usuario, así que no puede compartirla. |
| `readOnly` | `SET TRANSACTION READ ONLY`: la BASE rechaza con 25006 una escritura desde un Server Component. Se deja en `false` sólo donde el render emite un `ReportRun` (informes, panel, sumas y saldos, mayor, PyG analítica). |
| Pool explícito | `PrismaPg` con `DB_POOL_MAX` (20 por defecto, era el `max: 10` de `pg`), `DB_POOL_IDLE_TIMEOUT_MS` y `DB_POOL_CONNECTION_TIMEOUT_MS`; `transactionOptions` por defecto `maxWait 5 s / timeout 15 s`. Documentado en `.env.example`. |

**Red de seguridad (ESLint).** `no-restricted-syntax` prohíbe `Promise.all` en cualquier fichero que importe `@/lib/page-tenant` (y en el layout, que importa `@/lib/db`): dentro de la transacción de la petición hay UNA conexión, así que un `Promise.all` de lecturas no gana nada y dispara el aviso de `pg`. Verificado que la regla salta (se reintrodujo el `Promise.all` de `/settings/currencies` y falló el lint).

**Flaky cerrado (`e6-reports.test.ts › criterio 15`).** Fallaba ≈1 de cada 13 ejecuciones. Causa: la corrupción de prueba elegía la línea con `ORDER BY id LIMIT 1` sobre las **trece** líneas `4300` con debe > 0 de la organización; `id` es un uuid v4, así que el orden cambiaba en cada carga del fixture, y **una** de esas trece es la de apertura del ejercicio **2027**. Cuando la lotería caía en ella, el céntimo se sumaba fuera del periodo del informe (2026) y ni el `ledgerHash` ni las líneas de I2 cambiaban: I2 salía en PASS y el test fallaba sin que nada estuviera roto. Corregido acotando la línea al ejercicio y al periodo del informe, con orden de negocio estable (`entry_date, line_no, id`) y `expect(rowCount).toBe(1)` para que un futuro «no toca ninguna fila» se vea. Verificado: **15 pasadas seguidas del fichero en verde**. (El test hermano de `LEDGER_DRIFT` no tenía el problema: sus cinco líneas `628` están todas en 2026.)

**N1 reforzado.** La fase 2 de `getOrCreateReportRun` corre en `RepeatableRead`: el `ledgerHash` que se recalcula al entrar y las líneas que sella salen del MISMO snapshot. El recálculo + reintento sigue puesto y es lo que cubre el caso reentrante (dentro de la transacción de una petición el nivel lo fijó el llamante).

Las escrituras siguen usando `tenantTransaction` explícito y **sigue prohibido anidar transacciones del diario** (`LedgerNestingError` en `models/ledger.ts`, intacto).

**Medido** (`tests/integration/perf-pages.test.ts`, fixture `ejercicio-completo`, local):

| Cargador | Transacciones antes → después | ms antes → después |
|---|---|---|
| `/settings/fiscal-years` | 3 → **1** | 27 → **8** |
| `/ledger` | 9 → **1** | 76 → **37** |
| `/settings/accounts` | 2 → **1** | 24 → **12** |

`readOnly: true` también en `/reports/runs`: lista runs y avisos de revisión, no emite ninguno.

`readOnly: true` también en `/reports/runs`: lista runs y avisos, no emite ninguno.

Con cuatro peticiones simultáneas de `/ledger` (layout + página en paralelo) el pico de conexiones baja de 9 a 8 y la latencia de 331 ms a 159 ms. El test fija dos techos por cargador: **≤ 2 conexiones simultáneas por petición** (medidas en `pg_stat_activity`) y **< 1500 ms**, más «un render abre exactamente 1 transacción» y el rechazo de escrituras en `READ ONLY`.

**Síntoma que cerraba.** `Transaction API error: Unable to start a transaction in the given time` en `/settings/fiscal-years` durante los e2e. Ya no aparece: 15/15 e2e en verde.

### Roles de base de datos
`DATABASE_URL` debe apuntar ahora al rol **`app_runtime`** (LOGIN, NOBYPASSRLS, no propietario) y `DIRECT_URL` al propietario, que es el que usan las migraciones (`prisma.config.ts`). Las migraciones **ya no fijan contraseñas** (quedarían en el repositorio): crean el rol sin LOGIN y garantizan `NOBYPASSRLS`. La credencial la pone el operador:

```bash
APP_RUNTIME_PASSWORD='…' APP_MAINTENANCE_PASSWORD='…' ./scripts/dev-db-setup.sh   # local y CI
```

Desde E3 hay un tercer rol: **`app_maintenance`** (`BYPASSRLS`, `NOLOGIN` por defecto). Se consume por `DATABASE_URL_MAINTENANCE` y **sólo** desde `scripts/`: `migrate-uploads-to-org.ts` y `run-invariants.ts` abortan con un mensaje explícito si la variable falta o si el rol no tiene `BYPASSRLS` — un barrido que ve 0 filas en silencio es peor que uno que no arranca.

**Acción pendiente del operador:** en cualquier entorno donde ya se aplicó `20260904140000_e1_rls_effective`, esa migración dejó la contraseña literal `app_runtime`; hay que ROTARLA. La migración no se edita porque ya está aplicada (`CLAUDE.md`).

### Deuda técnica: pg DeprecationWarning en tenantDb — **CERRADA (E6-perf, 2026-09-05)**
El aviso «client is already executing a query» no venía del adaptador sino de **consultas hermanas lanzadas en paralelo sobre la única conexión de una transacción**. Dos causas, las dos corregidas:

1. `app/(app)/ledger/shared.ts` · `entryExtras` pedía `fiscalYear`, `reverses` y `reversedBy` en un `select` multi-relación: Prisma resolvía las tres a la vez. Ahora son cuatro consultas planas **en serie** (mismos viajes a la base, cero solapamiento).
2. Los `Promise.all` de lecturas dentro de transacciones (`models/{ledger,analytics,accounts,account-map,tax-rates,fiscal-years}.ts`, layout y páginas). Dentro de una transacción hay UNA conexión: `pg` los encola igual, así que el paralelismo era ficticio y sólo producía el aviso. Todos pasados a serie.

Verificado: `npm run test:integration` (1047 tests) y los e2e no emiten ya el `DeprecationWarning`, y **se ha retirado la exclusión** de `tests/e2e/libro-diario.spec.ts` — ese test vuelve a fallar ante cualquier error de consola.

**Regla nueva:** dentro de `runWithRequestTenant` / `tenantTransaction`, las lecturas van en serie. Está escrita en el docblock de ambas.

### Comandos de test
```bash
npm run test                  # unitarios
npm run test:integration      # integración como PROPIETARIO (no ejerce RLS)
npm run test:integration:rls  # models/ como app_runtime: RLS efectiva
npm run test:all              # los tres
npm run test:e2e              # Playwright sobre `npm run dev` en :7331
```

**Higiene del entorno e2e (importante).** Los e2e escriben en la base de desarrollo `erp` y **acumulan estado** entre ejecuciones: asientos `Venta e2e …` en la organización del diario, reclasificaciones en la analítica y `report_runs` cacheados. Pasadas 15–20 ejecuciones el diario supera las 50 filas de la primera página, la línea que el test de reclasificación elige acaba siendo la de un asiento ya anulado y los informes se sirven de una caché de otro estado: fallan tests correctos. Antes de una pasada de verificación:

```bash
# 1. Recargar el fixture en la organización analítica (vacía y vuelve a postear)
DATABASE_URL_MAINTENANCE=… npx tsx scripts/load-fixture.ts --org <org> --user <user> \
  --fixture tests/fixtures/ejercicio-completo.json --reset-org
# 2. Vaciar la caché de informes y los avisos de revisión (owner, con el baile NO FORCE/FORCE)
```

## Siguiente trabajo (en este orden) — épica E1 "fix" (COMPLETADA salvo lo indicado)
1. ✅ **BLOQUEA-1/2 RLS inerte**: cablear `tenantTransaction` en escrituras de `models/`; políticas de `organizations`/`memberships` por `user_id` (función `app.current_user()`); `SET LOCAL` en `createOrganizationWithOwner`; `.env.example`/docker-compose con rol `app_runtime`; test de humo con `app_runtime` en `test:integration`. Si no cabe en un sprint, ADR-0008 que reconozca RLS efectiva en E3 (Nivel 2: Pablo ya delegó aprobación general en sesión de setup).
2. ✅ **BLOQUEA-3 ficheros por organización**: rutas físicas `uploads/<organizationId>/…` + script de migración de disco; arregla también DEBE-4 (backup), DEBE-5 (logo), DEBE-6 (cuota).
3. ✅ DEBE-7/8 members: `requireOrg("ADMIN")` + `notFound()`; sin mutación en RSC.
4. ✅ DEBE-9 `NO_ORGANIZATION` → redirect a `/organizations/new` (sacar `/organizations/**` del layout).
5. ✅ DEBE-10/11 CI: `test:integration` obligatorio y falla si falta `DATABASE_URL_TEST`; versionar tests QA; test de migración con fixture `tests/fixtures/taxhacker-pre-e1.sql`.
6. ✅ DEBE-12..18: `DROP INDEX IF EXISTS`; slug con uuid completo; rate limit en invitación D-3; aceptación en `$transaction`; log Stripe solo id/type + unique parcial `stripe_customer_id`; `log` de Prisma por entorno; validación mimetype/tamaño en uploads.
7. ✅ PUEDE-19..26 según tiempo (documentar límite de `tenantDb` con relaciones; ESLint `lib/**` + patterns; política RLS `app.current_user()`; monedas duplicadas; `iat` en cookie; `AuthzError` → `ActionState`; alinear contrato de actions; `leaveOrganizationAction`).
8. ✅ Revisión final APROBADA (3 rondas). E1 CERRADA en ROADMAP; registro en runs/registro.jsonl.
9. ✅ E2 CERRADA (plan de cuentas, mapa, impuestos, AuditLog; revisión APROBADA).
10. ✅ E3 CERRADA 2026-09-05 (libro diario; auditor CONFORME; revisión APROBADA).
11. ✅ E4 DISEÑADA y aprobada (docs/design/E4-analitica.md, E4-validacion-analitica.md, ADR-0010). Backend implementado (commit 3b769f1: 615 unit / 798 integración / 85 RLS; matriz PyG analítica byte a byte con docs/design/fixtures/pyg-analitica-esperada.json). UI implementada (commit 0bf28a3: /analytics/pyg, projects, cost-centers, business-lines, /settings/analytics, reclasificación, dimensiones en asientos; 8 e2e verdes).
12. ✅ E4 CERRADA 2026-09-05 (bugs corregidos; QA PASS; auditor CONFORME; revisión APROBADA tras 1 ronda; ADR-0011). Deuda aceptada: matriz por agregado SQL, índices O(1) en resolveDestination, MLC por entryDate, seedAnalyticsDefaults con tx del llamante, $queryRawUnsafe documentado, closedProjectOverride sin superficie UI (derivar rol de withOrg al exponerla).
12-old. (cerrado) E4 pendiente de cierre — en este orden:
    a. Bugs reportados por dev-frontend, a corregir por dev-backend: (b) `lib/analytics` `resolveLevel` lanza `AnalyticsError TYPE_UNKNOWN` en vez de devolver FAIL → una línea 6/7 con costCenterId y analyticType NULL tumba /ledger/sumas-saldos (debe ser check FAIL/WARN, nunca excepción); (c) AuditLog de `reclassifyLines` con ~21 líneas falla «value too long» (before/after como JSON compacto o por lotes; comprobar tipo de columna); caché de `models/margins.ts::getAnalyticPnl` es de módulo (debe ser per-request y acotada; clave incluye dimensiones — ya parcheado por frontend).
    b. QA (qa-tester) sobre E4: criterios docs/design/E4-analitica.md §8; adversarial: xor project/ceco, FK cruzadas, reclasificación en ejercicio cerrado, hash v2 estable ante reclasificación, I4 con líneas CC-NA (WARN → REQUIERE REVISIÓN), VIEWER.
    c. auditor-fiabilidad en contexto limpio: reconstruir por SQL/Python la matriz (INGRESOS 6.250.000 · MC1 5.670.000 · MC2 3.276.000 · MC3 3.084.110 · EBITDA 2.390.430 · EBIT 1.995.430 · BAI 1.996.430 · RESULTADO 1.497.322) y P-02/CC-GA; error inyectado en dimensión.
    d. revisor-codigo en contexto limpio sobre `git diff a6e4a14...HEAD`; rondas de fix hasta APROBADO.
    e. documentador: ROADMAP E4 = CERRADA, runs/registro.jsonl, ESTADO; push.
13. ✅ E6 DISEÑADA y aprobada (docs/design/E6-informes.md, E6-validacion-estados.md, ADR-0012; estados esperados en docs/design/fixtures/estados-esperados.json). Backend implementado (commit 8d8055a: 766 unit / 995 integración / 105 RLS; balance/PyG/cashflow byte a byte con los esperados: activo 13.673.820, PN 8.307.322, resultado 1.497.322, cash 2.943.920). UI implementada por dev-frontend hasta corte por límite de uso (commit siguiente): rutas /reports/{balance,pyg,cashflow,aging,runs}, /settings/review-thresholds, dashboard reescrito, tests/e2e/informes.spec.ts escrito pero NO ejecutado; tsc y lint en verde.
14. ✅ E6 CERRADA 2026-09-06 (QA PASS, auditor CONFORME, revisor APROBADO; perf: tenantPage una transacción por petición, pool explícito; flaky criterio 15 corregido). Deuda aceptada E7/E9 en runs/registro.jsonl.
14-bis. (histórico) E6 pendiente de cierre — en este orden:
    a. dev-frontend: retomar UI E6 — arrancar dev (`npm run dev` como app_runtime), `npm run build`, ejecutar `npm run test:e2e` (tests/e2e/informes.spec.ts) y corregir; capturas en /tmp/e6-screens; revisar que dashboard no usa models/stats.ts (eliminado) y que sidebar tiene sección Informes.
    b. qa-tester (criterios docs/design/E6-informes.md §8; adversarial: ReportRun inmutable como app_runtime, caché por paramsHash, umbral de variación EV-*, ManualReviewFlag, export válido, I2/I3/I6 sobre fixture, bidireccionales por signo, VIEWER).
    c. auditor-fiabilidad contexto limpio: reconstruir balance (activo 13.673.820 / PN 8.307.322), PyG (A.4 1.497.322), cashflow (Δ −1.056.080, cash final 2.943.920) por SQL/Python; error inyectado.
    d. revisor-codigo contexto limpio sobre `git diff 97221fb...HEAD`; rondas hasta APROBADO.
    e. cierre E6 (ROADMAP, registro, ESTADO, push).
15. ✅ **E5 implementada y corregida en dos rondas (2026-09-06).** Backend + UI (commits f57d6ee, 7d6d213, 17b8fe9). Auditor: **CONFORME** en cifras (`docs/design/E5-auditoria.md`, 4 hallazgos de detección). Revisor: ronda 1 CAMBIOS REQUERIDOS (3 BLOQUEA · 7 DEBE · 7 PUEDE) → **ronda 1 cerrada en 62ded40**; ronda 2 CAMBIOS REQUERIDOS (0 BLOQUEA · 1 DEBE · 2 PUEDE) → **R2-1/R2-2/R2-3 cerrados**. QA: BUG-E5-1 cerrado. Ver §«E5 — deuda y decisiones» más abajo.
16. ✅ **E5 CERRADA (2026-09-06, commit 53f5818 + cierre).** Ronda 3 del revisor: **APROBADO** (0 abiertos). Re-auditoría: **CONFORME** (Δ=0 tras BigInt; I-E5-12 detecta la alteración de suma cero; ReportRun imputado caduca al revertir). e2e 21/21. Registro: `2026-09-06_e5_cierre`.
17. ✅ **E8 implementada y corregida en dos rondas (2026-09-06).** Diseño + ADR-0014 (commit 607f53c) y siete commits de implementación hasta `1652150`. Ronda 1 (`008fa0d`): auditoría adversarial **DISCREPANCIA** (H-1…H-9) + revisión **BLOQUEADO** (1 BLOQUEA · 4 DEBE · 6 PUEDE) + QA (BUG-E8-1, BUG-E8-2, criterio 31 sin test) — todo cerrado. Ronda 2: R2-1 (emparejamiento bloque↔línea por clave estable), R2-2 (I-E8-7a nombra los documentos sin contraste + caso adverso permanente), H-6 (los quince casos sobre el NPGC real **sin traducciones de arnés**; el defecto era del fixture y se corrigió en el generador → `extraccion-esperada.v1.1.json`) y R2-3 (`lib/uploads` perezoso en `settings/actions`).
18. ✅ **E8 CERRADA (2026-09-06).** **Auditor CONFORME** y **revisor APROBADO** en la ronda 2. Tests: unit **1 331** ✓ / 11 skip · integración **1 763** ✓ · RLS **155** ✓ · e2e **28** ✓ (documentos 7/7) · `build` OK · `build_extraccion_esperada.py --check` reproducible byte a byte. Deuda fechada y con épica en §«E8 — deuda y decisiones». Registro: `2026-09-06_e8_cierre`.
19. **SIGUIENTE**: **`/epica E7` (Auditoría)** → `/sprint E7` → E9 → E10 → E11 → E12.

    **E7 no empieza de cero: hereda deuda ya fechada.** Lo que tiene que cerrar, además de su propio alcance (pestaña Auditoría con checks, calidad de datos, `AuditLog`, runs y forzar revisión; `scripts/run-invariants.ts` en pantalla; test de error inyectado; conciliación bancaria básica con `BankStatementLine`):

    | Viene de | Deuda | Qué hay que hacer en E7 |
    |---|---|---|
    | **E5** | Runs de liquidación con `lines_hash` NULL (sellados antes de `20260910110000`): I-E5-12 los declara INFO en vez de verificarlos | Listarlos en la pestaña con su periodo y su fecha, para re-liquidarlos y dejarlos sellados |
    | **E5** | `journal_lines.debit_cents`/`credit_cents` en `integer` (techo 21.474.836,47 €), mismo problema que ya se retiró en `allocation_lines` | Decidir `bigint` y, si se aprueba, migrarlo con el barrido de Auditoría: es DDL puro pero toca la tabla más grande y el motor entero |
    | **E5** | Un `ReportRun` sellado no caduca si alguien altera `allocation_lines` por SQL | Lo detecta el barrido (I5 + I-E5-12 con `linesHash`); la pestaña es donde se mira |
    | **E6** | Deuda menor anotada en el registro de E6 | Revisar al abrir la épica |
    | **E8** | **I-E8-2 sólo verifica los ficheros que respaldan un asiento** (los que el invariante mira) | Barrido del almacén COMPLETO desde la pestaña, con aviso de reingesta para el documento no disponible |
    | **E8** | **Split N-a-1 sin interfaz**: `splitProposalAction` y `lib/extraction/split.ts` están cerrados y probados, falta el diálogo de reparto por líneas | Pantalla de split, con el resto del trabajo de interfaz de la Auditoría |
    | **E8** | Endurecimiento condicional de `files.sha256` | Cerrado el hueco real en la ronda 1; queda el barrido masivo |

    Y **E7 es quien pinta** lo que E8 ya produce y hoy nadie enseña: los `dataQualityWarnings` (documento sin asiento, run en FAIL sin resolver, extracción parcial, duplicado forzado, deducibilidad pendiente, ticket cualificado, contraparte sin régimen, desviación de cuota) y el bloque **I-E8-1…20** con su evidencia.
~~13. `/epica E6` (informes financieros: balance, PyG contable, cashflow, ReportRun persistente con sello, export) → `/epica E5` (liquidación de CECOs) → E8 (OCR → asientos) → E7 → E9…
~~11. `/epica E4` (analítica base: BusinessLine, Project, CostCenter, AnalyticType en líneas, MarginLevelConfig, PyG analítica sin imputaciones, I4; retirar CHECK NULL de dimensiones + FKs; fixtures con projectCode/costCenterCode activados) → `/sprint E4` → E6 (informes: balance, PyG, cashflow, ReportRun) → E5 (liquidación CECOs).
~~10. `/epica E3` (libro diario: FiscalYear, JournalEntry/Line, post/void, numeración, trigger Σdebe=Σhaber, plantillas de asientos, mayor, sumas y saldos, invariantes I1/I7–I10, ledgerHash) **+ retirada de deuda RLS de E1/E2 + pendientes E2 (importCustomPlan createMany, alta org+siembra atómica, virtualizar árbol)** → `/sprint E3`.

## E5 — deuda y decisiones (rondas 1 y 2 de corrección, 2026-09-06)

Todo lo que E5 deja abierto, con **épica de cierre y fecha**, como exige el
§Estándar de calidad de `CLAUDE.md`. Nada de esto bloquea el cierre de E5; lo que
no puede pasar es que desaparezca del seguimiento.

| Deuda | Estado | Épica de cierre | Nota |
|---|---|---|---|
| **O-A6** — `Budget` con `@@unique` de tres columnas nullables (NULL <> NULL, no impide duplicados) | **CERRADA (2026-09-15, E10)**: `20260924100000_e10_presupuesto` crea `budget_lines` con `CHECK ((project_id IS NULL) <> (cost_center_id IS NULL))` y **cuatro índices únicos parciales** (proyecto+cuenta, proyecto sin cuenta, CECO+cuenta, CECO sin cuenta), más otros cuatro en `budget_hours_lines`. Lo comprueba `tests/integration/e10-esquema.test.ts` y lo vigila I-E10-8 | — (cerrada en E10) | Cuatro índices únicos PARCIALES por combinación (proyecto+cuenta, proyecto sin cuenta, CECO+cuenta, CECO sin cuenta) o `NULLS NOT DISTINCT` (PG 15+), más `CHECK ((project_id IS NULL) <> (cost_center_id IS NULL))`. Corregidos `MODELO-DATOS.md` y ADR-0013 con nota al pie fechada |
| **`TargetKind.MIXED`** — valor de enum **sin uso**: ni el motor lo resuelve, ni el formulario lo ofrece ya (se retiró del selector en esta ronda), ni hay reglas con él | ABIERTA (contrato desaconsejado y documentado) | **E10** | Un reparto «mixto» se declara hoy con VARIAS reglas del mismo CECO y `sourceShareBps` complementarios, que es más explícito y cuadra por I-E5-3. Si en E10 sigue sin usarse, se retira del enum en la migración que toque `allocation_rules` |
| **`AllocationRunStatus.DRAFT`** — valor de enum sin persistencia: la simulación **no escribe nada** (ADR-0013 D5) | ABIERTA (valor de enum sin uso) | **E10** | Se retira con `MIXED` en la misma migración, o se usa si aparece el caso de una simulación guardada para aprobación |
| **Matriz imputada sin agregado SQL total** | **CERRADA en esta ronda (parcial y medida)**: `getAllocationTotals` agrega en SQL por `(fuente, destino, nivel)`, `readAllocationLines` pasó de cuatro consultas (con tres catálogos enteros) a una consulta más las dimensiones REFERENCIADAS, y `getAllocationCellDetail` ya no lee el reparto entero para sacar los `runIds` | — | Criterio 20 medido en `tests/integration/perf-pages.test.ts`: liquidación anual < 400 ms, PyG analítica imputada < 800 ms |
| **N+1 en `/analytics/allocations/runs`** | **CERRADA en esta ronda**: memoización por transacción del `ledgerHash` por `(periodo, ejercicio)` y de las reglas por `(periodicidad, fin de periodo)` | — | Con 17 runs se pasa de ~68 consultas a una por periodo distinto |
| **I5.b con periodicidades mixtas** — exigía cierre a 0 a un CECO cuya regla es de periodicidad más gruesa y todavía no vence en el periodo del informe (FAIL falso, sello REQUIERE REVISIÓN sin motivo) | **CERRADA en la ronda 2 (R2-1)**: `settlementPeriodFitsIn` acota I5.b a las reglas cuyo periodo cabe en el del informe; el resto se declara «pendiente de liquidar» con importe y regla (diseño §3.3, criterio 18). Un run REVERTIDO sigue dando FAIL, que es un residuo real | — | Las reglas se cargan aunque el periodo no tenga ni una línea: un run revertido deja exactamente ese estado |
| **Grafo de cascada** (§6/T11 del diseño) | **ENTREGADO en esta ronda** como componente simple: `components/analytics/allocation-cascade-graph.tsx`, aristas `fuente → destino` numeradas por orden de ejecución y agrupadas por periodicidad | — | Se descarta el layout de grafo con librería: lo que hace falta saber es qué se reparte antes que qué (I-E5-8), no la geometría |
| **`allocation_lines` en `bigint`** | **CERRADA en esta ronda**: `amount_cents`, `driver_base`, `driver_base_total` y `allocation_runs.total_allocated_cents` pasan a `bigint`; `hamilton()` opera en `BigInt` | — | Con `integer` el techo eran 21.474.836,47 €, por debajo del rango de producto («hasta 100 M€»). La conversión vive en el borde (`models/allocations.ts`); el motor y la UI siguen en `number` |
| **`HOURS` / `HEADCOUNT`** | ABIERTA por diseño (ADR-0013 D4: se RECHAZAN, no quedan inertes) | **E10** | Con `TimeEntry` y el contrato del experto (minutos enteros, sólo entradas aprobadas, `fteMilli` a fin de periodo) |
| **Auditoría: runs con `lines_hash` NULL** — los sellados antes de `20260910110000` no tienen sello de líneas e I-E5-12 los declara INFO en vez de verificarlos | ABIERTA (declarada, no oculta) | **E7** (pestaña Auditoría) | Listarlos en la pestaña con su periodo y su fecha, para que se puedan re-liquidar y quedar sellados. Petición del auditor tras la ronda 1 |
| **`journal_lines.debit_cents` / `credit_cents` en `integer`** — mismo techo (21.474.836,47 €) que ya se retiró en `allocation_lines` | ABIERTA (decisión pendiente) | **E7** | Decidir `bigint` también en el diario y, si se aprueba, migrarlo con el resto del barrido de Auditoría: es DDL puro, pero toca la tabla más grande y el motor entero. Petición del auditor tras la ronda 1 |
| **Un `ReportRun` sellado no caduca si alguien altera `allocation_lines` por SQL** | ABIERTA (limitación conocida) | **E7** (pestaña Auditoría) | La clave del run se compone del `ledgerHash` y del CONJUNTO de runs, no del contenido de las líneas. Lo detecta el barrido de invariantes (I5 e I-E5-12 con `linesHash`), que es donde se mira; incluirlo en la clave obligaría a hashear el reparto en cada petición de caché |

## E8 — deuda y decisiones (ronda 1 de corrección, 2026-09-06)

Toda la deuda que E8 deja abierta, **con épica de cierre y fecha**, como exige el
§Estándar de calidad de `CLAUDE.md` («el revisor bloquea si una épica añade deuda
sin fecha»). Es el hallazgo 1 —**BLOQUEA**— de `docs/design/E8-revision.md`.
Nada de esto impide cerrar E8; lo que no puede pasar es que desaparezca del
seguimiento. Las decisiones de fondo están en `docs/adr/0014-estados-transaccion-fx-y-tolerancia-reconcile.md`.

| Deuda | Estado | Épica de cierre | Nota |
|---|---|---|---|
| **523 → 173** — un proveedor de inmovilizado a más de doce meses se registra en **523 siempre en el alta** (ADR-0014 D6), sin reclasificar a 173 ni descontar el valor actual del aplazamiento (NRV 9ª.3.1) | ABIERTA por diseño | **E9** | La reclasificación se mide desde el CIERRE, no desde el alta, así que es un asiento de cierre y no del camino documental. E9 la hará junto con la periodificación y el devengo del interés implícito. Mientras tanto el pasivo está completo y cuadrado: lo que falta es su presentación corriente/no corriente y el descuento |
| **RECC y REDEME** — `Organization.ivaRegime` distinto de `GENERAL` **bloquea** la contabilización automática (RC-24 FAIL, `blocksBatch`) | ABIERTA, declarada y bloqueante (no silenciosa) | **E9** | Criterio de caja (arts. 163 terdecies y quaterdecies LIVA) y devolución mensual cambian el devengo y la deducción al cobro y al pago: no es un ajuste de plantilla, es otro calendario. Bloquear es lo correcto hasta tenerlo; contabilizar como GENERAL sería declarar mal |
| **`DUA_IMPORTACION` con plantilla `null`** — un DUA no entra por ninguna plantilla de compra (`TEMPLATE_FOR_DOC`) | ABIERTA por diseño | **E9** (T-20) | El IVA de importación lo liquida el propio DUA contra la Aduana, con su base de valor en aduana + aranceles, que no es la de la factura del proveedor. La factura extracomunitaria sí se contabiliza (C10/C15 del fixture): base sin IVA contra 400/523 |
| **668 / 768 · diferencias de cambio** — no existe ninguna línea de resultado por diferencias de cambio | ABIERTA por diseño | **E9** | En el reconocimiento inicial NO hay diferencia de cambio (NRV 11ª): el residuo de conversión se elimina por construcción repartiéndolo entre las cuotas (ADR-0014 D2). Las diferencias nacen al **liquidar** y al **cerrar**, que es E9. Documentado en `lib/fx/convert.ts`: si alguna vez procediera reconocer un residuo, su cuenta sería 668/768 y jamás 669/769 |
| **G-14 · conciliación bancaria** | ABIERTA | **E12** | El extracto bancario tiene plantilla `null` a propósito: sus cifras las calcula un tercero y entran por la conciliación, no por una plantilla de compra |
| **G-15 · facturación emitida completa** (PDF, envío, cobro) | ABIERTA | **E11** | E8 cierra la numeración sin huecos (I-E8-20), la serie rectificativa y el asiento de la factura emitida; el ciclo comercial es de E11 |
| **Serie `ORDINARIA` no sembrada** | **NO es deuda de código**: la serie se crea desde Configuración → Facturación (`createInvoiceSeriesAction`, panel `invoice-series-panel`), que es donde una organización decide su prefijo y su numeración | **E11** para la siembra automática al activar el módulo de facturación | Sembrarla en el alta obligaría a inventar un prefijo por la organización y a dejar un contador vivo que nadie pidió; I-E8-20 lo trata bien (`INFO` mientras no hay números emitidos). En E11, al activar facturación, se crea con el prefijo que elija el usuario |
| **Endurecimiento condicional de `files.sha256`** — la columna es `NOT NULL` desde `20260914090000`, pero la comprobación de los BYTES depende de que el almacén responda | **CERRADA en esta ronda** en lo que era el hueco real (auditor H-3): `readDocumentsInvariantInput` lee el fichero del almacén **en streaming** y compara; si no está, **I-E8-2 FAIL** con la ruta, y la vista previa devuelve `410` con `X-Document-Status: NO_DISPONIBLE` en vez de un 404 mudo | **E7** para el barrido masivo | Lo que queda para E7 es el barrido de TODO el almacén desde la pestaña Auditoría (aquí se comprueban sólo los ficheros que respaldan un asiento, que son los que I-E8-2 mira) y el aviso de reingesta desde la propia pantalla |
| **Split N-a-1 en la interfaz** — `splitProposalAction` divide un fichero en N operaciones y N asientos, y está probado (`e8-actions.test.ts`), pero la pantalla no ofrece todavía el diálogo de reparto por líneas | ABIERTA (motor sí, UI no) | **E7** | El motor (`lib/extraction/split.ts`) y la acción están cerrados y con tests; falta la pantalla que elija los grupos de líneas. Se aplaza a E7 con el resto del trabajo de interfaz de la Auditoría, no ahora, para no abrir una pantalla nueva en una ronda de corrección |
| **Criterio 31 · rendimiento de la bandeja** | **CERRADA en esta ronda**: `tests/integration/e8-bandeja-perf.test.ts` mide la bandeja con **2 000 ficheros y 6 000 extracciones** —los cuatro accesos del render de `/unsorted`, dentro de una sola transacción de tenant— y exige mediana < 150 ms | — | Se añadió además la paginación `LIMIT/OFFSET` que pedía §9 (revisor #10): antes la bandeja pedía 200 filas fijas y truncaba en silencio |
| **Rate limit de proceso en la cola de extracción** — la concurrencia se acota por proveedor (`maxConcurrency`), no hay un techo global por organización ni por minuto | ABIERTA | **E9** | Con la cola actual (`ai/queue.ts`) un lote de 100 documentos consume saldo tan rápido como el proveedor lo sirva. El saldo sí se decrementa por run creado (G-12), así que no hay gasto invisible; lo que falta es el techo |
| **`exchange_rates` es global y visible entre organizaciones** (auditor H-8) | ABIERTA por diseño (ADR-0014 D7) | **E9** si se decide cambiarlo | La referencia del BCE es pública, pero *qué pares y qué fechas* consulta una organización sí es información suya. Hoy la tabla lleva `ENABLE` + `FORCE` con `RESTRICTIVE` en UPDATE/DELETE y una sola política de lectura global. Cambiarlo exige ADR: partir la tabla por organización multiplica las llamadas a la fuente |
| **`resolveRectifiedEntry` no valida el formato de `rectifies.entryId`** (auditor H-9) | ABIERTA, **inalcanzable hoy** | **E9** | `ai/schema.ts` no expone `entryId` al modelo y `forms/extraction.ts` lo valida como `uuid`, así que un valor no-UUID no puede llegar. Es endurecimiento defensivo, no un defecto abierto |
| **Trazabilidad de T18/T19 por `run_id` y no por commit** (revisor #9) | ANOTADA, no se parte el commit | — | `7a8a1c3` mezcla el lote T6/T10/T11/T12 con T18/T19. El árbol resultante es correcto y `runs/registro.jsonl` los separa en dos runs (`e8_olaB_extraccion_fx` y `e8_olaB_t18_t19`) con su alcance y su deuda. La trazabilidad de T18/T19 se busca por `run_id` |

### Cerrado en la ronda 1 (2026-09-06) — no queda deuda de estos puntos

| Hallazgo | Qué se hizo |
|---|---|
| **Auditor H-1 / H-2** · los tres puentes al 303 daban FAIL sobre quince asientos correctos (−10 438 en Q4 por divisa, +12 600 en Q3 por rectificativa) | El libro registro se deriva ahora del **asiento contabilizado** (`vatBookRowFromEntry`), que ya está en moneda base y ya lleva la diferencia; la propuesta sellada —convertida con la tasa del run por `convertDocumentToBase`, la MISMA función que convirtió el asiento, y con el `rectificationDelta` aplicado— viaja como **contraste** y la compara **I-E8-7a**, documento a documento y con tolerancia 0. `SealedReconcile` gana `rectificationDelta` |
| **Auditor H-3 / QA BUG-E8-1** · `diskSha256` no lo escribía nadie | `lib/files-integrity.ts · sha256OfStoredFile` lee los bytes en **streaming** y `readDocumentsInvariantInput` los compara para los ficheros que respaldan un asiento. Fichero ausente o bytes alterados ⇒ **I-E8-2 FAIL** con la ruta y sello **REQUIERE REVISIÓN** (`tests/integration/e8-qa.test.ts`). El lector se **inyecta** (`runLedgerInvariants({ readStoredFile })`) desde `app/(app)/ledger/shared.ts`, `ledger/actions.ts`, `scripts/run-invariants.ts` y `scripts/load-fixture.ts`: importarlo dentro de `models/ledger.ts` metía un `createReadStream` en el grafo de casi toda la aplicación y el rastreador de ficheros de Next pasaba de **1 aviso a 38** («se ha trazado el proyecto entero»). Con la inyección quedan **5**, y sólo en las rutas del diario y de analítica, que son las que de verdad lo alcanzan. Sin lector, I-E8-2 no miente: WARN diciendo que el almacén no expuso los bytes |
| **Auditor H-4** · `ExchangeRateUnavailableError` sin capturar | `guardingRates` en `app/(app)/unsorted/actions.ts` la traduce a un `ActionState` con el texto de **RC-14 «sin tasa»** (par, fecha y qué hacer). Nunca se inventa una tasa y no se guarda nada a medias |
| **Auditor H-5** · `proposal_sha` no se recomputaba | **I-E8-11** recalcula el sello de la propuesta (y el del esquema, cuando la versión es la vigente) sobre lo que hoy tiene la fila. Editar por SQL un run ya contabilizado lo delata nombrando el run |
| **Auditor H-6** · el fixture sólo se verificaba contra un plan sintético | `tests/integration/e8-ronda1.test.ts` replica los **quince casos sobre el NPGC PYMES sembrado**, con la traducción de cuentas resuelta contra el plan real (no a mano) |
| **Auditor H-7** · ningún caso ejercía el reparto Hamilton del residuo de conversión | Caso CHF con tasa 920 000 µ y bases 33 333 / 33 333 / 33 334: residuo ≠ 0, absorbido por las cuotas, sin línea de ajuste y sin 668/768 ni 669/769 |
| **Revisor #2** · `simplifiedQualified` viajaba en la propuesta | `submittedProposalSchema` (zod `.strict()` sin el campo) lo rechaza en `confirmProposalAction` y en `previewProposalAction`; el servidor lo recupera del run sellado, que sólo escribe `markSimplifiedQualifiedAction` con su `AuditLog` |
| **Revisor #3** · el motivo por campos `no_verificado` sólo se exigía en el cliente | `confirmOne` lo calcula en el servidor (procedencias recalculadas ∪ selladas en el run) y exige ≥ 10 caracteres, que quedan en el `AuditLog` junto con la lista de campos asumidos |
| **Revisor #4** · `originalAmountCents` salía de deshacer la conversión | Los bloques de pasivo se recalculan **sobre las cifras del documento** con el mismo Hamilton; `reverseConvert` queda como red de seguridad. Test con `rateMicro = 920000` sobre 20 000 importes |
| **Revisor #5** · `authz-actions.test.ts` agotaba los 5 000 ms | Causa: `sharp` (~2,3 s, binario nativo) y los tres SDK de LangChain (~1,3 s) se cargaban en el grafo de `settings/actions`. Ahora son importaciones perezosas. Medido: **6 853 → 2 449 ms**, sin tocar el timeout ni el aserto |
| **Revisor #6** · rama `PROPOSED → DRAFT` de más en el trigger | Retirada en la migración aditiva `20260915090000_e8_ronda1_transiciones` (`CREATE OR REPLACE FUNCTION`, sin SUPERUSER), con test en `e8-esquema.test.ts` |
| **Revisor #7 / #8** · ISO-4217 y coma flotante en la tasa | `assertCurrencyCode` en la frontera y `rateMicroFromValue`, que pasa el literal decimal a micros con aritmética entera |
| **Revisor #10** · bandeja sin paginación | `LIMIT/OFFSET` por `?page=`, con el rango y el total a la vista («Documentos 1–100 de 412») |
| **QA BUG-E8-2** · el arnés e2e daba por sembrado un documento cuyos bytes no estaban | `tests/support/seed-extraction.ts` comprueba el sha256 en disco y regenera el fichero si falta; `/files/preview/[fileId]` devuelve **410** con `X-Document-Status: NO_DISPONIBLE` y el visor pinta el aviso en vez de un hueco |

### Cerrado en la ronda 2 (2026-09-06) — revisor APROBADO, auditor CONFORME

| Hallazgo | Qué se hizo |
|---|---|
| **R2-1** · el importe en divisa de la línea de pasivo se emparejaba por FIFO de `accountCode` | Dos claves de pasivo pueden mapear a la MISMA cuenta (`PROVEEDORES_INMOVILIZADO` y `ACREEDORES` a la 4100): las dos líneas son indistinguibles y un cambio de orden en la plantilla habría intercambiado sus importes **sin descuadrar el asiento**. `pairOriginalAmounts` empareja ahora por clave estable —`(accountCode, importe convertido)` y, en su defecto, por orden de bloque— y es pura, para que el test pueda darle los bloques al revés y comprobar que no se cruzan |
| **R2-2** · I-E8-7a no decía QUÉ documentos se quedaban sin contraste | La evidencia los nombra (`asiento 12 (2026-Q4)`). Y el puente al 303 gana **vigilancia propia y permanente**: `e8-ronda1.test.ts` altera por SQL la cuota de la propuesta de un run ya contabilizado y comprueba que **I-E8-7a da FAIL con la diferencia** mientras I-E8-15a/b/c siguen en PASS —el asiento no se ha tocado—, que es justo el reparto de responsabilidades que la ronda 1 estableció |
| **H-6 (ronda 2)** · el test de los quince casos sobre el NPGC real todavía traducía `IRPF_15 → IRPF_PROF_15` | El defecto era **del fixture**: `IRPF_15` no existe en el catálogo del producto (`lib/taxes/rates.ts`). Corregido en el generador y sellado en un fichero **nuevo versionado**, `extraccion-esperada.v1.1.json` (la 1.0 queda congelada como evidencia de la ronda 1). En la misma revisión, la línea del documento de C06 pasa de citar `608` —que tiene subcuentas y no es postable en el NPGC— a citar `607`: la 608 la decide el motor por `DEVOLUCION_COMPRAS`, que es lo que las notas del caso ya afirmaban. El asiento sellado **no cambia ni un céntimo**. El test resuelve las contrapartidas con el mecanismo del producto (`OrganizationAccountMap`) y **falla nombrando el fixture** si éste cita una cuenta no postable o un tipo que no está en el catálogo |
| **Hidratación de la bandeja** (lo destapó el e2e a las 22:5x UTC, y era un fallo real) | `new Date(iso).toLocaleDateString("es-ES")` formatea con la zona de quien lo ejecuta: el servidor (UTC) y el navegador (Europe/Madrid) devolvían **días distintos** durante las dos horas anteriores a medianoche UTC. React lo denunciaba como desajuste de hidratación, regeneraba el árbol y la navegación por los filtros se quedaba colgada — un usuario en España que abriera la bandeja a la una de la madrugada veía lo mismo. `lib/dates-ui.ts` (`fechaUtc` / `fechaHoraUtc`) formatea desde las piezas UTC del ISO, con test propio; aplicado a la bandeja, al selector de extracciones y a la pestaña Documento |
| **`HEAD` a `/files/preview` en cada carga de la ficha** (introducido por mí en la ronda 1) | El visor preguntaba desde el cliente si el documento estaba en el almacén con un `HEAD`, y Next atiende un `HEAD` **ejecutando el `GET` entero**: cada carga de la pantalla de revisión regeneraba la vista previa (sharp/pdf2pic) para responder algo que el servidor ya sabía. Ahora lo decide el servidor con un `access()` y viaja como prop (`unavailable`), en `/unsorted/[fileId]` y en la pestaña Documento de `/ledger/[entryId]` |
| **e2e: los diálogos se pulsaban antes de la hidratación** | `page.click()` comprueba visibilidad y estabilidad, no que React haya enganchado el `onClick`: el botón se pulsaba, recibía el foco y no pasaba nada. `abrirDialogo()` reintenta la pulsación hasta que el contenido del diálogo aparece — el mismo patrón que `libro-diario.spec.ts` ya usaba para los `fill`. **No se relaja ninguna aserción**: sólo se espera a que la pantalla esté viva |
| **R2-3** · el import de `settings/actions` seguía costando 2,4 s | `lib/uploads` (1,2 s) pasa a importación perezosa: sólo lo usa el avatar y el logotipo. **2 449 → 1 151 ms**. Lo que queda es la pila de autenticación (`lib/auth` → better-auth, ~1,6 s en frío) y el cliente de Prisma (~0,6 s), inevitables en una acción que empieza por `requireOrg`; no se retuerce más |

## E7 — deuda y decisiones (ronda 1 de corrección, 2026-09-07)

Entradas: `docs/design/E7-auditoria-informe.md` (auditor, **DISCREPANCIA**, H-1…H-7),
`docs/design/E7-revision.md` (revisor, 3 DEBE + 3 PUEDE) y el QA de E7
(BUG-E7-1, BUG-E7-2). **Todo cerrado en E7** en dos rondas; no queda deuda diferida. Lo único que E7
deja explícitamente para otra épica es lo que su diseño ya declaraba: **E7 mide
la diferencia de cambio, E9 la reconoce** (I-E7-12, NRV 11ª.2.2).

| Hallazgo | Qué era | Cómo se ha cerrado |
|---|---|---|
| **H-1** (ALTA) | Una cuenta bancaria en divisa cuadraba **mezclando monedas**: `E`/`Ue` del extracto (divisa) contra `B`/`Ub` del diario (moneda base). I-E7-1 daba PASS por vacuidad mientras nada estuviera conciliado, y en cuanto se intentaba puntear el servidor lo rechazaba: sólo se podía conciliar a paridad 1:1 | `B`/`Ub` salen de `journal_lines.original_amount_cents`/`original_currency` (`hashVersion = 3`) cuando la cuenta no es en moneda base; `comparableAmountOf` en I-E7-2 e I-E7-11; `createMatchGroup` compara en la divisa de la cuenta; y **los dos guardias de la base** (`app.bank_reconciliations_guard`, `app.bank_match_groups_balanced`) también, con `app.bank_line_amount_in_currency`. Un apunte sin importe en la divisa deja el cuadre **no evaluable**, nunca en un PASS mezclado |
| **H-2** (ALTA) | `headline.activo` y `headline.pn_mas_pasivo` no filtraban `entry_kind`: a 31-12 —el día en que se firman— el asiento de cierre las dejaba en **0,00 €** e I2 se cumplía por vacuidad | `kind ∉ {CLOSING}` en las dos, la misma foto `PRE_REGULARIZACION` de E6. Test sobre el fixture completo: 13 673 820 / 13 673 820 (PN 8 307 322 + pasivo 5 366 498) |
| **H-3** (ALTA) | `BankInvariantInput.fx` no lo rellenaba nadie: I-E7-12 salía siempre `INFO`, el panel enseñaba `null` y `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` era inalcanzable. El único test que lo ejercía era **autocontradictorio** (paridad 1:1) y encubría H-1 | `readFxCloses` en `models/bank.ts` (tasa de cierre publicada, contravalor histórico y lo ya reconocido en 768/668 por asientos que tocan esa 57x), `fxDifferenceCents` derivado por el motor y enseñado por el panel sin recalcularlo, y el test reescrito con tasa de contabilización 0,92 ≠ tasa de cierre 0,90 |
| **H-4** | `computedSeal` se calculaba **antes** de componer los motivos de E7: un periodo con ocho pendientes de hasta 183 días se firmaba `VALIDADO_AUTOMATICAMENTE` con los AVISOS listados al lado | Los cuatro motivos entran en `seal()` por `auditReasons`, igual que los seis de E8 por `documentReasons`. `seal` y `sealReasons` dicen lo mismo. **`docs/design/E7-auditoria.md` §5.3 corregido**: la redacción original invitaba al error |
| **H-5** | «Explicado» era código muerto: `resolvedLaterIds` se pasaba fijo a `new Set()` y `pendingKind` no lo escribía nadie. El badge sólo se concedía con CERO pendientes | Tabla nueva **`bank_pending_kinds`** (el diario es append-only y el tipo de un pendiente no es un dato del asiento), acción `typePendingAction` y selector en el panel; el tipado se borra al conciliar y al ignorar. `resolvedLaterIds` lo **deriva el cuadre**: un grupo sólo cancela si TODOS sus miembros caen dentro del corte, y los que quedan dentro son exactamente los «recogidos por una conciliación posterior» de §3.6 |
| **H-6** | I-E7-14 era inevaluable justo en el alcance `FISCAL_YEAR`, con el que se sella un ejercicio: necesita las líneas `OPENING` del ejercicio **siguiente** | `auditBlock` hace una segunda lectura acotada a `OPENING` posterior al corte. No mueve ningún otro check (I-E7-15/16 filtran por `entryDate <= to`, I-E7-17 por `[from, to]`) |
| **H-7** | El periodo del extracto salía del primer y el último movimiento: un extracto mensual sin movimiento el día 1 abría un hueco falso y en una cartera real I-E7-6b salía FAIL casi siempre | El periodo lo **declara el banco** (registro 11 de la N43; `periodStart`/`periodEnd` del mapeo CSV), y se ensancha —nunca se recorta— hasta cubrir los apuntes nuevos |
| **DEBE 1** | El diff de E7 no tocaba un solo documento, contra ADR-0015 §Consecuencias y contra `CLAUDE.md` §Principio 4 | `.claude/skills/fiabilidad/SKILL.md` (bloque **I-E7-1…17**, los cuatro motivos de sello y la regla del badge P6 por composición: **es la definición única**), `docs/MODELO-DATOS.md` (las ocho tablas de E7, `ReportType.CASHFLOW` unificado, el borde `bigint`) y `docs/ARQUITECTURA.md` (§`lib/audit`, `lib/bank`, rutas `/audit`, medición por cargador) |
| **DEBE 3 / BUG-E7-2** | Las dos pantallas nuevas más pesadas entraron sin test de rendimiento | `tests/integration/perf-audit.test.ts` con los **cinco techos de §8** (ms y conexiones) y `perf-pages.test.ts` extendido con `/audit` y `/audit/bank` |
| **BUG-E7-1** | `--reset-org` no limpiaba las tablas de E7: `auditoria.spec.ts` dejaba conciliaciones y `liquidacion.spec.ts` reventaba con una FK | Las ocho tablas en el orden de las FK, antes del diario. Tres casos de QA en verde y la suite e2e completa, en orden alfabético, sin limpiar a mano |
| **PUEDE 4** | `authPrisma` no estaba bajo `no-restricted-imports` | Cubierto por nombre y por patrón, con lista blanca `lib/auth.ts` + `models/users.ts` |
| **PUEDE 5** | El `CONSTRAINT TRIGGER` de I-E7-11 era `AFTER INSERT` sobre las pertenencias: un grupo vivo sin ninguna nunca se comprobaba | `bank_match_groups_not_empty`, constraint trigger **diferido** sobre el grupo |
| **PUEDE 6** | `e4-qa-attack.test.ts` flaky por timeout de 5 s en la suite completa | Timeout del caso a 120 s con el motivo escrito. **No es de E7** (el test no toca `bigint`, ni el borde, ni la conciliación): es contención del pool, misma causa que el criterio 15 de E6. De paso, `e4-analytics #7` dejó de depender de un `findFirstOrThrow` sin `orderBy` que en la suite completa tocaba un asiento anulado |

### Ronda 2 (2026-09-07) — el bloqueante N-1 y las dos observaciones menores

| # | Qué era | Cómo se ha cerrado |
|---|---|---|
| **N-1** (ALTA) | El arreglo de H-3 **duplicaba la diferencia de cambio**: `fxDifferenceOf` restaba `recognizedDifferenceCents` sobre un `baseBalanceCents` que `readFxCloses` calcula como el saldo COMPLETO de la 57x —y el asiento que reconoce la diferencia (`5740001 (D) / 768 (H)`, NRV 11ª.2.2) **mueve la 57x**, así que ya estaba dentro—. Sobre una cuenta correctamente regularizada salía `WARN` con la diferencia cambiada de signo y una evidencia que se contradecía sola («332,50 € valorados frente a 332,50 € contabilizados … diferencia −10,50 €»); y como H-4 hizo que el motivo **sí** mueva el sello, la cuenta quedaba en `REQUIERE REVISIÓN` **para siempre por haber hecho lo correcto** | La diferencia es `saldo en divisa × tasa de cierre − contravalor contabilizado`, y punto. `recognizedDifferenceCents` se conserva como **evidencia**, no como sumando. El test unitario de la ronda 1 pasaba con un fixture que `readFxCloses` **no puede producir jamás** (saldo base sin mover y a la vez diferencia reconocida): se sustituye por uno realizable y por `tests/integration/e7-ronda2.test.ts`, que va de punta a punta —cuenta USD, tasa de cierre, asiento de 768— y comprueba **WARN antes, PASS después** |
| **O-1** | Una cuenta en divisa lucía `✓ validado contra fuente` con I-E7-12 en WARN: está conciliada en dólares, pero el balance enseña su contravalor en euros y ése no lo estaba | El badge se retira con la diferencia sin reconocer, diciendo por qué; en cuanto existe el asiento de 768/668 vuelve solo |
| **O-2** | `createMatchGroup` borraba el tipado de un pendiente **a caballo del corte**, que a la fecha de corte sigue siendo pendiente: se enseñaba «sin tipar» justo después de que alguien lo describiera | Conciliar **no destipa**. El tipado sólo se borra al **ignorar**, que es cuando el pendiente deja de serlo en todos los cortes. Un tipado que sobrevive a una conciliación completa es inocuo: `pendingKind` sólo se lee para lo que está pendiente en el corte evaluado |
| **R2-1** (revisor) | El comentario de `headlineFigures` atribuía el hallazgo a H-1 en vez de a H-2 | Corregido |

**Efecto lateral de N-1, resuelto de paso.** El asiento de reconocimiento mueve
la 57x **en moneda base y no en divisa**: en la moneda de la cuenta vale 0,00.
Aparecía como un pendiente de 0,00 USD «sin tipar» y retiraba el badge. Un apunte
que no mueve nada en la moneda del cuadre **no es una partida en tránsito** y sale
de la lista de pendientes (a `Ub` suma 0, así que la identidad no se toca). Es la
regla negativa de §3.5 —*una diferencia de cambio jamás aparece en `Ue` ni en
`Ub`*— aplicada donde de verdad muerde. En moneda base el caso no existe: el
CHECK del diario exige que exactamente uno de debe/haber sea > 0.

**Decisión de diseño registrada (H-5).** Un grupo de conciliación **sólo cancela
en la identidad `E − B = Ue − Ub` si TODOS sus miembros caen dentro del corte**.
Es I-E7-11 (`Σ líneas = Σ apuntes`) lo que los cancela, y esa igualdad vale
entera o no vale: el cheque contabilizado el 20-12 y cargado por el banco el
15-01 **sigue siendo un pendiente a 31-12** —y tiene que serlo, o la identidad
falla por su importe exacto— aunque ya esté punteado. Lo que sí queda es
**explicado**, que es para lo que existen los criterios 1 y 2 de §3.6.

## E9 — ronda de integración (2026-09-14): los cuatro bloqueantes de UI y el arnés

Los agentes de interfaz destaparon cinco defectos de backend. Todos cerrados con
test propio; ninguno queda anotado como deuda.

| # | Defecto | Cierre |
|---|---|---|
| 1 | `RECC_DEVENGADO_31_12` devolvía **`NA`** fuera del régimen de caja y `canCloseFiscalYear` exige PASS en los nueve: **ninguna organización en régimen general podía cerrar el ejercicio**. Y `capitalGoodsGuard` salía WARN —bloqueante— con un activo > 3 005,06 € en cuanto **no** había prorrata declarada, contra la letra de R-IVA-16 | **Decisión contable**: fuera del RECC el paso devuelve **PASS** con evidencia «régimen de caja no aplica en el ejercicio»; `NA` queda sólo para los pasos informativos (los societarios posteriores al cierre, ninguno bloqueante). La guardia del art. 107 sólo se dispara si existe algún año con prorrata ≠ 100 %. `models/closing.ts` calcula ya `reccPendingCents` de verdad: `null` si no hay `VatRegimePeriod` RECC vigente en el ejercicio, y el saldo pendiente de `4778`/`4728` de N−1 si lo hay. Tests: `lib/closing/checklist.test.ts` (ejercicio vacío cerrable, ningún bloqueante puede salir `NA`), `lib/closing/vat.test.ts` y el nuevo `tests/integration/e9-cierre-completo.test.ts` |
| 2 | **Dos formas para la clave de periodo**: la base escribía `AAAA-Tn` (`app.iva_period`, el trigger y seis CHECK de T4) y el motor leía `AAAA-Qn`. Con régimen trimestral el libro registro salía **vacío** y no se podía dar de alta una regla trimestral | Forma canónica **`AAAA-Qn`** — la del diseño §4.1 y §5.3, la de ADR-0014 D8 (`quarterOf` de E8) y la de los fixtures sellados. Migración **aditiva** `20260921090000_e9_periodo_iva_canonico`: reemplaza la función, suelta los seis CHECK, reescribe lo guardado bajo `NO FORCE`/`FORCE` y los vuelve a poner. El rodeo del régimen mensual del e2e desaparece: `recurrentes-iva.spec.ts` corre **trimestral** de extremo a extremo |
| 3 | `recurring_occurrences_entry_iff_generada` (T4) contra el orden de `recordOccurrenceTx` (T12): la ocurrencia se insertaba `GENERADA` con `entry_id` nulo y el CHECK abortaba. Además el `UPDATE` posterior era imposible por la política append-only. **Ninguna generación real se contabilizaba** | Orden invertido: **asiento primero**, ocurrencia después **ya enlazada** en un solo `INSERT`. La restricción de la base sigue garantizando `entry ⇔ GENERADA` **en todo momento** —garantía más fuerte que un trigger diferido— y la idempotencia sigue siendo el índice único, reforzada por la clave de idempotencia del asiento |
| 4 | `sellAssetAction` / `disposeAssetAction` no reenviaban el destino analítico del activo a T-33/T-34: con `analyticsRequired`, «la cuenta 771 exige exactamente un destino analítico» y **no se podía contabilizar ninguna baja ni venta** | El resultado de la enajenación hereda el destino **del activo** (`FixedAsset.projectId`/`costCenterId`), y las dos acciones admiten además uno explícito que manda sobre él (`forms/assets.ts`). Test de integración con `analyticsRequired = true` |
| 5 | `scripts/load-fixture.ts --reset-org` no conocía las tablas de E9 | Las trece, en orden de FK: once antes del diario y `asset_revisions`/`fixed_assets` después (`journal_lines.fixed_asset_id` es RESTRICT). Los `beforeAll` de `cierre.spec.ts` y `recurrentes-iva.spec.ts` ya no limpian a mano —el `resetE9` del segundo ni siquiera funcionaba: iba con el rol propietario y las políticas RESTRICTIVE lo dejaban en nada, con el error tragado por un `.catch()`— y los dos `test.fixme` están activos |

**Además**: `tests/support/fixtures.ts` carga ya los `accountsExtra` del fixture en
el plan (`planWithExtras`) y las `DEFERRED_ACCOUNT_KEYS` de E9 con su código
exacto (`fixtureAccountMap`). Sin eso `ejercicio-completo-v2` no resolvía ni su
primer asiento.

### Anotado para T26 — **CERRADO en la ronda 1 (2026-09-14)**

Las tres discrepancias documentales se han resuelto; ninguna queda abierta.

1. **22 vs 23 pares** → **22**. Corregido en `docs/design/E9-cierre-recurrentes.md`
   (§0, §4.5, D5/R2-1, plan de tareas) y en ADR-0016, con nota fechada.
2. **41 vs 43 pasos** → **43**, los que la tabla de §4.8 enumera. Corregido en el
   diseño y en ADR-0016 D9.3. Los **nueve bloqueantes** no cambian.
3. **Interés implícito 442 817 vs 454 133** → **442 817**, y **no era
   documental**: era un error de cálculo del criterio 22. Recomputado a mano con
   la convención que fija **ADR-0016 D7.3** —un ÚNICO tipo **mensual** declarado,
   el mismo para descontar y para devengar—. El tipo que produce el valor actual
   8 899 964 desde 10 000 000 a 24 meses es `1,06^(1/12) − 1`; devengarlo diez
   meses con truncamiento mensual da **442 817** exacto, que es lo que dicen el
   fixture sellado `valor-actual-esperado.json` y el motor. Los 454 133 salían de
   **mezclar dos tipos** (descontar al efectivo y devengar al nominal 6 %/12, que
   da 455 139), justo la ambigüedad que D7.3 existe para eliminar. Se corrigen
   §12 criterio 22, §4.7 de `E9-validacion-cierre.md`, ADR-0016 y
   `cierre-e9.test.ts`; **el fixture no se toca** y no hace falta reversionarlo.

## E9 — ronda 1 de corrección (2026-09-14): auditoría, revisión y QA

Entradas: `docs/design/E9-auditoria-informe.md` (DISCREPANCIA, H-1…H-6),
`docs/design/E9-revision.md` (1 BLOQUEA, 8 DEBE, 3 PUEDE) y QA (BUG-E9-1,
`perf-closing.test.ts` con cuatro techos en `.skip`). **Todo cerrado con test.**

| # | Hallazgo | Cierre |
|---|---|---|
| **H-1** BLOQ. | `readMaturityPositions` devolvía `credit − debit` y `lib/closing/reclass.ts` espera **`debe − haber`**: T-32 se posteaba **al revés** (`523 (D) / 173 (H)`), inflando el pasivo no corriente y dejando el corriente **negativo**. Silencioso: I-E9-16 cuadraba y el paso salía PASS | La convención se unifica en **`debe − haber`** y se **escribe en el tipo** (`MaturityPositionRow.openCents`, renombrado desde `balanceCents` para que nadie asuma un signo). Corregidos los dos llamantes. Test de **DIRECCIÓN** sobre un pasivo real (`173 → 523`: `173 (D) / 523 (H)`) y un activo real (`253 → 543`: `543 (D) / 253 (H)`), con el saldo resultante: el pasivo corriente no puede quedar deudor |
| **H-2** BLOQ. | Los **27 `I-E9-*` nunca corrían**: `runInvariantsPure` los ejecuta `if (input.closing)` y `models/ledger.ts` no rellenaba `closing`. 0 de 215 checks sobre un ejercicio cerrado | `models/closing.readClosingInvariantInput` compone el bloque —recurrentes, activos, periodificaciones, reclasificación (con las posiciones **antes** y **después** de T-32), FX, el acto de cerrar, los `ClosingRun` y la distribución— y `runLedgerInvariants` lo cablea en el barrido de auditoría con ejercicio en el alcance. Test: los 27 ids aparecen y quedan **persistidos** en `invariant_runs`, e **I-E9-16 FALLA** si se reintroduce el signo invertido |
| **H-3** BLOQ. | La **reapertura era imposible**: `voidEntryInTx` → `buildReversal` aplica CA-1, que prohíbe anular `OPENING`/`CLOSING`/`REGULARIZATION`, y el trigger de la base repite la regla. D1, O-21 e I-E9-21 inalcanzables; el test que los cubría pasaba **en vacío** | La salida que la propia CA-1 nombra, **sólo por la vía registrada**: `VoidOptions.reopeningRunId` en el motor —que únicamente pasa `reopenFiscalYear`— y el GUC de transacción `app.reopening_run_id` en la base (migración aditiva `20260922090000_e9_reapertura_registrada`, con `app.reopening_run_id()` que exige un uuid). `voidEntry`, la anulación pública, **no lo pasa nunca**. Test sobre un ejercicio cerrado **de verdad**: cuatro contra-asientos, ejercicio `OPEN`, `129`/`6300` a cero, pasos 5-7 en `PENDIENTE_RECOMPUTO`, y `voidEntry` sigue rechazando los tres kind |
| **H-4** | El desempate del FIFO (R-RC-3) no estaba cableado: `entryNumber: 0` en los dos llamantes | `readMaturityPositions` devuelve el nº del **asiento vivo más antiguo** del grupo (`MIN(e.entry_number)`), y los dos llamantes lo pasan |
| **H-5** | El aviso de partidas **no monetarias** era inalcanzable: la consulta las filtraba en SQL y `excludedNonMonetary` llegaba siempre vacío | La marca del plan (`accounts.is_monetary`) viaja en `FxPositionRow.isMonetary` y **el motor** excluye y explica. La exclusión no cambia una cifra; ahora se ve |
| **H-6** | Alterar `debt_installments` tras el cierre no lo detectaba nadie | `ReclassBlock.tamperedSchedules`: el `scheduleHash` sellado contra el recomputado sobre los vencimientos de hoy. **I-E9-25 en FAIL** con el cuadro nombrado |
| **BLOQUEA 1** | **El paso 12 de O-17 no existía**: se sellaba T-32 misma como su propio contra-asiento y `reclass_reversal_entry_id` no lo escribía nadie. La reclasificación quedaba «pegada» en N+1 | `closeFiscalYearE9` postea el contra-asiento de T-32 **después** de la apertura (**nº 2 de N+1**, R-RC-6) y lo sella en su columna. Test: `kind = REVERSAL`, ejercicio N+1, nº 2, y en N+1 la deuda vuelve entera a `173` |
| **DEBE 2** | `aperturaEntryId` cableado a `null`: `CIERRE_APERTURA` salía WARN **para siempre** y el sello quedaba en `REQUIERE_REVISION` | Se busca `APERTURA_EJERCICIO` **en el ejercicio siguiente**, que es donde vive |
| **DEBE 5** | `postClosingStepAction` posteaba **sin `idempotencyKey`**: un doble envío duplicaba T-31 y T-25 | Clave determinista `cierre:` + sha256 de `(ejercicio, paso, plantilla)` — `idempotency_key` es `varchar(64)`— resuelta por el índice único que ya existe |
| **DEBE 6** | El cierre iba en **tres** transacciones: si fallaba la tercera, el ejercicio quedaba CLOSED y el run sin sellar. **Un cierre sin sello** | `closeFiscalYearTx` extrae el cuerpo y `closeFiscalYearE9` hace guardia + doce asientos + paso 12 + sello en **una sola** transacción |
| **DEBE 7** | El test de los doce asientos sólo comprobaba que existían las columnas, y prometía `473 = 0` sin comprobarlo | `tests/integration/e9-ronda1.test.ts` recorre las posiciones con datos reales y comprueba **`473 = 0`** tras T-25 |
| **DEBE 9** | `runClosingChecklistAction` era `VIEWER` y **escribe** (`closing_runs` + AuditLog) | Pasa a **EDITOR**; la lectura sigue en `getClosingRunAction` (VIEWER). Test de los dos lados |
| **DEBE 3** | `perf-closing.test.ts` con cuatro techos en `.skip` | **Los ocho activos.** El fixture era una comodidad, no la medida: el volumen de §9 (2 000 documentos, año completo, 200 periodos vencidos) se siembra en el propio test. Destapó un defecto real: el libro registro tardaba ~1 500 ms sobre una `journal_lines` grande porque el `EXISTS` acababa en recorrido de tabla → índice `(organization_id, account_code, entry_id)` en migración aditiva `20260922100000_e9_indice_libro_registro`. Ahora < 800 ms |
| **DEBE 4** | N+1 de la staleness de CECOs dentro de la transacción del checklist | Se **mide**, que es la alternativa que el propio revisor admite: el perf test siembra **doce `AllocationRun` mensuales sellados** —el caso que dispara el N+1— y el checklist completo sigue por debajo de los 2 000 ms de §9. La agregación en una sola consulta queda fechada abajo |
| **PUEDE 10** | `capitalGoodsGuard` devuelve `blocking: false` contradiciendo el catálogo | El campo es **inerte** y ponerlo a `true` obligaría a reversionar el fixture sellado `liquidacion-iva-esperada.json` por un dato que nadie lee. Se documenta en `ClosingStepResult.blocking`: **la única fuente es el catálogo** |
| **PUEDE 11** | Cardinales abiertos en los documentos canónicos | Corregidos (ver arriba) |
| **BUG-E9-1** | `reviseAssetAction` admitía revisiones **retroactivas** | R-AM-5 / NRV 22ª: el suelo es `max(mes siguiente al último dotado, mes en curso)`, con `refDate` **por parámetro**. Rechaza con `ASSET_REVISION_RETROACTIVE` nombrando el suelo y la salida (T-22 contra reservas) |

### Deuda nueva, fechada

1. **`ejercicio-completo-v2` sigue sin poder cargarse** y ahora se sabe por qué:
   es **internamente incoherente**. Usa `4751` directamente en sus nóminas **y**
   la clave `IRPF_A_PAGAR_123` → `47513`; al crear la subcuenta, la madre deja de
   admitir apuntes por derivación del plan y las nóminas no entran
   (`ACCOUNT_NOT_POSTABLE`). Arreglarlo exige **reversionar el fixture** (es
   inmutable) y escribir el `build_ejercicio_completo_v2.py` que nunca se hizo.
   El cargador ya lo **acepta** y `planWithExtras` resuelve sus `accountsExtra`;
   falta el fichero coherente. → **E10** (era T24; E9 cerró sin él).
2. **La staleness de CECOs sigue derivándose run a run.** Medida y dentro del
   techo con doce runs mensuales sellados; agregar los hashes por periodo en una
   sola consulta → **E10** (era T26; el cierre documental de T26 se hizo y la
   agregación no).
3. **PUEDE 12** (Σ Debe / Σ Haber sumadas en cliente para pintar el cuadre) sigue
   abierto: es feedback visual sobre líneas que compone el servidor. → **E10**.

## E9 — ronda 2 de corrección (2026-09-14): R-1, R-2 y los tres PUEDE

Entradas: la «Re-auditoría (ronda 1)» de `docs/design/E9-auditoria-informe.md`
(DISCREPANCIA: **R-1** bloqueante y **R-2** alto) y `docs/design/E9-revision.md`
(APROBADO con tres PUEDE).

| Punto | Qué estaba mal | Qué se ha hecho |
|---|---|---|
| **R-1** BLOQ. | Los contra-asientos de la reapertura se fechaban **01-01-2027** y anulaban asientos de **31-12-2026**: dentro de 2026 el cierre anulado **seguía en vigor**, el recierre no veía saldo que barrer, **omitía T-26/T-27/T-28** y aun así marcaba `CLOSED` y sellaba `CERRADO` (`entryIds` a `null`, `129 = 0`, apertura anulada sin regenerar) | **Decisión (coherente con ADR-0016 D1: la reapertura es un acto contable del ejercicio que se reabre, no del siguiente).** El ejercicio vuelve a `OPEN` **antes** de revertir y se le suelta el primer mes, así que los contra-asientos de T-25/T-26/T-27 caen **dentro** del ejercicio (31-12) y el de T-28 en su propio ejercicio (01-01 de N+1). No se ha tocado el criterio de saldos: los asientos anulados siguen en el diario, netean con su espejo y nada se «excluye» de los informes |
| **R-1** (2ª mitad) | Con `kind = REVERSAL`, el espejo de una apertura, un cierre o una regularización **no** quedaba excluido por los filtros que dejan fuera los asientos de sistema (PyG de I3/I4, `readAccountBalances`, I-E7-14, cobertura de I-E4-1): el original salía y el espejo entraba, y **el par dejaba de netear** | El contra-asiento de un asiento de sistema **hereda su `kind`** (sigue siendo contra-asiento: `reversesEntryId` + plantilla `CONTRA_ASIENTO` + espejo exacto). La base lo admite sólo en esa forma y con un `ClosingRun` real detrás (`20260923100000_e9_contra_asiento_de_sistema`); los índices «una apertura/un cierre vivo por ejercicio» dejan de contar los espejos (`20260923110000`); I-E3-4 lo distingue y sigue siendo FAIL cualquier otra anulación de los tres kind |
| **R-1** guardia | Nada impedía marcar `CLOSED` sin asientos de cierre | `closeFiscalYearTx` **aborta** si el ejercicio tiene saldo de 6/7 sin T-26, o saldo de balance sin T-27 (y sin T-28 habiendo ejercicio siguiente). Un ejercicio **vacío** se sigue cerrando sin postear nada |
| **R-1** I-E9-21 | Devolvía `INFO` en todos los barridos: no cazaba el `CLOSED` sin cierre | El bloque se compone también con el ejercicio **CERRADO** y el invariante **FALLA** nombrando T-26/T-27/T-28 sin postear. Tras reabrir, `6300` deja de exigirse a cero cuando ya hay un T-25 nuevo vivo (reabrir es para volver a contabilizar) |
| **R-1** idempotencia | Tras reabrir, `postClosingStepAction` devolvía por idempotencia el asiento **anulado** y el recierre se quedaba sin impuesto | La clave lleva la **generación de cierre** (nº de reaperturas registradas): protege del doble envío dentro de un cierre, no entre dos cierres del mismo ejercicio |
| **R-2** ALTO | Los 22 pares sólo existían por el backfill de la migración: una organización nueva tenía **0 filas** e I-E9-16 pasaba **por vacuidad** mientras la acción sí reclasificaba (caía a `RECLASS_PAIRS`) | `seedReclassificationPairs` en el alta de organización (junto al plan y el mapa, idempotente y auditado) **y** el mismo *fallback* a `RECLASS_PAIRS` en `readClosingInvariantInput`. Además, la falta de vencimiento sólo es defecto en la cuenta de **largo**: en la de corto el corto plazo es la afirmación por defecto (un 543 de T-33 nace a corto) |
| **H-5** menor | El aviso de partidas **no monetarias** no llegaba al usuario | `fxStep` lo declara en su evidencia (O-4 / I-E9-24) |
| **PUEDE (a)** | El GUC de reapertura admitía **cualquier** uuid | El trigger exige que sea un `ClosingRun` **del mismo tenant** en `CERRADO`/`REABIERTO` (`20260923090000_e9_reapertura_guc_verificado`) |
| **PUEDE (b)** | No había prueba del rollback | Test con fallo inyectado **después** de postear T-26/T-27/T-28 (contador del ejercicio adelantado → I7 en FAIL): mismo nº de asientos, mismos bloqueos, ejercicio `OPEN` |
| **PUEDE (c)** | El PASS de I-E9-4/5 callaba lo que omitía | Nombra cuántos activos dados de baja o vendidos quedan fuera |

| **menor del auditor** (ronda 2) | Tras reabrir, `IMPUESTO_BENEFICIOS` no quedaba pendiente y el recierre podía dejar el ejercicio **sin T-25**, con `129` recogiendo el resultado ANTES de impuestos: el paso sólo daba WARN y no es bloqueante | El impuesto —y el paso declarado del impuesto diferido— entran en `PENDING_RECOMPUTE_STEP_CODES`, así que la reapertura los marca `PENDIENTE_RECOMPUTO` en el `ClosingRun` sellado; y `closeFiscalYearTx` **se niega a recerrar** un ejercicio reabierto que tenga resultado y no tenga T-25 vivo |

Tests: `tests/integration/e9-ronda2.test.ts` (10). La deuda del **N+1 de la
staleness de CECOs** queda fechada en **E10**.

## E10 — ronda de integración (2026-09-15): los cuatro hallazgos de C2 y C3

Los agentes de interfaz de la ola C dejaron nombrados cuatro defectos de la capa
de modelo. Los cuatro están cerrados, cada uno con su test:

| # | Defecto | Corrección |
|---|---|---|
| **1** (BLOQUEANTE) | `previewAllocationRun` y `sealAllocationRunTx` llamaban a `allocate()` **sin** `timeEntries` ni `headcount` aunque `loadRunContext` ya cargaba `ctx.activity` (sólo se usaba para el `timeHash`): `HORAS` y `PLANTILLA` caían **siempre** en su `zeroBaseFallback` | Los dos le pasan `ctx.activity.timeRows` y `ctx.activity.headcount`, la MISMA base que el cuarto sello firma. Con 720 min aprobados y 300 sin aprobar: `W-E10-UNAPPROVED-HOURS` con su % sobre la base, reparto real y run sellable (criterios 13 y 12-bis) |
| **2** | `budgetVsActual` construía `buildVariance` **antes** que el forecast y sin pasárselo: la quinta columna estaba siempre vacía; y la vista no exponía los sellos de la cabecera | El forecast se construye primero (corte = último mes cerrado) y entra en la desviación; `BudgetVsActualView.seals` expone los **cinco** (`ledgerHash`, `analyticsKey`, `budgetHash`, `budgetRulesHash`, `gitSha`) en fresh, caché y previsualización |
| **3** | `getAnalyticsConfig` resolvía la organización con un `$queryRaw`, que con el `db` de `tenantPage()` sale de la transacción y **sin** `app.current_org` | Usa el delegado `tx.organization.findUnique` —que la extensión despacha sobre la transacción abierta— y acepta `AnalyticsReadClient = TenantTransactionClient \| TenantClient` |
| **4** | Vaciar una celda del editor la guardaba como `0,00 €` | `getBudgetVersion` devuelve el id de cada celda, la hoja lo propaga en `lineIds` y el editor separa lo tecleado (upsert) de lo vaciado (`deleteBudgetCellsTx`). **Teclear `0` sigue siendo un cero declarado** |

**Deuda nueva, fechada.** Con granularidad `MONTH` la matriz etiqueta la celda
con su mes cuando el periodo pedido cae dentro de **un** mes; un periodo de
varios meses pedido como `MONTH` sigue devolviendo el acumulado con
`month = null`. El desglose mes a mes **dentro de un mismo informe** se cierra en
**E11**, junto con la descomposición volumen/precio (Q-6 / D6), que es la que
fija la forma definitiva de la celda mensual. Registro:
`2026-09-15_e10_ronda_integracion`.

## E10 — ronda 1 de corrección (2026-09-15): auditoría, revisión y QA

Entradas: `docs/design/E10-auditoria-informe.md` (DISCREPANCIA, H-1…H-7),
`docs/design/E10-revision.md` (BLOQUEADO: 3 BLOQUEA, 5 DEBE, 7 PUEDE) y QA
(BUG-E10-1, BUG-E10-2). Todo cerrado; lo que queda abierto va abajo **con épica
y fecha**, como exige el §Estándar de calidad de `CLAUDE.md`.

| # | Hallazgo | Corrección |
|---|---|---|
| **H-1** GRAVE | Los dieciocho `I-E10-1…18` eran **código muerto**: `runInvariantsPure` los ejecuta `if (input.budget \|\| input.time)` y `models/ledger.runLedgerInvariants` **no rellenaba ninguno de los dos bloques**. La familia `PRESUPUESTO` de `/audit` salía siempre `SIN_EVALUAR` y los cinco motivos de sello de E10 no llegaban al sello del periodo (el H-2 de E9 repetido) | `models/budget-invariants.readBudgetInvariantInput` compone los bloques `budget` y `time` desde la base —versiones con su hash recomputado, líneas, matriz, partes, tarifas, plantilla, runs sellados con su ventana y la absorción de 64x— y `runLedgerInvariants` los pasa, con `budgetSealReasons()` alimentando `budgetReasons` del sello. Se lee con las mismas dos condiciones que el bloque de cierre: barrido de auditoría **y** ejercicio en el alcance |
| **H-1-bis** (destapado por H-1) | Con el bloque cableado, **I-E10-9 daba FAIL sobre datos perfectos**: agrupaba por `(ejercicio, escenario)` y exigía revisiones correlativas desde 0 dentro de cada escenario, cuando la numeración de `createBudgetVersionTx` es **una sola serie por ejercicio** (BASE = 0, cada REVISADO la siguiente) y el `EXCLUDE USING gist` también acota por ejercicio. El caso del propio fixture sellado —BASE rev 0 + REVISADO rev 1— salía «la revisión 1 rompe la correlatividad» | `checkIE109` agrupa por ejercicio. Es la prueba de que un invariante que nadie ejecuta no vigila nada |
| **H-2** GRAVE | `valid_to` entraba en la forma canónica del `budgetHash`, pero es **mutable por diseño**: al sellar la siguiente versión, `sealBudgetTx` cierra la anterior con `validTo = validFrom − 1 día` (O-E10-8) y el trigger lo admite. El hash de toda versión relevada dejaba de ser reproducible e **I-E10-6 daba FAIL sobre datos íntegros** | Fuera de la cabecera. Test: sellada la REV1, la BASE tiene `validTo = 2026-06-30` y su hash **sigue** siendo el sellado |
| **H-3** / **BLOQUEA 3** | El `budgetHash` **no cubría las horas presupuestadas**, contra ADR-0018 D2 y §3.8. Y las horas alimentan la liquidación presupuestaria en dry-run, o sea las celdas de MC3 **por dimensión** del informe | Las líneas de horas entran en la forma canónica, en minutos enteros. `budgetHoursHash` se **retira** (DEBE 8): la función que sellaría las horas existía y no se usaba. Fixture reversionado a **`presupuesto-horas-esperado.v1.1.json`** (schemaVersion 1.1); el v1.0 queda congelado |
| **H-4** | `budget_lines_sign_by_type` empezaba por `sign_exception OR …` sin comprobar la familia de la cuenta: por SQL entraba una `640` de +123 456 c con la bandera puesta | `20260925090000_e10_ronda1_signo_y_reset`: la excepción sólo vale en `61x`/`71x`, `706`/`708`/`709`, `79x`/`759` (`app.budget_sign_exception_allowed`). Se retira de paso la rama `analytic_type IS NULL`, inalcanzable desde O-E10-23 (PUEDE 10) |
| **H-5** | `absorption.byCostCenter` traía `valuedCents: 0` en todas las filas y dos filas llevaban `PROJ:…` en un campo llamado `costCenterCode`: **infraabsorción del 100 %** en todas las unidades con el total correcto | El desglose compara ahora dos magnitudes reales y comparables: `payrollCents` = Σ 64x **de ese CECO** (las imputadas a proyecto van a `SIN_CECO`, no disfrazadas de CECO) y `valuedCents` = Σ del coste de los partes de **los empleados de ese CECO** (`Employee.defaultCostCenter`), sea cual sea el receptor |
| **H-6** | §3.6 y la redacción de I-E10-3 decían que el peso de `HOURS` son los minutos de la ventana **efectiva del run**; la implementación usa la del **periodo** y sólo la ensancha cuando el fallback se aplicó de hecho | Corregido el diseño (la implementación era la correcta) |
| **H-7** | La provenance de `PRESUPUESTO_REAL` era un bloque de run, no **por celda**: el drill-down prometido por §5.1 obligaba a escribir las consultas a mano | `budgetProvenanceByCell` (`lib/budget/variance.ts`) compone, celda a celda, las consultas parametrizadas de `registros_origen`: `real`, `imputado`, `presupuesto` (de la versión que gobierna ESE mes, O-E10-9) y `horas` |
| **BLOQUEA 1** | T19 sin ejecutar: **ninguno** de los nueve techos de §9 medido | `tests/integration/perf-budget.test.ts` mide los nueve sobre el volumen exacto de §9 (28 800 celdas, 500 celdas por lote, 30 000 líneas de import, 40 empleados × 22 días, 120 000 partes, 17 periodos y 17 runs), con ms **y** conexiones, y **contando las consultas** del lote de staleness |
| **BLOQUEA 2** | Tres deudas declaradas en `runs/registro.jsonl` que no llegaron a `ESTADO.md` | Las tres, abajo: dos **cerradas ahora** y una fechada |
| **DEBE 4** | `HORAS_SIN_APROBAR` no se emitía con base aprobada 0: la rama del `zeroBaseFallback` salía antes de mirar los minutos sin firmar, y el run se sellaba **sin el motivo** en el caso más grave (100 % sin aprobar) | El aviso se calcula antes de la rama, con `shareOfBaseBps: null` (que dejaba de ser una rama inalcanzable del tipo). Alineado también el generador Python: el caso `criterio-13-bis` del fixture lo publica |
| **DEBE 5** | O-A6 declarada ABIERTA en dos documentos pese a estar cerrada con SQL, y `MODELO-DATOS.md` sin las siete tablas | O-A6 **CERRADA** aquí y en `MODELO-DATOS.md`, que incorpora `Budget`, `BudgetLine`, `BudgetHoursLine`, `TimeEntry`, `Employee`, `EmployeeRate` y `HeadcountSnapshot` |
| **DEBE 6** | `proposePayrollReclass` sin ningún consumidor: el camino (b) de §3.7 era inalcanzable desde el producto | Acción ADMIN **«Proponer reclasificación de nómina por horas»** en `/analytics/projects`, que propone y delega en `reclassifyLines` (ADR-0010) tras confirmación |
| **DEBE 7** | Varias transacciones por petición en `/analytics/budget` y `/time`, contra el «una transacción por petición (`tenantPage`)» de §9 | Las dos páginas leen dentro del `db` de `tenantPage`; las server actions quedan para las mutaciones |
| **QA BUG-E10-1** | `--reset-org` no vaciaba presupuesto ni horas: `budgets.fiscal_year_id` es `RESTRICT` y las suites e2e se contaminaban entre ficheros | Integrado el arreglo de QA en `scripts/load-fixture.ts` y el nuevo `tests/integration-rls/e10-tenant.test.ts` (criterio 24, las siete tablas) |
| **QA BUG-E10-2** | Un parte APROBADO no se podía borrar **ni desde `app_maintenance`**: `--reset-org` moría en `time_entries` | Nivel 2, nota fechada en ADR-0018 (**D7**, aprobada por permiso delegado 2026-09-15): GUC de transacción `app.maintenance_reset_org`, **verificado** contra la organización de la fila y contra el rol de operador (patrón `app.reopening_run_id` de E9). La aplicación no conecta nunca con ese rol |

### Re-auditoría de la ronda 1 (2026-09-15): los cuatro puntos

El auditor volvió sobre `5d2d2ba…aa7a7d0` y cerró H-1, H-2, H-3, H-4, H-6 y D7.
Quedaban cuatro cosas, todas cerradas aquí:

| # | Punto | Corrección |
|---|---|---|
| **1** GRAVE (regresión) | `readPayrollAbsorption` no excluía `REGULARIZATION`/`CLOSING`/`OPENING`: el asiento de regularización **abona** las 640/642 y dejaba la nómina del mes en negativo, así que la guarda leía `0 ≤ −2 640 000` como un exceso. **Todo ejercicio cerrado** quedaba con la familia PRESUPUESTO en FAIL y el periodo en REQUIERE REVISIÓN con los datos intactos | Se aplica la MISMA convención que la PyG (I3). Test: con el asiento de regularización puesto, I-E10-12 **PASS**; con una 640 alterada por SQL, **FAIL** |
| **2** | H-5 cerrado en el producto pero **no en el fixture**: `build_absorption()` repartía lo valorado por el RECEPTOR, así que las tres filas de CECO salían a 0 y dos llevaban `PROJ:…` en un campo llamado `costCenterCode`. El contrato congelado de D6 y el motor decían cosas distintas | El generador reparte lo valorado por el CECO del **empleado** y manda a `SIN_CECO` lo que no es de ningún CECO. Fixture **v1.2** (los dos `budgetHash` NO cambian; v1.1 queda congelado). Test byte a byte: Σ por CECO = −22 787 c |
| **3** | La provenance por celda filtraba por los tipos **del nivel** y la matriz es **acumulativa**, así que una celda de MC3 devolvía **0 filas**; y fijaba una celda anual a `month = '<año>-01-01'` | Las consultas acumulan los niveles ≤ N, abren el rango a los meses del periodo y respetan la **composición** mes a mes (O-E10-9): `budget_id IN (…) AND month BETWEEN …` contaba julio-diciembre dos veces. Test de integración que **ejecuta** las consultas: Σ real = `actualCents`, Σ presupuesto = `budgetCents`, Σ minutos = los presupuestados |
| **4** | La inyección (b) sólo la detecta un tenant **con** un run sellado de driver de actividad, y el arnés del auditor no tenía ninguno | El arnés sella un run con driver `HOURS` **y un segundo** con la misma ventana: alterar un parte APROBADO pone a los **dos** en FAIL por I-E10-17 y el run sale `STALE` por el camino del producto; alterar una `allocation_line` rompe I5 / I-E5-12. I-E10-17 ya recorría todos los runs con driver de actividad —no sólo el último—, y ahora el test lo demuestra con dos |

### Residuales del auditor (2026-09-15), cerrados

| # | Punto | Corrección |
|---|---|---|
| **1** | `I-E10-12` usaba `costOfTime().totals.valuedCents`, que **descarta el receptor entero** cuando uno de sus partes no tiene tarifa (en el fixture, `P-01` con 834 500 c): comparar un numerador incompleto contra la nómina completa es una cota floja **justo donde falta el dato**, y decir PASS ahí es afirmar lo que no se ha comprobado | Con receptores no evaluables la guarda sale **`INFO`** nombrándolos con su motivo —nunca PASS con numerador parcial—; con todos evaluables usa el numerador completo. Test para los dos casos |
| **2** | El contra-apunte del fixture se fechaba tres días después del original (2026-09-30 contra 2026-09-27) y `app.assert_time_entry_correction_mirror` **lo habría rechazado**: el contrato sellado y el producto decían cosas distintas | Manda el diseño §3 y el trigger: **el contra-apunte lleva la fecha del original** —el parte dice cuándo se trabajó, y el techo diario agregado por (empleado, día) sólo netea si el par comparte día—. Generador y fixture alineados en **v1.3** (cambian los tres `timeHash`; los dos `budgetHash`, no), con `direction` sellado e incluido `SIN_NOMINA_QUE_ABSORBER`. Test: por SQL con otra fecha, la base rechaza; por la acción, la fecha es la del original |

**PUEDE atendidos**: 9 (los dos recuentos del diseño: nueve techos y ocho
enums), 10 (rama muerta del CHECK de signo), 11 (`REVOKE DELETE ON employees`),
12 (`timeWindowOf` sólo se ensancha por drivers de actividad), 13
(`applyHourlyCostAction` devuelve error cuando la propuesta no es evaluable), 15
(`upsertBudgetHoursAction` en la matriz de roles de §4.2). **PUEDE 14** (validar
extensión/mimetype del fichero importado en el borde) queda abierto abajo.

### Deuda de E10 que sigue abierta, con épica de cierre

| Deuda | Estado | Épica de cierre | Nota |
|---|---|---|---|
| **Drill-down del informe: 28 800 celdas filtradas en memoria** (registro C1) | **CERRADA (2026-09-15)** | — | `budgetSheetSummary` agrega en SQL (recuento de filas, total, por mes y por nivel) y `getBudgetVersion(tx, id, { rows })` pagina por **fila de la hoja** —sus doce meses—, resolviendo la ventana con `row_number()` en SQL. El techo 1 de §9 se mide sobre ese camino |
| **El editor pinta las celdas de UNA versión sin paginación** (registro C2) | **CERRADA (2026-09-15)** | — | Misma corrección: la pantalla lee una página de filas y los totales del ejercicio por agregado SQL, así que el pie de la tabla no miente aunque en pantalla haya cien filas |
| **El calendario de `/time` lee hasta 5 000 partes del mes** (registro C1) | **ABIERTA**, acotada | **E11** | El listado ya pagina (`take`) y el techo 6 de §9 se mide (< 400 ms con 40 × 22 partes). Lo que falta es el **agregado por (empleado, día) en SQL** para el calendario, en vez de traer los partes y agrupar en memoria: con 40 empleados y 22 días son 880 filas, pero con 250 el calendario del mes se va a 5 000 |
| **Contrato del bloque de rentabilidad por proyecto** (registro C3, «queda abierto, sin fecha propia») | **ABIERTA**, ahora **fechada** | **E11** | Depende del contrato de la celda mensual y de la descomposición volumen/precio (Q-6 / D6), que E11 fija. Hasta entonces el bloque publica lo de §5.2 sin desglose mensual |
| **PUEDE 14** — el import valida el tamaño pero no extensión ni mimetype en el borde | ABIERTA | **E11** | Un `.xlsx` soltado por error entra como binario y sale como 30 000 rechazos en vez de un «esto no es un CSV» |
| **Granularidad `MONTH` de varios meses** (ronda de integración) | ABIERTA | **E11** | Ya fechada arriba; se mantiene |

Registro: `2026-09-15_e10_ronda1`.

## Higiene del entorno e2e (ronda 1 de E5, 2026-09-06)

`tests/e2e/session.ts` **siembra** lo que necesita en vez de darlo por hecho
(`tests/support/ensure-self-hosted.ts`, idempotente y ejecutado una vez por
proceso):

- el usuario global de `SELF_HOSTED_MODE` (`taxhacker@localhost`), su
  organización personal y su membresía ADMIN. Sin él la aplicación mandaba al
  asistente «TaxHacker: Self-Hosted Edition» y la suite fallaba en el primer
  `expect`, con un mensaje que no decía nada del problema real;
- una SEGUNDA organización, `e2e-analitica`, con el plan **sin subcuentas** y el
  fixture `ejercicio-completo` cargado. Son dos a propósito: la personal nace con
  subcuentas (`5720`, que `plan-cuentas.spec` renombra) y los fixtures se postean
  contra `572`, que en un plan con subcuentas no admite apuntes. Con una sola
  organización, además, el `--reset-org` de una suite borraba el diario de otra.
  La membresía de `e2e-analitica` se ancla en 2020 para que la organización
  personal siga siendo la que la aplicación elige sin cookie de organización
  activa; las suites analíticas plantan la cookie explícitamente.
- todas las capturas de los specs pasan `caret: "initial"`. Con el valor por
  defecto (`hide`) Playwright inyecta `style="caret-color: transparent"` en los
  `input`, y en modo dev React lo denuncia como desajuste de hidratación en la
  navegación siguiente: los specs que comprueban «cero errores de consola»
  (`libro-diario`, `plan-cuentas`) fallaban de forma intermitente por un
  artefacto del arnés, no por la aplicación.
- `adminUserId()` ya no lanza cuando no hay ningún ADMIN: devuelve el usuario
  sembrado. Las suites que degradan el rol para probar el VIEWER dejaban la base
  sin ADMIN y su `finally` moría sin restaurar el rol.

## e2e en un sandbox saturado — cómo leer un fallo (2026-09-06, ampliado en E7)

Los `test:e2e` corren contra `next dev`, y en esta máquina (8 GB, Postgres + dev
server + Chromium + la sesión del agente) hay **tres** modos de fallo que **no
son del producto** y conviene reconocer antes de perder una hora:

1. **Compilación en frío de una ruta.** La primera visita la compila Turbopack:
   medido, 30–90 s (`/ledger/new` 32,7 s · `/settings/taxes` 72 s ·
   `/settings/account-map` 10,6 s), y con el techo de 90 s por test el primero
   que toca esa ruta se va a timeout. La segunda visita baja a 0,3–3 s. Con
   `mode: "serial"` el resto del fichero queda en «did not run», así que un
   fichero entero aparece rojo por una sola compilación.
2. **El dev server crece hasta 5–6 GB** a lo largo de una sesión larga de
   compilaciones y acaba sin responder (`ERR_ABORTED`, o peticiones que nunca
   terminan). Se arregla reiniciándolo.
3. **`.next` envenenado por un `npm run build` previo** (visto en E7, ronda 1).
   Si se ha ejecutado `npm run build` y después se arranca `npm run dev` sobre el
   mismo directorio, Turbopack se queda **compilando una ruta indefinidamente**
   —medido: `/audit/bank/[id]` más de 20 minutos, con el dev server en 5,1 GB—
   sin error y sin timeout que lo corte. No es la ruta: la misma ruta compila en
   segundos con la caché limpia, y el `build` de producción la compila entera en
   71 s. **Receta**: parar el dev server, `rm -rf .next`, arrancarlo de nuevo.
   Con eso, `auditoria.spec.ts` pasó sus 7 tests en 2,6 minutos.

Cómo verificar de verdad: parar el dev server, **borrar `.next` si antes se ha
hecho un `build`**, reiniciar `npm run dev`, **calentar las rutas** con `curl` y
volver a lanzar el fichero. Y nunca borrar `.next` —ni lanzar `npm run build`—
**con el dev server arrancado**: comparten directorio.

Y un aviso sobre los tests mismos: **un e2e que depende de datos que dejó una
sesión anterior sólo falla la primera vez**, que es la peor clase de fallo. En el
cierre de E7 lo hizo `auditoria.spec.ts` §historial, que contaba los barridos del
historial en el instante siguiente a crear el suyo: sobre una base con historial
previo pasaba siempre; sobre una recién creada daba 1 y tumbaba el fichero entero
por `mode: "serial"`. Corregido con `expect.poll`. Al reproducir un fallo de e2e,
**mirar antes si la base viene de cero**.

Orden recomendado para la suite completa: **un fichero por invocación, con el dev
server reiniciado entre ficheros** (`scripts` de sesión aparte). En orden
alfabético, que es como corre Playwright: `auditoria.spec.ts` deja conciliaciones
y barridos en la organización de fixtures y `liquidacion.spec.ts` llama después a
`--reset-org` — es justo el escenario de BUG-E7-1 y hay que conservarlo.

Lo que **sí** era producto y se corrigió tras verlo aquí está en §«E8 — deuda y
decisiones»: el desajuste de hidratación por `toLocaleDateString` y el `HEAD` a
`/files/preview` que regeneraba la vista previa en cada carga de la ficha.

## E13 Autenticación — CERRADA en rama `feat/e13-auth` (2026-09-07)
Login email + contraseña (better-auth `emailAndPassword`, scrypt, ≥12 caracteres), `/enter` · `/forgot-password` · `/reset-password/[token]` · invitación con contraseña, todo con identidad CFOnomic (solo `app/(auth)/`); cambiar contraseña en `/settings/profile`; ADMIN envía enlace de restablecimiento desde `/settings/members`; `scripts/create-admin.ts` (primer ADMIN, contraseña por `ADMIN_PASSWORD`, idempotente; runbook `docs/deploy/create-admin.md`). OTP retirado. Sesión 30 d, `cookieCache` 5 min, revocación de sesiones al cambiar/restablecer. Rate limit por IP y sha256(email). Suite e2e propia `npm run test:e2e:auth` (`playwright.auth.config.ts`, `SELF_HOSTED_MODE=false`); los e2e self-hosted no cambian. Única migración: `20260919090000_e13_account_id_default` (`account.id` DEFAULT gen_random_uuid(): better-auth delega la id a la BD en Postgres — BUG-E13-1). Solape con E8: solo `models/audit-log.ts` (bloque `// E13` al final). Deuda: rate limit en memoria (E11); `settings/profile` conserva un texto heredado en inglés; Resend sin configurar en preview → el correo de reset se registra y no se envía hasta tener `RESEND_API_KEY`.
**Para activar en el preview**: fusionar `feat/e13-auth` → build aplica la migración → ejecutar `create-admin.ts` contra Supabase (`DATABASE_URL_MAINTENANCE`, ver runbook) → cambiar `SELF_HOSTED_MODE` a `false` en Vercel (Preview) → redeploy. Sin admin creado antes del cambio, nadie puede entrar.

## Preview desplegado (Pablo, 2026-09-05 20:45)
Vercel `nomicsaas-preview` (team pablo-7579s-projects) desde `main` como preview protegido por login Vercel; Supabase `nomicsaas-preview` (ref ilzqlmjbbmunwhoeyhoy, eu-west-1, free) con las 31 migraciones registradas (dos adaptadas a mano por exigir SUPERUSER: 20260904150000 y 20260906090000 — ver runbook DESPLIEGUE-PREVIEW.md en el Project). `DATABASE_URL` con `sslmode=no-verify` (deuda: CA del pooler), session pooler 5432. Cada push a `main` redespliega. URL: https://nomicsaas-preview-git-main-pablo-7579s-projects.vercel.app

## Cómo reanudar (sesión nueva)
1. `git clone https://github.com/pablopradomarr/NOMICSAAS && cd NOMICSAAS && npm install --ignore-scripts --engine-strict=false`
2. **Postgres local, desde cero.** El cluster empaquetado del sandbox **pierde los datos al reiniciar**: no supongas que `erp`/`erp_test` siguen ahí. Secuencia completa:
   ```bash
   initdb -D "$PGDATA" 2>/dev/null; pg_ctl -D "$PGDATA" -l /tmp/pg.log start
   # pg_hba.conf en `trust` para local y host 127.0.0.1/32 (es un sandbox, no producción)
   createdb erp; createdb erp_test
   ./scripts/dev-db-setup.sh                                              # roles app_runtime y app_maintenance
   DATABASE_URL=postgresql://postgres@localhost:5432/erp_test ./scripts/dev-db-setup.sh
   set -a && . ./.env && set +a
   npx prisma migrate deploy                                              # sobre DIRECT_URL (erp)
   DIRECT_URL=postgresql://postgres@localhost:5432/erp_test npx prisma migrate deploy
   ```
   Los tests de integración aplican las migraciones a `erp_test` por su cuenta (`vitest.integration.setup.ts`). Los **e2e** ya no necesitan preparar `erp` a mano: `tests/support/ensure-self-hosted.ts` siembra el usuario global, la organización personal y `e2e-analitica` con el fixture (ver §Higiene del entorno e2e).
3. Leer `CLAUDE.md`, este fichero y `docs/design/E1-revision.md`; seguir el flujo `/sprint` (dev → qa → revisor → auditor si cifras → documentador → registro).
4. Push: si el proxy devuelve 403, la sesión no tiene el repo autorizado → pedir a Pablo que añada `pablopradomarr/NOMICSAAS` a las fuentes de la sesión o un token fine-grained (Contents + Workflows: RW); mientras, entregar `git format-patch` o zip.

## Runbook de operación (E3)

**Backfills en migraciones bajo `FORCE ROW LEVEL SECURITY` (#7b de la revisión de E3).** El patrón obligatorio es `ALTER TABLE x NO FORCE` → backfill → `ALTER TABLE x FORCE` en la MISMA migración (CLAUDE.md), **y la marca de conversión se escribe ANTES del backfill**, no después: si se escribe después, el guard que la consulta no protege la primera ejecución y en un entorno donde el backfill ya se aplicó (propietario superusuario, que esquiva RLS) los valores se convertirían dos veces. `20260907110000_e3_backfill_prorrata_force` tenía ese orden invertido y lo corrige `20260907120000_e3_prorrata_marker_order`, que además verifica la marca y que la tabla no queda en `NO FORCE`. Tests: `tests/integration/e3-backfill-prorrata.test.ts`.

**FK `journal_entries.posted_by_id → users` (migración `20260907130000`).** Se añade `NOT VALID` y se valida en el acto **sólo si no hay filas huérfanas**; si las hay, la migración deja un `WARNING` y la constraint queda activa para las filas nuevas. Cierre manual del pendiente, una vez corregidas o borradas esas filas:

```sql
-- 1. Ver qué asientos no tienen autor real:
SELECT e.id, e.entry_number, e.posted_by_id FROM journal_entries e
  LEFT JOIN users u ON u.id = e.posted_by_id WHERE u.id IS NULL;
-- 2. Con la lista revisada (nunca se borran asientos: se corrige el autor), validar:
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_posted_by_id_fkey;
```

**Invariantes reproducibles.** `scripts/run-invariants.ts --org <uuid> [--ref-date AAAA-MM-DD]`: sin `--ref-date` se usa hoy en Europe/Madrid, lo que hace que I8 dependa del día. Para comparar dos ejecuciones (o para los fixtures, que llegan a 2027) hay que pasarla explícita. `GIT_SHA` debe estar en el entorno: sin él, el sello es siempre `REQUIERE REVISIÓN` a propósito, porque no se puede acreditar con qué versión del motor se calculó la cifra.

## Pendiente de Pablo (no bloquea)
- Proyecto Supabase (crear o indicar existente) para el entorno preview/prod.
- Borrar el token temporal `nomicsaas-push` en GitHub cuando ya no haga falta.
