const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3010);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const cleanUrl = (req.url || "/").split("?")[0];
  let relPath = cleanUrl === "/" ? "/index.html" : cleanUrl;
  relPath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, relPath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackErr, html) => {
          if (fallbackErr) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        });
      } else {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Pianissimo Tournées local server running at http://127.0.0.1:${PORT}`);
});
