// One Escape, one owner. Several things listen for Escape at different
// levels (a menu on its input, a dialog on the document, focus mode on the
// window); the innermost listener runs first. Each handler asks claimEsc(e)
// and acts only if it gets it, so one press closes only the nearest thing.
const handled = new WeakSet();

export function claimEsc(e) {
  if (e.key !== "Escape" || handled.has(e)) return false;
  handled.add(e);
  return true;
}

// For handlers that see Escape but decide to leave it to an outer owner.
export const escTaken = (e) => handled.has(e);
