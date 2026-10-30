/*!
 * Dictée — moteur de transcription Whisper 100 % local, partagé entre le Transcripteur et Podo Bilan.
 * Fichiers requis à côté de ce script : worker.js, pcm-worklet.js (+ lib/ pour un usage hors ligne).
 *
 *   const D = Dictee.create({ base: './', storageKey: 'dictee' });
 *   D.attach(textarea, { lexicon: 'lombalgie, talalgie…' });   // bouton micro sur un champ
 *   D.openSettings();                                           // réglages, vocabulaire, corrections
 *   D.startMic({ onText(text, t) {}, onLevel(rms) {} });        // dictée libre
 *   D.transcribeFile(file, { onText, onProgress });             // fichier audio
 */
(function (global) {
  'use strict';
  const SR = 16000;
  const CONFIG_VERSION = 1;

  const MODELS = {
    base:  { id: 'onnx-community/whisper-base',  size: '≈ 80 Mo',  label: 'Rapide · base' },
    small: { id: 'onnx-community/whisper-small', size: '≈ 250 Mo', label: 'Précis · small' },
    turbo: { id: 'onnx-community/whisper-large-v3-turbo', size: '≈ 1 à 1,4 Go', label: 'Très précis · large-v3-turbo', big: true },
  };
  const DEFAULT_LEXICON = "Bilan podologique et postural. Posturale, antéro-postérieure, médio-latérale, stabilométrie, centre de pression, Romberg, bipodal, unipodal, proprioception, hallux valgus, métatarsalgie, névrome de Morton, aponévrosite plantaire, talalgie, tendinopathie achilléenne, onychocryptose, hyperkératose, pied creux, pied plat valgus, arrière-pied varus, orthèses plantaires, élément rétro-capital, coin supinateur, talonnette.";
  // Ancienne liste par défaut (v1) : remplacée automatiquement si l'utilisateur ne l'a pas modifiée
  const OLD_DEFAULTS = ["Consultation de pédicurie-podologie. Hallux valgus, hallux rigidus, quintus varus, métatarsalgie, névrome de Morton, aponévrosite plantaire, épine calcanéenne, tendinopathie achilléenne, onychocryptose, onychomycose, onychogryphose, hyperkératose, durillon, verrue plantaire, orteils en griffe, pied creux, pied plat valgus, arrière-pied varus, sous-talienne, métatarso-phalangienne, orthèses plantaires, élément rétro-capital, barre rétro-capitale, coin supinateur, talonnette, orthoplastie, stabilométrie, posturologie, neuropathie diabétique, monofilament."];
  const LEGACY_LANGS = { french: 'fr', english: 'en', spanish: 'es', german: 'de', italian: 'it' };

  // Phrases fantômes que Whisper produit sur du silence ou du bruit
  const HALLU = [/amara\.org/i, /sous-titr/i, /merci d'avoir regard/i, /abonnez-vous/i, /thanks? for watching/i];

  /* ---------- Outils audio ---------- */
  const FR = 320; // trames de 20 ms
  function frameRms(a, i) { let s = 0; const e = Math.min(i + FR, a.length); for (let k = i; k < e; k++) s += a[k] * a[k]; return Math.sqrt(s / Math.max(1, e - i)); }
  function quietestCut(a, from, to) {
    const rms = []; for (let i = from; i + FR <= to; i += FR) rms.push(frameRms(a, i));
    const W = 15; let best = to, bestE = Infinity;
    for (let k = 0; k + W <= rms.length; k++) { let e = 0; for (let j = k; j < k + W; j++) e += rms[j]; if (e < bestE) { bestE = e; best = from + (k + (W >> 1)) * FR; } }
    return best;
  }
  function maxRms(a, from, to) { let m = 0; for (let i = from; i < to; i += FR) m = Math.max(m, frameRms(a, i)); return m; }

  /* ---------- Texte ---------- */
  function parseCorrections(src) {
    return (src || '').split('\n').map((l) => l.split(/\s*(?:=|→|->)\s*/)).filter((p) => p.length === 2 && p[0].trim())
      .map(([a, b]) => ({
        re: new RegExp('(?<![\\p{L}\\p{N}])' + a.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}])', 'giu'),
        to: b.trim(),
      }));
  }
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  function create(opts) {
    opts = opts || {};
    const base = new URL(opts.base || './', document.baseURI).href;
    const native = opts.native === undefined ? (global.AndroidBridge || null) : opts.native;
    const KEY = opts.storageKey || 'dictee';

    /* ---------- Stockage ---------- */
    const store = {
      get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
      set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
      del(k) { try { localStorage.removeItem(k); } catch (_) {} },
    };
    const saved = store.get(KEY + '.settings', null) || (opts.legacySettingsKey ? store.get(opts.legacySettingsKey, {}) : {});
    const settings = { model: 'small', lang: 'fr', device: 'auto', lexicon: DEFAULT_LEXICON, corrections: '' };
    ['model', 'lang', 'device', 'lexicon', 'corrections'].forEach((k) => { if (saved[k] != null) settings[k] = saved[k]; });
    if (OLD_DEFAULTS.indexOf(settings.lexicon) >= 0) settings.lexicon = DEFAULT_LEXICON;
    if (LEGACY_LANGS[settings.lang]) settings.lang = LEGACY_LANGS[settings.lang];
    if (!settings.lang) settings.lang = 'fr';
    if (!MODELS[settings.model]) settings.model = 'small';
    let corrections = parseCorrections(settings.corrections);
    function saveSettings() { store.set(KEY + '.settings', settings); }
    const GUARD = KEY + '.inflight';
    function guardOn(what) { store.set(GUARD, { what, model: settings.model, device: engine.device || settings.device, t: Date.now() }); }
    function guardOff() { store.del(GUARD); }
    // L'appli s'est arrêtée pendant une dictée : on repasse sur un réglage plus sûr
    let crashNotice = '';
    (function recoverFromCrash() {
      const g = store.get(GUARD, null); if (!g) return;
      store.del(GUARD);
      if (Date.now() - (g.t || 0) > 24 * 3600 * 1000) return;
      if (g.device === 'webgpu' || settings.device === 'webgpu') {
        settings.device = 'wasm';
        crashNotice = "La dictée a interrompu l'application. Calcul repassé sur le processeur.";
      } else if (settings.model === 'turbo') {
        settings.model = 'small';
        crashNotice = "La dictée a interrompu l'application (mémoire insuffisante). Modèle repassé en « Précis ».";
      } else if (settings.model === 'small') {
        settings.model = 'base';
        crashNotice = "La dictée a interrompu l'application (mémoire insuffisante). Modèle repassé en « Rapide ».";
      } else {
        crashNotice = "La dictée a interrompu l'application. Si cela se reproduit, signalez-le.";
      }
      store.set(KEY + '.settings', settings);
    })();
    const cachedKey = (m) => KEY + '.loaded.' + m;
    const isCached = () => store.get(cachedKey(settings.model), false) || (opts.legacySettingsKey && store.get('tx.loaded.' + settings.model, false));

    /* ---------- Événements ---------- */
    const listeners = {};
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; }
    function emit(ev, data) { (listeners[ev] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }
    function notify(msg) { if (opts.notify) opts.notify(msg); else if (listeners.message && listeners.message.length) emit('message', msg); else toast(msg); }

    /* ---------- Moteur ---------- */
    const libBase = opts.libBase ? new URL(opts.libBase, base).href : (native ? new URL('lib/', base).href : '');
    const wurl = new URL('worker.js', base); if (libBase) wurl.searchParams.set('lib', libBase);
    const worker = new Worker(wurl.href, { type: 'module' });
    const engine = { state: 'idle', device: null, error: '', threads: 0, lastMs: 0, lastSec: 0 };
    const files = new Map();
    const pending = new Map();
    let loadCb = null, loadPromise = null, seq = 0, busy = 0, fileJob = null;

    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const p = m.p;
        if (p.status === 'progress' && p.file) { files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 }); emitStatus(); }
      } else if (m.type === 'ready') {
        engine.threads = m.threads || 1;
        if (loadCb) { loadCb.res(); loadCb = null; }
      } else if (m.type === 'count') {
        if (pending.has(m.id)) { pending.get(m.id).res(m.n); pending.delete(m.id); }
      } else if (m.type === 'result' || m.type === 'error') {
        if (m.id != null && pending.has(m.id)) {
          const r = pending.get(m.id); pending.delete(m.id);
          if (m.type === 'result' && m.ms) { engine.lastMs = m.ms; engine.lastSec = m.sec; }
          m.type === 'result' ? r.res(m.text) : r.rej(new Error(m.message));
        } else if (m.type === 'error' && loadCb) { loadCb.rej(new Error(m.message)); loadCb = null; }
      }
    };
    worker.onerror = (e) => {
      const msg = "Le moteur n'a pas pu démarrer (" + (e.message || 'erreur de chargement') + ').';
      if (loadCb) { loadCb.rej(new Error(msg)); loadCb = null; }
    };

    function status() {
      let l = 0, t = 0; files.forEach((f) => { l += f.loaded; t += f.total; });
      return {
        state: engine.state, device: engine.device, error: engine.error, cached: !!isCached(),
        model: settings.model, modelSize: MODELS[settings.model].size,
        downloadPct: t ? Math.round(l / t * 100) : 0,
        busy, fileJob: fileJob ? { done: fileJob.done, total: fileJob.total } : null,
        recording: !!mic, threads: engine.threads, lastMs: engine.lastMs, lastSec: engine.lastSec,
      };
    }
    function emitStatus() { emit('status', status()); }

    async function hasWebGPU() { try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (_) { return false; } }
    // Dans la WebView Android, WebGPU est instable (un plantage graphique ferme toute l'appli) : processeur par défaut
    const inWebView = !!native || /; wv\)/.test(navigator.userAgent);
    async function pickDevice() {
      if (settings.device !== 'auto') return settings.device;
      if (inWebView) return 'wasm';
      return (await hasWebGPU()) ? 'webgpu' : 'wasm';
    }
    function workerLoad(device) {
      return new Promise((res, rej) => {
        loadCb = { res, rej }; files.clear();
        const m = MODELS[settings.model];
        worker.postMessage({ type: 'load', model: m.id, device, big: !!m.big });
      });
    }
    function loadModel() {
      if (loadPromise) return loadPromise;
      engine.state = 'loading'; engine.error = ''; emitStatus();
      loadPromise = (async () => {
        let dev = await pickDevice();
        guardOn('load');
        try { await workerLoad(dev); }
        catch (err) { if (dev !== 'webgpu') throw err; dev = 'wasm'; await workerLoad(dev); } // repli processeur
        engine.device = dev; engine.state = 'ready';
        if (!busy) guardOff();
        store.set(cachedKey(settings.model), true);
        emitStatus();
      })();
      loadPromise.catch((err) => { guardOff(); loadPromise = null; engine.state = 'error'; engine.error = err.message; emitStatus(); });
      return loadPromise;
    }
    function resetModel() { loadPromise = null; engine.state = 'idle'; engine.device = null; emitStatus(); }

    function run(audio, lexicon, previous) {
      return new Promise((res, rej) => {
        const id = ++seq; pending.set(id, { res, rej });
        worker.postMessage({ type: 'run', id, audio, lang: settings.lang, lexicon, previous }, [audio.buffer]);
      });
    }
    function countTokens(text) {
      if (engine.state !== 'ready') return Promise.resolve(-1);
      return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ type: 'count', id, text }); });
    }

    /* ---------- Nettoyage du texte ---------- */
    function applyCorrections(t) {
      for (const c of corrections) t = t.replace(c.re, (m) => (m[0] !== m[0].toLowerCase() && c.to[0] === c.to[0].toLowerCase()) ? c.to[0].toUpperCase() + c.to.slice(1) : c.to);
      return t;
    }
    function echoesLexicon(t, lexicon) {
      const lex = norm(lexicon || ''); if (!lex) return false;
      const n = norm(t);
      if (n.length > 12 && lex.includes(n)) return true;
      const terms = (lexicon || '').split(/[,.;]/).map(norm).filter((x) => x.length > 4);
      return terms.filter((x) => n.includes(x)).length >= 6 && n.split(' ').length < terms.length * 3;
    }
    function clean(t, lexicon) {
      t = (t || '').replace(/\s+/g, ' ').trim();
      if (!t || /^[\s.,!?…\-–—♪*]*$/.test(t)) return '';
      if (t.length < 90 && HALLU.some((r) => r.test(t))) return '';
      if (echoesLexicon(t, lexicon)) return '';
      return applyCorrections(t);
    }
    // Vocabulaire du champ en premier (le plus pertinent), puis vocabulaire général
    const fullLexicon = (fieldLex) => [fieldLex, settings.lexicon].filter(Boolean).join(' ');

    /* ---------- File d'attente ---------- */
    let queue = Promise.resolve();
    function enqueue(job) {
      busy++; emitStatus(); keepAwake(true);
      const p = queue.then(async () => {
        try {
          await loadModel();
          const lex = fullLexicon(job.lexicon);
          const prev = typeof job.previous === 'function' ? job.previous() : (job.previous || '');
          guardOn('run');
          const text = clean(await run(job.audio, lex, prev), lex);
          if (text) job.onText(text, job.t);
        } catch (err) {
          notify('Échec sur un passage : ' + err.message);
        } finally {
          busy--;
          if (!busy) guardOff();
          if (fileJob && job.file) fileJob.done++;
          if (!busy) { fileJob = null; if (!mic) keepAwake(false); }
          emitStatus();
          if (job.after) job.after();
        }
      });
      queue = p;
      return p;
    }

    /* ---------- Écran allumé ---------- */
    let wakeLock = null;
    async function keepAwake(on) {
      if (native && native.keepAwake) { try { native.keepAwake(!!on); } catch (_) {} return; }
      try {
        if (on && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
        if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
      } catch (_) {}
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (mic || busy)) keepAwake(true); });

    /* ---------- Micro ---------- */
    let mic = null;
    async function startMic(o) {
      o = o || {};
      if (mic) await stopMic();
      if (!navigator.mediaDevices || !global.AudioWorkletNode) { notify("Ce navigateur ne permet pas l'accès au micro."); return null; }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (_) { notify("Accès au micro refusé. Autorisez-le dans les réglages."); return null; }
      loadModel();
      const ctx = new AudioContext({ sampleRate: SR });
      await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', base).href);
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-tap');
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(node); node.connect(mute); mute.connect(ctx.destination);
      let lastText = '';
      const r = {
        stream, ctx, node, o, chunks: [], len: 0, start: 0, total: 0, floor: 0.01, silentMs: 0, voiced: false, inflight: 0,
        previous: o.previous || (() => lastText),
        emit: (text, t) => { lastText = text; o.onText && o.onText(text, t); },
      };
      mic = r;
      node.port.onmessage = (e) => onPcm(r, e.data);
      keepAwake(true); emitStatus();
      return {
        stop: () => (mic === r ? stopMic() : Promise.resolve()),
        get seconds() { return r.total / SR; },
        get active() { return mic === r; },
      };
    }
    function onPcm(r, c) {
      if (mic !== r) return;
      r.chunks.push(c); r.len += c.length; r.total += c.length;
      let s = 0; for (let i = 0; i < c.length; i++) s += c[i] * c[i];
      const rms = Math.sqrt(s / c.length);
      r.floor = rms < r.floor ? r.floor * 0.95 + rms * 0.05 : r.floor * 1.0008;
      const thr = Math.max(0.006, r.floor * 3);
      if (rms < thr) r.silentMs += c.length / SR * 1000; else { r.silentMs = 0; r.voiced = true; }
      r.o.onLevel && r.o.onLevel(rms);
      const dur = r.len / SR;
      // Passages plus longs = plus de contexte pour le modèle = meilleure précision
      if (dur >= 5 && r.silentMs >= 700) flush(r, false);
      else if (dur >= 25) flush(r, true);
    }
    function flush(r, cutAtQuiet) {
      if (!r.len) return;
      const all = new Float32Array(r.len); let off = 0; for (const c of r.chunks) { all.set(c, off); off += c.length; }
      let end = all.length;
      if (cutAtQuiet && all.length > 8 * SR) end = quietestCut(all, all.length - 6 * SR, all.length);
      const seg = all.slice(0, end), rest = all.slice(end);
      const t = r.start / SR;
      r.start += end; r.chunks = rest.length ? [rest] : []; r.len = rest.length;
      const voiced = r.voiced; r.voiced = false; r.silentMs = 0;
      if (voiced && maxRms(seg, 0, seg.length) > 0.008) {
        r.inflight++;
        enqueue({ audio: seg, t, lexicon: r.o.lexicon, previous: r.previous, onText: r.emit, after: () => { r.inflight--; if (!r.inflight && mic !== r) r.o.onIdle && r.o.onIdle(); } });
      }
    }
    async function stopMic() {
      const r = mic; if (!r) return;
      flush(r, false);
      mic = null;
      r.node.port.onmessage = null;
      r.stream.getTracks().forEach((t) => t.stop());
      try { await r.ctx.close(); } catch (_) {}
      if (!busy) keepAwake(false);
      emitStatus();
      r.o.onStop && r.o.onStop({ seconds: r.total / SR, pending: r.inflight });
      if (!r.inflight) r.o.onIdle && r.o.onIdle();
    }

    /* ---------- Fichiers audio ---------- */
    async function decodeFile(file) {
      const ab = await file.arrayBuffer();
      const tmp = new AudioContext();
      let buf;
      try { buf = await tmp.decodeAudioData(ab); } finally { tmp.close(); }
      const off = new OfflineAudioContext(1, Math.ceil(buf.duration * SR), SR);
      const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
      return (await off.startRendering()).getChannelData(0);
    }
    async function transcribeFile(file, o) {
      o = o || {};
      if (mic) throw new Error("Arrêtez la dictée avant d'importer.");
      loadModel();
      let pcm;
      try { pcm = await decodeFile(file); }
      catch (_) { throw new Error("Format non lu par l'appareil. Essayez m4a, mp3, wav, ogg ou opus."); }
      const duration = pcm.length / SR;
      const MAX = 28 * SR, SEARCH = 6 * SR, segs = [];
      let s = 0;
      while (s < pcm.length) {
        if (pcm.length - s <= MAX) { segs.push([s, pcm.length]); break; }
        const cut = quietestCut(pcm, s + MAX - SEARCH, s + MAX); segs.push([s, cut]); s = cut;
      }
      const kept = segs.filter(([a, b]) => maxRms(pcm, a, b) > 0.005);
      o.onStart && o.onStart({ duration, segments: kept.length });
      if (!kept.length) return { duration, segments: 0 };
      fileJob = { done: 0, total: kept.length }; emitStatus();
      let last = '';
      const jobs = kept.map(([a, b]) => enqueue({
        audio: pcm.slice(a, b), t: a / SR, file: true, lexicon: o.lexicon, previous: () => last,
        onText: (text, t) => { last = text; o.onText && o.onText(text, t); },
        after: () => { o.onProgress && o.onProgress(fileJob ? fileJob.done : kept.length, kept.length); },
      }));
      await Promise.all(jobs);
      return { duration, segments: kept.length };
    }

    /* ---------- Export / import du vocabulaire et des corrections ---------- */
    function exportConfig() {
      return JSON.stringify({ app: 'dictee', version: CONFIG_VERSION, date: new Date().toISOString(), lexicon: settings.lexicon, corrections: settings.corrections }, null, 2);
    }
    function importConfig(text, mode) {
      let d; try { d = JSON.parse(text); } catch (_) { throw new Error("Fichier illisible : ce n'est pas un export de dictée."); }
      if (!d || d.app !== 'dictee') throw new Error("Ce fichier n'est pas un export de dictée.");
      if (typeof d.lexicon === 'string') settings.lexicon = d.lexicon;
      if (typeof d.corrections === 'string') {
        if (mode === 'merge') {
          const have = new Set(settings.corrections.split('\n').map((l) => l.trim()).filter(Boolean));
          const add = d.corrections.split('\n').map((l) => l.trim()).filter((l) => l && !have.has(l));
          settings.corrections = [settings.corrections.trim(), ...add].filter(Boolean).join('\n');
        } else settings.corrections = d.corrections;
      }
      corrections = parseCorrections(settings.corrections);
      saveSettings(); emit('settings', settings);
    }
    function saveFile(name, text) {
      if (opts.saveFile) return opts.saveFile(name, text);
      if (native && native.saveText) return native.saveText(name, text) ? 'Enregistré dans Téléchargements' : "Échec de l'enregistrement";
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return 'Fichier exporté';
    }
    async function clearModels() {
      if (busy || mic) throw new Error('Attendez la fin de la transcription.');
      try { await caches.delete('transformers-cache'); } catch (_) {}
      Object.keys(MODELS).forEach((k) => { store.del(cachedKey(k)); store.del('tx.loaded.' + k); });
      resetModel();
    }

    /* ---------- Styles communs (préfixe dk-) ---------- */
    function injectStyle() {
      if (document.getElementById('dk-style')) return;
      const st = document.createElement('style'); st.id = 'dk-style';
      st.textContent = `
.dk-root{--dk-bg:#fafbfb;--dk-fg:#162023;--dk-muted:#5a696c;--dk-line:#d2d9da;--dk-accent:#1e6a68;--dk-accent-fg:#fff;--dk-rec:#d1372b;--dk-field:#eceff0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]):not(.dk-light).dk-root{--dk-bg:#172023;--dk-fg:#e4ebea;--dk-muted:#8fa1a2;--dk-line:#273437;--dk-accent:#5dbdb3;--dk-accent-fg:#0d1a1a;--dk-rec:#ff5b4e;--dk-field:#101618}}
:root[data-theme="dark"]:not(.dk-light).dk-root{--dk-bg:#172023;--dk-fg:#e4ebea;--dk-muted:#8fa1a2;--dk-line:#273437;--dk-accent:#5dbdb3;--dk-accent-fg:#0d1a1a;--dk-rec:#ff5b4e;--dk-field:#101618}
.dk-wrap{position:relative;display:block}
.dk-wrap>textarea,.dk-wrap>input{padding-right:52px!important;box-sizing:border-box}
.dk-mic{position:absolute;right:6px;bottom:6px;width:40px;height:40px;border-radius:50%;border:1px solid var(--dk-line);background:var(--dk-bg);color:var(--dk-fg);display:grid;place-items:center;cursor:pointer;padding:0;z-index:1}
.dk-wrap:not(.dk-line) .dk-mic{right:16px;bottom:8px}
.dk-wrap.dk-line .dk-mic{top:50%;bottom:auto;margin-top:-15px;width:30px;height:30px;right:4px}
.dk-wrap.dk-line>input{padding-right:40px!important}
.dk-mic svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.8}
.dk-mic:focus-visible{outline:2px solid var(--dk-accent);outline-offset:2px}
.dk-mic.dk-on{background:var(--dk-rec);border-color:var(--dk-rec);color:#fff;animation:dk-pulse 1.4s ease-in-out infinite}
.dk-mic.dk-work::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid transparent;border-top-color:var(--dk-accent);animation:dk-spin 1s linear infinite}
@keyframes dk-pulse{50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--dk-rec) 25%,transparent)}}
@keyframes dk-spin{to{transform:rotate(1turn)}}
.dk-dialog{border:1px solid var(--dk-line);border-radius:16px;background:var(--dk-bg);color:var(--dk-fg);padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow-y:auto;font:15px/1.5 system-ui,sans-serif}
.dk-dialog::backdrop{background:rgba(0,0,0,.45)}
.dk-sheet{padding:18px;display:flex;flex-direction:column;gap:16px}
.dk-sheet h3{margin:0;font-size:18px}
.dk-field{display:flex;flex-direction:column;gap:6px}
.dk-field>label,.dk-field>.dk-lbl{font-size:13px;font-weight:700}
.dk-field small{color:var(--dk-muted);font-size:12px;line-height:1.4}
.dk-field select,.dk-field textarea{font:inherit;color:inherit;border:1px solid var(--dk-line);background:var(--dk-field);border-radius:10px;padding:10px;min-height:44px;width:100%;box-sizing:border-box}
.dk-field textarea{font-size:14px;line-height:1.45;resize:vertical}
.dk-row{display:flex;gap:8px;flex-wrap:wrap}
.dk-btn{font:inherit;color:inherit;border:1px solid var(--dk-line);background:transparent;border-radius:10px;padding:8px 12px;min-height:40px;font-size:14px;cursor:pointer}
.dk-btn.dk-primary{background:var(--dk-accent);color:var(--dk-accent-fg);border-color:var(--dk-accent)}
.dk-btn.dk-danger{color:var(--dk-rec)}
.dk-foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dk-toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--dk-fg);color:var(--dk-bg);padding:10px 16px;border-radius:10px;font:14px system-ui,sans-serif;max-width:calc(100vw - 32px);z-index:2147483000}
@media (prefers-reduced-motion:reduce){.dk-mic,.dk-mic::after{animation:none!important}}`;
      document.head.append(st);
      document.documentElement.classList.add('dk-root');
      if (opts.darkMode === false) document.documentElement.classList.add('dk-light');
    }
    let toastEl = null, toastT = null;
    function toast(msg) {
      injectStyle();
      if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'dk-toast'; toastEl.setAttribute('role', 'status'); document.body.append(toastEl); }
      toastEl.textContent = msg; toastEl.hidden = false;
      clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 2800);
    }

    /* ---------- Bouton micro sur un champ texte ---------- */
    const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    const STOP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" style="fill:currentColor;stroke:none"/></svg>';
    let activeField = null;

    function attach(el, o) {
      o = o || {};
      if (!el || el.dataset.dkAttached) return null;
      injectStyle();
      el.dataset.dkAttached = '1';
      const wrap = document.createElement('span'); wrap.className = 'dk-wrap' + (el.tagName === 'INPUT' ? ' dk-line' : '');
      el.parentNode.insertBefore(wrap, el); wrap.append(el);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'dk-mic'; btn.innerHTML = MIC_SVG;
      btn.setAttribute('aria-label', 'Dicter dans ce champ'); btn.title = 'Dicter';
      wrap.append(btn);

      let handle = null, pos = 0, inflight = 0;
      const render = () => {
        const on = !!(handle && handle.active);
        btn.classList.toggle('dk-on', on);
        btn.classList.toggle('dk-work', !on && inflight > 0);
        btn.innerHTML = on ? STOP_SVG : MIC_SVG;
        btn.setAttribute('aria-label', on ? 'Arrêter la dictée' : 'Dicter dans ce champ');
      };
      const insert = (text) => {
        if (el.disabled || el.readOnly) return;
        const v = el.value;
        pos = Math.min(pos, v.length);
        const before = v.slice(0, pos), after = v.slice(pos);
        const sepL = before && !/\s$/.test(before) ? ' ' : '';
        const sepR = after && !/^[\s.,;:!?]/.test(after) ? ' ' : '';
        el.value = before + sepL + text + sepR + after;
        pos += sepL.length + text.length;
        try { if (document.activeElement === el) el.setSelectionRange(pos, pos); } catch (_) {}
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        o.onText && o.onText(text);
      };
      const stop = async () => { if (handle) { const h = handle; await h.stop(); } };
      btn.addEventListener('click', async () => {
        if (handle && handle.active) { await stop(); return; }
        if (activeField && activeField !== api) await activeField.stop();
        pos = (typeof el.selectionEnd === 'number' && document.activeElement === el) ? el.selectionEnd : el.value.length;
        handle = await startMic({
          lexicon: typeof o.lexicon === 'function' ? o.lexicon() : o.lexicon,
          previous: () => el.value.slice(Math.max(0, pos - 300), pos),
          onText: (text) => { insert(text); render(); },
          onStop: () => { activeField = activeField === api ? null : activeField; render(); },
          onIdle: () => { inflight = 0; render(); },
        });
        if (handle) activeField = api;
        render();
      });
      // Suivre les passages en attente pour l'indicateur
      const off = on('status', (s) => { if (handle && !handle.active) { inflight = s.busy; render(); } });
      const api = {
        el, button: btn, stop,
        detach() { stop(); off(); wrap.parentNode.insertBefore(el, wrap); wrap.remove(); delete el.dataset.dkAttached; },
      };
      return api;
    }

    /* ---------- Réglages (boîte de dialogue partagée) ---------- */
    let dlg = null;
    function openSettings(o) {
      o = o || {};
      injectStyle();
      if (!dlg) {
        dlg = document.createElement('dialog'); dlg.className = 'dk-dialog';
        dlg.innerHTML = `
<form class="dk-sheet" method="dialog">
  <h3>Réglages de la dictée</h3>
  <div class="dk-field"><label for="dkModel">Modèle Whisper</label><select id="dkModel"></select>
    <small>Téléchargé une seule fois, puis gardé sur l'appareil. « Très précis » est le meilleur pour le vocabulaire médical, mais il lui faut un GPU ; sur processeur seul, il est très lent.</small></div>
  <div class="dk-field"><label for="dkLang">Langue parlée</label><select id="dkLang">
    <option value="fr">Français</option><option value="en">Anglais</option><option value="es">Espagnol</option><option value="de">Allemand</option><option value="it">Italien</option></select></div>
  <div class="dk-field"><label for="dkDevice">Calcul</label><select id="dkDevice">
    <option value="auto">Automatique (GPU si disponible)</option><option value="webgpu">GPU (WebGPU)</option><option value="wasm">Processeur</option></select>
    <small id="dkDevInfo">—</small></div>
  <div class="dk-field"><label for="dkLex">Vocabulaire à reconnaître</label><textarea id="dkLex" rows="6"></textarea>
    <small><span id="dkLexCount"></span> Le modèle lit ce texte avant chaque passage et privilégie ces orthographes. Termes séparés par des virgules, avec une phrase de contexte au début. Seuls les ~190 premiers jetons sont utilisés (vocabulaire du champ compris).</small>
    <div class="dk-row"><button class="dk-btn" type="button" id="dkLexReset">Rétablir le vocabulaire podologique</button></div></div>
  <div class="dk-field"><label for="dkCorr">Corrections automatiques</label>
    <textarea id="dkCorr" rows="5" placeholder="hallux val gus = hallux valgus&#10;ony cryptose = onychocryptose"></textarea>
    <small>Une règle par ligne, « entendu = écrit ». Appliquées à chaque nouveau passage, sans tenir compte des majuscules.</small></div>
  <div class="dk-field"><span class="dk-lbl">Partager avec l'autre application</span>
    <div class="dk-row">
      <button class="dk-btn" type="button" id="dkExport">Exporter vocabulaire et corrections</button>
      <button class="dk-btn" type="button" id="dkImport">Importer…</button>
      <input type="file" id="dkImportFile" accept="application/json,.json" hidden>
    </div>
    <small>L'import ajoute les corrections manquantes et remplace le vocabulaire.</small></div>
  <div id="dkExtra"></div>
  <div class="dk-foot"><button class="dk-btn dk-danger" type="button" id="dkClear">Effacer les modèles téléchargés</button>
    <button class="dk-btn dk-primary" value="ok">Fermer</button></div>
</form>`;
        document.body.append(dlg);
        const $ = (id) => dlg.querySelector('#' + id);
        Object.entries(MODELS).forEach(([k, m]) => { const op = document.createElement('option'); op.value = k; op.textContent = `${m.label} · ${m.size}`; $('dkModel').append(op); });
        const guard = (sel, key) => $(sel).addEventListener('change', (e) => {
          if (busy || mic) { notify('Attendez la fin de la transcription.'); e.target.value = settings[key]; return; }
          settings[key] = e.target.value; saveSettings(); resetModel(); emit('settings', settings);
        });
        guard('dkModel', 'model'); guard('dkDevice', 'device');
        $('dkLang').addEventListener('change', (e) => { settings.lang = e.target.value; saveSettings(); emit('settings', settings); });
        let lexT = null;
        const updCount = async () => {
          const n = await countTokens(settings.lexicon);
          $('dkLexCount').textContent = n < 0 ? `${settings.lexicon.length} caractères.` : (n > 190 ? `${n} jetons : la fin sera ignorée.` : `${n} / 190 jetons.`);
        };
        dlg._updCount = updCount;
        $('dkLex').addEventListener('input', (e) => { settings.lexicon = e.target.value; saveSettings(); clearTimeout(lexT); lexT = setTimeout(updCount, 400); });
        $('dkLexReset').addEventListener('click', () => { settings.lexicon = DEFAULT_LEXICON; $('dkLex').value = DEFAULT_LEXICON; saveSettings(); updCount(); });
        $('dkCorr').addEventListener('input', (e) => { settings.corrections = e.target.value; corrections = parseCorrections(e.target.value); saveSettings(); });
        $('dkExport').addEventListener('click', () => {
          const d = new Date().toISOString().slice(0, 10);
          const r = saveFile(`dictee-vocabulaire_${d}.json`, exportConfig());
          if (typeof r === 'string') notify(r);
        });
        $('dkImport').addEventListener('click', () => $('dkImportFile').click());
        $('dkImportFile').addEventListener('change', async (e) => {
          const f = e.target.files[0]; e.target.value = ''; if (!f) return;
          try { importConfig(await f.text(), 'merge'); $('dkLex').value = settings.lexicon; $('dkCorr').value = settings.corrections; updCount(); notify('Vocabulaire et corrections importés'); }
          catch (err) { notify(err.message); }
        });
        let armed = false;
        $('dkClear').addEventListener('click', async () => {
          const b = $('dkClear');
          if (!armed) { armed = true; b.textContent = 'Confirmer'; setTimeout(() => { armed = false; b.textContent = 'Effacer les modèles téléchargés'; }, 3000); return; }
          armed = false; b.textContent = 'Effacer les modèles téléchargés';
          try { await clearModels(); notify('Modèles effacés'); } catch (err) { notify(err.message); }
        });
      }
      const $ = (id) => dlg.querySelector('#' + id);
      $('dkModel').value = settings.model; $('dkLang').value = settings.lang; $('dkDevice').value = settings.device;
      $('dkLex').value = settings.lexicon; $('dkCorr').value = settings.corrections;
      const extra = $('dkExtra'); extra.replaceChildren(); if (o.extra) extra.append(o.extra);
      dlg._updCount();
      hasWebGPU().then((gpu) => {
        $('dkDevInfo').textContent = (gpu ? 'WebGPU disponible sur cet appareil.' : 'WebGPU indisponible : le calcul se fera sur le processeur, plus lentement.') +
          (engine.device ? ` En cours : ${engine.device === 'webgpu' ? 'GPU' : `processeur, ${engine.threads} cœur${engine.threads > 1 ? 's' : ''}`}.` : '') +
          (engine.lastMs ? ` Dernier passage : ${(engine.lastMs / 1000).toFixed(1)} s de calcul pour ${engine.lastSec.toFixed(1)} s de parole.` : '');
      });
      dlg.showModal();
    }

    if (crashNotice) setTimeout(() => notify(crashNotice), 800);
    if (opts.preload !== false && isCached() && !crashNotice) loadModel();

    return {
      MODELS, DEFAULT_LEXICON, settings, saveSettings, status, on, notify,
      loadModel, resetModel, clearModels, countTokens,
      startMic, stopMic, transcribeFile, attach, openSettings,
      exportConfig, importConfig, applyCorrections,
      get recording() { return !!mic; },
    };
  }

  global.Dictee = { create, version: '1.0' };
})(window);
