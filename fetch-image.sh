#!/usr/bin/env bash
# =====================================================================
# fetch-image.sh — докачивает Docker-образ jetkvm-cloud:latest
# из GitHub Releases в текущую папку (рядом с docker-compose.portainer.yaml).
#
# Использование:
#   chmod +x fetch-image.sh
#   sudo -E ./fetch-image.sh
#
# Для private repo установите GITHUB_TOKEN перед запуском:
#   export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
#
# Полная инструкция: см. ReadGH.me в корне репозитория.
# =====================================================================
set -euo pipefail

# ── Параметры (отредактируйте под свой репозиторий) ──────────────────
REPO="<github-user>/<repo-name>"             # например: ivanov/jetkvm-selfhosted
TAG="v0.1.001"                               # тег релиза на GitHub
FILE="jetkvm-cloud-2026.04.20.tar.gz"        # имя файла-артефакта
EXPECTED_SHA=""                              # SHA256, опционально

# ── Не редактируйте ниже ─────────────────────────────────────────────
URL="https://github.com/${REPO}/releases/download/${TAG}/${FILE}"
DEST_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${DEST_DIR}/${FILE}"

verify_sha() {
    if [ -n "$EXPECTED_SHA" ]; then
        echo "[fetch-image] Проверка SHA256..."
        echo "${EXPECTED_SHA}  ${DEST}" | sha256sum -c
    fi
}

if [ -f "$DEST" ]; then
    echo "[fetch-image] ${FILE} уже на месте."
    if [ -n "$EXPECTED_SHA" ]; then
        if echo "${EXPECTED_SHA}  ${DEST}" | sha256sum -c --status; then
            echo "[fetch-image] SHA256 совпадает — пропускаю скачивание."
            exit 0
        fi
        echo "[fetch-image] SHA256 не совпал — перекачиваю."
        rm -f "$DEST"
    else
        exit 0
    fi
fi

echo "[fetch-image] Скачиваю ${URL}"
echo "[fetch-image]      → ${DEST}"

if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fL --retry 3 \
        -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        -H "Accept: application/octet-stream" \
        -o "$DEST" "$URL"
else
    curl -fL --retry 3 -o "$DEST" "$URL"
fi

verify_sha
echo "[fetch-image] Готово: ${DEST}"
