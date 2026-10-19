'use strict';

const { make } = require('./embylike');

const sources = [
  require('./plex'), make('jellyfin'), make('emby'),
  // Smart TVs and streaming boxes: react to whatever app is playing on them, not just a media server.
  require('./tv/roku'), require('./tv/lg'), require('./tv/androidtv'), require('./tv/cast'), require('./tv/vizio'), require('./tv/samsung'),
];
const byId = Object.fromEntries(sources.map(s => [s.id, s]));

module.exports = { sources, byId };
