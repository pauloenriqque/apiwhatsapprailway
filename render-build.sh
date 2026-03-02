#!/usr/bin/env bash
# fail fast
set -o errexit
set -o pipefail

echo "[render-build] iniciando build..."

# -----------------------------------------------------------
# 1) Instala dependências (usa yarn se houver, senão npm)
# -----------------------------------------------------------
if command -v yarn >/dev/null 2>&1; then
  echo "[render-build] usando yarn..."
  yarn install --frozen-lockfile || yarn install
else
  echo "[render-build] usando npm..."
  if [ -f package-lock.json ]; then
    npm ci || npm install
  else
    npm install
  fi
fi

# -----------------------------------------------------------
# 2) Garante diretórios de cache
#    - PUPPETEER_CACHE_DIR: cache de runtime do Render
#    - /opt/render/project/src/.cache: cache persistido entre builds
# -----------------------------------------------------------
export PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p "$PUPPETEER_CACHE_DIR"
mkdir -p /opt/render/project/src/.cache/puppeteer

echo "[render-build] PUPPETEER_CACHE_DIR=$PUPPETEER_CACHE_DIR"

# -----------------------------------------------------------
# 3) Baixa o Chrome for Testing compatível com o Puppeteer
# -----------------------------------------------------------
echo "[render-build] baixando Chrome for Testing via Puppeteer..."
npx puppeteer browsers install chrome

# -----------------------------------------------------------
# 4) Sincroniza cache para o workspace do build (persistência do Render)
# -----------------------------------------------------------
if [ -d "$PUPPETEER_CACHE_DIR/chrome" ]; then
  echo "[render-build] sincronizando cache para /opt/render/project/src/.cache..."
  cp -R "$PUPPETEER_CACHE_DIR/chrome" /opt/render/project/src/.cache/puppeteer/ || true
else
  echo "[render-build] nada para copiar de $PUPPETEER_CACHE_DIR/chrome (ainda)"
fi

# -----------------------------------------------------------
# 5) Passo de build do app (opcional)
#    - descomente se tiver "build" no package.json
# -----------------------------------------------------------
# echo "[render-build] executando npm run build..."
# npm run build

echo "[render-build] finalizado com sucesso."
