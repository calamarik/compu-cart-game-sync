const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("compucart", {
  on: (ch, cb) => ipcRenderer.on(`cc:${ch}`, (_e, d) => cb(d)),
  launch: (root) => ipcRenderer.invoke("cc:launch", root),
});
