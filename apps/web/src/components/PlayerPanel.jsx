import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Volume2 } from 'lucide-react';

function canUseNativeHls(video) {
  if (!video?.canPlayType) {
    return false;
  }

  return Boolean(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));
}

function getDecodedAudioBytes(video) {
  const decodedBytes = video?.webkitAudioDecodedByteCount;
  return typeof decodedBytes === 'number' && Number.isFinite(decodedBytes) ? decodedBytes : null;
}

export default function PlayerPanel({ source, title, subtitle, poster, playbackModeLabel, onProxyFallback, onCompatFallback }) {
  const videoRef = useRef(null);
  const [volume, setVolume] = useState(1);
  const [playerError, setPlayerError] = useState('');

  const isHls = useMemo(() => source?.extension === 'm3u8', [source?.extension]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source?.url) {
      return undefined;
    }

    let cancelled = false;
    let hls;
    let compatCheckTimer = null;
    let compatCheckStarted = false;
    setPlayerError('');

    const requestCompatFallback = () => {
      if (typeof onCompatFallback === 'function') {
        return onCompatFallback();
      }

      return false;
    };

    const requestProxyFallback = () => {
      if (typeof onProxyFallback === 'function') {
        return onProxyFallback();
      }

      return false;
    };

    const requestNextFallback = () => {
      if (source?.deliveryMode === 'direct' && requestProxyFallback()) {
        setPlayerError('Retrying this stream through the server compatibility proxy...');
        return true;
      }

      if (requestCompatFallback()) {
        setPlayerError('Retrying this live stream with AAC stereo compatibility...');
        return true;
      }

      return false;
    };

    const clearCompatCheck = () => {
      if (compatCheckTimer) {
        window.clearTimeout(compatCheckTimer);
        compatCheckTimer = null;
      }
    };

    const scheduleCompatCheck = () => {
      if (compatCheckStarted || video.muted || video.volume === 0) {
        return;
      }

      const initialDecodedBytes = getDecodedAudioBytes(video);
      if (initialDecodedBytes === null) {
        return;
      }

      const initialTime = video.currentTime;
      compatCheckStarted = true;
      clearCompatCheck();
      compatCheckTimer = window.setTimeout(() => {
        compatCheckTimer = null;

        if (cancelled || video.paused || video.ended || video.muted || video.volume === 0) {
          return;
        }

        const elapsedTime = video.currentTime - initialTime;
        const nextDecodedBytes = getDecodedAudioBytes(video);
        if (elapsedTime >= 2 && nextDecodedBytes !== null && nextDecodedBytes <= initialDecodedBytes) {
          requestNextFallback();
        }
      }, 4000);
    };

    const attemptPlayback = () => {
      video.play().catch(() => {
        setPlayerError('Playback is ready. Press Play if your browser blocked auto-start.');
      });
    };

    const onVideoError = () => {
      if (requestNextFallback()) {
        return;
      }

      setPlayerError('The browser could not load this stream. Try another live output format.');
    };

    video.addEventListener('error', onVideoError);
    video.addEventListener('playing', scheduleCompatCheck, { once: true });

    async function loadSource() {
      if (isHls && canUseNativeHls(video)) {
        video.addEventListener('loadedmetadata', attemptPlayback, { once: true });
        video.src = source.url;
        return;
      }

      if (isHls) {
        const { default: Hls } = await import('hls.js');
        if (cancelled) {
          return;
        }

        if (Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
          });
          hls.on(Hls.Events.MANIFEST_PARSED, attemptPlayback);
          hls.loadSource(source.url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              if (requestNextFallback()) {
                return;
              }

              setPlayerError('This stream could not be decoded in the browser. Try another output format or enable AAC stereo compatibility.');
            }
          });
          return;
        }
      }

      video.addEventListener('loadedmetadata', attemptPlayback, { once: true });
      video.src = source.url;
    }

    loadSource().catch(() => {
      if (requestNextFallback()) {
        return;
      }

      setPlayerError('The player failed to initialize this stream. Try another output format or enable AAC stereo compatibility.');
    });

    return () => {
      cancelled = true;
      clearCompatCheck();
      video.removeEventListener('error', onVideoError);
      video.removeEventListener('playing', scheduleCompatCheck);
      if (hls) {
        hls.destroy();
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [isHls, onCompatFallback, onProxyFallback, source?.deliveryMode, source?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }
    return undefined;
  }, []);

  function updateVolume(nextVolume) {
    const numericVolume = Number(nextVolume);
    setVolume(numericVolume);
    if (videoRef.current) {
      videoRef.current.volume = numericVolume;
    }
  }

  return (
    <section className="player-panel">
      <div className="player-video-shell">
        <video
          ref={videoRef}
          className="player-video"
          controls
          poster={poster || undefined}
          playsInline
        />
        {!source?.url ? (
          <div className="player-empty-state">
            <p>Pick a channel or movie to begin playback.</p>
          </div>
        ) : null}
      </div>

      <div className="player-toolbar">
        <div>
          <h2>{title || 'Nothing selected'}</h2>
          <p>{subtitle || 'Your stream metadata will appear here.'}</p>
        </div>
      </div>

      <div className="player-footer">
        <label className="volume-control">
          <Volume2 size={16} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(event) => updateVolume(event.target.value)}
          />
        </label>

        <div className="player-pill-group">
          <span className="stream-pill">{source?.extension?.toUpperCase() || 'IDLE'}</span>
          {playbackModeLabel ? <span className="stream-pill stream-pill-secondary">{playbackModeLabel}</span> : null}
        </div>
      </div>

      {playerError ? (
        <div className="player-error">
          <AlertCircle size={16} />
          <span>{playerError}</span>
        </div>
      ) : null}
    </section>
  );
}
