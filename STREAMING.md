# Channel N9NE live streaming

This repository now supports a first-party live path:

`OBS (RTMP) -> MediaMTX -> low-latency HLS -> v2.html`

Playback events are posted to the server-side analytics endpoint and stored in Supabase. Raw events remain private; the page receives only aggregate viewer count, watch minutes, and playback health.

## 1. Start MediaMTX

Copy `.env.example` to `.env`, replace the publisher password, then run:

```bash
docker compose up -d
```

For OBS, use:

- Server: `rtmp://YOUR_STREAM_HOST:1935`
- Stream key: `n9ne?user=n9ne-publisher&pass=YOUR_PASSWORD`

Local HLS playback is available at `http://localhost:8888/n9ne/index.m3u8`. In production, put TLS and a CDN/reverse proxy in front of port 8888 and set `PUBLIC_HLS_URL` in the web deployment.

## 2. Create analytics storage

Run `supabase/migrations/001_viewer_analytics.sql` in the existing Supabase project, then configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel. The service-role key must never be exposed to browser code.

The first milestone tracks:

- viewers active within the last 45 seconds;
- watch minutes from 15-second heartbeats;
- play, pause, buffering, and fatal playback errors;
- aggregate playback health.

## 3. Deploy the player

Set these server-side environment variables:

```text
PUBLIC_STREAM_ID=n9ne
PUBLIC_HLS_URL=https://stream.channeln9ne.com/n9ne/index.m3u8
PUBLIC_WEBRTC_URL=https://stream.channeln9ne.com:8889/n9ne
```

Open `v2.html`. Safari uses native HLS; other modern browsers use hls.js. When no manifest is available, the player switches to an off-air state without breaking the rest of the page.

## Operations

- MediaMTX Prometheus metrics are available inside the host at `http://127.0.0.1:9998/metrics` when port 9998 is not publicly exposed.
- Recordings are stored under `streaming/recordings` and expire after 30 days.
- Keep RTMP port 1935 behind a firewall where possible. The publisher account is limited to the `n9ne` path.
- Do not expose MediaMTX API or metrics ports publicly.

