import { db, doc, getDoc, setDoc, deleteDoc, serverTimestamp, collection, getDocs } from "./firebase.js";

const $ = (id) => document.getElementById(id);

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

let frenchNameMap = null;
let currentSort = { key: "usage", dir: "desc" };
let statsCache = [];

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function showdownToKey(name) {
  // Convert Showdown display -> keys like "great-tusk", "mr-mime", "farfetchd"
  return name
    .toLowerCase()
    .replace(/\./g, "")       // Mr. Mime -> mr mime
    .replace(/'/g, "")        // Farfetch'd -> farfetchd
    .replace(/:/g, "")        // Type: Null -> type null
    .replace(/♀/g, "-f")      // Nidoran♀ -> nidoran-f
    .replace(/♂/g, "-m")      // Nidoran♂ -> nidoran-m
    .trim()
    .replace(/\s+/g, "-");    // Great Tusk -> great-tusk
}

async function loadFrenchPokemonNames() {
  if (frenchNameMap) return frenchNameMap;

  setStatus("Chargement des noms français…");
  const res = await fetch("./pokemon-fr.json", { cache: "no-store" });

  if (!res.ok) {
    throw new Error(`Impossible de charger pokemon-fr.json (${res.status})`);
  }

  frenchNameMap = await res.json();
  setStatus("Noms français chargés ✅");
  return frenchNameMap;
}

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

  return map[key] || s; // fallback to original if missing
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

  if (!res.ok) {
    throw new Error(`Échec de récupération du replay JSON (${res.status})`);
  }

  return await res.json();
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

  if (snap.exists()) {
    return { already: true };
  }

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

async function importReplay() {
  const replayId = normalizeReplayId(replayUrlEl?.value);
  if (!replayId) {
    setStatus("Collez une URL de replay valide (ou un id).");
    return;
  }

  importBtn.disabled = true;
  setStatus(`Récupération de ${replayId}…`);

  try {
    // Ensure FR map loaded early (better UX)
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

    // 1) Supprime l'agrégat
    await deleteDoc(doc(db, "stats", "aggregate"));

    // 2) Supprime tous les replays importés
    const snap = await getDocs(collection(db, "replays"));
    const deletions = [];
    snap.forEach(d => deletions.push(deleteDoc(doc(db, "replays", d.id))));
    await Promise.all(deletions);

    setStatus("Réinitialisation terminée ✅");
    await loadAggregate();
  } catch (e) {
    console.error(e);
    setStatus(`Erreur : ${e.message}`);
  } finally {
    resetBtn.disabled = false;
  }
}


// Sorting
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

// Events
importBtn?.addEventListener("click", importReplay);
importExampleBtn?.addEventListener("click", () => {
  replayUrlEl.value = "https://replay.pokemonshowdown.com/gen9ubers-2497048368";
});
refreshBtn?.addEventListener("click", loadAggregate);
resetBtn?.addEventListener("click", resetStats);
searchEl?.addEventListener("input", () => renderTable(statsCache));

// Initial
setStatus("Chargement des statistiques…");
loadAggregate().then(() => setStatus("Prêt."));
