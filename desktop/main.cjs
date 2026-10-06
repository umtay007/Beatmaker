/**
 * Beatmaker desktop: the web app in a window of its own, plus what a browser can't do.
 *
 * - Drop songs on Beatmaker.exe (or run `Beatmaker.exe song.mp3 …`): each is remade and everything
 *   is exported into a folder next to it, with no clicks.
 * - Every download the app makes (instrument recordings, the separation, transcription and speech
 *   models, libraries) goes through a disk cache with retries: a flaky connection can't swap a
 *   recording for a synth stand-in, and after the first time it all works offline.
 * - The page is cross-origin isolated, so the models can use every CPU core.
 */
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const APP_DIR = path.join(__dirname, 'app');
const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|aif|aiff|webm|mp4|m4v|mov)$/i;
/** Hosts the app downloads from: cached on disk, retried, and allowed into the isolated page. */
const CACHED_HOSTS = new Set(['cdn.jsdelivr.net', 'gleitz.github.io', 'tambien.github.io', 'huggingface.co', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The video is recorded in real time: keep drawing and playing when the window is covered,
// minimized or in the background (Windows otherwise stops painting a hidden window).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// ---------------------------------------------------------------------------------------------
// Log (in the app's data folder: beatmaker.log)

let logFile = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    logFile ??= path.join(app.getPath('userData'), 'beatmaker.log');
    fs.appendFileSync(logFile, line);
  } catch {
    // No log is no reason to stop.
  }
}

// ---------------------------------------------------------------------------------------------
// Command line: songs to remake and options

function parseArgs(argv) {
  const songs = [];
  // Instrumental by default: no lyrics, no vocals.
  const options = { thorough: false, lyrics: false, vocals: false, video: true, stems: false, quick: false, tidy: true, hidden: false, vst: true };
  let out = null;
  let quit = false;
  let pick = null;
  let plugin = null;
  let noWindow = false;
  let kits = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all-instruments') options.thorough = true;
    else if (a === '--lyrics') options.lyrics = true;
    else if (a === '--vocals') options.vocals = true;
    else if (a === '--no-tidy') options.tidy = false;
    else if (a === '--hidden') options.hidden = true; // no window shown: for jobs left running in the background
    else if (a === '--no-vst') options.vst = false;
    else if (a === '--quick') options.quick = true; // analysis and report only, no exports
    else if (a === '--no-video') options.video = false;
    else if (a === '--stems') options.stems = true;
    else if (a === '--quit') quit = true;
    else if (a === '--pick-sound') pick = argv[++i] ?? null;
    else if (a === '--plugin') plugin = argv[++i] ?? null;
    else if (a === '--no-window') noWindow = true;
    else if (a === '--kits') kits = argv[++i] ?? null;
    else if (a === '--out') out = argv[++i] ?? null;
    else if (a.startsWith('--out=')) out = a.slice(6);
    else if (!a.startsWith('-') && AUDIO.test(a) && fs.existsSync(a)) songs.push(path.resolve(a));
  }
  return { songs, options, out, quit, pick: pick && { roles: pick.split(',').filter(Boolean), plugin, noWindow }, kits };
}

// The first entries are the program (and the app folder when run as `electron .`).
const cli = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));

/** Where a song's results go: a folder next to it, or under Documents if that isn't writable. */
async function outDirFor(song, root = cli.out) {
  const name = `${path.parse(song).name} - Beatmaker`.replace(/[<>:"/\\|?*]/g, '_');
  const tries = [root ? path.join(path.resolve(root), name) : path.join(path.dirname(song), name), path.join(app.getPath('documents'), 'Beatmaker', name)];
  for (const dir of tries) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.access(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Try the next place.
    }
  }
  return tries[tries.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Jobs: one song at a time

let win = null;
let rendererReady = false;
let busy = null;
let nextId = 1;
const queue = [];
const finished = [];

async function enqueue(songs, options = cli.options) {
  for (const song of songs) queue.push({ id: nextId++, path: song, name: path.basename(song), outDir: await outDirFor(song), options });
  log('queued', songs.length, 'song(s)');
  pump();
}

function pump() {
  if (!rendererReady || busy || !win) return;
  const job = queue.shift();
  if (!job) {
    if (!finished.length) return;
    const last = finished[finished.length - 1];
    if (cli.quit) app.quit();
    else if (last.ok && !cli.options.quick) void shell.openPath(last.outDir);
    finished.length = 0;
    return;
  }
  busy = job;
  // A song takes a while: don't let the computer sleep in the middle of it.
  job.blocker = powerSaveBlocker.start('prevent-app-suspension');
  log('start', job.path, '->', job.outDir);
  win.webContents.send('job', { id: job.id, path: job.path, name: job.name, outDir: job.outDir, options: job.options });
}

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  pump();
});

ipcMain.on('job-done', async (_e, id, result) => {
  const job = busy && busy.id === id ? busy : null;
  busy = null;
  win?.setProgressBar(-1);
  win?.setTitle('Beatmaker');
  if (job) {
    if (powerSaveBlocker.isStarted(job.blocker)) powerSaveBlocker.stop(job.blocker);
    log('done', job.path, result.ok ? `ok, ${result.files.length} files` : `failed: ${result.error}`);
    if (!result.ok) await fsp.writeFile(path.join(job.outDir, 'error.txt'), `Beatmaker couldn't finish ${job.name}:\n${result.error}\n`).catch(() => {});
    finished.push({ ...job, ok: result.ok });
  }
  pump();
});

// ---------------------------------------------------------------------------------------------
// Files

const safeFileName = (n) => String(n).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'file';

ipcMain.handle('read-file', (_e, p) => fsp.readFile(p));
ipcMain.handle('write-file', async (_e, dir, name, data) => {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeFileName(name));
  await fsp.writeFile(file, Buffer.from(data));
  return file;
});
ipcMain.handle('save-as', async (_e, name, data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeFileName(name)) });
  if (r.canceled || !r.filePath) return false;
  await fsp.writeFile(r.filePath, Buffer.from(data));
  return true;
});
ipcMain.handle('open-folder', (_e, dir) => shell.openPath(dir));
ipcMain.handle('out-dir-for', (_e, song) => outDirFor(song, null));
ipcMain.handle('choose-songs', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Songs to remake',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'webm', 'mp4'] }],
  });
  if (r.canceled) return 0;
  await enqueue(r.filePaths);
  return r.filePaths.length;
});
ipcMain.on('version', (e) => (e.returnValue = app.getVersion()));

// ---------------------------------------------------------------------------------------------
// Your drum samples: `--kits <folder>` (remembered) is searched for the best kick, snare and hats

const kitsFile = () => path.join(app.getPath('userData'), 'kits.txt');
const AUDIO_HIT = /.(wav|aif|aiff|flac)$/i;
/** Longest file taken for a drum hit (about 3 s of stereo 24-bit): bigger ones are loops. */
const MAX_HIT_BYTES = 1.2e6;

ipcMain.handle('kit-files', async () => {
  let root = null;
  try {
    root = (await fsp.readFile(kitsFile(), 'utf8')).trim();
  } catch {
    return [];
  }
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 8 || out.length > 20000) return;
    let items = [];
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) await walk(p, depth + 1);
      else if (AUDIO_HIT.test(it.name)) {
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.size > 1000 && st.size <= MAX_HIT_BYTES) out.push({ path: p, rel: path.relative(root, p).split(path.sep).join('/') });
      }
    }
  };
  await walk(root, 0);
  return out;
});

// ---------------------------------------------------------------------------------------------
// Your VST instruments: notes played through a sound you picked once (see vst/host.py)

const vstDir = () => path.join(app.getPath('userData'), 'vst');
const vstScript = () => path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : __dirname, 'vst', 'host.py');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: !opts.show, ...opts.spawn });
    } catch (e) {
      resolve({ code: -1, out: String(e) });
      return;
    }
    const take = (d) => {
      out += d;
      if (opts.onLine) for (const l of String(d).split(/\r?\n/)) if (l.trim()) opts.onLine(l);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

let python = null;
/** A Python that can run the host: the one in BEATMAKER_PYTHON, else `py -3` or `python`, installing pedalboard if it's missing. */
async function findPython() {
  if (python) return python;
  const candidates = [process.env.BEATMAKER_PYTHON && [process.env.BEATMAKER_PYTHON], ['py', '-3'], ['python']].filter(Boolean);
  const has = (c) => run(c[0], [...c.slice(1), '-c', 'import pedalboard, numpy']);
  let runs = null;
  for (const c of candidates) {
    if ((await has(c)).code === 0) return (python = c);
    if (!runs && (await run(c[0], [...c.slice(1), '-c', 'pass'])).code === 0) runs = c;
  }
  if (runs) {
    log('installing pedalboard for', runs.join(' '));
    await run(runs[0], [...runs.slice(1), '-m', 'pip', 'install', '--user', '--quiet', 'pedalboard', 'numpy']);
    if ((await has(runs)).code === 0) return (python = runs);
  }
  return null;
}

/** The sounds picked so far: { melody: { name, plugin }, drums: … } (only those whose files are still there). */
async function vstSounds() {
  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(vstDir(), 'sounds.json'), 'utf8'));
    const out = {};
    for (const [role, s] of Object.entries(cfg)) if (fs.existsSync(path.join(vstDir(), s.dir, 'sound.json'))) out[role] = { name: s.name, plugin: s.plugin };
    return out;
  } catch {
    return {};
  }
}
ipcMain.handle('vst-sounds', () => (cli.options.vst === false ? {} : vstSounds()));

/** job = { duration, parts: [{ role, notes: [{ p, s, e, v }], channel?, shift? }] } → { role: WAV bytes } (or { error }). */
ipcMain.handle('vst-render', async (_e, job) => {
  const sounds = await vstSounds();
  const py = await findPython();
  if (!py) return { error: "Python with pedalboard isn't available (set BEATMAKER_PYTHON, or install Python)" };
  const tmp = await fsp.mkdtemp(path.join(app.getPath('temp'), 'beatmaker-vst-'));
  try {
    const parts = job.parts.filter((p) => sounds[p.sound ?? p.role]).map((p) => ({ ...p, soundDir: path.join(vstDir(), p.sound ?? p.role) }));
    await fsp.writeFile(path.join(tmp, 'job.json'), JSON.stringify({ duration: job.duration, outDir: tmp, parts }));
    const r = await run(py[0], [...py.slice(1), vstScript(), 'render', path.join(tmp, 'job.json')], { onLine: (l) => log('vst', l.slice(0, 300)) });
    if (r.code !== 0) return { error: `The VST host failed: ${r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300)}` };
    const files = {};
    for (const p of parts) files[p.role] = await fsp.readFile(path.join(tmp, `${p.role}.wav`));
    return { files };
  } catch (e) {
    return { error: String(e && e.message) };
  } finally {
    void fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

/** `Beatmaker.exe --pick-sound melody,drums [--plugin X.vst3]`: for each part, open the plugin, choose a sound, close it. */
async function pickSound({ roles, plugin, noWindow }) {
  const py = await findPython();
  if (!py) return log('pick-sound: Python with pedalboard is needed');
  for (const role of roles) {
    const saved = (await vstSounds())[role];
    const target = plugin || (saved && saved.plugin);
    if (!target) return log(`pick-sound: ${role} needs a --plugin path`);
    const r = await run(py[0], [...py.slice(1), vstScript(), 'pick', role, target, vstDir(), ...(noWindow ? ['--no-window'] : [])], { show: true, onLine: (l) => log('vst', l.slice(0, 300)) });
    log('pick-sound', role, 'done', r.code);
  }
}
// Progress of the song being remade, on the taskbar button and in the title.
ipcMain.on('progress', (_e, fraction, label) => {
  if (!win || !busy) return;
  win.setProgressBar(Math.max(0, Math.min(1, Number(fraction) || 0)));
  win.setTitle(`Beatmaker: ${Math.round(fraction * 100)}% ${busy.name}${queue.length ? ` (${queue.length} more to go)` : ''}`);
  void label;
});

// ---------------------------------------------------------------------------------------------
// The page (app://beatmaker/…), cross-origin isolated

async function serveApp(req) {
  const { pathname, search } = new URL(req.url);
  // jsDelivr files through the app's own origin (and the cache): ONNX Runtime needs its code and
  // its worker threads same-origin to run multi-threaded.
  if (pathname.startsWith('/cdn/')) {
    const res = await serveHttps(new Request(`https://cdn.jsdelivr.net/${pathname.slice(5)}${search}`, { method: req.method, headers: req.headers }));
    const headers = new Headers(res.headers);
    headers.set('cross-origin-resource-policy', 'same-origin');
    headers.set('cross-origin-embedder-policy', 'require-corp');
    return new Response(res.body, { status: res.status, headers });
  }
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR)) return new Response('Not found', { status: 404 });
  try {
    const body = await fsp.readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------------------------
// Downloads: a disk cache with retries

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type, etag',
  'cross-origin-resource-policy': 'cross-origin',
  'timing-allow-origin': '*',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheDir = () => path.join(app.getPath('userData'), 'downloads');
const inflight = new Map();

function cacheKey(href) {
  const u = new URL(href);
  // The app adds ?retry=N to retry a failed module import: the same file.
  u.searchParams.delete('retry');
  return crypto.createHash('sha256').update(u.href).digest('hex');
}

async function readMeta(file) {
  try {
    const m = JSON.parse(await fsp.readFile(file + '.json', 'utf8'));
    const st = await fsp.stat(file);
    return st.size === m.size ? m : null;
  } catch {
    return null;
  }
}

/** Fonts only change how the page looks: never hold it up waiting for them. */
const NICE_TO_HAVE = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/** Download a file into the cache, retrying dropped connections and server errors. */
async function download(href, file) {
  await fsp.mkdir(cacheDir(), { recursive: true });
  const tries = NICE_TO_HAVE.has(new URL(href).hostname) ? 1 : 8;
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const tmp = `${file}.part${process.pid}-${attempt}`;
    try {
      const res = await net.fetch(href, { bypassCustomProtocolHandlers: true });
      if (res.status >= 500 || res.status === 429 || res.status === 408) throw new Error(`HTTP ${res.status}`);
      // A missing file is an answer, not a failure (the app asks for optional files): pass it on.
      if (!res.ok) return { status: res.status, type: res.headers.get('content-type') ?? 'text/plain', body: Buffer.from(await res.arrayBuffer()) };
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const size = (await fsp.stat(tmp)).size;
      const expect = Number(res.headers.get('content-length') ?? 0);
      if (expect && !res.headers.get('content-encoding') && size !== expect) throw new Error(`cut short (${size} of ${expect} bytes)`);
      const meta = { url: href, type: res.headers.get('content-type') ?? 'application/octet-stream', size };
      await fsp.rename(tmp, file);
      await fsp.writeFile(file + '.json', JSON.stringify(meta));
      return meta;
    } catch (e) {
      last = e;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      // Offline: say so now rather than after a minute of retries.
      if (attempt + 1 >= tries || !net.isOnline()) break;
      log('retry', attempt + 1, href, String(e && e.message));
      await sleep(Math.min(20000, 700 * 2 ** attempt));
    }
  }
  throw last ?? new Error('download failed');
}

function serveCached(req, file, meta) {
  const base = { ...CORS, 'content-type': meta.type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable' };
  const head = req.method === 'HEAD';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, meta.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : meta.size - 1;
    end = Math.min(end, meta.size - 1);
    if (start > end || start >= meta.size) return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${meta.size}` } });
    const body = head ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${meta.size}`, 'content-length': String(end - start + 1) } });
  }
  const body = head || meta.size === 0 ? null : Readable.toWeb(fs.createReadStream(file));
  return new Response(body, { status: 200, headers: { ...base, 'content-length': String(meta.size) } });
}

async function passThrough(req) {
  const res = await net.fetch(req, { bypassCustomProtocolHandlers: true });
  const headers = new Headers(res.headers);
  headers.set('cross-origin-resource-policy', 'cross-origin');
  if (!headers.has('access-control-allow-origin')) headers.set('access-control-allow-origin', '*');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function serveHttps(req) {
  const url = new URL(req.url);
  if (!CACHED_HOSTS.has(url.hostname)) return passThrough(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? '*', 'access-control-max-age': '86400' } });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return passThrough(req);
  const key = cacheKey(req.url);
  const file = path.join(cacheDir(), key);
  let meta = await readMeta(file);
  if (!meta) {
    let job = inflight.get(key);
    if (!job) {
      job = download(req.url, file).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    let got;
    try {
      got = await job;
    } catch (e) {
      log('failed', req.url, String(e && e.message));
      return new Response(`Download failed: ${e && e.message}`, { status: 503, headers: CORS });
    }
    if (got.body) return new Response(new Uint8Array(got.body), { status: got.status, headers: { ...CORS, 'content-type': got.type } });
    meta = got;
  }
  return serveCached(req, file, meta);
}

// ---------------------------------------------------------------------------------------------
// Window

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0c12',
    title: 'Beatmaker',
    autoHideMenuBar: true,
    show: !cli.options.hidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Video export records in real time: never slow the page down in the background.
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.webContents.on('console-message', (e) => {
    const msg = String(e.message);
    if (e.level === 'error' || e.level === 'warning' || msg.startsWith('[job]')) log('page', e.level, msg.slice(0, 500));
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer gone', d.reason);
    if (busy) {
      finished.push({ ...busy, ok: false });
      void fsp.writeFile(path.join(busy.outDir, 'error.txt'), `Beatmaker stopped while remaking ${busy.name} (${d.reason}).\n`).catch(() => {});
      busy = null;
    }
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });
  // F12 for the developer tools, for when something needs looking into.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  void win.loadURL('app://beatmaker/index.html');
}

if (!app.requestSingleInstanceLock()) {
  // Already running: the songs go to that window (second-instance below).
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const more = parseArgs(argv.slice(1));
    if (more.songs.length) void enqueue(more.songs, more.options);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle('app', serveApp);
    protocol.handle('https', serveHttps);
    log('start', app.getVersion(), process.platform, process.arch, JSON.stringify(cli));
    if (cli.kits) fs.writeFileSync(kitsFile(), path.resolve(cli.kits));
    if (cli.pick) {
      void pickSound(cli.pick).finally(() => app.quit());
      return;
    }
    createWindow();
    if (cli.songs.length) void enqueue(cli.songs, cli.options);
  });
  app.on('window-all-closed', () => app.quit());
}
