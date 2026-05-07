# Deployment

Reference configs for hosting the standalone server (`npm run server:dev`
or `npm run server:start`) on a Linux VM behind nginx with TLS.

## Files

- `nginx/agm.conf` — HTTP-only site config that fronts both ports on a
  single domain. `certbot --nginx` rewrites it in place to add TLS,
  the 443 server block, and the 80 → 443 redirect. Routes:
  - `/admin/*` → management UI (port 8046)
  - `/api/*`   → management API (port 8046, with login rate limit)
  - `/v1/*`, `/v1beta/*` → OpenAI/Anthropic/Gemini proxy (port 8045)
  - `/`        → 302 redirect to `/admin/`

## Quick deploy

```bash
# Replace YOUR_DOMAIN below.
sudo cp deploy/nginx/agm.conf /etc/nginx/sites-available/agm.conf
sudo sed -i 's/agm.example.com/YOUR_DOMAIN/g' /etc/nginx/sites-available/agm.conf
sudo ln -s /etc/nginx/sites-available/agm.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# TLS via Let's Encrypt — rewrites agm.conf with the 443 block.
sudo certbot --nginx -d YOUR_DOMAIN
```

## Lock the upstreams to loopback

The Node servers default to `0.0.0.0`, which means they're reachable
directly on `:8045` and `:8046` even with nginx in front. Two fixes —
ideally both:

1. **Set `AGM_BIND_HOST=127.0.0.1`** in `.env`. Both the proxy and the
   management server then bind to loopback only and are only reachable
   via nginx.
2. **Firewall:** allow only ports 80 and 443 inbound.
   ```bash
   sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
   sudo ufw enable
   ```

## Hardening checklist before pointing DNS at the VM

- [ ] Strong `AGM_ADMIN_PASSWORD` (24+ random chars) in `.env`
- [ ] `AGM_API_KEY` set to a long random secret (clients send it as
      `Authorization: Bearer …`)
- [ ] `.env` permissions: `chmod 600 .env`
- [ ] Run as a non-login system user (e.g. `adduser --system --group agm`)
- [ ] Backup `~/.antigravity-agent/cloud_accounts.db` and `~/.antigravity-agent/.mk`
      (the master key — without it, the DB is unrecoverable)
- [ ] Process supervisor in place (systemd/pm2) so a crash auto-restarts
- [ ] HTTPS verified end-to-end (`curl -I https://YOUR_DOMAIN/admin/`)
