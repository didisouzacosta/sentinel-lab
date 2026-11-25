#!/usr/bin/env bash
# Cria/atualiza os recursos do Sentinel Lab na conta Cloudflare logada no wrangler e faz o deploy.
# Idempotente. Ordem importa: o Access entra ANTES do Worker, porque o primeiro
# usuário que se cadastra no Sentinel vira admin.
#
# Requer: npx wrangler login, e para o Access:
#   CLOUDFLARE_API_TOKEN (Access: Apps and Policies Edit), CLOUDFLARE_ACCOUNT_ID,
#   SENTINEL_ADMIN_EMAILS (e-mails que entram no painel, separados por vírgula).
set -euo pipefail

LAB="$(cd "$(dirname "$0")" && pwd)"
cd "$LAB/../packages/workers-sentinel"

echo "Conta Cloudflare em uso:"
npx wrangler whoami
read -r -p "Criar/atualizar os recursos 'sentinel-lab*' nesta conta? [s/N] " ok
[[ "$ok" =~ ^[sS]$ ]] || { echo "Cancelado."; exit 1; }

# 1. Access primeiro (painel fechado antes de existir).
node "$LAB/access.mjs" apply

# 2. Bucket de anexos.
if npx wrangler r2 bucket info sentinel-lab-attachments >/dev/null 2>&1; then
	echo "R2 sentinel-lab-attachments já existe."
else
	npx wrangler r2 bucket create sentinel-lab-attachments
fi

# 2b. Bucket de debug files (dSYM, mapping) e fila de processamento.
#     Chunks do sentry-cli e uploads em espera expiram em 1 dia.
if npx wrangler r2 bucket info sentinel-lab-debug-files >/dev/null 2>&1; then
	echo "R2 sentinel-lab-debug-files já existe."
else
	npx wrangler r2 bucket create sentinel-lab-debug-files
fi
npx wrangler r2 bucket lifecycle add sentinel-lab-debug-files expire-chunks chunks/ --expire-days 1 --force 2>/dev/null || true
npx wrangler r2 bucket lifecycle add sentinel-lab-debug-files expire-staging staging/ --expire-days 1 --force 2>/dev/null || true
if npx wrangler queues info sentinel-lab-process >/dev/null 2>&1; then
	echo "Fila sentinel-lab-process já existe."
else
	npx wrangler queues create sentinel-lab-process
fi

# 3. Worker + domínio sentinel.adrianosouzacosta.com.br.
npx wrangler deploy

# 4. Conferência rápida.
H=https://sentinel.adrianosouzacosta.com.br
echo "painel (espera 302 do Access): $(curl -s -o /dev/null -w '%{http_code}' "$H/")"
echo "health (espera 200):           $(curl -s -o /dev/null -w '%{http_code}' "$H/api/health")"
echo
echo "Pronto. Abra $H, entre pelo Access e crie o primeiro usuário (vira admin)."
