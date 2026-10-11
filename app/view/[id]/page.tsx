'use client';

import { useEffect, useState, use } from 'react';
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
  const unwrappedParams = use(params);
  const id = unwrappedParams.id;
  const [state, setState] = useState<ScoreboardState | null>(null);

  useEffect(() => {
    const fetchState = async () => {
      const { data } = await supabase.from('scoreboards').select('*').eq('id', id).single();
      if (data) setState(data);
    };
    fetchState();

    const channel = supabase.channel(`scoreboard_${id}`)
      .on('broadcast', { event: 'STATE_UPDATE' }, ({ payload }) => {
        setState(payload);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scoreboards', filter: `id=eq.${id}` },
        (payload) => {
          const newData = payload.new as ScoreboardState;
          setState({
            ...newData,
            graphics_config: { ...(newData.graphics_config || {}) }
          });
        }
      ).subscribe();

    let localChannel: BroadcastChannel | null = null;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      localChannel = new BroadcastChannel(`scoreboard_local_${id}`);
      localChannel.onmessage = (event) => {
        if (event.data) {
          setState(event.data);
        }
      };
    }

    return () => {
      supabase.removeChannel(channel);
      if (localChannel) {
        localChannel.close();
      }
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
  
  if (state.right_panel_mode === 'none' && (awayPens.length > 0 || homePens.length > 0)) {
    if (awayPens.length !== homePens.length) {
      ppActive = true;
      const isAwayPP = homePens.length > awayPens.length;
      ppTeam = isAwayPP ? state.away_name : state.home_name;
      const lowestTime = isAwayPP ? Math.min(...homePens.map(p=>p.time)) : Math.min(...awayPens.map(p=>p.time));
      ppTimeStr = formatTime(lowestTime);
      ppSituationStr = `${5 - awayPens.length} VS ${5 - homePens.length}`;
    }
  }

  const currentMode = state.right_panel_mode || 'none';
  const isRollout = currentMode.startsWith('rollout');
  const isDelayed = currentMode === 'delayedPenalty';
  const isAwayGoal = currentMode === 'awayGoal';
  const isHomeGoal = currentMode === 'homeGoal';
  const isGoal = isAwayGoal || isHomeGoal || currentMode === 'goal';

  const showRightPanel = isRollout || isDelayed || ppActive || isGoal;

  const activePanelKey = 
    ppActive ? 'ppPanel' :
    isAwayGoal ? 'awayGoal' :
    isHomeGoal ? 'homeGoal' :
    isGoal ? 'goal' :
    isDelayed ? 'delayedPenalty' :
    isRollout ? currentMode : 'rollout1';

  const hexToRgba = (hex: string, alphaPercent: number = 100) => {
    if (!hex || hex === 'transparent') return 'transparent';
    let cleanHex = hex.replace('#', '');
    if (cleanHex.length === 3) {
      cleanHex = cleanHex.split('').map(c => c + c).join('');
    }
    const r = parseInt(cleanHex.substring(0, 2), 16) || 0;
    const g = parseInt(cleanHex.substring(2, 4), 16) || 0;
    const b = parseInt(cleanHex.substring(4, 6), 16) || 0;
    const a = (alphaPercent ?? 100) / 100;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  const getCompBackgroundStyle = (compKey: string, fallbackColor: string) => {
    const bgType = gc[`${compKey}_bg_type`] || 'solid';
    if (bgType === 'clear') return { backgroundColor: 'transparent', backgroundImage: 'none' };

    const rawC1 = gc[`${compKey}_bg_color`] || 
      (compKey === 'awayTeam' || compKey === 'awayGoal' ? state.away_color : 
       compKey === 'homeTeam' || compKey === 'homeGoal' ? state.home_color : null) || 
      fallbackColor;
      
    const rawC2 = gc[`${compKey}_bg_col2`] || '#000000';
    const rawC3 = gc[`${compKey}_bg_col3`] || '#888888';

    const a1 = gc[`${compKey}_col1_alpha`] !== undefined ? parseFloat(gc[`${compKey}_col1_alpha`]) : 100;
    const a2 = gc[`${compKey}_col2_alpha`] !== undefined ? parseFloat(gc[`${compKey}_col2_alpha`]) : 100;
    const a3 = gc[`${compKey}_col3_alpha`] !== undefined ? parseFloat(gc[`${compKey}_col3_alpha`]) : 100;

    const c1 = hexToRgba(rawC1, a1);
    const c2 = hexToRgba(rawC2, a2);
    const c3 = hexToRgba(rawC3, a3);

    const angle = gc[`${compKey}_bg_angle`] || '90';

    const midPos = parseFloat(gc[`${compKey}_mid_pos`] ?? '50');
    const midWidth = parseFloat(gc[`${compKey}_mid_width`] ?? '0');

    const midStart = Math.max(0, midPos - midWidth / 2);
    const midEnd = Math.min(100, midPos + midWidth / 2);

    if (bgType === 'linear') return { backgroundImage: `linear-gradient(${angle}deg, ${c1}, ${c2})` };
    
    if (bgType === 'linear3') {
      return { 
        backgroundImage: `linear-gradient(${angle}deg, ${c1} 0%, ${c3} ${midStart}%, ${c3} ${midEnd}%, ${c2} 100%)` 
      };
    }

    if (bgType === 'radial') return { backgroundImage: `radial-gradient(circle, ${c1}, ${c2})` };

    return { backgroundColor: c1, backgroundImage: 'none' };
  };

  const getCompStyle = (compKey: string, defaultBg: string, defaultTextCol: string, defaultSize: number) => {
    const color = gc[`${compKey}_text_color`] || defaultTextCol;
    const fontSize = `${gc[`${compKey}_font_size`] || defaultSize}px`;
    const fontFam = gc[`${compKey}_font_family`] || 'var(--global-font)';
    const borderWidth = `${gc[`${compKey}_border_width`] || 0}px`;
    const borderColor = gc[`${compKey}_border_color`] || '#ffffff';
    
    const strokeWidth = gc[`${compKey}_stroke_width`] || 0;
    const strokeColor = gc[`${compKey}_stroke_color`] || '#000000';
    const strokeCss = strokeWidth > 0 ? `${strokeWidth}px ${strokeColor}` : 'none';

    const bgAlpha = parseFloat(gc[`${compKey}_bg_alpha`] ?? '100') / 100;

    return {
      color: color,
      fontSize: fontSize,
      fontFamily: fontFam,
      border: `${borderWidth} solid ${borderColor}`,
      WebkitTextStroke: strokeCss,
      paintOrder: 'stroke fill',
      opacity: bgAlpha,
      position: 'relative' as const,
      overflow: 'hidden' as const,
      lineHeight: 1,
      fontVariantNumeric: 'tabular-nums',
      display: 'inline-block'
    };
  };

  const getTextSkewTransform = (compKey: string) => {
    const useGlobal = gc[`${compKey}_text_global_skew`] === true;
    if (useGlobal) {
      const globalSkewNum = gc.skewAngle ? parseInt(gc.skewAngle) : (layoutStyle === 'style1' ? -15 : 0);
      return `skewX(${-globalSkewNum}deg)`;
    }
    const localSkewNum = gc[`${compKey}_text_skew`] ? parseInt(gc[`${compKey}_text_skew`]) : 0;
    return `skewX(${localSkewNum}deg)`;
  };

  const renderCompLayers = (compKey: string, fallbackColor: string) => {
    const url = gc[`${compKey}_media_url`];
    const layerOrder = gc[`${compKey}_layer_order`] || 'mediaBelow';
    const colorStyle = getCompBackgroundStyle(compKey, fallbackColor);

    const isGradientForeground = layerOrder === 'mediaBelow';
    const colorZIndex = isGradientForeground ? 2 : 1;
    const mediaZIndex = isGradientForeground ? 1 : 2;

    const fillStyle: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none'
    };

    return (
      <>
        <div style={{ ...fillStyle, zIndex: colorZIndex, ...colorStyle }} />
        {url && (
          <div style={{ ...fillStyle, zIndex: mediaZIndex, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {gc[`${compKey}_is_video`] === true ? (
              <video 
                key={`${url}_${gc[`${compKey}_media_loop`] ?? true}_${gc[`${compKey}_media_ts`] || '0'}`}
                src={url}
                autoPlay loop muted playsInline
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  pointerEvents: 'none',
                  opacity: parseFloat(gc[`${compKey}_img_alpha`] || '100') / 100,
                  transform: `translate(${gc[`${compKey}_img_x`] || '0'}%, ${gc[`${compKey}_img_y`] || '0'}%) scale(${parseFloat(gc[`${compKey}_img_scale`] || '100') / 100}) skewX(${gc[`${compKey}_use_global_skew`] ? (gc.skewAngle ?? (layoutStyle === 'style1' ? -15 : 0)) : 0}deg)`
                }}
              />
            ) : (
              <img 
                key={`${url}_${gc[`${compKey}_media_ts`] || '0'}`}
                src={url} alt="Background Media" 
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  pointerEvents: 'none',
                  opacity: parseFloat(gc[`${compKey}_img_alpha`] || '100') / 100,
                  transform: `translate(${gc[`${compKey}_img_x`] || '0'}%, ${gc[`${compKey}_img_y`] || '0'}%) scale(${parseFloat(gc[`${compKey}_img_scale`] || '100') / 100}) skewX(${gc[`${compKey}_use_global_skew`] ? (gc.skewAngle ?? (layoutStyle === 'style1' ? -15 : 0)) : 0}deg)`
                }}
              />
            )}
          </div>
        )}
      </>
    );
  };

  const getTextAnimStyle = (compKey: string) => {
    const animType = gc[`${compKey}_text_anim`] || 'none';
    if (animType === 'none') return {};

    const dur = `${gc[`${compKey}_text_anim_dur`] || '0.6'}s`;

    switch (animType) {
      case 'wipeLeft':
        return { animation: `animWipeLeft ${dur} ease-out forwards` };
      case 'wipeRight':
        return { animation: `animWipeRight ${dur} ease-out forwards` };
      case 'wipeUp':
        return { animation: `animWipeUp ${dur} ease-out forwards` };
      case 'wipeDown':
        return { animation: `animWipeDown ${dur} ease-out forwards` };
      case 'fadeIn':
        return { animation: `animFadeIn ${dur} ease-out forwards` };
      case 'fadeOut':
        return { animation: `animFadeOut ${dur} ease-out forwards` };
      case 'zoomIn':
        return { animation: `animZoomIn ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` };
      case 'zoomOut':
        return { animation: `animZoomOut ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` };
      case 'typewriter':
        return { 
          animation: `animTypewriter ${dur} steps(20, end) forwards`, 
          overflow: 'hidden', 
          whiteSpace: 'nowrap' as const, 
          margin: '0 auto', 
          textAlign: 'center' as const,
          display: 'inline-block' 
        };
      case 'glitchTypewriter':
        return { animation: `animGlitch ${dur} steps(15, end) forwards, animGlitchFlicker 0.2s infinite` };
      case 'spinInLeft':
        return { animation: `animSpinInLeft ${dur} ease-out forwards` };
      case 'spinInRight':
        return { animation: `animSpinInRight ${dur} ease-out forwards` };
      case 'pushLeft':
        return { animation: `animPushLeft ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'pushRight':
        return { animation: `animPushRight ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'pushUp':
        return { animation: `animPushUp ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'pushDown':
        return { animation: `animPushDown ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` };
      case 'randomFlash':
        return { animation: `animRandomFlash ${dur} steps(1, end) forwards` };
      case 'enlarge':
        return { animation: `animEnlarge ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` };
      case 'rightInsert':
        return { animation: `animRightInsert ${dur} cubic-bezier(0.1, 0.9, 0.2, 1) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const };
      case 'leftInsert':
        return { animation: `animLeftInsert ${dur} cubic-bezier(0.1, 0.9, 0.2, 1) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const };
      case 'blurLeft':
        return { animation: `animBlurLeft ${dur} ease-out forwards` };
      case 'blurRight':
        return { animation: `animBlurRight ${dur} ease-out forwards` };
      default:
        return {};
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
          marginTop: '6px',
          alignSelf: 'center',
          ...shootoutStyle,
          borderRadius: `${gc.cornerRadius || 8}px`,
          padding: '8px 24px',
          boxShadow: '0 8px 16px rgba(0,0,0,0.6)',
          transform: `skewX(${shootoutContainerSkew})`,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          zIndex: 100
        }}
      >
        {renderCompLayers('shootout', '#0a0a0a')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', position: 'relative', zIndex: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: 'bold', width: '70px', textAlign: 'right' }}>
              {state.away_name}
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              {shootoutRounds.map((r, i) => (
                <div 
                  key={i} 
                  style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    border: '2px solid #555555',
                    background: r.away === 1 ? '#10b981' : r.away === 2 ? '#ef4444' : '#1a1a1a',
                    boxShadow: r.away === 1 ? '0 0 8px #10b981' : r.away === 2 ? '0 0 8px #ef4444' : 'none'
                  }}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontWeight: 'bold', width: '70px', textAlign: 'right' }}>
              {state.home_name}
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              {shootoutRounds.map((r, i) => (
                <div 
                  key={i} 
                  style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    border: '2px solid #555555',
                    background: r.home === 1 ? '#10b981' : r.home === 2 ? '#ef4444' : '#1a1a1a',
                    boxShadow: r.home === 1 ? '0 0 8px #10b981' : r.home === 2 ? '0 0 8px #ef4444' : 'none'
                  }}
                />
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
        minHeight: '100vh',
        padding: '20px',
        position: 'relative',
        fontFamily: gc.globalFont || state.global_font || "'Roboto Condensed', sans-serif"
      }}
    >
      <style>{`
        @keyframes animWipeLeft { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0 0 0 0); } }
        @keyframes animWipeRight { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes animWipeUp { from { clip-path: inset(100% 0 0 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes animWipeDown { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
        
        @keyframes animFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes animFadeOut { from { opacity: 1; } to { opacity: 0; } }
        
        @keyframes animZoomIn { from { opacity: 0; transform: scale(0.2); } to { opacity: 1; transform: scale(1); } }
        @keyframes animZoomOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(2.2); } }
        
        @keyframes animTypewriter { from { max-width: 0; } to { max-width: 100%; } }
        @keyframes animGlitch { 0% { opacity: 0; transform: translate(-4px, 2px); } 50% { opacity: 0.8; transform: translate(3px, -2px); } 100% { opacity: 1; transform: translate(0, 0); } }
        @keyframes animGlitchFlicker { 0% { text-shadow: 2px 0 red, -2px 0 blue; } 50% { text-shadow: -2px 0 red, 2px 0 blue; } 100% { text-shadow: 0 0 transparent; } }
        
        @keyframes animSpinInLeft { from { opacity: 0; transform: translateX(-120%) rotate(-180deg); } to { opacity: 1; transform: translateX(0) rotate(0deg); } }
        @keyframes animSpinInRight { from { opacity: 0; transform: translateX(120%) rotate(180deg); } to { opacity: 1; transform: translateX(0) rotate(0deg); } }
        
        @keyframes animPushLeft { from { opacity: 0; transform: translateX(100%); } to { opacity: 1; transform: translateX(0); } }
        @keyframes animPushRight { from { opacity: 0; transform: translateX(-100%); } to { opacity: 1; transform: translateX(0); } }
        @keyframes animPushUp { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }
        @keyframes animPushDown { from { opacity: 0; transform: translateY(-100%); } to { opacity: 1; transform: translateY(0); } }
        
        @keyframes animRandomFlash { 0% { opacity: 0; filter: brightness(2); } 20% { opacity: 1; filter: brightness(1); } 40% { opacity: 0.1; } 60% { opacity: 1; filter: brightness(1.5); } 80% { opacity: 0.3; } 100% { opacity: 1; filter: brightness(1); } }
        @keyframes animEnlarge { 0% { opacity: 0; transform: scale(0.1); } 80% { transform: scale(1.15); } 100% { opacity: 1; transform: scale(1); } }
        
        @keyframes animRightInsert { from { clip-path: polygon(100% 0, 100% 0, 100% 100%, 100% 100%); transform: translateX(30px); } to { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); transform: translateX(0); } }
        @keyframes animLeftInsert { from { clip-path: polygon(0 0, 0 0, 0 100%, 0 100%); transform: translateX(-30px); } to { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); transform: translateX(0); } }
        
        @keyframes animBlurLeft { from { opacity: 0; transform: translateX(-100px); filter: blur(20px); } to { opacity: 1; transform: translateX(0); filter: blur(0px); } }
        @keyframes animBlurRight { from { opacity: 0; transform: translateX(100px); filter: blur(20px); } to { opacity: 1; transform: translateX(0); filter: blur(0px); } }
        
        /* BANNER FULL WIDTH REVISED LEFT-TO-RIGHT WIPE SHOW/HIDE ROLLOUT ANIMATION */
        @keyframes animBannerRolloutLeftToRight {
          from { clip-path: polygon(0 0, 0 0, 0 100%, 0 100%); }
          to { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
        }

        @keyframes animBannerHideLeftToRight {
          from { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
          to { clip-path: polygon(100% 0, 100% 0, 100% 100%, 100% 100%); }
        }
      `}</style>

      {/* STYLE 1: LINEAR SLANTED BUG BAR */}
      {layoutStyle === 'style1' && (
        <div style={{ display: 'flex', flexDirection: 'column', width: 'fit-content' }}>
          
          <div 
            style={{ 
              position: 'relative',
              borderRadius: `${gc.cornerRadius || 8}px`, 
              overflow: 'hidden', 
              boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
              transform: `skewX(${skewAngle})`, 
              border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
              width: 'fit-content'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'stretch' }}>
              <div style={{ padding: '12px 20px', ...getCompStyle('clock', '#111111', '#ffffff', 32), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {renderCompLayers('clock', '#111111')}
                <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
              </div>

              {/* PERIOD */}
              <div style={{ padding: '12px 15px', ...getCompStyle('period', '#222222', '#ffffff', 24), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {renderCompLayers('period', '#222222')}
                <span 
                  key={`period_${state.period}`}
                  style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}
                >
                  {state.period}
                </span>
              </div>
              
              {/* AWAY TEAM BOX */}
              <div id="away-team-box-wrapper" style={{ padding: '12px 28px', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 32), fontWeight: 'bold', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: '180px', position: 'relative' }}>
                {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam') }}>SOG: {state.away_sog}</span>
              </div>

              {/* AWAY SCORE */}
              <div style={{ padding: '12px 20px', ...getCompStyle('awayScore', '#ffffff', '#000000', 36), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '60px' }}>
                {renderCompLayers('awayScore', '#ffffff')}
                <span 
                  key={`awayScore_${state.away_score}`}
                  style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}
                >
                  {state.away_score}
                </span>
              </div>

              {/* HOME TEAM BOX */}
              <div id="home-team-box-wrapper" style={{ padding: '12px 28px', ...getCompStyle('homeTeam', state.home_color || '#111111', '#ffffff', 32), fontWeight: 'bold', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: '180px', position: 'relative' }}>
                {renderCompLayers('homeTeam', state.home_color || '#111111')}
                <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam') }}>SOG: {state.home_sog}</span>
              </div>

              {/* HOME SCORE */}
              <div style={{ padding: '12px 20px', ...getCompStyle('homeScore', '#ffffff', '#000000', 36), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '60px' }}>
                {renderCompLayers('homeScore', '#ffffff')}
                <span 
                  key={`homeScore_${state.home_score}`}
                  style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}
                >
                  {state.home_score}
                </span>
              </div>

              {showRightPanel && (
                <div style={{ 
                  padding: '12px 24px', 
                  ...getCompStyle(activePanelKey, '#ffcc00', '#000000', 20),
                  fontWeight: 'bold', 
                  display: 'flex', 
                  alignItems: 'center', 
                  position: 'relative', 
                  minWidth: '160px', 
                  justifyContent: 'center' 
                }}>
                  {renderCompLayers(activePanelKey, '#ffcc00')}
                  <span 
                    key={`${activePanelKey}_${state.right_panel_text}_${Date.now()}`}
                    style={{ 
                      position: 'relative', 
                      zIndex: 3, 
                      transform: getTextSkewTransform(activePanelKey), 
                      ...getTextAnimStyle(activePanelKey) 
                    }}
                  >
                    {ppActive && `${ppTeam} PP ${ppTimeStr}`}
                    {isDelayed && 'DELAYED PENALTY'}
                    {(isRollout || isGoal) && state.right_panel_text}
                  </span>
                </div>
              )}
            </div>

            {/* FULL WIDTH BANNER WITH SHOW AND ROLLOUT-LEFT-TO-RIGHT HIDE ANIMATIONS */}
            {state.banner_active && (
              <div 
                style={{ 
                  ...getCompStyle('banner', '#007bff', '#ffffff', 32),
                  position: 'absolute', 
                  inset: 0,
                  zIndex: 99999, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  fontWeight: 'bold', 
                  textAlign: 'center',
                  width: '100%',
                  height: '100%',
                  animation: 'animBannerRolloutLeftToRight 0.6s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                }}
              >
                {renderCompLayers('banner', '#007bff')}
                <div key={`banner_${state.banner_text}_${Date.now()}`} style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', ...getTextAnimStyle('banner') }}>
                  {state.banner_text}
                </div>
              </div>
            )}
          </div>

          {renderShootoutOverlay()}

          {/* PENALTIES DISPLAY */}
          <div style={{ display: 'flex', position: 'relative', marginTop: '6px', transform: `skewX(${skewAngle})` }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', position: 'absolute', left: '175px', width: '236px' }}>
              {awayPens.map(p => (
                <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#fff', padding: '6px 14px', borderRadius: '4px', fontSize: '15px', fontWeight: '900', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box', width: '100%' }}>
                  <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', position: 'absolute', left: '511px', width: '236px' }}>
              {homePens.map(p => (
                <div key={p.id} style={{ background: state.home_color || '#111111', color: '#fff', padding: '6px 14px', borderRadius: '4px', fontSize: '15px', fontWeight: '900', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box', width: '100%' }}>
                  <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}

      {/* STYLE 2: CLASSIC GRID BUG */}
      {layoutStyle === 'style2' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: 'fit-content' }}>
          <div 
            style={{ 
              position: 'relative',
              borderRadius: `${gc.cornerRadius || 8}px`, 
              overflow: 'hidden', 
              boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
              border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
              width: 'fit-content'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'stretch', height: '80px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', width: '130px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('clock', '#111111', '#ffffff', 28), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('clock', '#111111')}
                  <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('period', '#ffffff', '#111111', 24), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('period', '#ffffff')}
                  <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '180px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 28), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                  <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 22), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('awaySog', '#ffffff')}
                  <span style={{ position: 'relative', zIndex: 3 }}>{state.away_sog}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('awayScore', '#002855')}
                  <span key={`awayScore_${state.away_score}`} style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                </div>
                <div style={{ height: '50%', background: '#dbe2ea', color: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
                  SHOTS
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '180px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 28), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('homeTeam', state.home_color || '#222222')}
                  <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('homeSog', '#ffffff', '#000000', 22), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('homeSog', '#ffffff')}
                  <span style={{ position: 'relative', zIndex: 3 }}>{state.home_sog}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('homeScore', '#111111')}
                  <span key={`homeScore_${state.home_score}`} style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                </div>
                <div style={{ height: '50%', background: '#dbe2ea', color: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
                  SHOTS
                </div>
              </div>

              {showRightPanel && (
                <div style={{ 
                  padding: '0 24px', 
                  ...getCompStyle(activePanelKey, '#ffcc00', '#000000', 20),
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  minWidth: '160px', 
                  fontWeight: 'bold', 
                  height: '100%', 
                  textAlign: 'center' 
                }}>
                  {renderCompLayers(activePanelKey, '#ffcc00')}
                  {ppActive ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', position: 'relative', zIndex: 3, ...getTextAnimStyle(activePanelKey) }}>
                      <span style={{ fontSize: '12px', textTransform: 'uppercase', marginBottom: '2px', lineHeight: 1 }}>{ppSituationStr || `${ppTeam} PP`}</span>
                      <span style={{ fontSize: '30px', lineHeight: 1 }}>{ppTimeStr}</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', position: 'relative', zIndex: 3 }}>
                      <span 
                        key={`${activePanelKey}_${state.right_panel_text}_${Date.now()}`}
                        style={{ fontSize: '20px', lineHeight: 1, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey) }}
                      >
                        {isDelayed && 'DELAYED PENALTY'}
                        {(isRollout || isGoal) && state.right_panel_text}
                      </span>
                    </div>
                  )}
                </div>
              )}

            </div>

            {state.banner_active && (
              <div 
                style={{ 
                  ...getCompStyle('banner', '#007bff', '#ffffff', 32),
                  position: 'absolute', 
                  inset: 0,
                  zIndex: 99999, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  fontWeight: 'bold', 
                  textAlign: 'center',
                  width: '100%',
                  height: '100%',
                  animation: 'animBannerRolloutLeftToRight 0.6s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                }}
              >
                {renderCompLayers('banner', '#007bff')}
                <div key={`banner_${state.banner_text}_${Date.now()}`} style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', ...getTextAnimStyle('banner') }}>
                  {state.banner_text}
                </div>
              </div>
            )}
          </div>

          {renderShootoutOverlay()}

          <div style={{ display: 'flex', gap: '20px', paddingLeft: '110px', marginTop: '4px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {awayPens.map(p => (
                <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#fff', padding: '4px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', width: '150px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginLeft: '10px' }}>
              {homePens.map(p => (
                <div key={p.id} style={{ background: state.home_color || '#222222', color: '#fff', padding: '4px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', width: '150px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* STYLE 3: COMPACT SPLIT BUG */}
      {layoutStyle === 'style3' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: 'fit-content' }}>
          <div 
            style={{ 
              position: 'relative',
              borderRadius: `${gc.cornerRadius || 8}px`, 
              overflow: 'hidden', 
              boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
              border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
              width: 'fit-content'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'stretch', height: '80px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: '110px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('clock', '#111111', '#ffffff', 28), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('clock', '#111111')}
                  <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('period', '#ffffff', '#111111', 22), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('period', '#ffffff')}
                  <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '320px', height: '100%' }}>
                <div style={{ display: 'flex', height: '50%', alignItems: 'stretch' }}>
                  <div style={{ flex: 1, ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 26), padding: '0 16px', display: 'flex', alignItems: 'center' }}>
                    {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                    <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                  </div>
                  <div style={{ minWidth: '65px', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {renderCompLayers('awayScore', '#002855')}
                    <span key={`awayScore_${state.away_score}`} style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', height: '50%', alignItems: 'stretch' }}>
                  <div style={{ flex: 1, ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 26), padding: '0 16px', display: 'flex', alignItems: 'center' }}>
                    {renderCompLayers('homeTeam', state.home_color || '#222222')}
                    <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                  </div>
                  <div style={{ minWidth: '65px', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {renderCompLayers('homeScore', '#111111')}
                    <span key={`homeScore_${state.home_score}`} style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', minWidth: '60px', position: 'relative', background: '#ffffff', color: '#000', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 20), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('awaySog', '#ffffff')}
                  <span style={{ position: 'relative', zIndex: 3 }}>{state.away_sog}</span>
                </div>
                
                <span style={{ 
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  fontSize: '9px', 
                  fontWeight: 'bold', 
                  color: '#444', 
                  background: '#e2e8f0', 
                  padding: '2px 5px', 
                  borderRadius: '3px', 
                  border: '1px solid #cbd5e1', 
                  boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                  zIndex: 10,
                  lineHeight: 1
                }}>
                  SOG
                </span>

                <div style={{ height: '50%', ...getCompStyle('homeSog', '#ffffff', '#000000', 20), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompLayers('homeSog', '#ffffff')}
                  <span style={{ position: 'relative', zIndex: 3 }}>{state.home_sog}</span>
                </div>
              </div>

              {showRightPanel && (
                <div style={{ 
                  padding: '0 20px', 
                  ...getCompStyle(activePanelKey, '#ffcc00', '#000000', 20),
                  fontSize: '20px', 
                  fontWeight: 'bold', 
                  display: 'flex', 
                  alignItems: 'center', 
                  minWidth: '160px', 
                  justifyContent: 'center', 
                  height: '100%' 
                }}>
                  {renderCompLayers(activePanelKey, '#ffcc00')}
                  <span 
                    key={`${activePanelKey}_${state.right_panel_text}_${Date.now()}`}
                    style={{ 
                      position: 'relative', 
                      zIndex: 3, 
                      transform: getTextSkewTransform(activePanelKey), 
                      ...getTextAnimStyle(activePanelKey) 
                    }}
                  >
                    {ppActive && `${ppTeam} PP ${ppTimeStr}`}
                    {isDelayed && 'DELAYED PENALTY'}
                    {(isRollout || isGoal) && state.right_panel_text}
                  </span>
                </div>
              )}
            </div>

            {state.banner_active && (
              <div 
                style={{ 
                  ...getCompStyle('banner', '#007bff', '#ffffff', 32),
                  position: 'absolute', 
                  inset: 0,
                  zIndex: 99999, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  fontWeight: 'bold', 
                  textAlign: 'center',
                  width: '100%',
                  height: '100%',
                  animation: 'animBannerRolloutLeftToRight 0.6s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                }}
              >
                {renderCompLayers('banner', '#007bff')}
                <div key={`banner_${state.banner_text}_${Date.now()}`} style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', ...getTextAnimStyle('banner') }}>
                  {state.banner_text}
                </div>
              </div>
            )}
          </div>

          {renderShootoutOverlay()}

          <div style={{ display: 'flex', gap: '20px', paddingLeft: '110px', marginTop: '4px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {awayPens.map(p => (
                <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#fff', padding: '4px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', width: '150px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginLeft: '10px' }}>
              {homePens.map(p => (
                <div key={p.id} style={{ background: state.home_color || '#222222', color: '#fff', padding: '4px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', width: '150px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}