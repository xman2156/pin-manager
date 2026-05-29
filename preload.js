const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    onUndo: (callback) => {
        ipcRenderer.on('trigger-undo', () => callback());
    }
});