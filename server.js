const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const employeeSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

// First use creates an employee with the default leave balances.
app.post("/api/employees", async (req, res) => {
  try {
    const employeeId = String(req.body.employeeId || "").trim();
    const name = String(req.body.name || "").trim();
    if (!employeeId || !name) return res.status(400).json({ message: "Employee ID and name are required." });

    let employee = await Employee.findOne({ employeeId });
    if (!employee) employee = await Employee.create({ employeeId, name });
    else if (employee.name !== name) {
      employee.name = name;
      await employee.save();
    }
    res.json(employee);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "Employee ID already exists." });
    res.status(500).json({ message: "Could not save employee." });
  }
});

app.get("/api/employees/:employeeId", async (req, res) => {
  try {
    const employee = await Employee.findOne({ employeeId: req.params.employeeId });
    if (!employee) return res.status(404).json({ message: "Employee not found. Enter your name and ID first." });
    res.json(employee);
  } catch {
    res.status(500).json({ message: "Could not load employee." });
  }
});

app.get("/api/leaves/:employeeId", async (req, res) => {
  try {
    const leaves = await Leave.find({ employeeId: req.params.employeeId }).sort({ createdAt: -1 });
    res.json(leaves);
  } catch {
    res.status(500).json({ message: "Could not load leave applications." });
  }
});

app.post("/api/leaves", async (req, res) => {
  try {
    const { employeeId, employeeName, leaveType, startDate, endDate, reason } = req.body;
    if (![employeeId, employeeName, leaveType, startDate, endDate, reason].every(v => String(v || "").trim())) {
      return res.status(400).json({ message: "Please complete all fields." });
    }
    if (!["Casual Leave", "Medical Leave"].includes(leaveType)) {
      return res.status(400).json({ message: "Choose a valid leave type." });
    }

    const start = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return res.status(400).json({ message: "End date must be the same as or after start date." });
    }
    // Calendar days, including both the start and end date.
    const days = Math.floor((end - start) / 86400000) + 1;

    let employee = await Employee.findOne({ employeeId: String(employeeId).trim() });
    if (!employee) employee = await Employee.create({ employeeId: String(employeeId).trim(), name: String(employeeName).trim() });

    const balanceField = leaveType === "Casual Leave" ? "casualLeave" : "medicalLeave";
    const pending = await Leave.aggregate([
      { $match: { employeeId: employee.employeeId, leaveType, status: { $in: ["Pending", "Approved"] } } },
      { $group: { _id: null, total: { $sum: "$days" } } }
    ]);
    const alreadyRequested = pending.length ? pending[0].total : 0;
    if (alreadyRequested + days > employee[balanceField]) {
      return res.status(400).json({ message: `Not enough ${leaveType} balance. Available before this request: ${Math.max(0, employee[balanceField] - alreadyRequested)} day(s).` });
    }

    const leave = await Leave.create({
      employeeId: employee.employeeId, employeeName: String(employeeName).trim(),
      leaveType, startDate: start, endDate: end, days, reason: String(reason).trim()
    });
    res.status(201).json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not submit leave application." });
  }
});

// Demo manager endpoint: approve or reject a pending request.
app.patch("/api/leaves/:id/status", async (req, res) => {
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
      const field = leave.leaveType === "Casual Leave" ? "casualLeave" : "medicalLeave";
      if (employee[field] < leave.days) return res.status(400).json({ message: "Not enough leave balance to approve." });
      employee[field] -= leave.days;
      await employee.save();
    }
    leave.status = status;
    await leave.save();
    res.json(leave);
  } catch {
    res.status(500).json({ message: "Could not update leave status." });
  }
});

app.get("/api/manager/leaves", async (req, res) => {
  try {
    const leaves = await Leave.find().sort({ createdAt: -1 });
    res.json(leaves);
  } catch {
    res.status(500).json({ message: "Could not load all leave requests." });
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
    console.error("Check that MongoDB Server is installed and running, and MONGODB_URI in .env is correct.");
    process.exit(1);
  });