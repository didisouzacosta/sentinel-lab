#!/usr/bin/env bash
# Apaga TODOS os recursos Cloudflare do Sentinel Lab (lista em lab/cloudflare-resources.md).
# Irreversível: os eventos, issues, usuários e anexos guardados no lab somem.
# Para apagar o projeto local depois, basta remover a pasta do projeto.
set -uo pipefail

LAB="$(cd "$(dirname "$0")" && pwd)"
cd "$LAB/../packages/workers-sentinel"

echo "Conta Cloudflare em uso:"
npx wrangler whoami
echo
echo "Serão apagados (se existirem): Worker sentinel-lab (+ domínio sentinel.adrianosouzacosta.com.br,"
echo "Durable Objects e dados), R2 sentinel-lab-attachments, R2 sentinel-lab-debug-files,"
echo "fila sentinel-lab-process, app e política 'Sentinel Lab ·' do Access."
read -r -p "Digite 'apagar sentinel-lab' para confirmar: " ok
[[ "$ok" == "apagar sentinel-lab" ]] || { echo "Cancelado."; exit 1; }

# 1. Worker: leva junto o Custom Domain, os Durable Objects (issues, eventos,
#    usuários) e o container, se houver.
npx wrangler delete --name sentinel-lab --force || echo "Worker sentinel-lab não encontrado (ok)."

# 1a. Container do simbolizador: sai com o Worker; isto só garante.
symbolicator=$(npx wrangler containers list 2>/dev/null | awk '/sentinel-lab-symbolicator/ {print $2}')
if [[ -n "$symbolicator" ]]; then
	npx wrangler containers delete "$symbolicator" || echo "Apague o container sentinel-lab-symbolicator no painel."
fi

# 1b. Access (depois do Worker, para o painel nunca ficar aberto sem proteção).
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
	node "$LAB/access.mjs" delete
else
	echo "Access: defina CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID e rode 'node lab/access.mjs delete',"
	echo "ou apague 'Sentinel Lab · painel' e 'Sentinel Lab · administradores' no painel do Zero Trust."
fi

# 2. Fila de processamento.
npx wrangler queues delete sentinel-lab-process 2>/dev/null || true

# 3. Buckets R2: só apagam vazios. Se tiver objetos, aplica regra que expira tudo em 1 dia.
pending=()
for bucket in sentinel-lab-attachments sentinel-lab-debug-files; do
	npx wrangler r2 bucket info "$bucket" >/dev/null 2>&1 || continue
	if npx wrangler r2 bucket delete "$bucket"; then
		echo "R2 $bucket apagado."
	else
		npx wrangler r2 bucket lifecycle add "$bucket" expire-all "" --expire-days 1 --force 2>/dev/null || true
		pending+=("$bucket")
	fi
done

if ((${#pending[@]})); then
	echo
	echo "Buckets com objetos: ${pending[*]}"
	echo "Configurei expiração de 1 dia. Rode este script de novo amanhã para concluir,"
	echo "ou esvazie e apague pelo painel da Cloudflare (R2 → bucket → Delete)."
	exit 2
fi
echo "Sentinel Lab removido da Cloudflare."
