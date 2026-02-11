import {
  db, doc, getDoc, setDoc, deleteDoc,
  serverTimestamp, collection, getDocs, addDoc
} from "./firebase.js";

const $ = (id) => document.getElementById(id);

// --- DOM
const replayUrlEl = $("replayUrl");
const importBtn = $("importBtn");
const importExampleBtn = $("importExampleBtn");
const refreshBtn = $("refreshBtn");
const resetBtn = $("resetBtn");
const statusEl = $("status");
const searchEl = $("search");
const statsBody = $("statsBody");
const totalsPill = $("totalsPill");
const statsTable = $("statsTable");

const teamTextEl = $("teamText");
const teamResultEl = $("teamResult");
const importTeamBtn = $("importTeamBtn");
const teamStatusEl = $("teamStatus");

// --- STATE
let frenchNameMap = null;      // { pokeapiKey: "Nom FR" }
let nameIndex = null;          // Map normalizeLoose -> "Nom FR"
let currentSort = { key: "usage", dir: "desc" };
let statsCache = [];

// --- ICON HASHES STATE
let ICON_HASHES = null;     // { key: "hex64" }
let ICON_HASH_KEYS = null;  // Array<[key, BigInt]>

// =======================================================
// UI helpers
// =======================================================
function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}
function setTeamStatus(msg) {
  if (teamStatusEl) teamStatusEl.textContent = msg;
}

// =======================================================
// Normalisation / keys
// =======================================================
function showdownToKey(name) {
  // Convert Showdown display -> keys like "great-tusk", "mr-mime", "farfetchd"
  return String(name || "")
    .toLowerCase()
    .replace(/\./g, "")       // Mr. Mime -> mr mime
    .replace(/'/g, "")        // Farfetch'd -> farfetchd
    .replace(/:/g, "")        // Type: Null -> type null
    .replace(/♀/g, "-f")      // Nidoran♀ -> nidoran-f
    .replace(/♂/g, "-m")      // Nidoran♂ -> nidoran-m
    .trim()
    .replace(/\s+/g, "-");    // Great Tusk -> great-tusk
}

function normalizeNameLoose(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // enlève accents
    .replace(/[^a-z0-9]+/g, " ")       // garde lettres/chiffres
    .trim()
    .replace(/\s+/g, " ");
}

function looseToKey(s) {
  const base = normalizeNameLoose(s)
    .replace(/\bmr\b/g, "mr")
    .replace(/\btype 0\b/g, "type null");
  return base.replace(/\s+/g, "-");
}

// =======================================================
// Load FR map (optionnel)
// =======================================================
async function loadFrenchPokemonNames() {
  if (frenchNameMap) return frenchNameMap;

  try {
    const res = await fetch("/pokemon-fr.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    frenchNameMap = await res.json();
    return frenchNameMap;
  } catch (e) {
    console.warn("pokemon-fr.json non dispo (fallback).", e);
    frenchNameMap = {}; // fallback vide
    return frenchNameMap;
  }
}

// Build index FR/EN loose -> FR display
async function buildNameIndex() {
  if (nameIndex) return nameIndex;

  const map = await loadFrenchPokemonNames();
  const idx = new Map();

  for (const [key, fr] of Object.entries(map)) {
    if (fr) idx.set(normalizeNameLoose(fr), fr);

    // Permet "great tusk" depuis la key "great-tusk"
    const spacedKey = String(key).replace(/-/g, " ");
    idx.set(normalizeNameLoose(spacedKey), fr);
  }

  // Alias/typos FR fréquents (tu peux en ajouter)
  const aliases = {
    "dracaufeu": "Dracaufeu",
    "lokhlass": "Lokhlass",
    "pingoleon": "Pingoléon",
    "pingoléon": "Pingoléon",
    "roitiflam": "Roitiflam",
    "miascarade": "Miascarade",
    "simiabraz": "Simiabraz",
    "demeteros": "Démétéros",
    "demétéros": "Démétéros",
    "electhor": "Électhor",
    "électhor": "Électhor",
    "farfurex": "Farfurex"
  };

  for (const [k, v] of Object.entries(aliases)) {
    idx.set(normalizeNameLoose(k), v);
  }

  nameIndex = idx;
  return idx;
}

// =======================================================
// Team parsers (paste showdown / 6 lignes)
// =======================================================
function parseSpeciesFromPaste(text) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/);
  const species = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines[0].startsWith("===")) continue;

    let first = lines[0];

    // Nickname (Species) @ Item -> inside parentheses
    const paren = first.match(/\(([^)]+)\)/);
    if (paren) first = paren[1];

    // Remove @ item
    first = first.split("@")[0].trim();

    // Remove trailing gender markers sometimes in text
    first = first.replace(/\s+\((m|f)\)\s*$/i, "").trim();

    // "Pokémon: X" style
    const colon = first.match(/(?:species|pokemon|pokémon)\s*[:\-]\s*(.+)/i);
    if (colon) first = colon[1].trim();

    if (first) species.push(first);
  }

  return species.slice(0, 6);
}

function parseManualTeamInput(text) {
  const t = String(text || "").replace(/\r/g, "").trim();
  if (!t) return [];

  const looksLikeShowdown =
    t.includes("@") || t.includes("Ability:") || t.includes("EVs:") || t.includes("- ");

  if (looksLikeShowdown) return parseSpeciesFromPaste(t);

  const lines = t.split("\n").map(x => x.trim()).filter(Boolean);
  return lines.slice(0, 6);
}

async function bestEffortToFrench(nameList) {
  const map = await loadFrenchPokemonNames();
  const idx = await buildNameIndex();

  const recognized = [];
  const unknown = [];

  for (const raw of nameList) {
    const rawLoose = normalizeNameLoose(raw);

    // 1) Index (FR loose & key-derived)
    const hit = idx.get(rawLoose);
    if (hit) { recognized.push(hit); continue; }

    // 2) showdownToKey -> map
    const key1 = showdownToKey(raw);
    if (map[key1]) { recognized.push(map[key1]); continue; }

    // 3) looseToKey -> map
    const key2 = looseToKey(raw);
    if (map[key2]) { recognized.push(map[key2]); continue; }

    unknown.push(raw);
  }

  return { recognized, unknown };
}

// =======================================================
// Replay helpers
// =======================================================
function normalizeReplayId(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;

  const m = trimmed.match(/replay\.pokemonshowdown\.com\/([a-z0-9-]+)/i);
  if (m) return m[1];

  if (/^[a-z0-9-]+$/i.test(trimmed)) return trimmed;

  return null;
}

function toJsonUrl(replayId) {
  return `https://replay.pokemonshowdown.com/${replayId}.json`;
}

async function extractSpecies(pokeField) {
  let s = (pokeField || "").trim();
  if (!s) return "";

  if (s.includes(",")) s = s.split(",")[0].trim();

  const map = await loadFrenchPokemonNames();
  const key = showdownToKey(s);
  return map[key] || s;
}

async function parseReplayLog(logText) {
  const p1Mons = new Set();
  const p2Mons = new Set();
  let p1Name = null;
  let p2Name = null;
  let winnerName = null;
  let format = null;

  const lines = (logText || "").split("\n");

  for (const line of lines) {
    if (line.startsWith("|player|p1|")) {
      const parts = line.split("|");
      p1Name = parts[3] ?? p1Name;
    }
    if (line.startsWith("|player|p2|")) {
      const parts = line.split("|");
      p2Name = parts[3] ?? p2Name;
    }
    if (line.startsWith("|tier|")) {
      const parts = line.split("|");
      format = parts[2] ?? null;
    }
    if (line.startsWith("|poke|p1|")) {
      const parts = line.split("|");
      const species = await extractSpecies(parts[3] ?? "");
      if (species) p1Mons.add(species);
    }
    if (line.startsWith("|poke|p2|")) {
      const parts = line.split("|");
      const species = await extractSpecies(parts[3] ?? "");
      if (species) p2Mons.add(species);
    }
    if (line.startsWith("|win|")) {
      const parts = line.split("|");
      winnerName = parts[2] ?? null;
    }
  }

  let winnerSide = null;
  if (winnerName && p1Name && winnerName === p1Name) winnerSide = "p1";
  if (winnerName && p2Name && winnerName === p2Name) winnerSide = "p2";

  return {
    format,
    p1Name,
    p2Name,
    p1Team: Array.from(p1Mons),
    p2Team: Array.from(p2Mons),
    winnerName,
    winnerSide,
  };
}

async function fetchReplayJson(replayId) {
  const url = toJsonUrl(replayId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Échec de récupération du replay JSON (${res.status})`);
  return await res.json();
}

// =======================================================
// Aggregates + storage
// =======================================================
async function upsertAggregatesFromTeam(teamMons, result) {
  const aggRef = doc(db, "stats", "aggregate");
  const snap = await getDoc(aggRef);

  const agg = snap.exists() ? snap.data() : { mons: {}, updatedAt: null };
  const mons = agg.mons || {};

  const ensure = (name) => {
    if (!mons[name]) mons[name] = { usage: 0, wins: 0, losses: 0 };
    return mons[name];
  };

  for (const m of teamMons) {
    if (!m) continue;
    ensure(m).usage += 1;
    if (result === "win") ensure(m).wins += 1;
    if (result === "loss") ensure(m).losses += 1;
  }

  await setDoc(aggRef, { mons, updatedAt: serverTimestamp() }, { merge: true });
}

async function storeTeamImport(teamMonsFR, teamMonsRaw, result) {
  const colRef = collection(db, "teamImports");
  await addDoc(colRef, {
    teamFR: teamMonsFR,
    teamRaw: teamMonsRaw,
    result,
    importedAt: serverTimestamp()
  });
}

async function upsertAggregatesFromReplay(parsed) {
  const aggRef = doc(db, "stats", "aggregate");
  const snap = await getDoc(aggRef);

  const agg = snap.exists() ? snap.data() : { mons: {}, updatedAt: null };
  const mons = agg.mons || {};

  const ensure = (name) => {
    if (!mons[name]) mons[name] = { usage: 0, wins: 0, losses: 0 };
    return mons[name];
  };

  for (const m of parsed.p1Team) ensure(m).usage += 1;
  for (const m of parsed.p2Team) ensure(m).usage += 1;

  if (parsed.winnerSide === "p1") {
    for (const m of parsed.p1Team) ensure(m).wins += 1;
    for (const m of parsed.p2Team) ensure(m).losses += 1;
  } else if (parsed.winnerSide === "p2") {
    for (const m of parsed.p2Team) ensure(m).wins += 1;
    for (const m of parsed.p1Team) ensure(m).losses += 1;
  }

  await setDoc(aggRef, { mons, updatedAt: serverTimestamp() }, { merge: true });
}

async function storeReplay(replayId, replayMeta, parsed) {
  const replayRef = doc(db, "replays", replayId);
  const snap = await getDoc(replayRef);

  if (snap.exists()) return { already: true };

  await setDoc(replayRef, {
    replayId,
    format: parsed.format || replayMeta.format || null,
    p1Name: parsed.p1Name || null,
    p2Name: parsed.p2Name || null,
    p1Team: parsed.p1Team,
    p2Team: parsed.p2Team,
    winnerName: parsed.winnerName || null,
    importedAt: serverTimestamp(),
    url: `https://replay.pokemonshowdown.com/${replayId}`
  });

  return { already: false };
}

// =======================================================
// Table render
// =======================================================
function computeRows(monsObj) {
  return Object.entries(monsObj || {}).map(([name, s]) => {
    const usage = s.usage || 0;
    const wins = s.wins || 0;
    const losses = s.losses || 0;
    const totalWL = wins + losses;
    const winrate = totalWL > 0 ? (wins / totalWL) * 100 : null;
    return { name, usage, wins, losses, winrate };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function renderTable(rows) {
  const q = (searchEl?.value || "").trim().toLowerCase();
  let filtered = q
    ? rows.filter(r => r.name.toLowerCase().includes(q))
    : rows.slice();

  filtered.sort((a, b) => {
    const { key, dir } = currentSort;
    const mul = dir === "asc" ? 1 : -1;

    if (key === "name") return a.name.localeCompare(b.name) * mul;

    const av = a[key];
    const bv = b[key];

    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    return (av - bv) * mul;
  });

  if (totalsPill) totalsPill.textContent = `${filtered.length} Pokémon`;
  if (!statsBody) return;

  statsBody.innerHTML = filtered.map(r => {
    const wr = r.winrate == null ? "—" : `${r.winrate.toFixed(1)}%`;
    const wrClass = r.winrate == null ? "" : (r.winrate >= 50 ? "good" : "bad");
    return `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${r.usage}</td>
        <td class="num">${r.wins}</td>
        <td class="num">${r.losses}</td>
        <td class="num ${wrClass}">${wr}</td>
      </tr>
    `;
  }).join("");
}

async function loadAggregate() {
  const aggRef = doc(db, "stats", "aggregate");
  const snap = await getDoc(aggRef);
  const data = snap.exists() ? snap.data() : { mons: {} };
  statsCache = computeRows(data.mons || {});
  renderTable(statsCache);
}

// =======================================================
// Actions
// =======================================================
async function importTeamFromText() {
  const txt = (teamTextEl?.value || "").trim();
  if (!txt) {
    setTeamStatus("Colle une team d’abord.");
    return;
  }

  importTeamBtn?.setAttribute("disabled", "true");
  setTeamStatus("Analyse…");

  try {
    const raw = parseManualTeamInput(txt);
    if (!raw.length) throw new Error("Aucun Pokémon détecté.");

    const { recognized, unknown } = await bestEffortToFrench(raw);
    if (recognized.length === 0) {
      throw new Error("Aucun Pokémon reconnu. Vérifie l’orthographe.");
    }

    const result = teamResultEl?.value || "neutral";

    await storeTeamImport(recognized, raw, result);
    await upsertAggregatesFromTeam(recognized, result);

    setTeamStatus(
      unknown.length
        ? `✅ Importé: ${recognized.length}. ⚠️ Non reconnus: ${unknown.join(", ")}`
        : `✅ Importé: ${recognized.length} Pokémon`
    );

    await loadAggregate();
  } catch (e) {
    console.error(e);
    setTeamStatus(`Erreur : ${e.message}`);
  } finally {
    importTeamBtn?.removeAttribute("disabled");
  }
}

async function importReplay() {
  const replayId = normalizeReplayId(replayUrlEl?.value);
  if (!replayId) {
    setStatus("Collez une URL de replay valide (ou un id).");
    return;
  }

  importBtn.disabled = true;
  setStatus(`Récupération de ${replayId}…`);

  try {
    await loadFrenchPokemonNames();

    const replayJson = await fetchReplayJson(replayId);
    if (!replayJson.log) throw new Error("Le replay JSON ne contient pas de log.");

    const parsed = await parseReplayLog(replayJson.log);

    const stored = await storeReplay(replayId, replayJson, parsed);
    if (stored.already) {
      setStatus("Replay déjà importé. Actualisation des stats…");
    } else {
      setStatus("Replay importé. Mise à jour des stats…");
      await upsertAggregatesFromReplay(parsed);
      setStatus("Terminé ✅");
    }

    await loadAggregate();
  } catch (e) {
    console.error(e);
    setStatus(`Erreur : ${e.message}`);
  } finally {
    importBtn.disabled = false;
  }
}

async function resetStats() {
  resetBtn.disabled = true;
  try {
    setStatus("Réinitialisation en cours…");

    await deleteDoc(doc(db, "stats", "aggregate"));

    const snap = await getDocs(collection(db, "replays"));
    const deletions = [];
    snap.forEach(d => deletions.push(deleteDoc(doc(db, "replays", d.id))));
    await Promise.all(deletions);

    const snapTeams = await getDocs(collection(db, "teamImports"));
    const deletionsTeams = [];
    snapTeams.forEach(d => deletionsTeams.push(deleteDoc(doc(db, "teamImports", d.id))));
    await Promise.all(deletionsTeams);

    // Reset caches too
    nameIndex = null;
    frenchNameMap = null;

    setStatus("Réinitialisation terminée ✅");
    await loadAggregate();
    setTeamStatus("");
  } catch (e) {
    console.error(e);
    setStatus(`Erreur : ${e.message}`);
  } finally {
    resetBtn.disabled = false;
  }
}

// =======================================================
// ICON SCAN (teambuilder-friendly) via sliding window
// =======================================================

async function loadIconHashes() {
  if (ICON_HASHES) return ICON_HASHES;

  const candidates = [
    "./icon-hashes.json",        // même dossier que index.html (Live Server)
    "/icon-hashes.json",         // racine
    "./public/icon-hashes.json", // si tu as un dossier public
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      ICON_HASHES = await res.json();
      ICON_HASH_KEYS = Object.entries(ICON_HASHES).map(([k, hex]) => [k, BigInt("0x" + hex)]);
      console.log(`[icon-hashes] loaded ${ICON_HASH_KEYS.length} hashes from ${url}`);
      return ICON_HASHES;
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`Impossible de charger icon-hashes.json (${lastErr?.message || "unknown error"})`);
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
// Remplace ENTIÈREMENT ta fonction scanIconsInImage par celle-ci
async function scanIconsInImage(img, opts = {}) {
  await loadIconHashes();

  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;

  // Downscale pour vitesse
  const targetW = opts.targetW ?? 1000;
  const scale = Math.min(1, targetW / W);
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  // ---- Paramètres "header 6 icons" (Showdown)
  const iconW = Math.round((opts.iconW ?? 40) * scale);
  const iconH = Math.round((opts.iconH ?? 30) * scale);
  const gap = Math.round((opts.gap ?? 6) * scale);          // espace entre icônes (approx)
  const padX = Math.round((opts.padX ?? 6) * scale);        // padding gauche/droite du bandeau
  const maxDist = opts.maxDist ?? 14;

  // Zone de recherche verticale (haut de l'image)
  const yMin = Math.max(0, Math.round((opts.yMinFrac ?? 0.00) * h));
  const yMax = Math.min(h - iconH - 1, Math.round((opts.yMaxFrac ?? 0.25) * h));

  // Largeur approximative d'une rangée de 6 icônes
  const rowW = padX * 2 + (iconW * 6) + (gap * 5);

  // On balaye plusieurs X possibles (parce que selon le screen, la rangée n'est pas toujours centrée pareil)
  // et plusieurs Y pour trouver la "meilleure" rangée.
  const xCandidates = [];
  const x0 = Math.max(0, Math.round((w - rowW) / 2));
  xCandidates.push(x0);
  xCandidates.push(Math.max(0, x0 - Math.round(40 * scale)));
  xCandidates.push(Math.max(0, x0 + Math.round(40 * scale)));
  xCandidates.push(0);
  xCandidates.push(Math.max(0, w - rowW));

  // Pas vertical (plus petit = plus précis)
  const yStep = opts.yStep ?? Math.max(2, Math.round(2 * scale));

  // Score: somme des meilleurs dists sur les 6 icônes (plus petit = meilleur)
  function bestMatchNameAndDist(hash) {
    let bestName = null;
    let bestDist = 999;
    for (const [name, refHash] of ICON_HASH_KEYS) {
      const d = hamming64(hash, refHash);
      if (d < bestDist) {
        bestDist = d;
        bestName = name;
        if (bestDist === 0) break;
      }
    }
    return { bestName, bestDist };
  }

  let best = null;

  for (let y = yMin; y <= yMax; y += yStep) {
    for (const xBase0 of xCandidates) {
      let xBase = Math.min(Math.max(0, xBase0), Math.max(0, w - rowW));

      // calcule un score pour cette rangée (6 cases)
      const matches = [];
      let total = 0;
      let okCount = 0;

      for (let i = 0; i < 6; i++) {
        const sx = xBase + padX + i * (iconW + gap);
        const sy = y;

        if (sx < 0 || sy < 0 || sx + iconW > w || sy + iconH > h) {
          matches.push({ name: null, dist: 999 });
          total += 999;
          continue;
        }

        const dh = dHashFromRegion(ctx, sx, sy, iconW, iconH);
        const { bestName, bestDist } = bestMatchNameAndDist(dh);

        matches.push({ name: bestName, dist: bestDist });
        total += bestDist;
        if (bestDist <= maxDist) okCount++;
      }

      // On exige au moins 5/6 "ok" pour éviter les faux positifs
      const minOk = opts.minOk ?? 5;
      if (okCount < minOk) continue;

      if (!best || total < best.total) {
        best = { xBase, y, total, okCount, matches, iconW, iconH, gap, padX };
      }
    }
  }

  if (!best) return [];

  // On retourne les 6 noms si dist assez ok (sinon [])
  const out = [];
  for (const m of best.matches) {
    if (!m.name || m.dist > maxDist) return [];
    out.push(m.name);
  }

  return out;
}



function showdownIdToPokeapiKey(id) {
  const s = String(id || "").toLowerCase();

  // formes régionales (très fréquent)
  const regional = [
    ["hisui", "-hisui"],
    ["alola", "-alola"],
    ["galar", "-galar"],
    ["paldea", "-paldea"],
  ];
  for (const [suffix, rep] of regional) {
    if (s.endsWith(suffix) && !s.includes("-")) {
      return s.slice(0, -suffix.length) + rep;
    }
  }

  // Pikachu costumes
  if (s.startsWith("pikachu") && s !== "pikachu" && !s.includes("-")) {
    return "pikachu-" + s.slice("pikachu".length);
  }

  // Paradox mons (Showdown les écrit sans tiret)
  const paradox = {
    greattusk: "great-tusk",
    screamtail: "scream-tail",
    brutebonnet: "brute-bonnet",
    fluttermane: "flutter-mane",
    slitherwing: "slither-wing",
    sandyshocks: "sandy-shocks",
    irontreads: "iron-treads",
    ironbundle: "iron-bundle",
    ironhands: "iron-hands",
    ironjugulis: "iron-jugulis",
    ironmoth: "iron-moth",
    ironthorns: "iron-thorns",
    roaringmoon: "roaring-moon",
    ironvaliant: "iron-valiant",
    walkingwake: "walking-wake",
    ironleaves: "iron-leaves",
    gougingfire: "gouging-fire",
    ragingbolt: "raging-bolt",
    ironboulder: "iron-boulder",
    ironcrown: "iron-crown",
  };
  if (paradox[s]) return paradox[s];

  return s; // fallback
}


teamTextEl?.addEventListener("paste", async (e) => {
  try {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imgItem = Array.from(items).find(it => it.type && it.type.startsWith("image/"));
    if (!imgItem) return; // texte normal => laisser faire

    e.preventDefault();

    const file = imgItem.getAsFile();
    if (!file) return;

    setTeamStatus("Analyse de l’image (scan icônes)…");

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    URL.revokeObjectURL(url);

    const names = await scanIconsInImage(img, {
  targetW: 1100,
  yMaxFrac: 0.22,   // icônes dans le haut
  maxDist: 14,
  minOk: 6,         // on veut 6/6 ok sinon on refuse
  iconW: 40,
  iconH: 30,
  gap: 6,
  padX: 6,
});




    if (names.length < 6) {
      setTeamStatus("⚠️ Je n’ai pas réussi à reconnaître 6 icônes. Essaie un screen plus zoomé / plus net (ou recadré sur la rangée d’icônes).");
      return;
    }

    // On met les keys dans le textarea (ton pipeline bestEffortToFrench gère derrière)
    teamTextEl.value = names.map(showdownIdToPokeapiKey).join("\n");
    setTeamStatus("Icônes reconnues ✅ Clique “Importer la team”.");
  } catch (err) {
    console.error(err);
    setTeamStatus(`Erreur import image : ${err.message}`);
  }
});


// =======================================================
// Sorting
// =======================================================
if (statsTable) {
  statsTable.querySelectorAll("thead th").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (!key) return;

      if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentSort.key = key;
        currentSort.dir = (key === "name") ? "asc" : "desc";
      }
      renderTable(statsCache);
    });
  });
}

// =======================================================
// Events
// =======================================================
importBtn?.addEventListener("click", importReplay);
importExampleBtn?.addEventListener("click", () => {
  if (replayUrlEl) replayUrlEl.value = "https://replay.pokemonshowdown.com/gen9ubers-2497048368";
});
refreshBtn?.addEventListener("click", loadAggregate);
resetBtn?.addEventListener("click", resetStats);
searchEl?.addEventListener("input", () => renderTable(statsCache));
importTeamBtn?.addEventListener("click", importTeamFromText);

// =======================================================
// Initial
// =======================================================
setStatus("Chargement des statistiques…");
loadAggregate().then(() => setStatus("Prêt."));
