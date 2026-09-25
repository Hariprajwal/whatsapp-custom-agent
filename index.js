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
const config = require('./config');

// Paths
const ROOT_DIR = path.resolve(__dirname, '..');
const LINK_FILE_PATH = path.resolve(__dirname, config.paths.linkFile);
const AUTH_DIR = path.resolve(__dirname, config.paths.authDir);

// In-memory group cache (jid -> subject)
const groupCache = new Map();

// Helper: Sleep / delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ==========================================
// 🛡️ HUMAN-LIKE WHATSAPP SENDER HELPER
// ==========================================
async function sendHumanReply(sock, jid, text, originalMsg = null) {
    try {
        if (originalMsg?.key) {
            await sock.readMessages([originalMsg.key]).catch(() => {});
        }

        await sleep(randomDelay(config.safety.markAsReadDelayMinMs, config.safety.markAsReadDelayMaxMs));
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        const typingTime = Math.min(
            config.safety.maxTypingDelayMs, 
            Math.max(config.safety.minTypingDelayMs, text.length * 20 + randomDelay(300, 700))
        );
        await sleep(typingTime);

        await sock.sendPresenceUpdate('paused', jid).catch(() => {});

        const sendOptions = (config.safety.quoteOriginalMessage && originalMsg) ? { quoted: originalMsg } : {};
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

        ps.on('close', () => {
            resolve({ success: true, message: '🛑 Tenor Agent process has been stopped on your PC.' });
        });
        ps.on('error', (err) => {
            resolve({ success: false, message: `Failed to stop agent: ${err.message}` });
        });
    });
}

// ==========================================
// 🦙 DUAL AI ENGINE: OLLAMA + OPENROUTER BACKUP
// ==========================================
async function queryOllama(prompt) {
    try {
        const res = await fetch(`${config.ollama.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.ollama.defaultModel,
                prompt: `You are a helpful, concise AI assistant in a WhatsApp group called movie. Answer concisely.\n\nUser: ${prompt}\n\nAssistant:`,
                stream: false,
                options: {
                    temperature: config.ollama.temperature,
                    num_predict: config.ollama.numPredict
                }
            })
        });

        if (!res.ok) return null;
        const data = await res.json();
        return data.response?.trim() || null;
    } catch (e) {
        return null;
    }
}

async function queryOpenRouter(prompt) {
    if (!config.openrouter.apiKey) return null;
    try {
        const res = await fetch(config.openrouter.baseUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.openrouter.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': config.openrouter.siteUrl,
                'X-Title': config.openrouter.siteName
            },
            body: JSON.stringify({
                model: config.openrouter.defaultModel,
                messages: [
                    { role: 'system', content: 'You are a helpful, concise AI assistant in a WhatsApp group called movie. Answer concisely.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 300,
                temperature: 0.7
            })
        });

        if (!res.ok) return null;
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        console.error('[!] OpenRouter fallback error:', e.message);
        return null;
    }
}

async function queryAIWithFallback(prompt) {
    // 1. Try local Ollama first (Priority: 100% Free & Local)
    try {
        console.log(`[🦙] Querying local Ollama (${config.ollama.defaultModel})...`);
        const ollamaPromise = queryOllama(prompt);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 7000));
        const ollamaRes = await Promise.race([ollamaPromise, timeoutPromise]);
        
        if (ollamaRes) {
            return `${ollamaRes}\n\n_(⚡ Local Ollama)_`;
        }
    } catch (err) {
        console.log(`[!] Ollama unreachable, switching to OpenRouter backup...`);
    }

    // 2. Fallback to OpenRouter Cloud API
    if (config.openrouter.apiKey) {
        console.log(`[☁️] Querying OpenRouter Cloud Backup (${config.openrouter.defaultModel})...`);
        const orRes = await queryOpenRouter(prompt);
        if (orRes) {
            return `${orRes}\n\n_(☁️ OpenRouter Backup)_`;
        }
    }

    return '⚠️ AI Assistant is currently offline. Please ensure local Ollama is running or OpenRouter key is set.';
}

async function checkAIStatus() {
    let ollamaOnline = false;
    try {
        const res = await fetch(`${config.ollama.baseUrl}/api/tags`);
        ollamaOnline = res.ok;
    } catch (e) {}

    return {
        ollama: { online: ollamaOnline, model: config.ollama.defaultModel },
        openRouter: { configured: Boolean(config.openrouter.apiKey), model: config.openrouter.defaultModel }
    };
}

// ==========================================
// 🤖 MAIN BOT LOOP & EVENT HANDLER
// ==========================================
async function startWhatsAppSync() {
    console.log('\n=============================================================');
    console.log('       WHATSAPP AI ASSISTANT & SYNC AGENT STARTING...        ');
    console.log('=============================================================');
    console.log(`[i] Target File       : ${LINK_FILE_PATH}`);
    console.log(`[i] Target Keyword(s) : "${config.targetGroupKeywords.join(' / ').toUpperCase()}"`);
    console.log(`[i] Local Ollama      : ${config.ollama.baseUrl} (${config.ollama.defaultModel})`);
    console.log(`[i] OpenRouter Backup : ${config.openrouter.apiKey ? 'Enabled ✅ (' + config.openrouter.defaultModel + ')' : 'No API Key ❌'}\n`);

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
            console.log(` [✓] Monitored Group(s): "${config.targetGroupKeywords.join(' / ').toUpperCase()}"`);
            console.log(' [✓] Dual AI: Local Ollama + OpenRouter Backup Active');
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const jid = msg.key.remoteJid;
            if (!jid || !jid.endsWith('@g.us')) continue; // Group messages

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

            const matchesGroup = config.targetGroupKeywords.some(kw => groupName.toLowerCase().includes(kw));
            if (!groupName || !matchesGroup) {
                continue;
            }

            const text = extractTextFromMessage(msg.message).trim();
            if (!text) continue;

            const sender = msg.pushName || 'Friend';
            console.log(`\n[📩] [${new Date().toLocaleTimeString()}] Group: "${groupName}" | ${sender}: "${text}"`);

            // 1. LINK DETECTION & SAVING
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

            // 2. COMMANDS
            const lower = text.toLowerCase();

            // !status
            if (lower === '!status' || lower === 'status') {
                const isRunning = await isTenorAgentRunning();
                const linkCount = getValidLinks().length;
                const aiInfo = await checkAIStatus();

                const statusText = 
                    `📊 *SYSTEM STATUS REPORT*\n` +
                    `──────────────────────────\n` +
                    `🤖 *Tenor Agent:* ${isRunning ? 'RUNNING 🟢' : 'IDLE / STOPPED ⚪'}\n` +
                    `📋 *Queue Size:* ${linkCount} links waiting in link.txt\n` +
                    `🦙 *Local Ollama:* ${aiInfo.ollama.online ? `ONLINE ⚡ (${aiInfo.ollama.model})` : 'OFFLINE ⚪'}\n` +
                    `☁️ *OpenRouter:* ${aiInfo.openRouter.configured ? `READY 🟢 (Backup active)` : 'NO KEY ⚪'}\n` +
                    `💻 *Host Machine:* Windows PC (Active)\n` +
                    `──────────────────────────\n` +
                    `💡 Tip: Send *!launch* to start or *!clean* to tidy links.`;

                await sendHumanReply(sock, jid, statusText, msg);
                continue;
            }

            // !launch / !start
            if (lower === '!launch' || lower === '!start' || lower === 'start bot') {
                const result = await launchTenorAgent();
                await sendHumanReply(sock, jid, result.message, msg);
                continue;
            }

            // !stop
            if (lower === '!stop' || lower === 'stop bot') {
                const result = await stopTenorAgent();
                await sendHumanReply(sock, jid, result.message, msg);
                continue;
            }

            // !clean
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

            // !help
            if (lower === '!help' || lower === 'help' || lower === '!commands') {
                const helpText = 
                    `🤖 *MOVIE ASSISTANT COMMANDS*\n` +
                    `──────────────────────────\n` +
                    `🔗 *Paste any Link* -> Auto-saved to link.txt\n` +
                    `📊 *!status* -> Check agent state & queue count\n` +
                    `🚀 *!launch* -> Launch Tenor Agent on PC\n` +
                    `🛑 *!stop* -> Stop Tenor Agent\n` +
                    `🧹 *!clean* -> Deduplicate & tidy link.txt\n` +
                    `🤖 *!ai <prompt>* -> Ask AI (Ollama + OpenRouter fallback)\n` +
                    `──────────────────────────`;
                await sendHumanReply(sock, jid, helpText, msg);
                continue;
            }

            // 3. AI CHATBOT (!ai <prompt> or ai: <prompt>)
            if (lower.startsWith('!ai ') || lower.startsWith('ai ') || lower.startsWith('ai:')) {
                const prompt = text.replace(/^(!ai\s+|ai\s+|ai:\s*)/i, '').trim();
                if (!prompt) {
                    await sendHumanReply(sock, jid, '❓ Please write a question after !ai (e.g. *!ai suggest 5 action movies*)', msg);
                    continue;
                }

                const answer = await queryAIWithFallback(prompt);
                await sendHumanReply(sock, jid, answer, msg);
                continue;
            }
        }
    });
}

startWhatsAppSync().catch(err => {
    console.error('[FATAL] WhatsApp Sync failed to start:', err);
});
