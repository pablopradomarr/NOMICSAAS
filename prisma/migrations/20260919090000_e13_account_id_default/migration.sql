-- E13 · BUG-E13-1: better-auth 1.6 delega la generación de `id` en la base de
-- datos cuando `advanced.database.generateId: "uuid"` y el adaptador reporta
-- `supportsUUIDs: true` (Postgres). `account.id` (TEXT) era la única tabla de
-- better-auth sin default, a diferencia de `user`/`session`/`verification`, así
-- que la creación de la cuenta `credential` fallaba con
-- `Argument \`id\` is missing`. Tabla pre-tenant, sin RLS: ejecutable con el
-- rol de aplicación (app_maintenance / app_runtime), sin superusuario.
ALTER TABLE "account" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
