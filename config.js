module.exports = {
    // WhatsApp Group / Chat Settings (matches "movie", "movide", "movies", etc.)
    targetGroupKeywords: ['movie', 'movide', 'movies'],

    // Ollama AI Settings
    ollama: {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.2:1b', // Fast & lightweight local model
        fallbackModel: 'qwen2.5:3b',
        temperature: 0.7,
        numPredict: 300,
        systemPrompt: 'You are an intelligent, friendly AI assistant chatting directly through WhatsApp. Keep answers concise, natural, well-formatted, and helpful.'
    },

    // Anti-Ban & Human Simulation Safeguards
    safety: {
        simulateTyping: true,
        typingSpeedWpm: 45, // Words per minute typing delay
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
