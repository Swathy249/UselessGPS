/* Smartly Useless GPS — Enhanced
   - Marks detected features (water, forest/park, roads, railways, peaks) on the map.
   - Adaptive sampling and radius to reduce Overpass load.
   - Rotating snark feed with generated context snark + extras.
   - Beginner-friendly comments.
*/

// ---------- Config ----------
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MAX_SAMPLES = 14;   // hard cap so queries don't explode
const MIN_SAMPLES = 4;
const MAX_RADIUS = 1000;  // meters
const MIN_RADIUS = 120;   // meters

// ---------- UI / Map ----------
let map, startMarker, destMarker, lineLayer, featuresLayer;
let feedInterval = null;

function el(id){ return document.getElementById(id); }

document.addEventListener('DOMContentLoaded', () => {
  // init map
  map = L.map('map').setView([20.5937, 78.9629], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  featuresLayer = L.layerGroup().addTo(map);

  el('goBtn').addEventListener('click', onGo);
  el('resetBtn').addEventListener('click', resetAll);
});

// ---------- Main flow ----------
async function onGo(){
  const startName = el('startInput').value.trim();
  const destName  = el('destInput').value.trim();
  const snarkEnabled = el('snarkToggle').checked;
  if (!startName || !destName) { showToast("Please enter start and destination."); return; }

  showToast("Geocoding...");
  try {
    const start = await geocode(startName);
    const dest  = await geocode(destName);
    if (!start || !dest) { showToast("Could not geocode one or both places."); return; }

    plotRoute(start, dest);

    const meters = map.distance([start.lat, start.lon], [dest.lat, dest.lon]);
    const km = (meters/1000).toFixed(2);
    const bearing = calculateBearing(start.lat, start.lon, dest.lat, dest.lon).toFixed(0);

    el('distance').textContent = `Distance: ${km} km (${Math.round(meters)} m)`;
    el('bearing').textContent  = `Bearing: ${bearing}°`;

    // adaptive sampling & radius
    const samples = adaptiveSampleCount(meters);
    const radius  = adaptiveRadius(meters);
    showToast(`Sampling ${samples} points (radius ${Math.round(radius)} m) — querying Overpass...`, 1600);

    const found = await analyzePath(start, dest, samples, radius);
    // Draw feature layers from Overpass results
    drawDetectedFeatures(found.rawElements);

    // Generate snark & start feed rotation
    const generatedSnark = composeSnark(meters, found.flags);
    el('snark').textContent = `Snark: ${generatedSnark}`;
    if (snarkEnabled) startRotatingFeed(generatedSnark);
    showToast("Analysis complete. Enjoy being gloriously misled.", 2000);

  } catch (err) {
    console.error(err);
    showToast("Error: " + (err.message || "something went wrong"));
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
  // clean previous
  if (startMarker) map.removeLayer(startMarker);
  if (destMarker)  map.removeLayer(destMarker);
  if (lineLayer)   map.removeLayer(lineLayer);
  featuresLayer.clearLayers();

  startMarker = L.marker([start.lat, start.lon]).addTo(map).bindPopup("Start: " + start.name).openPopup();
  destMarker  = L.marker([dest.lat, dest.lon]).addTo(map).bindPopup("Destination: " + dest.name).openPopup();
  lineLayer = L.polyline([[start.lat, start.lon],[dest.lat, dest.lon]], { color: 'crimson', weight: 4, dashArray: '6 8' }).addTo(map);
  map.fitBounds(lineLayer.getBounds().pad(0.3));
}

// ---------- Adaptive sampling & radius ----------
function adaptiveSampleCount(meters){
  const km = meters/1000;
  // For very short distances we still want a few samples
  let samples = Math.ceil(km * 3); // 3 samples per km roughly
  if (samples < MIN_SAMPLES) samples = MIN_SAMPLES;
  if (samples > MAX_SAMPLES) samples = MAX_SAMPLES;
  return samples;
}
function adaptiveRadius(meters){
  // base radius proportional to distance but within min/max
  let r = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, meters / 10)); // heuristic
  return r;
}

// ---------- Overpass analysis (single combined query, geom requested) ----------
async function analyzePath(start, dest, samples = 6, radius = 200){
  // produce evenly spaced sample points along lat/lon (linear interp ok for most short/med distances)
  const pts = [];
  for (let i=1;i<=samples;i++){
    const t = i/(samples+1);
    const lat = start.lat + (dest.lat - start.lat)*t;
    const lon = start.lon + (dest.lon - start.lon)*t;
    pts.push({lat: lat.toFixed(6), lon: lon.toFixed(6)});
  }

  // build Overpass query: request geometry (out geom;)
  const wanted = [
    `way(around:R, LAT, LON)[natural=water];`,
    `way(around:R, LAT, LON)[waterway];`,
    `way(around:R, LAT, LON)[landuse=forest];`,
    `way(around:R, LAT, LON)[leisure=park];`,
    `way(around:R, LAT, LON)[highway];`,
    `way(around:R, LAT, LON)[railway];`,
    `node(around:R, LAT, LON)[natural=peak];`
  ];

  let joinParts = [];
  for (const p of pts){
    for (const w of wanted){
      joinParts.push(w.replace('LAT', p.lat).replace('LON', p.lon).replace('R', radius));
    }
  }

  const fullQuery = `[out:json][timeout:25];
(
${joinParts.join("\n")}
);
out geom;`; // geom gives geometry arrays for ways

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: fullQuery,
      headers: { 'Content-Type': 'text/plain' }
    });
    const data = await res.json();
    // interpret results into flags
    const flags = { water:false, river:false, forest:false, park:false, highway:false, railway:false, peak:false, error:false };
    const elements = data.elements || [];
    elements.forEach(el => {
      const t = el.tags || {};
      if (t.natural === 'water') flags.water = true;
      if (t.waterway) flags.river = true;
      if (t.landuse === 'forest') flags.forest = true;
      if (t.leisure === 'park') flags.park = true;
      if (t.highway) flags.highway = true;
      if (t.railway) flags.railway = true;
      if (t.natural === 'peak') flags.peak = true;
    });
    return { flags, rawElements: elements };
  } catch (err) {
    console.warn("Overpass error", err);
    return { flags: { error:true }, rawElements: [] };
  }
}

// ---------- Draw detected features (from Overpass elements) ----------
function drawDetectedFeatures(elements){
  featuresLayer.clearLayers();
  if (!elements || elements.length === 0) return;

  elements.forEach(el => {
    const tags = el.tags || {};
    if (el.type === 'way' && el.geometry && el.geometry.length > 0) {
      const latlngs = el.geometry.map(p => [p.lat, p.lon]);
      // closed polygon?
      const isClosed = (latlngs.length > 2 && latlngs[0][0] === latlngs[latlngs.length-1][0] && latlngs[0][1] === latlngs[latlngs.length-1][1]);

      // Determine style & popup title
      let style = { color: '#888', weight: 3, opacity: 0.8 };
      let title = null;

      if (tags.natural === 'water' || tags.water) {
        style = { color: '#1e90ff', weight: 1, fillColor: '#b6e0ff', fillOpacity: 0.5 };
        title = 'Water';
      } else if (tags.waterway) {
        style = { color: '#1e90ff', weight: 3, dashArray: '2 6' };
        title = 'Waterway';
      } else if (tags.landuse === 'forest') {
        style = { color: '#047857', weight: 1, fillColor: '#bbf1d0', fillOpacity: 0.45 };
        title = 'Forest';
      } else if (tags.leisure === 'park') {
        style = { color: '#065f46', weight: 1, fillColor: '#bde7c9', fillOpacity: 0.45 };
        title = 'Park';
      } else if (tags.highway) {
        style = { color: '#f97316', weight: 3, dashArray: null };
        title = `Road (${tags.highway})`;
      } else if (tags.railway) {
        style = { color: '#111827', weight: 2, dashArray: '4 6' };
        title = `Railway`;
      } else {
        style = { color: '#6b7280', weight: 2 };
        title = Object.keys(tags).length ? Object.entries(tags).slice(0,3).map(kv=>kv.join('=')).join(',') : 'OSM Feature';
      }

      if (isClosed) {
        const poly = L.polygon(latlngs, style).addTo(featuresLayer);
        poly.bindPopup(`<strong>${title}</strong><br>${popupTags(tags)}`);
      } else {
        const pl = L.polyline(latlngs, style).addTo(featuresLayer);
        pl.bindPopup(`<strong>${title}</strong><br>${popupTags(tags)}`);
      }
    } else if (el.type === 'node') {
      // nodes (e.g., peaks)
      if (el.tags && el.tags.natural === 'peak') {
        const mk = L.marker([el.lat, el.lon]).addTo(featuresLayer);
        mk.bindPopup(`<strong>Peak</strong><br>${popupTags(el.tags)}`);
      }
    }
  });
}

function popupTags(tags){
  const lines = Object.entries(tags).slice(0,6).map(([k,v]) => `<em>${k}</em>: ${v}`);
  return lines.join('<br>') || 'No tags';
}

// ---------- Compose snark message ----------
function composeSnark(meters, found){
  const km = meters/1000;
  if (found.error) return "Overpass refused to cooperate — maybe it's napping. Try again later.";

  // collect types present
  const types = [];
  if (found.water) types.push("water");
  if (found.river) types.push("river");
  if (found.forest) types.push("forest");
  if (found.park) types.push("park");
  if (found.highway) types.push("road");
  if (found.railway) types.push("railway");
  if (found.peak) types.push("peak");

  // base messages
  if (types.length === 0) {
    if (km < 0.1) return "It's practically on your doorstep. Stop being dramatic.";
    if (km < 1) return "Tiny stroll. Wear flip-flops.";
    if (km < 50) return "This looks boringly walkable. Or invent teleportation.";
    return "Miles of nothingness — but hey, the line is beautiful.";
  }

  // prioritized messages
  let msg = "";
  if (types.includes("water") || types.includes("river")) msg = "Looks watery — bring a boat or learn instant swimming.";
  else if (types.includes("peak")) msg = "Mountain ahead. Climbing ropes recommended (or a helicopter).";
  else if (types.includes("forest")) msg = "Forest detected. Bears and dramatic fog included free of charge.";
  else if (types.includes("road")) msg = "Roads ahead. Dramatically dodge traffic.";
  else if (types.includes("railway")) msg = "Rails detected. You're not the hero if you stand on them.";
  else if (types.includes("park")) msg = "Park vibes — perfect for a tragic picnic.";

  // distance tweaks
  if (km > 500) msg = "This is absurdly long. Consider a plane or radical life choices.";
  if (km < 0.5 && types.includes("road")) msg = "There's a road nearby — cross it like a fearless pigeon.";

  // combine extras if multiple types
  if (types.length >= 2) {
    msg += " Also: " + types.slice(1,3).join(" & ") + " detected.";
  }

  // final seasoning
  const extras = [
    "Also: bring snacks.",
    "Also: dramatic music improves traversal odds.",
    "Also: don't sue us.",
    "Also: training montage recommended."
  ];
  msg += " " + extras[Math.floor(Math.random()*extras.length)];
  return msg.trim();
}

// ---------- Rotating snark feed ----------
const extraSnarks = [
  "Pro tip: walking fast looks like progress.",
  "GPS says: take a nap halfway.",
  "This line has trust issues.",
  "You look like someone who loves futile quests.",
  "If lost, blame the app."
];
function startRotatingFeed(generatedSnark){
  // stop previous
  if (feedInterval) clearInterval(feedInterval);
  const feedText = el('feedText');
  // Build feed array (generated snark first, then rotating extras)
  const feedArr = [generatedSnark, ...shuffleArray(extraSnarks.slice())];
  let idx = 0;
  feedText.textContent = feedArr[idx];
  feedInterval = setInterval(() => {
    if (!el('snarkToggle').checked) { clearInterval(feedInterval); feedInterval = null; return; }
    idx = (idx + 1) % feedArr.length;
    feedText.textContent = feedArr[idx];
  }, 3800);
}
function shuffleArray(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }

// ---------- Bearing calculation ----------
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const λ1 = toRad(lon1), λ2 = toRad(lon2);
  const y = Math.sin(λ2-λ1) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  let θ = Math.atan2(y,x);
  θ = (toDeg(θ) + 360) % 360;
  return θ;
}

// ---------- Reset ----------
function resetAll(){
  if (startMarker) map.removeLayer(startMarker); startMarker = null;
  if (destMarker)  map.removeLayer(destMarker);  destMarker = null;
  if (lineLayer)   map.removeLayer(lineLayer);   lineLayer = null;
  featuresLayer.clearLayers();
  el('distance').textContent = "Distance: —";
  el('bearing').textContent  = "Bearing: —";
  el('snark').textContent    = "Snark: —";
  el('feedText').textContent = "—";
  if (feedInterval) { clearInterval(feedInterval); feedInterval = null; }
  showToast("Reset — ready for more glorious nonsense.");
}

// ---------- Toast helper ----------
let toastTimer = null;
function showToast(txt, time = 2000){
  const elToast = el('toast');
  elToast.textContent = txt;
  elToast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> elToast.classList.add('hidden'), time);
}
