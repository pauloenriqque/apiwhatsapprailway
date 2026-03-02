"use strict";

const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client, LocalAuth } = require('whatsapp-web.js');

let qrcode = null;
try { qrcode = require('qrcode-terminal'); } catch (_) {
  // opcional: instale com `npm i qrcode-terminal` para ver QR no terminal
}

const PORT = process.env.PORT || 8000;

/** Resolve o caminho do executável do Chrome.
 * Prioridades:
 * 1) PUPPETEER_EXECUTABLE_PATH (env)
 * 2) Chrome baixado no cache do Puppeteer (mais recente)
 * 3) Chrome do sistema (Windows)
 */
function resolveChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // Tenta achar no cache do Puppeteer (Windows)
  try {
    const cacheRoot = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(cacheRoot)) {
      const entries = fs.readdirSync(cacheRoot).filter((d) => d.startsWith('win64-'));
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // mais novo primeiro
      for (const dir of entries) {
        const candidate = path.join(cacheRoot, dir, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (_) {}

  // Caminho padrão do Chrome no Windows
  const systemChrome = 'C\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe';
  if (fs.existsSync(systemChrome)) return systemChrome;

  return null; // não encontrado
}

const executablePath = resolveChromeExecutable();
console.log('[Chrome]', executablePath ? `usando: ${executablePath}` : 'não encontrado automaticamente. Defina PUPPETEER_EXECUTABLE_PATH ou rode: npx puppeteer browsers install chrome');

// Estado do cliente
let isReady = false;
let lastState = null;
let lastAuthAt = null;

// Bootstrap único do WhatsApp Web JS
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'BOT-ZDG' }),
  puppeteer: {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(executablePath ? { executablePath } : {}),
  },
});

client.once('qr', (qr) => {
  console.log('QR RECEIVED');
  if (qrcode) qrcode.generate(qr, { small: true }); else console.log(qr);
});

client.once('authenticated', () => {
  lastAuthAt = new Date();
  console.log('₢ BOT-ZDG Autenticado');
});

client.once('ready', async () => {
  isReady = true;
  console.log('₢ BOT-ZDG Dispositivo pronto');
  try {
    lastState = await client.getState();
    console.log('getState() após ready:', lastState);
  } catch (_) {}
});

client.on('auth_failure', (m) => console.error('[auth_failure]', m));
client.on('disconnected', (reason) => {
  isReady = false;
  console.warn('[disconnected]', reason);
});

client.initialize();

// ----------------- Express App -----------------
const app = express();

// Log simples de requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} [${req.method}] ${req.url}`);
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.type('text/plain; charset=utf-8').send(`App running on *:${PORT}\nBOT-ZDG: ${isReady ? 'ready' : 'initializing'}\n`);
});

app.get('/status', async (req, res) => {
  let state = null;
  try { state = await client.getState(); } catch (_) {}
  res.json({ ok: true, isReady, state, authenticatedAt: lastAuthAt, chromeExec: executablePath || null });
});

// ================== PATCH SOLICITADO ==================
// Rota de envio de mensagem AGORA é: POST /send-message
// Parâmetros no corpo: { numero: '5511999999999' | '5511999999999@c.us' | '1203...@g.us', message: 'texto' }
app.post('/send-message', async (req, res) => {
  try {
    const { numero, message } = req.body || {};
    if (!numero || !message) {
      return res.status(400).json({ ok: false, error: 'Parâmetros obrigatórios: numero, message' });
    }

    let chatId = String(numero).trim();

    // Caso seja grupo, deve terminar com @g.us
    const isGroup = chatId.endsWith('@g.us');

    if (!isGroup) {
      // Se já vier como contato com @c.us, usamos direto
      if (chatId.endsWith('@c.us')) {
        // ok
      } else {
        // Limpa para dígitos e valida E.164 (DDI+DDD+número)
        const digits = chatId.replace(/\D/g, '');
        if (!/^[1-9]\d{9,14}$/.test(digits)) {
          return res.status(400).json({
            ok: false,
            error: 'Formato inválido de numero. Envie em E.164: ex. 5511999999999 (DDI+DDD+número).'
          });
        }
        // Resolve para JID com getNumberId (evita "No LID for user")
        const wid = await client.getNumberId(digits);
        if (!wid || !wid._serialized) {
          return res.status(404).json({ ok: false, error: 'Número não encontrado no WhatsApp (getNumberId retornou vazio).' });
        }
        chatId = wid._serialized; // ex.: 5511999999999@c.us
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
// ======================================================

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

const server = http.createServer(app);
server.listen(PORT, () => console.log(`App running on *: ${PORT}`));

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log('Servidor HTTP fechado.'));
  try { client.destroy(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
