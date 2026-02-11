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

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}
function setTeamStatus(msg) {
  if (teamStatusEl) teamStatusEl.textContent = msg;
}

// --- Normalisation / keys
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

// --- Load FR map (OPTIONNEL)
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

// --- Build index FR/EN loose -> FR display
async function buildNameIndex() {
  if (nameIndex) return nameIndex;

  const map = await loadFrenchPokemonNames();
  const idx = new Map();

  // Base: toutes les entrées du json (clé -> fr)
  for (const [key, fr] of Object.entries(map)) {
    if (fr) idx.set(normalizeNameLoose(fr), fr);

    // Permet de coller l'EN sous forme "great tusk" (depuis la clé)
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
    "simia**braz": "Simiabraz", // exemple: retire si inutile
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

// --- Paste parser (Showdown/PokéPaste)
function parseSpeciesFromPaste(text) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/);
  const species = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines[0].startsWith("===")) continue;

    let first = lines[0];

    // Nickname (Species) @ Item -> take inside parentheses if present
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

// --- Manual input parser: either 6 lines OR showdown paste
function parseManualTeamInput(text) {
  const t = String(text || "").replace(/\r/g, "").trim();
  if (!t) return [];

  // Heuristique: si ça ressemble à un paste Showdown, on parse en blocs
  const looksLikeShowdown = t.includes("@") || t.includes("Ability:") || t.includes("EVs:") || t.includes("- ");
  if (looksLikeShowdown) return parseSpeciesFromPaste(t);

  // Sinon: une ligne = un pokémon
  const lines = t.split("\n").map(x => x.trim()).filter(Boolean);
  return lines.slice(0, 6);
}

// --- Translate a list (best effort)
async function bestEffortToFrench(nameList) {
  const map = await loadFrenchPokemonNames();
  const idx = await buildNameIndex();

  const recognized = [];
  const unknown = [];

  for (const raw of nameList) {
    const rawLoose = normalizeNameLoose(raw);

    // 1) Try index (FR loose & key-derived)
    const hit = idx.get(rawLoose);
    if (hit) { recognized.push(hit); continue; }

    // 2) Try showdownToKey -> map
    const key1 = showdownToKey(raw);
    if (map[key1]) { recognized.push(map[key1]); continue; }

    // 3) Try looseToKey -> map
    const key2 = looseToKey(raw);
    if (map[key2]) { recognized.push(map[key2]); continue; }

    // fallback
    unknown.push(raw);
  }

  return { recognized, unknown };
}

// --- Replay helpers
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

  // Remove ", M" / ", F" etc.
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

// --- Aggregates
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

// --- Table
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

// --- Actions
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

// --- Sorting
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

// --- Events
importBtn?.addEventListener("click", importReplay);
importExampleBtn?.addEventListener("click", () => {
  if (replayUrlEl) replayUrlEl.value = "https://replay.pokemonshowdown.com/gen9ubers-2497048368";
});
refreshBtn?.addEventListener("click", loadAggregate);
resetBtn?.addEventListener("click", resetStats);
searchEl?.addEventListener("input", () => renderTable(statsCache));
importTeamBtn?.addEventListener("click", importTeamFromText);

// --- Initial
setStatus("Chargement des statistiques…");
loadAggregate().then(() => setStatus("Prêt."));
