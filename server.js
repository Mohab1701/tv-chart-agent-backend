const log = document.getElementById("log");
const statusEl = document.getElementById("status");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const talkBtn = document.getElementById("talkBtn");

function addMsg(text, cls) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function speak(text) {
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.02;
  window.speechSynthesis.speak(utter);
}

// Finds the TradingView tab (this window is a separate popup window now,
// not the tab itself) and screenshots THAT tab's window. If no TradingView
// tab is open anywhere, this fails clearly rather than capturing the wrong
// thing.
function findTradingViewTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: ["*://*.tradingview.com/*"] }, (tabs) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!tabs || tabs.length === 0) {
        return reject(new Error("No TradingView tab is open. Open tradingview.com first."));
      }
      // Prefer the currently active one if multiple are open.
      const active = tabs.find((t) => t.active) || tabs[0];
      resolve(active);
    });
  });
}

function captureActiveTab() {
  return new Promise((resolve, reject) => {
    findTradingViewTab()
      .then((tab) => {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          chrome.tabs.update(tab.id, { active: true }, () => {
            setTimeout(() => {
              chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (dataUrl) => {
                if (chrome.runtime.lastError || !dataUrl) {
                  reject(chrome.runtime.lastError || new Error("Capture failed"));
                } else {
                  resolve(dataUrl);
                }
              });
            }, 1200);
          });
        });
      })
      .catch(reject);
  });
}

async function askAgent(userText) {
  addMsg(userText || "(chart check)", "user");
  statusEl.textContent = "capturing chart...";
  try {
    const image = await captureActiveTab();
    statusEl.textContent = "thinking...";
    const res = await fetch(BACKEND_URL + "/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, text: userText }),
    });
    if (!res.ok) throw new Error("Backend error " + res.status);
    const data = await res.json();
    addMsg(data.reply, "agent");
    speak(data.reply);
  } catch (err) {
    addMsg("Error: " + err.message, "err");
  } finally {
    statusEl.textContent = "scoped to TradingView tabs only";
  }
}

sendBtn.addEventListener("click", () => {
  const val = textInput.value.trim();
  if (!val) return;
  textInput.value = "";
  askAgent(val);
});
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// ---- Push to talk ----------------------------------------------------
let recognition = null;
let recognizing = false;

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    talkBtn.textContent = "Voice input not supported in this browser";
    talkBtn.disabled = true;
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    askAgent(transcript);
  };
  recognition.onerror = (e) => {
    addMsg("Mic error: " + e.error, "err");
  };
  recognition.onend = () => {
    recognizing = false;
    talkBtn.classList.remove("recording");
    talkBtn.textContent = "🎤 Hold to talk";
  };
}
setupRecognition();

talkBtn.addEventListener("mousedown", () => {
  if (!recognition || recognizing) return;
  recognizing = true;
  talkBtn.classList.add("recording");
  talkBtn.textContent = "🔴 Listening... release when done";
  recognition.start();
});
talkBtn.addEventListener("mouseup", () => {
  if (recognition && recognizing) recognition.stop();
});
talkBtn.addEventListener("mouseleave", () => {
  if (recognition && recognizing) recognition.stop();
});

// ---- Continuous watch --------------------------------------------------
// Runs only while this panel is open. Checks the chart on an interval,
// but only speaks up when the backend says something actually changed —
// every check still costs one API call, so keep the interval sane.
const watchToggle = document.getElementById("watchToggle");
const intervalSelect = document.getElementById("intervalSelect");
const watchStatus = document.getElementById("watchStatus");

let watchTimer = null;
let lastState = ""; // short text summary the backend hands back each check, fed into the next one

async function watchTick() {
  try {
    const image = await captureActiveTab();
    const res = await fetch(BACKEND_URL + "/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, lastState }),
    });
    if (!res.ok) throw new Error("Backend error " + res.status);
    const data = await res.json();
    lastState = data.summary || lastState;

    const stamp = new Date().toLocaleTimeString();
    if (data.alert) {
      addMsg(data.message, "agent");
      speak(data.message);
    } else {
      addMsg(stamp + " — no change", "quiet");
    }
    watchStatus.textContent = "last check: " + stamp;
  } catch (err) {
    watchStatus.textContent = "watch error: " + err.message;
  }
}

watchToggle.addEventListener("change", () => {
  if (watchToggle.checked) {
    const seconds = parseInt(intervalSelect.value, 10);
    watchStatus.textContent = "watching every " + seconds + "s...";
    watchTick(); // check immediately, then on interval
    watchTimer = setInterval(watchTick, seconds * 1000);
  } else {
    clearInterval(watchTimer);
    watchTimer = null;
    watchStatus.textContent = "watch stopped";
  }
});

intervalSelect.addEventListener("change", () => {
  if (watchTimer) {
    clearInterval(watchTimer);
    const seconds = parseInt(intervalSelect.value, 10);
    watchTimer = setInterval(watchTick, seconds * 1000);
    watchStatus.textContent = "watching every " + seconds + "s...";
  }
});

// ---- Combined Trade Setup Analysis (TradingView + Sahm) -------------------
function findTabByUrlPattern(pattern) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: [pattern] }, (tabs) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!tabs || tabs.length === 0) return resolve(null);
      resolve(tabs.find((t) => t.active) || tabs[0]);
    });
  });
}

// captureVisibleTab can only capture whichever tab is CURRENTLY on-screen
// in its window — it cannot reach a background tab just because we found
// it by URL. So before capturing, we explicitly switch to that tab and
// its window, wait briefly for it to render, then capture. This means the
// browser will visibly flip to that tab for a moment — unavoidable given
// how Chrome's capture API works.
function captureTab(tab) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(tab.windowId, { focused: true }, () => {
      chrome.tabs.update(tab.id, { active: true }, () => {
        setTimeout(() => {
          chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
              reject(chrome.runtime.lastError || new Error("Capture failed"));
            } else {
              resolve(dataUrl);
            }
          });
        }, 1200); // give the tab a moment to actually render before capturing
      });
    });
  });
}

function renderPlan(plan) {
  const div = document.createElement("div");
  div.className = "plan";
  if (plan.error) {
    div.innerHTML = `<div style="color:#FB7185">${plan.error}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return;
  }
  const rec = plan.recommendedStrike;
  const entry = plan.recommendedEntry;
  div.innerHTML = `
    <div class="row"><span class="label">Direction</span><span>${plan.direction.toUpperCase()}</span></div>
    <div class="row"><span class="label">Spot</span><span>${plan.spot}</span></div>
    <div class="row"><span class="label">Target</span><span>${plan.target ?? "not read from chart"}</span></div>
    <div class="row"><span class="label">Days to expiration</span><span>${plan.daysToExpiration}</span></div>
    ${plan.entryZone ? `<div class="row"><span class="label">Entry zone</span><span>${plan.entryZone.lower} - ${plan.entryZone.upper}</span></div>` : ""}
    ${rec ? `
    <div class="best">
      <div class="row"><span class="label">Recommended strike</span><span>${rec.strike}</span></div>
      <div class="row"><span class="label">Entry premium</span><span>$${rec.entryPremium}</span></div>
      <div class="row"><span class="label">Delta</span><span>${rec.delta}</span></div>
      ${rec.estimatedReturnPct !== null ? `<div class="row"><span class="label">Est. return @ target</span><span>${rec.estimatedReturnPct}%</span></div>` : ""}
      ${plan.ladder ? `<div class="row"><span class="label">Initial SL (45%)</span><span>$${plan.ladder.initialSLPremium}</span></div>` : ""}
    </div>` : `<div style="color:#FB7185; margin-top:6px;">No strike could be ranked from the chain data.</div>`}
    ${entry ? `
    <div class="best" style="border-top-color:#F5B94255;">
      <div style="color:#F5B942; font-size:11px; margin-bottom:4px;">${entry.waitRequired ? "Wait-for-pullback price (estimate)" : "Pullback zone already reached"}</div>
      <div class="row"><span class="label">Marked zone</span><span>${entry.zoneLower} - ${entry.zoneUpper}</span></div>
      ${entry.waitRequired ? `<div class="row"><span class="label">Est. premium in zone</span><span>$${entry.estimatedPremium}</span></div>` : ""}
      <div style="color:#6B7785; margin-top:4px; font-size:10px;">${entry.note}</div>
    </div>` : ""}
    ${plan.impliedRange ? `
    <div class="best" style="border-top-color:#2A3D4A;">
      <div style="color:#5EC8E8; font-size:11px; margin-bottom:4px;">Market-implied expected range (from IV, not a target)</div>
      <div class="row"><span class="label">If it moves up ~${plan.impliedRange.expectedMovePoints} to ${plan.impliedRange.ifUp.spot}</span><span>$${plan.impliedRange.ifUp.premium}</span></div>
      <div class="row"><span class="label">If it moves down ~${plan.impliedRange.expectedMovePoints} to ${plan.impliedRange.ifDown.spot}</span><span>$${plan.impliedRange.ifDown.premium}</span></div>
    </div>` : ""}
    ${plan.notes && plan.notes.length ? `<div style="color:#6B7785; margin-top:6px; font-size:11px;">${plan.notes.join(" ")}</div>` : ""}
  `;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

const tradePlanBtn = document.getElementById("tradePlanBtn");
tradePlanBtn.addEventListener("click", async () => {
  addMsg("Analyze trade setup", "user");
  statusEl.textContent = "finding tabs...";
  try {
    const [tvTab, sahmTab] = await Promise.all([
      findTabByUrlPattern("*://*.tradingview.com/*"),
      findTabByUrlPattern("*://app.sahmcapital.com/*"),
    ]);
    if (!sahmTab) {
      addMsg("Error: No Sahm options chain tab is open. Open app.sahmcapital.com to an options chain page first.", "err");
      statusEl.textContent = "opens as a window · captures whichever tab has TradingView open";
      return;
    }

    statusEl.textContent = "capturing tabs...";
    const chainImage = await captureTab(sahmTab);
    const chartImage = tvTab ? await captureTab(tvTab) : null;

    // Show thumbnails of exactly what got captured, so a bad capture is
    // immediately visible instead of hiding inside an opaque JSON result.
    const preview = document.createElement("div");
    preview.style.cssText = "display:flex; gap:6px; margin-bottom:8px;";
    preview.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:10px; color:#6B7785; margin-bottom:2px;">Sahm capture</div>
        <img src="${chainImage}" style="width:100%; border:1px solid #1E252D; border-radius:4px;" />
      </div>
      ${chartImage ? `<div style="flex:1;">
        <div style="font-size:10px; color:#6B7785; margin-bottom:2px;">TradingView capture</div>
        <img src="${chartImage}" style="width:100%; border:1px solid #1E252D; border-radius:4px;" />
      </div>` : ""}
    `;
    log.appendChild(preview);
    log.scrollTop = log.scrollHeight;

    statusEl.textContent = "analyzing...";
    const res = await fetch(BACKEND_URL + "/trade-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainImage, chartImage }),
    });
    if (!res.ok) throw new Error("Backend error " + res.status);
    const plan = await res.json();
    renderPlan(plan);
    if (plan.recommendedStrike) {
      speak(`Recommended ${plan.direction} strike ${plan.recommendedStrike.strike}, entry premium ${plan.recommendedStrike.entryPremium} dollars.`);
    }
  } catch (err) {
    addMsg("Error: " + err.message, "err");
  } finally {
    statusEl.textContent = "opens as a window · captures whichever tab has TradingView open";
  }
});
