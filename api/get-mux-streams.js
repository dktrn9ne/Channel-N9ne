const PUBLIC_ID_ENV_KEYS = [
  "MUX_PUBLIC_PLAYBACK_IDS",
  "MUX_FALLBACK_PLAYBACK_IDS",
  "MUX_ARCHIVE_PLAYBACK_IDS",
];

function readFallbackPlaybackIds() {
  for (const key of PUBLIC_ID_ENV_KEYS) {
    const value = process.env[key];
    if (value && typeof value === "string") {
      return value
        .split(/[,\n]/)
        .map((id) => id.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function buildFallbackResponse(ids) {
  return ids.map((id, index) => ({
    mux_asset_id: `fallback-${index}`,
    title: "Previous Stream",
    playback_id: id,
    playback_url: `https://stream.mux.com/${id}.m3u8`,
    thumbnail_url: `https://image.mux.com/${id}/thumbnail.jpg?time=2`,
    duration: "—",
    views: 0,
    created_at: null,
  }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const fallbackPlaybackIds = readFallbackPlaybackIds();

  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  let authHeader = null;
  if (MUX_TOKEN_ID && MUX_TOKEN_SECRET) {
    authHeader =
      "Basic " + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64");
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return "—";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}h ${mins.toString().padStart(2, "0")}m`;
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  }

  try {
    if (!authHeader) {
      if (fallbackPlaybackIds.length) {
        res.setHeader("Cache-Control", "public, max-age=120");
        return res.status(200).json(buildFallbackResponse(fallbackPlaybackIds));
      }
      return res
        .status(500)
        .json({ error: "Mux API credentials missing and no fallback playback IDs configured" });
    }

    const params = new URLSearchParams({
      limit: "50",
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
      .filter(asset => asset?.status === "ready")
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
        playback_url: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
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

    const filteredResponse = response.filter(item => item.playback_id);

    if (filteredResponse.length === 0 && fallbackPlaybackIds.length) {
      res.setHeader("Cache-Control", "public, max-age=120");
      return res.status(200).json(buildFallbackResponse(fallbackPlaybackIds));
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json(filteredResponse);
  } catch (error) {
    console.error("Mux API Error:", error);
    if (fallbackPlaybackIds.length) {
      res.setHeader("Cache-Control", "public, max-age=120");
      return res.status(200).json(buildFallbackResponse(fallbackPlaybackIds));
    }

    res
      .status(500)
      .json({ error: "Failed to fetch Mux assets", details: error.message || "Unknown error" });
  }
}
