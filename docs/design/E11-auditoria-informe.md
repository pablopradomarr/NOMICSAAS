# E11 — Auditoría adversarial de fiabilidad (plataforma SaaS, modo INTERNO)

Auditor `auditor-fiabilidad`, contexto limpio. Diff auditado `366c347…HEAD`
(`18b3326`). Se recibieron **sólo** entradas y entregables: `docs/design/E11-plataforma-saas.md`
(§3.4, §3.5, §5, §11), `docs/adr/0019-plataforma-saas.md` (D1–D9),
`docs/design/E11-validacion-plataforma.md`, los cuatro `tests/integration/e11-*.test.ts`
**como guía, no como prueba**, y `tests/fixtures/ejercicio-completo.json`. No se ha
leído ni usado razonamiento del productor.

## Método

Reconstrucción **por otro camino**, tolerancia 0:

- **Python propio** sobre el ZIP: `sha256` de cada fichero de datos, forma canónica
  del manifest (claves ordenadas, compacta) y su `sha256`, verificación del
  `HMAC-SHA256` de `signature.txt` con su `keyId`, e inventario del archivo.
- **SQL directo** (psql) contra una base aislada clonada de `erp_test`, para los
  tres sellos reimplementados desde la tupla de **ADR-0011** —no desde
  `lib/ledger/hash.ts`—, los recuentos tabla a tabla, la numeración, las nueve
  piezas de siembra, el uso derivado y las políticas/privilegios de RLS.
- El producto se ejerció **por sus server actions** (`requestBackupAction`,
  `startRestoreAction`, `changePlanAction`, ruta `POST /api/cron/[job]`,
  `createDemoOrganization`), con la sesión inyectada y contra los **dos roles**:
  `app_runtime` (el de producción) y el propietario.
- **No se importó** `lib/platform/**`, `lib/storage/**` ni `models/backups.ts` para
  reconstruir ninguna cifra.
- La base clonada se ha **eliminado** al terminar. El producto y los fixtures **no
  se han modificado** (`git status` limpio salvo el andamiaje de la auditoría, ya
  retirado).

## Cifras reconstruidas

| Métrica | Motor / manifest | Reconstrucción | Δ | Método |
|---|---|---|---|---|
| `ledgerHash` origen | `cb9c8744…0769e` | `cb9c8744…0769e` | 0 | SQL propio, tupla ADR-0011 v2 |
| `ledgerHash` destino restaurado | `cb9c8744…0769e` | `cb9c8744…0769e` | 0 | ídem, sobre la organización nueva |
| `analyticsKey` origen / destino | `05ba4b9a…7d3f` | `05ba4b9a…7d3f` (ambas) | 0 | SQL propio sobre códigos naturales |
| `budgetHash` | `null` (0 presupuestos) | sha del vacío, 0 filas | 0 | SQL propio |
| `sha256` del manifest | `aead06a7…c4eae` | `aead06a7…c4eae` | 0 | Python, forma canónica reimplementada |
| Firma HMAC `k1` | `176d1947…c023ea` | `176d1947…c023ea` | 0 | Python `hmac(clave, sha)` |
| `sha256` de las 67 tablas del ZIP | 67 declarados | 67 idénticos | 0 | Python, sha del cuerpo JSONL |
| Recuentos de las 67 tablas | 1 410 filas | 1 410 en destino | 0 | SQL, tabla a tabla |
| Numeración por ejercicio | 2026: 83/83 · 2027: 1/1 | idéntica, 0 huecos, 0 duplicados | 0 | SQL `max − count` y `count − count(distinct)` |
| Partida doble (I1) origen/destino | 84 asientos, 0 descuadrados | idéntico | 0 | SQL `Σdebe − Σhaber` por asiento |
| Uso derivado (6 cifras) | 5 / 0 / 1 / 1 / 1 / 0 | 5 / 0 / 1 / 1 / 1 / 0 | 0 | SQL con las exclusiones de §3.4 |
| Nueve piezas de siembra | — | plan 1 · mapa 61 · ejercicio 1 · `ORDINARIA`/`RECTIFICATIVA` `nextNumber`=1 · 22 pares · `MarginLevelConfig` · `OnboardingRun` · `TaxRate` IVA+IRPF · `Currency` | — | SQL |

Los tres sellos y las 67 tablas **cuadran exactamente** entre origen y destino:
el volcado, la firma y la reconstrucción del diario son correctos.

## Hallazgos

**H-1 · BLOQUEANTE · Los trece invariantes `I-E11-1…13` no existen.** No hay
ningún fichero que los implemente (`lib/*/invariants-e11.ts` no existe), ninguna
línea de producto emite un id `I-E11-*`, la familia **`PLATAFORMA` no está en
`CheckFamily`** (`lib/audit/types.ts:27-36`) ni en el mapa de prefijos
(`lib/audit/families.ts:90-101`) —un id `I-E11-*` caería en `INTEGRIDAD`—, y
`.claude/skills/fiabilidad/SKILL.md` contiene **cero** menciones a `I-E11-`, que
es donde §11 dice que se definen «una sola vez». Evidencia directa: el barrido
completo con `audit: true` sobre origen y destino devuelve **43 checks y ninguno
`I-E11-*`**. Todo lo que §11 promete vigilar —el uso derivado, las cuotas, la
cobertura del backup, la retención, la serie de plataforma, la idempotencia del
reloj— **no lo vigila nadie**. Es literalmente el riesgo que el propio diseño cita
en §5.4: «lo que no está en el enunciado no se ejecuta: H-1 de E9 y H-1 de E10».

**H-2 · BLOQUEANTE · `currencies` se pierde en la restauración, y las seis
comprobaciones lo declaran verificado.** `currencies` lleva `organization_id`, es
tabla de negocio con `FORCE ROW LEVEL SECURITY` y política propia, y la siembra le
escribe **177 filas por organización** (`models/onboarding.ts:199`; además
`models/currencies.ts:19` deja al usuario crear más). **No está en
`TENANT_MODELS`** (`lib/db.ts:88-197`), y como el inventario se deriva de ahí,
**no está en el ZIP**: el manifest tiene 67 tablas y `currencies` no es una de
ellas (verificado con Python: las tablas con `organization_id` en la base son 69;
faltan `currencies` y `platform_audit_logs`). Prueba directa: organización sembrada
con **177** currencies → backup por la acción → restauración a organización nueva →
**0** currencies en el destino, `currencies` ausente del ZIP, y **las seis
comprobaciones de §5.4 en PASS con `verified = true`**. Es exactamente el fallo
BUG-E7-1 / BUG-E9-5 / BUG-E10-1 que I-E11-7 decía cerrar «por cuarta y última
vez», y además rompe la novena pieza de I-E11-10 (`Currency` del `baseCurrency`)
en toda organización restaurada.

**H-3 · BLOQUEANTE · La demo nunca se puede crear.** `createDemoOrganization`
(`models/onboarding.ts:551-596`) crea la organización y **después** ejecuta
`UPDATE organizations SET is_demo = true`, pero el CHECK de base la declara
inmutable **también en `f → t`**: `23514 — «La marca de demo de una organización es
inmutable (O-6): f → t»`. La acción del asistente devuelve siempre «No se han
podido cargar los datos de demostración». O-6 y §6.3 están, en la práctica, sin
implementar. *Lo que sí queda probado por este mismo error es que `isDemo` es
inmutable, que era el otro extremo del encargo.* El comentario del propio código
(«la demo se marca ANTES de tener una sola fila… no hay una segunda oportunidad de
ponerlo») describe la solución correcta; el código hace lo contrario.

**H-4 · ALTA · `getSubscription` no lleva filtro de tenant, y `changeOrganizationPlan`
declara un cambio que no ha ocurrido.** `SELECT_SUBSCRIPTION`
(`models/subscriptions.ts:92-97`) es SQL crudo **sin `WHERE organization_id = …`**:
se apoya **sólo** en la RLS, que CLAUDE.md declara *segunda* barrera. Bajo cualquier
rol `BYPASSRLS` —el propietario de `DIRECT_URL`, `app_maintenance`, o un despliegue
donde el rol de la aplicación sea el dueño— devuelve la suscripción de **otra
organización**: reproducido con `app.current_org` correctamente fijado a la
organización A y la fila devuelta perteneciendo a la organización B, y `SELECT id,
plan_code FROM subscriptions` dentro de `tenantTransaction` devolviendo **las nueve
filas de las nueve organizaciones**. Como consecuencia, `changeOrganizationPlan`
(`models/subscriptions.ts:426-429`) hace un `UPDATE … WHERE id = <el de otra
organización> AND organization_id = <la propia>` que afecta a **0 filas**, **nadie
comprueba el recuento**, y la función devuelve `success: true`, escribe un
`AuditLog` `CAMBIO_DE_PLAN` y un `PlatformAuditLog` `plan.changed → FREE` mientras
la suscripción sigue en `ILIMITADO` con su `updated_at` original. **La traza miente**
(P6). Con el rol de producción `app_runtime` el cambio sí se aplica —se verificó—,
pero el registro sin comprobar el número de filas es un defecto por sí mismo.

**H-5 · MEDIA · La cuota blanda de asientos es código muerto.** `checkSoftEntries`
(`lib/platform/limits.ts:196-216`) **no tiene ni un solo llamador de producción**:
las únicas referencias en todo el repositorio están en `lib/platform/limits.test.ts`
y `lib/platform/billing.test.ts`. La función es correcta —se comprobó que devuelve
el aviso al 80 % (`usedBps` 8000) y al 101 % con `blocksAccessory: true`—, pero nada
la invoca, de modo que **nada de §3.5 ocurre**: ni el aviso al 80 % y al 100 %, ni el
motivo `CUOTA_DE_ASIENTOS_SUPERADA` en cabecera o en `/settings/subscription`, ni el
WARN en `/audit`, ni el bloqueo de lo accesorio, ni el `PlatformAuditLog` de excepción
automática. **I-E11-4(b) pasaría por vacuidad** si existiera (no existe: H-1). La
única excepción automática que sí se registra es la de `maxStorageBytes` en mora
(`models/platform-limits.ts:240-274`).

**H-6 · MEDIA · La comprobación 6 es absoluta, no enfrentada al origen: una
restauración fiel se marca `DONE_UNVERIFIED`.** Restaurando el fixture completo, el
barrido del destino devuelve `I8` e `I-E7-14` en FAIL y el trabajo termina en
`DONE_UNVERIFIED`. Reejecutado el **mismo barrido, con la misma `refDate`, sobre la
organización de ORIGEN**: **43 checks y los mismos dos FAIL**, `I8` e `I-E7-14`. La
copia es fiel al detalle —los tres sellos, los 67 recuentos, la numeración y los 53
sellos derivados coinciden—, pero `verifyRestore` (`models/backups.ts:1078`) exige
`swept.failed.length === 0` **en términos absolutos**, no `destino ≡ origen`. Toda
organización que ya tenga un invariante en FAIL —aquí, asientos con fecha posterior a
la `refDate` que la acción fija con `new Date()`— **no puede obtener jamás un backup
verificado**, y O-2 manda esa restauración buena a una etiqueta que I-E11-2 declara
FAIL.

**H-7 · MEDIA · La caché de uso sirve la cifra falseada.** Alterando por SQL las seis
columnas de `usage_runs` **sin tocar `source_hash`**, `getUsage` devuelve
`members: 77, entries: 4242` con `fromCache: true`, cuando la Σ real es `1` y `5`. Es
coherente con §3.4 («no entra ninguna cifra derivada: se validaría a sí misma»), y el
privilegio protege el camino de la aplicación (`app_runtime` recibe *permission
denied* en el `UPDATE`), pero **la detección que el diseño encomienda a I-E11-1 no
existe** (H-1): nada compara jamás la caché con la Σ real. Con la caché vacía, el
recálculo **cuadra al 100 %** con la reconstrucción SQL de las seis cifras.

**H-8 · BAJA · `platform_audit_logs` es legible por cualquier tenant y el comentario
que lo justifica es falso.** Su política de `SELECT` es `USING (true)`: cualquier
sesión `app_runtime` ve las líneas de todas las organizaciones. Hoy no es explotable
—`listPlatformAudit` (`models/platform.ts:132`) no tiene ningún llamador en `app/` ni
en `components/`—, pero es una fuga latente en cuanto alguien pinte la familia
`PLATAFORMA` de `/audit` que §3.5 promete. Y `lib/db.ts:190-193` afirma que
`platform_audit_logs` «no lleva `organization_id`»: **sí lo lleva**, con índice
`(organization_id, at DESC)`.

**H-9 · BAJA · Provenance del manifest incompleta.** `manifest.gitSha` y
`UsageRun.gitSha` valen literalmente `"desconocido"`: un backup restaurado no puede
decir qué código lo produjo, que es lo que P6 pide de una cifra derivada.

**H-10 · OBSERVACIÓN · Divergencias menores entre §3.4 y el código.** `exports` se
cuenta sobre `audit_logs` con acciones `EXPORT_*` + `BackupJob` `MANUAL`
(`models/usage.ts:94-103`), no sobre «`ReportRun` con export materializado» como dice
la tabla de §3.4; el resultado es equivalente pero el contrato escrito no lo recoge.
Y `checkLimit` sólo impide una clave blanda **por el tipo**: invocada en tiempo de
ejecución con `softMaxEntriesMonth` devuelve `ok: false`. Con I-E11-4(c) sin
implementar (H-1), la única red que queda es el compilador.

## Lo que sí quedó demostrado

- **Las tres manipulaciones del ZIP se rechazan, y la organización de origen no se
  toca**: (a) un byte cambiado en `data/accounts.jsonl` ⇒ «el sha256 del fichero de
  datos no coincide con el manifest», con tabla y línea; (b) `journal_lines` con
  `entry_id` inexistente y el manifest re-firmado con la clave real ⇒
  `SHA_DISCORDANTE` antes de tocar la base; (c) `formatVersion = "1.0"` re-firmado
  ⇒ `FORMATO_NO_SOPORTADO`. En los tres casos la organización de destino queda
  **vacía** (0 asientos, comprobado por SQL) y conservada como evidencia, y el
  recuento de organizaciones sube en exactamente 1 —el destino vacío—, nunca una
  organización a medias.
- **Modo INTERNO (D9)**: `/api/stripe/checkout`, `/portal` y `/webhook` devuelven
  **404**; **0 `PlatformInvoice`**; las **ocho** suscripciones de las ocho
  organizaciones están en `ILIMITADO`/`ACTIVE`; el plan `ILIMITADO` tiene los siete
  límites a `−1` y no es público ni tiene `stripePriceId`; y el alta de una
  organización nueva siembra las **nueve piezas** en la misma transacción.
- **Cuotas con el rol de producción**: con `FREE` asignado por la acción del
  administrador de plataforma, el documento **nº 21 se bloquea** («documentos
  analizados este mes: 21 sobre un máximo de 20»), y también el tercer miembro, el
  byte 500 MB + 1, la exportación 1 001 y la copia 1 001, todos con mensaje legible en
  español; una subida pequeña se permite; y **`postEntry` no aparece en ningún
  camino del guardián** —`assertWithinLimit` sólo acepta `HardLimitKey` y
  `HARD_LIMIT_KEYS` son exactamente las seis de recurso—, de modo que **ningún
  límite puede rechazar un asiento**. Vuelto a `ILIMITADO` al terminar.
- **Almacén**: para los dos `StoredObject` vivos, `sha256` y `sizeBytes` declarados
  **coinciden byte a byte** con los ficheros del driver local; borrado el fichero,
  `verifyObject` devuelve `{ok:false, "el objeto no está en el almacén"}`; y **no hay
  doble escritura** —ningún fichero de `data/uploads` tiene el sha de un
  `StoredObject`, y `lib/uploads.ts:277-295` retira explícitamente la copia
  transitoria de T7—.
- **Cron**: sin `Bearer` ⇒ **401**; con un token equivocado ⇒ **401** (mismo cuerpo,
  sin pista); con el correcto y `refDate` explícito ⇒ **200** con el `CronRun` en
  `DONE`; repetido con el mismo `refDate` ⇒ **200 `{skipped:true}`** y **una sola**
  fila `(job, periodKey)`. El `ref_date` se persiste tal cual se pidió
  (`2027-03-04`) y la `periodKey` se deriva de él, no del instante de ejecución;
  ninguna ocurrencia quedó fechada en el futuro.
- **Append-only y tenant**: como `app_runtime`, `UPDATE`/`DELETE` sobre
  `subscription_events` y `platform_audit_logs` fallan con **42501**, `UPDATE` sobre
  `usage_runs` también, y una lectura del diario de otra organización devuelve **0
  filas**.

## No verificable con este fixture

`ejercicio-completo.json` no trae ficheros (`manifest.files = []`, 0 bytes), ni
líneas en moneda extranjera (`global/exchange_rates.jsonl` vacío, `globalRefs.rows
= 0`), ni recurrentes (`recurring_occurrences` = 0), ni presupuestos, ni facturas
de plataforma. Por tanto **no** se han podido ejercer: la restauración de ficheros
con su `sha256` (paso 6 de §5.4), el camino O-1.5 de las tasas referenciadas, la
generación idempotente de ocurrencias pendientes, el `budgetHash` no nulo e
**I-E11-13**. No son PASS: son **SIN EVALUAR**, y con H-1 no hay invariante que los
evalúe después.

---

```
VEREDICTO: DISCREPANCIA

Cifras reconstruidas: | Métrica | Motor | Reconstrucción | Δ | Método |
| ledgerHash (origen y destino) | cb9c8744… | cb9c8744… | 0 | SQL propio, tupla ADR-0011 v2 |
| analyticsKey (origen y destino) | 05ba4b9a… | 05ba4b9a… | 0 | SQL propio sobre códigos naturales |
| sha256 del manifest + HMAC k1 | aead06a7… / 176d1947… | idénticos | 0 | Python, forma canónica y hmac |
| sha256 de las 67 tablas del ZIP | 67 | 67 idénticos | 0 | Python sobre el cuerpo JSONL |
| Recuentos y numeración | 1 410 filas · 83+1 · 0 huecos | idénticos | 0 | SQL tabla a tabla |
| Uso derivado (6 cifras) | 5/0/1/1/1/0 | 5/0/1/1/1/0 | 0 | SQL con las exclusiones de §3.4 |

Hallazgos:
1. BLOQUEANTE — los trece I-E11-1…13 no existen: sin implementación, sin familia
   PLATAFORMA en CheckFamily, sin una sola mención en SKILL.md, y 0 checks I-E11-*
   en el barrido real (43 checks, ninguno).
2. BLOQUEANTE — `currencies` (177 filas por organización, con organization_id y RLS)
   no está en TENANT_MODELS ni en el ZIP: 177 → 0 tras restaurar, y las SEIS
   comprobaciones en PASS con verified = true. Es BUG-E7-1/E9-5/E10-1 por cuarta vez.
3. BLOQUEANTE — la demo nunca se crea: `UPDATE … SET is_demo = true` choca con el
   CHECK de inmutabilidad (23514, «f → t»). O-6 y §6.3 sin implementar.
4. ALTA — `SELECT_SUBSCRIPTION` sin filtro de tenant (models/subscriptions.ts:92);
   bajo rol BYPASSRLS devuelve otra organización y `changeOrganizationPlan` actualiza
   0 filas pero responde success y registra un CAMBIO_DE_PLAN que no ocurrió.
5. MEDIA — `checkSoftEntries` es código muerto (sólo sus tests lo llaman): §3.5 —aviso
   al 80/100 %, motivo, WARN en /audit, bloqueo de lo accesorio— no ocurre nunca.
6. MEDIA — la comprobación 6 es absoluta: origen y destino dan los MISMOS dos FAIL
   (I8, I-E7-14) y la restauración fiel se marca DONE_UNVERIFIED.
7. MEDIA — la caché de `usage_runs` falseada sin tocar `source_hash` se sirve tal cual
   (77/4242 frente a 1/5), y no hay I-E11-1 que lo detecte.
8. BAJA — `platform_audit_logs` con política SELECT USING(true) (fuga latente) y el
   comentario de lib/db.ts:190 que niega su `organization_id` es falso.
9. BAJA — `gitSha = "desconocido"` en el manifest y en `UsageRun`: sin provenance.

Trazabilidad: OK — elegido el `ledgerHash` cb9c8744…, reconstruido en < 2 minutos desde
`journal_lines ⋈ journal_entries` con la tupla de ADR-0011, y las 67 tablas del ZIP
enfrentadas una a una a su sha256 y su recuento.

Recomendación: no cerrar E11. Implementar I-E11-1…13 con su familia PLATAFORMA (H-1);
añadir `currencies` a TENANT_MODELS y al inventario, con test de pérdida (H-2); marcar
`is_demo` en el INSERT (H-3); filtrar por `organization_id` en SELECT_SUBSCRIPTION y
exigir 1 fila afectada antes de registrar el cambio (H-4). H-5 a H-9, en la misma ronda.
```

---

# Re-auditoría (ronda 1) — diff `18b3326…1ef4692`

Base aislada clonada de `erp_test`, ejercida por las server actions y con los **dos roles**
(`app_runtime` y propietario `BYPASSRLS`); reconstrucción por SQL propio (ADR-0011) y Python sobre el ZIP.

| # | Comprobación | Resultado |
|---|---|---|
| 1 | Los **13** `I-E11-1…13` en el barrido, familia `PLATAFORMA` (56 checks, antes 43) | **CERRADO**. Inyecciones: caché falseada → `I-E11-1:FAIL`; sin `Subscription` → `I-E11-5:FAIL`; sin serie `RECTIFICATIVA` → `I-E11-10:FAIL`, y `PASS` al reponerla (el invariante mira `kind`, no sólo `code`) |
| 2 | `currencies` **177 → 177**, seis comprobaciones `PASS`, `DONE`/`verified` | **CERRADO**. ZIP = 65 tablas = `BACKUP_TENANT_MODELS`; de las 69 con `organization_id` en la base, las 4 ausentes son las 4 exclusiones declaradas |
| 3 | Demo con `isDemo` en el `INSERT`, fixture v1, `UPDATE t → f` | **CERRADO**. `ledgerHash` de la demo `cb9c8744…`, el conocido; el `UPDATE` se rechaza |
| 4 | `changeOrganizationPlan` cruzado | **CERRADO**. Como propietario, `getSubscription` ya devuelve **su** organización (antes la de otra); el `UPDATE` exige `afectadas === 1`; la organización ajena cambia, la propia no se toca, un solo registro |
| 5 | Cuota blanda | **CERRADO**. `noteSoftEntryQuota` (llamada desde `postEntry`, `models/ledger.ts:1197`) da `warn {current 6, soft 5, CUOTA_DE_ASIENTOS_SUPERADA}`, escribe `LIMITE_EXCEPCION_AUTOMATICA`, **no lanza**, y el guardián duro no admite la clave blanda |
| 6 | Comprobación 6 **relativa** | **CERRADO**. Origen y destino con los mismos tres FAIL (`I8`, `I-E7-14`, `I-E11-10`) ⇒ `DONE` / `verified: true` |
| 7 | Caché de uso falseada | **CERRADO**. Limpia → `I-E11-1:PASS`; falseada (77/4242) → `I-E11-1:FAIL` |
| 8 | Cifras de la ronda 0 | `ledgerHash` `cb9c8744…`, `analyticsKey` `05ba4b9a…`, idénticos en origen y destino y a la ronda 0; 84 asientos, 0 descuadrados. **Δ = 0** |

**H-8 cerrado** además: la política de lectura de `platform_audit_logs` pasa de `USING(true)` a
`organization_id IS NULL OR = app.current_org()`, y el comentario falso de `lib/db.ts` está corregido.

**Observaciones (no bloquean).** (a) **I-E11-7 mira el esquema de Prisma, no el catálogo**: una tabla
con `organization_id` creada por SQL directo (`auditoria_fantasma`) **no** se detecta —sigue en `PASS`—.
Cubre el fallo real (un modelo Prisma fuera del inventario), pero enfrentarlo también a
`information_schema` cuesta una consulta y cierra el hueco entero. (b) `GIT_SHA` sigue en
`"desconocido"` por defecto (H-9): es variable de despliegue, no código.

```
VEREDICTO: CONFORME

Cifras reconstruidas: | Métrica | Motor | Reconstrucción | Δ | Método |
| ledgerHash origen y destino | cb9c8744… | cb9c8744… | 0 | SQL propio, tupla ADR-0011 v2 |
| analyticsKey origen y destino | 05ba4b9a… | 05ba4b9a… | 0 | SQL propio sobre códigos naturales |
| currencies tras restaurar | 177 | 177 | 0 | SQL, origen vs destino |
| Inventario del ZIP | 65 tablas | 69 con organization_id − 4 exclusiones declaradas | 0 | Python + information_schema |
| Partida doble en el destino | 84 asientos | 0 descuadrados | 0 | SQL Σdebe − Σhaber |
| ledgerHash de la demo | cb9c8744… | cb9c8744… | 0 | SQL propio sobre la organización de demo |

Hallazgos: los nueve de la ronda 0 se dan por cerrados, ocho comprobados de forma
adversarial (inyección que debe fallar + estado correcto que debe pasar) y el noveno
(H-9, gitSha) es variable de despliegue. Queda una observación nueva, no bloqueante:
I-E11-7 se verifica contra el esquema de Prisma y no contra el catálogo de la base.

Trazabilidad: OK — elegido el ledgerHash cb9c8744…, reconstruido en < 2 minutos desde
journal_lines ⋈ journal_entries, y el inventario del ZIP enfrentado a information_schema.

Recomendación: E11 puede cerrarse. Añadir a I-E11-7 el contraste con information_schema
y fijar GIT_SHA en el despliegue; ambas cosas caben en la épica siguiente.
```
