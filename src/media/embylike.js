'use strict';

// Jellyfin and Emby share most of their API, so one factory builds both.
// Two ways to receive playback state (either or both):
//   - webhook: Jellyfin "Webhook" plugin (Generic destination) / Emby Premiere webhooks
//   - polling: this app reads /Sessions every couple of seconds with an API key
// Both feed the tracker, which removes duplicates.

const { http, isPrivateIp } = require('../util');
const { mediaType, truthy, num } = require('./tracker');

function itemTitle(type, name, series, season, episode) {
  if (String(type).toLowerCase() === 'episode' && series) {
    const se = season != null && episode != null ? ` S${season}E${episode}` : '';
    return `${series}${se} ${name || ''}`.trim();
  }
  return name || 'Unknown';
}

function make(variant) {
  const isJelly = variant === 'jellyfin';
  const id = variant;
  const label = isJelly ? 'Jellyfin' : 'Emby';
  let timer = null;
  let lastPollError = null;

  const api = (c, path) => http('GET', `${String(c.url).replace(/\/+$/, '')}${path}`, { headers: { 'X-Emby-Token': c.apiKey } });

  function fromSession(s) {
    const it = s.NowPlayingItem;
    return {
      info: {
        source: id,
        playerId: s.DeviceId,
        playerName: s.DeviceName || s.Client || s.DeviceId,
        product: s.Client || '',
        user: s.UserName || '',
        mediaType: mediaType(it.Type),
        title: itemTitle(it.Type, it.Name, it.SeriesName, it.ParentIndexNumber, it.IndexNumber),
        local: isPrivateIp(s.RemoteEndPoint) !== false,
      },
      state: { paused: Boolean(s.PlayState?.IsPaused), position: num(s.PlayState?.PositionTicks), runtime: num(it.RunTimeTicks) },
    };
  }

  return {
    id,
    label,
    blurb: isJelly
      ? 'Use the Jellyfin Webhook plugin, or let this app poll Jellyfin with an API key (no plugin needed). You can use both.'
      : 'Use Emby webhooks (Emby Premiere), or let this app poll Emby with an API key. You can use both.',
    fields: [
      { key: 'url', label: `${label} server URL`, placeholder: isJelly ? 'http://192.168.1.10:8096' : 'http://192.168.1.10:8096' },
      { key: 'apiKey', label: 'API key', placeholder: 'Dashboard > API Keys > +', secret: true },
      { key: 'poll', label: 'Poll for playback (works without webhooks)', type: 'checkbox', default: !isJelly },
      { key: 'pollSeconds', label: 'Poll every (seconds)', type: 'number', placeholder: '2' },
    ],
    webhookHelp: isJelly
      ? 'Dashboard > Plugins > Catalog > install "Webhook", restart. Then Dashboard > Plugins > Webhook > Add Generic Destination: paste this URL, tick "Send All Properties", and select notification types Playback Start, Playback Progress and Playback Stop. Optionally limit it to your user.'
      : 'Emby Dashboard > Notifications (or Webhooks) > Add > Webhooks: paste this URL, content type application/json, and select Playback Start, Pause, Unpause and Stop.',

    configured: () => true,

    parseWebhook(req, tracker) {
      let b = req.body || {};
      if (typeof b.data === 'string') { try { b = JSON.parse(b.data); } catch { /* keep */ } }

      if (isJelly || b.NotificationType) {
        const type = b.NotificationType;
        const info = {
          source: id,
          playerId: b.DeviceId,
          playerName: b.DeviceName || b.ClientName || b.DeviceId,
          product: b.ClientName || '',
          user: b.NotificationUsername || b.Username || '',
          mediaType: mediaType(b.ItemType),
          title: itemTitle(b.ItemType, b.Name, b.SeriesName, b.SeasonNumber ?? b.SeasonNumber00, b.EpisodeNumber ?? b.EpisodeNumber00),
          local: isPrivateIp(b.RemoteEndPoint) !== false,
        };
        if (!info.playerId) return { seen: null, raw: type };
        const kind = { PlaybackStart: 'start', PlaybackProgress: 'progress', PlaybackStop: 'stop' }[type];
        if (kind) tracker.observe(info, kind, { paused: truthy(b.IsPaused), position: num(b.PlaybackPositionTicks), runtime: num(b.RunTimeTicks) });
        return { seen: info.local ? info : null, raw: type };
      }

      // Emby webhook
      const ev = String(b.Event || '');
      const s = b.Session || {};
      const it = b.Item || {};
      const info = {
        source: id,
        playerId: s.DeviceId,
        playerName: s.DeviceName || s.Client || s.DeviceId,
        product: s.Client || '',
        user: b.User?.Name || '',
        mediaType: mediaType(it.Type),
        title: itemTitle(it.Type, it.Name, it.SeriesName, it.ParentIndexNumber, it.IndexNumber),
        local: isPrivateIp(s.RemoteEndPoint) !== false,
      };
      if (!info.playerId) return { seen: null, raw: ev };
      const kind = { 'playback.start': 'start', 'playback.pause': 'pause', 'playback.unpause': 'resume', 'playback.stop': 'stop', 'playback.progress': 'progress' }[ev];
      if (kind) tracker.observe(info, kind, { position: num(b.PlaybackInfo?.PositionTicks), runtime: num(it.RunTimeTicks) });
      return { seen: info.local ? info : null, raw: ev };
    },

    start(c, tracker, onSeen, log) {
      this.stop();
      if (!c.poll || !c.url || !c.apiKey) return;
      const every = Math.max(1, Number(c.pollSeconds) || 2) * 1000;
      const tick = async () => {
        try {
          const sessions = await api(c, '/Sessions?ActiveWithinSeconds=120');
          const active = new Set();
          for (const s of sessions || []) {
            if (!s.NowPlayingItem || !s.DeviceId) continue;
            const { info, state } = fromSession(s);
            active.add(info.playerId);
            if (info.local) onSeen(info);
            tracker.observe(info, 'progress', state);
          }
          tracker.sweep(id, active, every * 3);
          if (lastPollError) { log('ok', `${label} polling recovered`); lastPollError = null; }
        } catch (err) {
          if (lastPollError !== err.message) log('error', `${label} polling failed: ${err.message}`);
          lastPollError = err.message;
        }
      };
      tick();
      timer = setInterval(tick, every);
    },

    stop() { clearInterval(timer); timer = null; },

    // Players that have connected from this network (the server forgets them when it restarts,
    // so Photon also remembers the ones it has seen).
    async listPlayers(c) {
      if (!c.url || !c.apiKey) return [];
      const res = await api(c, '/Sessions?ActiveWithinSeconds=2592000');
      return (res || [])
        .filter(x => x.DeviceId && isPrivateIp(x.RemoteEndPoint) !== false)
        .map(x => ({ id: x.DeviceId, name: x.DeviceName || x.Client, product: [x.Client, x.UserName].filter(Boolean).join(', '), local: true }));
    },
  };
}

module.exports = { make };
