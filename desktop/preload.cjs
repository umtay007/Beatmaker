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
