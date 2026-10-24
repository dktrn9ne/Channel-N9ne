const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};
const EVENT_TYPES = new Set([
  "session_start", "playback_ready", "play", "pause", "heartbeat",
  "buffer_start", "buffer_end", "playback_error", "session_end",
]);

function config() {
  return {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

function send(res, status, payload) {
  Object.entries(HEADERS).forEach(([key, value]) => res.setHeader(key, value));
  return res.status(status).json(payload);
}

async function bodyOf(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return {};
}

function validId(value, max = 100) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[a-zA-Z0-9_.:-]+$/.test(value);
}

function supabaseHeaders(key, prefer) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    return res.status(204).end();
  }

  const { url, key } = config();
  if (!url || !key) return send(res, 503, { error: "Analytics storage is not configured" });
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/viewer_events`;

  try {
    if (req.method === "POST") {
      const event = await bodyOf(req);
      if (!validId(event.session_id, 120) || !validId(event.stream_id) || !EVENT_TYPES.has(event.event_type)) {
        return send(res, 400, { error: "Invalid analytics event" });
      }
      const occurredAt = new Date(event.occurred_at || Date.now());
      if (Number.isNaN(occurredAt.valueOf())) return send(res, 400, { error: "Invalid event timestamp" });

      const payload = {
        session_id: event.session_id,
        stream_id: event.stream_id,
        event_type: event.event_type,
        playback_position: Number.isFinite(Number(event.playback_position)) ? Number(event.playback_position) : 0,
        occurred_at: occurredAt.toISOString(),
        details: event.details && JSON.stringify(event.details).length <= 2048 ? event.details : {},
      };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: supabaseHeaders(key, "return=minimal"),
        body: JSON.stringify(payload),
      });
      if (!response.ok) return send(res, 502, { error: "Analytics insert failed" });
      return send(res, 202, { accepted: true });
    }

    if (req.method === "GET") {
      const streamId = req.query?.stream_id || "n9ne";
      if (!validId(streamId)) return send(res, 400, { error: "Invalid stream id" });
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({
        select: "session_id,event_type,occurred_at,details",
        stream_id: `eq.${streamId}`,
        occurred_at: `gte.${since}`,
        order: "occurred_at.desc",
        limit: "5000",
      });
      const response = await fetch(`${endpoint}?${params}`, { headers: supabaseHeaders(key) });
      if (!response.ok) return send(res, 502, { error: "Analytics query failed" });
      const events = await response.json();
      const cutoff = Date.now() - 45_000;
      const latestBySession = new Map();
      let heartbeats = 0;
      let errors = 0;
      let healthySignals = 0;
      for (const event of events) {
        const timestamp = new Date(event.occurred_at).valueOf();
        if (!latestBySession.has(event.session_id)) latestBySession.set(event.session_id, event);
        if (event.event_type === "heartbeat") heartbeats += 1;
        if (event.event_type === "playback_error") errors += 1;
        if (["heartbeat", "play", "playback_ready"].includes(event.event_type)) healthySignals += 1;
        event._timestamp = timestamp;
      }
      const activeViewers = [...latestBySession.values()].filter(event =>
        event._timestamp >= cutoff && !["pause", "session_end", "playback_error"].includes(event.event_type)
      ).length;
      const health = healthySignals + errors === 0 ? null : Math.round((healthySignals / (healthySignals + errors)) * 100);
      return send(res, 200, {
        stream_id: streamId,
        active_viewers: activeViewers,
        watch_minutes: Math.round((heartbeats * 15) / 60),
        playback_health: health === null ? "—" : `${health}%`,
      });
    }

    return send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error("Analytics API error", error);
    return send(res, 500, { error: "Analytics service unavailable" });
  }
}

