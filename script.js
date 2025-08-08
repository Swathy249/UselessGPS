/* Full integrated Useless GPS:
   - Nominatim geocoding
   - Overpass sampling & feature detection (adaptive)
   - Draw features on the map
   - Compose snark + rotating feed
   - Simulate traversal (animated marker) and trigger snark per sample
*/

// ---------- Config ----------
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MAX_SAMPLES = 14;   // hard cap
const MIN_SAMPLES = 4;
const MAX_RADIUS = 1000;  // meters
const MIN_RADIUS = 120;   // meters

// ---------- UI / Map ----------
let map, startMarker, destMarker, lineLayer, featuresLayer;
let samplePoints = []; // will hold {lat,lng,flags,elements}
let feedInterval = null;
let simulateMarker = null;
let simulateTimer = null;
let lastTriggeredSampleIndex = -1;
let rawElementsCache = []; // Overpass returned elements

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
  el('simulateBtn').addEventListener('click', onSimulate);
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

    const analysis = await analyzePath(start, dest, samples, radius);
    if (analysis.flags.error) {
      el('snark').textContent = `Snark: Couldn't analyze path (Overpass error).`;
      rawElementsCache = [];
      samplePoints = []; 
      el('simulateBtn').disabled = true;
      return;
    }

    rawElementsCache = analysis.rawElements;
    samplePoints = analysis.samples; // each sample has flags & hits
    drawDetectedFeatures(analysis.rawElements);

    // Generate snark & start feed rotation
    const generatedSnark = composeSnark(meters, analysis.flags);
    el('snark').textContent = `Snark: ${generatedSnark}`;
    if (snarkEnabled) startRotatingFeed(generatedSnark);
    showToast("Analysis complete — you are now gloriously misled.", 2000);

    // enable simulate
    el('simulateBtn').disabled = false;
    lastTriggeredSampleIndex = -1; // reset triggers
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
  let samples = Math.ceil(km * 3);
  if (samples < MIN_SAMPLES) samples = MIN_SAMPLES;
  if (samples > MAX_SAMPLES) samples = MAX_SAMPLES;
  return samples;
}
function adaptiveRadius(meters){
  let r = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, meters / 10));
  return r;
}

// ---------- Overpass analysis ----------
async function analyzePath(start, dest, samples = 6, radius = 200){
  // sample points (linear interpolation)
  const pts = [];
  for (let i=1;i<=samples;i++){
    const t = i/(samples+1);
    const lat = start.lat + (dest.lat - start.lat)*t;
    const lon = start.lon + (dest.lon - start.lon)*t;
    pts.push({lat: parseFloat(lat.toFixed(6)), lon: parseFloat(lon.toFixed(6)), flags:{}, hits:[]});
  }

  // build Overpass query (request geom for ways)
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
out geom;`; // geometry so we can draw & compute proximity

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: fullQuery,
      headers: { 'Content-Type': 'text/plain' }
    });
    const data = await res.json();
    const elements = data.elements || [];

    // aggregated flags
    const flags = { water:false, river:false, forest:false, park:false, highway:false, railway:false, peak:false, error:false };

    // For each sample, determine which elements are near it (by checking geometry vertices)
    pts.forEach(p => {
      p.flags = { water:false, river:false, forest:false, park:false, highway:false, railway:false, peak:false };
      p.hits = [];
    });

    elements.forEach(el => {
      const t = el.tags || {};
      // mark global flags
      if (t.natural === 'water') flags.water = true;
      if (t.waterway) flags.river = true;
      if (t.landuse === 'forest') flags.forest = true;
      if (t.leisure === 'park') flags.park = true;
      if (t.highway) flags.highway = true;
      if (t.railway) flags.railway = true;
      if (t.natural === 'peak') flags.peak = true;

      // For proximity checks: get an array of latlng points (nodes or geometry)
      let geom = [];
      if (el.geometry && el.geometry.length) {
        geom = el.geometry.map(g => ({lat: g.lat, lon: g.lon}));
      } else if (el.lat && el.lon) {
        geom = [{lat: el.lat, lon: el.lon}];
      }

      // For each sample, compute minimal distance to any vertex (approx)
      pts.forEach((p, idx) => {
        let minDist = Infinity;
        geom.forEach(gp => {
          const d = haversineMeters(p.lat, p.lon, gp.lat, gp.lon);
          if (d < minDist) minDist = d;
        });
        if (minDist <= radius) {
          // mark which tag
          if (t.natural === 'water') p.flags.water = true;
          if (t.waterway) p.flags.river = true;
          if (t.landuse === 'forest') p.flags.forest = true;
          if (t.leisure === 'park') p.flags.park = true;
          if (t.highway) p.flags.highway = true;
          if (t.railway) p.flags.railway = true;
          if (t.natural === 'peak') p.flags.peak = true;
          p.hits.push({element: el, dist: minDist});
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
      const latlngs = el.geometry.map(p => [p.lat, p.lon]);
      const isClosed = (latlngs.length > 2 && latlngs[0][0] === latlngs[latlngs.length-1][0] && latlngs[0][1] === latlngs[latlngs.length-1][1]);

      let style = { color: '#888', weight: 3, opacity: 0.8 };
      let title = 'OSM Feature';

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
        style = { color: '#f97316', weight: 3 };
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

  const types = [];
  if (found.water) types.push("water");
  if (found.river) types.push("river");
  if (found.forest) types.push("forest");
  if (found.park) types.push("park");
  if (found.highway) types.push("road");
  if (found.railway) types.push("railway");
  if (found.peak) types.push("peak");

  if (types.length === 0) {
    if (km < 0.1) return "It's practically on your doorstep. Stop being dramatic.";
    if (km < 1) return "Tiny stroll. Wear flip-flops.";
    if (km < 50) return "This looks boringly walkable. Or invent teleportation.";
    return "Miles of nothingness — but hey, the line is beautiful.";
  }

  let msg = "";
  if (types.includes("water") || types.includes("river")) msg = "Looks watery — bring a boat or learn instant swimming.";
  else if (types.includes("peak")) msg = "Mountain ahead. Climbing ropes recommended (or a helicopter).";
  else if (types.includes("forest")) msg = "Forest detected. Bears and dramatic fog included free of charge.";
  else if (types.includes("road")) msg = "Roads ahead. Dramatically dodge traffic.";
  else if (types.includes("railway")) msg = "Rails detected. You're not the hero if you stand on them.";
  else if (types.includes("park")) msg = "Park vibes — perfect for a tragic picnic.";

  if (km > 500) msg = "This is absurdly long. Consider a plane or radical life choices.";
  if (km < 0.5 && types.includes("road")) msg = "There's a road nearby — cross it like a fearless pigeon.";

  if (types.length >= 2) {
    msg += " Also: " + types.slice(1,3).join(" & ") + " detected.";
  }

  const extras = ["Also: bring snacks.","Also: dramatic music improves traversal odds.","Also: don't sue us.","Also: training montage recommended."];
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
  if (feedInterval) clearInterval(feedInterval);
  const feedText = el('feedText');
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

// ---------- Traversal simulation ----------
function onSimulate(){
  if (!lineLayer) { showToast("Draw a line first (Go Straight)."); return; }
  if (!samplePoints || samplePoints.length === 0) { showToast("No sample data — run analysis first."); return; }
  // remove previous marker
  if (simulateMarker) map.removeLayer(simulateMarker);
  if (simulateTimer) clearInterval(simulateTimer);
  lastTriggeredSampleIndex = -1;

  const pathLatLngs = lineLayer.getLatLngs();
  // We'll interpolate along this single segment from start->dest (simple linear steps)
  const start = pathLatLngs[0];
  const dest = pathLatLngs[pathLatLngs.length-1];
  const meters = map.distance(start, dest);
  const durationMs = Math.min(30000, Math.max(4000, meters * 2)); // heuristic: speed scales with distance
  const steps = Math.max(80, Math.min(1000, Math.round(durationMs/30)));
  let step = 0;

  simulateMarker = L.circleMarker(start, {radius:8, color:'blue', fillColor:'deepskyblue', fillOpacity:0.9}).addTo(map);

  simulateTimer = setInterval(() => {
    const t = step / steps;
    const curLat = start.lat + (dest.lat - start.lat) * t;
    const curLng = start.lng + (dest.lng - start.lng) * t;
    simulateMarker.setLatLng([curLat, curLng]);

    // check nearest sample index
    let nearestIdx = -1;
    let nearestDist = Infinity;
    samplePoints.forEach((s, idx) => {
      const d = haversineMeters(curLat, curLng, s.lat, s.lon);
      if (d < nearestDist) { nearestDist = d; nearestIdx = idx; }
    });

    // when we pass a sample point and it has hits & not triggered, trigger snark
    if (nearestIdx !== -1 && nearestIdx !== lastTriggeredSampleIndex && nearestDist <= adaptiveRadius(map.distance(start,dest)) ) {
      const sample = samplePoints[nearestIdx];
      if (sample && sample.hits && sample.hits.length > 0) {
        // compose a small snark for this sample
        const types = [];
        if (sample.flags.water) types.push("water");
        if (sample.flags.river) types.push("river");
        if (sample.flags.forest) types.push("forest");
        if (sample.flags.park) types.push("park");
        if (sample.flags.highway) types.push("road");
        if (sample.flags.railway) types.push("rail");
        if (sample.flags.peak) types.push("peak");
        let msg = "Encountered: " + types.join(", ");
        if (!msg.trim()) msg = "Weird stuff here.";
        // show toast and append to snark area
        showToast(msg, 2200);
        el('snark').textContent = `Snark: ${msg}`;
        lastTriggeredSampleIndex = nearestIdx;
      }
    }

    step++;
    if (step > steps) {
      clearInterval(simulateTimer);
      simulateTimer = null;
      // final snark
      const finalExtras = ["Congrats, you survived the line.","This was a very direct journey.","Next time, take a bus."];
      const finalMsg = finalExtras[Math.floor(Math.random()*finalExtras.length)];
      showToast(finalMsg, 3000);
      el('snark').textContent = `Snark: ${finalMsg}`;
    }
  }, Math.max(10, Math.round(durationMs / steps)));
}

// ---------- Helpers ----------
function haversineMeters(lat1, lon1, lat2, lon2) {
  return haversineDistance([lat1, lon1], [lat2, lon2]) * 1000;
}
function haversineDistance(coord1, coord2) {
  const R = 6371; // km
  const lat1 = coord1[0] * Math.PI/180;
  const lat2 = coord2[0] * Math.PI/180;
  const dLat = (coord2[0]-coord1[0]) * Math.PI/180;
  const dLon = (coord2[1]-coord1[1]) * Math.PI/180;

  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ---------- Reset ----------
function resetAll(){
  if (startMarker) map.removeLayer(startMarker); startMarker = null;
  if (destMarker)  map.removeLayer(destMarker);  destMarker = null;
  if (lineLayer)   map.removeLayer(lineLayer);   lineLayer = null;
  featuresLayer.clearLayers();
  if (simulateMarker) map.removeLayer(simulateMarker);
  if (simulateTimer) { clearInterval(simulateTimer); simulateTimer = null; }
  samplePoints = []; rawElementsCache = [];
  if (feedInterval) clearInterval(feedInterval);
  el('distance').textContent = "Distance: —";
  el('bearing').textContent  = "Bearing: —";
  el('snark').textContent    = "Snark: —";
  el('feedText').textContent = "—";
  el('simulateBtn').disabled = true;
  showToast("Reset — ready for more glorious nonsense.");
}

// ---------- Toast helper ----------
let toastTimer = null;
function showToast(txt, time = 2200){
  const elToast = el('toast');
  elToast.textContent = txt;
  elToast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> elToast.classList.add('hidden'), time);
}

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
