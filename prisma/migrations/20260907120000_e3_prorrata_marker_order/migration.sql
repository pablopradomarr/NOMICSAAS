-- E3 · revisión ronda 1, hallazgo #7 — el backfill de `prorrata_bps` no era
-- idempotente DE VERDAD.
--
-- QUÉ ESTABA MAL. En 20260907110000 la marca de conversión
-- (`prorrata_bps:convertido`, en el `COMMENT ON TABLE organizations`) se escribe
-- DESPUÉS del `UPDATE … * 10`, y el propio `UPDATE` lleva un `NOT EXISTS` que
-- consulta esa misma marca. En la primera ejecución la marca todavía no existe,
-- así que el guard no protege nada: en un entorno donde la migración anterior SÍ
-- había convertido (local, propietario superusuario, que esquiva RLS), los
-- valores ya en puntos básicos ≤ 1000 se habrían vuelto a multiplicar por diez.
-- Que nadie lo notara es sólo suerte: en la práctica todas las filas eran NULL.
--
-- CÓMO SE ARREGLA. El orden correcto es **marca primero, backfill después**, y
-- el backfill se ejecuta única y exclusivamente si la marca no estaba puesta al
-- entrar. Esta migración deja ese orden fijado y la marca escrita, de modo que
-- ninguna ejecución posterior —de ésta o de cualquier otra— puede volver a
-- convertir. No se edita 20260907110000: ya está aplicada (CLAUDE.md).
--
-- No convierte ningún valor: a estas alturas la marca ya está puesta por la
-- migración anterior en todos los entornos, así que el bloque es un no-op
-- verificable. Si alguien restaura una base ANTERIOR a 110000 y aplica la cadena
-- entera, el orden correcto es el que manda a partir de aquí.
DO $$
DECLARE
  v_oid oid := (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'organizations');
  v_marked boolean := COALESCE(obj_description(
    (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'organizations'), 'pg_class'
  ) LIKE '%prorrata_bps:convertido%', false);
  v_converted integer := 0;
BEGIN
  IF v_marked THEN
    RAISE NOTICE 'prorrata_bps ya marcada como convertida: no se toca ningún valor';
    RETURN;
  END IF;

  -- 1. LA MARCA VA PRIMERO. Va en la misma transacción que el backfill, así que
  --    o se aplican las dos cosas o ninguna.
  EXECUTE 'COMMENT ON TABLE "organizations" IS ' || quote_literal(
    'Organizaciones (tenant raíz). prorrata_bps:convertido — la prorrata está en PUNTOS BÁSICOS (90 % = 9000), O-7 de E3.'
  );

  -- 2. Y DESPUÉS el backfill, con el patrón NO FORCE → backfill → FORCE.
  ALTER TABLE "organizations" NO FORCE ROW LEVEL SECURITY;
  UPDATE "organizations" SET "prorrata_bps" = "prorrata_bps" * 10
   WHERE "prorrata_bps" IS NOT NULL AND "prorrata_bps" <= 1000;
  GET DIAGNOSTICS v_converted = ROW_COUNT;
  ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

  RAISE NOTICE 'prorrata_bps: % fila(s) convertidas a puntos básicos', v_converted;
END $$;

-- La marca queda puesta pase lo que pase (si el bloque salió por el RETURN, ya
-- estaba). Es lo que hace que el backfill no pueda repetirse nunca más.
DO $$
BEGIN
  IF NOT COALESCE(obj_description(
       (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'organizations'), 'pg_class'
     ) LIKE '%prorrata_bps:convertido%', false) THEN
    RAISE EXCEPTION 'la marca prorrata_bps:convertido no ha quedado escrita';
  END IF;
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'organizations') THEN
    RAISE EXCEPTION 'organizations ha quedado en NO FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
