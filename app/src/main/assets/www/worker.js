// Moteur Whisper exécuté hors du fil principal. Tout reste sur l'appareil.
// worker.js?local=1 (appli Android) : bibliothèque et moteur WebAssembly embarqués dans l'APK.
const LOCAL = new URL(self.location.href).searchParams.has('local');
const LIB = LOCAL
  ? new URL('lib/transformers.min.js', self.location.href).href
  : 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

let tf = null;
let asr = null;
let loadedKey = null;

async function lib() {
  if (tf) return tf;
  tf = await import(LIB);
  tf.env.allowLocalModels = false;
  tf.env.useBrowserCache = true; // modèle gardé en cache après le 1er téléchargement
  if (LOCAL) tf.env.backends.onnx.wasm.wasmPaths = new URL('lib/', self.location.href).href;
  return tf;
}

async function load(model, device) {
  const key = model + '|' + device;
  if (asr && loadedKey === key) return;
  if (asr && asr.dispose) { try { await asr.dispose(); } catch (_) {} }
  asr = null;
  const { pipeline } = await lib();
  const dtype = device === 'webgpu'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    : { encoder_model: 'q8', decoder_model_merged: 'q8' };
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => postMessage({ type: 'progress', p }),
  });
  // Pré-chauffe : compile les shaders / initialise les sessions
  await asr(new Float32Array(16000), { language: 'french', task: 'transcribe' });
  loadedKey = key;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load(m.model, m.device);
      postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const opts = { task: 'transcribe' };
      if (m.lang) opts.language = m.lang;
      const out = await asr(m.audio, opts);
      postMessage({ type: 'result', id: m.id, text: (out && out.text) || '' });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
