// Moteur Whisper exécuté hors du fil principal. Tout reste sur l'appareil.
// Paramètre ?lib=<url> : bibliothèque et moteur WebAssembly servis localement (APK, appli Mac hors ligne).
// Sans paramètre : bibliothèque chargée depuis le CDN.
const LIBBASE = new URL(self.location.href).searchParams.get('lib');
const LIB = LIBBASE
  ? new URL('transformers.min.js', LIBBASE).href
  : 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

const MAX_TOTAL = 448;   // longueur max du décodeur Whisper
const MAX_LEX = 150;     // jetons réservés au lexique
const MAX_PREV = 60;     // jetons du texte précédent (continuité)

let T = null, tok = null, proc = null, model = null, ids = null, loadedKey = null;

async function lib() {
  if (T) return T;
  T = await import(LIB);
  T.env.allowLocalModels = false;
  T.env.useBrowserCache = true; // modèle gardé en cache après le 1er téléchargement
  if (LIBBASE) T.env.backends.onnx.wasm.wasmPaths = LIBBASE;
  return T;
}

async function gpuHasF16() {
  try { const a = await navigator.gpu.requestAdapter(); return !!(a && a.features.has('shader-f16')); } catch (_) { return false; }
}

async function load(modelId, device, big) {
  const key = modelId + '|' + device;
  if (model && loadedKey === key) return;
  if (model && model.dispose) { try { await model.dispose(); } catch (_) {} }
  model = null; loadedKey = null;
  await lib();
  let dtype;
  if (device === 'webgpu') {
    const f16 = await gpuHasF16();
    if (big && !f16) throw new Error('GPU sans demi-précision, passage au processeur');
    dtype = { encoder_model: f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };
  } else {
    dtype = { encoder_model: 'q8', decoder_model_merged: 'q8' };
  }
  const progress_callback = (p) => postMessage({ type: 'progress', p });
  tok = await T.AutoTokenizer.from_pretrained(modelId, { progress_callback });
  proc = await T.AutoProcessor.from_pretrained(modelId, { progress_callback });
  model = await T.WhisperForConditionalGeneration.from_pretrained(modelId, { device, dtype, progress_callback });
  const id = (t) => tok.model.tokens_to_ids.get(t);
  ids = { prev: id('<|startofprev|>'), sot: id('<|startoftranscript|>'), transcribe: id('<|transcribe|>'), notime: id('<|notimestamps|>') };
  await transcribe(new Float32Array(16000), 'fr', '', ''); // pré-chauffe
  loadedKey = key;
}

function enc(text) {
  text = (text || '').replace(/\s+/g, ' ').trim();
  return text ? tok.encode(' ' + text, { add_special_tokens: false }) : [];
}

async function transcribe(audio, lang, lexicon, previous) {
  const { input_features } = await proc(audio);
  const langId = tok.model.tokens_to_ids.get(`<|${lang || 'fr'}|>`);
  const prefix = [ids.sot, langId, ids.transcribe, ids.notime].filter((x) => x != null);
  const lex = enc(lexicon).slice(0, MAX_LEX);
  const prev = enc(previous).slice(-MAX_PREV);
  const prompt = lex.length || prev.length ? [ids.prev, ...lex, ...prev] : [];
  const input = [...prompt, ...prefix];
  const out = await model.generate({
    inputs: input_features,
    decoder_input_ids: input,
    max_new_tokens: Math.max(32, MAX_TOTAL - input.length - 1),
  });
  const seq = out.tolist()[0].map(Number).slice(input.length);
  return tok.decode(seq, { skip_special_tokens: true });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load(m.model, m.device, m.big);
      postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const text = await transcribe(m.audio, m.lang, m.lexicon, m.previous);
      postMessage({ type: 'result', id: m.id, text });
    } else if (m.type === 'count') {
      postMessage({ type: 'count', id: m.id, n: tok ? enc(m.text).length : -1 });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
