import axios from "axios";
import moment from "moment";
import winston from "winston";

// Setup logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(), // still logs to console
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
  maxRetries = 3,
  delayMs = 1000
) => {
  const rocketChatServer = process.env.ROCKET_CHAT_SERVER_URL as string;
  const authToken = process.env.ROCKET_CHAT_AUTH_TOKEN as string;
  const userId = process.env.ROCKET_CHAT_USER_ID as string;

  const formattedTime = moment(punchTime).format("h:mm A");
  const message = isFromClockify
    ? `${firstName}${project ? ` | ${project}` : ""} | ${formattedTime} | ${punchState}`
    : `${firstName} | ${formattedTime} | ${punchState}`;

  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      logger.info(`💬 Attempt ${attempt + 1}: ${message} - ${punchTime}`);

      const res = await axios.post(
        `${rocketChatServer}/api/v1/chat.postMessage`,
        {
          channel: process.env.CHANNEL_NAME as string,
          text: message,
        },
        {
          headers: {
            "X-Auth-Token": authToken,
            "X-User-Id": userId,
            "Content-Type": "application/json",
          },
        }
      );

      logger.info(`✅ Sent for ${firstName}: ${formattedTime}`);
      return; // success, exit the function

    } catch (error: any) {
      const errorMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.error(`🚫 Attempt ${attempt + 1} failed: ${errorMsg}`);

      attempt++;
      if (attempt < maxRetries) {
        const waitTime = delayMs * Math.pow(2, attempt); // Exponential backoff
        logger.info(`⏳ Retrying in ${waitTime / 1000} seconds...`);
        await new Promise(res => setTimeout(res, waitTime));
      } else {
        logger.error(`❌ All ${maxRetries} attempts failed.`);
      }
    }
  }
};

