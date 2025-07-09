import { sendMessage } from "@src/utils/sendMessage";
import axios from "axios";
import moment from "moment";
import dotenv from "dotenv";
import fs, { stat } from "fs";
import path from "path";
import * as XLSX from "xlsx";

dotenv.config();

const clockify = axios.create({
  baseURL: "https://api.clockify.me/api/v1",
  headers: { "X-Api-Key": process.env.CLOCKIFY_API_KEY as string },
});
const WORKSPACE_ID = process.env.CLOCKIFY_WORKSPACE_ID as string;
const FILE_PATH = path.join(__dirname, "../utils/clockifyStates.json");

const filePath = path.join(__dirname, "../attendance.xlsx");
const sheetName = "Attendance";

export class TransactionService {
  private previousStates = new Map<string, string>(); // userId => timerId
  constructor() {
    this.previousStates = loadPreviousStatesFromFile();
  }

  public fetchTransactions = async (): Promise<any> => {
    const deviceUrl = process.env.DEVICE_URL as string;

    let jwtToken = process.env.JWT_TOKEN as string;

    const endTime = moment();
    const startTime = moment().subtract(216, "minutes");

    const formattedStart = startTime.format("YYYY-MM-DD HH:mm:ss");
    const formattedEnd = endTime.format("YYYY-MM-DD HH:mm:ss");
    console.log(`StartTime:: ${formattedStart} endTime:: ${formattedEnd}`);

    const url = `${deviceUrl}iclock/api/transactions/?start_time=${encodeURIComponent(
      formattedStart
    )}&end_time=${encodeURIComponent(formattedEnd)}&page_size=1000`;

    try {
      const response = await axios.get(url, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `JWT ${jwtToken}`,
        },
      });

      const punches = response.data?.data;
      if (Array.isArray(punches) && punches.length > 0) {
        for (const punch of punches) {
          const fullName = punch.last_name
            ? `${punch.first_name} ${punch.last_name}`
            : punch.first_name;

          await sendMessage(
            `${fullName} (${punch.emp_code})`,
            punch.punch_time,
            punch.punch_state_display
          );
          const punchMoment = moment(punch.punch_time, "YYYY-MM-DD HH:mm:ss");
          const formattedDate = punchMoment.format("MMMM DD, YYYY");
          const formattedTime = punchMoment.format("hh:mm A");
          appendToAttendanceSheet({
            Name: fullName,
            UserID: String(punch.emp_code),
            Date: formattedDate,
            Time: formattedTime,
            Status: punch.punch_state_display,
            Total_Hour: "",
            Source: "Zkteco",
            Project: "",
          });
        }
      } else {
        console.log("⚠️ No punches found in response.");
      }

      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;

      // Token is invalid or expired
      if (status === 401 || error?.response?.data?.code === "token_not_valid") {
        console.warn("🔒 Token expired or invalid. Fetching new token...");

        const newToken = await this.getJWTToken({
          userName: process.env.DEVICE_USERNAME as string,
          Password: process.env.DEVICE_PASSWORD as string,
        });

        process.env.JWT_TOKEN = newToken;
        jwtToken = newToken;

        // Retry the request with new token
        const retryResponse = await axios.get(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `JWT ${jwtToken}`,
          },
        });

        const punches = retryResponse.data?.data;
        if (Array.isArray(punches) && punches.length > 0) {
          for (const punch of punches) {
            const fullName = punch.last_name
              ? `${punch.first_name} ${punch.last_name}`
              : punch.first_name;

            await sendMessage(
              `${fullName} (${punch.emp_code})`,
              punch.punch_time,
              punch.punch_state_display
            );
            const punchMoment = moment(punch.punch_time, "YYYY-MM-DD HH:mm:ss");
            const formattedDate = punchMoment.format("MMMM DD, YYYY");
            const formattedTime = punchMoment.format("hh:mm A");
            appendToAttendanceSheet({
              Name: fullName,
              UserID: String(punch.emp_code),
              Date: formattedDate, // e.g., "2025 || July | Wednesday"
              Time: formattedTime, // e.g., "09:22 AM"
              Status: punch.punch_state_display,
              Total_Hour: "",
              Source: "Zkteco",
              Project: "",
            });
          }
        } else {
          console.log("⚠️ No punches found in retry response.");
        }

        return retryResponse.data;
      } else {
        throw error;
      }
    }
  };

  public getJWTToken = async (data: any): Promise<any> => {
    const { userName, Password } = data;
    if (!userName || !Password) {
      throw new Error("Missing username or password.");
    }

    const deviceUrl = process.env.DEVICE_URL as string;

    const response = await axios.post(
      `${deviceUrl}jwt-api-token-auth/`,
      {
        username: userName,
        password: Password,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.token;
  };

  public getClockify = async (): Promise<void> => {
    try {
      const users: any = await getUsers();
      console.log("length is ", users.length);
      const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
      for (const user of users) {
        await delay(200); // 200ms delay between users

        const runningEntry = await getRunningEntry(user.id);
        const lastTimerId = this.previousStates.get(user.id);

        if (runningEntry) {
          var project = await getProjectName(runningEntry.projectId);
          if (lastTimerId !== runningEntry.id) {
            const msg = `${user.name} | ${project} | ${runningEntry?.timeInterval?.start} | Signing In`;

            this.previousStates.set(user.id, runningEntry.id);
            savePreviousStatesToFile(this.previousStates);

            sendMessage(
              `🏠 ${user.name}`,
              runningEntry?.timeInterval?.start,
              "Signing In",
              project,
              true
            );
            const punchMoment = moment(
              runningEntry?.timeInterval?.start,
              "YYYY-MM-DD HH:mm:ss"
            );
            const formattedDate = punchMoment.format("MMMM DD, YYYY");
            const formattedTime = punchMoment.format("hh:mm A");
            appendToAttendanceSheet({
              Name: user.name,
              UserID: "",
              Date: formattedDate,
              Time: formattedTime,
              Status: "Signing In",
              Total_Hour: "",
              Source: "Clockify",
              Project: project,
            });
          }
        } else {
          if (lastTimerId) {
            const lastEntry = await getLastTimeEntry(user.id);
            if (lastEntry && lastEntry.id === lastTimerId) {
              const start = lastEntry.timeInterval?.start;
              const end = lastEntry.timeInterval?.end;
              const durationISO = lastEntry.timeInterval?.duration;

              const duration = moment.duration(durationISO);
              const totalSeconds = duration.asSeconds();
              const worked = formatDuration(totalSeconds);

              const project = await getProjectName(lastEntry.projectId);
              const formattedEnd = moment(end).toISOString();

              const msg = `${user.name} | ${
                project || "No Project"
              } | ${formattedEnd} | Signing off | Hours: ${worked}`;

              sendMessage(
                `🏠 ${user.name}`,
                end,
                `Signing off | ${worked}`,
                project,
                true
              );
              const punchMoment = moment(
                runningEntry?.timeInterval?.start,
                "YYYY-MM-DD HH:mm:ss"
              );
              const formattedDate = punchMoment.format("MMMM DD, YYYY");
              const formattedTime = punchMoment.format("hh:mm A");
              appendToAttendanceSheet({
                Name: user.name,
                UserID: "",
                Date: formattedDate,
                Time: formattedTime,
                Status: "Signing off",
                Total_Hour: worked,
                Source: "Clockify",
                Project: project,
              });
            } else {
              console.warn(
                `⚠️ Last time entry not found or mismatched for ${user.name}`
              );
            }
            this.previousStates.delete(user.id);
            savePreviousStatesToFile(this.previousStates);
          }
        }
      }
    } catch (err: any) {
      console.error("❌ Error in getClockify:", err.message || err);
    }
  };
}

export const getUsers = async () => {
  // const res = await clockify.get(`/workspaces/${WORKSPACE_ID}/users`);
  // return res.data;
  const allUsers: any[] = [];
  let page = 1;
  const pageSize = 100; // maximum allowed

  while (true) {
    const res = await clockify.get(`/workspaces/${WORKSPACE_ID}/users`, {
      params: {
        page,
        "page-size": pageSize,
      },
    });

    const users = res.data;

    allUsers.push(...users);

    if (users.length < pageSize) {
      break;
    }

    page++;
  }

  return allUsers;
};

export const getRunningEntry = async (userId: string) => {
  const res = await clockify.get(
    `/workspaces/${WORKSPACE_ID}/user/${userId}/time-entries?in-progress=true`
  );
  return res.data[0];
};

export const getProjectName = async (projectId: string) => {
  if (!projectId) return null;
  const res = await clockify.get(
    `/workspaces/${WORKSPACE_ID}/projects/${projectId}`
  );

  return res.data.name;
};

const getMyWorkspaces = async () => {
  const res = await clockify.get("/workspaces");
  console.log("✅ Your workspaces:", res.data);
};

const loadPreviousStatesFromFile = (): Map<string, string> => {
  try {
    let data = "{}";

    if (fs.existsSync(FILE_PATH)) {
      const raw = fs.readFileSync(FILE_PATH, "utf-8").trim();
      data = raw === "" ? "{}" : raw;
    }

    const parsed = JSON.parse(data);
    return new Map(Object.entries(parsed));
  } catch (err) {
    console.error("Error loading previousStates:", err);
    return new Map();
  }
};

// Save previousStates to file
const savePreviousStatesToFile = (map: Map<string, string>) => {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(FILE_PATH, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving previousStates:", err);
  }
};

export const getLastTimeEntry = async (userId: string) => {
  const res = await clockify.get(
    `/workspaces/${WORKSPACE_ID}/user/${userId}/time-entries?hydrated=true&page-size=1`
  );
  return res.data[0];
};

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const parts: string[] = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

export const appendToAttendanceSheet = async (entry: any) => {
  let workbook, worksheet;

  const headers = [
    "Name",
    "UserID",
    "Date",
    "Time",
    "Status",
    "Total_Hour",
    "Source",
    "Project",
  ];

  if (fs.existsSync(filePath)) {
    workbook = XLSX.readFile(filePath);
    worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      worksheet = XLSX.utils.aoa_to_sheet([headers]);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    }
  } else {
    workbook = XLSX.utils.book_new();
    worksheet = XLSX.utils.aoa_to_sheet([headers]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[];

  const newRow = [
    entry.Name,
    entry.UserID,
    entry.Date,
    entry.Time,
    entry.Status,
    entry.Total_Hour || "",
    entry.Source,
    entry.Project || "",
  ];

  data.push(newRow);

  const updatedSheet = XLSX.utils.aoa_to_sheet(data);

  // 👇 Only replace the sheet content, don't re-append it
  workbook.Sheets[sheetName] = updatedSheet;

  XLSX.writeFile(workbook, filePath);
  console.log(`✅ Attendance saved for ${entry.Name} (${entry.Source})`);
};
