#!/bin/sh
# ربط الدومين الرسمي بالموقع، ويُشغَّل مرة واحدة بصلاحية root بعد ما يوصل الدومين للسيرفر:
#   sudo sh /home/sufera/dolab/scripts/domain-setup.sh
# النتيجة: https://dolab.cloud هو الموقع، و www والرابط القديم (sslip.io) يتحولون له تلقائياً.
set -eu

DOMAIN=dolab.cloud
OLD=dolab.185.238.70.49.sslip.io
SERVER_IP=185.238.70.49
PORT=3200
CONF=/etc/nginx/sites-available/dolab

echo "== DNS"
for name in "$DOMAIN" "www.$DOMAIN"; do
  ip=$(getent ahostsv4 "$name" | awk 'NR==1{print $1}')
  if [ "$ip" != "$SERVER_IP" ]; then
    echo "$name يشير إلى '${ip:-لا شيء}' بدل $SERVER_IP — تأكد من سجلات DNS وانتظر قليلاً ثم أعد المحاولة."
    exit 1
  fi
  echo "$name -> $ip ✓"
done

echo "== certificate"
certbot certonly --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --keep-until-expiring

echo "== nginx"
cp "$CONF" "$CONF.bak-$(date +%Y%m%d%H%M%S)"
cat > "$CONF" <<EOF
# HTTP: كل شيء يتحول إلى https://$DOMAIN
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN $OLD;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}

# www والرابط القديم يتحولون إلى الدومين الأساسي
server {
    listen 443 ssl;
    server_name www.$DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://$DOMAIN\$request_uri;
}
server {
    listen 443 ssl;
    server_name $OLD;
    ssl_certificate /etc/letsencrypt/live/$OLD/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$OLD/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://$DOMAIN\$request_uri;
}

# الموقع
server {
    listen 443 ssl;
    server_name $DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

if nginx -t; then
  systemctl reload nginx
else
  echo "إعداد nginx فيه خطأ — رجعنا للنسخة السابقة."
  cp "$(ls -t "$CONF".bak-* | head -1)" "$CONF"
  nginx -t && systemctl reload nginx
  exit 1
fi

echo "done: https://$DOMAIN"
