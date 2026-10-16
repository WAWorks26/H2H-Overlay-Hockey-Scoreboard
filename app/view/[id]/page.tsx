'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

interface Penalty { id: number; team: string; plyr: string; time: number; }
interface ShootoutRound { away: number; home: number; }

interface ScoreboardState {
  id: string; away_name: string; home_name: string;
  away_score: number; home_score: number; away_sog: number; home_sog: number;
  clock_seconds: number; period: string; clock_running: boolean;
  away_color: string; home_color: string; global_font: string;
  penalties: Penalty[];
  shootout_active?: boolean;
  shootout_rounds?: ShootoutRound[];
  right_panel_mode: string; right_panel_text: string;
  banner_active: boolean; banner_text: string;
  graphics_config: Record<string, any>;
}

export default function OBSOverlayPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<ScoreboardState | null>(null);

  const stateRef = useRef<ScoreboardState | null>(null);

  const [panelExiting, setPanelExiting] = useState(false);
  const [displayedPanelMode, setDisplayedPanelMode] = useState('none');
  const [displayedPanelText, setDisplayedPanelText] = useState('');

  const [bannerExiting, setBannerExiting] = useState(false);
  const [displayedBannerActive, setDisplayedBannerActive] = useState(false);
  const [displayedBannerText, setDisplayedBannerText] = useState('');

  const activePanelModeRef = useRef('none');
  const bannerActiveRef = useRef(false);

  useEffect(() => {
    params.then(p => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const fetchState = async () => {
      const { data } = await supabase.from('scoreboards').select('*').eq('id', id).single();
      if (data) {
        stateRef.current = data;
        setState(data);
        
        const savedMode = data.right_panel_mode || 'none';
        const isTransientMode = ['awayGoal', 'homeGoal', 'goal', 'delayedPenalty'].includes(savedMode) || savedMode.startsWith('rollout');
        const modeToDisplay = isTransientMode ? 'none' : savedMode;

        setDisplayedPanelMode(modeToDisplay);
        setDisplayedPanelText(isTransientMode ? '' : (data.right_panel_text || ''));
        activePanelModeRef.current = modeToDisplay;

        if (isTransientMode) {
          supabase.from('scoreboards').update({ right_panel_mode: 'none', right_panel_text: '' }).eq('id', id).then();
        }

        const bActive = !!data.banner_active;
        setDisplayedBannerActive(bActive);
        setDisplayedBannerText(data.banner_text || '');
        bannerActiveRef.current = bActive;
      }
    };
    fetchState();

    const handleStateUpdate = (incomingState: any) => {
      const mergedState = { ...incomingState };

      if (mergedState.graphics_config === undefined || mergedState.graphics_config === null) {
        mergedState.graphics_config = stateRef.current?.graphics_config || {};
      }
      if (mergedState.penalties === undefined || mergedState.penalties === null) {
        mergedState.penalties = stateRef.current?.penalties || [];
      }
      if (mergedState.shootout_rounds === undefined || mergedState.shootout_rounds === null) {
        mergedState.shootout_rounds = stateRef.current?.shootout_rounds || Array(10).fill({ away: 0, home: 0 });
      }

      stateRef.current = mergedState as ScoreboardState;
      setState(mergedState as ScoreboardState);

      const newMode = mergedState.right_panel_mode || 'none';
      if (newMode === 'none' && activePanelModeRef.current !== 'none') {
        setPanelExiting(true);
        setTimeout(() => {
          setPanelExiting(false);
          setDisplayedPanelMode('none');
          activePanelModeRef.current = 'none';
        }, 500);
      } else if (newMode !== 'none') {
        setPanelExiting(false);
        setDisplayedPanelMode(newMode);
        setDisplayedPanelText(mergedState.right_panel_text || '');
        activePanelModeRef.current = newMode;
      }

      const isBannerOn = !!mergedState.banner_active;
      if (!isBannerOn && bannerActiveRef.current) {
        setBannerExiting(true);
        bannerActiveRef.current = false;
        setTimeout(() => {
          setBannerExiting(false);
          setDisplayedBannerActive(false);
        }, 500);
      } else if (isBannerOn && !bannerActiveRef.current) {
        setBannerExiting(false);
        setDisplayedBannerActive(true);
        setDisplayedBannerText(mergedState.banner_text || '');
        bannerActiveRef.current = true;
      } else if (isBannerOn) {
        setDisplayedBannerText(mergedState.banner_text || '');
      }
    };

    const channel = supabase.channel(`scoreboard_${id}`)
      .on('broadcast', { event: 'STATE_UPDATE' }, ({ payload }) => handleStateUpdate(payload))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scoreboards', filter: `id=eq.${id}` },
        (payload) => handleStateUpdate(payload.new)
      ).subscribe();

    let localChannel: BroadcastChannel | null = null;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      localChannel = new BroadcastChannel(`scoreboard_local_${id}`);
      localChannel.onmessage = (event) => {
        if (event.data) handleStateUpdate(event.data);
      };
    }

    return () => {
      supabase.removeChannel(channel);
      if (localChannel) localChannel.close();
    };
  }, [id]);

  const gc = state?.graphics_config || {};
  const isChromaGreen = gc.chromaKeyActive === true;
  const layoutStyle = gc.scoreboardStyle || 'style1';

  useEffect(() => {
    const targetBg = isChromaGreen ? '#00ff00' : 'transparent';
    document.body.style.backgroundColor = targetBg;
    document.documentElement.style.backgroundColor = targetBg;
    return () => {
      document.body.style.backgroundColor = '';
      document.documentElement.style.backgroundColor = '';
    };
  }, [isChromaGreen]);

  if (!state) return null;

  const formatTime = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;

  const awayPens = (state.penalties || []).filter(p => p.team === 'away');
  const homePens = (state.penalties || []).filter(p => p.team === 'home');

  let ppActive = false;
  let ppTeam = '';
  let ppTimeStr = '';
  let ppSituationStr = '';
  
  if (displayedPanelMode === 'none' && (awayPens.length > 0 || homePens.length > 0)) {
    if (awayPens.length !== homePens.length) {
      ppActive = true;
      const isAwayPP = homePens.length > awayPens.length;
      ppTeam = isAwayPP ? state.away_name : state.home_name;
      const lowestTime = isAwayPP ? Math.min(...homePens.map(p=>p.time)) : Math.min(...awayPens.map(p=>p.time));
      ppTimeStr = formatTime(lowestTime);
      ppSituationStr = `${5 - awayPens.length} VS ${5 - homePens.length}`;
    }
  }

  const currentMode = displayedPanelMode;
  const isRollout = currentMode.startsWith('rollout');
  const isDelayed = currentMode === 'delayedPenalty';
  const isAwayGoal = currentMode === 'awayGoal';
  const isHomeGoal = currentMode === 'homeGoal';
  const isGoal = isAwayGoal || isHomeGoal || currentMode === 'goal';

  const showRightPanel = isRollout || isDelayed || ppActive || isGoal || panelExiting;

  const activePanelKey = 
    ppActive ? 'ppPanel' :
    isAwayGoal ? 'awayGoal' :
    isHomeGoal ? 'homeGoal' :
    isGoal ? 'goal' :
    isDelayed ? 'delayedPenalty' :
    isRollout ? currentMode : 'rollout1';

  const getCompVar = (compKey: string, propSuffix: string, fallback: any = undefined) => {
    const directVal = gc[`${compKey}_${propSuffix}`];
    if (directVal !== undefined && directVal !== '') return directVal;

    if (compKey === 'awayGoal' || compKey === 'homeGoal') {
      const teamPrefix = compKey === 'awayGoal' ? 'awayTeam' : 'homeTeam';

      const isMediaProp = ['is_video', 'media_loop', 'img_alpha', 'img_scale', 'img_x', 'img_y', 'use_global_skew'].includes(propSuffix);
      if (isMediaProp) {
        const hasDirectMedia = gc[`${compKey}_media_url`] !== undefined && gc[`${compKey}_media_url`] !== '';
        if (hasDirectMedia) return fallback;
      }

      const inherited = gc[`${teamPrefix}_${propSuffix}`];
      if (inherited !== undefined && inherited !== '') return inherited;
    }

    return fallback;
  };

  const hexToRgba = (hex: string, alphaPercent: number = 100) => {
    if (!hex || hex === 'transparent') return 'transparent';
    let cleanHex = hex.replace('#', '');
    if (cleanHex.length === 3) cleanHex = cleanHex.split('').map(c => c + c).join('');
    const r = parseInt(cleanHex.substring(0, 2), 16) || 0;
    const g = parseInt(cleanHex.substring(2, 4), 16) || 0;
    const b = parseInt(cleanHex.substring(4, 6), 16) || 0;
    const a = (alphaPercent ?? 100) / 100;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  const getCompBackgroundStyle = (compKey: string, fallbackColor: string) => {
    const defaultTeamColor = 
      compKey === 'awayTeam' || compKey === 'awayGoal' ? (state.away_color || '#00468b') : 
      compKey === 'homeTeam' || compKey === 'homeGoal' ? (state.home_color || '#111111') : fallbackColor;

    const parentKey = compKey === 'awayGoal' ? 'awayTeam' : compKey === 'homeGoal' ? 'homeTeam' : compKey;
    const inheritedBgType = gc[`${parentKey}_bg_type`] || 'solid';
    const bgType = getCompVar(compKey, 'bg_type', inheritedBgType);

    if (bgType === 'clear') return { backgroundColor: 'transparent', backgroundImage: 'none' };

    const rawC1 = getCompVar(compKey, 'bg_color', defaultTeamColor);
    const rawC2 = getCompVar(compKey, 'bg_col2', '#000000');
    const rawC3 = getCompVar(compKey, 'bg_col3', '#888888');

    const a1 = parseFloat(getCompVar(compKey, 'col1_alpha', 100));
    const a2 = parseFloat(getCompVar(compKey, 'col2_alpha', 100));
    const a3 = parseFloat(getCompVar(compKey, 'col3_alpha', 100));

    const c1 = hexToRgba(rawC1, a1);
    const c2 = hexToRgba(rawC2, a2);
    const c3 = hexToRgba(rawC3, a3);

    const angle = getCompVar(compKey, 'bg_angle', '90');
    const midPos = parseFloat(getCompVar(compKey, 'mid_pos', 50));
    const midWidth = parseFloat(getCompVar(compKey, 'mid_width', 0));

    const midStart = Math.max(0, midPos - midWidth / 2);
    const midEnd = Math.min(100, midPos + midWidth / 2);

    if (bgType === 'linear') return { backgroundImage: `linear-gradient(${angle}deg, ${c1}, ${c2})` };
    if (bgType === 'linear3') return { backgroundImage: `linear-gradient(${angle}deg, ${c1} 0%, ${c3} ${midStart}%, ${c3} ${midEnd}%, ${c2} 100%)` };
    if (bgType === 'radial') return { backgroundImage: `radial-gradient(circle, ${c1}, ${c2})` };

    return { backgroundColor: c1, backgroundImage: 'none' };
  };

  const getCompStyle = (compKey: string, defaultBg: string, defaultTextCol: string, defaultSize: number) => {
    const color = getCompVar(compKey, 'text_color', defaultTextCol);
    const fontSize = `${getCompVar(compKey, 'font_size', defaultSize)}px`;
    const fontFam = getCompVar(compKey, 'font_family', 'var(--global-font)');
    
    const strokeWidth = getCompVar(compKey, 'stroke_width', 0);
    const strokeColor = getCompVar(compKey, 'stroke_color', '#000000');
    const strokeCss = strokeWidth > 0 ? `${strokeWidth}px ${strokeColor}` : 'none';

    const bgAlpha = parseFloat(getCompVar(compKey, 'bg_alpha', 100)) / 100;

    return {
      color: color,
      fontSize: fontSize,
      fontFamily: fontFam,
      border: 'none', 
      WebkitTextStroke: strokeCss,
      paintOrder: 'stroke fill',
      opacity: bgAlpha,
      position: 'relative' as const,
      overflow: 'visible' as const,
      lineHeight: 1,
      fontVariantNumeric: 'tabular-nums',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box' as const
    };
  };

  const getTextSkewTransform = (compKey: string) => {
    const useGlobal = getCompVar(compKey, 'text_global_skew', false) === true;
    if (useGlobal) {
      const globalSkewNum = gc.skewAngle ? parseInt(gc.skewAngle) : (layoutStyle === 'style1' ? -15 : 0);
      return `skewX(${-globalSkewNum}deg)`;
    }
    const localSkewNum = parseInt(getCompVar(compKey, 'text_skew', 0));
    return `skewX(${localSkewNum}deg)`;
  };

  const renderCompLayers = (compKey: string, fallbackColor: string, hideLeftBorder = false) => {
    const url = getCompVar(compKey, 'media_url', '');
    const layerOrder = getCompVar(compKey, 'layer_order', 'mediaBelow');
    const colorStyle = getCompBackgroundStyle(compKey, fallbackColor);

    const isGradientForeground = layerOrder === 'mediaBelow';
    const colorZIndex = isGradientForeground ? 2 : 1;
    const mediaZIndex = isGradientForeground ? 1 : 2;

    const fillStyle: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none'
    };

    const isVid = getCompVar(compKey, 'is_video', false);
    const isLoop = getCompVar(compKey, 'media_loop', true);

    const imgAlpha = parseFloat(getCompVar(compKey, 'img_alpha', 100)) / 100;
    const imgX = getCompVar(compKey, 'img_x', '0');
    const imgY = getCompVar(compKey, 'img_y', '0');
    const imgScale = parseFloat(getCompVar(compKey, 'img_scale', 100)) / 100;
    const useGlobalSkew = getCompVar(compKey, 'use_global_skew', false);
    const skewVal = useGlobalSkew ? (gc.skewAngle ?? (layoutStyle === 'style1' ? -15 : 0)) : 0;

    const borderWidth = `${getCompVar(compKey, 'border_width', 0)}px`;
    const borderColor = getCompVar(compKey, 'border_color', '#ffffff');

    return (
      <>
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', zIndex: 0 }}>
          <div style={{ ...fillStyle, zIndex: colorZIndex, ...colorStyle }} />
          {url && (
            <div style={{ ...fillStyle, zIndex: mediaZIndex, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translateZ(0)', willChange: 'transform' }}>
              {isVid ? (
                <video 
                  key={`vid_${url}`} 
                  src={url}
                  autoPlay loop={isLoop} muted playsInline
                  style={{
                    width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none',
                    opacity: imgAlpha, willChange: 'transform', transformOrigin: 'center',
                    transform: `translate(${imgX}%, ${imgY}%) scale(${imgScale}) skewX(${skewVal}deg)`
                  }}
                />
              ) : (
                <img 
                  key={`img_${url}`}
                  src={url} alt="Background Media" 
                  style={{
                    width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none',
                    opacity: imgAlpha, willChange: 'transform', transformOrigin: 'center',
                    transform: `translate(${imgX}%, ${imgY}%) scale(${imgScale}) skewX(${skewVal}deg)`
                  }}
                />
              )}
            </div>
          )}
        </div>
        {borderWidth !== '0px' && (
          <div style={{ 
            position: 'absolute', inset: 0, zIndex: 10, 
            border: `${borderWidth} solid ${borderColor}`, 
            borderLeft: hideLeftBorder ? 'none' : `${borderWidth} solid ${borderColor}`,
            borderRadius: 'inherit', pointerEvents: 'none' 
          }} />
        )}
      </>
    );
  };

  const getTextAnimStyle = (compKey: string) => {
    const animType = getCompVar(compKey, 'text_anim', 'none');
    if (animType === 'none') return {};

    const durVal = parseInt(getCompVar(compKey, 'text_anim_dur', '0.6'));
    const dur = `${isNaN(durVal) ? 0.6 : durVal}s`;

    switch (animType) {
      case 'wipeLeft': return { animation: `animWipeLeft ${dur} ease-out forwards` };
      case 'wipeRight': return { animation: `animWipeRight ${dur} ease-out forwards` };
      case 'wipeUp': return { animation: `animWipeUp ${dur} ease-out forwards` };
      case 'wipeDown': return { animation: `animWipeDown ${dur} ease-out forwards` };
      case 'fadeIn': return { animation: `animFadeIn ${dur} ease-out forwards` };
      case 'fadeOut': return { animation: `animFadeOut ${dur} ease-out forwards` };
      case 'zoomIn': return { animation: `animZoomIn ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` };
      case 'zoomOut': return { animation: `animZoomOut ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` };
      case 'typewriter': return { animation: `animTypewriter ${dur} steps(20, end) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const, margin: '0 auto', textAlign: 'center' as const, display: 'inline-block' };
      case 'glitchTypewriter': return { animation: `animGlitch ${dur} steps(15, end) forwards, animGlitchFlicker 0.2s infinite` };
      case 'spinInLeft': return { animation: `animSpinInLeft ${dur} ease-out forwards` };
      case 'spinInRight': return { animation: `animSpinInRight ${dur} ease-out forwards` };
      case 'pushLeft': return { animation: `animPushLeft ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'pushRight': return { animation: `animPushRight ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'pushUp': return { animation: `animPushUp ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'pushDown': return { animation: `animPushDown ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'randomFlash': return { animation: `animRandomFlash ${dur} steps(1, end) forwards` };
      case 'enlarge': return { animation: `animEnlarge ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` };
      case 'rightInsert': return { animation: `animRightInsert ${dur} cubic-bezier(0.1, 0.9, 0.2, 1) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const };
      case 'leftInsert': return { animation: `animLeftInsert ${dur} cubic-bezier(0.1, 0.9, 0.2, 1) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const };
      case 'blurLeft': return { animation: `animBlurLeft ${dur} ease-out forwards` };
      case 'blurRight': return { animation: `animBlurRight ${dur} ease-out forwards` };
      default: return {};
    }
  };

  const userSkew = gc.skewAngle ? `${gc.skewAngle}deg` : null;
  const skewAngle = userSkew || (layoutStyle === 'style1' ? '-15deg' : '0deg');

  const shootoutRounds = state.shootout_rounds || Array(10).fill({ away: 0, home: 0 });

  const renderShootoutOverlay = () => {
    if (!state.shootout_active) return null;

    const shootoutStyle = getCompStyle('shootout', '#0a0a0a', '#ffffff', 18);
    const useGlobalSkew = gc.shootout_text_global_skew === true;
    const shootoutContainerSkew = useGlobalSkew ? skewAngle : `${gc.shootout_text_skew || 0}deg`;

    return (
      <div 
        style={{
          marginTop: '6px', alignSelf: 'center', ...shootoutStyle,
          borderRadius: `${gc.cornerRadius || 8}px`, padding: '8px 24px',
          boxShadow: '0 8px 16px rgba(0,0,0,0.6)', transform: `skewX(${shootoutContainerSkew})`,
          display: 'flex', flexDirection: 'column', gap: '6px', zIndex: 100
        }}
      >
        {renderCompLayers('shootout', '#0a0a0a')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', position: 'relative', zIndex: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: 'bold', width: '70px', textAlign: 'right', whiteSpace: 'nowrap', paddingRight: '8px' }}>{state.away_name}</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              {shootoutRounds.map((r, i) => (
                <div key={i} style={{ width: '18px', height: '18px', borderRadius: '50%', border: '2px solid #555555', background: r.away === 1 ? '#10b981' : r.away === 2 ? '#ef4444' : '#1a1a1a', boxShadow: r.away === 1 ? '0 0 8px #10b981' : r.away === 2 ? '0 0 8px #ef4444' : 'none' }} />
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: 'bold', width: '70px', textAlign: 'right', whiteSpace: 'nowrap', paddingRight: '8px' }}>{state.home_name}</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              {shootoutRounds.map((r, i) => (
                <div key={i} style={{ width: '18px', height: '18px', borderRadius: '50%', border: '2px solid #555555', background: r.home === 1 ? '#10b981' : r.home === 2 ? '#ef4444' : '#1a1a1a', boxShadow: r.home === 1 ? '0 0 8px #10b981' : r.home === 2 ? '0 0 8px #ef4444' : 'none' }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div 
      id="scoreboard-master-container"
      style={{
        backgroundColor: isChromaGreen ? '#00ff00' : 'transparent',
        minHeight: '100vh', padding: '20px', position: 'relative',
        fontFamily: gc.globalFont || state.global_font || "'Roboto Condensed', sans-serif"
      }}
    >
      <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* STYLE 1: LINEAR SLANTED BUG BAR */}
        {layoutStyle === 'style1' && (
          <div style={{ display: 'flex', flexDirection: 'column', width: 'fit-content', position: 'relative' }}>
            
            <div 
              style={{ 
                position: 'relative',
                borderRadius: `${gc.cornerRadius || 8}px`, 
                boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
                transform: `skewX(${skewAngle})`, 
                width: 'fit-content',
                boxSizing: 'border-box'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'stretch' }}>
                <div style={{ padding: '12px 20px', ...getCompStyle('clock', '#111111', '#ffffff', 32), fontWeight: 'bold' }}>
                  {renderCompLayers('clock', '#111111')}
                  <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                </div>

                <div style={{ padding: '12px 15px', ...getCompStyle('period', '#222222', '#ffffff', 24), fontWeight: 'bold' }}>
                  {renderCompLayers('period', '#222222')}
                  <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                </div>
                
                <div id="away-team-box-wrapper" style={{ padding: '12px 28px', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 32), fontWeight: 'bold', flexDirection: 'column', minWidth: '180px', position: 'relative' }}>
                  {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                  <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam'), paddingRight: '8px', whiteSpace: 'nowrap', ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                  <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam') }}>SOG: {state.away_sog}</span>
                  
                  {/* FIX: Penalties anchored directly inside team box width */}
                  {awayPens.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10 }}>
                      {awayPens.map(p => (
                        <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>#{p.plyr}</span>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>{formatTime(p.time)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ padding: '12px 20px', ...getCompStyle('awayScore', '#ffffff', '#000000', 36), fontWeight: 'bold', minWidth: '60px' }}>
                  {renderCompLayers('awayScore', '#ffffff')}
                  <span key={`awayScore_${state.away_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                </div>

                <div id="home-team-box-wrapper" style={{ padding: '12px 28px', ...getCompStyle('homeTeam', state.home_color || '#111111', '#ffffff', 32), fontWeight: 'bold', flexDirection: 'column', minWidth: '180px', position: 'relative' }}>
                  {renderCompLayers('homeTeam', state.home_color || '#111111')}
                  <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam'), paddingRight: '8px', whiteSpace: 'nowrap', ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                  <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam') }}>SOG: {state.home_sog}</span>

                  {/* FIX: Penalties anchored directly inside team box width */}
                  {homePens.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10 }}>
                      {homePens.map(p => (
                        <div key={p.id} style={{ background: state.home_color || '#111111', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>#{p.plyr}</span>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>{formatTime(p.time)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ padding: '12px 20px', ...getCompStyle('homeScore', '#ffffff', '#000000', 36), fontWeight: 'bold', minWidth: '60px' }}>
                  {renderCompLayers('homeScore', '#ffffff')}
                  <span key={`homeScore_${state.home_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                </div>

                {/* RIGHT PANEL ROLLOUT WRAPPER - Positioned Absolute so it doesn't push the flex center */}
                {showRightPanel && (
                  <div style={{ 
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    bottom: 0,
                    zIndex: -1,
                    display: 'flex',
                    alignItems: 'stretch',
                    animation: panelExiting 
                      ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards'
                      : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ 
                      padding: '12px 24px', 
                      ...getCompStyle(activePanelKey, '#ffcc00', '#ffffff', 20),
                      fontWeight: 'bold', 
                      minWidth: '160px', 
                      boxSizing: 'border-box',
                      borderTopRightRadius: `${gc.cornerRadius || 8}px`,
                      borderBottomRightRadius: `${gc.cornerRadius || 8}px`
                    }}>
                      {renderCompLayers(activePanelKey, '#ffcc00', true)}
                      <span 
                        key={`rollout_txt_${activePanelKey}_${displayedPanelText}_${state.right_panel_text}`}
                        style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', flexShrink: 0, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey) }}
                      >
                        {ppActive && `${ppTeam} PP ${ppTimeStr}`}
                        {isDelayed && 'DELAYED PENALTY'}
                        {(isRollout || isGoal) && (displayedPanelText || state.right_panel_text)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* PERFECT FULL WIDTH BANNER OVERLAY - Matches Scoreboard EXACTLY */}
              {(displayedBannerActive || bannerExiting) && (
                <div 
                  style={{ 
                    position: 'absolute', inset: 0, zIndex: 99999,
                    display: 'flex', alignItems: 'stretch', height: '100%',
                    animation: bannerExiting 
                      ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards'
                      : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}
                >
                  <div style={{ ...getCompStyle('banner', '#007bff', '#ffffff', 32), fontWeight: 'bold', textAlign: 'center', width: '100%', height: '100%', border: 'none' }}>
                    {renderCompLayers('banner', '#007bff')}
                    <div 
                      key={`banner_txt_${displayedBannerText}_${state.banner_text}`}
                      style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 3, whiteSpace: 'nowrap', paddingRight: '8px', ...getTextAnimStyle('banner') }}
                    >
                      {displayedBannerText || state.banner_text}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {renderShootoutOverlay()}
          </div>
        )}

        {/* STYLE 2: CLASSIC GRID BUG */}
        {layoutStyle === 'style2' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: 'fit-content', position: 'relative' }}>
            <div 
              style={{ 
                position: 'relative',
                borderRadius: `${gc.cornerRadius || 8}px`, 
                boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
                border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
                width: 'fit-content'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'stretch', height: '80px', position: 'relative' }}>
                <div style={{ display: 'flex', flexDirection: 'column', width: '130px', height: '100%' }}>
                  <div style={{ height: '50%', ...getCompStyle('clock', '#111111', '#ffffff', 28), padding: '0 12px', fontWeight: 'bold' }}>
                    {renderCompLayers('clock', '#111111')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                  </div>
                  <div style={{ height: '50%', ...getCompStyle('period', '#ffffff', '#111111', 24), padding: '0 12px', fontWeight: 'bold' }}>
                    {renderCompLayers('period', '#ffffff')}
                    <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', width: '180px', height: '100%', position: 'relative' }}>
                  <div style={{ height: '50%', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 28), padding: '0 12px', fontWeight: 'bold' }}>
                    {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                  </div>
                  <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 22), padding: '0 12px', fontWeight: 'bold' }}>
                    {renderCompLayers('awaySog', '#ffffff')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px' }}>{state.away_sog}</span>
                  </div>
                  
                  {/* FIX: Penalties anchored directly inside team box width */}
                  {awayPens.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10 }}>
                      {awayPens.map(p => (
                        <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>#{p.plyr}</span>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>{formatTime(p.time)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                  <div style={{ height: '50%', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 8px', fontWeight: 'bold' }}>
                    {renderCompLayers('awayScore', '#002855')}
                    <span key={`awayScore_${state.away_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                  </div>
                  <div style={{ height: '50%', background: '#dbe2ea', color: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
                    SHOTS
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', width: '180px', height: '100%', position: 'relative' }}>
                  <div style={{ height: '50%', ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 28), padding: '0 12px', fontWeight: 'bold' }}>
                    {renderCompLayers('homeTeam', state.home_color || '#222222')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                  </div>
                  <div style={{ height: '50%', ...getCompStyle('homeSog', '#ffffff', '#000000', 22), padding: '0 12px', fontWeight: 'bold' }}>
                    {renderCompLayers('homeSog', '#ffffff')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px' }}>{state.home_sog}</span>
                  </div>

                  {/* FIX: Penalties anchored directly inside team box width */}
                  {homePens.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10 }}>
                      {homePens.map(p => (
                        <div key={p.id} style={{ background: state.home_color || '#111111', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>#{p.plyr}</span>
                          <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>{formatTime(p.time)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                  <div style={{ height: '50%', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 8px', fontWeight: 'bold' }}>
                    {renderCompLayers('homeScore', '#111111')}
                    <span key={`homeScore_${state.home_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                  </div>
                  <div style={{ height: '50%', background: '#dbe2ea', color: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
                    SHOTS
                  </div>
                </div>

                {showRightPanel && (
                  <div style={{ 
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    bottom: 0,
                    zIndex: -1,
                    animation: panelExiting 
                      ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards'
                      : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ 
                      padding: '0 24px', 
                      ...getCompStyle(activePanelKey, '#ffcc00', '#ffffff', 20),
                      flexDirection: 'column', 
                      minWidth: '160px', 
                      fontWeight: 'bold', 
                      height: '100%', 
                      textAlign: 'center',
                      boxSizing: 'border-box',
                      borderTopRightRadius: `${gc.cornerRadius || 8}px`,
                      borderBottomRightRadius: `${gc.cornerRadius || 8}px`
                    }}>
                      {renderCompLayers(activePanelKey, '#ffcc00', true)}
                      {ppActive ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', position: 'relative', zIndex: 3 }}>
                          <span style={{ fontSize: '12px', textTransform: 'uppercase', marginBottom: '2px', lineHeight: 1 }}>{ppSituationStr || `${ppTeam} PP`}</span>
                          <span style={{ fontSize: '30px', lineHeight: 1 }}>{ppTimeStr}</span>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', position: 'relative', zIndex: 3 }}>
                          <span 
                            key={`rollout_s2_txt_${activePanelKey}_${displayedPanelText}_${state.right_panel_text}`}
                            style={{ fontSize: '20px', lineHeight: 1, paddingRight: '8px', whiteSpace: 'nowrap', flexShrink: 0, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey) }}
                          >
                            {isDelayed && 'DELAYED PENALTY'}
                            {(isRollout || isGoal) && (displayedPanelText || state.right_panel_text)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              
              {(displayedBannerActive || bannerExiting) && (
                <div 
                  style={{ 
                    position: 'absolute', inset: 0, zIndex: 99999,
                    display: 'flex', alignItems: 'stretch', height: '100%',
                    animation: bannerExiting 
                      ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards'
                      : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}
                >
                  <div style={{ ...getCompStyle('banner', '#007bff', '#ffffff', 32), fontWeight: 'bold', textAlign: 'center', width: '100%', height: '100%', border: 'none' }}>
                    {renderCompLayers('banner', '#007bff')}
                    <div 
                      key={`banner_txt_${displayedBannerText}_${state.banner_text}`}
                      style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 3, whiteSpace: 'nowrap', paddingRight: '8px', ...getTextAnimStyle('banner') }}
                    >
                      {displayedBannerText || state.banner_text}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {renderShootoutOverlay()}
          </div>
        )}

        {/* STYLE 3: COMPACT SPLIT BUG */}
        {layoutStyle === 'style3' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: 'fit-content', position: 'relative' }}>
            <div 
              style={{ 
                position: 'relative',
                borderRadius: `${gc.cornerRadius || 8}px`, 
                boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
                border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
                width: 'fit-content'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'stretch', height: '80px', position: 'relative' }}>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: '110px', height: '100%' }}>
                  <div style={{ height: '50%', ...getCompStyle('clock', '#111111', '#ffffff', 28), padding: '0 16px', fontWeight: 'bold' }}>
                    {renderCompLayers('clock', '#111111')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                  </div>
                  <div style={{ height: '50%', ...getCompStyle('period', '#ffffff', '#111111', 22), padding: '0 16px', fontWeight: 'bold' }}>
                    {renderCompLayers('period', '#ffffff')}
                    <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', width: '320px', height: '100%', position: 'relative' }}>
                  <div style={{ display: 'flex', height: '50%', alignItems: 'stretch', position: 'relative' }}>
                    <div style={{ flex: 1, ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 26), padding: '0 16px', justifyContent: 'flex-start' }}>
                      {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                      <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                    </div>
                    <div style={{ minWidth: '65px', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 16px' }}>
                      {renderCompLayers('awayScore', '#002855')}
                      <span key={`awayScore_${state.away_score}`} style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', height: '50%', alignItems: 'stretch', position: 'relative' }}>
                    <div style={{ flex: 1, ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 26), padding: '0 16px', justifyContent: 'flex-start' }}>
                      {renderCompLayers('homeTeam', state.home_color || '#222222')}
                      <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                    </div>
                    <div style={{ minWidth: '65px', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 16px' }}>
                      {renderCompLayers('homeScore', '#111111')}
                      <span key={`homeScore_${state.home_score}`} style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                    </div>
                  </div>

                  {/* FIX: Penalties anchored directly below the entire 320px column for Style 3 */}
                  {(awayPens.length > 0 || homePens.length > 0) && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', display: 'flex', gap: '8px', zIndex: 10, marginTop: '4px' }}>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {awayPens.map(p => (
                          <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                            <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>#{p.plyr}</span>
                            <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>{formatTime(p.time)}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {homePens.map(p => (
                          <div key={p.id} style={{ background: state.home_color || '#111111', color: '#fff', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                            <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>#{p.plyr}</span>
                            <span style={{ transform: `skewX(${-parseInt(skewAngle)}deg)` }}>{formatTime(p.time)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', minWidth: '60px', position: 'relative', background: '#ffffff', color: '#000', height: '100%' }}>
                  <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 20), fontWeight: 'bold' }}>
                    {renderCompLayers('awaySog', '#ffffff')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px' }}>{state.away_sog}</span>
                  </div>
                  
                  <span style={{ 
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    fontSize: '9px', fontWeight: 'bold', color: '#444', background: '#e2e8f0', 
                    padding: '2px 5px', borderRadius: '3px', border: '1px solid #cbd5e1', 
                    boxShadow: '0 2px 4px rgba(0,0,0,0.15)', zIndex: 10, lineHeight: 1
                  }}>
                    SOG
                  </span>

                  <div style={{ height: '50%', ...getCompStyle('homeSog', '#ffffff', '#000000', 20), fontWeight: 'bold' }}>
                    {renderCompLayers('homeSog', '#ffffff')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px' }}>{state.home_sog}</span>
                  </div>
                </div>

                {showRightPanel && (
                  <div style={{ 
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    bottom: 0,
                    zIndex: -1,
                    animation: panelExiting 
                      ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards'
                      : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ 
                      padding: '0 20px', 
                      ...getCompStyle(activePanelKey, '#ffcc00', '#ffffff', 20),
                      fontSize: '20px', fontWeight: 'bold', minWidth: '160px', height: '100%', boxSizing: 'border-box',
                      borderTopRightRadius: `${gc.cornerRadius || 8}px`,
                      borderBottomRightRadius: `${gc.cornerRadius || 8}px`
                    }}>
                      {renderCompLayers(activePanelKey, '#ffcc00', true)}
                      <span 
                        key={`rollout_s3_txt_${activePanelKey}_${displayedPanelText}_${state.right_panel_text}`}
                        style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', flexShrink: 0, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey) }}
                      >
                        {ppActive && `${ppTeam} PP ${ppTimeStr}`}
                        {isDelayed && 'DELAYED PENALTY'}
                        {(isRollout || isGoal) && (displayedPanelText || state.right_panel_text)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {(displayedBannerActive || bannerExiting) && (
                <div 
                  style={{ 
                    position: 'absolute', inset: 0, zIndex: 99999,
                    display: 'flex', alignItems: 'stretch', height: '100%',
                    animation: bannerExiting 
                      ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards'
                      : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}
                >
                  <div style={{ ...getCompStyle('banner', '#007bff', '#ffffff', 32), fontWeight: 'bold', textAlign: 'center', width: '100%', height: '100%', border: 'none' }}>
                    {renderCompLayers('banner', '#007bff')}
                    <div 
                      key={`banner_txt_${displayedBannerText}_${state.banner_text}`}
                      style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 3, whiteSpace: 'nowrap', paddingRight: '8px', ...getTextAnimStyle('banner') }}
                    >
                      {displayedBannerText || state.banner_text}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {renderShootoutOverlay()}
          </div>
        )}

      </div>
    </div>
  );
}