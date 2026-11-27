
const MANIFEST = {
  id: "bitchord-internet-archive-flac",
  name: "Layz Add On",
  version: "1.6.0",
  resources: ["search", "stream"],
  settings: [{
    key: "quality",
    type: "select",
    default: "lossless",
    options: [
      { label: "Lossless", value: "lossless" },
      { label: "High", value: "high" },
      { label: "Low", value: "low" }
    ]
  }]
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isInteger(n) ? Math.trunc(n) : n;
}

function first(data, ...keys) {
  for (const key of keys) {
    if (data[key] !== null && data[key] !== undefined && data[key] !== "") {
      return data[key];
    }
  }
  return null;
}

function qualityLabel(sr, bd) {
  const details = [];
  if (bd !== null) details.push(`${bd}-bit`);
  if (sr !== null) details.push(`${sr / 1000} kHz`);
  const hi = (bd !== null && bd > 16) || (sr !== null && sr > 48000);
  return (hi ? "Hi-Res Lossless" : "Lossless") +
    (details.length ? " · " + details.join(" / ") : "");
}

async function inspect(identifier, item) {
  const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(item.name)}`;

  let sr = num(first(item, "sample_rate", "samplerate", "sampleRate"));
  let bd = num(first(item, "bit_depth", "bitdepth", "bitDepth"));

  if (sr === null || bd === null) {
    try {
      const response = await fetch(url, {
        headers: { Range: "bytes=0-63" }
      });
      if (response.ok || response.status === 206) {
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length >= 26 &&
            String.fromCharCode(...data.slice(0, 4)) === "fLaC") {
          const blockType = data[4] & 0x7f;
          const blockLength = (data[5] << 16) | (data[6] << 8) | data[7];

          if (blockType === 0 && blockLength >= 34) {
            let packed = 0n;
            for (let i = 18; i < 26; i++) {
              packed = (packed << 8n) | BigInt(data[i]);
            }
            const detectedSr = Number(packed >> 44n);
            const detectedBd = Number((packed >> 36n) & 31n) + 1;

            if (detectedSr >= 1000 && detectedSr <= 768000) sr ??= detectedSr;
            if (detectedBd >= 4 && detectedBd <= 32) bd ??= detectedBd;
          }
        }
      }
    } catch {}
  }

  return {
    url,
    filename: item.name,
    size: num(item.size),
    length: num(item.length),
    bitrate: num(first(item, "bitrate", "bit_rate", "bitRate")),
    sampleRate: sr,
    bitDepth: bd,
    quality: "LOSSLESS"
  };
}

async function getFlac(identifier) {
  const response = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`
  );
  if (!response.ok) throw new Error("Internet Archive metadata error");

  const data = await response.json();
  const candidates = (data.files || [])
    .filter(f => String(f.name || "").toLowerCase().endsWith(".flac"))
    .sort((a, b) => (num(b.size) || 0) - (num(a.size) || 0))
    .slice(0, 3);

  if (!candidates.length) return null;

  const inspected = [];
  for (const item of candidates) {
    try {
      inspected.push(await inspect(identifier, item));
    } catch {}
  }

  inspected.sort((a, b) =>
    Number((b.bitDepth || 0) > 16) - Number((a.bitDepth || 0) > 16) ||
    (b.bitDepth || 0) - (a.bitDepth || 0) ||
    (b.sampleRate || 0) - (a.sampleRate || 0) ||
    (b.size || 0) - (a.size || 0)
  );

  return inspected[0] || null;
}

function makeTrack(doc, flac) {
  const creator = doc.creator;
  return {
    id: String(doc.identifier),
    title: String(doc.title || flac.filename),
    artist: Array.isArray(creator)
      ? String(creator[0] || "Internet Archive")
      : String(creator || "Internet Archive"),
    album: String(doc.album || ""),
    duration: flac.length,
    artworkURL: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
    format: "flac",
    audioQuality: "LOSSLESS",
    quality: qualityLabel(flac.sampleRate, flac.bitDepth),
    sampleRate: flac.sampleRate,
    bitDepth: flac.bitDepth,
    bitrate: flac.bitrate,
    streamURL: flac.url
  };
}

async function search(url) {
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) return json({ tracks: [] });

  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "8", 10) || 8, 1), 8);

  const params = new URLSearchParams();
  params.set("q", `(mediatype:audio) AND (${query})`);
  ["identifier", "title", "creator", "album", "year"].forEach(
    field => params.append("fl[]", field)
  );
  params.set("rows", String(Math.min(limit * 3, 24)));
  params.set("page", "1");
  params.set("output", "json");

  try {
    const response = await fetch(
      `https://archive.org/advancedsearch.php?${params}`
    );
    if (!response.ok) throw new Error("Internet Archive search error");

    const result = await response.json();
    const docs = result.response?.docs || [];
    const tracks = [];

    for (const doc of docs) {
      if (!doc.identifier) continue;
      try {
        const flac = await getFlac(String(doc.identifier));
        if (flac) tracks.push(makeTrack(doc, flac));
      } catch {}

      if (tracks.length >= limit) break;
    }

    return json({ tracks });
  } catch (error) {
    return json({ tracks: [], error: String(error) }, 502);
  }
}

async function stream(identifier) {
  identifier = (identifier || "").trim();
  if (!identifier) return json({ error: "missing id" }, 400);

  try {
    const flac = await getFlac(identifier);
    if (!flac) {
      return json({ error: "No FLAC file found for this item" }, 404);
    }

    return json({
      url: flac.url,
      format: "flac",
      quality: qualityLabel(flac.sampleRate, flac.bitDepth),
      audioQuality: "LOSSLESS",
      codec: "flac",
      container: "flac",
      manifest: "none",
      encrypted: false,
      sampleRate: flac.sampleRate,
      bitDepth: flac.bitDepth,
      bitrate: flac.bitrate,
      audioMode: "stereo"
    });
  } catch (error) {
    return json({ error: String(error) }, 502);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      });
    }

    if (path === "/" || path === "/manifest.json") {
      return json(MANIFEST);
    }

    if (path === "/health") {
      return json({
        ok: true,
        name: MANIFEST.name,
        version: MANIFEST.version
      });
    }

    if (path === "/search") {
      return search(url);
    }

    if (path === "/stream") {
      return stream(url.searchParams.get("id"));
    }

    if (path.startsWith("/stream/")) {
      return stream(decodeURIComponent(path.slice(8)));
    }

    return json({ error: "Not found" }, 404);
  }
};
