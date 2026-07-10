// OCR offline de las pantallas de post-partido de eFootball (stats y
// valoraciones), sin OpenAI. Usa Tesseract.js VENDORIZADO en local (public/vendor/tesseract),
// para funcionar 100% offline. El preprocesado (recorte por
// proporción + umbral) se hace con canvas → texto negro sobre blanco limpio,
// que es lo que mejor lee Tesseract sobre el fondo chillón del juego.
//
// Devuelve datos "en crudo" (left/right, nombres OCR) que el editor orienta y
// casa con la plantilla. Todo es "mejor esfuerzo": el resultado es editable.

let tesseractPromise = null;
function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractPromise) {
        tesseractPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'vendor/tesseract/tesseract.min.js'; // vendorizado (offline)
            s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract no disponible'));
            s.onerror = () => reject(new Error('No se pudo cargar Tesseract.js'));
            document.head.appendChild(s);
        });
    }
    return tesseractPromise;
}

function fileToImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo leer la imagen'));
        img.src = URL.createObjectURL(file);
    });
}

// Recorta una región proporcional [x0,y0,x1,y1] (0..1) y umbraliza a blanco/negro.
// El texto de eFootball es brillante sobre fondo oscuro → texto negro, fondo blanco.
function preprocess(img, [x0, y0, x1, y1], { scale = 2, threshold = 140 } = {}) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const sx = Math.max(0, x0 * W), sy = Math.max(0, y0 * H);
    const sw = (x1 - x0) * W, sh = (y1 - y0) * H;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = lum > threshold ? 0 : 255; // brillante(texto)→negro
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

async function ocr(worker, canvas, whitelist) {
    await worker.setParameters({ tessedit_char_whitelist: whitelist || '' });
    const { data } = await worker.recognize(canvas);
    return data.text || '';
}

// Regiones proporcionales calibradas sobre capturas 16:9 de eFootball.
const REGION = {
    headerLeft: [0.19, 0.15, 0.45, 0.24],
    headerRight: [0.55, 0.15, 0.82, 0.24],
    scoreLeft: [0.435, 0.16, 0.482, 0.235],
    scoreRight: [0.518, 0.16, 0.565, 0.235],
    statsTable: [0.305, 0.263, 0.699, 0.770],
    ratingsLeft: [0.290, 0.334, 0.610, 0.802],
    ratingsRight: [0.640, 0.334, 0.960, 0.802],
};

const DIGITS = '0123456789';

// ── Stats: marcador (2 cajas) + tabla (etiqueta como ancla) ──────────────
const STAT_LABELS = [ // orden: la más específica primero
    [/tiros?\s*a\s*puerta/i, 'shots_on_target'],
    [/tiros?\s*libres/i, 'free_kicks'],
    [/tiros/i, 'shots'],
    [/posesi/i, 'possession'],
    [/faltas/i, 'fouls'],
    [/fueras|juego/i, 'offsides'],
    [/c[oó0]rn/i, 'corners'],
    [/pases?\s*completad/i, 'passes_completed'],
    [/pases?\s*intercept/i, 'interceptions'],
    [/pases/i, 'passes'],
    [/centros/i, 'crosses'],
    [/entradas/i, 'tackles'],
    [/paradas/i, 'saves'],
];

function parseStatsTable(text) {
    const left = {}, right = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const nums = line.match(/\d+/g);
        if (!nums || nums.length < 2) continue;
        const found = STAT_LABELS.find(([re]) => re.test(line));
        if (!found) continue;
        const field = found[1];
        left[field] = Number(nums[0]);
        right[field] = Number(nums[nums.length - 1]);
    }
    return { left, right };
}

export async function recognizeStats(file) {
    const T = await loadTesseract();
    const worker = await T.createWorker('eng', 1, { workerPath: 'vendor/tesseract/worker.min.js', corePath: 'vendor/tesseract/', langPath: 'vendor/tesseract/lang' });
    try {
        const img = await fileToImage(file);
        const [scoreL, scoreR, headerL, headerR, table] = [
            await ocr(worker, preprocess(img, REGION.scoreLeft, { scale: 3 }), DIGITS),
            await ocr(worker, preprocess(img, REGION.scoreRight, { scale: 3 }), DIGITS),
            await ocr(worker, preprocess(img, REGION.headerLeft, { scale: 2 })),
            await ocr(worker, preprocess(img, REGION.headerRight, { scale: 2 })),
            await ocr(worker, preprocess(img, REGION.statsTable, { scale: 2 })),
        ];
        const toInt = (s) => { const m = (s || '').match(/\d+/); return m ? Number(m[0]) : null; };
        return {
            leftName: (headerL || '').replace(/\s+/g, ' ').trim(),
            rightName: (headerR || '').replace(/\s+/g, ' ').trim(),
            score: { left: toInt(scoreL), right: toInt(scoreR) },
            stats: parseStatsTable(table),
        };
    } finally {
        await worker.terminate();
    }
}

// ── Valoraciones: filas "nº Nombre nota" en dos columnas ─────────────────
function parseRatingValue(s) {
    s = (s || '').replace(',', '.');
    if (s.includes('.')) { const v = parseFloat(s); return isFinite(v) ? v : null; }
    if (s.length === 2) return Number(s[0]) + Number(s[1]) / 10; // 55 → 5.5
    if (s.length === 1) return Number(s);                        // 6 → 6.0
    return null;
}

function parseRatingRows(text) {
    const rows = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/[★*]|hk/gi, '').trim();
        // nº_camiseta  Nombre…  nota(6.0 | 65 | 6)
        const m = line.match(/^(\d{1,2})[.\s]+(.+?)\s+(\d[.,]\d|\d{2}|\d)\s*$/);
        if (!m) continue;
        const name = m[2].trim();
        const rating = parseRatingValue(m[3]);
        if (name.length >= 3 && rating != null && rating >= 1 && rating <= 10) {
            rows.push({ name, rating: Math.round(rating * 10) / 10 });
        }
    }
    return rows;
}

export async function recognizeRatings(file) {
    const T = await loadTesseract();
    const worker = await T.createWorker('eng', 1, { workerPath: 'vendor/tesseract/worker.min.js', corePath: 'vendor/tesseract/', langPath: 'vendor/tesseract/lang' });
    try {
        const img = await fileToImage(file);
        const leftText = await ocr(worker, preprocess(img, REGION.ratingsLeft, { scale: 2 }));
        const rightText = await ocr(worker, preprocess(img, REGION.ratingsRight, { scale: 2 }));
        return { rows: [...parseRatingRows(leftText), ...parseRatingRows(rightText)] };
    } finally {
        await worker.terminate();
    }
}
