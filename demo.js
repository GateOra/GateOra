// GateOra Demo Engine v1 (static)
const $ = (id) => document.getElementById(id);

function prettyJSON(obj) {
  return JSON.stringify(obj, null, 2);
}

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[c]));
}

function setBadge(elBadge, verdict) {
  elBadge.classList.remove("allow","warn","block");
  if (verdict === "ALLOW") elBadge.classList.add("allow");
  if (verdict === "WARN") elBadge.classList.add("warn");
  if (verdict === "BLOCK") elBadge.classList.add("block");
  elBadge.textContent = verdict;
}

function addReason(list, title, detail) {
  list.push({ title, detail });
}

// --- Risk engine (heuristics) ---
function evaluate(tx, policies) {
  let score = 0;
  const reasons = [];
  let topSignal = "No critical signals";

  // Approvals
  if (tx.type === "approve") {
    if (tx.allowance === "MAX_UINT") {
      score += 45;
      addReason(reasons, "Unlimited approval", "Allowance is MAX_UINT (unlimited spend).");
      topSignal = "Unlimited approval";

      if (policies.blockUnlimitedApprovals) {
        score = Math.max(score, 85);
        addReason(reasons, "Policy triggered", "Policy blocks unlimited approvals.");
      }
    } else {
      score += 5;
      addReason(reasons, "Limited approval", "Approval amount is limited.");
    }

    if (tx.spenderVerified === false) {
      score += 25;
      addReason(reasons, "Unverified spender", "Spender address is not verified.");
      topSignal = topSignal === "Unlimited approval" ? topSignal : "Unverified spender";
    }
  }

  // Contract reputation
  if (tx.contractReputation === "unknown") {
    score += 15;
    addReason(reasons, "Unknown reputation", "Target has no trusted reputation signals.");

    if (policies.blockUnknownContracts) {
      score = Math.max(score, 80);
      addReason(reasons, "Policy triggered", "Policy blocks unknown contracts.");
      topSignal = "Unknown contract blocked";
    }
  }

  // Contract age
  if (typeof tx.contractAgeDays === "number" && tx.contractAgeDays < 7) {
    score += 10;
    addReason(reasons, "Very new contract", `Contract age is ${tx.contractAgeDays} day(s).`);
    if (topSignal === "No critical signals") topSignal = "Very new contract";
  }

  // High value
  if (typeof tx.valueUSD === "number" && tx.valueUSD >= 5000) {
    score += 15;
    addReason(reasons, "High value", `Estimated value: ~$${tx.valueUSD.toLocaleString()}.`);
    topSignal = "High value transfer";
  }

  // Signatures
  if (tx.type === "sign") {
    score += 20;
    addReason(reasons, "Signature request", "User is asked to sign an off-chain message.");
    topSignal = "Signature request";

    if (tx.domainLookalike) {
      score += 20;
      addReason(reasons, "Lookalike domain", "Domain appears to mimic a known brand.");
      topSignal = "Lookalike domain";
    }

    if (tx.knownDrainerPattern) {
      score += 55;
      addReason(reasons, "Known drainer pattern", "Message matches a known draining signature pattern.");
      topSignal = "Known drainer pattern";
    }
  }

  // Admin risk
  if (tx.upgradeable) {
    score += 12;
    addReason(reasons, "Upgradeable contract", "Upgradeable contracts increase governance/admin risk.");
    if (topSignal === "No critical signals") topSignal = "Upgradeable risk";
  }
  if (tx.adminCanWithdraw) {
    score += 18;
    addReason(reasons, "Admin withdraw privileges", "Admin can withdraw funds or move assets.");
    topSignal = "Admin withdraw privileges";
  }
  if (tx.adminCanPause) {
    score += 10;
    addReason(reasons, "Admin pause privileges", "Admin can pause protocol activity.");
  }

  // Gas anomaly
  if (tx.gasAnomaly) {
    score += 12;
    addReason(reasons, "Gas anomaly", "Unusual fee / gas pattern detected.");
    if (topSignal === "No critical signals") topSignal = "Gas anomaly";
  }

  // Strict mode
  if (policies.strictMode) {
    score += 8;
    addReason(reasons, "Strict mode", "Stricter thresholds applied.");
  }

  score = Math.max(0, Math.min(100, score));

  const warnAt = policies.strictMode ? 40 : 50;
  const blockAt = policies.strictMode ? 70 : 80;

  let verdict = "ALLOW";
  if (score >= blockAt) verdict = "BLOCK";
  else if (score >= warnAt) verdict = "WARN";

  const summary = buildSummary(tx, verdict, score);

  return { score, verdict, reasons, topSignal, summary };
}

function buildSummary(tx, verdict, score) {
  const parts = [];
  parts.push(`Verdict: ${verdict} (Risk ${score}/100).`);

  if (tx.type === "approve") {
    parts.push(`Approval request for ${tx.token || "a token"}.`);
    parts.push(tx.allowance === "MAX_UINT" ? "Approval is unlimited (MAX)." : `Approval amount: ${tx.allowance}.`);
    if (tx.spender) parts.push(`Spender: ${tx.spender}.`);
    if (tx.spenderVerified === false) parts.push("Spender is not verified.");
  } else if (tx.type === "swap") {
    parts.push(`Swap via ${tx.to || "router"} with ${tx.slippage}% slippage.`);
  } else if (tx.type === "transfer") {
    parts.push(`Transfer of ${tx.token || "asset"} to ${tx.to || "recipient"} worth ~$${(tx.valueUSD||0).toLocaleString()}.`);
  } else if (tx.type === "sign") {
    parts.push(`Signature request (${tx.messageType || "message"}) from domain ${tx.domain || "unknown"}.`);
  } else {
    parts.push(`Interaction with ${tx.to || "contract"} on ${tx.chain || "chain"}.`);
  }

  return parts.join(" ");
}

// --- localStorage event log ---
const LOG_KEY = "gateora_demo_log_v1";

function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLog(entries) {
  localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(0, 50)));
}

function renderLog(logBody, entries) {
  logBody.innerHTML = "";
  entries.slice(0, 10).forEach(e => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHTML(e.time)}</td>
      <td>${escapeHTML(e.scenario)}</td>
      <td><span class="demo-pill ${e.verdict.toLowerCase()}">${escapeHTML(e.verdict)}</span></td>
      <td>${e.score}</td>
      <td class="muted">${escapeHTML(e.topSignal)}</td>
    `;
    logBody.appendChild(tr);
  });
}

// --- boot ---
async function main() {
  const elScenario = $("scenario");
  const elInput = $("txInput");

  const elScore = $("score");
  const elGauge = $("gauge");
  const elBadge = $("badge");
  const elVerdictNote = $("verdictNote");
  const elReasons = $("reasons");
  const elSummary = $("summary");
  const logBody = $("logBody");

  const polBlockUnlimited = $("polBlockUnlimited");
  const polBlockUnknown = $("polBlockUnknown");
  const polStrictMode = $("polStrictMode");
  const polExplainMore = $("polExplainMore");

  // Load scenarios
  const res = await fetch("./data/scenarios.json");
  const data = await res.json();
  const scenarios = data.scenarios || [];

  // Fill dropdown
  scenarios.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    elScenario.appendChild(opt);
  });

  // initial log
  let entries = loadLog();
  renderLog(logBody, entries);
const elPack = document.getElementById("policyPack");

function applyPack(pack) {
  if (pack === "basic") {
    polBlockUnlimited.checked = true;
    polBlockUnknown.checked = false;
    polStrictMode.checked = false;
    polExplainMore.checked = true;
  }
  if (pack === "strict") {
    polBlockUnlimited.checked = true;
    polBlockUnknown.checked = true;
    polStrictMode.checked = true;
    polExplainMore.checked = true;
  }
  if (pack === "degen") {
    polBlockUnlimited.checked = false;
    polBlockUnknown.checked = false;
    polStrictMode.checked = false;
    polExplainMore.checked = false;
  }
}

  function getPolicies() {
    return {
      blockUnlimitedApprovals: polBlockUnlimited.checked,
      blockUnknownContracts: polBlockUnknown.checked,
      strictMode: polStrictMode.checked,
      explainMore: polExplainMore.checked
    };
  }

  function renderResult(result) {
    elScore.textContent = String(result.score);
    elGauge.style.setProperty("--score", result.score);
    setBadge(elBadge, result.verdict);

    if (result.verdict === "ALLOW") elVerdictNote.textContent = "Looks safe based on current signals.";
    if (result.verdict === "WARN") elVerdictNote.textContent = "Potential risk detected. Review signals before proceeding.";
    if (result.verdict === "BLOCK") elVerdictNote.textContent = "High risk detected. Transaction should be blocked.";

    elReasons.innerHTML = "";
    if (polExplainMore.checked) {
      const ul = document.createElement("ul");
      ul.className = "demo-reason-list";
      result.reasons.slice(0, 8).forEach(r => {
        const li = document.createElement("li");
        li.innerHTML = `<b>${escapeHTML(r.title)}:</b> <span class="muted">${escapeHTML(r.detail)}</span>`;
        ul.appendChild(li);
      });
      elReasons.appendChild(ul);
    }

    elSummary.textContent = result.summary;
  }

  function loadScenarioById(id) {
    const sc = scenarios.find(s => s.id === id) || scenarios[0];
    elScenario.value = sc.id;
    elInput.value = prettyJSON(sc.tx);
    return sc;
  }

  function analyze() {
    let tx;
    try {
      tx = JSON.parse(elInput.value);
    } catch {
      alert("Invalid JSON. Please use valid JSON format.");
      return null;
    }

    const policies = getPolicies();
    const sc = scenarios.find(s => s.id === elScenario.value) || { name: "Custom" };

    const result = evaluate(tx, policies);
    renderResult(result);

    // log
    const entry = {
      time: nowTime(),
      scenario: sc.name,
      verdict: result.verdict,
      score: result.score,
      topSignal: result.topSignal
    };
    entries = [entry, ...entries];
    saveLog(entries);
    renderLog(logBody, entries);

    return { tx, sc, result };
  }

  // Wire buttons
  $("btnAnalyze").addEventListener("click", analyze);

  elScenario.addEventListener("change", () => {
    loadScenarioById(elScenario.value);
  });

  $("btnRandom").addEventListener("click", () => {
    const pick = scenarios[Math.floor(Math.random() * scenarios.length)];
    loadScenarioById(pick.id);
    analyze();
  });

  $("btnReset").addEventListener("click", () => {
    loadScenarioById(scenarios[0].id);
    elScore.textContent = "0";
    elGauge.style.setProperty("--score", 0);
    setBadge(elBadge, "ALLOW");
    elVerdictNote.textContent = "Low risk behavior detected.";
    elReasons.innerHTML = "";
    elSummary.textContent = "Select a scenario and click Analyze.";
  });

  $("btnCopy").addEventListener("click", async () => {
    const out = analyze();
    if (!out) return;

    const report = [
      "GateOra Live Demo Report",
      `Scenario: ${out.sc.name}`,
      `Verdict: ${out.result.verdict}`,
      `Risk Score: ${out.result.score}/100`,
      "",
      "Top signals:",
      ...out.result.reasons.slice(0, 8).map(r => `- ${r.title}: ${r.detail}`),
      "",
      "Transaction JSON:",
      JSON.stringify(out.tx, null, 2)
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      alert("Report copied to clipboard.");
    } catch {
      alert("Copy failed (browser permissions).");
    }
  });

  $("btnSimulate").addEventListener("click", async () => {
    const picks = ["phishing_signature_drainer", "unlimited_approval_unknown", "new_contract_high_value"]
      .map(id => scenarios.find(s => s.id === id))
      .filter(Boolean);

    for (const sc of picks) {
      loadScenarioById(sc.id);
      analyze();
      await new Promise(r => setTimeout(r, 550));
    }
  });

  $("btnAllowOnce").addEventListener("click", () => alert("ALLOW ONCE (demo action)."));
  $("btnBlock").addEventListener("click", () => alert("BLOCK (demo action)."));

  // default scenario
  loadScenarioById(scenarios[0].id);
  elSummary.textContent = "Select a scenario and click Analyze.";
}

main().catch((e) => {
  console.error(e);
  alert("Demo failed to load. Check console for details.");
});
