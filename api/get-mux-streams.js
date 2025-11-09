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
    // Fetch up to 50 assets
    const assetRes = await fetch("https://api.mux.com/video/v1/assets?limit=50", {
      headers: { Authorization: authHeader },
    });
    const { data: assets = [] } = await assetRes.json();

    const readyAssets = assets
      .filter(a => a.status === "ready" && a.playback_ids?.length)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const response = readyAssets.map(asset => {
      const playbackId = asset.playback_ids[0].id;
      const createdAt = new Date(asset.created_at); // ✅ fix
      const title = `Stream from ${createdAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`;

      return {
        mux_asset_id: asset.id,
        title,
        playback_id: playbackId,
        thumbnail_url: `https://image.mux.com/${playbackId}/thumbnail.jpg?time=2`,
        duration: formatDuration(asset.duration || 0),
        views: 0,
        created_at: createdAt.toISOString(), // ✅ fix for front-end sorting
      };
    });

    res.status(200).json(response);
  } catch (error) {
    console.error("Mux API Error:", error);
    res.status(500).json({ error: "Failed to fetch Mux assets", details: error.message });
  }
}
