// Useless GPS — Anime Snark Simulation (complete)
// Uses Nominatim + Overpass + Leaflet (free). No API keys required.

// ---------- Config ----------
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MAX_SAMPLES = 12;
const MIN_SAMPLES = 4;
const MIN_RADIUS = 120;   // meters
const MAX_RADIUS = 900;   // meters

// ---------- Map & UI ----------
let map, startMarker, destMarker, lineLayer, featuresLayer;
let samplePoints = []; // {lat,lon,flags,hits}
let rawElements = [];
let simulateMarker = null, simulateTimer = null;
let lastTriggeredSample = -1;

function el(id){ return document.getElementById(id); }
document.addEventListener('DOMContentLoaded', () => {
  map = L.map('map').setView([20.5937, 78.9629], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  featuresLayer = L.layerGroup().addTo(map);

  el('goBtn').addEventListener('click', onGo);
  el('resetBtn').addEventListener('click', resetAll);
  el('simulateBtn').addEventListener('click', onSimulate);
});

// ---------- Main flow ----------
async function onGo(){
  const startName = el('startInput').value.trim();
  const destName  = el('destInput').value.trim();
  if (!startName || !destName) { showToast("Enter start & destination"); return; }

  showToast("Geocoding...");
  try {
    const start = await geocode(startName);
    const dest  = await geocode(destName);
    if (!start || !dest) { showToast("Couldn't find a location."); return; }

    plotRoute(start, dest);

    const meters = map.distance([start.lat, start.lon], [dest.lat, dest.lon]);
    const km = (meters/1000).toFixed(2);
    const bearing = calculateBearing(start.lat, start.lon, dest.lat, dest.lon).toFixed(0);

    // Update HUD nicely
    setInfo('distance', `${km} km (${Math.round(meters)} m)`);
    setInfo('bearing', `${bearing}°`);

    // adaptive sampling
    const samples = adaptiveSampleCount(meters);
    const radius = adaptiveRadius(meters);

    showToast(`Sampling ${samples} points (radius ${Math.round(radius)} m) — analyzing...`, 1500);
    const analysis = await analyzePath(start, dest, samples, radius);

    if (analysis.flags.error) {
      showToast("Overpass error — try again later.", 3000);
      el('simulateBtn').disabled = true;
      return;
    }

    rawElements = analysis.rawElements;
    samplePoints = analysis.samples;
    drawDetectedFeatures(rawElements);

    // show initial anime message summarizing (optional)
    const topMsg = composeSummaryMessage(analysis.flags, meters);
    showAnime(topMsg, 3000);

    el('simulateBtn').disabled = false;
    showToast("Analysis complete. Click Simulate to start the trip.", 2200);
    lastTriggeredSample = -1;

  } catch (e) {
    console.error(e);
    showToast("Error: " + (e.message || "something went wrong"));
  }
}

// ---------- Geocoding (Nominatim) ----------
async function geocode(query){
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }});
  const arr = await res.json();
  if (!arr || arr.length === 0) return null;
  return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), name: arr[0].display_name };
}

// ---------- Plotting ----------
function plotRoute(start, dest){
  if (startMarker) map.removeLayer(startMarker);
  if (destMarker)  map.removeLayer(destMarker);
  if (lineLayer)   map.removeLayer(lineLayer);
  featuresLayer.clearLayers();

  startMarker = L.marker([start.lat, start.lon]).addTo(map).bindPopup("Start: " + start.name).openPopup();
  destMarker  = L.marker([dest.lat, dest.lon]).addTo(map).bindPopup("Dest: " + dest.name).openPopup();
  lineLayer = L.polyline([[start.lat,start.lon],[dest.lat,dest.lon]], { color:'crimson', weight:4, dashArray:'6 8' }).addTo(map);
  map.fitBounds(lineLayer.getBounds().pad(0.3));
}

// ---------- Sampling heuristics ----------
function adaptiveSampleCount(meters){
  const km = meters/1000;
  let samples = Math.ceil(km * 2);
  if (samples < MIN_SAMPLES) samples = MIN_SAMPLES;
  if (samples > MAX_SAMPLES) samples = MAX_SAMPLES;
  return samples;
}
function adaptiveRadius(meters){
  let r = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, meters / 8));
  return r;
}

// ---------- Overpass analysis ----------
async function analyzePath(start, dest, samples=6, radius=200){
  // create sample points as linear interpolation
  const pts = [];
  for (let i=1;i<=samples;i++){
    const t = i/(samples+1);
    const lat = start.lat + (dest.lat - start.lat) * t;
    const lon = start.lon + (dest.lon - start.lon) * t;
    pts.push({lat: parseFloat(lat.toFixed(6)), lon: parseFloat(lon.toFixed(6)), flags:{}, hits:[]});
  }

  // wanted features (include building -> city)
  const wanted = [
    `way(around:R, LAT, LON)[natural=water];`,
    `way(around:R, LAT, LON)[waterway];`,
    `way(around:R, LAT, LON)[landuse=forest];`,
    `way(around:R, LAT, LON)[leisure=park];`,
    `way(around:R, LAT, LON)[highway];`,
    `way(around:R, LAT, LON)[railway];`,
    `way(around:R, LAT, LON)[building];`,
    `node(around:R, LAT, LON)[natural=peak];`
  ];

  const joinParts = [];
  for (const p of pts) {
    for (const w of wanted) {
      joinParts.push(w.replace('LAT', p.lat).replace('LON', p.lon).replace('R', radius));
    }
  }

  const fullQuery = `[out:json][timeout:25];
(
${joinParts.join("\n")}
);
out geom;`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: fullQuery,
      headers: { 'Content-Type': 'text/plain' }
    });
    const data = await res.json();
    const elements = data.elements || [];

    // global flags
    const flags = { water:false, river:false, forest:false, park:false, highway:false, railway:false, building:false, peak:false, error:false };

    // evaluate proximity per sample (approximate by nearest vertex)
    pts.forEach(p => { p.flags = { water:false, river:false, forest:false, park:false, highway:false, railway:false, building:false, peak:false }; p.hits = []; });

    elements.forEach(el => {
      const t = el.tags || {};
      if (t.natural === 'water') flags.water = true;
      if (t.waterway) flags.river = true;
      if (t.landuse === 'forest') flags.forest = true;
      if (t.leisure === 'park') flags.park = true;
      if (t.highway) flags.highway = true;
      if (t.railway) flags.railway = true;
      if (t.building) flags.building = true;
      if (t.natural === 'peak') flags.peak = true;

      // geometry points
      let geom = [];
      if (el.geometry && el.geometry.length) geom = el.geometry.map(g => ({lat:g.lat, lon:g.lon}));
      else if (el.lat && el.lon) geom = [{lat:el.lat, lon:el.lon}];

      pts.forEach(p => {
        let minDist = Infinity;
        geom.forEach(gp => {
          const d = haversineMeters(p.lat, p.lon, gp.lat, gp.lon);
          if (d < minDist) minDist = d;
        });
        if (minDist <= radius) {
          if (t.natural === 'water') p.flags.water = true;
          if (t.waterway) p.flags.river = true;
          if (t.landuse === 'forest') p.flags.forest = true;
          if (t.leisure === 'park') p.flags.park = true;
          if (t.highway) p.flags.highway = true;
          if (t.railway) p.flags.railway = true;
          if (t.building) p.flags.building = true;
          if (t.natural === 'peak') p.flags.peak = true;
          p.hits.push({el, dist:minDist});
        }
      });
    });

    return { flags, samples: pts, rawElements: elements };
  } catch (err) {
    console.warn("Overpass error", err);
    return { flags: { error:true }, samples: [], rawElements: [] };
  }
}

// ---------- Draw detected features ----------
function drawDetectedFeatures(elements){
  featuresLayer.clearLayers();
  if (!elements || elements.length === 0) return;
  elements.forEach(el => {
    const tags = el.tags || {};
    if (el.type === 'way' && el.geometry && el.geometry.length > 0) {
      const latlngs = el.geometry.map(g => [g.lat, g.lon]);
      const isClosed = latlngs.length>2 && latlngs[0][0]===latlngs[latlngs.length-1][0] && latlngs[0][1]===latlngs[latlngs.length-1][1];
      let style = { color:'#888', weight:2, opacity:0.8 }, title='OSM feature';
      if (tags.natural==='water' || tags.water) { style={color:'#1e90ff', weight:1, fillColor:'#b6e0ff', fillOpacity:0.45}; title='Water'; }
      else if (tags.waterway) { style={color:'#1e90ff', weight:3, dashArray:'2 6'}; title='Waterway'; }
      else if (tags.landuse==='forest') { style={color:'#047857', weight:1, fillColor:'#bbf1d0', fillOpacity:0.45}; title='Forest'; }
      else if (tags.leisure==='park') { style={color:'#065f46', weight:1, fillColor:'#bde7c9', fillOpacity:0.45}; title='Park'; }
      else if (tags.highway) { style={color:'#f97316', weight:3}; title=`Road (${tags.highway})`; }
      else if (tags.railway) { style={color:'#111827', weight:2, dashArray:'4 6'}; title='Railway'; }
      else if (tags.building) { style={color:'#7c3aed', weight:1, fillColor:'#eadcff', fillOpacity:0.4}; title='Building'; }
      if (isClosed) {
        const poly = L.polygon(latlngs, style).addTo(featuresLayer);
        poly.bindPopup(`<strong>${title}</strong><br>${popupTags(tags)}`);
      } else {
        const pl = L.polyline(latlngs, style).addTo(featuresLayer);
        pl.bindPopup(`<strong>${title}</strong><br>${popupTags(tags)}`);
      }
    } else if (el.type==='node') {
      if (el.tags && el.tags.natural==='peak') {
        const mk = L.marker([el.lat, el.lon]).addTo(featuresLayer);
        mk.bindPopup(`<strong>Peak</strong><br>${popupTags(el.tags)}`);
      }
    }
  });
}
function popupTags(tags){
  return Object.entries(tags).slice(0,6).map(([k,v]) => `<em>${k}</em>: ${v}`).join('<br>') || 'No tags';
}

// ---------- Compose summary (first) message ----------
function composeSummaryMessage(flags, meters) {
  const km = (meters/1000);
  if (flags.error) return "Overpass grumbled — analysis failed.";
  if (flags.water || flags.river) return "Route appears watery — you might need a boat. You go swim!";
  if (flags.peak) return "Mountains detected — hope you like climbing.";
  if (flags.forest) return "There's forest along the way — mind the wildlife.";
  if (flags.building) return "Urban area ahead — honk responsibly.";
  return km < 1 ? "Short hop — slippers recommended." : "All clearish — still useless, though.";
}

// ---------- Simulation (anime + messages) ----------
function onSimulate(){
  if (!lineLayer) { showToast("Draw a line first."); return; }
  if (!samplePoints || samplePoints.length===0) { showToast("No samples — run analysis first."); return; }

  if (simulateMarker) map.removeLayer(simulateMarker);
  if (simulateTimer) clearInterval(simulateTimer);
  lastTriggeredSample = -1;

  const latlngs = lineLayer.getLatLngs();
  const start = latlngs[0], dest = latlngs[latlngs.length-1];
  const meters = map.distance(start, dest);
  const km = meters / 1000;
  const durationMs = Math.min(30000, Math.max(4000, meters * 2)); // speed heuristic
  const steps = Math.max(80, Math.round(durationMs / 25));
  let step = 0;

  simulateMarker = L.circleMarker(start, {radius:8, color:'#0ea5a4', fillColor:'#34d399', fillOpacity:0.9}).addTo(map);

  // Adaptive number of messages: 1 every ~10 km, min 3, max 6
  const minMsgs = 3, maxMsgs = 6;
  const msgCount = Math.min(maxMsgs, Math.max(minMsgs, Math.ceil(km / 10)));
  const triggerSteps = [];
  for(let i = 1; i <= msgCount; i++) {
    triggerSteps.push(Math.floor((steps * i) / (msgCount + 1)));
  }
  let nextTriggerIndex = 0;

  simulateTimer = setInterval(() => {
    const t = step / steps;
    const curLat = start.lat + (dest.lat - start.lat) * t;
    const curLon = start.lng + (dest.lng - start.lng) * t;
    simulateMarker.setLatLng([curLat, curLon]);

    // Check proximity to samples
    let nearestIdx = -1, nearestDist = Infinity;
    samplePoints.forEach((s, idx) => {
      const d = haversineMeters(curLat, curLon, s.lat, s.lon);
      if (d < nearestDist) { nearestDist = d; nearestIdx = idx; }
    });

    // Message triggered either by proximity or by scheduled step
    const triggerRadius = adaptiveRadius(meters);

    if (
      nearestIdx !== lastTriggeredSample &&
      nearestIdx !== -1 &&
      nearestDist <= triggerRadius
    ) {
      // Show message based on sample flags
      const sp = samplePoints[nearestIdx];
      const msg = sensibleMessageForSample(sp);
      showAnime(msg, 3000);
      lastTriggeredSample = nearestIdx;
    }
    else if (nextTriggerIndex < triggerSteps.length && step === triggerSteps[nextTriggerIndex]) {
      // Force message at scheduled steps - find closest sample at this t
      let closestSample = null;
      let closestDist = Infinity;
      samplePoints.forEach(sp => {
        const d = haversineMeters(curLat, curLon, sp.lat, sp.lon);
        if (d < closestDist) {
          closestDist = d;
          closestSample = sp;
        }
      });
      const msg = closestSample ? sensibleMessageForSample(closestSample) : "Enjoy your useless journey!";
      showAnime(msg, 3000);
      nextTriggerIndex++;
    }

    step++;
    if (step > steps) {
      clearInterval(simulateTimer);
      simulateTimer = null;
      showAnime("You reached the destination! What a useless journey.", 4000);
    }
  }, 25);
}

// Improved terrain-based messages
function sensibleMessageForSample(sample) {
  if (!sample || !sample.flags) return "Just empty air and useless road.";

  const f = sample.flags;

  // Priority messages based on terrain importance
  if (f.water && f.river) return "You’re crossing water and river — watch your step or swim!";
  if (f.water) return "Water nearby — maybe a boat ride?";
  if (f.river) return "A river flows here — maybe a bridge?";
  if (f.peak) return "Mountains ahead — get ready for the climb.";
  if (f.forest) return "Forest surrounds you — watch for wildlife.";
  if (f.park) return "A peaceful park — perfect for a useless picnic.";
  if (f.highway) return "Busy highway — cross carefully!";
  if (f.railway) return "Railway tracks — stay alert and don’t get caught.";
  if (f.building) return "Passing through buildings — urban vibes.";

  return "Just empty air and useless road.";
}

// Generates message based on sample flags
function generateMessageForSample(sample) {
  if (sample.flags.water) return "Water everywhere... no bridge? Just swim.";
  if (sample.flags.river) return "A river blocks your path. Did you bring a canoe?";
  if (sample.flags.peak) return "Uh oh, a peak! Time to climb?";
  if (sample.flags.forest) return "Deep forest here. Watch out for bears.";
  if (sample.flags.park) return "A nice park, but no benches for you.";
  if (sample.flags.highway) return "Highway nearby. Stay safe, no jaywalking.";
  if (sample.flags.railway) return "Railway crossing ahead. Don't get hit.";
  if (sample.flags.building) return "Passing through some buildings. Don't get lost.";
  return "Just empty air and useless road.";
}

// ---------- Reset ----------
function resetAll(){
  if (startMarker) { map.removeLayer(startMarker); startMarker=null; }
  if (destMarker)  { map.removeLayer(destMarker); destMarker=null; }
  if (lineLayer)   { map.removeLayer(lineLayer); lineLayer=null; }
  featuresLayer.clearLayers();
  samplePoints = [];
  rawElements = [];
  if (simulateMarker) { map.removeLayer(simulateMarker); simulateMarker=null; }
  if (simulateTimer) clearInterval(simulateTimer);
  lastTriggeredSample = -1;
  setInfo('distance', '—');
  setInfo('bearing', '—');
  el('simulateBtn').disabled = true;
  showAnime("", 0);
  showToast("Reset done.", 1000);
}

// ---------- Utility helpers ----------
function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371e3;
  const phi1 = lat1 * Math.PI/180;
  const phi2 = lat2 * Math.PI/180;
  const dPhi = (lat2-lat1) * Math.PI/180;
  const dLambda = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) +
            Math.cos(phi1)*Math.cos(phi2) *
            Math.sin(dLambda/2)*Math.sin(dLambda/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}
function calculateBearing(lat1, lon1, lat2, lon2){
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) -
            Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  let θ = Math.atan2(y, x);
  θ = (θ*180/Math.PI + 360) % 360; // in degrees
  return θ;
}

// ---------- UI helpers ----------

function showToast(msg, duration=1500){
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  if (duration > 0){
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), duration);
  }
}

// Shows anime bubble with message
let animeTimeout;
function showAnime(msg, duration=2000){
  const a = el('anime');
  const speech = el('speech');
  if (!a || !speech) return;
  if (!msg) {
    a.classList.remove('show');
    speech.textContent = "";
    return;
  }
  speech.textContent = msg;
  a.classList.add('show');
  clearTimeout(animeTimeout);
  animeTimeout = setTimeout(() => {
    a.classList.remove('show');
  }, duration);
}

// Update HUD info
function setInfo(id, text) {
  const container = el(id);
  if (!container) return;
  const valueSpan = container.querySelector('.value');
  if (valueSpan) valueSpan.textContent = text;
}
