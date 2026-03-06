"use strict";
require('dotenv').config();

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
let qrcodeTerm = null; try { qrcodeTerm = require('qrcode-terminal'); } catch {}

const CLIENT_ID = process.env.WWEBJS_CLIENT_ID || 'BOT-ZDG';

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('Defina MONGODB_URI no .env');
    process.exit(1);
  }

  console.log('[MongoDB] conectando...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[MongoDB] conectado!');

  const store = new MongoStore({ mongoose });

  const client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: CLIENT_ID,
      backupSyncIntervalMs: 60000 // salva a sessão ~1 min após autenticar
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    console.log('QR RECEIVED (local)');
    if (qrcodeTerm) qrcodeTerm.generate(qr, { small: true });
    const url = await QRCode.toDataURL(qr);
    console.log('(DataURL opcional p/ viewer):', url.slice(0, 80) + '...');
  });

  client.on('authenticated', () => {
    console.log('✓ Autenticado (local).');
  });

  client.on('ready', () => {
    console.log('✓ Ready (local). Aguardando salvar sessão no Mongo...');
  });

  client.on('remote_session_saved', async () => {
    console.log('✓ Sessão salva no Mongo (RemoteAuth). Encerrando o pareamento local.');
    try { await mongoose.connection.close(); } catch {}
    process.exit(0);
  });

  client.on('auth_failure', (m) => console.error('[auth_failure]', m));
  client.on('disconnected', (r) => console.warn('[disconnected]', r));

  await client.initialize();
})();
