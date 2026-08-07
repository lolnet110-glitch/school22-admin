const API_BASE = new URLSearchParams(window.location.search).get("api")
  || "https://school22-rating-api.onrender.com";

const state = {
  meta: null,
  classes: [],
  directions: [],
  ratings: [],
  selectedClass: null,
  selectedDetails: null,
  selectedCriterion: null,
  currentGroup: "all"
};

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options) {
  const response = await fetch(API_BASE + path, Object.assign({
    headers: {"Content-Type": "application/json"}
  }, options || {}));
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data && data.detail ? data.detail : "Ошибка API: " + response.status);
  }
  return data;
}

function show(screenId) {
  document.querySelectorAll(".screen").forEach(function (screen) {
    screen.classList.toggle("active", screen.id === screenId);
  });
  window.scrollTo({top: 0, behavior: "smooth"});
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () {
    element.classList.remove("show");
  }, 2600);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function groupName(groupId) {
  if (String(groupId) === "all") return "Все классы";
  if (Number(groupId) === 1) return "Начальная школа";
  if (Number(groupId) === 2) return "Средняя школа";
  return "Старшая школа";
}

async function loadBase() {
  const result = await Promise.all([
    api("/api/meta"),
    api("/api/classes"),
    api("/api/directions"),
    api("/api/ratings/classes")
  ]);
  state.meta = result[0];
  state.classes = result[1];
  state.directions = result[2];
  state.ratings = result[3];
  document.getElementById("matrixVersion").textContent = "матрица v" + state.meta.matrix_version;
  document.getElementById("activeYear").textContent = state.meta.academic_year;
  renderUniformAlert();
}

function ratingForClass(classId) {
  return state.ratings.find(function (row) {
    return row.class_id === classId;
  });
}

function uniformSummary(classId) {
  const rating = ratingForClass(classId) || {};
  return rating.uniform || {points: 0, checks_count: 0, checks_remaining: 4};
}

function renderUniformAlert() {
  const unchecked = state.classes.filter(function (item) {
    return Number(uniformSummary(item.id).checks_count || 0) === 0;
  });
  const button = document.getElementById("uniformAlertBtn");
  button.classList.toggle("hidden", unchecked.length === 0);
  document.getElementById("uniformAlertTitle").textContent = unchecked.length
    ? "Нет проверки школьной формы: " + unchecked.length + " классов"
    : "Школьная форма проверена";
  document.getElementById("uniformAlertText").textContent =
    "Откройте палитру: по матрице допускается до 4 общих срезов за учебный год";
}

function renderClassList() {
  const classes = state.currentGroup === "all"
    ? state.classes
    : state.classes.filter(function (item) {
        return item.group_id === Number(state.currentGroup);
      });
  document.getElementById("classesTitle").textContent = groupName(state.currentGroup);
  document.getElementById("classesList").innerHTML = classes.map(function (item) {
    const rating = ratingForClass(item.id) || {};
    return '<button class="item clickable" onclick="openClassDetail(' + item.id + ')">' +
      '<div><h3>' + escapeHtml(item.name) + ' класс</h3>' +
      '<p>' + Number(item.students_count || 0) + ' учеников · заполнено ' +
      round(rating.progress_percent) + '%</p></div>' +
      '<strong>' + round(rating.total) + '</strong></button>';
  }).join("") || '<p class="notice">В этом блоке пока нет классов.</p>';
}

async function openClassDetail(classId) {
  state.selectedClass = state.classes.find(function (item) {
    return item.id === classId;
  });
  if (!state.selectedClass) return;
  state.selectedDetails = await api("/api/classes/" + classId + "/details");
  const rating = state.selectedDetails.class;
  document.getElementById("classDetailTitle").textContent = state.selectedClass.name + " класс";
  document.getElementById("classTotal").textContent = round(rating.total);
  document.getElementById("classProgress").textContent = round(rating.progress_percent) + "%";
  document.getElementById("classProgressText").textContent =
    rating.completed_criteria + " из " + rating.applicable_criteria;
  document.getElementById("classNameInput").value = state.selectedClass.name;
  document.getElementById("classGradeInput").value = state.selectedClass.grade;
  document.getElementById("classGroupInput").value = state.selectedClass.group_id;
  document.getElementById("studentsCountInput").value = state.selectedClass.students_count;
  renderDirectionScores(rating.directions);
  show("screenClassDetail");
}

function renderDirectionScores(directions) {
  document.getElementById("directionScores").innerHTML = directions.map(function (direction, index) {
    const criteria = (direction.criteria || []).map(function (criterion) {
      const target = criterion.target + " " + criterion.unit;
      const action = criterion.code === "КР-08.01" || criterion.code === "КР-08.02"
        ? "openUniform(" + state.selectedClass.id + ")"
        : "openMeasurement('" + criterion.code + "')";
      const points = criterion.applicable === false ? "N/A" : round(criterion.points);
      return '<button class="criterion-row" onclick="' + action + '">' +
        '<span><b>' + escapeHtml(criterion.code + " · " + criterion.name) + '</b>' +
        '<small>' + escapeHtml(criterion.formula_code + " · цель " + target +
        " · " + criterion.capture_mode) + '</small></span>' +
        '<span class="criterion-points">' + points + ' / 10</span></button>';
    }).join("");
    return '<details class="direction-card"' + (index === 0 ? " open" : "") + '>' +
      '<summary><span class="direction-number">' + direction.number + '</span>' +
      '<span><h3>' + escapeHtml(direction.name) + '</h3><p>' +
      direction.completed_criteria + ' из ' + direction.applicable_criteria +
      ' критериев заполнено</p></span>' +
      '<span class="direction-score">' +
      (direction.points == null ? "N/A" : round(direction.points)) + '</span></summary>' +
      '<div class="criteria">' + criteria + '</div></details>';
  }).join("");
}

function findCriterion(code) {
  if (!state.selectedDetails) return null;
  for (const direction of state.selectedDetails.class.directions || []) {
    const found = (direction.criteria || []).find(function (criterion) {
      return criterion.code === code;
    });
    if (found) return found;
  }
  return null;
}

function fieldControl(field, label, formulaCode) {
  if (formulaCode === "ФАКТ" && field === "fact_score") {
    return '<label>' + escapeHtml(label) +
      '<select data-input-field="' + field + '">' +
      '<option value="0">0 — не выполнено</option>' +
      '<option value="5">5 — выполнено частично</option>' +
      '<option value="10">10 — выполнено полностью</option>' +
      '</select></label>';
  }
  return '<label>' + escapeHtml(label) +
    '<input type="number" min="0" step="0.01" data-input-field="' + field + '"></label>';
}

function openMeasurement(code) {
  const criterion = findCriterion(code);
  if (!criterion) return;
  state.selectedCriterion = criterion;
  document.getElementById("measurementCode").textContent = criterion.code;
  document.getElementById("measurementTitle").textContent = criterion.name;
  document.getElementById("measurementDate").value = today();
  document.getElementById("measurementNA").checked = false;
  document.getElementById("measurementComment").value = "";
  document.getElementById("measurementEvidence").value = "";
  document.getElementById("criterionInfo").innerHTML =
    '<h3>' + escapeHtml(criterion.measurement) + '</h3>' +
    '<p><b>Расчёт:</b> ' + escapeHtml(criterion.scoring_rule) + '</p>' +
    '<p><b>Источник:</b> ' + escapeHtml(criterion.primary_source) + '</p>' +
    '<div class="chips"><span class="chip">' + escapeHtml(criterion.formula_code) + '</span>' +
    '<span class="chip">цель ' + escapeHtml(criterion.target + " " + criterion.unit) + '</span>' +
    '<span class="chip">' + escapeHtml(criterion.capture_mode) + '</span>' +
    '<span class="chip">' + escapeHtml(criterion.data_owner) + '</span></div>';

  const schema = criterion.input_schema;
  document.getElementById("dynamicFields").innerHTML = schema.fields.map(function (field) {
    return fieldControl(field, schema.labels[field] || field, criterion.formula_code);
  }).join("");
  if (criterion.formula_code === "ОХВ(T)" || criterion.formula_code === "КГ/УЧ(T)") {
    const denominator = document.querySelector('[data-input-field="denominator"]');
    if (denominator) denominator.value = state.selectedClass.students_count || "";
  }
  document.getElementById("aggregationHint").textContent =
    criterion.aggregation === "average"
      ? "Для итога используется среднее всех значений"
      : "Для итога используется последнее значение";
  renderMeasurementHistory(criterion);
  toggleNAFields();
  show("screenMeasurement");
}

function renderMeasurementHistory(criterion) {
  const rows = (criterion.measurements || []).slice().reverse();
  document.getElementById("measurementHistory").innerHTML = rows.map(function (item) {
    const details = item.is_not_applicable
      ? "Критерий отмечен как N/A"
      : Object.entries(item.input_data || {}).map(function (entry) {
          return escapeHtml(entry[0]) + ": " + escapeHtml(entry[1]);
        }).join(" · ");
    return '<article class="item"><div><h4>' + escapeHtml(item.measured_at) + '</h4>' +
      '<p>' + details + '</p><p>' + escapeHtml(item.comment || "") + '</p></div>' +
      '<div class="item-actions"><strong>' +
      (item.points == null ? "N/A" : round(item.points)) +
      '</strong><button class="mini-danger" onclick="deleteMeasurement(' + item.id + ')">Удалить</button></div></article>';
  }).join("") || '<p class="notice">Значений пока нет.</p>';
}

function toggleNAFields() {
  const disabled = document.getElementById("measurementNA").checked;
  document.querySelectorAll("[data-input-field]").forEach(function (input) {
    input.disabled = disabled;
  });
}

async function saveMeasurement() {
  const criterion = state.selectedCriterion;
  if (!criterion) return;
  const isNA = document.getElementById("measurementNA").checked;
  const inputData = {};
  if (!isNA) {
    document.querySelectorAll("[data-input-field]").forEach(function (input) {
      inputData[input.dataset.inputField] = input.value === "" ? null : Number(input.value);
    });
  }
  try {
    const result = await api(
      "/api/classes/" + state.selectedClass.id + "/criteria/" + criterion.code + "/measurements",
      {
        method: "POST",
        body: JSON.stringify({
          measured_at: document.getElementById("measurementDate").value,
          input_data: inputData,
          is_not_applicable: isNA,
          comment: document.getElementById("measurementComment").value.trim() || null,
          evidence: document.getElementById("measurementEvidence").value.trim() || null
        })
      }
    );
    toast(result.points == null ? "Сохранено как N/A" : "Сохранено: " + round(result.points) + " балла");
    await loadBase();
    await openClassDetail(state.selectedClass.id);
  } catch (error) {
    toast(error.message);
  }
}

async function deleteMeasurement(id) {
  if (!confirm("Удалить это значение?")) return;
  try {
    await api("/api/measurements/" + id, {method: "DELETE"});
    toast("Значение удалено");
    await loadBase();
    await openClassDetail(state.selectedClass.id);
  } catch (error) {
    toast(error.message);
  }
}

function renderUniformPalette() {
  document.getElementById("uniformPalette").innerHTML = state.classes.map(function (item) {
    const summary = uniformSummary(item.id);
    const checked = Number(summary.checks_count || 0) > 0;
    return '<button class="uniform-tile ' + (checked ? "checked" : "unchecked") +
      '" onclick="openUniform(' + item.id + ')"><strong>' + escapeHtml(item.name) +
      '</strong><span>' + (checked ? summary.checks_count + ' из 4' : 'нет срезов') + '</span>' +
      '<small>форма: ' + round(summary.points) + ' балла</small></button>';
  }).join("");
}

async function openUniform(classId) {
  if (classId) {
    state.selectedClass = state.classes.find(function (item) { return item.id === classId; });
  }
  if (!state.selectedClass) return;
  const data = await api("/api/classes/" + state.selectedClass.id + "/responsibility-checks");
  document.getElementById("uniformTitle").textContent = state.selectedClass.name + " класс";
  document.getElementById("uniformAverage").textContent = round(data.uniform_points);
  document.getElementById("shoesAverage").textContent = round(data.shoes_points);
  document.getElementById("uniformChecksCount").textContent = data.checks_count;
  document.getElementById("uniformStatusText").textContent = data.checks_count
    ? "Срезов: " + data.checks_count + " из 4"
    : "Пока не проверено";
  document.getElementById("uniformStatusSubtext").textContent =
    "Осталось срезов: " + data.checks_remaining;
  document.getElementById("uniformStatusCard").classList.toggle("checked", data.checks_count > 0);
  document.getElementById("uniformDateInput").value = today();
  document.getElementById("presentCountInput").value = state.selectedClass.students_count || "";
  document.getElementById("withoutUniformInput").value = 0;
  document.getElementById("withoutShoesInput").value = 0;
  document.getElementById("uniformCommentInput").value = "";
  document.getElementById("saveUniformBtn").disabled = data.checks_remaining === 0;
  document.getElementById("uniformHistory").innerHTML = (data.checks || []).map(function (item) {
    return '<article class="item"><div><h4>' + escapeHtml(item.check_date) + '</h4>' +
      '<p>Присутствовали: ' + item.present_count + ' · без формы: ' +
      item.uniform_violations + ' · без сменной обуви: ' + item.shoes_violations + '</p>' +
      '<p>' + escapeHtml(item.comment || "") + '</p></div>' +
      '<button class="mini-danger" onclick="deleteResponsibility(' + item.id + ')">Удалить</button></article>';
  }).join("") || '<p class="notice">Проверок пока нет.</p>';
  show("screenUniform");
}

async function saveUniform() {
  try {
    await api("/api/classes/" + state.selectedClass.id + "/responsibility-checks", {
      method: "POST",
      body: JSON.stringify({
        check_date: document.getElementById("uniformDateInput").value,
        present_count: Number(document.getElementById("presentCountInput").value || 0),
        uniform_violations: Number(document.getElementById("withoutUniformInput").value || 0),
        shoes_violations: Number(document.getElementById("withoutShoesInput").value || 0),
        comment: document.getElementById("uniformCommentInput").value.trim() || null
      })
    });
    toast("Проверка школьной формы сохранена");
    await loadBase();
    renderUniformPalette();
    await openUniform(state.selectedClass.id);
  } catch (error) {
    toast(error.message);
  }
}

async function deleteResponsibility(id) {
  if (!confirm("Удалить эту проверку?")) return;
  try {
    await api("/api/responsibility-checks/" + id, {method: "DELETE"});
    toast("Проверка удалена");
    await loadBase();
    renderUniformPalette();
    await openUniform(state.selectedClass.id);
  } catch (error) {
    toast(error.message);
  }
}

function renderMatrix() {
  document.getElementById("matrixList").innerHTML = state.directions.map(function (direction) {
    const criteria = direction.criteria.map(function (criterion) {
      return '<div class="criterion-row"><span><b>' +
        escapeHtml(criterion.code + " · " + criterion.name) + '</b><small>' +
        escapeHtml(criterion.formula_code + " · цель " + criterion.target + " " +
        criterion.unit + " · " + criterion.periodicity) +
        '</small></span><span class="criterion-points">10</span></div>';
    }).join("");
    return '<details class="direction-card"><summary><span class="direction-number">' +
      direction.number + '</span><span><h3>' + escapeHtml(direction.name) +
      '</h3><p>10 критериев · максимум 100</p></span><span class="direction-score">100</span>' +
      '</summary><div class="criteria">' + criteria + '</div></details>';
  }).join("");
}

async function saveClass() {
  try {
    await api("/api/classes/" + state.selectedClass.id, {
      method: "PUT",
      body: JSON.stringify({
        name: document.getElementById("classNameInput").value.trim(),
        grade: Number(document.getElementById("classGradeInput").value),
        group_id: Number(document.getElementById("classGroupInput").value),
        students_count: Number(document.getElementById("studentsCountInput").value || 0)
      })
    });
    toast("Класс обновлён");
    await loadBase();
    await openClassDetail(state.selectedClass.id);
  } catch (error) {
    toast(error.message);
  }
}

async function archiveClass() {
  if (!confirm("Переместить класс в архив?")) return;
  try {
    await api("/api/classes/" + state.selectedClass.id, {method: "DELETE"});
    toast("Класс перемещён в архив");
    await loadBase();
    renderClassList();
    show("screenClasses");
  } catch (error) {
    toast(error.message);
  }
}

async function createClass() {
  try {
    await api("/api/classes", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("newClassName").value.trim(),
        grade: Number(document.getElementById("newClassGrade").value),
        group_id: Number(document.getElementById("newClassGroup").value),
        students_count: Number(document.getElementById("newClassStudents").value || 0)
      })
    });
    toast("Класс добавлен");
    await loadBase();
    show("screenHome");
  } catch (error) {
    toast(error.message);
  }
}

function renderAllRating() {
  document.getElementById("allRatingList").innerHTML = state.ratings.map(function (row, index) {
    return '<button class="item clickable" onclick="openClassDetail(' + row.class_id + ')">' +
      '<div><h3>' + (index + 1) + '. ' + escapeHtml(row.class_name) + ' класс</h3>' +
      '<p>Заполнено: ' + row.completed_criteria + ' из ' + row.applicable_criteria +
      ' · ' + round(row.progress_percent) + '%</p></div><strong>' +
      round(row.total) + '</strong></button>';
  }).join("");
}

window.openClassDetail = openClassDetail;
window.openMeasurement = openMeasurement;
window.openUniform = openUniform;
window.deleteMeasurement = deleteMeasurement;
window.deleteResponsibility = deleteResponsibility;

document.getElementById("openAdminBtn").addEventListener("click", function () { show("screenHome"); });
document.getElementById("quickClasses").addEventListener("click", function () { show("screenGroups"); });
document.getElementById("quickUniform").addEventListener("click", function () {
  renderUniformPalette();
  show("screenUniformClassSelect");
});
document.getElementById("uniformAlertBtn").addEventListener("click", function () {
  renderUniformPalette();
  show("screenUniformClassSelect");
});
document.getElementById("quickAllRating").addEventListener("click", function () {
  renderAllRating();
  show("screenAllRating");
});
document.getElementById("quickMatrix").addEventListener("click", function () {
  renderMatrix();
  show("screenCategories");
});
document.getElementById("quickAddClass").addEventListener("click", function () { show("screenClassForm"); });
document.querySelectorAll(".group-card").forEach(function (button) {
  button.addEventListener("click", function () {
    state.currentGroup = button.dataset.group;
    renderClassList();
    show("screenClasses");
  });
});
document.querySelectorAll(".back").forEach(function (button) {
  button.addEventListener("click", function () { show(button.dataset.target); });
});
document.getElementById("refreshBtn").addEventListener("click", async function () {
  try {
    await loadBase();
    toast("Данные обновлены");
  } catch (error) {
    toast(error.message);
  }
});
document.getElementById("saveClassBtn").addEventListener("click", saveClass);
document.getElementById("deleteClassBtn").addEventListener("click", archiveClass);
document.getElementById("createClassBtn").addEventListener("click", createClass);
document.getElementById("openUniformFromClassBtn").addEventListener("click", function () {
  openUniform(state.selectedClass && state.selectedClass.id);
});
document.getElementById("measurementNA").addEventListener("change", toggleNAFields);
document.getElementById("saveMeasurementBtn").addEventListener("click", saveMeasurement);
document.getElementById("saveUniformBtn").addEventListener("click", saveUniform);

loadBase().catch(function (error) {
  console.error(error);
  toast("Не удалось загрузить API: " + error.message);
});
