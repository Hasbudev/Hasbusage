// scripts/make-icon-hashes.mjs
import fs from "fs";
import path from "path";
import sharp from "sharp";

const OUT_PATH = path.resolve("public/icon-hashes.json");

// Args:
// 1 = client repo (icons + indexes)
// 2 = server repo (pokedex)
const CLIENT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve("pokemon-showdown-client");

const SERVER_DIR = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve("pokemon-showdown");

// Icon sheet layout
const ICON_W = 40;
const ICON_H = 30;

const URL_SHEET =
  "https://play.pokemonshowdown.com/sprites/pokemonicons-sheet.png";

// --------------------------------------------------

function log(...a) {
  console.log(...a);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function walkFiles(dir, exts, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const e of entries) {
    const p = path.join(dir, e.name);

    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walkFiles(p, exts, out);
    } else {
      if (exts.has(path.extname(e.name).toLowerCase())) {
        out.push(p);
      }
    }
  }

  return out;
}

// --------------------------------------------------
// ICON INDEX (CLIENT)
// --------------------------------------------------

function extractIconIndexTableFromText(text) {
  const idx = text.indexOf("BattlePokemonIconIndexes");
  if (idx < 0) return null;

  const eq = text.indexOf("=", idx);
  const braceStart = text.indexOf("{", eq);
  if (eq < 0 || braceStart < 0) return null;

  let depth = 0;
  let end = -1;

  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < 0) return null;

  const obj = text.slice(braceStart, end + 1);
  return new Function(`"use strict";return(${obj});`)();
}

function findIconIndexTable(clientDir) {
  const files = walkFiles(
    clientDir,
    new Set([".js", ".ts", ".mjs", ".cjs"])
  );

  log(`Recherche BattlePokemonIconIndexes dans ${files.length} fichiers (client)...`);

  for (const f of files) {
    const txt = fs.readFileSync(f, "utf8");

    if (!txt.includes("BattlePokemonIconIndexes")) continue;

    const table = extractIconIndexTableFromText(txt);

    if (table) {
      log("✅ Index icons trouvé:", f);
      return table;
    }
  }

  throw new Error("BattlePokemonIconIndexes introuvable (client).");
}

// --------------------------------------------------
// POKEDEX (SERVER)
// --------------------------------------------------

function findPokedexTs(serverDir) {
  const p = path.join(serverDir, "data", "pokedex.ts");
  if (exists(p)) return p;

  const files = walkFiles(serverDir, new Set([".ts"]));

  return files.find(f =>
    f.replaceAll("\\", "/").endsWith("/data/pokedex.ts")
  );
}

function extractPokedexNums(text) {
  // Trouver "export const Pokedex" ou "export const Pokedex ="
  const decl =
    text.match(/\bexport\s+const\s+Pokedex\b/) ||
    text.match(/\bconst\s+Pokedex\b/);

  if (!decl || decl.index == null) throw new Error("Déclaration Pokedex introuvable");

  // Extraire le gros objet { ... }
  const start = decl.index;
  const eq = text.indexOf("=", start);
  const brace = text.indexOf("{", eq);
  if (eq < 0 || brace < 0) throw new Error("Syntaxe Pokedex inattendue");

  let depth = 0;
  let end = -1;
  for (let i = brace; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error("Objet Pokedex non fermé");

  const block = text.slice(brace + 1, end); // contenu interne, sans { }

  // Parse top-level entries: key: { ... }
  // On scanne caractère par caractère et on récupère les couples (key, objectText)
  const out = {};
  let i = 0;

  function skipWs() {
    while (i < block.length && /\s|,/.test(block[i])) i++;
  }

  function readKey() {
    skipWs();
    if (i >= block.length) return null;

    // key peut être "foo" ou 'foo' ou foo
    let key = "";
    const ch = block[i];

    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      const startKey = i;
      while (i < block.length && block[i] !== q) i++;
      key = block.slice(startKey, i);
      i++; // skip quote
    } else {
      const startKey = i;
      while (i < block.length && /[a-z0-9-]/i.test(block[i])) i++;
      key = block.slice(startKey, i);
    }

    skipWs();
    if (block[i] !== ":") return null;
    i++; // skip ':'
    return key.trim().toLowerCase();
  }

  function readObjectText() {
    skipWs();
    if (block[i] !== "{") return null;
    const objStart = i;
    let d = 0;
    while (i < block.length) {
      const ch = block[i];
      if (ch === "{") d++;
      else if (ch === "}") {
        d--;
        if (d === 0) {
          i++; // include closing }
          return block.slice(objStart, i);
        }
      }
      i++;
    }
    return null;
  }

  while (i < block.length) {
    const key = readKey();
    if (!key) { i++; continue; }

    const objText = readObjectText();
    if (!objText) { i++; continue; }

    // IMPORTANT: extraire num au niveau de l'entrée (pas dans un sous-objet)
    // On prend le premier "num: N" trouvé
    const m = objText.match(/\bnum\s*:\s*(\d+)/);
    if (m) {
      const num = Number(m[1]);
      if (Number.isFinite(num) && num > 0) out[key] = num;
    }

    skipWs();
  }

  return out;
}


// --------------------------------------------------
// ICON SHEET
// --------------------------------------------------

function findLocalSheet(clientDir) {
  const candidates = [
    path.join(clientDir, "sprites", "pokemonicons-sheet.png"),
    path.join(clientDir, "play.pokemonshowdown.com", "sprites", "pokemonicons-sheet.png"),
    path.join(clientDir, "dist", "sprites", "pokemonicons-sheet.png"),
  ];

  for (const c of candidates) {
    if (exists(c)) return c;
  }

  const pngs = walkFiles(clientDir, new Set([".png"]));

  return pngs.find(p =>
    p.endsWith(path.join("sprites", "pokemonicons-sheet.png"))
  );
}

// --------------------------------------------------
// HASH
// --------------------------------------------------

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function dHash(buf) {
  const { data, info } = await sharp(buf)
    .resize(9, 8)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lum = [];

  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    lum[i] = r * 0.299 + g * 0.587 + b * 0.114;
  }

  let h = 0n;
  let bit = 0n;

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = lum[y * 9 + x];
      const b = lum[y * 9 + x + 1];
      if (a < b) h |= 1n << bit;
      bit++;
    }
  }

  let hex = h.toString(16);
  while (hex.length < 16) hex = "0" + hex;

  return hex;
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  log("Client:", CLIENT_DIR);
  log("Server:", SERVER_DIR);

  // Icon index (client)
  const iconIndex = findIconIndexTable(CLIENT_DIR);

  // Pokedex (server)
  const dexFile = findPokedexTs(SERVER_DIR);
  if (!dexFile) throw new Error("data/pokedex.ts not found (server)");

  log("✅ pokedex:", dexFile);

  const dexText = fs.readFileSync(dexFile, "utf8");
  const pokedex = extractPokedexNums(dexText);

  log("✅ dex entries:", Object.keys(pokedex).length);

  // Sheet
  let sheetBuf;

  const local = findLocalSheet(CLIENT_DIR);

  if (local) {
    log("✅ sheet:", local);
    sheetBuf = fs.readFileSync(local);
  } else {
    log("⬇️ download sheet");
    sheetBuf = await fetchBuffer(URL_SHEET);
  }

  const meta = await sharp(sheetBuf).metadata();

  const cols = Math.floor(meta.width / ICON_W);

  log(`Sheet: ${meta.width}x${meta.height} cols=${cols}`);

  const out = {};
  let ok = 0;

for (const [id, num] of Object.entries(pokedex)) {
  if (!Number.isFinite(num) || num <= 0) continue;

  const rawIconNum =
    (typeof iconIndex[id] === "number") ? iconIndex[id] : (num - 1);

  const iconNum = Math.floor(rawIconNum);
  if (!Number.isFinite(iconNum) || iconNum < 0) continue;

  const x = (iconNum % cols) * ICON_W;
  const y = Math.floor(iconNum / cols) * ICON_H;

    if (x + ICON_W > meta.width || y + ICON_H > meta.height) continue;

    const buf = await sharp(sheetBuf)
      .extract({ left: x, top: y, width: ICON_W, height: ICON_H })
      .png()
      .toBuffer();

    out[id] = await dHash(buf);
    ok++;

    if (ok % 500 === 0) log("Progress:", ok);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  log("✅ Done:", ok, "hashes");
  log("➡️", OUT_PATH);
}

main().catch(e => {
  console.error("❌", e);
  process.exit(1);
});
