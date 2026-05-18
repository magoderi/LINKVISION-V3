/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents, useMap, Tooltip, Circle, Popup, Polygon } from 'react-leaflet';
import L from 'leaflet';
import { Point, LOSResult, TerrainPoint, Obstacle, ObstacleType } from './types';
import { calculateDistance, fetchElevations, getIntermediatePoints, checkLOS, suggestOptimalRepeaters, searchLocation, reverseGeocode, calculateViewshed, smoothTerrainProfile } from './services/gisService';
import { ProfileChart } from './components/ProfileChart';
import { 
  Settings, 
  Activity, 
  Trash2,
  Plus,
  Zap,
  Target,
  Search,
  ChevronRight,
  MapPin,
  Copy,
  Check,
  Building2,
  Trees,
  Box,
  Layers
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Map Events component to handle clicks
function MapEvents({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Map Controller for auto-zoom and panning
function MapController({ points, activePointId }: { points: Point[], activePointId: string | null }) {
  const map = useMap();

  useEffect(() => {
    if (points.length >= 2) {
      const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [50, 50], animate: true, maxZoom: 15 });
    } else if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13);
    }
  }, [points, map]);

  useEffect(() => {
    if (!activePointId) return;
    const p = points.find(pt => pt.id === activePointId);
    if (p) {
        // Individual point focus: Zoom in more
        map.setView([p.lat, p.lng], 16, { animate: true });
    }
  }, [activePointId, map, points]);

  return null;
}

export default function App() {
  const [points, setPoints] = useState<Point[]>([]);
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  const [activePointId, setActivePointId] = useState<string | null>(null);
  const [activeObstacleId, setActiveObstacleId] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<'points' | 'obstacles'>('points');
  const [losResult, setLosResult] = useState<LOSResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [antennaDefaultHeight, setAntennaDefaultHeight] = useState(30);
  const [terrainSmoothing, setTerrainSmoothing] = useState(0); // 0 = off, values like 3, 5, 7 for window size
  const [mapLayer, setMapLayer] = useState<'topo' | 'osm' | 'satellite'>('topo');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{lat: number, lng: number, name: string}[]>([]);

  // Initial map center: Catalonia
  const initialCenter: [number, number] = [41.6, 1.8];

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length > 2) {
      const results = await searchLocation(query);
      setSearchResults(results);
    } else {
      setSearchResults([]);
    }
  };

  const handleMapClick = async (lat: number, lng: number) => {
    if (interactionMode === 'points') {
      if (points.length >= 10) return; 
      
      setIsLoading(true);
      const [elevation] = await fetchElevations([{ lat, lng }]);
      const siteName = await reverseGeocode(lat, lng);
      
      let label = '';
      if (points.length === 0) label = `Origen: ${siteName}`;
      else label = `Destino: ${siteName}`;

      const viewshedPolygon = await calculateViewshed({
        id: '',
        lat,
        lng,
        elevation,
        antennaHeight: antennaDefaultHeight
      });

      const newPoint: Point = {
        id: Math.random().toString(36).substr(2, 9),
        lat,
        lng,
        elevation,
        antennaHeight: antennaDefaultHeight,
        label: label,
        viewshedPolygon
      };
      
      setPoints(prev => {
          const next = [...prev, newPoint];
          if (next.length > 2) {
              return next.map((p, i) => {
                  if (i === 0) return p;
                  if (i === next.length - 1) return { ...p, label: `Destino: ${siteName}` };
                  return { ...p, label: p.label.includes('Repetidor') ? p.label : `Repetidor ${i}: ${siteName}` };
              });
          }
          return next;
      });
      setActivePointId(newPoint.id);
      setIsLoading(false);
    } else {
      // Add obstacle
      setIsLoading(true);
      const [elevation] = await fetchElevations([{ lat, lng }]);
      const siteName = await reverseGeocode(lat, lng);

      const newObstacle: Obstacle = {
        id: Math.random().toString(36).substr(2, 9),
        lat,
        lng,
        elevation,
        height: 10,
        type: 'building',
        label: `Obstrucción: ${siteName}`
      };

      setObstacles(prev => [...prev, newObstacle]);
      setActiveObstacleId(newObstacle.id);
      setIsLoading(false);
    }
  };

  const removeObstacle = (id: string) => {
    setObstacles(prev => prev.filter(o => o.id !== id));
    if (activeObstacleId === id) setActiveObstacleId(null);
  };

  const updateObstacle = (id: string, updates: Partial<Obstacle>) => {
    setObstacles(prev => prev.map(o => o.id === id ? { ...o, ...updates } : o));
  };

  const removePoint = (id: string) => {
    setPoints(prev => prev.filter(p => p.id !== id));
    if (activePointId === id) setActivePointId(null);
  };

  const updateAntennaHeight = async (id: string, height: number) => {
    // Optimistic update of antenna height
    setPoints(prev => prev.map(p => p.id === id ? { ...p, antennaHeight: height } : p));
    
    // Async update of viewshed
    setIsLoading(true);
    try {
        setPoints(prev => {
            const p = prev.find(pt => pt.id === id);
            if (!p) return prev;
            
            // We need to return a function that calls calculateViewshed but setPoints expects a new array
            // So we'll trigger it outside or use a more complex state management.
            return prev;
        });

        const currentPoint = points.find(pt => pt.id === id);
        if (currentPoint) {
            const viewshedPolygon = await calculateViewshed({ ...currentPoint, antennaHeight: height });
            setPoints(prev => prev.map(pt => pt.id === id ? { ...pt, antennaHeight: height, viewshedPolygon } : pt));
        }
    } finally {
        setIsLoading(false);
    }
  };

  const runAnalysis = useCallback(async () => {
    if (points.length < 2) {
      setLosResult(null);
      return;
    }

    setIsLoading(true);
    let totalDistance = 0;
    let overallLOS = true;
    let worstObstruction: TerrainPoint | undefined;
    let allProfilePoints: TerrainPoint[] = [];

    // Analyze each segment: P0-P1, P1-P2, ...
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i+1];
        const segmentDist = calculateDistance(p1.lat, p1.lng, p2.lat, p2.lng);
        
        const steps = Math.max(60, Math.floor(segmentDist * 20));
        const intermediates = getIntermediatePoints(p1, p2, steps);
        const elevations = await fetchElevations(intermediates);
        
        const segmentProfile: TerrainPoint[] = intermediates.map((inter, j) => ({
            ...inter,
            elevation: elevations[j],
            distance: totalDistance + (j / steps) * segmentDist
        }));

        // Apply smoothing if enabled
        const analyzedProfile = terrainSmoothing > 0 
            ? smoothTerrainProfile(segmentProfile, terrainSmoothing)
            : segmentProfile;

        const result = checkLOS(p1, p2, analyzedProfile, obstacles);
        if (!result.hasLOS) {
            overallLOS = false;
            // Use the elevations from analyzedProfile (which might be smoothed)
            if (result.obstructionPoint && (!worstObstruction || result.obstructionPoint.elevation > worstObstruction.elevation)) {
                worstObstruction = result.obstructionPoint;
            }
        }
        
        allProfilePoints.push(...analyzedProfile);
        totalDistance += segmentDist;
    }

    setLosResult({
        hasLOS: overallLOS,
        obstructionPoint: worstObstruction,
        profile: allProfilePoints,
        distance: totalDistance
    });
    setIsLoading(false);
  }, [points, obstacles, terrainSmoothing]);

  useEffect(() => {
    runAnalysis();
  }, [points, obstacles, runAnalysis, terrainSmoothing]);

  const suggestIntermediates = async () => {
      if (points.length < 2) return;
      const pA = points[0];
      const pB = points[points.length - 1];
      
      setIsLoading(true);
      const suggestions = await suggestOptimalRepeaters(pA, pB, antennaDefaultHeight);
      
      if (suggestions.length === 0) {
        setIsLoading(false);
        return;
      }

      const newPoints: Point[] = [pA];
      
      // Parallelize reverse geocoding and viewshed for speed
      const siteNames = await Promise.all(
          suggestions.map(s => reverseGeocode(s.lat, s.lng))
      );
      
      const viewsheds = await Promise.all(
          suggestions.map(s => calculateViewshed({
              id: '',
              lat: s.lat,
              lng: s.lng,
              elevation: s.elevation,
              antennaHeight: antennaDefaultHeight
          }))
      );

      for (let i = 0; i < suggestions.length; i++) {
          const s = suggestions[i];
          const siteName = siteNames[i];
          const viewshedPolygon = viewsheds[i];
          newPoints.push({
              id: Math.random().toString(36).substr(2, 9),
              lat: s.lat,
              lng: s.lng,
              elevation: s.elevation,
              antennaHeight: antennaDefaultHeight,
              label: `Repetidor ${i + 1}: ${siteName}`,
              viewshedPolygon
          });
      }
      newPoints.push(pB);
      
      setPoints(newPoints);
      setIsLoading(false);
  };

  return (
    <div className="flex h-screen w-screen font-sans bg-[#050505] overflow-hidden text-white">
      {/* Sidebar - LEFT */}
      <div className="w-80 h-full border-r border-[#1a1a1a] flex flex-col z-20 bg-[#050505]/95 backdrop-blur-xl">
        <div className="p-4 border-b border-[#111] bg-black/40">
          <h1 className="text-lg font-display font-black tracking-tighter leading-none mb-1 text-white">LINKVISION</h1>
          <p className="text-[7px] font-black tracking-[0.3em] text-[#ff6b00] animate-pulse">V2.5 · SYSTEM UNPLUGGED</p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-5 custom-scrollbar mt-2">
          {/* Interaction Mode Toggle */}
          <div className="grid grid-cols-2 border border-[#222]">
            <button 
              onClick={() => setInteractionMode('points')}
              className={cn(
                "py-2.5 text-[9px] font-black uppercase transition-all tracking-widest flex items-center justify-center gap-2",
                interactionMode === 'points' ? "bg-white text-black" : "text-gray-500 hover:text-white border-r border-[#222]"
              )}
            >
              <Target className={cn("w-3.5 h-3.5", interactionMode === 'points' ? "text-[#ff6b00]" : "text-gray-500")} />
              ESTACIONES
            </button>
            <button 
              onClick={() => setInteractionMode('obstacles')}
              className={cn(
                "py-2.5 text-[9px] font-black uppercase transition-all tracking-widest flex items-center justify-center gap-2",
                interactionMode === 'obstacles' ? "bg-white text-black" : "text-gray-500 hover:text-white"
              )}
            >
              <Layers className={cn("w-3.5 h-3.5", interactionMode === 'obstacles' ? "text-[#ff6b00]" : "text-gray-500")} />
              OBSTÁCULOS
            </button>
          </div>

          {/* Search Area */}
          <div className="relative group">
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                <Search className="w-3.5 h-3.5 text-gray-500 group-focus-within:text-white transition-colors" />
            </div>
            <input 
                type="text" 
                placeholder="Buscar ubicación..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                className="w-full bg-[#111] border border-[#222] rounded-none py-3 pl-10 pr-4 text-xs font-medium focus:ring-0 focus:border-white outline-none transition-all placeholder:text-gray-600"
            />
            <AnimatePresence>
                {searchResults.length > 0 && (
                    <motion.div 
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full left-0 w-full bg-[#111] border-x border-b border-[#222] z-50 shadow-2xl"
                    >
                        {searchResults.map((res, i) => (
                            <button 
                                key={i}
                                onClick={() => {
                                    handleMapClick(res.lat, res.lng);
                                    setSearchResults([]);
                                    setSearchQuery('');
                                }}
                                className="w-full text-left px-4 py-3 hover:bg-white hover:text-black transition-colors border-t border-[#222] first:border-0 group flex items-start gap-3"
                            >
                                <MapPin className="w-3 h-3 mt-0.5 text-gray-500 group-hover:text-black shrink-0" />
                                <span className="text-[10px] font-bold uppercase leading-tight line-clamp-2">{res.name}</span>
                            </button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
          </div>

          {/* Controls */}
          <section>
            <h2 className="text-[9px] font-black uppercase tracking-[0.2em] mb-6 text-gray-300 flex items-center gap-2">
                <Settings className="w-3 h-3" /> CONFIGURACIÓN
            </h2>
            <div className="space-y-6">
              {interactionMode === 'points' ? (
                activePointId ? (
                  <div>
                    <label className="block text-[8px] font-bold text-[#ff6b00] uppercase mb-4 tracking-widest">
                      Altura Mastil (Sobre el Suelo AGL)
                    </label>
                    <div className="flex items-center gap-4">
                      <input 
                        type="range" min="1" max="250" 
                        value={points.find(p => p.id === activePointId)?.antennaHeight || antennaDefaultHeight} 
                        onChange={(e) => {
                            const val = parseInt(e.target.value);
                            updateAntennaHeight(activePointId!, val);
                        }}
                        className="flex-1 h-0.5 bg-[#333] appearance-none cursor-pointer accent-[#ff6b00]"
                      />
                      <span className="text-xs font-mono font-bold w-12 text-right text-white">
                        {points.find(p => p.id === activePointId)?.antennaHeight}m
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 border border-[#222] bg-[#111]/50">
                    <p className="text-[9px] text-gray-400 font-bold uppercase tracking-tight">Selecciona un punto para ajustar su altura.</p>
                  </div>
                )
              ) : (
                activeObstacleId ? (
                  <div className="space-y-6">
                    <div>
                      <label className="block text-[8px] font-bold text-[#ff6b00] uppercase mb-4 tracking-widest">
                        Altura del Obstáculo
                      </label>
                      <div className="flex items-center gap-4">
                        <input 
                          type="range" min="1" max="100" 
                          value={obstacles.find(o => o.id === activeObstacleId)?.height || 10} 
                          onChange={(e) => updateObstacle(activeObstacleId!, { height: parseInt(e.target.value) })}
                          className="flex-1 h-0.5 bg-[#333] appearance-none cursor-pointer accent-[#ff6b00]"
                        />
                        <span className="text-xs font-mono font-bold w-12 text-right text-white">
                          {obstacles.find(o => o.id === activeObstacleId)?.height}m
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[8px] font-bold text-gray-500 uppercase mb-4 tracking-widest">
                        Tipo de Obstáculo
                      </label>
                      <div className="grid grid-cols-3 border border-[#222]">
                        {(['building', 'tree', 'other'] as const).map(type => (
                          <button 
                            key={type}
                            onClick={() => updateObstacle(activeObstacleId!, { type })}
                            className={cn(
                              "py-2 text-[8px] font-black uppercase transition-all tracking-tighter flex flex-col items-center gap-1",
                              obstacles.find(o => o.id === activeObstacleId)?.type === type ? "bg-white text-black" : "text-gray-500 hover:text-white border-r border-[#222] last:border-r-0"
                            )}
                          >
                            {type === 'building' ? <Building2 className="w-3 h-3" /> : type === 'tree' ? <Trees className="w-3 h-3" /> : <Box className="w-3 h-3" />}
                            {type === 'building' ? 'EDIF' : type === 'tree' ? 'ARBOL' : 'OTRO'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 border border-[#222] bg-[#111]/50">
                    <p className="text-[9px] text-gray-400 font-bold uppercase tracking-tight">Selecciona un obstáculo para configurar su altura y tipo.</p>
                  </div>
                )
              )}

              <div className="grid grid-cols-3 border border-[#222]">
                {(['topo', 'osm', 'satellite'] as const).map(layer => (
                  <button 
                    key={layer}
                    onClick={() => setMapLayer(layer)}
                    className={cn(
                      "py-2 text-[8px] font-black uppercase transition-all tracking-tighter",
                      mapLayer === layer ? "bg-[#ff6b00] text-black" : "text-gray-500 hover:text-white border-r border-[#222] last:border-r-0"
                    )}
                  >
                    {layer === 'topo' ? 'TOPO' : layer === 'osm' ? 'PLAN' : 'SAT'}
                  </button>
                ))}
              </div>

              {/* Terrain Smoothing */}
              <div className="pt-2">
                <label className="block text-[8px] font-bold text-gray-500 uppercase mb-3 tracking-widest flex justify-between">
                  Suavizado de Terreno
                  <span className="text-[#ff6b00]">{terrainSmoothing > 0 ? `VENTANA: ${terrainSmoothing}` : 'DESACTIVADO'}</span>
                </label>
                <div className="flex gap-1">
                  {[0, 3, 7, 15, 31].map((val) => (
                    <button
                      key={val}
                      onClick={() => setTerrainSmoothing(val)}
                      className={cn(
                        "flex-1 py-1.5 text-[8px] font-black border transition-all",
                        terrainSmoothing === val 
                          ? "bg-white text-black border-white" 
                          : "bg-transparent text-gray-500 border-[#222] hover:border-gray-500"
                      )}
                    >
                      {val === 0 ? 'OFF' : `${val}x`}
                    </button>
                  ))}
                </div>
                <p className="text-[7px] text-gray-600 font-bold uppercase mt-2 leading-tight">Reduce variaciones menores para captar formas geográficas principales.</p>
              </div>
            </div>
          </section>

          {/* Points/Obstacles List */}
          <section>
            {interactionMode === 'points' ? (
              <>
                <div className="flex justify-between items-end mb-6">
                  <h2 className="text-[9px] font-black uppercase tracking-widest text-gray-300 flex items-center gap-2">
                      <Target className="w-3 h-3 text-[#ff6b00]" /> INFRAESTRUCTURA
                  </h2>
                  {points.length > 0 && (
                      <button 
                        onClick={() => { setPoints([]); setLosResult(null); }}
                        className="text-[9px] font-black uppercase text-gray-400 hover:text-white underline underline-offset-4"
                      >
                          BORRAR TODO
                      </button>
                  )}
                </div>
                
                <div className="space-y-2">
                  {points.length === 0 && (
                      <div className="py-12 border border-dashed border-[#222] flex flex-col items-center justify-center text-center">
                          <Plus className="w-4 h-4 mb-3 text-gray-700" />
                          <p className="text-[8px] font-black uppercase tracking-widest text-gray-500">Haz clic en el mapa</p>
                      </div>
                  )}
                  {points.map((p, idx) => (
                    <motion.div 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      key={p.id}
                      onClick={() => { setActivePointId(p.id); setActiveObstacleId(null); }}
                      className={cn(
                        "p-2 border transition-all cursor-pointer relative group",
                        activePointId === p.id 
                          ? "bg-white text-black border-[#ff6b00]" 
                          : "bg-[#0a0a0a] border-[#1a1a1a] hover:border-gray-500"
                      )}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <p className={cn("text-[10px] font-black uppercase tracking-tight", activePointId === p.id ? "text-black" : "text-[#ff6b00]")}>{p.label}</p>
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              navigator.clipboard.writeText(`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
                            }}
                            className={cn("p-1 transition-colors", activePointId === p.id ? "text-gray-600 hover:text-black" : "text-gray-400 hover:text-white")}
                            title="Copiar Coordenadas"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); removePoint(p.id); }}
                            className={cn("p-1 transition-colors", activePointId === p.id ? "text-gray-400 hover:text-black" : "text-gray-600 hover:text-white")}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-0.5 mb-2">
                        <p className={cn("text-[8px] font-mono font-bold tracking-widest", activePointId === p.id ? "text-black/60" : "text-gray-400")}>{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</p>
                      </div>

                      <div className={cn("flex items-end justify-between border-t pt-2", activePointId === p.id ? "border-black/10" : "border-white/10")}>
                        <div className="space-y-0.5 flex-1">
                           <label className={cn("text-[7px] font-black uppercase block tracking-widest leading-none", activePointId === p.id ? "text-black/40" : "text-gray-500")}>Antena</label>
                           <div className="flex items-center gap-2">
                            <input 
                                type="number" 
                                value={p.antennaHeight}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => updateAntennaHeight(p.id, parseInt(e.target.value) || 0)}
                                className={cn(
                                    "w-10 bg-transparent border-b font-mono text-[11px] font-bold focus:outline-none transition-all",
                                    activePointId === p.id ? "border-black/20" : "border-white/10 focus:border-white"
                                )}
                            />
                            <span className="text-[8px] font-bold opacity-30">m</span>
                           </div>
                        </div>
                        <div className="text-right">
                            <label className={cn("text-[7px] font-black uppercase block tracking-widest leading-none", activePointId === p.id ? "text-black/40" : "text-gray-500")}>Elevación</label>
                            <span className="text-[11px] font-mono font-bold">{p.elevation.toFixed(0)}m</span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between items-end mb-6">
                  <h2 className="text-[9px] font-black uppercase tracking-widest text-gray-300 flex items-center gap-2">
                      <Layers className="w-3 h-3 text-[#ff6b00]" /> OBSTÁCULOS TEMP
                  </h2>
                  {obstacles.length > 0 && (
                      <button 
                        onClick={() => { setObstacles([]); }}
                        className="text-[9px] font-black uppercase text-gray-400 hover:text-white underline underline-offset-4"
                      >
                          BORRAR TODO
                      </button>
                  )}
                </div>
                
                <div className="space-y-2">
                  {obstacles.length === 0 && (
                      <div className="py-12 border border-dashed border-[#222] flex flex-col items-center justify-center text-center">
                          <Building2 className="w-4 h-4 mb-3 text-gray-700" />
                          <p className="text-[8px] font-black uppercase tracking-widest text-gray-500">Haz clic para añadir edificios/árboles</p>
                      </div>
                  )}
                  {obstacles.map((o) => (
                    <motion.div 
                      key={o.id}
                      onClick={() => { setActiveObstacleId(o.id); setActivePointId(null); }}
                      className={cn(
                        "p-2 border transition-all cursor-pointer relative group",
                        activeObstacleId === o.id 
                          ? "bg-white text-black border-[#ff6b00]" 
                          : "bg-[#0a0a0a] border-[#1a1a1a] hover:border-gray-500"
                      )}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <div className="flex items-center gap-2">
                            {o.type === 'building' ? <Building2 className="w-3 h-3" /> : o.type === 'tree' ? <Trees className="w-3 h-3" /> : <Box className="w-3 h-3" />}
                            <p className={cn("text-[10px] font-black uppercase tracking-tight", activeObstacleId === o.id ? "text-black" : "text-white")}>{o.type === 'building' ? 'Edificio' : o.type === 'tree' ? 'Árbol' : 'Objeto'}</p>
                        </div>
                        <button 
                          onClick={(e) => { e.stopPropagation(); removeObstacle(o.id); }}
                          className={cn("p-1 transition-colors", activeObstacleId === o.id ? "text-gray-400 hover:text-black" : "text-gray-600 hover:text-white")}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <p className={cn("text-[8px] font-mono font-bold tracking-widest", activeObstacleId === o.id ? "text-black/60" : "text-gray-400")}>{o.lat.toFixed(5)}, {o.lng.toFixed(5)}</p>
                      
                      <div className={cn("flex items-end justify-between border-t pt-2 mt-2", activeObstacleId === o.id ? "border-black/10" : "border-white/10")}>
                        <div>
                           <label className={cn("text-[7px] font-black uppercase block tracking-widest leading-none", activeObstacleId === o.id ? "text-black/40" : "text-gray-500")}>Altura</label>
                           <span className="text-[11px] font-mono font-bold">{o.height}m</span>
                        </div>
                        <div className="text-right">
                            <label className={cn("text-[7px] font-black uppercase block tracking-widest leading-none", activeObstacleId === o.id ? "text-black/40" : "text-gray-500")}>Base Elev.</label>
                            <span className="text-[11px] font-mono font-bold">{o.elevation.toFixed(0)}m</span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </section>

          {points.length >= 2 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <button 
                onClick={suggestIntermediates}
                className="w-full py-3 bg-[#ff6b00] text-black text-[9px] font-black uppercase tracking-[0.3em] hover:bg-[#ff8c00] transition-all active:scale-[0.98] flex items-center justify-center gap-3 rounded-none border-y-4 border-black/20 relative overflow-hidden group"
              >
                  <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500 skew-x-12" />
                  <Zap className="w-4 h-4 fill-current" /> 
                  <span className="relative z-10">Optimizar Enlace</span>
              </button>
            </motion.div>
          )}

          {/* Results Summary - MINIMIZED */}
          {losResult && (
              <section className="bg-white text-black p-4 space-y-4 border-b-4 border-[#ff6b00]">
                  <div className="flex items-center justify-between">
                      <h4 className="text-[8px] font-black uppercase tracking-widest">ESTADO ENLACE</h4>
                      <div className={cn("w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(0,0,0,0.3)]", losResult.hasLOS ? "bg-[#ff6b00]" : "bg-red-600 animate-pulse")} />
                  </div>
                  <div>
                    <p className={cn("text-2xl font-display font-black leading-none tracking-tighter", !losResult.hasLOS && "text-red-600")}>
                      {losResult.hasLOS ? "LINK OK" : "OBSTRUIDO"}
                    </p>
                  </div>
                  <div className="flex items-end justify-between border-t border-gray-100 pt-3">
                      <div>
                        <p className="text-[7px] font-black text-gray-400 uppercase mb-1 tracking-[0.2em]">Distancia Total</p>
                        <p className="text-lg font-display font-black tracking-tighter text-[#ff6b00]">{losResult.distance.toFixed(1)} <span className="text-[8px] font-bold opacity-30">km</span></p>
                      </div>
                      <div className="text-right">
                        <p className="text-[7px] font-black text-gray-400 uppercase mb-1 tracking-[0.2em]">Saltos</p>
                        <p className="text-lg font-display font-black tracking-tighter">{points.length - 1}</p>
                      </div>
                  </div>
              </section>
          )}
        </div>
      </div>

      {/* Main Content - RIGHT */}
      <div className="flex-1 flex flex-col bg-[#050505] overflow-hidden">
        {/* Map Area */}
        <div className="flex-1 relative p-2 md:p-3">
            <div className="h-full w-full relative overflow-hidden rounded-none border border-[#1a1a1a]">
                <MapContainer 
                    center={initialCenter} 
                    zoom={9} 
                    className={cn("h-full w-full", interactionMode === 'obstacles' ? "cursor-crosshair" : "cursor-default")}
                    zoomControl={true}
                    scrollWheelZoom={false}
                >
                {mapLayer === 'topo' && (
                    <TileLayer
                    attribution='&copy; OpenTopoMap'
                    url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
                    className="grayscale contrast-[1.1] invert-[0.95] opacity-70"
                    />
                )}
                {mapLayer === 'osm' && (
                    <TileLayer
                        attribution='&copy; OpenStreetMap'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        className="grayscale contrast-[1.1] invert-[0.95] opacity-50"
                    />
                )}
                {mapLayer === 'satellite' && (
                    <TileLayer
                        attribution='&copy; Esri'
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        className="grayscale contrast-[1.1] brightness-[0.7]"
                    />
                )}
            
            <MapEvents onMapClick={handleMapClick} />
            <MapController points={points} activePointId={activePointId} />
            
            {/* LOS Zones & Viewsheds */}
            {points.map(p => (
                <React.Fragment key={`v-container-${p.id}`}>
                    <Circle 
                        center={[p.lat, p.lng]}
                        radius={p.antennaHeight * 80}
                        pathOptions={{
                            fillColor: '#000',
                            fillOpacity: activePointId === p.id ? 0.2 : 0.05,
                            weight: 1,
                            color: '#000',
                            dashArray: '4, 4'
                        }}
                    />
                    {p.viewshedPolygon && (
                        <Polygon 
                            positions={p.viewshedPolygon}
                            pathOptions={{
                                fillColor: '#3b82f6',
                                fillOpacity: activePointId === p.id ? 0.35 : 0.15,
                                weight: 0.5,
                                color: '#3b82f6',
                                dashArray: '2, 2'
                            }}
                        />
                    )}
                </React.Fragment>
            ))}

            {/* Link Path */}
            {points.length >= 2 && points.map((p, i) => {
                if (i === points.length - 1) return null;
                const nextP = points[i+1];
                const isHighlighted = activePointId === p.id || activePointId === nextP.id;
                
                return (
                    <React.Fragment key={`seg-${p.id}-${nextP.id}`}>
                        <Polyline 
                            positions={[[p.lat, p.lng], [nextP.lat, nextP.lng]]} 
                            color={isHighlighted ? "#ffffff" : "#ff6b00"} 
                            weight={isHighlighted ? 10 : 8}
                            opacity={1}
                            lineJoin="round"
                            lineCap="round"
                        />
                        <Polyline 
                            positions={[[p.lat, p.lng], [nextP.lat, nextP.lng]]} 
                            color={isHighlighted ? "#ffffff" : "#ff6b00"} 
                            weight={isHighlighted ? 30 : 24}
                            opacity={isHighlighted ? 0.3 : 0.15}
                            lineJoin="round"
                            lineCap="round"
                        />
                    </React.Fragment>
                );
            })}
            
            {points.length >= 2 && (
                <Polyline 
                    positions={[[points[0].lat, points[0].lng], [points[points.length-1].lat, points[points.length-1].lng]]} 
                    color={losResult?.hasLOS ? "#ff6b00" : "#ff0000"} 
                    weight={2}
                    opacity={0.3}
                    dashArray="10, 10"
                />
            )}

            {/* Obstacle Markers */}
            {obstacles.map((obs) => (
                <Marker 
                    key={obs.id} 
                    position={[obs.lat, obs.lng]} 
                    icon={new L.DivIcon({
                        className: 'custom-div-icon',
                        html: `<div style="background-color: ${activeObstacleId === obs.id ? '#64748b' : '#334155'}; border: 2px solid white; width: 12px; height: 12px; border-radius: 2px; box-shadow: ${activeObstacleId === obs.id ? `0 0 10px #64748b` : 'none'}; display: flex; align-items: center; justify-content: center; color: white;">${obs.type === 'tree' ? 'T' : 'B'}</div>`,
                        iconSize: [14, 14],
                        iconAnchor: [7, 7]
                    })}
                    draggable={true}
                    eventHandlers={{
                        drag: (e: any) => {
                            const { lat, lng } = e.target.getLatLng();
                            updateObstacle(obs.id, { lat, lng });
                        },
                        dragend: async (e: any) => {
                            const { lat, lng } = e.target.getLatLng();
                            const [elevation] = await fetchElevations([{ lat, lng }]);
                            updateObstacle(obs.id, { lat, lng, elevation });
                        },
                        click: () => { setActiveObstacleId(obs.id); setActivePointId(null); }
                    }}
                >
                    <Tooltip direction="top">
                        <div className="bg-black text-white p-1 text-[8px] font-mono">
                            {obs.type === 'building' ? 'EDIFICIO' : 'ÁRBOL'} ({obs.height}m)
                        </div>
                    </Tooltip>
                </Marker>
            ))}

            {/* Distance Markers along Line segments */}
            {points.length >= 2 && points.map((p, i) => {
                if (i === points.length - 1) return null;
                const nextP = points[i+1];
                const dist = calculateDistance(p.lat, p.lng, nextP.lat, nextP.lng).toFixed(2);
                const midLat = (p.lat + nextP.lat) / 2;
                const midLng = (p.lng + nextP.lng) / 2;
                
                return (
                    <Marker 
                        key={`dist-${i}`}
                        position={[midLat, midLng]}
                        icon={new L.DivIcon({
                            className: 'custom-div-icon',
                            html: `<div style="background-color: #ff6b00; color: white; padding: 2px 5px; border-radius: 4px; font-size: 8px; font-weight: 900; white-space: nowrap; border: 1px solid black; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transform: translateY(-10px);">${dist} km</div>`,
                            iconSize: [40, 14],
                            iconAnchor: [20, 7]
                        })}
                    />
                );
            })}

            {/* Markers Section */}
            {points.map((p, idx) => {
              const isOrigin = idx === 0;
              const isDest = idx === points.length - 1;
              const isRepeater = !isOrigin && !isDest;
              const isCriticalMarker = isOrigin || isDest;
              const color = isCriticalMarker ? '#ff6b00' : '#22c55e';
              const shadowColor = isCriticalMarker ? 'rgba(255, 107, 0, 0.5)' : 'rgba(34, 197, 94, 0.5)';
              
              return (
                <Marker 
                    key={p.id} 
                    position={[p.lat, p.lng]} 
                    icon={new L.DivIcon({
                        className: 'custom-div-icon',
                        html: `
                            <div style="position: relative; display: flex; flex-direction: column; align-items: center;">
                                <div style="background-color: ${activePointId === p.id ? color : (isCriticalMarker ? 'black' : '#111')}; border: 2.5px solid ${color}; width: ${isCriticalMarker ? '22px' : '16px'}; height: ${isCriticalMarker ? '22px' : '16px'}; border-radius: 50%; box-shadow: ${activePointId === p.id ? `0 0 15px ${shadowColor}` : 'none'}; transition: all 0.3s; display: flex; align-items: center; justify-content: center; transform: translateY(${isRepeater ? '-5px' : '0'});">
                                    <span style="font-size: 8px; font-weight: 900; color: white;">${isRepeater ? `R${idx}` : (isOrigin ? 'A' : 'B')}</span>
                                </div>
                                ${isRepeater ? `<div style="color: #22c55e; font-size: 9px; font-weight: 900; position: absolute; top: -30px; white-space: nowrap; text-shadow: 0 0 2px black; letter-spacing: -0.5px;">REP ${idx}</div>` : ''}
                            </div>
                        `,
                        iconSize: [22, 22],
                        iconAnchor: [11, 11]
                    })}
                    draggable={true}
                    eventHandlers={{
                        drag: (e: any) => {
                            const { lat, lng } = e.target.getLatLng();
                            setPoints(prev => prev.map(pt => pt.id === p.id ? { ...pt, lat, lng } : pt));
                        },
                        dragend: async (e: any) => {
                            const marker = e.target;
                            const { lat, lng } = marker.getLatLng();
                            setIsLoading(true);
                            const [elevation] = await fetchElevations([{ lat, lng }]);
                            const viewshedPolygon = await calculateViewshed({ ...p, lat, lng, elevation });
                            setPoints(prev => prev.map(pt => pt.id === p.id ? { ...pt, lat, lng, elevation, viewshedPolygon } : pt));
                            setIsLoading(false);
                        },
                        click: () => setActivePointId(p.id)
                    }}
                >
                  <Tooltip direction="top" offset={[0, -10]} opacity={1} permanent={isCriticalMarker}>
                    <div className="p-2 bg-[#000] text-white font-mono border-l-2" style={{ borderColor: color }}>
                      <p className="text-[8px] font-black uppercase tracking-widest mb-1" style={{ color: color }}>{isRepeater ? `REP ${idx}` : p.label.split(':')[0]}</p>
                      <p className="text-[9px] font-bold">{p.elevation.toFixed(1)}m + {p.antennaHeight}m</p>
                    </div>
                  </Tooltip>
                  <Popup offset={[0, -5]}>
                    <div className="p-3 bg-[#000] text-white font-mono border-l-4" style={{ borderColor: color }}>
                      <div className="flex justify-between items-center gap-4 mb-2">
                        <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: color }}>{p.label === 'R' || p.label.startsWith('R-') ? 'REPETIDOR' : 'ESTACIÓN'}</p>
                        <span className="text-[8px] font-bold opacity-30 text-white">#{idx+1}</span>
                      </div>
                      <p className="text-sm font-black mb-2 text-white">{p.label}</p>
                      <div className="space-y-1 text-[9.5px] font-bold">
                        <div className="flex justify-between gap-6"><span className="opacity-40">LAT</span> <span className="text-white">{p.lat.toFixed(6)}</span></div>
                        <div className="flex justify-between gap-6"><span className="opacity-40">LNG</span> <span className="text-white">{p.lng.toFixed(6)}</span></div>
                        <div className="flex justify-between gap-6"><span className="opacity-40">ELEVACIÓN</span> <span className="text-white">{p.elevation.toFixed(1)}m</span></div>
                        <div className="flex justify-between gap-6"><span className="opacity-40 text-[#ff6b00]">ANTENA</span> <span className="text-[#ff6b00]">+{p.antennaHeight}m</span></div>
                      </div>
                    </div>
                  </Popup>
                </Marker>
              );
            })}

            {/* Loading Overlay */}
            {isLoading && (
                <div className="absolute inset-0 bg-white/5 z-[2000] flex items-center justify-center pointer-events-none">
                    <div className="flex flex-col items-center">
                        <div className="w-12 h-12 border-4 border-black border-t-transparent animate-spin mb-4" />
                        <span className="text-[10px] font-black tracking-[0.5em] text-black">UPLOADING GIS DATA</span>
                    </div>
                </div>
            )}
            </MapContainer>
            </div>
        </div>

        {/* Profile Area - BOTTOM */}
        <div className="h-[450px] bg-[#050505] flex flex-col px-8 pt-4 pb-4 border-t border-[#1a1a1a]">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                    <Activity className="w-3.5 h-3.5 text-[#ff6b00]" />
                    <h3 className="text-[9px] font-black uppercase tracking-[0.4em] font-display text-[#ccc]">Relieve del Enlace</h3>
                </div>
                <div className="flex items-center gap-10">
                    <div className="flex flex-col text-right">
                        <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">Cota Max</span>
                        <span className="text-sm font-mono font-bold text-white">{Math.max(...(losResult?.profile.map(p => p.elevation) || [0])).toFixed(0)}m</span>
                    </div>
                    <div className="flex flex-col text-right">
                        <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">Resultado</span>
                        <span className="text-sm font-mono font-bold text-[#ff6b00]">{losResult?.hasLOS ? 'LOS OK' : 'OBSTRUIDO'}</span>
                    </div>
                </div>
            </div>
            <div className="flex-1 min-h-0 bg-[#080808]">
                    <ProfileChart 
                        profile={losResult?.profile || []} 
                        points={points} 
                        activePointId={activePointId}
                        isLoading={isLoading} 
                        obstructionPoint={losResult?.obstructionPoint}
                        onPointSelect={setActivePointId}
                    />
            </div>
        </div>
      </div>
    </div>
  );
}
