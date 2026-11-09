import express from "express";
import dotenv from "dotenv";
import path from "path";
import dns from "dns";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

dns.setDefaultResultOrder("ipv4first");
dotenv.config();

// ---------- Debug helpers ----------
const DEBUG = true; // set to false when everything works

const log = (...args) => {
  if (DEBUG) console.log(new Date().toISOString(), "[DEBUG]", ...args);
};

function describeError(error) {
  return {
    name: error?.name,
    status: error?.status,
    message: String(error?.message || error).slice(0, 1500),
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message
  };
}

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  log(`${req.method} ${req.url}`);
  next();
});

const PORT = 3000;
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

log("Node version:", process.version);
log("API key loaded:", Boolean(apiKey), apiKey ? `(length ${apiKey.length})` : "");

// ---------- Website files ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));

const systemPrompt = `
You are MedAura, an educational AI health assistant.

Your job is to explain general health information in simple language.

You can answer questions about fever, common cold, cough, headache,
sore throat, stomach pain, tiredness and general health education.

IMPORTANT RULES:
1. Never claim to diagnose a disease.
2. Never prescribe medicines or dosages.
3. Explain that symptoms can have multiple causes.
4. Ask relevant follow-up questions when helpful.
5. Explain warning signs that need medical attention.
6. For chest pain, breathing difficulty, severe bleeding, fainting,
   sudden weakness or other emergency symptoms, tell the user to seek
   emergency medical care immediately.
7. In India, the emergency number is 112.
8. Encourage users to consult a qualified doctor.
9. Use clear, friendly and understandable language.
10. Reply in the language selected by the user.

You are an educational assistant, not a doctor.
`;

// ---------- Gemini calls with fallback ----------
const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateWithFallback(params) {
  let lastError;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      log(`Trying model ${model}, attempt ${attempt}...`);

      try {
        const result = await ai.models.generateContent({ ...params, model });
        log(`SUCCESS with ${model} in ${Date.now() - started} ms`);
        return result;
      } catch (error) {
        lastError = error;
        const info = describeError(error);
        console.warn(
          `[FAIL] ${model} attempt ${attempt} after ${Date.now() - started} ms:`,
          info
        );

        // Quota exceeded or model missing: retrying the same model won't help
        if (info.status === 429 || info.status === 404) {
          log(`${model} unavailable (${info.status}), moving to next model`);
          break;
        }

        const isNetworkError = !info.status;
        const isTemporary = [500, 503].includes(info.status);

        if (!isNetworkError && !isTemporary) {
          throw error;
        }

        await sleep(1000 * attempt);
      }
    }
  }

  log("All models failed");
  throw lastError;
}

// ---------- Chat route ----------
app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: "Gemini API key is missing. Check your .env file."
      });
    }

    const { message, history = [], language = "en-IN" } = req.body;

    log("Chat request:", {
      messageLength: typeof message === "string" ? message.length : message,
      historyItems: Array.isArray(history) ? history.length : "not an array",
      language
    });

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Please enter a message." });
    }

    const languageNames = {
      "en-IN": "English",
      "hi-IN": "Hindi",
      "kn-IN": "Kannada"
    };

    const contents = (Array.isArray(history) ? history.slice(-16) : [])
      .filter(
        (item) =>
          item &&
          ["user", "model"].includes(item.role) &&
          typeof item.text === "string"
      )
      .map((item) => ({
        role: item.role,
        parts: [{ text: item.text.slice(0, 4000) }]
      }));

    contents.push({ role: "user", parts: [{ text: message.slice(0, 4000) }] });

    const response = await generateWithFallback({
      contents,
      config: {
        systemInstruction:
          systemPrompt +
          "\nRespond in " +
          (languageNames[language] || "English") +
          ".",
        temperature: 0.4,
        maxOutputTokens: 700
      }
    });

    const reply = response.text;
    log("Reply length:", reply ? reply.length : 0);

    res.json({
      reply: reply || "Sorry, I could not generate a response."
    });
  } catch (error) {
    const info = describeError(error);
    console.error("[CHAT ERROR]", info);

    const quota = info.status === 429;
    const busy = !info.status || [503, 500].includes(info.status);

    let text = quota
      ? "The AI quota is used up for now. Please try again in a few minutes."
      : busy
        ? "The AI service is busy right now. Please try again in a moment."
        : "AI connection failed. Check your API key and internet connection.";

    if (DEBUG) {
      text += ` [debug: ${info.status || info.causeCode || info.name} - ${info.message}]`;
    }

    res.status(quota ? 429 : busy ? 503 : 500).json({ error: text });
  }
});

// ---------- Health and diagnostics ----------
app.get("/api/health", (req, res) => {
  res.json({
    status: "MedAura server is working",
    aiConfigured: Boolean(ai)
  });
});

app.get("/api/debug", async (req, res) => {
  const report = {
    node: process.version,
    keyLoaded: Boolean(apiKey),
    network: null,
    models: []
  };

  try {
    const started = Date.now();
    const r = await fetch("https://generativelanguage.googleapis.com/");
    report.network = { reachable: true, httpStatus: r.status, ms: Date.now() - started };
  } catch (error) {
    report.network = { reachable: false, error: describeError(error) };
  }

  if (ai) {
    for (const model of MODELS) {
      const started = Date.now();
      try {
        const r = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: "Say OK" }] }],
          config: { maxOutputTokens: 20 }
        });
        report.models.push({ model, ok: true, ms: Date.now() - started, reply: r.text });
      } catch (error) {
        report.models.push({
          model,
          ok: false,
          ms: Date.now() - started,
          error: describeError(error)
        });
      }
    }
  }

  res.json(report);
});

app.listen(PORT, () => {
  console.log(`MedAura running at http://localhost:${PORT}`);
});