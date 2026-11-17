'use strict';

/**
 * Ponte segura entre o renderer (UI) e o main (canal nativo).
 *
 * contextIsolation:true + nodeIntegration:false => o renderer nao tem require
 * nem fs. Tudo o que ele pode fazer passa por estas funcoes explicitas.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pka', {
  // descoberta e conexao
  scan: () => ipcRenderer.invoke('scan'),
  connect: (pid, opts) => ipcRenderer.invoke('connect', pid, opts),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  status: () => ipcRenderer.invoke('status'),

  // comandos do jogo
  command: (name, parameter, options) => ipcRenderer.invoke('command', name, parameter, options),

  // rota
  saveRoute: (pid, waypoints) => ipcRenderer.invoke('save-route', pid, waypoints),
  loadRoute: (pid) => ipcRenderer.invoke('load-route', pid),

  // utilidades
  openFolder: which => ipcRenderer.invoke('open-folder', which),

  // mapa do jogo (OTMM)
  mapOpen: () => ipcRenderer.invoke('map-open'),
  mapRegion: (x, y, z, w, h) => ipcRenderer.invoke('map-region', x, y, z, w, h),

  // perfect lure
  lureDecide: ctx => ipcRenderer.invoke('lure-decide', ctx),
  lureConfig: () => ipcRenderer.invoke('lure-config'),
  lureSet: overrides => ipcRenderer.invoke('lure-set', overrides),

  // roster (uuid para o combo, slots e teclas da config real)
  roster: () => ipcRenderer.invoke('roster'),

  // eventos
  onTelemetry: cb => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('telemetry', h);
    return () => ipcRenderer.removeListener('telemetry', h);
  },
  onState: cb => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
  onLog: cb => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('log', h);
    return () => ipcRenderer.removeListener('log', h);
  },
});
