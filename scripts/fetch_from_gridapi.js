// scripts/fetch_from_gridapi.js
// grid-api(=OCCTO由来CSV) を取得 → line_map.json で正規IDに写像 → public/data/latest.json を生成
import fs from "fs/promises";
import Papa from "papaparse";

// === 設定 ===
const AREAS = [1,2,3,4,5,6,7,8,9,10];  // 北海道..沖縄（grid-apiのエリア番号）
const BASE  = "https://powerflowmap.shikiblog.link/api/chinaiKikanJisseki.php";
const MAP_JSON = "mappings/line_map.json";           // さっき作った辞書
const OUT_LATEST = "public/data/latest.json";
const OUT_HOURLY = () => {
  const d = new Date(Date.now() + 9*3600*1000);      // JST
  return "public/data/" + d.toISOString().slice(0,13).replace(/[-:T]/g,"") + ".json";
};

// === 共通ユーティリティ ===
const J = (ms=Date.now()) => new Date(ms + 9*3600*1000); // JST
const yyyymmdd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const num = x => { const n = Number(String(x??"").replace(/[, ]/g,"")); return isFinite(n)?n:0; };

async function loadMap(){
  try {
    const j = JSON.parse(await fs.readFile(MAP_JSON,"utf8"));
    return j.map || {};
  } catch {
    console.warn("[warn] mappings/line_map.json が見つかりません。外部名をそのまま使用します。");
    return {};
  }
}
// external(=CSVの送電線名) を canonical(=正規ID)に
function toCanonical(mapObj, area, external){
  const key = `${area}::${external}`;
  return mapObj[key]?.canonical || external; // 見つからない時は外部名のまま（後で検証で拾う）
}

// 列名のゆらぎに耐えるフィールド検出
function pickField(row){
  const keys = Object.keys(row).map(k=>[k,k.toLowerCase()]);
  const find = (...cands) => keys.find(([orig,low]) => cands.some(c => low.includes(c)))?.[0];
  return {
    area: find("対象エリア","area"),
    id:   find("送電線名","設備","line","name","id"),
    p:    find("潮流","p(mw)","p_mw","mw","power"),
    cap:  find("運用容量","容量","capacity"),
    t:    find("時刻","time","timestamp","時分")
  };
}

async function fetchCsv(area, dateStr){
  const url = `${BASE}?area=${area}&date=${dateStr}`;
  const res = await fetch(url, { headers: { "Cache-Control":"no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} area=${area}`);
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

async function main(){
  const today = yyyymmdd(J());
  const mapObj = await loadMap();
  const lastByCanonical = new Map(); // canonical -> {lineId, p_mw, capacity_mw, util, dir, timeKey}

  for (const a of AREAS){
    try{
      const rows = await fetchCsv(a, today);
      if (!rows.length) continue;
      const f = pickField(rows[0]);

      for (const r of rows){
        const ext = String(r[f.id] ?? "").trim();           // 外部名（送電線名）
        if (!ext) continue;
        const areaTxt = r[f.area] ?? a;                      // CSV側のエリア名 or 番号
        const canonical = toCanonical(mapObj, areaTxt, ext); // 正規IDへ

        const p_mw = num(r[f.p]);                            // MW
        const dir  = p_mw >= 0 ? 1 : -1;                     // 方向（符号から）
        // capacity: CSVにあれば使う。無ければ mapping 側に将来追加してもOK。
        const capacity_mw = f.cap ? num(r[f.cap]) : (mapObj[`${areaTxt}::${ext}`]?.capacity_mw ?? 0);

        // util: capacity が分かるときは |P|/capacity。無ければ 0 にしておく（見栄え用に後段で補完可）。
        const util = capacity_mw > 0 ? Math.abs(p_mw)/capacity_mw : 0;

        const timeKey = f.t ? String(r[f.t]).trim() : "";    // 最新時刻コマの判定に使用

        // 同じ canonical の中で「最も新しい時刻」を採用
        const prev = lastByCanonical.get(canonical);
        if (!prev || prev.timeKey <= timeKey) {
          lastByCanonical.set(canonical, { lineId: canonical, p_mw, capacity_mw, util: +util.toFixed(3), dir, timeKey });
        }
      }
    }catch(e){
      console.warn("[warn]", e.message);
    }
  }

  // util が 0 の行（=容量が不明）に対しては、p95 を使った見栄え用スケールを暫定適用
  const arr = Array.from(lastByCanonical.values());
  const absP = arr.map(x => Math.abs(x.p_mw)).filter(n => isFinite(n));
  absP.sort((a,b)=>a-b);
  const p95 = absP.length ? absP[Math.floor(absP.length*0.95)] : 1;
  for (const r of arr){
    if (r.util === 0 && p95 > 0) {
      r.util = Math.min(Math.abs(r.p_mw)/p95, 1.2); // 1超は赤で表示
      r.util = +r.util.toFixed(3);
    }
    delete r.timeKey;
  }

  const out = { ts: J().toISOString().replace("Z","+09:00"), lines: arr };
  await fs.mkdir("public/data", { recursive:true });
  await fs.writeFile(OUT_LATEST, JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile(OUT_HOURLY(), JSON.stringify(out, null, 2), "utf8"); // 履歴も残す

  console.log("latest.json updated:", arr.length, "lines");
}

main().catch(e => { console.error(e); process.exit(1); });
