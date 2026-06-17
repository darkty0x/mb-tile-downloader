const VISUALS = {
  esri: {
    icon: "layers",
    shell: "border-[#b7d6ff] bg-[#eaf3ff] text-[#0969da]",
    badge: "bg-[#0969da] text-white",
  },
  satellite: {
    icon: "satellite",
    shell: "border-[#a5ddff] bg-[#e7f7ff] text-[#0077b6]",
    badge: "bg-[#0077b6] text-white",
  },
  dem: {
    icon: "terrain",
    shell: "border-[#b4e5cb] bg-[#ebfbf2] text-[#087b45]",
    badge: "bg-[#087b45] text-white",
  },
  vector: {
    icon: "vector",
    shell: "border-[#c3c7ff] bg-[#f0f1ff] text-[#4d54d8]",
    badge: "bg-[#4d54d8] text-white",
  },
  raster: {
    icon: "raster",
    shell: "border-[#ffd0df] bg-[#fff0f5] text-[#c0185d]",
    badge: "bg-[#c0185d] text-white",
  },
  rasterarray: {
    icon: "array",
    shell: "border-[#f7d89c] bg-[#fff7e8] text-[#a56000]",
    badge: "bg-[#a56000] text-white",
  },
  style: {
    icon: "style",
    shell: "border-[#d8c2ff] bg-[#f6efff] text-[#6842bd]",
    badge: "bg-[#6842bd] text-white",
  },
  default: {
    icon: "config",
    shell: "border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] text-[var(--ptg-primary)]",
    badge: "bg-[var(--ptg-primary)] text-white",
  },
};

export function configPresetVisual(template = {}) {
  const id = String(template.id || "").toLowerCase();
  const provider = String(template.provider || "").toLowerCase();
  const layer = String(template.layer || "").toLowerCase();
  const format = String(template.format || "").toLowerCase();
  if (provider === "esri") return VISUALS.esri;
  if (id.includes("satellite") || layer.includes("satellite")) return VISUALS.satellite;
  if (layer === "dem" || format.includes("pngraw")) return VISUALS.dem;
  if (layer.includes("rasterarray") || format === "mrt") return VISUALS.rasterarray;
  if (layer.includes("style")) return VISUALS.style;
  if (layer.includes("raster") || ["jpg", "jpg90", "png"].includes(format)) return VISUALS.raster;
  if (layer.includes("vector") || ["pbf", "mvt"].includes(format)) return VISUALS.vector;
  return VISUALS.default;
}
