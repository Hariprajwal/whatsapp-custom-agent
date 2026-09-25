# ⚖️ Legal Disclaimer & Policy Guidelines

## 1. Terms of Service & Third-Party Notice
This project uses `@whiskeysockets/baileys`, an open-source reverse-engineered implementation of WhatsApp's Web Multi-Device protocol. 
* This repository is **not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp LLC, Meta Platforms, Inc.**, or any of their subsidiaries.
* Using third-party software to automate WhatsApp accounts is technically against WhatsApp's official [Terms of Service](https://www.whatsapp.com/legal/).
* **Use this software at your own risk.** The authors and contributors are not responsible for any account suspensions, bans, or data loss.

---

## 2. 🛡️ Built-in Anti-Ban & Safety Safeguards
Unlike automated spam tools that trigger heuristic detection systems, this repository enforces strict **Human Behavior Emulation**:
1. **Dynamic Human Typing Jitter:** All outgoing messages simulate realistic human typing speeds (`40-60 WPM`) with random micro-delays (`1200ms - 3500ms`).
2. **Presence Updates:** The bot explicitly signals `composing` ("typing...") before dispatching messages and `paused` afterward.
3. **Read Receipts:** Messages are marked as read with randomized delays (`400ms - 900ms`) to match natural human reading patterns.
4. **Legitimate Browser Fingerprint:** Emulates a standard desktop Chrome browser header on Windows.
5. **No Mass Outreach:** The bot only replies in authorized groups or direct conversations. It does **not** mass-broadcast, scrape contacts, or cold-message unknown numbers.

---

## 3. 🔒 100% Local-First Privacy Policy
* **Zero Cloud Dependence:** All LLM inference is processed locally through **Ollama** (`localhost:11434`). Your messages, prompts, and personal data are never transmitted to third-party AI APIs (OpenAI, Anthropic, Google).
* **Local Session Storage:** Cryptographic keys and authentication tokens are stored exclusively on your local storage in `auth_info/`.
* **Zero Telemetry:** No analytics, telemetry, or user tracking are embedded in this codebase.
