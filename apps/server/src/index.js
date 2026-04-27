import { spawn } from 'node:child_process';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { Readable } from 'node:stream';

const app = express();
const port = process.env.PORT || 3001;
const corsOrigin = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(morgan('dev'));

const categoryActions = {
  live: 'get_live_categories',
  vod: 'get_vod_categories',
  series: 'get_series_categories',
};

const streamActions = {
  live: 'get_live_streams',
  vod: 'get_vod_streams',
  series: 'get_series',
};

function normalizeServerUrl(serverUrl) {
  if (!serverUrl) {
    throw new Error('Server URL is required.');
  }

  const normalized = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`;
  return new URL(normalized).toString().replace(/\/$/, '');
}

function getPlayerApiUrl(serverUrl) {
  return `${normalizeServerUrl(serverUrl)}/player_api.php`;
}

function decodeMaybeBase64(value) {
  if (!value || typeof value !== 'string') {
    return value || '';
  }

  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
}

async function xtreamRequest({ serverUrl, username, password, action, params = {} }) {
  const url = new URL(getPlayerApiUrl(serverUrl));
  url.searchParams.set('username', username);
  url.searchParams.set('password', password);
  if (action) {
    url.searchParams.set('action', action);
  }
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'IPTVPlayer/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Xtream API request failed with status ${response.status}.`);
  }

  return response.json();
}

function buildStreamUrl({ serverUrl, username, password, contentType, streamId, extension }) {
  const baseUrl = normalizeServerUrl(serverUrl);

  if (contentType === 'live') {
    const liveExtension = extension || 'm3u8';
    return `${baseUrl}/live/${username}/${password}/${streamId}.${liveExtension}`;
  }

  if (contentType === 'series') {
    const seriesExtension = extension || 'mp4';
    return `${baseUrl}/series/${username}/${password}/${streamId}.${seriesExtension}`;
  }

  const vodExtension = extension || 'mp4';
  return `${baseUrl}/movie/${username}/${password}/${streamId}.${vodExtension}`;
}

function mapCategory(category) {
  return {
    id: category.category_id,
    name: category.category_name,
    parentId: category.parent_id || null,
  };
}

function mapItem(item, contentType) {
  return {
    id: item.stream_id || item.series_id,
    name: item.name,
    categoryId: item.category_id,
    logo: item.stream_icon || item.cover || '',
    type: contentType,
    added: item.added || null,
    epgChannelId: item.epg_channel_id || null,
    rating: item.rating || null,
    plot: item.plot || item.series_plot || '',
    containerExtension: item.container_extension || null,
    year: item.year || item.releaseDate || null,
  };
}

function mapSeriesEpisode(episode, seasonNumber) {
  const info = episode.info || {};
  const episodeId = episode.id || episode.episode_id || info.id;

  return {
    id: episodeId,
    name: episode.title || episode.name || info.name || `Episode ${episode.episode_num || ''}`.trim(),
    type: 'series',
    seasonNumber: Number(seasonNumber) || seasonNumber,
    seasonLabel: `Season ${seasonNumber}`,
    episodeNumber: episode.episode_num || info.episode_num || null,
    plot: decodeMaybeBase64(info.plot || episode.plot || ''),
    logo: info.movie_image || episode.cover_big || episode.cover || '',
    containerExtension: episode.container_extension || info.container_extension || 'mp4',
    added: episode.added || info.added || null,
    rating: info.rating || episode.rating || null,
    airDate: info.releaseDate || episode.releaseDate || null,
  };
}

function mapSeriesInfo(payload, seriesId) {
  const info = payload?.info || {};
  const rawEpisodes = payload?.episodes || {};
  const seasons = Object.entries(rawEpisodes)
    .map(([seasonNumber, episodes]) => ({
      key: String(seasonNumber),
      label: `Season ${seasonNumber}`,
      episodes: (Array.isArray(episodes) ? episodes : [])
        .map((episode) => mapSeriesEpisode(episode, seasonNumber))
        .filter((episode) => episode.id),
    }))
    .filter((season) => season.episodes.length)
    .sort((left, right) => Number(left.key) - Number(right.key));

  return {
    series: {
      id: seriesId,
      name: info.name || payload?.series_name || 'Untitled series',
      plot: decodeMaybeBase64(info.plot || payload?.plot || ''),
      logo: info.cover_big || info.cover || '',
      rating: info.rating || null,
      year: info.releaseDate || info.year || null,
      genre: info.genre || null,
      cast: info.cast || null,
    },
    seasons,
  };
}

function normalizeEpgEntry(entry) {
  const start = entry.start || entry.start_timestamp || entry.start_datetime || null;
  const end = entry.end || entry.stop || entry.end_timestamp || entry.stop_timestamp || null;

  return {
    id: entry.id || `${entry.start || 'epg'}-${entry.end || 'entry'}`,
    title: decodeMaybeBase64(entry.title || entry.name || 'Untitled program'),
    description: decodeMaybeBase64(entry.description || entry.desc || ''),
    start,
    end,
    category: entry.category || null,
  };
}

function filterItems(items, categoryId, search) {
  return items.filter((item) => {
    const categoryMatch = categoryId ? String(item.categoryId) === String(categoryId) : true;
    const searchMatch = search
      ? item.name.toLowerCase().includes(search.toLowerCase())
      : true;

    return categoryMatch && searchMatch;
  });
}

function rewriteManifest(manifest, sourceUrl) {
  return manifest
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXTINF')) {
        return line;
      }

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const absolute = new URL(uri, sourceUrl).toString();
          return `URI="/api/proxy?target=${encodeURIComponent(absolute)}"`;
        });
      }

      const absolute = new URL(trimmed, sourceUrl).toString();
      return `/api/proxy?target=${encodeURIComponent(absolute)}`;
    })
    .join('\n');
}

async function proxyRemote(req, res, targetUrl) {
  const headers = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': 'IPTVPlayer/1.0',
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const upstream = await fetch(targetUrl, { headers });

  if (!upstream.ok && upstream.status !== 206) {
    const message = await upstream.text();
    res.status(upstream.status).json({ error: message || 'Upstream stream request failed.' });
    return;
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const cacheControl = upstream.headers.get('cache-control');
  const contentRange = upstream.headers.get('content-range');
  const contentLength = upstream.headers.get('content-length');

  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl);
  }
  if (contentRange) {
    res.setHeader('Content-Range', contentRange);
  }
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  res.setHeader('Accept-Ranges', 'bytes');

  if (contentType.includes('mpegurl') || targetUrl.endsWith('.m3u8')) {
    const manifest = await upstream.text();
    res.send(rewriteManifest(manifest, upstream.url || targetUrl));
    return;
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

async function transcodeLiveAudio(req, res, targetUrl) {
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    targetUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '160k',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  ];

  let stderrOutput = '';
  let started = false;
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stopTranscode = () => {
    if (!ffmpeg.killed) {
      ffmpeg.kill('SIGKILL');
    }
  };

  req.on('close', stopTranscode);
  res.on('close', stopTranscode);

  ffmpeg.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
  });

  ffmpeg.once('spawn', () => {
    started = true;
    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Transfer-Encoding', 'chunked');
    ffmpeg.stdout.pipe(res);
  });

  ffmpeg.once('error', (error) => {
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || 'Unable to start ffmpeg for audio compatibility mode.',
      });
      return;
    }

    res.end();
  });

  ffmpeg.once('close', (code) => {
    req.off('close', stopTranscode);
    res.off('close', stopTranscode);

    if (code === 0) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (!started && !res.headersSent) {
      res.status(500).json({
        error: stderrOutput.trim() || 'Unable to transcode this stream to AAC stereo.',
      });
      return;
    }

    if (!res.writableEnded) {
      res.end();
    }
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const { serverUrl, username, password } = req.body || {};

  if (!serverUrl || !username || !password) {
    res.status(400).json({ error: 'Server URL, username, and password are required.' });
    return;
  }

  try {
    const payload = await xtreamRequest({ serverUrl, username, password });

    if (!payload?.user_info?.auth || payload.user_info.auth === 0) {
      res.status(401).json({ error: 'Xtream Codes rejected these credentials.' });
      return;
    }

    res.json({
      serverUrl: normalizeServerUrl(serverUrl),
      username,
      password,
      userInfo: payload.user_info,
      serverInfo: payload.server_info,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to authenticate with Xtream Codes.' });
  }
});

app.get('/api/catalog', async (req, res) => {
  const { serverUrl, username, password, contentType = 'live', categoryId = '', search = '' } = req.query;

  if (!serverUrl || !username || !password) {
    res.status(400).json({ error: 'Missing Xtream credentials.' });
    return;
  }

  if (!categoryActions[contentType] || !streamActions[contentType]) {
    res.status(400).json({ error: 'Unsupported content type.' });
    return;
  }

  try {
    const [categories, items] = await Promise.all([
      xtreamRequest({
        serverUrl,
        username,
        password,
        action: categoryActions[contentType],
      }),
      xtreamRequest({
        serverUrl,
        username,
        password,
        action: streamActions[contentType],
      }),
    ]);

    const mappedItems = filterItems(
      (items || []).map((item) => mapItem(item, contentType)),
      categoryId,
      search,
    );

    res.json({
      categories: (categories || []).map(mapCategory),
      items: mappedItems,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load Xtream catalog.' });
  }
});

app.get('/api/series/:seriesId', async (req, res) => {
  const { seriesId } = req.params;
  const { serverUrl, username, password } = req.query;

  if (!serverUrl || !username || !password) {
    res.status(400).json({ error: 'Missing Xtream credentials.' });
    return;
  }

  try {
    const payload = await xtreamRequest({
      serverUrl,
      username,
      password,
      action: 'get_series_info',
      params: { series_id: seriesId },
    });

    res.json(mapSeriesInfo(payload, seriesId));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load series data.' });
  }
});

app.get('/api/epg/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const { serverUrl, username, password, limit = 12 } = req.query;

  if (!serverUrl || !username || !password) {
    res.status(400).json({ error: 'Missing Xtream credentials.' });
    return;
  }

  try {
    const payload = await xtreamRequest({
      serverUrl,
      username,
      password,
      action: 'get_short_epg',
      params: {
        stream_id: streamId,
        limit,
      },
    });

    const listings = (payload?.epg_listings || payload?.listings || [])
      .map(normalizeEpgEntry)
      .filter((entry) => entry.start || entry.end || entry.title);

    res.json({ listings });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load EPG data.' });
  }
});

app.get('/api/epg', async (req, res) => {
  const { serverUrl, username, password, streamIds = '', limit = 2 } = req.query;

  if (!serverUrl || !username || !password) {
    res.status(400).json({ error: 'Missing Xtream credentials.' });
    return;
  }

  const parsedStreamIds = String(streamIds)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!parsedStreamIds.length) {
    res.status(400).json({ error: 'At least one stream ID is required.' });
    return;
  }

  try {
    const entries = await Promise.all(
      parsedStreamIds.map(async (streamId) => {
        const payload = await xtreamRequest({
          serverUrl,
          username,
          password,
          action: 'get_short_epg',
          params: {
            stream_id: streamId,
            limit,
          },
        });

        const listings = (payload?.epg_listings || payload?.listings || [])
          .map(normalizeEpgEntry)
          .filter((entry) => entry.start || entry.end || entry.title);

        return [streamId, listings];
      }),
    );

    res.json({ listingsByStreamId: Object.fromEntries(entries) });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to load guide snapshots.' });
  }
});

app.get('/api/play/:contentType/:streamId', async (req, res) => {
  const { contentType, streamId } = req.params;
  const { serverUrl, username, password, extension, audioMode = 'direct' } = req.query;

  if (!serverUrl || !username || !password) {
    res.status(400).json({ error: 'Missing Xtream credentials.' });
    return;
  }

  try {
    const targetUrl = buildStreamUrl({
      serverUrl,
      username,
      password,
      contentType,
      streamId,
      extension,
    });

    if (contentType === 'live' && audioMode === 'aac-stereo') {
      await transcodeLiveAudio(req, res, targetUrl);
      return;
    }

    await proxyRemote(req, res, targetUrl);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to proxy stream.' });
  }
});

app.get('/api/proxy', async (req, res) => {
  const { target } = req.query;

  if (!target) {
    res.status(400).json({ error: 'Missing proxy target.' });
    return;
  }

  try {
    await proxyRemote(req, res, String(target));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to proxy media segment.' });
  }
});

app.listen(port, () => {
  console.log(`Xtream API listening on ${port}`);
});
