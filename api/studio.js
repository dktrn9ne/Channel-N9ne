import crypto from "node:crypto";

const COOKIE_NAME = "n9ne_studio";
const SESSION_SECONDS = 8 * 60 * 60;
const ALLOWED_RANGES = new Map([
  ["24h", { milliseconds: 24 * 60 * 60 * 1000, bucketMinutes: 15 }],
  ["7d", { milliseconds: 7 * 24 * 60 * 60 * 1000, bucketMinutes: 120 }],
  ["30d", { milliseconds: 30 * 24 * 60 * 60 * 1000, bucketMinutes: 720 }],
]);

function send(res, status, payload) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function createSession(secret) {
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  return `${expires}.${signature(expires, secret)}`;
}

function hasValidSession(req, secret) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return false;
  const [expires, providedSignature] = token.split(".");
  if (!expires || !providedSignature || Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  return safeEqual(providedSignature, signature(expires, secret));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return {};
}

function supabaseConfig() {
  return {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function readMediaMtxStatus(streamId) {
  if (!process.env.MEDIAMTX_METRICS_URL) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    const base = process.env.MEDIAMTX_METRICS_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/metrics?type=paths&path=${encodeURIComponent(streamId)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const metrics = await response.text();
    const escaped = streamId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`paths\\{name="${escaped}",state="ready"\\}\\s+1`).test(metrics);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function aggregate(events, rangeConfig) {
  const now = Date.now();
  const activeCutoff = now - 45_000;
  const sessions = new Map();
  const buckets = new Map();
  const counts = {};
  let heartbeats = 0;
  let errors = 0;
  let healthySignals = 0;
  let bufferMilliseconds = 0;

  for (const event of events) {
    const time = new Date(event.occurred_at).valueOf();
    if (!Number.isFinite(time)) continue;
    counts[event.event_type] = (counts[event.event_type] || 0) + 1;
    if (event.event_type === "heartbeat") heartbeats += 1;
    if (event.event_type === "playback_error") errors += 1;
    if (["heartbeat", "play", "playback_ready"].includes(event.event_type)) healthySignals += 1;
    if (event.event_type === "buffer_end") bufferMilliseconds += Number(event.details?.duration_ms || 0);

    const session = sessions.get(event.session_id) || {
      id: event.session_id,
      first: time,
      last: time,
      latestType: event.event_type,
      events: 0,
      errors: 0,
    };
    session.first = Math.min(session.first, time);
    session.last = Math.max(session.last, time);
    session.latestType = time >= session.last ? event.event_type : session.latestType;
    session.events += 1;
    if (event.event_type === "playback_error") session.errors += 1;
    sessions.set(event.session_id, session);

    if (["heartbeat", "play", "playback_ready"].includes(event.event_type)) {
      const bucketMs = rangeConfig.bucketMinutes * 60 * 1000;
      const bucket = Math.floor(time / bucketMs) * bucketMs;
      if (!buckets.has(bucket)) buckets.set(bucket, new Set());
      buckets.get(bucket).add(event.session_id);
    }
  }

  const activeViewers = [...sessions.values()].filter(session =>
    session.last >= activeCutoff && !["pause", "session_end", "playback_error"].includes(session.latestType)
  ).length;
  const timeline = [...buckets.entries()].sort(([a], [b]) => a - b).map(([timestamp, viewers]) => ({
    timestamp: new Date(timestamp).toISOString(),
    viewers: viewers.size,
  }));
  const peakViewers = timeline.reduce((peak, point) => Math.max(peak, point.viewers), 0);
  const health = healthySignals + errors === 0 ? null : Math.round((healthySignals / (healthySignals + errors)) * 100);
  const recentSessions = [...sessions.values()].sort((a, b) => b.last - a.last).slice(0, 12).map(session => ({
    id: `${session.id.slice(0, 8)}…`,
    started_at: new Date(session.first).toISOString(),
    last_seen: new Date(session.last).toISOString(),
    minutes: Math.max(0, Math.round((session.last - session.first) / 60000)),
    events: session.events,
    errors: session.errors,
  }));

  return {
    active_viewers: activeViewers,
    peak_viewers: peakViewers,
    unique_sessions: sessions.size,
    watch_minutes: Math.round((heartbeats * 15) / 60),
    playback_health: health,
    playback_errors: errors,
    buffer_minutes: Math.round(bufferMilliseconds / 60000),
    event_counts: counts,
    timeline,
    recent_sessions: recentSessions,
  };
}

export default async function handler(req, res) {
  const password = process.env.STUDIO_ADMIN_PASSWORD;
  const sessionSecret = process.env.STUDIO_SESSION_SECRET;
  if (!password || !sessionSecret) return send(res, 503, { error: "Studio authentication is not configured" });

  if (req.method === "POST") {
    const body = await readBody(req);
    if (body.action !== "login" || !safeEqual(body.password || "", password)) {
      return send(res, 401, { error: "Invalid Studio password" });
    }
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(createSession(sessionSecret))}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
    return send(res, 200, { authenticated: true });
  }

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return send(res, 200, { authenticated: false });
  }

  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
  if (!hasValidSession(req, sessionSecret)) return send(res, 401, { error: "Authentication required" });

  const selectedRange = ALLOWED_RANGES.has(req.query?.range) ? req.query.range : "24h";
  const rangeConfig = ALLOWED_RANGES.get(selectedRange);
  const streamId = process.env.PUBLIC_STREAM_ID || "n9ne";
  const { url, key } = supabaseConfig();
  if (!url || !key) return send(res, 503, { error: "Supabase service-role configuration is missing" });

  const since = new Date(Date.now() - rangeConfig.milliseconds).toISOString();
  const params = new URLSearchParams({
    select: "session_id,event_type,occurred_at,playback_position,details",
    stream_id: `eq.${streamId}`,
    occurred_at: `gte.${since}`,
    order: "occurred_at.asc",
    limit: "10000",
  });
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/viewer_events?${params}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return send(res, 502, { error: "Unable to load analytics" });
  const events = await response.json();
  const analytics = aggregate(events, rangeConfig);
  const mediaMtxOnline = await readMediaMtxStatus(streamId);

  return send(res, 200, {
    range: selectedRange,
    generated_at: new Date().toISOString(),
    stream: {
      id: streamId,
      online: mediaMtxOnline ?? analytics.active_viewers > 0,
      rtmp_server: process.env.RTMP_PUBLIC_URL || "rtmp://localhost:1935",
      stream_key: process.env.STREAM_PUBLISH_PASSWORD
        ? `${streamId}?user=n9ne-publisher&pass=${process.env.STREAM_PUBLISH_PASSWORD}`
        : null,
      hls_url: process.env.PUBLIC_HLS_URL || "http://localhost:8888/n9ne/index.m3u8",
      webrtc_url: process.env.PUBLIC_WEBRTC_URL || null,
    },
    analytics,
  });
}
