'use strict';

// Time windows for rules. A boundary can be a clock time ("22:30") or a sun
// event with an optional offset in minutes ("sunset", "sunset-30", "sunrise+15").

const SunCalc = require('suncalc');

const SUN_RE = /^(sunrise|sunset|dawn|dusk)\s*([+-]\s*\d+)?$/i;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

// Returns minutes after local midnight for `spec` on the given date, or null.
function minutesOf(spec, date, location) {
  const s = String(spec || '').trim().toLowerCase();
  const clock = CLOCK_RE.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }
  const sun = SUN_RE.exec(s);
  if (sun) {
    const lat = location?.lat;
    const lon = location?.lon;
    // Without a location, fall back to typical times so rules still behave sensibly.
    const fallback = { sunrise: 6 * 60 + 30, dawn: 6 * 60, sunset: 18 * 60 + 30, dusk: 19 * 60 };
    let base = fallback[sun[1]];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
      const t = SunCalc.getTimes(noon, lat, lon)[sun[1]];
      if (t && !Number.isNaN(t.getTime())) base = t.getHours() * 60 + t.getMinutes();
    }
    const offset = sun[2] ? Number(sun[2].replace(/\s/g, '')) : 0;
    return (((base + offset) % 1440) + 1440) % 1440;
  }
  return null;
}

function isValidSpec(spec) {
  return minutesOf(spec, new Date(), null) !== null;
}

// Is `now` inside the rule's window? Windows may wrap past midnight
// (e.g. sunset to 02:00). For wrapped windows the day check uses the day the
// window started, so "Fri 22:00 to 02:00" still applies at 01:00 Saturday.
function isActive(schedule, now = new Date(), location = null) {
  if (!schedule || !schedule.enabled) return true;
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(schedule.from, now, location);
  const to = minutesOf(schedule.to, now, location);
  if (from === null || to === null) return false;

  if (from === to) return days.includes(now.getDay()); // whole day
  if (from < to) return cur >= from && cur < to && days.includes(now.getDay());

  // wraps midnight
  if (cur >= from) return days.includes(now.getDay());
  if (cur < to) return days.includes((now.getDay() + 6) % 7);
  return false;
}

function fmt(min) {
  if (min === null) return '?';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function sunTimesToday(location, now = new Date()) {
  const out = {};
  for (const k of ['dawn', 'sunrise', 'sunset', 'dusk']) out[k] = fmt(minutesOf(k, now, location));
  out.usingFallback = !(Number.isFinite(location?.lat) && Number.isFinite(location?.lon));
  return out;
}

module.exports = { isActive, isValidSpec, minutesOf, sunTimesToday };
