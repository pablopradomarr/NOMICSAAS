-- E12 · T20 (deuda 14) — **la copia programada**.
--
-- E11 dejó `backup-schedule` fuera del reloj con fecha de cierre en E12: el
-- backup manual y el de salida cubrían el mínimo de portabilidad que exige O-4,
-- pero «acuérdate de pedir una copia» no es una política de copias. Aquí la
-- organización declara su cadencia y el reloj la cumple.
--
-- Dos decisiones:
--
--  1. **Por defecto, `WEEKLY`.** Una instalación que no configura nada tiene
--     copias; la alternativa —`NONE` por defecto— es la que deja a un cliente sin
--     ninguna el día que hace falta. La retención (`backup_retention_days`, 30 por
--     defecto) impide que se acumulen, y una copia `SCHEDULED` **no consume
--     cuota** (O-4): la portabilidad no la puede desactivar un precio.
--  2. **Cadencia, no cron.** Un campo con una expresión cron sería texto libre
--     que alguien escribe mal una vez y nadie vuelve a mirar. Tres valores, un
--     enumerado, y la clave de idempotencia sale de la cadencia (lección O-21).
--
-- Ejecutable por rol NO superusuario.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'backup_schedule_cadence') THEN
    CREATE TYPE "backup_schedule_cadence" AS ENUM ('NONE', 'WEEKLY', 'MONTHLY');
  END IF;
END $$;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "backup_schedule" "backup_schedule_cadence" NOT NULL DEFAULT 'WEEKLY';

COMMENT ON COLUMN "organizations"."backup_schedule" IS
  'E12 · T20 — cadencia de la copia automática. El job `backup-schedule` la encola con trigger SCHEDULED, que NO consume cuota (O-4). NONE la desactiva.';
