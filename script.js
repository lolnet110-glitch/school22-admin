const API_BASE = "https://school22-rating-api.onrender.com";

let state = {
  groupId: null,
  selectedClass: null,
  selectedStudent: null,
  classes: [],
  students: [],
  allStudents: [],
  categories: []
};

async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

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
  try {
    state.classes = await api("/api/classes");
    state.categories = await api("/api/categories");
    fillClassSelects();
    fillCategorySelect();
  } catch (error) {
    toast("Ошибка загрузки API");
    console.error(error);
  }
}

function fillClassSelects() {
  const html = state.classes.map(cls => `
    <option value="${cls.id}">${cls.name} класс</option>
  `).join("");

  document.getElementById("studentClassSelect").innerHTML = html;
}

function fillCategorySelect() {
  document.getElementById("subcategoryCategorySelect").innerHTML = state.categories.map(cat => `
    <option value="${cat.id}">${cat.name}</option>
  `).join("");
}

function openGroup(groupId) {
  state.groupId = groupId === "all" ? "all" : Number(groupId);
  document.getElementById("classesTitle").textContent = groupName(state.groupId);

  const classes = state.groupId === "all"
    ? state.classes
    : state.classes.filter(c => c.group_id === state.groupId);

  document.getElementById("classesList").innerHTML = classes.map(cls => `
    <button class="item" onclick="openClass(${cls.id})">
      <div>
        <h3>${cls.name} класс</h3>
        <p>${cls.group_name || ""}</p>
      </div>
      <strong>›</strong>
    </button>
  `).join("");

  show("screenClasses");
}

async function openClass(classId) {
  state.selectedClass = state.classes.find(c => c.id === classId);
  document.getElementById("studentsTitle").textContent = `${state.selectedClass.name} класс`;

  try {
    state.students = await api(`/api/classes/${classId}/students`);
  } catch (error) {
    state.students = [];
    console.error(error);
  }

  renderStudents();
  show("screenStudents");
}

function renderStudents() {
  const list = document.getElementById("studentsList");
  list.innerHTML = state.students.map(student => `
    <button class="item" onclick="openScores(${student.id})">
      <div>
        <h3>${student.full_name}</h3>
        <p>${student.class_name || state.selectedClass.name} класс</p>
      </div>
      <strong>${student.total_score || 0}</strong>
    </button>
  `).join("");
}

async function openAllStudents() {
  const result = [];
  for (const cls of state.classes) {
    try {
      const students = await api(`/api/classes/${cls.id}/students`);
      students.forEach(s => result.push(s));
    } catch (e) {}
  }

  state.allStudents = result;

  document.getElementById("allStudentsList").innerHTML = result.map(student => `
    <button class="item" onclick="openStudentFromAll(${student.id}, '${student.class_name}')">
      <div>
        <h3>${student.full_name}</h3>
        <p>${student.class_name} класс</p>
      </div>
      <strong>${student.total_score || 0}</strong>
    </button>
  `).join("");

  show("screenAllStudents");
}

function openStudentFromAll(studentId, className) {
  const cls = state.classes.find(c => c.name === className);
  state.selectedClass = cls;
  state.students = state.allStudents.filter(s => s.class_name === className);
  openScores(studentId);
}

function openStudentForm(classId = null) {
  document.getElementById("studentFormTitle").textContent = "Добавить ученика";
  document.getElementById("studentNameInput").value = "";

  if (classId || state.selectedClass) {
    document.getElementById("studentClassSelect").value = classId || state.selectedClass.id;
  }

  show("screenStudentForm");
}

async function saveStudent() {
  const name = document.getElementById("studentNameInput").value.trim();
  const classId = Number(document.getElementById("studentClassSelect").value);

  if (!name) {
    toast("Введите ФИО ученика");
    return;
  }

  try {
    await api("/api/students", {
      method: "POST",
      body: JSON.stringify({
        full_name: name,
        class_id: classId
      })
    });

    toast("Ученик добавлен");
    await loadBase();
    const cls = state.classes.find(c => c.id === classId);
    state.selectedClass = cls;
    await openClass(classId);
  } catch (error) {
    toast("Ошибка сохранения ученика");
    console.error(error);
  }
}

function openScores(studentId) {
  state.selectedStudent = [...state.students, ...state.allStudents].find(s => s.id === studentId);
  document.getElementById("scoresStudentName").textContent = state.selectedStudent.full_name;

  document.getElementById("scoresList").innerHTML = state.categories.map(category => `
    <section class="score-card">
      <h3>${category.name}</h3>
      ${(category.subcategories || []).map(sub => `
        <div class="sub-score">
          <div>
            <span>${sub.name}</span>
            <small>до ${sub.max_points} баллов</small>
          </div>
          <input type="number" min="0" max="${sub.max_points}" value="0" data-subcategory="${sub.id}" />
        </div>
      `).join("")}
    </section>
  `).join("");

  show("screenScores");
}

async function saveScores() {
  const inputs = [...document.querySelectorAll("[data-subcategory]")];

  try {
    for (const input of inputs) {
      const subcategoryId = Number(input.dataset.subcategory);
      const points = Number(input.value || 0);

      await api(`/api/students/${state.selectedStudent.id}/scores/${subcategoryId}`, {
        method: "PUT",
        body: JSON.stringify({ points })
      });
    }

    toast("Баллы сохранены");
    await openClass(state.selectedClass.id);
  } catch (error) {
    toast("Ошибка сохранения баллов");
    console.error(error);
  }
}

function renderCategories() {
  document.getElementById("categoriesList").innerHTML = state.categories.map(category => `
    <article class="category-card">
      <h3>${category.name}</h3>
      <ul>
        ${(category.subcategories || []).map(sub => `<li>${sub.name} — до ${sub.max_points}</li>`).join("")}
      </ul>
    </article>
  `).join("");
}

function openCategories() {
  renderCategories();
  show("screenCategories");
}

function openCategoryForm() {
  document.getElementById("categoryNameInput").value = "";
  document.getElementById("categoryMaxInput").value = 100;
  show("screenCategoryForm");
}

async function saveCategory() {
  const name = document.getElementById("categoryNameInput").value.trim();
  const max = Number(document.getElementById("categoryMaxInput").value || 100);

  if (!name) {
    toast("Введите название категории");
    return;
  }

  try {
    await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({
        name: name,
        max_points: max,
        sort_order: state.categories.length + 1
      })
    });

    toast("Категория добавлена");
  } catch (error) {
    toast("Ошибка добавления категории");
    console.error(error);
    return;
  }

  try {
    await loadBase();
    openCategories();
  } catch (error) {
    console.warn("Категория сохранена, но список не обновился автоматически", error);
    show("screenHome");
  }
}

function openSubcategoryForm() {
  fillCategorySelect();
  document.getElementById("subcategoryNameInput").value = "";
  document.getElementById("subcategoryMaxInput").value = 10;
  show("screenSubcategoryForm");
}

async function saveSubcategory() {
  const categoryId = Number(document.getElementById("subcategoryCategorySelect").value);
  const name = document.getElementById("subcategoryNameInput").value.trim();
  const max = Number(document.getElementById("subcategoryMaxInput").value || 10);

  if (!name) {
    toast("Введите название подкатегории");
    return;
  }

  try {
    await api("/api/subcategories", {
      method: "POST",
      body: JSON.stringify({
        category_id: categoryId,
        name: name,
        max_points: max,
        sort_order: 99
      })
    });

    toast("Подкатегория добавлена");
  } catch (error) {
    toast("Ошибка добавления подкатегории");
    console.error(error);
    return;
  }

  try {
    await loadBase();
    openCategories();
  } catch (error) {
    console.warn("Подкатегория сохранена, но список не обновился автоматически", error);
    show("screenHome");
  }
}

document.querySelectorAll(".group-card").forEach(btn => {
  btn.addEventListener("click", () => openGroup(btn.dataset.group));
});

document.querySelectorAll(".back").forEach(btn => {
  btn.addEventListener("click", () => show(btn.dataset.target));
});

document.getElementById("quickClasses").addEventListener("click", () => show("screenGroups"));
document.getElementById("quickCategories").addEventListener("click", openCategories);
document.getElementById("quickAddCategory").addEventListener("click", openCategoryForm);
document.getElementById("quickAddSubcategory").addEventListener("click", openSubcategoryForm);
document.getElementById("quickAllStudents").addEventListener("click", openAllStudents);
document.getElementById("quickAddStudent").addEventListener("click", () => openStudentForm());

document.getElementById("addStudentBtn").addEventListener("click", () => openStudentForm());
document.getElementById("allAddStudentBtn").addEventListener("click", () => openStudentForm());
document.getElementById("studentFormBack").addEventListener("click", () => show(state.selectedClass ? "screenStudents" : "screenHome"));
document.getElementById("saveStudentBtn").addEventListener("click", saveStudent);
document.getElementById("saveScoresBtn").addEventListener("click", saveScores);
document.getElementById("addCategoryBtn").addEventListener("click", openCategoryForm);
document.getElementById("addSubcategoryBtn").addEventListener("click", openSubcategoryForm);
document.getElementById("saveCategoryBtn").addEventListener("click", saveCategory);
document.getElementById("saveSubcategoryBtn").addEventListener("click", saveSubcategory);

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await loadBase();
  toast("Обновлено");
});

loadBase();
