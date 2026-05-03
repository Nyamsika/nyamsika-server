const { app, BrowserWindow } = require('electron');
const { exec } = require('child_process');
const path = require('path');

let serverProcess = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Try to load the app
  win.loadURL('https://localhost:3443').catch(err => {
    console.log('Waiting for server...');
    setTimeout(() => {
      win.loadURL('https://localhost:3443');
    }, 5000);
  });
}

app.whenReady().then(() => {
  // Start server in background
  serverProcess = exec('node server/index.js', {
    cwd: path.join(__dirname, '..')
  });
  
  // Wait 5 seconds then open window
  setTimeout(() => {
    createWindow();
  }, 5000);
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  app.quit();
});