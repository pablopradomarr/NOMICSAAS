import path from "node:path"
import { defineConfig } from "prisma/config"

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    // Las migraciones necesitan el rol PROPIETARIO (crea tablas, políticas RLS y
    // funciones); el runtime conecta con `app_runtime`, sin BYPASSRLS. ADR-0007.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || "postgresql://localhost:5432/taxhacker",
  },
})
