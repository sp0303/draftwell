// Simple per-user (or per-IP) rate limits for the routes that cost CPU or AI
// calls. In memory, which is enough for one server process; counts reset on restart.

const buckets = new Map();

// Forget idle entries now and then so the map can't grow without end.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > b.windowMs) buckets.delete(k);
}, 60 * 1000).unref();

/**
 * @param {string} name     a label for this limit, e.g. "pdf"
 * @param {number} max      requests allowed per window
 * @param {number} windowMs window length
 * @param {string} message  shown to the person when they hit it
 */
function limit(name, max, windowMs, message) {
  return (req, res, next) => {
    // Behind Cloudflare the visitor's address is in CF-Connecting-IP; nginx alone gives 127.0.0.1.
    const who = req.user ? `u:${req.user._id}` : `ip:${req.get('cf-connecting-ip') || req.ip}`;
    const key = `${name}|${who}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) { b = { start: now, n: 0, windowMs }; buckets.set(key, b); }
    b.n += 1;
    if (b.n > max) {
      const wait = Math.ceil((b.start + windowMs - now) / 1000);
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `${message} Try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.` });
    }
    next();
  };
}

const reset = () => buckets.clear();

module.exports = { limit, reset };
