-- E1-fix · hallazgos #14 y #16.
--
-- #16: `stripe_customer_id` no era único, así que `findFirst` devolvía una
-- organización ARBITRARIA cuando dos compartían cliente de Stripe (y el webhook
-- actualizaba el plan de la equivocada). En Postgres los NULL son distintos
-- entre sí en un índice único, de modo que este UNIQUE es de facto parcial
-- «WHERE stripe_customer_id IS NOT NULL»: varias organizaciones pueden seguir
-- sin cliente de Stripe. El índice no único queda cubierto por el único.
--
-- #14: contador de intentos fallidos por invitación, para bloquear el enlace
-- tras 5 intentos (rate limit persistente, complementario al de memoria).

DROP INDEX IF EXISTS "organizations_stripe_customer_id_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_stripe_customer_id_key"
  ON "organizations"("stripe_customer_id");

ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
