
import { createFireWeather } from '/workspace/spoint/src/behaviours/fireWeather.js';
const config = { rainPerIntensity: 255, snowRainFraction: 0.5, maxMoisture: 255, wetPerStep: 10, dryPerStep: 1, hysteresis: 8 };
const cases = { absent: null, unknownType: { type: 'fog', intensity: 0.5 }, badIntensity: { type: 'rain', intensity: NaN }, rain: { type: 'rain', intensity: 0.5 } };
const out = {};
for (const [name, w] of Object.entries(cases)) {
  const fw = createFireWeather({ config, readWeather: () => w, stepTicks: 1 });
  fw.step(0, {});
  out[name] = { kind: fw.reading.kind, rain: fw.rain };
}
console.log(JSON.stringify(out));