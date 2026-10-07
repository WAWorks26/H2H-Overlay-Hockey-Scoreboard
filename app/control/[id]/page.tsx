'use client';

import { useEffect, useState, use, useRef } from 'react';
import { supabase } from '@/lib/supabase';

interface Penalty { id: number; team: string; plyr: string; time: number; }
interface ShootoutRound { away: number; home: number; }

const DEFAULT_HOTKEYS: Record<string, string> = {
  toggleClock: 'Space', resetClock: '', addMin: '', subMin: '', addSec: '', subSec: '',
  resetAllStats: '', clearPenalties: '', triggerRollout1: 'Digit1', triggerRollout2: 'Digit2',
  triggerRollout3: 'Digit3', triggerDelayedPenalty: 'KeyD', triggerBanner: 'KeyB',
  addAwayGoal: 'KeyA', subAwayGoal: 'KeyZ', addAwaySog: 'KeyS', subAwaySog: '', addAwayPenalty: '',
  addHomeGoal: 'KeyH', subHomeGoal: 'KeyN', addHomeSog: 'KeyJ', subHomeSog: '', addHomePenalty: '',
};

export default function ControlPanelPage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params);
  const id = unwrappedParams.id;
  
  const [state, setState] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('tab-ops');
  const [selectedComp, setSelectedComp] = useState('clock');
  const [listeningKeyFor, setListeningKeyFor] = useState<string | null>(null);
  const [exportFolderHandle, setExportFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);

  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [autoSaveIntervalSec, setAutoSaveIntervalSec] = useState(15);
  const [periodLengthMin, setPeriodLengthMin] = useState(20);

  const stateRef = useRef(state);
  stateRef.current = state;
  const channelRef = useRef<any>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const channel = supabase.channel(`scoreboard_${id}`, { config: { broadcast: { self: false } } });
    channel.subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [id]);

  const broadcastState = async (updatedState: any) => {
    if (channelRef.current) {
      await channelRef.current.send({
        type: 'broadcast',
        event: 'STATE_UPDATE',
        payload: updatedState,
      });
    }
  };

  useEffect(() => {
    const fetchState = async () => {
      const { data, error } = await supabase.from('scoreboards').select('*').eq('id', id).single();
      if (error) console.error("Supabase Error:", error.message);
      if (data) {
        setState({ 
          ...data, 
          penalties: data.penalties || [],
          shootout_rounds: data.shootout_rounds || Array(10).fill({ away: 0, home: 0 }),
          graphics_config: data.graphics_config || {}
        });
      }
    };
    fetchState();
  }, [id]);

  useEffect(() => {
    let autoSaveTimer: NodeJS.Timeout;
    if (autoSaveEnabled && state) {
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
    if (state?.clock_running && state.clock_seconds > 0) {
      interval = setInterval(() => {
        setState((prev: any) => {
          if (!prev) return prev;
          
          const newPenalties = (prev.penalties || [])
            .map((p: Penalty) => p.time > 0 ? { ...p, time: p.time - 1 } : p)
            .filter((p: Penalty) => p.time > 0);

          const nextState = {
            ...prev,
            clock_seconds: prev.clock_seconds <= 0 ? 0 : prev.clock_seconds - 1,
            clock_running: prev.clock_seconds <= 0 ? false : prev.clock_running,
            penalties: newPenalties
          };

          if (prev.clock_seconds <= 0) {
            clearInterval(interval);
            supabase.from('scoreboards').update({ clock_running: false, penalties: newPenalties }).eq('id', id);
          }

          broadcastState(nextState);
          return nextState;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [state?.clock_running, id]);

  const updateField = async (field: string, value: any) => {
    const updated = { ...state, [field]: value };
    setState(updated);
    await broadcastState(updated);
    await supabase.from('scoreboards').update({ [field]: value }).eq('id', id);
  };

  const updateGraphicVar = async (key: string, value: any, immediate = false) => {
    const newConfig = { ...(state?.graphics_config || {}), [key]: value };
    const updated = { ...state, graphics_config: newConfig };

    setState(updated);
    await broadcastState(updated);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    if (immediate) {
      await supabase.from('scoreboards').update({ graphics_config: newConfig }).eq('id', id);
    } else {
      debounceTimer.current = setTimeout(async () => {
        await supabase.from('scoreboards').update({ graphics_config: newConfig }).eq('id', id);
      }, 150);
    }
  };

  const getGVar = (key: string, fallback: any = '') => {
    return state?.graphics_config?.[key] ?? fallback;
  };

  const currentTheme = getGVar('uiTheme', 'Light');
  const isLight = currentTheme === 'Light';
  const isMedium = currentTheme === 'Medium';
  const isDefaultDark = currentTheme === 'Default' || currentTheme === 'Studio Dark';

  const themeVars = {
    bgPage: isLight ? '#eef2f7' : isMedium ? '#5c636e' : isDefaultDark ? '#22262a' : '#0e0e0e',
    bgHeader: isLight ? '#e2e8f0' : isMedium ? '#495057' : isDefaultDark ? '#141414' : '#111111',
    bgBox: isLight ? '#ffffff' : isMedium ? '#6c757d' : isDefaultDark ? '#2a2e33' : '#181818',
    bgInput: isLight ? '#f1f5f9' : isMedium ? '#eef2f7' : isDefaultDark ? '#16181b' : '#0a0a0a',
    textColor: isLight ? '#2b3e50' : '#ffffff',
    headerTextCol: isMedium ? '#e2e8f0' : isLight ? '#2b3e50' : '#ffffff',
    textMuted: isLight ? '#64748b' : isMedium ? '#e2e8f0' : '#aaaaaa',
    borderCol: isLight ? '#dbe2ea' : isMedium ? '#7a828e' : isDefaultDark ? '#3d434a' : '#333333',
    tabHeaderBg: isLight ? '#e2e8f0' : isMedium ? '#495057' : isDefaultDark ? '#141414' : '#000000',
    tabActiveBg: isLight ? '#ffffff' : isMedium ? '#6c757d' : isDefaultDark ? '#2a2e33' : '#141414',
    tabActiveText: '#007bff',
    tabInactiveText: isLight ? '#475569' : '#d0d7de',
    btnSecondaryBg: isLight ? '#e2e8f0' : isMedium ? '#e9ecef' : isDefaultDark ? '#2d3238' : '#1a1a1a',
    btnSecondaryText: isLight ? '#2b3e50' : isMedium ? '#1e293b' : '#ffffff',
    btnSecondaryBorder: isLight ? '#b0c4de' : isMedium ? '#ced4da' : isDefaultDark ? '#4a5059' : '#444444',
    coloredBtnBorder: '1px solid #b0c4de'
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

  const adjClock = async (seconds: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newTime = Math.max(0, currentState.clock_seconds + seconds);
    updateField('clock_seconds', newTime);
  };

  const toggleClock = async () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const isRunning = !currentState.clock_running;
    updateField('clock_running', isRunning);
  };

  const resetClock = () => {
    const totalSecs = periodLengthMin * 60;
    updateField('clock_running', false);
    updateField('clock_seconds', totalSecs);
  };

  const adjStat = (team: 'away' | 'home', type: 'score' | 'sog', val: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const field = `${team}_${type}`;
    const newVal = Math.max(0, currentState[field] + val);
    updateField(field, newVal);
  };

  const triggerRollout = async (num: number) => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const modeName = `rollout${num}`;
    const isActivating = currentState.right_panel_mode !== modeName;
    const newMode = isActivating ? modeName : 'none';
    const txt = getGVar(`rollout${num}_text`, `ROLLOUT ${num}`);
    
    const updated = { ...currentState, right_panel_mode: newMode, right_panel_text: txt };
    setState(updated);
    await broadcastState(updated);
    await supabase.from('scoreboards').update({ right_panel_mode: newMode, right_panel_text: txt }).eq('id', id);
  };

  const triggerDelayedPenalty = async () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const newMode = currentState.right_panel_mode === 'delayedPenalty' ? 'none' : 'delayedPenalty';
    updateField('right_panel_mode', newMode);
  };

  const triggerBanner = async () => {
    const currentState = stateRef.current;
    if (!currentState) return;
    const isActive = !currentState.banner_active;
    const txt = getGVar('banner_text', "FULL WIDTH BANNER");
    const updated = { ...currentState, banner_active: isActive, banner_text: txt };
    setState(updated);
    await broadcastState(updated);
    await supabase.from('scoreboards').update({ banner_active: isActive, banner_text: txt }).eq('id', id);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && !listeningKeyFor) return;

      if (listeningKeyFor) {
        e.preventDefault();
        setHotkey(listeningKeyFor, e.code);
        setListeningKeyFor(null);
        return;
      }

      const matchedAction = Object.keys(hotkeysConfig).find(action => hotkeysConfig[action] === e.code);
      if (!matchedAction) return;

      e.preventDefault();

      switch (matchedAction) {
        case 'toggleClock': toggleClock(); break;
        case 'resetClock': resetClock(); break;
        case 'addMin': adjClock(60); break;
        case 'subMin': adjClock(-60); break;
        case 'addSec': adjClock(1); break;
        case 'subSec': adjClock(-1); break;
        case 'resetAllStats': updateField('away_score', 0); updateField('away_sog', 0); updateField('home_score', 0); updateField('home_sog', 0); break;
        case 'clearPenalties': updateField('penalties', []); break;
        case 'triggerRollout1': triggerRollout(1); break;
        case 'triggerRollout2': triggerRollout(2); break;
        case 'triggerRollout3': triggerRollout(3); break;
        case 'triggerDelayedPenalty': triggerDelayedPenalty(); break;
        case 'triggerBanner': triggerBanner(); break;
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

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hotkeysConfig, listeningKeyFor]);

  const addPenalty = async () => {
    const team = (document.getElementById('sel-pen-team') as HTMLSelectElement).value;
    const plyr = (document.getElementById('inp-pen-plyr') as HTMLInputElement).value || "00";
    const min = parseInt((document.getElementById('inp-pen-min') as HTMLInputElement).value) || 0;
    const sec = parseInt((document.getElementById('inp-pen-sec') as HTMLInputElement).value) || 0;
    const time = (min * 60) + sec;
    
    if (time > 0) {
      const newPenalties = [...(state.penalties || []), { id: Date.now(), team, plyr, time }];
      updateField('penalties', newPenalties);
      (document.getElementById('inp-pen-plyr') as HTMLInputElement).value = '';
    }
  };

  const removePenalty = async (penId: number) => {
    const newPenalties = state.penalties.filter((p: Penalty) => p.id !== penId);
    updateField('penalties', newPenalties);
  };

  const updateShootoutRound = async (index: number, team: 'away' | 'home', val: number) => {
    const newRounds = [...(state.shootout_rounds || Array(10).fill({ away: 0, home: 0 }))];
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
        const newConfig = { 
          ...(state.graphics_config || {}),
          [`${selectedComp}_media_url`]: urlData.publicUrl,
          [`${selectedComp}_is_video`]: isVid,
          [`${selectedComp}_media_loop`]: true,
          [`${selectedComp}_media_ts`]: nowTs
        };

        const updated = { ...state, graphics_config: newConfig };
        setState(updated);
        await broadcastState(updated);
        await supabase.from('scoreboards').update({ graphics_config: newConfig }).eq('id', id);
      }

    } catch (err) {
      console.error("Upload exception handled:", err);
    }
  };

  const clearMedia = async () => {
    const fileInput = document.getElementById(`file-input-${selectedComp}`) as HTMLInputElement;
    if (fileInput) fileInput.value = '';

    const newConfig = { ...(state.graphics_config || {}) };
    delete newConfig[`${selectedComp}_media_url`];
    delete newConfig[`${selectedComp}_is_video`];
    delete newConfig[`${selectedComp}_media_loop`];
    delete newConfig[`${selectedComp}_media_ts`];

    const updated = { ...state, graphics_config: newConfig };
    setState(updated);
    await broadcastState(updated);
    await supabase.from('scoreboards').update({ graphics_config: newConfig }).eq('id', id);
  };

  const selectExportFolder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker();
        setExportFolderHandle(handle);
      } catch (err) {
        console.warn("Folder selection canceled or unsupported:", err);
      }
    } else {
      alert("Folder selection API is not supported in this browser. Downloads will prompt standard save location.");
    }
  };

  const exportProfileJSON = async () => {
    const exportData = {
      scoreboard: state,
      graphics_config: state.graphics_config || {},
      exported_at: new Date().toISOString()
    };
    const jsonStr = JSON.stringify(exportData, null, 2);
    const fileName = `Scoreboard_Profile_${state.away_name}_vs_${state.home_name}_${Date.now()}.json`;

    if (exportFolderHandle) {
      try {
        const fileHandle = await exportFolderHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        alert(`Profile exported successfully to folder: ${fileName}`);
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
        const newScoreboardState = {
          ...state,
          ...(parsed.scoreboard || {}),
          id: id,
          graphics_config: importedConfig
        };

        setState(newScoreboardState);
        await broadcastState(newScoreboardState);
        await supabase.from('scoreboards').update(newScoreboardState).eq('id', id);
        alert("Profile imported and synchronized successfully!");
      } catch (err) {
        alert("Failed to parse Profile JSON file. Ensure it is a valid format.");
      }
    };
    reader.readAsText(file);
  };

  const saveToTemporaryCache = () => {
    localStorage.setItem(`scoreboard_cache_${id}`, JSON.stringify(state));
    alert("Profile saved to local browser temporary cache.");
  };

  const saveAsUserSystemDefault = () => {
    localStorage.setItem(`scoreboard_default_user`, JSON.stringify(state));
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
    setState(restoredState);
    await broadcastState(restoredState);
    await supabase.from('scoreboards').update(restoredState).eq('id', id);
    alert("Restored User Default profile successfully.");
  };

  const factoryReset = async () => {
    if (!confirm("Are you sure you want to reset all scoreboard settings to factory defaults?")) return;
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
    const updated = { ...state, ...defaultData };
    setState(updated);
    await broadcastState(updated);
    await supabase.from('scoreboards').update(defaultData).eq('id', id);
    alert("Scoreboard reset to factory defaults.");
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
  const currentRevSkew = getGVar(`${selectedComp}_rev_skew`, false);
  const chromaActive = getGVar('chromaKeyActive', false);

  const selectStyle: React.CSSProperties = {
    backgroundColor: themeVars.bgInput,
    color: isMedium ? '#1e293b' : themeVars.textColor,
    borderColor: themeVars.borderCol
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
        #control-panel .box { background-color: ${themeVars.bgBox} !important; border-color: ${themeVars.borderCol} !important; }
        #control-panel .box h3, #control-panel .box label { color: ${themeVars.headerTextCol} !important; }
        #control-panel input, #control-panel select { background-color: ${themeVars.bgInput} !important; color: ${isMedium ? '#1e293b' : themeVars.textColor} !important; border-color: ${themeVars.borderCol} !important; }
        #control-panel .tab-headers { background-color: ${themeVars.tabHeaderBg} !important; border-bottom-color: ${themeVars.borderCol} !important; }
        #control-panel .tab-btn { color: ${themeVars.tabInactiveText} !important; }
        #control-panel .tab-btn.active { background-color: ${themeVars.tabActiveBg} !important; color: ${themeVars.tabActiveText} !important; }
        #control-panel .btn-green { background-color: #10b981 !important; color: #ffffff !important; border: ${themeVars.coloredBtnBorder} !important; }
        #control-panel .btn-blue { background-color: #3b82f6 !important; color: #ffffff !important; border: ${themeVars.coloredBtnBorder} !important; }
        #control-panel .btn-orange { background-color: #f59e0b !important; color: #ffffff !important; border: ${themeVars.coloredBtnBorder} !important; }
        #control-panel .btn-red { background-color: #ef4444 !important; color: #ffffff !important; border: ${themeVars.coloredBtnBorder} !important; }
        #control-panel .btn-purple { background-color: #8b5cf6 !important; color: #ffffff !important; border: ${themeVars.coloredBtnBorder} !important; }
        #control-panel .btn-secondary-theme { background-color: ${themeVars.btnSecondaryBg} !important; color: ${themeVars.btnSecondaryText} !important; border: 1px solid ${themeVars.btnSecondaryBorder} !important; }
        #control-panel .sync-group { display: flex; align-items: center; gap: 8px; width: 100%; }
      `}</style>

      <div style={{ background: themeVars.bgHeader, padding: '10px 20px', borderBottom: `1px solid ${themeVars.borderCol}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#007bff', fontWeight: 'bold' }}>H2H OVERLAY SYSTEM</span>
        <span style={{ color: themeVars.textMuted, fontSize: '12px' }}>Live Sync: Active</span>
      </div>

      <div className="tab-headers" style={{ display: 'flex' }}>
        <button className={`tab-btn ${activeTab === 'tab-ops' ? 'active' : ''}`} onClick={() => setActiveTab('tab-ops')}>GAME OPERATIONS</button>
        <button className={`tab-btn ${activeTab === 'tab-graphics' ? 'active' : ''}`} onClick={() => setActiveTab('tab-graphics')}>GRAPHICS SETTINGS</button>
        <button className={`tab-btn ${activeTab === 'tab-hotkeys' ? 'active' : ''}`} onClick={() => setActiveTab('tab-hotkeys')}>HOTKEYS</button>
        <button className={`tab-btn ${activeTab === 'tab-system' ? 'active' : ''}`} onClick={() => setActiveTab('tab-system')}>SYSTEM & PROFILES</button>
      </div>

      {/* GAME OPS TAB */}
      <div id="tab-ops" className={`tab-content ${activeTab === 'tab-ops' ? 'active' : ''}`}>
        <div className="panel-grid">
          
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
              <label>Game Phase:</label>
              <select value={state.period} onChange={(e) => updateField('period', e.target.value)} style={selectStyle}>
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

          <div className="box" style={{ flex: '2 1 450px' }}>
            <h3>TEAM CONTROLS</h3>
            <div className="row" style={{ background: themeVars.bgInput, padding: '10px', borderRadius: '6px' }}>
              <input type="text" value={state.away_name} onChange={(e) => updateField('away_name', e.target.value)} style={{ maxWidth: '80px', flex: 'none', fontWeight: 'bold' }} />
              <button className="btn btn-secondary-theme" onClick={() => adjStat('away', 'score', 1)}>+ GOAL</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('away', 'score', -1)}>-1 G</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('away', 'sog', 1)}>+ SOG</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('away', 'sog', -1)}>-1 SOG</button>
            </div>
            <div className="row" style={{ background: themeVars.bgInput, padding: '10px', borderRadius: '6px' }}>
              <input type="text" value={state.home_name} onChange={(e) => updateField('home_name', e.target.value)} style={{ maxWidth: '80px', flex: 'none', fontWeight: 'bold' }} />
              <button className="btn btn-secondary-theme" onClick={() => adjStat('home', 'score', 1)}>+ GOAL</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('home', 'score', -1)}>-1 G</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('home', 'sog', 1)}>+ SOG</button>
              <button className="btn btn-secondary-theme" onClick={() => adjStat('home', 'sog', -1)}>-1 SOG</button>
            </div>
            <div className="row">
              <button className="btn btn-secondary-theme" onClick={() => { updateField('away_score', 0); updateField('away_sog', 0); }}>RESET AWAY STATS</button>
              <button className="btn btn-secondary-theme" onClick={() => { updateField('home_score', 0); updateField('home_sog', 0); }}>RESET HOME STATS</button>
              <button className="btn btn-secondary-theme" onClick={() => { updateField('away_score', 0); updateField('away_sog', 0); updateField('home_score', 0); updateField('home_sog', 0); }}>RESET ALL STATS</button>
            </div>
          </div>

          <div className="box">
            <h3>PENALTIES & TRIGGERS</h3>
            <div className="row">
                <select id="sel-pen-team" style={{ width: '75px', flex: 'none', ...selectStyle }}><option value="away" style={selectStyle}>Away</option><option value="home" style={selectStyle}>Home</option></select>
                <input type="text" id="inp-pen-plyr" placeholder="Plyr #" style={{ width: '60px', flex: 'none' }} />
                <input type="number" id="inp-pen-min" defaultValue="2" min="0" style={{ width: '50px', flex: 'none' }} /> : 
                <input type="number" id="inp-pen-sec" defaultValue="00" min="0" max="59" style={{ width: '50px', flex: 'none' }} />
                <button className="btn btn-red" style={{ borderRadius: '6px' }} onClick={addPenalty}>ADD</button>
            </div>
            <div className="row"><button className="btn btn-orange" style={{ borderRadius: '6px' }} onClick={() => updateField('penalties', [])}>CLEAR ALL PENALTIES</button></div>
            
            <div style={{ marginTop: '10px', maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {(state.penalties || []).map((p: Penalty) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', background: themeVars.bgInput, color: themeVars.textColor, padding: '6px 12px', borderRadius: '4px', fontSize: '12px', alignItems: 'center', borderLeft: `3px solid ${p.team === 'away' ? '#007bff' : '#dc3545'}` }}>
                  <span><strong>{p.team.toUpperCase()}</strong> #{p.plyr} - {formatTime(p.time)}</span>
                  <button onClick={() => removePenalty(p.id)} style={{ background: 'transparent', color: themeVars.textMuted, border: `1px solid ${themeVars.borderCol}`, borderRadius: '4px', padding: '2px 6px', cursor: 'pointer' }}>✖</button>
                </div>
              ))}
            </div>

            <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />
            
            <div className="row">
                <button className="btn btn-blue" style={{ borderRadius: '6px' }} onClick={() => triggerRollout(1)}>ROLLOUT 1</button>
                <button className="btn btn-blue" style={{ borderRadius: '6px' }} onClick={() => triggerRollout(2)}>ROLLOUT 2</button>
                <button className="btn btn-blue" style={{ borderRadius: '6px' }} onClick={() => triggerRollout(3)}>ROLLOUT 3</button>
            </div>
            <div className="row" style={{ marginTop: '5px' }}>
                <button className="btn btn-orange" style={{ borderRadius: '6px' }} onClick={triggerDelayedPenalty}>DELAYED PENALTY</button>
                <button className="btn btn-purple" style={{ borderRadius: '6px' }} onClick={triggerBanner}>FULL WIDTH BANNER</button>
            </div>
          </div>

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
              <label>Global Scale:</label>
              <input 
                type="range" min="0.5" max="1.5" step="0.05" 
                value={getGVar('bugScale', '1.0')} 
                onChange={(e) => updateGraphicVar('bugScale', e.target.value)} 
              />
            </div>

            <div className="row">
              <label>Skew Angle °:</label>
              <div className="sync-group">
                <input 
                  type="range" min="-30" max="30" 
                  value={getGVar('skewAngle', '0')} 
                  onChange={(e) => updateGraphicVar('skewAngle', e.target.value)} 
                />
                <input 
                  type="number" className="sync-num" 
                  value={getGVar('skewAngle', '0')} 
                  onChange={(e) => updateGraphicVar('skewAngle', e.target.value)} 
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
                  onChange={(e) => updateGraphicVar('cornerRadius', e.target.value)} 
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
              <div className="sync-group">
                <input 
                  type="color" 
                  value={getGVar('bugBorderColor', '#ffffff')} 
                  onChange={(e) => updateGraphicVar('bugBorderColor', e.target.value, true)} 
                  style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                />
                <input 
                  type="text" 
                  value={getGVar('bugBorderColor', '#ffffff')} 
                  onChange={(e) => updateGraphicVar('bugBorderColor', e.target.value, true)} 
                  style={{ width: '75px', textAlign: 'center', fontFamily: 'monospace' }} 
                />
                <input 
                  type="number" min="0" max="15" 
                  value={getGVar('bugBorderWidth', '2')} 
                  onChange={(e) => updateGraphicVar('bugBorderWidth', e.target.value)} 
                  style={{ width: '50px' }} 
                /> px
              </div>
            </div>

            <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />

            <div className="row">
              <label>Rollout 1 Text:</label>
              <input 
                type="text" 
                value={getGVar('rollout1_text', 'ROLLOUT 1')} 
                onChange={(e) => updateGraphicVar('rollout1_text', e.target.value, true)} 
              />
            </div>

            <div className="row">
              <label>Rollout 2 Text:</label>
              <input 
                type="text" 
                value={getGVar('rollout2_text', 'ROLLOUT 2')} 
                onChange={(e) => updateGraphicVar('rollout2_text', e.target.value, true)} 
              />
            </div>

            <div className="row">
              <label>Rollout 3 Text:</label>
              <input 
                type="text" 
                value={getGVar('rollout3_text', 'ROLLOUT 3')} 
                onChange={(e) => updateGraphicVar('rollout3_text', e.target.value, true)} 
              />
            </div>

            <div className="row">
              <label>Banner Text:</label>
              <input 
                type="text" 
                value={getGVar('banner_text', 'FULL WIDTH BANNER')} 
                onChange={(e) => updateGraphicVar('banner_text', e.target.value, true)} 
              />
            </div>
          </div>

          {/* COMPONENT EDITOR - WITH SHOOTOUT TRACKER INCLUDED */}
          <div className="box" style={{ flex: '2 1 600px', borderColor: '#007bff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #007bff', paddingBottom: '10px', marginBottom: '15px' }}>
              <h3 style={{ border: 'none', margin: 0, padding: 0 }}>COMPONENT EDITOR</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ width: 'auto', fontSize: '13px' }}>Select Element:</label>
                <select 
                  value={selectedComp} 
                  onChange={(e) => setSelectedComp(e.target.value)}
                  style={{ width: '200px', flex: 'none', fontWeight: 'bold', ...selectStyle }}
                >
                  <option value="clock" style={selectStyle}>Game Clock</option>
                  <option value="period" style={selectStyle}>Period</option>
                  <option value="awayTeam" style={selectStyle}>Away Team Box</option>
                  <option value="awayScore" style={selectStyle}>Away Score</option>
                  <option value="homeTeam" style={selectStyle}>Home Team Box</option>
                  <option value="homeScore" style={selectStyle}>Home Score</option>
                  <option value="awaySog" style={selectStyle}>Away Shots on Goal</option>
                  <option value="homeSog" style={selectStyle}>Home Shots on Goal</option>
                  <option value="ppPanel" style={selectStyle}>Power Play (Panel BG)</option>
                  <option value="rollout1" style={selectStyle}>Rollout 1</option>
                  <option value="rollout2" style={selectStyle}>Rollout 2</option>
                  <option value="rollout3" style={selectStyle}>Rollout 3</option>
                  <option value="delayedPenalty" style={selectStyle}>Delayed Penalty</option>
                  <option value="banner" style={selectStyle}>Full Width Banner</option>
                  <option value="shootout" style={selectStyle}>Shootout Tracker</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
              
              <div style={{ flex: '1 1 250px' }}>
                <div className="row">
                  <label>Text Color:</label>
                  <div className="sync-group">
                    <input 
                      type="color" 
                      value={getGVar(`${selectedComp}_text_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_color`, e.target.value, true)} 
                      style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                    />
                    <input 
                      type="text" 
                      value={getGVar(`${selectedComp}_text_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_color`, e.target.value, true)} 
                      style={{ width: '75px', fontFamily: 'monospace' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Text Outline Color:</label>
                  <div className="sync-group">
                    <input 
                      type="color" 
                      value={getGVar(`${selectedComp}_stroke_color`, '#000000')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_color`, e.target.value, true)} 
                      style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                    />
                    <input 
                      type="text" 
                      value={getGVar(`${selectedComp}_stroke_color`, '#000000')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_color`, e.target.value, true)} 
                      style={{ width: '75px', fontFamily: 'monospace' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Text Outline (px):</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="0" max="20" 
                      value={getGVar(`${selectedComp}_stroke_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_width`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_stroke_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_stroke_width`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
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

                <div className="row">
                  <label>Font Size (px):</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="8" max="150" 
                      value={getGVar(`${selectedComp}_font_size`, '24')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_font_size`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_font_size`, '24')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_font_size`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Text Skew °:</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="-40" max="40" 
                      value={getGVar(`${selectedComp}_text_skew`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_skew`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_text_skew`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_skew`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label></label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="checkbox" 
                      checked={getGVar(`${selectedComp}_text_global_skew`, false)} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_text_global_skew`, e.target.checked, true)} 
                      style={{ flex: 'none' }} 
                    /> 
                    <span style={{ fontSize: '11px' }}>Use Global Box Angle</span>
                  </div>
                </div>

                <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />

                <div className="row">
                  <label>Border Color:</label>
                  <div className="sync-group">
                    <input 
                      type="color" 
                      value={getGVar(`${selectedComp}_border_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_color`, e.target.value, true)} 
                      style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                    />
                    <input 
                      type="text" 
                      value={getGVar(`${selectedComp}_border_color`, '#ffffff')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_color`, e.target.value, true)} 
                      style={{ width: '75px', fontFamily: 'monospace' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Border Width (px):</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="0" max="20" 
                      value={getGVar(`${selectedComp}_border_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_width`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={getGVar(`${selectedComp}_border_width`, '0')} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_border_width`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <hr style={{ borderColor: themeVars.borderCol, margin: '15px 0' }} />

                <div className="row">
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
                  <div className="row">
                    <label>BG Color 1 (Left):</label>
                    <div className="sync-group">
                      <input 
                        type="color" 
                        value={
                          selectedComp === 'awayTeam' ? state.away_color || '#00468b' :
                          selectedComp === 'homeTeam' ? state.home_color || '#222222' :
                          getGVar(`${selectedComp}_bg_color`, '#111111')
                        } 
                        onChange={(e) => {
                          const val = e.target.value;
                          if (selectedComp === 'awayTeam') updateField('away_color', val);
                          else if (selectedComp === 'homeTeam') updateField('home_color', val);
                          else updateGraphicVar(`${selectedComp}_bg_color`, val, true);
                        }} 
                        style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                      />
                      <input 
                        type="text" 
                        value={
                          selectedComp === 'awayTeam' ? state.away_color || '#00468b' :
                          selectedComp === 'homeTeam' ? state.home_color || '#222222' :
                          getGVar(`${selectedComp}_bg_color`, '#111111')
                        } 
                        onChange={(e) => {
                          const val = e.target.value;
                          if (selectedComp === 'awayTeam') updateField('away_color', val);
                          else if (selectedComp === 'homeTeam') updateField('home_color', val);
                          else updateGraphicVar(`${selectedComp}_bg_color`, val, true);
                        }} 
                        style={{ width: '75px', fontFamily: 'monospace' }}
                      />
                    </div>
                  </div>
                )}

                {bgType === 'linear3' && (
                  <>
                    <div className="row">
                      <label>BG Color 2 (Mid):</label>
                      <div className="sync-group">
                        <input 
                          type="color" 
                          value={getGVar(`${selectedComp}_bg_col3`, '#888888')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col3`, e.target.value, true)} 
                          style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                        />
                        <input 
                          type="text" 
                          value={getGVar(`${selectedComp}_bg_col3`, '#888888')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col3`, e.target.value, true)} 
                          style={{ width: '75px', fontFamily: 'monospace' }}
                        />
                      </div>
                    </div>

                    <div className="row">
                      <label>Mid Position %:</label>
                      <div className="sync-group">
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_mid_pos`, '50')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_pos`, e.target.value)} 
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_mid_pos`, '50')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_pos`, e.target.value)} 
                          style={{ width: '55px' }}
                        />
                      </div>
                    </div>

                    <div className="row">
                      <label>Mid Width %:</label>
                      <div className="sync-group">
                        <input 
                          type="range" min="0" max="100" 
                          value={getGVar(`${selectedComp}_mid_width`, '0')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_width`, e.target.value)} 
                        />
                        <input 
                          type="number" className="sync-num" 
                          value={getGVar(`${selectedComp}_mid_width`, '0')} 
                          onChange={(e) => updateGraphicVar(`${selectedComp}_mid_width`, e.target.value)} 
                          style={{ width: '55px' }}
                        />
                      </div>
                    </div>
                  </>
                )}

                {(bgType === 'linear' || bgType === 'linear3' || bgType === 'radial') && (
                  <div className="row">
                    <label>{bgType === 'linear3' ? 'BG Color 3 (Right):' : 'BG Color 2 (Right):'}</label>
                    <div className="sync-group">
                      <input 
                        type="color" 
                        value={getGVar(`${selectedComp}_bg_col2`, '#000000')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col2`, e.target.value, true)} 
                        style={{ width: '32px', height: '32px', padding: 0, cursor: 'pointer' }}
                      />
                      <input 
                        type="text" 
                        value={getGVar(`${selectedComp}_bg_col2`, '#000000')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_col2`, e.target.value, true)} 
                        style={{ width: '75px', fontFamily: 'monospace' }}
                      />
                    </div>
                  </div>
                )}

                {(bgType === 'linear' || bgType === 'linear3') && (
                  <div className="row">
                    <label>Gradient Angle:</label>
                    <div className="sync-group">
                      <input 
                        type="range" min="0" max="360" 
                        value={getGVar(`${selectedComp}_bg_angle`, '90')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_angle`, e.target.value)} 
                      />
                      <input 
                        type="number" className="sync-num" 
                        value={getGVar(`${selectedComp}_bg_angle`, '90')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_angle`, e.target.value)} 
                        style={{ width: '55px' }}
                      />
                    </div>
                  </div>
                )}

                {bgType !== 'clear' && (
                  <div className="row">
                    <label>BG Transparency:</label>
                    <div className="sync-group">
                      <input 
                        type="range" min="0" max="100" 
                        value={getGVar(`${selectedComp}_bg_alpha`, '100')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_alpha`, e.target.value)} 
                      />
                      <input 
                        type="number" className="sync-num" 
                        value={getGVar(`${selectedComp}_bg_alpha`, '100')} 
                        onChange={(e) => updateGraphicVar(`${selectedComp}_bg_alpha`, e.target.value)} 
                        style={{ width: '55px' }}
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
                      <div style={{ border: `1px solid ${themeVars.borderCol}`, borderRadius: '4px', overflow: 'hidden', background: themeVars.bgInput, height: '80px', position: 'relative' }}>
                        {currentIsVideo ? (
                          <video 
                            key={`${currentMediaUrl}_${currentMediaLoop}_${currentMediaTs}`}
                            src={currentMediaUrl} 
                            autoPlay loop muted playsInline
                            style={{ 
                              width: '100%', height: '100%', objectFit: 'contain', position: 'absolute', top: 0, left: 0,
                              opacity: parseFloat(currentImgAlpha) / 100,
                              transform: `translate(${currentImgX}%, ${currentImgY}%) scale(${parseFloat(currentImgScale) / 100})`
                            }} 
                          />
                        ) : (
                          <img 
                            key={`${currentMediaUrl}_${currentMediaTs}`}
                            src={currentMediaUrl} alt="Media Preview"
                            style={{ 
                              width: '100%', height: '100%', objectFit: 'contain', position: 'absolute', top: 0, left: 0,
                              opacity: parseFloat(currentImgAlpha) / 100,
                              transform: `translate(${currentImgX}%, ${currentImgY}%) scale(${parseFloat(currentImgScale) / 100})`
                            }} 
                          />
                        )}
                      </div>
                    )}
                    
                    <button className="btn btn-secondary-theme" onClick={clearMedia}>CLEAR MEDIA</button>
                  </div>
                </div>

                {currentIsVideo && (
                  <div className="row">
                    <label>Loop Media:</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input 
                        type="checkbox" 
                        checked={currentMediaLoop} 
                        onChange={(e) => {
                          const newLoop = e.target.checked;
                          const nowTs = Date.now();
                          const newConfig = {
                            ...(state.graphics_config || {}),
                            [`${selectedComp}_media_loop`]: newLoop,
                            [`${selectedComp}_media_ts`]: nowTs
                          };
                          setState((prev: any) => ({ ...prev, graphics_config: newConfig }));
                          supabase.from('scoreboards').update({ graphics_config: newConfig }).eq('id', id);
                        }} 
                        style={{ flex: 'none', width: 'auto' }} 
                      />
                      <span style={{ fontSize: '11px' }}>Loops video endlessly</span>
                    </div>
                  </div>
                )}

                <div className="row">
                  <label>Scale %:</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="10" max="500" step="5" 
                      value={currentImgScale} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_scale`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgScale} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_scale`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Alpha %:</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="0" max="100" 
                      value={currentImgAlpha} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_alpha`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgAlpha} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_alpha`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Pos X %:</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="-200" max="200" 
                      value={currentImgX} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_x`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgX} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_x`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Pos Y %:</label>
                  <div className="sync-group">
                    <input 
                      type="range" min="-200" max="200" 
                      value={currentImgY} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_y`, e.target.value)} 
                    />
                    <input 
                      type="number" className="sync-num" 
                      value={currentImgY} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_img_y`, e.target.value)} 
                      style={{ width: '55px' }}
                    />
                  </div>
                </div>

                <div className="row">
                  <label>Reverse Skew:</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input 
                      type="checkbox" 
                      checked={currentRevSkew} 
                      onChange={(e) => updateGraphicVar(`${selectedComp}_rev_skew`, e.target.checked, true)} 
                      style={{ flex: 'none', width: 'auto' }} 
                    />
                    <span style={{ fontSize: '11px' }}>Keeps media upright</span>
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
              {renderHotkeyRow('Delayed Penalty:', 'triggerDelayedPenalty')}
              {renderHotkeyRow('Trigger Banner:', 'triggerBanner')}
            </div>
            <div className="box">
              <h3>AWAY TEAM</h3>
              {renderHotkeyRow('+1 Goal:', 'addAwayGoal')}
              {renderHotkeyRow('-1 Goal:', 'subAwayGoal')}
              {renderHotkeyRow('+1 SOG:', 'addAwaySog')}
              {renderHotkeyRow('-1 SOG:', 'subAwaySog')}
            </div>
            <div className="box">
              <h3>HOME TEAM</h3>
              {renderHotkeyRow('+1 Goal:', 'addHomeGoal')}
              {renderHotkeyRow('-1 Goal:', 'subHomeGoal')}
              {renderHotkeyRow('+1 SOG:', 'addHomeSog')}
              {renderHotkeyRow('-1 SOG:', 'subHomeSog')}
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
                  value={currentTheme === 'Studio Dark' ? 'Default' : currentTheme} 
                  onChange={(e) => updateGraphicVar('uiTheme', e.target.value, true)}
                  style={{ width: '160px', padding: '6px', fontSize: '12px', ...selectStyle }}
                >
                  <option value="Light" style={selectStyle}>Light</option>
                  <option value="Medium" style={selectStyle}>Medium</option>
                  <option value="Default" style={selectStyle}>Default</option>
                  <option value="High Contrast Dark" style={selectStyle}>High Contrast Dark</option>
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
              <button onClick={selectExportFolder} style={{ background: themeVars.btnSecondaryBg, color: themeVars.btnSecondaryText, border: `1px solid ${themeVars.btnSecondaryBorder}`, borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                1. SELECT EXPORT FOLDER
              </button>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button onClick={exportProfileJSON} style={{ flex: 1, background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}>
                  2. EXPORT JSON
                </button>
                <label style={{ flex: 1, background: '#8b5cf6', color: '#fff', borderRadius: '6px', padding: '10px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', textAlign: 'center' }}>
                  IMPORT JSON
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