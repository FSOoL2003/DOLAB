#!/bin/sh
# الجزء الذي يحتاج صلاحية root، ويُشغَّل مرة واحدة:
#   sudo sh /home/sufera/dolab/scripts/root-setup.sh
# ينشئ قاعدة بيانات ومستخدم خاصين بـ DOLAB، وموقع nginx جديد، وشهادة HTTPS.
# لا يعدّل أي قاعدة بيانات أو موقع موجود.
set -eu

DOLAB_DIR=/home/sufera/dolab
DOMAIN=dolab.185.238.70.49.sslip.io
PORT=3200

DB_PASSWORD=$(sed -n 's/^DB_PASSWORD=//p' "$DOLAB_DIR/.env")
[ -n "$DB_PASSWORD" ] || { echo "DB_PASSWORD missing from $DOLAB_DIR/.env"; exit 1; }

echo "== database"
cd /tmp
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'dolab'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE ROLE dolab LOGIN PASSWORD '$DB_PASSWORD'"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'dolab'" | grep -q 1; then
  sudo -u postgres createdb -O dolab dolab
fi

echo "== nginx"
cat > /etc/nginx/sites-available/dolab <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/dolab /etc/nginx/sites-enabled/dolab
nginx -t
systemctl reload nginx

echo "== https"
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos

echo "done: https://$DOMAIN"
