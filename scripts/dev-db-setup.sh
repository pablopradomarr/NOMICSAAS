#!/usr/bin/env bash
# Prepara el rol de runtime `app_runtime` en una base LOCAL o de CI.
#
# Las migraciones ya no fijan contraseñas (ronda 2, hallazgo #8): crean el rol
# sin LOGIN y es el operador quien le da credencial. Este script hace ese paso
# para desarrollo y CI, tomando la contraseña de APP_RUNTIME_PASSWORD.
#
# Desde E3 prepara también `app_maintenance` (BYPASSRLS, ADR-0009 §6), que usan
# los scripts de operador y el check del invariante I10 — nunca la aplicación web.
#
#   ./scripts/dev-db-setup.sh                                  # BD por defecto
#   DATABASE_URL=postgresql://postgres@localhost:5432/erp_test ./scripts/dev-db-setup.sh
#   APP_RUNTIME_PASSWORD='…' ./scripts/dev-db-setup.sh
#
# NO usar en producción: allí la contraseña la fija el operador por su canal
# seguro (o se usa autenticación IAM del proveedor).
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-${DIRECT_URL:-postgresql://postgres@localhost:5432/erp}}"
APP_RUNTIME_PASSWORD="${APP_RUNTIME_PASSWORD:-app_runtime}"
APP_MAINTENANCE_PASSWORD="${APP_MAINTENANCE_PASSWORD:-app_maintenance}"

echo "· Configurando app_runtime en ${DATABASE_URL%%\?*}"
psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END \$\$;
ALTER ROLE app_runtime WITH LOGIN NOBYPASSRLS PASSWORD '${APP_RUNTIME_PASSWORD}';
GRANT USAGE ON SCHEMA public, app TO app_runtime;
-- Los privilegios de TABLA los conceden LAS MIGRACIONES (E1 sobre todas las
-- tablas + ALTER DEFAULT PRIVILEGES para las que nazcan después), y algunas los
-- recortan a propósito: audit_logs es append-only (20260905120000) y
-- journal_entries/journal_lines sólo admiten SELECT+INSERT (E3). Un
-- "GRANT ... ON ALL TABLES" aquí volvería a abrirlos y el entorno de desarrollo
-- divergiría del real, que es justo lo que la suite de RLS debe detectar.

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;
  END IF;
END \$\$;
ALTER ROLE app_maintenance WITH LOGIN BYPASSRLS PASSWORD '${APP_MAINTENANCE_PASSWORD}';
GRANT USAGE ON SCHEMA public, app TO app_maintenance;
-- Ídem: los privilegios de tabla de app_maintenance los conceden las migraciones
-- 20260906090000 / 20260906100000.
SQL
echo "· Listo. DATABASE_URL de la app: postgresql://app_runtime:***@…"
echo "·        DATABASE_URL_MAINTENANCE (scripts de operador e I10): postgresql://app_maintenance:***@…"
