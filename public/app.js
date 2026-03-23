const el = (id) => document.getElementById(id);

function statusChip(status) {
  if (!status) return "";
  if (status === "Good") {
    return `<span class="inline-flex items-center rounded-full bg-teal-100 px-3 py-1 text-teal-700 font-semibold">Good</span>`;
  }
  if (status === "Needs Improvement") {
    return `<span class="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-amber-700 font-semibold">Needs Improvement</span>`;
  }
  if (status === "Poor") {
    return `<span class="inline-flex items-center rounded-full bg-rose-100 px-3 py-1 text-rose-700 font-semibold">Poor</span>`;
  }
  return `<span class="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-slate-700 font-semibold">${status}</span>`;
}

function setCwv(containerPrefix, cwv) {
  const lcp = cwv?.LCP;
  const inp = cwv?.INP;
  const cls = cwv?.CLS;

  const setOne = (key, valueEl, statusEl) => {
    const item = cwv?.[key];
    const v = item?.display || (item?.value != null ? String(item.value) : "--");
    valueEl.textContent = v || "--";
    statusEl.innerHTML = statusChip(item?.status);
  };

  setOne("LCP", el(`${containerPrefix}LCPVal`), el(`${containerPrefix}LCPStatus`));
  setOne("INP", el(`${containerPrefix}INPVal`), el(`${containerPrefix}INPStatus`));
  setOne("CLS", el(`${containerPrefix}CLSVal`), el(`${containerPrefix}CLSStatus`));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAi(ai) {
  const overviewEl = el("aiOverview");
  const prioritiesEl = el("aiPriorities");
  const quickWinsEl = el("aiQuickWins");

  overviewEl.textContent = "";
  prioritiesEl.innerHTML = "";
  quickWinsEl.innerHTML = "";

  if (!ai) {
    overviewEl.textContent = "AI explanation is currently unavailable.";
    return;
  }

  if (ai.overview) {
    overviewEl.innerHTML = `<div class="whitespace-pre-wrap">${escapeHtml(String(ai.overview))}</div>`;
  } else {
    overviewEl.textContent = "";
  }

  const priorities = Array.isArray(ai.priorities) ? ai.priorities : [];
  if (priorities.length) {
    prioritiesEl.innerHTML = priorities
      .map((p, idx) => {
        return `
          <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="text-sm font-bold text-slate-900">#${idx + 1} ${escapeHtml(p.title)}</div>
                <div class="mt-2 text-sm text-slate-700 font-semibold">Problem</div>
                <div class="mt-1 text-sm text-slate-600">${escapeHtml(p.problem)}</div>
              </div>
            </div>
            <div class="mt-3 text-sm text-slate-700 font-semibold">Why it matters</div>
            <div class="mt-1 text-sm text-slate-600">${escapeHtml(p.whyItMatters)}</div>
            ${
              Array.isArray(p.fixPlan) && p.fixPlan.length
                ? `<div class="mt-3 text-sm text-slate-700 font-semibold">Fix plan</div>
                   <ul class="mt-2 list-disc pl-5 text-sm text-slate-600">
                     ${p.fixPlan.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}
                   </ul>`
                : ""
            }
            ${p.estimatedImpact ? `<div class="mt-3 text-sm text-slate-700 font-semibold">Estimated impact</div>
              <div class="mt-1 text-sm text-slate-600">${escapeHtml(p.estimatedImpact)}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  const quickWins = Array.isArray(ai.quickWins) ? ai.quickWins : [];
  if (quickWins.length) {
    quickWinsEl.innerHTML = `
      <div class="mt-2 text-sm font-semibold text-slate-700">Quick wins</div>
      <ul class="mt-2 list-disc pl-5 text-sm text-slate-600">
        ${quickWins.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}
      </ul>
    `;
  }
}

function renderSuggestions(suggestions) {
  const list = el("suggestionsList");
  list.innerHTML = "";

  const items = Array.isArray(suggestions) ? suggestions : [];
  if (!items.length) {
    list.innerHTML = `<li class="text-sm text-slate-500">No optimization suggestions returned.</li>`;
    return;
  }

  list.innerHTML = items
    .map((s) => {
      return `
        <li class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0 pr-2">
              <div class="text-sm font-bold text-slate-900">${escapeHtml(s.title)}</div>
              <div class="mt-2 text-sm text-slate-600 break-words whitespace-normal">
                ${escapeHtml(s.description)}
              </div>
            </div>
            <div class="shrink-0 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 border border-slate-200">
              ${typeof s.score === "number" ? `${s.score}` : "--"}%
            </div>
          </div>
        </li>
      `;
    })
    .join("");
}

async function analyze(url) {
  const loading = el("loadingState");
  const errorBox = el("errorBox");
  const dashboard = el("dashboard");

  loading.classList.remove("hidden");
  errorBox.classList.add("hidden");
  errorBox.textContent = "";

  dashboard.classList.add("hidden");

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, includeAI: true }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed: ${res.status}`);
  }
  return data;
}

function setLoadingButtons(isLoading) {
  const buttons = document.querySelectorAll("[data-analyze]");
  buttons.forEach((b) => {
    b.disabled = isLoading;
    b.classList.toggle("opacity-60", isLoading);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const input = el("siteUrl");
  const errorBox = el("errorBox");
  const loading = el("loadingState");
  const dashboard = el("dashboard");
  const inputEcho = el("inputEcho");

  const run = async () => {
    const url = input.value.trim();
    if (!url) {
      errorBox.textContent = "Please enter a website URL.";
      errorBox.classList.remove("hidden");
      return;
    }

    setLoadingButtons(true);
    try {
      const data = await analyze(url);

      loading.classList.add("hidden");
      dashboard.classList.remove("hidden");
      inputEcho.textContent = `Analyzing: ${data?.inputUrl || url}`;

      const desktop = data?.desktop || {};
      const mobile = data?.mobile || {};

      el("desktopScore").textContent = typeof desktop?.performanceScore === "number" ? desktop.performanceScore : "--";
      el("mobileScore").textContent = typeof mobile?.performanceScore === "number" ? mobile.performanceScore : "--";

      setCwv("desktop", desktop?.coreWebVitals);
      setCwv("mobile", mobile?.coreWebVitals);

      renderSuggestions(desktop?.optimizationSuggestions || []);
      renderAi(data?.ai || null);

      // Scroll into view so user sees the results immediately.
      dashboard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      loading.classList.add("hidden");
      errorBox.textContent = err?.message ? String(err.message) : "Something went wrong.";
      errorBox.classList.remove("hidden");
    } finally {
      setLoadingButtons(false);
    }
  };

  const buttons = document.querySelectorAll("[data-analyze]");
  buttons.forEach((b) => b.addEventListener("click", run));
});

