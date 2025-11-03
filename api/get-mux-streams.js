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

    // Sort newest first
    assets.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    // 2️⃣ For each asset, fetch analytics from Mux Data
    const enriched = await Promise.all(
      assets.map(async (asset) => {
        if (!asset.playback_ids?.length) return null;
        const playbackId = asset.playback_ids[0].id;

        // 🎯 Fetch Mux Data metrics (views)
        const dataRes = await fetch(
          `https://api.mux.com/data/v1/metrics/views?filters[]=asset_id:${asset.id}`,
          { headers: { Authorization: authHeader } }
        );
        const { data } = await dataRes.json();
        const totalViews = data?.[0]?.total_views || 0;

        // 🕒 Fix date (Mux returns UNIX seconds)
        const createdAt = asset.created_at
          ? new Date(asset.created_at * 1000)
          : new Date();

        // 🖼️ Thumbnail + Title fallback
        const title =
          asset.name ||
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
          duration: formatDuration(asset.duration),
          views: totalViews,
          created_at: createdAt,
        };
      })
    );

    res.status(200).json(enriched.filter(Boolean));
  } catch (error) {
    console.error('Mux API Error:', error);
    res
      .status(500)
      .json({ error: 'Failed to fetch Mux data', details: error.message });
  }
}
