const { app, BrowserWindow, Menu, Tray, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PANEL_URL = process.env.OPENCLAW_PANEL_URL || 'http://127.0.0.1:18789';
const HEALTH_URL = `${PANEL_URL}/`;
const START_TIMEOUT_MS = 5 * 60_000;
const START_NOTICE_MS = 45_000;
const CHECK_INTERVAL_MS = 800;
const DEFAULT_OPENCLAW_ARGS = ['gateway', '--port', '18789', 'run'];

const SETTINGS_FILE = 'settings.json';
const CLOSE_BEHAVIOR = {
  ASK: 'ask',
  MINIMIZE_TO_TRAY: 'minimize-to-tray',
  QUIT: 'quit',
};
const gotSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow;
let tray;
let openClawProcess = null;
let startedOpenClaw = false;
let isQuitting = false;
let startupInProgress = false;
let panelLoaded = false;
let settings = { closeBehavior: CLOSE_BEHAVIOR.ASK };

function getIconPath() {
  const devIcon = path.join(__dirname, '..', 'build', 'icon.ico');
  const packagedIcon = path.join(process.resourcesPath || '', 'icon.ico');
  if (fs.existsSync(devIcon)) return devIcon;
  if (fs.existsSync(packagedIcon)) return packagedIcon;
  return devIcon;
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function loadSettings() {
  try {
    const file = getSettingsPath();
    if (!fs.existsSync(file)) return;
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.values(CLOSE_BEHAVIOR).includes(loaded.closeBehavior)) {
      settings.closeBehavior = loaded.closeBehavior;
    }
  } catch {
    settings = { closeBehavior: CLOSE_BEHAVIOR.ASK };
  }
}

function saveSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function sendStatus(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('status', message);
}

function sendError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('startup-error', message);
}

function checkUrl(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 2500 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function waitForOpenClaw(timeoutMs) {
  const start = Date.now();
  let noticeShown = false;
  return new Promise((resolve, reject) => {
    async function tick() {
      if (await checkUrl(HEALTH_URL)) return resolve();

      const elapsed = Date.now() - start;
      if (!noticeShown && elapsed > START_NOTICE_MS) {
        noticeShown = true;
        sendStatus('OpenClaw 仍在启动中，冷启动可能需要一两分钟…');
      }

      if (elapsed > timeoutMs) {
        return reject(new Error(`等待 OpenClaw 启动超时：${Math.round(timeoutMs / 1000)} 秒。OpenClaw 进程可能已启动但 Web 面板尚未就绪，请稍后在托盘菜单选择“打开 OpenClaw Panel”，或检查 openclaw gateway status。`));
      }
      setTimeout(tick, CHECK_INTERVAL_MS);
    }
    tick();
  });
}

function parseOpenClawArgs() {
  return (process.env.OPENCLAW_ARGS || DEFAULT_OPENCLAW_ARGS.join(' ')).split(/\s+/).filter(Boolean);
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function getOpenClawLaunchCommand() {
  if (process.env.OPENCLAW_CMD) {
    return {
      command: process.env.OPENCLAW_CMD,
      args: parseOpenClawArgs(),
      display: `${process.env.OPENCLAW_CMD} ${parseOpenClawArgs().join(' ')}`,
    };
  }

  if (process.platform === 'win32') {
    const npmDir = path.join(process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming'), 'npm');
    const cmdShim = path.join(npmDir, 'openclaw.cmd');
    if (fs.existsSync(cmdShim)) {
      const script = [quoteCmdArg(cmdShim), ...parseOpenClawArgs().map(quoteCmdArg)].join(' ');
      return {
        command: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
        args: ['/d', '/s', '/c', script],
        display: script,
      };
    }
  }

  return {
    command: 'openclaw',
    args: parseOpenClawArgs(),
    display: `openclaw ${parseOpenClawArgs().join(' ')}`,
  };
}

function startOpenClaw() {
  const launch = getOpenClawLaunchCommand();
  sendStatus(`未检测到运行中的 OpenClaw，正在启动 gateway…\n${launch.display}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    openClawProcess = spawn(launch.command, launch.args, {
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const failStartup = (error) => {
      if (settled) return;
      settled = true;
      startedOpenClaw = false;
      reject(error);
    };

    openClawProcess.once('spawn', () => {
      settled = true;
      startedOpenClaw = true;
      resolve(openClawProcess);
    });

    openClawProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) sendStatus(text.slice(-240));
    });

    openClawProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) sendStatus(text.slice(-240));
    });

    openClawProcess.on('error', (error) => {
      const message = `无法启动 OpenClaw gateway。\n命令：${launch.display}\n错误：${error.message}`;
      sendError(message);
      failStartup(new Error(message));
    });

    openClawProcess.on('exit', (code, signal) => {
      if (!settled) {
        const message = `OpenClaw gateway 启动后立即退出。\n命令：${launch.display}\ncode=${code ?? 'null'} signal=${signal ?? 'null'}`;
        sendError(message);
        failStartup(new Error(message));
        return;
      }
      if (!isQuitting && startedOpenClaw) {
        sendError(`OpenClaw 进程已退出。code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      }
    });
  });
}

async function ensureOpenClaw() {
  sendStatus('正在检查 OpenClaw 是否已运行…');
  if (await checkUrl(HEALTH_URL)) {
    startedOpenClaw = false;
    sendStatus('检测到 OpenClaw 已运行，正在打开控制面板…');
    return;
  }

  await startOpenClaw();
  await waitForOpenClaw(START_TIMEOUT_MS);
  sendStatus('OpenClaw 已就绪，正在打开控制面板…');
}

async function bootPanel() {
  if (!mainWindow || mainWindow.isDestroyed() || startupInProgress || panelLoaded) return;
  startupInProgress = true;
  try {
    await ensureOpenClaw();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    panelLoaded = true;
    await mainWindow.loadURL(PANEL_URL);
  } catch (error) {
    sendError(error.stack || error.message || String(error));
  } finally {
    startupInProgress = false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function minimizeToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (tray) tray.displayBalloon?.({
    title: 'OpenClaw Panel 已在后台运行',
    content: '双击状态栏图标可以重新打开窗口。',
  });
}

async function promptCloseBehavior() {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '关闭 OpenClaw Panel',
    message: '关闭窗口时要怎么处理？',
    detail: '选择“缩至状态栏”会让控制面板在后台继续运行；选择“退出软件”会关闭桌面壳。若 OpenClaw 是本软件启动的，退出软件时也会一起关闭。',
    buttons: ['缩至状态栏', '退出软件', '取消'],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: '不再提醒，记住我的选择',
    checkboxChecked: false,
  });

  if (result.response === 2) return 'cancel';

  const chosenBehavior = result.response === 0 ? CLOSE_BEHAVIOR.MINIMIZE_TO_TRAY : CLOSE_BEHAVIOR.QUIT;
  if (result.checkboxChecked) {
    settings.closeBehavior = chosenBehavior;
    saveSettings();
    rebuildMenus();
  }

  return chosenBehavior;
}

async function handleWindowClose(event) {
  if (isQuitting) return;
  event.preventDefault();

  let behavior = settings.closeBehavior;
  if (behavior === CLOSE_BEHAVIOR.ASK) {
    behavior = await promptCloseBehavior();
  }

  if (behavior === 'cancel') return;
  if (behavior === CLOSE_BEHAVIOR.MINIMIZE_TO_TRAY) {
    minimizeToTray();
    return;
  }

  isQuitting = true;
  app.quit();
}

async function openCloseBehaviorSettings() {
  const currentText = {
    [CLOSE_BEHAVIOR.ASK]: '每次关闭窗口时询问',
    [CLOSE_BEHAVIOR.MINIMIZE_TO_TRAY]: '关闭窗口时缩至状态栏',
    [CLOSE_BEHAVIOR.QUIT]: '关闭窗口时退出软件',
  }[settings.closeBehavior];

  const result = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question',
    title: '关闭窗口行为设置',
    message: '设置点击关闭按钮时的行为',
    detail: `当前设置：${currentText}\n\n如果之前勾选过“不再提醒”，可以在这里重新改回“每次询问”。`,
    buttons: ['每次询问', '缩至状态栏', '退出软件', '取消'],
    defaultId: settings.closeBehavior === CLOSE_BEHAVIOR.ASK ? 0 : settings.closeBehavior === CLOSE_BEHAVIOR.MINIMIZE_TO_TRAY ? 1 : 2,
    cancelId: 3,
  });

  if (result.response === 3) return;
  settings.closeBehavior = [CLOSE_BEHAVIOR.ASK, CLOSE_BEHAVIOR.MINIMIZE_TO_TRAY, CLOSE_BEHAVIOR.QUIT][result.response];
  saveSettings();
  rebuildMenus();
}

function quitFromMenu() {
  isQuitting = true;
  app.quit();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 OpenClaw Panel', click: showMainWindow },
    { type: 'separator' },
    { label: '关闭窗口行为设置…', click: openCloseBehaviorSettings },
    { type: 'separator' },
    { label: '退出软件', click: quitFromMenu },
  ]);
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'OpenClaw Panel',
      submenu: [
        { label: '打开控制面板', click: showMainWindow },
        { label: '关闭窗口行为设置…', click: openCloseBehaviorSettings },
        { type: 'separator' },
        { label: '退出软件', click: quitFromMenu },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]);
}

function rebuildMenus() {
  Menu.setApplicationMenu(buildAppMenu());
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray) return;
  const iconPath = getIconPath();
  tray = fs.existsSync(iconPath) ? new Tray(iconPath) : new Tray();
  tray.setToolTip('OpenClaw Panel');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', showMainWindow);
  tray.on('click', showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    maximizable: true,
    title: 'OpenClaw Panel',
    icon: getIconPath(),
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.on('close', handleWindowClose);
  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (currentUrl.startsWith('file://') && currentUrl.endsWith('/loading.html')) {
      panelLoaded = false;
      bootPanel();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    bootPanel();
  });
}

async function stopStartedOpenClaw() {
  if (!startedOpenClaw || !openClawProcess || openClawProcess.killed) return;

  sendStatus('正在关闭本软件启动的 OpenClaw…');

  if (process.platform === 'win32' && openClawProcess.pid) {
    await new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(openClawProcess.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  } else {
    openClawProcess.kill('SIGTERM');
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    loadSettings();
    createTray();
    rebuildMenus();
    createWindow();
  });

  app.on('activate', showMainWindow);

  app.on('window-all-closed', () => {
    // Keep the app alive for the tray icon. Explicit menu quit still exits.
  });

  app.on('before-quit', async (event) => {
    if (isQuitting === 'stopping-openclaw') return;
    if (isQuitting !== true) isQuitting = true;
    event.preventDefault();
    isQuitting = 'stopping-openclaw';
    await stopStartedOpenClaw();
    app.exit(0);
  });
}
