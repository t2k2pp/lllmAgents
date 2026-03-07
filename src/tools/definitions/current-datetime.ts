import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const currentDatetimeTool: ToolHandler = {
  name: "current_datetime",
  definition: {
    type: "function",
    function: {
      name: "current_datetime",
      description: "現在の日時（現在時刻）を取得します。引数は不要です。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  async execute(): Promise<ToolResult> {
    try {
      const now = new Date();
      
      const isoString = now.toISOString();
      
      // format: YYYY/MM/DD HH:mm:ss
      const localString = now.toLocaleString("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });

      // format offset like +09:00
      const offsetMinutes = now.getTimezoneOffset();
      const offsetSign = offsetMinutes > 0 ? "-" : "+";
      const absOffset = Math.abs(offsetMinutes);
      const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
      const offsetMins = String(absOffset % 60).padStart(2, "0");
      const offsetString = `${offsetSign}${offsetHours}:${offsetMins}`;

      const output = [
        `ISO 8601: ${isoString}`,
        `Local Time: ${localString}`,
        `Timezone Offset: ${offsetString}`
      ].join("\n");

      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: "", error: error.message };
    }
  },
};
