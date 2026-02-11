import asyncio
import json
import re
from pathlib import Path

import aiohttp
from tqdm import tqdm

POKEAPI = "https://pokeapi.co/api/v2"
OUT = Path("public/pokemon-fr.json")

def pick_fr_name(names):
    """names: list of {language:{name}, name}"""
    for n in names:
        if n.get("language", {}).get("name") == "fr":
            return n.get("name")
    return None

async def fetch_json(session: aiohttp.ClientSession, url: str):
    async with session.get(url) as r:
        r.raise_for_status()
        return await r.json()

async def fetch_list(session, endpoint: str, limit: int = 100000):
    data = await fetch_json(session, f"{POKEAPI}/{endpoint}?limit={limit}")
    return data["results"]

async def worker(name, session, queue, out_map, pbar):
    while True:
        item = await queue.get()
        if item is None:
            queue.task_done()
            return
        key, url, kind = item
        try:
            data = await fetch_json(session, url)
            fr = pick_fr_name(data.get("names", []))

            # Some endpoints don't have French name; skip those
            if fr:
                out_map[key] = fr

        except Exception:
            # ignore individual failures (rare)
            pass
        finally:
            pbar.update(1)
            queue.task_done()

def normalize_key(s: str) -> str:
    # Keep PokeAPI identifiers as-is, but ensure consistent
    return s.strip().lower()

async def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)

    connector = aiohttp.TCPConnector(limit=40)
    timeout = aiohttp.ClientTimeout(total=60)

    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        # 1) Base species names (covers "groudon", "pikachu", etc.)
        species_list = await fetch_list(session, "pokemon-species")

        # 2) Form names (covers "-therian", "-wash", "-crowned", "-wellspring", etc.)
        form_list = await fetch_list(session, "pokemon-form")

        # Build queue of fetch tasks
        tasks = []
        queue = asyncio.Queue()

        out_map = {}

        total = len(species_list) + len(form_list)
        with tqdm(total=total, desc="Fetching FR names") as pbar:
            # Put all jobs
            for it in species_list:
                key = normalize_key(it["name"])
                await queue.put((key, it["url"], "species"))

            for it in form_list:
                key = normalize_key(it["name"])
                await queue.put((key, it["url"], "form"))

            # Start workers
            workers = [
                asyncio.create_task(worker(f"w{i}", session, queue, out_map, pbar))
                for i in range(40)
            ]

            # Stop signals
            for _ in workers:
                await queue.put(None)

            await queue.join()
            for w in workers:
                await w

        # Some very common Showdown identifiers vs display differences:
        # (mostly covered already, but these help if you normalize Showdown names)
        out_map.setdefault("mr-mime", "M. Mime")
        out_map.setdefault("mime-jr", "Mime Jr.")
        out_map.setdefault("type-null", "Type:0")

        # Write output
        OUT.write_text(json.dumps(out_map, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ Wrote {OUT} with {len(out_map)} entries")

if __name__ == "__main__":
    asyncio.run(main())
