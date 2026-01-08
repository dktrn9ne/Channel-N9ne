const DEFAULT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_KEY;
  return { supabaseUrl, supabaseKey };
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...DEFAULT_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, DEFAULT_HEADERS);
    res.end();
    return;
  }

  const { supabaseUrl, supabaseKey } = getSupabaseConfig();
  if (!supabaseUrl || !supabaseKey) {
    sendJson(res, 500, { error: "Supabase configuration missing" });
    return;
  }

  const baseUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/messages`;
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  try {
    if (req.method === "GET") {
      const url = `${baseUrl}?select=*&order=created_at.asc&limit=200`;
      const response = await fetch(url, { headers, method: "GET" });
      const payload = await response.json();
      if (!response.ok) {
        sendJson(res, response.status, { error: "Supabase fetch failed", details: payload });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "POST") {
      const { user_id: userId, username, message } = await readJson(req);
      if (!message || typeof message !== "string") {
        sendJson(res, 400, { error: "Message text required" });
        return;
      }
      const insertPayload = {
        user_id: userId || "anonymous",
        username: username || "Anonymous",
        message: message.trim(),
      };
      const response = await fetch(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(insertPayload),
      });
      const payload = await response.json();
      if (!response.ok) {
        sendJson(res, response.status, { error: "Supabase insert failed", details: payload });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    res.writeHead(405, DEFAULT_HEADERS);
    res.end();
  } catch (error) {
    sendJson(res, 500, { error: "Supabase proxy failed", details: error.message });
  }
}
