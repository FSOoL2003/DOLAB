#!/bin/sh
# نسخة احتياطية لقاعدة البيانات والصور، ويحتفظ بآخر 14 نسخة.
# تشغيل يومي الساعة 3 فجراً:  (crontab -l; echo "0 3 * * * /opt/dolab/scripts/backup.sh") | crontab -
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M)

docker compose exec -T db pg_dump -U dolab dolab | gzip > "backups/db-$stamp.sql.gz"
docker compose exec -T app tar -C /data -czf - uploads > "backups/uploads-$stamp.tar.gz"

ls -1t backups/db-*.sql.gz | tail -n +15 | xargs -r rm --
ls -1t backups/uploads-*.tar.gz | tail -n +15 | xargs -r rm --
echo "backup done: $stamp"
