# saltleak mobile

Ionic React app sharing the E2EE core with the web frontend.

- Crypto / IndexedDB / API / store logic: imported from `../frontend/src/lib`
  via the `@shared` alias — single source of truth, no duplicated crypto.
- UI: stock Ionic components (no retro theme).

## Dev

```bash
cp .env.example .env   # VITE_API_URL=https://relay.saltleak.com
npm install
npm run dev            # vite dev server
```

## Build

```bash
npm run build          # tsc + vite → dist/
npm run preview        # serve dist locally
```

## Capacitor (Android/iOS)

```bash
npm i -D @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init saltleak com.saltleak.app --web-dir dist
npx cap add android    # or: npx cap add ios
npx cap sync
npx cap open android   # opens Android Studio
```

Notes:
- `VITE_API_URL` is baked at build time — set it before `npm run build`.
- IndexedDB persists inside the WebView; vault export/import covers device
  migration, same as web.
- SSE (`/api/events`) works in the WebView; EventSource is supported.
