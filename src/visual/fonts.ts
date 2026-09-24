const loaded = new Map<string, Promise<void>>();
const SYSTEM = new Set(['system-ui', 'sans-serif', 'serif', 'monospace']);

/** Load a Google Font on demand (fails silently offline; the canvas falls back to system fonts). */
export function ensureFont(family: string): Promise<void> {
  if (!family || SYSTEM.has(family)) return Promise.resolve();
  let p = loaded.get(family);
  if (!p) {
    p = new Promise<void>((resolve) => {
      const id = 'gf-' + family.replace(/\s+/g, '-');
      if (!document.getElementById(id)) {
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;700&display=swap`;
        link.onerror = () => resolve();
        link.onload = () => {
          const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
          if (!fonts) return resolve();
          Promise.all([fonts.load(`700 48px "${family}"`), fonts.load(`500 24px "${family}"`)])
            .then(() => resolve())
            .catch(() => resolve());
        };
        document.head.append(link);
      } else resolve();
      setTimeout(resolve, 4000);
    });
    loaded.set(family, p);
  }
  return p;
}
