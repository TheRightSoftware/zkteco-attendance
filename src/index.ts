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

(async () => {
  try {
    server.listen(app.get("port"), () => {
      console.log(
        "🚀 App is running at http://localhost:%d in %s mode",
        app.get("port"),
        app.get("env")
      );
    });
    transactionService.fetchTransactions();
    setInterval(() => {
      transactionService.fetchTransactions();
    }, 1 * 60 * 1000); // 1 minute in ms
    transactionService.getClockify();
    setInterval(() => {
      transactionService.getClockify();
    }, 10 * 1000); // 10 s
  } catch (error) {
    console.error("❌ Error starting server:", error);
  }
})();
