import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("reports");

const sources = {
  tileMath: "https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames",
  crusoeAbilene: "https://crusoe.ai/newsroom/crusoe-expands-ai-data-center-campus-in-abilene-to-1-2-gigawatts",
  metaRichland:
    "https://www.datacentermap.com/usa/louisiana/shreveport/meta-hyperion-building-2/",
  awsLouisiana:
    "https://www.fox8live.com/2026/02/24/campuses-newly-announced-amazon-data-center-spanning-bossier-caddo-parishes-confirmed/?outputType=amp",
  coreweaveLancaster: "https://www.cityoflancasterpa.gov/data-center/",
  joliet: "https://joliet.legistar.com/View.ashx?GUID=9AA55BE3-8202-4DE9-8C73-109F9714A9FA&ID=15317176&M=F",
  stargate: "https://apnews.com/article/0b3f4fa6e8d8141b4c143e3e7f41aba1",
  lockheedCourtland:
    "https://www.lockheedmartin.com/en-us/news/features/2026/where-history-meets-the-future-of-missile-defense.html",
  lockheedTroy:
    "https://www.lockheedmartin.com/en-us/news/statements-speeches/2026/press-briefing-transcript--under-secretary-of-war-michael-p-duffey-lockheed-martin-jim-taiclet-discuss-increasing-critical-munitions-and-opening-munitions-production-center-building-troy-alabama.html",
  lockheedHuntsville:
    "https://www.aerotime.aero/articles/lockheed-martin-hypersonics-integration-lab-huntsville-alabama",
  qatarMountainHome: "https://apnews.com/article/fc1506584e7833dbde3e16fe8613b6b4",
  mountainHomeArea: "https://cumulis.epa.gov/supercpad/cursites/csitinfo.cfm?id=1000302",
  fortBliss: "https://home.army.mil/bliss/my-fort",
  fortBlissMain:
    "https://home.army.mil/bliss/download_file/view/764/366",
  iconFortBliss:
    "https://www.iconbuild.com/newsroom/u-s-army-awards-icon-a-62-8m-production-contract-for-new-series-of-3d-printed-barracks-at-fort-bliss-in-west-texas",
  yongin:
    "https://en.news1.kr/economy/5510604",
  cheongju:
    "https://www.prnewswire.com/news-releases/sk-hynix-to-build-m15x-fab-in-cheongju-301617986.html",
  samsungPyeongtaek:
    "https://semiconductor.samsung.com/about-us/locations/",
  lguPaju: "https://www.lguplus.com/biz/solution/type/aidc",
  samsungGumi:
    "https://www.samsungsds.com/eu/newsroom/gumi-260112.html",
  skAwsUlsan: "https://www.datacenterdynamics.com/en/news/sk-group-and-aws-break-ground-for-data-center-in-ulsan-korea/",
  kddiSakai: "https://newsroom.kddi.com/english/news/detail/kddi_nr-916_4323.html",
  mageshima:
    "https://www.asahi.com/ajw/articles/14812738",
  nyutabaru:
    "https://www.mod.go.jp/en/publ/w_paper/wp2021/DOJ2021_EN_Reference.pdf",
};

const acreToKm2 = (acres) => acres * 0.0040468564224;
const sqftToKm2 = (sqft) => sqft * 0.00000009290304;

const sites = [
  {
    id: "prince-edward-islands-marion-region",
    name: "Prince Edward Islands / Marion Island Region",
    category: "Supplied Mapbox tile range",
    operator: "South Africa / Western Cape jurisdiction",
    publicLocation: "Prince Edward Islands and Marion Island region, southern Indian Ocean",
    lat: -48.65532871541818,
    lon: 36.016273498535156,
    reportedAreaKm2: 316,
    tileCoverageAreaKm2: null,
    confidence: "medium",
    fixedTileRanges: [
      [1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2],
      [3, 4, 5, 4, 5],
      [4, 9, 10, 9, 10],
      [5, 18, 20, 19, 21],
      [6, 37, 40, 39, 43],
      [7, 74, 81, 79, 86],
      [8, 149, 163, 158, 172],
      [9, 298, 326, 316, 345],
      [10, 596, 652, 632, 690],
      [11, 1192, 1305, 1265, 1380],
      [12, 2384, 2611, 2530, 2761],
      [13, 4769, 5223, 5061, 5523],
      [14, 9539, 10446, 10122, 11046],
      [15, 19079, 20893, 20244, 22092],
      [16, 38159, 41786, 40489, 44184],
      [17, 76319, 83573, 80978, 88369],
      [18, 152639, 167147, 161957, 176739],
      [19, 305278, 334295, 323914, 353478],
    ],
    notes:
      "Inserted from the user-supplied tile ranges. The most detailed z19 range resolves to a large southern Indian Ocean envelope around the Prince Edward Islands / Marion Island area; the range is much larger than the islands' land footprint.",
    sources: [
      "https://www.dffe.gov.za/antarctica-and-southern-oceans-islands",
      "https://www.britannica.com/place/Prince-Edward-Islands",
    ],
  },
  {
    id: "stargate-crusoe-abilene",
    name: "Stargate / Crusoe Abilene Campus",
    category: "AI data center",
    operator: "Crusoe / Oracle / OpenAI / Lancium",
    publicLocation: "5502 Spinks Rd, Abilene, Texas 79601",
    lat: 32.502213,
    lon: -99.788717,
    reportedAreaKm2: acreToKm2(1000),
    tileCoverageAreaKm2: acreToKm2(1000),
    confidence: "medium",
    notes:
      "Address and campus identity are publicly corroborated. Center is adjusted to a published public coordinate for Project Artemis / Abilene Clean Campus; bbox remains an equivalent-area site envelope, not a surveyed parcel.",
    sources: [sources.crusoeAbilene, "https://www.gem.wiki/Project_Artemis"],
  },
  {
    id: "meta-hyperion-richland-parish",
    name: "Meta Hyperion / Richland Parish Data Center",
    category: "AI data center",
    operator: "Meta",
    publicLocation: "LA-183 & Wade Rd, Rayville / Richland Parish, Louisiana",
    lat: 32.5059261,
    lon: -91.6350739,
    reportedAreaKm2: acreToKm2(2250),
    tileCoverageAreaKm2: acreToKm2(2250),
    confidence: "medium",
    notes:
      "Public point from the supplied intersection; area is the publicly reported 2,250-acre campus, represented as an equivalent-area square.",
    sources: [sources.metaRichland],
  },
  {
    id: "google-goodnight-armstrong-county",
    name: "Google Armstrong County / Goodnight Campus",
    category: "AI/cloud infrastructure",
    operator: "Google",
    publicLocation: "Goodnight area, Armstrong County, Texas",
    lat: 35.0195588,
    lon: -101.3023416,
    reportedAreaKm2: null,
    tileCoverageAreaKm2: 4.0,
    confidence: "low",
    notes:
      "No exact public parcel boundary found in this pass; generated as a 4.0 km2 planning coverage box around the user-supplied centroid.",
    sources: [],
  },
  {
    id: "aws-louisiana-blanchard-caddo",
    name: "AWS Louisiana Data Center Campus - Blanchard / Caddo Parish",
    category: "AI/cloud data center",
    operator: "Amazon / AWS",
    publicLocation: "North of Blanchard Latex Rd on State Line Rd, Caddo Parish, Louisiana",
    lat: 32.62,
    lon: -93.95,
    reportedAreaKm2: null,
    tileCoverageAreaKm2: 4.0,
    confidence: "low",
    notes:
      "Public reporting identifies the road corridor, not a released parcel. This is a 4.0 km2 planning coverage box around the supplied centroid.",
    sources: [sources.awsLouisiana],
  },
  {
    id: "aws-louisiana-benton-bossier",
    name: "AWS Louisiana Data Center Campus - Benton / Bossier Parish",
    category: "AI/cloud data center",
    operator: "Amazon / AWS",
    publicLocation: "Highway 3 west side north of Benton, Bossier Parish, Louisiana",
    lat: 32.78,
    lon: -93.74,
    reportedAreaKm2: null,
    tileCoverageAreaKm2: 4.0,
    confidence: "low",
    notes:
      "Public reporting identifies the road corridor, not a released parcel. This is a 4.0 km2 planning coverage box around the supplied centroid.",
    sources: [sources.awsLouisiana],
  },
  {
    id: "coreweave-lancaster",
    name: "CoreWeave Lancaster AI Data Center",
    category: "AI data center",
    operator: "CoreWeave / Chirisa Technology Parks",
    publicLocation: "216 Greenfield Rd, Lancaster, Pennsylvania",
    lat: 40.048747,
    lon: -76.256144,
    reportedAreaKm2: acreToKm2(78.07),
    tileCoverageAreaKm2: acreToKm2(78.07),
    confidence: "medium",
    notes:
      "Public address is city-confirmed and commercial-property sources list the 216 Greenfield Road lot at about 78.07 acres. Coverage is still an equivalent-area envelope, not parcel geometry.",
    sources: [
      sources.coreweaveLancaster,
      "https://www.commercialcafe.com/commercial-property/us/pa/lancaster/216-greenfield-road/",
    ],
  },
  {
    id: "joliet-technology-center",
    name: "Joliet Technology Center",
    category: "AI/cloud data center",
    operator: "PowerHouse Data Centers / Hillwood",
    publicLocation: "S. Rowell Rd and Bernhard Rd area, Joliet, Will County, Illinois",
    lat: 41.459723,
    lon: -88.0560382,
    reportedAreaKm2: acreToKm2(795),
    tileCoverageAreaKm2: acreToKm2(795),
    confidence: "low",
    notes:
      "City materials describe an approximately 795-acre annexation site; represented as an equivalent-area square around the supplied centroid.",
    sources: [sources.joliet],
  },
  {
    id: "stargate-shackelford-county",
    name: "Stargate Shackelford County Site",
    category: "AI data center",
    operator: "OpenAI / Oracle / SoftBank",
    publicLocation: "Shackelford County, Texas",
    lat: 32.541852,
    lon: -99.5398082,
    reportedAreaKm2: acreToKm2(1200),
    tileCoverageAreaKm2: acreToKm2(1200),
    confidence: "low",
    notes:
      "Exact address was not public in the sources checked; the supplied point is treated as a county-level planning centroid with an equivalent-area box.",
    sources: [sources.stargate],
  },
  {
    id: "lockheed-courtland-mab5",
    name: "Next Generation Interceptor Facility / MAB-5",
    category: "Defense industrial facility",
    operator: "Lockheed Martin / Missile Defense Agency",
    publicLocation: "Courtland, Alabama",
    lat: 34.6701785,
    lon: -87.352048,
    reportedAreaKm2: sqftToKm2(88000),
    tileCoverageAreaKm2: 0.25,
    confidence: "low",
    notes:
      "Public source gives building size and town. Center is public Lockheed Martin Way/Courtland campus geocode; range is a non-internal campus-level envelope, not a building-level coordinate.",
    sources: [sources.lockheedCourtland],
  },
  {
    id: "lockheed-huntsville-hypersonics-sil",
    name: "Hypersonics System Integration Lab",
    category: "Defense industrial lab",
    operator: "Lockheed Martin",
    publicLocation: "Huntsville, Alabama campus",
    lat: 34.7272933,
    lon: -86.6453694,
    reportedAreaKm2: sqftToKm2(17000),
    tileCoverageAreaKm2: 0.1,
    confidence: "low",
    notes:
      "Public source gives lab size and campus; tile range is a non-internal campus-level envelope.",
    sources: [sources.lockheedHuntsville],
  },
  {
    id: "lockheed-troy-building-47",
    name: "Munitions Production Center / Building 47",
    category: "Defense industrial facility",
    operator: "Lockheed Martin",
    publicLocation: "Troy, Alabama campus",
    lat: 31.9822393,
    lon: -85.9861611,
    reportedAreaKm2: sqftToKm2(87000),
    tileCoverageAreaKm2: acreToKm2(3863),
    confidence: "medium",
    notes:
      "Public source gives Building 47 size; Lockheed publishes Troy Operations at 5500 Co Rd 37 over 3,863 acres. Coverage is public campus-level, not building-level.",
    sources: [sources.lockheedTroy, "https://www.lockheedmartin.com/en-us/who-we-are/business-areas/missiles-and-fire-control/troy.html"],
  },
  {
    id: "qatar-training-mountain-home-afb",
    name: "Qatari Emiri Air Force Training Facility",
    category: "Military training facility",
    operator: "U.S. Air Force / Qatar",
    publicLocation: "Mountain Home Air Force Base, Elmore County, Idaho",
    lat: 43.0495485,
    lon: -115.8659691,
    reportedAreaKm2: 9 * 2.589988110336,
    tileCoverageAreaKm2: 9 * 2.589988110336,
    confidence: "low",
    notes:
      "Public source describes a facility inside an existing U.S. base, not a separate foreign base. Center is public base-level geocode; coverage uses public base-level area and excludes internal building coordinates.",
    sources: [sources.qatarMountainHome, sources.mountainHomeArea],
  },
  {
    id: "fort-bliss-icon-3d-barracks",
    name: "3D-Printed Barracks Expansion",
    category: "Military construction",
    operator: "U.S. Army / ICON",
    publicLocation: "Fort Bliss, El Paso, Texas; some Camp McGregor, New Mexico",
    lat: 31.8340284,
    lon: -106.3815018,
    reportedAreaKm2: acreToKm2(3150),
    tileCoverageAreaKm2: acreToKm2(3150),
    confidence: "low",
    notes:
      "Army/ICON sources confirm the Fort Bliss program. Coverage uses the public Main Post/cantonment scale, not exact barracks or Camp McGregor building coordinates.",
    sources: [sources.iconFortBliss, sources.fortBliss, sources.fortBlissMain],
  },
  {
    id: "sk-yongin-semiconductor-cluster",
    name: "SK Yongin Semiconductor Cluster",
    category: "AI semiconductor fab cluster",
    operator: "SK hynix",
    publicLocation: "Wonsam-myeon, Cheoin-gu, Yongin-si, Gyeonggi-do",
    lat: 37.1705,
    lon: 127.332,
    reportedAreaKm2: 4.15,
    tileCoverageAreaKm2: 4.15,
    confidence: "medium",
    notes:
      "Public sources give Wonsam-myeon and about 4.15 million m2; centroid is approximate and represented with an equivalent-area square.",
    sources: [sources.yongin],
  },
  {
    id: "sk-cheongju-m15x",
    name: "SK Cheongju M15X",
    category: "AI semiconductor fab",
    operator: "SK hynix",
    publicLocation: "Cheongju Technopolis, Heungdeok-gu, Cheongju-si, Chungcheongbuk-do",
    lat: 36.654,
    lon: 127.425,
    reportedAreaKm2: 0.06,
    tileCoverageAreaKm2: 0.25,
    confidence: "low",
    notes:
      "Public source gives M15X as a 60,000 m2 site in Cheongju Technopolis. Coverage uses a 0.25 km2 local envelope because no parcel corners are included.",
    sources: [sources.cheongju],
  },
  {
    id: "samsung-pyeongtaek-p5",
    name: "Samsung Pyeongtaek Campus P5",
    category: "AI semiconductor fab",
    operator: "Samsung Electronics",
    publicLocation: "Pyeongtaek Campus, Godeok-myeon, Pyeongtaek-si, Gyeonggi-do",
    lat: 37.0356175,
    lon: 127.0531633,
    reportedAreaKm2: null,
    tileCoverageAreaKm2: 1.0,
    confidence: "low",
    notes:
      "Samsung publishes the Pyeongtaek campus address. The prior centroid was not validated; this center is adjusted to public Korean address data for Samsung-ro 114 / Pyeongtaek campus. P5-specific parcel corners remain not public in this pass.",
    sources: [
      sources.samsungPyeongtaek,
      "https://findby.co.kr/details/17786-412203350996-st-652c10c9f27008be2c63a44c",
    ],
  },
  {
    id: "lguplus-paju-data-center",
    name: "LG U+ Paju Data Center",
    category: "Data center",
    operator: "LG U+",
    publicLocation: "Deokeun-ri 1239-1, Wollong-myeon, Paju-si, Gyeonggi-do",
    lat: 37.75,
    lon: 126.75,
    reportedAreaKm2: 0.073712,
    tileCoverageAreaKm2: 0.073712,
    confidence: "low",
    notes:
      "LG U+ publishes the Deokeun-ri address and gross floor area; Korean construction data lists the project land at 73,712 m2. The centroid remains user-supplied because public geocoding did not resolve parcel 1239-1 in this pass.",
    sources: [sources.lguPaju, "https://www.lendershield.ai/_detail/detail.jsp?biz_no=6698702230"],
  },
  {
    id: "samsung-gumi-data-center",
    name: "Samsung Gumi Data Center",
    category: "AI data center",
    operator: "Samsung SDS",
    publicLocation: "Former Samsung Electronics Gumi Plant 1, Gumi-si, Gyeongsangbuk-do",
    lat: 36.0997222,
    lon: 128.3911111,
    reportedAreaKm2: 0.198,
    tileCoverageAreaKm2: 0.198,
    confidence: "medium",
    notes:
      "Samsung SDS announced a 60 MW data center at former Samsung Electronics Gumi Plant 1. Center is adjusted to public Gumi Plant 1 coordinates and area is the published 198,000 m2 Plant 1 site.",
    sources: [
      sources.samsungGumi,
      "https://gumi.grandculture.net/gumi/toc/GC01201765",
      "https://wikimapia.org/2068102/ko/%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90-%EA%B5%AC%EB%AF%B81%EC%82%AC%EC%97%85%EC%9E%A5",
    ],
  },
  {
    id: "sk-aws-ulsan-data-center",
    name: "SK/AWS Ulsan Data Center",
    category: "AI data center",
    operator: "SK Group / AWS",
    publicLocation: "Mipo National Industrial Complex, Ulsan, South Korea",
    lat: 35.460013,
    lon: 129.357843,
    reportedAreaKm2: 0.036,
    tileCoverageAreaKm2: 0.036,
    confidence: "medium",
    notes:
      "Public source identifies a 36,000 m2 Hwangseong-dong site in the Mipo National Industrial Complex, formerly SK Chemicals. Center is adjusted to public SK Chemicals Ulsan plant coordinate.",
    sources: [
      sources.skAwsUlsan,
      "https://biz.chosun.com/en/en-it/2025/06/15/E6HQVT7K2RAOJI2XG7ESGTKQ4Q/?outputType=amp",
      "https://xn--hq1bk10a0wb12g.kr/facility/emission-facility-45314/",
    ],
  },
  {
    id: "kddi-osaka-sakai-data-center",
    name: "KDDI Osaka Sakai Data Center",
    category: "AI data center",
    operator: "KDDI",
    publicLocation: "Sakai, Osaka Prefecture, Japan",
    lat: 34.597111,
    lon: 135.439667,
    reportedAreaKm2: null,
    tileCoverageAreaKm2: 0.5,
    confidence: "medium",
    notes:
      "KDDI says the data center reuses facilities at the Sharp Sakai Plant site; supplied coordinate is used with a compact site envelope.",
    sources: [sources.kddiSakai],
  },
  {
    id: "mageshima-sdf-fclp",
    name: "Mageshima SDF Base / FCLP Facility",
    category: "Military training base",
    operator: "Japan Self-Defense Forces",
    publicLocation: "Mageshima, Nishinoomote, Kagoshima Prefecture, Japan",
    lat: 30.7453314,
    lon: 130.8544937,
    reportedAreaKm2: 8.2,
    tileCoverageAreaKm2: 8.2,
    confidence: "medium",
    notes:
      "Coverage uses public island-scale area and OSM/Nominatim island centroid; it does not identify internal base structures.",
    sources: [sources.mageshima],
  },
  {
    id: "jasdf-nyutabaru-air-base",
    name: "JASDF Nyutabaru Air Base",
    category: "Military air base",
    operator: "Japan Air Self-Defense Force",
    publicLocation: "Nyuta, Shintomi, Koyu District, Miyazaki Prefecture, Japan",
    lat: 32.0841222,
    lon: 131.4543682,
    reportedAreaKm2: 9.135,
    tileCoverageAreaKm2: 9.135,
    confidence: "medium",
    notes:
      "Coverage uses public air-base-level area and public OSM/Nominatim base geocode; it does not identify internal facilities.",
    sources: [sources.nyutabaru],
  },
];

function bboxFromArea(lat, lon, areaKm2) {
  const sideKm = Math.sqrt(areaKm2);
  const halfLat = (sideKm / 2) / 110.574;
  const halfLon = (sideKm / 2) / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    west: lon - halfLon,
    south: lat - halfLat,
    east: lon + halfLon,
    north: lat + halfLat,
  };
}

function lonToTileX(lon, zoom) {
  const n = 2 ** zoom;
  return Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
}

function tileXToLon(x, zoom) {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function bboxForTileRange({ z, xStart, xEnd, yStart, yEnd }) {
  return {
    west: tileXToLon(xStart, z),
    south: tileYToLat(yEnd + 1, z),
    east: tileXToLon(xEnd + 1, z),
    north: tileYToLat(yStart, z),
  };
}

function bboxAreaKm2(bbox) {
  const latKm = Math.abs(bbox.north - bbox.south) * 110.574;
  const centerLat = (bbox.north + bbox.south) / 2;
  const lonKm = Math.abs(bbox.east - bbox.west) * 111.32 * Math.cos((centerLat * Math.PI) / 180);
  return latKm * lonKm;
}

function fixedRange(tuple) {
  const [z, xStart, yStart, xEnd, yEnd] = tuple;
  return {
    z,
    xStart,
    xEnd,
    yStart,
    yEnd,
    tiles: (xEnd - xStart + 1) * (yEnd - yStart + 1),
    pathRange: `${z}/${xStart}/${yStart}/ - ${z}/${xEnd}/${yEnd}/`,
  };
}

function latToTileY(lat, zoom) {
  const limitedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (limitedLat * Math.PI) / 180;
  const n = 2 ** zoom;
  return Math.max(
    0,
    Math.min(n - 1, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)),
  );
}

function rangeForBbox(bbox, zoom) {
  const xStart = lonToTileX(bbox.west, zoom);
  const xEnd = lonToTileX(bbox.east, zoom);
  const yStart = latToTileY(bbox.north, zoom);
  const yEnd = latToTileY(bbox.south, zoom);
  return {
    z: zoom,
    xStart,
    xEnd,
    yStart,
    yEnd,
    tiles: (xEnd - xStart + 1) * (yEnd - yStart + 1),
    pathRange: `${zoom}/${xStart}/${yStart}/ - ${zoom}/${xEnd}/${yEnd}/`,
  };
}

function fmt(value, digits = 7) {
  return value == null ? "" : Number(value).toFixed(digits);
}

const generatedAt = new Date().toISOString();
const report = sites.map((site) => {
  const tileRanges = site.fixedTileRanges
    ? site.fixedTileRanges.map(fixedRange)
    : Array.from({ length: 19 }, (_, i) => rangeForBbox(bboxFromArea(site.lat, site.lon, site.tileCoverageAreaKm2), i + 1));
  const bbox = site.fixedTileRanges
    ? bboxForTileRange(tileRanges[tileRanges.length - 1])
    : bboxFromArea(site.lat, site.lon, site.tileCoverageAreaKm2);
  const tileCoverageAreaKm2 = site.tileCoverageAreaKm2 ?? bboxAreaKm2(bbox);
  return {
    ...site,
    tileCoverageAreaKm2,
    generatedAt,
    coordinateSystem: "Mapbox/XYZ Web Mercator z/x/y",
    bbox,
    tileRanges,
  };
});

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const csvRows = [
  [
    "id",
    "name",
    "category",
    "operator",
    "public_location",
    "center_lat",
    "center_lon",
    "reported_area_km2",
    "tile_coverage_area_km2",
    "bbox_west",
    "bbox_south",
    "bbox_east",
    "bbox_north",
    "confidence",
    "zoom",
    "x_start",
    "x_end",
    "y_start",
    "y_end",
    "tiles",
    "path_range",
    "notes",
    "sources",
  ],
];

for (const site of report) {
  for (const r of site.tileRanges) {
    csvRows.push([
      site.id,
      site.name,
      site.category,
      site.operator,
      site.publicLocation,
      fmt(site.lat),
      fmt(site.lon),
      site.reportedAreaKm2 == null ? "" : site.reportedAreaKm2.toFixed(6),
      site.tileCoverageAreaKm2.toFixed(6),
      fmt(site.bbox.west),
      fmt(site.bbox.south),
      fmt(site.bbox.east),
      fmt(site.bbox.north),
      site.confidence,
      r.z,
      r.xStart,
      r.xEnd,
      r.yStart,
      r.yEnd,
      r.tiles,
      r.pathRange,
      site.notes,
      site.sources.join(" "),
    ]);
  }
}

const csv = csvRows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";

const md = [
  "# Location Mapbox XYZ Tile Ranges",
  "",
  `Generated: ${generatedAt}`,
  "",
  "Coordinate system: Mapbox/XYZ Web Mercator `z/x/y`, with inclusive tile ranges. For a bbox, `xStart/xEnd` are west/east and `yStart/yEnd` are north/south.",
  "",
  "Military-related entries use public base/campus/island-level coverage only. They do not identify internal building coordinates.",
  "",
  "## Summary",
  "",
  "| # | ID | Center lat, lon | Coverage km2 | BBox W,S,E,N | Confidence |",
  "| - | - | - | -: | - | - |",
  ...report.map(
    (site, idx) =>
      `| ${idx + 1} | ${site.id} | ${fmt(site.lat)}, ${fmt(site.lon)} | ${site.tileCoverageAreaKm2.toFixed(3)} | ${fmt(site.bbox.west)}, ${fmt(site.bbox.south)}, ${fmt(site.bbox.east)}, ${fmt(site.bbox.north)} | ${site.confidence} |`,
  ),
  "",
  "## Ranges",
  "",
  ...report.flatMap((site, idx) => [
    `### ${idx + 1}. ${site.name}`,
    "",
    `- ID: \`${site.id}\``,
    `- Public location: ${site.publicLocation}`,
    `- Center: ${fmt(site.lat)}, ${fmt(site.lon)}`,
    `- Reported area km2: ${site.reportedAreaKm2 == null ? "not public/unknown" : site.reportedAreaKm2.toFixed(6)}`,
    `- Tile coverage area km2: ${site.tileCoverageAreaKm2.toFixed(6)}`,
    `- BBox W,S,E,N: ${fmt(site.bbox.west)}, ${fmt(site.bbox.south)}, ${fmt(site.bbox.east)}, ${fmt(site.bbox.north)}`,
    `- Notes: ${site.notes}`,
    `- Sources: ${site.sources.length ? site.sources.join(", ") : "user-supplied location only in this pass"}`,
    "",
    ...site.tileRanges.map((r) => r.pathRange),
    "",
  ]),
  "## Tile Math Source",
  "",
  sources.tileMath,
  "",
].join("\n");

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "location-mapbox-tiles.json"), JSON.stringify({ generatedAt, sources, sites: report }, null, 2));
await writeFile(path.join(outDir, "location-mapbox-tiles.csv"), csv);
await writeFile(path.join(outDir, "location-mapbox-tiles.md"), md);

console.log(`Wrote ${report.length} sites`);
console.log(path.join(outDir, "location-mapbox-tiles.json"));
console.log(path.join(outDir, "location-mapbox-tiles.csv"));
console.log(path.join(outDir, "location-mapbox-tiles.md"));
