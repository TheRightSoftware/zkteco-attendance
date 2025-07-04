import axios from "axios";
import moment from "moment";

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
      ? `${firstName}${
          project ? ` | ${project}` : ""
        } | ${formattedTime} | ${punchState}`
      : `${firstName} | ${formattedTime} | ${punchState}`;
    console.log("💬", message);

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

    console.log(`✅ Sent for ${firstName}: ${formattedTime}`);
  } catch (error: any) {
    console.error(
      "🚫 Failed to send message:",
      error.response?.data || error.message
    );
  }
};
