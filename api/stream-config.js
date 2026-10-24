const DEFAULT_HLS_URL = "http://localhost:8888/n9ne/index.m3u8";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  return res.status(200).json({
    stream_id: process.env.PUBLIC_STREAM_ID || "n9ne",
    hls_url: process.env.PUBLIC_HLS_URL || DEFAULT_HLS_URL,
    webrtc_url: process.env.PUBLIC_WEBRTC_URL || null,
  });
}

