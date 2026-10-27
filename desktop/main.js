const {app, BrowserWindow, ipcMain, Menu, dialog} = require('electron');
const path = require('path');
const fs = require('fs');

let mainWin = null;
let splash = null;
let printerWin = null;

const settingsFile = () => path.join(app.getPath('userData'), 'rafiq-printer.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s)); } catch (e) {}
}

function webIndex() {
  const packaged = path.join(__dirname, 'app', 'index.html');
  const dev = path.join(__dirname, '..', 'web-client', 'index.html');
  return fs.existsSync(packaged) ? packaged : dev;
}

function createSplash() {
  splash = new BrowserWindow({
    width: 760, height: 460,
    frame: false, resizable: false, movable: false, maximizable: false,
    alwaysOnTop: true, center: true, show: true,
    backgroundColor: '#071726', skipTaskbar: false
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.setMenuBarVisibility(false);
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1366, height: 860,
    minWidth: 1024, minHeight: 700,
    show: false, backgroundColor: '#eef2f7',
    icon: path.join(__dirname, 'resources', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWin.loadFile(webIndex());
  mainWin.once('ready-to-show', () => {
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.show();
      if (splash && !splash.isDestroyed()) splash.close();
      splash = null;
    }, 1900);
  });
  const cssPath = path.join(__dirname, 'desktop.css');
  mainWin.webContents.on('did-finish-load', () => {
    try { mainWin.webContents.insertCSS(fs.readFileSync(cssPath, 'utf8')); } catch (e) {}
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function silentPrint(win) {
  if (!win || win.isDestroyed()) return;
  const s = loadSettings();
  const opts = { silent: !!s.printerName, printBackground: true, margins: { marginType: 'none' } };
  if (s.printerName) opts.deviceName = s.printerName;
  win.webContents.print(opts, (ok) => {
    if (!ok && s.printerName) {
      try { win.webContents.print({ silent: false, printBackground: true, margins: { marginType: 'none' } }); } catch (e) {}
    }
  });
}

function openPrinterSettings() {
  if (printerWin && !printerWin.isDestroyed()) { printerWin.focus(); return; }
  printerWin = new BrowserWindow({
    width: 560, height: 520,
    resizable: false, minimizable: false, maximizable: false,
    parent: mainWin || undefined, modal: false,
    backgroundColor: '#0e2a47',
    title: 'إعدادات الطابعة',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  });
  printerWin.loadFile(path.join(__dirname, 'printer.html'));
  printerWin.setMenuBarVisibility(false);
  printerWin.on('closed', () => { printerWin = null; });
}

function testPrint() {
  const s = loadSettings();
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <style>
    @page{size:80mm auto;margin:0}
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:72mm;font-family:Tahoma,Arial,sans-serif;font-size:11px;padding:4mm 3mm;color:#000}
    h1{font-size:15px;text-align:center;margin:2mm 0 1mm}
    .sub{text-align:center;font-size:10px;color:#333}
    hr{border:none;border-top:1px dashed #000;margin:2.5mm 0}
    table{width:100%;border-collapse:collapse}
    td{padding:.8mm 0;font-size:11px}
    .t{text-align:center}
    .tot{font-size:13px;font-weight:bold}
    .foot{margin-top:3mm;text-align:center;font-size:9.5px;color:#222}
  </style></head><body>
  <h1>بقالة الوفاء</h1>
  <div class="sub">فاتورة تجريبية — رفيق المحاسب</div>
  <hr>
  <table>
    <tr><td>خبز عربي × 3</td><td class="t">150</td></tr>
    <tr><td>حليب نادك 1ل</td><td class="t">400</td></tr>
    <tr><td>سكر 1كجم</td><td class="t">700</td></tr>
    <tr><td>شاي عدني 250جم</td><td class="t">900</td></tr>
  </table>
  <hr>
  <table>
    <tr class="tot"><td>الإجمالي</td><td class="t">2,150 ريال</td></tr>
    <tr><td>المدفوع</td><td class="t">2,500 ريال</td></tr>
    <tr><td>الباقي</td><td class="t">350 ريال</td></tr>
  </table>
  <hr>
  <div class="foot">شكرًا لزيارتكم — رفيق المحاسب<br>من دهفة للتقنية</div>
  </body></html>`;
  const tw = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  tw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => {
    setTimeout(() => { silentPrint(tw); }, 400);
    setTimeout(() => { if (!tw.isDestroyed()) tw.destroy(); }, 12000);
  });
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'ملف',
      submenu: [
        { label: 'طباعة السند الحالي', accelerator: 'CmdOrCtrl+P', click: () => silentPrint(mainWin) },
        { label: 'إعدادات الطابعة…', click: () => openPrinterSettings() },
        { label: 'طباعة تجريبية (بقالة الوفاء)', click: () => testPrint() },
        { type: 'separator' },
        { role: 'quit', label: 'خروج' }
      ]
    },
    {
      label: 'عرض',
      submenu: [
        { role: 'reload', label: 'تحديث' },
        { role: 'togglefullscreen', label: 'ملء الشاشة' },
        { type: 'separator' },
        { role: 'zoomIn', label: 'تكبير' },
        { role: 'zoomOut', label: 'تصغير' },
        { role: 'resetZoom', label: 'الحجم الأصلي' }
      ]
    },
    {
      label: 'مساعدة',
      submenu: [
        {
          label: 'عن رفيق المحاسب',
          click: () => {
            dialog.showMessageBox(mainWin || undefined, {
              type: 'info',
              title: 'عن رفيق المحاسب',
              message: 'رفيق المحاسب — نظام نقاط البيع والمحاسبة',
              detail: 'من دهفة للتقنية — الإصدار 0.3.4 (Build 144)\nيعمل مع طابعة حرارية ويتزامن مع هاتف المالك.'
            });
          }
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

ipcMain.handle('get-printers', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w ? w.webContents.getPrintersAsync() : [];
});
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('save-printer', (e, name) => {
  const s = loadSettings();
  s.printerName = name || '';
  saveSettings(s);
  if (printerWin && !printerWin.isDestroyed()) printerWin.close();
});
ipcMain.on('print-silent', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  silentPrint(w === printerWin ? mainWin : w);
});
ipcMain.on('open-printer-settings', () => openPrinterSettings());
ipcMain.on('test-print', () => testPrint());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  app.whenReady().then(() => {
    createSplash();
    buildMenu();
    createMain();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createSplash();
        createMain();
      }
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
