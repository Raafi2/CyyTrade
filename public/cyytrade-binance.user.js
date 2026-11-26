// ==UserScript==
// @name         CyyTrade: pembaca halaman BTC 5 menit Binance
// @namespace    cyytrade
// @version      1.0.1
// @description  Membaca angka yang tampil di halaman prediksi BTC 5 menit Binance (harga acuan, persen Naik/Turun, hitung mundur) dan mengirimnya ke aplikasi CyyTrade di komputer Anda. Tidak membaca API key, tidak menekan tombol, tidak membuat order.
// @match        https://www.binance.com/*
// @match        https://*.binance.com/*
// @downloadURL  http://127.0.0.1:8000/cyytrade-binance.user.js
// @updateURL    http://127.0.0.1:8000/cyytrade-binance.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Alamat aplikasi CyyTrade (php artisan serve). Ubah bila Anda memakai port lain.
  var SERVER = 'http://127.0.0.1:8000';
  var EVERY_MS = 1000;

  var NUM = '([\\d,]+(?:\\.\\d+)?)';
  var toNum = function (s) { return s == null ? null : parseFloat(String(s).replace(/,/g, '')); };
  var first = function (text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m) return m;
    }
    return null;
  };

  // Teks halaman Indonesia (sesuai layar yang diberikan) dengan cadangan istilah Inggris.
  function parse(text) {
    var kM = first(text, [
      new RegExp('Harga yang Perlu Dikalahkan[\\s\\S]{0,40}?\\$?\\s*' + NUM, 'i'),
      new RegExp('(?:Price to Beat|Target Price|Strike)[\\s\\S]{0,40}?\\$?\\s*' + NUM, 'i'),
    ]);
    if (!kM) return null; // bukan halaman prediksi

    var refM = first(text, [
      new RegExp('Referensi\\s*[+\\-−]?\\s*\\$?[\\d,]+\\.\\d+\\s*\\$?\\s*' + NUM, 'i'),
      new RegExp('(?:Reference|Current Price)\\s*[+\\-−]?\\s*\\$?[\\d,]+\\.\\d+\\s*\\$?\\s*' + NUM, 'i'),
    ]);
    var upM = first(text, [/Naik\s*(\d{1,3}(?:\.\d+)?)\s*%/, /\bUp\s*(\d{1,3}(?:\.\d+)?)\s*%/]);
    var dnM = first(text, [/Turun\s*(\d{1,3}(?:\.\d+)?)\s*%/, /\bDown\s*(\d{1,3}(?:\.\d+)?)\s*%/]);
    var leftM = first(text, [/Hitung\s*mundur\s*(\d{1,2}):(\d{2})/i, /(?:Countdown|Time left)\s*(\d{1,2}):(\d{2})/i]);
    var expM = first(text, [/Kedaluwarsa:?\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i, /(?:Expir\w*|Settle\w*):?\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i]);
    var titleM = text.match(/BTC[^\n]{0,60}(?:menit|min)/i);

    var expiry = null;
    if (expM) {
      var t = new Date(expM[1] + 'T' + expM[2]).getTime(); // waktu lokal browser, sama dengan yang tampil di halaman
      if (isFinite(t)) expiry = Math.round(t / 1000);
    }
    return {
      k: toNum(kM[1]),
      ref: refM ? toNum(refM[1]) : null,
      up: upM ? parseFloat(upM[1]) : null,
      down: dnM ? parseFloat(dnM[1]) : null,
      left: leftM ? parseInt(leftM[1], 10) * 60 + parseInt(leftM[2], 10) : null,
      expiry: expiry,
      title: titleM ? titleM[0].trim() : null,
    };
  }

  // ---- lencana status di pojok kiri bawah ----
  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;font:11px/1.4 monospace;padding:4px 8px;border-radius:3px;background:#111;color:#bbb;border:1px solid #444;cursor:pointer;max-width:70vw;display:none';
  badge.title = 'Klik untuk menyalin teks halaman (debug) ke clipboard';
  document.documentElement.appendChild(badge);
  var show = function (msg, color) { badge.style.display = 'block'; badge.style.borderColor = color; badge.style.color = color; badge.textContent = 'CyyTrade ' + msg; };
  badge.addEventListener('click', function () {
    var t = (document.body.innerText || '').slice(0, 3000);
    if (typeof GM_setClipboard === 'function') { GM_setClipboard(t); show('teks halaman disalin', '#e0b341'); }
  });

  function send(p) {
    var clean = {};
    Object.keys(p).forEach(function (k) { if (p[k] !== null && p[k] !== undefined && !(typeof p[k] === 'number' && !isFinite(p[k]))) clean[k] = p[k]; });
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER + '/api/btc5/feed',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'fetch' },
      data: JSON.stringify(clean),
      timeout: 4000,
      onload: function (r) {
        if (r.status >= 200 && r.status < 300) {
          show('OK  acuan ' + p.k + '  Naik ' + (p.up == null ? '?' : p.up + '%') + ' / Turun ' + (p.down == null ? '?' : p.down + '%') + '  sisa ' + (p.left == null ? '?' : p.left + 's'), '#3ecf8e');
        } else {
          show('ditolak aplikasi (HTTP ' + r.status + ')', '#e5534b');
        }
      },
      onerror: function () { show('tidak bisa terhubung ke ' + SERVER + ' (php artisan serve jalan?)', '#e5534b'); },
      ontimeout: function () { show('timeout ke ' + SERVER, '#e5534b'); },
    });
  }

  show('aktif, membaca halaman…', '#e0b341');
  setInterval(function () {
    var p;
    try { p = parse(document.body ? document.body.innerText || '' : ''); } catch (e) { p = null; }
    if (!p) { show('aktif, tapi halaman prediksi belum dikenali (klik kotak ini untuk menyalin teks halaman)', '#e0b341'); return; }
    send(p);
  }, EVERY_MS);
})();
