/** The bridge the page sees as window.beatmakerDesktop (see src/ui/desktop.ts). */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('beatmakerDesktop', {
  version: ipcRenderer.sendSync('version'),
  platform: process.platform,
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (dir, name, data) => ipcRenderer.invoke('write-file', dir, name, data),
  saveAs: (name, data) => ipcRenderer.invoke('save-as', name, data),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  outDirFor: (file) => {
    const p = webUtils.getPathForFile(file);
    return p ? ipcRenderer.invoke('out-dir-for', p) : Promise.resolve(null);
  },
  earsReady: () => ipcRenderer.invoke('ears-ready'),
  earsScore: (refs, cands) => ipcRenderer.invoke('ears-score', refs, cands),
  devocalReady: () => ipcRenderer.invoke('devocal-ready'),
  beatsReady: () => ipcRenderer.invoke('beats-ready'),
  pathOf: (file) => webUtils.getPathForFile(file) || '',
  mixerSession: { load: () => ipcRenderer.invoke('mixer-session-load'), save: (data) => ipcRenderer.invoke('mixer-session-save', data) },
  stemsCache: { get: (file) => ipcRenderer.invoke('stems-cache-get', file), put: (file, stems) => ipcRenderer.invoke('stems-cache-put', file, stems) },
  beatSearch: (tags) => ipcRenderer.invoke('beat-search', tags),
  beatFetch: (beat, record) => ipcRenderer.invoke('beat-fetch', beat, record),
  spotify: {
    status: () => ipcRenderer.invoke('spotify-status'),
    setClient: (id) => ipcRenderer.invoke('spotify-set-client', id),
    login: () => ipcRenderer.invoke('spotify-login'),
    logout: () => ipcRenderer.invoke('spotify-logout'),
    api: (method, path, body) => ipcRenderer.invoke('spotify-api', method, path, body),
  },
  vocalEngineer: (job) => ipcRenderer.invoke('vocal-engineer', job),
  vocalPresets: () => ipcRenderer.invoke('vocal-presets'),
  vocalPresetMake: (job) => ipcRenderer.invoke('vocal-preset-make', job),
  stem2Send: (job) => ipcRenderer.invoke('stem2-send', job),
  beatsRun: (wav) => ipcRenderer.invoke('beats-run', wav),
  resynthRun: (wav) => ipcRenderer.invoke('resynth-run', wav),
  stemClean: (stem, vocals, bpm, offset) => ipcRenderer.invoke('stem-clean', stem, vocals, bpm, offset),
  devocalRun: (wav) => ipcRenderer.invoke('devocal-run', wav),
  ymt3Ready: () => ipcRenderer.invoke('ymt3-ready'),
  ymt3Run: (wav, seconds) => ipcRenderer.invoke('ymt3-run', wav, seconds),
  kitFiles: () => ipcRenderer.invoke('kit-files'),
  vstSounds: () => ipcRenderer.invoke('vst-sounds'),
  vstRender: (job) => ipcRenderer.invoke('vst-render', job),
  chooseSongs: () => ipcRenderer.invoke('choose-songs'),
  onJob: (fn) => ipcRenderer.on('job', (_e, job) => fn(job)),
  jobDone: (id, result) => ipcRenderer.send('job-done', id, result),
  ready: () => ipcRenderer.send('renderer-ready'),
  progress: (fraction, label) => ipcRenderer.send('progress', fraction, label),
});
