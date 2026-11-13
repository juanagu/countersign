#!/bin/sh
# Prompts for the Anthropic API key without echoing it and writes it to .env (never committed).
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env

printf 'Paste your Anthropic API key (input hidden): '
if [ -t 0 ]; then
  stty -echo
  trap 'stty echo' EXIT INT TERM
fi
read -r key || true
[ -t 0 ] && stty echo
printf '\n'

case "$key" in
  sk-ant-*) ;;
  '') echo "No key entered; .env unchanged." >&2; exit 1 ;;
  *) echo "That doesn't look like an Anthropic key (expected sk-ant-...); .env unchanged." >&2; exit 1 ;;
esac

# The key goes through the environment, not the awk program text, so no character in it needs escaping.
tmp="$(mktemp .env.XXXXXX)"
KEY="$key" awk '
  /^ANTHROPIC_API_KEY=/ { print "ANTHROPIC_API_KEY=" ENVIRON["KEY"]; found = 1; next }
  { print }
  END { if (!found) print "ANTHROPIC_API_KEY=" ENVIRON["KEY"] }
' .env > "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
echo "Saved to .env. Run 'make up' to restart the stack with it."
