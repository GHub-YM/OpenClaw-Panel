# OpenClaw Panel

Windows desktop shell for the OpenClaw web control panel.

## Features

- Opens the OpenClaw web panel in a resizable desktop window.
- Starts `openclaw gateway --port 18789` automatically when OpenClaw is not already running.
- If OpenClaw was already running, the app connects to it without taking ownership.
- If this app started OpenClaw, quitting the app also stops that OpenClaw process.
- Supports tray/minimize behavior with a persistent close-window preference.
- Includes custom OpenClaw icon.

## Development

```powershell
npm install
npm start
```

## Build portable Windows exe

```powershell
npm run dist
```

Output:

```text
dist/OpenClaw-Panel-0.1.0.exe
```
