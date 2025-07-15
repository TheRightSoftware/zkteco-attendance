import { sendMessage } from "@src/utils/sendMessage";
import axios from "axios";
import moment from "moment-timezone";
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
const zktecoFilePath = path.join(__dirname, "../utils/lastFetchedTime.json");
const processedPunchesFilePath = path.join(
  __dirname,
  "../utils/processedPunches.json"
);
const sheetName = "Attendance";

var punchSet = new Set<string>();
export class TransactionService {
  private previousStates = new Map<string, string>(); // userId => timerId
  constructor() {
    this.previousStates = loadPreviousStatesFromFile();
  }

  public fetchTransactions = async (): Promise<any> => {
    const deviceUrl = process.env.DEVICE_URL as string;
    let jwtToken = process.env.JWT_TOKEN as string;

    await loadPunchCache();
    const lastFetchedTime = await getLastFetchedTime();
    const endTime = moment();
    const startTime = lastFetchedTime.clone().subtract(10, "seconds");

    const formattedStart = startTime.format("YYYY-MM-DD HH:mm:ss");
    const formattedEnd = endTime.format("YYYY-MM-DD HH:mm:ss");

    const url = `${deviceUrl}iclock/api/transactions/?start_time=${encodeURIComponent(
      formattedStart
    )}&end_time=${encodeURIComponent(formattedEnd)}&page_size=1000`;

    const processPunches = async (punches: any[]) => {
      for (const punch of punches) {
        const uniqueKey = `${punch.emp_code}_${punch.punch_time}`;
        if (isDuplicate(uniqueKey)) continue;
        markAsProcessed(uniqueKey);

        const punchMoment = moment(punch.punch_time, "YYYY-MM-DD HH:mm:ss");
        const formattedDate = punchMoment.format("MMMM DD, YYYY");
        const formattedTime = punchMoment.format("hh:mm A");
        const fullName = punch.last_name
          ? `${punch.first_name} ${punch.last_name}`
          : punch.first_name;
        const userId = String(punch.emp_code);
        const status = punch.punch_state_display?.toLowerCase();

        const entry = {
          Name: fullName,
          UserID: userId,
          Date: formattedDate,
          Status: status,
          Time: formattedTime,
          Source: "Zkteco", // or "Clockify"
          Project: "",
        };

        await upsertToAttendanceSheet(entry);
        await sendMessage(
          `${fullName} (${userId})`,
          punch.punch_time,
          punch.punch_state_display
        );
      }
    };

    try {
      const response = await axios.get(url, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `JWT ${jwtToken}`,
        },
      });

      const punches = response.data?.data;
      if (Array.isArray(punches) && punches.length > 0) {
        await processPunches(punches);
      } else {
        console.log("⚠️ No punches found in response.");
      }

      setLastFetchedTime(endTime);
      savePunchCache();
      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401 || error?.response?.data?.code === "token_not_valid") {
        console.warn("🔒 Token expired. Fetching new token...");
        const newToken = await this.getJWTToken({
          userName: process.env.DEVICE_USERNAME as string,
          Password: process.env.DEVICE_PASSWORD as string,
        });

        process.env.JWT_TOKEN = newToken;
        jwtToken = newToken;

        const retryResponse = await axios.get(url, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `JWT ${jwtToken}`,
          },
        });

        const punches = retryResponse.data?.data;
        if (Array.isArray(punches) && punches.length > 0) {
          await processPunches(punches);
        } else {
          console.log("⚠️ No punches found in retry response.");
        }

        setLastFetchedTime(endTime);
        savePunchCache();
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
            const punchMoment = moment
              .utc(runningEntry.timeInterval.start)
              .tz("Asia/Karachi");

            const formattedDate = punchMoment.format("MMMM DD, YYYY");
            const formattedTime = punchMoment.format("hh:mm A");
            //--------------------------------
            // appendToAttendanceSheet({
            //   Name: user.name,
            //   UserID: "",
            //   Date: formattedDate,
            //   Time: formattedTime,
            //   Status: "Signing In",
            //   Total_Hour: "",
            //   Source: "Clockify",
            //   Project: project,
            // });
            const entry = {
              Name: user.name,
              UserID: "",
              Date: formattedDate,
              Status: "Signing In",
              Time: formattedTime,
              Source: "Clockify", // or "Clockify"
              Project: project,
            };

            await upsertToAttendanceSheet(entry);
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
              //--------------------------------
              // appendToAttendanceSheet({
              //   Name: user.name,
              //   UserID: "",
              //   Date: formattedDate,
              //   Time: formattedTime,
              //   Status: "Signing off",
              //   Total_Hour: worked,
              //   Source: "Clockify",
              //   Project: project,
              // });
              const entry = {
                Name: user.name,
                UserID: "",
                Date: formattedDate,
                Status: "Signing off",
                Time: formattedTime,
                Source: "Clockify", // or "Clockify"
                Project: project,
              };
              await upsertToAttendanceSheet(entry);
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

export const upsertToAttendanceSheet = async (entry: any) => {
  let workbook, worksheet;
  const status = entry.Status?.toLowerCase() || "";
  const formattedTime = entry.Time || "";
  const headers = [
    "Name",
    "UserID",
    "Date",
    "checkIn",
    "checkOut",
    "breakIn",
    "breakOut",
    "breakIn2",
    "breakOut2",
    "breakIn3",
    "breakOut3",
    "WFH Start 1",
    "WFH End 1",
    "WFH Start 2",
    "WFH End 2",
    "WFH Start 3",
    "WFH End 3",
    "WFH Start 4",
    "WFH End 4",
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

  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as string[][];
  const existingRows = data.slice(1); // skip headers

  const rowIndex = existingRows.findIndex((row) => {
    const matchByUserId =
      entry.UserID && row[1] === entry.UserID && row[2] === entry.Date;
    const matchByName =
      !entry.UserID && row[0] === entry.Name && row[2] === entry.Date;
    return matchByUserId || matchByName;
  });

  const newRow = new Array(headers.length).fill("");
  newRow[0] = entry.Name;
  newRow[1] = entry.UserID;
  newRow[2] = entry.Date;
  newRow[headers.indexOf("Source")] = entry.Source;
  newRow[headers.indexOf("Project")] = entry.Project || "";

  const isWFH = entry.Source === "Clockify";

  const assignTime = (row: string[]) => {
    if (isWFH) {
      // WFH: Fill WFH Start/End pairs in order
      const wfhPairs = [
        ["WFH Start 1", "WFH End 1"],
        ["WFH Start 2", "WFH End 2"],
        ["WFH Start 3", "WFH End 3"],
        ["WFH Start 4", "WFH End 4"],
      ];
      const isStart = status.toLowerCase().includes("signing in");
      const isEnd = status.toLowerCase().includes("signing off");

      for (const [startKey, endKey] of wfhPairs) {
        const startIdx = headers.indexOf(startKey);
        const endIdx = headers.indexOf(endKey);

        if (isStart && !row[startIdx]) {
          row[startIdx] = formattedTime;
          break;
        }
        if (isEnd && !row[endIdx]) {
          row[endIdx] = formattedTime;
          break;
        }
      }
    } else {
      // Office logic
      const checkInIdx = headers.indexOf("checkIn");
      const checkOutIdx = headers.indexOf("checkOut");
      const breakIns = [
        headers.indexOf("breakIn"),
        headers.indexOf("breakIn2"),
        headers.indexOf("breakIn3"),
      ];
      const breakOuts = [
        headers.indexOf("breakOut"),
        headers.indexOf("breakOut2"),
        headers.indexOf("breakOut3"),
      ];

      const lowerStatus = status.toLowerCase();

      if (lowerStatus.includes("check in")) {
        if (!row[checkInIdx]) row[checkInIdx] = formattedTime;
      } else if (lowerStatus.includes("check out")) {
        if (!row[checkOutIdx]) row[checkOutIdx] = formattedTime;
      } else if (lowerStatus.includes("break start")) {
        for (const idx of breakIns) {
          if (!row[idx]) {
            row[idx] = formattedTime;
            break;
          }
        }
      } else if (lowerStatus.includes("break end")) {
        for (const idx of breakOuts) {
          if (!row[idx]) {
            row[idx] = formattedTime;
            break;
          }
        }
      }
    }
  };

  if (rowIndex !== -1) {
    const row = data[rowIndex + 1]; // account for header
    // Update project (for WFH or anyone)
    row[headers.indexOf("Project")] =
      entry.Project || row[headers.indexOf("Project")];
    assignTime(row);
    data[rowIndex + 1] = row;
  } else {
    assignTime(newRow);
    data.push(newRow);
  }

  const updatedSheet = XLSX.utils.aoa_to_sheet(data);
  workbook.Sheets[sheetName] = updatedSheet;
  XLSX.writeFile(workbook, filePath);
  console.log(`✅ Attendance upserted for ${entry.Name} (${entry.Source})`);
};

export const getLastFetchedTime = (): moment.Moment => {
  try {
    if (fs.existsSync(zktecoFilePath)) {
      const data = fs.readFileSync(zktecoFilePath, "utf-8");
      const parsed = JSON.parse(data);
      return moment(parsed.lastFetchedTime);
    }
  } catch (err) {
    console.error("❌ Failed to read last fetched time:", err);
  }

  // Default: 2 minutes ago
  return moment().subtract(2, "minutes");
};

export const setLastFetchedTime = (time: moment.Moment) => {
  try {
    const data = { lastFetchedTime: time.toISOString() };
    fs.writeFileSync(zktecoFilePath, JSON.stringify(data), "utf-8");
  } catch (err) {
    console.error("❌ Failed to save last fetched time:", err);
  }
};

export const loadPunchCache = () => {
  try {
    if (fs.existsSync(processedPunchesFilePath)) {
      const data = JSON.parse(
        fs.readFileSync(processedPunchesFilePath, "utf-8")
      );
      punchSet = new Set(data);
    }
  } catch (err) {
    console.error("⚠️ Failed to load punch cache:", err);
  }
};

export const isDuplicate = (key: string): boolean => {
  return punchSet.has(key);
};

export const markAsProcessed = (key: string) => {
  punchSet.add(key);
};

export const savePunchCache = () => {
  try {
    fs.writeFileSync(
      processedPunchesFilePath,
      JSON.stringify(Array.from(punchSet))
    );
  } catch (err) {
    console.error("⚠️ Failed to save punch cache:", err);
  }
};
