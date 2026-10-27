// Serves the Linyra UI Map (dev/ui-map/index.html): every part of the panel, named, so the
// maintainer and Claude use the same words. Dev-only; nothing here ships in the VSIX.
//
//   npm run ui-map            → http://localhost:5179/
//   PORT=5200 npm run ui-map
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const page = join(dirname(fileURLToPath(import.meta.url)), "index.html");
const port = Number(process.env.PORT) || 5179;

createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404).end("Not found");
    return;
  }
  // Read on every request: an edit to index.html shows on the next reload.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(await readFile(page));
}).listen(port, "127.0.0.1", () => console.log(`Linyra UI Map: http://localhost:${port}/`));
