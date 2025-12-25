import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* =====================
   Configuration
===================== */
var MIN_HEIGHT_METERS = 9;

/* =====================
   Helpers
===================== */
function $(id) {
  return document.getElementById(id);
}

function setStatus(msg, cls) {
  var el = $("status");
  el.className = "small " + (cls || "");
  el.textContent = msg;
}

function haversineMeters(a, b) {
  var R = 6371000;
  var toRad = function (d) { return (d * Math.PI) / 180; };

  var dLat = toRad(b.lat - a.lat);
  var dLon = toRad(b.lon - a.lon);
  var lat1 = toRad(a.lat);
  var lat2 = toRad(b.lat);

  var s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * R * Math.asin(Math.sqrt(s));
}

function approxHeightMeters(tags) {
  // Prefer explicit height
  if (tags.height) {
    var m = parseFloat(String(tags.height).replace(/[^\d.]/g, ""));
    if (!Number.isNaN(m) && m > 0) return m;
  }

  // building:levels -> approx 3m per level
  if (tags["building:levels"]) {
    var levels = parseFloat(String(tags["building:levels"]).replace(/[^\d.]/g, ""));
    if (!Number.isNaN(levels) && levels > 0) return levels * 3.0;
  }

  // tower/mast often have no height; conservative default
  if (tags.man_made === "tower" || tags.man_made === "mast") return 25;

  return null;
}

function titleFor(tags) {
  return tags.name || tags["tower:type"] || tags.man_made || tags.building || "Unnamed structure";
}

function osmUrl(type, id) {
  return "https://www.openstreetmap.org/" + type + "/" + id;
}

/* =====================
   Critical infra label (Option C)
===================== */
function criticalLabel(tags) {
  if (tags.name && String(tags.name).trim().length > 0) {
    return String(tags.name).trim();
  }

  if (tags.amenity) {
    var map = {
      hospital: "Hospital",
      fire_station: "Fire station",
      police: "Police station"
    };
    var human = map[tags.amenity] || "Amenity";
    return human + " (amenity=" + tags.amenity + ")";
  }

  if (tags.power === "substation") {
    var op = tags.operator ? (" - " + tags.operator) : "";
    return "Substation (power=substation)" + op;
  }

  if (tags.man_made === "water_tower") {
    return "Water tower (man_made=water_tower)";
  }

  if (tags.power) return "Power site (power=" + tags.power + ")";
  if (tags.man_made) return "Site (man_made=" + tags.man_made + ")";

  return "Critical site (unnamed)";
}

function elementToPoint(el) {
  // nodes have lat/lon; ways/relations in "out center" give center.lat/center.lon
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function isCritical(tags) {
  return (
    tags.amenity === "hospital" ||
    tags.amenity === "fire_station" ||
    tags.amenity === "police" ||
    tags.power === "substation" ||
    tags.man_made === "water_tower"
  );
}

function isCandidate(tags) {
  return (
    (tags.building && (tags.height || tags["building:levels"])) ||
    tags.man_made === "tower" ||
    tags.man_made === "mast"
  );
}

/* =====================
   Leaflet map
===================== */
var map = L.map("map").setView([30.2672, -97.7431], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

var layerCandidates = L.layerGroup().addTo(map);
var layerCritical = L.layerGroup().addTo(map);
var layerCenter = L.layerGroup().addTo(map);

// Fix default marker icon paths in some bundlers (simple workaround)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"
});

/* =====================
   Data fetch
===================== */
async function zipToLatLon(zip) {
  var res = await fetch("https://api.zippopotam.us/us/" + zip);
  if (!res.ok) throw new Error("ZIP not found");

  var data = await res.json();
  var p = data.places && data.places[0];
  if (!p) throw new Error("ZIP lookup returned no places");

  return {
    lat: parseFloat(p.latitude),
    lon: parseFloat(p.longitude),
    label: p["place name"] + ", " + p["state abbreviation"]
  };
}

async function overpass(query) {
  // Overpass public endpoint
  var res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query
  });
  if (!res.ok) throw new Error("Overpass error: " + res.status);
  return res.json();
}

function buildOverpassQuery(lat, lon, r) {
  // Avoid template literals; use concatenation only.
  return (
    "[out:json][timeout:25];\n" +
    "(\n" +
    "  // Tall candidates\n" +
    "  way(around:" + r + "," + lat + "," + lon + ")[\"building\"][\"building:levels\"];\n" +
    "  way(around:" + r + "," + lat + "," + lon + ")[\"building\"][\"height\"];\n" +
    "  node(around:" + r + "," + lat + "," + lon + ")[\"man_made\"~\"tower|mast\"];\n" +
    "  way(around:" + r + "," + lat + "," + lon + ")[\"man_made\"~\"tower|mast\"];\n" +
    "  relation(around:" + r + "," + lat + "," + lon + ")[\"man_made\"~\"tower|mast\"];\n" +
    "\n" +
    "  // Critical infrastructure\n" +
    "  node(around:" + r + "," + lat + "," + lon + ")[\"amenity\"~\"hospital|fire_station|police\"];\n" +
    "  way(around:" + r + "," + lat + "," + lon + ")[\"amenity\"~\"hospital|fire_station|police\"];\n" +
    "  node(around:" + r + "," + lat + "," + lon + ")[\"power\"=\"substation\"];\n" +
    "  way(around:" + r + "," + lat + "," + lon + ")[\"power\"=\"substation\"];\n" +
    "  node(around:" + r + "," + lat + "," + lon + ")[\"man_made\"=\"water_tower\"];\n" +
    "  way(around:" + r + "," + lat + "," + lon + ")[\"man_made\"=\"water_tower\"];\n" +
    ");\n" +
    "out tags center;\n"
  );
}

/* =====================
   Scoring (includes nearest critical name)
===================== */
function scoreCandidate(candidate, criticalPoints) {
  var h = candidate.heightMeters;

  var within1k = 0;
  var within3k = 0;

  var nearest = Infinity;
  var nearestTitle = null;
  var nearestKind = null;

  for (var i = 0; i < criticalPoints.length; i++) {
    var c = criticalPoints[i];
    var d = haversineMeters(candidate, c);

    if (d < nearest) {
      nearest = d;
      nearestTitle = c.title || "Critical site (unnamed)";
      nearestKind = c.kind || "critical";
    }

    if (d <= 1000) within1k++;
    if (d <= 3000) within3k++;
  }

  var heightScore = Math.log2(1 + h) * 12;
  var densityScore = within1k * 18 + within3k * 6;
  var proximityScore = (nearest === Infinity) ? 0 : Math.max(0, 18 - (nearest / 200));
  var total = heightScore + densityScore + proximityScore;

  return {
    total: total,
    within1k: within1k,
    within3k: within3k,
    nearestMeters: nearest,
    nearestTitle: nearestTitle,
    nearestKind: nearestKind
  };
}

/* =====================
   Export helpers (CSV / GeoJSON)
===================== */
var lastRun = null; // { zip, center, radiusKm, candidates, critical }

function csvEscape(v) {
  var s = (v === null || v === undefined) ? "" : String(v);
  if (s.indexOf('"') !== -1) s = s.replace(/"/g, '""');
  if (s.indexOf(",") !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
    s = '"' + s + '"';
  }
  return s;
}

function buildCandidatesCsv(run) {
  var header = [
    "feature_type",
    "title",
    "lat",
    "lon",
    "height_m",
    "score_total",
    "nearest_critical_title",
    "nearest_critical_kind",
    "nearest_critical_km",
    "critical_within_1km",
    "critical_within_3km",
    "candidate_kind",
    "osm_url"
  ];

  var lines = [];
  lines.push(header.join(","));

  for (var i = 0; i < run.candidates.length; i++) {
    var c = run.candidates[i];
    var nearestKm = Number.isFinite(c.score.nearestMeters) ? (c.score.nearestMeters / 1000) : "";
    var row = [
      "candidate",
      c.title,
      c.lat,
      c.lon,
      c.heightMeters,
      c.score.total,
      c.score.nearestTitle,
      c.score.nearestKind,
      nearestKm,
      c.score.within1k,
      c.score.within3k,
      c.kind,
      c.osm
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  return lines.join("\n");
}

function buildGeoJson(run) {
  var features = [];

  // Center point
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [run.center.lon, run.center.lat] },
    properties: {
      feature_type: "zip_center",
      zip: run.zip,
      label: run.center.label,
      radius_km: run.radiusKm
    }
  });

  // Critical points
  for (var i = 0; i < run.critical.length; i++) {
    var k = run.critical[i];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [k.lon, k.lat] },
      properties: {
        feature_type: "critical",
        title: k.title,
        kind: k.kind
      }
    });
  }

  // Candidate points
  for (var j = 0; j < run.candidates.length; j++) {
    var c = run.candidates[j];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        feature_type: "candidate",
        title: c.title,
        kind: c.kind,
        height_m: c.heightMeters,
        score_total: c.score.total,
        within_1km: c.score.within1k,
        within_3km: c.score.within3k,
        nearest_critical_title: c.score.nearestTitle,
        nearest_critical_kind: c.score.nearestKind,
        nearest_critical_m: c.score.nearestMeters,
        osm_url: c.osm
      }
    });
  }

  return {
    type: "FeatureCollection",
    features: features
  };
}

function downloadText(filename, mimeType, text) {
  var blob = new Blob([text], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Delay revoke to allow the download to start
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function ensureExportUi() {
  // Insert export UI just under the status line, if it doesn't already exist.
  var statusEl = $("status");
  if (!statusEl) return;

  var existing = document.getElementById("exportLinks");
  if (existing) return;

  var wrap = document.createElement("div");
  wrap.id = "exportLinks";
  wrap.className = "small";
  wrap.style.marginTop = "6px";

  wrap.innerHTML =
    '<span class="pill">Export</span> ' +
    '<a href="#" id="exportCsvLink">CSV</a>' +
    " | " +
    '<a href="#" id="exportGeoJsonLink">GeoJSON</a>';

  // Place it right after the status element
  statusEl.parentNode.insertBefore(wrap, statusEl.nextSibling);

  document.getElementById("exportCsvLink").addEventListener("click", function (e) {
    e.preventDefault();
    if (!lastRun) {
      setStatus("Run a search first to export.", "err");
      return;
    }
    var safeZip = String(lastRun.zip || "zip");
    var filename = "meshtastic_candidates_" + safeZip + ".csv";
    var csv = buildCandidatesCsv(lastRun);
    downloadText(filename, "text/csv;charset=utf-8", csv);
  });

  document.getElementById("exportGeoJsonLink").addEventListener("click", function (e) {
    e.preventDefault();
    if (!lastRun) {
      setStatus("Run a search first to export.", "err");
      return;
    }
    var safeZip = String(lastRun.zip || "zip");
    var filename = "meshtastic_sites_" + safeZip + ".geojson";
    var geo = buildGeoJson(lastRun);
    downloadText(filename, "application/geo+json;charset=utf-8", JSON.stringify(geo, null, 2));
  });
}

/* =====================
   UI render
===================== */
function clearMap() {
  layerCandidates.clearLayers();
  layerCritical.clearLayers();
  layerCenter.clearLayers();
}

function renderResults(center, candidates, critical) {
  var resultsEl = $("results");
  resultsEl.innerHTML = "";

  // Center marker
  layerCenter.addLayer(
    L.circleMarker([center.lat, center.lon], { radius: 8 }).bindPopup(
      "<b>ZIP center</b><br>" +
        center.label +
        "<br>" +
        center.lat.toFixed(5) +
        ", " +
        center.lon.toFixed(5)
    )
  );

  // Critical markers (blue circles)
  for (var i = 0; i < critical.length; i++) {
    var c = critical[i];
    layerCritical.addLayer(
      L.circleMarker([c.lat, c.lon], { radius: 5 }).bindPopup(
        "<b>Critical</b><br>" + c.title + "<br>" + c.kind
      )
    );
  }

  // Candidate markers + side list (cards)
  for (var j = 0; j < candidates.length; j++) {
    var cand = candidates[j];

    var card = document.createElement("div");
    card.className = "card";

    var link = document.createElement("a");
    link.href = cand.osm;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = cand.title;

    var heightTxt = cand.heightMeters ? (cand.heightMeters.toFixed(1) + " m") : "unknown";

    var nearestDistTxt = Number.isFinite(cand.score.nearestMeters)
      ? ((cand.score.nearestMeters / 1000).toFixed(2) + " km")
      : "n/a";

    var nearestNameTxt = cand.score.nearestTitle ? cand.score.nearestTitle : "n/a";

    card.innerHTML =
      '<div><span class="pill">Score ' + cand.score.total.toFixed(1) +
      '</span> <span class="pill">Height ' + heightTxt + '</span></div>' +
      '<div style="margin-top:6px;"></div>' +
      '<div class="small">' +
      "Nearest critical: <b>" + nearestNameTxt + "</b> " +
      '<span class="mono">(' + nearestDistTxt + ")</span>" +
      " - within 1km: <b>" + cand.score.within1k + "</b>" +
      " - within 3km: <b>" + cand.score.within3k + "</b>" +
      "</div>" +
      '<div class="small mono" style="margin-top:6px;">' + cand.kind + "</div>";

    var secondDiv = card.querySelector("div:nth-child(2)");
    if (secondDiv) secondDiv.appendChild(link);

    card.addEventListener("click", (function (lat, lon) {
      return function () {
        map.setView([lat, lon], Math.max(map.getZoom(), 15));
      };
    })(cand.lat, cand.lon));

    resultsEl.appendChild(card);

    var popupHtml =
      "<b>" + cand.title + "</b><br>" +
      "Kind: " + cand.kind + "<br>" +
      "Height: " + heightTxt + "<br>" +
      "Nearest critical: " + nearestNameTxt + " (" + nearestDistTxt + ")<br>" +
      "Score: " + cand.score.total.toFixed(1) + "<br>" +
      '<a href="' + cand.osm + '" target="_blank" rel="noreferrer">Open in OSM</a>';

    layerCandidates.addLayer(
      L.marker([cand.lat, cand.lon]).bindPopup(popupHtml)
    );
  }

  // Fit bounds around candidates + center + critical
  var pts = [];
  pts.push([center.lat, center.lon]);

  for (var a = 0; a < candidates.length; a++) pts.push([candidates[a].lat, candidates[a].lon]);
  for (var b = 0; b < critical.length; b++) pts.push([critical[b].lat, critical[b].lon]);

  if (pts.length > 0) {
    var bounds = L.latLngBounds(pts);
    map.fitBounds(bounds.pad(0.15));
  }
}

/* =====================
   Main flow
===================== */
async function run() {
  var zip = $("zip").value.trim();
  var radiusKm = parseFloat($("radiusKm").value);
  var maxCandidates = parseInt($("maxCandidates").value, 10);

  if (!/^\d{5}$/.test(zip)) {
    setStatus("Enter a valid 5-digit ZIP.", "err");
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    setStatus("Radius must be a positive number.", "err");
    return;
  }
  if (!Number.isFinite(maxCandidates) || maxCandidates <= 0) {
    setStatus("Max candidates must be a positive integer.", "err");
    return;
  }

  ensureExportUi(); // show export links (will be usable after first run)

  clearMap();
  setStatus("Looking up ZIP...");

  try {
    var center = await zipToLatLon(zip);
    setStatus("Querying OpenStreetMap around " + center.label + "...");

    var r = Math.round(radiusKm * 1000);
    var query = buildOverpassQuery(center.lat, center.lon, r);
    var data = await overpass(query);

    var elements = data.elements || [];

    var critical = [];
    var candidatesRaw = [];

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var tags = el.tags || {};
      var pt = elementToPoint(el);
      if (!pt) continue;

      if (isCritical(tags)) {
        var ctitle = criticalLabel(tags);
        var ckind = tags.amenity
          ? ("amenity=" + tags.amenity)
          : tags.power
          ? ("power=" + tags.power)
          : tags.man_made
          ? ("man_made=" + tags.man_made)
          : "critical";

        critical.push({
          lat: pt.lat,
          lon: pt.lon,
          title: ctitle,
          kind: ckind
        });
      } else if (isCandidate(tags)) {
        var h = approxHeightMeters(tags);
        if (h === null || h < MIN_HEIGHT_METERS) continue;

        var k = tags.man_made
          ? ("man_made=" + tags.man_made)
          : tags.building
          ? ("building=" + tags.building)
          : "candidate";

        candidatesRaw.push({
          lat: pt.lat,
          lon: pt.lon,
          title: titleFor(tags),
          kind: k,
          heightMeters: h,
          osm: osmUrl(el.type, el.id)
        });
      }
    }

    // Score + sort
    var scored = candidatesRaw.map(function (c) {
      return {
        lat: c.lat,
        lon: c.lon,
        title: c.title,
        kind: c.kind,
        heightMeters: c.heightMeters,
        osm: c.osm,
        score: scoreCandidate(c, critical)
      };
    });

    scored.sort(function (a, b) { return b.score.total - a.score.total; });

    var top = scored.slice(0, Math.max(1, maxCandidates));

    // Save for export
    lastRun = {
      zip: zip,
      center: center,
      radiusKm: radiusKm,
      candidates: top,
      critical: critical
    };

    setStatus(
      "Found " + candidatesRaw.length + " candidates >= " + MIN_HEIGHT_METERS +
      "m and " + critical.length + " critical sites. Showing top " + top.length + "."
    );

    renderResults(center, top, critical);
  } catch (e) {
    console.error(e);
    setStatus("Error: " + e.message, "err");
  }
}

/* =====================
   Events
===================== */
ensureExportUi();
$("go").addEventListener("click", run);
$("zip").addEventListener("keydown", function (e) {
  if (e.key === "Enter") run();
});
