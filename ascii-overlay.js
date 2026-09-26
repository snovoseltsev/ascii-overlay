/*!
 * ASCII overlay — полноэкранный оверлей «живого кода» (Axion).
 *
 * Что делает: поверх всей страницы рисуется фиксированный canvas, на нём —
 * ASCII-глифы (70-уровневый рамп Бурка), чей рисунок берётся из люминанса
 * скрытого видео-клипа (золотая дюна mask.mp4). Часть строк — бегущие
 * телеметрия-тикеры. Поле рвётся шумом на острова (sparse), тёмные глифы
 * подсвечиваются белым (liftDark), у курсора работает линза-магнит:
 * выборка кадра стягивается к указателю. Ноль зависимостей, один файл.
 *
 * Подключение (видео лежат рядом со скриптом):
 *   <script src="ascii-overlay/ascii-overlay.js" defer></script>
 *
 * Настройки — объект window.ASCII_OVERLAY, объявленный ДО скрипта:
 *   <script>
 *     window.ASCII_OVERLAY = {
 *       zIndex: 9999,      // слой оверлея
 *       opacity: 1,        // прозрачность всего эффекта 0..1
 *       sparse: 0.65,      // 0 = сплошное поле, выше = более рваные острова
 *       dataShare: 0.5,    // доля строк-тикеров с телеметрией
 *       magnetism: true,   // линза у курсора
 *       video: null,       // свой путь к клипу (десктоп)
 *       videoMobile: null, // свой путь к клипу (мобилка, ≤768px)
 *       records: null,     // свои строки телеметрии (массив строк)
 *     };
 *   </script>
 *
 * API после загрузки: window.AsciiOverlay.destroy() — снять эффект.
 *
 * ВАЖНО: страница должна открываться по http(s), не через file:// —
 * иначе браузер считает canvas «испорченным» видео-кадром и эффект
 * молча не рисуется. Для локальной проверки: npx serve / python -m http.server.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- config --
  const userCfg = window.ASCII_OVERLAY || {};
  // База для путей видео — папка самого скрипта.
  const scriptEl = document.currentScript;
  const baseUrl = scriptEl
    ? scriptEl.src.slice(0, scriptEl.src.lastIndexOf("/") + 1)
    : "";
  const cfg = {
    zIndex: userCfg.zIndex ?? 9999,
    opacity: userCfg.opacity ?? 1,
    sparse: userCfg.sparse ?? 0.65,
    dataShare: userCfg.dataShare ?? 0.5,
    magnetism: userCfg.magnetism !== false,
    mobileMaxWidth: userCfg.mobileMaxWidth ?? 768,
    video: userCfg.video || baseUrl + "mask.mp4",
    videoMobile: userCfg.videoMobile || baseUrl + "mask-m.mp4",
    records: userCfg.records || null,
  };

  // ------------------------------------------------------ device detection --
  const isTouchDevice = () =>
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const prefersReducedMotion = () =>
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Уважение к reduced-motion: эффект не монтируется вовсе.
  if (prefersReducedMotion()) {
    window.AsciiOverlay = { destroy() {} };
    return;
  }

  // ----------------------------------------------------------- field noise --
  // Детерминированный хэш 0..1 — imul-микс + лавинный финиш (без него младшие
  // биты дают периодические полосы вместо шума).
  function h01(a, b, c) {
    let x =
      Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2246822519);
    x = Math.imul(x ^ (x >>> 15), 2654435761);
    x ^= x >>> 13;
    return ((x >>> 0) & 0xfffff) / 0x100000;
  }

  // Гладкий 3D value-noise на решётке h01 (трилинейный, smoothstep). Время
  // едет по оси z — поле эволюционирует НА МЕСТЕ, а не скользит вбок.
  function vnoise(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const slice = (zz) => {
      const a = h01(xi, yi, zz);
      const b = h01(xi + 1, yi, zz);
      const c = h01(xi, yi + 1, zz);
      const d = h01(xi + 1, yi + 1, zz);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const n0 = slice(zi);
    return n0 + (slice(zi + 1) - n0) * w;
  }

  // -------------------------------------------------------------- constants --
  // Рамп Бурка, от плотного к светлому; развёрнут: индекс 0 = пусто
  // (тёмный пиксель → нет глифа), последний = самый плотный глиф.
  const RAMP_DENSE_FIRST =
    "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ";
  const RAMP = [...RAMP_DENSE_FIRST].reverse().join("");

  const FONT_PX = 9; // высота ячейки в CSS px (меньше = мельче глифы)
  const FONT_STACK = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace`;
  const GAMMA = 1.25; // >1 углубляет полутона — сетка не сплошная
  const TARGET_FPS = 24;
  const MAG_RADIUS_PX = 300; // радиус линзы-магнита, CSS px
  const MAG_LENS = 1.8; // сила линзы (насколько дальше сэмплится выборка)
  const DPR_CAP = 2; // потолок devicePixelRatio — резко на HiDPI без 3× буферов
  const LENS_FADE_S = 0.5; // растворение линзы после touchend

  // Контрастная пара: клип тёмный (p50≈0.03), кривая режет высоко — глифы
  // живут золотыми островами только на ярких гребнях дюны.
  const WIN_BLACK_POINT = userCfg.blackPoint ?? 0.45;
  const WIN_WHITE_POINT = userCfg.whitePoint ?? 0.85;
  const DATA_CRAWL = 3; // скорость тикера, ячеек/сек
  // Подсветка тёмного: ячейки ярче LIFT_REF держат чистую заливку клипом
  // (золото), тусклее — подмешивают белый по (1 − b/ref).
  const LIFT_REF = 0.35;
  // Сэмпл кадра (GPU→CPU-ридбэк) дорогой — буфер люминанса обновляется
  // редко: дюна дрейфует медленно, рисунок на ~5.5 Гц неотличим от 24.
  const LUM_REFRESH_S = 0.18;
  // Пересчёт sparse-маски — раз в этот интервал, не на кадр.
  const FIELD_REFRESH_S = 0.4;

  // Телеметрия цифрового двойника — строки, сквозь которые ползут тикеры.
  const TWIN_RECORDS = cfg.records || [
    '"twin_id":"TWN-RD-00231" "asset":"Al Wasl Road, Segment 14" "district":"Al Wasl, Dubai" "status":"degraded" "condition_score":42 "last_inspection":"2025-11-02" "sensor_temp_c":38.6 "history_points":214',
    '"twin_id":"TWN-BLD-01187" "asset":"Burj Vista Tower 1" "district":"Downtown Dubai" "status":"nominal" "condition_score":88 "sensor_temp_c":39.1 "detections":18 "history_points":412',
    '"twin_id":"TWN-RD-00232" "asset":"Sheikh Zayed Road, Segment 03" "district":"Trade Centre, Dubai" "status":"nominal" "condition_score":87 "last_inspection":"2025-12-18" "sensor_temp_c":41.2 "history_points":508',
    '"twin_id":"TWN-BLD-02034" "asset":"Marina Gate 2" "district":"Dubai Marina" "status":"watch" "condition_score":64 "sensor_temp_c":41.8 "detections":7 "history_points":167',
    '"twin_id":"TWN-BR-00107" "asset":"Business Bay Crossing, Deck B" "district":"Business Bay, Dubai" "status":"watch" "condition_score":63 "last_inspection":"2025-10-27" "sensor_temp_c":36.9 "history_points":132',
    '"twin_id":"TWN-RD-00544" "asset":"King Fahd Road, Exit 9" "district":"Al Olaya, Riyadh" "status":"nominal" "condition_score":90 "sensor_temp_c":43.2 "detections":3 "history_points":301',
    '"twin_id":"TWN-BLD-00892" "asset":"Kingdom Centre Podium" "district":"Al Olaya, Riyadh" "status":"watch" "condition_score":58 "last_inspection":"2025-12-04" "sensor_temp_c":42.5 "history_points":129',
    '"twin_id":"TWN-RD-00318" "asset":"Jumeirah Beach Road, Segment 22" "district":"Jumeirah 1, Dubai" "status":"nominal" "condition_score":91 "last_inspection":"2026-01-09" "sensor_temp_c":39.4 "history_points":347',
    '"twin_id":"TWN-BLD-01566" "asset":"Al Faisaliah Tower Skybridge" "district":"Al Olaya, Riyadh" "status":"degraded" "condition_score":47 "sensor_temp_c":44.0 "detections":21 "history_points":98',
    '"twin_id":"TWN-BLD-03412" "asset":"Gate Avenue Facade" "district":"DIFC, Dubai" "status":"nominal" "condition_score":86 "sensor_temp_c":37.4 "detections":5 "history_points":268',
    '"twin_id":"TWN-BLD-02901" "asset":"KAFD Conference Centre" "district":"KAFD, Riyadh" "status":"watch" "condition_score":66 "last_inspection":"2025-10-18" "sensor_temp_c":40.7 "history_points":183',
    '"twin_id":"TWN-PK-00095" "asset":"Zabeel Park Bridge" "district":"Zabeel, Dubai" "status":"nominal" "condition_score":84 "sensor_temp_c":38.2 "detections":2 "history_points":152',
    '"twin_id":"TWN-RD-00871" "asset":"Al Khail Road, Segment 31" "district":"Al Quoz, Dubai" "status":"degraded" "condition_score":39 "last_inspection":"2025-09-14" "sensor_temp_c":42.9 "history_points":226',
    '"twin_id":"TWN-BLD-04120" "asset":"Diriyah Gate Wall, Sector 2" "district":"Diriyah, Riyadh" "status":"watch" "condition_score":61 "sensor_temp_c":43.8 "detections":11 "history_points":74',
  ];
  const DATA_TEXT = TWIN_RECORDS.join("  ") + "  ";
  // Алфавит телеметрии без дублей — в атласе он идёт СЛЕДОМ за рампом:
  // индекс data-ячейки = RAMP.length + CHAR_INDEX[ch]; пробел остаётся
  // прозрачной ячейкой, так что разделители читаются дырками бесплатно.
  const CHARS = [...new Set(DATA_TEXT)].join("");
  const CHAR_INDEX = {};
  for (let i = 0; i < CHARS.length; i++) CHAR_INDEX[CHARS[i]] = i;

  const dataShare = cfg.dataShare;
  const sparseGate = Math.min(Math.max(cfg.sparse, 0), 1);

  // ---------------------------------------------------------- hidden video --
  // Паттерн «скрытый клип»: 1px, opacity 0 — НЕ display:none (это убивает
  // декодер iOS). Автоплей-политика WebKit у программно созданных видео
  // смотрит на АТРИБУТЫ, свойств недостаточно — без них iOS поднимает клип
  // нативным фулскрин-слоем поверх страницы.
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.loop = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous"; // видео с CDN: нужен CORS, иначе canvas «портится»
  video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    zIndex: "-1000",
    pointerEvents: "none",
  });
  // Мобильный энкод (640×360): клип — только источник люминанса, полный
  // 1080p-декод на телефоне греет декодер впустую.
  video.src = matchMedia(`(max-width: ${cfg.mobileMaxWidth}px)`).matches
    ? cfg.videoMobile
    : cfg.video;
  document.body.appendChild(video);
  const kick = () => {
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };
  kick();
  // iOS блокирует автоплей без жеста — клип будят ВСЕ ранние жесты и
  // возврат вкладки (один once-touchstart тратился на жест до готовности).
  const kicks = ["touchstart", "pointerdown", "click"];
  for (const ev of kicks) window.addEventListener(ev, kick, { passive: true });
  document.addEventListener("visibilitychange", kick);

  const getFrame = () =>
    video.readyState >= 2 && video.videoWidth
      ? { el: video, w: video.videoWidth, h: video.videoHeight }
      : null;

  // ------------------------------------------------------------- mount/DOM --
  const mount = document.createElement("div");
  mount.setAttribute("aria-hidden", "true");
  Object.assign(mount.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "100%",
    // Стабильная ПОЛНАЯ высота вьюпорта: живой innerHeight дышит с
    // URL-баром iOS, поле должно покрывать экран в обоих состояниях.
    height: "100vh",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: String(cfg.zIndex),
  });
  mount.style.height = "100lvh"; // где поддержан — перекрывает vh-фолбэк
  document.body.appendChild(mount);

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
  });
  mount.appendChild(canvas);

  const mctx = canvas.getContext("2d");
  // Оффскрин-слой композиции глифов (альфа-маска → заливка кадром source-in).
  const glyphs = document.createElement("canvas");
  const gctx = glyphs.getContext("2d");
  // Второй слой для ТУСКЛЫХ ячеек — всегда белый, кладётся поверх залитого.
  const darkG = document.createElement("canvas");
  const dgctx = darkG.getContext("2d");
  // Крохотный оффскрин — даунсэмпл клипа до пикселя на ячейку.
  const sample = document.createElement("canvas");
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  if (!mctx || !gctx || !sctx || !dgctx) {
    mount.remove();
    video.remove();
    window.AsciiOverlay = { destroy() {} };
    return;
  }

  // ---------------------------------------------------------------- state --
  let dpr = 1;
  let cellW = 0;
  let cellH = 0;
  let cols = 0;
  let rows = 0;
  let atlas = null;
  // Сетка «ячейка оставлена в этом кадре» — решения прохода 2.
  let keep = new Uint8Array(0);
  // Маска sparse-гейта — кэш (2 vnoise на ячейку каждый кадр было дорого).
  let shatter = new Uint8Array(0);
  let lastFieldT = -Infinity;
  // Кэш люминанса кадра (главный кост — GPU→CPU-ридбэк).
  let lumCache = null;
  // Общий буфер кадра под заливку: у <video>-источника WebKit игнорирует
  // globalCompositeOperation — кадр сперва копируется в canvas, льётся уже он.
  let pourShared = null;
  let pourCache = null;

  // Линза-магнит: курсор в device px (-1 = ещё не видели → нет притяжения).
  // Мышиная линза стоит на месте; пальцевая растворяется на touchend.
  let curX = -1;
  let curY = -1;
  const lensState = { mul: 0 };
  let lensTween = null; // {from,to,t0,dur} — ручной твин вместо GSAP
  const tweenLensTo = (to, durS) => {
    lensTween = { from: lensState.mul, to, t0: performance.now(), dur: durS * 1000 };
  };
  const magnetism = cfg.magnetism;
  const listeners = []; // [target, type, fn, opts] — для destroy()
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };
  if (magnetism) {
    if (isTouchDevice()) {
      on(
        window,
        "touchstart",
        (e) => {
          const t = e.touches[0];
          if (!t) return;
          curX = t.clientX * dpr;
          curY = t.clientY * dpr;
          lensTween = null;
          lensState.mul = 1;
        },
        { passive: true }
      );
      // touchmove НЕ подписан: палец почти всегда ведёт скролл, и линза
      // таскалась за ним — поле «плыло» на каждом свайпе.
      on(window, "touchend", () => tweenLensTo(0, LENS_FADE_S), { passive: true });
    } else {
      on(window, "pointermove", (e) => {
        curX = e.clientX * dpr;
        curY = e.clientY * dpr;
        lensState.mul = 1;
      });
    }
  }

  function buildAtlas() {
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    cellH = Math.max(1, Math.round(FONT_PX * dpr));
    mctx.font = `${FONT_PX * dpr}px ${FONT_STACK}`;
    cellW = Math.max(1, Math.round(mctx.measureText("M").width));

    const a = atlas || document.createElement("canvas");
    a.width = cellW * (RAMP.length + CHARS.length);
    a.height = cellH;
    const actx = a.getContext("2d");
    actx.clearRect(0, 0, a.width, a.height);
    actx.font = `${FONT_PX * dpr}px ${FONT_STACK}`;
    actx.textAlign = "center";
    actx.textBaseline = "middle";
    actx.fillStyle = "#fff"; // непрозрачный белый = альфа-маска под заливку
    for (let i = 1; i < RAMP.length; i++) {
      actx.fillText(RAMP[i], i * cellW + cellW / 2, cellH / 2);
    }
    for (let i = 0; i < CHARS.length; i++) {
      actx.fillText(CHARS[i], (RAMP.length + i) * cellW + cellW / 2, cellH / 2);
    }
    atlas = a;
  }

  function resize() {
    const nd = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const r = canvas.getBoundingClientRect();
    const cssW = r.width > 1 ? r.width : window.innerWidth;
    const cssH = r.height > 1 ? r.height : window.innerHeight;
    const w = Math.max(1, Math.round(cssW * nd));
    const h = Math.max(1, Math.round(cssH * nd));
    // Гвард одинаковых размеров — iOS шлёт resize на каждое дыхание URL-бара.
    if (w === canvas.width && h === canvas.height && atlas && nd === dpr) return;
    buildAtlas();
    canvas.width = w;
    canvas.height = h;
    glyphs.width = w;
    glyphs.height = h;
    darkG.width = w;
    darkG.height = h;
    cols = Math.ceil(w / cellW);
    rows = Math.ceil(h / cellH);
    sample.width = cols;
    sample.height = rows;
    keep = new Uint8Array(cols * rows);
    if (sparseGate > 0) shatter = new Uint8Array(cols * rows);
    lastFieldT = -Infinity;
  }
  resize();
  on(window, "resize", resize);

  // ------------------------------------------------------------ draw loop --
  const frameMs = 1000 / TARGET_FPS;
  let lastT = 0;

  const draw = () => {
    const nowMs = performance.now();
    // Ручной твин линзы (power2.out) — до троттла, чтобы растворение
    // не квантовалось грубее нужного.
    if (lensTween) {
      const p = Math.min(1, (nowMs - lensTween.t0) / lensTween.dur);
      const e = 1 - Math.pow(1 - p, 3);
      lensState.mul = lensTween.from + (lensTween.to - lensTween.from) * e;
      if (p >= 1) lensTween = null;
    }
    if (nowMs - lastT < frameMs) return;
    lastT = nowMs;

    mctx.clearRect(0, 0, canvas.width, canvas.height);
    const frame = getFrame();
    if (!atlas || !frame) return;

    // Единственная «карта» — весь канвас (в движке Axion тут пул окон).
    const cardX = 0;
    const cardY = 0;
    const cardW = canvas.width;
    const cardH = canvas.height;
    const cardOp = Math.min(Math.max(cfg.opacity, 0), 1);
    if (cardOp <= 0.01) return;

    // 1) Один сэмпл люминанса на ячейку сетки (кроп object-fit: cover).
    const vw = frame.w;
    const vh = frame.h;
    const scale = Math.max(canvas.width / vw, canvas.height / vh);
    const srcW = canvas.width / scale;
    const srcH = canvas.height / scale;
    const srcX = (vw - srcW) / 2;
    const srcY = (vh - srcH) / 2;
    let lum = null;
    const c = lumCache;
    if (
      c &&
      c.el === frame.el &&
      c.cols === cols &&
      c.rows === rows &&
      nowMs - c.t < LUM_REFRESH_S * 1000
    ) {
      lum = c.data;
    } else {
      sctx.drawImage(frame.el, srcX, srcY, srcW, srcH, 0, 0, cols, rows);
      try {
        lum = sctx.getImageData(0, 0, cols, rows).data;
      } catch {
        // file:// или видео без CORS — canvas «испорчен», рисовать нечем.
        return;
      }
      lumCache = { el: frame.el, cols, rows, t: nowMs, data: lum };
    }

    // 2) Альфа-маска глифов для ячеек, прошедших sparse-гейт.
    const winBlack = WIN_BLACK_POINT;
    const winWhite = Math.max(WIN_WHITE_POINT, winBlack + 0.01);
    const tSec = nowMs / 1000;
    const crawlOff = Math.floor(tSec * DATA_CRAWL);
    const textLen = DATA_TEXT.length;
    // Sparse-маска: шум ГРУБЕЕ и медленнее рампа (фича ≈ 11 строк) — большие
    // выжившие острова с настоящими пустотами, эволюционируют на месте.
    if (sparseGate > 0 && nowMs - lastFieldT >= FIELD_REFRESH_S * 1000) {
      lastFieldT = nowMs;
      const SPARSE_SCALE = 11;
      const zs = (tSec * 0.06) % 1024;
      const sxScale = cellW / (SPARSE_SCALE * cellH);
      const syScale = 1 / SPARSE_SCALE;
      for (let r = 0; r < rows; r++) {
        const row = r * cols;
        const ny = r * syScale;
        for (let cc = 0; cc < cols; cc++) {
          const n =
            0.65 * vnoise(cc * sxScale, ny, zs) +
            0.35 * vnoise(cc * sxScale * 2.3 + 31, ny * 2.3 + 17, zs * 1.4 + 5);
          shatter[row + cc] = n < sparseGate ? 0 : 1;
        }
      }
    }
    const last = RAMP.length - 1;
    // Линза считается раз на кадр; растворение тача — множитель силы.
    const magOn = magnetism && curX >= 0 && lensState.mul > 0.01;
    const radius = MAG_RADIUS_PX * dpr;
    const radius2 = radius * radius;
    const lensK = MAG_LENS * lensState.mul;
    const curCX = curX;
    const curCY = curY;
    gctx.globalCompositeOperation = "source-over";
    gctx.clearRect(0, 0, glyphs.width, glyphs.height);
    dgctx.globalCompositeOperation = "source-over";
    dgctx.clearRect(0, 0, darkG.width, darkG.height);
    keep.fill(0);

    const c0 = 0;
    const c1 = Math.min(cols - 1, Math.floor((cardX + cardW - 1) / cellW));
    const r0 = 0;
    const r1 = Math.min(rows - 1, Math.floor((cardY + cardH - 1) / cellH));
    for (let r = r0; r <= r1; r++) {
      const isData = h01(r, 0, 777) < dataShare;
      const dataDir = h01(r, 5, 55) < 0.5 ? 1 : -1;
      for (let cc = c0; cc <= c1; cc++) {
        const ki = r * cols + cc;
        // Sparse-гейт: ячейка гибнет там, где грубый шум под порогом — поле
        // рвётся на рваные острова вместо сплошной заливки.
        if (sparseGate > 0 && !shatter[ki]) continue;
        // Линза: внутри радиуса сэмплим ДАЛЬШЕ от курсора (k>1, с изингом) —
        // окружение стягивается внутрь, код сжимается к курсору как гравитация.
        // Глиф рисуется в СВОЕЙ ячейке — покрытие не редеет.
        let sc = cc;
        let sr = r;
        if (magOn) {
          const vx = cc * cellW + cellW * 0.5 - curCX;
          const vy = r * cellH + cellH * 0.5 - curCY;
          const d2 = vx * vx + vy * vy;
          if (d2 < radius2) {
            const f = 1 - Math.sqrt(d2) / radius;
            const k = 1 + f * f * lensK;
            sc = ((curCX + vx * k) / cellW) | 0;
            sr = ((curCY + vy * k) / cellH) | 0;
            if (sc < 0) sc = 0;
            else if (sc >= cols) sc = cols - 1;
            if (sr < 0) sr = 0;
            else if (sr >= rows) sr = rows - 1;
          }
        }
        // Выбор глифа по люминансу клипа сквозь контрастную кривую;
        // data-строки подставляют ползущий фрагмент записи.
        const p = (sr * cols + sc) * 4;
        const l = (0.299 * lum[p] + 0.587 * lum[p + 1] + 0.114 * lum[p + 2]) / 255;
        let b = (l - winBlack) / (winWhite - winBlack);
        keep[ki] = 1;
        if (b <= 0) continue;
        if (b > 1) b = 1;
        let idx;
        if (isData) {
          const pos = Math.imul(r, 31) + cc + dataDir * crawlOff;
          const ch = DATA_TEXT[((pos % textLen) + textLen) % textLen];
          if (ch === " ") continue;
          idx = RAMP.length + CHAR_INDEX[ch];
        } else {
          idx = Math.round(Math.pow(b, GAMMA) * last);
          if (idx <= 0) continue;
        }
        gctx.drawImage(atlas, idx * cellW, 0, cellW, cellH, cc * cellW, r * cellH, cellW, cellH);
        // liftDark: тот же глиф в белый слой с альфой (1 − b/ref) — тусклые
        // ячейки получают сильную белую подсветку, яркие — никакой.
        const wa = b >= LIFT_REF ? 0 : 1 - b / LIFT_REF;
        if (wa > 0.01) {
          dgctx.globalAlpha = wa;
          dgctx.drawImage(atlas, idx * cellW, 0, cellW, cellH, cc * cellW, r * cellH, cellW, cellH);
          dgctx.globalAlpha = 1;
        }
      }
    }

    // Заливка живого кадра В ФОРМЫ глифов (только где маска непрозрачна).
    // Кадр сперва в общий буфер БЕЗ композита (WebKit игнорирует композит у
    // <video>-источника), в глифы льётся уже canvas — source-in работает везде.
    const ft = frame.el.currentTime ?? 0;
    const pc = pourCache;
    if (
      !pourShared ||
      !pc ||
      pc.el !== frame.el ||
      pc.w !== glyphs.width ||
      pc.h !== glyphs.height ||
      pc.t !== ft
    ) {
      const pcv = pourShared || document.createElement("canvas");
      if (pcv.width !== glyphs.width || pcv.height !== glyphs.height) {
        pcv.width = glyphs.width;
        pcv.height = glyphs.height;
      }
      const pctx = pcv.getContext("2d");
      pctx.globalCompositeOperation = "copy";
      pctx.drawImage(frame.el, srcX, srcY, srcW, srcH, 0, 0, pcv.width, pcv.height);
      pctx.globalCompositeOperation = "source-over";
      pourShared = pcv;
      pourCache = { el: frame.el, w: pcv.width, h: pcv.height, t: ft };
    }
    // Форма согласована с кадром (глиф стоит только на ярком) — клип льётся
    // чистым, золото дюны без белёсой примеси.
    gctx.globalCompositeOperation = "source-in";
    gctx.drawImage(pourShared, 0, 0);
    gctx.globalCompositeOperation = "source-over";
    // Белые (тусклые) глифы поверх залитых → золото на ярком, белый на тусклом.
    gctx.drawImage(darkG, 0, 0);

    // 3) Видимый канвас: без чёрной подложки — глифы плывут поверх страницы.
    mctx.globalAlpha = cardOp;
    mctx.drawImage(glyphs, 0, 0);
    mctx.globalAlpha = 1;
  };

  let rafId = 0;
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    draw();
  };
  rafId = requestAnimationFrame(loop);

  // ----------------------------------------------------------------- API --
  window.AsciiOverlay = {
    destroy() {
      cancelAnimationFrame(rafId);
      for (const [t, type, fn, opts] of listeners) t.removeEventListener(type, fn, opts);
      for (const ev of kicks) window.removeEventListener(ev, kick);
      document.removeEventListener("visibilitychange", kick);
      mount.remove();
      video.pause();
      video.removeAttribute("src");
      video.load(); // остановить декодер
      video.remove();
      lumCache = null;
      pourShared = null;
      pourCache = null;
    },
  };
})();
