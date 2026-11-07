# Deploy ke VPS (Ubuntu)

Target: `relay.saltleak.com` → Go backend + Redis di VPS, Postgres di Supabase.

## 1. DNS

Buat record `A` → `relay.saltleak.com` mengarah ke IP VPS. Tunggu propagasi.

## 2. Setup VPS (sekali)

```bash
# update + docker
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER   # logout-login setelah ini

# clone repo
mkdir -p ~/saltleak && cd ~/saltleak
git clone <repo-url> .
cd backend
```

## 3. Env

```bash
cp .env.production.example .env.production
nano .env.production   # isi DATABASE_URL (Supabase pooler, port 6543)
```

## 4. Jalankan

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps   # app + redis harus healthy
curl http://127.0.0.1:8080/api/health           # {"ok":true,...}
```

## 5. TLS + domain (nginx yang sudah ada)

VPS sudah menjalankan nginx di port 80 — pakai itu, jangan install Caddy.

```bash
sudo cp nginx.relay.conf /etc/nginx/sites-available/relay.saltleak.com
sudo ln -s /etc/nginx/sites-available/relay.saltleak.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL gratis via certbot (auto-tambah blok 443 + redirect http→https)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d relay.saltleak.com
```

Verifikasi: `curl https://relay.saltleak.com/api/health`

## Update berikutnya

```bash
cd ~/saltleak && git pull
cd backend
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

## Frontend

Build React dengan API URL production lalu serve statis (Cloudflare Pages gratis,
atau nginx/Caddy di VPS yang sama):

```bash
cd frontend
echo "VITE_API_URL=https://relay.saltleak.com" > .env.production
npm ci && npm run build
```

Legacy web client tetap tersedia di `https://relay.saltleak.com/` (embedded Go).
