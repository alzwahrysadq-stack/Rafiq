const {ipcRenderer} = require('electron');

// جسر الطباعة للحاسوب: window.print يطبع مباشرة على الطابعة الحرارية المختارة
// (يبقى سلوك web.js كما هو — المتصفح يستدعي window.print، والتطبيق يستقبله هنا)
window.print = () => ipcRenderer.send('print-silent');

// واجهة إضافية للتطبيق على الحاسوب
window.desktopAPI = {
  isDesktop: true,
  printSilent: () => ipcRenderer.send('print-silent'),
  printers: () => ipcRenderer.invoke('get-printers'),
  settings: () => ipcRenderer.invoke('get-settings'),
  savePrinter: (name) => ipcRenderer.send('save-printer', name),
  openPrinterSettings: () => ipcRenderer.send('open-printer-settings'),
  testPrint: () => ipcRenderer.send('test-print')
};
