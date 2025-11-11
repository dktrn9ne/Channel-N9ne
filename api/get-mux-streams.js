export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    res.setHeader("Access-Control-Allow-Origin", "*");
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
    const params = new URLSearchParams({
      limit: "50",
      status: "ready",
      order: "created_at:desc",
    });

    const assetRes = await fetch(`https://api.mux.com/video/v1/assets?${params.toString()}`, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });

    if (!assetRes.ok) {
      const text = await assetRes.text();
      throw new Error(`Mux responded with ${assetRes.status}: ${text || assetRes.statusText}`);
    }

    const { data: assets = [] } = await assetRes.json();

    const readyAssets = assets
      .filter(asset => asset?.playback_ids?.some(p => p?.policy === "public"))
      .map(asset => ({
        ...asset,
        playback_ids: asset.playback_ids.filter(p => p?.policy === "public"),
      }));

    const response = readyAssets.map(asset => {
      const playbackId = asset.playback_ids[0]?.id;
      const createdAt = new Date(asset.created_at);
      const title = createdAt instanceof Date && !Number.isNaN(createdAt.valueOf())
        ? `Stream from ${createdAt.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}`
        : "Previous Stream";

      return {
        mux_asset_id: asset.id,
        title,
        playback_id: playbackId,
        thumbnail_url: playbackId
          ? `https://image.mux.com/${playbackId}/thumbnail.jpg?time=2`
          : null,
        duration: formatDuration(asset.duration || 0),
        views: Number.isFinite(Number(asset.view_count)) ? Number(asset.view_count) : 0,
        created_at:
          createdAt instanceof Date && !Number.isNaN(createdAt.valueOf())
            ? createdAt.toISOString()
            : null,
      };
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json(response.filter(item => item.playback_id));
  } catch (error) {
    console.error("Mux API Error:", error);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res
      .status(500)
      .json({ error: "Failed to fetch Mux assets", details: error.message || "Unknown error" });
  }
}
