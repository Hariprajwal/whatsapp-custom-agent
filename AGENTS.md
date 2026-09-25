# 🤖 AGENTS.md — AI Agent & Developer Architecture Guide

> **Target Audience:** Autonomous AI coding agents, LLM crawlers (Perplexity, Cursor, Copilot, Gemini), and automation architects.
> **Repository:** [Hariprajwal/whatsapp-custom-agent](https://github.com/Hariprajwal/whatsapp-custom-agent)

---

## 1. System Mission & Philosophy

`whatsapp-custom-agent` is an autonomous, dual-engine WhatsApp automation gateway and local LLM bridge designed to operate on Windows systems. It serves two distinct operational modalities:
1. **Link Ingestion & Process Orchestration (`index.js`):** Continuously monitors WhatsApp group traffic (matching keyword `"movie"`), sanitizes incoming URLs against junk/trackers (e.g. JioSphere), deduplicates into a target queue (`link.txt`), and exposes RPC-like commands (`!status`, `!launch`, `!stop`, `!clean`) to control desktop automation processes.
2. **Multi-Turn Conversational Companion (`standalone_chat.js`):** Provides a 100% local-first conversational interface powered by local **Ollama** models (`llama3.2`, `qwen2.5`) with an automatic zero-config failover to **OpenRouter Cloud API** (`openrouter/free`) for 100% uptime.

---

## 2. Core Architecture & Tech Stack

```
                          ┌───────────────────────────┐
                          │    WhatsApp Network       │
                          │   (Multi-Device E2EE)     │
                          └─────────────┬─────────────┘
                                        │ WebSockets (Noise Protocol)
                                        ▼
                          ┌───────────────────────────┐
                          │   @whiskeysockets/baileys │
                          │   (~25MB RAM, Headless)   │
                          └─────────────┬─────────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
              [Human Emulation Engine]       [Command Dispatcher]
              • Randomized WPM delays         • URL regex extractor
              • "composing" presence          • RPC process manager
              • Mark as read receipts         • Dual AI routing
                         │                             │
                         ▼                             ▼
              ┌─────────────────────┐       ┌─────────────────────┐
              │  Local Ollama LLM   │       │  OpenRouter Cloud   │
              │  (Port 11434)       │◄─────►│  (Failover Backup)  │
              └─────────────────────┘       └─────────────────────┘
```

* **Runtime:** Node.js v18+ (tested on Node v24).
* **Protocol Implementation:** `@whiskeysockets/baileys` (WebSockets direct protocol, no Chromium/Puppeteer).
* **AI Providers:**
  * **Primary:** Ollama Local API (`http://localhost:11434/api/generate` and `/api/chat`).
  * **Secondary / Fallback:** OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`).
* **Session Persistence:** `useMultiFileAuthState` saving granular cryptographic keys to `auth_info/`.
* **Logging:** `pino` (configured to `silent` in production to prevent console spam).

---

## 3. Human Simulation & Anti-Ban Heuristics

Any agent modifying or extending this repository **MUST** adhere to the following anti-ban constraints:

1. **Typing Indicator Simulation:** Never dispatch messages without calling `sock.sendPresenceUpdate('composing', jid)` first, followed by `paused`.
2. **Dynamic Jitter Latency:** Outgoing message delays must never be fixed. Use `Math.min(3500, Math.max(1200, text.length * 20 + jitter))` where jitter is between 300ms and 700ms.
3. **Read Receipts:** Inbound messages must be explicitly acknowledged via `sock.readMessages([msg.key])` with a natural 400ms–900ms human cognitive delay.
4. **Browser Fingerprinting:** Keep the client signature aligned with standard desktop environments: `['Chrome (Windows)', 'Desktop', '124.0.0.0']`.
5. **No Cold Outreach:** Restrict outgoing messages strictly to explicit triggers (commands, mentions, or monitored groups). Do not initiate unsolicited outbound conversations.

---

## 4. Message Flow & Processing Schema

### A. Link Queue Pipeline
```typescript
interface LinkIngestionFlow {
  input: string; // raw WhatsApp message text
  regex: /https?:\/\/[^\s<>"'{}|\\^`]+[^\s<>"'{}|\\^`.,;:?!()\[\]]/gi;
  filter: (url: string) => boolean; // rejects /jiosphere\.com/i
  deduplicate: (url: string, file: string) => boolean; // checks link.txt
  output: void; // fs.appendFileSync(link.txt, url + '\n')
}
```

### B. Dual-Tier AI Routing Protocol
```typescript
async function routeAIQuery(prompt: string): Promise<string> {
  // Step 1: Probe Local Ollama with 7000ms race timeout
  const localResponse = await queryLocalOllama(prompt, timeout: 7000);
  if (localResponse) return localResponse;

  // Step 2: On timeout, network failure, or offline state, route to OpenRouter
  if (config.openrouter.apiKey) {
    const cloudResponse = await queryOpenRouter(prompt, model: 'openrouter/free');
    if (cloudResponse) return cloudResponse;
  }

  // Step 3: Graceful degradation notification
  return "⚠️ AI service unavailable.";
}
```

---

## 5. Process Controller (Windows RPC)

Commands executed from WhatsApp (`!launch`, `!stop`, `!status`) interface with the Windows OS:
* **Detection:** Query Windows processes using PowerShell:
  `Get-CimInstance Win32_Process | Where-Object CommandLine -like "*tenor_agent.py*"`
* **Launch:** Detached, unreferenced child process:
  `spawn('cmd.exe', ['/c', 'start', 'Tenor Agent', 'cmd', '/k', 'python tenor_agent.py'], { detached: true, stdio: 'ignore' })`
* **Termination:** Force-kill targeted process tree without collateral termination of parent Node/Python processes.

---

## 6. Directory Layout & File Contracts

| File | Purpose / Contract |
| :--- | :--- |
| `config.js` | Single source of truth. Auto-loads `.env` from local or parent directory. Exposes group keywords, Ollama ports, OpenRouter keys, and safety timeouts. |
| `index.js` | Main daemon: WhatsApp listener, link sanitizer, Windows process controller, and dual-tier AI fallback. |
| `standalone_chat.js` | Independent chatbot: multi-turn conversational memory (`MAX_HISTORY_TURNS = 8`), dynamic model switcher (`!model`), host diagnostics. |
| `DISCLAIMER.md` | Legal compliance, WhatsApp Terms of Service notices, and privacy guarantees. |
| `llms.txt` | Standard machine-readable project summary for AI search engines. |

---

## 7. Guidelines for AI Agents & Modifiers

* **Preserve `auth_info/` in `.gitignore`:** Under no circumstances should cryptographic session tokens or `.env` files be tracked or staged.
* **Keep Dependencies Minimal:** Avoid introducing heavyweight dependencies (e.g. Puppeteer, Playwright, or Electron). Maintain the pure WebSocket architecture of Baileys.
* **Preserve Dual Fallback:** Always ensure that any modification to AI routes maintains the local-first Ollama priority while guaranteeing the OpenRouter cloud failover.
