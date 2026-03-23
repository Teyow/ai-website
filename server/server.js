const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const { URL } = require("url");
const https = require("https");
const http = require("http");

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Basic hardening for frontend usage.
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve static frontend.
app.use(express.static(path.join(__dirname, "..", "public")));

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Default to a model that is commonly available for the v1beta generateContent endpoint.
// Users can override via `GEMINI_MODEL` in `server/.env`.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

if (!PAGESPEED_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn("Missing PAGESPEED_API_KEY in environment.");
}

// ---- In-memory cache (short TTL) ----
const cache = new Map(); // key -> { expiresAt, value }
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function setCached(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function requestWithTimeout(method, urlStr, headers, bodyObj, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var parsed = new URL(urlStr);
    var isHttps = parsed.protocol === "https:";
    var lib = isHttps ? https : http;

    var headersObj = headers || {};
    var bodyText = bodyObj ? JSON.stringify(bodyObj) : null;
    if (bodyText != null) {
      headersObj["Content-Type"] = "application/json";
      headersObj["Content-Length"] = Buffer.byteLength(bodyText);
    }

    var req;
    var timer = setTimeout(function () {
      try {
        if (req) req.abort();
      } catch (e) {
        // ignore
      }
      reject(new Error("Request timed out"));
    }, timeoutMs);

    req = lib.request(
      {
        method: method,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ""),
        headers: headersObj,
      },
      function (res) {
        var data = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          data += chunk;
        });
        res.on("end", function () {
          clearTimeout(timer);
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );

    req.on("error", function (err) {
      clearTimeout(timer);
      reject(err);
    });

    if (bodyText != null) req.write(bodyText);
    req.end();
  });
}

async function requestJson(method, urlStr, headers, bodyObj, timeoutMs) {
  var result = await requestWithTimeout(method, urlStr, headers, bodyObj, timeoutMs);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error("Request failed " + result.statusCode + ": " + result.body);
  }
  try {
    return JSON.parse(result.body);
  } catch (e) {
    return result.body;
  }
}

function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;

  // If user enters "example.com", assume https.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return url.toString();
}

function scoreToPercent(score) {
  // Lighthouse scores are typically 0..1.
  if (typeof score !== "number") return null;
  if (score <= 1) return Math.round(score * 100);
  return Math.round(score);
}

function extractAuditValue(audit) {
  // audits often include `numericValue` + `unit` (ms/s) and/or `displayValue`.
  if (!audit || typeof audit !== "object") return { raw: null, display: null };
  const display = audit.displayValue != null ? audit.displayValue : null;
  const numericValue = audit.numericValue != null ? audit.numericValue : null;
  const unit = audit.unit != null ? audit.unit : null;
  return { raw: { numericValue, unit }, display };
}

function parseTimeToMs(display, raw) {
  const text = String(display != null ? display : "");
  if (text) {
    const msMatch = text.match(/([\d.]+)\s*ms/i);
    if (msMatch) return Number(msMatch[1]);
    const sMatch = text.match(/([\d.]+)\s*s\b/i);
    if (sMatch) return Number(sMatch[1]) * 1000;
  }
  if (raw && typeof raw.numericValue === "number") {
    // unit might be "ms" or "s" in lighthouse.
    if (raw.unit === "ms") return raw.numericValue;
    if (raw.unit === "s") return raw.numericValue * 1000;
  }
  return null;
}

function parseCls(display, raw) {
  const text = String(display != null ? display : "");
  const numMatch = text.match(/([\d.]+)/);
  if (numMatch) return Number(numMatch[1]);
  if (raw && typeof raw.numericValue === "number") return raw.numericValue;
  return null;
}

function cwvStatus(cwv, valueMsOrScore) {
  // Heuristic thresholds:
  // - LCP good <= 2.5s, needs improvement <= 4.0s
  // - INP good <= 200ms, needs improvement <= 500ms
  // - CLS good < 0.1, needs improvement < 0.25
  if (cwv === "LCP") {
    if (valueMsOrScore == null) return null;
    if (valueMsOrScore <= 2500) return "Good";
    if (valueMsOrScore <= 4000) return "Needs Improvement";
    return "Poor";
  }
  if (cwv === "INP") {
    if (valueMsOrScore == null) return null;
    if (valueMsOrScore <= 200) return "Good";
    if (valueMsOrScore <= 500) return "Needs Improvement";
    return "Poor";
  }
  if (cwv === "CLS") {
    if (valueMsOrScore == null) return null;
    if (valueMsOrScore < 0.1) return "Good";
    if (valueMsOrScore < 0.25) return "Needs Improvement";
    return "Poor";
  }
  return null;
}

function buildCwvCards(lhr) {
  const audits = lhr && lhr.audits ? lhr.audits : {};

  const lcpAudit = audits["largest-contentful-paint"];
  const inpAudit = audits["interaction-to-next-paint"];
  const clsAudit = audits["cumulative-layout-shift"];

  const lcp = extractAuditValue(lcpAudit);
  const inp = extractAuditValue(inpAudit);
  const cls = extractAuditValue(clsAudit);

  const lcpMs = parseTimeToMs(lcp.display, lcp.raw);
  const inpMs = parseTimeToMs(inp.display, inp.raw);
  const clsScore = parseCls(cls.display, cls.raw);

  return {
    LCP: {
      value: lcpMs,
      display: lcp.display,
      status: cwvStatus("LCP", lcpMs),
      raw: lcp.raw,
    },
    INP: {
      value: inpMs,
      display: inp.display,
      status: cwvStatus("INP", inpMs),
      raw: inp.raw,
    },
    CLS: {
      value: clsScore,
      display: cls.display,
      status: cwvStatus("CLS", clsScore),
      raw: cls.raw,
    },
  };
}

function buildOptimizationSuggestions(lhr) {
  const audits = lhr && lhr.audits ? lhr.audits : {};
  const suggestions = [];

  for (const [id, audit] of Object.entries(audits)) {
    // Only consider items with a numeric score < 1 (poor/problematic).
    const score = audit ? audit.score : undefined;
    const title = audit ? audit.title : undefined;
    const description = audit ? audit.description || audit.explanation : undefined;
    const explanation = audit ? audit.explanation : null;
    const scoreDisplayMode = audit ? audit.scoreDisplayMode : undefined;

    if (typeof score !== "number") continue;
    if (scoreDisplayMode !== "numeric" && scoreDisplayMode !== "manual") continue;
    if (!title || !description) continue;
    if (score >= 0.95) continue;

    suggestions.push({
      id,
      title,
      score: Math.round(score * 100),
      description: String(description),
      explanation: explanation ? String(explanation) : null,
    });
  }

  suggestions.sort((a, b) => a.score - b.score);
  return suggestions.slice(0, 8);
}

async function runPageSpeed(url, strategy) {
  const cacheKey = `pagespeed::${url}::${strategy}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const apiUrl = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  apiUrl.searchParams.set("url", url);
  apiUrl.searchParams.set("strategy", strategy);
  apiUrl.searchParams.set("category", "performance");
  apiUrl.searchParams.set("key", PAGESPEED_API_KEY);

  const data = await requestJson("GET", apiUrl.toString(), null, null, 35000);
  const lhr = data ? data.lighthouseResult : null;

  const result = {
    performanceScore: scoreToPercent(
      lhr && lhr.categories && lhr.categories.performance ? lhr.categories.performance.score : undefined
    ),
    coreWebVitals: buildCwvCards(lhr),
    optimizationSuggestions: buildOptimizationSuggestions(lhr),
    raw: {
      requestedUrl:
        data && data.lighthouseResult && data.lighthouseResult.requestedUrl != null ? data.lighthouseResult.requestedUrl : null,
      finalUrl:
        data && data.lighthouseResult && data.lighthouseResult.finalUrl != null ? data.lighthouseResult.finalUrl : null,
    },
  };

  setCached(cacheKey, result, 15 * 60 * 1000);
  return result;
}

function buildGeminiPrompt(desktop, mobile) {
  const picks = [];
  const topDesktop = (desktop.optimizationSuggestions || []).slice(0, 5);
  const topMobile = (mobile.optimizationSuggestions || []).slice(0, 5);

  for (const s of topDesktop) {
    picks.push({
      formFactor: "Desktop",
      title: s.title,
      score: s.score,
      description: s.description,
    });
  }
  for (const s of topMobile) {
    picks.push({
      formFactor: "Mobile",
      title: s.title,
      score: s.score,
      description: s.description,
    });
  }

  const desktopCwv = desktop && desktop.coreWebVitals ? desktop.coreWebVitals : null;
  const mobileCwv = mobile && mobile.coreWebVitals ? mobile.coreWebVitals : null;
  const desktopLCP = desktopCwv && desktopCwv.LCP && desktopCwv.LCP.display ? desktopCwv.LCP.display : "N/A";
  const desktopINP = desktopCwv && desktopCwv.INP && desktopCwv.INP.display ? desktopCwv.INP.display : "N/A";
  const desktopCLS = desktopCwv && desktopCwv.CLS && desktopCwv.CLS.display ? desktopCwv.CLS.display : "N/A";
  const mobileLCP = mobileCwv && mobileCwv.LCP && mobileCwv.LCP.display ? mobileCwv.LCP.display : "N/A";
  const mobileINP = mobileCwv && mobileCwv.INP && mobileCwv.INP.display ? mobileCwv.INP.display : "N/A";
  const mobileCLS = mobileCwv && mobileCwv.CLS && mobileCwv.CLS.display ? mobileCwv.CLS.display : "N/A";

  // Prefer strict JSON output so the UI can render priority/quick-win cards reliably.
  return `You are an expert web performance engineer.\n\nAnalyze the following PageSpeed Insights results and explain the main problems in simple, user-friendly language.\n\nReturn ONLY valid JSON (no markdown, no code fences, no extra commentary).\n\nSchema (follow EXACTLY):\n{\n  "overview": string,\n  "priorities": [\n    {\n      "title": string,\n      "problem": string,\n      "whyItMatters": string,\n      "fixPlan": [string],\n      "estimatedImpact": string\n    }\n  ],\n  "quickWins": [string]\n}\n\nRules:\n- priorities should have 3 to 5 items.\n- quickWins should have 3 to 6 items.\n- fixPlan should have 3 to 5 short steps each.\n- Use values from the provided top issues when possible.\n- Keep every string concise (1-2 sentences max).\n\nDesktop Performance Score: ${desktop.performanceScore}\nMobile Performance Score: ${mobile.performanceScore}\nCore Web Vitals (Desktop): LCP=${desktopLCP}, INP=${desktopINP}, CLS=${desktopCLS}\nCore Web Vitals (Mobile): LCP=${mobileLCP}, INP=${mobileINP}, CLS=${mobileCLS}\n\nTop optimization issues (mix desktop+mobile):\n${JSON.stringify(picks, null, 2)}\n`;
}

function extractJsonFromText(text) {
  const str = String(text || "").trim();
  // Try direct parse first.
  try {
    return JSON.parse(str);
  } catch (e) {
    // ignore
  }

  // Fallback: locate first {...} block.
  const first = str.indexOf("{");
  const last = str.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = str.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

function parseGeminiPlainText(aiText) {
  const text = String(aiText != null ? aiText : "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;

  const overviewMatch = text.match(/OVERVIEW:\s*\n([\s\S]*?)\n\s*PRIORITIES:\s*\n/);
  const prioritiesBlockMatch = text.match(/PRIORITIES:\s*\n([\s\S]*?)\n\s*QUICK_WINS:\s*\n/);
  const quickWinsMatch = text.match(/QUICK_WINS:\s*\n([\s\S]*)$/);

  const overview = overviewMatch ? overviewMatch[1].trim() : null;
  const prioritiesBlock = prioritiesBlockMatch ? prioritiesBlockMatch[1] : null;
  const quickWinsBlock = quickWinsMatch ? quickWinsMatch[1] : null;

  const priorities = [];

  if (prioritiesBlock) {
    // Split by each "<index>) Title:" occurrence.
    const itemRegex = /(\d+\)\s*Title:\s*[\s\S]*?)(?=\n\d+\)\s*Title:|\n$)/g;
    const items = String(prioritiesBlock).match(itemRegex) || [];

    for (const itemText of items) {
      // Title line
      const header = itemText.match(/^\s*(\d+\))\s*Title:\s*(.*)$/m);
      const title = header ? header[2].trim() : null;

      const problemMatch = itemText.match(/^\s*Problem:\s*(.*)$/m);
      const whyItMattersMatch = itemText.match(/^\s*Why it matters:\s*(.*)$/m);
      const estimatedImpactMatch = itemText.match(/^\s*Estimated impact:\s*(.*)$/m);
      const problem = problemMatch && problemMatch[1] ? problemMatch[1].trim() : null;
      const whyItMatters = whyItMattersMatch && whyItMattersMatch[1] ? whyItMattersMatch[1].trim() : null;
      const estimatedImpact = estimatedImpactMatch && estimatedImpactMatch[1] ? estimatedImpactMatch[1].trim() : null;

      // Fix plan bullets: lines starting with "- " until next field label or end of item.
      const fixPlanSectionMatch = itemText.match(/Fix plan:\n([\s\S]*?)(?=\nEstimated impact:|\n\d+\)\s*Title:|\s*$)/);
      const fixPlanLines = fixPlanSectionMatch ? fixPlanSectionMatch[1] : "";
      const fixPlan = String(fixPlanLines)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.replace(/^\-\s*/, "").trim())
        .filter(Boolean);

      if (title && (problem || whyItMatters || fixPlan.length)) {
        priorities.push({
          title,
          problem: problem || "",
          whyItMatters: whyItMatters || "",
          fixPlan: fixPlan.length ? fixPlan : [],
          estimatedImpact: estimatedImpact || "",
        });
      }
    }
  }

  const quickWins = [];
  if (quickWinsBlock) {
    for (const line of String(quickWinsBlock).split("\n")) {
      const t = line.trim();
      if (t.startsWith("- ")) {
        const w = t.replace(/^\-\s*/, "").trim();
        if (w) quickWins.push(w);
      }
    }
  }

  if (!overview && !priorities.length && !quickWins.length) return null;
  return {
    overview: overview || "",
    priorities,
    quickWins,
  };
}

async function explainWithGemini(desktopResult, mobileResult) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in environment.");

  const prompt = buildGeminiPrompt(desktopResult, mobileResult);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

  const data = await requestJson(
    "POST",
    url,
    { "x-goog-api-key": GEMINI_API_KEY },
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1600,
        responseMimeType: "application/json",
      },
    },
    45000
  );

  let parts = [];
  if (
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    Array.isArray(data.candidates[0].content.parts)
  ) {
    parts = data.candidates[0].content.parts;
  }

  const aiText = Array.isArray(parts)
    ? parts
        .map(function (p) {
          return p && p.text ? p.text : "";
        })
        .join("")
    : "";

  // Prefer JSON parsing first (deterministic cards).
  const jsonParsed = extractJsonFromText(aiText);
  if (jsonParsed && typeof jsonParsed === "object") {
    return {
      overview: jsonParsed.overview ? String(jsonParsed.overview) : "",
      priorities: Array.isArray(jsonParsed.priorities) ? jsonParsed.priorities : [],
      quickWins: Array.isArray(jsonParsed.quickWins) ? jsonParsed.quickWins : [],
    };
  }

  // Fallback: best-effort parse from plain text.
  const parsed = parseGeminiPlainText(aiText);
  if (parsed) return parsed;

  return { overview: aiText, priorities: [], quickWins: [] };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { url: urlInput, includeAI } = req.body || {};
    const url = normalizeUrl(urlInput);
    if (!url) {
      return res.status(400).json({ error: "Invalid URL. Example: https://example.com" });
    }

    const include = includeAI !== false; // default true

    const [desktop, mobile] = await Promise.all([runPageSpeed(url, "desktop"), runPageSpeed(url, "mobile")]);

    let ai = null;
    if (include) {
      ai = await explainWithGemini(desktop, mobile);
    }

    return res.json({
      inputUrl: url,
      desktop,
      mobile,
      ai,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the response clean for the frontend.
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`SpeedAI server running on http://localhost:${PORT}`);
});

