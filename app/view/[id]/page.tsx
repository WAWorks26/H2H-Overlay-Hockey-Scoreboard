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

    return () => {
      supabase.removeChannel(channel);
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

  const isRollout = state.right_panel_mode?.startsWith('rollout');
  const isDelayed = state.right_panel_mode === 'delayedPenalty';
  const isAwayGoal = state.right_panel_mode === 'awayGoal';
  const isHomeGoal = state.right_panel_mode === 'homeGoal';
  const isGoal = isAwayGoal || isHomeGoal || state.right_panel_mode === 'goal';
  const activeGoalComp = isAwayGoal ? 'awayGoal' : isHomeGoal ? 'homeGoal' : 'goal';

  const showRightPanel = isRollout || isDelayed || ppActive || isGoal;

  const getCompBackground = (compKey: string, fallbackColor: string) => {
    const bgType = gc[`${compKey}_bg_type`] || 'solid';
    if (bgType === 'clear') return { backgroundColor: 'transparent', backgroundImage: 'none' };

    const c1 = gc[`${compKey}_bg_color`] || 
      (compKey === 'awayTeam' || compKey === 'awayGoal' ? state.away_color : 
       compKey === 'homeTeam' || compKey === 'homeGoal' ? state.home_color : null) || 
      fallbackColor;
      
    const c2 = gc[`${compKey}_bg_col2`] || '#000000';
    const c3 = gc[`${compKey}_bg_col3`] || '#888888';
    const angle = gc[`${compKey}_bg_angle`] || '90';

    if (bgType === 'linear') return { backgroundImage: `linear-gradient(${angle}deg, ${c1}, ${c2})` };
    if (bgType === 'linear3') return { backgroundImage: `linear-gradient(${angle}deg, ${c1}, ${c3}, ${c2})` };
    if (bgType === 'radial') return { backgroundImage: `radial-gradient(circle, ${c1}, ${c2})` };

    return { backgroundColor: c1, backgroundImage: 'none' };
  };

  const getCompStyle = (compKey: string, defaultBg: string, defaultTextCol: string, defaultSize: number) => {
    const bgStyle = getCompBackground(compKey, defaultBg);
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
      ...bgStyle,
      color: color,
      fontSize: fontSize,
      fontFamily: fontFam,
      border: `${borderWidth} solid ${borderColor}`,
      WebkitTextStroke: strokeCss,
      paintOrder: 'stroke fill',
      opacity: bgAlpha,
      position: 'relative' as const,
      overflow: 'hidden' as const,
      lineHeight: 1
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

  const renderCompMedia = (compKey: string) => {
    const url = gc[`${compKey}_media_url`];
    if (!url) return null;

    const isVid = gc[`${compKey}_is_video`] === true;
    const loop = gc[`${compKey}_media_loop`] ?? true;
    const ts = gc[`${compKey}_media_ts`] || '0';
    const scale = parseFloat(gc[`${compKey}_img_scale`] || '100') / 100;
    const alpha = parseFloat(gc[`${compKey}_img_alpha`] || '100') / 100;
    const posX = gc[`${compKey}_img_x`] || '0';
    const posY = gc[`${compKey}_img_y`] || '0';
    
    const useGlobalSkew = gc[`${compKey}_use_global_skew`] === true;
    const globalSkewVal = gc.skewAngle ?? (layoutStyle === 'style1' ? -15 : 0);
    const mediaSkew = useGlobalSkew ? `${globalSkewVal}deg` : '0deg';

    const wrapperStyle: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 0,
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    };

    const mediaStyle: React.CSSProperties = {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      pointerEvents: 'none',
      opacity: alpha,
      transform: `translate(${posX}%, ${posY}%) scale(${scale}) skewX(${mediaSkew})`
    };

    if (isVid) {
      return (
        <div style={wrapperStyle}>
          <video 
            key={`${url}_${loop}_${ts}`}
            src={url}
            autoPlay loop muted playsInline
            style={mediaStyle}
          />
        </div>
      );
    }

    return (
      <div style={wrapperStyle}>
        <img 
          key={`${url}_${ts}`}
          src={url} alt="Background Media" 
          style={mediaStyle}
        />
      </div>
    );
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
        {renderCompMedia('shootout')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', position: 'relative', zIndex: 1 }}>
          
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

  const activePanelKey = isGoal ? activeGoalComp : isDelayed ? 'delayedPenalty' : 'rollout1';

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
                {renderCompMedia('clock')}
                <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('clock') }}>{formatTime(state.clock_seconds)}</span>
              </div>

              <div style={{ padding: '12px 15px', ...getCompStyle('period', '#222222', '#ffffff', 24), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {renderCompMedia('period')}
                <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('period') }}>{state.period}</span>
              </div>
              
              {/* AWAY TEAM BOX */}
              <div id="away-team-box-wrapper" style={{ padding: '12px 28px', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 32), fontWeight: 'bold', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: '180px', position: 'relative' }}>
                {renderCompMedia('awayTeam')}
                <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayTeam') }}>{state.away_name}</span>
                <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayTeam') }}>SOG: {state.away_sog}</span>
              </div>

              <div style={{ padding: '12px 20px', ...getCompStyle('awayScore', '#ffffff', '#000000', 36), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '60px' }}>
                {renderCompMedia('awayScore')}
                <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayScore') }}>{state.away_score}</span>
              </div>

              {/* HOME TEAM BOX */}
              <div id="home-team-box-wrapper" style={{ padding: '12px 28px', ...getCompStyle('homeTeam', state.home_color || '#111111', '#ffffff', 32), fontWeight: 'bold', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: '180px', position: 'relative' }}>
                {renderCompMedia('homeTeam')}
                <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeTeam') }}>{state.home_name}</span>
                <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeTeam') }}>SOG: {state.home_sog}</span>
              </div>

              <div style={{ padding: '12px 20px', ...getCompStyle('homeScore', '#ffffff', '#000000', 36), fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '60px' }}>
                {renderCompMedia('homeScore')}
                <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeScore') }}>{state.home_score}</span>
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
                  {renderCompMedia(activePanelKey)}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform(activePanelKey) }}>
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
                  height: '100%'
                }}
              >
                {renderCompMedia('banner')}
                <div style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
                  {renderCompMedia('clock')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('clock') }}>{formatTime(state.clock_seconds)}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('period', '#ffffff', '#111111', 24), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('period')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('period') }}>{state.period}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '180px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 28), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('awayTeam')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayTeam') }}>{state.away_name}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 22), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('awaySog')}
                  <span style={{ position: 'relative', zIndex: 1 }}>{state.away_sog}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('awayScore')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayScore') }}>{state.away_score}</span>
                </div>
                <div style={{ height: '50%', background: '#dbe2ea', color: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
                  SHOTS
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '180px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 28), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('homeTeam')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeTeam') }}>{state.home_name}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('homeSog', '#ffffff', '#000000', 22), padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('homeSog')}
                  <span style={{ position: 'relative', zIndex: 1 }}>{state.home_sog}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('homeScore')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeScore') }}>{state.home_score}</span>
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
                  {ppActive ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                      <span style={{ fontSize: '12px', textTransform: 'uppercase', marginBottom: '2px', lineHeight: 1 }}>{ppSituationStr || `${ppTeam} PP`}</span>
                      <span style={{ fontSize: '30px', lineHeight: 1 }}>{ppTimeStr}</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                      <span style={{ fontSize: '20px', lineHeight: 1 }}>
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
                  height: '100%'
                }}
              >
                {renderCompMedia('banner')}
                <div style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
                  {renderCompMedia('clock')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('clock') }}>{formatTime(state.clock_seconds)}</span>
                </div>
                <div style={{ height: '50%', ...getCompStyle('period', '#ffffff', '#111111', 22), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('period')}
                  <span style={{ position: 'relative', zIndex: 1, transform: getTextSkewTransform('period') }}>{state.period}</span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', width: '320px', height: '100%' }}>
                <div style={{ display: 'flex', height: '50%', alignItems: 'stretch' }}>
                  <div style={{ flex: 1, ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 26), padding: '0 16px', display: 'flex', alignItems: 'center' }}>
                    {renderCompMedia('awayTeam')}
                    <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayTeam') }}>{state.away_name}</span>
                  </div>
                  <div style={{ minWidth: '65px', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {renderCompMedia('awayScore')}
                    <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 1, transform: getTextSkewTransform('awayScore') }}>{state.away_score}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', height: '50%', alignItems: 'stretch' }}>
                  <div style={{ flex: 1, ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 26), padding: '0 16px', display: 'flex', alignItems: 'center' }}>
                    {renderCompMedia('homeTeam')}
                    <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeTeam') }}>{state.home_name}</span>
                  </div>
                  <div style={{ minWidth: '65px', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {renderCompMedia('homeScore')}
                    <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 1, transform: getTextSkewTransform('homeScore') }}>{state.home_score}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', minWidth: '60px', position: 'relative', background: '#ffffff', color: '#000', height: '100%' }}>
                <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 20), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                  {renderCompMedia('awaySog')}
                  <span style={{ position: 'relative', zIndex: 1 }}>{state.away_sog}</span>
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
                  {renderCompMedia('homeSog')}
                  <span style={{ position: 'relative', zIndex: 1 }}>{state.home_sog}</span>
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
                  {ppActive && `${ppTeam} PP ${ppTimeStr}`}
                  {isDelayed && 'DELAYED PENALTY'}
                  {(isRollout || isGoal) && state.right_panel_text}
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
                  height: '100%'
                }}
              >
                {renderCompMedia('banner')}
                <div style={{ transform: getTextSkewTransform('banner'), width: '100%', textAlign: 'center', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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