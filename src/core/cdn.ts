/**
 * Where the libraries and models on jsDelivr load from. In the desktop app they come through the
 * app's own origin (app://beatmaker/cdn/…, cached on disk by the app), which lets ONNX Runtime
 * start its worker threads from them; in a browser, straight from the CDN.
 */
export function sameOriginCdn(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'app:';
}

export function cdn(path: string): string {
  return sameOriginCdn() ? `${location.origin}/cdn/npm/${path}` : `https://cdn.jsdelivr.net/npm/${path}`;
}
