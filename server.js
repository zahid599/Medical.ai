import express from "express";
import dotenv from "dotenv";
import path from "path";
import dns from "dns";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

dns.setDefaultResultOrder("ipv4first");
dotenv.config();

// ---------- Debug helpers ----------
// Keep false for the public site. Set to true only while testing locally.
const DEBUG = false;

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

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  log(`${req.method} ${req.url}`);
  next();
});

const PORT = process.env.PORT || 3000;
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

log("Node version:", process.version);
log("API key loaded:", Boolean(apiKey));

// ---------- Website files ----------
// Used when running locally (node server.js).
// On Vercel this line is ignored and the "public" folder is served from the CDN.
app.use(express.static(path.join(__dirname, "public")));

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
          info.status || info.causeCode || info.name
        );

        // Quota exceeded or model missing: retrying the same model won't help
        if (info.status === 429 || info.status === 404) {
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

  throw lastError;
}

// ---------- Chat route ----------
app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: "The server is missing its Gemini API key."
      });
    }

    const { message, history = [], language = "en-IN" } = req.body || {};

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

    res.json({
      reply: response.text || "Sorry, I could not generate a response."
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
        : "AI connection failed. Please try again later.";

    if (DEBUG) {
      text += ` [debug: ${info.status || info.causeCode || info.name} - ${info.message}]`;
    }

    res.status(quota ? 429 : busy ? 503 : 500).json({ error: text });
  }
});

// ---------- Health check ----------
app.get("/api/health", (req, res) => {
  res.json({
    status: "MedAura server is working",
    aiConfigured: Boolean(ai)
  });
});

// ---------- Start ----------
// Locally: starts a server on port 3000.
// On Vercel: the app is exported below and Vercel runs it as a function.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`MedAura running at http://localhost:${PORT}`);
  });
}

export default app;