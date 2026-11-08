const $ = id => document.getElementById(id);
let messageTimer;

function showMessage(message, isError = false) {
  const box = $("message");
  box.textContent = message;
  box.className = isError ? "error" : "";
  box.style.display = "block";
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => box.style.display = "none", 4500);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function fmt(date) {
  return new Date(date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
function dateRange(item) { return `${fmt(item.startDate)} – ${fmt(item.endDate)}`; }
function statusPill(status) { return `<span class="pill ${status}">${status}</span>`; }

function showView(view) {
  $("authView").classList.toggle("hidden", view !== "auth");
  $("employeeView").classList.toggle("hidden", view !== "employee");
  $("managerView").classList.toggle("hidden", view !== "manager");
}
function setTab(tabId) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".auth-form").forEach(f => f.classList.toggle("hidden", f.id !== tabId));
}
document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));

async function openEmployee(user) {
  showView("employee");
  $("employeeNameDisplay").textContent = user.name;
  await loadEmployeeData();
}
async function openManager() {
  showView("manager");
  await loadManagerLeaves();
}
async function checkSession() {
  try {
    const result = await api("/api/session");
    if (!result.loggedIn) return showView("auth");
    if (result.user.role === "manager") await openManager();
    else await openEmployee(result.user);
  } catch (err) {
    showView("auth");
    showMessage("Could not check login session. Check server connection.", true);
  }
}

$("employeeLogin").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/employee-login", { method: "POST", body: JSON.stringify({
      employeeId: $("loginEmployeeId").value.trim(),
      password: $("loginEmployeePassword").value
    }) });
    await openEmployee(result.user);
    showMessage("Employee login successful.");
  } catch (err) { showMessage(err.message, true); }
});

$("managerLogin").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/manager-login", { method: "POST", body: JSON.stringify({
      username: $("managerUsername").value.trim(),
      password: $("managerPassword").value
    }) });
    await openManager();
    showMessage(result.message);
  } catch (err) { showMessage(err.message, true); }
});

$("register").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/register", { method: "POST", body: JSON.stringify({
      employeeId: $("registerId").value.trim(),
      name: $("registerName").value.trim(),
      password: $("registerPassword").value
    }) });
    $("register").reset();
    await openEmployee(result.user);
    showMessage(result.message);
  } catch (err) { showMessage(err.message, true); }
});

document.querySelectorAll(".logout").forEach(button => button.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    showView("auth");
    setTab("employeeLogin");
    showMessage("Logged out successfully.");
  } catch (err) { showMessage(err.message, true); }
}));

async function loadEmployeeData() {
  const [employee, leaves] = await Promise.all([
    api("/api/employee/profile"),
    api("/api/employee/leaves")
  ]);
  $("employeeNameDisplay").textContent = employee.name;
  $("clBalance").innerHTML = `${employee.casualLeave} <small>days left</small>`;
  $("mlBalance").innerHTML = `${employee.medicalLeave} <small>days left</small>`;
  $("employeeRows").innerHTML = leaves.length ? leaves.map(l => `
    <tr><td>${escapeHtml(l.leaveType)}</td><td>${dateRange(l)}</td><td>${l.days}</td><td>${escapeHtml(l.reason)}</td><td>${statusPill(l.status)}</td></tr>
  `).join("") : `<tr><td colspan="5" class="empty">No applications yet.</td></tr>`;
}
function updateDayCount() {
  const start = $("startDate").value, end = $("endDate").value;
  if (!start || !end) { $("dayCount").textContent = "Select dates to calculate days."; return; }
  const days = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  $("dayCount").textContent = days > 0 ? `${days} calendar day(s) requested.` : "Invalid: end date must be on or after start date.";
}
$("startDate").addEventListener("change", updateDayCount);
$("endDate").addEventListener("change", updateDayCount);

$("leaveForm").addEventListener("submit", async event => {
  event.preventDefault();
  const start = $("startDate").value;
  const end = $("endDate").value;
  // Client-side check gives instant feedback; server repeats validation for security.
  const today = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!start || new Date(start + "T00:00:00") < todayLocal) {
    showMessage("Invalid leave date: past days are not allowed. Please select today or a future date.", true);
    return;
  }
  if (!end || new Date(end + "T00:00:00") < todayLocal) {
    showMessage("Invalid leave date: end date cannot be in the past.", true);
    return;
  }
  if (new Date(end + "T00:00:00") < new Date(start + "T00:00:00")) {
    showMessage("Invalid date range: end date must be on or after start date.", true);
    return;
  }
  try {
    const result = await api("/api/employee/leaves", { method: "POST", body: JSON.stringify({
      leaveType: $("leaveType").value,
      startDate: start,
      endDate: end,
      reason: $("reason").value.trim()
    }) });
    $("leaveForm").reset();
    updateDayCount();
    await loadEmployeeData();
    showMessage(result.message);
  } catch (err) { showMessage(err.message, true); }
});

$("refreshEmployee").addEventListener("click", async () => {
  try { await loadEmployeeData(); showMessage("Your leave information is refreshed."); }
  catch (err) { showMessage(err.message, true); }
});

async function loadManagerLeaves() {
  const leaves = await api("/api/manager/leaves");
  $("totalCount").textContent = leaves.length;
  $("pendingCount").textContent = leaves.filter(l => l.status === "Pending").length;
  $("managerRows").innerHTML = leaves.length ? leaves.map(l => `
    <tr><td>${escapeHtml(l.employeeName)}<br><span class="muted">${escapeHtml(l.employeeId)}</span></td>
    <td>${escapeHtml(l.leaveType)}</td><td>${dateRange(l)}</td><td>${l.days}</td><td>${escapeHtml(l.reason)}</td>
    <td>${statusPill(l.status)} ${l.status === "Pending" ? `<div class="action-buttons"><button data-id="${l._id}" data-status="Approved">Approve</button><button class="reject" data-id="${l._id}" data-status="Rejected">Reject</button></div>` : ""}</td></tr>
  `).join("") : `<tr><td colspan="6" class="empty">No leave requests found.</td></tr>`;
}
$("refreshManager").addEventListener("click", async () => {
  try { await loadManagerLeaves(); showMessage("Leave requests refreshed."); }
  catch (err) { showMessage(err.message, true); }
});
$("managerRows").addEventListener("click", async event => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/manager/leaves/${button.dataset.id}/status`, {
      method: "PATCH", body: JSON.stringify({ status: button.dataset.status })
    });
    await loadManagerLeaves();
    showMessage(result.message);
  } catch (err) { showMessage(err.message, true); button.disabled = false; }
});

api("/api/health").then(data => {
  if (data.database !== "connected") showMessage("MongoDB is not connected.", true);
}).catch(() => showMessage("Start MongoDB and the Node.js server, then refresh.", true));

checkSession();
