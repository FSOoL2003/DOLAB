#!/bin/sh
# تجهيز سيرفر Ubuntu/Debian جديد: Docker + جدار حماية. يُشغَّل مرة واحدة كـ root.
set -eu

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

mkdir -p /opt/dolab
echo "server ready"
