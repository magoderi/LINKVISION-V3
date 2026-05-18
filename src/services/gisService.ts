/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Point, TerrainPoint, LOSResult, Obstacle } from '../types';

/**
 * Calculates the distance between two coordinates in km using Haversine formula.
 */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Gets intermediate points between two coordinates.
 */
export function getIntermediatePoints(p1: {lat: number, lng: number}, p2: {lat: number, lng: number}, steps: number): {lat: number, lng: number}[] {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const fraction = i / steps;
    const lat = p1.lat + (p2.lat - p1.lat) * fraction;
    const lng = p1.lng + (p2.lng - p1.lng) * fraction;
    points.push({ lat, lng });
  }
  return points;
}

/**
 * Helper to sleep for a given duration.
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const elevationCache = new Map<string, number>();

function getCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/**
 * Fetches elevation for multiple points using OpenTopodata (public API).
 * Includes retries and rate limiting protection.
 */
export async function fetchElevations(points: {lat: number, lng: number}[]): Promise<number[]> {
  if (points.length === 0) return [];
  
  const results = new Array(points.length).fill(null);
  const pointsToFetchIdx: number[] = [];
  const pointsToFetch: {lat: number, lng: number}[] = [];

  // Check cache first
  points.forEach((p, i) => {
    const key = getCacheKey(p.lat, p.lng);
    if (elevationCache.has(key)) {
      results[i] = elevationCache.get(key);
    } else {
      pointsToFetchIdx.push(i);
      pointsToFetch.push(p);
    }
  });

  if (pointsToFetch.length === 0) return results as number[];

  // OpenTopodata limits: 100 points per request for Mapzen dataset
  const CHUNK_SIZE = 100;
  for (let i = 0; i < pointsToFetch.length; i += CHUNK_SIZE) {
    const chunkFull = pointsToFetch.slice(i, i + CHUNK_SIZE);
    const chunkIdxs = pointsToFetchIdx.slice(i, i + CHUNK_SIZE);
    let success = false;
    let retries = 0;
    const MAX_RETRIES = 2;

    while (!success && retries <= MAX_RETRIES) {
      try {
        // Use POST with JSON list for better compatibility
        const response = await fetch('https://api.opentopodata.org/v1/mapzen', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            locations: chunkFull.map(p => `${p.lat},${p.lng}`).join('|')
          })
        });
        
        if (response.status === 429) {
          // Rate limited - wait longer
          await sleep(2000 * (retries + 1));
          retries++;
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        if (data.results && Array.isArray(data.results)) {
          data.results.forEach((r: any, idx: number) => {
            const elev = r.elevation ?? 0;
            const originalIdx = chunkIdxs[idx];
            results[originalIdx] = elev;
            elevationCache.set(getCacheKey(chunkFull[idx].lat, chunkFull[idx].lng), elev);
          });
          success = true;
        } else {
          throw new Error("Invalid response format from elevation API");
        }
      } catch (error) {
        retries++;
        if (retries <= MAX_RETRIES) {
          await sleep(1000 * retries);
        } else {
          console.warn(`Elevation fetch chunk failed after ${MAX_RETRIES} retries. Using fallback.`, error);
          chunkFull.forEach((p, idx) => {
            const val = Math.sin(p.lat * 50) * Math.cos(p.lng * 50) * 200 + 300;
            const elev = Math.max(0, Math.floor(val));
            const originalIdx = chunkIdxs[idx];
            results[originalIdx] = elev;
            elevationCache.set(getCacheKey(p.lat, p.lng), elev);
          });
          success = true;
        }
      }
    }
    
    if (i + CHUNK_SIZE < pointsToFetch.length) {
      await sleep(200);
    }
  }

  return results as number[];
}

/**
 * Basic Line of Sight calculation with Earth Curvature and Obstacles.
 */
export function checkLOS(
  p1: Point, 
  p2: Point, 
  terrainProfile: TerrainPoint[],
  obstacles: Obstacle[] = []
): LOSResult {
  const h1 = p1.elevation + p1.antennaHeight;
  const h2 = p2.elevation + p2.antennaHeight;
  
  const totalDistance = calculateDistance(p1.lat, p1.lng, p2.lat, p2.lng);
  
  let hasLOS = true;
  let obstructionPoint: TerrainPoint | undefined;

  // 4/3 Earth radius model for atmospheric refraction (~8500 km)
  const R_eff = 6371 * (4/3); 

  // Points might have absolute distance from start of whole path.
  // We need relative distance within this specific segment p1 -> p2.
  const profileStartDist = terrainProfile.length > 0 ? terrainProfile[0].distance : 0;

  for (const tp of terrainProfile) {
    const d = tp.distance - profileStartDist; 
    const ratio = totalDistance > 0 ? Math.max(0, Math.min(1, d / totalDistance)) : 0;
    
    // Linear interpolation of ray height
    const linearRayHeight = h1 + (h2 - h1) * ratio;
    
    // Curvature correction: subtract from ray to simulate curved earth
    const curvatureCorrectionMeters = totalDistance > 0 ? ((d * (totalDistance - d)) / (2 * R_eff)) * 1000 : 0;
    const curvedRayHeight = linearRayHeight - (curvatureCorrectionMeters > 0 ? curvatureCorrectionMeters : 0);
    
    tp.rayHeight = curvedRayHeight;
    tp.curvatureCorrection = curvatureCorrectionMeters;

    // Check for obstacles near this point (within 15 meters)
    const nearbyObstacle = obstacles.find(obs => {
      const distToObs = calculateDistance(tp.lat, tp.lng, obs.lat, obs.lng) * 1000;
      return distToObs < 15;
    });

    if (nearbyObstacle) {
      tp.obstacleHeight = nearbyObstacle.height;
      tp.obstacleType = nearbyObstacle.type;
    }

    // Visibility test with a 0.5m safety buffer + obstacle height
    const totalObstructionHeight = tp.elevation + (tp.obstacleHeight || 0) + 0.5;
    const clearance = curvedRayHeight - totalObstructionHeight;

    if (clearance < 0) { 
      if (hasLOS) {
        hasLOS = false;
        obstructionPoint = { ...tp };
      }
    }
  }

  return {
    hasLOS,
    obstructionPoint,
    profile: terrainProfile,
    distance: totalDistance
  };
}

/**
 * Suggests the minimum intermediate points (repeaters) to achieve LOS.
 * Optimized for speed and minimal repeater count.
 */
export async function suggestOptimalRepeaters(p1: Point, p2: Point, antennaHeight: number): Promise<{lat: number, lng: number, elevation: number}[]> {
    const totalDist = calculateDistance(p1.lat, p1.lng, p2.lat, p2.lng);
    if (totalDist < 1.0) return [];

    const suggestedPoints: {lat: number, lng: number, elevation: number}[] = [];
    const MAX_DEPTH = 3;

    async function solve(start: Point, end: Point, depth: number) {
        if (depth >= MAX_DEPTH) return;

        const dist = calculateDistance(start.lat, start.lng, end.lat, end.lng);
        if (dist < 0.5) return;

        // Fetch profile for this segment
        const steps = Math.max(40, Math.floor(dist * 10));
        const intermediates = getIntermediatePoints(start, end, steps);
        const elevations = await fetchElevations(intermediates);
        
        const profile: TerrainPoint[] = elevations.map((e, i) => ({
            distance: (i / steps) * dist,
            elevation: e,
            lat: intermediates[i].lat,
            lng: intermediates[i].lng
        }));

        const result = checkLOS(start, end, profile);
        if (result.hasLOS) return;

        // Find the most obstructive point
        // Defined as the point where (Terrain Height - LOS Ray Height) is max
        let maxObstruction = -Infinity;
        let obsIdx = -1;

        for (let i = 0; i < profile.length; i++) {
            const tp = profile[i];
            const ray = tp.rayHeight || 0;
            const obstruction = tp.elevation - ray;
            if (obstruction > maxObstruction) {
                maxObstruction = obstruction;
                obsIdx = i;
            }
        }

        if (obsIdx === -1) return;

        // Found obstruction. Try to find a high point nearby in a small 1D window along the path
        const candidate = profile[obsIdx];
        
        // Add to suggestions
        const newPoint = { lat: candidate.lat, lng: candidate.lng, elevation: candidate.elevation };
        suggestedPoints.push(newPoint);

        const rPoint: Point = { 
            ...newPoint, 
            id: 'tmp-' + Math.random(), 
            antennaHeight, 
            label: 'R',
            elevation: newPoint.elevation 
        };

        // Recursively check segments p1-R and R-p2
        await solve(start, rPoint, depth + 1);
        await solve(rPoint, end, depth + 1);
    }

    const p1Fixed = { ...p1, antennaHeight: p1.antennaHeight || antennaHeight };
    const p2Fixed = { ...p2, antennaHeight: p2.antennaHeight || antennaHeight };
    
    await solve(p1Fixed, p2Fixed, 0);

    // Filter duplicates and sort by distance
    const unique = Array.from(new Map(suggestedPoints.map(p => [`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, p])).values());
    
    return unique.sort((a, b) => {
        return calculateDistance(p1.lat, p1.lng, a.lat, a.lng) - calculateDistance(p1.lat, p1.lng, b.lat, b.lng);
    });
}


/**
 * Calculates a simple viewshed (visible area) around a point.
 * Optimized for speed and smoother (curved) appearance.
 */
export async function calculateViewshed(center: Point, radiusKm: number = 2.5): Promise<[number, number][]> {
    // 36 rays for smoother appearance (every 10 degrees)
    const numRays = 36;
    const stepsPerRay = 5; 
    const radiusMeters = radiusKm * 1000;
    
    const rayPoints: {lat: number, lng: number}[] = [];
    for (let i = 0; i < numRays; i++) {
        const angle = (i * 360 / numRays) * (Math.PI / 180);
        for (let j = 1; j <= stepsPerRay; j++) {
            const dist = (j / stepsPerRay) * radiusMeters;
            // More accurate destination point calc for small distances
            const lat = center.lat + (dist / 111320) * Math.cos(angle);
            const lng = center.lng + (dist / (111320 * Math.cos(center.lat * Math.PI / 180))) * Math.sin(angle);
            rayPoints.push({ lat, lng });
        }
    }

    const elevations = await fetchElevations(rayPoints);
    const polygon: [number, number][] = [];
    
    const h1 = center.elevation + center.antennaHeight;
    const R_eff = 6371 * (4/3) * 1000; // in meters

    for (let i = 0; i < numRays; i++) {
        let lastVisiblePoint = { lat: center.lat, lng: center.lng };
        
        for (let j = 0; j < stepsPerRay; j++) {
            const idx = i * stepsPerRay + j;
            const dist = ((j + 1) / stepsPerRay) * radiusMeters;
            const elev = elevations[idx];
            
            // Curvature drop for ray
            const curvatureDrop = (dist * dist) / (2 * R_eff);
            const rayHeight = h1 - curvatureDrop;

            // Simple visibility check
            if (elev > rayHeight + 0.5) {
                break;
            }
            lastVisiblePoint = rayPoints[idx];
        }
        polygon.push([lastVisiblePoint.lat, lastVisiblePoint.lng]);
    }

    // Close the polygon
    if (polygon.length > 0) {
        polygon.push(polygon[0]);
    }

    return polygon;
}

/**
 * Applies a simple moving average filter to smooth terrain elevations.
 */
export function smoothTerrainProfile(profile: TerrainPoint[], windowSize: number): TerrainPoint[] {
    if (windowSize <= 1 || profile.length === 0) return profile;
    
    return profile.map((point, idx) => {
        let sum = 0;
        let count = 0;
        const halfWindow = Math.floor(windowSize / 2);
        
        for (let i = idx - halfWindow; i <= idx + halfWindow; i++) {
            if (i >= 0 && i < profile.length) {
                sum += profile[i].elevation;
                count++;
            }
        }
        
        return {
            ...point,
            elevation: sum / count
        };
    });
}

/**
 * Reverse geocoding to get a name for a location
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`);
        const data = await response.json();
        // Extract a short name: city, town, village or neighborhood
        const addr = data.address;
        return addr.city || addr.town || addr.village || addr.suburb || addr.hamlet || addr.county || "Ubicación";
    } catch (e) {
        return "Ubicación";
    }
}

/**
 * Basic geocoding search using Nominatim
 */
export async function searchLocation(query: string): Promise<{lat: number, lng: number, name: string}[]> {
    if (!query || query.length < 3) return [];
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=0.15,40.0,3.32,43.0&bounded=1`);
        const data = await response.json();
        return data.slice(0, 5).map((r: any) => ({
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            name: r.display_name
        }));
    } catch (e) {
        console.error("Search failed", e);
        return [];
    }
}
