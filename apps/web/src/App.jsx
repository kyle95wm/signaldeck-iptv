import { useEffect, useMemo, useState } from 'react';
import { Bolt, Film, Heart, Radio, Search, ShieldCheck, Tv2 } from 'lucide-react';
import PlayerPanel from './components/PlayerPanel';

const sessionKey = 'signaldeck-session';
const favoritesKey = 'signaldeck-favorites';

const views = [
  { id: 'live', label: 'Live TV', icon: Radio },
  { id: 'vod', label: 'Movies', icon: Film },
];

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

  return new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
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

  return new Intl.DateTimeFormat([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(dayDate);
}

function getGuideSummary(listings, nowMs) {
  const sortedListings = [...(listings || [])].sort((left, right) => {
    return (getGuideTimestamp(left.start) ?? Number.MAX_SAFE_INTEGER)
      - (getGuideTimestamp(right.start) ?? Number.MAX_SAFE_INTEGER);
  });

  const current = sortedListings.find((entry) => {
    const start = getGuideTimestamp(entry.start);
    const end = getGuideTimestamp(entry.end);
    return start !== null && end !== null && nowMs >= start && nowMs < end;
  }) || null;

  const upcoming = sortedListings.filter((entry) => {
    const start = getGuideTimestamp(entry.start);
    return start !== null && start >= nowMs;
  });

  const featured = current || upcoming[0] || sortedListings[0] || null;
  const next = current
    ? sortedListings.filter((entry) => (getGuideTimestamp(entry.start) ?? 0) >= (getGuideTimestamp(current.end) ?? 0))
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

  const start = getGuideTimestamp(entry.start);
  const end = getGuideTimestamp(entry.end);
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

function buildPlaybackSource(session, item, outputFormat) {
  if (!session || !item) {
    return null;
  }

  const extension = item.type === 'live' ? outputFormat : item.containerExtension || 'mp4';
  const params = new URLSearchParams({
    serverUrl: session.serverUrl,
    username: session.username,
    password: session.password,
    extension,
  });

  return {
    url: `/api/play/${item.type}/${item.id}?${params.toString()}`,
    extension,
  };
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
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState({ loading: false, error: '', authLoading: false });
  const [liveFormat, setLiveFormat] = useState(() => getPreferredLiveFormat(readStorage(sessionKey, null)));
  const [epg, setEpg] = useState({ loading: false, error: '', listings: [] });
  const [channelGuideMap, setChannelGuideMap] = useState({});
  const [guideDay, setGuideDay] = useState('');
  const [guideNow, setGuideNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setGuideNow(Date.now());
    }, 60000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(favoritesKey, JSON.stringify(favorites));
  }, [favorites]);

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
      if (search) {
        params.set('search', search);
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
          if (!payload.items?.length) {
            return null;
          }

          const stillExists = payload.items.find((item) => item.id === current?.id);
          return stillExists || null;
        });
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
  }, [contentType, search, selectedCategory, session]);

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
    if (!session || contentType !== 'live' || !items.length) {
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
  }, [contentType, items, session]);

  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const liveFormatOptions = useMemo(() => getAllowedLiveFormats(session), [session]);
  const playbackSource = useMemo(
    () => buildPlaybackSource(session, selectedItem, liveFormat),
    [liveFormat, selectedItem, session],
  );
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
    setSession(null);
    setItems([]);
    setCategories([]);
    setSelectedItem(null);
    setSelectedCategory('');
  }

  return (
    <div className="app-shell">
      <div className="app-bg app-bg-one" />
      <div className="app-bg app-bg-two" />

      <header className="hero-card">
        <div>
          <span className="eyebrow">Docker-ready Xtream Codes client</span>
          <h1>SignalDeck IPTV</h1>
          <p>
            Browse live channels and on-demand titles from your Xtream Codes provider in a
            focused browser player with local favorites and proxied playback.
          </p>
        </div>

        <div className="hero-points">
          <div>
            <ShieldCheck size={18} />
            <span>Credentials stay in your local session.</span>
          </div>
          <div>
            <Tv2 size={18} />
            <span>HLS manifests are proxied for smoother browser playback.</span>
          </div>
          <div>
            <Bolt size={18} />
            <span>Runs as a clean two-container Docker stack.</span>
          </div>
        </div>
      </header>

      <main className="layout-grid">
        <section className="auth-card panel-card">
          <div className="section-heading">
            <h2>Connection</h2>
            {session ? <button onClick={logout}>Disconnect</button> : null}
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

          <div className="session-meta">
            <div>
              <span>Status</span>
              <strong>{session ? 'Connected' : 'Idle'}</strong>
            </div>
            <div>
              <span>Account</span>
              <strong>{session?.userInfo?.username || 'Not signed in'}</strong>
            </div>
            <div>
              <span>Expires</span>
              <strong>{session?.userInfo?.exp_date || 'Unknown'}</strong>
            </div>
          </div>
        </section>

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
                    }}
                  >
                    <Icon size={16} />
                    {view.label}
                  </button>
                );
              })}
            </div>

            <label className="search-field">
              <Search size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search streams"
              />
            </label>
          </div>

          <div className="browser-layout">
            <aside className="category-rail">
              <button
                className={!selectedCategory ? 'category-pill active' : 'category-pill'}
                type="button"
                onClick={() => setSelectedCategory('')}
              >
                All categories
              </button>
              {categories.map((category) => (
                <button
                  key={category.id}
                  className={selectedCategory === category.id ? 'category-pill active' : 'category-pill'}
                  type="button"
                  onClick={() => setSelectedCategory(category.id)}
                >
                  {category.name}
                </button>
              ))}
            </aside>

            <div className="content-list">
              <div className="list-header">
                <div>
                  <h2>{contentType === 'live' ? 'Channels' : 'Movie catalog'}</h2>
                  <p>{items.length} results loaded</p>
                </div>
                {contentType === 'live' ? (
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
                ) : null}
              </div>

              {status.loading ? <div className="empty-message">Loading catalog...</div> : null}
              {!status.loading && !items.length ? (
                <div className="empty-message">No streams match the current filter.</div>
              ) : null}

              <div className="stream-grid">
                {items.map((item) => {
                  const favoriteKey = `${item.type}:${item.id}`;
                  const isFavorite = favoriteIds.has(favoriteKey);
                  const itemGuide = channelGuideSummaries[item.id];
                  const itemProgram = itemGuide?.current || itemGuide?.featured || null;
                  const itemProgress = getProgramProgress(itemGuide?.current, guideNow);
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
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="panel-card playback-card">
          <PlayerPanel
            source={playbackSource}
            title={selectedItem?.name}
            subtitle={
              currentProgram
                ? `${formatGuideRange(currentProgram)}  ${currentProgram.title}`
                : selectedItem?.plot || selectedItem?.epgChannelId || 'Select a title to inspect it here.'
            }
            poster={selectedItem?.logo}
          />

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
        </section>
      </main>

      {status.error ? <div className="error-banner">{status.error}</div> : null}
    </div>
  );
}
