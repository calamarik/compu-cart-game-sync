const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("compucart", {
  on: (ch, cb) => {
    if (!["log", "cart", "integrity", "sync", "settings"].includes(ch)) return;
    const listener = (_e, d) => cb(d);
    ipcRenderer.on(`cc:${ch}`, listener);
    return () => ipcRenderer.removeListener(`cc:${ch}`, listener);
  },
  launch: (root) => ipcRenderer.invoke("cc:launch", root),
  play: () => ipcRenderer.invoke("cc:play"),
  state: () => ipcRenderer.invoke("cc:state"),
  settings: () => ipcRenderer.invoke("cc:settings"),
  setAutoLaunch: (on) => ipcRenderer.invoke("cc:setAutoLaunch", !!on),
  eject: () => ipcRenderer.invoke("cc:eject"),
  hide: () => ipcRenderer.invoke("cc:hide"),
  quit: () => ipcRenderer.invoke("cc:quit"),
});
