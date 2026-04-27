import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Maximize, Pause, Play, Volume2 } from 'lucide-react';

function canFullscreenVideo(video) {
  if (!video) {
    return false;
  }

  return Boolean(video.requestFullscreen || video.webkitEnterFullscreen || video.webkitRequestFullscreen);
}

function canUseNativeHls(video) {
  if (!video?.canPlayType) {
    return false;
  }

  return Boolean(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));
}

export default function PlayerPanel({ source, title, subtitle, poster }) {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playerError, setPlayerError] = useState('');
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);

  const isHls = useMemo(() => source?.extension === 'm3u8', [source?.extension]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source?.url) {
      return undefined;
    }

    let cancelled = false;
    let hls;
    setPlayerError('');
    setIsPlaying(false);

    const attemptPlayback = () => {
      video.play().catch(() => {
        setPlayerError('Playback is ready. Press Play if your browser blocked auto-start.');
      });
    };

    const onVideoError = () => {
      setPlayerError('The browser could not load this stream. Try another live output format.');
    };

    video.addEventListener('error', onVideoError);

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
              setPlayerError('This stream could not be decoded in the browser. Try another output format.');
            }
          });
          return;
        }
      }

      video.addEventListener('loadedmetadata', attemptPlayback, { once: true });
      video.src = source.url;
    }

    loadSource().catch(() => {
      setPlayerError('The player failed to initialize this stream. Try another output format.');
    });

    return () => {
      cancelled = true;
      video.removeEventListener('error', onVideoError);
      if (hls) {
        hls.destroy();
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [isHls, source?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    setFullscreenAvailable(canFullscreenVideo(video));

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, []);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.paused) {
      video.play().catch(() => {
        setPlayerError('Playback was blocked by the browser. Interact with the page and try again.');
      });
      return;
    }

    video.pause();
  }

  function toggleFullscreen() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.requestFullscreen) {
      video.requestFullscreen().catch(() => {
        setPlayerError('Fullscreen is not available in this browser.');
      });
      return;
    }

    if (video.webkitRequestFullscreen) {
      video.webkitRequestFullscreen();
      return;
    }

    if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      return;
    }

    setPlayerError('Fullscreen is not available in this browser.');
  }

  function handleFullscreenClick() {
    if (!source?.url) {
      return;
    }

    try {
      toggleFullscreen();
    } catch {
      setPlayerError('Fullscreen is not available in this browser.');
    }
  }

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

        <div className="player-actions">
          <button type="button" onClick={togglePlayback} disabled={!source?.url}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={handleFullscreenClick} disabled={!source?.url || !fullscreenAvailable}>
            <Maximize size={16} />
            Fullscreen
          </button>
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

        <span className="stream-pill">{source?.extension?.toUpperCase() || 'IDLE'}</span>
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
