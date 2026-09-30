/**
 * رصد — تسجيل Service Worker + تلميح التثبيت على الموبايل
 */
(function () {
  'use strict';

  // تسجيل Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function (err) {
        console.warn('SW register failed', err);
      });
    });
  }

  // زر / بانر بسيط لـ «تثبيت التطبيق» (Android Chrome)
  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallHint();
  });

  function showInstallHint() {
    if (document.getElementById('rasdPwaInstallBar')) return;
    var bar = document.createElement('div');
    bar.id = 'rasdPwaInstallBar';
    bar.setAttribute('dir', 'rtl');
    bar.style.cssText =
      'position:fixed;bottom:16px;right:16px;left:16px;max-width:420px;margin:0 auto;' +
      'z-index:10000;background:#1e3a5f;color:#fff;padding:12px 16px;border-radius:12px;' +
      'box-shadow:0 8px 24px rgba(15,23,42,.25);display:flex;align-items:center;gap:12px;' +
      'font-family:Cairo,Segoe UI,Tahoma,sans-serif;font-size:14px;';
    bar.innerHTML =
      '<span style="flex:1;line-height:1.5;">ثبّت «رصد» على الشاشة الرئيسية للوصول السريع</span>' +
      '<button type="button" id="rasdPwaInstallBtn" style="background:#fff;color:#1e3a5f;border:none;' +
      'padding:8px 14px;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">تثبيت</button>' +
      '<button type="button" id="rasdPwaInstallClose" style="background:transparent;color:#cbd5e1;border:none;' +
      'font-size:18px;cursor:pointer;line-height:1;padding:4px;" aria-label="إغلاق">×</button>';
    document.body.appendChild(bar);

    document.getElementById('rasdPwaInstallBtn').addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        bar.remove();
      });
    });
    document.getElementById('rasdPwaInstallClose').addEventListener('click', function () {
      bar.remove();
    });
  }

  // بعد التثبيت
  window.addEventListener('appinstalled', function () {
    var bar = document.getElementById('rasdPwaInstallBar');
    if (bar) bar.remove();
    deferredPrompt = null;
  });
})();
