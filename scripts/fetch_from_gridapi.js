// 最小のダミー: latest.json を作るだけ
import fs from "fs/promises";

const outDir = "public/data";
await fs.mkdir(outDir, { recursive: true });
const out = {
  ts: new Date(Date.now() + 9*3600*1000).toISOString().replace("Z","+09:00"),
  lines: []   // ここに本番は取得した行を入れる
};
await fs.writeFile(`${outDir}/latest.json`, JSON.stringify(out, null, 2), "utf8");
console.log("wrote", `${outDir}/latest.json`);
