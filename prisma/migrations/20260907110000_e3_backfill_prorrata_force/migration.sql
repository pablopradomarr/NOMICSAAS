-- E3 · corrección de 20260907100000_e3_ledger — backfill de `prorrata_bps`
-- bajo `FORCE ROW LEVEL SECURITY` (ADR-0009 §7, CLAUDE.md §RLS estricta).
--
-- EL PROBLEMA. La migración anterior renombra `prorrata_permille` a
-- `prorrata_bps` y multiplica por 10 los valores existentes:
--
--     UPDATE "organizations" SET "prorrata_bps" = "prorrata_bps" * 10 …
--
-- En local funcionó porque el propietario de la BD es superusuario y los
-- superusuarios esquivan siempre las políticas. En Supabase el propietario NO
-- es superusuario y `organizations` está en `FORCE ROW LEVEL SECURITY` desde
-- 20260906100000, así que ese UPDATE **no ve ninguna fila y no da error**: deja
-- los valores en tanto por mil, y `applyBps(cuota, prorrataBps)` calcularía el
-- IVA deducible con la escala equivocada (un 90 % se leería como 9 %).
--
-- No se edita una migración ya aplicada: se repite el backfill aquí con el
-- patrón obligatorio `NO FORCE → backfill → FORCE`, que es transaccional.
--
-- IDEMPOTENCIA. Tras el renombrado no hay forma de distinguir por el valor un
-- 900 que ya son puntos básicos (9 %) de un 900 que sigue en tanto por mil
-- (90 %), así que la conversión NO puede depender de un umbral: se marca con un
-- `COMMENT ON COLUMN` y sólo se ejecuta si la marca no está. En un entorno donde
-- la migración anterior sí convirtió (local, superusuario) este bloque marca la
-- columna sin tocar ningún valor, porque la marca se pone en la misma
-- transacción que el backfill y ambos entornos convergen al mismo estado.
DO $$
DECLARE
  v_marker text := obj_description(
    (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'organizations'),
    'pg_class'
  );
  v_pending integer;
BEGIN
  IF v_marker IS NOT NULL AND v_marker LIKE '%prorrata_bps:convertido%' THEN
    RAISE NOTICE 'prorrata_bps ya convertida: no se repite el backfill';
    RETURN;
  END IF;

  -- El propietario deja de esquivar las políticas con FORCE: se retira durante
  -- el backfill y se vuelve a poner en la MISMA transacción.
  ALTER TABLE "organizations" NO FORCE ROW LEVEL SECURITY;

  SELECT count(*) INTO v_pending FROM "organizations" WHERE "prorrata_bps" IS NOT NULL;

  -- Sólo convierte lo que la migración anterior pudo no haber visto. En la
  -- práctica E2 nunca escribió la columna (todas las filas son NULL), así que
  -- esto es una salvaguarda, no una transformación masiva.
  UPDATE "organizations"
     SET "prorrata_bps" = "prorrata_bps" * 10
   WHERE "prorrata_bps" IS NOT NULL
     AND "prorrata_bps" <= 1000
     AND NOT EXISTS (
       -- Si el UPDATE de 20260907100000 sí se aplicó, sus valores ya están en
       -- bps y no se vuelven a multiplicar: la marca de abajo lo impide en
       -- ejecuciones futuras, y este NOT EXISTS protege la primera.
       SELECT 1 FROM pg_class c
        WHERE c.relname = 'organizations'
          AND obj_description(c.oid, 'pg_class') LIKE '%prorrata_bps:convertido%'
     );

  RAISE NOTICE 'backfill de prorrata_bps revisado sobre % fila(s) no nulas', v_pending;

  ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
END $$;

-- Marca de conversión: hace el backfill idempotente para siempre.
COMMENT ON TABLE "organizations" IS
  'Organizaciones (tenant raíz). prorrata_bps:convertido — la prorrata está en PUNTOS BÁSICOS (90 % = 9000), O-7 de E3.';

-- El rango de la escala nueva, por si la migración anterior corrió sin backfill.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_prorrata_bps_check";
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_prorrata_bps_check"
  CHECK ("prorrata_bps" IS NULL OR "prorrata_bps" BETWEEN 0 AND 10000);

-- La tabla NO puede quedar en NO FORCE (lo comprueba tests/integration-rls).
DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'organizations') THEN
    RAISE EXCEPTION 'organizations ha quedado en NO FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
