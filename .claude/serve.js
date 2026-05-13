#!/usr/bin/env node
/* Minimal static file server for preview. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(ROOT, url);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }

    fs.stat(filePath, (err, stats) => {
      if (err) { res.writeHead(404); res.end('404: ' + url); return; }
      if (stats.isDirectory()) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (err2, data) => {
        if (err2) { res.writeHead(404); res.end('404'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });
  } catch (e) {
    res.writeHead(500); res.end('500: ' + e.message);
  }
});

server.listen(PORT, () => console.log(`SkylineSound dev server on http://localhost:${PORT}/`));
