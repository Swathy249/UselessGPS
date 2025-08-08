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
    el('distance').textContent = `Distance: ${km} km (${Math.round(meters)} m)`;
    el('bearing').textContent = `Bearing: ${bearing}°`;

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
  
  // Faster duration but smooth enough
  const durationMs = Math.min(15000, Math.max(5000, meters * 1.5)); 
  const steps = Math.max(60, Math.round(durationMs / 30)); 
  let step = 0;

  simulateMarker = L.circleMarker(start, {radius:8, color:'#0ea5a4', fillColor:'#34d399', fillOpacity:0.9}).addTo(map);

  let lastPopupTime = 0;
  const popupCooldown = 3000; // 3 sec cooldown

  simulateTimer = setInterval(() => {
    const t = step / steps;
    const curLat = start.lat + (dest.lat - start.lat) * t;
    const curLon = start.lng + (dest.lng - start.lng) * t;
    simulateMarker.setLatLng([curLat, curLon]);

    // Find samples close enough to current position (within radius)
    const triggerRadius = adaptiveRadius(meters);
    const now = Date.now();

    // Gather all samples near current location (some might overlap)
    const nearbySamples = samplePoints.filter(s => haversineMeters(curLat, curLon, s.lat, s.lon) <= triggerRadius);

    // Pick the sample with the highest priority message (or first)
    let msg = null;
    for (const s of nearbySamples) {
      const candidateMsg = messageForSample(s);
      if (candidateMsg !== "Nothing interesting here... yawn.") {
        msg = candidateMsg;
        break; // show first interesting message nearby
      }
    }
    // If no interesting nearby message, fallback to default
    if (!msg) msg = "Just passing by...";

    // Show popup if cooldown passed and message changed from last
    if ((now - lastPopupTime) > popupCooldown && msg !== lastTriggeredSample) {
      showAnime(msg, 3000);
      lastPopupTime = now;
      lastTriggeredSample = msg;  // store message text to avoid repeats
    }

    step++;
    if (step > steps) {
      clearInterval(simulateTimer);
      simulateTimer = null;
      const endings = ["You made it along the useless line.","That was very efficient and pointless.","Next: a diagonal trip."];
      showAnime(endings[Math.floor(Math.random()*endings.length)], 3000);
    }
  }, Math.max(20, Math.round(durationMs/steps)));
}


// choose message based on sample flags
function messageForSample(sample) {
  if (!sample || !sample.flags) return "Weird emptiness.";
  const f = sample.flags;
  if (f.water || f.river) return "You go swim!";
  if (f.peak) return "Climb time — bring boots!";
  if (f.forest) return "Forest ahead — bears included.";
  if (f.park) return "Park vibes — picnic when?";
  if (f.highway) return "Cars! Dodge dramatically.";
  if (f.railway) return "Railway — don't be the film extra.";
  if (f.building) return "Urban jungle — stay alert.";
  return "Nothing interesting here... yawn.";
}

// ---------- Helpers ----------
function haversineMeters(lat1, lon1, lat2, lon2) {
  return haversine([lat1, lon1], [lat2, lon2]) * 1000;
}
function haversine(c1, c2){
  const R = 6371; // km
  const lat1 = c1[0] * Math.PI/180, lat2 = c2[0] * Math.PI/180;
  const dLat = (c2[0]-c1[0]) * Math.PI/180;
  const dLon = (c2[1]-c1[1]) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ---------- Draw features already implemented above ----------

// ---------- Anime popup control ----------
let animeTimer = null;
function showAnime(text, ms=2500) {
  const anime = el('anime');
  const speech = el('speech');
  speech.innerText = text;
  anime.classList.remove('hidden');
  requestAnimationFrame(() => anime.classList.add('show')); // animate
  if (animeTimer) clearTimeout(animeTimer);
  animeTimer = setTimeout(() => {
    anime.classList.remove('show');
    setTimeout(()=> anime.classList.add('hidden'), 300);
  }, ms);
}

// ---------- Reset ----------
function resetAll(){
  if (startMarker) map.removeLayer(startMarker); startMarker=null;
  if (destMarker) map.removeLayer(destMarker); destMarker=null;
  if (lineLayer) map.removeLayer(lineLayer); lineLayer=null;
  featuresLayer.clearLayers();
  if (simulateMarker) map.removeLayer(simulateMarker); simulateMarker=null;
  if (simulateTimer) { clearInterval(simulateTimer); simulateTimer=null; }
  samplePoints = []; rawElements = [];
  el('simulateBtn').disabled = true;
  el('distance').textContent = "Distance: —"; el('bearing').textContent = "Bearing: —";
  showToast("Reset.");
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(txt, time=2000){
  const t = el('toast');
  t.textContent = txt; t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.add('hidden'), time);
}

// ---------- Bearing ----------
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI/180;
  const toDeg = r => r * 180/Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const λ1 = toRad(lon1), λ2 = toRad(lon2);
  const y = Math.sin(λ2-λ1) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  let θ = Math.atan2(y,x);
  θ = (toDeg(θ) + 360) % 360;
  return θ;
}
