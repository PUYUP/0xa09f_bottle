# Deploy ke VPS (Ubuntu)

Target: `relay.a09f.com` → Go backend + Redis di VPS, Postgres di Supabase.

## 1. DNS

Buat record `A` → `relay.a09f.com` mengarah ke IP VPS. Tunggu propagasi.

## 2. Setup VPS (sekali)

```bash
# update + docker
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER   # logout-login setelah ini

# clone repo
mkdir -p ~/a09f && cd ~/a09f
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
sudo cp nginx.relay.conf /etc/nginx/sites-available/relay.a09f.com
sudo ln -s /etc/nginx/sites-available/relay.a09f.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL gratis via certbot (auto-tambah blok 443 + redirect http→https)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d relay.a09f.com
```

Verifikasi: `curl https://relay.a09f.com/api/health`

## Update berikutnya

```bash
cd ~/a09f && git pull
cd backend
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

## Frontend (Vercel — web.a09f.com)

React app di-deploy ke Vercel sebagai project terpisah:

```bash
cd frontend
echo "VITE_API_URL=https://relay.a09f.com" > .env.production
npm ci && npm run build
vercel deploy --prod
```

CORS backend sudah `AllowOrigins: *` jadi domain Vercel langsung bisa call API.

Hasil:
- `https://relay.a09f.com/` → info page statis (di backend)
- `https://relay.a09f.com/legacy/` → web client lama (tidak dihapus)
- `https://relay.a09f.com/api/*` → Go backend
- `https://web.a09f.com` → React app (Vercel)
