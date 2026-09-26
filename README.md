# ASCII overlay

Полноэкранный эффект «живого ASCII-кода» с сайта Axion, вынесенный в самодостаточный пакет.
Фиксированный canvas поверх всей страницы: глифы (70-уровневый ASCII-рамп) рисуются по
люминанса скрытого видео-клипа с золотой дюной, часть строк — бегущие тикеры телеметрии,
поле разорвано шумом на острова, у курсора — линза-магнит. Без зависимостей.

## Файлы

- `ascii-overlay.js` — весь эффект, один файл
- `mask.mp4` — клип-источник, десктоп (1080p, ~13 МБ)
- `mask-m.mp4` — клип-источник, мобилка ≤768px (640×360, ~1.3 МБ)
- `background.mp4` — видимая дюна для фона демо (1080p, ~2.1 МБ), та же съёмка, что и `mask.mp4`
- `dune.jpg` — фото-фолбэк дюны до первого кадра клипа (~0.5 МБ)
- `index.html` — демо: эффект поверх фона-дюны

## Подключение

1. Положить папку (js + оба mp4 рядом) в проект.
2. Перед `</body>`:

```html
<script src="/ascii-overlay/ascii-overlay.js" defer></script>
```

Всё. Скрипт сам создаёт фиксированный слой поверх всего (`pointer-events: none` —
клики и скролл проходят насквозь) и сам находит видео рядом с собой.

## Фон-дюна (демо)

На сайте Axion дюна под кодом — не часть эффекта, а отдельный слой страницы
(`BackdropStage`): фиксированный контейнер под оверлеем, в нём фото-фолбэк и
поверх него зацикленный клип. `index.html` повторяет этот слой один в один,
сам `ascii-overlay.js` остаётся прозрачным и ничего о фоне не знает.

```html
<style>
  body { background: #b7b7b7; }               /* серый до первого кадра, как на сайте */
  .backdrop { position: fixed; inset: 0; height: 100lvh; z-index: 0;
              background: #b7b7b7; overflow: hidden; pointer-events: none; }
  .backdrop__fallback, .backdrop__media { position: absolute; inset: 0;
              width: 100%; height: 100%; object-fit: cover; }
  .backdrop__media { object-position: 69% 50%; } /* гребень клипа = гребень фото на телефоне */
  @media (prefers-reduced-motion: reduce) { .backdrop__media { display: none; } }
</style>
<div class="backdrop" aria-hidden="true">
  <img class="backdrop__fallback" src="/ascii-overlay/dune.jpg" alt="" width="1024" height="1536" />
  <video class="backdrop__media" src="/ascii-overlay/background.mp4" autoplay muted loop playsinline preload="auto"></video>
</div>
```

- `background.mp4` и `mask.mp4` — одна и та же съёмка (1920×1080, 20 с, обе
  зациклены), поэтому острова глифов ложатся на гребни дюны. Жёсткой
  синхронизации по времени нет, как и на сайте: разбег в доли секунды на
  медленном клипе не читается.
- Эффект живёт на `zIndex: 9999`, фон — на `z-index: 0`; между ними можно
  класть любой контент страницы.
- `prefers-reduced-motion: reduce` — клип скрыт, остаётся фото; эффект в этом
  режиме и так не монтируется.

## Настройки (необязательно)

Объект `window.ASCII_OVERLAY` объявить **до** подключения скрипта:

```html
<script>
  window.ASCII_OVERLAY = {
    zIndex: 9999,      // слой оверлея
    opacity: 1,        // прозрачность всего эффекта 0..1
    sparse: 0.65,      // разреженность: 0 = сплошное поле, выше = рваные острова
    dataShare: 0.5,    // доля строк-тикеров телеметрии (0 = только рамп)
    magnetism: true,   // линза-магнит у курсора
    video: null,       // свой путь к десктоп-клипу (если видео не рядом со скриптом)
    videoMobile: null, // свой путь к мобильному клипу
    blackPoint: 0.45,  // контрастная кривая: ниже = больше глифов (плотнее)
    whitePoint: 0.85,
    records: null,     // свои строки телеметрии: массив строк
  };
</script>
<script src="/ascii-overlay/ascii-overlay.js" defer></script>
```

Хочется плотнее/сплошнее — `sparse: 0` и `blackPoint: 0.2`.
Снять эффект из кода: `window.AsciiOverlay.destroy()`.

## Важно

- Открывать по **http(s)**, не через `file://` — иначе браузер блокирует чтение
  видео-кадров и эффект молча не рисуется. Локально: `npx serve` или
  `python3 -m http.server` в папке с `index.html`.
- Если видео лежит на другом домене (CDN) — на нём должен быть CORS
  (`Access-Control-Allow-Origin`), скрипт запрашивает клип с `crossorigin=anonymous`.
- `prefers-reduced-motion: reduce` — эффект не монтируется вовсе (так и задумано).
- Эффект светлый (золото + белый) — лучше всего читается на тёмных страницах.
