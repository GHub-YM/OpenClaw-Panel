const { app, BrowserWindow, Menu, Tray, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PANEL_URL = process.env.OPENCLAW_PANEL_URL || 'http://127.0.0.1:18789';
const HEALTH_URL = `${PANEL_URL}/`;
const SERVICE_WAIT_MS = 20_000;
const RUN_WAIT_MS = 45_000;
const CHECK_INTERVAL_MS = 800;

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
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'openclaw-panel.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Ignore logging failures.
  }
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

function waitForOpenClaw(timeoutMs, label = 'OpenClaw gateway') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    async function tick() {
      if (await checkUrl(HEALTH_URL)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`${label} 在 ${Math.round(timeoutMs / 1000)} 秒内没有变为可访问。`));
      }
      setTimeout(tick, CHECK_INTERVAL_MS);
    }
    tick();
  });
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function findExecutableOnPath(name) {
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExts) {
      const candidate = path.join(dir, process.platform === 'win32' && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function getOpenClawCliTarget() {
  if (process.env.OPENCLAW_CMD) {
    return { type: 'direct', command: process.env.OPENCLAW_CMD };
  }

  const npmOpenClawDir = path.join(process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming'), 'npm', 'node_modules', 'openclaw');
  const openClawMjs = path.join(npmOpenClawDir, 'openclaw.mjs');
  const nodeExe = findExecutableOnPath('node');

  if (nodeExe && fs.existsSync(openClawMjs)) {
    return {
      type: 'node-mjs',
      command: nodeExe,
      prefixArgs: [openClawMjs],
    };
  }

  return { type: 'missing', command: 'openclaw' };
}

function buildOpenClawDisplay(target, args) {
  if (target.type === 'node-mjs') return [target.command, ...target.prefixArgs, ...args].map(quoteCmdArg).join(' ');
  return [target.command, ...args].map(quoteCmdArg).join(' ');
}

function spawnOpenClawCommand(args, stdio = ['ignore', 'pipe', 'pipe']) {
  const target = getOpenClawCliTarget();
  if (target.type === 'node-mjs') {
    return spawn(target.command, [...target.prefixArgs, ...args], {
      windowsHide: true,
      stdio,
    });
  }
  if (target.type === 'missing') {
    throw new Error('无法静默启动 OpenClaw：未找到 node.exe 或 openclaw.mjs。请确认 OpenClaw 已通过 npm 安装，且 Node.js 在 PATH 中。');
  }
  return spawn(target.command, args, {
    windowsHide: true,
    stdio,
  });
}

function runOpenClawCli(args, options = {}) {
  const target = getOpenClawCliTarget();
  const display = buildOpenClawDisplay(target, args);
  sendStatus(`${options.status || '正在执行 OpenClaw 命令'}…\n${display}`);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawnOpenClawCommand(args);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const text = data.toString().trim();
      if (text) sendStatus(text.slice(-300));
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      const text = data.toString().trim();
      if (text) sendStatus(text.slice(-300));
    });

    child.on('error', (error) => {
      reject(new Error(`无法执行命令：${display}\n${error.message}`));
    });

    child.on('exit', (code, signal) => {
      const result = { code, signal, stdout, stderr, display };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`命令执行失败：${display}\ncode=${code ?? 'null'} signal=${signal ?? 'null'}\n${stderr || stdout}`));
    });
  });
}

function runOpenClawGatewayForeground() {
  const target = getOpenClawCliTarget();
  const args = ['gateway', 'run'];
  const display = buildOpenClawDisplay(target, args);
  sendStatus(`服务启动/重启仍不可用，改用前台 gateway run…\n${display}`);

  openClawProcess = spawnOpenClawCommand(args);

  startedOpenClaw = true;

  openClawProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) sendStatus(text.slice(-300));
  });

  openClawProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) sendStatus(text.slice(-300));
  });

  openClawProcess.on('error', (error) => {
    sendError(`无法启动 OpenClaw gateway run。\n命令：${display}\n错误：${error.message}`);
  });

  openClawProcess.on('exit', (code, signal) => {
    if (!isQuitting && startedOpenClaw) {
      sendError(`OpenClaw gateway run 已退出。code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    }
  });
}

async function ensureOpenClaw() {
  sendStatus('正在检查 OpenClaw 是否已运行…');
  if (await checkUrl(HEALTH_URL)) {
    startedOpenClaw = false;
    sendStatus('检测到 OpenClaw 已运行，正在打开控制面板…');
    return;
  }

  try {
    runOpenClawGatewayForeground();
    await waitForOpenClaw(RUN_WAIT_MS, 'openclaw gateway run');
    sendStatus('OpenClaw gateway run 已静默启动，正在打开控制面板…');
    return;
  } catch (error) {
    throw new Error(`OpenClaw gateway 静默启动失败。\n\n已尝试：\n- gateway run: ${error.message}`);
  }
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
    show: true,
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

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL === PANEL_URL) {
      panelLoaded = false;
      sendError(`控制面板页面加载失败：${errorDescription} (${errorCode})`);
    }
  });

  setTimeout(bootPanel, 100);
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
