const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("compucart", {
  on: (ch, cb) => {
    if (!["log", "cart", "integrity", "sync"].includes(ch)) return;
    const listener = (_e, d) => cb(d);
    ipcRenderer.on(`cc:${ch}`, listener);
    return () => ipcRenderer.removeListener(`cc:${ch}`, listener);
  },
  launch: (root) => ipcRenderer.invoke("cc:launch", root),
});
