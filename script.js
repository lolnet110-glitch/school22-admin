const API_BASE = "https://school22-rating-api.onrender.com";

let state = {
  groupId: null,
  selectedClass: null,
  selectedCategory: null,
  selectedSubcategory: null,
  selectedEvent: null,
  classes: [],
  categories: [],
  ratings: [],
  classScores: [],
  classEvents: [],
  uniform: null
};

async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
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

function isUniformCheckedCurrentMonth(row) {
  const uniform = (row.categories || []).find(cat => cat.name.toLowerCase().includes("форма"));
  return Boolean(uniform?.uniform_summary?.is_checked_current_month);
}

function uniformLatestDate(row) {
  const uniform = (row.categories || []).find(cat => cat.name.toLowerCase().includes("форма"));
  return uniform?.uniform_summary?.latest_check_date || null;
}

async function loadBase() {
  state.classes = await api("/api/classes");
  state.categories = await api("/api/categories");
  state.ratings = await api("/api/ratings/classes");
  renderUniformAlert();
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
  state.selectedClass = state.classes.find(c => c.id === classId);
  if (!state.selectedClass) return toast("Класс не найден");

  document.getElementById("classDetailTitle").textContent = `${state.selectedClass.name} класс`;
  document.getElementById("classNameInput").value = state.selectedClass.name || "";
  document.getElementById("classGradeInput").value = state.selectedClass.grade || 1;
  document.getElementById("classGroupInput").value = state.selectedClass.group_id || 1;
  document.getElementById("studentsCountInput").value = state.selectedClass.students_count || 0;

  state.classScores = await api(`/api/classes/${classId}/category-scores`);
  state.classEvents = await api(`/api/classes/${classId}/subcategory-events`);

  renderClassScores();
  show("screenClassDetail");
}

function renderClassScores() {
  document.getElementById("classScoresList").innerHTML = state.classScores.map(cat => {
    const isUniform = cat.name.toLowerCase().includes("форма");

    if (isUniform) {
      const checked = cat.uniform_summary?.is_checked_current_month;
      return `
        <section class="score-card ${checked ? "uniform-ok" : "uniform-bad"}">
          <h3>${cat.name}</h3>
          <p>${checked ? "Проверено в текущем месяце" : "В текущем месяце не проверено"}</p>
          <div class="big-score">${cat.points || 0}</div>
        </section>
      `;
    }

    return `
      <section class="score-card">
        <h3>${cat.name} <em>${cat.points || 0}/${cat.max_points}</em></h3>
        <p>${cat.maxed ? `Лимит категории достигнут: ${cat.raw_points} → ${cat.points}` : "Баллы складываются из событий"}</p>
        ${(cat.subcategories || []).map(sub => `
          <div class="sub-block">
            <div class="sub-head">
              <div>
                <b>${sub.name}</b>
                <small>${sub.maxed ? `Лимит: ${sub.raw_points} → ${sub.points}` : `до ${sub.max_points} баллов`}</small>
              </div>
              <button class="mini" onclick="openEventForm(null, ${sub.id})">+ событие</button>
            </div>
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
    `;
  }).join("");
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
    if (cat.name.toLowerCase().includes("форма")) return;
    (cat.subcategories || []).forEach(sub => {
      options.push(`<option value="${sub.id}">${cat.name} → ${sub.name} (до ${sub.max_points})</option>`);
    });
  });

  select.innerHTML = options.join("");
  if (selectedSubcategoryId) select.value = String(selectedSubcategoryId);
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
              <b>${sub.name}</b>
              <small>до ${sub.max_points} · порядок: ${sub.sort_order}</small>
            </div>
            <button class="mini" onclick="openSubcategoryForm(${sub.id})">Изменить</button>
          </div>
        `).join("") || `<p class="empty">Подкатегорий нет</p>`}
      </div>
      ${cat.name.toLowerCase().includes("форма") ? "" : `<button class="secondary full" onclick="openSubcategoryForm(null, ${cat.id})">+ Подкатегория</button>`}
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
    .filter(c => !c.name.toLowerCase().includes("форма"))
    .map(c => `<option value="${c.id}">${c.name}</option>`)
    .join("");

  select.value = state.selectedSubcategory?.category_id || categoryId || state.categories[0]?.id || "";

  document.getElementById("subcategoryNameInput").value = state.selectedSubcategory?.name || "";
  document.getElementById("subcategoryMaxInput").value = state.selectedSubcategory?.max_points || 10;
  document.getElementById("subcategorySortInput").value = state.selectedSubcategory?.sort_order || 0;
  document.getElementById("deleteSubcategoryBtn").classList.toggle("hidden", !id);

  show("screenSubcategoryForm");
}

async function saveSubcategory() {
  const payload = {
    category_id: Number(document.getElementById("subcategoryCategoryInput").value),
    name: document.getElementById("subcategoryNameInput").value.trim(),
    max_points: Number(document.getElementById("subcategoryMaxInput").value || 10),
    sort_order: Number(document.getElementById("subcategorySortInput").value || 0)
  };

  if (!payload.name) return toast("Введите название подкатегории");

  if (state.selectedSubcategory) {
    await api(`/api/subcategories/${state.selectedSubcategory.id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    toast("Подкатегория обновлена");
  } else {
    await api("/api/subcategories", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    toast("Подкатегория добавлена");
  }

  await loadBase();
  openCategories();
}

async function deleteSubcategory() {
  if (!state.selectedSubcategory) return;
  if (!confirmAction("Удалить подкатегорию?")) return;

  await api(`/api/subcategories/${state.selectedSubcategory.id}`, { method: "DELETE" });
  toast("Подкатегория удалена");
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
document.getElementById("openUniformFromClassBtn").addEventListener("click", () => openUniform(state.selectedClass.id));
document.getElementById("saveUniformBtn").addEventListener("click", saveUniform);
document.getElementById("addCategoryBtn").addEventListener("click", () => openCategoryForm());
document.getElementById("saveCategoryBtn").addEventListener("click", saveCategory);
document.getElementById("deleteCategoryBtn").addEventListener("click", deleteCategory);
document.getElementById("saveSubcategoryBtn").addEventListener("click", saveSubcategory);
document.getElementById("deleteSubcategoryBtn").addEventListener("click", deleteSubcategory);

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await loadBase();
  toast("Обновлено");
});

loadBase().catch(error => {
  console.error(error);
  toast("Ошибка загрузки API");
});