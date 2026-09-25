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
const { spawn } = require('child_process');

// Paths
const ROOT_DIR = path.resolve(__dirname, '..');
const LINK_FILE_PATH = path.join(ROOT_DIR, 'link.txt');
const AUTH_DIR = path.resolve(__dirname, 'auth_info');
const TARGET_GROUP_KEYWORD = 'movide';

// Ollama Settings
const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'llama3.2:1b';

// In-memory group cache (jid -> subject)
const groupCache = new Map();

// Helper: Sleep / delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Random jitter delay
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ==========================================
// 🛡️ HUMAN-LIKE WHATSAPP SENDER HELPER
// ==========================================
async function sendHumanReply(sock, jid, text, originalMsg = null) {
    try {
        // 1. Mark the incoming message as read
        if (originalMsg?.key) {
            await sock.readMessages([originalMsg.key]).catch(() => {});
        }

        // 2. Realistic "thinking" pause before typing (400ms - 900ms)
        await sleep(randomDelay(400, 900));

        // 3. Show "typing..." presence indicator
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        // 4. Calculate realistic typing duration based on response length
        const typingTime = Math.min(3500, Math.max(1200, text.length * 20 + randomDelay(300, 700)));
        await sleep(typingTime);

        // 5. Pause composing
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});

        // 6. Send the message (quote original if provided)
        const sendOptions = originalMsg ? { quoted: originalMsg } : {};
        await sock.sendMessage(jid, { text }, sendOptions);
        
        console.log(`[✓] Sent reply: "${text.substring(0, 50).replace(/\n/g, ' ')}..."`);
    } catch (err) {
        console.error('[!] Failed to send human reply:', err.message);
    }
}

// ==========================================
// 📂 LINK.TXT MANAGEMENT
// ==========================================
function getValidLinks() {
    try {
        if (!fs.existsSync(LINK_FILE_PATH)) return [];
        const content = fs.readFileSync(LINK_FILE_PATH, 'utf-8');
        return content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && line.startsWith('http'));
    } catch (err) {
        console.error('[!] Error reading link.txt:', err.message);
        return [];
    }
}

function appendLinkToFile(url) {
    try {
        fs.appendFileSync(LINK_FILE_PATH, url + '\n', 'utf-8');
        return true;
    } catch (err) {
        console.error('[!] Failed writing to link.txt:', err.message);
        return false;
    }
}

function cleanAndDeduplicateLinkFile() {
    try {
        if (!fs.existsSync(LINK_FILE_PATH)) return { before: 0, after: 0, removed: 0 };
        const raw = fs.readFileSync(LINK_FILE_PATH, 'utf-8');
        const lines = raw.split(/\r?\n/).map(l => l.trim());
        const beforeCount = lines.filter(l => l.length > 0).length;

        const uniqueLinks = [];
        const seen = new Set();

        for (const line of lines) {
            if (!line || !line.startsWith('http')) continue;
            // Ignore JioSphere junk
            if (/jiosphere\.com/i.test(line)) continue;
            
            if (!seen.has(line)) {
                seen.add(line);
                uniqueLinks.push(line);
            }
        }

        fs.writeFileSync(LINK_FILE_PATH, uniqueLinks.join('\n') + '\n', 'utf-8');
        return {
            before: beforeCount,
            after: uniqueLinks.length,
            removed: beforeCount - uniqueLinks.length
        };
    } catch (err) {
        console.error('[!] Error cleaning link.txt:', err.message);
        return null;
    }
}

function extractCleanUrls(text) {
    if (!text || typeof text !== 'string') return [];
    const urlRegex = /https?:\/\/[^\s<>"'{}|\\^`]+[^\s<>"'{}|\\^`.,;:?!()\[\]]/gi;
    const matches = text.match(urlRegex) || [];
    const valid = [];

    for (let raw of matches) {
        let clean = raw.replace(/[.,;:?!)]+$/, '').trim();
        if (/jiosphere\.com/i.test(clean)) continue;
        if (clean.startsWith('http://') || clean.startsWith('https://')) {
            valid.push(clean);
        }
    }
    return valid;
}

function extractTextFromMessage(message) {
    if (!message) return '';
    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        ''
    );
}

// ==========================================
// 🖥️ WINDOWS PROCESS CONTROLLER
// ==========================================
function isTenorAgentRunning() {
    return new Promise((resolve) => {
        const ps = spawn('powershell', [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Where-Object CommandLine -like "*tenor_agent.py*" | Select-Object -ExpandProperty ProcessId'
        ]);

        let output = '';
        ps.stdout.on('data', (d) => { output += d.toString(); });
        ps.on('close', () => {
            const pids = output.trim().split(/\r?\n/).filter(Boolean);
            resolve(pids.length > 0);
        });
        ps.on('error', () => resolve(false));
    });
}

function launchTenorAgent() {
    return new Promise(async (resolve) => {
        const alreadyRunning = await isTenorAgentRunning();
        if (alreadyRunning) {
            return resolve({ success: false, message: 'Tenor Agent is ALREADY running on your PC!' });
        }

        try {
            // Launch in a new, independent Windows console window
            const child = spawn('cmd.exe', ['/c', 'start', 'Tenor Agent', 'cmd', '/k', 'python tenor_agent.py'], {
                cwd: ROOT_DIR,
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            resolve({ success: true, message: '🚀 Tenor Agent has been launched in a new window on your PC!' });
        } catch (err) {
            resolve({ success: false, message: `Failed to launch Tenor Agent: ${err.message}` });
        }
    });
}

function stopTenorAgent() {
    return new Promise((resolve) => {
        const ps = spawn('powershell', [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Where-Object CommandLine -like "*tenor_agent.py*" | Stop-Process -Force'
        ]);

        ps.on('close', (code) => {
            resolve({ success: true, message: '🛑 Tenor Agent process has been stopped on your PC.' });
        });
        ps.on('error', (err) => {
            resolve({ success: false, message: `Failed to stop agent: ${err.message}` });
        });
    });
}

// ==========================================
// 🦙 OLLAMA AI QUERY HANDLER
// ==========================================
async function queryOllama(prompt) {
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt: `You are a helpful, concise AI assistant in a WhatsApp group called MOVIDE. Answer the user prompt directly and concisely.\n\nUser: ${prompt}\n\nAssistant:`,
                stream: false,
                options: {
                    temperature: 0.7,
                    num_predict: 250
                }
            })
        });

        if (!response.ok) {
            return `⚠️ Ollama returned error: HTTP ${response.status}`;
        }

        const data = await response.json();
        return data.response?.trim() || '⚠️ (Empty response from Ollama)';
    } catch (err) {
        return `⚠️ Could not reach Ollama at ${OLLAMA_BASE_URL}. Ensure Ollama is running! (${err.message})`;
    }
}

async function checkOllamaStatus() {
    try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (res.ok) {
            const data = await res.json();
            const models = (data.models || []).map(m => m.name);
            const hasModel = models.includes(OLLAMA_MODEL);
            return { online: true, activeModel: OLLAMA_MODEL, modelFound: hasModel };
        }
    } catch (e) {}
    return { online: false, activeModel: OLLAMA_MODEL, modelFound: false };
}

// ==========================================
// 🤖 MAIN BOT LOOP & EVENT HANDLER
// ==========================================
async function startWhatsAppSync() {
    console.log('\n=============================================================');
    console.log('       WHATSAPP AI ASSISTANT & SYNC AGENT STARTING...        ');
    console.log('=============================================================');
    console.log(`[i] Target File  : ${LINK_FILE_PATH}`);
    console.log(`[i] Target Group : "${TARGET_GROUP_KEYWORD.toUpperCase()}" (case-insensitive)`);
    console.log(`[i] Local Ollama : ${OLLAMA_BASE_URL} (${OLLAMA_MODEL})\n`);

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
        browser: ['Chrome (Windows)', 'Desktop', '124.0.0.0'], // Realistic browser signature
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n=============================================================');
            console.log(' SCAN THE QR CODE BELOW WITH WHATSAPP ON YOUR PHONE:');
            console.log(' 1. Open WhatsApp on your phone');
            console.log(' 2. Go to Settings > Linked Devices > Link a Device');
            console.log(' 3. Point your camera at this QR code:');
            console.log('=============================================================\n');
            qrcode.generate(qr, { small: true });
            console.log('\nWaiting for scan...');
        }

        if (connection === 'open') {
            console.log('\n=============================================================');
            console.log(' [✓] WHATSAPP AI AGENT CONNECTED SUCCESSFULLY!');
            console.log(` [✓] Group: "${TARGET_GROUP_KEYWORD.toUpperCase()}"`);
            console.log(' [✓] Human Simulation: Enabled (Mark Read + Typing Presence)');
            console.log(' [✓] Ready to receive links, commands (!status, !launch), & AI prompts!');
            console.log('=============================================================\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`\n[!] Connection closed (${statusCode || 'Unknown'}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                console.log('[...] Reconnecting in 3 seconds...');
                setTimeout(startWhatsAppSync, 3000);
            } else {
                console.log('[X] Logged out from WhatsApp. Clear session and restart to scan new QR code.');
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {}
            }
        }
    });

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            // Ignore messages sent by this bot itself to avoid loops
            if (msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            if (!jid || !jid.endsWith('@g.us')) continue; // Group messages only

            // Check group name
            let groupName = groupCache.get(jid);
            if (!groupName) {
                try {
                    const metadata = await sock.groupMetadata(jid);
                    groupName = metadata.subject || '';
                    groupCache.set(jid, groupName);
                } catch (e) {
                    groupName = '';
                }
            }

            if (!groupName || !groupName.toLowerCase().includes(TARGET_GROUP_KEYWORD)) {
                continue;
            }

            const text = extractTextFromMessage(msg.message).trim();
            if (!text) continue;

            const sender = msg.pushName || 'Friend';
            console.log(`\n[📩] [${new Date().toLocaleTimeString()}] Group: "${groupName}" | ${sender}: "${text}"`);

            // ==========================================
            // 1. LINK DETECTION & SAVING
            // ==========================================
            const urls = extractCleanUrls(text);
            if (urls.length > 0) {
                const existing = new Set(getValidLinks());
                let addedCount = 0;

                for (const url of urls) {
                    if (!existing.has(url)) {
                        appendLinkToFile(url);
                        existing.add(url);
                        addedCount++;
                    }
                }

                const totalRemaining = getValidLinks().length;
                let replyMsg = '';
                if (addedCount > 0) {
                    replyMsg = `✅ Saved ${addedCount} new link(s) to queue!\n📋 Total links in queue: ${totalRemaining}`;
                } else {
                    replyMsg = `⚠️ Link is already in the queue!\n📋 Total links in queue: ${totalRemaining}`;
                }

                await sendHumanReply(sock, jid, replyMsg, msg);
                continue;
            }

            // ==========================================
            // 2. REMOTE BOT COMMANDS
            // ==========================================
            const lower = text.toLowerCase();

            // Command: !status
            if (lower === '!status' || lower === 'status') {
                const isRunning = await isTenorAgentRunning();
                const linkCount = getValidLinks().length;
                const ollamaInfo = await checkOllamaStatus();

                const statusText = 
                    `📊 *SYSTEM STATUS REPORT*\n` +
                    `──────────────────────────\n` +
                    `🤖 *Tenor Agent:* ${isRunning ? 'RUNNING 🟢' : 'IDLE / STOPPED ⚪'}\n` +
                    `📋 *Queue Size:* ${linkCount} links waiting in link.txt\n` +
                    `🦙 *Ollama AI:* ${ollamaInfo.online ? `ONLINE ⚡ (${ollamaInfo.activeModel})` : 'OFFLINE ❌'}\n` +
                    `💻 *Host Machine:* Windows PC (Active)\n` +
                    `──────────────────────────\n` +
                    `💡 Tip: Send *!launch* to start or *!clean* to tidy links.`;

                await sendHumanReply(sock, jid, statusText, msg);
                continue;
            }

            // Command: !launch or !start
            if (lower === '!launch' || lower === '!start' || lower === 'start bot') {
                const result = await launchTenorAgent();
                await sendHumanReply(sock, jid, result.message, msg);
                continue;
            }

            // Command: !stop
            if (lower === '!stop' || lower === 'stop bot') {
                const result = await stopTenorAgent();
                await sendHumanReply(sock, jid, result.message, msg);
                continue;
            }

            // Command: !clean
            if (lower === '!clean' || lower === 'clean links') {
                const cleanResult = cleanAndDeduplicateLinkFile();
                if (cleanResult) {
                    const cleanMsg = 
                        `🧹 *LINK.TXT CLEANED!*\n` +
                        `• Cleaned duplicates/junk: ${cleanResult.removed}\n` +
                        `• Valid links remaining: ${cleanResult.after}`;
                    await sendHumanReply(sock, jid, cleanMsg, msg);
                } else {
                    await sendHumanReply(sock, jid, '⚠️ Failed to clean link.txt.', msg);
                }
                continue;
            }

            // Command: !help or !commands
            if (lower === '!help' || lower === 'help' || lower === '!commands') {
                const helpText = 
                    `🤖 *MOVIDE ASSISTANT COMMANDS*\n` +
                    `──────────────────────────\n` +
                    `🔗 *Paste any Link* -> Auto-saved to link.txt\n` +
                    `📊 *!status* -> Check agent state & queue count\n` +
                    `🚀 *!launch* -> Launch Tenor Agent on PC\n` +
                    `🛑 *!stop* -> Stop Tenor Agent\n` +
                    `🧹 *!clean* -> Deduplicate & tidy link.txt\n` +
                    `🦙 *!ai <prompt>* -> Ask local Ollama AI\n` +
                    `──────────────────────────`;
                await sendHumanReply(sock, jid, helpText, msg);
                continue;
            }

            // ==========================================
            // 3. OLLAMA AI CHATBOT (!ai <prompt> or ai: <prompt>)
            // ==========================================
            if (lower.startsWith('!ai ') || lower.startsWith('ai ') || lower.startsWith('ai:')) {
                const prompt = text.replace(/^(!ai\s+|ai\s+|ai:\s*)/i, '').trim();
                if (!prompt) {
                    await sendHumanReply(sock, jid, '❓ Please write a question after !ai (e.g. *!ai give me movie ideas*)', msg);
                    continue;
                }

                console.log(`[🦙] Querying Ollama: "${prompt}"`);
                const answer = await queryOllama(prompt);
                await sendHumanReply(sock, jid, answer, msg);
                continue;
            }
        }
    });
}

// Start bot
startWhatsAppSync().catch(err => {
    console.error('[FATAL] WhatsApp Sync failed to start:', err);
});
