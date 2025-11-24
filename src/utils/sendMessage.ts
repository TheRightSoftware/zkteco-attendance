import axios from "axios";
import moment from "moment";
import winston from "winston";

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
) => {
  const rocketChatServer = process.env.ROCKET_CHAT_SERVER_URL as string;
  const authToken = process.env.ROCKET_CHAT_AUTH_TOKEN as string;
  const userId = process.env.ROCKET_CHAT_USER_ID as string;

  const formattedTime = moment(punchTime).format("h:mm A");
  let message = isFromClockify
    ? `${firstName}${project ? ` | ${project}` : ""} | ${formattedTime} | ${punchState}`
    : `${rocketChatUsername ? `@${rocketChatUsername} (${user_Id})` : firstName} | ${formattedTime} | ${punchState}`;
  
  // if (rocketChatUsername) {
  //   message = `@${rocketChatUsername} ${message}`;
  // }

  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      logger.info(`💬 Attempt ${attempt + 1}: ${message} - ${punchTime}`);

      const payload: any = {
        roomId: process.env.CHANNEL_NAME as string,
        text: message,
      };

      const res = await axios.post(
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

      logger.info(`✅ Sent for ${firstName}: ${formattedTime}`);
      return;

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
      } else {
        logger.error(`❌ All ${maxRetries} attempts failed.`);
        throw error;
      }
    }
  }
};

