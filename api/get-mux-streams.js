export default async function handler(req, res) {
  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Mux API credentials missing' });
  }

  const authHeader =
    'Basic ' + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString('base64');

  // ⏱️ Helper: Format duration from seconds → "1h 02m" or "59m 58s"
  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '—';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}h ${mins.toString().padStart(2, '0')}m`;
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }

  try {
    // 1️⃣ Get latest Mux assets
    const assetRes = await fetch('https://api.mux.com/video/v1/assets?limit=20', {
      headers: { Authorization: authHeader },
    });
    const { data: assets = [] } = await assetRes.json();

    // 🧹 Deduplicate by asset ID and sort newest first
    const uniqueAssets = Array.from(
      new Map(assets.map((a) => [a.id, a])).values()
    ).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // 2️⃣ Enrich with analytics
    const enriched = await Promise.all(
      uniqueAssets.map(async (asset) => {
        if (!asset.playback_ids?.length) return null;
        const playbackId = asset.playback_ids[0].id;

        // 🎯 Fetch Mux Data metrics (views)
        let totalViews = 0;
        try {
          const dataRes = await fetch(
            `https://api.mux.com/data/v1/metrics/views?filters[]=asset_id:${asset.id}`,
            { headers: { Authorization: authHeader } }
          );
          const { data } = await dataRes.json();
          totalViews = data?.[0]?.total_views || 0;
        } catch (err) {
          console.warn(`Analytics fetch failed for asset ${asset.id}`);
        }

        // 🕒 Fix date (handle both UNIX and ISO)
        const createdAt =
          typeof asset.created_at === 'number'
            ? new Date(asset.created_at * 1000)
            : new Date(asset.created_at);

        // 🕒 Safe duration
        const durationSeconds = Number(asset.duration);
        const duration = formatDuration(!isNaN(durationSeconds) ? durationSeconds : 0);

        // 🖼️ Thumbnail + Title fallback
        const title =
          asset.name?.trim() ||
          `Stream from ${createdAt.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}`;

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

    // Filter valid items only
    const cleaned = enriched.filter(Boolean);

    res.status(200).json(cleaned);
  } catch (error) {
    console.error('Mux API Error:', error);
    res
      .status(500)
      .json({ error: 'Failed to fetch Mux data', details: error.message });
  }
}
