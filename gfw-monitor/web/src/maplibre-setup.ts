// MapLibre v6 computes its worker URL at runtime, which breaks under Vite's dependency
// pre-bundling. Let Vite bundle the worker itself and hand MapLibre the resulting URL.
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
