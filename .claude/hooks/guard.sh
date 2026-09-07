#!/usr/bin/env bash
# PreToolUse guard (Edit|Write). Recibe el JSON del tool call por stdin.
# exit 2 = bloquea la acción y devuelve el motivo al agente por stderr.
set -euo pipefail
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$file" ] && exit 0
rel=${file#"$PWD/"}
content=$(printf '%s' "$input" | jq -r '.tool_input.content // .tool_input.new_string // empty')

# 1) Fixtures inmutables: se pueden crear, nunca modificar.
case "$rel" in
  tests/fixtures/*)
    if [ -f "$file" ]; then echo "⛔ Fixture inmutable: $rel. Crea un fichero nuevo versionado." >&2; exit 2; fi ;;
esac

# 2) ADRs: se pueden crear (PROPUESTO); un ADR APROBADO no se edita, se sustituye.
case "$rel" in
  docs/adr/*.md)
    if [ -f "$file" ] && grep -q "APROBADO" "$file"; then echo "⛔ ADR aprobado: $rel. Crea un ADR nuevo que lo sustituya." >&2; exit 2; fi ;;
esac

# 3) Motor contable puro: sin reloj implícito, IO, BD ni LLM (tests excluidos).
case "$rel" in
  lib/ledger/*.test.ts|lib/analytics/*.test.ts|lib/accounts/*.test.ts|lib/taxes/*.test.ts|lib/audit/*.test.ts|lib/bank/*.test.ts) ;;
  lib/ledger/*|lib/analytics/*|lib/accounts/*|lib/taxes/*|lib/audit/*|lib/bank/*)
    if printf '%s' "$content" | grep -nE 'Date\.now\(\)|new Date\(\)|@/lib/db|prisma\.|fetch\(|@langchain|Math\.random' >/dev/null; then
      echo "⛔ $rel debe ser puro: sin Date.now()/new Date()/prisma/fetch/LLM/Math.random. La fecha de referencia entra por parámetro." >&2; exit 2; fi ;;
esac

# 4) Dinero: prohibido Float en Prisma para importes.
case "$rel" in
  prisma/schema.prisma)
    if printf '%s' "$content" | grep -niE '(cents|amount|total|debit|credit|price|rate)[A-Za-z]*\s+Float' >/dev/null; then
      echo "⛔ Importes en Float prohibidos en schema.prisma (usa Int céntimos / BigInt)." >&2; exit 2; fi ;;
esac
exit 0
