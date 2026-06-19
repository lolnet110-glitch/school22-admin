const API_BASE = "https://school22-rating-api.onrender.com";

let state = {
  groupId: null,
  selectedClass: null,
  classes: [],
  categories: [],
  classScores: [],
  uniform: null
};

async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function show(screenId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2300);
}

function groupName(id) {
  if (id === "all") return "Все классы";
  if (id === 1) return "Начальная школа";
  if (id === 2) return "Средняя школа";
  return "Старшая школа";
}

async function loadBase() {
  state.classes = await api("/api/classes");
  state.categories = await api("/api/categories");
}

function openGroup(groupId) {
  state.groupId = groupId === "all" ? "all" : Number(groupId);
  document.getElementById("classesTitle").textContent = groupName(state.groupId);

  const classes = state.groupId === "all"
    ? state.classes
    : state.classes.filter(c => c.group_id === state.groupId);

  renderClassList("classesList", classes);
  show("screenClasses");
}

function renderClassList(containerId, classes) {
  document.getElementById(containerId).innerHTML = classes.map(cls => `
    <button class="item" onclick="openClassDetail(${cls.id})">
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
  document.getElementById("classDetailTitle").textContent = `${state.selectedClass.name} класс`;
  document.getElementById("studentsCountInput").value = state.selectedClass.students_count || 0;

  state.classScores = await api(`/api/classes/${classId}/category-scores`);

  document.getElementById("classScoresList").innerHTML = state.classScores.map(cat => {
    const isUniform = cat.name.toLowerCase().includes("форма");
    return `
      <section class="score-card">
        <div class="score-row">
          <div>
            <span>${cat.name}</span>
            <small>${isUniform ? "считается автоматически" : "до " + cat.max_points + " баллов"}</small>
          </div>
          <input 
            type="number" 
            min="0" 
            max="${cat.max_points}" 
            value="${cat.points || 0}"
            data-category="${cat.id}"
            ${isUniform ? "disabled" : ""}
          />
        </div>
      </section>
    `;
  }).join("");

  show("screenClassDetail");
}

async function saveClass() {
  const studentsCount = Number(document.getElementById("studentsCountInput").value || 0);
  await api(`/api/classes/${state.selectedClass.id}`, {
    method: "PUT",
    body: JSON.stringify({ students_count: studentsCount })
  });
  toast("Класс обновлён");
  await loadBase();
  state.selectedClass = state.classes.find(c => c.id === state.selectedClass.id);
}

async function saveClassScores() {
  const inputs = [...document.querySelectorAll("[data-category]")].filter(input => !input.disabled);

  for (const input of inputs) {
    const categoryId = Number(input.dataset.category);
    const points = Number(input.value || 0);
    await api(`/api/classes/${state.selectedClass.id}/category-scores/${categoryId}`, {
      method: "PUT",
      body: JSON.stringify({ points })
    });
  }

  toast("Рейтинг класса сохранён");
  await openClassDetail(state.selectedClass.id);
}

function openUniformClassSelect() {
  renderClassList("uniformClassesList", state.classes);
  show("screenUniformClassSelect");
}

async function openUniform(classId = null) {
  if (classId) {
    state.selectedClass = state.classes.find(c => c.id === classId);
  }

  document.getElementById("uniformTitle").textContent = `${state.selectedClass.name} класс`;
  state.uniform = await api(`/api/classes/${state.selectedClass.id}/uniform-checks`);

  document.getElementById("uniformAverage").textContent = state.uniform.average_points || 0;
  document.getElementById("uniformChecksCount").textContent = state.uniform.checks_count || 0;

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("uniformDateInput").value = today;
  document.getElementById("withoutUniformInput").value = 0;
  document.getElementById("uniformCommentInput").value = "";

  document.getElementById("uniformHistory").innerHTML = (state.uniform.checks || []).map(check => `
    <article class="item">
      <div>
        <h3>${check.check_date}</h3>
        <p>Без формы: ${check.without_uniform} · В форме: ${check.in_uniform} · ${check.percent_in_uniform}%</p>
      </div>
      <strong>${check.points}</strong>
    </article>
  `).join("");

  show("screenUniform");
}

async function saveUniform() {
  const check_date = document.getElementById("uniformDateInput").value;
  const without_uniform = Number(document.getElementById("withoutUniformInput").value || 0);
  const comment = document.getElementById("uniformCommentInput").value.trim() || null;

  await api(`/api/classes/${state.selectedClass.id}/uniform-checks`, {
    method: "POST",
    body: JSON.stringify({ check_date, without_uniform, comment })
  });

  toast("Проверка формы добавлена");
  await openUniform();
}

function renderCategories() {
  document.getElementById("categoriesList").innerHTML = state.categories.map(cat => `
    <article class="category-card">
      <h3>${cat.name}</h3>
      <p>Максимум: ${cat.max_points} баллов</p>
    </article>
  `).join("");
}

function openCategories() {
  renderCategories();
  show("screenCategories");
}

async function saveCategory() {
  const name = document.getElementById("categoryNameInput").value.trim();
  const max_points = Number(document.getElementById("categoryMaxInput").value || 10);

  if (!name) {
    toast("Введите название категории");
    return;
  }

  await api("/api/categories", {
    method: "POST",
    body: JSON.stringify({
      name,
      max_points,
      sort_order: state.categories.length + 1
    })
  });

  toast("Категория добавлена");
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

document.getElementById("openAdminBtn").addEventListener("click", () => show("screenHome"));
document.getElementById("quickClasses").addEventListener("click", () => show("screenGroups"));
document.getElementById("quickUniform").addEventListener("click", openUniformClassSelect);
document.getElementById("quickCategories").addEventListener("click", openCategories);
document.getElementById("quickAllRating").addEventListener("click", openAllRating);

document.querySelectorAll(".group-card").forEach(btn => {
  btn.addEventListener("click", () => openGroup(btn.dataset.group));
});

document.querySelectorAll(".back").forEach(btn => {
  btn.addEventListener("click", () => show(btn.dataset.target));
});

document.getElementById("saveClassBtn").addEventListener("click", saveClass);
document.getElementById("saveClassScoresBtn").addEventListener("click", saveClassScores);
document.getElementById("openUniformFromClassBtn").addEventListener("click", () => openUniform());
document.getElementById("saveUniformBtn").addEventListener("click", saveUniform);
document.getElementById("addCategoryBtn").addEventListener("click", () => show("screenCategoryForm"));
document.getElementById("saveCategoryBtn").addEventListener("click", saveCategory);

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await loadBase();
  toast("Обновлено");
});

loadBase().catch(error => {
  console.error(error);
  toast("Ошибка загрузки API");
});
