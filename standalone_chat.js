/**
 * 🦙 Standalone WhatsApp AI Chatbot & PC Companion
 * Dual-tier AI: Local Ollama (Priority) + OpenRouter Cloud (Fallback)
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
const config = require('./config');

const AUTH_DIR = path.resolve(__dirname, config.paths.authDir);
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
// 🦙 DUAL AI ENGINE: OLLAMA + OPENROUTER
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

async function queryOllamaChat(history) {
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

    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = await response.json();
    return data.message?.content?.trim() || null;
}

async function queryOpenRouterChat(history) {
    if (!config.openrouter.apiKey) return null;

    const messages = [
        { role: 'system', content: config.ollama.systemPrompt },
        ...history
    ];

    const response = await fetch(config.openrouter.baseUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.openrouter.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': config.openrouter.siteUrl,
            'X-Title': config.openrouter.siteName
        },
        body: JSON.stringify({
            model: config.openrouter.defaultModel,
            messages,
            max_tokens: 350,
            temperature: config.ollama.temperature
        })
    });

    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
}

async function queryDualAIChat(jid, userPrompt) {
    let history = conversationHistory.get(jid) || [];
    history.push({ role: 'user', content: userPrompt });

    if (history.length > MAX_HISTORY_TURNS) {
        history = history.slice(-MAX_HISTORY_TURNS);
    }

    let reply = null;
    let providerTag = '';

    // 1. Try local Ollama
    try {
        console.log(`[🦙] Querying local Ollama (${currentModel})...`);
        const ollamaPromise = queryOllamaChat(history);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 7000));
        reply = await Promise.race([ollamaPromise, timeoutPromise]);
        if (reply) {
            providerTag = '_(⚡ Local Ollama)_';
        }
    } catch (err) {
        console.log(`[!] Ollama chat failed (${err.message}), falling back to OpenRouter...`);
    }

    // 2. Fallback to OpenRouter
    if (!reply && config.openrouter.apiKey) {
        try {
            console.log(`[☁️] Querying OpenRouter (${config.openrouter.defaultModel})...`);
            reply = await queryOpenRouterChat(history);
            if (reply) {
                providerTag = '_(☁️ OpenRouter Backup)_';
            }
        } catch (err) {
            console.error('[!] OpenRouter fallback error:', err.message);
        }
    }

    if (!reply) {
        return '⚠️ AI Assistant is temporarily unavailable. (Local Ollama offline and OpenRouter error)';
    }

    // Update conversation memory with assistant response
    history.push({ role: 'assistant', content: reply });
    conversationHistory.set(jid, history);

    return `${reply}\n\n${providerTag}`;
}

// ==========================================
// 💻 PC SYSTEM DIAGNOSTICS
// ==========================================
async function getSystemStatus() {
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const uptimeHours = (os.uptime() / 3600).toFixed(1);

    let ollamaOnline = false;
    try {
        const res = await fetch(`${config.ollama.baseUrl}/api/tags`);
        ollamaOnline = res.ok;
    } catch (e) {}

    return (
        `💻 *HOST PC & AI DIAGNOSTICS*\n` +
        `──────────────────────────\n` +
        `🖥️ *OS:* ${os.type()} (${os.arch()})\n` +
        `⏱️ *Uptime:* ${uptimeHours} hours\n` +
        `🧠 *RAM:* ${freeMem} GB free / ${totalMem} GB total\n` +
        `🦙 *Local Ollama:* ${ollamaOnline ? `ONLINE ⚡ (${currentModel})` : 'OFFLINE ⚪'}\n` +
        `☁️ *OpenRouter:* ${config.openrouter.apiKey ? `READY 🟢 (Backup: ${config.openrouter.defaultModel})` : 'NO KEY ⚪'}\n` +
        `──────────────────────────`
    );
}

// ==========================================
// 🚀 MAIN AGENT
// ==========================================
async function startStandaloneAIAgent() {
    console.log('\n=============================================================');
    console.log('       STANDALONE WHATSAPP DUAL-TIER AI CHATBOT AGENT        ');
    console.log('=============================================================');
    console.log(`[i] Local Ollama      : ${config.ollama.baseUrl} (${currentModel})`);
    console.log(`[i] OpenRouter Backup : ${config.openrouter.apiKey ? 'Enabled ✅ (' + config.openrouter.defaultModel + ')' : 'No API Key ❌'}`);
    console.log(`[i] Auth Directory    : ${AUTH_DIR}\n`);

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
            console.log(` [✓] Primary AI: Ollama (${currentModel})`);
            console.log(` [✓] Backup AI : OpenRouter (${config.openrouter.defaultModel})`);
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

            const isCommand = text.startsWith('!');
            const isAiPrefix = lower.startsWith('ai ') || lower.startsWith('ai:');
            const shouldRespond = !isGroup || isCommand || isAiPrefix;

            if (!shouldRespond) continue;

            console.log(`[💬] [${new Date().toLocaleTimeString()}] ${sender}: "${text}"`);

            // !help
            if (lower === '!help') {
                const helpMsg = 
                    `🤖 *STANDALONE DUAL AI COMMANDS*\n` +
                    `──────────────────────────\n` +
                    `💬 *Chatting:* Type any question (multi-turn memory!)\n` +
                    `🦙 *!model <name>* -> Switch local Ollama model\n` +
                    `📋 *!models* -> List all installed models on PC\n` +
                    `💻 *!status* -> Show PC RAM, CPU & AI status\n` +
                    `🧹 *!clear* -> Reset conversation memory\n` +
                    `──────────────────────────\n` +
                    `⚡ Primary: Local Ollama | ☁️ Backup: OpenRouter`;
                await sendHumanReply(sock, jid, helpMsg, msg);
                continue;
            }

            // !status
            if (lower === '!status') {
                const statusMsg = await getSystemStatus();
                await sendHumanReply(sock, jid, statusMsg, msg);
                continue;
            }

            // !models
            if (lower === '!models') {
                const models = await getInstalledOllamaModels();
                let reply = `🦙 *INSTALLED OLLAMA MODELS (${models.length}):*\n`;
                if (models.length === 0) {
                    reply += `⚠️ No models found or Ollama is offline. OpenRouter backup active.`;
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

            // AI CHAT QUERY
            let cleanPrompt = text;
            if (cleanPrompt.startsWith('!ai ')) cleanPrompt = cleanPrompt.substring(4).trim();
            else if (cleanPrompt.toLowerCase().startsWith('ai:')) cleanPrompt = cleanPrompt.substring(3).trim();
            else if (cleanPrompt.toLowerCase().startsWith('ai ')) cleanPrompt = cleanPrompt.substring(3).trim();

            const answer = await queryDualAIChat(jid, cleanPrompt);
            await sendHumanReply(sock, jid, answer, msg);
        }
    });
}

startStandaloneAIAgent().catch(err => {
    console.error('[FATAL] Standalone AI Agent error:', err);
});
