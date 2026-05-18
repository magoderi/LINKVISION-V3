/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point {
  id: string;
  lat: number;
  lng: number;
  elevation: number;
  antennaHeight: number;
  label?: string;
  viewshedPolygon?: [number, number][];
}

export type ObstacleType = 'building' | 'tree' | 'other';

export interface Obstacle {
  id: string;
  lat: number;
  lng: number;
  elevation: number;
  height: number;
  type: ObstacleType;
  label: string;
}

export interface TerrainPoint {
  distance: number;
  elevation: number;
  lat: number;
  lng: number;
  rayHeight?: number;
  curvatureCorrection?: number;
  obstacleHeight?: number;
  obstacleType?: ObstacleType;
}

export interface LOSResult {
  hasLOS: boolean;
  obstructionPoint?: TerrainPoint;
  profile: TerrainPoint[];
  distance: number;
  isObstructed?: boolean;
}

export interface ViewshedPoint {
  lat: number;
  lng: number;
  visible: boolean;
  elevation: number;
}
