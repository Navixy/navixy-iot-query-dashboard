/**
 * MapPanel Component
 * Renders GPS coordinates on an interactive Leaflet map with marker clustering
 */

import React, { useMemo, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLocale } from '@/i18n/LocaleProvider';
import { isDisplayableCoordinate } from '@/utils/gps';

const dotMarkerIcon = L.divIcon({
  className: 'map-dot-marker',
  html: '<span style="display:block;width:8px;height:8px;border-radius:9999px;background:var(--map-marker-color, #3b82f6);border:1px solid rgba(255,255,255,0.9);box-shadow:0 0 0 1px rgba(59,130,246,0.28);"></span>',
  iconSize: [8, 8],
  iconAnchor: [4, 4],
});

export interface GPSPoint {
  lat: number;
  lon: number;
  label?: string;
  data?: Record<string, unknown>;
}

export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export interface MapPanelProps {
  /** Array of GPS points to display on the map */
  points: GPSPoint[];
  /** Optional title for the map section */
  title?: string;
  /** Height of the map container (default: 400px) */
  height?: number | string;
  /** Optional CSS class for styling */
  className?: string;
  /** Columns to show in popup (if not specified, shows all data) */
  popupColumns?: string[];
  /** Enable marker clustering for large datasets */
  enableClustering?: boolean;
  /** Callback when map view changes (center or zoom) */
  onViewChange?: (viewState: MapViewState) => void;
  /** Show location count footer (default: true) */
  showLocationCount?: boolean;
}

/**
 * Component to fit map bounds to all markers
 */
function FitBounds({ points }: { points: GPSPoint[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;

    if (points.length === 1) {
      // Single point: zoom in reasonably close
      map.setView([points[0].lat, points[0].lon], 12);
    } else {
      const bounds = L.latLngBounds(
        points.map(p => [p.lat, p.lon] as [number, number])
      );
      // Frame every marker with a little padding — and stop there. Nudging the
      // zoom in afterwards re-hides the edge markers this is meant to reveal.
      map.fitBounds(bounds, {
        padding: [50, 50]
      });
    }
  }, [map, points]);

  return null;
}

/**
 * Component to track view changes (zoom and pan) and report to parent
 */
function ViewTracker({ onViewChange }: { onViewChange?: (viewState: MapViewState) => void }) {
  const map = useMap();

  useEffect(() => {
    const handleViewChange = () => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      
      if (onViewChange) {
        onViewChange({
          center: [center.lat, center.lng],
          zoom: zoom
        });
      }
    };

    // Listen for both zoom and move (pan) events
    map.on('zoomend', handleViewChange);
    map.on('moveend', handleViewChange);

    // Report initial state after a short delay (after FitBounds completes)
    const timer = setTimeout(() => {
      handleViewChange();
    }, 500);

    return () => {
      map.off('zoomend', handleViewChange);
      map.off('moveend', handleViewChange);
      clearTimeout(timer);
    };
  }, [map, onViewChange]);

  return null;
}

/**
 * Show All button component - fits map to show all markers
 */
function ShowAllButton({ points }: { points: GPSPoint[] }) {
  const { t } = useLocale();
  const map = useMap();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Disable click propagation to map using Leaflet's method
  useEffect(() => {
    if (buttonRef.current) {
      L.DomEvent.disableClickPropagation(buttonRef.current);
      L.DomEvent.disableScrollPropagation(buttonRef.current);
    }
  }, []);

  const handleShowAll = () => {
    if (points.length === 0) return;

    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 12, { animate: true });
    } else {
      const bounds = L.latLngBounds(
        points.map(p => [p.lat, p.lon] as [number, number])
      );
      // Fit to all markers and stop. A follow-up zoom-in would zoom out then back
      // in — the jump the tester reported — and re-crop the outermost markers.
      map.fitBounds(bounds, {
        padding: [50, 50],
        animate: true
      });
    }
  };

  return (
    <div 
      className="leaflet-top leaflet-right" 
      style={{ 
        position: 'absolute', 
        top: 10, 
        right: 10, 
        zIndex: 1000,
        pointerEvents: 'auto'  // Override Leaflet's pointer-events: none on overlays
      }}
    >
      <button
        ref={buttonRef}
        onClick={handleShowAll}
        className="bg-white border border-gray-300 rounded px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        style={{ 
          cursor: 'pointer',
          pointerEvents: 'auto'  // Ensure button receives pointer events
        }}
        title={t('report_view.map_panel.show_all_button.tooltip')}
      >
        {t('common.actions.show_all.cta')}
      </button>
    </div>
  );
}

/**
 * Clickable marker that zooms to location when clicked
 */
function ClickableMarker({ 
  point, 
  index, 
  popupColumns 
}: { 
  point: GPSPoint; 
  index: number;
  popupColumns?: string[];
}) {
  const map = useMap();
  
  const handleClick = () => {
    const targetZoom = 10; // Zoom level when clicking on marker
    map.setView([point.lat, point.lon], targetZoom, { animate: true });
  };

  return (
    <Marker 
      key={`marker-${index}-${point.lat}-${point.lon}`}
      position={[point.lat, point.lon]}
      icon={dotMarkerIcon}
      eventHandlers={{
        click: handleClick
      }}
    >
      <Popup>
        <PopupContent point={point} popupColumns={popupColumns} />
      </Popup>
    </Marker>
  );
}

/**
 * Format value for display in popup
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return value.toLocaleString();
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    // Format numbers nicely
    if (Number.isInteger(value)) {
      return value.toLocaleString();
    }
    return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(value);
}

/**
 * Generate popup content from point data
 */
function PopupContent({ 
  point, 
  popupColumns 
}: {
  point: GPSPoint;
  popupColumns?: string[];
}) {
  const { t } = useLocale();
  const dataEntries = useMemo(() => {
    if (!point.data) return [];
    
    const entries = Object.entries(point.data);
    
    if (popupColumns && popupColumns.length > 0) {
      return entries.filter(([key]) => popupColumns.includes(key));
    }
    
    // Limit to 10 fields if showing all data
    return entries.slice(0, 10);
  }, [point.data, popupColumns]);

  return (
    <div className="map-popup-content" style={{ minWidth: 150 }}>
      {point.label && (
        <div style={{ 
          fontWeight: 600, 
          marginBottom: 8,
          borderBottom: '1px solid #e0e0e0',
          paddingBottom: 4
        }}>
          {point.label}
        </div>
      )}
      <table style={{ fontSize: '12px', width: '100%' }}>
        <tbody>
          <tr>
            <td style={{ fontWeight: 500, paddingRight: 8 }}>{t('report_view.map_panel.latitude.label')}</td>
            <td>{point.lat.toFixed(6)}</td>
          </tr>
          <tr>
            <td style={{ fontWeight: 500, paddingRight: 8 }}>{t('report_view.map_panel.longitude.label')}</td>
            <td>{point.lon.toFixed(6)}</td>
          </tr>
          {dataEntries.map(([key, value]) => (
            <tr key={key}>
              <td style={{ fontWeight: 500, paddingRight: 8 }}>{key}:</td>
              <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {formatValue(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * MapPanel - Interactive map component for displaying GPS coordinates
 */
export function MapPanel({
  points,
  title,
  height = 400,
  className = '',
  popupColumns,
  onViewChange,
  showLocationCount = true,
}: MapPanelProps) {
  const { t } = useLocale();
  const mapRef = useRef<L.Map>(null);

  // Filter and validate GPS points. isDisplayableCoordinate also drops the (0,0)
  // null-island sentinel so a no-fix row can't stretch the fit bounds (FR-11283).
  const validPoints = useMemo(() => {
    return points.filter(p => isDisplayableCoordinate(p.lat, p.lon));
  }, [points]);

  // Calculate center point
  const center = useMemo<[number, number]>(() => {
    if (validPoints.length === 0) {
      return [51.505, -0.09]; // Default: London
    }
    
    const avgLat = validPoints.reduce((sum, p) => sum + p.lat, 0) / validPoints.length;
    const avgLon = validPoints.reduce((sum, p) => sum + p.lon, 0) / validPoints.length;
    
    return [avgLat, avgLon];
  }, [validPoints]);

  if (validPoints.length === 0) {
    return (
      <div 
        className={`flex items-center justify-center bg-muted rounded-lg ${className}`}
        style={{ height }}
      >
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">{t('report_view.map_panel.empty_state.paragraph.empty')}</p>
          <p className="text-sm mt-1">
            {t('report_view.map_panel.empty_state.paragraph.instruction')}
          </p>
        </div>
      </div>
    );
  }

  // Determine if using flex layout (when height is 100%)
  const useFlexLayout = height === '100%';
  
  return (
    <div className={`${className} ${useFlexLayout ? 'flex flex-col h-full' : ''}`}>
      {title && (
        <h3 className="text-lg font-semibold mb-3">{title}</h3>
      )}
      <div 
        className={`rounded-lg overflow-hidden border border-border ${useFlexLayout ? 'flex-1 min-h-0' : ''}`}
        style={useFlexLayout ? undefined : { height }}
      >
        <MapContainer
          ref={mapRef}
          center={center}
          zoom={10}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={true}
          attributionControl={false}
        >
          {/*
            crossOrigin lets the client-side PDF export (modern-screenshot) read the
            tiles without tainting the canvas. It is safe *because* this URL is hardcoded
            to OpenStreetMap, which returns `Access-Control-Allow-Origin: *` on every
            {s} subdomain — so the live map keeps rendering. This is a deliberate coupling:
            if the tile URL ever becomes configurable or moves to a source without CORS,
            drop crossOrigin here (it would break the live map for everyone) and instead
            set it on the cloned tile nodes inside the export util (src/utils/exportDashboardPdf.ts).
          */}
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            crossOrigin="anonymous"
          />
          
          <FitBounds points={validPoints} />
          <ViewTracker onViewChange={onViewChange} />
          <ShowAllButton points={validPoints} />
          
          {validPoints.map((point, index) => (
            <ClickableMarker 
              key={`marker-${index}-${point.lat}-${point.lon}`}
              point={point}
              index={index}
              popupColumns={popupColumns}
            />
          ))}
          
          {/* Custom Navixy attribution */}
          <div 
            className="leaflet-bottom leaflet-right"
            style={{ 
              position: 'absolute', 
              bottom: 5, 
              right: 5, 
              zIndex: 1000,
              pointerEvents: 'auto'
            }}
          >
            <a 
              href="https://www.navixy.com" 
              target="_blank" 
              rel="noopener noreferrer"
              title={t('report_view.map_panel.attribution_link.tooltip')}
              style={{ display: 'block' }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <g clipPath="url(#clip0_navixy)">
                  <path d="M9.92784 0.0618557C4.26804 1.05155 0.0927835 5.96907 0 11.7217V12.3402L10.3608 6.15464V0L9.92784 0.0618557Z" fill="#007AD2"/>
                  <path d="M24.064 11.8763C24.033 6.06186 19.8578 1.08247 14.1361 0.0618557L13.7031 0V6.21649L24.064 12.4948V11.8763Z" fill="#007AD2"/>
                  <path d="M0.772149 16.1754C1.63813 18.4331 3.12266 20.3816 5.10205 21.7733C7.14328 23.196 9.52473 23.9692 12.0299 23.9692C14.5041 23.9692 16.8855 23.227 18.8959 21.8043C20.8752 20.4434 22.3598 18.5259 23.2258 16.2991L23.3185 16.0208L11.999 9.15479L0.648438 15.928L0.772149 16.1754Z" fill="#007AD2"/>
                </g>
                <defs>
                  <clipPath id="clip0_navixy">
                    <rect width="24" height="24" fill="white"/>
                  </clipPath>
                </defs>
              </svg>
            </a>
          </div>
        </MapContainer>
      </div>
      {showLocationCount && (
        <div className="text-xs text-muted-foreground mt-2">
          {t('report_view.map_panel.location_count.label', { count: validPoints.length })}
        </div>
      )}
    </div>
  );
}

export default MapPanel;
