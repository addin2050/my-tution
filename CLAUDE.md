# Tuition Center Manager

Node + Express + SQLite (better-sqlite3), EJS views, no build step. Entry file: `app.js`. See `README.md` for features.

## Deployment

Shared course server. Follow `DEPLOY-GUIDE.md` for the full instructions.

| | |
|---|---|
| Server | 187.127.162.81 (Ubuntu), user `sarasanabi`, `ssh sarasanabi@187.127.162.81` (key login) |
| App name | `tuition` |
| Port | 3800 (127.0.0.1 only; allowed range 3800–3899) |
| Address | https://sarasanabi.dhilber.in |
| Repo | https://github.com/addin2050/my-tution (public) |
| Code | `~/apps/tuition/` |
| Database | `~/data/tuition/tuition.db` (backups in `~/data/tuition/backups/`, nightly cron 21:24 UTC, 14 days kept) |
| Settings/secrets | `~/.config/tuition.env` (chmod 600, never commit) |
| Service | `~/.config/systemd/user/tuition.service` (`systemctl --user ... tuition`) |

Update after pushing to GitHub:

```
ssh sarasanabi@187.127.162.81 "cd ~/apps/tuition && git pull && npm ci --omit=dev && systemctl --user restart tuition"
```

Then check `systemctl --user status tuition --no-pager`, `curl -s http://127.0.0.1:3800/login` on the server, and the address above. Logs: `journalctl --user -u tuition -n 50 --no-pager`.

Rules (from the course server):
- No sudo/root, no `apt`, no `npm install -g`. If something needs root, ask the instructor.
- Stay inside `/home/sarasanabi`; never touch other users' processes or files.
- Listen on 127.0.0.1 only, ports 3800–3899 only (also for test runs on the server).
- Don't touch the web server, firewall or DNS.
- No secrets in git or in this file; they live only in `~/.config/tuition.env`.
- Keep the app running with `systemctl --user`, not pm2, nohup, screen or `&`.
- The database lives outside the code folder so `git pull` never touches it.
