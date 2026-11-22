# Deploying Strapi to the VPS (cms.hvtdpstainz.at)

Strapi runs as a Node process on `127.0.0.1:1337`, behind nginx on `cms.hvtdpstainz.at`,
with its data in the existing MariaDB server.

## 1. DNS

Create an `A` (and `AAAA`, if used) record `cms.hvtdpstainz.at` pointing to the VPS.

## 2. Database

```sql
-- mariadb -u root -p
CREATE DATABASE strapi_hvtdp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'strapi_hvtdp'@'localhost' IDENTIFIED BY '<strong password>';
GRANT ALL PRIVILEGES ON strapi_hvtdp.* TO 'strapi_hvtdp'@'localhost';
FLUSH PRIVILEGES;
```

Strapi 5 requires MariaDB >= 10.3 (`mariadb --version`).

## 3. App

Node 22–26 is required (e.g. via nvm for the site user). Install pm2 under that same Node version.

```bash
git clone https://github.com/sjaindl/strapi-cloud-template-blog-49970f95ac.git ~/strapi
cd ~/strapi
cp .env.example .env   # then edit, see below
npm ci
NODE_ENV=production npm run build
```

`.env`. Generate every secret with `openssl rand -base64 32`, and give `APP_KEYS` four comma-separated values:

```
NODE_ENV=production
HOST=127.0.0.1
PORT=1337
PUBLIC_URL=https://cms.hvtdpstainz.at
IS_PROXIED=true
APP_KEYS=<k1>,<k2>,<k3>,<k4>
API_TOKEN_SALT=<secret>
ADMIN_JWT_SECRET=<secret>
TRANSFER_TOKEN_SALT=<secret>
JWT_SECRET=<secret>
ENCRYPTION_KEY=<secret>
DATABASE_CLIENT=mysql
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_NAME=strapi_hvtdp
DATABASE_USERNAME=strapi_hvtdp
DATABASE_PASSWORD=<db password>
```

Run it with pm2:

```bash
npm install -g pm2
pm2 start npm --name strapi-hvtdp -- run start
pm2 save
pm2 startup   # run the command it prints
```

## 4. nginx

Proxy straight to Node, **not through Varnish**, so admin/API responses are never cached.
If the server is managed by a hosting panel (e.g. CloudPanel), create the site there as a
Node.js / reverse-proxy site on port 1337 and issue the Let's Encrypt certificate there instead
of hand-editing the vhost.

```nginx
server {
  listen 80;
  listen [::]:80;
  server_name cms.hvtdpstainz.at;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name cms.hvtdpstainz.at;

  ssl_certificate     /etc/letsencrypt/live/cms.hvtdpstainz.at/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/cms.hvtdpstainz.at/privkey.pem;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:1337;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

Then open `https://cms.hvtdpstainz.at/admin` and create the first admin user.

## 5. Migrate the news

```bash
cd ~/strapi
curl -s https://www.hvtdpstainz.at/api/getNews.php -o /tmp/news.json
pm2 stop strapi-hvtdp
NODE_ENV=production node scripts/migrate-news.js \
  --source /tmp/news.json \
  --images <webroot>/assets/images \
  --images-url https://www.hvtdpstainz.at/assets/images
pm2 start strapi-hvtdp
```

The script can be re-run safely: news items whose `newsId` already exists are skipped. It also grants the
Public role read access to `news-item`.

Check: `curl 'https://cms.hvtdpstainz.at/api/news-items?pagination[pageSize]=1'` should report
`"total":233` (or the current count).

## 5b. Migrate the club data (page by page)

The remaining website data moves from the PHP endpoints to Strapi one area at a time. Every area has a
script in `scripts/migrate-<area>.js` (shared helpers: `scripts/lib/migrate-utils.js`). Each script:

- reads a JSON export of the legacy PHP endpoint(s),
- uploads referenced images to the media library (once; files are named after their legacy path, e.g.
  `gallery_boccia_2026_01.jpg` for `gallery/boccia_2026/01.jpg`, and reused on re-runs),
- creates or updates the entries (safe to re-run) and grants the Public role read access.

Deploy the new content types first (pull, `npm run build`, `pm2 restart strapi-hvtdp`), then run the
migration script from the website repo (`hvtdp/scripts/migrate-to-strapi.sh`, copy it to the VPS if the
website repo is not checked out there). It downloads the PHP JSON, checks it, stops `strapi-hvtdp` (pm2),
runs the selected areas in production mode and always starts the server again — also when a step fails:

```bash
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images announcement
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images club   # ~160 images
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images   # all areas
./migrate-to-strapi.sh --list                                                   # available areas
```

Check the area's endpoint (e.g. `curl https://cms.hvtdpstainz.at/api/announcement`) before deploying the
website build that uses it — or run the area's folder of the Postman collection in the website repo
(`hvtdp/postman/`) with the `HV TDP CMS – production` environment (every request has tests for status and response shape). Further
areas are added here and to the collection as they are migrated.

Disk space: the images are about 1.5 GB; Strapi additionally stores thumbnail/small/medium/large
versions (configured in `config/plugins.js`), so plan for roughly 3 GB in `public/uploads`.

## 6. Backups

Add these to the existing backup routine:

```bash
mysqldump strapi_hvtdp | gzip > strapi_hvtdp_$(date +%F).sql.gz
tar czf strapi_uploads_$(date +%F).tgz -C ~/strapi/public uploads
```
