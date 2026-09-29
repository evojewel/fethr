// Shared by the tests: the server's URL carries the per-launch token in its
// fragment. Split it, and fetch /api with the header the page would send.
export function split(url) {
  const u = new URL(url);
  return { base: u.origin + "/", token: u.hash.replace(/^#t=/, "") };
}

export function apiFetch(url, path, init = {}) {
  const { base, token } = split(url);
  return fetch(base + path, { ...init, headers: { ...(init.headers || {}), "x-fethr-token": token } });
}
