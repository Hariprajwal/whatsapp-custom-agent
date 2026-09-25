/**
 * 🦙 Standalone WhatsApp Local AI Chatbot & PC Companion
 * Direct local Ollama chat + PC remote control over WhatsApp with human simulation.
 */

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const config = require('./config');

const AUTH_DIR = path.resolve(__dirname, 'auth_info');
let currentModel = config.ollama.defaultModel;

// In-memory chat history: jid -> array of { role: 'user'|'assistant', content: string }
const conversationHistory = new Map();
const MAX_HISTORY_TURNS = 8;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ==========================================
// 🛡️ HUMAN SIMULATION SENDER
// ==========================================
async function sendHumanReply(sock, jid, text, originalMsg = null) {
    try {
        if (originalMsg?.key) {
            await sock.readMessages([originalMsg.key]).catch(() => {});
        }

        await sleep(randomDelay(config.safety.markAsReadDelayMinMs, config.safety.markAsReadDelayMaxMs));
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        const typingDelay = Math.min(
            config.safety.maxTypingDelayMs, 
            Math.max(config.safety.minTypingDelayMs, text.length * 20 + randomDelay(300, 700))
        );
        await sleep(typingDelay);

        await sock.sendPresenceUpdate('paused', jid).catch(() => {});

        const sendOptions = (config.safety.quoteOriginalMessage && originalMsg) ? { quoted: originalMsg } : {};
        await sock.sendMessage(jid, { text }, sendOptions);
    } catch (err) {
        console.error('[!] Failed to send message:', err.message);
    }
}

// ==========================================
// 🦙 OLLAMA AI CLIENT
// ==========================================
async function getInstalledOllamaModels() {
    try {
        const res = await fetch(`${config.ollama.baseUrl}/api/tags`);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || []).map(m => m.name);
    } catch (e) {
        return [];
    }
}

async function queryOllamaChat(jid, userPrompt) {
    try {
        // Retrieve / update conversation context
        let history = conversationHistory.get(jid) || [];
        history.push({ role: 'user', content: userPrompt });

        // Keep last MAX_HISTORY_TURNS messages
        if (history.length > MAX_HISTORY_TURNS) {
            history = history.slice(-MAX_HISTORY_TURNS);
        }

        const messages = [
            { role: 'system', content: config.ollama.systemPrompt },
            ...history
        ];

        const response = await fetch(`${config.ollama.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: currentModel,
                messages,
                stream: false,
                options: {
                    temperature: config.ollama.temperature,
                    num_predict: config.ollama.numPredict
                }
            })
        });

        if (!response.ok) {
            return `⚠️ Ollama API Error: HTTP ${response.status}`;
        }

        const data = await response.json();
        const reply = data.message?.content?.trim() || '⚠️ (No response from Ollama)';

        // Store assistant reply in history
        history.push({ role: 'assistant', content: reply });
        conversationHistory.set(jid, history);

        return reply;
    } catch (err) {
        return `⚠️ Could not reach Ollama at ${config.ollama.baseUrl}. Is Ollama running on your PC?`;
    }
}

// ==========================================
// 💻 PC SYSTEM DIAGNOSTICS
// ==========================================
function getSystemStatus() {
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const uptimeHours = (os.uptime() / 3600).toFixed(1);

    return (
        `💻 *HOST PC DIAGNOSTICS*\n` +
        `──────────────────────────\n` +
        `🖥️ *OS:* ${os.type()} (${os.arch()})\n` +
        `⏱️ *Uptime:* ${uptimeHours} hours\n` +
        `🧠 *RAM:* ${freeMem} GB free / ${totalMem} GB total\n` +
        `🦙 *Active Ollama Model:* ${currentModel}\n` +
        `──────────────────────────`
    );
}

// ==========================================
// 🚀 MAIN AGENT
// ==========================================
async function startStandaloneAIAgent() {
    console.log('\n=============================================================');
    console.log('       STANDALONE WHATSAPP LOCAL AI CHATBOT AGENT           ');
    console.log('=============================================================');
    console.log(`[i] Ollama Host   : ${config.ollama.baseUrl}`);
    console.log(`[i] Active Model  : ${currentModel}`);
    console.log(`[i] Auth Directory: ${AUTH_DIR}\n`);

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: config.safety.browserSignature,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n=============================================================');
            console.log(' SCAN QR CODE WITH WHATSAPP (Settings > Linked Devices):');
            console.log('=============================================================\n');
            qrcode.generate(qr, { small: true });
            console.log('\nWaiting for scan...');
        }

        if (connection === 'open') {
            console.log('\n=============================================================');
            console.log(' [✓] STANDALONE AI AGENT CONNECTED!');
            console.log(` [✓] Model: ${currentModel}`);
            console.log(' [✓] Send "!help" in WhatsApp to see available commands.');
            console.log('=============================================================\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[!] Connection closed (${statusCode || 'Unknown'}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(startStandaloneAIAgent, 3000);
            } else {
                console.log('[X] Logged out. Resetting auth directory.');
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');
            const text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                ''
            ).trim();

            if (!text) continue;

            const sender = msg.pushName || 'User';
            const lower = text.toLowerCase();

            // Direct message OR group mention / !ai command
            const isCommand = text.startsWith('!');
            const isAiPrefix = lower.startsWith('ai ') || lower.startsWith('ai:');
            const shouldRespond = !isGroup || isCommand || isAiPrefix;

            if (!shouldRespond) continue;

            console.log(`[💬] [${new Date().toLocaleTimeString()}] ${sender}: "${text}"`);

            // --- COMMANDS ---

            // !help
            if (lower === '!help') {
                const helpMsg = 
                    `🤖 *STANDALONE LOCAL AI COMMANDS*\n` +
                    `──────────────────────────\n` +
                    `💬 *Chatting:* Just type your question!\n` +
                    `🦙 *!model <name>* -> Switch local Ollama model\n` +
                    `📋 *!models* -> List all installed models on PC\n` +
                    `💻 *!status* -> Show PC RAM, CPU & host health\n` +
                    `🧹 *!clear* -> Reset conversation memory\n` +
                    `──────────────────────────\n` +
                    `Powered by your local PC (0 API cost & 100% private)`;
                await sendHumanReply(sock, jid, helpMsg, msg);
                continue;
            }

            // !status
            if (lower === '!status') {
                const statusMsg = getSystemStatus();
                await sendHumanReply(sock, jid, statusMsg, msg);
                continue;
            }

            // !models
            if (lower === '!models') {
                const models = await getInstalledOllamaModels();
                let reply = `🦙 *INSTALLED OLLAMA MODELS (${models.length}):*\n`;
                if (models.length === 0) {
                    reply += `⚠️ No models found or Ollama is offline.`;
                } else {
                    reply += models.map(m => `• ${m === currentModel ? `👉 *${m}* (Active)` : m}`).join('\n');
                    reply += `\n\n💡 Tip: Send *!model <name>* to switch models!`;
                }
                await sendHumanReply(sock, jid, reply, msg);
                continue;
            }

            // !model <name>
            if (lower.startsWith('!model ')) {
                const requested = text.substring(7).trim();
                const available = await getInstalledOllamaModels();
                if (available.includes(requested)) {
                    currentModel = requested;
                    await sendHumanReply(sock, jid, `✅ Switched active Ollama model to: *${currentModel}*`, msg);
                } else {
                    await sendHumanReply(sock, jid, `⚠️ Model "${requested}" not found on your PC. Type *!models* to see available options.`, msg);
                }
                continue;
            }

            // !clear
            if (lower === '!clear') {
                conversationHistory.delete(jid);
                await sendHumanReply(sock, jid, '🧹 Conversation context has been cleared!', msg);
                continue;
            }

            // --- AI CHAT QUERY ---
            let cleanPrompt = text;
            if (cleanPrompt.startsWith('!ai ')) cleanPrompt = cleanPrompt.substring(4).trim();
            else if (cleanPrompt.toLowerCase().startsWith('ai:')) cleanPrompt = cleanPrompt.substring(3).trim();
            else if (cleanPrompt.toLowerCase().startsWith('ai ')) cleanPrompt = cleanPrompt.substring(3).trim();

            const answer = await queryOllamaChat(jid, cleanPrompt);
            await sendHumanReply(sock, jid, answer, msg);
        }
    });
}

startStandaloneAIAgent().catch(err => {
    console.error('[FATAL] Standalone AI Agent error:', err);
});
