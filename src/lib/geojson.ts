import type { FeatureCollection, Geometry, Position } from 'geojson'
import type { GeoJSONSummary } from '../types'

export class GeoJSONValidationError extends Error {}

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
])

/**
 * テキストを GeoJSON としてパースし、FeatureCollection に正規化する。
 * Feature / Geometry 単体の場合も FeatureCollection に包んで返す。
 */
export function parseGeoJSON(text: string): FeatureCollection {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new GeoJSONValidationError('JSON として読み込めませんでした')
  }

  if (typeof json !== 'object' || json === null || !('type' in json)) {
    throw new GeoJSONValidationError('"type" プロパティがありません')
  }

  const obj = json as { type: string }
  if (obj.type === 'FeatureCollection') {
    const fc = json as FeatureCollection
    if (!Array.isArray(fc.features)) {
      throw new GeoJSONValidationError('"features" が配列ではありません')
    }
    return fc
  }
  if (obj.type === 'Feature') {
    return { type: 'FeatureCollection', features: [json as FeatureCollection['features'][number]] }
  }
  if (GEOMETRY_TYPES.has(obj.type)) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: json as Geometry, properties: {} }],
    }
  }
  throw new GeoJSONValidationError(`未対応の type です: ${obj.type}`)
}

export function summarize(fc: FeatureCollection): GeoJSONSummary {
  const geometryTypes: Record<string, number> = {}
  const keys = new Set<string>()
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]

  const extend = ([lng, lat]: Position) => {
    if (lng < bbox[0]) bbox[0] = lng
    if (lat < bbox[1]) bbox[1] = lat
    if (lng > bbox[2]) bbox[2] = lng
    if (lat > bbox[3]) bbox[3] = lat
  }

  const walk = (g: Geometry | null) => {
    if (!g) return
    switch (g.type) {
      case 'Point':
        extend(g.coordinates)
        break
      case 'MultiPoint':
      case 'LineString':
        g.coordinates.forEach(extend)
        break
      case 'MultiLineString':
      case 'Polygon':
        g.coordinates.forEach((ring) => ring.forEach(extend))
        break
      case 'MultiPolygon':
        g.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(extend)))
        break
      case 'GeometryCollection':
        g.geometries.forEach(walk)
        break
    }
  }

  for (const f of fc.features) {
    const type = f.geometry?.type ?? 'null'
    geometryTypes[type] = (geometryTypes[type] ?? 0) + 1
    if (f.properties) Object.keys(f.properties).forEach((k) => keys.add(k))
    walk(f.geometry)
  }

  return {
    featureCount: fc.features.length,
    geometryTypes,
    bbox: Number.isFinite(bbox[0]) ? bbox : null,
    propertyKeys: [...keys].sort(),
  }
}

/** ファイル名から MVT のレイヤー名として使える文字列を作る */
export function toLayerName(fileName: string): string {
  const base = fileName.replace(/\.(geo)?json$/i, '')
  const sanitized = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'layer'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
