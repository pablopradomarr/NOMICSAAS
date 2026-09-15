# ADR-0020 — Escrituras de operador en `/admin`: excepciones auditadas, caducas y que nunca tocan el diario

**Estado:** **APROBADO por Pablo** (permiso general delegado de 2026-09-04)
**el 2026-09-15**, **D1–D6** · **Nivel:** 2 ·
**Fecha:** 2026-09-15 · **Épica:** E12 ·
**Diseño:** `docs/design/E12-fiabilidad-dod.md` §5 ·
**Complementa:** ADR-0003 (el diario es la fuente única y nada se borra),
ADR-0008 (`AuditLog` append-only), ADR-0009 (RLS estricta y rol
`app_maintenance`), ADR-0012 (motivos de sello), ADR-0015 D3 (retención),
ADR-0019 D9 (el cambio de plan ya es una acción de administración con
`PlatformAuditLog`) ·
**No enmienda ninguno.**

> **Firmado.** Las tareas que bloqueaba —**T12** (modelo, migración, `I-E12-5`) y
> **T13** (las cuatro escrituras, UI y revocación de privilegios) del plan de §11
> del diseño— quedan **desbloqueadas**, con los criterios de aceptación 40–46.

---

## Contexto

Hay cuatro operaciones que la plataforma necesita y que hoy **sólo** se pueden
hacer con `psql` en la mano:

1. **Vaciar una organización** de pruebas o de demo (`--reset-org` existe como
   script, pero su lista de tablas ha fallado cuatro veces: BUG-E7-1, BUG-E9-5,
   BUG-E10-1, BUG-E11-2).
2. **Desbloquear** algo que una guardia dejó atascado: un `PeriodLock` puesto por
   error, una guardia de cierre, un `RestoreJob` colgado, un job de cron en
   `PARTIAL` que no avanza.
3. **Reasignar el plan** de una organización — ya existe desde ADR-0019 D9, pero
   sin motivo obligatorio ni doble confirmación.
4. **Purgar lo que la retención ya ordena** purgar.

Hacer esto por SQL tiene tres defectos que no son de comodidad:

- **No deja motivo.** Seis meses después nadie sabe por qué se vació aquello.
- **No deja actor.** El `AuditLog` del cliente no registra que alguien de la
  plataforma tocó sus datos, y el cliente tiene derecho a saberlo.
- **No tiene límites.** Nada impide que un `DELETE` mal escrito alcance
  `journal_lines`. La partida doble está protegida por *constraint trigger*; el
  **borrado**, no.

Y hay un riesgo mayor que los tres: que un panel de operador se convierta en la
manera elegante de **apagar la capa de fiabilidad**. Un ERP que puede saltarse
sus propios invariantes desde un botón no tiene invariantes: tiene sugerencias.

---

## Decisión

Se crea `/admin` con **cuatro** escrituras de operador, gobernadas por **cinco
reglas** que no admiten excepción.

### D1 — Las cuatro operaciones, y sus límites duros

| Operación | Qué hace | Límite que no se negocia |
|---|---|---|
| **`reset-org`** | Vacía una organización entera | **Se niega si existe un solo `JournalEntry`.** No hay `--force`, ni bandera, ni confirmación que lo supere. La lista de tablas se **deriva de `TENANT_MODELS`** |
| **`unblock`** | Levanta **una** guardia nombrada: `PeriodLock`, guardia de cierre, `RestoreJob` colgado, job de cron en `PARTIAL` | **Nunca levanta un invariante.** Levanta la *puerta*; el invariante que la cerró sigue en FAIL y sigue moviendo el sello |
| **`reassign-plan`** | Cambia el plan (ADR-0019 D9) | Gana motivo obligatorio y doble confirmación |
| **`purge-retention`** | Ejecuta la purga que la política ya ordena | Sólo lo vencido por `expiresAt`; enumera antes de borrar; nunca un `BackupJob` con `RestoreJob` vivo (I-E11-11) |

No hay una quinta. Añadir una exige enmendar este ADR.

### D2 — Ninguna escritura de operador toca el diario

Prohibido `INSERT`, `UPDATE` y `DELETE` sobre `journal_entries`, `journal_lines`,
`audit_logs`, `extraction_runs`, `invariant_runs` y `closing_runs`. Se garantiza
por **tres** vías independientes, no por una:

1. **Privilegios**: el rol que sirve `/admin` no los tiene.
2. **Test estático sobre el AST** de `app/(app)/admin/**`.
3. **`I-E12-5`** en el barrido.

*Corolario de `reset-org`*: vaciar una organización **con** asientos no es una
operación de operador. Es una decisión contable, y la respuesta es que no se
hace: un asiento se anula con contra-asiento (ADR-0003).

### D3 — Motivo obligatorio y actor registrado, en los dos registros

Motivo ≥ 20 caracteres, con lista negra de genéricos (`test`, `arreglo`, `.`, la
cadena vacía, sólo espacios). Se escribe en:

- **`PlatformAuditLog`** con `action ∈ {admin.reset_org, admin.unblock,
  admin.plan_changed, admin.purge_retention}` y `detail = { reason,
  confirmedName, before, after, affectedCounts }`;
- y, cuando la operación afecta a una organización, **también en su `AuditLog`**.
  El cliente ve que alguien de la plataforma tocó algo suyo.

### D4 — Doble confirmación verificada en el servidor

La segunda confirmación exige **teclear el nombre exacto** de la organización. La
acción **recibe** ese nombre y lo compara en el servidor. Una confirmación que
sólo vive en el diálogo no es una confirmación: es una animación.

### D5 — Una excepción es un evento, no un estado

`unblock` no cambia una bandera: crea una fila `OperatorException` con
`expiresAt`. **CHECK en base**: `expires_at > created_at` y
`expires_at <= created_at + 24 h`. Cuando caduca, la puerta vuelve a estar
cerrada sin que nadie haga nada. **No existen excepciones permanentes**, y no
existe forma de renovar una sin crear otra —con su motivo y su registro.

### D6 — Toda excepción viva mueve el sello

Motivo de sello nuevo **`EXCEPCION_DE_OPERADOR_VIGENTE`**, familia `PLATAFORMA`,
naturaleza `ENTORNO` (no cambia una cifra; cambia lo que se puede afirmar de
ella). Un periodo con una excepción viva **no puede** firmarse como `VALIDADO
AUTOMÁTICAMENTE`.

Esta es la regla que sostiene el resto. Sin ella, `/admin` sería exactamente lo
que este ADR existe para impedir. Si alguna vez se propone una excepción que
*no* mueva el sello, la pregunta correcta no es cuál es el caso de uso: es por
qué se quiere apagar el control.

---

## Modelo

```prisma
enum OperatorExceptionKind {
  UNBLOCK_PERIOD_LOCK
  UNBLOCK_CLOSING_GUARD
  UNSTICK_RESTORE_JOB
  UNSTICK_CRON_JOB

  @@map("operator_exception_kind")
}

enum OperatorTargetKind {
  PERIOD_LOCK
  FISCAL_YEAR
  RESTORE_JOB
  CRON_JOB

  @@map("operator_target_kind")
}

model OperatorException {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  kind       OperatorExceptionKind
  targetKind OperatorTargetKind    @map("target_kind")
  targetId   String?               @map("target_id") @db.Uuid

  reason      String    @db.VarChar(1000)
  requestedBy String    @map("requested_by") @db.VarChar(120)
  createdAt   DateTime  @default(now()) @map("created_at")
  expiresAt   DateTime  @map("expires_at")
  revokedAt   DateTime? @map("revoked_at")

  @@index([organizationId, expiresAt])
  @@map("operator_exceptions")
}
```

Append-only como el resto de registros de control: `REVOKE UPDATE, DELETE` +
política `RESTRICTIVE`; revocar una excepción es escribir `revokedAt` por una
función `SECURITY DEFINER` acotada, no un `UPDATE` libre. Tabla de negocio:
`SELECT app.enforce_tenant_rls('operator_exceptions')` y alta en `TENANT_MODELS`
—con lo que entra sola en el backup, en `reset-org` y en `purgeDerived`
(regla E-4 de la propuesta v1.1).

---

## Consecuencias

**Buenas**

- Las cuatro operaciones dejan de ser invisibles: motivo, actor, antes/después y
  recuentos, en los dos registros.
- El diario queda protegido del borrado por tres vías, no por prudencia.
- Una excepción no puede olvidarse abierta: caduca sola en 24 h.
- El sello sigue diciendo la verdad incluso mientras hay una excepción viva.

**Costes y molestias**

- Un operador con prisa tendrá que escribir un motivo de verdad y teclear el
  nombre de la organización. Es el punto.
- Una guardia que haya que levantar más de 24 h obliga a crear una excepción
  nueva. También es el punto: si hay que levantarla tres días, el problema no es
  la guardia.
- `reset-org` no servirá para lo que alguien querrá usarlo alguna vez (vaciar una
  organización con asientos). La respuesta seguirá siendo contra-asiento.

**Lo que este ADR deliberadamente NO decide**

- Un panel de observabilidad completo de plataforma (métricas, colas, trazas):
  fuera de alcance, sigue siendo `/api/health` y SQL de runbook.
- Impersonación de un usuario cliente por soporte: **no se propone**. Exigiría su
  propio ADR y su propio registro, y hoy no hay caso.

---

## Alternativas descartadas

1. **Dejarlo en SQL de runbook** (estado actual). Descartada: es exactamente el
   problema —sin motivo, sin actor, sin límite.
2. **Excepciones permanentes con revocación manual.** Descartada: lo permanente
   se olvida. Los cuatro fallos de inventario de E7–E11 nacieron todos de algo
   que se dejó abierto «de momento».
3. **Excepciones que no muevan el sello**, para no «ensuciar» el informe.
   Descartada de plano: un control que se puede silenciar sin dejar marca no es
   un control (§5 de la SPEC-FIABILIDAD, anti-patrón «entregar un informe cuya
   validación falló, sin sello de advertencia»).
4. **Permitir `reset-org` con `--force` sobre organizaciones con asientos.**
   Descartada: choca frontalmente con ADR-0003. Si hiciera falta de verdad, sería
   otro ADR y tendría que explicar por qué el art. 30 CCom no aplica.
5. **Un rol de base de datos con `BYPASSRLS` para `/admin`.** Descartada: ya
   existe `app_maintenance` para `scripts/` y el check de I10, y la aplicación
   nunca conecta con él (ADR-0009). `/admin` se sirve con el rol de aplicación y
   privilegios explícitos por tabla.
