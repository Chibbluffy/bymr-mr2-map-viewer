# Deploying to a server

## 1. Copy the repository to the server

```bash
git clone git@github.com:Chibbluffy/bymr-mr2-map-viewer.git
cd ~/bymr-mr2-map-viewer
git pull
cp .env.example .env
vim .env    # fill in BYM_API_KEY from REACT
```

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

## 3. nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/mr2.example.com
sudo nano /etc/nginx/sites-available/mr2.example.com   # fill in your real subdomain
sudo ln -s /etc/nginx/sites-available/mr2.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

To get HTTPS working and create a cert
```bash
sudo certbot --nginx -d mr2.example.com
```

(assumes certbot + the nginx plugin are already installed
`sudo apt install certbot python3-certbot-nginx` if not).

A subdomain, not a path under an existing site, is what the nginx config
here assumes — every asset/API path in the app is root-relative
(`/styles.css`, `/api/worlds`, ...), so whatever serves it needs to own the
whole path space. A shared path like `example.com/mr2/` would need real
code changes first.

## Updating 

```bash
cd ~/bymr-mr2-map-viewer && git pull
sudo systemctl restart bymr-mr2-poller bymr-mr2-server
```
