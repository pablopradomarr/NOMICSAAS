-- E12 · T15 (deuda 4 de §6) — **`static/` al almacén, con `kind = BRANDING`**.
--
-- El logotipo de la organización y el avatar del usuario eran los dos últimos
-- ficheros que vivían SÓLO en disco (`uploads/<org>/static/…`), servidos por
-- `/files/static/[filename]`. En Vercel eso es `/tmp`: efímero entre
-- despliegues. El mismo hecho 4 de ADR-0019 que obligó a mover los documentos.
--
-- Dos decisiones:
--
--  1. **Familia propia, `BRANDING`**, y no `LOGO`/`AVATAR`. Las dos familias
--     viejas figuraban en `BILLABLE_STORAGE_KINDS`, es decir, **contaban para la
--     cuota del cliente**: cobrarle 40 KB por su propio logotipo es ruido en una
--     cifra que tiene que ser creíble. O-12c dice que la cuota se filtra por
--     `kind`; con una familia propia, excluirla es una línea y no una excepción
--     repartida. `LOGO` y `AVATAR` se quedan en el enumerado —un valor de
--     `enum` no se puede retirar sin reescribir el tipo entero— pero **nadie los
--     vuelve a escribir**; la migración siguiente pasa a `BRANDING` lo que haya.
--  2. **`purpose` explícito.** Los bytes se nombran por su `sha256` (igual que
--     todo lo demás en el almacén), así que la clave ya no dice si es un
--     logotipo o un avatar. `purpose` lo dice, con un enumerado y no con texto
--     libre, y su índice `(organization_id, purpose)` es el camino de la
--     pantalla que lo pinta.
--
-- `ALTER TYPE … ADD VALUE` no puede USARSE en la misma transacción que lo añade
-- (PostgreSQL 12+ lo admite dentro de un bloque, pero el valor no es visible
-- hasta el commit). Por eso esto va en su propia migración y el traspaso de
-- filas en la siguiente. Ejecutable por rol NO superusuario.

ALTER TYPE "stored_object_kind" ADD VALUE IF NOT EXISTS 'BRANDING';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stored_object_purpose') THEN
    CREATE TYPE "stored_object_purpose" AS ENUM ('ORG_LOGO', 'USER_AVATAR');
  END IF;
END $$;

ALTER TABLE "stored_objects" ADD COLUMN IF NOT EXISTS "purpose" "stored_object_purpose";

COMMENT ON COLUMN "stored_objects"."purpose" IS
  'E12 · T15 — para qué sirve un objeto de kind = BRANDING (logotipo de la organización, avatar). NULL en el resto de familias.';

CREATE INDEX IF NOT EXISTS "stored_objects_organization_id_purpose_idx"
  ON "stored_objects" ("organization_id", "purpose");
