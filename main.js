const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1300,
        height: 850,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile('index.html');
}

// Create an application menu with a working Undo
const menuTemplate = [
    {
        label: 'File',
        submenu: [
            { role: 'quit' }
        ]
    },
    {
        label: 'Edit',
        submenu: [
            {
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                click: () => {
                    BrowserWindow.getFocusedWindow()?.webContents.send('trigger-undo');
                }
            },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' }
        ]
    },
    {
        label: 'View',
        submenu: [
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
        ]
    }
];

// Listen for the open‑external request from the renderer
ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
});

app.whenReady().then(() => {
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
    createWindow();
});