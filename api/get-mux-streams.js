// api/get-mux-streams.js

export default async function handler(req, res) {
  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Mux API credentials missing' });
  }

  const authHeader = "Basic " + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64");

  try {
    // 1️⃣ Get Mux assets
    const assetRes = await fetch("https://api.mux.com/video/v1/assets?limit=20", {
      headers: { Authorization: authHeader },
    });
    const { data: assets } = await assetRes.json();

    // 2️⃣ For each asset, fetch analytics from Mux Data
    const enriched = await Promise.all(
      assets.map(async (asset) => {
        if (!asset.playback_ids?.length) return null;
        const playbackId = asset.playback_ids[0].id;

        const dataRes = await fetch(
          `https://api.mux.com/data/v1/metrics/views?filters[]=asset_id:${asset.id}`,
          { headers: { Authorization: authHeader } }
        );
        const { data } = await dataRes.json();
        const totalViews = data?.[0]?.total_views || 0;

        return {
          mux_asset_id: asset.id,
          title: asset.name || `Stream from ${new Date(asset.created_at).toLocaleDateString()}`,
          playback_id: playbackId,
          thumbnail_url: `https://image.mux.com/${playbackId}/thumbnail.jpg?time=2`,
          duration: asset.duration,
          views: totalViews,
          created_at: asset.created_at,
        };
      })
    );

    res.status(200).json(enriched.filter(Boolean));
  } catch (error) {
    console.error('Mux API Error:', error);
    res.status(500).json({ error: 'Failed to fetch Mux data' });
  }
}
