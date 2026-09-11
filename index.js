import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import dotenv from 'dotenv';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Jimp } from 'jimp';
import jsQR from 'jsqr';

import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de entorno
dotenv.config({ path: path.join(__dirname, '.env') });
// Fallback al .env de la raíz de Laravel si no están definidas
if (!process.env.LARAVEL_API_URL || !process.env.BOT_INTERNAL_TOKEN) {
    dotenv.config({ path: path.join(__dirname, '..', '.env') });
}

// ── SERVIDOR HTTP PARA RENDER / HEALTH CHECKS ────────────────────────────────
const PORT = process.env.PORT || 3000;
let botStatus = 'Iniciando conexión...';
let currentQr = null;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    
    const qrHtml = currentQr 
        ? `<div style="background: white; padding: 16px; border-radius: 12px; display: inline-block; margin: 1.2rem auto; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
             <img src="https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(currentQr)}" 
                  alt="Código QR WhatsApp" 
                  style="display: block; width: 260px; height: 260px;" />
           </div>
           <p style="color: #cbd5e1; font-size: 0.9rem; margin: 0.5rem 0 0 0;">
             Abre WhatsApp en tu teléfono > <b>Dispositivos vinculados</b> y escanea este código.
           </p>
           <p style="color: #64748b; font-size: 0.75rem; margin-top: 0.5rem;">
             (Esta página se recargará automáticamente cada 20 segundos para refrescar el QR si expira).
           </p>
           <script>setTimeout(() => window.location.reload(), 20000);</script>`
        : `<p style="color: #94a3b8; font-size: 0.95rem; margin: 1.5rem 0;">
             ${botStatus.includes('🟢') ? '✅ El bot está activo y procesando mensajes normalmente.' : 'Esperando estado de conexión...'}
           </p>`;

    res.end(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bot de WhatsApp - alveappw</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #1e293b; padding: 2.2rem; border-radius: 1.2rem; border: 1px solid #334155; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 15px 30px rgba(0,0,0,0.5); }
        .badge { display: inline-block; padding: 0.4rem 1rem; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; background: #22c55e20; color: #4ade80; margin: 0.8rem 0; border: 1px solid #22c55e40; }
        code { background: #0f172a; padding: 2px 6px; border-radius: 4px; font-size: 0.82rem; color: #38bdf8; }
    </style>
</head>
<body>
    <div class="card">
        <div style="font-size: 2.5rem; margin-bottom: 0.4rem;">🤖</div>
        <h2 style="margin: 0.4rem 0; font-size: 1.4rem;">Bot de WhatsApp</h2>
        <p style="color: #94a3b8; font-size: 0.85rem; margin-top: 0;">Gestión de Equipos alveappw</p>
        <div class="badge">${botStatus}</div>
        ${qrHtml}
        <div style="margin-top: 1.5rem; border-top: 1px solid #334155; padding-top: 1rem;">
            <p style="color: #64748b; font-size: 0.75rem; margin: 0;">API Destino: <code>${process.env.LARAVEL_API_URL || 'No configurada'}</code></p>
        </div>
    </div>
</body>
</html>`);
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP activo en puerto ${PORT} (compatible con Render)`);
});

const LARAVEL_API_URL = process.env.LARAVEL_API_URL || 'http://proyecto_app.test/api/bot/chat';
const BOT_TOKEN = process.env.BOT_INTERNAL_TOKEN || '';

console.log('────────────────────────────────────────────────────────────');
console.log('🤖 INICIANDO BOT DE WHATSAPP (Baileys + Laravel + Lector QR)');
console.log(`📡 Conectado a Laravel API: ${LARAVEL_API_URL}`);
console.log('────────────────────────────────────────────────────────────\n');

/**
 * Procesa un buffer de imagen para buscar y decodificar un código QR
 */
async function decodificarQrDesdeBuffer(buffer) {
    try {
        const image = await Jimp.read(buffer);

        // 1. Intento directo con tamaño original
        let qrCode = jsQR(new Uint8ClampedArray(image.bitmap.data), image.bitmap.width, image.bitmap.height);
        if (qrCode?.data) return qrCode.data;

        // 2. Si es una foto de alta resolución, reducir dimensiones para acelerar y mejorar detección
        if (image.bitmap.width > 1200 || image.bitmap.height > 1200) {
            const copia = image.clone();
            const ratio = 1000 / Math.max(copia.bitmap.width, copia.bitmap.height);
            copia.resize({ w: Math.round(copia.bitmap.width * ratio), h: Math.round(copia.bitmap.height * ratio) });
            qrCode = jsQR(new Uint8ClampedArray(copia.bitmap.data), copia.bitmap.width, copia.bitmap.height);
            if (qrCode?.data) return qrCode.data;
        }

        // 3. Ajuste de contraste para fotos con sombras o baja iluminación
        const copiaContraste = image.clone();
        copiaContraste.greyscale().contrast(0.3);
        qrCode = jsQR(new Uint8ClampedArray(copiaContraste.bitmap.data), copiaContraste.bitmap.width, copiaContraste.bitmap.height);
        if (qrCode?.data) return qrCode.data;

        return null;
    } catch (e) {
        console.error('Error al decodificar QR:', e.message);
        return null;
    }
}

async function iniciarBot() {
    const authFolder = path.join(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`ℹ️  Versión de WhatsApp Web: v${version.join('.')}${isLatest ? ' (última)' : ''}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Silenciar logs internos para no tapar el QR
        printQRInTerminal: false,           // Usaremos qrcode-terminal manualmente para mejor formato
        auth: state,
        browser: ['Gestión de Equipos alveappw', 'Desktop', '1.0.0']
    });

    // Guardar credenciales de autenticación cada vez que se actualicen
    sock.ev.on('creds.update', saveCreds);

    // Monitorear estado de la conexión
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQr = qr;
            botStatus = '📲 Esperando escaneo de código QR';
            console.log('\n📲 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP:\n');
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Esperando vinculación...\n');
        }

        if (connection === 'close') {
            botStatus = '⚠️ Desconectado o reconectando...';
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

            if (isLoggedOut) {
                console.log('🔄 Sesión desvinculada desde el teléfono. Limpiando credenciales antiguas...');
                try {
                    fs.rmSync(authFolder, { recursive: true, force: true });
                } catch (e) {}
                console.log('⏳ Generando un nuevo código QR en 2 segundos...\n');
                setTimeout(iniciarBot, 2000);
            } else {
                console.log(`⚠️  Conexión pausada (código ${statusCode || 'red'}). Reconectando en 3s...`);
                setTimeout(iniciarBot, 3000);
            }
        } else if (connection === 'open') {
            currentQr = null;
            botStatus = '🟢 Conectado y Operativo en WhatsApp';
            console.log('✅ ¡BOT CONECTADO EXITOSAMENTE A WHATSAPP!');
            console.log('🤖 Listo para responder consultas de equipos, reportes y empresas.\n');
        }
    });

    const sentMessageIds = new Set();

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.endsWith('@broadcast')) continue;

            // Manejo de mensajes propios (evitar bucle infinito y permitir auto-chat)
            if (msg.key.fromMe) {
                // Si es un mensaje enviado por el bot como respuesta, ignorar
                if (sentMessageIds.has(msg.key.id)) continue;

                // Solo permitir mensajes en el chat propio ("Mensajes contigo mismo" / "Tú")
                const botNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : null;
                const chatNumber = remoteJid.split('@')[0].replace(/\D/g, '');

                if (!botNumber || botNumber !== chatNumber) {
                    continue; // Ignorar lo que escribes a tus otros contactos
                }
            }

            // Verificar si el mensaje contiene una imagen
            const isImage = Boolean(msg.message?.imageMessage);
            let textoMensaje =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                '';
            let esQr = false;
            let imageBase64 = null;

            const remitente = remoteJid.replace(/@s\.whatsapp\.net|@g\.us/, '');
            const nombreRemitente = msg.pushName || 'Usuario';

            // Si es una imagen, descargar y procesar
            let qrContent = null;
            if (isImage) {
                console.log(`📷 Foto recibida de [${nombreRemitente} (${remitente})]. Procesando...`);
                try {
                    const buffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );

                    if (buffer) {
                        imageBase64 = buffer.toString('base64');
                        qrContent = await decodificarQrDesdeBuffer(buffer);

                        if (qrContent) {
                            console.log(`✅ ¡Código QR detectado en la foto!: "${qrContent}"`);
                            esQr = true;
                        } else {
                            console.log(`ℹ️ Foto sin código QR (enviando a Laravel como posible evidencia de formulario)...`);
                        }
                    }
                } catch (imgErr) {
                    console.error('Error procesando imagen:', imgErr.message);
                }
            }

            // Si no hay texto y tampoco hay imagen, ignorar
            if (!textoMensaje.trim() && !imageBase64) continue;

            // Si se detectó un QR y el usuario no puso texto, usar el QR como mensaje principal
            const mensajeFinal = (!textoMensaje.trim() && qrContent) ? qrContent : textoMensaje;

            console.log(`📩 Mensaje de [${nombreRemitente} (${remitente})]: "${mensajeFinal || '[Imagen]'}" (QR: ${esQr ? 'Sí' : 'No'}, Foto: ${imageBase64 ? 'Sí' : 'No'})`);

            try {
                // Marcar mensaje como leído
                await sock.readMessages([msg.key]);

                // Consultar al backend Laravel
                const respuestaApi = await axios.post(
                    LARAVEL_API_URL,
                    {
                        from: remitente,
                        name: nombreRemitente,
                        message: mensajeFinal,
                        qr_content: qrContent,
                        is_qr: esQr,
                        image_base64: imageBase64
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Bot-Token': BOT_TOKEN
                        },
                        timeout: 20000
                    }
                );

                const textoRespuesta = respuestaApi.data?.reply;

                if (textoRespuesta) {
                    const sent = await sock.sendMessage(remoteJid, { text: textoRespuesta }, { quoted: msg });
                    if (sent?.key?.id) {
                        sentMessageIds.add(sent.key.id);
                        if (sentMessageIds.size > 2000) sentMessageIds.clear();
                    }
                    console.log(`📤 Respuesta enviada a [${remitente}]`);
                }
            } catch (error) {
                console.error(`❌ Error al procesar mensaje con Laravel:`, error.response?.data || error.message);

                try {
                    const sentErr = await sock.sendMessage(remoteJid, {
                        text: '⚠️ Ocurrió un error temporal al consultar el sistema. Por favor intenta más tarde.'
                    }, { quoted: msg });
                    if (sentErr?.key?.id) sentMessageIds.add(sentErr.key.id);
                } catch (sendErr) {
                    console.error('Error al notificar fallo al usuario:', sendErr.message);
                }
            }
        }
    });
}

// Iniciar proceso
iniciarBot().catch((err) => {
    console.error('Error fatal al iniciar el bot:', err);
});
