export default async function handler(req, res) {
  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    return res.status(500).json({ error: "Mux API credentials missing" });
  }

  const authHeader =
    "Basic " + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64");

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return "—";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}h ${mins.toString().padStart(2, "0")}m`;
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  }

  try {
    // 1️⃣ Fetch up to 50 latest assets
    const assetRes = await fetch("https://api.mux.com/video/v1/assets?limit=50", {
      headers: { Authorization: authHeader },
    });
    if (!assetRes.ok) throw new Error(`Mux assets API ${assetRes.statusText}`);
    const { data: assets = [] } = await assetRes.json();

    // 2️⃣ Filter for ready assets with playback IDs
    const readyAssets = assets
      .filter(a => a.status === "ready" && a.playback_ids?.length)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 3️⃣ Map and format
    const response = readyAssets.map(asset => {
      const playbackId = asset.playback_ids[0].id;
      const duration = formatDuration(asset.duration || 0);
      const createdAt = new Date(asset.created_at);
      const title =
        asset.name?.trim() ||
        `Stream from ${createdAt.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`;
      return {
        mux_asset_id: asset.id,
        title,
        playback_id: playbackId,
        thumbnail_url: `https://image.mux.com/${playbackId}/thumbnail.jpg?time=2`,
        duration,
        views: 0, // skip slow /data/v1/video-views
        created_at: asset.created_at,
      };
    });

    res.status(200).json(response);
  } catch (err) {
    console.error("Mux API Error:", err);
    res.status(500).json({
      error: "Failed to fetch Mux assets",
      details: err.message,
    });
  }
}
