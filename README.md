# Tuition Center Manager

Fee collection and attendance tracking for a tuition center. Node + Express + SQLite, mobile-first.

## Features
- Classes 1A–10D (40 sections: grades 1–10, divisions A–D) with a fixed monthly fee per class
- Monthly dues generated automatically; payments go to the oldest unpaid month first, extra amounts pay upcoming months in advance
- Quick **Collect fee** flow, downloadable PDF receipts, WhatsApp receipt/reminder links
- Student profile: pending amount, month-by-month status, past receipts, attendance
- Attendance marking (everyone defaults to present, holiday flag), monthly summary
- Reports with quick filters (Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, Custom), class filter, CSV export
- Admin + teacher logins (teachers see attendance only)
- Void (not delete) receipts; year-end promotion 1→2→…→10→graduated

## Run locally
```
npm install
npm start          # http://localhost:3000
```
On the first start an `admin` user is created and its password is printed in the console
(or set `ADMIN_USER` / `ADMIN_PASSWORD` before the first start). Change it under Settings.

Then open **Settings** to set the center name, address, billing start month and the fee per class.

Environment variables: `PORT` (3000), `HOST` (127.0.0.1), `TZ` (Asia/Kolkata — "today" and report ranges use this), `DB_PATH` (./data/tuition.db), `SESSION_SECRET` (auto-generated and stored next to the database), `NODE_ENV=production`.

## Deploy on Ubuntu
```
sudo apt update && sudo apt install -y nginx sqlite3 build-essential python3
# Node 20+ (e.g. via NodeSource), then:
sudo useradd -r -m -d /opt/tuition tuition
sudo -u tuition git clone <your repo> /opt/tuition      # or copy the folder
cd /opt/tuition && sudo -u tuition npm ci --omit=dev
sudo cp deploy/tuition.service /etc/systemd/system/
sudo systemctl enable --now tuition
sudo journalctl -u tuition -n 20        # shows the generated admin password on first start
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tuition   # edit server_name
sudo ln -s /etc/nginx/sites-available/tuition /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d your.domain
```
Use HTTPS: the login cookie is marked secure in production.

## Backups
`chmod +x backup.sh`, then add a cron job: `30 2 * * * /opt/tuition/backup.sh`. Copy the `backups/` folder off the server regularly.

## Notes
- Amounts are whole numbers (no paise). Receipts print "Rs." because the built-in PDF font has no ₹ glyph.
- Changing a class fee affects months billed afterwards; existing dues keep their original amount.
- Dues are created for every month from the later of "billing starts from" and the student's start month.
