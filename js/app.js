/* Локальний тренажер ПДР. Все в браузері: дані з data/questions.js,
   прогрес і помилки — у localStorage. Без бекенду і без збірки. */
(function () {
  "use strict";

  var DATA = window.PDR_DATA;
  var app = document.getElementById("app");

  if (!DATA) {
    app.innerHTML = '<div class="empty"><h3>Не знайдено data/questions.js</h3>' +
      "<p>Згенеруйте датасет: <code>python tools/build_dataset.py</code></p></div>";
    return;
  }

  /* ---------- категорії прав ---------- */
  /* Розділи 1-39 — спільна теорія для всіх категорій. Далі першоджерело дає по
     чотири додаткові розділи на кожну групу (загальні, будова, юридична
     відповідальність, безпека), тому категорія — це просто діапазон розділів. */
  var CATEGORIES = [
    { id: "A",  label: "A1, A",   extra: [40, 43] },
    { id: "B",  label: "B1, B",   extra: [44, 47] },
    { id: "C",  label: "C1, C",   extra: [48, 51] },
    { id: "D",  label: "D1, D",   extra: [52, 55] },
    { id: "BE", label: "BE…DE",   extra: [56, 59] },
    { id: "T",  label: "T",       extra: [60, 63] }
  ];
  var CATEGORY_KEY = "pdr.category.v1";
  var DEFAULT_CATEGORY = "B";

  // Перезбираються при кожній зміні категорії, тому не const-подібні.
  var CATEGORY, QUESTIONS, SECTIONS, BY_ID, BY_SECTION;

  function categoryById(id) {
    var found = null;
    CATEGORIES.forEach(function (c) { if (c.id === id) { found = c; } });
    return found;
  }

  function applyCategory(id) {
    CATEGORY = categoryById(id) || categoryById(DEFAULT_CATEGORY);
    var lo = CATEGORY.extra[0], hi = CATEGORY.extra[1];
    function fits(sectionId) {
      var major = parseInt(sectionId, 10);   // «33.4» -> 33, «8.1» -> 8
      return major <= 39 || (major >= lo && major <= hi);
    }
    QUESTIONS = DATA.questions.filter(function (q) { return fits(q.section); });
    SECTIONS = DATA.sections.filter(function (s) { return fits(s.id); });
    BY_ID = {};
    BY_SECTION = {};
    QUESTIONS.forEach(function (q) {
      BY_ID[q.id] = q;
      (BY_SECTION[q.section] = BY_SECTION[q.section] || []).push(q);
    });
  }

  var EXAM_SIZE = 20;
  var EXAM_MINUTES = 20;
  var EXAM_MISTAKES_ALLOWED = 2;
  var EXAM_PER_SECTION = 3;   // не більше 3 питань з одного розділу
  var EXAM_PER_TOPIC = 6;     // і не більше 6 з підрозділів однієї теми
  var AUTO_NEXT_MS = 0;     // пауза на зелену підсвітку перед наступним питанням

  /* ---------- сховище ---------- */
  var store = {
    progressKey: "pdr.progress.v1",
    mistakesKey: "pdr.mistakes.v1",
    favoritesKey: "pdr.favorites.v1",
    read: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    write: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватний режим */ }
    },
    progress: function () { return store.read(store.progressKey, {}); },
    mistakes: function () { return store.read(store.mistakesKey, []); },
    /* Улюблені — ручний список: на відміну від помилок, звідси нічого не
       зникає само. Питання лишається, доки його не знімуть тією ж зіркою. */
    favorites: function () { return store.read(store.favoritesKey, []); },
    isFavorite: function (id) { return store.favorites().indexOf(id) !== -1; },
    toggleFavorite: function (id) {
      var f = store.favorites();
      var at = f.indexOf(id);
      if (at === -1) { f.push(id); } else { f.splice(at, 1); }
      store.write(store.favoritesKey, f);
      return at === -1;
    },
    clearFavorites: function () { store.write(store.favoritesKey, []); },
    /* Перенос з іншого пристрою доливається, а не затирає: зірочки, які вже
       встигли поставити тут, мають пережити імпорт. */
    mergeFavorites: function (ids) {
      var f = store.favorites(), added = 0;
      ids.forEach(function (id) {
        if (f.indexOf(id) === -1) { f.push(id); added++; }
      });
      store.write(store.favoritesKey, f);
      return added;
    },
    record: function (id, ok) {
      var p = store.progress();
      var row = p[id] || { c: 0, w: 0, last: null };
      if (ok) { row.c++; } else { row.w++; }
      row.last = ok ? 1 : 0;
      p[id] = row;
      store.write(store.progressKey, p);

      var m = store.mistakes();
      var at = m.indexOf(id);
      if (!ok && at === -1) { m.push(id); store.write(store.mistakesKey, m); }
    },
    forget: function (id) {
      var m = store.mistakes();
      var at = m.indexOf(id);
      if (at !== -1) { m.splice(at, 1); store.write(store.mistakesKey, m); }
    },
    reset: function () {
      // улюблені навмисно не чіпаємо: це ручна добірка, а не наслідок відповідей
      store.write(store.progressKey, {});
      store.write(store.mistakesKey, []);
    }
  };

  /* Категорія має бути відома до першого звернення до QUESTIONS — зокрема до
     міграції нижче, яка ходить по базі. */
  applyCategory(store.read(CATEGORY_KEY, DEFAULT_CATEGORY));

  function setCategory(id) {
    if (id === CATEGORY.id || !categoryById(id)) { return; }
    store.write(CATEGORY_KEY, id);
    applyCategory(id);
    // Прогрес прив'язаний до id питання, тож спільні розділи 1-39 переїжджають
    // між категоріями самі; скидати треба лише поточну сесію.
    session = null;
    stopTicker();
    cancelAutoNext();
    updateBadges();
    render();
  }

  function mountCategoryPicker() {
    var sel = document.getElementById("category");
    if (!sel) { return; }
    CATEGORIES.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.label;
      sel.appendChild(o);
    });
    sel.value = CATEGORY.id;
    sel.onchange = function () { setCategory(this.value); };
  }

  /* Розділ 33 роз'їхався на 33.1-33.7, тому змінились id питань:
     «33-42» -> «33.4-42». Одноразово переносимо на них збережений прогрес. */
  (function migrate33Split() {
    var flag = "pdr.migrated.33split";
    try {
      if (localStorage.getItem(flag)) { return; }
    } catch (e) { return; }               // приватний режим — просто пропускаємо

    var renamed = {};
    QUESTIONS.forEach(function (q) {
      if (q.section.indexOf("33.") === 0) { renamed["33-" + q.number] = q.id; }
    });
    var p = store.progress(), touched = false;
    Object.keys(renamed).forEach(function (old) {
      if (p[old] && !p[renamed[old]]) {
        p[renamed[old]] = p[old];
        delete p[old];
        touched = true;
      }
    });
    if (touched) { store.write(store.progressKey, p); }
    store.write(store.mistakesKey, store.mistakes().map(function (id) {
      return renamed[id] || id;
    }));
    try { localStorage.setItem(flag, "1"); } catch (e) { /* нічого страшного */ }
  })();

  /* Перемішувати питання в темі чи йти по порядку — вибір зберігається. */
  var SHUFFLE_KEY = "pdr.shuffle.v1";
  function shuffleOn() { return store.read(SHUFFLE_KEY, false) === true; }
  function setShuffleOn(v) { store.write(SHUFFLE_KEY, !!v); }

  /* Стан по всій базі: скільки питань закрито (остання відповідь правильна),
     скільки відкрито назад помилкою, скільки ще не бачили. */
  function overallStats() {
    var p = store.progress();
    var done = 0, right = 0;
    QUESTIONS.forEach(function (q) {
      var row = p[q.id];
      if (row && row.last !== null) {
        done++;
        if (row.last === 1) { right++; }
      }
    });
    return { total: QUESTIONS.length, done: done, right: right, wrong: done - right };
  }

  function overallBar() {
    var st = overallStats();
    var pct = function (n) { return st.total ? (n * 100 / st.total).toFixed(1) : 0; };
    var tail = [];
    if (st.wrong) { tail.push("з помилкою " + st.wrong); }
    tail.push("не пройдено " + (st.total - st.done));
    return el(
      '<div class="overall">' +
      '<div class="overall-head"><b>Закрито ' + st.right + " з " + st.total + " питань · " +
      Math.round(st.right * 100 / (st.total || 1)) + "%</b>" +
      '<span class="hint">' + tail.join(" · ") + "</span></div>" +
      '<div class="bar big split">' +
      '<i class="ok" style="width:' + pct(st.right) + '%"></i>' +
      '<i class="bad" style="width:' + pct(st.wrong) + '%"></i>' +
      "</div></div>"
    );
  }

  function sectionStats(sectionId) {
    var qs = BY_SECTION[sectionId] || [];
    var p = store.progress();
    var done = 0, right = 0;
    qs.forEach(function (q) {
      var row = p[q.id];
      if (!row || row.last === null) { return; }
      done++;
      if (row.last === 1) { right++; }
    });
    return { total: qs.length, done: done, right: right, pct: qs.length ? Math.round(right * 100 / qs.length) : 0 };
  }

  /* ---------- дрібні помічники ---------- */
  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstChild;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function mmss(ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? "0" : "") + m + " : " + (s < 10 ? "0" : "") + s;
  }
  /* 1 питання · 3 питання · 5 питань */
  function qWord(n) {
    var a = n % 100, b = n % 10;
    var many = a > 10 && a < 20 ? true : !(b >= 1 && b <= 4);
    return n + (many ? " питань" : " питання");
  }
  /* 1 тема · 3 теми · 5 тем — тут, на відміну від «питання», три форми */
  function tWord(n) {
    var a = n % 100, b = n % 10;
    if (a > 10 && a < 20) { return n + " тем"; }
    if (b === 1) { return n + " тема"; }
    if (b >= 2 && b <= 4) { return n + " теми"; }
    return n + " тем";
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* Білет: 20 питань, пропорційно розмірам розділів (як у офіційній логіці —
     чим більший розділ, тим більше шансів), але не більше 3 з одного розділу.
     Друга стеля — на тему цілком (33.1-33.7 рахуються разом, як 8.1+8.2):
     знаки це п'ята частина бази, і без неї в білет інколи набивалось 9-11
     знаків. Стеля 6 зрізає лише верхні ~8% білетів і не чіпає середнє. */
  function buildTicket() {
    var pool = shuffle(QUESTIONS);
    var perSection = {}, perTopic = {}, picked = [];
    for (var i = 0; i < pool.length && picked.length < EXAM_SIZE; i++) {
      var q = pool[i];
      var topic = q.section.split(".")[0];
      if ((perSection[q.section] || 0) >= EXAM_PER_SECTION) { continue; }
      if ((perTopic[topic] || 0) >= EXAM_PER_TOPIC) { continue; }
      perSection[q.section] = (perSection[q.section] || 0) + 1;
      perTopic[topic] = (perTopic[topic] || 0) + 1;
      picked.push(q);
    }
    return picked;
  }

  /* ---------- сесія проходження ---------- */
  var session = null;
  var ticker = null;
  var autoNext = null;

  function cancelAutoNext() {
    if (autoNext) { clearTimeout(autoNext); autoNext = null; }
  }

  function startSession(opts) {
    stopTicker();
    pagScroll = 0;
    session = {
      mode: opts.mode,                 // study | exam | mistakes
      title: opts.title,
      questions: opts.questions,
      idx: 0,
      chosen: {},                      // idx -> обраний варіант (0-based)
      startedAt: Date.now(),
      questionAt: Date.now(),
      paused: false,
      pausedFor: 0,
      finished: false,
      timed: opts.mode === "exam",
      limitMs: EXAM_MINUTES * 60 * 1000,
      mistakes: 0,
      failed: false,
      backTo: opts.backTo || "#/"
    };
  }

  function elapsed() {
    return Date.now() - session.startedAt - session.pausedFor;
  }

  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  function answer(optionIndex) {
    var q = session.questions[session.idx];
    if (session.finished || session.chosen[session.idx] !== undefined) { return; }
    var ok = optionIndex === q.correctIndex;
    session.chosen[session.idx] = optionIndex;
    store.record(q.id, ok);
    if (session.mode === "mistakes" && ok) { store.forget(q.id); }
    updateBadges();
    if (!ok) {
      session.mistakes++;
      if (session.mode === "exam" && session.mistakes > EXAM_MISTAKES_ALLOWED) {
        session.failed = true;
        finish();
        return;
      }
    }
    render();

    // У навчальних режимах правильна відповідь сама гортає далі: встигаємо
    // побачити зелену підсвітку, але не тиснемо «Далі». На іспиті — ні,
    // там гортає сам користувач. Помилку теж лишаємо на екрані, щоб прочитати.
    if (ok && session.mode !== "exam" && session.idx < session.questions.length - 1) {
      var at = session.idx;
      autoNext = setTimeout(function () {
        autoNext = null;
        if (!session || session.finished || session.reviewing || session.idx !== at) { return; }
        session.idx = at + 1;
        session.questionAt = Date.now();
        render();   // саме render, а не renderSession: маршрут міг уже змінитись
      }, AUTO_NEXT_MS);
    }
  }

  function go(delta) {
    var next = session.idx + delta;
    if (next < 0 || next >= session.questions.length) { return; }
    cancelAutoNext();
    session.idx = next;
    session.questionAt = Date.now();
    renderSession();
  }

  function finish() {
    session.finished = true;
    stopTicker();
    render();
  }

  /* ---------- рендер ---------- */
  function render() {
    var route = location.hash.replace(/^#/, "") || "/";
    highlightTab(route);
    updateBadges();

    if (session && !/^\/(topic\/|exam|mistakes|favorites)/.test(route)) {
      session = null;
      stopTicker();
      cancelAutoNext();
    }

    if (route === "/") { return renderHome(); }
    if (route === "/topics") { return renderTopics(); }
    if (route.indexOf("/topic/") === 0) { return renderTopic(decodeURIComponent(route.slice(7))); }
    if (route === "/exam") { return renderExam(); }
    if (route === "/mistakes") { return renderMistakes(); }
    if (route === "/favorites") { return renderFavorites(); }
    if (route.indexOf("/import") === 0) {
      var at = route.indexOf("?");
      return renderImport(at === -1 ? "" : route.slice(at + 1));
    }
    if (route === "/progress") { return renderProgress(); }
    if (route === "/about") { return renderAbout(); }
    location.hash = "#/";
  }

  function highlightTab(route) {
    var map = {
      "/topics": "topics", "/exam": "exam", "/mistakes": "mistakes",
      "/favorites": "favorites", "/progress": "progress", "/about": "about"
    };
    var key = map[route] || (route.indexOf("/topic/") === 0 ? "topics" : null);
    [].forEach.call(document.querySelectorAll("#tabs a"), function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === key);
    });
  }

  function known(ids) {
    return ids.filter(function (id) { return BY_ID[id]; });
  }

  function updateBadges() {
    paintBadge("mistakes-badge", known(store.mistakes()).length);
    paintBadge("favorites-badge", known(store.favorites()).length);
  }

  function paintBadge(id, n) {
    var b = document.getElementById(id);
    if (!b) { return; }
    b.textContent = n;
    b.hidden = n === 0;
  }

  function renderHome() {
    var st = overallStats();
    var done = st.done, right = st.right;
    var mistakes = known(store.mistakes()).length;
    var favorites = known(store.favorites()).length;

    app.innerHTML = "";
    app.appendChild(el(
      '<div><div class="hero">' +
      '<p class="disclaimer">Перед початком користування рекомендовано прочитати розділ - <a href="#/about">Про проєкт</a> </p>' +
      "<h1>Підготовка до теоретичного іспиту ПДР</h1>" +
      "<p>Категорія " + esc(CATEGORY.label) + " · " + qWord(QUESTIONS.length) +
      " із офіційної бази ГСЦ МВС · " + tWord(SECTIONS.length) + "</p></div>" +
      '<div class="cards">' +
      '<a class="card" href="#/topics"><h3>Вчити по темах</h3>' +
      "<p>Проходьте питання розділ за розділом. Правильна відповідь показується одразу.</p></a>" +
      '<a class="card" href="#/exam"><h3>Іспит як в СЦ</h3>' +
      "<p>" + EXAM_SIZE + " питань із різних тем, " + EXAM_MINUTES + " хвилин, " +
      "не більше " + EXAM_MISTAKES_ALLOWED + " помилок.</p></a>" +
      '<a class="card" href="#/mistakes"><h3>Мої помилки</h3>' +
      "<p>" + (mistakes ? "Накопичено " + qWord(mistakes) + " для повторення." : "Тут зберуться питання, на яких ви помилились.") +
      "</p></a>" +
      '<a class="card" href="#/favorites"><h3>Улюблені</h3>' +
      "<p>" + (favorites
        ? "Ваша добірка: " + qWord(favorites) + ". Правильна відповідь звідси нічого не прибирає."
        : "Позначайте зірочкою питання, які хочете проганяти окремо.") +
      "</p></a>" +
      '<a class="card" href="#/progress"><h3>Прогрес</h3>' +
      "<p>Опрацьовано " + done + " з " + QUESTIONS.length + ", правильно " +
      (done ? Math.round(right * 100 / done) : 0) + "%.</p></a>" +
      "</div></div>"
    ));
  }

  function renderTopics() {
    app.innerHTML = "";
    var head = el('<div class="section-head"><h1>Теми</h1>' +
      '<div class="head-opts">' +
      '<label class="opt"><input type="checkbox" id="opt-shuffle"' +
      (shuffleOn() ? " checked" : "") + ">Перемішувати питання в темі</label>" +
      '<p class="hint">Прогрес рахується за останньою відповіддю на кожне питання</p>' +
      "</div></div>");
    head.querySelector("#opt-shuffle").onchange = function () {
      setShuffleOn(this.checked);
      session = null;              // наступний вхід у тему збереться в новому порядку
    };
    app.appendChild(head);
    app.appendChild(overallBar());

    var list = el('<div class="topic-list"></div>');
    SECTIONS.forEach(function (s) {
      var st = sectionStats(s.id);
      var a = el(
        '<a class="topic" href="#/topic/' + encodeURIComponent(s.id) + '">' +
        '<span class="topic-id">' + esc(s.id) + "</span>" +
        '<span class="topic-name">' + esc(niceName(s.name)) +
        "<small>" + st.total + " питань" + (s.withImage ? " · " + s.withImage + " з малюнком" : "") + "</small></span>" +
        '<span class="bar"><i style="width:' + st.pct + '%"></i></span>' +
        '<span class="topic-pct">' + st.pct + "%</span>" +
        "</a>"
      );
      list.appendChild(a);
    });
    app.appendChild(list);
  }

  function niceName(name) {
    var s = name.charAt(0) + name.slice(1).toLowerCase();
    return s.replace(/\bдтп\b/gi, "ДТП").replace(/\bпдр\b/gi, "ПДР");
  }

  function startTopicSession(sectionId, mixed) {
    var s = SECTIONS.filter(function (x) { return x.id === sectionId; })[0];
    var qs = BY_SECTION[sectionId];
    startSession({
      mode: "study",
      title: niceName(s.name),
      questions: mixed ? shuffle(qs) : qs,
      backTo: "#/topics"
    });
    session.sectionId = sectionId;
    session.shuffled = mixed;
  }

  function renderTopic(sectionId) {
    if (!BY_SECTION[sectionId]) { location.hash = "#/topics"; return; }
    if (!session || session.mode !== "study" || session.sectionId !== sectionId) {
      startTopicSession(sectionId, shuffleOn());
    }
    renderSession();
  }

  function renderExam() {
    if (!session || session.mode !== "exam") {
      return renderExamIntro();
    }
    renderSession();
  }

  function renderExamIntro() {
    app.innerHTML = "";
    app.appendChild(el(
      '<div><div class="hero"><h1>Іспит як в сервісному центрі</h1>' +
      "<p>" + EXAM_SIZE + " питань із різних тем · " + EXAM_MINUTES + " хвилин · " +
      "дозволено не більше " + EXAM_MISTAKES_ALLOWED + " помилок</p></div>" +
      '<div class="stat-grid">' +
      '<div class="stat"><b>' + EXAM_SIZE + "</b><span>питань у білеті</span></div>" +
      '<div class="stat"><b>' + EXAM_MINUTES + ":00</b><span>на весь білет</span></div>" +
      '<div class="stat"><b>' + EXAM_MISTAKES_ALLOWED + "</b><span>помилки максимум</span></div>" +
      '<div class="stat"><b>' + esc(CATEGORY.id) + "</b><span>категорія</span></div>" +
      "</div>" +
      '<div style="text-align:center"><button class="btn primary" id="start-exam">Почати іспит</button>' +
      '<p class="hint" style="margin-top:14px">Питання добираються випадково з усіх тем категорії ' +
      esc(CATEGORY.label) + ", " +
      "пропорційно до їх розміру (не більше трьох питань з однієї теми).</p></div></div>"
    ));
    document.getElementById("start-exam").onclick = function () {
      startSession({ mode: "exam", title: "Іспит", questions: buildTicket(), backTo: "#/" });
      startExamTicker();
      renderSession();
    };
  }

  function startExamTicker() {
    stopTicker();
    ticker = setInterval(function () {
      if (!session || session.finished) { stopTicker(); return; }
      if (session.paused) { return; }
      if (elapsed() >= session.limitMs) {
        session.failed = true;
        finish();
        return;
      }
      paintTimers();
    }, 1000);
  }

  function renderMistakes() {
    var ids = known(store.mistakes());
    if (!ids.length) {
      app.innerHTML = "";
      app.appendChild(el('<div class="empty"><h3>Помилок поки немає</h3>' +
        "<p>Питання, на яких ви помилитесь, автоматично зберуться сюди.</p>" +
        '<p><a class="btn" href="#/topics">Перейти до тем</a></p></div>'));
      return;
    }
    if (!session || session.mode !== "mistakes") {
      startSession({
        mode: "mistakes",
        title: "Мої помилки",
        questions: ids.map(function (id) { return BY_ID[id]; }),
        backTo: "#/"
      });
    }
    renderSession();
  }

  /* Улюблені ганяємо так само, як помилки, з однією різницею: правильна
     відповідь нічого не викидає зі списку — добірка живе, доки її не знімуть. */
  function renderFavorites() {
    var ids = known(store.favorites());
    if (!ids.length) {
      session = null;
      app.innerHTML = "";
      app.appendChild(el('<div class="empty"><h3>Улюблених питань поки немає</h3>' +
        "<p>Натисніть зірочку в питанні — і воно збережеться сюди, " +
        "щоб потім проганяти окремо. Правильна відповідь звідси нічого не прибирає.</p>" +
        '<p><a class="btn" href="#/topics">Перейти до тем</a></p></div>'));
      return;
    }
    if (!session || session.mode !== "favorites") {
      startSession({
        mode: "favorites",
        title: "Улюблені питання",
        questions: ids.map(function (id) { return BY_ID[id]; }),
        backTo: "#/"
      });
    }
    renderSession();
  }

  /* ---------- перенос улюблених між пристроями ---------- */
  /* Бекенду немає, тому добірка їде в самому посиланні. id виду «16.2-49» —
     це цифри, крапка й дефіс, у фрагменті URL їх можна лишати як є. */
  function favoritesLink() {
    var ids = known(store.favorites());
    if (!ids.length) { return null; }
    return location.href.split("#")[0] + "#/import?f=" + ids.join(",");
  }

  function renderImport(query) {
    session = null;
    var m = /(?:^|&)f=([^&]*)/.exec(query);
    var seen = {}, incoming = [];
    (m ? decodeURIComponent(m[1]).split(",") : []).forEach(function (id) {
      id = id.replace(/^\s+|\s+$/g, "");
      // чужі й застарілі id мовчки відкидаємо: краще менший імпорт, ніж битий
      if (id && !seen[id] && BY_ID[id]) { seen[id] = true; incoming.push(id); }
    });

    app.innerHTML = "";
    if (!incoming.length) {
      app.appendChild(el('<div class="empty"><h3>Посилання порожнє</h3>' +
        "<p>У ньому немає жодного питання з бази категорії B — " +
        "схоже, адресу обрізало при пересиланні.</p>" +
        '<p><a class="btn" href="#/">На головну</a></p></div>'));
      return;
    }

    var fresh = incoming.filter(function (id) { return !store.isFavorite(id); });
    if (!fresh.length) {
      app.appendChild(el('<div class="empty"><h3>Уже все на місці</h3>' +
        "<p>Усі " + qWord(incoming.length) + " з посилання вже в улюблених.</p>" +
        '<p><a class="btn primary" href="#/favorites">Пройти улюблені</a></p></div>'));
      return;
    }

    var box = el('<div class="empty"><h3>Перенести улюблені</h3>' +
      "<p>У посиланні " + qWord(incoming.length) + ", з них " + fresh.length +
      " ще немає у вашій добірці. Наявні зірочки залишаться на місці.</p>" +
      '<p><button class="btn primary" id="do-import"></button> ' +
      '<a class="btn" href="#/">Скасувати</a></p></div>');
    app.appendChild(box);
    var go = document.getElementById("do-import");
    go.textContent = "Додати " + qWord(fresh.length);
    go.onclick = function () {
      store.mergeFavorites(fresh);
      updateBadges();
      location.hash = "#/favorites";
    };
  }

  function renderProgress() {
    var st = overallStats();
    var done = st.done, right = st.right;
    var mistakes = known(store.mistakes()).length;
    var favorites = known(store.favorites()).length;

    app.innerHTML = "";
    app.appendChild(el('<div class="section-head"><h1>Прогрес</h1>' +
      '<div class="head-opts">' +
      (favorites ? '<button class="btn" id="share-favorites">Перенести на телефон</button>' : "") +
      (favorites ? '<button class="btn danger" id="clear-favorites">Очистити улюблені</button>' : "") +
      '<button class="btn danger" id="reset-progress">Скинути весь прогрес</button>' +
      "</div></div>"));
    app.appendChild(overallBar());
    app.appendChild(el(
      '<div class="stat-grid">' +
      '<div class="stat"><b>' + done + " / " + QUESTIONS.length + "</b><span>опрацьовано питань</span></div>" +
      '<div class="stat"><b>' + (done ? Math.round(right * 100 / done) : 0) + "%</b><span>правильних відповідей</span></div>" +
      '<div class="stat"><b>' + mistakes + "</b><span>у розділі «Мої помилки»</span></div>" +
      '<div class="stat"><b>' + favorites + "</b><span>в улюблених</span></div>" +
      '<div class="stat"><b>' + Math.round(done * 100 / QUESTIONS.length) + "%</b><span>покриття бази</span></div>" +
      "</div>"
    ));

    var list = el('<div class="topic-list"></div>');
    SECTIONS.forEach(function (s) {
      var st = sectionStats(s.id);
      list.appendChild(el(
        '<a class="topic" href="#/topic/' + encodeURIComponent(s.id) + '">' +
        '<span class="topic-id">' + esc(s.id) + "</span>" +
        '<span class="topic-name">' + esc(niceName(s.name)) +
        "<small>опрацьовано " + st.done + " з " + st.total + ", правильно " + st.right + "</small></span>" +
        '<span class="bar"><i style="width:' + st.pct + '%"></i></span>' +
        '<span class="topic-pct">' + st.pct + "%</span></a>"
      ));
    });
    app.appendChild(list);

    document.getElementById("reset-progress").onclick = function () {
      if (confirm("Скинути весь прогрес і список помилок? Улюблені питання залишаться.")) {
        store.reset();
        updateBadges();
        render();
      }
    };
    var shareFav = document.getElementById("share-favorites");
    if (shareFav) {
      shareFav.onclick = function () {
        var open = document.getElementById("share-box");
        if (open) { open.parentNode.removeChild(open); return; }

        var link = favoritesLink();
        var local = /^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(location.host);
        var box = el('<div class="share-box" id="share-box">' +
          '<p class="hint">Відкрийте це посилання на телефоні — воно додасть ' +
          "туди ці " + qWord(favorites) + ". Прогрес і помилки не переносяться.</p>" +
          (local ? '<p class="hint warn">Адреса локальна, з телефона вона не ' +
            "відкриється. Згенеруйте посилання, зайшовши на сайт за зовнішньою " +
            "адресою — тоді в ньому буде правильний хост.</p>" : "") +
          '<div class="share-row"><input type="text" readonly>' +
          '<button class="btn" id="copy-link">Скопіювати</button></div></div>');
        var field = box.querySelector("input");
        field.value = link;
        document.querySelector(".section-head").insertAdjacentElement("afterend", box);

        document.getElementById("copy-link").onclick = function () {
          var btn = this;
          field.select();
          field.setSelectionRange(0, field.value.length);   // без цього iOS не копіює
          function done() { btn.textContent = "Скопійовано"; }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(done, function () {
              // http без TLS: clipboard API мовчить, лишається старий шлях
              try { document.execCommand("copy"); done(); } catch (e) { /* хай копіює вручну */ }
            });
          } else {
            try { document.execCommand("copy"); done(); } catch (e) { /* хай копіює вручну */ }
          }
        };
      };
    }

    var clearFav = document.getElementById("clear-favorites");
    if (clearFav) {
      clearFav.onclick = function () {
        if (confirm("Прибрати всі " + qWord(favorites) + " з улюблених?")) {
          store.clearFavorites();
          session = null;
          updateBadges();
          render();
        }
      };
    }
  }

  /* ---------- про проєкт ---------- */
  var CONTACT_URL = "https://t.me/vl_taran";
  var CONTACT_LABEL = "@vl_taran";

  /* Три фонди, які збирають на Сили оборони. Посилання ведуть тільки на
     офіційні сайти — жодних карток і реквізитів з третіх рук. */
  var FUNDS = [
    {
      name: "Повернись живим",
      url: "https://savelife.in.ua/",
      about: "Один з найбільших фондів підтримки Сил оборони: спорядження, " +
        "техніка, розвідувальні комплекси, навчання військових."
    },
    {
      name: "Фонд Сергія Притули",
      url: "https://prytulafoundation.org/",
      about: "Забезпечення захисників технікою й спорядженням і паралельно " +
        "допомога цивільним, які постраждали від війни."
    },
    {
      name: "Спільнота Стерненка",
      url: "https://www.sternenkofund.org/donate",
      about: "Переважно дрони: FPV та перехоплювачі, якими збивають «шахеди» " +
        "і б'ють по ворожій логістиці."
    }
  ];

  function renderAbout() {
    session = null;
    var total = DATA.questions.length;

    app.innerHTML = "";
    app.appendChild(el(
      '<div class="about">' +
      '<div class="section-head"><h1>Про проєкт</h1></div>' +

      "<section><h2>Це безкоштовно</h2>" +
      "<p>Тренажер безплатний і некомерційний: без реклами, без реєстрації, " +
      "без платних режимів. Нічого не збирається і нікуди не відправляється — " +
      "прогрес, помилки й улюблені лежать у <code>localStorage</code> вашого " +
      "браузера і далі нього не йдуть. Якщо захочете віддячити — краще " +
      "задонатьте на ЗСУ, посилання внизу.</p></section>" +

      "<section><h2>Звідки питання</h2>" +
      "<p>Офіційні матеріали Головного сервісного центру МВС: «Екзаменаційні " +
      "питання та відповіді для складення іспиту з теоретичної підготовки / " +
      "перепідготовки водіїв транспортних засобів», затверджені " +
      "<b>наказом ГСЦ МВС від 29.10.2025 № 225</b>.</p>" +
      '<p><a href="https://hsc.gov.ua/index/poslugi/vidacha-posvidchennya-vodiya/pitannya-ta-ispit-z-pdr/"' +
      ' target="_blank" rel="noopener">Сторінка ГСЦ МВС з офіційними файлами</a></p>' +
      '<ul class="facts">' +
      "<li>PDF з питаннями сформовано <b>10.11.2025</b>, таблицю відповідей — " +
      "<b>11.11.2025</b> (за метаданими самих файлів)</li>" +
      "<li>Файли завантажено <b>14.08.2026</b></li>" +
      "<li>Датасет для цього сайту зібрано <b>16.08.2026</b></li>" +
      "<li>Разом: " + total + " питань, 71 розділ, 1168 зображень</li>" +
      "</ul></section>" +

      "<section><h2>Як це розпізнавалось</h2>" +
      "<p>Питання й відповіді витягнуті з PDF автоматично — конвеєр на Python " +
      "написав <b>Claude (Anthropic)</b>. З файлом питань просто: у ньому є " +
      "текстовий шар. А таблиця відповідей — це скан без тексту, тому її " +
      "довелось читати окремим конвеєром: вирівнювання сторінки, пошук сітки " +
      "таблиці, нарізка клітинок і класифікатор цифр.</p>" +
      "<p>Що перевірялось, аби не переплутати відповіді:</p>" +
      '<ul class="facts">' +
      "<li>кількість клітинок у таблиці звірена з кількістю питань — по кожному розділу</li>" +
      "<li>жодна відповідь не виходить за межі варіантів свого питання</li>" +
      "<li>наскрізна звірка з незалежним розпізнаванням іншою моделлю</li>" +
      "<li>спірні клітинки виведені картинками й звірені очима вручну (48 штук)</li>" +
      "</ul></section>" +

      '<section class="contact"><h2>Знайшли помилку?</h2>' +
      "<p>Якщо десь не збігається правильна відповідь, з'їхала картинка або " +
      "покришився текст — напишіть, будь ласка. Вкажіть номер розділу й номер " +
      "питання, так знайти найшвидше.</p>" +
      '<p><a class="btn" href="' + esc(CONTACT_URL) + '" target="_blank" rel="noopener">' +
      "Написати в Telegram · " + esc(CONTACT_LABEL) + "</a></p></section>" +

      '<section class="warn-box"><h2>Застереження</h2>' +
      "<p>Це <b>не</b> офіційний ресурс ГСЦ МВС і не заміна першоджерелу. " +
      "Попри всі перевірки, помилки розпізнавання виключити не можна. " +
      "Якщо бачите розбіжність — вірте офіційному файлу, а не цьому сайту.</p>" +
      "<p>Тексти питань, відповідей і зображення належать ГСЦ МВС і " +
      "використані тут для навчальних цілей.</p></section>" +

      '<section><h2>Подякувати — задонатити на ЗСУ</h2>' +
      "<p>Автору платити не треба. Якщо тренажер допоміг скласти іспит — " +
      "закиньте будь-яку суму тим, завдяки кому ми взагалі маємо можливість " +
      "здавати ці іспити.</p>" +
      '<div class="funds">' +
      FUNDS.map(function (f) {
        return '<a class="fund" href="' + esc(f.url) + '" target="_blank" rel="noopener">' +
          "<h3>" + esc(f.name) + "</h3><p>" + esc(f.about) + "</p>" +
          '<span class="fund-link">' + esc(f.url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "")) +
          "</span></a>";
      }).join("") +
      "</div>" +
      '<p class="hint">Посилання ведуть на офіційні сайти фондів. Ніколи не ' +
      "переказуйте гроші на картки, які надсилають у приватних повідомленнях.</p>" +
      "</section></div>"
    ));
  }

  /* Зірочка всередині питання. Перемальовуємо саму кнопку, а не весь екран:
     повний render() скинув би підсвітку відповіді й змотав смугу номерів. */
  function favToggle(q) {
    var btn = el('<button class="fav-toggle" type="button"></button>');
    paint(store.isFavorite(q.id));
    btn.onclick = function () {
      paint(store.toggleFavorite(q.id));
      updateBadges();
    };
    return btn;

    function paint(on) {
      btn.classList.toggle("on", on);
      btn.title = on ? "Прибрати з улюблених" : "Додати в улюблені (клавіша F)";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.innerHTML = '<span class="star">' + (on ? "★" : "☆") + "</span>" +
        '<span class="hide-xs">' + (on ? "В улюблених" : "В улюблені") + "</span>";
    }
  }

  /* ---------- екран проходження ---------- */
  function renderSession() {
    if (session.finished && !session.reviewing) { return renderResult(); }

    var q = session.questions[session.idx];
    var chosen = session.chosen[session.idx];
    var answered = chosen !== undefined;
    var readonly = !!session.reviewing;

    app.innerHTML = "";

    if (readonly) {
      app.appendChild(el('<div class="section-head"><h1>Розбір питання</h1>' +
        '<p class="hint">Питання ' + (session.idx + 1) + " з " + session.questions.length + "</p></div>"));
    } else if (session.mode === "exam") {
      app.appendChild(el(
        '<div class="timers">' +
        '<div><span class="hide-xs">Розмірковуємо над запитанням</span>' +
        '<span class="times" id="t-question">00 : 00</span></div>' +
        "<div>Помилок: <span class=\"times\" id=\"t-mistakes\">" + session.mistakes + " / " + EXAM_MISTAKES_ALLOWED + "</span></div>" +
        "<div>Залишилось: <span class=\"times\" id=\"t-total\">" + mmss(session.limitMs) + "</span></div>" +
        "</div>"
      ));
    } else {
      app.appendChild(el('<div class="section-head"><h1>' + esc(session.title) + "</h1>" +
        '<p class="hint">Питання ' + (session.idx + 1) + " з " + session.questions.length +
        (session.shuffled ? " · перемішано" : "") + "</p></div>"));
    }

    // номери питань
    var pag = el('<ul class="pagination"></ul>');
    session.questions.forEach(function (qq, i) {
      var cls = [];
      if (i === session.idx) { cls.push("current"); }
      var c = session.chosen[i];
      if (c !== undefined) { cls.push(c === qq.correctIndex ? "right" : "wrong"); }
      var li = el("<li" + (cls.length ? ' class="' + cls.join(" ") + '"' : "") + ">" + (i + 1) + "</li>");
      li.onclick = function () {
        cancelAutoNext();
        session.idx = i;
        session.questionAt = Date.now();
        renderSession();
      };
      pag.appendChild(li);
    });
    var strip = el('<div class="pag-strip"></div>');
    strip.appendChild(pag);
    var pagWrap = el('<div class="pag-wrap"></div>');
    var arrowL = el('<button class="pag-arrow" type="button" aria-label="Попередні номери">‹</button>');
    var arrowR = el('<button class="pag-arrow" type="button" aria-label="Наступні номери">›</button>');
    arrowL.onclick = function () { nudgeStrip(strip, -1); };
    arrowR.onclick = function () { nudgeStrip(strip, 1); };
    pagWrap.appendChild(arrowL);
    pagWrap.appendChild(strip);
    pagWrap.appendChild(arrowR);
    app.appendChild(pagWrap);

    // питання
    var wrap = el('<div class="question"></div>');
    var head = el('<div class="q-head"></div>');
    head.appendChild(el("<h2>" + esc(q.text) + "</h2>"));
    head.appendChild(favToggle(q));
    wrap.appendChild(head);

    var body = el('<div class="q-body"></div>');
    var ul = el('<ul class="answers' + (answered || readonly ? " answered" : "") + '"></ul>');
    q.options.forEach(function (opt, i) {
      var cls = "";
      if (answered || readonly) {
        if (i === q.correctIndex) { cls = " class=\"right_answer\""; }
        else if (i === chosen) { cls = " class=\"wrong_answer\""; }
      }
      var li = el("<li" + cls + '><span><i class="num">' + (i + 1) + ".</i> " + esc(opt) + "</span></li>");
      if (!readonly) { li.onclick = function () { answer(i); }; }
      ul.appendChild(li);
    });
    body.appendChild(ul);

    var imgBox = el('<div class="question-img"></div>');
    if (q.images && q.images.length) {
      q.images.forEach(function (src) {
        var img = el('<img src="' + esc(src) + '" alt="Малюнок до питання" loading="lazy">');
        // дрібні знаки в PDF лежать у малій роздільності — трохи збільшуємо,
        // але не розтягуємо на всю колонку, щоб не милити
        img.onload = function () {
          if (this.naturalWidth && this.naturalWidth < 200) {
            this.style.width = Math.min(this.naturalWidth * 2.2, 300) + "px";
          }
        };
        imgBox.appendChild(img);
      });
    } else {
      imgBox.appendChild(el('<div class="no-image">Питання без малюнку</div>'));
    }
    body.appendChild(imgBox);
    wrap.appendChild(body);

    // низ
    var foot = el('<div class="q-foot"></div>');
    if (readonly) {
      var backRes = el('<button class="btn primary">← До результатів</button>');
      backRes.onclick = function () { session.reviewing = false; render(); };
      foot.appendChild(backRes);
      var pv = el('<button class="btn"' + (session.idx === 0 ? " disabled" : "") + ">← Назад</button>");
      pv.onclick = function () { go(-1); };
      var nx = el('<button class="btn"' + (session.idx === session.questions.length - 1 ? " disabled" : "") + ">Далі →</button>");
      nx.onclick = function () { go(1); };
      foot.appendChild(pv);
      foot.appendChild(nx);
      foot.appendChild(el('<span class="q-source">Розділ ' + esc(q.section) + ", питання " + q.number + "</span>"));
      wrap.appendChild(foot);
      app.appendChild(wrap);
      syncPagination(strip);
      return;
    }
    var prev = el('<button class="btn"' + (session.idx === 0 ? " disabled" : "") + ">← Назад</button>");
    prev.onclick = function () { go(-1); };
    foot.appendChild(prev);

    var last = session.idx === session.questions.length - 1;
    if (last && (session.mode === "exam" ? true : answered)) {
      var fin = el('<button class="btn primary">Завершити</button>');
      fin.onclick = function () {
        if (session.mode !== "exam" || confirm("Завершити іспит?")) { finish(); }
      };
      foot.appendChild(fin);
    } else {
      var next = el('<button class="btn' + (answered ? " primary" : "") + '"' + (last ? " disabled" : "") + ">Далі →</button>");
      next.onclick = function () { go(1); };
      foot.appendChild(next);
    }

    if (session.mode === "exam") {
      var pause = el('<button class="btn ghost">' + (session.paused ? "Продовжити" : "Пауза") + "</button>");
      pause.onclick = function () {
        if (session.paused) {
          session.pausedFor += Date.now() - session.pausedAt;
          session.paused = false;
        } else {
          session.paused = true;
          session.pausedAt = Date.now();
        }
        render();
      };
      foot.appendChild(pause);
    } else {
      if (session.mode === "study") {
        var mix = el('<button class="btn ghost">Перемішати</button>');
        mix.onclick = function () {
          cancelAutoNext();
          startTopicSession(session.sectionId, true);
          renderSession();
        };
        foot.appendChild(mix);
      }
      var back = el('<a class="btn ghost" href="' + session.backTo + '">Вийти</a>');
      foot.appendChild(back);
    }

    foot.appendChild(el('<span class="q-source">Розділ ' + esc(q.section) + ", питання " + q.number + "</span>"));
    wrap.appendChild(foot);

    if (session.mode === "mistakes" && answered && chosen === q.correctIndex) {
      wrap.appendChild(el('<p class="hint">Правильно — питання прибрано зі списку помилок.</p>'));
    }
    if (session.mode === "favorites" && answered && chosen === q.correctIndex) {
      wrap.appendChild(el('<p class="hint">Правильно — питання залишається в улюблених.</p>'));
    }

    app.appendChild(wrap);

    syncPagination(strip);
    paintTimers();
  }

  /* Смуга номерів. Розмітка щоразу малюється наново, тому запам'ятовуємо, де
     смуга стояла, — інакше вона стрибала б на початок і «під'їзд» до поточного
     номера був би не рухом, а телепортом. */
  var pagScroll = 0;

  function syncPagination(strip) {
    var max = strip.scrollWidth - strip.clientWidth;
    strip.parentNode.classList.toggle("no-scroll", max <= 2);
    strip.scrollLeft = Math.min(pagScroll, Math.max(0, max));
    strip.onscroll = function () {
      pagScroll = strip.scrollLeft;
      paintArrows(strip);
    };
    var cur = strip.querySelector(".current");
    if (cur && max > 2) {
      // тримаємо поточний номер посередині смуги, поки є куди їхати.
      // Рахуємо через getBoundingClientRect, а не offsetLeft: offsetLeft
      // залежить від offsetParent і дає зсув на кілька десятків пікселів.
      var sr = strip.getBoundingClientRect();
      var cr = cur.getBoundingClientRect();
      var to = strip.scrollLeft + (cr.left - sr.left) - (sr.width - cr.width) / 2;
      strip.scrollTo({ left: Math.max(0, Math.min(to, max)), behavior: "smooth" });
    }
    paintArrows(strip);
  }

  function paintArrows(strip) {
    var max = strip.scrollWidth - strip.clientWidth;
    var arrows = strip.parentNode.querySelectorAll(".pag-arrow");
    if (arrows.length < 2) { return; }
    arrows[0].disabled = strip.scrollLeft <= 1;
    arrows[1].disabled = strip.scrollLeft >= max - 1;
  }

  function nudgeStrip(strip, dir) {
    strip.scrollBy({ left: dir * Math.max(120, strip.clientWidth - 60), behavior: "smooth" });
  }

  function paintTimers() {
    if (!session || session.mode !== "exam" || session.finished) { return; }
    var tq = document.getElementById("t-question");
    var tt = document.getElementById("t-total");
    var tm = document.getElementById("t-mistakes");
    if (tq) { tq.textContent = mmss(session.paused ? 0 : Date.now() - session.questionAt); }
    if (tt) {
      var left = session.limitMs - elapsed();
      tt.textContent = mmss(left);
      tt.classList.toggle("danger", left < 3 * 60 * 1000);
    }
    if (tm) { tm.textContent = session.mistakes + " / " + EXAM_MISTAKES_ALLOWED; }
  }

  function renderResult() {
    var total = session.questions.length;
    var answeredCount = Object.keys(session.chosen).length;
    var right = 0;
    session.questions.forEach(function (q, i) {
      if (session.chosen[i] === q.correctIndex) { right++; }
    });
    var wrong = answeredCount - right;
    var passed = session.mode === "exam"
      ? (!session.failed && wrong <= EXAM_MISTAKES_ALLOWED && answeredCount === total)
      : true;
    var timeStr = mmss(elapsed());

    app.innerHTML = "";
    var reason = "";
    if (session.mode === "exam" && !passed) {
      reason = session.failed && elapsed() >= session.limitMs
        ? "Час вичерпано."
        : (wrong > EXAM_MISTAKES_ALLOWED ? "Перевищено ліміт помилок." : "Іспит завершено достроково.");
    }

    var head = session.mode === "exam"
      ? '<div class="verdict ' + (passed ? "ok" : "fail") + '">' + (passed ? "Іспит складено" : "Іспит не складено") + "</div>" +
        (reason ? '<p class="hint">' + reason + "</p>" : "")
      : '<div class="verdict ok">' + esc(session.title) + "</div>";

    var box = el(
      '<div class="result">' + head +
      '<div class="stats">' +
      "<div><b>" + right + "</b>правильних</div>" +
      "<div><b>" + wrong + "</b>помилок</div>" +
      "<div><b>" + answeredCount + " / " + total + "</b>відповідей</div>" +
      "<div><b>" + timeStr + "</b>час</div>" +
      "</div></div>"
    );

    var actions = el('<div></div>');
    if (session.mode === "exam") {
      var again = el('<button class="btn primary">Ще один білет</button>');
      again.onclick = function () {
        startSession({ mode: "exam", title: "Іспит", questions: buildTicket(), backTo: "#/" });
        startExamTicker();
        renderSession();
      };
      actions.appendChild(again);
    } else {
      var restart = el('<button class="btn">Пройти ще раз</button>');
      restart.onclick = function () {
        // помилки й улюблені беремо зі сховища наново: за прохід список міг змінитись
        var mode = session.mode;
        var qs = mode === "mistakes" || mode === "favorites"
          ? known(mode === "mistakes" ? store.mistakes() : store.favorites())
              .map(function (id) { return BY_ID[id]; })
          : session.questions;
        if (!qs.length) {
          session = null;
          location.hash = mode === "favorites" ? "#/favorites" : "#/mistakes";
          render();
          return;
        }
        var keep = { mode: session.mode, title: session.title, questions: qs, backTo: session.backTo };
        var sec = session.sectionId;
        startSession(keep);
        session.sectionId = sec;
        renderSession();
      };
      actions.appendChild(restart);
    }
    var home = el('<a class="btn ghost" href="#/" style="margin-left:10px">На головну</a>');
    home.onclick = function () { session = null; };
    actions.appendChild(home);
    box.appendChild(actions);

    var review = el('<div class="review"></div>');
    session.questions.forEach(function (q, i) {
      var c = session.chosen[i];
      var ok = c === q.correctIndex;
      var line = c === undefined
        ? '<span class="bad">без відповіді</span>'
        : (ok ? '<span class="good">правильно</span>'
              : 'ваша: <span class="bad">' + (c + 1) + ") " + esc(q.options[c]) + "</span>");
      var item = el(
        '<div class="review-item ' + (ok ? "ok" : "bad") + '">' +
        '<div class="rq">' + (i + 1) + ". " + esc(q.text) + "</div>" +
        '<div class="ra">' + line +
        (ok ? "" : ' · правильна: <span class="good">' + (q.correctIndex + 1) + ") " +
          esc(q.options[q.correctIndex]) + "</span>") +
        " · розділ " + esc(q.section) + ", питання " + q.number + "</div></div>"
      );
      item.onclick = function () {
        session.reviewing = true;
        session.idx = i;
        renderSession();
        window.scrollTo(0, 0);
      };
      review.appendChild(item);
    });
    box.appendChild(review);
    app.appendChild(box);
  }

  /* ---------- старт ---------- */
  window.addEventListener("hashchange", render);
  document.addEventListener("keydown", function (e) {
    if (!session || session.finished) { return; }
    if (e.key === "ArrowRight") { go(1); }
    if (e.key === "ArrowLeft") { go(-1); }
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) {
      var q = session.questions[session.idx];
      if (n <= q.options.length) { answer(n - 1); }
    }
    // «а» — та сама клавіша F в українській розкладці
    if (/^[fFаА]$/.test(e.key)) {
      var btn = document.querySelector(".fav-toggle");
      if (btn) { btn.click(); }
    }
  });

  mountCategoryPicker();
  updateBadges();
  render();
})();
