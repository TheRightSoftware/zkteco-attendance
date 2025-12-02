import { sendMessage } from "@src/utils/sendMessage";
import { parseTime } from "@src/utils/time";
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
let jwtToken = process.env.JWT_TOKEN as string;
let isSavingCache = false;
let employeeNicknameCache = new Map<string, string>();

let lastMessageTime = 0;
const MIN_MESSAGE_INTERVAL = 10000; //10 sec

const waitForRateLimit = async (): Promise<void> => {
  const now = Date.now();
  const timeSinceLastMessage = now - lastMessageTime;
  
  if (timeSinceLastMessage < MIN_MESSAGE_INTERVAL) {
    const waitTime = MIN_MESSAGE_INTERVAL - timeSinceLastMessage;
    console.log(`⏳ Waiting ${Math.ceil(waitTime / 1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastMessageTime = Date.now();
};

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
        
        if (isDuplicate(uniqueKey)) {
          console.log(`⏭️ Skipping duplicate: ${uniqueKey}`);
          continue;
        }

        const punchMoment = moment(punch.punch_time, "YYYY-MM-DD HH:mm:ss");
        const formattedDate = punchMoment.format("MMMM DD, YYYY");
        const formattedTime = punchMoment.format("hh:mm A");
        const fullName = punch.last_name ? `${punch.first_name} ${punch.last_name}` : punch.first_name;
        const userId = String(punch.emp_code);
        const status = punch.punch_state_display?.toLowerCase();

        const entry = {
          Name: fullName,
          UserID: userId,
          Date: formattedDate,
          Status: status,
          Time: formattedTime,
          Source: "Zkteco",
          Project: "",
        };

        await upsertToAttendanceSheet(entry);
        
        let messageState = punch.punch_state_display;
        let rocketChatUsername: string | undefined = undefined;

        if (status.includes("check out")) {
          const totalWorkTime = await getTotalWorkTimeFromBiotimeAPI(
            userId,
            formattedDate,
            deviceUrl,
            jwtToken
          );
          rocketChatUsername = await getEmployeeRecord(punch.emp_code, deviceUrl, jwtToken);

          if (totalWorkTime) {
            messageState = `${punch.punch_state_display} | Work Time: ${totalWorkTime}`;
          }
        }
        
        try {
          await waitForRateLimit();
          await sendMessage(
            `${fullName} (${userId})`,
            punch.punch_time,
            messageState,
            undefined,
            false,
            rocketChatUsername,
            String(userId)
          );
          
          markAsProcessed(uniqueKey);
          await savePunchCache();
          console.log(`✅ Processed: ${uniqueKey}`);
        } catch (error) {
          console.error(`❌ Failed: ${uniqueKey}`, error);
        }
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
      await savePunchCache();
      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401 || error?.response?.data?.code === "token_not_valid") {
        console.warn("🔒 Token expired. Fetching new token...");
        const newToken = await this.getJWTToken({
          userName: process.env.DEVICE_USERNAME as string,
          Password: process.env.DEVICE_PASSWORD as string,
        });
        console.log("New token:", newToken);

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
        await savePunchCache();
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

      const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
      for (const user of users) {
        await delay(200);

        const runningEntry = await getRunningEntry(user.id);
        const lastTimerId = this.previousStates.get(user.id);

        if (runningEntry) {
          var project = await getProjectName(runningEntry.projectId);
          if (lastTimerId !== runningEntry.id) {
            this.previousStates.set(user.id, runningEntry.id);
            savePreviousStatesToFile(this.previousStates);

            await waitForRateLimit();
            
            await sendMessage(
              `🏠 ${user.name}`,
              runningEntry?.timeInterval?.start,
              "Signing In",
              project,
              true
            );

            const punchMoment = moment.utc(runningEntry.timeInterval.start).tz("Asia/Karachi");
            const formattedDate = punchMoment.format("MMMM DD, YYYY");
            const formattedTime = punchMoment.format("hh:mm A");

            const entry = {
              Name: user.name,
              UserID: "",
              Date: formattedDate,
              Status: "Signing In",
              Time: formattedTime,
              Source: "Clockify",
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

              await waitForRateLimit();
              
              await sendMessage(
                `🏠 ${user.name}`,
                end,
                `Signing off | ${worked}`,
                project,
                true
              );

              const punchMoment = moment(runningEntry?.timeInterval?.start, "YYYY-MM-DD HH:mm:ss");
              const formattedDate = punchMoment.format("MMMM DD, YYYY");
              const formattedTime = punchMoment.format("hh:mm A");

              const entry = {
                Name: user.name,
                UserID: "",
                Date: formattedDate,
                Status: "Signing off",
                Time: formattedTime,
                Source: "Clockify",
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

  public getRocketChatUsers = async (): Promise<any> => {
    return await fetchAllRocketChatUsers();
  };

  public exportRocketChatUsers = async () => {
    const users = await fetchAllRocketChatUsers();
    
    const workbook = XLSX.utils.book_new();
    
    const rows = users.map((user: any) => ({
      "User ID": user._id,
      "Username": user.username || "",
      "Name": user.name || "",
      "Email": user.emails?.[0]?.address || "",
      "Active": user.active ? "Yes" : "No",
      "Status": user.status || "",
      "Roles": user.roles?.join(", ") || "",
      "Created At": user.createdAt ? moment(user.createdAt).format("YYYY-MM-DD HH:mm:ss") : "",
      "Last Login": user.lastLogin ? moment(user.lastLogin).format("YYYY-MM-DD HH:mm:ss") : "",
    }));
    
    const sheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, "Rocket.Chat Users");
    
    const fileName = `rocketchat-users-${moment().format("YYYY-MM-DD")}.xlsx`;
    
    return { workbook, fileName };
  };

  // From Zkteco device.
  public getAllUsersAttendance = async (data: any) => {
    const { start, end } = data;
    const users = await getUsers();
    const attendanceRows: any[] = [];

    for (const user of users) {
      const res = await clockify.get(
        `/workspaces/${WORKSPACE_ID}/user/${user.id}/time-entries`,
        {
          params: { start, end },
        }
      );

      const entries = res.data;
      if (!entries.length) continue;

      const groupedByDate: Record<string, any[]> = {};

      entries.forEach((entry: any) => {
        const date = entry.timeInterval.start.split("T")[0];
        if (!groupedByDate[date]) groupedByDate[date] = [];
        groupedByDate[date].push(entry);
      });

      for (const date in groupedByDate) {
        const dayEntries = groupedByDate[date];

        const startTimes = dayEntries.map(
          (e) => new Date(e.timeInterval.start)
        );
        const endTimes = dayEntries.map((e) => new Date(e.timeInterval.end));

        const earliestStart = new Date(
          Math.min(...startTimes.map((d) => d.getTime()))
        );
        const latestEnd = new Date(
          Math.max(...endTimes.map((d) => d.getTime()))
        );

        const totalDurationMs = endTimes.reduce((sum, end, i) => {
          return sum + (end.getTime() - startTimes[i].getTime());
        }, 0);

        const durationHrs = Math.floor(totalDurationMs / (1000 * 60 * 60));
        const durationMin = Math.floor((totalDurationMs / (1000 * 60)) % 60);

        attendanceRows.push({
          Name: user.name,
          Email: user.email,
          Date: date,
          "Check In": earliestStart.toLocaleTimeString(),
          "Check Out": latestEnd.toLocaleTimeString(),
          "Worked Hours": `${durationHrs}h ${durationMin}m`,
        });
      }
    }

    // Export to Excel
    const worksheet = XLSX.utils.json_to_sheet(attendanceRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");

    const filePath = path.join(__dirname, "attendance-report.xlsx");
    XLSX.writeFile(workbook, filePath);

    console.log("✅ Attendance report saved to:", filePath);
  };

  // From Clockify
  public exportAttendanceReport = async () => {
    const deviceUrl = process.env.DEVICE_URL as string;
    const jwtToken = process.env.JWT_TOKEN as string;

    const start_date = "2025-11-01";
    const end_date = "2025-11-21";

    let url = `${deviceUrl}att/api/transactionReport/?start_date=${encodeURIComponent(
      start_date
    )}&end_date=${encodeURIComponent(end_date)}&page_size=500`;
    // let url =
    //   `${deviceUrl}iclock/api/transactions/?end_time=2025-11-30&page=1&limit=10000&start_time=2025-11-01`;

    let allRecords: any[] = [];
    const res = await axios.get(url, {
      headers: {
        Authorization: `JWT ${jwtToken}`,
        Accept: "application/json",
      },
    });
    console.log("Response status:", res.status);
    console.log("Response headers:", res.headers);
    // return JSON.stringify(res.data);


    // Fetch all pages
    while (url) {
      console.log("📡 Fetching:", url);
      const res = await axios.get(url, {
        headers: {
          Authorization: `JWT ${jwtToken}`,
          Accept: "application/json",
        },
      });

      const response = res.data?.response || res.data;
      if (!response?.data || !Array.isArray(response.data)) {
        console.error("❌ Invalid response structure or missing data.");
        break;
      }
      console.log("response.next", response.next);

      allRecords = allRecords.concat(response.data);
      url = response.next || null;
    }
    // return allRecords;

    if (allRecords.length === 0) {
      console.log("⚠️ No attendance records found.");
      return;
    }

    // Group by emp_code + att_date
    const grouped: { [key: string]: any[] } = {};
    for (const record of allRecords) {
      const key = `${record.emp_code}_${record.att_date}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(record);
    }

    const finalRows: any[] = [];

    for (const [key, records] of Object.entries(grouped)) {
      // Sort by punch_time
      records.sort((a, b) => a.punch_time.localeCompare(b.punch_time));

      const base = records[0];
      const times = records.map((r) => ({
        time: r.punch_time,
        state: r.punch_state,
      }));

      const row: any = {
        "Employee Code": base.emp_code,
        Name: `${base.first_name ?? ""} ${base.last_name ?? ""}`.trim(),
        Department: base.dept_name,
        Company: base.company_name,
        Date: base.att_date,
        "Check In": "",
        "Check Out": "",
        "Break 1 Start": "",
        "Break 1 End": "",
        "Break 2 Start": "",
        "Break 2 End": "",
        "Break 3 Start": "",
        "Break 3 End": "",
        "Break 4 Start": "",
        "Break 4 End": "",
        "Total Break Time": "",
        "Total Work Time": "",
      };

      const punches = times.map((t) => t.time);

      // Assume: first = Check In, last = Check Out
      row["Check In"] = punches[0];
      row["Check Out"] = punches[punches.length - 1];

      const breaks = punches.slice(1, punches.length - 1); // exclude CheckIn and CheckOut

      for (let i = 0; i < breaks.length && i < 8; i += 2) {
        const breakNum = Math.floor(i / 2) + 1;
        row[`Break ${breakNum} Start`] = breaks[i];
        row[`Break ${breakNum} End`] = breaks[i + 1] ?? "";
      }

      // Time calculations
      const toMinutes = (time: string) => {
        const [h, m] = time.split(":").map(Number);
        return h * 60 + m;
      };

      const checkInMin = toMinutes(row["Check In"]);
      const checkOutMin = toMinutes(row["Check Out"]);

      let breakMin = 0;
      for (let i = 1; i <= 4; i++) {
        const bStart = row[`Break ${i} Start`];
        const bEnd = row[`Break ${i} End`];
        if (bStart && bEnd) {
          breakMin += toMinutes(bEnd) - toMinutes(bStart);
        }
      }

      const totalWorked = checkOutMin - checkInMin - breakMin;
      row["Total Break Time"] = toHHMM(breakMin);
      row["Total Work Time"] = toHHMM(totalWorked);

      finalRows.push(row);
    }

    // Export to XLSX
    const worksheet = XLSX.utils.json_to_sheet(finalRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Formatted Attendance");

    const fileName = `attendance-${start_date}_to_${end_date}.xlsx`;
    const filePath = path.join(process.cwd(), fileName);
    XLSX.writeFile(workbook, filePath);

    console.log(`✅ Formatted XLSX saved to: ${filePath}`);
  };

  public exportMergedAttendanceReport = async (data: any) => {
    const { start, end } = data;
    console.log("🔴 start:", start);

    const startDate = new Date(start).toISOString().split("T")[0];
    const endDate = new Date(end).toISOString().split("T")[0];

    try {
      const adjustedEndDate = new Date(end);
      adjustedEndDate.setUTCHours(23, 59, 59, 999);
      const formattedEndDate = adjustedEndDate.toISOString();

      const deviceUrl = process.env.DEVICE_URL as string;
      const jwtToken = process.env.JWT_TOKEN as string;

      // 🔍 Fast binary search to find maximum working page_size
      const findMaxPageSize = async (): Promise<number> => {
        let low = 1;
        let high = 5000; // Start with reasonable upper bound
        let best = 100; // Fallback value

        console.log("🔍 Finding maximum working page_size (binary search)...");

        // First, check if a high value works to set upper bound
        const testHigh = async (size: number): Promise<boolean> => {
          const testUrl = `${deviceUrl}att/api/transactionReport/?start_date=${encodeURIComponent(
            startDate
          )}&end_date=${encodeURIComponent(endDate)}&page_size=${size}`;
          
          console.log(`🔍 Testing page_size=${size}...`);
          
          try {
            const res: any = await axios.get(testUrl, {
              headers: {
                Authorization: `JWT ${jwtToken}`,
                Accept: "application/json",
              },
              validateStatus: () => true,
            });

            const isHtmlError = typeof res.data === 'string' && 
              (res.data.includes('<!DOCTYPE') || res.data.includes('<html>') || res.data.includes('Page not found'));

            if (isHtmlError || res.status !== 200) {
              console.log(`❌ page_size=${size} failed (status: ${res.status}, HTML error: ${isHtmlError})`);
              return false;
            }

            const response: any = res.data?.response || res.data;
            const isValid = response?.data && Array.isArray(response.data);
            
            if (isValid) {
              console.log(`✅ page_size=${size} works! (found ${response.data.length} records)`);
            } else {
              console.log(`❌ page_size=${size} failed (invalid response structure)`);
            }
            
            return isValid;
          } catch (error: any) {
            console.log(`❌ page_size=${size} failed with error: ${error.message}`);
            return false;
          }
        };

        // Binary search
        console.log(`🔍 Starting binary search: low=${low}, high=${high}`);
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          console.log(`\n📊 Binary search step: testing mid=${mid} (range: ${low}-${high}, best so far: ${best})`);
          
          const works = await testHigh(mid);
          
          if (works) {
            best = mid;
            low = mid + 1; // Try higher
            console.log(`✅ page_size=${mid} works! Updated best=${best}, trying higher (new range: ${low}-${high})`);
          } else {
            high = mid - 1; // Try lower
            console.log(`❌ page_size=${mid} failed, trying lower (new range: ${low}-${high})`);
          }
        }

        console.log(`\n✅ Maximum working page_size found: ${best}`);
        return best;
      };

      const optimalPageSize = await findMaxPageSize();

      let url: string | null = `${deviceUrl}att/api/transactionReport/?start_date=${encodeURIComponent(
        startDate
      )}&end_date=${encodeURIComponent(endDate)}&page_size=${optimalPageSize}`;

      let allRecords: any[] = [];

      // 🔁 Fetch Biotime Data with pagination
      while (url) {
        try {
          const res: any = await axios.get(url, {
            headers: {
              Authorization: `JWT ${jwtToken}`,
              Accept: "application/json",
            },
            validateStatus: () => true,
          });

          console.log("Fetching URL:", url);
          console.log("Response status:", res.status);

          // Check if response is HTML (error page) - happens on last page sometimes
          const isHtmlError = typeof res.data === 'string' && 
            (res.data.includes('<!DOCTYPE') || res.data.includes('<html>') || res.data.includes('Page not found'));

          if (isHtmlError || res.status !== 200) {
            console.log("⚠️ API returned error page (likely last page reached)");
            console.log("Stopping pagination. Total records fetched:", allRecords.length);
            break;
          }

          const response: any = res.data?.response || res.data;
          
          if (!response?.data || !Array.isArray(response.data)) {
            console.log("❌ Invalid response structure");
            break;
          }

          allRecords = allRecords.concat(response.data);
          console.log(`✅ Fetched ${response.data.length} records (Total: ${allRecords.length})`);

          // Get next page URL
          const nextUrl: string | null | undefined = response.next;
          if (nextUrl && typeof nextUrl === 'string' && nextUrl.trim() !== '') {
            url = nextUrl;
            console.log("⏳ Waiting 2 seconds before next request...");
            await this.delay(2000);
          } else {
            console.log("✅ No more pages to fetch");
            url = null;
          }
        } catch (error: any) {
          console.error("❌ Error fetching page:", error.message);
          break;
        }
      }

      if (!allRecords.length) {
        console.log("⚠️ No Biotime attendance records found.");
        return;
      }


      // 📦 Group by emp_code + date
      const grouped: { [key: string]: any[] } = {};
      for (const record of allRecords) {
        const key = `${record.emp_code}_${record.att_date}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(record);
      }

      const finalRows: any[] = [];

      for (const [key, records] of Object.entries(grouped)) {
        records.sort((a, b) => a.punch_time.localeCompare(b.punch_time));
        const base = records[0];
        const times = records.map((r) => r.punch_time);

        const row: any = {
          "Employee Code": base.emp_code,
          Name: `${base.first_name ?? ""} ${base.last_name ?? ""}`.trim(),
          Date: base.att_date,
          "Check In": times[0],
          "Check Out": times[times.length - 1],
          "Break 1 Start": "",
          "Break 1 End": "",
          "Break 2 Start": "",
          "Break 2 End": "",
          "Break 3 Start": "",
          "Break 3 End": "",
          "Break 4 Start": "",
          "Break 4 End": "",
          "Total Break Time": "",
          "Office Work Time": "",
          "Clockify Check In": "",
          "Clockify Check Out": "",
          "Clockify Worked Hours": "",
          "Total Work Time": "",
        };

        const breaks = times.slice(1, times.length - 1);
        for (let i = 0; i < breaks.length && i < 8; i += 2) {
          const bNum = Math.floor(i / 2) + 1;
          row[`Break ${bNum} Start`] = breaks[i];
          row[`Break ${bNum} End`] = breaks[i + 1] ?? "";
        }

        const toMinutes = (t: string) => {
          const [h, m, s] = t.split(":").map(Number);
          return h * 60 + m;
        };

        const checkInMin = toMinutes(row["Check In"]);
        const checkOutMin = toMinutes(row["Check Out"]);

        let breakMin = 0;
        for (let i = 1; i <= 4; i++) {
          const bStart = row[`Break ${i} Start`];
          const bEnd = row[`Break ${i} End`];
          if (bStart && bEnd) {
            breakMin += toMinutes(bEnd) - toMinutes(bStart);
          }
        }

        const officeWorkedMin = checkOutMin - checkInMin - breakMin;
        row["Total Break Time"] = toHHMM(breakMin);
        row["Office Work Time"] = toHHMM(officeWorkedMin);
        row["OfficeWorkMinutes"] = officeWorkedMin;

        finalRows.push(row);
      }

      // 🔁 FETCH CLOCKIFY
      const users = await getUsers();
      const clockifyMap = new Map<string, any>();
      const unmatchedClockifyRows: any[] = [];

      for (const user of users) {
        const res = await clockify.get(
          `/workspaces/${WORKSPACE_ID}/user/${user.id}/time-entries`,
          { params: { start, end: formattedEndDate } }
        );

        const entries = res.data;
        if (!entries.length) continue;

        const groupedByDate: Record<string, any[]> = {};
        entries.forEach((entry: any) => {
          const date = entry.timeInterval.start.split("T")[0];
          if (!groupedByDate[date]) groupedByDate[date] = [];
          groupedByDate[date].push(entry);
        });

        for (const date in groupedByDate) {
          const dayEntries = groupedByDate[date];
          const startTimes = dayEntries.map(
            (e) => new Date(e.timeInterval.start)
          );
          const endTimes = dayEntries.map((e) => new Date(e.timeInterval.end));

          const checkIn = new Date(
            Math.min(...startTimes.map((d) => d.getTime()))
          );
          const checkOut = new Date(
            Math.max(...endTimes.map((d) => d.getTime()))
          );

          // ✅ CORRECT: Total span between check-in and check-out
          const durationMs = checkOut.getTime() - checkIn.getTime();

          const h = Math.floor(durationMs / (1000 * 60 * 60));
          const m = Math.floor((durationMs / (1000 * 60)) % 60);

          const name = user.name.trim();
          const key = `${name}_${date}`;

          clockifyMap.set(key, {
            checkIn: checkIn.toLocaleTimeString(),
            checkOut: checkOut.toLocaleTimeString(),
            worked: `${h}h ${m}m`,
            ClockifyMinutes: Math.floor(durationMs / (1000 * 60)), // for total work time
          });
        }
      }

      // 🔗 Merge Clockify
      for (const row of finalRows) {
        const key = `${row.Name?.trim().toLowerCase()}_${row.Date}`;
        const clockify = clockifyMap.get(key);

        let officeMin = row.OfficeWorkMinutes || 0;
        let clockifyMin = 0;

        if (clockify) {
          row["Clockify Check In"] = clockify.checkIn;
          row["Clockify Check Out"] = clockify.checkOut;
          row["Clockify Worked Hours"] = clockify.worked;
          clockifyMin = clockify.ClockifyMinutes;
        }

        const totalMin = officeMin + clockifyMin;
        row["Total Work Time"] = `${String(Math.floor(totalMin / 60)).padStart(
          2,
          "0"
        )}:${String(totalMin % 60).padStart(2, "0")}`;
      }

      // ➕ Add unmatched Clockify entries
      for (const [key, cData] of clockifyMap.entries()) {
        const [name, date] = key.split("_");
        const alreadyExists = finalRows.find(
          (r) => r.Name?.trim().toLowerCase() === name && r.Date === date
        );

        if (!alreadyExists) {
          const totalMin = cData.ClockifyMinutes;

          finalRows.push({
            "Employee Code": "",
            Name: name,
            Date: date,
            "Check In": "",
            "Check Out": "",
            "Break 1 Start": "",
            "Break 1 End": "",
            "Break 2 Start": "",
            "Break 2 End": "",
            "Break 3 Start": "",
            "Break 3 End": "",
            "Break 4 Start": "",
            "Break 4 End": "",
            "Total Break Time": "",
            "Office Work Time": "",
            "Clockify Check In": cData.checkIn,
            "Clockify Check Out": cData.checkOut,
            "Clockify Worked Hours": cData.worked,
            "Total Work Time": `${String(Math.floor(totalMin / 60)).padStart(
              2,
              "0"
            )}:${String(totalMin % 60).padStart(2, "0")}`,
          });
        }
      }

      // Export
      const cleanRows = finalRows.map(({ OfficeWorkMinutes, ...rest }) => rest);
      const worksheet = XLSX.utils.json_to_sheet(cleanRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Merged Attendance");

      // const fileName = `attendance-merged-${startDate}_to_${endDate}.xlsx`;
      // const filePath = path.join(process.cwd(), fileName);
      // XLSX.writeFile(workbook, filePath);

      // ➕ Weekly & Monthly Summary Sheets
      const groupBy = (rows: any[], granularity: "week" | "month") => {
        const map: Record<string, any> = {};
        const givenStart = moment(start, "YYYY-MM-DD").startOf("day"); // the user-provided start

        // First week end: if start is Monday this becomes Sunday of that week; if start is any other day it becomes the upcoming Sunday.
        const firstWeekEnd = givenStart.clone().endOf("isoWeek"); // ISO week: Monday–Sunday

        for (const row of rows) {
          const date = moment(row.Date, "YYYY-MM-DD").startOf("day");

          let key: string;
          if (granularity === "week") {
            if (date.isBetween(givenStart, firstWeekEnd, "day", "[]")) {
              // falls in the initial partial/full week from givenStart to the first Sunday
              key = `week-${givenStart.format(
                "YYYY-MM-DD"
              )}-to-${firstWeekEnd.format("YYYY-MM-DD")}`;
            } else {
              // subsequent regular ISO weeks (Monday to Sunday)
              const weekStart = date.clone().startOf("isoWeek");
              const weekEnd = date.clone().endOf("isoWeek");
              key = `week-${weekStart.format("YYYY-MM-DD")}-to-${weekEnd.format(
                "YYYY-MM-DD"
              )}`;
            }
          } else {
            key = `month-${moment(date).format("YYYY-MM")}`;
          }

          if (!map[key]) map[key] = {};
          const userKey = row.Name?.trim().toLowerCase();

          if (!map[key][userKey]) {
            map[key][userKey] = {
              Name: row.Name?.trim(),
              "Total Office Work Minutes": 0,
              "Total Break Minutes": 0,
              "Total Clockify Minutes": 0,
              "Total Work Minutes": 0,
            };
          }

          const user = map[key][userKey];

          const toMinutes = (str: string) => {
            if (!str || typeof str !== "string") return 0;
            const match = str.match(/^(\d{1,2})h\s?(\d{1,2})?m?$/i);
            if (match) {
              const h = parseInt(match[1] || "0", 10);
              const m = parseInt(match[2] || "0", 10);
              return h * 60 + m;
            }
            const [h, m] = str.split(":").map(Number);
            if (isNaN(h) || isNaN(m)) return 0;
            return h * 60 + m;
          };

          user["Total Office Work Minutes"] += toMinutes(
            row["Office Work Time"]
          );
          user["Total Break Minutes"] += toMinutes(row["Total Break Time"]);
          user["Total Clockify Minutes"] += toMinutes(
            row["Clockify Worked Hours"]
          );
          user["Total Work Minutes"] += toMinutes(row["Total Work Time"]);
        }

        return map;
      };

      const weekly = groupBy(cleanRows, "week");
      const monthly = groupBy(cleanRows, "month");

      const formatSummary = (group: Record<string, any>) =>
        Object.entries(group).map(([sheetName, users]) => {
          const rows = Object.values(users).map((user: any) => {
            return {
              Name: user.Name,
              "Total Office Work Time": toHHMM(
                user["Total Office Work Minutes"]
              ),
              "Total Break Time": toHHMM(user["Total Break Minutes"]),
              "Total Clockify Time": toHHMM(user["Total Clockify Minutes"]),
              "Total Work Time": toHHMM(user["Total Work Minutes"]),
            };
          });

          return { sheetName, rows };
        });

      // ➕ Append sheets to Excel
      [...formatSummary(weekly), ...formatSummary(monthly)].forEach(
        ({ sheetName, rows }) => {
          const sheet = XLSX.utils.json_to_sheet(rows);
          XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
        }
      );

      const fileName = `attendance-merged-${startDate}_to_${endDate}.xlsx`;
      // const filePath = path.join(process.cwd(), fileName);
      // XLSX.writeFile(workbook, filePath);
      return { workbook, fileName };
      console.log(`✅ Final merged XLSX saved to: ${filePath}`);
    } catch (error: any) {
      console.log("🔴 Error:", error);

      const status = error?.response?.status;
      if (status === 401 || error?.response?.data?.code === "token_not_valid") {
        console.warn("🔒 Token expired. Fetching new token...");
        try {
          const newToken = await this.getJWTToken({
            userName: process.env.DEVICE_USERNAME as string,
            Password: process.env.DEVICE_PASSWORD as string,
          });

          process.env.JWT_TOKEN = newToken;
          jwtToken = newToken;
          // Retry the entire operation with new token
          const response: any = await this.exportMergedAttendanceReport(data);
          return response;
        } catch (retryError: any) {
          console.error("❌ Retry failed after token refresh:", retryError);
          throw retryError;
        }
      } else {
        throw error;
      }
    }
  };

  public delay(ms: any) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const toMinutes = (t: string) => {
  if (!t || typeof t !== "string") return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

const toHHMM = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(
    2,
    "0"
  )}`;

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

const getMinutesDifference = (startMoment: moment.Moment, endMoment: moment.Moment): number => {
  const startTotalMinutes = startMoment.hours() * 60 + startMoment.minutes();
  const endTotalMinutes = endMoment.hours() * 60 + endMoment.minutes();
  let diff = endTotalMinutes - startTotalMinutes;
  return diff < 0 ? diff + 24 * 60 : diff;
};

const getTotalWorkTimeFromBiotimeAPI = async (
  userId: string,
  date: string,
  deviceUrl: string,
  jwtToken: string
): Promise<string> => {
  try {
    const dateMoment = moment(date, "MMMM DD, YYYY");
    if (!dateMoment.isValid()) {
      return "";
    }

    const startTime = dateMoment.clone().startOf("day").format("YYYY-MM-DD HH:mm:ss");
    const endTime = dateMoment.clone().endOf("day").format("YYYY-MM-DD HH:mm:ss");

    const response = await axios.get(
      `${deviceUrl}iclock/api/transactions/?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}&page_size=1000&emp_code=${userId}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `JWT ${jwtToken}`,
        },
      }
    );

    const punches = response.data?.data;
    if (!Array.isArray(punches) || punches.length === 0) {
      return "";
    }

    punches.sort((a: any, b: any) => 
      moment(a.punch_time, "YYYY-MM-DD HH:mm:ss").valueOf() - 
      moment(b.punch_time, "YYYY-MM-DD HH:mm:ss").valueOf()
    );

    // Find check-in and check-out punches
    let checkInPunch: any = null;
    let lastCheckOut: any = null;

    for (const punch of punches) {
      const status = punch.punch_state_display?.toLowerCase() || "";
      if (status.includes("check in") && !checkInPunch) {
        checkInPunch = punch;
      }
    }

    for (let i = punches.length - 1; i >= 0; i--) {
      const status = punches[i].punch_state_display?.toLowerCase() || "";
      if (status.includes("check out")) {
        lastCheckOut = punches[i];
        break;
      }
    }

    if (!checkInPunch || !lastCheckOut) {
      return "";
    }

    const checkInMoment = moment(checkInPunch.punch_time, "YYYY-MM-DD HH:mm:ss");
    const checkOutMoment = moment(lastCheckOut.punch_time, "YYYY-MM-DD HH:mm:ss");
    
    if (!checkInMoment.isValid() || !checkOutMoment.isValid()) {
      return "";
    }

    // Calculate break time
    let totalBreakMinutes = 0;
    let breakStart: moment.Moment | null = null;

    for (const punch of punches) {
      const status = punch.punch_state_display?.toLowerCase() || "";
      const punchMoment = moment(punch.punch_time, "YYYY-MM-DD HH:mm:ss");

      if (status.includes("break start")) {
        breakStart = punchMoment;
      } else if (status.includes("break end") && breakStart) {
        const breakDuration = getMinutesDifference(breakStart, punchMoment);
        if (breakDuration > 0) {
          totalBreakMinutes += breakDuration;
        }
        breakStart = null;
      }
    }

    // Calculate work time
    const totalDurationMinutes = getMinutesDifference(checkInMoment, checkOutMoment);
    const totalWorkMinutes = totalDurationMinutes - totalBreakMinutes;

    if (totalWorkMinutes < 0) {
      return "";
    }

    return toHHMM(totalWorkMinutes);
  } catch (error: any) {
    return "";
  }
};

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

  const calculateTotalWorkTime = (row: string[]): string => {
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

    const checkIn = row[checkInIdx];
    const checkOut = row[checkOutIdx];

    if (!checkIn || !checkOut) return "";

    const checkInMin = parseTime(checkIn);
    const checkOutMin = parseTime(checkOut);

    if (checkInMin === 0 || checkOutMin === 0) return "";

    // Calculate total break time
    let breakMin = 0;
    for (let i = 0; i < breakIns.length; i++) {
      const breakIn = row[breakIns[i]];
      const breakOut = row[breakOuts[i]];
      if (breakIn && breakOut) {
        const breakInMin = parseTime(breakIn);
        const breakOutMin = parseTime(breakOut);
        if (breakInMin > 0 && breakOutMin > 0) {
          breakMin += breakOutMin - breakInMin;
        }
      }
    }

    // Calculate total work time: (checkOut - checkIn) - breakTime
    const totalWorkMin = checkOutMin - checkInMin - breakMin;
    if (totalWorkMin < 0) return ""; // Invalid calculation

    return toHHMM(totalWorkMin);
  };

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
        // Calculate total work time when checkout happens
        const totalHourIdx = headers.indexOf("Total_Hour");
        const totalWorkTime = calculateTotalWorkTime(row);
        if (totalWorkTime) {
          row[totalHourIdx] = totalWorkTime;
        }
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
        // Recalculate total work time when break ends (in case checkout already happened)
        const checkOutIdx = headers.indexOf("checkOut");
        if (row[checkOutIdx]) {
          const totalHourIdx = headers.indexOf("Total_Hour");
          const totalWorkTime = calculateTotalWorkTime(row);
          if (totalWorkTime) {
            row[totalHourIdx] = totalWorkTime;
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
      const fileContent = fs.readFileSync(processedPunchesFilePath, "utf-8").trim();
      if (fileContent) {
        const data = JSON.parse(fileContent);
        punchSet = new Set(Array.isArray(data) ? data : []);
        console.log(`📦 Loaded ${punchSet.size} punches`);
      } else {
        punchSet = new Set();
      }
    } else {
      punchSet = new Set();
    }
  } catch (err) {
    console.error("⚠️ Cache load failed:", err);
    punchSet = new Set();
  }
};

export const isDuplicate = (key: string): boolean => {
  return punchSet.has(key);
};

export const markAsProcessed = (key: string) => {
  punchSet.add(key);
};

export const savePunchCache = async () => {
  if (isSavingCache) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (isSavingCache) return;
  }

  isSavingCache = true;
  try {
    const data = JSON.stringify(Array.from(punchSet), null, 2);
    fs.writeFileSync(processedPunchesFilePath, data, "utf-8");
  } catch (err) {
    console.error("⚠️ Cache save failed:", err);
  } finally {
    isSavingCache = false;
  }
};
export const getEmployeeRecord = async (empCode: string, deviceUrl: string, jwtToken: string): Promise<string | undefined> => {
  if (employeeNicknameCache.has(empCode)) {
    return employeeNicknameCache.get(empCode);
  }

  try {
    const response = await axios.get(`${deviceUrl}personnel/api/employees/`, {
      params: { emp_code: empCode },
      headers: {
        Authorization: `JWT ${jwtToken}`,
      },
    });

    if (response.data?.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
      const employee = response.data.data[0];
      const nickname = employee.nickname;
      
      if (nickname) {
        employeeNicknameCache.set(empCode, nickname);
        return nickname;
      }
    }
  } catch (error: any) {
    console.error(`⚠️ Failed to fetch employee for ${empCode}`);
  }
  
  return undefined;
};

export const fetchAllRocketChatUsers = async () => {
  const rocketChatServer = process.env.ROCKET_CHAT_SERVER_URL as string;
  const authToken = process.env.ROCKET_CHAT_AUTH_TOKEN as string;
  const userId = process.env.ROCKET_CHAT_USER_ID as string;

  try {
    const allUsers: any[] = [];
    let offset = 0;
    const pageSize = 100;
    let total = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get(`${rocketChatServer}/api/v1/users.list`, {
        params: {
          count: pageSize,
          offset: offset,
        },
        headers: {
          "X-Auth-Token": authToken,
          "X-User-Id": userId,
          "Content-Type": "application/json",
        },
      });

      if (response.data?.success && response.data?.users) {
        allUsers.push(...response.data.users);
        total = response.data.total || allUsers.length;
        offset += pageSize;
        
        console.log(`📥 Fetched ${allUsers.length}/${total} users...`);
        
        hasMore = allUsers.length < total && response.data.users.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(`✅ Total Rocket.Chat users: ${allUsers.length}`);
    return allUsers;
  } catch (error: any) {
    console.error("❌ Failed to fetch Rocket.Chat users:", error.response?.data || error.message);
    throw error;
  }
};
