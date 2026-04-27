import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Film, Heart, Radio, Search, SlidersHorizontal, Tv, X } from 'lucide-react';
import VirtualizedStreamList from './components/VirtualizedStreamList';

const sessionKey = 'signaldeck-session';
const favoritesKey = 'signaldeck-favorites';
const liveAudioModeKey = 'signaldeck-live-audio-mode';

const views = [
  { id: 'live', label: 'Live TV', icon: Radio },
  { id: 'vod', label: 'Movies', icon: Film },
  { id: 'series', label: 'TV Series', icon: Tv },
];

const PlayerPanel = lazy(() => import('./components/PlayerPanel'));

const guideTimeFormatter = new Intl.DateTimeFormat([], {
  hour: 'numeric',
  minute: '2-digit',
});

const guideDayFormatter = new Intl.DateTimeFormat([], {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

function getGuideTimestamp(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).includes(' ') ? String(value).replace(' ', 'T') : String(value);
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function formatGuideTime(value) {
  const timestamp = getGuideTimestamp(value);
  if (timestamp === null) {
    return 'TBD';
  }

  return guideTimeFormatter.format(timestamp);
}

function formatGuideRange(entry) {
  if (!entry) {
    return '';
  }

  return `${formatGuideTime(entry.start)} - ${formatGuideTime(entry.end)}`;
}

function formatGuideDayLabel(dayKey) {
  const timestamp = getGuideTimestamp(`${dayKey}T00:00:00`);
  if (timestamp === null) {
    return dayKey;
  }

  const dayDate = new Date(timestamp);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const isoDay = dayDate.toISOString().slice(0, 10);
  if (isoDay === today.toISOString().slice(0, 10)) {
    return 'Today';
  }
  if (isoDay === tomorrow.toISOString().slice(0, 10)) {
    return 'Tomorrow';
  }

  return guideDayFormatter.format(dayDate);
}

function getGuideSummary(listings, nowMs) {
  const sortedListings = (listings || []).map((entry) => {
    const startMs = getGuideTimestamp(entry.start);
    const endMs = getGuideTimestamp(entry.end);
    return {
      ...entry,
      startMs,
      endMs,
    };
  }).sort((left, right) => {
    return (left.startMs ?? Number.MAX_SAFE_INTEGER) - (right.startMs ?? Number.MAX_SAFE_INTEGER);
  });

  const current = sortedListings.find((entry) => {
    return entry.startMs !== null && entry.endMs !== null && nowMs >= entry.startMs && nowMs < entry.endMs;
  }) || null;

  const upcoming = sortedListings.filter((entry) => {
    return entry.startMs !== null && entry.startMs >= nowMs;
  });

  const featured = current || upcoming[0] || sortedListings[0] || null;
  const next = current
    ? sortedListings.filter((entry) => (entry.startMs ?? 0) >= (current.endMs ?? 0))
    : upcoming.slice(featured ? 1 : 0);

  return {
    current,
    featured,
    next,
  };
}

function getProgramProgress(entry, nowMs) {
  if (!entry) {
    return 0;
  }

  const start = entry.startMs ?? getGuideTimestamp(entry.start);
  const end = entry.endMs ?? getGuideTimestamp(entry.end);
  if (start === null || end === null || end <= start) {
    return 0;
  }

  return Math.max(0, Math.min(100, ((nowMs - start) / (end - start)) * 100));
}

function groupGuideDays(listings) {
  const grouped = new Map();

  listings.forEach((entry) => {
    const start = entry.start ? String(entry.start).slice(0, 10) : 'unknown';
    const bucket = grouped.get(start) || [];
    bucket.push(entry);
    grouped.set(start, bucket);
  });

  return [...grouped.entries()].map(([key, entries]) => ({
    key,
    label: formatGuideDayLabel(key),
    entries,
  }));
}

function getAllowedLiveFormats(session) {
  const formats = session?.userInfo?.allowed_output_formats;
  if (Array.isArray(formats) && formats.length > 0) {
    return formats;
  }

  return ['m3u8', 'ts'];
}

function getPreferredLiveFormat(session) {
  const formats = getAllowedLiveFormats(session);
  return formats.includes('m3u8') ? 'm3u8' : formats[0];
}

function readStorage(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function buildPlaybackSource(session, item, outputFormat, audioMode) {
  if (!session || !item) {
    return null;
  }

  const upstreamExtension = item.type === 'live' ? outputFormat : item.containerExtension || 'mp4';
  const playerExtension = item.type === 'live' && audioMode === 'aac-stereo'
    ? 'mp4'
    : upstreamExtension;
  const params = new URLSearchParams({
    serverUrl: session.serverUrl,
    username: session.username,
    password: session.password,
    extension: upstreamExtension,
  });

  if (item.type === 'live' && audioMode) {
    params.set('audioMode', audioMode);
  }

  return {
    url: `/api/play/${item.type}/${item.id}?${params.toString()}`,
    extension: playerExtension,
  };
}

function shouldUsePlainStreamList() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const platform = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(platform)
    || (platform.includes('Mac') && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;
}

function getItemTypeLabel(itemType) {
  if (itemType === 'live') {
    return 'Live TV';
  }

  if (itemType === 'series') {
    return 'TV Series';
  }

  return 'Movies';
}

export default function App() {
  const [credentials, setCredentials] = useState({ serverUrl: '', username: '', password: '' });
  const [session, setSession] = useState(() => readStorage(sessionKey, null));
  const [favorites, setFavorites] = useState(() => readStorage(favoritesKey, []));
  const [contentType, setContentType] = useState('live');
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedEpisode, setSelectedEpisode] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState({ loading: false, error: '', authLoading: false });
  const [liveFormat, setLiveFormat] = useState(() => getPreferredLiveFormat(readStorage(sessionKey, null)));
  const [liveAudioMode, setLiveAudioMode] = useState(() => readStorage(liveAudioModeKey, 'direct'));
  const [autoCompatTarget, setAutoCompatTarget] = useState(null);
  const [epg, setEpg] = useState({ loading: false, error: '', listings: [] });
  const [channelGuideMap, setChannelGuideMap] = useState({});
  const [guideDay, setGuideDay] = useState('');
  const [guideNow, setGuideNow] = useState(() => Date.now());
  const [viewportWidth, setViewportWidth] = useState(() => {
    return typeof window === 'undefined' ? 1280 : window.innerWidth;
  });
  const [usePlainStreamList] = useState(() => shouldUsePlainStreamList());
  const [plainVisibleCount, setPlainVisibleCount] = useState(0);
  const [isBrowseMenuOpen, setIsBrowseMenuOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isSearchPaletteOpen, setIsSearchPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [debouncedCommandQuery, setDebouncedCommandQuery] = useState('');
  const [commandResults, setCommandResults] = useState({ loading: false, error: '', groups: [] });
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [seriesDetail, setSeriesDetail] = useState({ loading: false, error: '', series: null, seasons: [] });
  const [selectedSeasonKey, setSelectedSeasonKey] = useState('');
  const commandInputRef = useRef(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setGuideNow(Date.now());
    }, 60000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(favoritesKey, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    window.localStorage.setItem(liveAudioModeKey, JSON.stringify(liveAudioMode));
  }, [liveAudioMode]);

  useEffect(() => {
    if (session) {
      window.localStorage.setItem(sessionKey, JSON.stringify(session));
      setCredentials({
        serverUrl: session.serverUrl,
        username: session.username,
        password: session.password,
      });
      setLiveFormat((current) => {
        const allowedFormats = getAllowedLiveFormats(session);
        return allowedFormats.includes(current) ? current : getPreferredLiveFormat(session);
      });
      return;
    }

    window.localStorage.removeItem(sessionKey);
  }, [session]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedCommandQuery(commandQuery);
    }, 180);

    return () => window.clearTimeout(timer);
  }, [commandQuery]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const controller = new AbortController();

    async function loadCatalog() {
      setStatus((current) => ({ ...current, loading: true, error: '' }));
      const params = new URLSearchParams({
        serverUrl: session.serverUrl,
        username: session.username,
        password: session.password,
        contentType,
      });
      if (selectedCategory) {
        params.set('categoryId', selectedCategory);
      }
      if (debouncedSearch) {
        params.set('search', debouncedSearch);
      }

      try {
        const response = await fetch(`/api/catalog?${params.toString()}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load the requested catalog.');
        }

        setCategories(payload.categories || []);
        setItems(payload.items || []);
        setSelectedItem((current) => {
          if (!current) {
            return null;
          }

          const stillExists = payload.items.find((item) => item.id === current.id);
          return stillExists || current;
        });
        if (contentType !== 'series') {
          setSelectedEpisode(null);
          setSelectedSeasonKey('');
          setSeriesDetail({ loading: false, error: '', series: null, seasons: [] });
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          setStatus((current) => ({
            ...current,
            error: error.message || 'Unable to load your playlist.',
          }));
        }
      } finally {
        setStatus((current) => ({ ...current, loading: false }));
      }
    }

    loadCatalog();
    return () => controller.abort();
  }, [contentType, debouncedSearch, selectedCategory, session]);

  useEffect(() => {
    if (!session || contentType !== 'series' || !selectedItem?.id) {
      setSeriesDetail({ loading: false, error: '', series: null, seasons: [] });
      setSelectedEpisode(null);
      setSelectedSeasonKey('');
      return;
    }

    const controller = new AbortController();

    async function loadSeries() {
      setSeriesDetail((current) => ({ ...current, loading: true, error: '' }));
      const params = new URLSearchParams({
        serverUrl: session.serverUrl,
        username: session.username,
        password: session.password,
      });

      try {
        const response = await fetch(`/api/series/${selectedItem.id}?${params.toString()}`, {
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load series details.');
        }

        setSeriesDetail({
          loading: false,
          error: '',
          series: payload.series || null,
          seasons: payload.seasons || [],
        });

        const firstSeason = payload.seasons?.[0] || null;
        setSelectedSeasonKey((current) => {
          const hasCurrent = payload.seasons?.some((season) => season.key === current);
          return hasCurrent ? current : firstSeason?.key || '';
        });
        setSelectedEpisode((current) => {
          const flatEpisodes = (payload.seasons || []).flatMap((season) => season.episodes || []);
          const stillExists = flatEpisodes.find((episode) => episode.id === current?.id);
          return stillExists || firstSeason?.episodes?.[0] || null;
        });
      } catch (error) {
        if (error.name !== 'AbortError') {
          setSeriesDetail({ loading: false, error: error.message || 'Unable to load series details.', series: null, seasons: [] });
          setSelectedEpisode(null);
          setSelectedSeasonKey('');
        }
      }
    }

    loadSeries();
    return () => controller.abort();
  }, [contentType, selectedItem?.id, session]);

  useEffect(() => {
    if (!session || contentType !== 'live' || !selectedItem?.id) {
      setEpg({ loading: false, error: '', listings: [] });
      return;
    }

    const controller = new AbortController();

    async function loadEpg() {
      setEpg((current) => ({ ...current, loading: true, error: '' }));
      const params = new URLSearchParams({
        serverUrl: session.serverUrl,
        username: session.username,
        password: session.password,
        limit: '48',
      });

      try {
        const response = await fetch(`/api/epg/${selectedItem.id}?${params.toString()}`, {
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load guide data.');
        }

        setEpg({ loading: false, error: '', listings: payload.listings || [] });
      } catch (error) {
        if (error.name !== 'AbortError') {
          setEpg({
            loading: false,
            error: error.message || 'Unable to load guide data.',
            listings: [],
          });
        }
      }
    }

    loadEpg();
    return () => controller.abort();
  }, [contentType, selectedItem?.id, session]);

  useEffect(() => {
    if (!session || contentType !== 'live' || !items.length || usePlainStreamList) {
      setChannelGuideMap({});
      return;
    }

    const controller = new AbortController();
    const streamIds = items.slice(0, 24).map((item) => item.id).join(',');

    async function loadChannelSnapshots() {
      const params = new URLSearchParams({
        serverUrl: session.serverUrl,
        username: session.username,
        password: session.password,
        streamIds,
        limit: '2',
      });

      try {
        const response = await fetch(`/api/epg?${params.toString()}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load channel guide snapshots.');
        }

        setChannelGuideMap(payload.listingsByStreamId || {});
      } catch (error) {
        if (error.name !== 'AbortError') {
          setChannelGuideMap({});
        }
      }
    }

    loadChannelSnapshots();
    return () => controller.abort();
  }, [contentType, items, session, usePlainStreamList]);

  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const liveFormatOptions = useMemo(() => getAllowedLiveFormats(session), [session]);
  const streamItemHeight = useMemo(() => {
    const compactLayout = viewportWidth <= 760;
    if (contentType === 'live') {
      return compactLayout ? 148 : 118;
    }

    return compactLayout ? 104 : 88;
  }, [contentType, viewportWidth]);
  const plainPageSize = useMemo(() => {
    const compactLayout = viewportWidth <= 760;
    if (contentType === 'live') {
      return compactLayout ? 40 : 56;
    }

    return compactLayout ? 48 : 64;
  }, [contentType, viewportWidth]);
  const plainVisibleItems = useMemo(() => {
    if (!usePlainStreamList) {
      return items;
    }

    return items.slice(0, plainVisibleCount);
  }, [items, plainVisibleCount, usePlainStreamList]);
  const commandResultItems = useMemo(() => {
    return commandResults.groups.flatMap((group) => group.items);
  }, [commandResults.groups]);
  const activePlayableItem = useMemo(() => {
    return contentType === 'series' ? selectedEpisode : selectedItem;
  }, [contentType, selectedEpisode, selectedItem]);
  const activeCompatTarget = useMemo(() => {
    if (!session || contentType !== 'live' || !activePlayableItem) {
      return null;
    }

    return `${session.serverUrl}:${activePlayableItem.id}`;
  }, [activePlayableItem, contentType, session]);
  const playbackSource = useMemo(
    () => buildPlaybackSource(session, activePlayableItem, liveFormat, liveAudioMode),
    [activePlayableItem, liveAudioMode, liveFormat, session],
  );

  useEffect(() => {
    if (liveAudioMode !== 'aac-stereo' || !autoCompatTarget || !activeCompatTarget || autoCompatTarget === activeCompatTarget) {
      return;
    }

    setLiveAudioMode('direct');
  }, [activeCompatTarget, autoCompatTarget, liveAudioMode]);

  const requestLiveAudioCompatFallback = useCallback(() => {
    if (contentType !== 'live' || !activePlayableItem || liveAudioMode !== 'direct' || !activeCompatTarget) {
      return false;
    }

    if (autoCompatTarget === activeCompatTarget) {
      return false;
    }

    setAutoCompatTarget(activeCompatTarget);
    setLiveAudioMode('aac-stereo');
    return true;
  }, [activeCompatTarget, activePlayableItem, autoCompatTarget, contentType, liveAudioMode]);
  const guideSummary = useMemo(() => getGuideSummary(epg.listings, guideNow), [epg.listings, guideNow]);
  const currentProgram = useMemo(
    () => guideSummary.current || guideSummary.featured,
    [guideSummary.current, guideSummary.featured],
  );
  const nextPrograms = useMemo(() => guideSummary.next.slice(0, 5), [guideSummary.next]);
  const currentProgramProgress = useMemo(
    () => getProgramProgress(guideSummary.current, guideNow),
    [guideNow, guideSummary.current],
  );
  const guideDays = useMemo(() => groupGuideDays(epg.listings), [epg.listings]);
  const activeGuideDay = useMemo(
    () => guideDays.find((day) => day.key === guideDay) || guideDays[0] || null,
    [guideDay, guideDays],
  );
  const channelGuideSummaries = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(channelGuideMap).map(([streamId, listings]) => [streamId, getGuideSummary(listings, guideNow)]),
      ),
    [channelGuideMap, guideNow],
  );

  useEffect(() => {
    if (!guideDays.length) {
      setGuideDay('');
      return;
    }

    if (!guideDays.some((day) => day.key === guideDay)) {
      setGuideDay(guideDays[0].key);
    }
  }, [guideDay, guideDays]);

  useEffect(() => {
    if (!usePlainStreamList) {
      return;
    }

    setPlainVisibleCount(plainPageSize);
  }, [items, plainPageSize, usePlainStreamList]);

  useEffect(() => {
    if (!isBrowseMenuOpen && !isAccountMenuOpen && !isSearchPaletteOpen) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsBrowseMenuOpen(false);
        setIsAccountMenuOpen(false);
        setIsSearchPaletteOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAccountMenuOpen, isBrowseMenuOpen, isSearchPaletteOpen]);

  useEffect(() => {
    if (!session || !isSearchPaletteOpen || !debouncedCommandQuery.trim()) {
      setCommandResults({ loading: false, error: '', groups: [] });
      setActiveCommandIndex(0);
      return;
    }

    const controller = new AbortController();

    async function loadCommandResults() {
      setCommandResults((current) => ({ ...current, loading: true, error: '' }));

      try {
        const groups = await Promise.all(
          views.map(async (view) => {
            const params = new URLSearchParams({
              serverUrl: session.serverUrl,
              username: session.username,
              password: session.password,
              contentType: view.id,
              search: debouncedCommandQuery,
            });

            const response = await fetch(`/api/catalog?${params.toString()}`, { signal: controller.signal });
            const payload = await response.json();
            if (!response.ok) {
              throw new Error(payload.error || 'Unable to search the catalog.');
            }

            const categoryNames = new Map((payload.categories || []).map((category) => [String(category.id), category.name]));

            return {
              id: view.id,
              label: view.label,
              items: (payload.items || []).slice(0, 5).map((item) => ({
                ...item,
                categoryName: categoryNames.get(String(item.categoryId)) || '',
              })),
            };
          }),
        );

        setCommandResults({
          loading: false,
          error: '',
          groups: groups.filter((group) => group.items.length),
        });
        setActiveCommandIndex(0);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setCommandResults({
            loading: false,
            error: error.message || 'Unable to search the catalog.',
            groups: [],
          });
          setActiveCommandIndex(0);
        }
      }
    }

    loadCommandResults();
    return () => controller.abort();
  }, [debouncedCommandQuery, isSearchPaletteOpen, session]);

  useEffect(() => {
    if (!isSearchPaletteOpen) {
      return undefined;
    }

    const input = commandInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }

    const handleKeyDown = (event) => {
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !isTypingTarget(event.target))) {
        event.preventDefault();
        setIsSearchPaletteOpen(true);
        setIsBrowseMenuOpen(false);
        setIsAccountMenuOpen(false);
      }

      if (event.key === 'ArrowDown' && commandResultItems.length) {
        event.preventDefault();
        setActiveCommandIndex((current) => (current + 1) % commandResultItems.length);
      }

      if (event.key === 'ArrowUp' && commandResultItems.length) {
        event.preventDefault();
        setActiveCommandIndex((current) => (current - 1 + commandResultItems.length) % commandResultItems.length);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandResultItems.length, isSearchPaletteOpen]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !isTypingTarget(event.target))) {
        event.preventDefault();
        setIsSearchPaletteOpen(true);
        setIsBrowseMenuOpen(false);
        setIsAccountMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleLogin(event) {
    event.preventDefault();
    setStatus((current) => ({ ...current, authLoading: true, error: '' }));

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Login failed.');
      }

      setSession(payload);
      setSelectedCategory('');
      setIsAccountMenuOpen(false);
    } catch (error) {
      setStatus((current) => ({
        ...current,
        error: error.message || 'Unable to sign in to Xtream Codes.',
      }));
    } finally {
      setStatus((current) => ({ ...current, authLoading: false }));
    }
  }

  function updateField(event) {
    const { name, value } = event.target;
    setCredentials((current) => ({ ...current, [name]: value }));
  }

  function toggleFavorite(item) {
    const key = `${item.type}:${item.id}`;
    setFavorites((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  }

  function logout() {
    setIsBrowseMenuOpen(false);
    setIsAccountMenuOpen(false);
    setSession(null);
    setItems([]);
    setCategories([]);
    setSelectedItem(null);
    setSelectedCategory('');
  }

  const selectedCategoryLabel = categories.find((category) => category.id === selectedCategory)?.name || 'All categories';
  const activeConnections = session?.userInfo?.active_cons;
  const maxConnections = session?.userInfo?.max_connections;
  const activeSeason = useMemo(() => {
    return seriesDetail.seasons.find((season) => season.key === selectedSeasonKey) || seriesDetail.seasons[0] || null;
  }, [selectedSeasonKey, seriesDetail.seasons]);

  function toggleBrowseMenu() {
    setIsBrowseMenuOpen((current) => !current);
    setIsAccountMenuOpen(false);
    setIsSearchPaletteOpen(false);
  }

  function toggleAccountMenu() {
    setIsAccountMenuOpen((current) => !current);
    setIsBrowseMenuOpen(false);
    setIsSearchPaletteOpen(false);
  }

  function toggleSearchPalette() {
    setIsSearchPaletteOpen((current) => !current);
    setIsBrowseMenuOpen(false);
    setIsAccountMenuOpen(false);
  }

  function selectCommandResult(item) {
    setContentType(item.type);
    setSelectedCategory('');
    setSearch('');
    setSelectedItem(item);
    if (item.type === 'series') {
      setSelectedEpisode(null);
      setSelectedSeasonKey('');
    }
    setCommandQuery('');
    setDebouncedCommandQuery('');
    setCommandResults({ loading: false, error: '', groups: [] });
    setActiveCommandIndex(0);
    setIsSearchPaletteOpen(false);
  }

  if (!session) {
    return (
      <div className="app-shell app-shell-auth">
        <div className="app-bg app-bg-one" />
        <div className="app-bg app-bg-two" />

        <div className="app-topbar">
          <div className="app-mark">
            <span>SignalDeck</span>
            <small>Sign in</small>
          </div>
        </div>

        <main className="login-layout">
          <section className="panel-card auth-screen-card">
            <div className="auth-screen-copy">
              <span className="auth-kicker">Xtream login</span>
              <h1>Sign in to your IPTV provider.</h1>
              <p>Enter your Xtream Codes server URL, username, and password to open your channels and on-demand library.</p>
            </div>

            <form className="auth-form" onSubmit={handleLogin}>
              <label>
                <span>Server URL</span>
                <input
                  name="serverUrl"
                  placeholder="http://provider.example:8080"
                  value={credentials.serverUrl}
                  onChange={updateField}
                />
              </label>
              <label>
                <span>Username</span>
                <input name="username" value={credentials.username} onChange={updateField} />
              </label>
              <label>
                <span>Password</span>
                <input
                  name="password"
                  type="password"
                  value={credentials.password}
                  onChange={updateField}
                />
              </label>
              <button className="primary-button" type="submit" disabled={status.authLoading}>
                {status.authLoading ? 'Connecting...' : 'Connect to Xtream'}
              </button>
            </form>

            {status.error ? <div className="error-banner auth-error-banner">{status.error}</div> : null}
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-bg app-bg-one" />
      <div className="app-bg app-bg-two" />

      <div className="app-topbar">
        <div className="app-mark">
          <span>SignalDeck</span>
          <small>{session?.userInfo?.username || 'Connected'}</small>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className={isSearchPaletteOpen ? 'search-trigger active' : 'search-trigger'}
            aria-expanded={isSearchPaletteOpen}
            aria-controls="search-palette"
            onClick={toggleSearchPalette}
          >
            <span>
              <Search size={16} />
              Search
            </span>
            <small>Cmd+K</small>
          </button>

          <button
            type="button"
            className={isBrowseMenuOpen ? 'browse-menu-trigger active' : 'browse-menu-trigger'}
            aria-expanded={isBrowseMenuOpen}
            aria-controls="browse-menu"
            onClick={toggleBrowseMenu}
          >
            <span>
              <SlidersHorizontal size={16} />
              Browse
            </span>
          </button>

          <button
            type="button"
            className={isAccountMenuOpen ? 'account-menu-trigger active' : 'account-menu-trigger'}
            aria-expanded={isAccountMenuOpen}
            aria-controls="account-menu"
            onClick={toggleAccountMenu}
          >
            <span>Account</span>
            <strong>{session?.userInfo?.username || 'Connected'}</strong>
          </button>
        </div>
      </div>

      {isSearchPaletteOpen ? (
        <>
          <button
            type="button"
            className="browse-menu-backdrop"
            aria-label="Close search"
            onClick={() => setIsSearchPaletteOpen(false)}
          />
          <div className="search-palette" id="search-palette">
            <div className="search-palette-shell">
              <div className="search-palette-header">
                <div>
                  <h3>Search everything</h3>
                  <p>Jump straight to live channels, movies, or series.</p>
                </div>
                <button
                  type="button"
                  className="browse-menu-close"
                  onClick={() => setIsSearchPaletteOpen(false)}
                  aria-label="Close search"
                >
                  <X size={16} />
                </button>
              </div>

              <label className="search-field search-palette-field">
                <Search size={18} />
                <input
                  ref={commandInputRef}
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && commandResultItems[activeCommandIndex]) {
                      event.preventDefault();
                      selectCommandResult(commandResultItems[activeCommandIndex]);
                    }
                  }}
                  placeholder="Search channels, movies, and series"
                />
              </label>

              <div className="search-palette-body">
                {!commandQuery.trim() ? (
                  <div className="search-palette-empty">
                    <strong>Type to search across your full catalog.</strong>
                    <p>Use arrow keys to move and Enter to open the highlighted result.</p>
                  </div>
                ) : null}

                {commandResults.loading ? <div className="search-palette-empty">Searching catalog...</div> : null}
                {commandResults.error ? <div className="search-palette-empty">{commandResults.error}</div> : null}
                {!commandResults.loading && !commandResults.error && commandQuery.trim() && !commandResults.groups.length ? (
                  <div className="search-palette-empty">No matches found.</div>
                ) : null}

                {commandResults.groups.length ? (
                  <div className="search-palette-groups">
                    {commandResults.groups.map((group) => (
                      <div key={group.id} className="search-palette-group">
                        <div className="search-palette-group-header">
                          <span>{group.label}</span>
                          <strong>{group.items.length}</strong>
                        </div>

                        <div className="search-palette-result-list">
                          {group.items.map((item) => {
                            const resultIndex = commandResultItems.findIndex((entry) => `${entry.type}:${entry.id}` === `${item.type}:${item.id}`);
                            const isActive = resultIndex === activeCommandIndex;

                            return (
                              <button
                                key={`${item.type}:${item.id}`}
                                type="button"
                                className={isActive ? 'search-palette-result active' : 'search-palette-result'}
                                onMouseEnter={() => setActiveCommandIndex(resultIndex)}
                                onClick={() => selectCommandResult(item)}
                              >
                                <div>
                                  <strong>{item.name}</strong>
                                  <p>
                                    {item.type === 'series'
                                      ? item.year || getItemTypeLabel(item.type)
                                      : item.categoryName || getItemTypeLabel(item.type)}
                                  </p>
                                </div>
                                <span>{getItemTypeLabel(item.type)}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {isBrowseMenuOpen ? (
        <>
          <button
            type="button"
            className="browse-menu-backdrop"
            aria-label="Close browse menu"
            onClick={() => setIsBrowseMenuOpen(false)}
          />
          <div className="browse-menu" id="browse-menu">
            <div className="browse-menu-header">
              <div>
                <h3>Browse filters</h3>
                <p>Search and jump between categories without cluttering the main layout.</p>
              </div>
              <button
                type="button"
                className="browse-menu-close"
                onClick={() => setIsBrowseMenuOpen(false)}
                aria-label="Close browse menu"
              >
                <X size={16} />
              </button>
            </div>

            <label className="search-field browse-menu-search">
              <Search size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter current view"
              />
            </label>

            <div className="browse-menu-categories">
              <button
                className={!selectedCategory ? 'category-pill active' : 'category-pill'}
                type="button"
                onClick={() => {
                  setSelectedCategory('');
                  setIsBrowseMenuOpen(false);
                }}
              >
                All categories
              </button>
              {categories.map((category) => (
                <button
                  key={category.id}
                  className={selectedCategory === category.id ? 'category-pill active' : 'category-pill'}
                  type="button"
                  onClick={() => {
                    setSelectedCategory(category.id);
                    setIsBrowseMenuOpen(false);
                  }}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {isAccountMenuOpen ? (
        <>
          <button
            type="button"
            className="browse-menu-backdrop"
            aria-label="Close account menu"
            onClick={() => setIsAccountMenuOpen(false)}
          />
          <div className="account-menu" id="account-menu">
            <div className="account-menu-copy">
              <small>Connected account</small>
              <h3>{session?.userInfo?.username || 'Unknown account'}</h3>
              <p>{session?.serverUrl || credentials.serverUrl || 'Unknown server'}</p>
            </div>

            <div className="account-menu-meta">
              <div>
                <span>Status</span>
                <strong>Connected</strong>
              </div>
              <div>
                <span>Connections</span>
                <strong>
                  {activeConnections ?? '0'} / {maxConnections ?? 'Unknown'}
                </strong>
              </div>
              <div>
                <span>Expires</span>
                <strong>{session?.userInfo?.exp_date || 'Unknown'}</strong>
              </div>
            </div>

            <button type="button" className="account-disconnect-button" onClick={logout}>
              Log out
            </button>
          </div>
        </>
      ) : null}

      <main className="layout-grid layout-grid-connected">
        <section className="browser-card panel-card">
          <div className="section-heading browser-toolbar">
            <div className="view-toggle">
              {views.map((view) => {
                const Icon = view.icon;
                return (
                  <button
                    key={view.id}
                    type="button"
                    className={view.id === contentType ? 'active' : ''}
                    onClick={() => {
                      setContentType(view.id);
                      setSelectedCategory('');
                      setSelectedItem(null);
                      setSelectedEpisode(null);
                      setSelectedSeasonKey('');
                      setIsBrowseMenuOpen(false);
                    }}
                  >
                    <Icon size={16} />
                    {view.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="browser-layout browser-layout-popout">
            <div className="content-list">
              <div className="list-header">
                <div>
                  <h2>{contentType === 'live' ? 'Channels' : contentType === 'vod' ? 'Movie catalog' : 'TV series'}</h2>
                  <p>{items.length} results loaded</p>
                </div>
                <div className="list-header-actions">
                  <span className="browse-summary-pill">{selectedCategoryLabel}</span>
                  {contentType === 'live' ? (
                    <>
                      <label className="format-select">
                        Output
                        <select value={liveFormat} onChange={(event) => setLiveFormat(event.target.value)}>
                          {liveFormatOptions.map((format) => (
                            <option key={format} value={format}>
                              {format === 'm3u8' ? 'HLS (.m3u8)' : `${format.toUpperCase()} (.${format})`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="format-select">
                        Audio
                        <select
                          value={liveAudioMode}
                          onChange={(event) => {
                            const nextMode = event.target.value;
                            setAutoCompatTarget(null);
                            setLiveAudioMode(nextMode);
                          }}
                        >
                          <option value="direct">Direct</option>
                          <option value="aac-stereo">AAC stereo compatibility</option>
                        </select>
                      </label>
                    </>
                  ) : null}
                </div>
              </div>

              {status.loading ? <div className="empty-message">Loading catalog...</div> : null}
              {!status.loading && !items.length ? (
                <div className="empty-message">No streams match the current filter.</div>
              ) : null}

              {usePlainStreamList ? (
                <>
                  <div className="stream-grid">
                  {plainVisibleItems.map((item) => {
                    const favoriteKey = `${item.type}:${item.id}`;
                    const isFavorite = favoriteIds.has(favoriteKey);

                    return (
                      <article
                        key={item.id}
                        className={selectedItem?.id === item.id ? 'stream-card active' : 'stream-card'}
                        onClick={() => setSelectedItem(item)}
                      >
                        <div className="stream-card-media">
                          {item.logo ? <img src={item.logo} alt="" loading="lazy" /> : <Radio size={18} />}
                        </div>
                        <div className="stream-card-copy">
                          <h3>{item.name}</h3>
                          <p>{contentType === 'live' ? 'Tap to play' : contentType === 'series' ? item.year || 'Select a series' : item.categoryId || 'Unsorted'}</p>
                        </div>
                        <button
                          type="button"
                          className={isFavorite ? 'favorite-button active' : 'favorite-button'}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleFavorite(item);
                          }}
                        >
                          <Heart size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                        </button>
                      </article>
                    );
                  })}
                  </div>
                  {plainVisibleCount < items.length ? (
                    <div className="stream-grid-footer">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setPlainVisibleCount((current) => current + plainPageSize)}
                      >
                        Load {Math.min(plainPageSize, items.length - plainVisibleCount)} more {contentType === 'live' ? 'channels' : contentType === 'series' ? 'series' : 'titles'}
                      </button>
                      <p>
                        Showing {plainVisibleItems.length} of {items.length}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <VirtualizedStreamList
                  className="stream-grid"
                  items={items}
                  itemHeight={streamItemHeight}
                  itemKey={(item) => item.id}
                  renderItem={(item) => {
                    const favoriteKey = `${item.type}:${item.id}`;
                    const isFavorite = favoriteIds.has(favoriteKey);
                    const itemGuide = channelGuideSummaries[item.id];
                    const itemProgram = itemGuide?.current || itemGuide?.featured || null;
                    const itemProgress = getProgramProgress(itemGuide?.current, guideNow);

                    return (
                      <article
                        className={selectedItem?.id === item.id ? 'stream-card active' : 'stream-card'}
                        onClick={() => setSelectedItem(item)}
                      >
                        <div className="stream-card-media">
                          {item.logo ? <img src={item.logo} alt="" loading="lazy" /> : <Radio size={18} />}
                        </div>
                        <div className="stream-card-copy">
                          <h3>{item.name}</h3>
                          {contentType === 'live' && itemProgram ? (
                            <>
                              <p className="stream-program">{itemProgram.title}</p>
                              <p>{formatGuideRange(itemProgram)}</p>
                              {itemGuide?.current ? (
                                <div className="stream-progress-track">
                                  <span style={{ width: `${itemProgress}%` }} />
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <p>{item.categoryId || 'Unsorted'}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          className={isFavorite ? 'favorite-button active' : 'favorite-button'}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleFavorite(item);
                          }}
                        >
                          <Heart size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                        </button>
                      </article>
                    );
                  }}
                />
              )}
            </div>
          </div>
        </section>

        <section className="panel-card playback-card">
          <div className="playback-player-sticky">
            <Suspense fallback={<div className="player-panel-skeleton">Loading player...</div>}>
              <PlayerPanel
                source={playbackSource}
                title={activePlayableItem?.name || selectedItem?.name}
                onCompatFallback={requestLiveAudioCompatFallback}
                subtitle={
                  contentType === 'series'
                    ? selectedEpisode
                      ? `${selectedItem?.name || ''}${selectedEpisode.seasonLabel ? `  ${selectedEpisode.seasonLabel}` : ''}${selectedEpisode.episodeNumber ? `  Episode ${selectedEpisode.episodeNumber}` : ''}`
                      : seriesDetail.series?.plot || 'Select a series to browse episodes.'
                    : currentProgram
                    ? `${formatGuideRange(currentProgram)}  ${currentProgram.title}`
                    : selectedItem?.plot || selectedItem?.epgChannelId || 'Select a title to inspect it here.'
                }
                poster={activePlayableItem?.logo || selectedItem?.logo}
              />
            </Suspense>
          </div>

          {contentType === 'live' ? (
            <section className="epg-panel">
              <div className="section-heading epg-heading">
                <div>
                  <h2>Guide</h2>
                  <p>{selectedItem?.name ? `Schedule for ${selectedItem.name}` : 'Select a live channel'}</p>
                </div>
                {epg.loading ? <span className="stream-pill epg-pill">Loading</span> : null}
              </div>

              {currentProgram ? (
                <article className="epg-now-card">
                  <span className="eyebrow">{guideSummary.current ? 'Now Playing' : 'Up Next'}</span>
                  <h3>{currentProgram.title}</h3>
                  <p>{formatGuideRange(currentProgram)}</p>
                  {guideSummary.current ? (
                    <div className="epg-progress-track">
                      <span style={{ width: `${currentProgramProgress}%` }} />
                    </div>
                  ) : null}
                  {currentProgram.description ? <p>{currentProgram.description}</p> : null}
                </article>
              ) : null}

              {epg.error ? <div className="empty-message">{epg.error}</div> : null}
              {!epg.loading && !epg.error && !epg.listings.length ? (
                <div className="empty-message">No guide data is available for this channel.</div>
              ) : null}

              {nextPrograms.length ? (
                <div className="epg-up-next">
                  <h3>Up Next</h3>
                  <div className="epg-list">
                    {nextPrograms.map((entry) => (
                      <article className="epg-entry" key={entry.id}>
                        <div>
                          <strong>{entry.title}</strong>
                          <p>{entry.description || 'No synopsis provided.'}</p>
                        </div>
                        <span>{formatGuideRange(entry)}</span>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              {guideDays.length ? (
                <div className="epg-day-browser">
                  <div className="epg-day-tabs">
                    {guideDays.map((day) => (
                      <button
                        key={day.key}
                        type="button"
                        className={day.key === activeGuideDay?.key ? 'active' : ''}
                        onClick={() => setGuideDay(day.key)}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>

                  {activeGuideDay ? (
                    <div className="epg-day-list">
                      {activeGuideDay.entries.map((entry) => {
                        const isCurrent = guideSummary.current?.id === entry.id;
                        return (
                          <article className={isCurrent ? 'epg-entry active' : 'epg-entry'} key={entry.id}>
                            <div>
                              <strong>{entry.title}</strong>
                              <p>{entry.description || 'No synopsis provided.'}</p>
                            </div>
                            <span>{formatGuideRange(entry)}</span>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {contentType === 'series' ? (
            <section className="series-panel">
              <div className="section-heading series-heading">
                <div>
                  <h2>Episodes</h2>
                  <p>{selectedItem?.name ? `Browse episodes for ${selectedItem.name}` : 'Select a series'}</p>
                </div>
                {seriesDetail.loading ? <span className="stream-pill epg-pill">Loading</span> : null}
              </div>

              {seriesDetail.error ? <div className="empty-message">{seriesDetail.error}</div> : null}
              {!seriesDetail.loading && !seriesDetail.error && !seriesDetail.seasons.length ? (
                <div className="empty-message">No episodes are available for this series.</div>
              ) : null}

              {seriesDetail.series ? (
                <article className="series-summary-card">
                  <div>
                    <h3>{seriesDetail.series.name}</h3>
                    <p>{seriesDetail.series.plot || 'No description provided.'}</p>
                  </div>
                  <div className="series-summary-meta">
                    {seriesDetail.series.year ? <span>{seriesDetail.series.year}</span> : null}
                    {seriesDetail.series.genre ? <span>{seriesDetail.series.genre}</span> : null}
                  </div>
                </article>
              ) : null}

              {seriesDetail.seasons.length ? (
                <div className="series-browser">
                  <div className="series-season-tabs">
                    {seriesDetail.seasons.map((season) => (
                      <button
                        key={season.key}
                        type="button"
                        className={season.key === activeSeason?.key ? 'active' : ''}
                        onClick={() => {
                          setSelectedSeasonKey(season.key);
                          setSelectedEpisode((current) => season.episodes.find((episode) => episode.id === current?.id) || season.episodes[0] || null);
                        }}
                      >
                        {season.label}
                      </button>
                    ))}
                  </div>

                  {activeSeason ? (
                    <div className="series-episode-list">
                      {activeSeason.episodes.map((episode) => (
                        <article
                          key={episode.id}
                          className={selectedEpisode?.id === episode.id ? 'series-episode-card active' : 'series-episode-card'}
                          onClick={() => setSelectedEpisode(episode)}
                        >
                          <div className="series-episode-copy">
                            <strong>{episode.episodeNumber ? `Episode ${episode.episodeNumber}: ` : ''}{episode.name}</strong>
                            <p>{episode.plot || 'No synopsis provided.'}</p>
                          </div>
                          <span>{episode.airDate || episode.containerExtension?.toUpperCase() || 'Episode'}</span>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </section>
      </main>

      {status.error ? <div className="error-banner">{status.error}</div> : null}
    </div>
  );
}
