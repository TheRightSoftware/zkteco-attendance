import axios from "axios";
import moment from "moment";
import winston from "winston";
import fs from "fs";
import path from "path";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) => 
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

/** Rocket.Chat `roomId` is a server room id; @user / #room must use `channel`. */
const postMessageTarget = (
  target: string
): { channel?: string; roomId?: string } => {
  const t = target.trim();
  if (!t) {
    throw new Error("Rocket.Chat target (CHANNEL_NAME) is missing or empty");
  }

  if (t.startsWith("@") || t.startsWith("#")) {
    return { channel: t };
  }
  // Typical Rocket.Chat rid (e.g. jK9ARWic28jeHGF4Z) — not a display name
  if (/^[a-zA-Z0-9]{17}$/.test(t)) {
    return { roomId: t };
  }
  return { channel: `@${t}` };
};

const failedMessagesFilePath = path.join(__dirname, "../utils/failedMessages.json");

export interface FailedMessage {
  firstName: string;
  punchTime: string;
  punchState: string;
  project?: string;
  isFromClockify: boolean;
  rocketChatUsername?: string;
  user_Id?: string;
  maxRetries: number;
  delayMs: number;
  roomIdOverride?: string;
}

let isProcessingQueue = false;

// Core HTTP post logic
const sendRawMessage = async (
  message: string,
  punchTime: string,
  firstName: string,
  roomIdOverride?: string,
  maxRetries = 3,
  delayMs = 1000
): Promise<boolean> => {
  const rocketChatServer = process.env.ROCKET_CHAT_SERVER_URL as string;
  const authToken = process.env.ROCKET_CHAT_AUTH_TOKEN as string;
  const userId = process.env.ROCKET_CHAT_USER_ID as string;

  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      logger.info(`💬 Attempt ${attempt + 1}: ${message} - ${punchTime}`);

      const target = (roomIdOverride ?? process.env.CHANNEL_NAME) as string;
      const payload: any = {
        text: message,
        ...postMessageTarget(target),
      };

      await axios.post(
        `${rocketChatServer}/api/v1/chat.postMessage`,
        payload,
        {
          headers: {
            "X-Auth-Token": authToken,
            "X-User-Id": userId,
            "Content-Type": "application/json",
          },
        }
      );

      logger.info(`✅ Sent for ${firstName}: ${moment(punchTime).format("h:mm A")}`);
      return true;

    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.error(`🚫 Attempt ${attempt + 1} failed: ${errorMsg}`);

      const isRateLimit = error.response?.data?.error?.includes("too many requests") || 
                         error.response?.data?.error?.includes("error-too-many-requests");
      
      let waitTime = delayMs * Math.pow(2, attempt);
      
      if (isRateLimit) {
        const waitMatch = error.response?.data?.error?.match(/wait (\d+) seconds?/i);
        waitTime = waitMatch?.[1] ? (parseInt(waitMatch[1]) + 2) * 1000 : 30000;
        logger.warn(`⏸️ Rate limited! Waiting ${waitTime / 1000}s...`);
      }

      attempt++;
      if (attempt < maxRetries) {
        logger.info(`⏳ Retrying in ${waitTime / 1000}s...`);
        await new Promise(res => setTimeout(res, waitTime));
      }
    }
  }
  return false;
};

// Queue file readers/writers
const loadFailedMessages = (): FailedMessage[] => {
  try {
    if (fs.existsSync(failedMessagesFilePath)) {
      const data = fs.readFileSync(failedMessagesFilePath, "utf-8").trim();
      return data ? JSON.parse(data) : [];
    }
  } catch (err) {
    logger.error("❌ Failed to load failed messages from file:", err);
  }
  return [];
};

const saveFailedMessages = (list: FailedMessage[]) => {
  try {
    // Ensure directory exists
    const dir = path.dirname(failedMessagesFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(failedMessagesFilePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    logger.error("❌ Failed to save failed messages to file:", err);
  }
};

const queueFailedMessage = (msg: FailedMessage) => {
  const list = loadFailedMessages();
  const exists = list.some(
    item => item.firstName === msg.firstName && 
            item.punchTime === msg.punchTime && 
            item.punchState === msg.punchState
  );
  if (!exists) {
    list.push(msg);
    saveFailedMessages(list);
  }
};

export const sendMessage = async (
  firstName: string,
  punchTime: string,
  punchState: string,
  project?: string,
  isFromClockify: boolean = false,
  rocketChatUsername?: string,
  user_Id?: string,
  maxRetries = 3,
  delayMs = 1000,
  roomIdOverride?: string,
) => {
  // Try processing the failed queue if we're not currently doing so
  if (!isProcessingQueue) {
    await processFailedMessages();
  }

  const formattedTime = moment(punchTime).format("h:mm A");
  const message = isFromClockify
    ? `${firstName}${project ? ` | ${project}` : ""} | ${formattedTime} | ${punchState}`
    : `${rocketChatUsername ? `@${rocketChatUsername} (${user_Id})` : firstName} | ${formattedTime} | ${punchState}`;

  const success = await sendRawMessage(message, punchTime, firstName, roomIdOverride, maxRetries, delayMs);
  
  if (!success) {
    queueFailedMessage({
      firstName,
      punchTime,
      punchState,
      project,
      isFromClockify,
      rocketChatUsername,
      user_Id,
      maxRetries,
      delayMs,
      roomIdOverride
    });
    logger.error(`💾 Saved failed message to queue for persistence: ${firstName} (${punchTime})`);
  }
};

export const processFailedMessages = async () => {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    const list = loadFailedMessages();
    if (list.length === 0) {
      isProcessingQueue = false;
      return;
    }

    logger.info(`🔄 Processing persistent failed messages queue (${list.length} pending)...`);
    const remaining: FailedMessage[] = [];

    for (const msg of list) {
      const formattedTime = moment(msg.punchTime).format("h:mm A");
      const message = msg.isFromClockify
        ? `${msg.firstName}${msg.project ? ` | ${msg.project}` : ""} | ${formattedTime} | ${msg.punchState}`
        : `${msg.rocketChatUsername ? `@${msg.rocketChatUsername} (${msg.user_Id})` : msg.firstName} | ${formattedTime} | ${msg.punchState}`;

      // Try sending with a rate limit delay, and fewer retries to keep it fast
      const success = await sendRawMessage(message, msg.punchTime, msg.firstName, msg.roomIdOverride, 2, msg.delayMs);
      if (!success) {
        const index = list.indexOf(msg);
        remaining.push(...list.slice(index));
        logger.warn(`⏸️ A queued message failed to send. Pausing queue flushing to prevent out of order messages.`);
        break;
      }
      
      // Delay slightly between queue items to prevent rate limits
      await new Promise(res => setTimeout(res, 2000));
    }

    saveFailedMessages(remaining);
    logger.info(`✅ Finished processing failed messages queue. Remaining: ${remaining.length}`);
  } catch (err) {
    logger.error("❌ Error processing failed messages queue:", err);
  } finally {
    isProcessingQueue = false;
  }
};
