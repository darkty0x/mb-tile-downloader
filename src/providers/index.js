import { createEsriProvider } from "./esri.js";
import { createMapboxProvider } from "./mapbox.js";

export function createProvider(config) {
  if (config.provider === "mapbox") return createMapboxProvider(config);
  if (config.provider === "esri") return createEsriProvider(config);
  throw new Error(`Unsupported provider: ${config.provider}`);
}
