// Pemberitahuan di browser: Notification API, bunyi (WebAudio), judul tab berkedip, getar.
// Semuanya hanya bekerja selama tab web terbuka. Tidak ada proses latar belakang.

let ctx: AudioContext | null = null;
let flashTimer: number | undefined;
const baseTitle = typeof document !== 'undefined' ? document.title : '';

/** Panggil dari klik tombol (syarat browser) untuk meminta izin notifikasi dan membuka audio. */
export async function primeAlerts(): Promise<NotificationPermission | 'unsupported'> {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) { ctx = ctx ?? new AC(); void ctx.resume(); }
  } catch { /* audio tidak tersedia */ }
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') {
    try { return await Notification.requestPermission(); } catch { return Notification.permission; }
  }
  return Notification.permission;
}

export function alertPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function beep(kind: 'good' | 'bad' | 'warn') {
  if (!ctx) return;
  const seq = kind === 'good' ? [660, 880, 1100] : kind === 'bad' ? [440, 330, 220] : [600, 600];
  let t = ctx.currentTime;
  for (const f of seq) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.25);
    t += 0.26;
  }
}

function flashTitle(text: string) {
  if (flashTimer !== undefined) window.clearInterval(flashTimer);
  let on = false;
  let n = 0;
  flashTimer = window.setInterval(() => {
    on = !on;
    document.title = on ? text : baseTitle;
    if (++n > 30 || document.visibilityState === 'visible' && n > 6) {
      window.clearInterval(flashTimer);
      flashTimer = undefined;
      document.title = baseTitle;
    }
  }, 800);
}

export function notify(kind: 'good' | 'bad' | 'warn', title: string, body: string) {
  beep(kind);
  flashTitle(title);
  try { navigator.vibrate?.(kind === 'bad' ? [300, 100, 300] : [200]); } catch { /* abaikan */ }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: `${title}|${body}`, requireInteraction: kind !== 'warn' }); } catch { /* abaikan */ }
  }
}
