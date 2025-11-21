import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import { routes } from "./routes/routes";
import * as http from "http";
import { transactionService } from "./services";

dotenv.config({ path: ".env" });

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.set("host", process.env.OPENSHIFT_NODEJS_IP || "0.0.0.0");
app.set("port", process.env.PORT || 8081);
app.set("env", process.env.NODE_ENVR || "development");

app.use("/api", routes);

const server: http.Server = http.createServer(app);

let isFetchingTransactions = false;
let isCheckingClockify = false;

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    jobs: {
      fetchTransactions: { running: isFetchingTransactions, interval: "1 minute" },
      clockifySync: { running: isCheckingClockify, interval: "10 seconds" }
    }
  });
});

const safeFetchTransactions = async () => {
  if (isFetchingTransactions) {
    console.log("⚠️ fetchTransactions already running, skipping");
    return;
  }

  isFetchingTransactions = true;
  const startTime = Date.now();
  
  try {
    await transactionService.fetchTransactions();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ fetchTransactions completed in ${duration}s`);
  } catch (error) {
    console.error("❌ fetchTransactions error:", error);
  } finally {
    isFetchingTransactions = false;
  }
};

const safeGetClockify = async () => {
  if (isCheckingClockify) {
    console.log("⚠️ getClockify already running, skipping");
    return;
  }

  isCheckingClockify = true;
  const startTime = Date.now();
  
  try {
    await transactionService.getClockify();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Clockify check completed in ${duration}s`);
  } catch (error) {
    console.error("❌ Clockify error:", error);
  } finally {
    isCheckingClockify = false;
  }
};

(async () => {
  try {
    server.listen(app.get("port"), () => {
      console.log("🚀 App running at http://localhost:%d in %s mode", app.get("port"), app.get("env"));
      console.log("📅 Jobs: Attendance (1 min) | Clockify (20 sec)");
    });

    await safeFetchTransactions();
    await safeGetClockify();

    setInterval(safeFetchTransactions, 60000);
    setInterval(safeGetClockify, 20000);
    
    console.log("✅ All jobs scheduled\n");
  } catch (error) {
    console.error("❌ Startup error:", error);
    process.exit(1);
  }
})();
