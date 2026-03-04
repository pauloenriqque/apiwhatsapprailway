"use strict";
const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');

let qrcodeTerm = null;
try { qrcodeTerm = require('qrcode-terminal'); } catch (_) {
  // opcional: instale com `npm i qrcode-terminal` para ver QR no terminal
}

const PORT = process.env.PORT || 8000;
const CLIENT_ID = process.env.WWEBJS_CLIENT_ID || 'BOT-ZDG';

// Resolve o executável do Chrome seguindo esta ordem:
// 1) PUPPETEER_EXECUTABLE_PATH (env)
// 2) Cache de runtime do Render: /opt/render/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome
// 3) Cache persistido do build no Render: /opt/render/project/src/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome
// 4) Cache local do Puppeteer (~/.cache/puppeteer/chrome)
// 5) Chrome do Windows (uso local)
function resolveChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    console.log('[Chrome] via env PUPPETEER_EXECUTABLE_PATH');
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [];

  // Cache de runtime do Render
  (function scanRenderRuntimeCache() {
    const root = '/opt/render/.cache/puppeteer/chrome';
    if (fs.existsSync(root)) {
      const entries = fs.readdirSync(root).filter(d => d.startsWith('linux-'));
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const dir of entries) {
        candidates.push(path.join(root, dir, 'chrome-linux64', 'chrome'));
      }
    }
  })();

  // Cache persistido do build no Render
  (function scanRenderBuildCache() {
    const root = '/opt/render/project/src/.cache/puppeteer/chrome';
    if (fs.existsSync(root)) {
      const entries = fs.readdirSync(root).filter(d => d.startsWith('linux-'));
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const dir of entries) {
        candidates.push(path.join(root, dir, 'chrome-linux64', 'chrome'));
      }
    }
  })();

  // Cache local do Puppeteer no HOME
  (function scanHomeCache() {
    try {
      const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
      if (fs.existsSync(root)) {
        const entries = fs.readdirSync(root).filter(d => d.startsWith('linux-') || d.startsWith('win64-'));
        entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const dir of entries) {
          candidates.push(path.join(root, dir, 'chrome-linux64', 'chrome'));
          candidates.push(path.join(root, dir, 'chrome-win64', 'chrome.exe'));
        }
      }
    } catch {}
  })();

  // Chrome do Windows (fallback local)
  candidates.push('C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe');

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log('[Chrome] detectado em:', c);
      return c;
    }
  }

  console.warn('[Chrome] nenhum executável encontrado nos diretórios esperados.');
  return null;
}

const executablePath = resolveChromeExecutable();
console.log('[Chrome]', executablePath ? `usando: ${executablePath}` : 'não encontrado automaticamente. Defina PUPPETEER_EXECUTABLE_PATH ou rode: npx puppeteer browsers install chrome');

// ----------------- Express + HTTP + Socket.IO -----------------
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server); // usa a v2.x conforme package.json

// Servir index.html e assets estáticos da pasta atual
app.use(express.static(path.join(__dirname)));

// Log simples de requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} [${req.method}] ${req.url}`);
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Página principal -> index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Estado para /status e logs
let isReady = false;
let lastState = null;
let lastAuthAt = null;

// client será criado após conectar ao Mongo
let client = null;
let mongoStore = null;

app.get('/status', async (req, res) => {
  let state = null;
  try { state = client ? await client.getState() : null; } catch (_) {}
  res.json({
    ok: true,
    isReady,
    state,
    authenticatedAt: lastAuthAt,
    chromeExec: executablePath || null,
    remoteAuth: !!mongoStore,
    clientId: CLIENT_ID
  });
});

// Diagnóstico: lista coleções do Mongo
app.get('/_diag/collections', async (req, res) => {
  try {
    const cols = await mongoose.connection.db.listCollections().toArray();
    res.json({ ok: true, collections: cols.map(c => c.name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: verifica documento da sessão (coleção típica: auth_sessions)
app.get('/_diag/remote', async (req, res) => {
  try {
    const col = mongoose.connection.db.collection('auth_sessions');
    const doc = await col.findOne({ session: CLIENT_ID });
    res.json({ ok: true, found: !!doc, docExists: !!doc });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Rota de envio de mensagem
app.post('/send-message', async (req, res) => {
  try {
    if (!client) return res.status(503).json({ ok: false, error: 'Cliente ainda não inicializado' });

    const { numero, message } = req.body || {};
    if (!numero || !message) {
      return res.status(400).json({ ok: false, error: 'Parâmetros obrigatórios: numero, message' });
    }
    let chatId = String(numero).trim();
    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup) {
      if (!chatId.endsWith('@c.us')) {
        const digits = chatId.replace(/\D/g, '');
        if (!/^[1-9]\d{9,14}$/.test(digits)) {
          return res.status(400).json({
            ok: false,
            error: 'Formato inválido de numero. Envie em E.164: ex. 5511999999999 (DDI+DDD+número).'
          });
        }
        const wid = await client.getNumberId(digits);
        if (!wid || !wid._serialized) {
          return res.status(404).json({ ok: false, error: 'Número não encontrado no WhatsApp (getNumberId retornou vazio).' });
        }
        chatId = wid._serialized;
      }
    }
    const result = await client.sendMessage(chatId, message);
    return res.json({ ok: true, id: result?.id?._serialized || result?.id?.id || null, to: chatId });
  } catch (e) {
    if ((e?.message || '').includes('No LID for user')) {
      return res.status(400).json({ ok: false, error: 'No LID for user: verifique o número (DDI+DDD) e se o contato tem WhatsApp.' });
    }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Rota de upload — middleware SOMENTE aqui
app.post('/upload', fileUpload({ createParentPath: true, limits: { fileSize: 20 * 1024 * 1024 }, abortOnLimit: true }), async (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).send('Nenhum arquivo recebido');
  const myFile = req.files.file; // campo "file"
  const saveDir = path.join(process.cwd(), 'uploads');
  fs.mkdirSync(saveDir, { recursive: true });
  const dest = path.join(saveDir, myFile.name);
  try {
    await myFile.mv(dest);
    res.json({ ok: true, saved: dest });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

server.listen(PORT, () => console.log(`App running on *:${PORT}`));

// ----------------- Inicialização com RemoteAuth + MongoDB -----------------
(async () => {
  try {
    if (!process.env.MONGODB_URI) {
      console.error('[MongoDB] defina a variável de ambiente MONGODB_URI');
      process.exit(1);
    }

    console.log('[MongoDB] conectando...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[MongoDB] conectado!');

    mongoStore = new MongoStore({ mongoose });

    client = new Client({
      authStrategy: new RemoteAuth({
        store: mongoStore,
        clientId: CLIENT_ID,
        backupSyncIntervalMs: 60000 // salva a sessão a cada 60s (mínimo recomendado)
      }),
      puppeteer: {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disk-cache-size=104857600'],
        ...(executablePath ? { executablePath } : {}),
      },
    });

    function logToUi(msg) {
      try { io.emit('message', msg); } catch (_) {}
    }

    client.on('qr', (qr) => {
      const QRCode = require('qrcode');
      QRCode.toDataURL(qr, { margin: 2, scale: 6 }, (err, url) => {
        if (!err && url) {
          io.emit('qr', url);
          logToUi('QR code gerado. Escaneie com o WhatsApp.');
        } else {
          logToUi('Falha ao gerar imagem do QR. Veja o terminal.');
        }
      });
      console.log('QR RECEIVED');
      if (qrcodeTerm) qrcodeTerm.generate(qr, { small: true }); else console.log(qr);
    });

    client.on('authenticated', () => {
      lastAuthAt = new Date();
      io.emit('authenticated', { at: lastAuthAt });
      logToUi('✓ BOT-ZDG autenticado (RemoteAuth).');
    });

    client.on('ready', async () => {
      isReady = true;
      io.emit('ready');
      logToUi('✓ Dispositivo pronto.');
      try {
        lastState = await client.getState();
        logToUi(`Estado: ${lastState}`);
      } catch (_) {}
    });

    // confirma que a sessão foi salva no Mongo
    client.on('remote_session_saved', () => {
      try { io.emit('message', '✓ Sessão salva no Mongo (RemoteAuth).'); } catch (_) {}
      console.log('[RemoteAuth] sessão salva no Mongo.');
    });

    client.on('auth_failure', (m) => {
      logToUi(`[auth_failure] ${m}`);
    });

    client.on('disconnected', (reason) => {
      isReady = false;
      io.emit('message', `[disconnected] ${reason}`);
    });

    await client.initialize();
  } catch (err) {
    console.error('[Bootstrap] Falha ao inicializar:', err);
    process.exit(1);
  }
})();

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log('Servidor HTTP fechado.'));
  try { client?.destroy(); } catch (_) {}
  try { mongoose.connection?.close?.(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
