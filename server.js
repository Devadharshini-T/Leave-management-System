const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-development-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const employeeSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: "employee", enum: ["employee"] },
  casualLeave: { type: Number, default: 12, min: 0 },
  medicalLeave: { type: Number, default: 10, min: 0 }
}, { timestamps: true });

const leaveSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, trim: true },
  employeeName: { type: String, required: true, trim: true },
  leaveType: { type: String, enum: ["Casual Leave", "Medical Leave"], required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  days: { type: Number, required: true, min: 1 },
  reason: { type: String, required: true, trim: true },
  status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" }
}, { timestamps: true });

const Employee = mongoose.model("Employee", employeeSchema);
const Leave = mongoose.model("Leave", leaveSchema);

function requireEmployee(req, res, next) {
  if (!req.session.user || req.session.user.role !== "employee") {
    return res.status(401).json({ message: "Please log in with an employee account." });
  }
  next();
}
function requireManager(req, res, next) {
  if (!req.session.user || req.session.user.role !== "manager") {
    return res.status(401).json({ message: "Manager login required. Please log in as manager." });
  }
  next();
}
function sameDayOrAfterToday(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const chosen = new Date(date);
  chosen.setHours(0, 0, 0, 0);
  return chosen >= today;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.get("/api/session", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// Employee self-registration. Passwords are stored as hashes, not plain text.
app.post("/api/auth/register", async (req, res) => {
  try {
    const employeeId = String(req.body.employeeId || "").trim();
    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");
    if (!employeeId || !name || !password) return res.status(400).json({ message: "Please complete all fields." });
    if (password.length < 6) return res.status(400).json({ message: "Password must contain at least 6 characters." });
    const exists = await Employee.findOne({ employeeId });
    if (exists) return res.status(409).json({ message: "This Employee ID is already registered. Please log in." });
    const passwordHash = await bcrypt.hash(password, 12);
    await Employee.create({ employeeId, name, passwordHash });
    req.session.user = { employeeId, name, role: "employee" };
    res.status(201).json({ message: "Employee account created successfully.", user: req.session.user });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "This Employee ID is already registered." });
    console.error(err);
    res.status(500).json({ message: "Could not create account." });
  }
});

app.post("/api/auth/employee-login", async (req, res) => {
  try {
    const employeeId = String(req.body.employeeId || "").trim();
    const password = String(req.body.password || "");
    const employee = await Employee.findOne({ employeeId });
    if (!employee || !(await bcrypt.compare(password, employee.passwordHash))) {
      return res.status(401).json({ message: "Invalid Employee ID or password." });
    }
    req.session.user = { employeeId: employee.employeeId, name: employee.name, role: "employee" };
    res.json({ message: "Employee login successful.", user: req.session.user });
  } catch {
    res.status(500).json({ message: "Could not log in." });
  }
});

app.post("/api/auth/manager-login", (req, res) => {
  const username = String(req.body.username || "");
  const password = String(req.body.password || "");
  if (username !== process.env.MANAGER_USERNAME || password !== process.env.MANAGER_PASSWORD) {
    return res.status(401).json({ message: "Invalid manager username or password." });
  }
  req.session.user = { name: "Manager", role: "manager" };
  res.json({ message: "Manager login successful.", user: req.session.user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: "Could not log out." });
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out successfully." });
  });
});

app.get("/api/employee/profile", requireEmployee, async (req, res) => {
  const employee = await Employee.findOne({ employeeId: req.session.user.employeeId }).select("-passwordHash");
  if (!employee) return res.status(404).json({ message: "Employee account not found." });
  res.json(employee);
});

app.get("/api/employee/leaves", requireEmployee, async (req, res) => {
  const leaves = await Leave.find({ employeeId: req.session.user.employeeId }).sort({ createdAt: -1 });
  res.json(leaves);
});

app.post("/api/employee/leaves", requireEmployee, async (req, res) => {
  try {
    const { leaveType, startDate, endDate, reason } = req.body;
    if (![leaveType, startDate, endDate, reason].every(v => String(v || "").trim())) {
      return res.status(400).json({ message: "Please complete all fields." });
    }
    if (!["Casual Leave", "Medical Leave"].includes(leaveType)) {
      return res.status(400).json({ message: "Choose a valid leave type." });
    }

    const start = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ message: "Please choose valid dates." });
    }

    // Reject any leave whose start date is before today.
    if (!sameDayOrAfterToday(startDate)) {
      return res.status(400).json({ message: "Invalid leave date: past dates are not allowed. Please choose today or a future date." });
    }
    if (!sameDayOrAfterToday(endDate)) {
      return res.status(400).json({ message: "Invalid leave date: end date cannot be in the past." });
    }
    if (end < start) return res.status(400).json({ message: "End date must be the same as or after the start date." });

    const days = Math.floor((end - start) / 86400000) + 1;
    const employee = await Employee.findOne({ employeeId: req.session.user.employeeId });
    if (!employee) return res.status(404).json({ message: "Employee account not found." });

    const balanceField = leaveType === "Casual Leave" ? "casualLeave" : "medicalLeave";
    const pendingOrApproved = await Leave.aggregate([
      { $match: { employeeId: employee.employeeId, leaveType, status: { $in: ["Pending", "Approved"] } } },
      { $group: { _id: null, total: { $sum: "$days" } } }
    ]);
    const alreadyRequested = pendingOrApproved.length ? pendingOrApproved[0].total : 0;
    const availableForRequest = employee[balanceField] - alreadyRequested;
    if (days > availableForRequest) {
      return res.status(400).json({ message: `Not enough ${leaveType} balance. Available for a new request: ${Math.max(0, availableForRequest)} day(s).` });
    }

    const leave = await Leave.create({
      employeeId: employee.employeeId,
      employeeName: employee.name,
      leaveType, startDate: start, endDate: end, days, reason: String(reason).trim()
    });
    res.status(201).json({ message: "Leave application submitted and sent to the manager for approval.", leave });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not submit leave application." });
  }
});

app.get("/api/manager/leaves", requireManager, async (req, res) => {
  const leaves = await Leave.find().sort({ createdAt: -1 });
  res.json(leaves);
});

app.patch("/api/manager/leaves/:id/status", requireManager, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({ message: "Status must be Approved or Rejected." });
    }
    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: "Leave request not found." });
    if (leave.status !== "Pending") return res.status(400).json({ message: "Only pending requests can be updated." });

    if (status === "Approved") {
      const employee = await Employee.findOne({ employeeId: leave.employeeId });
      if (!employee) return res.status(404).json({ message: "Employee account not found." });
      const field = leave.leaveType === "Casual Leave" ? "casualLeave" : "medicalLeave";
      if (employee[field] < leave.days) return res.status(400).json({ message: "Not enough leave balance to approve." });
      employee[field] -= leave.days;
      await employee.save();
    }
    leave.status = status;
    await leave.save();
    res.json({ message: `Leave ${status.toLowerCase()} successfully.`, leave });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not update leave status." });
  }
});

const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    app.listen(PORT, () => console.log(`Leave Management System running at http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error("MongoDB connection failed:", err.message);
    console.error("Make sure MongoDB Server is running and .env has the correct URI.");
    process.exit(1);
  });