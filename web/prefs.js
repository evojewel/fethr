// Preferences that survive a relaunch. localStorage is per origin and the
// server binds a random port every launch, so each launch was a fresh origin
// and every preference reset. These live server-side instead (GET/PUT
// /api/prefs, src/prefs.js), behind the same getItem/setItem/removeItem
// interface the page already used, so call sites and web/theme.js and
// web/update.js take this object where they took localStorage.
//
// Loaded once, before anything reads a preference. If the server can't be
// reached the object falls back to localStorage, which at least holds for
// the rest of this launch.

const FLUSH_MS = 300;

export async function loadPrefs(f, fallback = safeLocal()) {
  let data = null;
  try {
    const r = await f("/api/prefs");
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j === "object" && !Array.isArray(j)) data = j;
    }
  } catch { /* server unreachable: fallback below */ }
  return makePrefs(f, data, fallback);
}

function safeLocal() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function makePrefs(f, data, fallback) {
  const remote = data !== null;
  const values = { ...(data || {}) };
  let pending = {};
  let timer = null;

  const local = (fn) => {
    try {
      return fallback ? fn(fallback) : null;
    } catch {
      return null;
    }
  };

  function flush(keepalive = false) {
    clearTimeout(timer);
    timer = null;
    const body = pending;
    pending = {};
    if (!remote || !Object.keys(body).length) return;
    f("/api/prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    }).catch(() => { /* kept locally; the next write retries the server */ });
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  // A write made just before the window closes still reaches the server.
  window.addEventListener("pagehide", () => flush(true));

  return {
    getItem(k) {
      if (!remote) return local((s) => s.getItem(k));
      return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : null;
    },
    setItem(k, v) {
      const s = String(v);
      values[k] = s;
      pending[k] = s;
      local((st) => st.setItem(k, s));
      schedule();
    },
    removeItem(k) {
      delete values[k];
      pending[k] = null;
      local((st) => st.removeItem(k));
      schedule();
    },
    flush,
  };
}
