const API_BASE = "";

let state = {
  groupId: null,
  selectedClass: null,
  selectedCategory: null,
  selectedSubcategory: null,
  selectedEvent: null,
  selectedDirectionId: null,
  classDetailReturn: "screenClasses",
  classes: [],
  categories: [],
  ratings: [],
  classScores: [],
  classEvents: [],
  uniformByClass: {},
  uniform: null
};

async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options
  });

  if (!response.ok) {
    let text = await response.text();
    throw new Error(text || "Ошибка API");
  }

  return response.json();
}

function show(screenId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
  window.scrollTo(0, 0);
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2300);
}

function confirmAction(text) {
  return confirm(text);
}

function groupName(id) {
  if (id === "all") return "Все классы";
  if (id === 1) return "Начальная школа";
  if (id === 2) return "Средняя школа";
  return "Старшая школа";
}

function sortedDirections() {
  return [...state.categories].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
}

function directionForRow(row, base) {
  return (row.categories || []).find(category =>
    category.id === base.id ||
    (base.matrix_number && category.matrix_number === base.matrix_number)
  );
}

function currentScreenId() {
  return document.querySelector(".screen.active")?.id || "screenHome";
}

function isUniformCheckedCurrentMonth(row) {
  const uniform = (row.categories || []).find(cat => cat.uniform_summary);
  return Boolean(uniform?.uniform_summary?.is_checked_current_month);
}

function uniformLatestDate(row) {
  const uniform = (row.categories || []).find(cat => cat.uniform_summary);
  return uniform?.uniform_summary?.latest_check_date || null;
}

async function loadBase() {
  [state.classes, state.categories, state.ratings] = await Promise.all([
    api("/api/classes"),
    api("/api/categories"),
    api("/api/ratings/classes")
  ]);
  const summaries = await Promise.all(state.classes.map(async cls => {
    try { return [cls.id, await api(`/api/classes/${cls.id}/uniform-checks`)]; }
    catch (error) { return [cls.id, null]; }
  }));
  state.uniformByClass = Object.fromEntries(summaries);
  hydrateMatrixRatings();
  renderUniformAlert();
  if (state.categories.length && !state.selectedDirectionId) state.selectedDirectionId = sortedDirections()[0]?.id || null;
}

function hydrateMatrixRatings() {
  state.ratings.forEach(row => {
    const summary = state.uniformByClass[row.class_id];
    const responsibility = (row.categories || []).find(cat => cat.matrix_number === 8);
    if (responsibility && summary) {
      responsibility.uniform_summary = summary;
      const uniformCriterion = (responsibility.subcategories || []).find(sub => sub.code === "КР-08.01");
      if (uniformCriterion) {
        responsibility.points = Math.round((Number(responsibility.points || 0) - Number(uniformCriterion.points || 0) + Number(summary.average_points || 0)) * 100) / 100;
        uniformCriterion.points = Number(summary.average_points || 0);
        uniformCriterion.uniform_summary = summary;
      }
    }
    const possible = (row.categories || []).reduce((sum, cat) => sum + Number(cat.max_points || 0), 0);
    const earned = (row.categories || []).reduce((sum, cat) => sum + Number(cat.points || 0), 0);
    row.total = possible ? Math.round(earned / possible * 10000) / 100 : 0;
  });
}

function renderUniformAlert() {
  const unchecked = state.ratings.filter(row => !isUniformCheckedCurrentMonth(row));
  const btn = document.getElementById("uniformAlertBtn");

  if (!unchecked.length) {
    btn.classList.add("hidden");
    return;
  }

  btn.classList.remove("hidden");
  document.getElementById("uniformAlertTitle").textContent = `Не проверена школьная форма: ${unchecked.length} классов`;
  document.getElementById("uniformAlertText").textContent = "Нажмите, чтобы открыть палитру проверки";
}

function openGroup(groupId) {
  state.groupId = groupId === "all" ? "all" : Number(groupId);
  document.getElementById("classesTitle").textContent = groupName(state.groupId);

  const classes = state.groupId === "all"
    ? state.classes
    : state.classes.filter(c => c.group_id === state.groupId);

  renderClassList("classesList", classes, "detail");
  show("screenClasses");
}

function renderClassList(containerId, classes, mode = "detail") {
  document.getElementById(containerId).innerHTML = classes.map(cls => `
    <button class="item" onclick="${mode === "uniform" ? `openUniform(${cls.id})` : `openClassDetail(${cls.id})`}">
      <div>
        <h3>${cls.name} класс</h3>
        <p>${cls.group_name || ""} · учеников: ${cls.students_count || 0}</p>
      </div>
      <strong>›</strong>
    </button>
  `).join("");
}

async function openClassDetail(classId) {
  const current = currentScreenId();
  if (current === "screenDirectionDetail") state.classDetailReturn = "screenDirectionDetail";
  else if (current === "screenAllRating") state.classDetailReturn = "screenAllRating";
  else if (!["screenClassDetail", "screenEventForm", "screenUniform"].includes(current)) state.classDetailReturn = "screenClasses";
  document.querySelector("#screenClassDetail .back").dataset.target = state.classDetailReturn;

  state.selectedClass = state.classes.find(c => c.id === classId);
  if (!state.selectedClass) return toast("Класс не найден");

  document.getElementById("classDetailTitle").textContent = `${state.selectedClass.name} класс`;
  document.getElementById("classNameInput").value = state.selectedClass.name || "";
  document.getElementById("classGradeInput").value = state.selectedClass.grade || 1;
  document.getElementById("classGroupInput").value = state.selectedClass.group_id || 1;
  document.getElementById("studentsCountInput").value = state.selectedClass.students_count || 0;

  state.classScores = await api(`/api/classes/${classId}/category-scores`);
  state.classEvents = await api(`/api/classes/${classId}/subcategory-events`);

  const summary = state.uniformByClass[classId];
  const responsibility = state.classScores.find(cat => cat.matrix_number === 8);
  if (responsibility && summary) {
    responsibility.uniform_summary = summary;
    const uniformCriterion = (responsibility.subcategories || []).find(sub => sub.code === "КР-08.01");
    if (uniformCriterion) {
      responsibility.points = Math.round((Number(responsibility.points || 0) - Number(uniformCriterion.points || 0) + Number(summary.average_points || 0)) * 100) / 100;
      uniformCriterion.points = Number(summary.average_points || 0);
      uniformCriterion.uniform_summary = summary;
    }
  }

  renderClassScores();
  show("screenClassDetail");
}

function renderAdminDirectionCatalog() {
  const directions = sortedDirections();
  document.getElementById("adminDirectionCatalog").innerHTML = directions.map((direction, index) => {
    const values = state.ratings.map(row => Number(directionForRow(row, direction)?.points || 0));
    const average = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : 0;
    const active = values.filter(value => value > 0).length;
    return `
      <button class="admin-direction-card" onclick="openDirection(${direction.id})">
        <span>${String(direction.matrix_number || direction.sort_order || index + 1).padStart(2, "0")}</span>
        <div><h3>${direction.name}</h3><p>${(direction.subcategories || []).length} критериев · ${active}/${state.ratings.length} классов заполнено</p></div>
        <strong>${average}</strong>
      </button>
    `;
  }).join("");
}

function openDirections() {
  renderAdminDirectionCatalog();
  show("screenDirections");
}

function openDirection(directionId) {
  state.selectedDirectionId = Number(directionId);
  const base = sortedDirections().find(direction => direction.id === state.selectedDirectionId);
  if (!base) return toast("Направление не найдено");

  const ranking = state.ratings.map(row => ({
    row,
    category: directionForRow(row, base),
    points: Number(directionForRow(row, base)?.points || 0)
  })).sort((a, b) => b.points - a.points || a.row.class_name.localeCompare(b.row.class_name, "ru"));
  const average = ranking.length ? Math.round(ranking.reduce((sum, item) => sum + item.points, 0) / ranking.length * 10) / 10 : 0;
  const coverage = ranking.filter(item => item.points > 0).length;
  const leader = ranking[0];
  const sampleCategory = ranking.find(item => item.category)?.category;
  const criteria = sampleCategory?.subcategories || base.subcategories || [];

  document.getElementById("adminDirectionLabel").textContent = `Направление ${String(base.matrix_number || base.sort_order || 1).padStart(2, "0")}`;
  document.getElementById("adminDirectionTitle").textContent = base.name;
  document.getElementById("adminDirectionLeader").textContent = leader?.row?.class_name || "—";
  document.getElementById("adminDirectionLeaderPoints").textContent = `${Math.round((leader?.points || 0) * 10) / 10} из ${base.max_points || 100}`;
  document.getElementById("adminDirectionAverage").textContent = average;
  document.getElementById("adminDirectionCoverage").textContent = `${coverage}/${ranking.length}`;
  document.getElementById("adminDirectionCriteriaCount").textContent = criteria.length;

  document.getElementById("adminDirectionRanking").innerHTML = ranking.map((item, index) => `
    <button class="direction-class-row" onclick="openClassDetail(${item.row.class_id})">
      <span>${index + 1}</span>
      <div><h3>${item.row.class_name} класс</h3><p>${item.row.students_count || 0} учеников</p><i><b style="width:${Math.min(100, item.points)}%"></b></i></div>
      <strong>${Math.round(item.points * 10) / 10}</strong>
    </button>
  `).join("");

  document.getElementById("adminDirectionCriteria").innerHTML = criteria.map(criterion => {
    const classValues = ranking.map(item => {
      const sub = (item.category?.subcategories || []).find(candidate => candidate.id === criterion.id || candidate.code === criterion.code);
      return { row: item.row, points: Number(sub?.points || 0) };
    }).sort((a, b) => b.points - a.points);
    const criterionAverage = classValues.length ? Math.round(classValues.reduce((sum, item) => sum + item.points, 0) / classValues.length * 10) / 10 : 0;
    const criterionCoverage = classValues.filter(item => item.points > 0).length;
    return `
      <article class="direction-criterion-admin-card">
        <div class="criterion-admin-head">
          <div><span>${criterion.code || "Показатель"}</span><h3>${criterion.name}</h3></div>
          <button class="mini" onclick="openSubcategoryForm(${criterion.id})">Изменить</button>
        </div>
        <div class="criterion-admin-metrics"><strong>${criterionAverage}</strong><p>средний балл</p><b>${criterionCoverage}/${classValues.length}</b><p>классов</p></div>
        <p>${criterion.measurement || "Описание показателя не заполнено"}</p>
        <div class="criterion-admin-formula"><b>${criterion.formula_code || "Ручные баллы"}</b><span>${criterion.scoring_rule || `До ${criterion.max_points || 10} баллов`}</span></div>
        <div class="criterion-class-chips">
          ${classValues.slice(0, 6).map(item => `<button onclick="openClassDetail(${item.row.class_id})"><span>${item.row.class_name}</span><b>${Math.round(item.points * 10) / 10}</b></button>`).join("")}
        </div>
      </article>
    `;
  }).join("") || `<p class="empty">Критерии пока не добавлены</p>`;

  show("screenDirectionDetail");
}

function renderClassScores() {
  document.getElementById("classScoresList").innerHTML = state.classScores.map(cat => `
      <section class="score-card">
        <h3>${cat.name} <em>${cat.points || 0}/${cat.max_points}</em></h3>
        <p>${cat.maxed ? `Лимит категории достигнут: ${cat.raw_points} → ${cat.points}` : "До 10 баллов за каждый критерий"}</p>
        ${(cat.subcategories || []).map(sub => `
          <div class="sub-block">
            <div class="sub-head">
              <div>
                <b>${sub.code ? `${sub.code} · ` : ""}${sub.name}</b>
                <small>${sub.maxed ? `Лимит: ${sub.raw_points} → ${sub.points}` : `до ${sub.max_points} баллов`}</small>
              </div>
              <button class="mini" onclick="openEventForm(null, ${sub.id})">+ событие</button>
            </div>
            ${sub.formula_code ? `<p class="formula-line"><b>${sub.formula_code}</b> · цель ${sub.target ?? "—"} ${sub.unit || ""}</p>` : ""}
            ${sub.code === "КР-08.01" ? `<p class="${sub.uniform_summary?.is_checked_current_month ? "uniform-note-ok" : "uniform-note-bad"}">${sub.uniform_summary?.is_checked_current_month ? "Форма проверена в текущем месяце" : "Форма в текущем месяце не проверена"}</p>` : ""}
            <div class="event-list">
              ${(sub.events || []).map(event => `
                <button class="event-row" onclick="openEventForm(${event.id}, ${sub.id})">
                  <div>
                    <span>${event.title}</span>
                    <small>${event.event_date}${event.comment ? " · " + event.comment : ""}</small>
                  </div>
                  <strong>+${event.points}</strong>
                </button>
              `).join("") || `<p class="empty">Событий пока нет</p>`}
            </div>
          </div>
        `).join("")}
      </section>
    `).join("");
}

async function saveClass() {
  const payload = {
    name: document.getElementById("classNameInput").value.trim(),
    grade: Number(document.getElementById("classGradeInput").value),
    group_id: Number(document.getElementById("classGroupInput").value),
    students_count: Number(document.getElementById("studentsCountInput").value || 0)
  };

  await api(`/api/classes/${state.selectedClass.id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  toast("Класс обновлён");
  await loadBase();
  await openClassDetail(state.selectedClass.id);
}

async function deleteClass() {
  if (!confirmAction("Удалить класс? Он уйдёт в архив.")) return;

  await api(`/api/classes/${state.selectedClass.id}`, { method: "DELETE" });
  toast("Класс удалён");
  await loadBase();
  show("screenGroups");
}

async function createClass() {
  const payload = {
    name: document.getElementById("newClassName").value.trim(),
    grade: Number(document.getElementById("newClassGrade").value),
    group_id: Number(document.getElementById("newClassGroup").value),
    students_count: Number(document.getElementById("newClassStudents").value || 0)
  };

  if (!payload.name) return toast("Введите название класса");

  await api("/api/classes", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  toast("Класс добавлен");
  await loadBase();
  show("screenHome");
}

function fillEventSubcategorySelect(selectedSubcategoryId = null) {
  const select = document.getElementById("eventSubcategoryInput");
  const options = [];

  state.categories.forEach(cat => {
    (cat.subcategories || []).forEach(sub => {
      options.push(`<option value="${sub.id}">${cat.name} → ${sub.name}${sub.formula_code ? ` · ${sub.formula_code}` : ""}</option>`);
    });
  });

  select.innerHTML = options.join("");
  if (selectedSubcategoryId) select.value = String(selectedSubcategoryId);
}

function selectedEventCriterion() {
  const id = Number(document.getElementById("eventSubcategoryInput").value);
  for (const category of state.categories) {
    const criterion = (category.subcategories || []).find(item => item.id === id);
    if (criterion) return criterion;
  }
  return null;
}

const FORMULA_FIELDS = {
  "ОХВ(T)": [["percent", "Фактический процент"]],
  "КОЛ(q)": [["quantity", "Количество"]],
  "СРЕЗ": [["present", "Присутствуют"], ["violations", "Нарушения"]],
  "ФАКТ": [["fact_score", "Уровень выполнения: 0, 5 или 10"]],
  "ИНД": [["school", "Школьный уровень"], ["municipal", "Муниципальный"], ["regional", "Региональный"], ["federal", "Федеральный / международный"]],
  "КГ/УЧ(T)": [["amount", "Общий объём, кг"], ["denominator", "Численность класса"]]
};

function renderEventFormula() {
  const criterion = selectedEventCriterion();
  const box = document.getElementById("eventFormulaBox");
  if (!criterion?.formula_code) {
    box.classList.add("hidden");
    return;
  }

  box.classList.remove("hidden");
  document.getElementById("eventFormulaTitle").textContent = `${criterion.formula_code} · цель ${criterion.target ?? "—"} ${criterion.unit || ""}`;
  document.getElementById("eventFormulaText").textContent = criterion.scoring_rule || criterion.measurement || "Заполните исходные данные и рассчитайте балл.";
  document.getElementById("eventFormulaFields").innerHTML = (FORMULA_FIELDS[criterion.formula_code] || []).map(([name, label]) => `
    <label>${label}<input data-formula-field="${name}" type="number" min="0" step="any" value="0" /></label>
  `).join("");
}

function calculateEventPoints() {
  const criterion = selectedEventCriterion();
  if (!criterion?.formula_code) return toast("У критерия не задана формула");
  const input_data = {};
  document.querySelectorAll("[data-formula-field]").forEach(input => {
    input_data[input.dataset.formulaField] = Number(input.value || 0);
  });

  const target = Number(criterion.target || 0);
  const cap = value => Math.round(Math.max(0, Math.min(10, value)) * 100) / 100;
  let points = 0;

  try {
    if (criterion.formula_code === "ОХВ(T)") {
      points = target > 0 ? cap(10 * input_data.percent / target) : 0;
    } else if (criterion.formula_code === "КОЛ(q)") {
      points = target > 0 ? cap(10 * input_data.quantity / target) : 0;
    } else if (criterion.formula_code === "СРЕЗ") {
      if (input_data.violations > input_data.present) throw new Error();
      points = input_data.present > 0 ? cap(10 * (input_data.present - input_data.violations) / input_data.present) : 0;
    } else if (criterion.formula_code === "ФАКТ") {
      if (![0, 5, 10].includes(input_data.fact_score)) throw new Error();
      points = input_data.fact_score;
    } else if (criterion.formula_code === "ИНД") {
      points = cap(input_data.school + 2 * input_data.municipal + 3 * input_data.regional + 4 * input_data.federal);
    } else if (criterion.formula_code === "КГ/УЧ(T)") {
      points = input_data.denominator > 0 && target > 0 ? cap(10 * (input_data.amount / input_data.denominator) / target) : 0;
    }
    document.getElementById("eventPointsInput").value = points;
    toast(`Рассчитано: ${points} баллов`);
  } catch (error) {
    toast("Проверьте исходные данные формулы");
  }
}

function openEventForm(eventId = null, subcategoryId = null) {
  state.selectedEvent = null;

  if (eventId) {
    for (const cat of state.classScores) {
      for (const sub of (cat.subcategories || [])) {
        const found = (sub.events || []).find(e => e.id === eventId);
        if (found) state.selectedEvent = found;
      }
    }
  }

  fillEventSubcategorySelect(state.selectedEvent?.subcategory_id || subcategoryId);
  document.getElementById("eventFormTitle").textContent = eventId ? "Редактировать" : "Добавить";
  document.getElementById("eventDateInput").value = state.selectedEvent?.event_date || new Date().toISOString().slice(0, 10);
  document.getElementById("eventTitleInput").value = state.selectedEvent?.title || "";
  document.getElementById("eventPointsInput").value = state.selectedEvent?.points || 0;
  document.getElementById("eventCommentInput").value = state.selectedEvent?.comment || "";
  document.getElementById("deleteEventBtn").classList.toggle("hidden", !eventId);
  renderEventFormula();

  show("screenEventForm");
}

async function saveEvent() {
  const payload = {
    subcategory_id: Number(document.getElementById("eventSubcategoryInput").value),
    event_date: document.getElementById("eventDateInput").value,
    title: document.getElementById("eventTitleInput").value.trim(),
    points: Number(document.getElementById("eventPointsInput").value || 0),
    comment: document.getElementById("eventCommentInput").value.trim() || null
  };

  if (!payload.title) return toast("Введите название события");

  if (state.selectedEvent) {
    await api(`/api/subcategory-events/${state.selectedEvent.id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    toast("Событие обновлено");
  } else {
    await api(`/api/classes/${state.selectedClass.id}/subcategory-events`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    toast("Событие добавлено");
  }

  await openClassDetail(state.selectedClass.id);
}

async function deleteEvent() {
  if (!state.selectedEvent) return;
  if (!confirmAction("Удалить событие?")) return;

  await api(`/api/subcategory-events/${state.selectedEvent.id}`, { method: "DELETE" });
  toast("Событие удалено");
  await openClassDetail(state.selectedClass.id);
}

function openUniformClassSelect() {
  renderUniformPalette();
  show("screenUniformClassSelect");
}

function renderUniformPalette() {
  document.getElementById("uniformPalette").innerHTML = state.ratings.map(row => {
    const checked = isUniformCheckedCurrentMonth(row);
    const latest = uniformLatestDate(row);

    return `
      <button class="uniform-tile ${checked ? "checked" : "unchecked"}" onclick="openUniform(${row.class_id})">
        <strong>${row.class_name}</strong>
        <span>${checked ? "Проверено" : "Не проверено"}</span>
        <small>${latest ? `Последняя: ${latest}` : "Проверок нет"}</small>
      </button>
    `;
  }).join("");
}

async function openUniform(classId = null) {
  if (classId) state.selectedClass = state.classes.find(c => c.id === classId);
  if (!state.selectedClass) return toast("Сначала выберите класс");

  document.getElementById("uniformTitle").textContent = `${state.selectedClass.name} класс`;
  state.uniform = await api(`/api/classes/${state.selectedClass.id}/uniform-checks`);

  const checked = state.uniform.is_checked_current_month;
  const statusCard = document.getElementById("uniformStatusCard");
  statusCard.classList.toggle("uniform-ok", checked);
  statusCard.classList.toggle("uniform-bad", !checked);
  document.getElementById("uniformStatusText").textContent = checked ? "Проверено" : "Не проверено";
  document.getElementById("uniformStatusSubtext").textContent = checked
    ? `Последняя проверка: ${state.uniform.latest_check_date}`
    : "В текущем месяце проверка ещё не заполнена";

  document.getElementById("uniformAverage").textContent = state.uniform.average_points || 0;
  document.getElementById("uniformChecksCount").textContent = state.uniform.checks_count || 0;

  document.getElementById("uniformDateInput").value = new Date().toISOString().slice(0, 10);
  document.getElementById("withoutUniformInput").value = 0;
  document.getElementById("uniformCommentInput").value = "";

  document.getElementById("uniformHistory").innerHTML = (state.uniform.checks || []).map(check => `
    <article class="item">
      <div>
        <h3>${check.check_date}</h3>
        <p>Без формы: ${check.without_uniform} · В форме: ${check.in_uniform} · ${check.percent_in_uniform}%</p>
        <p>Комментарий: ${check.comment || "—"}</p>
      </div>
      <div class="item-actions">
        <strong>${check.points}</strong>
        <button class="mini-danger" onclick="deleteUniformCheck(${check.id})">Удалить</button>
      </div>
    </article>
  `).join("");

  show("screenUniform");
}

async function saveUniform() {
  const payload = {
    check_date: document.getElementById("uniformDateInput").value,
    without_uniform: Number(document.getElementById("withoutUniformInput").value || 0),
    comment: document.getElementById("uniformCommentInput").value.trim() || null
  };

  await api(`/api/classes/${state.selectedClass.id}/uniform-checks`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  toast("Проверка формы добавлена");
  await loadBase();
  await openUniform(state.selectedClass.id);
}

async function deleteUniformCheck(id) {
  if (!confirmAction("Удалить проверку формы?")) return;
  await api(`/api/uniform-checks/${id}`, { method: "DELETE" });
  toast("Проверка удалена");
  await loadBase();
  await openUniform(state.selectedClass.id);
}

function renderCategories() {
  document.getElementById("categoriesList").innerHTML = state.categories.map(cat => `
    <article class="category-card">
      <div class="category-top">
        <div>
          <h3>${cat.name}</h3>
          <p>Максимум: ${cat.max_points} баллов · порядок: ${cat.sort_order}</p>
        </div>
        <button class="mini" onclick="openCategoryForm(${cat.id})">Изменить</button>
      </div>
      <div class="sub-list">
        ${(cat.subcategories || []).map(sub => `
          <div class="sub-item">
            <div>
              <b>${sub.code ? `${sub.code} · ` : ""}${sub.name}</b>
              <small>до ${sub.max_points} · ${sub.formula_code || "ручные баллы"}${sub.target != null ? ` · цель ${sub.target} ${sub.unit || ""}` : ""}</small>
              ${sub.measurement ? `<p class="criterion-description">${sub.measurement}</p>` : ""}
              ${sub.scoring_rule ? `<p class="criterion-formula">${sub.scoring_rule}</p>` : ""}
            </div>
            <button class="mini" onclick="openSubcategoryForm(${sub.id})">Изменить</button>
          </div>
        `).join("") || `<p class="empty">Подкатегорий нет</p>`}
      </div>
      <button class="secondary full" onclick="openSubcategoryForm(null, ${cat.id})">+ Критерий</button>
    </article>
  `).join("");
}

function openCategories() {
  state.selectedCategory = null;
  state.selectedSubcategory = null;
  renderCategories();
  show("screenCategories");
}

function openCategoryForm(id = null) {
  state.selectedCategory = id ? state.categories.find(c => c.id === id) : null;

  document.getElementById("categoryFormTitle").textContent = id ? "Редактировать" : "Добавить";
  document.getElementById("categoryNameInput").value = state.selectedCategory?.name || "";
  document.getElementById("categoryMaxInput").value = state.selectedCategory?.max_points || 100;
  document.getElementById("categorySortInput").value = state.selectedCategory?.sort_order || 0;
  document.getElementById("deleteCategoryBtn").classList.toggle("hidden", !id);

  show("screenCategoryForm");
}

async function saveCategory() {
  const payload = {
    name: document.getElementById("categoryNameInput").value.trim(),
    max_points: Number(document.getElementById("categoryMaxInput").value || 100),
    sort_order: Number(document.getElementById("categorySortInput").value || 0)
  };

  if (!payload.name) return toast("Введите название категории");

  if (state.selectedCategory) {
    await api(`/api/categories/${state.selectedCategory.id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    toast("Категория обновлена");
  } else {
    await api("/api/categories", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    toast("Категория добавлена");
  }

  await loadBase();
  openCategories();
}

async function deleteCategory() {
  if (!state.selectedCategory) return;
  if (!confirmAction("Удалить категорию и её подкатегории?")) return;

  await api(`/api/categories/${state.selectedCategory.id}`, { method: "DELETE" });
  toast("Категория удалена");
  await loadBase();
  openCategories();
}

function openSubcategoryForm(id = null, categoryId = null) {
  state.selectedSubcategory = null;

  for (const cat of state.categories) {
    const found = (cat.subcategories || []).find(s => s.id === id);
    if (found) state.selectedSubcategory = found;
  }

  document.getElementById("subcategoryFormTitle").textContent = id ? "Редактировать" : "Добавить";

  const select = document.getElementById("subcategoryCategoryInput");
  select.innerHTML = state.categories
    .map(c => `<option value="${c.id}">${c.name}</option>`)
    .join("");

  select.value = state.selectedSubcategory?.category_id || categoryId || state.categories[0]?.id || "";

  document.getElementById("subcategoryNameInput").value = state.selectedSubcategory?.name || "";
  document.getElementById("subcategoryCodeInput").value = state.selectedSubcategory?.code || "";
  document.getElementById("subcategoryFormulaInput").value = state.selectedSubcategory?.formula_code || "";
  document.getElementById("subcategoryTargetInput").value = state.selectedSubcategory?.target ?? "";
  document.getElementById("subcategoryUnitInput").value = state.selectedSubcategory?.unit || "";
  document.getElementById("subcategoryMeasurementInput").value = state.selectedSubcategory?.measurement || "";
  document.getElementById("subcategoryScoringRuleInput").value = state.selectedSubcategory?.scoring_rule || "";
  document.getElementById("subcategoryPeriodicityInput").value = state.selectedSubcategory?.periodicity || "";
  document.getElementById("subcategoryMaxInput").value = state.selectedSubcategory?.max_points || 10;
  document.getElementById("subcategorySortInput").value = state.selectedSubcategory?.sort_order || 0;
  document.getElementById("deleteSubcategoryBtn").classList.toggle("hidden", !id);

  show("screenSubcategoryForm");
}

async function saveSubcategory() {
  const payload = {
    category_id: Number(document.getElementById("subcategoryCategoryInput").value),
    name: document.getElementById("subcategoryNameInput").value.trim(),
    code: document.getElementById("subcategoryCodeInput").value.trim() || null,
    formula_code: document.getElementById("subcategoryFormulaInput").value || null,
    target: document.getElementById("subcategoryTargetInput").value === "" ? null : Number(document.getElementById("subcategoryTargetInput").value),
    unit: document.getElementById("subcategoryUnitInput").value.trim() || null,
    measurement: document.getElementById("subcategoryMeasurementInput").value.trim() || null,
    scoring_rule: document.getElementById("subcategoryScoringRuleInput").value.trim() || null,
    periodicity: document.getElementById("subcategoryPeriodicityInput").value.trim() || null,
    max_points: Number(document.getElementById("subcategoryMaxInput").value || 10),
    sort_order: Number(document.getElementById("subcategorySortInput").value || 0)
  };

  if (!payload.name) return toast("Введите название подкатегории");

  if (state.selectedSubcategory) {
    await api(`/api/subcategories/${state.selectedSubcategory.id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    toast("Критерий обновлён");
  } else {
    await api("/api/subcategories", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    toast("Критерий добавлен");
  }

  await loadBase();
  openCategories();
}

async function deleteSubcategory() {
  if (!state.selectedSubcategory) return;
  if (!confirmAction("Удалить критерий?")) return;

  await api(`/api/subcategories/${state.selectedSubcategory.id}`, { method: "DELETE" });
  toast("Критерий удалён");
  await loadBase();
  openCategories();
}

async function openAllRating() {
  const rating = await api("/api/ratings/classes");

  document.getElementById("allRatingList").innerHTML = rating.map((row, index) => `
    <button class="item" onclick="openClassDetail(${row.class_id})">
      <div>
        <h3>${index + 1}. ${row.class_name} класс</h3>
        <p>Учеников: ${row.students_count || 0}</p>
      </div>
      <strong>${row.total || 0}</strong>
    </button>
  `).join("");

  show("screenAllRating");
}

document.getElementById("openAdminBtn").addEventListener("click", () => {
  document.getElementById("app").classList.add("opening");
  setTimeout(() => show("screenHome"), 650);
  setTimeout(() => document.getElementById("app").classList.remove("opening"), 1200);
});

document.getElementById("uniformAlertBtn").addEventListener("click", openUniformClassSelect);
document.getElementById("quickClasses").addEventListener("click", () => show("screenGroups"));
document.getElementById("quickUniform").addEventListener("click", openUniformClassSelect);
document.getElementById("quickDirections").addEventListener("click", openDirections);
document.getElementById("quickCategories").addEventListener("click", openCategories);
document.getElementById("quickAddClass").addEventListener("click", () => show("screenClassForm"));
document.getElementById("quickAllRating").addEventListener("click", openAllRating);

document.querySelectorAll(".group-card").forEach(btn => {
  btn.addEventListener("click", () => openGroup(btn.dataset.group));
});

document.querySelectorAll(".back").forEach(btn => {
  btn.addEventListener("click", () => show(btn.dataset.target));
});

document.getElementById("saveClassBtn").addEventListener("click", saveClass);
document.getElementById("deleteClassBtn").addEventListener("click", deleteClass);
document.getElementById("createClassBtn").addEventListener("click", createClass);
document.getElementById("openEventFormBtn").addEventListener("click", () => openEventForm());
document.getElementById("saveEventBtn").addEventListener("click", saveEvent);
document.getElementById("deleteEventBtn").addEventListener("click", deleteEvent);
document.getElementById("eventSubcategoryInput").addEventListener("change", renderEventFormula);
document.getElementById("calculateEventPointsBtn").addEventListener("click", calculateEventPoints);
document.getElementById("openUniformFromClassBtn").addEventListener("click", () => openUniform(state.selectedClass.id));
document.getElementById("saveUniformBtn").addEventListener("click", saveUniform);
document.getElementById("addCategoryBtn").addEventListener("click", () => openCategoryForm());
document.getElementById("saveCategoryBtn").addEventListener("click", saveCategory);
document.getElementById("deleteCategoryBtn").addEventListener("click", deleteCategory);
document.getElementById("saveSubcategoryBtn").addEventListener("click", saveSubcategory);
document.getElementById("deleteSubcategoryBtn").addEventListener("click", deleteSubcategory);
document.getElementById("openCriteriaSettingsBtn").addEventListener("click", openCategories);

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await loadBase();
  toast("Обновлено");
});

loadBase().catch(error => {
  console.error(error);
  toast("Ошибка загрузки API");
});
