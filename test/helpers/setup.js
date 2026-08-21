'use strict';
process.env.NODE_ENV = 'test';
process.env.TZ = 'Asia/Seoul';

// Auto-unref timers in test mode so the test runner exits cleanly
const originalSetInterval = global.setInterval;
global.setInterval = function(...args) {
  const timer = originalSetInterval.apply(this, args);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

const originalSetTimeout = global.setTimeout;
global.setTimeout = function(...args) {
  const timer = originalSetTimeout.apply(this, args);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};
