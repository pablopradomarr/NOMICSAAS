#!/bin/sh
set -e

# E9 · T21 — la retención de runs (ADR-0015 D3) corre desde el cron y necesita
# DOS variables que hasta ahora no se exportaban al entorno del cron:
#
#   · DATABASE_URL_MAINTENANCE — el rol `app_maintenance` (BYPASSRLS). La purga
#     recorre TODAS las organizaciones; con `app_runtime` (NOBYPASSRLS) vería
#     cero filas en silencio y el cron reportaría «nada que purgar» cada noche.
#     La aplicación NUNCA conecta con esta credencial: sólo `scripts/`.
#   · RUN_ARCHIVE_DIR — el directorio del archivo en frío. Si no está, el
#     crontab usa /var/lib/erp/archive; se crea aquí para que el primer paso del
#     script no falle por un directorio inexistente montado como sólo lectura.
#
# Si DATABASE_URL_MAINTENANCE no está definida, el cron sigue arrancando y la
# tarea de purga aborta con su mensaje explícito: es preferible un fallo diario
# visible en el log a una purga silenciosa que no purga (o que purga de más).
printenv | grep -E '^(DATABASE_URL|DATABASE_URL_MAINTENANCE|RUN_ARCHIVE_DIR|BETTER_AUTH_SECRET|UPLOAD_PATH|NODE_ENV|SELF_HOSTED_MODE|BASE_URL|GIT_SHA|PATH)=' > /etc/cron.env
chmod 0644 /etc/cron.env

# El archivo en frío lleva importes, cuentas y nombres de contrapartes: 0700 el
# directorio y 0600 cada fichero (lo pone el script). Es evidencia del art. 30
# CCom, no un volcado de depuración.
ARCHIVE_DIR="${RUN_ARCHIVE_DIR:-/var/lib/erp/archive}"
mkdir -p "$ARCHIVE_DIR" 2>/dev/null || echo "aviso: no se pudo crear $ARCHIVE_DIR; la purga nocturna avisará" >&2
chmod 0700 "$ARCHIVE_DIR" 2>/dev/null || true

cp /mnt/crontab /tmp/crontab
chmod 0644 /tmp/crontab
crontab /tmp/crontab

touch /var/log/cron.log
cron
exec tail -F /var/log/cron.log
