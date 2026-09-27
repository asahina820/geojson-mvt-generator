import { useEffect, useRef } from 'react'
import {
  Map as MaplibreMap,
  NavigationControl,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection } from 'geojson'

interface Props {
  geojson: FeatureCollection | null
  bbox: [number, number, number, number] | null
  /** 変換後タイルの URL テンプレート。指定時は MVT を表示する */
  tileUrl?: string
  layerName: string
  minZoom: number
  maxZoom: number
}

// maplibre-gl v6 は自身の import.meta.url からワーカーを探すため、Vite でバンドルすると見つからない。
// Vite にワーカーをバンドルさせ、その URL を明示的に渡す
setWorkerUrl(workerUrl)

const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.8 } }],
}

const COLOR = '#2563eb'

function addStyledLayers(
  map: MaplibreMap,
  prefix: string,
  source: string,
  color: string,
  sourceLayer?: string,
) {
  const common = sourceLayer ? { source, 'source-layer': sourceLayer } : { source }
  map.addLayer({
    id: `${prefix}-fill`,
    type: 'fill',
    ...common,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': color, 'fill-opacity': 0.25 },
  })
  map.addLayer({
    id: `${prefix}-line`,
    type: 'line',
    ...common,
    filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
    paint: { 'line-color': color, 'line-width': 1.5 },
  })
  map.addLayer({
    id: `${prefix}-circle`,
    type: 'circle',
    ...common,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': color,
      'circle-radius': 4,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1,
    },
  })
}

function removeLayers(map: MaplibreMap, prefix: string, source: string) {
  for (const suffix of ['fill', 'line', 'circle']) {
    const id = `${prefix}-${suffix}`
    if (map.getLayer(id)) map.removeLayer(id)
  }
  if (map.getSource(source)) map.removeSource(source)
}

export function MapPreview({ geojson, bbox, tileUrl, layerName, minZoom, maxZoom }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MaplibreMap | null>(null)
  const loadedRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    const map = new MaplibreMap({
      container: containerRef.current!,
      style: BASE_STYLE,
      center: [139.767, 35.681],
      zoom: 4,
    })
    map.addControl(new NavigationControl(), 'top-right')
    mapRef.current = map
    loadedRef.current = new Promise((resolve) => map.once('load', () => resolve()))
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // bbox が分かれば全体が見えるようにズーム
  useEffect(() => {
    if (!bbox) return
    loadedRef.current?.then(() => {
      mapRef.current?.fitBounds(bbox, { padding: 40, maxZoom: 16, duration: 0 })
    })
  }, [bbox])

  // 変換後の MVT。タイル URL がない場合（モックなど）は元の GeoJSON で代用する
  useEffect(() => {
    let cancelled = false
    loadedRef.current?.then(() => {
      const map = mapRef.current
      if (cancelled || !map) return
      removeLayers(map, 'preview', 'preview')
      if (tileUrl) {
        map.addSource('preview', { type: 'vector', tiles: [tileUrl], minzoom: minZoom, maxzoom: maxZoom })
        addStyledLayers(map, 'preview', 'preview', COLOR, layerName)
      } else if (geojson) {
        map.addSource('preview', { type: 'geojson', data: geojson })
        addStyledLayers(map, 'preview', 'preview', COLOR)
      }
    })
    return () => {
      cancelled = true
    }
  }, [geojson, tileUrl, layerName, minZoom, maxZoom])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      {!tileUrl && geojson && (
        <div className="map-note">タイル URL がないため、元の GeoJSON を表示しています</div>
      )}
    </div>
  )
}
