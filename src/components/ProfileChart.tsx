/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Area,
  Line,
  Bar,
  ReferenceLine,
  ReferenceDot
} from 'recharts';
import { TerrainPoint, Point } from '../types';
import { cn } from '../App';

interface ProfileChartProps {
  profile: TerrainPoint[];
  points: Point[];
  activePointId?: string | null;
  isLoading?: boolean;
  obstructionPoint?: TerrainPoint;
}

export const ProfileChart: React.FC<ProfileChartProps & { onPointSelect?: (id: string) => void }> = ({ 
  profile, 
  points, 
  activePointId, 
  isLoading, 
  obstructionPoint,
  onPointSelect
}) => {
  // ... (keep state and calculateDistance)
  function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  const stationDistances = useMemo(() => {
    let currentDist = 0;
    return points.map((p, i) => {
      if (i > 0) {
        currentDist += calculateDistance(points[i-1].lat, points[i-1].lng, p.lat, p.lng);
      }
      return { ...p, cumulativeDistance: currentDist };
    });
  }, [points]);

  const chartData = useMemo(() => {
    return profile.map(tp => {
      return {
        distance: parseFloat(tp.distance.toFixed(2)),
        elevation: tp.elevation,
        ray: tp.rayHeight ?? tp.elevation,
        obstacleTop: tp.obstacleHeight ? tp.elevation + tp.obstacleHeight : undefined,
        obstacleType: tp.obstacleType
      };
    });
  }, [profile]);

  if (isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#080808] border border-[#111] rounded-none">
        <div className="flex flex-col items-center">
            <div className="w-10 h-0.5 bg-white/10 overflow-hidden relative mb-2">
                <div className="absolute inset-0 bg-white animate-slide" style={{ width: '30%' }} />
            </div>
            <span className="text-[7px] uppercase tracking-[0.4em] font-black text-white/20">Calculating Profile</span>
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#080808] border border-[#111] rounded-none">
        <span className="text-[7px] uppercase tracking-[0.4em] font-black text-white/10">No Path Data</span>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-transparent overflow-visible flex flex-col">
      <div className="flex items-center gap-4 mb-2 px-4 text-[8px] font-black uppercase tracking-[0.2em] text-[#444]">
        <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-0.5 bg-[#ff6b00]" />
            <span>Relieve</span>
        </div>
        <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-0.5 bg-[#ffffff] border-t border-dashed border-[#ffffff]" />
            <span>Link</span>
        </div>
        <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-1.5 bg-[#64748b]" />
            <span>Obstáculo</span>
        </div>
        <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[#ff6b00]" />
            <span>A/B</span>
        </div>
        <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" />
            <span>Repetidor</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height="100%">
        <AreaChart 
          data={chartData} 
          margin={{ top: 100, right: 40, left: 40, bottom: 40 }}
          style={{ color: '#ffffff' }}
          onClick={(data) => {
            if (data && data.activeLabel !== undefined && onPointSelect) {
              const xPos = parseFloat(data.activeLabel);
              // Find the nearest station to this cumulative distance
              let nearest = stationDistances[0];
              let minDist = Math.abs(stationDistances[0].cumulativeDistance - xPos);
              
              stationDistances.forEach(sd => {
                const d = Math.abs(sd.cumulativeDistance - xPos);
                if (d < minDist) {
                  minDist = d;
                  nearest = sd;
                }
              });
              
              if (minDist < 1.0) { // Only select if clicking reasonably close (within 1km on chart)
                onPointSelect(nearest.id);
              }
            }
          }}
        >
          <defs>
            <linearGradient id="colorElev" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ff6b00" stopOpacity={0.4}/>
              <stop offset="95%" stopColor="#ff6b00" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="0" vertical={false} stroke="#1a1a1a" />
          <XAxis 
            dataKey="distance" 
            axisLine={false}
            tickLine={true}
            ticks={stationDistances.map(sd => parseFloat(sd.cumulativeDistance.toFixed(2)))}
            domain={[0, 'dataMax']}
            tick={({ x, y, payload }: any) => {
              const val = payload.value;
              const sd = stationDistances.find(s => Math.abs(s.cumulativeDistance - val) < 0.5);
              if (!sd) return null;
              const idx = stationDistances.indexOf(sd);
              const isFirst = idx === 0;
              const isLast = idx === stationDistances.length - 1;
              const isActive = sd.id === activePointId;
              
              // Calculate segment distance to previous station
              const prevSd = idx > 0 ? stationDistances[idx - 1] : null;
              const segmentKM = prevSd ? (sd.cumulativeDistance - prevSd.cumulativeDistance).toFixed(1) : "0.0";
              
              return (
                <g transform={`translate(${x},${y})`}>
                  <line y2={10} stroke="#333" strokeWidth={1} />
                  
                  <text x={0} y={22} textAnchor="middle" fill={isActive ? "#fff" : (isFirst || isLast ? "#ff6b00" : "#22c55e")} fontSize={10} fontWeight={900}>
                    {isFirst ? 'INICIO' : (isLast ? 'FINAL' : `R${idx}`)}
                  </text>
                  <text x={0} y={32} textAnchor="middle" fill={isActive ? "#ff6b00" : "#555"} fontSize={8} fontWeight={700}>
                    KM {val.toFixed(1)}
                  </text>
                </g>
              );
            }}
          />
          <YAxis 
            axisLine={false}
            tickLine={false}
            tick={{fontSize: 10, fill: '#666', fontWeight: 900}}
          />
          <Tooltip 
            cursor={{ stroke: '#ff6b00', strokeWidth: 1.5, strokeDasharray: '3 3' }}
            contentStyle={{ 
                fontSize: '11px', 
                borderRadius: '0px', 
                border: '1px solid #ff6b00',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
                backgroundColor: '#000',
                color: '#fff',
                fontFamily: 'JetBrains Mono',
                padding: '10px'
            }}
            itemStyle={{ color: '#fff', padding: '4px 0' }}
            labelStyle={{ color: '#ff6b00', fontWeight: 900, marginBottom: '6px', borderBottom: '1px solid #222', paddingBottom: '6px', textTransform: 'uppercase' }}
            labelFormatter={(label) => `Distancia: ${label} km`}
            formatter={(value: any, name: string) => [
              `${parseFloat(value).toFixed(1)} m`, 
              name === "elevation" ? "Cota Terreno" : (name === "ray" ? "Radio Enlace" : name)
            ]}
          />
          <Area 
            type="monotone" 
            dataKey="elevation" 
            stroke="#ff6b00" 
            strokeWidth={2}
            fillOpacity={1} 
            fill="url(#colorElev)" 
            name="Terreno"
            isAnimationActive={false}
          />
          <Bar
            dataKey={(data: any) => data.obstacleTop ? data.obstacleTop - data.elevation : 0}
            stackId="obs"
            baseValue="elevation"
            fill="#64748b"
            name="Obstáculo"
            isAnimationActive={false}
          />
          <Line 
            type="monotone" 
            dataKey="ray" 
            stroke="#ffffff" 
            strokeWidth={1}
            strokeDasharray="4 4" 
            dot={false}
            name="LOS"
            animationDuration={1000}
          />
          
          {/* Station Annotations */}
          {stationDistances.map((sd, idx) => {
            const isA = idx === 0;
            const isB = idx === stationDistances.length - 1;
            const isActive = sd.id === activePointId;
            const xPos = parseFloat(sd.cumulativeDistance.toFixed(2));
            
            // Critical points are Origen and Destino (Orange). Repeaters are Green.
            const themeColor = isA || isB ? "#ff6b00" : "#22c55e";
            const finalColor = isActive ? "#ffffff" : themeColor;
            
            return (
              <React.Fragment key={sd.id}>
                {/* Line at station position */}
                <ReferenceLine 
                    x={xPos} 
                    stroke={finalColor} 
                    strokeWidth={isActive ? 3 : (isA || isB ? 2 : 1.5)}
                    strokeDasharray={isActive ? "0" : "4 4"} 
                    opacity={isActive ? 1 : 0.6}
                />
                
                {/* Main Label Box */}
                <ReferenceLine
                    x={xPos}
                    stroke="transparent"
                    label={({ viewBox: { x } }: any) => {
                      const labelWidth = 110;
                      
                      // Position labels to not overlap
                      let boxX = x - labelWidth / 2;
                      if (isA) boxX = x + 2;
                      if (isB) boxX = x - labelWidth - 2;
                      
                      const textAlign = isA ? "start" : (isB ? "end" : "middle");
                      const textX = isA ? x + 10 : (isB ? x - 10 : x);

                      return (
                        <g className={cn("pointer-events-none transition-all duration-300", isActive && "translate-y-[-5px]")}>
                          <rect x={boxX} y={-95} width={labelWidth} height={48} fill="#000" fillOpacity={0.9} stroke={finalColor} strokeWidth={isActive ? 3 : 1.5} rx={0} />
                          <text x={textX} y={-80} textAnchor={textAlign} fill={finalColor} fontSize={10} fontWeight={900}>
                            {sd.label.split(':')[0]}
                          </text>
                          <text x={textX} y={-68} textAnchor={textAlign} fill="#999" fontSize={7} fontWeight={700}>
                            {sd.label.split(':')[1]?.trim() || ''}
                          </text>
                          <text x={textX} y={-56} textAnchor={textAlign} fill={isActive ? "#fff" : "#ff6b00"} fontSize={9} fontWeight={900}>
                            {sd.elevation.toFixed(0)}m + {sd.antennaHeight}m
                          </text>
                        </g>
                      );
                    }}
                />

                {/* Station Marker on Terrain Line */}
                <ReferenceDot 
                    x={xPos} 
                    y={sd.elevation} 
                    r={isActive ? 8 : 4} 
                    fill={isA || isB ? "#ff6b00" : "#22c55e"} 
                    stroke={isActive ? "#fff" : "#000"} 
                    strokeWidth={isActive ? 2 : 1.5}
                    isAnimationActive={false}
                    className="cursor-pointer"
                />
                
                {/* Connector Line to Antenna */}
                <ReferenceLine 
                    segment={[{ x: xPos, y: sd.elevation }, { x: xPos, y: sd.elevation + sd.antennaHeight }]}
                    stroke={finalColor}
                    strokeWidth={1}
                    strokeDasharray="2 2"
                />

                <ReferenceDot 
                    x={xPos} 
                    y={sd.elevation + sd.antennaHeight} 
                    r={isActive ? 8 : 6} 
                    fill={finalColor} 
                    stroke={"#000"} 
                    strokeWidth={2}
                    isAnimationActive={false}
                />
              </React.Fragment>
            );
          })}

          {obstructionPoint && (
              <ReferenceDot 
                  x={parseFloat(obstructionPoint.distance.toFixed(2))}
                  y={obstructionPoint.elevation}
                  r={4}
                  fill="#ef4444"
                  stroke="#ef4444"
                  strokeWidth={2}
                  fillOpacity={0.4}
              />
          )}

          {obstructionPoint && (
              <ReferenceLine 
                  x={parseFloat(obstructionPoint.distance.toFixed(2))}
                  stroke="#ef4444"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  label={({ viewBox: { x, y } }: any) => (
                    <g className="pointer-events-none">
                      <rect x={x - 45} y={y - 12} width={90} height={18} fill="#ef4444" fillOpacity={0.1} stroke="#ef4444" strokeWidth={0.5} rx={1} />
                      <text x={x} y={y} textAnchor="middle" fill="#ef4444" fontSize={7} fontWeight={900}>
                        OBSTRUCCIÓN {obstructionPoint.elevation.toFixed(0)}m
                      </text>
                    </g>
                  )}
              />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};
