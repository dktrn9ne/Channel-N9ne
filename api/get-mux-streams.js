export default async function handler(req, res) {
  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    return res.status(500).json({ error: "Mux API credentials missing" });
  }

  const authHeader =
    "Basic " +
    Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64");

  // ⏱️ Format seconds → "1h 02m" or "59 m 58 s"
  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return "—";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}h ${mins.toString().padStart(2, "0")}m`;
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  }

  try {
    // 1️⃣  Fetch latest Mux assets
    const assetRes = await fetch(
      "https://api.mux.com/video/v1/assets?limit=20",
      { headers: { Authorization: authHeader } }
    );
    const { data: assets = [] } = await assetRes.json();

    // 🧹  Deduplicate and sort newest first
    const uniqueAssets = Array.from(
      new Map(assets.map((a) => [a.id, a])).values()
    ).sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // 2️⃣  Enrich each asset
    const enriched = await Promise.all(
      uniqueAssets.map(async (asset) => {
        if (!asset.playback_ids?.length) return null;
        const playbackId = asset.playback_ids[0].id;

        // 🎯  Views using /data/v1/video-views
        let totalViews = 0;
        try {
          const viewsRes = await fetch(
            `https://api.mux.com/data/v1/video-views?filters[]=asset_id:${asset.id}&timeframe[]=30:days&limit=100`,
            { headers: { Authorization: authHeader } }
          );

          if (viewsRes.ok) {
            const json = await viewsRes.json();

            if (Array.isArray(json.data)) {
              totalViews = json.data.length;
            } else if (json.data) {
              totalViews = 1;
            } else {
              totalViews = 0;
            }
          } else {
            console.warn(
              `Video views API error ${viewsRes.status}: ${viewsRes.statusText}`
            );
          }
        } catch (err) {
          console.warn(`Video views fetch failed for ${asset.id}`, err);
        }

        // 🕒  Normalize & validate date
        let createdAt;
        if (asset.created_at) {
          const ts = Number(asset.created_at);
          createdAt = !isNaN(ts)
            ? new Date(ts < 1e12 ? ts * 1000 : ts)
            : new Date(asset.created_at);
        } else {
          createdAt = new Date();
        }
        const isValidDate = createdAt instanceof Date && !isNaN(createdAt);
        if (!isValidDate) createdAt = new Date();

        // 🕒  Normalize duration
        const rawDuration = asset.duration;
        const durationSeconds =
          typeof rawDuration === "string"
            ? parseFloat(rawDuration)
            : Number(rawDuration);
        const duration =
          !isNaN(durationSeconds) && durationSeconds > 0
            ? formatDuration(durationSeconds)
            : "—";

        // 🖼️  Title & thumbnail
        const title =
          asset.name?.trim() ||
          (isValidDate
            ? `Stream from ${createdAt.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}`
            : "Untitled Stream");

        const thumbnailUrl =
          asset.static_renditions?.files?.[0]?.url ||
          `https://image.mux.com/${playbackId}/thumbnail.jpg?time=2`;

        return {
          mux_asset_id: asset.id,
          title,
          playback_id: playbackId,
          thumbnail_url: thumbnailUrl,
          duration,
          views: totalViews,
          created_at: createdAt,
        };
      })
    );

    res.status(200).json(enriched.filter(Boolean));
  } catch (error) {
    console.error("Mux API Error:", error);
    res.status(500).json({
      error: "Failed to fetch Mux data",
      details: error.message,
    });
  }
}
