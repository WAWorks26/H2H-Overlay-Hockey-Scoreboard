'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';

interface Penalty { id: number; team: string; plyr: string; time: number; }
interface ShootoutRound { away: number; home: number; }

// One text in a rollout's text sequence. Item 0 is always the main "Rollout N Text" field.
// anim / animDur left blank = use the rollout component's own Text Animation settings.
interface RolloutSeqItem { id: string; text: string; dur: string; anim: string; animDur: string; }

const TEXT_ANIM_OPTIONS: [string, string][] = [
  ['none', 'None (Static)'], ['wipeLeft', 'Wipe Left'], ['wipeRight', 'Wipe Right'], ['wipeUp', 'Wipe Up'],
  ['wipeDown', 'Wipe Down'], ['fadeIn', 'Fade In'], ['fadeOut', 'Fade Out'], ['zoomIn', 'Zoom In'],
  ['zoomOut', 'Zoom Out'], ['typewriter', 'Typewriter (Centered)'], ['glitchTypewriter', 'Glitch Typewriter'],
  ['spinInLeft', 'Spin In Left'], ['spinInRight', 'Spin In Right'], ['pushLeft', 'Push Left'],
  ['pushRight', 'Push Right'], ['pushUp', 'Push Up'], ['pushDown', 'Push Down'], ['randomFlash', 'Random Flash'],
  ['enlarge', 'Enlarge'], ['rightInsert', 'Right Insert'], ['leftInsert', 'Left Insert'],
  ['blurLeft', 'Blur Left'], ['blurRight', 'Blur Right'],
];

const newSeqId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const DEFAULT_HOTKEYS: Record<string, string> = {
  toggleClock: 'Space', resetClock: '', addMin: '', subMin: '', addSec: '', subSec: '',
  resetAllStats: '', clearPenalties: '', triggerRollout1: 'Digit1', triggerRollout2: 'Digit2',
  triggerRollout3: 'Digit3', triggerDelayedPenalty: 'KeyD', triggerBanner: 'KeyB', triggerBanner2: '', triggerBanner3: '',
  addAwayGoal: 'KeyA', subAwayGoal: 'KeyZ', addAwaySog: 'KeyS', subAwaySog: '', addAwayPenalty: '',
  addHomeGoal: 'KeyH', subHomeGoal: 'KeyN', addHomeSog: 'KeyJ', subHomeSog: '', addHomePenalty: '',
  triggerAwayTimeout: '', triggerHomeTimeout: '', triggerAwayDelayed: '', triggerHomeDelayed: '', triggerFourOnFour: '',
};

export default function ControlPanelPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('tab-ops');
  const [selectedComp, setSelectedComp] = useState('clock');
  const [listeningKeyFor, setListeningKeyFor] = useState<string | null>(null);
  const [exportFolderHandle, setExportFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [exportFolderName, setExportFolderName] = useState<string>('');
  const [profileEventName, setProfileEventName] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedSettings, setCopiedSettings] = useState<any>(null);

  const [historyStack, setHistoryStack] = useState<any[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const isHistoryAction = useRef(false);

  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);

  // Game Ops: widths of the Clock | Team | Penalty columns (fr units, draggable dividers)
  const [opsCols, setOpsCols] = useState<number[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('h2h_ops_cols') || 'null');
      if (Array.isArray(v) && v.length === 3 && v.every((n: any) => typeof n === 'number' && n > 0)) return v;
    } catch { /* storage unavailable */ }
    return [1, 1, 1];
  });
  const opsColsRef = useRef<HTMLDivElement | null>(null);
  // Narrowest a Game Ops column may get before buttons stop being readable
  const OPS_MIN_COL_PX = 340;

  // Penalty entry form
  const [penTeam, setPenTeam] = useState<'away' | 'home'>('away');
  const [penPlyr, setPenPlyr] = useState('');
  const [penMin, setPenMin] = useState('2');
  const [penSec, setPenSec] = useState('00');

  // When the current side rollout auto-hides (for the preview countdown)
  const [rolloutEnds, setRolloutEnds] = useState<{ mode: string; at: number } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [autoSaveIntervalSec, setAutoSaveIntervalSec] = useState(15);
  const [periodLengthMin, setPeriodLengthMin] = useState(20);

  const stateRef = useRef(state);
  const channelRef = useRef<any>(null);
  const localChannelRef = useRef<BroadcastChannel | null>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const rolloutTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Monotonic sequence stamped on every broadcast so the overlay can discard
  // late / out-of-order messages (local BroadcastChannel vs Supabase vs DB echo).
  const broadcastSeqRef = useRef<number>(0);
  // Swap Teams: also swap the team names (off = graphics only)
  const [swapIncludesNames, setSwapIncludesNames] = useState(false);
  // Which text field's sequence dropdown is open (its seq key), or null.
  const [openSeqEditor, setOpenSeqEditor] = useState<string | null>(null);
  const bannerTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  const handleKeyDownRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  useEffect(() => {
    params.then(p => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const channel = supabase.channel(`scoreboard_${id}`, { config: { broadcast: { self: false } } });
    channel.subscribe();
    channelRef.current = channel;

    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      localChannelRef.current = new BroadcastChannel(`scoreboard_local_${id}`);
    }

    return () => { 
      supabase.removeChannel(channel);
      if (localChannelRef.current) {
        localChannelRef.current.close();
      }
    };
  }, [id]);

  const broadcastState = async (updatedState: any) => {
    // Date.now()-based so a reloaded control panel still outranks older messages
    const seq = Math.max(Date.now(), broadcastSeqRef.current + 1);
    broadcastSeqRef.current = seq;
    const stamped = { ...updatedState, _seq: seq };

    if (localChannelRef.current) {
      localChannelRef.current.postMessage(stamped);
    }
    if (channelRef.current) {
      await channelRef.current.send({
        type: 'broadcast',
        event: 'STATE_UPDATE',
        payload: stamped,
      });
    }
  };

  useEffect(() => {
    if (!id) return;
    const fetchState = async () => {
      const { data, error } = await supabase.from('scoreboards').select('*').eq('id', id).single();
      if (error) console.error("Supabase Error:", error.message);
      if (data) {
        let initialConfig = data.graphics_config || {};

        // One-time split of the shared Power Play panel into Away / Home panels:
        // copy the existing ppPanel graphic settings to both so nothing changes visually
        // and each can then be adjusted on its own. PP text/sequence stays shared.
        const hasSplitPP = Object.keys(initialConfig).some(k => k.startsWith('awayPP_') || k.startsWith('homePP_'));
        if (!hasSplitPP) {
          const sharedKeys = Object.keys(initialConfig).filter(k =>
            k.startsWith('ppPanel_') && !['ppPanel_seq', 'ppPanel_seq_loop', 'ppPanel_text'].includes(k));
          if (sharedKeys.length > 0) {
            const migrated = { ...initialConfig };
            sharedKeys.forEach(k => {
              const prop = k.slice('ppPanel_'.length);
              migrated[`awayPP_${prop}`] = initialConfig[k];
              migrated[`homePP_${prop}`] = initialConfig[k];
            });
            initialConfig = migrated;
            supabase.from('scoreboards').update({ graphics_config: migrated }).eq('id', id).then();
          }
        }
        const initialState = { 
          ...data, 
          penalties: data.penalties || [],
          shootout_rounds: data.shootout_rounds || Array(10).fill({ away: 0, home: 0 }),
          graphics_config: initialConfig
        };
        stateRef.current = initialState;
        setState(initialState);
        setHistoryStack([JSON.parse(JSON.stringify(initialConfig))]);
        setHistoryIndex(0);
      }
    };
    fetchState();
  }, [id]);

  const pushHistory = (newConfig: any) => {
    if (isHistoryAction.current) {
      isHistoryAction.current = false;
      return;
    }
    const cloned = JSON.parse(JSON.stringify(newConfig));
    setHistoryStack((prev) => {
      const sliced = prev.slice(0, historyIndex + 1);
      return [...sliced, cloned];
    });
    setHistoryIndex((prev) => prev + 1);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const newIdx = historyIndex - 1;
      const targetConfig = JSON.parse(JSON.stringify(historyStack[newIdx]));
      isHistoryAction.current = true;
      setHistoryIndex(newIdx);

      const currentState = stateRef.current;
      if (!currentState) return;
      
      const updated = { ...currentState, graphics_config: targetConfig };
      stateRef.current = updated;
      setState(updated);
      broadcastState(updated);
      supabase.from('scoreboards').update({ graphics_config: targetConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
    }
  };

  const handleRedo = () => {
    if (historyIndex < historyStack.length - 1) {
      const newIdx = historyIndex + 1;
      const targetConfig = JSON.parse(JSON.stringify(historyStack[newIdx]));
      isHistoryAction.current = true;
      setHistoryIndex(newIdx);

      const currentState = stateRef.current;
      if (!currentState) return;

      const updated = { ...currentState, graphics_config: targetConfig };
      stateRef.current = updated;
      setState(updated);
      broadcastState(updated);
      supabase.from('scoreboards').update({ graphics_config: targetConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
    }
  };

  useEffect(() => {
    let autoSaveTimer: NodeJS.Timeout;
    if (autoSaveEnabled) {
      autoSaveTimer = setInterval(async () => {
        if (stateRef.current) {
          await supabase.from('scoreboards').update({
            away_name: stateRef.current.away_name,
            home_name: stateRef.current.home_name,
            away_score: stateRef.current.away_score,
            home_score: stateRef.current.home_score,
            away_sog: stateRef.current.away_sog,
            home_sog: stateRef.current.home_sog,
            clock_seconds: stateRef.current.clock_seconds,
            period: stateRef.current.period,
            clock_running: stateRef.current.clock_running,
            penalties: stateRef.current.penalties,
            graphics_config: stateRef.current.graphics_config
          }).eq('id', id);
        }
      }, autoSaveIntervalSec * 1000);
    }
    return () => clearInterval(autoSaveTimer);
  }, [autoSaveEnabled, autoSaveIntervalSec, id]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    const currentState = stateRef.current;
    if (currentState?.clock_running && currentState.clock_seconds > 0) {
      interval = setInterval(() => {
        const liveState = stateRef.current;
        if (!liveState) return;
        
        const newPenalties = (liveState.penalties || [])
          .map((p: Penalty) => p.time > 0 ? { ...p, time: p.time - 1 } : p)
          .filter((p: Penalty) => p.time > 0);

        const nextState = {
          ...liveState,
          clock_seconds: liveState.clock_seconds <= 0 ? 0 : liveState.clock_seconds - 1,
          clock_running: liveState.clock_seconds <= 0 ? false : liveState.clock_running,
          penalties: newPenalties
        };

        stateRef.current = nextState;
        setState(nextState);
        broadcastState(nextState);

        if (liveState.clock_seconds <= 0) {
          clearInterval(interval);
          supabase.from('scoreboards').update({ clock_running: false, penalties: newPenalties }).eq('id', id).then();
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [state?.clock_running, id]);

  // SAFELY MERGES PENALTIES TO PREVENT COLLISION
  const updateField = async (field: string, value: any) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    
    const updated = { ...currentState, [field]: value };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    
    const payload: Record<string, any> = { 
      [field]: value, 
      clock_seconds: currentState.clock_seconds 
    };
    
    if (field !== 'penalties') {
      payload.penalties = currentState.penalties;
    }
    
    supabase.from('scoreboards').update(payload).eq('id', id).then();
  };

  const resetStats = (type: 'away' | 'home' | 'all') => {
    const currentState = stateRef.current;
    if (!currentState) return;

    if (rolloutTimerRef.current) {
      clearTimeout(rolloutTimerRef.current);
      rolloutTimerRef.current = null;
    }

    const payload: Record<string, any> = { right_panel_mode: 'none', right_panel_text: '' };
    if (type === 'away' || type === 'all') {
      payload.away_score = 0;
      payload.away_sog = 0;
    }
    if (type === 'home' || type === 'all') {
      payload.home_score = 0;
      payload.home_sog = 0;
    }

    const updated = { ...currentState, ...payload };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    supabase.from('scoreboards').update({ ...payload, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
  };

  const adjClock = async (seconds: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newSeconds = Math.max(0, currentState.clock_seconds + seconds);
    const updated = { ...currentState, clock_seconds: newSeconds };
    
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    supabase.from('scoreboards').update({ clock_seconds: newSeconds, penalties: currentState.penalties }).eq('id', id).then();
  };

  const toggleClock = async () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newRunningState = !currentState.clock_running;

    const updated = { ...currentState, clock_running: newRunningState };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    supabase.from('scoreboards').update({ clock_running: newRunningState, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
  };

  const resetClock = () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const totalSecs = periodLengthMin * 60;
    
    const updated = { ...currentState, clock_running: false, clock_seconds: totalSecs };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    supabase.from('scoreboards').update({ clock_running: false, clock_seconds: totalSecs, penalties: currentState.penalties }).eq('id', id).then();
  };

  const handlePeriodChange = async (newPeriod: string) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const totalSecs = periodLengthMin * 60;
    
    const updated = { 
      ...currentState, 
      period: newPeriod,
      clock_running: false, 
      clock_seconds: totalSecs 
    };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    supabase.from('scoreboards').update({ 
      period: newPeriod,
      clock_running: false, 
      clock_seconds: totalSecs,
      penalties: currentState.penalties
    }).eq('id', id).then();
  };

  const setExactPenaltyTime = async (penId: number, mins: number, secs: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    
    const newTotalSeconds = Math.max(0, (mins * 60) + secs);
    const updatedPenalties = (currentState.penalties || [])
      .map((p: Penalty) => p.id === penId ? { ...p, time: newTotalSeconds } : p)
      .filter((p: Penalty) => p.time > 0);

    const updated = { ...currentState, penalties: updatedPenalties };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    supabase.from('scoreboards').update({ penalties: updatedPenalties, clock_seconds: currentState.clock_seconds }).eq('id', id).then();
  };

  const updateGraphicVar = async (key: string, value: any, immediate = false, skipHistory = false) => {
    const currentState = stateRef.current;
    if (!currentState) return;

    const newConfig = { ...(currentState.graphics_config || {}), [key]: value };
    const updated = { ...currentState, graphics_config: newConfig };

    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);

    if (!skipHistory) {
      pushHistory(newConfig);
    }

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    if (immediate) {
      supabase.from('scoreboards').update({ graphics_config: newConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
    } else {
      debounceTimer.current = setTimeout(() => {
        supabase.from('scoreboards').update({ graphics_config: newConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
      }, 200);
    }
  };

  // Same as updateGraphicVar but writes several keys as one change / one history step.
  const updateGraphicVars = async (patch: Record<string, any>, immediate = false, skipHistory = false) => {
    const currentState = stateRef.current;
    if (!currentState) return;

    const newConfig = { ...(currentState.graphics_config || {}), ...patch };
    const updated = { ...currentState, graphics_config: newConfig };

    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);

    if (!skipHistory) pushHistory(newConfig);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const write = () => supabase.from('scoreboards').update({ graphics_config: newConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id).then();
    if (immediate) write();
    else debounceTimer.current = setTimeout(write, 200);
  };

  const getGVar = (key: string, fallback: any = '') => {
    return stateRef.current?.graphics_config?.[key] ?? fallback;
  };

  const getRefGVar = (key: string, fallback: any = '') => {
    return stateRef.current?.graphics_config?.[key] ?? fallback;
  };

  const copyComponentSettings = () => {
    const currentState = stateRef.current;
    if (!currentState) return;

    const config = currentState.graphics_config || {};
    const settingsToCopy: Record<string, any> = {};
    const prefix = `${selectedComp}_`;

    Object.keys(config).forEach((key) => {
      if (key.startsWith(prefix)) {
        const field = key.replace(prefix, '');
        settingsToCopy[field] = config[key];
      }
    });

    if (selectedComp === 'awayTeam') settingsToCopy['bg_color'] = currentState.away_color || config['awayTeam_bg_color'] || '#00468b';
    if (selectedComp === 'homeTeam') settingsToCopy['bg_color'] = currentState.home_color || config['homeTeam_bg_color'] || '#222222';

    setCopiedSettings(settingsToCopy);
    alert(`Copied graphics settings from [${selectedComp}]!`);
  };

  const pasteComponentSettings = () => {
    const currentState = stateRef.current;
    if (!currentState || !copiedSettings) {
      alert('No settings copied yet. Copy settings from an element first!');
      return;
    }

    const newConfig = { ...(currentState.graphics_config || {}) };
    let newAwayColor = currentState.away_color;
    let newHomeColor = currentState.home_color;

    Object.keys(copiedSettings).forEach((field) => {
      const fullKey = `${selectedComp}_${field}`;
      const val = copiedSettings[field];
      newConfig[fullKey] = val;

      if (field === 'bg_color') {
        if (selectedComp === 'awayTeam') newAwayColor = val;
        if (selectedComp === 'homeTeam') newHomeColor = val;
      }
    });

    const updated = { 
      ...currentState, 
      away_color: newAwayColor,
      home_color: newHomeColor,
      graphics_config: newConfig 
    };

    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    pushHistory(newConfig);

    supabase.from('scoreboards').update({ 
      away_color: newAwayColor,
      home_color: newHomeColor,
      graphics_config: newConfig,
      clock_seconds: currentState.clock_seconds,
      penalties: currentState.penalties
    }).eq('id', id).then();

    alert(`Pasted settings onto [${selectedComp}]!`);
  };

  // Swap every away-specific graphic setting with its home counterpart:
  // Away/Home Team Box, Score, Goal Rollout Panel and Shots on Goal (colors, media,
  // fonts, layers, animations...) plus the team box colors. Scores, SOG counts and
  // penalties are game data and are not touched.
  const swapTeamGraphics = () => {
    const currentState = stateRef.current;
    if (!currentState) return;

    const msg = swapIncludesNames
      ? 'Swap all Away and Home graphic settings AND team names?'
      : 'Swap all Away and Home graphic settings? (Team names stay where they are.)';
    if (!window.confirm(msg)) return;

    const oldConfig = currentState.graphics_config || {};
    const teamKey = /^(away|home)([A-Z][A-Za-z0-9]*_.+)$/; // awayTeam_bg_color, homeGoal_media_url, ...
    const newConfig: Record<string, any> = {};

    Object.keys(oldConfig).forEach(key => {
      const m = key.match(teamKey);
      if (m) {
        const swappedKey = `${m[1] === 'away' ? 'home' : 'away'}${m[2]}`;
        newConfig[swappedKey] = oldConfig[key];
      } else {
        newConfig[key] = oldConfig[key];
      }
    });

    // Team box colors live outside graphics_config
    const awayColor = currentState.away_color || oldConfig['awayTeam_bg_color'] || '#00468b';
    const homeColor = currentState.home_color || oldConfig['homeTeam_bg_color'] || '#222222';

    const updated: any = {
      ...currentState,
      away_color: homeColor,
      home_color: awayColor,
      graphics_config: newConfig,
    };
    if (swapIncludesNames) {
      updated.away_name = currentState.home_name;
      updated.home_name = currentState.away_name;
    }

    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    pushHistory(newConfig);

    const dbPayload: any = {
      away_color: updated.away_color,
      home_color: updated.home_color,
      graphics_config: newConfig,
      clock_seconds: currentState.clock_seconds,
      penalties: currentState.penalties,
    };
    if (swapIncludesNames) {
      dbPayload.away_name = updated.away_name;
      dbPayload.home_name = updated.home_name;
    }
    supabase.from('scoreboards').update(dbPayload).eq('id', id).then();

  };

  const currentTheme = getGVar('uiTheme', 'Light');
  const isLight = currentTheme === 'Light';
  const isConcrete = currentTheme === 'Concrete';
  const isSlate = currentTheme === 'Slate';

  const themeVars = {
    bgPage: isLight ? '#F1F4F8' : isConcrete ? '#888E99' : isSlate ? '#2F343E' : '#1C1C1E',
    bgHeader: isLight ? '#E1E5E9' : isConcrete ? '#535862' : isSlate ? '#2F343E' : '#141414',
    bgBox: isLight ? '#FFFFFF' : isConcrete ? '#535862' : isSlate ? '#454A53' : '#22262B',
    bgInput: isLight ? '#F1F5F9' : isConcrete ? '#6C737E' : isSlate ? '#2F343E' : '#16181B',
    textColor: isLight ? '#262A32' : isConcrete ? '#FFFFFF' : isSlate ? '#FFFFFF' : '#F0F0F0',
    headerTextCol: isLight ? '#262A32' : '#FFFFFF',
    textMuted: isLight ? '#1C2431' : isConcrete ? '#BDC601' : isSlate ? '#8892A2' : '#aaaaaa',
    borderCol: isLight ? '#E1E5E9' : isConcrete ? '#9AA1AD' : isSlate ? '#A1A1A1' : '#3C3C41',
    tabHeaderBg: isLight ? '#E1E5E9' : isConcrete ? '#495057' : isSlate ? '#2F343E' : '#141414',
    tabActiveBg: isLight ? '#FFFFFF' : isConcrete ? '#535862' : isSlate ? '#454A53' : '#22262B',
    tabActiveText: '#FF5100',
    tabInactiveText: isLight ? '#262A32' : '#D0D7DE',
    btnSecondaryBg: isLight ? '#E1E5E9' : isConcrete ? '#6C737E' : isSlate ? '#535862' : '#2D3238',
    btnSecondaryText: isLight ? '#262A32' : '#FFFFFF',
    btnSecondaryBorder: isLight ? '#B0C4DE' : isConcrete ? '#9AA1AD' : isSlate ? '#A1A1A1' : '#3C3C41',
  };

  useEffect(() => {
    document.body.style.setProperty('background-color', themeVars.bgPage, 'important');
    document.body.style.setProperty('color', themeVars.textColor, 'important');
    document.documentElement.style.setProperty('background-color', themeVars.bgPage, 'important');
    return () => {
      document.body.style.removeProperty('background-color');
      document.body.style.removeProperty('color');
      document.documentElement.style.removeProperty('background-color');
    };
  }, [themeVars.bgPage, themeVars.textColor]);

  const hotkeysConfig = getGVar('hotkeys', DEFAULT_HOTKEYS);

  const setHotkey = (actionKey: string, code: string) => {
    const updated = { ...hotkeysConfig, [actionKey]: code };
    updateGraphicVar('hotkeys', updated, true);
  };

  const clearAllHotkeys = () => {
    const cleared: Record<string, string> = {};
    Object.keys(DEFAULT_HOTKEYS).forEach(k => cleared[k] = '');
    updateGraphicVar('hotkeys', cleared, true);
  };

  const adjStat = async (team: 'away' | 'home', type: 'score' | 'sog', val: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;

    const field = `${team}_${type}`;
    const newVal = Math.max(0, (currentState[field] || 0) + val);
    
    const updatePayload: Record<string, any> = { 
      [field]: newVal,
      clock_seconds: currentState.clock_seconds,
      penalties: currentState.penalties
    };

    const isAutoRolloutEnabled = getRefGVar('auto_goal_rollout', true);

    if (type === 'score' && val > 0 && isAutoRolloutEnabled) {
      const isAway = team === 'away';
      const teamName = isAway ? (currentState.away_name || 'AWAY') : (currentState.home_name || 'HOME');
      const goalText = getRefGVar('goal_text_format', 'GOAL {TEAM}').replace(/{TEAM}/g, teamName);
      const mode = isAway ? 'awayGoal' : 'homeGoal';

      if (rolloutTimerRef.current) {
        clearTimeout(rolloutTimerRef.current);
        rolloutTimerRef.current = null;
      }

      const durationVal = parseInt(getRefGVar(`${mode}_duration`, '5'));
      const duration = isNaN(durationVal) || durationVal < 1 ? 5 : durationVal;

      const isAutoHide = getRefGVar(`${mode}_autohide`, true);
      const shouldAutoHide = isAutoHide === true || isAutoHide === 'true';

      updatePayload['right_panel_mode'] = mode;
      updatePayload['right_panel_text'] = goalText;

      if (shouldAutoHide) {
        rolloutTimerRef.current = setTimeout(() => {
          updateField('right_panel_mode', 'none');
        }, duration * 1000);
      }
    } else if (type === 'score') {
      updatePayload['right_panel_mode'] = 'none';
      updatePayload['right_panel_text'] = '';
    }

    const updated = { ...currentState, ...updatePayload };
    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);

    await supabase.from('scoreboards').update(updatePayload).eq('id', id);
  };

  // settingsKey: whose duration / auto-hide settings to use (defaults to the mode itself)
  const triggerRolloutWithAutoHide = (modeName: string, textValue: string, settingsKey: string = modeName, defaultSecs = 5) => {
    if (rolloutTimerRef.current) {
      clearTimeout(rolloutTimerRef.current);
      rolloutTimerRef.current = null;
    }

    const durationVal = parseInt(getRefGVar(`${settingsKey}_duration`, String(defaultSecs)));
    const duration = isNaN(durationVal) || durationVal < 1 ? defaultSecs : durationVal;

    const isAutoHide = getRefGVar(`${settingsKey}_autohide`, true);
    const shouldAutoHide = isAutoHide === true || isAutoHide === 'true';

    const currentState = stateRef.current;
    if (!currentState) return;

    const updated = { 
      ...currentState, 
      right_panel_mode: modeName, 
      right_panel_text: textValue 
    };

    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);
    
    supabase.from('scoreboards').update({ 
      right_panel_mode: modeName, 
      right_panel_text: textValue, 
      clock_seconds: currentState.clock_seconds,
      penalties: currentState.penalties
    }).eq('id', id).then();

    setRolloutEnds(modeName !== 'none' && shouldAutoHide ? { mode: modeName, at: Date.now() + duration * 1000 } : null);

    if (modeName !== 'none' && shouldAutoHide) {
      rolloutTimerRef.current = setTimeout(() => {
        // only hide if this rollout is still the one showing
        if (stateRef.current?.right_panel_mode === modeName) updateField('right_panel_mode', 'none');
      }, duration * 1000);
    }
  };

  // 4 on 4 side rollout (toggle). Graphics follow the Delayed Penalty panel until customised.
  const triggerFourOnFour = () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    if (currentState.right_panel_mode === 'fourOnFour') {
      if (rolloutTimerRef.current) clearTimeout(rolloutTimerRef.current);
      setRolloutEnds(null);
      updateField('right_panel_mode', 'none');
      return;
    }
    triggerRolloutWithAutoHide('fourOnFour', getRefGVar('fourOnFour_text', '4 ON 4'), 'fourOnFour', 10);
  };

  // Per-team side rollouts. Pressing the showing one again hides it; pressing another swaps.
  //  Timeout:         awayTimeout / homeTimeout - drawn with that team's Power Play panel graphics
  //  Delayed penalty: awayDelayed / homeDelayed - drawn with the Delayed Penalty graphics
  const triggerTeamRollout = (kind: 'timeout' | 'delayed', team: 'away' | 'home') => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const modeName = `${team}${kind === 'timeout' ? 'Timeout' : 'Delayed'}`;
    if (currentState.right_panel_mode === modeName) {
      if (rolloutTimerRef.current) clearTimeout(rolloutTimerRef.current);
      updateField('right_panel_mode', 'none');
      return;
    }
    if (kind === 'timeout') {
      triggerRolloutWithAutoHide(modeName, getRefGVar('timeout_text', 'TIMEOUT {TEAM}'), 'timeout', 30);
    } else {
      triggerRolloutWithAutoHide(modeName, getRefGVar('delayedPenalty_text', 'DELAYED PENALTY'), 'delayedPenalty', 5);
    }
  };

  const triggerRollout = async (num: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const modeName = `rollout${num}`;
    const isActivating = currentState.right_panel_mode !== modeName;
    const newMode = isActivating ? modeName : 'none';
    const txt = getRefGVar(`rollout${num}_text`, `ROLLOUT ${num}`);
    
    if (newMode === 'none') {
      if (rolloutTimerRef.current) clearTimeout(rolloutTimerRef.current);
      updateField('right_panel_mode', 'none');
    } else {
      triggerRolloutWithAutoHide(newMode, txt);
    }
  };

  const triggerDelayedPenalty = async () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newMode = currentState.right_panel_mode === 'delayedPenalty' ? 'none' : 'delayedPenalty';
    if (newMode === 'none') {
      if (rolloutTimerRef.current) clearTimeout(rolloutTimerRef.current);
      updateField('right_panel_mode', 'none');
    } else {
      triggerRolloutWithAutoHide(newMode, getRefGVar('delayedPenalty_text', 'DELAYED PENALTY'));
    }
  };

  // Three full-width banners share one banner slot on the overlay (only one shows at a
  // time). Which one is up is stored as graphics_config.active_banner:
  // 'banner' (Banner 1), 'banner2' or 'banner3'. Pressing the showing banner's button
  // hides it; pressing a different one swaps to it.
  const BANNER_KEYS = ['banner', 'banner2', 'banner3'];
  const BANNER_DEFAULT_TEXT: Record<string, string> = { banner: 'FULL WIDTH BANNER', banner2: 'BANNER 2', banner3: 'BANNER 3' };

  const triggerBanner = async (n: number = 1) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const key = BANNER_KEYS[n - 1] || 'banner';

    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }

    const currentKey = currentState.graphics_config?.active_banner || 'banner';
    const isActive = !(currentState.banner_active && currentKey === key);
    const txt = getRefGVar(`${key}_text`, BANNER_DEFAULT_TEXT[key]);

    const durationVal = parseInt(getRefGVar(`${key}_duration`, '5'));
    const duration = isNaN(durationVal) || durationVal < 1 ? 5 : durationVal;

    const isAutoHide = getRefGVar(`${key}_autohide`, true);
    const shouldAutoHide = isAutoHide === true || isAutoHide === 'true';

    const newConfig = { ...(currentState.graphics_config || {}), active_banner: key };
    const updated = {
      ...currentState,
      banner_active: isActive,
      banner_text: txt,
      graphics_config: newConfig,
    };

    stateRef.current = updated;
    setState(updated);
    broadcastState(updated);

    supabase.from('scoreboards').update({
      banner_active: isActive,
      banner_text: txt,
      graphics_config: newConfig,
      clock_seconds: currentState.clock_seconds,
      penalties: currentState.penalties
    }).eq('id', id).then();

    if (isActive && shouldAutoHide) {
      bannerTimerRef.current = setTimeout(() => {
        // only hide if this banner is still the one showing
        if ((stateRef.current?.graphics_config?.active_banner || 'banner') === key) {
          updateField('banner_active', false);
        }
      }, duration * 1000);
    }
  };

  useEffect(() => {
    handleKeyDownRef.current = (e: KeyboardEvent) => {
      if (e.repeat) return; 

      const target = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && !listeningKeyFor) return;

      if (listeningKeyFor) {
        e.preventDefault();
        setHotkey(listeningKeyFor, e.code);
        setListeningKeyFor(null);
        return;
      }

      const activeHotkeys = stateRef.current?.graphics_config?.hotkeys || DEFAULT_HOTKEYS;
      const matchedAction = Object.keys(activeHotkeys).find(action => activeHotkeys[action] === e.code);
      if (!matchedAction) return;

      e.preventDefault();

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      switch (matchedAction) {
        case 'toggleClock': toggleClock(); break;
        case 'resetClock': resetClock(); break;
        case 'addMin': adjClock(60); break;
        case 'subMin': adjClock(-60); break;
        case 'addSec': adjClock(1); break;
        case 'subSec': adjClock(-1); break;
        case 'resetAllStats': resetStats('all'); break;
        case 'clearPenalties': updateField('penalties', []); break;
        case 'triggerRollout1': triggerRollout(1); break;
        case 'triggerRollout2': triggerRollout(2); break;
        case 'triggerRollout3': triggerRollout(3); break;
        case 'triggerDelayedPenalty': triggerDelayedPenalty(); break;
        case 'triggerBanner': triggerBanner(1); break;
        case 'triggerAwayTimeout': triggerTeamRollout('timeout', 'away'); break;
        case 'triggerHomeTimeout': triggerTeamRollout('timeout', 'home'); break;
        case 'triggerAwayDelayed': triggerTeamRollout('delayed', 'away'); break;
        case 'triggerHomeDelayed': triggerTeamRollout('delayed', 'home'); break;
        case 'triggerFourOnFour': triggerFourOnFour(); break;
        case 'triggerBanner2': triggerBanner(2); break;
        case 'triggerBanner3': triggerBanner(3); break;
        case 'addAwayGoal': adjStat('away', 'score', 1); break;
        case 'subAwayGoal': adjStat('away', 'score', -1); break;
        case 'addAwaySog': adjStat('away', 'sog', 1); break;
        case 'subAwaySog': adjStat('away', 'sog', -1); break;
        case 'addHomeGoal': adjStat('home', 'score', 1); break;
        case 'subHomeGoal': adjStat('home', 'score', -1); break;
        case 'addHomeSog': adjStat('home', 'sog', 1); break;
        case 'subHomeSog': adjStat('home', 'sog', -1); break;
      }
    };
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (handleKeyDownRef.current) handleKeyDownRef.current(e);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const addPenalty = async () => {
    const plyr = penPlyr.trim() || "00";
    const min = parseInt(penMin) || 0;
    const sec = Math.min(59, parseInt(penSec) || 0);
    const time = (min * 60) + sec;
    
    if (time > 0) {
      const currentState = stateRef.current;
      if (!currentState) return;

      const newPenalties = [...(currentState.penalties || []), { id: Date.now(), team: penTeam, plyr, time }];
      updateField('penalties', newPenalties);
      setPenPlyr('');
      // back to the player # field, ready for the next penalty
      setTimeout(() => (document.getElementById('inp-pen-plyr') as HTMLInputElement | null)?.focus(), 0);
    }
  };

  const saveOpsCols = (v: number[]) => {
    setOpsCols(v);
    try { localStorage.setItem('h2h_ops_cols', JSON.stringify(v)); } catch { /* ignore */ }
  };

  // Drag the divider between column i and i+1
  const startColResize = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const box = opsColsRef.current;
    if (!box) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = [...opsCols];
    const total = start.reduce((a, b) => a + b, 0);
    const usable = box.getBoundingClientRect().width - 2 * 14; // minus the two dividers
    const minFr = Math.min(total * 0.45, total * (OPS_MIN_COL_PX / Math.max(usable, 1))); // keep columns readable
    let latest = start;
    const move = (ev: PointerEvent) => {
      const dFr = ((ev.clientX - startX) / usable) * total;
      const pair = start[i] + start[i + 1];
      const left = Math.min(pair - minFr, Math.max(minFr, start[i] + dFr));
      latest = [...start];
      latest[i] = left;
      latest[i + 1] = pair - left;
      setOpsCols(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveOpsCols(latest);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const renderColHandle = (i: number) => (
    <div
      className="ops-col-handle"
      title="Drag to resize columns · double-click to reset"
      onPointerDown={startColResize(i)}
      onDoubleClick={() => saveOpsCols([1, 1, 1])}
      style={{ cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' }}
    >
      <div style={{ width: '4px', height: '48px', borderRadius: '4px', background: themeVars.borderCol, opacity: 0.9 }} />
    </div>
  );

  // The Team Box background (solid or gradient) for a team, as the overlay draws it
  const teamBoxBg = (team: 'away' | 'home') => {
    const key = team === 'away' ? 'awayTeam' : 'homeTeam';
    const teamCol = team === 'away' ? (state?.away_color || '#00468b') : (state?.home_color || '#111111');
    const type = getGVar(`${key}_bg_type`, 'solid') || 'solid';
    const c1 = getGVar(`${key}_bg_color`, '') || teamCol;
    const c2 = getGVar(`${key}_bg_col2`, '') || '#000000';
    const c3 = getGVar(`${key}_bg_col3`, '') || '#888888';
    const angle = getGVar(`${key}_bg_angle`, '90') || '90';
    const midPos = parseFloat(getGVar(`${key}_mid_pos`, 50)) || 50;
    const midW = parseFloat(getGVar(`${key}_mid_width`, 0)) || 0;
    let bg = c1;
    if (type === 'linear') bg = `linear-gradient(${angle}deg, ${c1}, ${c2})`;
    else if (type === 'linear3') bg = `linear-gradient(${angle}deg, ${c1} 0%, ${c3} ${Math.max(0, midPos - midW / 2)}%, ${c3} ${Math.min(100, midPos + midW / 2)}%, ${c2} 100%)`;
    else if (type === 'radial') bg = `radial-gradient(circle, ${c1}, ${c2})`;
    else if (type === 'clear') bg = teamCol;
    // dark or light text depending on the main color
    const hex = String(type === 'clear' ? teamCol : c1).replace('#', '');
    const full = hex.length === 3 ? hex.split('').map(ch => ch + ch).join('') : hex.slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
    const lum = isNaN(r + g + b) ? 0 : (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return { '--btn-bg': bg, '--btn-fg': lum > 0.62 ? '#111111' : '#ffffff' } as React.CSSProperties;
  };

  const penRowBtn: React.CSSProperties = {
    borderRadius: '6px', flex: '1 1 0', minWidth: '58px', width: 'auto', margin: 0, padding: '0 4px',
    fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', boxSizing: 'border-box', minHeight: '40px',
  };

  // Hide whatever side rollout (timeout, delayed penalty, goal, rollout) is showing
  const hideSideRollout = () => {
    if (rolloutTimerRef.current) { clearTimeout(rolloutTimerRef.current); rolloutTimerRef.current = null; }
    setRolloutEnds(null);
    updateField('right_panel_mode', 'none');
  };

  useEffect(() => {
    if (!state || state.right_panel_mode === 'none' || !rolloutEnds) return;
    const t = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(t);
  }, [state?.right_panel_mode, rolloutEnds]);

  const removePenalty = async (penId: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newPenalties = currentState.penalties.filter((p: Penalty) => p.id !== penId);
    updateField('penalties', newPenalties);
  };

  const updateShootoutRound = async (index: number, team: 'away' | 'home', val: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newRounds = [...(currentState.shootout_rounds || Array(10).fill({ away: 0, home: 0 }))];
    newRounds[index] = { ...newRounds[index], [team]: val };
    updateField('shootout_rounds', newRounds);
  };

  const resetShootout = async () => {
    const emptyRounds = Array(10).fill({ away: 0, home: 0 });
    updateField('shootout_rounds', emptyRounds);
  };

  const handleMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (/\.(mpg|mpeg)$/i.test(file.name)) {
      alert("Modern web browsers and OBS overlays cannot decode legacy .mpg / .mpeg video codecs. Please convert your video file to .mp4 or .webm for live playback!");
      return;
    }

    const isVid = file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name);

    try {
      const fileExt = file.name.split('.').pop();
      const nowTs = Date.now();
      const fileName = `${selectedComp}_${nowTs}.${fileExt}`;
      const filePath = `${id}/${fileName}`;

      const { data: uploadData, error: uploadError } = await supabase
        .storage
        .from('media')
        .upload(filePath, file, { 
          upsert: true,
          contentType: file.type || (isVid ? 'video/mp4' : 'image/png')
        });

      if (uploadError) {
        console.error("Storage upload failed:", uploadError.message);
        alert(`Upload error: ${uploadError.message}`);
        return;
      }

      const { data: urlData } = supabase
        .storage
        .from('media')
        .getPublicUrl(filePath);

      if (urlData?.publicUrl) {
        const currentState = stateRef.current;
        if (!currentState) return;

        const newConfig = { 
          ...(currentState.graphics_config || {}),
          [`${selectedComp}_media_url`]: urlData.publicUrl,
          [`${selectedComp}_is_video`]: isVid,
          [`${selectedComp}_media_loop`]: true,
          [`${selectedComp}_media_ts`]: nowTs
        };

        const updated = { ...currentState, graphics_config: newConfig };
        stateRef.current = updated;
        setState(updated);
        await broadcastState(updated);
        pushHistory(newConfig);
        await supabase.from('scoreboards').update({ graphics_config: newConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id);
      }

    } catch (err) {
      console.error("Upload exception handled:", err);
    }
  };

  const clearMedia = async () => {
    const fileInput = document.getElementById(`file-input-${selectedComp}`) as HTMLInputElement;
    if (fileInput) fileInput.value = '';

    const currentState = stateRef.current;
    if (!currentState) return;

    const newConfig = { ...(currentState.graphics_config || {}) };
    delete newConfig[`${selectedComp}_media_url`];
    delete newConfig[`${selectedComp}_is_video`];
    delete newConfig[`${selectedComp}_media_loop`];
    delete newConfig[`${selectedComp}_media_ts`];

    const updated = { ...currentState, graphics_config: newConfig };
    stateRef.current = updated;
    setState(updated);
    await broadcastState(updated);
    pushHistory(newConfig);
    await supabase.from('scoreboards').update({ graphics_config: newConfig, clock_seconds: currentState.clock_seconds, penalties: currentState.penalties }).eq('id', id);
  };

  const selectExportFolder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker();
        setExportFolderHandle(handle);
        setExportFolderName(handle.name);
      } catch (err) {
        console.warn("Folder selection canceled or unsupported:", err);
      }
    } else {
      alert("Folder selection API is not supported in this browser. Downloads will prompt standard save location.");
    }
  };

  const clearExportFolder = () => {
    setExportFolderHandle(null);
    setExportFolderName('');
  };

  const exportProfileJSON = async () => {
    const customName = profileEventName.trim() 
      ? profileEventName.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
      : `${stateRef.current?.away_name || 'AWAY'}_vs_${stateRef.current?.home_name || 'HOME'}`;

    const exportData = {
      profile_title: profileEventName.trim() || customName,
      scoreboard: stateRef.current,
      graphics_config: stateRef.current?.graphics_config || {},
      exported_at: new Date().toISOString()
    };
    
    const jsonStr = JSON.stringify(exportData, null, 2);
    const fileName = `Scoreboard_Profile_${customName}_${Date.now()}.json`;

    if (exportFolderHandle) {
      try {
        const fileHandle = await exportFolderHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        alert(`Profile exported successfully as "${fileName}" to folder [${exportFolderName}]!`);
        return;
      } catch (err) {
        console.error("Failed to write to folder handle:", err);
      }
    }

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importProfileJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        const importedConfig = parsed.graphics_config || parsed.cssVars || {};
        const currentState = stateRef.current;

        const newScoreboardState = {
          ...currentState,
          ...(parsed.scoreboard || {}),
          id: id,
          graphics_config: importedConfig
        };

        if (parsed.profile_title) {
          setProfileEventName(parsed.profile_title);
        }

        stateRef.current = newScoreboardState;
        setState(newScoreboardState);
        await broadcastState(newScoreboardState);
        pushHistory(importedConfig);
        await supabase.from('scoreboards').update(newScoreboardState).eq('id', id);
        alert("Profile imported and synchronized successfully!");
      } catch (err) {
        alert("Failed to parse Profile JSON file. Ensure it is a valid format.");
      }
    };
    reader.readAsText(file);
  };

  const saveToTemporaryCache = () => {
    localStorage.setItem(`scoreboard_cache_${id}`, JSON.stringify(stateRef.current));
    alert("Profile saved to local browser temporary cache.");
  };

  const saveAsUserSystemDefault = () => {
    localStorage.setItem(`scoreboard_default_user`, JSON.stringify(stateRef.current));
    alert("Profile set as your system default for new scoreboards.");
  };

  const restoreUserDefaults = async () => {
    const saved = localStorage.getItem(`scoreboard_default_user`);
    if (!saved) {
      alert("No User Default profile found in local storage.");
      return;
    }
    const parsed = JSON.parse(saved);
    const restoredState = { ...parsed, id: id };
    
    stateRef.current = restoredState;
    setState(restoredState);
    await broadcastState(restoredState);
    pushHistory(restoredState.graphics_config || {});
    await supabase.from('scoreboards').update(restoredState).eq('id', id);
    alert("Restored User Default profile successfully.");
  };

  const factoryReset = async () => {
    if (!confirm("Are you sure you want to reset all scoreboard settings to factory defaults?")) return;
    const currentState = stateRef.current;
    if (!currentState) return;

    const cleanConfig = {};
    const defaultData = {
      away_name: 'AWAY',
      home_name: 'HOME',
      away_score: 0,
      home_score: 0,
      away_sog: 0,
      home_sog: 0,
      clock_seconds: 1200,
      period: '1ST',
      clock_running: false,
      penalties: [],
      shootout_rounds: Array(10).fill({ away: 0, home: 0 }),
      graphics_config: cleanConfig,
      banner_active: false,
      right_panel_mode: 'none'
    };
    const updated = { ...currentState, ...defaultData };
    
    stateRef.current = updated;
    setState(updated);
    await broadcastState(updated);
    pushHistory(cleanConfig);
    await supabase.from('scoreboards').update(defaultData).eq('id', id);
    alert("Scoreboard reset to factory defaults.");
  };

  const copyOverlayLink = () => {
    const url = `${window.location.origin}/view/${id}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  if (!state) return <div className="p-8 text-center text-slate-400 bg-[#1e1e1e] min-h-screen">Loading controller...</div>;
  const formatTime = (s: number) => `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;

  const bgType = getGVar(`${selectedComp}_bg_type`, 'solid');
  const currentMediaUrl = getGVar(`${selectedComp}_media_url`, '');
  const currentIsVideo = getGVar(`${selectedComp}_is_video`, false);
  const currentMediaLoop = getGVar(`${selectedComp}_media_loop`, true);
  const currentMediaTs = getGVar(`${selectedComp}_media_ts`, '0');
  const currentImgScale = getGVar(`${selectedComp}_img_scale`, '100');
  const currentImgAlpha = getGVar(`${selectedComp}_img_alpha`, '100');
  const currentImgX = getGVar(`${selectedComp}_img_x`, '0');
  const currentImgY = getGVar(`${selectedComp}_img_y`, '0');
  
  const mediaUseGlobalSkew = getGVar(`${selectedComp}_use_global_skew`, false);
  const globalSkewVal = getGVar('skewAngle', '0');
  const mediaComputedSkew = mediaUseGlobalSkew ? globalSkewVal : '0';

  const chromaActive = getGVar('chromaKeyActive', false);

  const selectStyle: React.CSSProperties = {
    backgroundColor: themeVars.bgInput,
    color: themeVars.textColor,
    borderColor: themeVars.borderCol
  };

  const isRolloutElement = ['rollout1', 'rollout2', 'rollout3', 'awayGoal', 'homeGoal', 'delayedPenalty', 'fourOnFour', 'banner', 'banner2', 'banner3'].includes(selectedComp);

  // ---------- Text sequences (rollouts, goals, delayed penalty, banner) ----------
  // Every rollout-style text field can hold a sequence of texts. The sequence is
  // stored at graphics_config[`${seqKey}_seq`]; item 0's text is mirrored into the
  // field's original key (textKey) so triggers and older overlays keep working.
  interface SeqFieldDef {
    seqKey: string;        // storage prefix + overlay lookup key
    label: string;
    textKey: string;       // original single-text key
    defaultText: string;
    durationKeys: string[]; // auto-hide duration key(s) for MATCH DURATION
    displayName: string;
    hint?: string;
  }

  const SEQ_FIELDS: SeqFieldDef[] = [
    { seqKey: 'goal', label: 'Goal Rollout Format:', textKey: 'goal_text_format', defaultText: 'GOAL {TEAM}', durationKeys: ['awayGoal_duration', 'homeGoal_duration'], displayName: 'the Away / Home Goal rollout', hint: 'Shared by Away and Home goals. {TEAM} is replaced with the scoring team name in any text.' },
    { seqKey: 'rollout1', label: 'Rollout 1 Text:', textKey: 'rollout1_text', defaultText: 'ROLLOUT 1', durationKeys: ['rollout1_duration'], displayName: 'Rollout 1' },
    { seqKey: 'rollout2', label: 'Rollout 2 Text:', textKey: 'rollout2_text', defaultText: 'ROLLOUT 2', durationKeys: ['rollout2_duration'], displayName: 'Rollout 2' },
    { seqKey: 'rollout3', label: 'Rollout 3 Text:', textKey: 'rollout3_text', defaultText: 'ROLLOUT 3', durationKeys: ['rollout3_duration'], displayName: 'Rollout 3' },
    { seqKey: 'delayedPenalty', label: 'Delayed Penalty Text:', textKey: 'delayedPenalty_text', defaultText: 'DELAYED PENALTY', durationKeys: ['delayedPenalty_duration'], displayName: 'the Delayed Penalty rollout', hint: 'Used by the Away / Home DELAYED PEN buttons. {TEAM} is replaced with the penalized team name.' },
    { seqKey: 'fourOnFour', label: '4 on 4 Text:', textKey: 'fourOnFour_text', defaultText: '4 ON 4', durationKeys: ['fourOnFour_duration'], displayName: 'the 4 on 4 rollout', hint: '{TIME} = shortest penalty time remaining (live), e.g. "4 ON 4 {TIME}".' },
    { seqKey: 'timeout', label: 'Timeout Text:', textKey: 'timeout_text', defaultText: 'TIMEOUT {TEAM}', durationKeys: ['timeout_duration'], displayName: 'the Timeout rollout', hint: '{TEAM} is replaced with the team that called the timeout. Graphics come from that team\'s Power Play panel.' },
    { seqKey: 'ppPanel', label: 'Power Play Text:', textKey: 'ppPanel_text', defaultText: '{TEAM} PP {TIME}', durationKeys: [], displayName: 'the Power Play panel', hint: 'Placeholders: {TEAM} = team on the power play, {TIME} = PP time remaining (live), {SITUATION} = e.g. 5 VS 4. The PP panel stays up for the whole power play.' },
    { seqKey: 'banner', label: 'Banner 1 Text:', textKey: 'banner_text', defaultText: 'FULL WIDTH BANNER', durationKeys: ['banner_duration'], displayName: 'Banner 1' },
    { seqKey: 'banner2', label: 'Banner 2 Text:', textKey: 'banner2_text', defaultText: 'BANNER 2', durationKeys: ['banner2_duration'], displayName: 'Banner 2' },
    { seqKey: 'banner3', label: 'Banner 3 Text:', textKey: 'banner3_text', defaultText: 'BANNER 3', durationKeys: ['banner3_duration'], displayName: 'Banner 3' },
  ];

  const getTextSeq = (f: SeqFieldDef): RolloutSeqItem[] => {
    const mainText = getGVar(f.textKey, f.defaultText);
    const raw = getGVar(`${f.seqKey}_seq`, null);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((it: any, i: number) => ({
        id: it?.id || `s${i}`,
        text: i === 0 ? mainText : String(it?.text ?? ''),
        dur: String(it?.dur ?? '3'),
        anim: String(it?.anim ?? ''),
        animDur: String(it?.animDur ?? ''),
      }));
    }
    return [{ id: 's0', text: mainText, dur: '3', anim: '', animDur: '' }];
  };

  const saveTextSeq = (f: SeqFieldDef, items: RolloutSeqItem[], immediate = true) => {
    updateGraphicVars({ [`${f.seqKey}_seq`]: items, [f.textKey]: items[0]?.text ?? '' }, immediate);
  };

  const renderSeqTextField = (f: SeqFieldDef) => {
    const items = getTextSeq(f);
    const hasStoredSeq = Array.isArray(getGVar(`${f.seqKey}_seq`, null));
    const isOpen = openSeqEditor === f.seqKey;
    const loopVal = getGVar(`${f.seqKey}_seq_loop`, true);
    const isLoop = loopVal === true || loopVal === 'true';
    const total = items.reduce((sum, it) => sum + (parseFloat(it.dur) || 0), 0);

    const patchItem = (idx: number, patch: Partial<RolloutSeqItem>, immediate = true) =>
      saveTextSeq(f, items.map((it, i) => (i === idx ? { ...it, ...patch } : it)), immediate);
    const moveItem = (idx: number, dir: -1 | 1) => {
      const to = idx + dir;
      if (to < 0 || to >= items.length) return;
      const next = [...items];
      [next[idx], next[to]] = [next[to], next[idx]];
      saveTextSeq(f, next);
    };
    const removeItem = (idx: number) => {
      if (items.length <= 1) return;
      saveTextSeq(f, items.filter((_, i) => i !== idx));
    };
    const addItem = () =>
      saveTextSeq(f, [...items, { id: newSeqId(), text: '', dur: '3', anim: '', animDur: '' }]);
    const matchDuration = () => {
      const secs = String(Math.max(1, Math.ceil(total)));
      updateGraphicVars(Object.fromEntries(f.durationKeys.map(k => [k, secs])), true);
    };

    const smallInput: React.CSSProperties = { width: '52px', flex: 'none', textAlign: 'center', padding: '6px 4px' };
    const iconBtn: React.CSSProperties = {
      flex: 'none', width: '28px', height: '30px', padding: 0, cursor: 'pointer', borderRadius: '4px',
      background: themeVars.btnSecondaryBg, color: themeVars.btnSecondaryText, border: `1px solid ${themeVars.btnSecondaryBorder}`,
    };

    return (
      <div key={`seq_text_field_${f.seqKey}`} style={{ marginBottom: '10px' }}>
        <div className="row" style={{ marginBottom: isOpen ? '6px' : undefined }}>
          <label>{f.label}</label>
          <input
            type="text"
            value={items[0].text}
            placeholder={f.seqKey === 'goal' ? 'e.g. GOAL {TEAM}' : f.seqKey === 'ppPanel' ? 'e.g. {TEAM} PP {TIME}' : undefined}
            onChange={(e) => {
              if (hasStoredSeq) patchItem(0, { text: e.target.value });
              else updateGraphicVar(f.textKey, e.target.value, true);
            }}
          />
          <button
            type="button"
            title="Text sequence: multiple texts with their own duration and effect"
            onClick={() => setOpenSeqEditor(isOpen ? null : f.seqKey)}
            style={{ ...iconBtn, width: 'auto', padding: '0 8px', whiteSpace: 'nowrap', fontWeight: 'bold', fontSize: '11px',
              background: items.length > 1 ? '#007bff' : iconBtn.background, color: items.length > 1 ? '#fff' : iconBtn.color }}
          >
            {items.length > 1 ? `${items.length} ` : ''}{isOpen ? '▴' : '▾'}
          </button>
        </div>

        {isOpen && (
          <div style={{ border: `1px solid ${themeVars.borderCol}`, borderRadius: '6px', padding: '10px', background: themeVars.bgInput }}>
            <div style={{ fontSize: '11px', color: themeVars.textMuted, marginBottom: '8px' }}>
              Texts play in order while {f.displayName} is on screen. Effect "Component default" uses the text animation set in the Component Editor.
              {f.hint ? <><br />{f.hint}</> : null}
            </div>

            <div style={{ display: 'flex', gap: '6px', fontSize: '10px', fontWeight: 'bold', color: themeVars.textMuted, padding: '0 0 4px 26px', textTransform: 'uppercase' }}>
              <span style={{ flex: 1 }}>Text</span>
              <span style={{ width: '52px', textAlign: 'center' }}>Show (s)</span>
              <span style={{ width: '130px' }}>Effect</span>
              <span style={{ width: '52px', textAlign: 'center' }}>Speed (s)</span>
              <span style={{ width: '94px' }} />
            </div>

            {items.map((it, idx) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <span style={{ width: '20px', flex: 'none', fontSize: '11px', fontWeight: 'bold', color: themeVars.textMuted, textAlign: 'right' }}>{idx + 1}</span>
                <input
                  type="text"
                  value={it.text}
                  placeholder={`Text ${idx + 1}`}
                  onChange={(e) => patchItem(idx, { text: e.target.value }, idx === 0)}
                  style={{ flex: 1, minWidth: 0, padding: '6px' }}
                />
                <input
                  type="number" min="0.5" step="0.5"
                  value={it.dur}
                  title="How long this text stays up before the next one"
                  onChange={(e) => patchItem(idx, { dur: e.target.value })}
                  style={smallInput}
                />
                <select
                  value={it.anim}
                  onChange={(e) => patchItem(idx, { anim: e.target.value })}
                  style={{ ...selectStyle, width: '130px', flex: 'none', padding: '6px 4px' }}
                >
                  <option value="" style={selectStyle}>Component default</option>
                  {TEXT_ANIM_OPTIONS.map(([v, label]) => (
                    <option key={v} value={v} style={selectStyle}>{label}</option>
                  ))}
                </select>
                <input
                  type="number" min="0.1" step="0.1"
                  value={it.animDur}
                  placeholder="def"
                  title="Animation speed in seconds (blank = component default)"
                  onChange={(e) => patchItem(idx, { animDur: e.target.value })}
                  style={smallInput}
                />
                <button type="button" title="Move up" onClick={() => moveItem(idx, -1)} disabled={idx === 0} style={{ ...iconBtn, opacity: idx === 0 ? 0.4 : 1 }}>↑</button>
                <button type="button" title="Move down" onClick={() => moveItem(idx, 1)} disabled={idx === items.length - 1} style={{ ...iconBtn, opacity: idx === items.length - 1 ? 0.4 : 1 }}>↓</button>
                <button type="button" title="Remove" onClick={() => removeItem(idx)} disabled={items.length <= 1} style={{ ...iconBtn, opacity: items.length <= 1 ? 0.4 : 1, color: '#ff6b6b' }}>✕</button>
              </div>
            ))}

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '8px' }}>
              <button type="button" className="btn bg-blue" style={{ flex: 'none', padding: '8px 12px' }} onClick={addItem}>+ ADD TEXT</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', width: 'auto', fontSize: '12px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isLoop}
                  onChange={(e) => updateGraphicVar(`${f.seqKey}_seq_loop`, e.target.checked, true)}
                />
                Loop sequence
              </label>
              <span style={{ fontSize: '12px', color: themeVars.textMuted, marginLeft: 'auto' }}>
                Total: {Math.round(total * 10) / 10}s{f.durationKeys.length > 0 ? ` · Shows for ${getGVar(f.durationKeys[0], '5')}s` : ''}
              </span>
              {f.durationKeys.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 'none', padding: '8px 12px' }}
                  title="Set the auto-hide duration so the whole sequence plays once"
                  onClick={matchDuration}
                >
                  MATCH DURATION
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderHotkeyRow = (label: string, actionKey: string) => {
    const currentVal = hotkeysConfig[actionKey] || '';
    const isListening = listeningKeyFor === actionKey;

    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontSize: '13px', color: themeVars.textColor, fontWeight: 'bold' }}>{label}</span>
        <div style={{ display: 'flex', gap: '6px', width: '220px' }}>
          <button 
            onClick={() => setListeningKeyFor(isListening ? null : actionKey)}
            style={{ 
              flex: 1, 
              background: isListening ? '#ff9800' : themeVars.btnSecondaryBg, 
              color: isListening ? '#000' : themeVars.btnSecondaryText, 
              border: `1px solid ${themeVars.btnSecondaryBorder}`, 
              borderRadius: '6px', 
              padding: '6px 12px', 
              fontSize: '12px', 
              fontWeight: 'bold', 
              cursor: 'pointer',
              textTransform: 'uppercase'
            }}
          >
            {isListening ? 'PRESS KEY...' : currentVal ? currentVal : 'UNBOUND'}
          </button>
          <button 
            onClick={() => setHotkey(actionKey, '')}
            style={{ 
              background: themeVars.btnSecondaryBg, 
              color: themeVars.btnSecondaryText, 
              border: `1px solid ${themeVars.btnSecondaryBorder}`, 
              borderRadius: '6px', 
              padding: '6px 10px', 
              fontSize: '12px', 
              fontWeight: 'bold', 
              cursor: 'pointer' 
            }}
          >
            ✖
          </button>
        </div>
      </div>
    );
  };

  return (
    <div id="control-panel" style={{ backgroundColor: themeVars.bgPage, color: themeVars.textColor, minHeight: '100vh' }}>
      
      <style>{`
        body, html { background-color: ${themeVars.bgPage} !important; color: ${themeVars.textColor} !important; }
        #control-panel .box { background-color: ${themeVars.bgBox} !important; border-color: ${themeVars.borderCol} !important; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
        #control-panel .box h3, #control-panel .box label { color: ${themeVars.headerTextCol} !important; }
        #control-panel input, #control-panel select { background-color: ${themeVars.bgInput} !important; color: ${themeVars.textColor} !important; border-color: ${themeVars.borderCol} !important; }
        #control-panel button.btn.btn-custom-bg { background: var(--btn-bg) !important; color: var(--btn-fg, #fff) !important; border: 1px solid rgba(0,0,0,0.25) !important; text-shadow: 0 1px 2px rgba(0,0,0,0.35); }
        #control-panel .team-row { gap: 6px !important; }
        #control-panel .team-row > input { width: calc(72px + 2ch) !important; max-width: calc(72px + 2ch) !important; min-width: 0; }
        #control-panel .team-row .btn.tr-narrow { flex: 0.75 1 0 !important; }
        #control-panel .team-row .btn.tr-wide { flex: 1.45 1 0 !important; }
        #control-panel .team-row .btn { flex: 1 1 0 !important; min-width: 0 !important; padding: 9px 4px !important; font-size: 10px !important; white-space: nowrap !important; overflow: hidden; text-overflow: ellipsis; }
        #control-panel .ops-cols > .box { min-width: 0; margin: 0; container-type: inline-size; }
        #control-panel .ops-col-handle:hover > div { background: #007bff !important; }
        /* Button text scales with its column (cqi = 1% of the column width), within readable limits */
        #control-panel .ops-cols .btn { font-size: clamp(9px, 2.7cqi, 13px) !important; }
        #control-panel .ops-cols .team-row .btn { font-size: clamp(9px, 2.5cqi, 12px) !important; min-width: 50px !important; }
        #control-panel .ops-cols .pen-row .btn, #control-panel .ops-cols .pen-team-btn { font-size: clamp(10px, 2.9cqi, 13px) !important; }
        #control-panel .team-row { flex-wrap: wrap; }
        @media (max-width: 1140px) {
          #control-panel .ops-cols { grid-template-columns: minmax(0, 1fr) !important; row-gap: 15px; }
          #control-panel .ops-col-handle { display: none !important; }
        }
        #control-panel #inp-pen-plyr { background: transparent !important; background-color: transparent !important; color: #1a1a1a !important; border: none !important; box-shadow: none !important; }
        #control-panel #inp-pen-plyr::placeholder { color: rgba(58,42,0,0.55) !important; }
        #control-panel .tab-headers { background-color: ${themeVars.tabHeaderBg} !important; border-bottom-color: ${themeVars.borderCol} !important; }
        #control-panel .tab-btn { color: ${themeVars.tabInactiveText} !important; font-weight: bold; border: none; padding: 12px 20px; cursor: pointer; transition: background 0.15s ease; }
        #control-panel .tab-btn:hover:not(.active) { background-color: ${isLight ? '#c9cfd8' : '#3a404a'} !important; color: ${isLight ? '#1c2431' : '#ffffff'} !important; }
        #control-panel .tab-btn.active { background-color: ${themeVars.tabActiveBg} !important; color: ${themeVars.tabActiveText} !important; border-bottom: 3px solid #FF5100; }
        
        #control-panel .btn {
          border-radius: 8px !important;
          font-weight: 800 !important;
          letter-spacing: 0.5px !important;
          transition: all 0.1s ease !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 6px rgba(0,0,0,0.2) !important;
          border-bottom: 2px solid rgba(0,0,0,0.3) !important;
          cursor: pointer !important;
        }
        #control-panel .btn:active {
          transform: translateY(2px) !important;
          box-shadow: inset 0 1px 3px rgba(0,0,0,0.4) !important;
        }
        #control-panel .btn-green { background: linear-gradient(180deg, #12c98c 0%, #0d9668 100%) !important; color: #ffffff !important; }
        #control-panel .btn-blue { background: linear-gradient(180deg, #2860bd 0%, #173e80 100%) !important; color: #ffffff !important; }
        #control-panel .btn-orange { background: linear-gradient(180deg, #ff6a21 0%, #d43d00 100%) !important; color: #ffffff !important; }
        #control-panel .btn-red { background: linear-gradient(180deg, #f85b5b 0%, #c92a2a 100%) !important; color: #ffffff !important; }
        #control-panel .btn-purple { background: linear-gradient(180deg, #a073f8 0%, #6d38d9 100%) !important; color: #ffffff !important; }
        #control-panel .btn-secondary-theme { 
          background: linear-gradient(180deg, ${isLight ? '#FFFFFF' : '#636a75'} 0%, ${isLight ? '#E1E5E9' : '#454a52'} 100%) !important; 
          color: ${themeVars.btnSecondaryText} !important; 
          border: 1px solid ${themeVars.btnSecondaryBorder} !important; 
        }
      `}</style>

      {/* BRANDING HEADER BAR */}
      <header style={{
        backgroundColor: themeVars.bgHeader,
        borderBottom: `3px solid ${themeVars.borderCol}`,
        padding: '10px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '10px', 
            background: '#FFFFFF', 
            border: '2px solid #104085', 
            borderRadius: '24px', 
            padding: '5px 18px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.1)'
          }}>
            <img 
              src="/brand/h2h-logo-icon.png" 
              alt="H2H Emblem" 
              style={{ height: '28px', width: 'auto', objectFit: 'contain' }}
            />
            <span style={{ fontWeight: '900', fontSize: '16px', color: '#104085', letterSpacing: '0.5px' }}>
              H2H <span style={{ color: '#F36C21' }}>OVERLAY</span>
            </span>
          </div>

          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            backgroundColor: 'rgba(16, 185, 129, 0.15)', 
            border: '1px solid rgba(16, 185, 129, 0.4)',
            borderRadius: '20px',
            padding: '4px 12px',
            color: '#10b981',
            fontSize: '11px',
            fontWeight: 'bold'
          }}>
            <span>●</span> Live Sync: Active
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button 
            onClick={copyOverlayLink}
            style={{
              backgroundColor: '#104085',
              color: '#ffffff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '6px',
              fontWeight: 'bold',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            {copiedLink ? '✓ Copied!' : '■ Copy Overlay Link'}
          </button>

          <a 
            href={`/view/${id}`} 
            target="_blank" 
            rel="noreferrer"
            style={{
              backgroundColor: '#F36C21',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '6px',
              fontWeight: 'bold',
              fontSize: '12px',
              textDecoration: 'none'
            }}
          >
            ● Open OBS View
          </a>
        </div>
      </header>

      {/* TAB NAVIGATION HEADERS */}
      <div className="tab-headers" style={{ display: 'flex', borderBottom: '1px solid ' + themeVars.borderCol }}>
        <button className={`tab-btn ${activeTab === 'tab-ops' ? 'active' : ''}`} onClick={() => setActiveTab('tab-ops')}>
          GAME OPERATIONS
        </button>
        <button className={`tab-btn ${activeTab === 'tab-graphics' ? 'active' : ''}`} onClick={() => setActiveTab('tab-graphics')}>
          GRAPHICS SETTINGS
        </button>
        <button className={`tab-btn ${activeTab === 'tab-hotkeys' ? 'active' : ''}`} onClick={() => setActiveTab('tab-hotkeys')}>
          HOTKEYS
        </button>
        <button className={`tab-btn ${activeTab === 'tab-system' ? 'active' : ''}`} onClick={() => setActiveTab('tab-system')}>
          SYSTEM & PROFILES
        </button>
      </div>

      {/* GAME OPS TAB */}
      <div id="tab-ops" className={`tab-content ${activeTab === 'tab-ops' ? 'active' : ''}`}>
        
        {/* LIVE BROADCAST DISPLAY PREVIEW */}
        <div className="box" style={{ 
          background: themeVars.bgBox, 
          border: `1px solid ${themeVars.borderCol}`, 
          padding: '12px 16px', 
          borderRadius: '8px', 
          marginBottom: '20px',
          overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', color: themeVars.textColor, fontWeight: 'bold', letterSpacing: '0.5px' }}>
              LIVE BROADCAST DISPLAY PREVIEW
            </span>
            <span style={{ fontSize: '11px', color: '#FF5100', fontWeight: 'bold' }}>
              PERIOD: {state.period || '1ST'}
            </span>
          </div>

          <div style={{ 
            background: isLight ? '#D5DCE2' : '#141820', 
            borderRadius: '8px', 
            padding: '15px 24px', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            gap: '24px',
            border: `1px solid ${isLight ? '#BCC5CE' : '#0A0D12'}`,
            boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.3)',
            overflow: 'hidden'
          }}>
            
            {/* FIX: Absolute Penalties positioned OUTSIDE the flex container on the far left */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px', position: 'relative' }}>
              {(state.penalties || []).filter((p: Penalty) => p.team === 'away').length > 0 && (
                <div style={{ position: 'absolute', right: '100%', marginRight: '20px', top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: '4px', width: '100px' }}>
                  {(state.penalties || []).filter((p: Penalty) => p.team === 'away').map((p: Penalty) => (
                    <div key={p.id} style={{ background: state.away_color || '#00468b', color: '#ffffff', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '900', display: 'flex', justifyContent: 'space-between', alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ width: '60px', height: '60px', position: 'relative', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {getGVar('awayTeam_media_url') && (
                  <img 
                    src={getGVar('awayTeam_media_url')} 
                    alt="" 
                    style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: 1, transform: 'translate(0%, 0%) scale(1)' }}
                  />
                )}
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '15px', fontWeight: '900', color: themeVars.textColor, lineHeight: '1.2' }}>
                  {state.away_name || 'AWAY'}
                </div>
                <div style={{ fontSize: '10px', fontWeight: 'bold', color: themeVars.textMuted, marginTop: '2px' }}>
                  SOG:{state.away_sog}
                </div>
              </div>

              <div style={{ width: '8px', height: '28px', backgroundColor: state.away_color || '#00468b', borderRadius: '10px', flex: 'none' }} />

              <div style={{ fontSize: '32px', fontWeight: '900', color: themeVars.textColor, minWidth: '24px', textAlign: 'center' }}>
                {state.away_score}
              </div>
            </div>

            {/* CENTER CLOCK & STATUS */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ 
                fontSize: '28px', 
                fontWeight: '900', 
                fontFamily: 'monospace', 
                background: '#161922',
                color: '#FFFFFF',
                padding: '4px 18px',
                borderRadius: '6px',
                border: '1px solid #2B3240',
                letterSpacing: '1px'
              }}>
                {formatTime(state.clock_seconds)}
              </div>
              <span style={{ fontSize: '9px', fontWeight: 'bold', marginTop: '3px', color: state.clock_running ? '#10b981' : '#ef4444', letterSpacing: '0.5px' }}>
                {state.clock_running ? '● RUNNING' : '❚❚ PAUSED'}
              </span>
            </div>

            {/* FIX: Absolute Penalties positioned OUTSIDE the flex container on the far right */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px', position: 'relative' }}>
              <div style={{ fontSize: '32px', fontWeight: '900', color: themeVars.textColor, minWidth: '24px', textAlign: 'center' }}>
                {state.home_score}
              </div>

              <div style={{ width: '8px', height: '28px', backgroundColor: state.home_color || '#222222', borderRadius: '10px', flex: 'none' }} />

              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: '15px', fontWeight: '900', color: themeVars.textColor, lineHeight: '1.2' }}>
                  {state.home_name || 'HOME'}
                </div>
                <div style={{ fontSize: '10px', fontWeight: 'bold', color: themeVars.textMuted, marginTop: '2px' }}>
                  SOG:{state.home_sog}
                </div>
              </div>

              <div style={{ width: '60px', height: '60px', position: 'relative', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {getGVar('homeTeam_media_url') && (
                  <img 
                    src={getGVar('homeTeam_media_url')} 
                    alt="" 
                    style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: 1, transform: 'translate(0%, 0%) scale(1)' }}
                  />
                )}
              </div>

              {(state.penalties || []).filter((p: Penalty) => p.team === 'home').length > 0 && (
                <div style={{ position: 'absolute', left: '100%', marginLeft: '20px', top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: '4px', width: '100px' }}>
                  {(state.penalties || []).filter((p: Penalty) => p.team === 'home').map((p: Penalty) => (
                    <div key={p.id} style={{ background: state.home_color || '#222222', color: '#ffffff', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: '900', display: 'flex', justifyContent: 'space-between', alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <span>#{p.plyr}</span><span>{formatTime(p.time)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* ON AIR: what the overlay is showing besides the bug */}
          {(() => {
            const mode = state.right_panel_mode || 'none';
            const pens = state.penalties || [];
            const awayN = pens.filter((p: Penalty) => p.team === 'away').length;
            const homeN = pens.filter((p: Penalty) => p.team === 'home').length;
            const teamOf = (m: string) => m.startsWith('away') ? 'away' : m.startsWith('home') ? 'home' : '';
            const teamName = (t: string) => t === 'away' ? (state.away_name || 'AWAY') : t === 'home' ? (state.home_name || 'HOME') : '';
            const teamColor = (t: string) => t === 'away' ? (state.away_color || '#00468b') : t === 'home' ? (state.home_color || '#222222') : '#555';
            const fill = (txt: string, t: string) => String(txt || '').replace(/{TEAM}/g, teamName(t)).replace(/\s{2,}/g, ' ').trim();

            let side: { label: string; text: string; color: string; hideable: boolean } | null = null;
            const t = teamOf(mode);
            if (mode === 'awayTimeout' || mode === 'homeTimeout') {
              side = { label: 'TIMEOUT', text: fill(getGVar('timeout_text', 'TIMEOUT {TEAM}'), t), color: teamColor(t), hideable: true };
            } else if (mode === 'awayDelayed' || mode === 'homeDelayed' || mode === 'delayedPenalty') {
              side = { label: 'DELAYED PENALTY', text: fill(getGVar('delayedPenalty_text', 'DELAYED PENALTY'), t) + (t ? ` · ${teamName(t)}` : ''), color: t ? teamColor(t) : '#c0392b', hideable: true };
            } else if (mode === 'awayGoal' || mode === 'homeGoal') {
              side = { label: 'GOAL', text: fill(getGVar('goal_text_format', 'GOAL {TEAM}'), t), color: teamColor(t), hideable: true };
            } else if (mode === 'fourOnFour') {
              const sp = pens.length > 0 ? Math.min(...pens.map((p: Penalty) => p.time)) : 0;
              side = { label: '4 ON 4', text: String(getGVar('fourOnFour_text', '4 ON 4')).replace(/{TIME}/g, sp > 0 ? formatTime(sp) : '').trim(), color: '#5a6270', hideable: true };
            } else if (mode.startsWith('rollout')) {
              side = { label: `ROLLOUT ${mode.slice(7)}`, text: state.right_panel_text || '', color: '#1e5bb8', hideable: true };
            } else if (mode === 'none' && awayN !== homeN) {
              const ppT = homeN > awayN ? 'away' : 'home';
              const shorthanded = pens.filter((p: Penalty) => p.team !== ppT);
              const lowest = Math.min(...shorthanded.map((p: Penalty) => p.time));
              side = { label: 'POWER PLAY', text: `${teamName(ppT)} · ${5 - awayN} VS ${5 - homeN} · ${formatTime(lowest)}`, color: teamColor(ppT), hideable: false };
            }

            const remaining = side && rolloutEnds && rolloutEnds.mode === mode
              ? Math.max(0, Math.ceil((rolloutEnds.at - nowTick) / 1000)) : null;
            const bannerKey = getGVar('active_banner', 'banner');
            const bannerN = bannerKey === 'banner' ? 1 : parseInt(bannerKey.replace('banner', '')) || 1;

            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px', minHeight: '30px' }}>
                <span style={{ fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.5px', color: themeVars.textMuted }}>ON AIR:</span>
                {!side && !state.banner_active && (
                  <span style={{ fontSize: '11px', color: themeVars.textMuted }}>Scoreboard only</span>
                )}
                {side && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: side.color, color: '#fff', borderRadius: '6px', padding: '4px 6px 4px 10px', fontSize: '12px', fontWeight: 'bold', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>
                    <span style={{ fontSize: '9px', background: 'rgba(0,0,0,0.35)', padding: '2px 6px', borderRadius: '3px', letterSpacing: '0.5px' }}>{side.label}</span>
                    <span style={{ whiteSpace: 'nowrap' }}>{side.text}</span>
                    {remaining !== null && (
                      <span style={{ fontFamily: 'monospace', fontSize: '13px', background: 'rgba(0,0,0,0.35)', padding: '1px 6px', borderRadius: '3px' }}>{formatTime(remaining)}</span>
                    )}
                    {side.hideable && (
                      <button onClick={hideSideRollout} title="Hide this rollout" style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none', borderRadius: '4px', padding: '2px 8px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}>HIDE</button>
                    )}
                  </div>
                )}
                {state.banner_active && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#6f42c1', color: '#fff', borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontWeight: 'bold' }}>
                    <span style={{ fontSize: '9px', background: 'rgba(0,0,0,0.35)', padding: '2px 6px', borderRadius: '3px' }}>BANNER {bannerN}</span>
                    <span style={{ whiteSpace: 'nowrap' }}>{state.banner_text}</span>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <div className="panel-grid">

          {/* Clock | Team | Penalties: three columns, drag the dividers to resize */}
          <div
            ref={opsColsRef}
            className="ops-cols"
            style={{
              flex: '1 1 100%', display: 'grid', alignItems: 'stretch', minWidth: 0,
              gridTemplateColumns: `minmax(${OPS_MIN_COL_PX}px, ${opsCols[0]}fr) 14px minmax(${OPS_MIN_COL_PX}px, ${opsCols[1]}fr) 14px minmax(${OPS_MIN_COL_PX}px, ${opsCols[2]}fr)`,
            }}
          >
          
          <div className="box">
            <button 
              className="btn btn-green"
              style={{ width: '100%', marginBottom: '12px', fontWeight: 'bold', borderRadius: '6px' }}
              onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
            >
              {autoSaveEnabled ? 'AUTO-SAVE ENABLED' : 'START GAME (ENABLE AUTO-SAVE)'}
            </button>

            <div className="row" style={{ marginBottom: '15px' }}>
              <label style={{ fontSize: '12px' }}>Auto-Save (Sec):</label>
              <input 
                type="number" 
                value={autoSaveIntervalSec} 
                onChange={(e) => setAutoSaveIntervalSec(parseInt(e.target.value) || 15)}
                style={{ width: '60px' }}
              />
            </div>

            <h3>CLOCK & PHASE</h3>
            <div className="row">
              <button className={`btn ${state.clock_running ? 'btn-red' : 'btn-blue'}`} style={{ borderRadius: '6px' }} onClick={toggleClock}>{state.clock_running ? 'STOP CLOCK' : 'START CLOCK'}</button>
              <button className="btn btn-orange" style={{ borderRadius: '6px' }} onClick={resetClock}>RESET CLOCK</button>
            </div>
            <div className="row"><button className="btn btn-secondary-theme" onClick={() => adjClock(60)}>+1 MIN</button><button className="btn btn-secondary-theme" onClick={() => adjClock(-60)}>-1 MIN</button></div>
            <div className="row"><button className="btn btn-secondary-theme" onClick={() => adjClock(1)}>+1 SEC</button><button className="btn btn-secondary-theme" onClick={() => adjClock(-1)}>-1 SEC</button></div>
            
            <div className="row" style={{ marginTop: '12px' }}>
              <label>Period Length (Min):</label>
              <input 
                type="number" 
                value={periodLengthMin} 
                onChange={(e) => setPeriodLengthMin(parseInt(e.target.value) || 20)}
                style={{ width: '60px' }}
              />
            </div>

            <div className="row" style={{ marginTop: '10px' }}>
              <label>Timeout Length:</label>
              {(() => {
                const cur = String(getGVar('timeout_duration', '30') || '30');
                const opts = ['30', '45', '60', '75', '90', '120'];
                if (!opts.includes(cur)) opts.push(cur);
                return (
                  <select
                    value={cur}
                    onChange={(e) => updateGraphicVar('timeout_duration', e.target.value, true)}
                    title="How long the timeout rollout stays up"
                    style={{ ...selectStyle, flex: 1, minWidth: 0 }}
                  >
                    {opts.sort((x, y) => parseInt(x) - parseInt(y)).map(v => {
                      const n = parseInt(v) || 0;
                      return <option key={`to_${v}`} value={v} style={selectStyle}>{n >= 60 ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : `0:${String(n).padStart(2, '0')}`} ({n} sec)</option>;
                    })}
                  </select>
                );
              })()}
            </div>

            <div className="row" style={{ marginTop: '10px' }}>
              <label>Game Phase:</label>
              <select value={state.period} onChange={(e) => handlePeriodChange(e.target.value)} style={selectStyle}>
                  <option value="WARM UP" style={selectStyle}>Warm Up</option>
                  <option value="1ST" style={selectStyle}>1st Period</option>
                  <option value="2ND" style={selectStyle}>2nd Period</option>
                  <option value="3RD" style={selectStyle}>3rd Period</option>
                  <option value="OT1" style={selectStyle}>OT1</option>
                  <option value="SHOOT OUT" style={selectStyle}>Shoot Out</option>
                  <option value="FINAL" style={selectStyle}>FINAL</option>
              </select>
            </div>
          </div>

          {renderColHandle(0)}

          <div className="box" style={{ 
            flex: '2 1 450px',
            padding: '16px', 
            borderRadius: '8px', 
            border: `1px solid ${themeVars.borderCol}`,
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{
              position: 'absolute',
              top: '55%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              opacity: isLight ? 0.08 : 0.14,
              pointerEvents: 'none',
              textAlign: 'center',
              userSelect: 'none',
              zIndex: 0
            }}>
              <img 
                src="/brand/h2h-logo-full.png" 
                alt="H2H Overlay Watermark" 
                style={{ width: '220px', height: 'auto', objectFit: 'contain', margin: '0 auto' }}
              />
            </div>

            <h3 style={{ fontSize: '14px', fontWeight: 'bold', borderBottom: `1px solid ${themeVars.borderCol}`, paddingBottom: '6px', marginBottom: '16px', zIndex: 1, position: 'relative' }}>TEAM CONTROLS</h3>
            <div className="row team-row" style={{ background: themeVars.bgInput, padding: '10px', borderRadius: '6px', position: 'relative', zIndex: 1 }}>
              <input type="text" value={state.away_name} onChange={(e) => updateField('away_name', e.target.value)} style={{ maxWidth: '80px', flex: 'none', fontWeight: 'bold' }} />
              <button className="btn btn-custom-bg" style={teamBoxBg('away')} onClick={() => adjStat('away', 'score', 1)}>+ GOAL</button>
              <button className="btn btn-secondary-theme tr-narrow" onClick={() => adjStat('away', 'score', -1)}>-1 G</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('away', 'sog', 1)}>+ SOG</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('away', 'sog', -1)}>-1 SOG</button>
              <button
                className="btn btn-secondary-theme tr-wide"
                style={{ whiteSpace: 'nowrap', outline: state.right_panel_mode === 'awayTimeout' ? '3px solid #F36C21' : 'none', outlineOffset: '-3px' }}
                title="Show the away timeout rollout (click again to hide)"
                onClick={() => triggerTeamRollout('timeout', 'away')}
              >
                TIMEOUT{state.right_panel_mode === 'awayTimeout' ? ' ●' : ''}
              </button>
            </div>
            <div className="row team-row" style={{ background: themeVars.bgInput, padding: '10px', borderRadius: '6px', position: 'relative', zIndex: 1 }}>
              <input type="text" value={state.home_name} onChange={(e) => updateField('home_name', e.target.value)} style={{ maxWidth: '80px', flex: 'none', fontWeight: 'bold' }} />
              <button className="btn btn-custom-bg" style={teamBoxBg('home')} onClick={() => adjStat('home', 'score', 1)}>+ GOAL</button>
              <button className="btn btn-secondary-theme tr-narrow" onClick={() => adjStat('home', 'score', -1)}>-1 G</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('home', 'sog', 1)}>+ SOG</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('home', 'sog', -1)}>-1 SOG</button>
              <button
                className="btn btn-secondary-theme tr-wide"
                style={{ whiteSpace: 'nowrap', outline: state.right_panel_mode === 'homeTimeout' ? '3px solid #F36C21' : 'none', outlineOffset: '-3px' }}
                title="Show the home timeout rollout (click again to hide)"
                onClick={() => triggerTeamRollout('timeout', 'home')}
              >
                TIMEOUT{state.right_panel_mode === 'homeTimeout' ? ' ●' : ''}
              </button>
            </div>
            <div className="row" style={{ position: 'relative', zIndex: 1 }}>
              <button className="btn btn-secondary-theme" onClick={() => resetStats('away')}>RESET AWAY STATS</button>
              <button className="btn btn-secondary-theme" onClick={() => resetStats('home')}>RESET HOME STATS</button>
              <button className="btn btn-secondary-theme" onClick={() => resetStats('all')}>RESET ALL STATS</button>
            </div>
          </div>

          {renderColHandle(1)}

          <div className="box">
            <h3>PENALTIES & ROLLOUTS</h3>
            {/* 1. Team  2. Player #  3. ADD  (penalty length sits after the button so the
                 player number can't be typed into the time by mistake) */}
            <div style={{ background: themeVars.bgInput, border: `1px solid ${themeVars.borderCol}`, borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                {(['away', 'home'] as const).map(t => {
                  const on = penTeam === t;
                  return (
                    <button
                      key={`pen_team_${t}`}
                      type="button"
                      className="pen-team-btn"
                      onClick={() => setPenTeam(t)}
                      title={on ? 'Selected team for the penalty' : 'Select this team'}
                      style={{
                        ...teamBoxBg(t),
                        flex: '1 1 0', minWidth: 0, padding: '8px 6px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold',
                        background: 'var(--btn-bg)', color: 'var(--btn-fg)',
                        opacity: on ? 1 : 0.4, filter: on ? 'none' : 'saturate(0.5)',
                        // LED blue border on the active team
                        border: on ? '3px solid #00B4FF' : '3px solid transparent',
                        boxShadow: 'none',
                        textShadow: '0 1px 2px rgba(0,0,0,0.35)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {on ? '✓ ' : ''}{(t === 'away' ? state.away_name : state.home_name) || t.toUpperCase()}
                    </button>
                  );
                })}
              </div>

              <div className="pen-row" style={{ display: 'flex', alignItems: 'stretch', gap: '6px', width: '100%', boxSizing: 'border-box', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', background: '#FFD54A', borderRadius: '6px', padding: '0 4px 0 8px', flex: '1.3 1 0', minWidth: '96px', boxSizing: 'border-box', border: '2px solid #E0A800' }}>
                  <span style={{ color: '#3a2a00', fontWeight: 900, fontSize: '18px' }}>#</span>
                  <input
                    type="text"
                    id="inp-pen-plyr"
                    inputMode="numeric"
                    placeholder="Player"
                    value={penPlyr}
                    onChange={(e) => setPenPlyr(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPenalty(); } }}
                    style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: '#1a1a1a', fontWeight: 900, fontSize: 'clamp(14px, 4.5cqi, 20px)', padding: '6px 6px', boxShadow: 'none' }}
                  />
                </div>
                <button className="btn btn-red" style={penRowBtn} onClick={addPenalty} title="Add penalty (or press Enter in the player # field)">
                  + ADD
                </button>
                <button
                  className="btn btn-orange"
                  style={{ ...penRowBtn, outline: state.right_panel_mode === `${penTeam}Delayed` ? '3px solid #fff' : 'none', outlineOffset: '-4px' }}
                  onClick={() => triggerTeamRollout('delayed', penTeam)}
                  title={`Delayed penalty rollout for ${(penTeam === 'away' ? state.away_name : state.home_name) || penTeam} (the selected team). Click again to hide.`}
                >
                  DELAYED
                </button>
                <button
                  className="btn btn-custom-bg"
                  style={{ ...penRowBtn, flex: '0.8 1 0', '--btn-bg': state.right_panel_mode === 'fourOnFour' ? '#F36C21' : '#5a6270', '--btn-fg': '#fff' } as React.CSSProperties}
                  onClick={triggerFourOnFour}
                  title="4 on 4 rollout. Click again to hide."
                >
                  4 V 4
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 'bold', color: themeVars.textMuted, flex: 'none' }}>LENGTH:</span>
                {(() => {
                  const curSecs = (parseInt(penMin) || 0) * 60 + Math.min(59, parseInt(penSec) || 0);
                  const opts: [number, string][] = [[90, '1:30'], [120, '2:00 Minor'], [180, '3:00'], [240, '4:00 Double Minor'], [300, '5:00 Major'], [600, '10:00 Misconduct']];
                  if (!opts.some(([v]) => v === curSecs)) opts.push([curSecs, `${Math.floor(curSecs / 60)}:${String(curSecs % 60).padStart(2, '0')}`]);
                  return (
                    <select
                      id="sel-pen-length"
                      tabIndex={-1}
                      value={String(curSecs)}
                      onChange={(e) => {
                        const v = parseInt(e.target.value) || 120;
                        setPenMin(String(Math.floor(v / 60)));
                        setPenSec(String(v % 60).padStart(2, '0'));
                      }}
                      style={{ ...selectStyle, flex: 1, minWidth: 0 }}
                    >
                      {opts.sort((x, y) => x[0] - y[0]).map(([v, label]) => (
                        <option key={`pl_${v}`} value={String(v)} style={selectStyle}>{label}</option>
                      ))}
                    </select>
                  );
                })()}
                {/* exact time, e.g. a penalty already partly served */}
                <input
                  type="number" id="inp-pen-min" tabIndex={-1} min="0" max="99"
                  value={penMin}
                  title="Minutes remaining"
                  onChange={(e) => setPenMin(e.target.value)}
                  style={{ width: '48px', flex: 'none', textAlign: 'center', padding: '6px 2px' }}
                />
                <span style={{ fontWeight: 'bold', flex: 'none' }}>:</span>
                <input
                  type="number" id="inp-pen-sec" tabIndex={-1} min="0" max="59"
                  value={penSec}
                  title="Seconds remaining"
                  onChange={(e) => setPenSec(e.target.value)}
                  onBlur={(e) => setPenSec(String(Math.min(59, Math.max(0, parseInt(e.target.value) || 0))).padStart(2, '0'))}
                  style={{ width: '48px', flex: 'none', textAlign: 'center', padding: '6px 2px' }}
                />
              </div>
            </div>
            <div className="row"><button className="btn btn-orange" style={{ borderRadius: '6px' }} onClick={() => updateField('penalties', [])}>CLEAR ALL PENALTIES</button></div>
            
            <div style={{ marginTop: '10px', maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {(state.penalties || []).map((p: Penalty) => {
                const currentMins = Math.floor(p.time / 60);
                const currentSecs = p.time % 60;

                return (
                  <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', background: themeVars.bgInput, color: themeVars.textColor, padding: '6px 10px', borderRadius: '4px', fontSize: '12px', alignItems: 'center', borderLeft: `3px solid ${p.team === 'away' ? '#007bff' : '#dc3545'}` }}>
                    <span><strong>{p.team.toUpperCase()}</strong> #{p.plyr}</span>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input 
                        type="number" 
                        min="0" 
                        max="99" 
                        value={currentMins}
                        onChange={(e) => {
                          const newM = Math.max(0, parseInt(e.target.value) || 0);
                          setExactPenaltyTime(p.id, newM, currentSecs);
                        }}
                        style={{ width: '42px', height: '26px', textAlign: 'center', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', padding: '2px' }}
                      />
                      <span style={{ fontWeight: 'bold' }}>:</span>
                      <input 
                        type="number" 
                        min="0" 
                        max="59" 
                        value={currentSecs < 10 ? `0${currentSecs}` : currentSecs}
                        onChange={(e) => {
                          const newS = Math.min(59, Math.max(0, parseInt(e.target.value) || 0));
                          setExactPenaltyTime(p.id, currentMins, newS);
                        }}
                        style={{ width: '42px', height: '26px', textAlign: 'center', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', padding: '2px' }}
                      />
                      <button onClick={() => removePenalty(p.id)} style={{ background: 'transparent', color: themeVars.textMuted, border: `1px solid ${themeVars.borderCol}`, borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', marginLeft: '6px' }}>✖</button>
                    </div>
                  </div>
                );
              })}
            </div>

            <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />
            
            <div className="row" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
              <input 
                type="checkbox" 
                id="chk-auto-goal"
                checked={getGVar('auto_goal_rollout', true)}
                onChange={(e) => updateGraphicVar('auto_goal_rollout', e.target.checked, true)}
              />
              <label htmlFor="chk-auto-goal" style={{ fontSize: '12px', cursor: 'pointer' }}>Auto Rollout on Goal (+1 G)</label>
            </div>

            <div className="row">
                <button className="btn btn-blue" style={{ borderRadius: '6px' }} onClick={() => triggerRollout(1)}>ROLLOUT 1</button>
                <button className="btn btn-blue" style={{ borderRadius: '6px' }} onClick={() => triggerRollout(2)}>ROLLOUT 2</button>
                <button className="btn btn-blue" style={{ borderRadius: '6px' }} onClick={() => triggerRollout(3)}>ROLLOUT 3</button>
            </div>
            <div className="row" style={{ marginTop: '5px' }}>
                {[1, 2, 3].map(n => {
                  const key = n === 1 ? 'banner' : `banner${n}`;
                  const isUp = !!state.banner_active && (getGVar('active_banner', 'banner') === key);
                  return (
                    <button
                      key={`banner_btn_${n}`}
                      className="btn btn-purple"
                      style={{ borderRadius: '6px', outline: isUp ? '3px solid #F36C21' : 'none', outlineOffset: '-3px' }}
                      title={isUp ? 'Showing now - click to hide' : `Show full width banner ${n}`}
                      onClick={() => triggerBanner(n)}
                    >
                      BANNER {n}{isUp ? ' ●' : ''}
                    </button>
                  );
                })}
            </div>
          </div>

          </div>
          {/* end three columns */}

          <div className="box" style={{ flex: '1 1 100%' }}>
            <h3>SHOOTOUT MODE (10 ROUNDS)</h3>
            <div className="row" style={{ marginBottom: '15px' }}>
              <button className="btn btn-blue" style={{ maxWidth: '250px', borderRadius: '6px' }} onClick={() => updateField('shootout_active', !state.shootout_active)}>
                {state.shootout_active ? 'HIDE SHOOTOUT GRAPHIC' : 'SHOW SHOOTOUT GRAPHIC'}
              </button>
              <button className="btn btn-orange" style={{ maxWidth: '250px', borderRadius: '6px' }} onClick={resetShootout}>RESET SHOOTOUT TRACKER</button>
            </div>
            
            <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '10px' }}>
              {(state.shootout_rounds || Array(10).fill({ away: 0, home: 0 })).map((r: ShootoutRound, i: number) => (
                <div key={i} className="so-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px', borderRadius: '4px', border: `1px solid ${themeVars.borderCol}`, minWidth: '65px', flex: 'none' }}>
                  <span style={{ fontSize: '10px', color: themeVars.textMuted, marginBottom: '6px', fontWeight: 'bold' }}>R{i+1}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px', width: '100%' }}>
                    <span style={{ fontSize: '9px', color: '#66b0ff', textAlign: 'center' }}>AWAY</span>
                    <select value={r.away} onChange={(e) => updateShootoutRound(i, 'away', parseInt(e.target.value))} style={{ padding: '2px', fontSize: '11px', width: '100%', textAlign: 'center', ...selectStyle }}>
                      <option value={0} style={selectStyle}>-</option>
                      <option value={1} style={selectStyle}>GOAL</option>
                      <option value={2} style={selectStyle}>MISS</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                    <span style={{ fontSize: '9px', color: '#66b0ff', textAlign: 'center' }}>HOME</span>
                    <select value={r.home} onChange={(e) => updateShootoutRound(i, 'home', parseInt(e.target.value))} style={{ padding: '2px', fontSize: '11px', width: '100%', textAlign: 'center', ...selectStyle }}>
                      <option value={0} style={selectStyle}>-</option>
                      <option value={1} style={selectStyle}>GOAL</option>
                      <option value={2} style={selectStyle}>MISS</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* FULL GRAPHICS SETTINGS TAB */}
      <div id="tab-graphics" className={`tab-content ${activeTab === 'tab-graphics' ? 'active' : ''}`}>
        <div className="panel-grid">
          
          <div className="box" style={{ flex: '1 1 350px' }}>
            <h3>GLOBAL ARCHITECTURE</h3>
            <div className="row">
              <label>Scoreboard Layout:</label>
              <select 
                value={getGVar('scoreboardStyle', 'style1')} 
                onChange={(e) => updateGraphicVar('scoreboardStyle', e.target.value, true)}
                style={selectStyle}
              >
                <option value="style1" style={selectStyle}>Style 1 - Linear Slanted Bug</option>
                <option value="style2" style={selectStyle}>Style 2 - Classic Grid Bug</option>
                <option value="style3" style={selectStyle}>Style 3 - Compact Split Bug</option>
              </select>
            </div>

            <div className="row">
              <label>Global Font:</label>
              <select 
                value={getGVar('globalFont', "'Roboto Condensed', sans-serif")} 
                onChange={(e) => { updateGraphicVar('globalFont', e.target.value, true); updateField('global_font', e.target.value); }}
                style={selectStyle}
              >
                <option value="'Roboto Condensed', sans-serif" style={selectStyle}>Roboto Condensed</option>
                <option value="'Bebas Neue', cursive" style={selectStyle}>Bebas Neue</option>
                <option value="'Montserrat', sans-serif" style={selectStyle}>Montserrat</option>
                <option value="'Oswald', sans-serif" style={selectStyle}>Oswald</option>
                <option value="'Anton', sans-serif" style={selectStyle}>Anton</option>
                <option value="'Teko', sans-serif" style={selectStyle}>Teko</option>
                <option value="'Rajdhani', sans-serif" style={selectStyle}>Rajdhani</option>
                <option value="'Orbitron', sans-serif" style={selectStyle}>Orbitron</option>
                <option value="Arial, sans-serif" style={selectStyle}>Arial</option>
                <option value="Impact, sans-serif" style={selectStyle}>Impact</option>
                <option value="'Share Tech Mono', monospace" style={selectStyle}>Share Tech Mono</option>
              </select>
            </div>

            <div className="row">
              <label>Overlay Scale:</label>
              <div className="sync-group">
                <input 
                  type="range" min="0.25" max="3" step="0.05" 
                  value={getGVar('bugScale', '1.0')} 
                  onChange={(e) => updateGraphicVar('bugScale', e.target.value, false, true)} 
                  onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                  onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                />
                <input 
                  type="number" className="sync-num" step="0.05" min="0.1" max="4"
                  value={getGVar('bugScale', '1.0')} 
                  onChange={(e) => updateGraphicVar('bugScale', e.target.value)} 
                  style={{ width: '55px' }}
                />
              </div>
            </div>

            <div className="row">
              <label>Position X (px):</label>
              <div className="sync-group">
                <input 
                  type="range" min="-960" max="960" step="1" 
                  value={getGVar('overlayPosX', '0')} 
                  onChange={(e) => updateGraphicVar('overlayPosX', e.target.value, false, true)} 
                  onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                  onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                />
                <input 
                  type="number" className="sync-num" step="1"
                  value={getGVar('overlayPosX', '0')} 
                  onChange={(e) => updateGraphicVar('overlayPosX', e.target.value)} 
                  style={{ width: '55px' }}
                />
              </div>
            </div>

            <div className="row">
              <label>Position Y (px):</label>
              <div className="sync-group">
                <input 
                  type="range" min="0" max="1080" step="1" 
                  value={getGVar('overlayPosY', '20')} 
                  onChange={(e) => updateGraphicVar('overlayPosY', e.target.value, false, true)} 
                  onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                  onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                />
                <input 
                  type="number" className="sync-num" step="1"
                  value={getGVar('overlayPosY', '20')} 
                  onChange={(e) => updateGraphicVar('overlayPosY', e.target.value)} 
                  style={{ width: '55px' }}
                />
              </div>
            </div>

            <div className="row">
              <button
                className="btn"
                style={{ borderRadius: '6px' }}
                onClick={() => {
                  const cfg = { ...(stateRef.current?.graphics_config || {}), bugScale: '1.0', overlayPosX: '0', overlayPosY: '20' };
                  updateGraphicVar('bugScale', '1.0', false, true);
                  updateGraphicVar('overlayPosX', '0', false, true);
                  updateGraphicVar('overlayPosY', '20', true, true);
                  pushHistory(cfg);
                }}
              >
                RESET POSITION &amp; SCALE
              </button>
            </div>

            <div className="row">
              <label>Skew Angle °:</label>
              <div className="sync-group">
                <input 
                  type="range" min="-30" max="30" 
                  value={globalSkewVal} 
                  onChange={(e) => updateGraphicVar('skewAngle', e.target.value, true, true)} 
                  onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                  onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                />
                <input 
                  type="number" className="sync-num" 
                  value={globalSkewVal} 
                  onChange={(e) => updateGraphicVar('skewAngle', e.target.value, true)} 
                  style={{ width: '55px' }}
                />
              </div>
            </div>

            <div className="row">
              <label>Corner Radius:</label>
              <div className="sync-group">
                <input 
                  type="range" min="0" max="40" 
                  value={getGVar('cornerRadius', '8')} 
                  onChange={(e) => updateGraphicVar('cornerRadius', e.target.value, false, true)} 
                  onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                  onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                />
                <input 
                  type="number" className="sync-num" 
                  value={getGVar('cornerRadius', '8')} 
                  onChange={(e) => updateGraphicVar('cornerRadius', e.target.value)} 
                  style={{ width: '55px' }}
                />
              </div>
            </div>

            <div className="row">
              <label>Bug Border:</label>
              <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input 
                  type="color" 
                  value={getGVar('bugBorderColor', '#ffffff')} 
                  onChange={(e) => updateGraphicVar('bugBorderColor', e.target.value, true)} 
                  style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                />
                <input 
                  type="text" 
                  value={getGVar('bugBorderColor', '#ffffff')} 
                  onChange={(e) => updateGraphicVar('bugBorderColor', e.target.value, true)} 
                  style={{ width: '85px', height: '32px', textAlign: 'center', fontFamily: 'monospace', padding: '4px' }} 
                />
                <input 
                  type="number" min="0" max="15" 
                  value={getGVar('bugBorderWidth', '2')} 
                  onChange={(e) => updateGraphicVar('bugBorderWidth', e.target.value)} 
                  style={{ width: '50px', height: '32px', textAlign: 'center' }} 
                /> px
              </div>
            </div>

            <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />

            {SEQ_FIELDS.map(f => renderSeqTextField(f))}

            <div className="row">
              <label>Timeout Rollout:</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={getGVar('timeout_autohide', true) === true || getGVar('timeout_autohide', true) === 'true'}
                  onChange={(e) => updateGraphicVar('timeout_autohide', e.target.checked, true)}
                  style={{ flex: 'none', width: 'auto' }}
                />
                <span style={{ fontSize: '12px' }}>Auto hide after</span>
                <input
                  type="number" min="1" max="300"
                  value={getGVar('timeout_duration', '30')}
                  onChange={(e) => updateGraphicVar('timeout_duration', e.target.value, true)}
                  style={{ width: '60px', flex: 'none', textAlign: 'center' }}
                />
                <span style={{ fontSize: '12px' }}>secs</span>
              </div>
            </div>
          </div>

          <div className="box" style={{ flex: '2 1 600px', borderColor: '#007bff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #007bff', paddingBottom: '10px', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
              <h3 style={{ border: 'none', margin: 0, padding: 0 }}>COMPONENT EDITOR</h3>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button 
                  onClick={handleUndo}
                  disabled={historyIndex <= 0}
                  style={{ 
                    background: historyIndex > 0 ? '#ff9800' : themeVars.btnSecondaryBg, 
                    color: historyIndex > 0 ? '#fff' : themeVars.textMuted, 
                    border: `1px solid ${themeVars.btnSecondaryBorder}`, 
                    borderRadius: '4px', 
                    padding: '6px 10px', 
                    fontSize: '11px', 
                    fontWeight: 'bold', 
                    cursor: historyIndex > 0 ? 'pointer' : 'not-allowed',
                    opacity: historyIndex > 0 ? 1 : 0.5 
                  }}
                >
                  ↩ UNDO
                </button>

                <button 
                  onClick={handleRedo}
                  disabled={historyIndex >= historyStack.length - 1}
                  style={{ 
                    background: historyIndex < historyStack.length - 1 ? '#ff9800' : themeVars.btnSecondaryBg, 
                    color: historyIndex < historyStack.length - 1 ? '#fff' : themeVars.textMuted, 
                    border: `1px solid ${themeVars.btnSecondaryBorder}`, 
                    borderRadius: '4px', 
                    padding: '6px 10px', 
                    fontSize: '11px', 
                    fontWeight: 'bold', 
                    cursor: historyIndex < historyStack.length - 1 ? 'pointer' : 'not-allowed',
                    opacity: historyIndex < historyStack.length - 1 ? 1 : 0.5 
                  }}
                >
                  ↪ REDO
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '6px' }}>
                  <button
                    onClick={swapTeamGraphics}
                    title="Swap all Away (left) and Home (right) graphic settings"
                    style={{ background: '#F36C21', color: '#fff', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    ⇄ SWAP TEAMS
                  </button>
                  <label title="Also swap the team names" style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={swapIncludesNames}
                      onChange={(e) => setSwapIncludesNames(e.target.checked)}
                      style={{ flex: 'none', width: 'auto', margin: 0 }}
                    />
                    + names
                  </label>
                </div>

                <button 
                  onClick={copyComponentSettings}
                  style={{ background: '#2860bd', color: '#fff', border: 'none', borderRadius: '4px', padding: '6px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  📋 COPY SETTINGS
                </button>

                <button 
                  onClick={pasteComponentSettings}
                  style={{ background: copiedSettings ? '#10b981' : themeVars.btnSecondaryBg, color: copiedSettings ? '#fff' : themeVars.btnSecondaryText, border: `1px solid ${themeVars.btnSecondaryBorder}`, borderRadius: '4px', padding: '6px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  📥 PASTE SETTINGS
                </button>
                
                <label style={{ width: 'auto', fontSize: '13px', marginLeft: '6px' }}>Select Element:</label>
                <select 
                  value={selectedComp} 
                  onChange={(e) => setSelectedComp(e.target.value)}
                  style={{ width: '210px', flex: 'none', fontWeight: 'bold', ...selectStyle }}
                >
                  <option value="clock" style={selectStyle}>Game Clock</option>
                  <option value="period" style={selectStyle}>Period</option>
                  <option value="awayTeam" style={selectStyle}>Away Team Box</option>
                  <option value="awayScore" style={selectStyle}>Away Score</option>
                  <option value="awayGoal" style={selectStyle}>Away Goal Rollout Panel</option>
                  <option value="homeTeam" style={selectStyle}>Home Team Box</option>
                  <option value="homeScore" style={selectStyle}>Home Score</option>
                  <option value="homeGoal" style={selectStyle}>Home Goal Rollout Panel</option>
                  <option value="awaySog" style={selectStyle}>Away Shots on Goal</option>
                  <option value="homeSog" style={selectStyle}>Home Shots on Goal</option>
                  <option value="awayPP" style={selectStyle}>Away Power Play Panel</option>
                  <option value="homePP" style={selectStyle}>Home Power Play Panel</option>
                  <option value="rollout1" style={selectStyle}>Rollout 1</option>
                  <option value="rollout2" style={selectStyle}>Rollout 2</option>
                  <option value="rollout3" style={selectStyle}>Rollout 3</option>
                  <option value="delayedPenalty" style={selectStyle}>Delayed Penalty</option>
                  <option value="fourOnFour" style={selectStyle}>4 on 4 Panel</option>
                  <option value="banner" style={selectStyle}>Full Width Banner 1</option>
                  <option value="banner2" style={selectStyle}>Full Width Banner 2</option>
                  <option value="banner3" style={selectStyle}>Full Width Banner 3</option>
                  <option value="shootout" style={selectStyle}>Shootout Tracker</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 250px' }}>
                {isRolloutElement && (
                  <div style={{ background: themeVars.bgInput, padding: '10px', borderRadius: '6px', marginBottom: '12px', border: `1px solid ${themeVars.borderCol}` }}>
                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="checkbox" 
                          id={`chk-autohide-${selectedComp}`}
                          checked={getGVar(`${selectedComp}_autohide`, true) === true || getGVar(`${selectedComp}_autohide`, true) === 'true'}
                          onChange={(e) => updateGraphicVar(`${selectedComp}_autohide`, e.target.checked, true)}
                        />
                        <label htmlFor={`chk-autohide-${selectedComp}`} style={{ fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>
                          Auto Hide {selectedComp.startsWith('banner') ? 'Banner' : 'Rollout'}
                        </label>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px' }}>Secs:</label>
                        <input 
                          type="number" 
                          min="1" max="60"
                          value={getGVar(`${selectedComp}_duration`, '5')}
                          onChange={(e) => updateGraphicVar(`${selectedComp}_duration`, e.target.value, true)}
                          style={{ width: '45px', textAlign: 'center', padding: '2px 4px' }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Text Color:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="color" 
                      value={getGVar(`${selectedComp}_text_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_color`, e.target.value, true)} 
                      style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                    />
                    <input 
                      type="text" 
                      value={getGVar(`${selectedComp}_text_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_color`, e.target.value, true)} 
                      style={{ width: '85px', height: '32px', fontFamily: 'monospace', textAlign: 'center', padding: '4px' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Text Outline Color:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="color" 
                      value={getGVar(`${selectedComp}_stroke_color`, '#000000')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_color`, e.target.value, true)} 
                      style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                    />
                    <input 
                      type="text" 
                      value={getGVar(`${selectedComp}_stroke_color`, '#000000')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_color`, e.target.value, true)} 
                      style={{ width: '85px', height: '32px', fontFamily: 'monospace', textAlign: 'center', padding: '4px' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Text Outline (px):</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="0" max="20" 
                      value={getGVar(`${selectedComp}_stroke_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_width`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_stroke_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_width`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Font Family:</label>
                  <select 
                    value={getGVar(`${selectedComp}_font_family`, '')} 
                    onChange={(e) => updateGraphicVar(`${selectedComp}_font_family`, e.target.value, true)}
                    style={selectStyle}
                  >
                    <option value="" style={selectStyle}>(Use Global Font)</option>
                    <option value="'Roboto Condensed', sans-serif" style={selectStyle}>Roboto Condensed</option>
                    <option value="'Bebas Neue', cursive" style={selectStyle}>Bebas Neue</option>
                    <option value="'Montserrat', sans-serif" style={selectStyle}>Montserrat</option>
                    <option value="'Oswald', sans-serif" style={selectStyle}>Oswald</option>
                    <option value="'Anton', sans-serif" style={selectStyle}>Anton</option>
                    <option value="'Teko', sans-serif" style={selectStyle}>Teko</option>
                    <option value="Arial, sans-serif" style={selectStyle}>Arial</option>
                    <option value="Impact, sans-serif" style={selectStyle}>Impact</option>
                  </select>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Font Size (px):</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="8" max="150" 
                      value={getGVar(`${selectedComp}_font_size`, '24')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_font_size`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_font_size`, '24')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_font_size`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Text Alignment:</label>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {[['', 'Default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']].map(([v, label]) => {
                      const cur = getGVar(`${selectedComp}_text_align`, '') || '';
                      const on = cur === v;
                      return (
                        <button
                          key={`align_${v || 'default'}`}
                          type="button"
                          title={v ? `Align text ${v}` : 'Use the layout\'s normal alignment'}
                          onClick={() => updateGraphicVar(`${selectedComp}_text_align`, v, true)}
                          style={{ padding: '6px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer',
                            background: on ? '#007bff' : themeVars.btnSecondaryBg, color: on ? '#fff' : themeVars.btnSecondaryText,
                            border: `1px solid ${on ? '#007bff' : themeVars.btnSecondaryBorder}` }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Text Animation Effect:</label>
                  <select 
                    value={getGVar(`${selectedComp}_text_anim`, 'none')} 
                    onChange={(e) => updateGraphicVar(`${selectedComp}_text_anim`, e.target.value, true)}
                    style={selectStyle}
                  >
                    <option value="none" style={selectStyle}>None (Static)</option>
                    <option value="wipeLeft" style={selectStyle}>Wipe Left</option>
                    <option value="wipeRight" style={selectStyle}>Wipe Right</option>
                    <option value="wipeUp" style={selectStyle}>Wipe Up</option>
                    <option value="wipeDown" style={selectStyle}>Wipe Down</option>
                    <option value="fadeIn" style={selectStyle}>Fade In</option>
                    <option value="fadeOut" style={selectStyle}>Fade Out</option>
                    <option value="zoomIn" style={selectStyle}>Zoom In</option>
                    <option value="zoomOut" style={selectStyle}>Zoom Out</option>
                    <option value="typewriter" style={selectStyle}>Typewriter (Centered)</option>
                    <option value="glitchTypewriter" style={selectStyle}>Glitch Typewriter</option>
                    <option value="spinInLeft" style={selectStyle}>Spin In Left</option>
                    <option value="spinInRight" style={selectStyle}>Spin In Right</option>
                    <option value="pushLeft" style={selectStyle}>Push Left</option>
                    <option value="pushRight" style={selectStyle}>Push Right</option>
                    <option value="pushUp" style={selectStyle}>Push Up</option>
                    <option value="pushDown" style={selectStyle}>Push Down</option>
                    <option value="randomFlash" style={selectStyle}>Random Flash</option>
                    <option value="enlarge" style={selectStyle}>Enlarge</option>
                    <option value="rightInsert" style={selectStyle}>Right Insert</option>
                    <option value="leftInsert" style={selectStyle}>Left Insert</option>
                    <option value="blurLeft" style={selectStyle}>Blur Left</option>
                    <option value="blurRight" style={selectStyle}>Blur Right</option>
                  </select>
                </div>

                {getGVar(`${selectedComp}_text_anim`, 'none') !== 'none' && (
                  <>
                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>Anim Duration (s):</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0.2" max="3.0" step="0.1" 
                          value={getGVar(`${selectedComp}_text_anim_dur`, '0.6')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_text_anim_dur`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" step="0.1"
                          value={getGVar(`${selectedComp}_text_anim_dur`, '0.6')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_text_anim_dur`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>Anim Intensity (Scale):</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0.1" max="5.0" step="0.1" 
                          value={getGVar(`${selectedComp}_text_anim_intensity`, '1.0')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_text_anim_intensity`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" step="0.1"
                          value={getGVar(`${selectedComp}_text_anim_intensity`, '1.0')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_text_anim_intensity`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>
                  </>
                )}

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Text Skew °:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="-40" max="40" 
                      value={getGVar(`${selectedComp}_text_global_skew`, false) ? globalSkewVal : getGVar(`${selectedComp}_text_skew`, '0')} 
                      disabled={getGVar(`${selectedComp}_text_global_skew`, false)}
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_skew`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_text_global_skew`, false) ? globalSkewVal : getGVar(`${selectedComp}_text_skew`, '0')} 
                      disabled={getGVar(`${selectedComp}_text_global_skew`, false)}
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_skew`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                  <label></label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="checkbox" 
                      checked={getGVar(`${selectedComp}_text_global_skew`, false)} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_global_skew`, e.target.checked, true)} 
                      style={{ flex: 'none', width: 'auto' }} 
                    /> 
                    <span style={{ fontSize: '11px' }}>Use Global Box Angle ({globalSkewVal}°)</span>
                  </div>
                </div>

                <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Border Color:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="color" 
                      value={getGVar(`${selectedComp}_border_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_color`, e.target.value, true)} 
                      style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                    />
                    <input 
                      type="text" 
                      value={getGVar(`${selectedComp}_border_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_color`, e.target.value, true)} 
                      style={{ width: '85px', height: '32px', fontFamily: 'monospace', textAlign: 'center', padding: '4px' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Border Width (px):</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="0" max="20" 
                      value={getGVar(`${selectedComp}_border_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_width`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_border_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_width`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>Layer System:</label>
                  <select 
                    value={getGVar(`${selectedComp}_layer_order`, 'mediaBelow')} 
                    onChange={(e) => updateGraphicVar(`${selectedComp}_layer_order`, e.target.value, true)}
                    style={selectStyle}
                  >
                    <option value="mediaBelow" style={selectStyle}>Foreground Layer (color/gradient in front of media)</option>
                    <option value="gradientBelow" style={selectStyle}>Background Layer (color/gradient behind media)</option>
                  </select>
                </div>

                {['awayPP', 'homePP', 'awayGoal', 'homeGoal', 'delayedPenalty', 'fourOnFour', 'shootout'].includes(selectedComp) && (() => {
                  const v = getGVar(`${selectedComp}_use_team_bg`, true);
                  const on = v !== false && v !== 'false';
                  const what = selectedComp === 'shootout'
                    ? 'Each team\'s row uses its Team Box background'
                    : selectedComp === 'fourOnFour'
                    ? 'Blend of the Away and Home Team Box colors'
                    : selectedComp === 'delayedPenalty'
                      ? 'Penalized team\'s Team Box background (per-team DELAYED buttons)'
                      : `${selectedComp.startsWith('away') ? 'Away' : 'Home'} Team Box background${selectedComp.endsWith('PP') ? ' (also used by that team\'s Timeout)' : ''}`;
                  return (
                    <div style={{ background: on ? 'rgba(0,123,255,0.08)' : 'transparent', border: `1px solid ${on ? '#007bff' : themeVars.borderCol}`, borderRadius: '6px', padding: '8px 10px', marginBottom: '10px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', width: 'auto', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => updateGraphicVar(`${selectedComp}_use_team_bg`, e.target.checked, true)}
                          style={{ flex: 'none', width: 'auto', margin: 0 }}
                        />
                        Match Team Box Background
                      </label>
                      <div style={{ fontSize: '11px', color: themeVars.textMuted, marginTop: '4px', marginLeft: '22px' }}>
                        {on ? `${what}. Untick to use the background settings below.` : 'Using the background settings below.'}
                      </div>
                    </div>
                  );
                })()}

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', opacity: (['awayPP', 'homePP', 'awayGoal', 'homeGoal', 'delayedPenalty', 'fourOnFour'].includes(selectedComp) && getGVar(`${selectedComp}_use_team_bg`, true) !== false && getGVar(`${selectedComp}_use_team_bg`, true) !== 'false') ? 0.5 : 1 }}>
                  <label>Background Type:</label>
                  <select 
                    value={bgType} 
                    onChange={(e) => updateGraphicVar(`${selectedComp}_bg_type`, e.target.value, true)}
                    style={selectStyle}
                  >
                    <option value="solid" style={selectStyle}>Solid Color</option>
                    <option value="clear" style={selectStyle}>Clear (Transparent)</option>
                    <option value="linear" style={selectStyle}>Linear Gradient (2-Color)</option>
                    <option value="linear3" style={selectStyle}>Linear Gradient (3-Color)</option>
                    <option value="radial" style={selectStyle}>Radial Gradient</option>
                  </select>
                </div>

                {bgType !== 'clear' && (
                  <>
                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <label>BG Color 1 (Left):</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="color" 
                          value={
                            selectedComp === 'awayTeam' ? stateRef.current?.away_color || getGVar('awayTeam_bg_color', '#00468b') :
                            selectedComp === 'homeTeam' ? stateRef.current?.home_color || getGVar('homeTeam_bg_color', '#222222') :
                            getGVar(`${selectedComp}_bg_color`, '#111111')
                          } 
                          onChange={(e) => {
                            const val = e.target.value;
                            if (selectedComp === 'awayTeam') {
                              updateField('away_color', val);
                              updateGraphicVar('awayTeam_bg_color', val, true);
                            } else if (selectedComp === 'homeTeam') {
                              updateField('home_color', val);
                              updateGraphicVar('homeTeam_bg_color', val, true);
                            } else {
                              updateGraphicVar(`${selectedComp}_bg_color`, val, true);
                            }
                          }} 
                          style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                        />
                        <input 
                          type="text" 
                          value={
                            selectedComp === 'awayTeam' ? stateRef.current?.away_color || getGVar('awayTeam_bg_color', '#00468b') :
                            selectedComp === 'homeTeam' ? stateRef.current?.home_color || getGVar('homeTeam_bg_color', '#222222') :
                            getGVar(`${selectedComp}_bg_color`, '#111111')
                          } 
                          onChange={(e) => {
                            const val = e.target.value;
                            if (selectedComp === 'awayTeam') {
                              updateField('away_color', val);
                              updateGraphicVar('awayTeam_bg_color', val, true);
                            } else if (selectedComp === 'homeTeam') {
                              updateField('home_color', val);
                              updateGraphicVar('homeTeam_bg_color', val, true);
                            } else {
                              updateGraphicVar(`${selectedComp}_bg_color`, val, true);
                            }
                          }} 
                          style={{ width: '85px', height: '32px', fontFamily: 'monospace', textAlign: 'center', padding: '4px' }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>Color 1 Alpha %:</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_col1_alpha`, '100')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_col1_alpha`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_col1_alpha`, '100')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_col1_alpha`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>
                  </>
                )}

                {bgType === 'linear3' && (
                  <>
                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <label>BG Color 2 (Mid):</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="color" 
                          value={getGVar(`${selectedComp}_bg_col3`, '#888888')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col3`, e.target.value, true)} 
                          style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                        />
                        <input 
                          type="text" 
                          value={getGVar(`${selectedComp}_bg_col3`, '#888888')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col3`, e.target.value, true)} 
                          style={{ width: '85px', height: '32px', fontFamily: 'monospace', textAlign: 'center', padding: '4px' }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>Color 2 Alpha %:</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_col3_alpha`, '100')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_col3_alpha`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_col3_alpha`, '100')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_col3_alpha`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>Mid Position %:</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_mid_pos`, '50')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_pos`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_mid_pos`, '50')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_pos`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>Mid Width %:</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_mid_width`, '0')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_width`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_mid_width`, '0')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_width`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>
                  </>
                )}

                {(bgType === 'linear' || bgType === 'linear3' || bgType === 'radial') && (
                  <>
                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <label>{bgType === 'linear3' ? 'BG Color 3 (Right):' : 'BG Color 2 (Right):'}</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="color" 
                          value={getGVar(`${selectedComp}_bg_col2`, '#000000')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col2`, e.target.value, true)} 
                          style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                        />
                        <input 
                          type="text" 
                          value={getGVar(`${selectedComp}_bg_col2`, '#000000')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col2`, e.target.value, true)} 
                          style={{ width: '85px', height: '32px', fontFamily: 'monospace', textAlign: 'center', padding: '4px' }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <label>{bgType === 'linear3' ? 'Color 3 Alpha %:' : 'Color 2 Alpha %:'}</label>
                      <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_col2_alpha`, '100')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_col2_alpha`, e.target.value, false, true)} 
                          onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                          onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_col2_alpha`, '100')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_col2_alpha`, e.target.value)} 
                          style={{ width: '55px', height: '32px', textAlign: 'center' }}
                        />
                      </div>
                    </div>
                  </>
                )}

                {(bgType === 'linear' || bgType === 'linear3') && (
                  <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <label>Gradient Angle:</label>
                    <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input 
                        type="range" min="0" max="360" 
                        value={getGVar(`${selectedComp}_bg_angle`, '90')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_angle`, e.target.value, false, true)} 
                        onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                        onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                      />
                      <input 
                        type="number" className="sync-num" 
                        value={getGVar(`${selectedComp}_bg_angle`, '90')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_angle`, e.target.value)} 
                        style={{ width: '55px', height: '32px', textAlign: 'center' }}
                      />
                    </div>
                  </div>
                )}

                {bgType !== 'clear' && (
                  <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <label>Box Overall Transparency:</label>
                    <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input 
                        type="range" min="0" max="100" 
                        value={getGVar(`${selectedComp}_bg_alpha`, '100')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_alpha`, e.target.value, false, true)} 
                        onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                        onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                      />
                      <input 
                        type="number" className="sync-num" 
                        value={getGVar(`${selectedComp}_bg_alpha`, '100')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_alpha`, e.target.value)} 
                        style={{ width: '55px', height: '32px', textAlign: 'center' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ flex: '1 1 250px' }}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <label>BG Media (Img/Vid):</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
                    <input 
                      id={`file-input-${selectedComp}`}
                      type="file" 
                      accept="image/*, video/*, .mp4, .webm, .gif" 
                      onChange={handleMediaUpload} 
                      style={{ fontSize: '11px', padding: '6px', width: '100%' }}
                    />
                    
                    {currentMediaUrl && (
                      <div style={{ 
                        border: `1px solid ${themeVars.borderCol}`, 
                        borderRadius: '6px', 
                        overflow: 'hidden', 
                        background: themeVars.bgInput, 
                        height: '100px', 
                        position: 'relative' 
                      }}>
                        {currentIsVideo ? (
                          <video 
                            key={`vid_${currentMediaUrl}`}
                            src={currentMediaUrl} 
                            autoPlay loop muted playsInline
                            style={{ 
                              width: '100%', height: '100%', objectFit: 'contain', position: 'absolute', top: 0, left: 0,
                              opacity: parseFloat(currentImgAlpha) / 100, transformOrigin: 'center',
                              transform: `translate(${currentImgX}%, ${currentImgY}%) scale(${parseFloat(currentImgScale) / 100}) skewX(${mediaComputedSkew}deg)`
                            }} 
                          />
                        ) : (
                          <img 
                            key={`img_${currentMediaUrl}`}
                            src={currentMediaUrl} alt="Media Preview"
                            style={{ 
                              width: '100%', height: '100%', objectFit: 'contain', position: 'absolute', top: 0, left: 0,
                              opacity: parseFloat(currentImgAlpha) / 100, transformOrigin: 'center',
                              transform: `translate(${currentImgX}%, ${currentImgY}%) scale(${parseFloat(currentImgScale) / 100}) skewX(${mediaComputedSkew}deg)`
                            }} 
                          />
                        )}
                      </div>
                    )}
                    
                    <button className="btn btn-secondary-theme" onClick={clearMedia}>CLEAR MEDIA</button>
                  </div>
                </div>

                {(selectedComp === 'awayPP' || selectedComp === 'homePP') && (
                  <div className="row" style={{ marginTop: '10px' }}>
                    <label>Team Logo BG:</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={(() => {
                          const v = getGVar(`${selectedComp}_use_team_media`, getGVar('ppPanel_use_team_media', true));
                          return v !== false && v !== 'false';
                        })()}
                        onChange={(e) => updateGraphicVar(`${selectedComp}_use_team_media`, e.target.checked, true)}
                        style={{ flex: 'none', width: 'auto' }}
                      />
                      <span style={{ fontSize: '11px' }}>Use this team's Team Box logo/video (overrides the media above when the team box has one). Scale, alpha and position here only affect this power play panel.</span>
                    </div>
                  </div>
                )}

                {currentIsVideo && (
                  <div className="row" style={{ marginTop: '10px' }}>
                    <label>Loop Media:</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input 
                        type="checkbox" 
                        checked={currentMediaLoop} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_media_loop`, e.target.checked, true)} 
                        style={{ flex: 'none', width: 'auto' }} 
                      />
                      <span style={{ fontSize: '11px' }}>Loops video endlessly</span>
                    </div>
                  </div>
                )}

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <label>Scale %:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="10" max="1000" step="5" 
                      value={currentImgScale} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_scale`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgScale} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_scale`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <label>Alpha %:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="0" max="100" 
                      value={currentImgAlpha} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_alpha`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgAlpha} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_alpha`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <label>Pos X %:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="-200" max="200" 
                      value={currentImgX} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_x`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgX} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_x`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <label>Pos Y %:</label>
                  <div className="sync-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="range" min="-200" max="200" 
                      value={currentImgY} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_y`, e.target.value, false, true)} 
                      onMouseUp={() => pushHistory(stateRef.current?.graphics_config)}
                      onTouchEnd={() => pushHistory(stateRef.current?.graphics_config)}
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgY} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_y`, e.target.value)} 
                      style={{ width: '55px', height: '32px', textAlign: 'center' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ display: 'flex', alignItems: 'center', marginTop: '10px' }}>
                  <label>Global Skew:</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="checkbox" 
                      checked={mediaUseGlobalSkew} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_use_global_skew`, e.target.checked, true)} 
                      style={{ flex: 'none', width: 'auto' }} 
                    />
                    <span style={{ fontSize: '11px' }}>Inherit Global Box Skew ({globalSkewVal}°)</span>
                  </div>
                </div>
              </div>

            </div>
          </div>

        </div>
      </div>

      {/* HOTKEYS TAB */}
      <div id="tab-hotkeys" className={`tab-content ${activeTab === 'tab-hotkeys' ? 'active' : ''}`}>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{ flex: '0 0 200px' }}>
            <button onClick={clearAllHotkeys} style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', padding: '12px', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', width: '100%' }}>
              CLEAR ALL HOTKEYS
            </button>
          </div>
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px' }}>
            <div className="box">
              <h3>GLOBAL ACTIONS</h3>
              {renderHotkeyRow('Toggle Clock:', 'toggleClock')}
              {renderHotkeyRow('Reset Clock:', 'resetClock')}
              {renderHotkeyRow('+1 Minute:', 'addMin')}
              {renderHotkeyRow('-1 Minute:', 'subMin')}
              {renderHotkeyRow('+1 Second:', 'addSec')}
              {renderHotkeyRow('-1 Second:', 'subSec')}
              {renderHotkeyRow('Reset ALL Stats:', 'resetAllStats')}
              {renderHotkeyRow('Clear Penalties:', 'clearPenalties')}
              <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />
              {renderHotkeyRow('Trigger Rollout 1:', 'triggerRollout1')}
              {renderHotkeyRow('Trigger Rollout 2:', 'triggerRollout2')}
              {renderHotkeyRow('Trigger Rollout 3:', 'triggerRollout3')}
              {renderHotkeyRow('Trigger Delayed Penalty:', 'triggerDelayedPenalty')}
              {renderHotkeyRow('Trigger 4 on 4:', 'triggerFourOnFour')}
              {renderHotkeyRow('Trigger Banner 1:', 'triggerBanner')}
              {renderHotkeyRow('Trigger Banner 2:', 'triggerBanner2')}
              {renderHotkeyRow('Trigger Banner 3:', 'triggerBanner3')}
            </div>
            <div className="box">
              <h3>AWAY TEAM</h3>
              {renderHotkeyRow('+1 Goal:', 'addAwayGoal')}
              {renderHotkeyRow('-1 Goal:', 'subAwayGoal')}
              {renderHotkeyRow('+1 SOG:', 'addAwaySog')}
              {renderHotkeyRow('-1 SOG:', 'subAwaySog')}
              {renderHotkeyRow('Timeout:', 'triggerAwayTimeout')}
              {renderHotkeyRow('Delayed Penalty:', 'triggerAwayDelayed')}
            </div>
            <div className="box">
              <h3>HOME TEAM</h3>
              {renderHotkeyRow('+1 Goal:', 'addHomeGoal')}
              {renderHotkeyRow('-1 Goal:', 'subHomeGoal')}
              {renderHotkeyRow('+1 SOG:', 'addHomeSog')}
              {renderHotkeyRow('-1 SOG:', 'subHomeSog')}
              {renderHotkeyRow('Timeout:', 'triggerHomeTimeout')}
              {renderHotkeyRow('Delayed Penalty:', 'triggerHomeDelayed')}
            </div>
          </div>
        </div>
      </div>

      {/* SYSTEM & PROFILES TAB */}
      <div id="tab-system" className={`tab-content ${activeTab === 'tab-system' ? 'active' : ''}`}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1.8fr', gap: '20px' }}>
          
          <div className="box">
            <h3>UI APPEARANCE & OUTPUT</h3>
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ fontSize: '13px', fontWeight: 'bold' }}>Interface Theme:</label>
                <select 
                  value={currentTheme} 
                  onChange={(e) => updateGraphicVar('uiTheme', e.target.value, true)}
                  style={{ width: '100%', padding: '8px', fontSize: '12px', ...selectStyle }}
                >
                  <option value="Light" style={selectStyle}>Option 1: Light (#F1F4F8)</option>
                  <option value="Concrete" style={selectStyle}>Option 2: Concrete (#888E99)</option>
                  <option value="Slate" style={selectStyle}>Option 3: Slate (#2F343E)</option>
                  <option value="Studio Black" style={selectStyle}>Option 4: Studio Black (#1C1C1E)</option>
                </select>
              </div>
            </div>

            <button 
              onClick={() => updateGraphicVar('chromaKeyActive', !chromaActive, true)}
              style={{
                width: '100%',
                background: chromaActive ? '#10b981' : themeVars.btnSecondaryBg,
                color: chromaActive ? '#ffffff' : themeVars.btnSecondaryText,
                border: `1px solid ${chromaActive ? '#10b981' : themeVars.btnSecondaryBorder}`,
                borderRadius: '6px',
                padding: '12px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                textAlign: 'center',
                textTransform: 'uppercase'
              }}
            >
              {chromaActive ? 'DISABLE GREEN SCREEN (CHROMA KEY)' : 'ENABLE GREEN SCREEN (CHROMA KEY)'}
            </button>
          </div>

          <div className="box">
            <h3>LOCAL BROWSER STORAGE</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button onClick={saveToTemporaryCache} style={{ width: '100%', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                SAVE TO TEMPORARY CACHE
              </button>
              <button onClick={saveAsUserSystemDefault} style={{ width: '100%', background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                SAVE AS USER SYSTEM DEFAULT
              </button>
              <button onClick={restoreUserDefaults} style={{ width: '100%', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                RESTORE USER DEFAULTS
              </button>
              <button onClick={factoryReset} style={{ width: '100%', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                FACTORY RESET
              </button>
            </div>
          </div>

          <div className="box">
            <h3>JSON FILE EXPORT / IMPORT</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Save As (Event / Profile Name):</label>
                <input 
                  type="text" 
                  value={profileEventName}
                  onChange={(e) => setProfileEventName(e.target.value)}
                  placeholder="e.g. Playoff_Game_1_RinkA"
                  style={{ padding: '8px', fontSize: '12px', borderRadius: '4px' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    onClick={selectExportFolder} 
                    style={{ flex: 1, background: themeVars.btnSecondaryBg, color: themeVars.btnSecondaryText, border: `1px solid ${themeVars.btnSecondaryBorder}`, borderRadius: '6px', padding: '8px 10px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    📁 SELECT EXPORT FOLDER
                  </button>
                  {exportFolderHandle && (
                    <button 
                      onClick={clearExportFolder}
                      style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 10px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}
                      title="Reset to default download folder"
                    >
                      ✖ RESET
                    </button>
                  )}
                </div>
                
                <div style={{ 
                  fontSize: '11px', 
                  color: exportFolderName ? '#10b981' : themeVars.textMuted, 
                  background: themeVars.bgInput, 
                  padding: '6px 10px', 
                  borderRadius: '4px', 
                  border: `1px solid ${themeVars.borderCol}`,
                  wordBreak: 'break-all'
                }}>
                  <strong>Active Target Folder:</strong> {exportFolderName ? `📂 ${exportFolderName}` : 'Default Downloads Folder'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                <button 
                  onClick={exportProfileJSON} 
                  style={{ flex: 1, background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  💾 EXPORT JSON
                </button>
                <label style={{ flex: 1, background: '#8b5cf6', color: '#fff', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', textAlign: 'center' }}>
                  📥 IMPORT JSON
                  <input type="file" accept=".json" onChange={importProfileJSON} style={{ display: 'none' }} />
                </label>
              </div>

            </div>
          </div>

        </div>
      </div>

    </div>
  );
}