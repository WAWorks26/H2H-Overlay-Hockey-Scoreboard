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

interface RolloutSeqItem { id?: string; text: string; dur?: string | number; anim?: string; animDur?: string | number; }

// ---------- Text sequences ----------
// Which graphics_config sequence a right-panel mode reads. Away/Home goals share one.
const seqKeyForMode = (mode: string) =>
  mode.startsWith('rollout') ? mode :
  (mode === 'delayedPenalty' || mode === 'awayDelayed' || mode === 'homeDelayed') ? 'delayedPenalty' :
  (mode === 'awayTimeout' || mode === 'homeTimeout') ? 'timeout' :
  mode === 'fourOnFour' ? 'fourOnFour' :
  (mode === 'awayGoal' || mode === 'homeGoal' || mode === 'goal') ? 'goal' : '';

const resolveSeq = (gc: Record<string, any>, seqKey: string, teamName?: string): RolloutSeqItem[] => {
  if (!seqKey) return [];
  const raw = gc?.[`${seqKey}_seq`];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it: any) => it && String(it.text ?? '').trim() !== '')
    .map((it: any) => ({ ...it, text: teamName !== undefined ? String(it.text).replace(/{TEAM}/g, teamName) : String(it.text) }));
};

const isSeqLoop = (gc: Record<string, any>, seqKey: string) => {
  const v = gc?.[`${seqKey}_seq_loop`];
  return v === undefined || v === true || v === 'true';
};

// Steps through a sequence locally. Restarts only when the active element or the
// timing changes (not on text edits). Returns the current index and a cycle count
// used in React keys so each text's animation replays.
function useTextSequence(items: RolloutSeqItem[], loop: boolean, activeKey: string) {
  const sig = `${activeKey}|${loop}|${items.length}|${items.map(it => it.dur).join(',')}`;
  const [pos, setPos] = useState({ sig: '', index: 0, cycle: 0 });

  useEffect(() => {
    setPos({ sig, index: 0, cycle: 0 });
    if (!activeKey || items.length < 2) return;

    let index = 0;
    let cycle = 0;
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const d = Math.max(0.3, parseFloat(String(items[index]?.dur ?? '3')) || 3);
      timer = setTimeout(() => {
        if (index + 1 >= items.length) {
          if (!loop) return; // hold the last text
          index = 0;
        } else {
          index++;
        }
        cycle++;
        setPos({ sig, index, cycle });
        schedule();
      }, d * 1000);
    };
    schedule();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const current = pos.sig === sig;
  return {
    index: current ? Math.min(pos.index, Math.max(0, items.length - 1)) : 0,
    cycle: current ? pos.cycle : 0,
  };
}

// ---------- Media cache ----------
// Every background image/video is downloaded ONCE, in full, into memory (blob URL)
// and into the browser's persistent Cache Storage. After that, playback never touches
// the network: no buffering on a weak rink connection, and an OBS restart reloads
// the media from disk instead of downloading it again.
const MEDIA_CACHE_NAME = 'h2h-media-v1';
const MEDIA_KEYS = ['awayGoal', 'homeGoal', 'goal', 'ppPanel', 'awayPP', 'homePP', 'delayedPenalty', 'fourOnFour', 'rollout1', 'rollout2', 'rollout3', 'banner', 'banner2', 'banner3', 'awayTeam', 'homeTeam', 'clock', 'period'];
const blobUrlCache = new Map<string, string>();          // remote URL -> blob: URL
const blobLoads = new Map<string, Promise<string>>();    // in-flight downloads

const loadMediaBlob = (url: string): Promise<string> => {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return Promise.resolve(url);
  const ready = blobUrlCache.get(url);
  if (ready) return Promise.resolve(ready);
  const pending = blobLoads.get(url);
  if (pending) return pending;

  const p = (async () => {
    try {
      let res: Response | undefined;
      let cache: Cache | undefined;
      if (typeof caches !== 'undefined') {
        try {
          cache = await caches.open(MEDIA_CACHE_NAME);
          res = await cache.match(url);
        } catch { /* Cache Storage unavailable (e.g. private mode) - memory only */ }
      }
      if (!res) {
        const net = await fetch(url, { mode: 'cors', cache: 'force-cache' });
        if (!net.ok) throw new Error(`HTTP ${net.status}`);
        if (cache) { try { await cache.put(url, net.clone()); } catch { /* quota etc. */ } }
        res = net;
      }
      const blobUrl = URL.createObjectURL(await res.blob());
      blobUrlCache.set(url, blobUrl);
      return blobUrl;
    } catch (err) {
      console.warn('[overlay] media cache failed, streaming from network instead:', url, err);
      blobLoads.delete(url); // allow a retry later
      return url;
    }
  })();
  blobLoads.set(url, p);
  return p;
};

// Style 3 (Compact Split Bug) team-name column width
const S3_TEAM_W = 178;

// Longest we will hold back a rollout / banner while its background video buffers.
const MEDIA_WAIT_MS = 250;

// Mirrors getCompVar's media inheritance (goal panels fall back to the team media).
const resolveMedia = (gc: Record<string, any>, key: string): { url: string; isVid: boolean } => {
  const direct = gc?.[`${key}_media_url`];
  if (direct && key !== 'awayPP' && key !== 'homePP') return { url: direct as string, isVid: !!gc[`${key}_is_video`] };
  // Timeouts draw with the team's power play panel, which falls back to the team logo
  if (key === 'awayTimeout' || key === 'homeTimeout') return resolveMedia(gc, key === 'awayTimeout' ? 'awayPP' : 'homePP');
  if (key === 'awayDelayed' || key === 'homeDelayed') return resolveMedia(gc, 'delayedPenalty');
  if (key === 'fourOnFour') return resolveMedia(gc, 'delayedPenalty'); // no own media: same look as delayed penalty
  if (key === 'awayPP' || key === 'homePP') {
    const useTeam = gc?.[`${key}_use_team_media`] ?? gc?.ppPanel_use_team_media;
    const team = key === 'awayPP' ? 'awayTeam' : 'homeTeam';
    if (useTeam !== false && useTeam !== 'false' && gc?.[`${team}_media_url`]) {
      return { url: gc[`${team}_media_url`] as string, isVid: !!gc[`${team}_is_video`] };
    }
  }
  if ((key === 'awayPP' || key === 'homePP') && direct) return { url: direct as string, isVid: !!gc[`${key}_is_video`] };
  if (key === 'awayGoal' || key === 'homeGoal') {
    const team = key === 'awayGoal' ? 'awayTeam' : 'homeTeam';
    const inherited = gc?.[`${team}_media_url`];
    if (inherited) return { url: inherited as string, isVid: !!gc[`${team}_is_video`] };
  }
  return { url: '', isVid: false };
};

export default function OBSOverlayPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<ScoreboardState | null>(null);

  const stateRef = useRef<ScoreboardState | null>(null);

  const [panelExiting, setPanelExiting] = useState(false);
  const [displayedPanelMode, setDisplayedPanelMode] = useState('none');
  const [displayedPanelText, setDisplayedPanelText] = useState('');

  const [bannerExiting, setBannerExiting] = useState(false);
  // Which banner (component key) is in the banner slot: 'banner' | 'banner2' | 'banner3'
  const [displayedBannerKey, setDisplayedBannerKey] = useState('banner');
  const bannerKeyRef = useRef('banner');
  const [displayedBannerActive, setDisplayedBannerActive] = useState(false);
  const [displayedBannerText, setDisplayedBannerText] = useState('');

  const activePanelModeRef = useRef('none');
  const bannerActiveRef = useRef(false);

  // Ordering guards: the same update arrives via up to three paths (local
  // BroadcastChannel, Supabase broadcast, Postgres change echo) at different
  // speeds. Without these, a late copy of an OLD state overwrites a newer one,
  // which is what made penalties reappear after CLEAR ALL and made the PP
  // panel flicker / vanish.
  const lastSeqRef = useRef<number>(0);
  const lastBroadcastAtRef = useRef<number>(0);
  const panelExitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const bannerExitTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Hidden, fully-buffered copies of every background video (keyed by URL) so a
  // rollout's video is already in the media cache when the panel mounts.
  const preloadVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const panelShowTokenRef = useRef(0);
  const bannerShowTokenRef = useRef(0);

  // Resolves when the video can play, or after MEDIA_WAIT_MS — whichever is first.
  const waitForMedia = (gcfg: Record<string, any>, key: string): Promise<void> => {
    const { url, isVid } = resolveMedia(gcfg || {}, key);
    if (!url || !isVid) return Promise.resolve();
    if (blobUrlCache.has(url)) {
      const vid = preloadVideosRef.current.get(url);
      if (!vid || vid.readyState >= 3) return Promise.resolve();
    }
    // Wait for the cached copy (and its decoder) - never longer than MEDIA_WAIT_MS
    return new Promise(resolve => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(t); resolve(); };
      const t = setTimeout(finish, MEDIA_WAIT_MS);
      loadMediaBlob(url).then(() => {
        const vid = preloadVideosRef.current.get(url);
        if (!vid || vid.readyState >= 3) return finish();
        const onReady = () => { vid.removeEventListener('canplay', onReady); finish(); };
        vid.addEventListener('canplay', onReady);
      });
    });
  };

  // Blob URLs for downloaded media (state so components re-render onto the local copy)
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const mediaUrlsKey = Array.from(new Set(
    MEDIA_KEYS.map(k => resolveMedia(state?.graphics_config || {}, k).url).filter(Boolean)
  )).join('|');

  useEffect(() => {
    const urls = mediaUrlsKey ? mediaUrlsKey.split('|') : [];
    let cancelled = false;

    const run = () => urls.forEach(u => {
      loadMediaBlob(u).then(local => {
        if (!cancelled && local !== u) setBlobUrls(prev => (prev[u] === local ? prev : { ...prev, [u]: local }));
      });
    });
    run();

    // Retry anything that failed (e.g. Wi-Fi dropped) every 15 s
    const retry = setInterval(() => {
      if (urls.some(u => !blobUrlCache.has(u))) run();
    }, 15000);

    // Drop cached files this scoreboard no longer uses (replaced uploads)
    if (id && state?.graphics_config && typeof caches !== 'undefined') {
      caches.open(MEDIA_CACHE_NAME)
        .then(c => c.keys().then(reqs => reqs.forEach(r => {
          if (r.url.includes(`/${id}/`) && !urls.includes(r.url)) c.delete(r);
        })))
        .catch(() => {});
    }

    return () => { cancelled = true; clearInterval(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaUrlsKey, id]);

  // Local copy if downloaded, otherwise the network URL
  const mediaSrc = (u: string) => blobUrls[u] || blobUrlCache.get(u) || u;

  useEffect(() => {
    params.then(p => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const fetchState = async () => {
      const { data } = await supabase.from('scoreboards').select('*').eq('id', id).single();
      // If live broadcasts already arrived, the DB row is older than what we show
      if (data && lastSeqRef.current > 0) return;
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
        const bKey = data.graphics_config?.active_banner || 'banner';
        bannerKeyRef.current = bKey;
        setDisplayedBannerKey(bKey);
        setDisplayedBannerActive(bActive);
        setDisplayedBannerText(data.banner_text || '');
        bannerActiveRef.current = bActive;
      }
    };
    fetchState();

    const handleStateUpdate = (incomingState: any, source: 'broadcast' | 'db') => {
      if (source === 'db') {
        // DB echoes carry whatever clock/penalties were last written, which is
        // usually seconds behind. Only trust them when the control panel is not
        // actively broadcasting (e.g. it is closed).
        if (Date.now() - lastBroadcastAtRef.current < 5000) return;
      } else {
        const seq = Number(incomingState?._seq) || 0;
        if (seq > 0) {
          if (seq <= lastSeqRef.current) return; // stale or duplicate copy
          lastSeqRef.current = seq;
        }
        lastBroadcastAtRef.current = Date.now();
      }

      const mergedState = { ...incomingState };
      delete mergedState._seq;

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
      const showPanel = () => {
        // A new rollout arrived mid-exit: cancel the pending hide so it can't
        // wipe out the panel that was just shown.
        if (panelExitTimerRef.current) {
          clearTimeout(panelExitTimerRef.current);
          panelExitTimerRef.current = null;
        }
        setPanelExiting(false);
        setDisplayedPanelMode(newMode);
        setDisplayedPanelText(mergedState.right_panel_text || '');
        activePanelModeRef.current = newMode;
      };

      if (newMode === 'none') panelShowTokenRef.current++; // cancel any pending show
      if (newMode === 'none' && activePanelModeRef.current !== 'none') {
        if (!panelExitTimerRef.current) {
          setPanelExiting(true);
          panelExitTimerRef.current = setTimeout(() => {
            panelExitTimerRef.current = null;
            setPanelExiting(false);
            setDisplayedPanelMode('none');
            activePanelModeRef.current = 'none';
          }, 500);
        }
      } else if (newMode !== 'none') {
        if (newMode === activePanelModeRef.current) {
          showPanel(); // same panel, text update only
        } else {
          const token = ++panelShowTokenRef.current;
          waitForMedia(mergedState.graphics_config, newMode).then(() => {
            if (token === panelShowTokenRef.current) showPanel();
          });
        }
      }

      const isBannerOn = !!mergedState.banner_active;
      const newBannerKey = mergedState.graphics_config
        ? (mergedState.graphics_config.active_banner || 'banner')
        : bannerKeyRef.current;

      const showBanner = (key: string) => {
        bannerActiveRef.current = true;
        bannerKeyRef.current = key;
        const token = ++bannerShowTokenRef.current;
        waitForMedia(mergedState.graphics_config, key).then(() => {
          if (token !== bannerShowTokenRef.current || !bannerActiveRef.current) return;
          if (bannerExitTimerRef.current) {
            clearTimeout(bannerExitTimerRef.current);
            bannerExitTimerRef.current = null;
          }
          setDisplayedBannerKey(key);
          setBannerExiting(false);
          setDisplayedBannerActive(true);
          setDisplayedBannerText(mergedState.banner_text || '');
        });
      };

      if (!isBannerOn && bannerActiveRef.current) {
        bannerShowTokenRef.current++; // cancel a banner still waiting on its media
        setBannerExiting(true);
        bannerActiveRef.current = false;
        if (bannerExitTimerRef.current) clearTimeout(bannerExitTimerRef.current);
        bannerExitTimerRef.current = setTimeout(() => {
          bannerExitTimerRef.current = null;
          setBannerExiting(false);
          setDisplayedBannerActive(false);
        }, 500);
      } else if (isBannerOn && !bannerActiveRef.current) {
        showBanner(newBannerKey);
      } else if (isBannerOn && newBannerKey !== bannerKeyRef.current) {
        // Swap to another banner: retract the current one, then bring in the new one
        bannerKeyRef.current = newBannerKey;
        const token = ++bannerShowTokenRef.current;
        setBannerExiting(true);
        if (bannerExitTimerRef.current) clearTimeout(bannerExitTimerRef.current);
        bannerExitTimerRef.current = setTimeout(() => {
          bannerExitTimerRef.current = null;
          if (token !== bannerShowTokenRef.current) return;
          setBannerExiting(false);
          setDisplayedBannerActive(false);
          showBanner(newBannerKey);
        }, 500);
      } else if (isBannerOn) {
        setDisplayedBannerText(mergedState.banner_text || '');
      }
    };

    const channel = supabase.channel(`scoreboard_${id}`)
      .on('broadcast', { event: 'STATE_UPDATE' }, ({ payload }) => handleStateUpdate(payload, 'broadcast'))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scoreboards', filter: `id=eq.${id}` },
        (payload) => handleStateUpdate(payload.new, 'db')
      ).subscribe();

    let localChannel: BroadcastChannel | null = null;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      localChannel = new BroadcastChannel(`scoreboard_local_${id}`);
      localChannel.onmessage = (event) => {
        if (event.data) handleStateUpdate(event.data, 'broadcast');
      };
    }

    return () => {
      supabase.removeChannel(channel);
      if (localChannel) localChannel.close();
      if (panelExitTimerRef.current) clearTimeout(panelExitTimerRef.current);
      if (bannerExitTimerRef.current) clearTimeout(bannerExitTimerRef.current);
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

  // ---------- Text sequences ----------
  const gcLive = state?.graphics_config || {};
  const panelSeqKey = seqKeyForMode(displayedPanelMode);
  // Team name for {TEAM} in goal / timeout / per-team delayed penalty texts
  const goalTeam =
    ['awayGoal', 'awayTimeout', 'awayDelayed'].includes(displayedPanelMode) ? (state?.away_name || 'AWAY') :
    ['homeGoal', 'homeTimeout', 'homeDelayed'].includes(displayedPanelMode) ? (state?.home_name || 'HOME') :
    displayedPanelMode === 'delayedPenalty' ? '' : undefined;
  const panelSeqItems = resolveSeq(gcLive, panelSeqKey, goalTeam);
  const panelSeq = useTextSequence(panelSeqItems, isSeqLoop(gcLive, panelSeqKey), panelSeqKey ? displayedPanelMode : '');

  // Power play side ('away' | 'home' | '') computed here too, because hooks must run
  // before the early return below.
  const ppSideLive = (() => {
    if (!state || displayedPanelMode !== 'none') return '';
    const pens = state.penalties || [];
    const a = pens.filter((p: any) => p.team === 'away').length;
    const h = pens.filter((p: any) => p.team === 'home').length;
    if (a === h) return '';
    return h > a ? 'away' : 'home';
  })();
  const ppSeqItemsRaw = ppSideLive ? resolveSeq(gcLive, 'ppPanel') : [];
  const ppSeq = useTextSequence(ppSeqItemsRaw, isSeqLoop(gcLive, 'ppPanel'), ppSideLive ? `pp_${ppSideLive}` : '');

  const bannerSeqItems = displayedBannerActive ? resolveSeq(gcLive, displayedBannerKey) : [];
  const bannerSeq = useTextSequence(bannerSeqItems, isSeqLoop(gcLive, displayedBannerKey), displayedBannerActive ? displayedBannerKey : '');

  if (!state) return null;

  const formatTime = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;

  const awayPens = (state.penalties || []).filter(p => p.team === 'away');
  const homePens = (state.penalties || []).filter(p => p.team === 'home');

  let ppActive = false;
  let ppTeam = '';
  let ppTimeStr = '';
  let ppSituationStr = '';
  let ppSide: '' | 'away' | 'home' = '';
  
  if (displayedPanelMode === 'none' && (awayPens.length > 0 || homePens.length > 0)) {
    if (awayPens.length !== homePens.length) {
      ppActive = true;
      const isAwayPP = homePens.length > awayPens.length;
      ppSide = isAwayPP ? 'away' : 'home';
      ppTeam = isAwayPP ? state.away_name : state.home_name;
      const lowestTime = isAwayPP ? Math.min(...homePens.map(p=>p.time)) : Math.min(...awayPens.map(p=>p.time));
      ppTimeStr = formatTime(lowestTime);
      ppSituationStr = `${5 - awayPens.length} VS ${5 - homePens.length}`;
    }
  }

  const currentMode = displayedPanelMode;
  const isRollout = currentMode.startsWith('rollout');
  const isDelayed = currentMode === 'delayedPenalty' || currentMode === 'awayDelayed' || currentMode === 'homeDelayed';
  const isTimeout = currentMode === 'awayTimeout' || currentMode === 'homeTimeout';
  const isFourOnFour = currentMode === 'fourOnFour';
  const isAwayGoal = currentMode === 'awayGoal';
  const isHomeGoal = currentMode === 'homeGoal';
  const isGoal = isAwayGoal || isHomeGoal || currentMode === 'goal';

  const showRightPanel = isRollout || isDelayed || isTimeout || isFourOnFour || ppActive || isGoal || panelExiting;

  // Current side-panel text: sequence item if one is configured, else the plain text.
  const panelHasText = isRollout || isGoal || isDelayed || isTimeout || isFourOnFour;
  const basePanelText = (
    isDelayed ? (gc.delayedPenalty_text || 'DELAYED PENALTY') :
    isTimeout ? (gc.timeout_text || 'TIMEOUT {TEAM}') :
    isFourOnFour ? (gc.fourOnFour_text || '4 ON 4') :
    (displayedPanelText || state.right_panel_text || '')
  ).replace(/{TEAM}/g, goalTeam ?? '').replace(/\s{2,}/g, ' ').trim();
  const activeSeqItem = panelHasText && panelSeqItems.length > 0 ? panelSeqItems[panelSeq.index] : null;
  // {TIME} = shortest penalty still running (live). Keys below use the unfilled text,
  // so the countdown doesn't replay the text animation every second.
  const shortestPen = (state.penalties || []).length > 0 ? Math.min(...(state.penalties || []).map(p => p.time)) : 0;
  const fillTime = (t: string) => t.includes('{TIME}') ? t.replace(/{TIME}/g, shortestPen > 0 ? formatTime(shortestPen) : '') : t;
  const panelText = fillTime(activeSeqItem ? activeSeqItem.text : basePanelText);
  const panelTextKey = activeSeqItem
    ? `seq_${panelSeq.index}_${panelSeq.cycle}_${activeSeqItem.text}`
    : `${basePanelText}`;
  const panelAnimOverride = activeSeqItem ? { anim: activeSeqItem.anim, dur: activeSeqItem.animDur } : undefined;
  // Every text the panel may show; the panel is sized to the longest so it never shrinks mid-sequence.
  const panelSizerTexts: string[] = panelHasText
    ? (panelSeqItems.length > 0 ? panelSeqItems.map(it => fillTime(it.text)) : [fillTime(basePanelText)])
    : [];

  // Banner text (sequence-aware)
  const activeBannerItem = bannerSeqItems.length > 0 ? bannerSeqItems[bannerSeq.index] : null;
  const bannerText = activeBannerItem ? activeBannerItem.text : (displayedBannerText || state.banner_text);
  const bannerTextKey = activeBannerItem
    ? `seq_${bannerSeq.index}_${bannerSeq.cycle}_${activeBannerItem.text}`
    : `${displayedBannerText}_${state.banner_text}`;
  const bannerAnimOverride = activeBannerItem ? { anim: activeBannerItem.anim, dur: activeBannerItem.animDur } : undefined;

  // Power play text: sequence / custom text with {TEAM} {TIME} {SITUATION} filled in live.
  // With no custom text configured, the original PP layouts are used unchanged.
  const fillPP = (t: string) =>
    String(t).replace(/{TEAM}/g, ppTeam || '').replace(/{TIME}/g, ppTimeStr).replace(/{SITUATION}/g, ppSituationStr);
  const ppCustomText = gc.ppPanel_text;
  const ppItems: RolloutSeqItem[] = ppSeqItemsRaw.length > 0
    ? ppSeqItemsRaw
    : (ppCustomText && String(ppCustomText).trim() !== '' ? [{ text: String(ppCustomText) }] : []);
  const ppCustom = ppActive && ppItems.length > 0;
  const activePPItem = ppCustom ? ppItems[Math.min(ppSeq.index, ppItems.length - 1)] : null;
  const ppText = activePPItem ? fillPP(activePPItem.text) : `${ppTeam} PP ${ppTimeStr}`;

  // What the side panel actually shows (PP or rollout/goal/delayed)
  const sideText = ppActive ? ppText : panelText;
  // PP key excludes the ticking time so the animation doesn't replay every second
  const sideTextKey = ppActive ? `pp_${ppSide}_${ppSeq.index}_${ppSeq.cycle}` : panelTextKey;
  const sideAnimOverride = ppActive
    ? (activePPItem ? { anim: activePPItem.anim, dur: activePPItem.animDur } : undefined)
    : panelAnimOverride;
  const sideSizerTexts = ppActive ? (ppCustom ? ppItems.map(it => fillPP(it.text)) : []) : panelSizerTexts;

  // Side-panel text in a grid cell: invisible copies of every possible text share the
  // cell with the visible (animated) one, so the panel is as wide as the longest
  // text and holds that width while shorter texts play.
  const renderPanelText = (spanKey: string, spanStyle: React.CSSProperties, content: React.ReactNode, sizers: string[]) => (
    <span style={{ display: 'inline-grid', position: 'relative', zIndex: 3, flexShrink: 0, alignItems: 'center', marginLeft: spanStyle.marginLeft, marginRight: spanStyle.marginRight, ...(ppActive ? { fontVariantNumeric: 'tabular-nums' } : {}) }}>
      {sizers.map((t, i) => (
        <span
          key={`sz_${i}`}
          aria-hidden="true"
          style={{ gridArea: '1 / 1', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'nowrap', paddingRight: spanStyle.paddingRight, fontSize: spanStyle.fontSize, lineHeight: spanStyle.lineHeight }}
        >
          {t}
        </span>
      ))}
      <span key={spanKey} style={{ ...spanStyle, gridArea: '1 / 1', justifySelf: 'center' }}>{content}</span>
    </span>
  );

  // Elements whose background follows a team box, and which team
  const TEAM_BG_SIDE: Record<string, 'away' | 'home'> = {
    awayPP: 'away', homePP: 'home', awayGoal: 'away', homeGoal: 'home', awayDelayed: 'away', homeDelayed: 'home',
  };
  const TEAM_BG_PROPS = ['bg_type', 'bg_color', 'bg_col2', 'bg_col3', 'col1_alpha', 'col2_alpha', 'col3_alpha', 'bg_angle', 'mid_pos', 'mid_width', 'bg_alpha'];
  // "Match Team Box Background" setting (on unless unticked). Delayed penalties share one setting.
  const teamBgOn = (compKey: string) => {
    const k = (compKey === 'awayDelayed' || compKey === 'homeDelayed') ? 'delayedPenalty' : compKey;
    const v = gc[`${k}_use_team_bg`];
    return v !== false && v !== 'false';
  };

  const activePanelKey = 
    ppActive ? (ppSide === 'away' ? 'awayPP' : 'homePP') :
    isAwayGoal ? 'awayGoal' :
    isHomeGoal ? 'homeGoal' :
    isGoal ? 'goal' :
    currentMode === 'awayDelayed' ? 'awayDelayed' :
    currentMode === 'homeDelayed' ? 'homeDelayed' :
    isDelayed ? 'delayedPenalty' :
    isFourOnFour ? 'fourOnFour' :
    currentMode === 'awayTimeout' ? 'awayPP' :
    currentMode === 'homeTimeout' ? 'homePP' :
    isRollout ? currentMode : 'rollout1';

  const getCompVar = (compKey: string, propSuffix: string, fallback: any = undefined): any => {
    // ---- Team-linked rollouts take their background from the team box ----
    // Power play + timeout (awayPP/homePP), goals, and per-team delayed penalties
    // use the Away/Home Team Box background unless "Match Team Box Background" is
    // unticked for that element in the Component Editor.
    const side = TEAM_BG_SIDE[compKey];
    if (side && TEAM_BG_PROPS.includes(propSuffix) && teamBgOn(compKey)) {
      const tk = side === 'away' ? 'awayTeam' : 'homeTeam';
      const v = gc[`${tk}_${propSuffix}`];
      if (v !== undefined && v !== '') return v;
      if (propSuffix === 'bg_color') return side === 'away' ? (state.away_color || '#00468b') : (state.home_color || '#111111');
      if (propSuffix === 'bg_type') return 'solid';
      return fallback;
    }
    // Per-team delayed penalty: everything else comes from the Delayed Penalty element
    if (compKey === 'awayDelayed' || compKey === 'homeDelayed') return getCompVar('delayedPenalty', propSuffix, fallback);

    // Power play panels: one per team (awayPP / homePP) so each team's logo can be
    // framed independently. Lookup order:
    //   media url / video / loop: PP team's team-box media (if "Team Logo BG" is on and
    //     the team has media) -> this panel's own -> shared ppPanel
    //   everything else: this panel's own -> shared ppPanel (older settings) ->
    //     the team box's value for logo scale/alpha/position -> default
    if (compKey === 'awayPP' || compKey === 'homePP') {
      const has = (v: any) => v !== undefined && v !== '';
      const team = compKey === 'awayPP' ? 'awayTeam' : 'homeTeam';
      const useTeamRaw = has(gc[`${compKey}_use_team_media`]) ? gc[`${compKey}_use_team_media`] : gc.ppPanel_use_team_media;
      const useTeam = useTeamRaw !== false && useTeamRaw !== 'false';
      const teamUrl = gc[`${team}_media_url`];

      if (useTeam && teamUrl && ['media_url', 'is_video', 'media_loop'].includes(propSuffix)) {
        const v = gc[`${team}_${propSuffix}`];
        return has(v) ? v : fallback;
      }
      const own = gc[`${compKey}_${propSuffix}`];
      if (has(own)) return own;
      const shared = gc[`ppPanel_${propSuffix}`];
      if (has(shared)) return shared;
      if (useTeam && teamUrl && ['img_alpha', 'img_scale', 'img_x', 'img_y', 'use_global_skew'].includes(propSuffix)) {
        const v = gc[`${team}_${propSuffix}`];
        if (has(v)) return v;
      }
      return fallback;
    }

    const directVal = gc[`${compKey}_${propSuffix}`];

    // 4 on 4 panel looks like the Delayed Penalty panel until it is customised
    if (compKey === 'fourOnFour' && (directVal === undefined || directVal === '') && propSuffix !== 'text') {
      const dp = gc[`delayedPenalty_${propSuffix}`];
      if (dp !== undefined && dp !== '') return dp;
    }
    if ((compKey === 'banner2' || compKey === 'banner3') && (directVal === undefined || directVal === '')
        && !['media_url', 'is_video', 'text'].includes(propSuffix)) {
      const b1 = gc[`banner_${propSuffix}`];
      if (b1 !== undefined && b1 !== '') return b1;
    }
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

  const getCompBackgroundStyle = (compKey: string, fallbackColor: string): React.CSSProperties => {
    if (compKey === 'fourOnFour' && teamBgOn('fourOnFour')) {
      // Away team box color fading into the home team box color
      const awayC = gc.awayTeam_bg_color || state.away_color || '#00468b';
      const homeC = gc.homeTeam_bg_color || state.home_color || '#111111';
      return { backgroundImage: `linear-gradient(90deg, ${hexToRgba(awayC, 100)} 0%, ${hexToRgba(awayC, 100)} 30%, ${hexToRgba(homeC, 100)} 70%, ${hexToRgba(homeC, 100)} 100%)` };
    }
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

  // Penalty chips under the bug use the team box background (solid team color if the box is clear)
  const penChipBg = (teamKey: string, teamColor: string): React.CSSProperties =>
    getCompVar(teamKey, 'bg_type', 'solid') === 'clear' ? { backgroundColor: teamColor } : getCompBackgroundStyle(teamKey, teamColor);

  const getCompStyle = (compKey: string, defaultBg: string, defaultTextCol: string, defaultSize: number) => {
    const color = getCompVar(compKey, 'text_color', defaultTextCol);
    const fontSize = `${getCompVar(compKey, 'font_size', defaultSize)}px`;
    const fontFam = getCompVar(compKey, 'font_family', 'var(--global-font)');
    
    const strokeWidthNum = parseInt(getCompVar(compKey, 'stroke_width', 0)) || 0;
    const strokeColor = getCompVar(compKey, 'stroke_color', '#000000');
    
    let shadowCss = 'none';
    if (strokeWidthNum > 0) {
      const sw = strokeWidthNum;
      const sc = strokeColor;
      shadowCss = `
        -${sw}px -${sw}px 0 ${sc},
         0px    -${sw}px 0 ${sc},
         ${sw}px -${sw}px 0 ${sc},
         ${sw}px  0px    0 ${sc},
         ${sw}px  ${sw}px 0 ${sc},
         0px     ${sw}px 0 ${sc},
        -${sw}px  ${sw}px 0 ${sc},
        -${sw}px  0px    0 ${sc}
      `;
    }

    const bgAlpha = parseFloat(getCompVar(compKey, 'bg_alpha', 100)) / 100;

    return {
      color: color,
      fontSize: fontSize,
      fontFamily: fontFam,
      border: 'none', 
      textShadow: shadowCss,
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
        {/* clipPath + isolation make this a hard clip that also applies to GPU-composited
            children (video / transformed images). overflow:hidden alone lets a composited
            media layer snap 1-2px past the box edge inside the skewed bar. */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', zIndex: 0, clipPath: 'inset(0)', isolation: 'isolate', contain: 'paint' }}>
          <div style={{ ...fillStyle, zIndex: colorZIndex, ...colorStyle }} />
          {url && (
            <div style={{ ...fillStyle, zIndex: mediaZIndex, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isVid ? (
                <video 
                  key={`vid_${url}`} 
                  src={mediaSrc(url)}
                  autoPlay loop={isLoop} muted playsInline preload="auto"
                  style={{
                    width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none',
                    opacity: imgAlpha, transformOrigin: 'center',
                    transform: `translate(${imgX}%, ${imgY}%) scale(${imgScale}) skewX(${skewVal}deg)`
                  }}
                />
              ) : (
                <img 
                  key={`img_${url}`}
                  src={mediaSrc(url)} alt="Background Media" 
                  style={{
                    width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none',
                    opacity: imgAlpha, transformOrigin: 'center',
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

  // Keyframes for intensity-driven animations are generated per intensity value
  // and injected in a <style> at the end of the render. Because the intensity is
  // part of the keyframe NAME, moving the slider changes the animation name, which
  // makes the browser replay it immediately (live preview), and the values are
  // baked in rather than relying on var() inside @keyframes.
  const dynKeyframes = new Map<string, string>();

  const buildIntensityKeyframes = (type: string, i: number): string | null => {
    const T = 'var(--text-skew, skewX(0deg))'; // keeps the text's own skew during the animation
    const name = `ta_${type}_${Math.round(i * 100)}`;
    if (dynKeyframes.has(name)) return name;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    let body = '';
    switch (type) {
      case 'zoomIn': // starts smaller the higher the intensity
        body = `0%{transform:${T} scale(${r(Math.max(0.02, 1 - 0.5 * i))});opacity:0}100%{transform:${T} scale(1);opacity:1}`; break;
      case 'zoomOut': // starts larger the higher the intensity
        body = `0%{transform:${T} scale(${r(1 + 0.5 * i)});opacity:0}100%{transform:${T} scale(1);opacity:1}`; break;
      case 'enlarge': // bigger growth plus a proportional overshoot
        body = `0%{transform:${T} scale(${r(Math.max(0.05, 1 - 0.2 * i))})}70%{transform:${T} scale(${r(1 + 0.06 * i)})}100%{transform:${T} scale(1)}`; break;
      case 'spinInLeft':
        body = `0%{transform:${T} translateX(${r(-50 * i)}px) rotate(${r(-180 * i)}deg);opacity:0}100%{transform:${T} translateX(0) rotate(0deg);opacity:1}`; break;
      case 'spinInRight':
        body = `0%{transform:${T} translateX(${r(50 * i)}px) rotate(${r(180 * i)}deg);opacity:0}100%{transform:${T} translateX(0) rotate(0deg);opacity:1}`; break;
      case 'pushLeft':
        body = `0%{transform:${T} translateX(${r(50 * i)}px);opacity:0}100%{transform:${T} translateX(0);opacity:1}`; break;
      case 'pushRight':
        body = `0%{transform:${T} translateX(${r(-50 * i)}px);opacity:0}100%{transform:${T} translateX(0);opacity:1}`; break;
      case 'pushUp':
        body = `0%{transform:${T} translateY(${r(50 * i)}px);opacity:0}100%{transform:${T} translateY(0);opacity:1}`; break;
      case 'pushDown':
        body = `0%{transform:${T} translateY(${r(-50 * i)}px);opacity:0}100%{transform:${T} translateY(0);opacity:1}`; break;
      case 'rightInsert':
        body = `0%{transform:${T} translateX(${r(100 * i)}%);opacity:0}100%{transform:${T} translateX(0);opacity:1}`; break;
      case 'leftInsert':
        body = `0%{transform:${T} translateX(${r(-100 * i)}%);opacity:0}100%{transform:${T} translateX(0);opacity:1}`; break;
      case 'blurLeft': // more blur and travel with intensity
        body = `0%{filter:blur(${r(10 * i)}px);transform:${T} translateX(${r(-20 * i)}px);opacity:0}100%{filter:blur(0px);transform:${T} translateX(0);opacity:1}`; break;
      case 'blurRight':
        body = `0%{filter:blur(${r(10 * i)}px);transform:${T} translateX(${r(20 * i)}px);opacity:0}100%{filter:blur(0px);transform:${T} translateX(0);opacity:1}`; break;
      case 'glitch': { // bigger jitter with intensity
        const o = r(2 * i);
        body = `0%{clip-path:inset(10% 0 80% 0);transform:${T} translate(${-o}px,${o}px)}20%{clip-path:inset(80% 0 5% 0);transform:${T} translate(${o}px,${-o}px)}40%{clip-path:inset(40% 0 40% 0);transform:${T} translate(${-o}px,${-o}px)}60%{clip-path:inset(20% 0 60% 0);transform:${T} translate(${o}px,${o}px)}80%{clip-path:inset(60% 0 20% 0);transform:${T} translate(${-o}px,0)}100%{clip-path:inset(0 0 0 0);transform:${T} translate(0,0)}`; break;
      }
      case 'glitchFlicker': // deeper flicker with intensity
        body = `0%{opacity:1}50%{opacity:${r(Math.max(0.1, 1 - 0.2 * i))}}100%{opacity:1}`; break;
      case 'randomFlash': { // more flashes with intensity
        const flashes = Math.max(1, Math.round(2 * i));
        const steps = flashes * 2;
        const frames: string[] = [];
        for (let k = 0; k < steps; k++) frames.push(`${r((k / steps) * 100)}%{opacity:${k % 2 === 0 ? 0 : 1}}`);
        frames.push('100%{opacity:1}');
        body = frames.join(''); break;
      }
      default: return null;
    }
    dynKeyframes.set(name, `@keyframes ${name}{${body}}`);
    return name;
  };

  // override lets a rollout sequence item use its own effect / speed
  // Text Alignment (Component Editor). Auto margins move the text inside its flex/grid
  // box whatever the box's own justify setting is; textAlign covers full-width text
  // (banner). Unset = the layout's normal alignment.
  const getTextAlignStyle = (compKey: string): React.CSSProperties => {
    const a = getCompVar(compKey, 'text_align', '');
    if (a === 'left') return { marginLeft: 0, marginRight: 'auto', textAlign: 'left' };
    if (a === 'right') return { marginLeft: 'auto', marginRight: 0, textAlign: 'right' };
    if (a === 'center') return { marginLeft: 'auto', marginRight: 'auto', textAlign: 'center' };
    return {};
  };

  const getTextAnimStyle = (compKey: string, override?: { anim?: string; dur?: string | number }) => {
    const alignStyle = getTextAlignStyle(compKey);
    const animType = override?.anim ? override.anim : getCompVar(compKey, 'text_anim', 'none');
    if (animType === 'none') return alignStyle;

    const hasDurOverride = override?.dur !== undefined && override?.dur !== '' && !isNaN(parseFloat(String(override.dur)));
    const durVal = hasDurOverride ? parseFloat(String(override!.dur)) : parseFloat(getCompVar(compKey, 'text_anim_dur', '0.6'));
    const dur = `${isNaN(durVal) ? 0.6 : durVal}s`;
    
    const intensityVal = parseFloat(getCompVar(compKey, 'text_anim_intensity', '1.0'));
    const intensity = isNaN(intensityVal) ? 1.0 : Math.min(5, Math.max(0.1, intensityVal));
    const kf = (type: string) => buildIntensityKeyframes(type, intensity) as string;

    let animStyle: any = {};

    switch (animType) {
      case 'wipeLeft': animStyle = { animation: `animWipeLeft ${dur} ease-out forwards` }; break;
      case 'wipeRight': animStyle = { animation: `animWipeRight ${dur} ease-out forwards` }; break;
      case 'wipeUp': animStyle = { animation: `animWipeUp ${dur} ease-out forwards` }; break;
      case 'wipeDown': animStyle = { animation: `animWipeDown ${dur} ease-out forwards` }; break;
      case 'fadeIn': animStyle = { animation: `animFadeIn ${dur} ease-out forwards` }; break;
      case 'fadeOut': animStyle = { animation: `animFadeOut ${dur} ease-out forwards` }; break;
      case 'zoomIn': animStyle = { animation: `${kf('zoomIn')} ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` }; break;
      case 'zoomOut': animStyle = { animation: `${kf('zoomOut')} ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` }; break;
      case 'typewriter': animStyle = { animation: `animTypewriter ${dur} steps(20, end) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const, margin: '0 auto', textAlign: 'center' as const, display: 'inline-block' }; break;
      case 'glitchTypewriter': animStyle = { animation: `${kf('glitch')} ${dur} steps(15, end) forwards, ${kf('glitchFlicker')} 0.2s infinite` }; break;
      case 'spinInLeft': animStyle = { animation: `${kf('spinInLeft')} ${dur} ease-out forwards` }; break;
      case 'spinInRight': animStyle = { animation: `${kf('spinInRight')} ${dur} ease-out forwards` }; break;
      case 'pushLeft': animStyle = { animation: `${kf('pushLeft')} ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` }; break;
      case 'pushRight': animStyle = { animation: `${kf('pushRight')} ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` }; break;
      case 'pushUp': animStyle = { animation: `${kf('pushUp')} ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` }; break;
      case 'pushDown': animStyle = { animation: `${kf('pushDown')} ${dur} cubic-bezier(0.34, 1.56, 0.64, 1) forwards` }; break;
      case 'randomFlash': animStyle = { animation: `${kf('randomFlash')} ${dur} steps(1, end) forwards` }; break;
      case 'enlarge': animStyle = { animation: `${kf('enlarge')} ${dur} cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards` }; break;
      case 'rightInsert': animStyle = { animation: `${kf('rightInsert')} ${dur} cubic-bezier(0.1, 0.9, 0.2, 1) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const }; break;
      case 'leftInsert': animStyle = { animation: `${kf('leftInsert')} ${dur} cubic-bezier(0.1, 0.9, 0.2, 1) forwards`, overflow: 'hidden', whiteSpace: 'nowrap' as const }; break;
      case 'blurLeft': animStyle = { animation: `${kf('blurLeft')} ${dur} ease-out forwards` }; break;
      case 'blurRight': animStyle = { animation: `${kf('blurRight')} ${dur} ease-out forwards` }; break;
    }

    // The text's skew is carried into the keyframes via this variable; previously
    // any transform-based animation wiped the text skew out once it ran.
    animStyle['--text-skew'] = getTextSkewTransform(compKey);

    return { ...alignStyle, ...animStyle } as React.CSSProperties;
  };

  const userSkew = gc.skewAngle ? `${gc.skewAngle}deg` : null;
  // Overlay placement (Graphics tab > Global Architecture). X is offset from
  // horizontal centre, Y is distance from the top of the OBS canvas.
  const numOr = (v: any, d: number) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const overlayPosX = numOr(gc.overlayPosX, 0);
  const overlayPosY = numOr(gc.overlayPosY, 20);
  const overlayScale = Math.min(4, Math.max(0.1, numOr(gc.bugScale, 1)));

  const skewAngle = userSkew || (layoutStyle === 'style1' ? '-15deg' : '0deg');

  const shootoutRounds = state.shootout_rounds || Array(10).fill({ away: 0, home: 0 });

  const renderShootoutOverlay = () => {
    if (!state.shootout_active) return null;

    const shootoutStyle = getCompStyle('shootout', '#0a0a0a', '#ffffff', 18);
    const useGlobalSkew = gc.shootout_text_global_skew === true;
    const shootoutContainerSkew = useGlobalSkew ? skewAngle : `${gc.shootout_text_skew || 0}deg`;

    // Each team's row uses that team's Team Box background unless "Match Team Box
    // Background" is unticked for the Shootout Tracker element.
    const soTeamBg = gc.shootout_use_team_bg !== false && gc.shootout_use_team_bg !== 'false';
    const awayName = state.away_name || 'AWAY';
    const homeName = state.home_name || 'HOME';
    const dot = (v: number): React.CSSProperties => ({
      // shrink (never below 10px) rather than push the panel wider than the scoreboard
      flex: '0 1 18px', minWidth: '10px', aspectRatio: '1 / 1', borderRadius: '50%', boxSizing: 'border-box',
      border: `2px solid ${soTeamBg ? 'rgba(255,255,255,0.55)' : '#555555'}`,
      background: v === 1 ? '#10b981' : v === 2 ? '#ef4444' : (soTeamBg ? 'rgba(0,0,0,0.35)' : '#1a1a1a'),
      boxShadow: v === 1 ? '0 0 8px #10b981' : v === 2 ? '0 0 8px #ef4444' : 'none',
    });
    const renderRow = (team: 'away' | 'home') => {
      const teamKey = team === 'away' ? 'awayTeam' : 'homeTeam';
      const teamCol = team === 'away' ? (state.away_color || '#00468b') : (state.home_color || '#111111');
      return (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 0', minWidth: 0,
          padding: soTeamBg ? '6px 12px' : '0',
          ...(soTeamBg ? { ...penChipBg(teamKey, teamCol), color: getCompVar(teamKey, 'text_color', '#ffffff') } : {}),
          ...(soTeamBg && team === 'home' ? { borderTop: '1px solid rgba(255,255,255,0.25)' } : {}),
        }}>
          {/* Both names stacked in one cell (one hidden) so the name column is the same
              width in both rows and the round dots line up vertically */}
          <span style={{ display: 'inline-grid', flex: 'none', fontWeight: 'bold', whiteSpace: 'nowrap', textAlign: 'right', paddingRight: '6px' }}>
            <span style={{ gridArea: '1 / 1', visibility: team === 'away' ? 'visible' : 'hidden' }}>{awayName}</span>
            <span style={{ gridArea: '1 / 1', visibility: team === 'home' ? 'visible' : 'hidden' }}>{homeName}</span>
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1, justifyContent: 'space-between', minWidth: 0 }}>
            {shootoutRounds.map((r, i) => <div key={i} style={dot(team === 'away' ? r.away : r.home)} />)}
          </div>
        </div>
      );
    };

    return (
      <div 
        style={{
          marginTop: '6px', alignSelf: 'stretch', ...shootoutStyle, // shootoutStyle already sets boxSizing: 'border-box'
          // width 0 + min-width 100%: exactly as wide as the scoreboard above, never wider
          width: 0, minWidth: '100%',
          borderRadius: `${gc.cornerRadius || 8}px`, padding: soTeamBg ? '0' : '8px 24px',
          overflow: soTeamBg ? 'hidden' : shootoutStyle.overflow,
          boxShadow: '0 8px 16px rgba(0,0,0,0.6)', transform: `skewX(${shootoutContainerSkew})`,
          display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: soTeamBg ? 0 : '6px', zIndex: 100
        }}
      >
        {renderCompLayers('shootout', '#0a0a0a')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: soTeamBg ? 0 : '6px', position: 'relative', zIndex: 3, minWidth: 0 }}>
          {renderRow('away')}
          {renderRow('home')}
        </div>
      </div>
    );
  };

  return (
    <>
      <style>{`
        @keyframes animRolloutShowFromLeft { 0% { transform: translateX(-5%); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
        @keyframes animRolloutRetractToLeft { 0% { transform: translateX(0); opacity: 1; } 100% { transform: translateX(-5%); opacity: 0; } }
        @keyframes animWipeLeft { 0% { clip-path: polygon(100% 0, 100% 0, 100% 100%, 100% 100%); } 100% { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); } }
        @keyframes animWipeRight { 0% { clip-path: polygon(0 0, 0 0, 0 100%, 0 100%); } 100% { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); } }
        @keyframes animWipeUp { 0% { clip-path: polygon(0 100%, 100% 100%, 100% 100%, 0 100%); } 100% { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); } }
        @keyframes animWipeDown { 0% { clip-path: polygon(0 0, 100% 0, 100% 0, 0 0); } 100% { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); } }
        @keyframes animFadeIn { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes animFadeOut { 0% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes animTypewriter { 0% { width: 0; } 100% { width: 100%; } }
        @keyframes animRandomFlash { 0% { opacity: 0; } 25% { opacity: 1; } 50% { opacity: 0; } 75% { opacity: 1; } 100% { opacity: 1; } }
        
        /* Intensity Scaled Animations */
        @keyframes animZoomIn { 0% { transform: scale(calc(1 - (0.5 * var(--anim-intensity, 1)))); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes animZoomOut { 0% { transform: scale(calc(1 + (0.5 * var(--anim-intensity, 1)))); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes animEnlarge { 0% { transform: scale(calc(1 - (0.2 * var(--anim-intensity, 1)))); } 100% { transform: scale(1); } }
        @keyframes animGlitch { 0% { clip-path: inset(10% 0 80% 0); transform: translate(calc(-2px * var(--anim-intensity, 1)), calc(2px * var(--anim-intensity, 1))); } 20% { clip-path: inset(80% 0 5% 0); transform: translate(calc(2px * var(--anim-intensity, 1)), calc(-2px * var(--anim-intensity, 1))); } 40% { clip-path: inset(40% 0 40% 0); transform: translate(calc(-2px * var(--anim-intensity, 1)), calc(-2px * var(--anim-intensity, 1))); } 60% { clip-path: inset(20% 0 60% 0); transform: translate(calc(2px * var(--anim-intensity, 1)), calc(2px * var(--anim-intensity, 1))); } 80% { clip-path: inset(60% 0 20% 0); transform: translate(calc(-2px * var(--anim-intensity, 1)), 0); } 100% { clip-path: inset(0 0 0 0); transform: translate(0, 0); } }
        @keyframes animGlitchFlicker { 0% { opacity: 1; } 50% { opacity: 0.8; } 100% { opacity: 1; } }
        @keyframes animSpinInLeft { 0% { transform: translateX(calc(-50px * var(--anim-intensity, 1))) rotate(calc(-180deg * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateX(0) rotate(0deg); opacity: 1; } }
        @keyframes animSpinInRight { 0% { transform: translateX(calc(50px * var(--anim-intensity, 1))) rotate(calc(180deg * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateX(0) rotate(0deg); opacity: 1; } }
        @keyframes animPushLeft { 0% { transform: translateX(calc(50px * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
        @keyframes animPushRight { 0% { transform: translateX(calc(-50px * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
        @keyframes animPushUp { 0% { transform: translateY(calc(50px * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
        @keyframes animPushDown { 0% { transform: translateY(calc(-50px * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
        @keyframes animRightInsert { 0% { transform: translateX(calc(100% * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
        @keyframes animLeftInsert { 0% { transform: translateX(calc(-100% * var(--anim-intensity, 1))); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
        @keyframes animBlurLeft { 0% { filter: blur(calc(10px * var(--anim-intensity, 1))); transform: translateX(calc(-20px * var(--anim-intensity, 1))); opacity: 0; } 100% { filter: blur(0px); transform: translateX(0); opacity: 1; } }
        @keyframes animBlurRight { 0% { filter: blur(calc(10px * var(--anim-intensity, 1))); transform: translateX(calc(20px * var(--anim-intensity, 1))); opacity: 0; } 100% { filter: blur(0px); transform: translateX(0); opacity: 1; } }
      `}</style>

      <div 
        id="scoreboard-master-container"
        style={{
          backgroundColor: isChromaGreen ? '#00ff00' : 'transparent',
          minHeight: '100vh', padding: '20px', position: 'relative',
          // globals.css has a legacy #scoreboard-master-container rule (top/left 40px +
          // scale) that silently offset the overlay; position is now set from the
          // Graphics tab instead.
          top: 0, left: 0, transform: 'none',
          fontFamily: gc.globalFont || state.global_font || "'Roboto Condensed', sans-serif"
        }}
      >
        <div style={{
          position: 'absolute',
          top: `${overlayPosY}px`,
          left: `calc(50% + ${overlayPosX}px)`,
          transform: `translateX(-50%) scale(${overlayScale})`,
          transformOrigin: 'top center',
          display: 'flex', flexDirection: 'column', alignItems: 'center'
        }}>

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
                    <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 3, transform: getTextSkewTransform('awayTeam'), ...getTextAlignStyle('awayTeam') }}>SOG: {state.away_sog}</span>
                    
                    {awayPens.length > 0 && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10 }}>
                        {awayPens.map(p => (
                          <div key={p.id} style={{ ...penChipBg('awayTeam', state.away_color || '#00468b'), color: getCompVar('awayTeam', 'text_color', '#fff'), padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                            <span style={{ transform: getTextSkewTransform('awayTeam') }}>#{p.plyr}</span>
                            <span style={{ transform: getTextSkewTransform('awayTeam') }}>{formatTime(p.time)}</span>
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
                    <span style={{ fontSize: '11px', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '10px', marginTop: '2px', position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeTeam'), ...getTextAlignStyle('homeTeam') }}>SOG: {state.home_sog}</span>

                    {homePens.length > 0 && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px', zIndex: 10 }}>
                        {homePens.map(p => (
                          <div key={p.id} style={{ ...penChipBg('homeTeam', state.home_color || '#111111'), color: getCompVar('homeTeam', 'text_color', '#fff'), padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                            <span style={{ transform: getTextSkewTransform('homeTeam') }}>#{p.plyr}</span>
                            <span style={{ transform: getTextSkewTransform('homeTeam') }}>{formatTime(p.time)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ padding: '12px 20px', ...getCompStyle('homeScore', '#ffffff', '#000000', 36), fontWeight: 'bold', minWidth: '60px' }}>
                    {renderCompLayers('homeScore', '#ffffff')}
                    <span key={`homeScore_${state.home_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                  </div>

                  {showRightPanel && (
                    <div style={{ 
                      position: 'absolute', left: '100%', top: 0, bottom: 0, zIndex: -1, display: 'flex', alignItems: 'stretch',
                      animation: panelExiting ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards' : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                    }}>
                      <div style={{ padding: '12px 24px', ...getCompStyle(activePanelKey, '#ffcc00', '#ffffff', 20), fontWeight: 'bold', minWidth: '160px', boxSizing: 'border-box', borderTopRightRadius: `${gc.cornerRadius || 8}px`, borderBottomRightRadius: `${gc.cornerRadius || 8}px` }}>
                        {renderCompLayers(activePanelKey, '#ffcc00', true)}
                        {renderPanelText(
  `rollout_txt_${activePanelKey}_${sideTextKey}`,
  { position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', flexShrink: 0, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey, sideAnimOverride) },
  sideText,
  sideSizerTexts
)}
                      </div>
                    </div>
                  )}
                </div>

                {(displayedBannerActive || bannerExiting) && (
                  <div style={{ 
                    position: 'absolute', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'stretch', height: '100%',
                    animation: bannerExiting ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards' : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ ...getCompStyle(displayedBannerKey, '#007bff', '#ffffff', 32), fontWeight: 'bold', textAlign: 'center', width: '100%', height: '100%', border: 'none' }}>
                      {renderCompLayers(displayedBannerKey, '#007bff')}
                      <div key={`banner_txt_${displayedBannerKey}_${bannerTextKey}`} style={{ transform: getTextSkewTransform(displayedBannerKey), width: '100%', textAlign: 'center', zIndex: 3, whiteSpace: 'nowrap', paddingRight: '8px', ...getTextAnimStyle(displayedBannerKey, bannerAnimOverride) }}>
                        {bannerText}
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
              
              {/* OUTER WRAPPER */}
              <div 
                style={{ 
                  position: 'relative',
                  borderRadius: `${gc.cornerRadius || 8}px`, 
                  boxShadow: '0 8px 16px rgba(0,0,0,0.4)', 
                  width: 'fit-content'
                }}
              >
                
                {/* INNER GRID */}
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'stretch', 
                  height: '80px', 
                  position: 'relative',
                  border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
                  borderRadius: 'inherit',
                  overflow: 'hidden',
                  zIndex: 2 
                }}>
                  
                  {/* CLOCK & PERIOD CONTINUOUS COLUMN */}
                  <div style={{ display: 'flex', flexDirection: 'column', width: '130px', height: '100%', position: 'relative' }}>
                    <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
                      {renderCompLayers('clock', '#111111')}
                    </div>
                    <div style={{ flex: 1, ...getCompStyle('clock', 'transparent', '#ffffff', 28), padding: '0 12px', fontWeight: 'bold' }}>
                      <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                    </div>
                    <div style={{ width: '70%', height: `${gc.bugBorderWidth || 2}px`, backgroundColor: 'rgba(255,255,255,0.3)', margin: '0 auto', position: 'relative', zIndex: 3 }} />
                    <div style={{ flex: 1, ...getCompStyle('period', 'transparent', '#ffffff', 24), padding: '0 12px', fontWeight: 'bold' }}>
                      <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                    </div>
                  </div>

                  {/* AWAY TEAM */}
                  <div style={{ width: '180px', height: '100%', ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 28), fontWeight: 'bold', padding: '0 12px' }}>
                    {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                  </div>

                  {/* AWAY SCORE & SOG */}
                  <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                    <div style={{ height: '55%', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 8px', fontWeight: 'bold' }}>
                      {renderCompLayers('awayScore', '#002855')}
                      <span key={`awayScore_${state.away_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                    </div>
                    <div style={{ height: '45%', ...getCompStyle('awaySog', '#dbe2ea', '#1e293b', 18), fontWeight: 'bold' }}>
                      {renderCompLayers('awaySog', '#dbe2ea')}
                      <div style={{ position: 'relative', zIndex: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: '9px', fontWeight: '900', letterSpacing: '0.5px' }}>SOG</span>
                        <span style={{ transform: getTextSkewTransform('awaySog'), ...getTextAnimStyle('awaySog'), fontSize: '18px', marginTop: '-2px' }}>{state.away_sog}</span>
                      </div>
                    </div>
                  </div>

                  {/* HOME TEAM */}
                  <div style={{ width: '180px', height: '100%', ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 28), fontWeight: 'bold', padding: '0 12px' }}>
                    {renderCompLayers('homeTeam', state.home_color || '#222222')}
                    <span style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                  </div>

                  {/* HOME SCORE & SOG */}
                  <div style={{ display: 'flex', flexDirection: 'column', width: '70px', height: '100%' }}>
                    <div style={{ height: '55%', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 8px', fontWeight: 'bold' }}>
                      {renderCompLayers('homeScore', '#111111')}
                      <span key={`homeScore_${state.home_score}`} style={{ position: 'relative', zIndex: 3, paddingRight: '8px', whiteSpace: 'nowrap', transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                    </div>
                    <div style={{ height: '45%', ...getCompStyle('homeSog', '#dbe2ea', '#1e293b', 18), fontWeight: 'bold' }}>
                      {renderCompLayers('homeSog', '#dbe2ea')}
                      <div style={{ position: 'relative', zIndex: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: '9px', fontWeight: '900', letterSpacing: '0.5px' }}>SOG</span>
                        <span style={{ transform: getTextSkewTransform('homeSog'), ...getTextAnimStyle('homeSog'), fontSize: '18px', marginTop: '-2px' }}>{state.home_sog}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* PENALTIES (Zero-height container removed to prevent GPU culling) */}
                {(awayPens.length > 0 || homePens.length > 0) && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, width: '100%', zIndex: 10, marginTop: '4px' }}>
                    {awayPens.length > 0 && (
                      <div style={{ position: 'absolute', left: '130px', width: '180px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {awayPens.map(p => (
                          <div key={p.id} style={{ ...penChipBg('awayTeam', state.away_color || '#00468b'), color: getCompVar('awayTeam', 'text_color', '#fff'), padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                            <span style={{ transform: getTextSkewTransform('awayTeam') }}>#{p.plyr}</span>
                            <span style={{ transform: getTextSkewTransform('awayTeam') }}>{formatTime(p.time)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {homePens.length > 0 && (
                      <div style={{ position: 'absolute', left: '380px', width: '180px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {homePens.map(p => (
                          <div key={p.id} style={{ ...penChipBg('homeTeam', state.home_color || '#111111'), color: getCompVar('homeTeam', 'text_color', '#fff'), padding: '6px 12px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                            <span style={{ transform: getTextSkewTransform('homeTeam') }}>#{p.plyr}</span>
                            <span style={{ transform: getTextSkewTransform('homeTeam') }}>{formatTime(p.time)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ROLLOUT PANEL */}
                {showRightPanel && (
                  <div style={{ 
                    position: 'absolute', left: '100%', top: 0, bottom: 0, zIndex: 1,
                    animation: panelExiting ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards' : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ padding: '0 24px', ...getCompStyle(activePanelKey, '#ffcc00', '#ffffff', 20), flexDirection: 'column', minWidth: '160px', fontWeight: 'bold', height: '100%', textAlign: 'center', boxSizing: 'border-box', borderTopRightRadius: `${gc.cornerRadius || 8}px`, borderBottomRightRadius: `${gc.cornerRadius || 8}px` }}>
                      {renderCompLayers(activePanelKey, '#ffcc00', true)}
                      {ppActive && !ppCustom ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', position: 'relative', zIndex: 3 }}>
                          <span style={{ fontSize: '0.6em', textTransform: 'uppercase', marginBottom: '2px', lineHeight: 1 }}>{ppSituationStr || `${ppTeam} PP`}</span>
                          <span style={{ fontSize: '1.5em', lineHeight: 1 }}>{ppTimeStr}</span>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', position: 'relative', zIndex: 3 }}>
                          {renderPanelText(
  `rollout_s2_txt_${activePanelKey}_${sideTextKey}`,
  { lineHeight: 1, paddingRight: '8px', whiteSpace: 'nowrap', flexShrink: 0, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey, sideAnimOverride) },
  sideText,
  sideSizerTexts
)}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* BANNER OVERLAY */}
                {(displayedBannerActive || bannerExiting) && (
                  <div style={{ 
                    position: 'absolute', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'stretch', height: '100%',
                    animation: bannerExiting ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards' : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ ...getCompStyle(displayedBannerKey, '#007bff', '#ffffff', 32), fontWeight: 'bold', textAlign: 'center', width: '100%', height: '100%' }}>
                      {renderCompLayers(displayedBannerKey, '#007bff')}
                      <div key={`banner_txt_${displayedBannerKey}_${bannerTextKey}`} style={{ transform: getTextSkewTransform(displayedBannerKey), width: '100%', textAlign: 'center', zIndex: 3, whiteSpace: 'nowrap', paddingRight: '8px', ...getTextAnimStyle(displayedBannerKey, bannerAnimOverride) }}>
                        {bannerText}
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
                  width: 'fit-content'
                }}
              >
                
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'stretch', 
                  height: '80px', 
                  position: 'relative',
                  border: `${gc.bugBorderWidth || 2}px solid ${gc.bugBorderColor || '#ffffff'}`,
                  borderRadius: 'inherit',
                  overflow: 'hidden',
                  zIndex: 2
                }}>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', width: '110px', height: '100%', position: 'relative' }}>
                    <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
                      {renderCompLayers('clock', '#111111')}
                    </div>
                    <div style={{ flex: 1, ...getCompStyle('clock', 'transparent', '#ffffff', 28), padding: '0 16px', fontWeight: 'bold' }}>
                      <span style={{ position: 'relative', zIndex: 3, whiteSpace: 'nowrap', transform: getTextSkewTransform('clock'), ...getTextAnimStyle('clock') }}>{formatTime(state.clock_seconds)}</span>
                    </div>
                    <div style={{ width: '70%', height: `${gc.bugBorderWidth || 2}px`, backgroundColor: 'rgba(255,255,255,0.3)', margin: '0 auto', position: 'relative', zIndex: 3 }} />
                    <div style={{ flex: 1, ...getCompStyle('period', 'transparent', '#ffffff', 22), padding: '0 16px', fontWeight: 'bold' }}>
                      <span key={`period_${state.period}`} style={{ position: 'relative', zIndex: 3, whiteSpace: 'nowrap', transform: getTextSkewTransform('period'), ...getTextAnimStyle('period') }}>{state.period}</span>
                    </div>
                  </div>

                  {/* Team names: 25% wider than before (was ~142px beside the score) */}
                  <div style={{ display: 'flex', flexDirection: 'column', width: `${S3_TEAM_W}px`, height: '100%', position: 'relative' }}>
                    
                    <div style={{ display: 'flex', height: '50%', alignItems: 'stretch', position: 'relative' }}>
                      <div style={{ flex: 1, ...getCompStyle('awayTeam', state.away_color || '#00468b', '#ffffff', 26), padding: '0 12px', justifyContent: 'flex-start', overflow: 'hidden' }}>
                        {renderCompLayers('awayTeam', state.away_color || '#00468b')}
                        <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, whiteSpace: 'nowrap', transform: getTextSkewTransform('awayTeam'), ...getTextAnimStyle('awayTeam') }}>{state.away_name}</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', height: '50%', alignItems: 'stretch', position: 'relative' }}>
                      <div style={{ flex: 1, ...getCompStyle('homeTeam', state.home_color || '#222222', '#ffffff', 26), padding: '0 12px', justifyContent: 'flex-start', overflow: 'hidden' }}>
                        {renderCompLayers('homeTeam', state.home_color || '#222222')}
                        <span style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, whiteSpace: 'nowrap', transform: getTextSkewTransform('homeTeam'), ...getTextAnimStyle('homeTeam') }}>{state.home_name}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: '60px', height: '100%', position: 'relative' }}>
                    
                    <div style={{ height: '50%', ...getCompStyle('awaySog', '#ffffff', '#000000', 20), fontWeight: 'bold' }}>
                      {renderCompLayers('awaySog', '#ffffff')}
                      <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('awaySog'), ...getTextAnimStyle('awaySog') }}>
                        {state.away_sog}
                      </span>
                    </div>

                    <div style={{ height: '50%', ...getCompStyle('homeSog', '#ffffff', '#000000', 20), fontWeight: 'bold' }}>
                      {renderCompLayers('homeSog', '#ffffff')}
                      <span style={{ position: 'relative', zIndex: 3, transform: getTextSkewTransform('homeSog'), ...getTextAnimStyle('homeSog') }}>
                        {state.home_sog}
                      </span>
                    </div>
                    
                    <span style={{ 
                      position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                      fontSize: '9px', fontWeight: '900', color: '#444', background: '#e2e8f0', 
                      padding: '2px 5px', borderRadius: '3px', border: '1px solid #cbd5e1', 
                      boxShadow: '0 2px 4px rgba(0,0,0,0.15)', zIndex: 20, lineHeight: 1, letterSpacing: '0.5px'
                    }}>
                      SOG
                    </span>

                  </div>

                  {/* Score column, now after SOG */}
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: '50px', height: '100%', position: 'relative' }}>
                    <div style={{ height: '50%', ...getCompStyle('awayScore', '#002855', '#ffffff', 28), padding: '0 8px' }}>
                      {renderCompLayers('awayScore', '#002855')}
                      <span key={`awayScore_${state.away_score}`} style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, whiteSpace: 'nowrap', transform: getTextSkewTransform('awayScore'), ...getTextAnimStyle('awayScore') }}>{state.away_score}</span>
                    </div>
                    <div style={{ height: '50%', ...getCompStyle('homeScore', '#111111', '#ffffff', 28), padding: '0 8px' }}>
                      {renderCompLayers('homeScore', '#111111')}
                      <span key={`homeScore_${state.home_score}`} style={{ fontWeight: 'bold', position: 'relative', zIndex: 3, whiteSpace: 'nowrap', transform: getTextSkewTransform('homeScore'), ...getTextAnimStyle('homeScore') }}>{state.home_score}</span>
                    </div>
                  </div>

                </div>

                {(awayPens.length > 0 || homePens.length > 0) && (
                  <div style={{ position: 'absolute', top: '100%', left: '110px', width: `${S3_TEAM_W}px`, display: 'flex', gap: '8px', zIndex: 10, marginTop: '4px' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {awayPens.map(p => (
                        <div key={p.id} style={{ ...penChipBg('awayTeam', state.away_color || '#00468b'), color: getCompVar('awayTeam', 'text_color', '#fff'), padding: '6px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                          <span style={{ transform: getTextSkewTransform('awayTeam') }}>#{p.plyr}</span>
                          <span style={{ transform: getTextSkewTransform('awayTeam') }}>{formatTime(p.time)}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {homePens.map(p => (
                        <div key={p.id} style={{ ...penChipBg('homeTeam', state.home_color || '#111111'), color: getCompVar('homeTeam', 'text_color', '#fff'), padding: '6px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(255,255,255,0.2)', boxSizing: 'border-box' }}>
                          <span style={{ transform: getTextSkewTransform('homeTeam') }}>#{p.plyr}</span>
                          <span style={{ transform: getTextSkewTransform('homeTeam') }}>{formatTime(p.time)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ROLLOUT PANEL */}
                {showRightPanel && (
                  <div style={{ 
                    position: 'absolute', left: '100%', top: 0, bottom: 0, zIndex: 1,
                    animation: panelExiting ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards' : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ padding: '0 20px', ...getCompStyle(activePanelKey, '#ffcc00', '#ffffff', 20), fontWeight: 'bold', minWidth: '160px', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', borderTopRightRadius: `${gc.cornerRadius || 8}px`, borderBottomRightRadius: `${gc.cornerRadius || 8}px` }}>
                      {renderCompLayers(activePanelKey, '#ffcc00', true)}
                      {renderPanelText(
  `rollout_s3_txt_${activePanelKey}_${sideTextKey}`,
  { position: 'relative', zIndex: 3, whiteSpace: 'nowrap', flexShrink: 0, transform: getTextSkewTransform(activePanelKey), ...getTextAnimStyle(activePanelKey, sideAnimOverride) },
  sideText,
  sideSizerTexts
)}
                    </div>
                  </div>
                )}
                
                {/* BANNER OVERLAY */}
                {(displayedBannerActive || bannerExiting) && (
                  <div style={{ 
                    position: 'absolute', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'stretch', height: '100%',
                    animation: bannerExiting ? 'animRolloutRetractToLeft 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards' : 'animRolloutShowFromLeft 0.5s cubic-bezier(0.1, 0.9, 0.2, 1) forwards'
                  }}>
                    <div style={{ ...getCompStyle(displayedBannerKey, '#007bff', '#ffffff', 32), fontWeight: 'bold', textAlign: 'center', width: '100%', height: '100%', border: 'none' }}>
                      {renderCompLayers(displayedBannerKey, '#007bff')}
                      <div key={`banner_txt_${displayedBannerKey}_${bannerTextKey}`} style={{ transform: getTextSkewTransform(displayedBannerKey), width: '100%', textAlign: 'center', zIndex: 3, whiteSpace: 'nowrap', ...getTextAnimStyle(displayedBannerKey, bannerAnimOverride) }}>
                        {bannerText}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {renderShootoutOverlay()}
            </div>
          )}

          {/* MEDIA PRELOADER: images via <link>, videos via hidden buffered <video>
              elements (Chrome/OBS ignore <link rel="preload" as="video">). */}
          <div aria-hidden style={{ position: 'fixed', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none', left: -10, top: -10 }}>
            {Array.from(new Map(
              MEDIA_KEYS
                .map(key => resolveMedia(gc, key))
                .filter(m => m.url)
                .map(m => [m.url, m] as const)
            ).values()).map(({ url, isVid }) => isVid ? (
              <video
                key={`preload_${url}`}
                src={mediaSrc(url)}
                preload="auto"
                muted
                playsInline
                ref={el => {
                  if (el) preloadVideosRef.current.set(url, el);
                  else preloadVideosRef.current.delete(url);
                }}
              />
            ) : (
              <link key={`preload_${url}`} rel="preload" href={url} as="image" />
            ))}
          </div>

        </div>
      </div>

      {/* Intensity-specific keyframes collected during this render */}
      <style>{Array.from(dynKeyframes.values()).join('\n')}</style>
    </>
  );
}
