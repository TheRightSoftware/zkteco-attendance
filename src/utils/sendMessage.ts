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
  isFromClockify: boolean = false
) => {
  try {
    const rocketChatServer = process.env.ROCKET_CHAT_SERVER_URL as string;
    const authToken = process.env.ROCKET_CHAT_AUTH_TOKEN as string;
    const userId = process.env.ROCKET_CHAT_USER_ID as string;

    const formattedTime = moment(punchTime).format("h:mm A");
    const message = isFromClockify
      ? `${firstName}${project ? ` | ${project}` : ""} | ${formattedTime} | ${punchState}`
      : `${firstName} | ${formattedTime} | ${punchState}`;

    logger.info(`💬 ${message} - ${punchTime}`);

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
    // return res.data;
  } catch (error: any) {
    logger.error(
      `🚫 Failed to send message: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`
    );
    // throw error; 
  }
};
