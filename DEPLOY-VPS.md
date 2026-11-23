# Deploying Strapi to the VPS (cms.hvtdpstainz.at)

Strapi runs as a Node process on `127.0.0.1:1337`, behind nginx on `cms.hvtdpstainz.at`,
with its data in the existing MariaDB server.

> **Before deploying the new website**, work through the checklist in [5b](#5b-migrate-the-club-data-page-by-page) —
> above all the **SMTP mail account** in `~/strapi/.env`. Without it, Hallenturnier registrations are stored, but
> neither the club nor the registrant gets a mail.

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

### Checklist before switching the website to Strapi

- [ ] **Mail account (SMTP) in `~/strapi/.env`** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`,
      `REGISTRATION_MAIL_TO` (and optionally `REGISTRATION_MAIL_CC`), then `pm2 restart strapi-hvtdp`. Details under
      "Hallenturnier registration mails" below. **Without it no registration mails are sent** (only logged).
      Test once: register a test team on the website, check both mails arrive, delete the test entry in the admin.
- [ ] `DOCUMENTS_PASSWORD` in `~/strapi/.env` (protected documents, see "Documents" below).
- [ ] `IS_PROXIED=true` in `~/strapi/.env` (rate limits of votes, downloads and registrations see the visitor's IP).
- [ ] New Strapi version deployed (`git pull`, `npm ci`, `npm run build`, `pm2 restart strapi-hvtdp`).
- [ ] Areas migrated in this order: `announcement club fanshop documents championship videos gallery pages news-categories`.
- [ ] `videos` run once more **right before** deploying the website (current vote counts), never again afterwards.
- [ ] Postman collection (production environment) passes, then deploy the website.

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
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images fanshop
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images --documents <webroot>/assets/documents documents
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images championship   # after club (players)
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images videos   # after club + championship
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images gallery   # ~2,900 photos, see below
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images --videos <webroot>/assets/videos pages   # after gallery
./migrate-to-strapi.sh --strapi-dir ~/strapi news-categories   # after championship + videos
./migrate-to-strapi.sh --strapi-dir ~/strapi --images <webroot>/assets/images   # all areas
./migrate-to-strapi.sh --list                                                   # available areas
```

**Documents:** protected documents (minutes, statutes) are only delivered by
`POST /api/documents/:documentId/download` with the members' password. Before migrating the documents, add
it to `~/strapi/.env` (the same password as `$docpass` in the PHP `constants.php`) and restart:

```bash
echo 'DOCUMENTS_PASSWORD=<members password>' >> ~/strapi/.env
pm2 restart strapi-hvtdp
```

Without it, protected documents cannot be downloaded (the endpoint answers 500 and logs an error). After the
website uses Strapi for documents, `checkPasswordValid.php` is no longer needed.

**Admin titles:** matches, videos, voting options, votings, players, standings and scorers have a computed,
read-only field "Titel" (`adminTitle`, not in the public API) that the admin shows in relations and the
relation picker (e.g. "2026/27 · 2. Runde · HV TDP Stainz – STT Pichler 3:3 (12.09.2026)"). It is updated on
every save (also of related entries) and filled in for entries without one when Strapi starts
(`src/admin-titles.js`).

**Gallery:** the first `gallery` run uploads about 2,900 photos (1.2 GB) and lets Strapi create 4 sizes of
each; plan for a longer run (about 8 minutes on a laptop, likely longer on the VPS) and about 1 GB more disk in
`~/strapi/public/uploads`. The photos land in media library folders "Galerie/<year>/<album>". Albums whose
photo files are missing are skipped and listed at the end (3 albums from 2022/2023 have no files anywhere: Kleinfeldturnier Stainz 2022, Straßenstockturnier ESV Zeierling 2023, 2. Vereinswandertag 2023);
copy the originals into `<webroot>/assets/images/<legacy folder>` and re-run `gallery` to add them. Old album
links (`/gallery/<year>/<slug>`) keep working, the slugs are the same.

**Pages (Hallenturnier, Advent):** `pages` fills the Hallenturnier entry (link to last year's album, so run
it after `gallery`) and uploads the Advent calendars 2021/2023 (48 posters, 48 videos, about 410 MB) into
media folders "Adventkalender/<year>". Every year: update the single type "Hallenturnier" (title, date,
deadline, fee, reference, album link; the registration closes automatically after the deadline or when
"Anmeldung offen" is switched off) and, for a new calendar, create an "Adventkalender" entry with 24 doors.

**Hallenturnier registration mails:** the form posts to `POST /api/hallenturnier-registrations/register`. Strapi
stores the registration (admin: "Hallenturnier-Anmeldung") and sends one mail to the club and a confirmation
with date, place, fee and bank details to the registrant. Add the SMTP account to `~/strapi/.env` and restart
(for GMX: `mail.gmx.net`, port 587, the full address as user):

```bash
cat >> ~/strapi/.env <<'ENV'
SMTP_HOST=mail.gmx.net
SMTP_PORT=587
SMTP_USER=hvtdpstainz@gmx.at
SMTP_PASS=<password>
MAIL_FROM=HV TDP Stainz <hvtdpstainz@gmx.at>
REGISTRATION_MAIL_TO=hvtdpstainz@gmx.at
REGISTRATION_MAIL_CC=<optional copy, e.g. your own address>
ENV
pm2 restart strapi-hvtdp
```

Without `SMTP_HOST` registrations are still stored, but the mails are only written to the log
(`pm2 logs strapi-hvtdp`). GMX may require enabling "POP3/IMAP/SMTP access" in the mailbox settings first.
`postHallenturnier.php` is no longer used by the website.

**News categories:** `news-categories` gives every news item a category (Spielbericht, Turnier, Veranstaltung,
Vereinsleben) from its title and links match reports to their match (about 60 of 109; reports without teams in
the title, e.g. "Verdienter Heimsieg!", are listed for linking in the admin). It only fills in what is missing, so
categories and links changed in the admin are kept; `node scripts/migrate-news-categories.js --force true`
recomputes everything. New news: pick the category (and for a match report the match) in the admin.

**Videos & voting:** the goal videos are attached to the championship matches, so run `videos` after `club`
and `championship` (it creates matches for older seasons and events, and fills in missing match dates).
Votes are cast via `POST /api/poll-options/:documentId/vote` (open votings only, at most 5 votes per IP and
voting per hour; `IS_PROXIED=true` is needed so the limit sees the visitor's IP, not nginx). The vote counts
are only visible in the admin. Until the new website is deployed, votes still go to the PHP endpoints: run
`videos` once more right before deploying the website, and **never again afterwards** — a re-run resets the
vote counts to the PHP numbers.

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
