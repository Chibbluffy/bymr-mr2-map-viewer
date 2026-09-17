# Deploying to a server

This turns the manual "ssh in, `git pull`" workflow into two always-running
systemd services (`poller.py` keeping the database in sync, `server.py`
serving the site) behind nginx, plus an optional GitHub Actions workflow that
does the pull-and-restart for you on every push to `main`.

Everything below assumes the layout your `ls` showed: user `ubuntu`, repo
checked out at `~/bymr-mr2-map-viewer` (i.e. `/home/ubuntu/bymr-mr2-map-viewer`).
If your user or path differs, adjust the `User=`/`WorkingDirectory=`/
`EnvironmentFile=`/`ExecStart=` lines in both `.service` files accordingly —
they're plain text, no templating.

## 1. Get the missing pieces onto the server

Your current checkout is missing `server.py`, `poller.py`, `db.py`,
`config.py`, and `data/` — those didn't exist when you last pulled. Get them,
and a `.env` with your API key:

```bash
cd ~/bymr-mr2-map-viewer
git pull
cp .env.example .env
nano .env    # fill in BYM_API_KEY
```

`data/` doesn't need creating by hand — `poller.py`'s first run creates
`data/mr2.sqlite3` itself.

## 2. Install the systemd services

```bash
sudo cp deploy/bymr-mr2-poller.service deploy/bymr-mr2-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bymr-mr2-poller bymr-mr2-server
```

Check both actually started:

```bash
sudo systemctl status bymr-mr2-poller bymr-mr2-server
journalctl -u bymr-mr2-poller -f    # watch it poll live; Ctrl-C to stop watching
```

`server.py` listens on `127.0.0.1:8081` by default (`HOST`/`PORT` in `.env`
to change it) — not exposed to the internet directly, nginx sits in front.

## 3. nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/mr2.example.com
sudo nano /etc/nginx/sites-available/mr2.example.com   # fill in your real subdomain
sudo ln -s /etc/nginx/sites-available/mr2.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Point that subdomain's DNS A/AAAA record at this server first, if you
haven't already. Then, once plain HTTP is confirmed working:

```bash
sudo certbot --nginx -d mr2.example.com
```

(assumes certbot + the nginx plugin are already installed, same as your
other sites — `sudo apt install certbot python3-certbot-nginx` if not).

A subdomain, not a path under an existing site, is what the nginx config
here assumes — every asset/API path in the app is root-relative
(`/styles.css`, `/api/worlds`, ...), so whatever serves it needs to own the
whole path space. A shared path like `example.com/mr2/` would need real
code changes first.

## 4. (Optional) automatic deploy on push

The workflow at `.github/workflows/deploy.yml` SSHes in, does
`git fetch && git reset --hard origin/main`, and restarts both services —
same steps as above minus the one-time setup.

**Add these repo secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | your server's IP or hostname |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | a **private** key whose matching public key is in that server's `~/.ssh/authorized_keys` for that user — generate a dedicated deploy key (`ssh-keygen -t ed25519 -f deploy_key -N ""`) rather than reusing your own, so it can be revoked independently |
| `DEPLOY_PORT` | only if SSH isn't on port 22 |

**Passwordless restart for just these two services** — the deploy user
needs `sudo systemctl restart` to work non-interactively. Don't grant broad
sudo for this; scope it to exactly the two restart commands:

```bash
sudo visudo -f /etc/sudoers.d/bymr-mr2-deploy
```

```
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart bymr-mr2-poller, /usr/bin/systemctl restart bymr-mr2-server, /usr/bin/systemctl status bymr-mr2-poller, /usr/bin/systemctl status bymr-mr2-server
```

(`visudo -f` validates syntax before saving — a broken sudoers file can lock
you out of sudo entirely, so always edit it this way, never with a plain
editor.)

After that, push to `main` and check the Actions tab — or trigger it by hand
from there any time (`workflow_dispatch` is wired up for that).

## Updating without the workflow

Same three commands as always, just now followed by two restarts instead of
none:

```bash
cd ~/bymr-mr2-map-viewer && git pull
sudo systemctl restart bymr-mr2-poller bymr-mr2-server
```
