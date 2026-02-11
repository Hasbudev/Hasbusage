// =======================================================
// ICON SCAN (teambuilder-friendly) via sliding window
// =======================================================

async function loadIconHashes() {
  if (ICON_HASHES) return ICON_HASHES;

  const res = await fetch("/icon-hashes.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Impossible de charger icon-hashes.json (${res.status})`);

  ICON_HASHES = await res.json();
  ICON_HASH_KEYS = Object.entries(ICON_HASHES).map(([k, hex]) => [k, BigInt("0x" + hex)]);
  return ICON_HASHES;
}

function hamming64(a, b) {
  let x = a ^ b;
  let c = 0;
  while (x) { x &= (x - 1n); c++; }
  return c;
}

// dHash directement depuis une région du canvas source, sans recrop lourd
function dHashFromRegion(srcCtx, sx, sy, sw, sh) {
  const tmp = document.createElement("canvas");
  tmp.width = 9;
  tmp.height = 8;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });

  // mini-resize de la région candidate en 9x8
  tctx.drawImage(srcCtx.canvas, sx, sy, sw, sh, 0, 0, 9, 8);

  const { data } = tctx.getImageData(0, 0, 9, 8);

  const lum = new Array(9 * 8);
  for (let i = 0; i < lum.length; i++) {
    const r = data[i * 4 + 0];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    lum[i] = r * 0.299 + g * 0.587 + b * 0.114;
  }

  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = lum[y * 9 + x];
      const right = lum[y * 9 + x + 1];
      const v = left < right ? 1n : 0n;
      hash |= (v << bit);
      bit++;
    }
  }
  return hash;
}

// Dédup: si deux detections sont proches, on garde la meilleure (dist plus faible)
function dedupeDetections(dets, radius = 26) {
  dets.sort((a, b) => a.dist - b.dist);

  const kept = [];
  for (const d of dets) {
    const tooClose = kept.some(k => {
      const dx = (k.cx - d.cx);
      const dy = (k.cy - d.cy);
      return (dx * dx + dy * dy) < (radius * radius);
    });
    if (!tooClose) kept.push(d);
  }
  return kept;
}

/**
 * Scan l’image pour trouver des icônes (teambuilder/replay/header).
 * Retourne un tableau de 6 keys (ou moins si pas assez sûr).
 */
async function scanIconsInImage(img, opts = {}) {
  await loadIconHashes();

  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;

  // On downscale pour accélérer (et garder ratios corrects)
  const targetW = opts.targetW ?? 900;
  const scale = Math.min(1, targetW / W);
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  // Taille icône du sheet showdown ≈ 40x30
  // Mais selon UI/zoom, ça varie → on teste 2-3 échelles
  const sizes = opts.sizes ?? [
    { iw: 40, ih: 30 },
    { iw: 32, ih: 24 },
    { iw: 48, ih: 36 },
  ];

  const step = opts.step ?? 6;           // plus petit => plus précis mais plus lent
  const maxDist = opts.maxDist ?? 12;    // seuil de confiance (à ajuster)
  const maxChecksPerSize = opts.maxChecksPerSize ?? 25000;

  const detections = [];

  for (const { iw, ih } of sizes) {
    let checks = 0;

    for (let y = 0; y <= h - ih; y += step) {
      for (let x = 0; x <= w - iw; x += step) {
        checks++;
        if (checks > maxChecksPerSize) break;

        // dHash de la région candidate
        const dh = dHashFromRegion(ctx, x, y, iw, ih);

        // match rapide: cherche meilleur dist
        let bestName = null;
        let bestDist = 999;

        for (const [name, refHash] of ICON_HASH_KEYS) {
          const d = hamming64(dh, refHash);
          if (d < bestDist) {
            bestDist = d;
            bestName = name;
            if (bestDist === 0) break;
          }
        }

        if (bestName && bestDist <= maxDist) {
          detections.push({
            name: bestName,
            dist: bestDist,
            x, y,
            cx: x + iw / 2,
            cy: y + ih / 2,
            iw, ih
          });
        }
      }
      if (checks > maxChecksPerSize) break;
    }
  }

  if (!detections.length) return [];

  // Déduplique les matches proches (même icône détectée plusieurs fois)
  const deduped = dedupeDetections(detections, 28);

  // Heuristique: souvent les 6 icônes sont sur une même ligne (ou 2 lignes)
  // On tente de regrouper par "bande" de Y
  deduped.sort((a, b) => a.cy - b.cy);

  const bands = [];
  for (const d of deduped) {
    let placed = false;
    for (const band of bands) {
      if (Math.abs(band.cy - d.cy) < 25) { // tolérance verticale
        band.items.push(d);
        band.cy = (band.cy * (band.items.length - 1) + d.cy) / band.items.length;
        placed = true;
        break;
      }
    }
    if (!placed) bands.push({ cy: d.cy, items: [d] });
  }

  // Prend la bande avec le plus d’items (souvent la rangée d’icônes)
  bands.sort((a, b) => b.items.length - a.items.length);
  const bestBand = bands[0]?.items ?? deduped;

  // Dans la bande, tri gauche->droite, puis prends 6 meilleurs (dist)
  // On mixe: priorise left->right mais on évite de garder un truc trop incertain
  bestBand.sort((a, b) => a.x - b.x);

  // Si > 6, on garde les 6 qui font le meilleur compromis:
  // 1) dist faible, 2) position gauche->droite
  // Simple: on garde d’abord les 8 plus à gauche, puis on prend les 6 plus sûres.
  const leftCandidates = bestBand.slice(0, 10);
  leftCandidates.sort((a, b) => a.dist - b.dist);

  const picked = [];
  for (const d of leftCandidates) {
    if (picked.length >= 6) break;
    // évite doublons de même nom
    if (picked.some(p => p.name === d.name)) continue;
    picked.push(d);
  }

  // si encore < 6, complète avec le reste
  if (picked.length < 6) {
    const rest = bestBand.slice(0, 20).sort((a, b) => a.dist - b.dist);
    for (const d of rest) {
      if (picked.length >= 6) break;
      if (picked.some(p => p.name === d.name)) continue;
      picked.push(d);
    }
  }

  // renvoie juste les keys
  picked.sort((a, b) => a.x - b.x);
  return picked.map(p => p.name);
}
