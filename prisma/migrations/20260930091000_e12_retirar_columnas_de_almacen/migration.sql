-- E12 · T15 (deudas 3 y 4 de §6) — **fuera la segunda fuente del almacenamiento**.
--
-- ## Deuda 3 · `organizations.storage_used` / `storage_limit`
--
-- Son un **contador vivo** del mismo dato que `models/usage.ts` deriva de
-- `stored_objects`, y por tanto una violación de **P2** («fuente única de
-- verdad») escrita en el esquema: dos cifras del mismo hecho que sólo coinciden
-- mientras alguien se acuerde de llamar a `syncOrganizationStorage()`. La
-- auditoría de E11 las dejó anotadas como deprecadas y §6 de E12 manda
-- eliminarlas. La cifra buena —la única— es `storageBytes` de `computeUsage`,
-- agregada en SQL sobre `stored_objects` filtrando por `kind` (O-12c), y el
-- techo lo pone `maxStorageBytes` del plan, no una columna de la organización.
--
-- **La guardia**, porque un `DROP COLUMN` a ciegas es como se rompe un
-- despliegue: se aborta si algo del ESQUEMA todavía depende de las columnas
-- (vista, índice, restricción, columna generada, política, disparador). Lo que
-- el SQL no puede ver —una lectura viva en el código— lo comprueba el test
-- estático sobre el AST (`tests/integration/e12-olab.test.ts`), que es la otra
-- mitad de la guardia y la que de verdad muerde.
--
-- ## Deuda 4 · lo que quedaba en `LOGO`/`AVATAR`
--
-- Pasa a `BRANDING` con su `purpose`. Con `FORCE ROW LEVEL SECURITY` ni el
-- propietario esquiva las políticas, así que el backfill va con el baile
-- obligatorio `NO FORCE → UPDATE → FORCE` de CLAUDE.md, dentro de la MISMA
-- migración (el DDL es transaccional).
--
-- Ejecutable por rol NO superusuario.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Traspaso de las dos familias viejas a BRANDING
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "stored_objects" NO FORCE ROW LEVEL SECURITY;

UPDATE "stored_objects"
   SET "purpose" = CASE WHEN "kind" = 'LOGO' THEN 'ORG_LOGO'::"stored_object_purpose"
                        ELSE 'USER_AVATAR'::"stored_object_purpose" END,
       "kind"    = 'BRANDING'::"stored_object_kind"
 WHERE "kind" IN ('LOGO', 'AVATAR');

ALTER TABLE "stored_objects" FORCE ROW LEVEL SECURITY;

-- Un objeto de `BRANDING` sin `purpose` no se sabe para qué es, y uno de otra
-- familia con `purpose` miente. La regla se escribe en la base, no en la app.
ALTER TABLE "stored_objects" DROP CONSTRAINT IF EXISTS "stored_objects_purpose_solo_branding";
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_purpose_solo_branding"
  CHECK (("kind" = 'BRANDING' AND "purpose" IS NOT NULL) OR ("kind" <> 'BRANDING' AND "purpose" IS NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · La guardia: nada del esquema puede seguir dependiendo de las dos columnas
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_dependencias text;
BEGIN
  SELECT string_agg(DISTINCT format('%s (%s)', dependiente, tipo), ', ')
    INTO v_dependencias
    FROM (
      -- Vistas, columnas generadas, índices y restricciones que nombren la columna.
      SELECT dependiente.relname::text AS dependiente, dependiente.relkind::text AS tipo
        FROM pg_depend d
        JOIN pg_rewrite r        ON r.oid = d.objid
        JOIN pg_class dependiente ON dependiente.oid = r.ev_class
        JOIN pg_attribute a      ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       WHERE d.refobjid = 'public.organizations'::regclass
         AND a.attname IN ('storage_used', 'storage_limit')
         AND dependiente.relname <> 'organizations'
      UNION ALL
      SELECT c.conname::text, 'restricción'
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.organizations'::regclass
         AND a.attname IN ('storage_used', 'storage_limit')
      UNION ALL
      SELECT i.relname::text, 'índice'
        FROM pg_index x
        JOIN pg_class i     ON i.oid = x.indexrelid
        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
       WHERE x.indrelid = 'public.organizations'::regclass
         AND a.attname IN ('storage_used', 'storage_limit')
    ) AS dependencias;

  IF v_dependencias IS NOT NULL THEN
    RAISE EXCEPTION
      'E12 · T15: no se pueden retirar organizations.storage_used/storage_limit, todavía dependen de ellas: %',
      v_dependencias;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Fuera
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "storage_used";
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "storage_limit";

COMMENT ON TABLE "organizations" IS
  'E12 · T15: el almacenamiento usado y su techo ya NO viven aquí. El usado se DERIVA de stored_objects (models/usage.ts, filtrando por kind, O-12c) y el techo lo pone maxStorageBytes del plan. Una segunda copia viva del mismo dato es lo que P2 prohíbe.';
