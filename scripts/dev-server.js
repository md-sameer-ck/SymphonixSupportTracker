// scripts/dev-server.js
//
// A dependency-free local server for trying the site out before it's
// deployed — serves site/ as static files and routes /api/* to the same
// Netlify Function handlers used in production (netlify/functions/*.js),
// faking just enough of the Lambda-style event/response shape that they
// don't need to know they're not running on Netlify.
//
// This is a convenience for local testing only. For anything closer to the
// real Netlify runtime (redirects, headers, etc.) use `netlify dev` from
// the Netlify CLI instead — this script exists so you don't have to install
// that CLI just to click through the UI.
//
//   ADMIN_PASSCODE=test123 node scripts/dev-server.js
//   -> open http://localhost:8888

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 8888;
const SITE_DIR = path.join(__dirname, "..", "site");
const FUNCTIONS_DIR = path.join(__dirname, "..", "netlify", "functions");

if (!process.env.ADMIN_PASSCODE) {
  process.env.ADMIN_PASSCODE = "dev-passcode";
  console.log("ADMIN_PASSCODE not set — defaulting to 'dev-passcode' for this local run.");
}

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

function serveStatic(req, res, pathname) {
  let filePath = path.join(SITE_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(SITE_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function handleApi(req, res, functionName, parsedUrl) {
  const modulePath = path.join(FUNCTIONS_DIR, `${functionName}.js`);
  if (!fs.existsSync(modulePath)) { res.writeHead(404); return res.end(JSON.stringify({ error: "No such function" })); }

  delete require.cache[require.resolve(modulePath)];
  const fn = require(modulePath);
  const body = await readBody(req);

  const event = {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: parsedUrl.query || {},
    body,
  };

  try {
    const result = await fn.handler(event);
    res.writeHead(result.statusCode, result.headers || { "Content-Type": "application/json" });
    res.end(result.body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname.startsWith("/api/")) {
    const functionName = parsedUrl.pathname.replace("/api/", "");
    return handleApi(req, res, functionName, parsedUrl);
  }
  return serveStatic(req, res, parsedUrl.pathname);
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
  console.log(`Admin passcode for this session: ${process.env.ADMIN_PASSCODE}`);
});
