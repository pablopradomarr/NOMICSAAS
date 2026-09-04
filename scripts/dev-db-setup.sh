#!/usr/bin/env bash
# Prepara el rol de runtime `app_runtime` en una base LOCAL o de CI.
#
# Las migraciones ya no fijan contraseñas (ronda 2, hallazgo #8): crean el rol
# sin LOGIN y es el operador quien le da credencial. Este script hace ese paso
# para desarrollo y CI, tomando la contraseña de APP_RUNTIME_PASSWORD.
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

echo "· Configurando app_runtime en ${DATABASE_URL%%\?*}"
psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END \$\$;
ALTER ROLE app_runtime WITH LOGIN NOBYPASSRLS PASSWORD '${APP_RUNTIME_PASSWORD}';
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
SQL
echo "· Listo. DATABASE_URL de la app: postgresql://app_runtime:***@…"
