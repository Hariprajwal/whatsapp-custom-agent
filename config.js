const fs = require('fs');
const path = require('path');

// Auto-load .env from current dir or parent dir
(function loadEnv() {
    const candidates = [
        path.resolve(__dirname, '.env'),
        path.resolve(__dirname, '..', '.env')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                        const [k, ...v] = trimmed.split('=');
                        const key = k.trim();
                        const val = v.join('=').trim();
                        if (!process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                }
            } catch (e) {}
        }
    }
})();

module.exports = {
    // WhatsApp Group / Chat Settings (matches "movie", "movide", "movies", etc.)
    targetGroupKeywords: ['movie', 'movide', 'movies'],

    // Primary AI: Local Ollama (100% Free, Private, Local)
    ollama: {
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        defaultModel: 'llama3.2:1b',
        fallbackModel: 'qwen2.5:3b',
        temperature: 0.7,
        numPredict: 300,
        systemPrompt: 'You are an intelligent, friendly AI assistant chatting directly through WhatsApp. Keep answers concise, natural, well-formatted, and helpful.'
    },

    // Secondary AI: OpenRouter Cloud Fallback (When Ollama is offline/unreachable)
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        defaultModel: 'openrouter/free', // Automatically routes to the best free live model
        fallbackModel: 'google/gemini-2.0-flash-lite-preview:free',
        siteUrl: 'https://github.com/Hariprajwal/whatsapp-custom-agent',
        siteName: 'WhatsApp Custom Agent'
    },

    // Anti-Ban & Human Simulation Safeguards
    safety: {
        simulateTyping: true,
        typingSpeedWpm: 45,
        minTypingDelayMs: 1200,
        maxTypingDelayMs: 3500,
        markAsReadDelayMinMs: 400,
        markAsReadDelayMaxMs: 900,
        quoteOriginalMessage: true,
        browserSignature: ['Chrome (Windows)', 'Desktop', '124.0.0.0']
    },

    // File Paths
    paths: {
        linkFile: '../link.txt',
        authDir: './auth_info'
    }
};
