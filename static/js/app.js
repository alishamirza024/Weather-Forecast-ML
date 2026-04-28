// ─────────────────────────────────────────────
// ForecastIQ — app.js
// ─────────────────────────────────────────────

let tempChart     = null;
let humidityChart = null;
let rainChart     = null;
let currentCity   = "";
let currentMode   = "General";
let lastWeatherData = null;
let bookmarks     = JSON.parse(localStorage.getItem("forecastiq_bookmarks") || "[]");
let localRecentSearches = [];

const weatherEmoji = {
  Clear:"☀️", Clouds:"☁️", Rain:"🌧️", Drizzle:"🌦️",
  Thunderstorm:"⛈️", Snow:"❄️", Mist:"🌫️", Fog:"🌫️",
  Haze:"🌫️", Smoke:"🌫️", Dust:"🌪️", Sand:"🌪️", Tornado:"🌪️",
};


// ─────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────
function getAutoTheme() {
  const h = new Date().getHours();
  return (h >= 6 && h < 20) ? "light" : "dark";
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("toggleIcon").textContent = theme === "dark" ? "🌙" : "☀️";
  localStorage.setItem("forecastiq_theme", theme);
  redrawChartsForTheme();
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
}
(function initTheme() {
  applyTheme(localStorage.getItem("forecastiq_theme") || getAutoTheme());
})();


// ─────────────────────────────────────────────
// WEATHER CANVAS ANIMATION
// ─────────────────────────────────────────────
const canvas = document.getElementById("weatherCanvas");
const ctx    = canvas.getContext("2d");
let particles    = [];
let animType     = "clear";

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

function createParticles(type) {
  particles = []; animType = type;
  if (type === "rain") {
    for (let i=0; i<120; i++) particles.push({
      x: Math.random()*canvas.width, y: Math.random()*canvas.height,
      speed: 8+Math.random()*6, length: 15+Math.random()*15, opacity: 0.3+Math.random()*0.4
    });
  } else if (type === "snow") {
    for (let i=0; i<80; i++) particles.push({
      x: Math.random()*canvas.width, y: Math.random()*canvas.height,
      r: 2+Math.random()*4, speed: 0.5+Math.random()*1.5,
      drift: (Math.random()-0.5)*0.5, opacity: 0.4+Math.random()*0.4
    });
  } else if (type === "clouds") {
    for (let i=0; i<6; i++) particles.push({
      x: Math.random()*canvas.width, y: 60+Math.random()*200,
      r: 60+Math.random()*80, speed: 0.2+Math.random()*0.3, opacity: 0.08+Math.random()*0.1
    });
  }
}

function animateWeather() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (animType === "rain") {
    ctx.strokeStyle = isDark ? "rgba(120,180,255,0.6)" : "rgba(60,100,200,0.4)";
    ctx.lineWidth = 1.5;
    particles.forEach(p => {
      ctx.globalAlpha = p.opacity;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x-2, p.y+p.length); ctx.stroke();
      p.y += p.speed;
      if (p.y > canvas.height) { p.y = -20; p.x = Math.random()*canvas.width; }
    });
  } else if (animType === "snow") {
    ctx.fillStyle = isDark ? "rgba(220,240,255,0.9)" : "rgba(150,180,220,0.8)";
    particles.forEach(p => {
      ctx.globalAlpha = p.opacity;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
      p.y += p.speed; p.x += p.drift;
      if (p.y > canvas.height) { p.y = -10; p.x = Math.random()*canvas.width; }
    });
  } else if (animType === "clouds") {
    ctx.fillStyle = isDark ? "rgba(255,255,255,1)" : "rgba(100,130,200,1)";
    particles.forEach(p => {
      ctx.globalAlpha = p.opacity;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
      ctx.arc(p.x+p.r*0.6, p.y-p.r*0.3, p.r*0.7, 0, Math.PI*2); ctx.fill();
      p.x += p.speed;
      if (p.x > canvas.width+p.r*2) p.x = -p.r*2;
    });
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(animateWeather);
}
animateWeather();

function setWeatherAnimation(condition) {
  const c = condition.toLowerCase();
  let weatherType = "clear";

  if (c.includes("rain") || c.includes("drizzle") || c.includes("thunder")) {
    createParticles("rain");
    weatherType = "rain";
  } else if (c.includes("snow")) {
    createParticles("snow");
    weatherType = "snow";
  } else if (c.includes("cloud") || c.includes("mist") || c.includes("fog") || c.includes("haze")) {
    createParticles("clouds");
    weatherType = "clouds";
  } else {
    particles = [];
    animType = "clear";
    weatherType = "clear";
  }

  document.body.setAttribute("data-weather", weatherType);
}


// ─────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────
document.getElementById("cityInput").addEventListener("keydown", e => {
  if (e.key === "Enter") searchWeather();
});

async function searchWeather() {
  const city = document.getElementById("cityInput").value.trim();
  if (!city) { showError("Please enter a city name."); return; }

  setLoading(true); hideError(); hideResults();

  try {
    const [wResp, fResp] = await Promise.all([
      fetch(`/api/weather?city=${encodeURIComponent(city)}`),
      fetch(`/api/forecast?city=${encodeURIComponent(city)}`)
    ]);

    const wData = await wResp.json();
    if (!wResp.ok) {
      showError(wData.error || "City not found.");
      setLoading(false); return;
    }

    currentCity = wData.city;
    lastWeatherData = wData;
    updateCurrentWeather(wData);
    updatePrediction(wData.prediction);
    setWeatherAnimation(wData.current.condition);
    updateBookmarkButton();
    generateInsights();

    if (fResp.ok) {
      const fData = await fResp.json();
      if (fData.forecast) { updateForecastCards(fData.forecast); drawCharts(fData.forecast); }
    }

    addToRecentSearches(wData.city);
    showResults();
  } catch (err) {
    showError("Connection error. Make sure the server is running.");
    console.error(err);
  }
  setLoading(false);
}

function updateCurrentWeather(data) {
  const c = data.current;
  document.getElementById("cityName").textContent      = data.city;
  document.getElementById("cityTime").textContent      = "Updated: " + new Date().toLocaleTimeString("en-IN");
  document.getElementById("currentTemp").textContent   = c.temperature.toFixed(1);
  document.getElementById("conditionText").textContent = c.description;
  document.getElementById("feelsLike").textContent     = c.feels_like.toFixed(1);
  document.getElementById("humidity").textContent      = c.humidity;
  document.getElementById("windSpeed").textContent     = c.wind_speed;
  document.getElementById("pressure").textContent      = c.pressure;
  document.getElementById("cloudCover").textContent    = c.cloud_cover;
  document.getElementById("weatherIconBig").textContent = weatherEmoji[c.condition] || "🌤️";
}

function updatePrediction(pred) {
  document.getElementById("predTemp").textContent     = pred.temperature.toFixed(1) + "°C";
  document.getElementById("predHumidity").textContent = pred.humidity.toFixed(1) + "%";
  document.getElementById("predRain").textContent     = pred.will_rain ? "Yes" : "No";
  document.getElementById("rainProb").textContent     = pred.rain_probability + "%";
  document.getElementById("rainIcon").textContent     = pred.will_rain ? "🌧️" : "🌤️";
  const el = document.getElementById("rainProb");
  el.style.color = pred.rain_probability > 60 ? "var(--accent)" :
                   pred.rain_probability > 30 ? "var(--accent2)" : "var(--success)";
}

function updateForecastCards(forecast) {
  const daily = []; const seen = new Set();
  for (const item of forecast) {
    const day = item.datetime.split(" ")[0];
    if (!seen.has(day)) { seen.add(day); daily.push(item); }
    if (daily.length >= 5) break;
  }
  const container = document.getElementById("forecastRow");
  container.innerHTML = "";
  daily.forEach(day => {
    const date  = new Date(day.datetime);
    const label = date.toLocaleDateString("en-IN", {weekday:"short", month:"short", day:"numeric"});
    const el    = document.createElement("div");
    el.className = "forecast-item";
    el.innerHTML = `
      <div class="forecast-date">${label}</div>
      <div class="forecast-icon">${weatherEmoji[day.condition] || "🌤️"}</div>
      <div class="forecast-temp">${day.temperature.toFixed(1)}°</div>
      <div class="forecast-cond">${day.description}</div>
      <div class="forecast-rain">💧 ${day.rain_prob}%</div>
    `;
    container.appendChild(el);
  });
}

function updateTopCities(cities) {
  const el = document.getElementById("topCitiesList");
  if (!cities.length) { el.innerHTML = `<p class="empty-hint">No data yet — search some cities!</p>`; return; }
  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣"];
  el.innerHTML = cities.map((c, i) => `
    <div class="top-city-item" onclick="quickSearch('${c.city_name}')">
      <span class="top-city-rank">${medals[i]||i+1}</span>
      <span class="history-city">${c.city_name}</span>
      <span class="top-city-count">${c.count} searches</span>
    </div>
  `).join("");
}


// ─────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────
async function loadHistory() {
  try {
    const resp = await fetch("/api/history?limit=8");
    const data = await resp.json();
    const el   = document.getElementById("historyList");
    if (!data.history || !data.history.length) {
      el.innerHTML = `<p class="empty-hint">No searches yet.</p>`; return;
    }
    el.innerHTML = data.history.map(h => {
      const time = new Date(h.searched_at).toLocaleTimeString("en-IN", {hour:"2-digit", minute:"2-digit"});
      return `
        <div class="history-item" onclick="quickSearch('${h.city_name}')">
          <span class="history-city">${h.city_name}</span>
          <span class="history-time">${time}</span>
          <span class="${h.was_found ? 'history-status-ok':'history-status-err'}">${h.was_found?"✓":"✗"}</span>
        </div>
      `;
    }).join("");
  } catch(e) { console.error("History load error:", e); }
}

function quickSearch(city) {
  document.getElementById("cityInput").value = city;
  searchWeather();
}


// ─────────────────────────────────────────────
// BOOKMARKS
// ─────────────────────────────────────────────
function toggleBookmark() {
  if (!currentCity) return;
  const idx = bookmarks.indexOf(currentCity);
  if (idx === -1) bookmarks.unshift(currentCity);
  else bookmarks.splice(idx, 1);
  localStorage.setItem("forecastiq_bookmarks", JSON.stringify(bookmarks));
  updateBookmarkButton(); renderBookmarks();
}
function updateBookmarkButton() {
  if (!currentCity) return;
  const saved = bookmarks.includes(currentCity);
  document.getElementById("bookmarkBtn").classList.toggle("active", saved);
  document.getElementById("bookmarkIcon").className = saved ? "fa-solid fa-bookmark" : "fa-regular fa-bookmark";
}
function renderBookmarks() {
  const el = document.getElementById("bookmarksList");
  if (!bookmarks.length) {
    el.innerHTML = `<p class="empty-hint">No bookmarks yet. Search a city and click the bookmark icon.</p>`; return;
  }
  el.innerHTML = bookmarks.map(city => `
    <div class="bookmark-item">
      <span class="history-city" onclick="quickSearch('${city}')" style="cursor:pointer;flex:1">${city}</span>
      <button class="bookmark-remove" onclick="removeBookmark('${city}')">✕</button>
    </div>
  `).join("");
}
function removeBookmark(city) {
  bookmarks = bookmarks.filter(b => b !== city);
  localStorage.setItem("forecastiq_bookmarks", JSON.stringify(bookmarks));
  updateBookmarkButton(); renderBookmarks();
}


// ─────────────────────────────────────────────
// CHARTS
// ─────────────────────────────────────────────
function getChartColors() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    grid: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
    tick: isDark ? "#8892a4" : "#64748b",
    tooltipBg: isDark ? "#1a2235" : "#ffffff",
    tooltipFg: isDark ? "#e8eaf0" : "#1a2235",
  };
}
function chartOptions(unit, colors) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: colors.tooltipBg, titleColor: colors.tooltipFg,
        bodyColor: colors.tick, borderColor: "rgba(128,128,128,0.2)", borderWidth: 1,
        callbacks: { label: ctx => ` ${ctx.parsed.y}${unit}` }
      }
    },
    scales: {
      x: { grid:{color:colors.grid}, ticks:{color:colors.tick, font:{size:10}, maxRotation:45, maxTicksLimit:8} },
      y: { grid:{color:colors.grid}, ticks:{color:colors.tick, font:{size:11}, callback:v=>v+unit} }
    }
  };
}
function drawCharts(forecast) {
  const pts = forecast.filter((_,i)=>i%2===0).slice(0,20);
  const labels = pts.map(p=>{
    const d=new Date(p.datetime);
    return d.toLocaleDateString("en-IN",{weekday:"short"})+" "+d.getHours().toString().padStart(2,"0")+":00";
  });
  const temps    = pts.map(p=>+p.temperature.toFixed(1));
  const humidity = pts.map(p=>p.humidity);
  const rainProb = pts.map(p=>p.rain_prob);
  const colors   = getChartColors();
  if (tempChart)     tempChart.destroy();
  if (humidityChart) humidityChart.destroy();
  if (rainChart)     rainChart.destroy();
  tempChart = new Chart(document.getElementById("tempChart"), {
    type:"line", data:{labels, datasets:[{
      label:"Temp (°C)", data:temps, borderColor:"#f59e0b",
      backgroundColor:"rgba(245,158,11,0.1)", borderWidth:2,
      pointRadius:3, pointBackgroundColor:"#f59e0b", fill:true, tension:0.4
    }]}, options:chartOptions("°C", colors)
  });
  humidityChart = new Chart(document.getElementById("humidityChart"), {
    type:"line", data:{labels, datasets:[{
      label:"Humidity (%)", data:humidity, borderColor:"#00d4ff",
      backgroundColor:"rgba(0,212,255,0.1)", borderWidth:2,
      pointRadius:3, pointBackgroundColor:"#00d4ff", fill:true, tension:0.4
    }]}, options:chartOptions("%", colors)
  });
  rainChart = new Chart(document.getElementById("rainChart"), {
    type:"bar", data:{labels, datasets:[{
      label:"Rain Probability (%)", data:rainProb,
      backgroundColor:rainProb.map(v=>v>60?"rgba(96,165,250,0.8)":v>30?"rgba(245,158,11,0.8)":"rgba(34,197,94,0.8)"),
      borderRadius:6
    }]}, options:chartOptions("%", colors)
  });
}
function redrawChartsForTheme() {
  [tempChart, humidityChart, rainChart].forEach(chart => {
    if (!chart) return;
    const c = getChartColors();
    chart.options.scales.x.grid.color  = c.grid;
    chart.options.scales.y.grid.color  = c.grid;
    chart.options.scales.x.ticks.color = c.tick;
    chart.options.scales.y.ticks.color = c.tick;
    chart.options.plugins.tooltip.backgroundColor = c.tooltipBg;
    chart.options.plugins.tooltip.titleColor      = c.tooltipFg;
    chart.update();
  });
}


// ─────────────────────────────────────────────
// TICKET MODAL
// ─────────────────────────────────────────────

function openTicketModal() {
  // Auto-fill city if one is searched
  if (currentCity) {
    document.getElementById("ticketCity").value = currentCity;
  }
  // Reset form
  document.getElementById("ticketForm").reset();
  if (currentCity) document.getElementById("ticketCity").value = currentCity;
  document.getElementById("ticketSuccess").classList.add("hidden");
  document.getElementById("ticketForm").classList.remove("hidden");
  document.getElementById("ticketError").classList.add("hidden");
  document.getElementById("charCount").textContent = "0 characters";

  // Show modal
  document.getElementById("ticketModalOverlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeTicketModal(event) {
  // Close only if clicking overlay background (not modal itself)
  if (event && event.target !== document.getElementById("ticketModalOverlay")) return;
  document.getElementById("ticketModalOverlay").classList.add("hidden");
  document.body.style.overflow = "";
}

// Close on Escape key
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.getElementById("ticketModalOverlay").classList.add("hidden");
    document.body.style.overflow = "";
  }
});

function updateCharCount() {
  const len = document.getElementById("ticketDescription").value.length;
  document.getElementById("charCount").textContent = `${len} characters`;
}

async function submitTicket(event) {
  event.preventDefault();

  const name        = document.getElementById("ticketName").value.trim();
  const email       = document.getElementById("ticketEmail").value.trim();
  const issueType   = document.getElementById("ticketIssueType").value;
  const city        = document.getElementById("ticketCity").value.trim();
  const description = document.getElementById("ticketDescription").value.trim();

  // Hide previous error
  document.getElementById("ticketError").classList.add("hidden");

  // Client-side validation
  if (!name || !email || !issueType || !description) {
    showTicketError("Please fill in all required fields.");
    return;
  }
  if (description.length < 10) {
    showTicketError("Description must be at least 10 characters.");
    return;
  }

  // Show loading
  setTicketLoading(true);

  try {
    const resp = await fetch("/api/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, issue_type: issueType, city, description }),
    });

    const data = await resp.json();

    if (data.success) {
      // Show success state
      document.getElementById("ticketForm").classList.add("hidden");
      document.getElementById("ticketSuccess").classList.remove("hidden");
      document.getElementById("successMessage").textContent = data.message;
      document.getElementById("ticketIdBox").textContent    = `Ticket #${data.ticket_id}`;
    } else {
      showTicketError(data.error || "Failed to submit ticket. Please try again.");
    }

  } catch (err) {
    showTicketError("Connection error. Please check if the server is running.");
    console.error(err);
  }

  setTicketLoading(false);
}

function showTicketError(msg) {
  document.getElementById("ticketErrorText").textContent = msg;
  document.getElementById("ticketError").classList.remove("hidden");
}

function setTicketLoading(on) {
  document.getElementById("submitBtnText").classList.toggle("hidden", on);
  document.getElementById("submitBtnLoader").classList.toggle("hidden", !on);
  document.getElementById("submitTicketBtn").disabled = on;
}


// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
function setLoading(on) {
  document.getElementById("btnText").classList.toggle("hidden", on);
  document.getElementById("btnLoader").classList.toggle("hidden", !on);
  document.getElementById("searchBtn").disabled = on;
}
function showError(msg) {
  document.getElementById("errorText").textContent = msg;
  document.getElementById("errorMsg").classList.remove("hidden");
}
function hideError()   { document.getElementById("errorMsg").classList.add("hidden"); }
function showResults() { document.getElementById("results").classList.remove("hidden"); }
function hideResults() { document.getElementById("results").classList.add("hidden"); }

// ─────────────────────────────────────────────
// MODES & SMART INSIGHTS
// ─────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll(".mode-btn").forEach(btn => btn.classList.remove("active"));
  document.getElementById(`mode-${mode}`).classList.add("active");
  document.getElementById("insightsModeLabel").textContent = mode;
  
  const iconMap = { "General": "fa-user", "Traveler": "fa-plane", "Farmer": "fa-tractor", "Student": "fa-graduation-cap", "Sports": "fa-person-running" };
  document.getElementById("insightsIcon").className = `fa-solid ${iconMap[mode]}`;
  
  if (lastWeatherData) {
    generateInsights();
  }
}

function generateInsights() {
  if (!lastWeatherData) return;
  const c = lastWeatherData.current.condition.toLowerCase();
  const temp = lastWeatherData.current.temperature;
  const feelsLike = lastWeatherData.current.feels_like;
  const humidity = lastWeatherData.current.humidity;
  const rainProb = lastWeatherData.prediction.rain_probability;
  const rainMm = lastWeatherData.current.rain_mm;
  let insights = [];

  // --- Alerts Logic ---
  const alertsContainer = document.getElementById("weatherAlertsContainer");
  alertsContainer.innerHTML = "";
  if (temp > 35) {
    alertsContainer.innerHTML += `<div class="weather-alert"><i class="fa-solid fa-triangle-exclamation"></i> 🔥 Heat Warning: Extremely high temperatures.</div>`;
  }
  if (humidity > 85) {
    alertsContainer.innerHTML += `<div class="weather-alert"><i class="fa-solid fa-triangle-exclamation"></i> 💧 High Humidity: Stay hydrated and cool.</div>`;
  }
  if (rainMm > 5 || rainProb > 80) {
    alertsContainer.innerHTML += `<div class="weather-alert"><i class="fa-solid fa-triangle-exclamation"></i> ⚠️ Heavy Rain Alert: Expect significant precipitation.</div>`;
  }

  // --- Confidence Score Logic ---
  const confidenceScoreEl = document.getElementById("confidenceScore");
  let confidence = "Medium";
  let confClass = "medium";
  if (rainProb > 85 || rainProb < 15) {
    confidence = "High"; confClass = "high";
  } else if (rainProb > 40 && rainProb < 60) {
    confidence = "Low"; confClass = "low";
  }
  confidenceScoreEl.textContent = `Confidence: ${confidence}`;
  confidenceScoreEl.className = `confidence-badge ${confClass}`;

  // --- Smart Summary Logic ---
  const summaryBox = document.getElementById("smartSummaryBox");
  const summaryText = document.getElementById("smartSummaryText");
  let summary = "";
  if (temp > 30) {
    summary = `Hot weather today with a ${rainProb}% chance of rain. `;
  } else if (temp < 15) {
    summary = `Chilly conditions with a ${rainProb}% chance of rain. `;
  } else {
    summary = `Pleasant temperatures with a ${rainProb}% chance of rain. `;
  }
  
  if (rainProb > 70) {
    summary += "Expect wet conditions; outdoor activities might be affected.";
  } else if (rainProb < 20) {
    summary += "Dry and stable; suitable for outdoor plans.";
  } else {
    summary += "Keep an umbrella handy just in case.";
  }
  summaryText.textContent = summary;
  summaryBox.style.display = "flex";

  // --- Base Insights (3-5 per mode) ---

  if (currentMode === "Farmer") {
    if (c.includes("rain") || c.includes("drizzle") || c.includes("thunder")) {
      insights = [
        { icon: "🌧", text: "Ideal natural irrigation conditions. Pause pesticide spraying." },
        { icon: "✔", text: "Ensure field drainage systems are clear to prevent waterlogging." },
        { icon: "🏠", text: "Monitor livestock shelters for leaks or flooding." },
        { icon: "🔧", text: "Plan indoor equipment maintenance today." }
      ];
    } else if (c.includes("clear") && temp > 30) {
      insights = [
        { icon: "💧", text: "High evaporation rates today. Consider early morning or late evening irrigation." },
        { icon: "🐄", text: "Provide extra shade and water for livestock." },
        { icon: "☀", text: "Great conditions for solar drying of harvested crops." },
        { icon: "🌱", text: "Monitor soil moisture closely in shallow-rooted crops." }
      ];
    } else if (c.includes("cloud")) {
      insights = [
        { icon: "☁", text: "Good day for field work with reduced sun exposure." },
        { icon: "🍄", text: "Monitor for potential fungal pests due to trapped humidity." },
        { icon: "✔", text: "Optimal time for applying fertilizers without immediate sun-burn risk." },
        { icon: "📡", text: "Check weather radar frequently for sudden scattered showers." }
      ];
    } else {
      insights = [
        { icon: "✔", text: "Stable conditions. Standard farming operations can proceed." },
        { icon: "🚶", text: "Good weather for inspecting fences and field boundaries." },
        { icon: "🚚", text: "Favorable for transporting harvested goods." },
        { icon: "🌱", text: "A regular day to continue seasonal planting or harvesting." }
      ];
    }
  } else if (currentMode === "Traveler") {
    if (c.includes("rain") || c.includes("thunder")) {
      insights = [
        { icon: "🚆", text: "High chance of flight or transit delays. Pack an umbrella." },
        { icon: "🏛", text: "Plan indoor activities like museums or cafes." },
        { icon: "🚶", text: "Wear slip-resistant waterproof footwear." },
        { icon: "🎒", text: "Keep electronic devices safely packed in water-resistant bags." }
      ];
    } else if (c.includes("fog") || c.includes("mist")) {
      insights = [
        { icon: "🌫", text: "Low visibility may affect road travel and early flights." },
        { icon: "🚗", text: "Drive safely and use fog lights if on the road." },
        { icon: "⏱", text: "Keep your itinerary flexible in case of delays." },
        { icon: "📸", text: "A moody, atmospheric day for unique photography." }
      ];
    } else if (c.includes("clear")) {
      insights = [
        { icon: "🌤", text: "Perfect weather for sightseeing and outdoor photography!" },
        { icon: "🕶", text: "Don't forget to pack sunglasses and apply sunscreen." },
        { icon: "🚲", text: "Ideal conditions for renting a bike or walking tours." },
        { icon: "👥", text: "Expect tourist hotspots to be more crowded than usual." }
      ];
    } else {
      insights = [
        { icon: "🧥", text: "Good conditions for travel. Keep a light jacket handy." },
        { icon: "🚶", text: "Favorable weather for both indoor and outdoor itineraries." },
        { icon: "🚆", text: "Transit systems should be running on their regular schedules." },
        { icon: "✔", text: "Comfortable temperatures for exploring the city on foot." }
      ];
    }
  } else if (currentMode === "Student") {
    if (c.includes("rain") || c.includes("drizzle")) {
      insights = [
        { icon: "☂", text: "Rainy day ahead. Bring an umbrella and waterproof backpack to campus." },
        { icon: "📚", text: "Opt for an indoor study session in the library." },
        { icon: "🚶", text: "Campus paths might be slippery, walk carefully." },
        { icon: "☕", text: "Perfect weather for a cozy coffee shop study group." }
      ];
    } else if (c.includes("clear") && temp > 25) {
      insights = [
        { icon: "🌤", text: "Great weather for an outdoor study session on campus!" },
        { icon: "💧", text: "Stay hydrated if walking long distances between classes." },
        { icon: "🚶", text: "Take a break and enjoy the sunshine on the quad." },
        { icon: "👕", text: "Wear breathable clothing for comfortable lectures." }
      ];
    } else if (temp < 15) {
      insights = [
        { icon: "🧥", text: "It's chilly! Dress warmly for those early morning lectures." },
        { icon: "☕", text: "A hot beverage might help you focus during long classes." },
        { icon: "🌬", text: "Study areas near windows might be a bit drafty today." },
        { icon: "📚", text: "Great conditions for uninterrupted focus indoors." }
      ];
    } else {
      insights = [
        { icon: "✔", text: "Comfortable weather for attending classes and campus activities." },
        { icon: "👥", text: "Good day to join an outdoor club meeting or campus tour." },
        { icon: "👕", text: "Standard layered clothing is recommended." },
        { icon: "🚶", text: "Take advantage of the mild weather for a campus walk." }
      ];
    }
  } else if (currentMode === "Sports") {
    if (c.includes("rain") || c.includes("drizzle") || c.includes("thunder")) {
      insights = [
        { icon: "🌧", text: "High chance of rain. Consider moving your workout indoors." },
        { icon: "🏋", text: "Great day for the gym or a home workout routine." },
        { icon: "⚠", text: "If running outside, watch out for slippery surfaces." },
        { icon: "🧥", text: "Wear proper waterproof and reflective gear if outdoors." }
      ];
    } else if (temp > 32) {
      insights = [
        { icon: "⚠", text: "High temperature! Avoid intense physical activity mid-day." },
        { icon: "💧", text: "Stay hydrated. Drink water before, during, and after your workout." },
        { icon: "👕", text: "Wear lightweight, breathable, and light-colored clothing." },
        { icon: "🏃", text: "Opt for an early morning or late evening run instead." }
      ];
    } else if (temp > 25 && c.includes("cloud")) {
      insights = [
        { icon: "☁", text: "Warm but cloudy. High humidity might cause faster fatigue." },
        { icon: "💧", text: "Keep a water bottle handy and take frequent breaks." },
        { icon: "🏃", text: "Good conditions for a moderate outdoor run or cycling." },
        { icon: "👕", text: "Moisture-wicking activewear is highly recommended." }
      ];
    } else if (temp < 10) {
      insights = [
        { icon: "❄", text: "Cold weather! Ensure a proper warm-up to prevent muscle strain." },
        { icon: "🧥", text: "Wear layered clothing to manage body heat." },
        { icon: "🧤", text: "Protect extremities with gloves and a warm hat or headband." },
        { icon: "🏃", text: "Great weather for an energetic run if dressed appropriately." }
      ];
    } else {
      insights = [
        { icon: "☀", text: "Pleasant weather! Perfect conditions for outdoor sports." },
        { icon: "🚴", text: "Ideal day for running, cycling, or playing field sports." },
        { icon: "✔", text: "Comfortable temperatures mean optimal performance." },
        { icon: "👥", text: "Great time to organize a team sport or group workout." }
      ];
    }
  } else {
    // General
    if (c.includes("rain") || c.includes("thunder")) {
      insights = [
        { icon: "☂", text: "Don't forget your umbrella today." },
        { icon: "🚗", text: "Expect slower traffic and allow extra commute time." },
        { icon: "📚", text: "Great day to stay in and catch up on reading." },
        { icon: "🏠", text: "Ensure your windows are closed before leaving home." }
      ];
    } else if (temp > 35) {
      insights = [
        { icon: "⚠", text: "Extreme heat alert! Stay hydrated and drink plenty of water." },
        { icon: "☀", text: "Avoid prolonged sun exposure, especially mid-day." },
        { icon: "🐕", text: "Keep pets indoors and ensure they have cool water." },
        { icon: "❄", text: "Use air conditioning or fans to stay comfortable." }
      ];
    } else if (temp < 10) {
      insights = [
        { icon: "🧥", text: "Cold weather alert! Bundle up before heading out." },
        { icon: "🚗", text: "Consider warming up your car before driving." },
        { icon: "☕", text: "A warm cup of tea or coffee is highly recommended." },
        { icon: "🏠", text: "Ensure your home heating system is working efficiently." }
      ];
    } else if (c.includes("clear")) {
      insights = [
        { icon: "🌤", text: "Beautiful clear day. Great time for a walk or outdoor workout." },
        { icon: "🧴", text: "Remember to wear sunscreen if spending time outside." },
        { icon: "👕", text: "Perfect conditions for doing laundry and sun-drying." },
        { icon: "🌇", text: "Enjoy the pleasant evening sky later today." }
      ];
    } else {
      insights = [
        { icon: "✔", text: "Typical weather conditions today. Have a great day!" },
        { icon: "🌤", text: "Temperatures are moderate and comfortable." },
        { icon: "🚆", text: "No severe weather disruptions expected." },
        { icon: "🚶", text: "A good, balanced day for both work and leisure." }
      ];
    }
  }

  // --- Feels Like Insight ---
  if (feelsLike > temp + 2) {
    insights.push({ icon: "🥵", text: `Feels significantly hotter (${feelsLike.toFixed(1)}°C) due to humidity.` });
  } else if (feelsLike < temp - 2) {
    insights.push({ icon: "🥶", text: `Feels much colder (${feelsLike.toFixed(1)}°C) due to wind chill.` });
  } else {
    insights.push({ icon: "🌡", text: `Comfortable weather conditions. Feels like ${feelsLike.toFixed(1)}°C.` });
  }

  const listHtml = `<ul style="margin:0; padding-left:0; list-style-type: none; display:flex; flex-direction:column; gap:16px;">` + 
    insights.map(item => `
      <li style="display:flex; align-items:flex-start; gap:14px;">
        <span style="font-size:1.25em; line-height:1.2; display:flex; align-items:center; justify-content:center; width:28px; height:28px; background:rgba(37, 99, 235, 0.1); border-radius:8px; color:#2563eb;">${item.icon}</span> 
        <span style="flex:1; line-height:1.6; font-size:15px; color:var(--text); opacity:0.9;">${item.text}</span>
      </li>`).join("") + 
    `</ul>`;

  document.getElementById("insightsText").innerHTML = listHtml;
}



// ─────────────────────────────────────────────
// RECENT SEARCHES
// ─────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch("/api/history?limit=5");
    const data = await res.json();
    if (data.history) {
      localRecentSearches = data.history;
      renderRecentSearches();
    }
  } catch (e) {
    console.error("Failed to load history", e);
  }
}

function addToRecentSearches(cityName) {
  const normalizedCity = cityName.toLowerCase().trim();
  localRecentSearches = localRecentSearches.filter(item => item.city_name.toLowerCase().trim() !== normalizedCity);
  localRecentSearches.unshift({
    city_name: cityName,
    searched_at: new Date().toISOString()
  });
  if (localRecentSearches.length > 5) {
    localRecentSearches.pop();
  }
  renderRecentSearches();
}

function renderRecentSearches() {
  const list = document.getElementById("historyList");
  if (localRecentSearches.length === 0) {
    list.innerHTML = `<p class="empty-hint">No searches yet.</p>`;
    return;
  }
  
  list.innerHTML = localRecentSearches.map(item => {
    return `
      <div class="history-item" onclick="document.getElementById('cityInput').value='${item.city_name}'; searchWeather();">
        <span class="history-city">${item.city_name}</span>
      </div>
    `;
  }).join("");
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
renderBookmarks();
loadHistory();
