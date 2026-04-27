# SignalDeck IPTV

SignalDeck IPTV is a Docker-ready web player for Xtream Codes IPTV services. It provides:

- Xtream Codes login against `player_api.php`
- Live TV and movie catalog browsing
- EPG guide support with current, upcoming, and full-day views
- In-browser playback through a local proxy for HLS manifests and media segments
- Local favorites stored in the browser
- Search and category filtering without forced auto-switch playback
- A responsive interface built with React and Vite

## Notes

- This project does not ship with any playlists, channels, or credentials.
- You must provide your own Xtream Codes-compatible service details.
- Use this software only with content you are authorized to access.

## Stack

- Frontend: React + Vite + hls.js
- Backend: Node.js + Express
- Containers: Docker Compose with Nginx serving the frontend and proxying `/api`

## Run with Docker

Start Docker Desktop or another Docker daemon first, then run:

```bash
docker compose up --build
```

Open:

- Web app: http://localhost:8090
- API health check: http://localhost:3001/api/health

If you want a different host port for the web app, set `WEB_PORT` when starting Compose:

```bash
WEB_PORT=8080 docker compose up --build
```

## Run locally without Docker

```bash
npm install
npm run dev
```

This starts:

- Web app on http://localhost:5173
- API on http://localhost:3001

For local development, call the API directly on port 3001. In Docker, Nginx forwards `/api/*` to the server container.

## Xtream Codes notes

Enter:

- Server URL, for example `http://provider.example:8080`
- Username
- Password

The app uses the Xtream Codes API to load live categories, live streams, VOD categories, and VOD streams. Live playback defaults to HLS (`.m3u8`) and can be switched to MPEG-TS (`.ts`) from the UI.

For live channels, the app also loads short EPG data and shows current and upcoming programming when the provider exposes guide data.

## Mobile browser support

The web UI is responsive and intended to work in current mobile browsers.

Expected support:

- iPhone Safari: Supported for browsing and HLS playback. Inline playback is enabled, and fullscreen now falls back to the iOS video fullscreen API when the standard Fullscreen API is unavailable.
- Android Chrome: Supported for browsing, HLS playback through `hls.js`, and standard fullscreen behavior.
- iPad Safari and Chrome on iPad: Supported, with behavior closest to desktop Safari because both use WebKit.

Known mobile limits:

- HLS (`.m3u8`) is the preferred live format on mobile. MPEG-TS (`.ts`) is less reliable across mobile browsers.
- Browser autoplay rules still apply. Some devices require an explicit tap on Play before video starts.
- Fullscreen behavior is browser-specific and may differ slightly between iOS and Android.
- Older or embedded in-app browsers may be missing APIs used by the app, including local storage and modern media playback features.

## Limitations

- Some providers return codecs or transport formats that certain browsers cannot decode.
- The proxy helps with HLS playback and relative segment URLs, but it cannot fix unsupported codecs.
- TV series endpoints are not implemented in this version.
